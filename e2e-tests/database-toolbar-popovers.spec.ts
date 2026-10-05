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
type ProbeGlobal = typeof globalThis & { __toolbarPopoverProbe?: Probe }
const sourceName = 'Toolbar popover source'
const viewName = 'Original popover table'
const recordTitle = 'Original selected popover record'
type MenuKind = 'filter' | 'sort'

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
    ;(globalThis as ProbeGlobal).__toolbarPopoverProbe = probe
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
    const popup = menu.querySelector<HTMLElement>('.dbw-config-popover')!, summary = menu.querySelector('summary')!
    const shell = menu.closest('.dbw-shell')!, shellRect = shell.getBoundingClientRect()
    const rectangle = (element: Element) => { const box = element.getBoundingClientRect(); return {
      left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } }
    const popupRect = rectangle(popup), triggerRect = rectangle(summary)
    const add = popup.querySelector<HTMLElement>('.dbw-add-config-row')!, addRect = add.getBoundingClientRect()
    const hit = document.elementFromPoint(addRect.left + addRect.width / 2, addRect.top + addRect.height / 2)
    const visibleControls = Array.from(popup.querySelectorAll<HTMLElement>('button, input, select')).flatMap(control => {
      const box = rectangle(control), x = box.left + box.width / 2, y = box.top + box.height / 2
      if (!box.width || !box.height || x <= popupRect.left || x >= popupRect.right || y <= popupRect.top || y >= popupRect.bottom) return []
      const top = document.elementFromPoint(x, y)
      return [{ tag: control.tagName, label: control.getAttribute('aria-label'), box,
        centerHit: top === control || Boolean(top && control.contains(top)) }]
    })
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
      openMenus: document.querySelectorAll('.dbw-toolbar-menu[open]').length,
      geometry: { popup: popupRect, trigger: triggerRect, bounds: {
        left: Math.max(10, shellRect.left + 10), right: Math.min(innerWidth - 10, shellRect.right - 10),
        top: Math.max(10, shellRect.top + 10), bottom: Math.min(innerHeight - 10, shellRect.bottom - 10) },
        gapToTrigger: Math.min(Math.abs(popupRect.top - triggerRect.bottom), Math.abs(triggerRect.top - popupRect.bottom)),
        horizontalOverlap: Math.min(popupRect.right, triggerRect.right) - Math.max(popupRect.left, triggerRect.left),
        clientWidth: popup.clientWidth, scrollWidth: popup.scrollWidth, clientHeight: popup.clientHeight,
        scrollHeight: popup.scrollHeight, scrollTop: popup.scrollTop, visibleControls,
        add: rectangle(add), addCenterHit: hit === add || Boolean(hit && add.contains(hit)) },
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
  const probe = await app.evaluate(() => (globalThis as ProbeGlobal).__toolbarPopoverProbe!)
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

function expectAnchored(result: Awaited<ReturnType<typeof record>>) {
  const { popup, bounds, gapToTrigger, horizontalOverlap, clientWidth, scrollWidth } = result.state.geometry
  expect(result.state.menuOpen).toBe(true)
  expect(result.state.openMenus).toBe(1)
  expect(popup.width).toBeGreaterThan(0)
  expect(popup.height).toBeGreaterThan(0)
  expect(gapToTrigger, 'Popover must follow its own summary rather than the full wrapped toolbar').toBeLessThanOrEqual(9)
  expect(horizontalOverlap).toBeGreaterThan(0)
  expect(popup.left).toBeGreaterThanOrEqual(bounds.left - 1)
  expect(popup.right).toBeLessThanOrEqual(bounds.right + 1)
  expect(popup.top).toBeGreaterThanOrEqual(bounds.top - 1)
  expect(popup.bottom).toBeLessThanOrEqual(bounds.bottom + 1)
  expect(scrollWidth - clientWidth).toBeLessThanOrEqual(1)
  expect(result.state.geometry.visibleControls.length).toBeGreaterThan(0)
  expect(result.state.geometry.visibleControls.every(control => control.centerHit), 'Visible popup controls must remain above the header and view tabs').toBe(true)
  expect(result.state.confirmCount).toBe(0)
}

for (const language of ['en-US', 'zh-CN'] as const) for (const kind of ['filter', 'sort'] as const) {
  test(`${kind} popover follows its summary and dismisses without losing drafts in ${language} @electron`, async ({}, info) => {
    test.setTimeout(180_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await prepare(page, language)
      await page.setViewportSize({ width: language === 'en-US' ? 1100 : 980, height: 760 })
      await installProbe(app)
      await installObservations(page)
      const before = await readStored(page, app, language), text = getDatabaseWorkspaceText(language)
      const menu = page.locator('.dbw-toolbar-menu').nth(kind === 'filter' ? 0 : 1)
      const summary = menu.locator('summary'), popup = menu.locator('.dbw-config-popover')
      const rows = menu.locator(kind === 'filter' ? '.dbw-filter-row' : '.dbw-config-row')
      const owner = kind === 'filter' ? rows.first().locator('input') : rows.first().locator('select').nth(1)
      const add = menu.locator('.dbw-add-config-row')
      const peer = page.locator('.dbw-toolbar-menu').nth(kind === 'filter' ? 1 : 0)
      const query = page.locator('.dbw-main-search input'), fields = page.locator('.dbw-toolbar > .dbw-toolbar-button')
      const steps: unknown[] = []
      const open = async () => {
        if (!(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await summary.click()
        await expect(menu).toHaveJSProperty('open', true)
        await expect(popup).toBeVisible()
        await twoFrames(page)
      }
      await open()
      const initial = await record(page, app, info, language, kind, before, 'first-open-before-anchor-business-oracle', steps)
      expectAnchored(initial)

      await tabTo(page, owner)
      await page.keyboard.press('Escape')
      await expect(menu).toHaveJSProperty('open', false)
      await expect(summary).toBeFocused()
      const escape = await record(page, app, info, language, kind, before, 'escape-closes-and-returns-summary', steps)
      expect(escape.state.dirty).toBe(false)

      await page.keyboard.press('Enter')
      await expect(menu).toHaveJSProperty('open', true)
      await tabTo(page, owner)
      if (kind === 'filter') await owner.fill('Original ')
      else await owner.selectOption('desc')
      // Composition is an explicit renderer fixture; real navigation and
      // ordinary Escape use the actual browser keyboard, without OS IME UI.
      await owner.dispatchEvent('compositionstart', { data: '文' })
      await page.keyboard.press('Escape')
      await expect(menu).toHaveJSProperty('open', true)
      await expect(owner).toBeFocused()
      await owner.dispatchEvent('compositionend', { data: '文' })
      await page.keyboard.press('Escape')
      await expect(menu).toHaveJSProperty('open', false)
      await expect(summary).toBeFocused()
      const draft = await record(page, app, info, language, kind, before, 'ime-keeps-draft-ordinary-escape-dismisses', steps)
      expect(draft.state.dirty).toBe(true)
      await open()
      await expect(owner).toHaveValue(kind === 'filter' ? 'Original ' : 'desc')
      await popup.locator('strong').first().click()
      await expect(menu).toHaveJSProperty('open', true)
      const inside = await record(page, app, info, language, kind, before, 'internal-pointer-keeps-current-draft', steps)
      expectAnchored(inside)

      await peer.locator('summary').click()
      await expect(peer).toHaveJSProperty('open', true)
      await expect(menu).toHaveJSProperty('open', false)
      await expect(page.locator('.dbw-toolbar-menu[open]')).toHaveCount(1)
      await summary.click()
      await expect(peer).toHaveJSProperty('open', false)
      await expect(menu).toHaveJSProperty('open', true)
      await expect(owner).toHaveValue(kind === 'filter' ? 'Original ' : 'desc')
      await twoFrames(page)
      const exclusive = await record(page, app, info, language, kind, before, 'peer-menus-exclusive-draft-retained', steps)
      expectAnchored(exclusive)

      await tabTo(page, add)
      const focusBefore = (await observations(page)).focus.length
      await tabTo(page, fields)
      await expect(menu).toHaveJSProperty('open', false)
      await expect(fields).toBeFocused()
      expect((await observations(page)).focus.length).toBe(focusBefore)
      const departure = await record(page, app, info, language, kind, before, 'real-tab-away-closes-without-return-focus', steps)
      expect(departure.state.dirty).toBe(true)

      await open()
      const pointerBefore = (await observations(page)).focus.length
      await query.click()
      await expect(menu).toHaveJSProperty('open', false)
      await expect(query).toBeFocused()
      expect((await observations(page)).focus.length).toBe(pointerBefore)
      const outside = await record(page, app, info, language, kind, before, 'outside-pointer-closes-without-return-focus', steps)
      expect(outside.state.dirty).toBe(true)
      await page.getByRole('button', { name: text.resetView, exact: true }).click()
      await open()
      await expect(owner).toHaveValue(kind === 'filter' ? 'Original' : 'asc')

      await page.setViewportSize({ width: 820, height: 480 })
      await tabTo(page, add)
      for (let count = 0; count < 20; count++) await page.keyboard.press('Enter')
      await expect(rows).toHaveCount(21)
      await tabTo(page, summary, true)
      await tabTo(page, add)
      await expect(add).toBeFocused()
      await twoFrames(page)
      const narrow = await record(page, app, info, language, kind, before, 'short-narrow-long-rules-native-tab-reaches-add', steps)
      expectAnchored(narrow)
      expect(narrow.state.geometry.scrollTop).toBeGreaterThan(0)
      expect(narrow.state.geometry.scrollHeight).toBeGreaterThan(narrow.state.geometry.clientHeight)
      expect(narrow.state.geometry.addCenterHit).toBe(true)

      await page.setViewportSize({ width: 1280, height: 860 })
      await twoFrames(page)
      const resized = await record(page, app, info, language, kind, before, 'resize-reanchors-with-local-draft', steps)
      expectAnchored(resized)
      expect(resized.state[kind === 'filter' ? 'filterCount' : 'sortCount']).toBe(21)
      await page.keyboard.press('Escape')
      await expect(menu).toHaveJSProperty('open', false)
      await expect(summary).toBeFocused()
      await page.getByRole('button', { name: text.resetView, exact: true }).click()
      const final = await record(page, app, info, language, kind, before, 'final-reset-preserves-source-view-records-and-schema', steps)
      expect(final.state.menuOpen).toBe(false)
      expect(final.state.dirty).toBe(false)
      expect(final.state.filterCount).toBe(1)
      expect(final.state.sortCount).toBe(1)
      expect(final.state.confirmCount).toBe(0)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
