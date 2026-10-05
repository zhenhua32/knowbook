import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1 } from '../src/shared/contracts'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __toolbarScopeProbe?: Probe }
const sourceName = 'Toolbar shortcut source'
const viewName = 'Original toolbar table'
const recordTitle = 'Original selected toolbar record'
type MenuKind = 'filter' | 'sort'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let step = 0; step < 64; step++) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
  }
  await expect(target).toBeFocused()
}

async function prepare(page: Page, language: Language) {
  await page.evaluate(async ({ language, sourceName, viewName, recordTitle }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep records and saved view metadata.' })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const hidden = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Hidden', type: 'text' })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [notes.id]: 'Original Notes', [hidden.id]: 'Original hidden metadata' } })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Hidden neighboring record',
      fieldValues: { [notes.id]: 'Neighboring Notes', [hidden.id]: 'Keep neighbor metadata' } })
    const fields = ['__title__', notes.id]
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original',
      filters: { operator: 'and', rules: [{ id: 'original-filter', fieldId: notes.id, operator: 'contains', value: 'Original' }] },
      sorts: [{ fieldId: notes.id, direction: 'asc' }], groupBy: { fieldId: null }, visibleFieldIds: fields, fieldOrder: [...fields, hidden.id],
      columnWidths: {}, cardFieldIds: [notes.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
  }, { language, sourceName, viewName, recordTitle })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(1)
  await page.locator('tbody .dbw-select-column input').click()
  await expect(page.locator('tbody .dbw-select-column input')).toBeChecked()
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__toolbarScopeProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        const request = { channel, input: structuredClone(input) }
        probe.requests.push(request)
        try { const result = await original(event, ...input); probe.writes.push(request); return result }
        catch (error) { probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) }); throw error }
      })
    }
  })
}

async function readStored(page: Page, app: ElectronApplication, language: Language) {
  const api = await page.evaluate(async language => {
    const databases = (await window.knowbook.getDatabases()).sort((left, right) => left.id.localeCompare(right.id))
    const catalog = (await window.knowbook.getDocumentCatalog()).sort((left, right) => left.id.localeCompare(right.id))
    return { databases, catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: (await window.knowbook.listDocumentTemplates(language)).sort((left, right) => left.id.localeCompare(right.id)),
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort((left, right) => left.id.localeCompare(right.id)),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort((left, right) => left.id.localeCompare(right.id)),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort((left, right) => left.id.localeCompare(right.id)) }))) }
  }, language)
  const sql = await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try { return {
      schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
      columns: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all(),
      entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
      values: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
      documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all(),
      views: database.prepare('SELECT * FROM database_saved_views ORDER BY id').all()
    } } finally { database.close() }
  })
  return { ...api, sql }
}

async function installObservations(page: Page) {
  await page.evaluate(() => {
    const observations = { focus: [] as unknown[], keys: [] as unknown[] }
    ;(window as unknown as { __toolbarObservations: typeof observations }).__toolbarObservations = observations
    const describe = (element: Element | null) => element instanceof HTMLElement
      ? { tag: element.tagName, className: element.className, label: element.getAttribute('aria-label'), text: element.textContent?.slice(0, 120) } : null
    const original = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (...args: Parameters<HTMLElement['focus']>) {
      observations.focus.push(describe(this))
      return original.apply(this, args)
    }
    window.addEventListener('keydown', event => {
      const target = describe(event.target instanceof Element ? event.target : null)
      queueMicrotask(() => observations.keys.push({ key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
        defaultPrevented: event.defaultPrevented, target, active: describe(document.activeElement) }))
    })
  })
}

async function observations(page: Page) {
  return page.evaluate(() => (window as unknown as { __toolbarObservations: { focus: unknown[]; keys: Array<{ key: string; defaultPrevented: boolean }> } }).__toolbarObservations)
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, kind: MenuKind,
  before: Awaited<ReturnType<typeof readStored>>, phase: string, steps: unknown[]) {
  const state = await page.evaluate(kind => {
    const menu = document.querySelectorAll<HTMLDetailsElement>('.dbw-toolbar-menu')[kind === 'filter' ? 0 : 1]
    const confirm = document.querySelector<HTMLDialogElement>('.app-confirm-dialog'), active = document.activeElement
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      activeView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      notes: document.querySelector<HTMLInputElement>('tbody .catalog-cell-input[aria-label="Notes"]')?.value,
      selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent),
      checkedCount: Array.from(document.querySelectorAll<HTMLInputElement>('tbody .dbw-select-column input')).filter(input => input.checked).length,
      menuOpen: menu.open, controls: Array.from(menu.querySelectorAll('summary, button, input, select')).map(element => ({
        tag: element.tagName, label: element.getAttribute('aria-label'), text: element.textContent?.slice(0, 120), focused: element === active,
        value: element instanceof HTMLInputElement || element instanceof HTMLSelectElement ? element.value : null })),
      filterCount: document.querySelectorAll('.dbw-filter-row').length, sortCount: document.querySelectorAll('.dbw-config-row').length,
      dirty: document.querySelector('.dbw-unsaved-dot') !== null,
      confirmCount: document.querySelectorAll('.app-confirm-dialog').length,
      confirm: confirm ? { open: confirm.open, heading: confirm.querySelector('h2')?.textContent,
        body: confirm.querySelector('.app-confirm-body')?.textContent } : null,
      formCount: document.querySelectorAll('.dbw-form-dialog, .dbw-create-record-dialog').length,
      active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className,
        label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 120) } : null }
  }, kind)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const probe = await app.evaluate(() => (globalThis as ProbeGlobal).__toolbarScopeProbe!)
  const stored = await readStored(page, app, language)
  const result = { phase, language, kind, steps, observations: await observations(page), state, windows, probe, before, stored }
  const path = info.outputPath(`${language}-${kind}-${phase}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${kind}-${phase}.png`) })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(probe).toEqual({ requests: [], writes: [], failures: [] })
  expect(stored).toEqual(before)
  expect(state.source).toBe(sourceName)
  expect(state.activeView).toBe(viewName)
  expect(state.query).toBe('Original')
  expect(state.notes).toBe('Original Notes')
  expect(state.selectedTitles).toEqual([recordTitle])
  expect(state.checkedCount).toBe(1)
  expect(state.formCount).toBe(0)
  return result
}

for (const language of ['en-US', 'zh-CN'] as const) for (const kind of ['filter', 'sort'] as const) {
  test(`${kind} toolbar menu owns keyboard shortcuts without deleting selected records in ${language} @electron`, async ({}, info) => {
    test.setTimeout(150_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await prepare(page, language)
      await installProbe(app)
      await installObservations(page)
      const before = await readStored(page, app, language)
      const text = getDatabaseWorkspaceText(language)
      const menu = page.locator('.dbw-toolbar-menu').nth(kind === 'filter' ? 0 : 1)
      const summary = menu.locator('summary')
      const remove = menu.locator(kind === 'filter' ? '.dbw-filter-row button' : '.dbw-config-row button').first()
      const add = menu.locator('.dbw-add-config-row')
      const rows = menu.locator(kind === 'filter' ? '.dbw-filter-row' : '.dbw-config-row')
      const query = page.locator('.dbw-main-search input')
      const source = page.locator('.dbw-source-trigger')
      const newView = page.locator('.dbw-new-view-menu > summary')
      const fields = page.locator('.dbw-toolbar > .dbw-toolbar-button')
      const steps: unknown[] = []
      await summary.click()
      await expect(menu).toHaveJSProperty('open', true)
      const firstOwner = kind === 'filter' ? menu.locator('.dbw-popover-heading button') : remove
      await tabTo(page, firstOwner)
      await expect(firstOwner).toBeFocused()
      steps.push({ phase: 'first-owner', owner: await firstOwner.evaluate(element => ({ tag: element.tagName,
        label: element.getAttribute('aria-label'), text: element.textContent, focused: document.activeElement === element })) })
      await page.keyboard.press('Delete')
      await twoFrames(page)
      const initial = await record(page, app, info, language, kind, before, 'first-delete-before-business-oracle', steps)
      expect(initial.state.confirmCount, 'Menu Delete must not target selected canvas records').toBe(0)
      expect(initial.observations.keys.at(-1)?.defaultPrevented).toBe(false)
      await expect(firstOwner).toBeFocused()

      const keys = ['Delete', '/', 'Control+Shift+L', 'Control+Shift+V'] as const
      const owners: Array<[string, Locator]> = [['summary', summary], ['remove', remove], ['add', add],
        ['field-select', rows.first().locator('select').nth(0)], ['operator-select', rows.first().locator('select').nth(1)]]
      if (kind === 'filter') owners.push(['clear', firstOwner])
      for (const [name, owner] of owners) {
        await tabTo(page, owner, name === 'summary')
        for (const key of keys) {
          const prior = await observations(page)
          await page.keyboard.press(key)
          await twoFrames(page)
          const after = await observations(page)
          steps.push({ owner: name, key, focusBefore: prior.focus.length, focusAfter: after.focus.length,
            event: after.keys.at(-1), focused: await owner.evaluate(element => document.activeElement === element) })
          await expect(owner).toBeFocused()
          expect(after.focus).toEqual(prior.focus)
          expect(after.keys.at(-1)?.defaultPrevented).toBe(false)
          await expect(page.locator('.app-confirm-dialog')).toHaveCount(0)
          await expect(menu).toHaveJSProperty('open', true)
        }
      }
      if (kind === 'filter') {
        // The input keeps its native editing/paste behavior. This key only
        // tests canvas focus ownership and does not read the user's clipboard.
        const value = menu.locator('.dbw-filter-row input')
        await tabTo(page, value)
        const prior = await observations(page)
        await page.keyboard.press('Control+Shift+L')
        await twoFrames(page)
        await expect(value).toBeFocused()
        expect((await observations(page)).focus).toEqual(prior.focus)
        await expect(value).toHaveValue('Original')
      }
      const matrix = await record(page, app, info, language, kind, before, 'open-control-keyboard-matrix', steps)
      expect(matrix.state.confirmCount).toBe(0)
      expect(matrix.state.dirty).toBe(false)

      // Ordinary Enter continues to add/remove rules in the local draft.
      await tabTo(page, add)
      await page.keyboard.press('Enter')
      await expect(rows).toHaveCount(2)
      const added = await record(page, app, info, language, kind, before, 'enter-add-local-rule', steps)
      expect(added.state.dirty).toBe(true)
      await page.getByRole('button', { name: text.resetView, exact: true }).click()
      await expect(rows).toHaveCount(1)
      await tabTo(page, remove, true)
      await page.keyboard.press('Enter')
      if (kind === 'filter') await expect(rows).toHaveCount(0)
      else {
        // Empty sorting is repaired to the existing updated-at fallback.
        await expect(rows).toHaveCount(1)
        await expect(rows.first().locator('select').nth(0)).toHaveValue('__updated_at__')
        await expect(rows.first().locator('select').nth(1)).toHaveValue('desc')
      }
      const removed = await record(page, app, info, language, kind, before, 'enter-remove-local-rule', steps)
      expect(removed.state.dirty).toBe(true)
      await page.getByRole('button', { name: text.resetView, exact: true }).click()
      await expect(rows).toHaveCount(1)

      // Closed summaries and controls outside an open menu still own the
      // existing canvas shortcuts. Only Cancel is activated in Delete dialogs.
      for (const mode of ['closed-summary', 'open-menu-outside-fields'] as const) {
        await tabTo(page, summary, true)
        await page.keyboard.press('Enter')
        await expect(menu).toHaveJSProperty('open', mode !== 'closed-summary')
        const owner = mode === 'closed-summary' ? summary : fields
        for (const key of keys) {
          await tabTo(page, owner)
          await expect(owner).toBeFocused()
          await page.keyboard.press(key)
          await twoFrames(page)
          expect((await observations(page)).keys.at(-1)?.defaultPrevented).toBe(true)
          if (key === '/') await expect(query).toBeFocused()
          else if (key === 'Control+Shift+L') await expect(source).toBeFocused()
          else if (key === 'Control+Shift+V') await expect(newView).toBeFocused()
          else {
            const confirmation = await record(page, app, info, language, kind, before, mode + '-canvas-delete-confirm', steps)
            expect(confirmation.state.confirmCount).toBe(1)
            expect(confirmation.state.confirm?.heading).toContain(language === 'zh-CN' ? '删除记录' : 'Delete record')
            expect(confirmation.state.confirm?.body).toContain(text.selected(1))
            const cancel = page.locator('.app-confirm-dialog').getByRole('button', { name: text.cancel, exact: true })
            await tabTo(page, cancel)
            await page.keyboard.press('Enter')
            await expect(page.locator('.app-confirm-dialog')).toHaveCount(0)
            await expect(query).toBeFocused()
          }
          steps.push({ mode, key, observations: await observations(page) })
          await expect(menu).toHaveJSProperty('open', mode !== 'closed-summary')
        }
        const canvas = await record(page, app, info, language, kind, before, mode + '-canvas-shortcuts-preserved', steps)
        expect(canvas.state.confirmCount).toBe(0)
        expect(canvas.state.dirty).toBe(false)
      }
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
