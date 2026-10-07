import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Theme = 'light' | 'dark'
type Rectangle = { left: number; top: number; right: number; bottom: number; width: number; height: number }
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; completed: Request[]; holdNextSave: boolean; release?: () => void }
type ProbeGlobal = typeof globalThis & { __databaseToolbarLayoutProbe?: Probe }
const sourceName = 'Toolbar layout source'
const viewName = 'Original toolbar table'
const widths = [1440, 1321, 1320, 1081, 1080, 901, 900, 760]

async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function resize(page: Page, app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 760])
  await settle(page)
  await page.locator('.content.page-database').evaluate(element => { element.scrollTop = 0 })
}

async function collapse(page: Page, collapsed: boolean): Promise<void> {
  if (await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed')) !== collapsed) {
    await page.locator('.rail-toggle-btn').click()
  }
  await settle(page)
}

async function prepare(page: Page, language: Language, theme: Theme) {
  const fixture = await page.evaluate(async ({ language, theme, sourceName, viewName }) => {
    const catalog = (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')!
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Project records and notes.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Original toolbar record', fieldValues: { [field.id]: 'Original toolbar notes' } })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Neighboring toolbar record', fieldValues: { [field.id]: 'Keep neighboring notes' } })
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, viewMode: 'table', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id], columnWidths: {}, cardFieldIds: [field.id]
    } })
    localStorage.setItem('knowbook.database.last-source', catalog.id)
    localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', theme)
    return { catalogId: catalog.id, customId: database.id, view }
  }, { language, theme, sourceName, viewName })
  await page.reload(); await page.locator('[data-page-id="database"]').click()
  await expect(page.locator('.dbw-toolbar')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
  await settle(page)
  return fixture
}

async function selectSource(page: Page, language: Language, custom: boolean): Promise<void> {
  const name = custom ? sourceName : getDatabaseWorkspaceText(language).allDocuments
  if (await page.locator('.dbw-source-trigger').getAttribute('title') === name) return
  await page.locator('.dbw-source-trigger').click()
  await page.locator('.dbw-source-search input').fill(custom ? sourceName : '')
  const option = custom ? page.locator('.dbw-source-option').filter({ hasText: sourceName })
    : page.locator('.dbw-source-option').filter({ has: page.locator('.dbw-system-badge') })
  await expect(option).toHaveCount(1); await option.click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', name)
  await settle(page)
}

async function installProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], completed: [], holdNextSave: false }
    ;(globalThis as ProbeGlobal).__databaseToolbarLayoutProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        const request = { channel, input: structuredClone(input) }; probe.requests.push(request)
        if (channel === 'knowbook:update-database-saved-view' && probe.holdNextSave) {
          probe.holdNextSave = false
          await new Promise<void>(resolve => { probe.release = resolve })
          delete probe.release
        }
        const result = await original(event, ...input); probe.completed.push(request); return result
      })
    }
  })
}

async function readProbe(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__databaseToolbarLayoutProbe!
    return { requests: probe.requests, completed: probe.completed, pendingSave: Boolean(probe.release) }
  })
}

async function readStored(page: Page, app: ElectronApplication, language: Language) {
  const api = await page.evaluate(async language => {
    const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)
    const databases = (await window.knowbook.getDatabases()).sort(byId), catalog = (await window.knowbook.getDocumentCatalog()).sort(byId)
    return { databases, catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: (await window.knowbook.listDocumentTemplates(language)).sort(byId),
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort(byId), fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort(byId),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort(byId) }))) }
  }, language)
  const sql = await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try { return { schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
      tables: Object.fromEntries(['documents', 'blocks', 'links', 'databases', 'document_database_columns', 'database_entities',
        'database_entity_values', 'document_database_values', 'database_saved_views'].map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()])) }
    } finally { database.close() }
  })
  return { api, sql }
}

function expectInside(child: Rectangle, parent: Rectangle, message: string): void {
  expect(child.width, `${message} width`).toBeGreaterThan(0); expect(child.height, `${message} height`).toBeGreaterThan(0)
  expect(child.left, `${message} left`).toBeGreaterThanOrEqual(parent.left - 1); expect(child.top, `${message} top`).toBeGreaterThanOrEqual(parent.top - 1)
  expect(child.right, `${message} right`).toBeLessThanOrEqual(parent.right + 1); expect(child.bottom, `${message} bottom`).toBeLessThanOrEqual(parent.bottom + 1)
}

async function recordToolbar(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, language: Language,
  width: number, phase: string, state: 'clean' | 'dirty' | 'saving' = 'clean') {
  await settle(page); await page.mouse.move(2, 2)
  for (const [selector, count] of [
    ['.dbw-main-search input', 1], ['.dbw-toolbar > .dbw-toolbar-menu > summary', 2], ['.dbw-toolbar > .dbw-toolbar-select select', 1],
    ['.dbw-toolbar > .dbw-toolbar-button', 1], ['.dbw-layout-switcher button', 3], ['.dbw-save-button', 1], ['.dbw-save-as-button', 1],
    ['.dbw-save-actions > .dbw-quiet-button', state === 'clean' ? 0 : 1]
  ] as const) {
    const controls = page.locator(selector); await expect(controls).toHaveCount(count)
    for (let index = 0; index < count; index++) await expect(controls.nth(index)).toBeVisible()
  }
  const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({
    bounds: window.getBounds(), size: window.getSize(), content: window.getContentSize(), minimum: window.getMinimumSize(),
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
  const layout = await page.locator('.dbw-toolbar').evaluate(toolbar => {
    const rectangle = (element: Element): Rectangle => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect(); return { left, top, right, bottom, width, height }
    }
    const visible = (element: HTMLElement) => element.getBoundingClientRect().height > 0
      && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility)
    const text = (element: HTMLElement) => {
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect()
        if (/hidden|clip|auto|scroll/.test(css.overflowX)) { left = Math.max(left, box.left + ancestor.clientLeft); right = Math.min(right, box.left + ancestor.clientLeft + ancestor.clientWidth) }
        if (/hidden|clip|auto|scroll/.test(css.overflowY)) { top = Math.max(top, box.top + ancestor.clientTop); bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight) }
      }
      const glyphs: Array<{ text: string; box: Rectangle; visible: boolean }> = []
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode, value = node.textContent ?? ''
        for (let index = 0; index < value.length;) {
          const glyph = String.fromCodePoint(value.codePointAt(index)!), range = document.createRange()
          range.setStart(node, index); range.setEnd(node, index + glyph.length)
          if (glyph.trim()) { const box = range.getBoundingClientRect()
            glyphs.push({ text: glyph, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
              visible: box.width > 0 && box.height > 0 && box.left >= left - 1 && box.top >= top - 1 && box.right <= right + 1 && box.bottom <= bottom + 1 }) }
          index += glyph.length
        }
      }
      return { text: element.textContent, glyphs, whiteSpace: getComputedStyle(element).whiteSpace, textOverflow: getComputedStyle(element).textOverflow }
    }
    const groups = Array.from(toolbar.querySelectorAll<HTMLElement>(':scope > .dbw-main-search, :scope > .dbw-toolbar-menu > summary, :scope > .dbw-toolbar-select, :scope > .dbw-toolbar-button, :scope > .dbw-layout-switcher, :scope > .dbw-record-count, :scope > .dbw-save-actions'))
      .filter(visible).map(element => ({ className: element.className, box: rectangle(element) }))
    const rows: number[] = []
    for (const group of groups) { const y = group.box.top + group.box.height / 2; if (!rows.some(previous => Math.abs(y - previous) < 6)) rows.push(y) }
    const controls = Array.from(toolbar.querySelectorAll<HTMLElement>(':scope > .dbw-main-search input, :scope > .dbw-main-search button, :scope > .dbw-toolbar-menu > summary, :scope > .dbw-toolbar-select select, :scope > .dbw-toolbar-button, :scope > .dbw-layout-switcher button, :scope > .dbw-save-actions button'))
      .filter(visible).map(element => {
        const box = rectangle(element), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { className: element.className, tag: element.tagName, label: element.getAttribute('aria-label') || element.textContent,
          box, hit: hit === element || Boolean(hit && element.contains(hit)), disabled: element.matches(':disabled') }
      })
    const labels = Array.from(toolbar.querySelectorAll<HTMLElement>(':scope > .dbw-toolbar-menu > summary, :scope > .dbw-toolbar-select > span:nth-child(2), :scope > .dbw-toolbar-button, :scope > .dbw-save-actions > .dbw-quiet-button, :scope > .dbw-save-actions > .dbw-save-button')).filter(visible).map(text)
    const input = toolbar.querySelector<HTMLInputElement>('.dbw-main-search input')!, css = getComputedStyle(input)
    const context = document.createElement('canvas').getContext('2d')!; context.font = css.font
    const selected = toolbar.querySelector<HTMLSelectElement>('.dbw-toolbar-select select')!, selectedCss = getComputedStyle(selected)
    const selectedText = selected.selectedOptions[0].textContent!; context.font = selectedCss.font
    const group = { text: selectedText, value: selected.value, width: selected.clientWidth, measuredTextWidth: context.measureText(selectedText).width }
    context.font = css.font
    const search = { value: input.value, placeholder: input.placeholder, box: rectangle(input), available: input.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
      measuredTextWidth: context.measureText(input.value || input.placeholder).width, font: css.font, scrollLeft: input.scrollLeft }
    const toolbarCss = getComputedStyle(toolbar), searchCss = getComputedStyle(input.parentElement!)
    return { inner: [innerWidth, innerHeight], viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight },
      theme: document.documentElement.dataset.theme, palette: document.documentElement.getAttribute('data-knowbook-theme-switcher'), toolbar: rectangle(toolbar),
      headerHeight: document.querySelector('.dbw-header')!.getBoundingClientRect().height, horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      groups, rowCount: rows.length, controls, labels, search, group, gap: toolbarCss.gap, searchMinWidth: searchCss.minWidth, searchBasis: searchCss.flexBasis,
      toolbarPaddingRight: parseFloat(toolbarCss.paddingRight), toolbarBorderRight: parseFloat(toolbarCss.borderRightWidth),
      saveText: toolbar.querySelector('.dbw-save-button')!.textContent, saving: toolbar.querySelector('.dbw-save-button')!.getAttribute('aria-busy'),
      resetPresent: Boolean(toolbar.querySelector('.dbw-save-actions > .dbw-quiet-button')), source: document.querySelector('.dbw-source-trigger')!.getAttribute('title') }
  })
  const probe = await readProbe(app)
  writeFileSync(info.outputPath(`${phase}.json`), JSON.stringify({ phase, state, native, tempRoot, layout, probe }, null, 2))
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(native.userData.toLowerCase()).toBe(tempRoot.toLowerCase())
  expect(native.windows.length).toBeGreaterThan(0); expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(native.windows[0].minimum).toEqual([760, 760]); expect(native.windows[0].bounds.width).toBe(native.windows[0].size[0]); expect(native.windows[0].bounds.height).toBe(native.windows[0].size[1])
  expect(native.windows[0].content).toEqual([width, 760]); expect(layout.inner).toEqual(native.windows[0].content)
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
  expectInside(layout.toolbar, layout.viewport, 'toolbar')
  for (const group of layout.groups) expectInside(group.box, layout.toolbar, group.className)
  const saveActions = layout.groups.find(group => group.className === 'dbw-save-actions')!
  expect(Math.abs(saveActions.box.right - (layout.toolbar.right - layout.toolbarPaddingRight - layout.toolbarBorderRight)), 'Save actions stay aligned with the toolbar inner right edge').toBeLessThanOrEqual(1)
  for (const control of layout.controls) { expectInside(control.box, layout.toolbar, control.label ?? control.className); expect(control.hit, `native hit target: ${control.label}`).toBe(true)
    if (control.tag !== 'BUTTON' || !['Clear search', '清除搜索'].includes(control.label ?? '')) expect(control.box.height).toBeGreaterThanOrEqual(36)
    if (/dbw-(save-button|save-as-button|quiet-button)/.test(control.className)) expect(control.box.height).toBeGreaterThanOrEqual(40) }
  expect(layout.groups.find(group => group.className.includes('dbw-main-search'))!.box.height).toBeGreaterThanOrEqual(40)
  for (const label of layout.labels) { expect(label.glyphs.length).toBeGreaterThan(0); expect(label.glyphs.every(glyph => glyph.visible), `complete toolbar glyphs: ${label.text}`).toBe(true); expect(label.textOverflow).not.toBe('ellipsis') }
  const text = getDatabaseWorkspaceText(language)
  expect(layout.labels.map(label => label.text)).toContain(text.group)
  expect(layout.labels[0].text).toBe(`◇${text.filter}`); expect(layout.labels[1].text).toBe(`⇅${text.sort}`)
  expect(layout.labels.find(label => label.text?.startsWith('☷'))!.text).toMatch(new RegExp(`^☷${text.fields}\\d+$`))
  expect(layout.group.text).toBe(text.noGrouping); expect(layout.group.value).toBe(''); expect(layout.group.measuredTextWidth + 12).toBeLessThanOrEqual(layout.group.width)
  expect(layout.search.placeholder).toBe(text.search); expect(layout.search.available).toBeGreaterThanOrEqual(120)
  expect(layout.search.measuredTextWidth).toBeLessThanOrEqual(layout.search.available); expect(layout.search.scrollLeft).toBe(0)
  expect(layout.saveText).toBe(state === 'saving' ? text.saving : state === 'dirty' ? text.saveChanges : text.saved)
  expect(layout.resetPresent).toBe(state !== 'clean'); expect(layout.saving).toBe(state === 'saving' ? 'true' : 'false')
  expect(layout.rowCount).toBeLessThanOrEqual(2); if (width === 760) { expect(layout.rowCount).toBe(2); expect(layout.toolbar.height).toBeLessThanOrEqual(110) }
  if (width === 1321 && state === 'clean') expect(layout.rowCount).toBe(1)
  return layout
}

async function localStates(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, language: Language, width: number, prefix: string): Promise<void> {
  await recordToolbar(page, app, tempRoot, info, language, width, `${prefix}-clean`)
  await page.locator('.dbw-main-search input').fill('Original')
  await expect(page.locator('.dbw-save-actions > .dbw-quiet-button')).toBeVisible()
  await recordToolbar(page, app, tempRoot, info, language, width, `${prefix}-dirty`, 'dirty')
  await page.locator('.dbw-save-actions > .dbw-quiet-button').click()
  await expect(page.locator('.dbw-main-search input')).toHaveValue(''); await expect(page.locator('.dbw-save-button')).toBeDisabled()
  expect((await readProbe(app)).requests).toEqual([])
}

async function exerciseKeyboard(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo): Promise<void> {
  await selectSource(page, 'en-US', true); await collapse(page, false); await resize(page, app, 760)
  const search = page.locator('.dbw-main-search input'); await search.fill('Original')
  const summaries = page.locator('.dbw-toolbar > .dbw-toolbar-menu > summary'), fields = page.locator('.dbw-toolbar > .dbw-toolbar-button')
  const controls: Array<[string, Locator]> = [['search', search], ['clear-search', page.locator('.dbw-main-search button')],
    ['filter', summaries.nth(0)], ['sort', summaries.nth(1)], ['group', page.locator('.dbw-toolbar-select select')], ['fields', fields],
    ['table', page.locator('.dbw-layout-switcher button').nth(0)], ['board', page.locator('.dbw-layout-switcher button').nth(1)],
    ['cards', page.locator('.dbw-layout-switcher button').nth(2)], ['reset', page.locator('.dbw-save-actions > .dbw-quiet-button')],
    ['save', page.locator('.dbw-save-button')], ['save-as', page.locator('.dbw-save-as-button')]]
  const steps: unknown[] = []
  const recordFocus = async (phase: string, target: Locator) => {
    await expect(target).toBeFocused()
    const state = await target.evaluate(element => {
      const box = element.getBoundingClientRect(), css = getComputedStyle(element)
      const outline = css.outlineStyle === 'none' ? 0 : Math.max(0, parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset))
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
        if (/hidden|clip|auto|scroll/.test(style.overflowX)) { left = Math.max(left, bounds.left + ancestor.clientLeft); right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth) }
        if (/hidden|clip|auto|scroll/.test(style.overflowY)) { top = Math.max(top, bounds.top + ancestor.clientTop); bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight) }
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { label: element.getAttribute('aria-label') || element.textContent, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height },
        outline, clip: { left, top, right, bottom }, hit: hit === element || Boolean(hit && element.contains(hit)) }
    })
    steps.push({ phase, state }); expect(state.hit).toBe(true)
    expect(state.box.left - state.outline).toBeGreaterThanOrEqual(state.clip.left - 1)
    expect(state.box.top - state.outline).toBeGreaterThanOrEqual(state.clip.top - 1)
    expect(state.box.right + state.outline).toBeLessThanOrEqual(state.clip.right + 1)
    expect(state.box.bottom + state.outline).toBeLessThanOrEqual(state.clip.bottom + 1)
  }
  await recordFocus('initial-search', search)
  for (const [name, control] of controls.slice(1)) { await page.keyboard.press('Tab'); await recordFocus(`tab-${name}`, control) }
  for (const [name, control] of controls.slice(0, -1).reverse()) { await page.keyboard.press('Shift+Tab'); await recordFocus(`reverse-tab-${name}`, control) }
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
  for (const kind of [0, 1]) {
    const summary = summaries.nth(kind), menu = page.locator('.dbw-toolbar-menu').nth(kind)
    await recordFocus(`before-open-${kind}`, summary); await page.keyboard.press('Enter')
    await expect(menu).toHaveJSProperty('open', true)
    await page.keyboard.press('Tab')
    const active = page.locator('.dbw-toolbar-menu[open] :focus')
    await expect(active).toHaveCount(1); await recordFocus(`open-menu-${kind}`, active)
    await page.keyboard.press('Escape'); await expect(menu).toHaveJSProperty('open', false)
    await recordFocus(`escape-menu-${kind}`, summary); await page.keyboard.press('Tab')
  }
  await recordFocus('group-after-menus', controls[4][1]); await page.keyboard.press('Tab')
  await recordFocus('fields-before-open', fields); await page.keyboard.press('Enter')
  await expect(page.locator('.dbw-field-drawer')).toBeVisible()
  await recordFocus('field-drawer-close', page.locator('.dbw-field-drawer header button'))
  await page.keyboard.press('Escape'); await expect(page.locator('.dbw-field-drawer')).toHaveCount(0)
  await recordFocus('fields-after-escape', fields)
  await recordToolbar(page, app, tempRoot, info, 'en-US', 760, 'keyboard-wrap-complete', 'dirty')
  await page.locator('.dbw-save-actions > .dbw-quiet-button').click(); await expect(search).toHaveValue('')
  expect((await readProbe(app)).requests).toEqual([])
  writeFileSync(info.outputPath('keyboard-native-760.json'), JSON.stringify({ steps, probe: await readProbe(app) }, null, 2))
}

function withoutViews(stored: Awaited<ReturnType<typeof readStored>>) {
  const { database_saved_views: _views, ...tables } = stored.sql.tables
  return { api: { ...stored.api, sources: stored.api.sources.map(({ views: _views, ...source }) => source) }, sql: { ...stored.sql, tables } }
}

async function exerciseRealSaving(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, language: Language, fixture: Awaited<ReturnType<typeof prepare>>) {
  const text = getDatabaseWorkspaceText(language)
  await selectSource(page, language, true); await collapse(page, false); await resize(page, app, 760)
  const before = await readStored(page, app, language)
  await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(2)
  await page.locator('.dbw-main-search input').fill('Original')
  await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(1)
  await app.evaluate(() => { (globalThis as ProbeGlobal).__databaseToolbarLayoutProbe!.holdNextSave = true })
  await page.locator('.dbw-save-button').click()
  try {
    await expect.poll(async () => (await readProbe(app)).pendingSave).toBe(true)
    await expect(page.locator('.dbw-save-as-button')).toBeDisabled()
    await recordToolbar(page, app, tempRoot, info, language, 760, 'business-pending-save', 'saving')
    expect(await readStored(page, app, language)).toEqual(before)
    expect((await readProbe(app)).completed).toEqual([])
  } finally { await app.evaluate(() => { (globalThis as ProbeGlobal).__databaseToolbarLayoutProbe!.release?.() }) }
  await expect(page.locator('.dbw-save-button')).toHaveText(text.saved); await expect(page.locator('.dbw-save-button')).toBeDisabled()
  const afterSave = await readStored(page, app, language)
  expect(withoutViews(afterSave)).toEqual(withoutViews(before))
  const saved = afterSave.api.sources.find(source => source.id === fixture.customId)!.views.find(view => view.id === fixture.view.id)!
  expect(saved.config).toEqual({ ...fixture.view.config, query: 'Original' }); expect(saved.filterQuery).toBe('Original')
  expect(saved.name).toBe(viewName); expect(saved.createdAt).toBe(fixture.view.createdAt)
  const sqlViews = (stored: typeof before) => stored.sql.tables.database_saved_views as Array<Record<string, unknown>>
  const beforeRow = sqlViews(before).find(row => row.id === fixture.view.id)!, afterRow = sqlViews(afterSave).find(row => row.id === fixture.view.id)!
  expect(afterRow).toEqual({ ...beforeRow, filter_query: 'Original', config_json: JSON.stringify(saved.config), updated_at: saved.updatedAt })
  expect(sqlViews(afterSave).filter(row => row.id !== fixture.view.id)).toEqual(sqlViews(before).filter(row => row.id !== fixture.view.id))
  const unchangedViews = (stored: typeof before) => stored.api.sources.flatMap(source => source.views).filter(view => view.id !== fixture.view.id)
  expect(unchangedViews(afterSave)).toEqual(unchangedViews(before))
  await recordToolbar(page, app, tempRoot, info, language, 760, 'business-save-complete')
  await page.locator('.dbw-save-as-button').click()
  const dialog = page.locator('.dbw-form-dialog'); await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: text.name, exact: true }).fill('Copied toolbar view')
  await dialog.getByRole('button', { name: text.cancel, exact: true }).click()
  await expect(dialog).toHaveCount(0); await expect(page.locator('.dbw-save-as-button')).toBeFocused()
  expect(await readStored(page, app, language)).toEqual(afterSave)
  await page.locator('.dbw-save-as-button').click()
  await dialog.getByRole('textbox', { name: text.name, exact: true }).fill('Copied toolbar view')
  await dialog.getByRole('button', { name: text.create, exact: true }).click(); await expect(dialog).toHaveCount(0)
  await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', 'Copied toolbar view')
  const afterCopy = await readStored(page, app, language), probe = await readProbe(app)
  expect(withoutViews(afterCopy)).toEqual(withoutViews(before))
  const copy = afterCopy.api.sources.find(source => source.id === fixture.customId)!.views.find(view => view.name === 'Copied toolbar view')!
  expect(copy).toBeDefined(); expect(copy.config).toEqual(saved.config); expect(copy.id).not.toBe(saved.id)
  expect(afterCopy.api.sources.flatMap(source => source.views).filter(view => view.id !== copy.id)).toEqual(afterSave.api.sources.flatMap(source => source.views))
  expect(sqlViews(afterCopy).filter(row => row.id !== copy.id)).toEqual(sqlViews(afterSave))
  expect(sqlViews(afterCopy).find(row => row.id === copy.id)).toMatchObject({ database_id: fixture.customId, name: 'Copied toolbar view', config_json: JSON.stringify(copy.config) })
  expect(probe.requests.map(request => request.channel)).toEqual(['knowbook:update-database-saved-view', 'knowbook:create-database-saved-view-form'])
  expect(probe.completed).toEqual(probe.requests); expect(probe.pendingSave).toBe(false)
  expect((probe.requests[0].input[0] as { viewId: string; config: unknown }).viewId).toBe(fixture.view.id)
  expect((probe.requests[0].input[0] as { config: unknown }).config).toEqual(saved.config)
  await recordToolbar(page, app, tempRoot, info, language, 760, 'business-save-as-complete')
  writeFileSync(info.outputPath('business-persistence.json'), JSON.stringify({ before, afterSave, afterCopy, probe }, null, 2))
}

for (const language of ['en-US', 'zh-CN'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`database toolbar fits native breakpoints and saves real view drafts in ${language} ${theme} @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.'); test.setTimeout(240_000)
    await withElectronApp(async ({ page, app, tempRoot }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const fixture = await prepare(page, language, theme); await installProbe(app)
      const before = await readStored(page, app, language)
      for (const custom of [false, true]) {
        await selectSource(page, language, custom)
        for (const collapsed of [false, true]) {
          await collapse(page, collapsed)
          for (const width of widths) {
            await resize(page, app, width)
            await localStates(page, app, tempRoot, info, language, width, `${custom ? 'custom' : 'catalog'}-${collapsed ? 'collapsed' : 'expanded'}-${width}`)
          }
        }
      }
      await page.locator('[data-page-id="settings"]').click(); await page.locator('[data-page-id="database"]').click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
      await collapse(page, false); await resize(page, app, 760)
      await recordToolbar(page, app, tempRoot, info, language, 760, 'settings-return')
      if (language === 'en-US' && theme === 'light') await exerciseKeyboard(page, app, tempRoot, info)
      const after = await readStored(page, app, language), probe = await readProbe(app)
      expect(after).toEqual(before); expect(probe.requests).toEqual([])
      writeFileSync(info.outputPath('local-persistence.json'), JSON.stringify({ before, after, probe }, null, 2))
      await exerciseRealSaving(page, app, tempRoot, info, language, fixture)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}

test('database toolbar preserves captions and native layout in all six built-in palettes @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.'); test.setTimeout(180_000)
  await withElectronApp(async ({ page, app, tempRoot }) => {
    await prepare(page, 'en-US', 'light'); await installProbe(app)
    const before = await readStored(page, app, 'en-US')
    await expect.poll(async () => (await page.evaluate(() => window.knowbook.listSystemPlugins()))
      .find(plugin => plugin.pluginId === 'theme-switcher')?.runtimeStatus).toBe('active')
    for (const palette of ['cloud', 'paper', 'moss', 'bay', 'midnight', 'violet']) {
      await page.evaluate(async themeId => {
        const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')!
        await window.knowbook.invokeSystemPluginMain({ pluginId: plugin.pluginId, revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'set-theme', input: { themeId } })
      }, palette)
      await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', palette)
      for (const custom of [false, true]) {
        await selectSource(page, 'en-US', custom)
        for (const width of [1320, 760]) {
          await resize(page, app, width)
          await localStates(page, app, tempRoot, info, 'en-US', width, `${palette}-${custom ? 'custom' : 'catalog'}-${width}`)
        }
      }
    }
    const after = await readStored(page, app, 'en-US'), probe = await readProbe(app)
    expect(after).toEqual(before); expect(probe.requests).toEqual([])
    writeFileSync(info.outputPath('local-persistence.json'), JSON.stringify({ before, after, probe }, null, 2))
  })
})
