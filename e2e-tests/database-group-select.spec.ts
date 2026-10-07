import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Theme = 'light' | 'dark'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type Probe = typeof globalThis & { __groupSelectWrites?: WriteRequest[] }
const sourceName = 'Group select source'
const recordTitle = 'Original group record'
const longName = '项目阶段与跨团队资料分类 — Research status and project knowledge'

async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function resize(page: Page, app: ElectronApplication, width: number, collapsed = false): Promise<void> {
  if (await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed')) !== collapsed) {
    await page.locator('.rail-toggle-btn').click()
  }
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 760])
  await settle(page)
  await page.locator('.content.page-database').evaluate(element => { element.scrollTop = 0 })
}

async function prepare(page: Page, language: Language, theme: Theme) {
  const fixture = await page.evaluate(async ({ language, theme, sourceName, recordTitle, longName }) => {
    const catalog = (await window.knowbook.getDatabases()).find(database => database.kind === 'document-catalog')!
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Project records and notes.' })
    const stageName = language === 'zh-CN' ? '阶段' : 'Stage'
    const stage = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: stageName, type: 'select', options: ['Plan', 'Done'] })
    const long = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: longName, type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle, fieldValues: { [stage.id]: 'Plan', [long.id]: 'Research' } })
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Original group table', viewMode: 'table', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', stage.id], fieldOrder: ['__title__', stage.id, long.id], columnWidths: {}, cardFieldIds: [stage.id] } })
    localStorage.setItem('knowbook.database.last-source', catalog.id)
    localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', theme)
    return { catalogId: catalog.id, customId: database.id, stageId: stage.id, longId: long.id, entityId: entity.id, stageName, view }
  }, { language, theme, sourceName, recordTitle, longName })
  await page.reload(); await page.locator('[data-page-id="database"]').click()
  await expect(page.locator('.dbw-toolbar-select select')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
  await settle(page)
  return fixture
}

async function selectSource(page: Page, language: Language, custom: boolean): Promise<void> {
  const name = custom ? sourceName : getDatabaseWorkspaceText(language).allDocuments
  if (await page.locator('.dbw-source-trigger').getAttribute('title') !== name) {
    await page.locator('.dbw-source-trigger').click()
    await page.locator('.dbw-source-search input').fill(custom ? sourceName : '')
    const option = custom ? page.locator('.dbw-source-option').filter({ hasText: sourceName })
      : page.locator('.dbw-source-option').filter({ has: page.locator('.dbw-system-badge') })
    await expect(option).toHaveCount(1); await option.click()
  }
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', name)
  await settle(page)
}

async function stored(page: Page, app: ElectronApplication, language: Language) {
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
      tables: Object.fromEntries(['documents', 'blocks', 'links', 'databases', 'document_database_columns', 'database_entities', 'database_entity_values',
        'document_database_values', 'database_saved_views'].map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()])) }
    } finally { database.close() }
  })
  return { api, sql }
}

async function installProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const writes: WriteRequest[] = []; (globalThis as Probe).__groupSelectWrites = writes
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => { writes.push({ channel, input: structuredClone(input) }); return original(event, ...input) })
    }
  })
}

async function writes(app: ElectronApplication): Promise<WriteRequest[]> {
  return app.evaluate(() => (globalThis as Probe).__groupSelectWrites!)
}

async function focusGroup(page: Page): Promise<void> {
  const select = page.locator('.dbw-toolbar-select select')
  await page.locator('.dbw-main-search input').click()
  for (let step = 0; step < 12 && !await select.evaluate(element => document.activeElement === element); step++) await page.keyboard.press('Tab')
  await expect(select).toBeFocused()
  expect(await select.evaluate(element => element.matches(':focus-visible'))).toBe(true)
}

async function keyboardGroup(page: Page, fieldId: string): Promise<void> {
  const select = page.locator('.dbw-toolbar-select select')
  await expect(select).toBeFocused()
  await page.keyboard.press('Home')
  const index = await select.evaluate((element, fieldId) => Array.from((element as HTMLSelectElement).options).findIndex(option => option.value === fieldId), fieldId)
  expect(index, 'The requested field is a real native option').toBeGreaterThanOrEqual(0)
  // Closed-select arrow keys avoid opening an OS popup or taking foreground focus.
  for (let step = 0; step < index; step++) await page.keyboard.press('ArrowDown')
  await expect(select).toHaveValue(fieldId)
}

type State = { value: string; name: string; query: string; dirty: boolean; selected?: number; focused?: boolean; long?: boolean }
async function record(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, language: Language, phase: string, state: State) {
  await settle(page)
  const select = page.locator('.dbw-toolbar-select select'), text = getDatabaseWorkspaceText(language)
  await expect(select).toHaveValue(state.value); await expect(select).toHaveAttribute('title', state.name)
  await expect(select).toHaveAttribute('aria-label', text.group); await expect(select).toHaveAccessibleName(text.group)
  await expect(page.locator('.dbw-main-search input')).toHaveValue(state.query)
  for (const [selector, count] of [
    ['.dbw-toolbar > .dbw-toolbar-menu > summary', 2], ['.dbw-toolbar > .dbw-toolbar-select select', 1],
    ['.dbw-toolbar > .dbw-toolbar-button', 1], ['.dbw-layout-switcher button', 3], ['.dbw-save-button', 1], ['.dbw-save-as-button', 1],
    ['.dbw-main-search input', 1], ['.dbw-main-search button', state.query ? 1 : 0],
    ['.dbw-save-actions > .dbw-quiet-button', state.dirty ? 1 : 0]
  ] as const) {
    const controls = page.locator(selector); await expect(controls).toHaveCount(count)
    for (let index = 0; index < count; index++) await expect(controls.nth(index)).toBeVisible()
  }
  const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({
    bounds: window.getBounds(), size: window.getSize(), content: window.getContentSize(), minimum: window.getMinimumSize(),
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
  const layout = await page.locator('.dbw-toolbar').evaluate(toolbar => {
    const rectangle = (element: Element) => element.getBoundingClientRect().toJSON(), bounds = toolbar.getBoundingClientRect()
    const selected = toolbar.querySelector<HTMLSelectElement>('.dbw-toolbar-select select')!, box = selected.getBoundingClientRect(), css = getComputedStyle(selected)
    // A single-option native clone gives the browser's own intrinsic text+arrow
    // width. It supplements actual screenshots; it does not inspect native pixels.
    const clone = selected.cloneNode(true) as HTMLSelectElement
    clone.removeAttribute('id'); clone.tabIndex = -1; clone.setAttribute('aria-hidden', 'true')
    for (const option of Array.from(clone.options)) if (option.value !== selected.value) option.remove()
    Object.assign(clone.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', maxWidth: 'none', minWidth: '0', width: 'auto' })
    selected.parentElement!.appendChild(clone)
    let requiredNativeWidth: number
    try { requiredNativeWidth = clone.getBoundingClientRect().width } finally { clone.remove() }
    const groups = Array.from(toolbar.querySelectorAll<HTMLElement>(':scope > .dbw-main-search, :scope > .dbw-toolbar-menu > summary, :scope > .dbw-toolbar-select, :scope > .dbw-toolbar-button, :scope > .dbw-layout-switcher, :scope > .dbw-record-count, :scope > .dbw-save-actions'))
      .filter(element => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && box.height > 0 && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility)
      })
      .map(element => ({ className: element.className, bounds: rectangle(element) }))
    const rows: number[] = []; for (const group of groups) { const y = group.bounds.top + group.bounds.height / 2; if (!rows.some(previous => Math.abs(previous - y) < 6)) rows.push(y) }
    const controls = Array.from(toolbar.querySelectorAll<HTMLElement>(':scope > .dbw-main-search input, :scope > .dbw-main-search button, :scope > .dbw-toolbar-menu > summary, :scope > .dbw-toolbar-select select, :scope > .dbw-toolbar-button, :scope > .dbw-layout-switcher button, :scope > .dbw-save-actions button'))
      .map(element => {
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { className: element.className, tag: element.tagName, label: element.getAttribute('aria-label') || element.textContent, bounds: rectangle(element),
          hit: hit === element || Boolean(hit && element.contains(hit)), inside: box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1 }
      })
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    for (let ancestor = selected.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) { left = Math.max(left, bounds.left + ancestor.clientLeft); right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth) }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) { top = Math.max(top, bounds.top + ancestor.clientTop); bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight) }
    }
    const extent = css.outlineStyle === 'none' ? 0 : Math.max(0, parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset))
    const focusVisible = selected.matches(':focus-visible'), input = toolbar.querySelector<HTMLInputElement>('.dbw-main-search input')!, inputCss = getComputedStyle(input)
    return { inner: [innerWidth, innerHeight], toolbar: rectangle(toolbar), rowCount: rows.length, groups, controls,
      searchWidth: input.clientWidth - parseFloat(inputCss.paddingLeft) - parseFloat(inputCss.paddingRight),
      group: { bounds: rectangle(selected), selectedText: selected.selectedOptions[0]?.textContent, value: selected.value,
        title: selected.getAttribute('title'), ariaLabel: selected.getAttribute('aria-label'), requiredNativeWidth, maxWidth: css.maxWidth,
        options: Array.from(selected.options).map(option => ({ value: option.value, text: option.textContent })),
        focusVisible, outline: { extent, width: css.outlineWidth, offset: css.outlineOffset, color: css.outlineColor, style: css.outlineStyle },
        clip: { left, top, right, bottom }, clipped: box.left - extent < left - .5 || box.top - extent < top - .5 || box.right + extent > right + .5 || box.bottom + extent > bottom + .5 },
      selectedRecords: document.querySelectorAll('tbody tr.is-selected').length,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  writeFileSync(info.outputPath(`${phase}.json`), JSON.stringify({ phase, state, native, tempRoot, layout }, null, 2))
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  await select.screenshot({ path: info.outputPath(`${phase}-native-select.png`) })
  if (state.focused) {
    const box = layout.group.bounds, margin = layout.group.outline.extent + 2
    const x = Math.max(0, box.left - margin), y = Math.max(0, box.top - margin)
    await page.screenshot({ path: info.outputPath(`${phase}-native-focus.png`), clip: {
      x, y, width: Math.min(layout.inner[0], box.right + margin) - x, height: Math.min(layout.inner[1], box.bottom + margin) - y } })
  }
  expect(native.userData.toLowerCase()).toBe(tempRoot.toLowerCase()); expect(native.windows).toHaveLength(1)
  expect(native.windows[0].minimum).toEqual([760, 760]); expect(native.windows[0].content).toEqual(layout.inner)
  expect(native.windows[0].bounds.width).toBe(native.windows[0].size[0]); expect(native.windows[0].bounds.height).toBe(native.windows[0].size[1])
  expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1); expect(layout.controls).toHaveLength(10 + (state.query ? 1 : 0) + (state.dirty ? 1 : 0))
  expect(layout.controls.every(control => control.inside && control.hit)).toBe(true)
  expect(layout.controls.every(control => control.bounds.height >= (control.label === text.clearSearch ? 20 : 36))).toBe(true)
  expect(layout.searchWidth).toBeGreaterThanOrEqual(120)
  expect(layout.rowCount).toBeLessThanOrEqual(state.selected ? 3 : 2)
  if (layout.inner[0] === 760 && !state.selected) { expect(layout.rowCount).toBe(2); expect(layout.toolbar.height).toBeLessThanOrEqual(110) }
  expect(layout.selectedRecords).toBe(state.selected ?? 0); expect(layout.group.selectedText).toBe(state.name)
  expect(layout.group.options.filter(option => option.value === state.value)).toEqual([{ value: state.value, text: state.name }])
  if (state.long) expect(layout.group.requiredNativeWidth).toBeGreaterThan(layout.group.bounds.width)
  else expect(layout.group.bounds.width, 'Short native value includes its complete text and arrow preferred width').toBeGreaterThanOrEqual(layout.group.requiredNativeWidth - .5)
  if (state.focused) {
    await expect(select).toBeFocused(); expect(layout.group.focusVisible).toBe(true)
    expect(layout.group.outline.style).not.toBe('none'); expect(parseFloat(layout.group.outline.width)).toBeGreaterThan(0)
    expect(layout.group.clipped, 'Real Tab focus outline remains fully inside clipping ancestors').toBe(false)
  }
  return layout
}

async function reset(page: Page): Promise<void> {
  await page.locator('.dbw-save-actions > .dbw-quiet-button').click()
  await expect(page.locator('.dbw-toolbar-select select')).toHaveValue('')
  await expect(page.locator('.dbw-main-search input')).toHaveValue('')
  await expect(page.locator('.dbw-save-button')).toBeDisabled()
}

function withoutViews(data: Awaited<ReturnType<typeof stored>>) {
  const { database_saved_views: _views, ...tables } = data.sql.tables
  return { api: { ...data.api, sources: data.api.sources.map(({ views: _views, ...source }) => source) }, sql: { ...data.sql, tables } }
}

async function saveGroup(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, language: Language, fixture: Awaited<ReturnType<typeof prepare>>) {
  await resize(page, app, 760); const before = await stored(page, app, language)
  await focusGroup(page); await keyboardGroup(page, fixture.stageId)
  await record(page, app, tempRoot, info, language, 'save-group-draft', { value: fixture.stageId, name: fixture.stageName, query: '', dirty: true, focused: true })
  expect(await stored(page, app, language)).toEqual(before); expect(await writes(app)).toEqual([])
  await page.locator('.dbw-save-button').click()
  await expect(page.locator('.dbw-save-button')).toHaveText(getDatabaseWorkspaceText(language).saved)
  await expect(page.locator('.dbw-save-button')).toBeDisabled()
  const after = await stored(page, app, language), requests = await writes(app)
  expect(withoutViews(after)).toEqual(withoutViews(before))
  const saved = after.api.sources.find(source => source.id === fixture.customId)!.views.find(view => view.id === fixture.view.id)!
  expect(saved.config).toEqual({ ...fixture.view.config, groupBy: { fieldId: fixture.stageId } })
  expect(saved.name).toBe(fixture.view.name); expect(saved.filterQuery).toBe(''); expect(saved.createdAt).toBe(fixture.view.createdAt)
  const rows = (data: typeof before) => data.sql.tables.database_saved_views as Array<Record<string, unknown>>
  expect(rows(after).filter(row => row.id !== saved.id)).toEqual(rows(before).filter(row => row.id !== saved.id))
  const oldRow = rows(before).find(row => row.id === saved.id)!
  expect(rows(after).find(row => row.id === saved.id)).toEqual({ ...oldRow, config_json: JSON.stringify(saved.config), updated_at: saved.updatedAt })
  const otherViews = (data: typeof before) => data.api.sources.flatMap(source => source.views).filter(view => view.id !== saved.id)
  expect(otherViews(after)).toEqual(otherViews(before))
  expect(requests.map(request => request.channel)).toEqual(['knowbook:update-database-saved-view'])
  expect(requests[0].input[0]).toMatchObject({ viewId: fixture.view.id, config: saved.config })
  await page.reload(); await page.locator('[data-page-id="database"]').click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', fixture.view.name)
  await resize(page, app, 760); await focusGroup(page)
  await record(page, app, tempRoot, info, language, 'saved-group-after-reload', { value: fixture.stageId, name: fixture.stageName, query: '', dirty: false, focused: true })
  const reloadStored = await stored(page, app, language)
  expect(reloadStored).toEqual(after)
  // Reload reinitializes the app language provider, which writes only this
  // existing preference. Keep the business save and startup call distinct.
  const expectedAfterReload = [...requests, { channel: 'knowbook:save-setting', input: ['ui.language', language] }]
  await expect.poll(() => writes(app)).toEqual(expectedAfterReload)
  const reloadRequests = await writes(app)
  writeFileSync(info.outputPath('save-persistence.json'), JSON.stringify({ language, before, after, reloadStored, requests, reloadRequests, saved }, null, 2))
}

for (const { language, theme } of [{ language: 'en-US', theme: 'light' }, { language: 'zh-CN', theme: 'dark' }] as const) {
  test(`native Group values, keyboard drafts and explicit persistence in ${language} ${theme} @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.'); test.setTimeout(180_000)
    await withElectronApp(async ({ page, app, tempRoot }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const fixture = await prepare(page, language, theme), text = getDatabaseWorkspaceText(language)
      await installProbe(app); const before = await stored(page, app, language)
      const normal = { value: '', name: text.noGrouping, query: '', dirty: false }
      for (const custom of [false, true]) {
        await selectSource(page, language, custom)
        for (const width of [760, 1280]) {
          await resize(page, app, width); await focusGroup(page)
          await record(page, app, tempRoot, info, language, `${custom ? 'custom' : 'catalog'}-${width}-clean`, { ...normal, focused: true })
          await page.locator('.dbw-main-search input').fill('Original'); await focusGroup(page)
          await record(page, app, tempRoot, info, language, `${custom ? 'custom' : 'catalog'}-${width}-dirty`, { ...normal, query: 'Original', dirty: true, focused: true })
          await reset(page)
        }
      }
      await resize(page, app, 900); await page.locator('.dbw-main-search input').fill('Original'); await focusGroup(page)
      await record(page, app, tempRoot, info, language, 'custom-900-dirty', { ...normal, query: 'Original', dirty: true, focused: true }); await reset(page)
      await resize(page, app, 760, true); await focusGroup(page)
      await record(page, app, tempRoot, info, language, 'custom-760-collapsed-clean', { ...normal, focused: true })
      await page.locator('.dbw-main-search input').fill('Original'); await focusGroup(page)
      await record(page, app, tempRoot, info, language, 'custom-760-collapsed-dirty', { ...normal, query: 'Original', dirty: true, focused: true }); await reset(page)
      await resize(page, app, 760); await page.locator('.dbw-main-search input').fill('Original')
      const checkbox = page.locator('tbody tr').filter({ hasText: recordTitle }).locator('.dbw-select-column input')
      await checkbox.check(); await focusGroup(page)
      await record(page, app, tempRoot, info, language, 'selected-no-group', { ...normal, query: 'Original', dirty: true, selected: 1, focused: true })
      await keyboardGroup(page, fixture.stageId)
      await record(page, app, tempRoot, info, language, 'selected-stage', { value: fixture.stageId, name: fixture.stageName, query: 'Original', dirty: true, selected: 1, focused: true })
      await page.keyboard.press('End'); await expect(page.locator('.dbw-toolbar-select select')).toHaveValue(fixture.longId)
      await record(page, app, tempRoot, info, language, 'selected-long-cjk', { value: fixture.longId, name: longName, query: 'Original', dirty: true, selected: 1, focused: true, long: true })
      await page.keyboard.press('Home')
      await record(page, app, tempRoot, info, language, 'selected-keyboard-none', { ...normal, query: 'Original', dirty: true, selected: 1, focused: true })
      await checkbox.uncheck(); await reset(page)
      await page.locator('[data-page-id="settings"]').click()
      await expect(page.getByRole('tablist', { name: language === 'en-US' ? 'Settings categories' : '设置分类' })).toBeVisible()
      await expect(page.locator('.dbw-toolbar')).toHaveCount(0)
      await page.locator('[data-page-id="database"]').click(); await resize(page, app, 760); await focusGroup(page)
      await record(page, app, tempRoot, info, language, 'settings-return-native-group', { ...normal, focused: true })
      const after = await stored(page, app, language), requests = await writes(app)
      expect(after).toEqual(before); expect(requests).toEqual([])
      writeFileSync(info.outputPath('local-persistence.json'), JSON.stringify({ before, after, requests }, null, 2))
      await saveGroup(page, app, tempRoot, info, language, fixture)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
