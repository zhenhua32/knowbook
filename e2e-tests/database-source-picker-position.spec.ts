import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __sourcePickerPositionProbe?: Probe }
const prefix = 'Atlas shared identity '
const sourceName = (suffix: string) => prefix + 'SharedIdentityWithoutBreaks'.repeat(5) + ' ' + suffix
const description = (suffix: string) => 'Shared description for closely related project collections. '.repeat(3) + suffix
const names = { alpha: sourceName('AlphaDistinctEnd'), beta: sourceName('BetaDistinctEnd'), tall: prefix + 'Large description' }
const descriptions = { alpha: description('AlphaDescriptionEnd'), beta: description('BetaDescriptionEnd'),
  tall: 'Scrollable description keeps every detail available. '.repeat(35) + 'TallDescriptionEnd' }

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 64; step++) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}
async function prepare(page: Page, language: Language, width: number) {
  const ids = await page.evaluate(async ({ language, names, descriptions }) => {
    const ids: Record<string, string> = {}
    for (const key of ['alpha', 'beta', 'tall'] as const) {
      const source = await window.knowbook.createDocumentDatabase({ name: names[key], description: descriptions[key] })
      ids[key] = source.id
      const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: source.id, name: 'Notes', type: 'text' })
      const hidden = await window.knowbook.createDocumentDatabaseColumn({ databaseId: source.id, name: 'Hidden', type: 'text' })
      await window.knowbook.createDatabaseEntity({ databaseId: source.id, title: key + ' original record',
        fieldValues: { [notes.id]: key + ' original Notes', [hidden.id]: key + ' hidden metadata' } })
      const view = await window.knowbook.createDatabaseSavedView({ databaseId: source.id, name: key + ' original table', config: {
        version: 1, layout: 'table', query: key, filters: { operator: 'and', rules: [] }, sorts: [{ fieldId: notes.id, direction: 'asc' }],
        groupBy: { fieldId: null }, visibleFieldIds: ['__title__', notes.id], fieldOrder: ['__title__', notes.id, hidden.id],
        columnWidths: {}, cardFieldIds: [notes.id] } })
      localStorage.setItem('knowbook.database.last-view.' + source.id, view.id)
    }
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', ids.alpha)
    return ids
  }, { language, names, descriptions })
  await page.reload()
  await page.setViewportSize({ width, height: 440 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', names.alpha)
  await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(1)
  return ids
}

// Probes delegate every mutation handler and compare both the API and the actual database.
async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__sourcePickerPositionProbe = probe
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

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, width: number,
  before: Awaited<ReturnType<typeof readStored>>, phase: string, expectedForms = 0, expectedTriggerRetained = true) {
  const state = await page.evaluate(() => {
    const metric = (element: HTMLElement | null) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      const clips = []
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
        const bl = parseFloat(style.borderLeftWidth) || 0, br = parseFloat(style.borderRightWidth) || 0
        const bt = parseFloat(style.borderTopWidth) || 0, bb = parseFloat(style.borderBottomWidth) || 0
        const verticalScrollbar = Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - bl - br)
        const horizontalScrollbar = Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - bt - bb)
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, bounds.left + bl); right = Math.min(right, bounds.right - br - verticalScrollbar) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, bounds.top + bt); bottom = Math.min(bottom, bounds.bottom - bb - horizontalScrollbar) }
        clips.push({ className: ancestor.className, overflowX: style.overflowX, overflowY: style.overflowY,
          left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom })
        if (style.position === 'fixed') break
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        clip: { left, top, right, bottom }, clips,
        fullyVisible: rect.width > 0 && rect.height > 0 && rect.left >= left && rect.right <= right && rect.top >= top && rect.bottom <= bottom,
        centerHit: hit === element || Boolean(hit && element.contains(hit)), focused: document.activeElement === element }
    }
    const popup = document.querySelector<HTMLElement>('.dbw-source-picker'), list = document.querySelector<HTMLElement>('.dbw-source-list')
    const search = document.querySelector<HTMLInputElement>('.dbw-source-search input'), trigger = document.querySelector('.dbw-source-trigger')
    const observed = window as unknown as { __sourcePickerInput?: HTMLElement; __sourcePickerTrigger?: HTMLElement }
    const active = document.activeElement
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      source: trigger?.getAttribute('title'), sourceId: localStorage.getItem('knowbook.database.last-source'),
      savedView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      sourceQuery: search?.value ?? null, selection: search ? [search.selectionStart, search.selectionEnd] : null,
      inputRetained: search === observed.__sourcePickerInput, triggerRetained: trigger === observed.__sourcePickerTrigger,
      popup: metric(popup), search: metric(search), create: metric(document.querySelector('.dbw-menu-create')),
      list: list ? { ...metric(list)!, scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } : null,
      style: popup ? { top: popup.style.top, left: popup.style.left, maxHeight: popup.style.maxHeight, maxWidth: popup.style.maxWidth,
        scrollTop: popup.scrollTop, overflowY: getComputedStyle(popup).overflowY } : null,
      active: active instanceof HTMLElement ? { className: active.className, text: active.textContent, label: active.getAttribute('aria-label'),
        sourceTrigger: active === trigger, sourceSearch: active === search, create: active.matches('.dbw-menu-create'),
        option: active.matches('.dbw-source-option') } : null,
      options: Array.from(document.querySelectorAll<HTMLButtonElement>('.dbw-source-option')).map(option => ({
        name: option.querySelector('strong')!.textContent, focused: active === option, box: metric(option)?.box })),
      outerScroll: { windowX: scrollX, windowY: scrollY, document: document.scrollingElement?.scrollTop,
        canvas: document.querySelector('.content.page-database')?.scrollTop },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      forms: document.querySelectorAll('.dbw-form-dialog, .dbw-create-record-dialog, .app-confirm-dialog').length,
      form: metric(document.querySelector('.dbw-form-dialog')) }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const probe = await app.evaluate(() => (globalThis as ProbeGlobal).__sourcePickerPositionProbe!)
  const stored = await readStored(page, app, language)
  const result = { phase, language, width, state, windows, probe, before, stored }
  const path = info.outputPath(language + '-' + width + '-' + phase + '.json')
  writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(language + '-' + width + '-' + phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(probe).toEqual({ requests: [], writes: [], failures: [] })
  expect(stored).toEqual(before)
  expect(state.horizontalOverflow).toBe(false)
  expect(state.forms).toBe(expectedForms)
  expect(state.triggerRetained).toBe(expectedTriggerRetained)
  return result
}

function assertSurface(result: Awaited<ReturnType<typeof record>>) {
  for (const metric of [result.state.popup, result.state.search, result.state.create]) {
    expect(metric).not.toBeNull()
    expect(metric!.fullyVisible, 'The popup, search and Create must fit the actual viewport and ancestor clip').toBe(true)
    expect(metric!.centerHit).toBe(true)
  }
  expect(result.state.list!.clientHeight).toBeGreaterThan(0)
  expect(result.state.list!.clientHeight).toBeLessThanOrEqual(320)
  expect(result.state.style!.scrollTop).toBe(0)
}

async function observeInput(page: Page) {
  await page.evaluate(() => {
    const observed = window as unknown as { __sourcePickerInput?: HTMLElement; __sourcePickerTrigger?: HTMLElement }
    observed.__sourcePickerInput = document.querySelector<HTMLElement>('.dbw-source-search input')!
    observed.__sourcePickerTrigger = document.querySelector<HTMLElement>('.dbw-source-trigger')!
  })
}
async function wheelToDescriptionEnd(page: Page, option: Locator) {
  const list = page.locator('.dbw-source-list'), bounds = await list.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width - 8, bounds!.y + bounds!.height / 2)
  for (let step = 0; step < 40; step++) {
    const visible = await option.locator('small').evaluate(element => {
      const text = element.textContent!, range = document.createRange(), index = text.lastIndexOf('TallDescriptionEnd')
      range.setStart(element.firstChild!, index); range.setEnd(element.firstChild!, text.length)
      const rect = range.getBoundingClientRect(), list = element.closest('.dbw-source-list')!.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return rect.top >= list.top && rect.bottom <= list.bottom && rect.left >= list.left && rect.right <= list.right
        && Boolean(hit && element.closest('.dbw-source-option')!.contains(hit))
    })
    if (visible) return
    await page.mouse.wheel(0, 80)
    await twoFrames(page)
  }
  throw new Error('Native list scrolling must expose the actual final description characters')
}

for (const language of ['en-US', 'zh-CN'] as const) for (const width of [760, 1100]) {
  test(`Source picker fits short windows and retains its controls and draft in ${language} at ${width}px @electron`, async ({}, info) => {
    test.setTimeout(120000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language, width), text = getDatabaseWorkspaceText(language)
      const before = await readStored(page, app, language)
      await installProbe(app)
      const trigger = page.locator('.dbw-source-trigger'), search = page.locator('.dbw-source-search input')
      const beta = page.locator('.dbw-source-option').filter({ has: page.locator('strong', { hasText: names.beta }) })
      const tall = page.locator('.dbw-source-option').filter({ has: page.locator('strong', { hasText: names.tall }) })
      const create = page.getByRole('button', { name: text.newDatabase, exact: true })
      await page.mouse.move(1, 1)
      await trigger.click()
      await expect(search).toBeFocused()
      await observeInput(page)
      await twoFrames(page)
      const first = await record(page, app, info, language, width, before, 'initial-short-window-many-sources-before-first-geometry-oracle')
      assertSurface(first)
      expect(first.state.inputRetained).toBe(true)
      expect(first.state.sourceId).toBe(ids.alpha)
      expect(first.state.list!.scrollHeight).toBeGreaterThan(first.state.list!.clientHeight)
      await search.fill(prefix)
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+ArrowRight')
      await page.keyboard.press('Shift+ArrowRight')
      const selection = await search.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])
      await page.setViewportSize({ width, height: 760 })
      await twoFrames(page)
      const expanded = await record(page, app, info, language, width, before, 'tall-window-keeps-original-search-node-focus-selection-and-query')
      assertSurface(expanded)
      expect(expanded.state.list!.clientHeight).toBe(320)
      expect(expanded.state.inputRetained).toBe(true)
      expect(expanded.state.active?.sourceSearch).toBe(true)
      expect(expanded.state.selection).toEqual(selection)
      expect(expanded.state.sourceQuery).toBe(prefix)
      await page.setViewportSize({ width, height: 440 })
      await twoFrames(page)
      const compact = await record(page, app, info, language, width, before, 'short-window-reflow-preserves-search-node-caret-and-query')
      assertSurface(compact)
      expect(compact.state.list!.clientHeight).toBeLessThan(320)
      expect(compact.state.inputRetained).toBe(true)
      expect(compact.state.active?.sourceSearch).toBe(true)
      expect(compact.state.selection).toEqual(selection)
      expect(compact.state.sourceQuery).toBe(prefix)
      await tabTo(page, tall)
      await wheelToDescriptionEnd(page, tall)
      const scrolled = await record(page, app, info, language, width, before, 'native-wheel-reads-long-description-with-search-and-create-still-visible')
      assertSurface(scrolled)
      expect(scrolled.state.options.find(option => option.name === names.tall)?.focused).toBe(true)
      expect(scrolled.state.list!.scrollTop).toBeGreaterThan(0)
      expect(scrolled.state.outerScroll).toEqual(first.state.outerScroll)
      await tabTo(page, create)
      const footer = await record(page, app, info, language, width, before, 'real-tab-reaches-visible-create-entry-without-outer-scroll')
      assertSurface(footer)
      expect(footer.state.active?.create).toBe(true)
      expect(footer.state.outerScroll).toEqual(first.state.outerScroll)
      await page.keyboard.press('Enter')
      const form = page.locator('.dbw-form-dialog'), name = form.getByRole('textbox', { name: text.name, exact: true })
      await expect(name).toBeFocused()
      await name.fill('Unsaved short-window database')
      const editing = await record(page, app, info, language, width, before, 'actual-create-form-starts-without-persisting', 1)
      expect(editing.state.form!.fullyVisible).toBe(true)
      await tabTo(page, form.getByRole('button', { name: text.cancel, exact: true }))
      await page.keyboard.press('Enter')
      await expect(form).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(search).toHaveValue(prefix)
      await twoFrames(page)
      const returned = await record(page, app, info, language, width, before, 'cancel-returns-original-source-trigger-and-preserves-picker-search')
      assertSurface(returned)
      expect(returned.state.active?.sourceSearch).toBe(true)
      await search.fill('no matching source for short-window test')
      await twoFrames(page)
      const empty = await record(page, app, info, language, width, before, 'empty-search-keeps-natural-small-surface-and-create-reachable')
      assertSurface(empty)
      expect(empty.state.options).toHaveLength(0)
      expect(empty.state.popup!.box.height).toBeLessThan(first.state.popup!.box.height)
      await search.fill(prefix)
      await tabTo(page, beta)
      await page.keyboard.press('Enter')
      await expect(trigger).toHaveAttribute('title', names.beta)
      const selected = await record(page, app, info, language, width, before, 'actual-source-selection-keeps-exact-id-original-view-and-zero-writes', 0, false)
      expect(selected.state.sourceId).toBe(ids.beta)
      expect(selected.state.savedView).toBe('beta original table')
      expect(selected.state.query).toBe('beta')
      expect(selected.state.popup).toBeNull()
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
