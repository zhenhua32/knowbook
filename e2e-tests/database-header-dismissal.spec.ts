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
type ProbeGlobal = typeof globalThis & { __headerDismissalProbe?: Probe }
const sourceName = 'Header dismissal source'
const viewName = 'Original header table'
const recordTitle = 'Original selected header record'
async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let step = 0; step < 256; step++) {
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
    ;(globalThis as ProbeGlobal).__headerDismissalProbe = probe
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

type Kind = 'picker' | 'settings'
async function installObservations(page: Page) {
  await page.evaluate(() => {
    const observations = { focus: [] as unknown[], keys: [] as unknown[], pointers: [] as unknown[] }
    ;(window as unknown as { __headerDismissalObservations: typeof observations }).__headerDismissalObservations = observations
    const describe = (element: Element | null) => element instanceof HTMLElement
      ? { tag: element.tagName, className: element.className, label: element.getAttribute('aria-label'), text: element.textContent?.slice(0, 120) } : null
    const original = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (...args: Parameters<HTMLElement['focus']>) {
      observations.focus.push(describe(this))
      return original.apply(this, args)
    }
    document.addEventListener('keydown', event => {
      const target = describe(event.target instanceof Element ? event.target : null)
      requestAnimationFrame(() => observations.keys.push({ key: event.key, defaultPrevented: event.defaultPrevented,
        target, active: describe(document.activeElement) }))
    }, true)
    document.addEventListener('pointerdown', event => {
      const refresh = event.target instanceof Element && Boolean(event.target.closest('.dbw-refresh-button'))
      requestAnimationFrame(() => observations.pointers.push({ refresh, defaultPrevented: event.defaultPrevented,
        isPrimary: event.isPrimary, button: event.button, active: describe(document.activeElement) }))
    }, true)
  })
}
async function observations(page: Page) {
  return page.evaluate(() => (window as unknown as { __headerDismissalObservations: {
    focus: unknown[]; keys: Array<{ key: string; defaultPrevented: boolean }>;
    pointers: Array<{ refresh: boolean; defaultPrevented: boolean; isPrimary: boolean; button: number }>
  } }).__headerDismissalObservations)
}
async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, kind: Kind,
  before: Awaited<ReturnType<typeof readStored>>, phase: string, expectedQuery = 'Original') {
  const state = await page.evaluate(() => {
    const active = document.activeElement
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      activeView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      notes: document.querySelector<HTMLInputElement>('tbody .catalog-cell-input[aria-label="Notes"]')?.value,
      selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent),
      checkedCount: Array.from(document.querySelectorAll<HTMLInputElement>('tbody .dbw-select-column input')).filter(input => input.checked).length,
      pickerCount: document.querySelectorAll('.dbw-source-picker').length,
      settingsCount: document.querySelectorAll('.dbw-header .dbw-action-menu').length,
      sourceExpanded: document.querySelector('.dbw-source-trigger')?.getAttribute('aria-expanded'),
      settingsExpanded: document.querySelector('.dbw-menu-wrap > button')?.getAttribute('aria-expanded'),
      sourceQuery: document.querySelector<HTMLInputElement>('.dbw-source-search input')?.value ?? null,
      sourceOptions: Array.from(document.querySelectorAll('.dbw-source-option strong')).map(item => item.textContent),
      confirmCount: document.querySelectorAll('.app-confirm-dialog').length,
      formCount: document.querySelectorAll('.dbw-form-dialog, .dbw-create-record-dialog').length,
      dirty: document.querySelector('.dbw-unsaved-dot') !== null,
      active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className,
        label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 120),
        source: active.matches('.dbw-source-trigger'), settings: active.matches('.dbw-menu-wrap > button') } : null }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const probe = await app.evaluate(() => (globalThis as ProbeGlobal).__headerDismissalProbe!)
  const stored = await readStored(page, app, language)
  const result = { phase, language, kind, state, windows, probe, observations: await observations(page), before, stored }
  const path = info.outputPath(language + '-' + kind + '-' + phase + '.json')
  writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(language + '-' + kind + '-' + phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(probe).toEqual({ requests: [], writes: [], failures: [] })
  expect(stored).toEqual(before)
  expect(state.source).toBe(sourceName)
  expect(state.activeView).toBe(viewName)
  expect(state.query).toBe(expectedQuery)
  expect(state.notes).toBe('Original Notes')
  expect(state.selectedTitles).toEqual([recordTitle])
  expect(state.checkedCount).toBe(1)
  expect(state.confirmCount).toBe(0)
  expect(state.formCount).toBe(0)
  return result
}

for (const language of ['en-US', 'zh-CN'] as const) for (const kind of ['picker', 'settings'] as const) {
  test('Header ' + kind + ' dismisses outside its own scope while preserving drafts in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(180_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await prepare(page, language)
      await installProbe(app)
      await installObservations(page)
      const before = await readStored(page, app, language), text = getDatabaseWorkspaceText(language)
      const source = page.locator('.dbw-source-trigger'), settings = page.locator('.dbw-menu-wrap > button')
      const picker = page.locator('.dbw-source-picker'), settingsMenu = page.locator('.dbw-header .dbw-action-menu')
      const sourceSearch = picker.locator('input'), query = page.locator('.dbw-main-search input')
      const primary = page.locator('.dbw-header-actions > .dbw-primary-button'), refresh = page.locator('.dbw-refresh-button')
      const popup = kind === 'picker' ? picker : settingsMenu, trigger = kind === 'picker' ? source : settings
      const edit = settingsMenu.getByRole('button', { name: text.editDatabase, exact: true })
      let seededSourceQuery = false
      const open = async () => {
        await trigger.click()
        await expect(popup).toBeVisible()
        if (kind === 'picker') {
          await expect(sourceSearch).toBeFocused()
          if (!seededSourceQuery) {
            await sourceSearch.fill('Header')
            seededSourceQuery = true
          } else await expect(sourceSearch).toHaveValue('Header')
          await expect(picker.locator('.dbw-source-option')).toHaveCount(1)
        } else {
          await page.keyboard.press('Tab')
          await expect(edit).toBeFocused()
        }
        await twoFrames(page)
      }
      const closed = async () => {
        await expect(picker).toHaveCount(0)
        await expect(settingsMenu).toHaveCount(0)
        await expect(source).toHaveAttribute('aria-expanded', 'false')
        await expect(settings).toHaveAttribute('aria-expanded', 'false')
      }
      await open()
      const departureFocus = (await observations(page)).focus.length
      await tabTo(page, primary, kind === 'settings')
      await twoFrames(page)
      const initial = await record(page, app, info, language, kind, before, 'first-native-tab-departure-before-menu-dismissal-oracle')
      expect(initial.state.pickerCount + initial.state.settingsCount, 'Leaving the popup and its trigger must dismiss the Header menu').toBe(0)
      await closed()
      await expect(primary).toBeFocused()
      expect(initial.observations.focus.length).toBe(departureFocus)
      expect(initial.observations.keys.at(-1)?.defaultPrevented).toBe(false)

      await open()
      const internalFocus = (await observations(page)).focus.length
      const internal = kind === 'picker' ? picker.getByRole('button', { name: new RegExp(sourceName) }) : settingsMenu.locator('button').last()
      await page.keyboard.press('Tab')
      await expect(internal).toBeFocused()
      await expect(popup).toBeVisible()
      expect((await observations(page)).focus.length).toBe(internalFocus)
      const kept = await record(page, app, info, language, kind, before, 'internal-native-tab-keeps-own-popup')
      expect(kept.state.pickerCount + kept.state.settingsCount).toBe(1)
      if (kind === 'picker') expect(kept.state.sourceQuery).toBe('Header')
      await page.keyboard.press('Escape')
      await closed()
      await expect(trigger).toBeFocused()

      await open()
      const owner = kind === 'picker' ? sourceSearch : edit
      const ownerBefore = await owner.evaluate(element => ({ tag: element.tagName, text: element.textContent }))
      const refreshFocus = (await observations(page)).focus.length
      await refresh.click()
      await twoFrames(page)
      await closed()
      // Refresh deliberately prevents its native pointer focus. Dismissal must
      // not supply another owner when the old popup input/button is removed.
      expect((await observations(page)).focus.length).toBe(refreshFocus)
      await expect(refresh).not.toBeFocused()
      expect((await observations(page)).pointers.at(-1)).toMatchObject({ refresh: true, defaultPrevented: true, isPrimary: true, button: 0 })
      const refreshed = await record(page, app, info, language, kind, before, 'header-refresh-pointer-dismisses-without-return-focus')
      expect(refreshed.state.pickerCount + refreshed.state.settingsCount).toBe(0)
      expect(refreshed.state.active?.source || refreshed.state.active?.settings).toBe(false)
      expect(ownerBefore.tag).toBe(kind === 'picker' ? 'INPUT' : 'BUTTON')

      await open()
      if (kind === 'picker') await expect(sourceSearch).toHaveValue('Header')
      const peer = kind === 'picker' ? settings : source
      const peerFocus = (await observations(page)).focus.length
      await peer.click()
      await twoFrames(page)
      await expect(popup).toHaveCount(0)
      await expect(kind === 'picker' ? settingsMenu : picker).toBeVisible()
      const exclusive = await record(page, app, info, language, kind, before, 'peer-menu-open-closes-only-previous-popup')
      expect(exclusive.state.pickerCount + exclusive.state.settingsCount).toBe(1)
      expect(exclusive.observations.focus.length).toBe(peerFocus + (kind === 'settings' ? 1 : 0))
      await page.keyboard.press('Escape')
      await closed()

      await open()
      const pointerFocus = (await observations(page)).focus.length
      // The exposed left edge is outside the source popup even when it covers
      // the central query area; this is an actual Chromium pointer action.
      await query.click({ position: { x: 8, y: 10 } })
      await expect(query).toBeFocused()
      await closed()
      await query.fill('Original ')
      const external = await record(page, app, info, language, kind, before, 'outside-pointer-preserves-query-draft-and-selection', 'Original ')
      expect(external.state.dirty).toBe(true)
      expect(external.observations.focus.length).toBe(pointerFocus)
      await open()
      if (kind === 'picker') await expect(sourceSearch).toHaveValue('Header')
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      await closed()
      const draft = await record(page, app, info, language, kind, before, 'owned-escape-keeps-query-draft-and-stable-trigger', 'Original ')
      expect(draft.state.dirty).toBe(true)
      expect(kind === 'picker' ? draft.state.active?.source : draft.state.active?.settings).toBe(true)

      await open()
      const formAction = kind === 'picker' ? picker.getByRole('button', { name: text.newDatabase, exact: true }) : edit
      await tabTo(page, formAction)
      await page.keyboard.press('Enter')
      const form = page.locator('.dbw-form-dialog'), name = form.getByLabel(text.name, { exact: true })
      await expect(form).toBeVisible()
      await expect(name).toBeFocused()
      await closed()
      if (kind === 'settings') await expect(name).toHaveValue(sourceName)
      await name.fill('Unsaved Header form')
      await tabTo(page, form.getByRole('button', { name: text.cancel, exact: true }))
      await page.keyboard.press('Enter')
      await expect(form).toHaveCount(0)
      await expect(trigger).toBeFocused()
      const cancelled = await record(page, app, info, language, kind, before, 'real-create-edit-form-cancel-keeps-original-trigger-and-draft', 'Original ')
      expect(cancelled.state.dirty).toBe(true)
      expect(kind === 'picker' ? cancelled.state.active?.source : cancelled.state.active?.settings).toBe(true)

      await open()
      const recordFocus = (await observations(page)).focus.length
      await primary.click()
      const recordForm = page.locator('.dbw-create-record-dialog')
      await expect(recordForm).toBeVisible()
      await closed()
      const closeRecord = recordForm.getByRole('button', { name: text.close, exact: true })
      await expect(recordForm.locator('input').first()).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(closeRecord).toBeFocused()
      await page.screenshot({ path: info.outputPath(language + '-' + kind + '-real-record-close-owner-before-cancel.png') })
      await page.keyboard.press('Enter')
      await expect(recordForm).toHaveCount(0)
      const recordCancelled = await record(page, app, info, language, kind, before, 'header-new-record-cancel-dismisses-menu-and-keeps-draft', 'Original ')
      expect(recordCancelled.state.dirty).toBe(true)
      expect(recordCancelled.observations.focus.length).toBeGreaterThan(recordFocus)

      await page.getByRole('button', { name: text.resetView, exact: true }).click()
      await expect(query).toHaveValue('Original')
      await closed()
      const final = await record(page, app, info, language, kind, before, 'final-reset-preserves-source-view-records-and-schema')
      expect(final.state.dirty).toBe(false)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
