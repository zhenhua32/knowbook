import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Layout = 'table' | 'cards' | 'board'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type Probe = typeof globalThis & { __viewportWrites?: WriteRequest[] }
const count = 145
const firstTitle = 'Match entry 0000'
const portSelector = '.dbw-table-scroll,.dbw-card-grid,.dbw-board'

async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function resize(page: Page, app: ElectronApplication, height = 760, collapsed = false): Promise<void> {
  if (await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed')) !== collapsed) {
    await page.locator('.rail-toggle-btn').click()
  }
  await app.evaluate(({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0].setContentSize(760, height), height)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([760, height])
  await settle(page)
}

async function prepare(page: Page, language: Language, theme: 'light' | 'dark') {
  const fixture = await page.evaluate(async ({ language, theme, count }) => {
    const catalog = (await window.knowbook.getDatabases()).find(database => database.kind === 'document-catalog')!
    const database = await window.knowbook.createDocumentDatabase({ name: 'Viewport records', description: 'Actual records and independent scrolling.' })
    const stage = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Stage', type: 'select', options: ['Alpha', 'Gamma'] })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const owner = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Owner', type: 'text' })
    const detail = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Details', type: 'text' })
    const records = []
    for (let index = 0; index < count; index++) records.push(await window.knowbook.createDatabaseEntity({ databaseId: database.id,
      title: `${index < 5 ? 'Match entry' : 'Viewport record'} ${String(index).padStart(4, '0')}`,
      fieldValues: { [stage.id]: index < 130 ? 'Alpha' : 'Gamma', [notes.id]: 'Original Notes', [owner.id]: 'Original owner', [detail.id]: `Detail ${index}` } }))
    const fields = ['__title__', stage.id, notes.id, owner.id, detail.id], views = []
    for (const layout of ['table', 'cards', 'board'] as const) views.push(await window.knowbook.createDatabaseSavedView({ databaseId: database.id,
      name: `Viewport ${layout}`, viewMode: layout, config: { version: 1, layout, query: '', filters: { operator: 'and', rules: [] }, sorts: [{ fieldId: '__title__', direction: 'asc' }],
        groupBy: { fieldId: layout === 'board' ? stage.id : null }, visibleFieldIds: fields, fieldOrder: fields, columnWidths: {}, cardFieldIds: [stage.id, notes.id, owner.id, detail.id] } }))
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem(`knowbook.database.last-view.${database.id}`, views[0].id)
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', theme)
    return { databaseId: database.id, catalogId: catalog.id, lastTitle: records.at(-1)!.title, lastAlphaTitle: records[129].title }
  }, { language, theme, count })
  await page.reload(); await page.locator('[data-page-id="database"]').click()
  await expect(page.locator('.dbw-table-scroll')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
  await settle(page)
  return fixture
}

async function stored(page: Page, app: ElectronApplication) {
  const api = await page.evaluate(async () => {
    const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)
    const databases = (await window.knowbook.getDatabases()).sort(byId), catalog = (await window.knowbook.getDocumentCatalog()).sort(byId)
    return { databases, catalog, sources: await Promise.all(databases.map(async database => ({ id: database.id,
      entities: (await window.knowbook.getDatabaseEntities(database.id)).sort(byId), fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort(byId),
      views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort(byId) }))) }
  })
  const sql = await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try { return { schema: database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      tables: Object.fromEntries(['documents', 'blocks', 'links', 'databases', 'document_database_columns', 'database_entities', 'database_entity_values',
        'document_database_values', 'database_saved_views'].map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1,2`).all()])) }
    } finally { database.close() }
  })
  return { api, sql }
}

async function installProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const writes: WriteRequest[] = []; (globalThis as Probe).__viewportWrites = writes
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    for (const [channel, original] of Array.from(handlers.entries())) if (/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => { writes.push({ channel, input: structuredClone(input) }); return original(event, ...input) })
    }
  })
}

async function zeroWrites(page: Page, app: ElectronApplication, before: Awaited<ReturnType<typeof stored>>, info: TestInfo, name: string): Promise<void> {
  const after = await stored(page, app), writes = await app.evaluate(() => (globalThis as Probe).__viewportWrites!)
  writeFileSync(info.outputPath(`${name}-persistence.json`), JSON.stringify({ before, after, writes }, null, 2))
  expect(writes).toEqual([]); expect(after).toEqual(before)
}

async function wheel(page: Page, locator: Locator, deltaY: number, deltaX = 0): Promise<void> {
  const box = (await locator.boundingBox())!, height = await page.evaluate(() => innerHeight)
  const y = (Math.max(0, box.y) + Math.min(height, box.y + box.height)) / 2
  await page.mouse.move(box.x + box.width / 2, y); await page.mouse.wheel(deltaX, deltaY)
  await settle(page)
}

async function fullyReachable(locator: Locator): Promise<boolean> {
  return locator.evaluate(element => {
    const bounds = element.getBoundingClientRect(), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const box = parent.getBoundingClientRect(), css = getComputedStyle(parent)
      if (/^(auto|scroll|hidden|clip)$/.test(css.overflowX)) { clip.left = Math.max(clip.left, box.left + parent.clientLeft); clip.right = Math.min(clip.right, box.left + parent.clientLeft + parent.clientWidth) }
      if (/^(auto|scroll|hidden|clip)$/.test(css.overflowY)) { clip.top = Math.max(clip.top, box.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, box.top + parent.clientTop + parent.clientHeight) }
    }
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
    return bounds.width > 0 && bounds.height > 0 && bounds.left >= clip.left - .5 && bounds.right <= clip.right + .5 && bounds.top >= clip.top - .5 && bounds.bottom <= clip.bottom + .5 && Boolean(hit && element.contains(hit))
  })
}

async function cardGlyphs(card: Locator, info: TestInfo, phase: string): Promise<void> {
  // These fixture titles and four property values are short; each real glyph must fit.
  const glyphs = await card.locator('strong,small,dt,dd').evaluateAll(elements => elements.filter(element => element.textContent?.trim()).map(element => {
    const range = document.createRange(); range.selectNodeContents(element)
    const boxes = Array.from(range.getClientRects()).filter(box => box.width > 0 && box.height > 0).map(box => box.toJSON())
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    for (let parent: HTMLElement | null = element as HTMLElement; parent; parent = parent.parentElement) {
      const box = parent.getBoundingClientRect(), css = getComputedStyle(parent)
      if (/^(auto|scroll|hidden|clip)$/.test(css.overflowX)) { clip.left = Math.max(clip.left, box.left + parent.clientLeft); clip.right = Math.min(clip.right, box.left + parent.clientLeft + parent.clientWidth) }
      if (/^(auto|scroll|hidden|clip)$/.test(css.overflowY)) { clip.top = Math.max(clip.top, box.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, box.top + parent.clientTop + parent.clientHeight) }
    }
    return { text: element.textContent, tag: element.tagName, boxes, clip, contained: boxes.length > 0 && boxes.every(box => box.left >= clip.left - .5 && box.right <= clip.right + .5 && box.top >= clip.top - .5 && box.bottom <= clip.bottom + .5) }
  }))
  writeFileSync(info.outputPath(`${phase}-glyphs.json`), JSON.stringify(glyphs, null, 2))
  expect(glyphs.length).toBeGreaterThanOrEqual(9)
  for (const glyph of glyphs) expect(glyph.contained, `${phase}: ${glyph.tag} ${glyph.text}`).toBe(true)
}

function recorder(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo) {
  const evidence: unknown[] = []
  return async (phase: string, normal = true, focused = false) => {
    await settle(page)
    const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({
      content: window.getContentSize(), bounds: window.getBounds(), size: window.getSize(), minimum: window.getMinimumSize(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
    const metrics = await page.evaluate(() => {
      const metric = (element: Element | null) => {
        if (!element) return null
        const node = element as HTMLElement, css = getComputedStyle(node), bounds = node.getBoundingClientRect()
        return { bounds: bounds.toJSON(), clientWidth: node.clientWidth, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
          scrollLeft: node.scrollLeft, scrollTop: node.scrollTop, overflowX: css.overflowX, overflowY: css.overflowY,
          gutterX: Math.max(0, node.offsetHeight - node.clientHeight - Math.round(parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth))),
          gutterY: Math.max(0, node.offsetWidth - node.clientWidth - Math.round(parseFloat(css.borderLeftWidth) + parseFloat(css.borderRightWidth))) }
      }
      const outer = document.querySelector<HTMLElement>('.content.page-database')!, css = getComputedStyle(outer)
      const port = document.querySelector<HTMLElement>('.dbw-table-scroll,.dbw-card-grid,.dbw-board'), empty = document.querySelector<HTMLElement>('.dbw-empty-state')
      const active = document.activeElement as HTMLElement, bounds = active.getBoundingClientRect(), style = getComputedStyle(active)
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let parent = active.parentElement; parent; parent = parent.parentElement) {
        const box = parent.getBoundingClientRect(), parentStyle = getComputedStyle(parent)
        if (/^(auto|scroll|hidden|clip)$/.test(parentStyle.overflowX)) { clip.left = Math.max(clip.left, box.left + parent.clientLeft); clip.right = Math.min(clip.right, box.left + parent.clientLeft + parent.clientWidth) }
        if (/^(auto|scroll|hidden|clip)$/.test(parentStyle.overflowY)) { clip.top = Math.max(clip.top, box.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, box.top + parent.clientTop + parent.clientHeight) }
      }
      if (port?.contains(active) && active.closest('tbody')) {
        const box = port.getBoundingClientRect(), headHeight = port.querySelector('thead')?.getBoundingClientRect().height ?? 0
        clip.top = Math.max(clip.top, box.top + port.clientTop + headHeight)
      }
      const ring = active.matches(':focus-visible') && style.outlineStyle !== 'none' ? Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) : 0
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return { inner: [innerWidth, innerHeight], horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        outer: metric(outer)!, outerPaddingBottom: parseFloat(css.paddingBottom), header: metric(document.querySelector('.dbw-header'))!, toolbar: metric(document.querySelector('.dbw-toolbar'))!,
        selection: metric(document.querySelector('.dbw-selection-toolbar')), canvas: metric(document.querySelector('.dbw-canvas'))!, port: metric(port), empty: metric(empty),
        recovery: metric(document.querySelector('.recovery-state')), plugins: Array.from(document.querySelectorAll('.content.page-database > .plugin-slot')).map(metric),
        titles: Array.from(document.querySelectorAll('.dbw-table tbody tr:not(.dbw-virtual-spacer) .dbw-record-title strong,.dbw-card-body strong,.dbw-board-card strong')).map(element => element.textContent),
        rows: Array.from(document.querySelectorAll('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).map(element => element.getBoundingClientRect().height),
        spacers: Array.from(document.querySelectorAll('.dbw-virtual-spacer td')).map(element => parseFloat((element as HTMLElement).style.height)),
        query: document.querySelector<HTMLInputElement>('.dbw-main-search input')!.value,
        focus: { tag: active.tagName, label: active.getAttribute('aria-label'), value: (active as HTMLInputElement).value, bounds: bounds.toJSON(), clip, ring,
          record: active.closest('tr')?.querySelector('.dbw-record-title strong')?.textContent ?? active.closest('article')?.querySelector('strong')?.textContent,
          sameNode: (globalThis as typeof globalThis & { __viewportFocusedNode?: Element }).__viewportFocusedNode === active,
          outline: { style: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset) },
          focusVisible: active.matches(':focus-visible'), hit: hit === active || Boolean(hit && active.contains(hit)),
          contained: bounds.width > 0 && bounds.height > 0 && bounds.left - ring >= clip.left - .5 && bounds.right + ring <= clip.right + .5 && bounds.top - ring >= clip.top - .5 && bounds.bottom + ring <= clip.bottom + .5 } }
    })
    evidence.push({ phase, tempRoot, native, metrics }); writeFileSync(info.outputPath('points.json'), JSON.stringify(evidence, null, 2))
    await page.screenshot({ path: info.outputPath(`${phase}.png`) })
    expect(native.userData.toLowerCase()).toBe(tempRoot.toLowerCase()); expect(native.windows).toHaveLength(1)
    expect(native.windows[0].content).toEqual(metrics.inner); expect(native.windows[0].minimum).toEqual([760, 760])
    expect(native.windows[0].bounds.width).toBe(native.windows[0].size[0]); expect(native.windows[0].bounds.height).toBe(native.windows[0].size[1])
    expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
    expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1)
    for (const height of metrics.rows) expect(height).toBeCloseTo(64, 1)
    for (const height of metrics.spacers) expect(height).toBeGreaterThanOrEqual(0)
    if (normal) {
      const data = metrics.port ?? metrics.empty!
      expect(metrics.outer.scrollHeight - metrics.outer.clientHeight).toBeLessThanOrEqual(1); expect(metrics.outer.scrollTop).toBe(0)
      expect(data.bounds.left).toBeGreaterThanOrEqual(metrics.outer.bounds.left - .5); expect(data.bounds.right).toBeLessThanOrEqual(metrics.outer.bounds.right + .5)
      expect(data.bounds.top).toBeGreaterThanOrEqual(metrics.toolbar.bounds.bottom - .5)
      expect(data.bounds.bottom).toBeLessThanOrEqual(metrics.inner[1] + .5)
      expect(Math.abs(data.bounds.bottom - (metrics.outer.bounds.bottom - metrics.outerPaddingBottom))).toBeLessThanOrEqual(2)
      expect(data.clientHeight).toBeGreaterThan(100)
    }
    if (focused) { expect(metrics.focus.contained, `${phase}: complete focused control and outline`).toBe(true); expect(metrics.focus.hit, `${phase}: focus hit target`).toBe(true) }
    return metrics
  }
}

async function clearSelection(page: Page, language: Language): Promise<void> {
  const button = page.getByRole('button', { name: getDatabaseWorkspaceText(language).clearSelection, exact: true })
  if (await button.isVisible()) await button.click()
}

async function openView(page: Page, language: Language, layout: Layout): Promise<void> {
  await clearSelection(page, language)
  const target = await page.evaluate(async layout => {
    const sourceId = localStorage.getItem('knowbook.database.last-source')!
    const views = await window.knowbook.getDatabaseSavedViews(sourceId)
    return { sourceId, viewId: views.find(view => view.name === `Viewport ${layout}`)!.id }
  }, layout)
  const tab = page.locator('.dbw-view-tab').filter({ hasText: `Viewport ${layout}` })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-current', 'page')
  await expect.poll(() => page.evaluate(sourceId => localStorage.getItem(`knowbook.database.last-view.${sourceId}`), target.sourceId)).toBe(target.viewId)
  // View hydration can remove the old view's transient Reset button.
  await settle(page)
  const reset = page.locator('.dbw-save-actions > .dbw-quiet-button')
  if (await reset.isVisible()) await reset.click()
  await settle(page)
  await expect(reset).toHaveCount(0)
  await expect(tab).toHaveAttribute('aria-current', 'page')
  const text = getDatabaseWorkspaceText(language)
  await expect(page.locator('.dbw-layout-switcher').getByRole('button', { name: text[layout], exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.dbw-main-search input')).toHaveValue('')
}

test.describe('database data viewport', () => {
  test.skip(!hasBuiltElectronApp(), 'Build the app before running Electron viewport tests.')
  for (const { language, theme } of [{ language: 'en-US', theme: 'light' }, { language: 'zh-CN', theme: 'dark' }] as const) {
    test(`${language} fills the available data area and keeps real scrolling, drafts and focus reachable @electron`, async ({}, info) => {
      await withElectronApp(async ({ page, app, tempRoot }) => {
        const fixture = await prepare(page, language, theme), text = getDatabaseWorkspaceText(language)
        await resize(page, app); const before = await stored(page, app); await installProbe(app)
        const record = recorder(page, app, tempRoot, info)
        for (const collapsed of [false, true]) {
          await resize(page, app, 760, collapsed); await openView(page, language, 'table')
          await record(`table-${collapsed ? 'collapsed' : 'expanded'}-clean`)
          await page.locator('.dbw-main-search input').fill('Viewport record'); await record(`table-${collapsed ? 'collapsed' : 'expanded'}-dirty`)
          await page.locator('tbody .dbw-select-column input').first().check(); await record(`table-${collapsed ? 'collapsed' : 'expanded'}-selected`, true, true)
          await clearSelection(page, language); await page.locator('.dbw-main-search input').fill('No matching viewport item')
          await expect(page.locator('.dbw-empty-state')).toBeVisible(); await record(`table-${collapsed ? 'collapsed' : 'expanded'}-empty`)
          await page.getByRole('button', { name: text.clearSearchAndFilters, exact: true }).click()
          await expect(page.locator('.dbw-main-search input')).toHaveValue(''); await expect(page.locator('.dbw-record-title strong').first()).toHaveText(firstTitle)
        }
        await resize(page, app); await openView(page, language, 'table')
        const table = page.locator('.dbw-table-scroll'), initial = await record('table-before-scroll')
        await wheel(page, table, 100000); await expect.poll(() => table.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
        await expect(page.locator('.dbw-record-title strong').last()).toHaveText(fixture.lastTitle)
        const bottom = await record('table-end-wheel'); expect(bottom.header.bounds).toEqual(initial.header.bounds); expect(bottom.titles.length).toBeLessThan(count)
        await wheel(page, table, 0, 20000); const horizontal = await record('table-bottom-horizontal-scrollbar'); expect(horizontal.port!.scrollLeft).toBeGreaterThan(0); expect(horizontal.port!.gutterX).toBeGreaterThan(0)
        const details = page.locator('tbody tr:not(.dbw-virtual-spacer)').last().getByLabel('Details', { exact: true })
        await details.click(); await details.fill('Viewport unsaved last detail')
        await page.evaluate(() => { (globalThis as typeof globalThis & { __viewportFocusedNode?: Element }).__viewportFocusedNode = document.activeElement! })
        const draft760 = await record('bottom-detail-draft-760', true, true)
        await resize(page, app, 1000); const draft1000 = await record('bottom-detail-draft-1000', true, true)
        await resize(page, app); const reshrink = await record('bottom-detail-draft-reshrink-760', true, true)
        for (const current of [draft760, draft1000, reshrink]) { expect(current.focus.label).toBe('Details'); expect(current.focus.record).toBe(fixture.lastTitle); expect(current.focus.value).toBe('Viewport unsaved last detail'); expect(current.focus.sameNode).toBe(true) }
        expect(draft1000.port!.clientHeight - draft760.port!.clientHeight).toBe(240); expect(reshrink.port!.scrollLeft).toBe(draft760.port!.scrollLeft)
        await zeroWrites(page, app, before, info, 'focused-resize-draft')
        await page.keyboard.press('Escape'); await expect(details).toHaveValue('Detail 144')
        // The click may reveal another column; capture its focus scroll position before selection changes the viewport.
        await page.evaluate(() => document.addEventListener('focusin', event => {
          const target = event.target as HTMLElement, port = target.closest<HTMLElement>('.dbw-table-scroll')
          if (port && target.matches('tbody .dbw-select-column input')) port.dataset.checkboxFocusLeft = String(port.scrollLeft)
        }, { capture: true }))
        await page.locator('tbody tr:not(.dbw-virtual-spacer)').last().locator('.dbw-select-column input').check()
        const selected = await record('bottom-checkbox-after-selection-shrink', true, true)
        expect(selected.focus.record).toBe(fixture.lastTitle); expect(selected.selection).not.toBeNull(); expect(selected.port!.clientHeight).toBeLessThan(reshrink.port!.clientHeight)
        expect(selected.port!.scrollLeft).toBe(await table.evaluate(element => Number((element as HTMLElement).dataset.checkboxFocusLeft)))
        for (let step = 0; step < 8 && await details.evaluate(element => document.activeElement !== element); step++) await page.keyboard.press('Tab')
        await expect(details).toBeFocused(); const tabbed = await record('bottom-details-after-native-tabs', true, true); expect(tabbed.focus.record).toBe(fixture.lastTitle); expect(tabbed.focus.value).toBe('Detail 144')
        expect(tabbed.focus.focusVisible).toBe(true); expect(tabbed.focus.outline.style).not.toBe('none'); expect(tabbed.focus.outline.width).toBeGreaterThan(0)
        await clearSelection(page, language); await wheel(page, table, -100000); await expect.poll(() => table.evaluate(element => element.scrollTop)).toBe(0)
        await expect(page.locator('.dbw-record-title strong').first()).toHaveText(firstTitle)
        const checkbox = page.locator('tbody .dbw-select-column input').first(); await checkbox.check(); await checkbox.uncheck()
        await expect(checkbox).toBeFocused(); await page.keyboard.press('PageDown'); await expect.poll(() => table.evaluate(element => element.scrollTop)).toBeGreaterThan(0); await record('native-checkbox-pagedown')
        await page.keyboard.press('Control+End'); await expect.poll(() => table.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
        await expect(page.locator('.dbw-record-title strong').last()).toHaveText(fixture.lastTitle); await record('native-checkbox-control-end')
        await page.locator('.dbw-main-search input').fill('Match entry'); await expect(page.locator('.dbw-record-title strong')).toHaveText(Array.from({ length: 5 }, (_, index) => `Match entry ${String(index).padStart(4, '0')}`))
        await record('table-five-after-deep-scroll'); await page.locator('.dbw-main-search button').click(); await expect(page.locator('.dbw-record-title strong').first()).toHaveText(firstTitle)
        await page.getByRole('button', { name: text.refreshDatabase, exact: true }).click(); await expect(page.locator('.dbw-record-title strong').first()).toHaveText(firstTitle); await record('table-cleared-and-refreshed')
        for (const layout of ['cards', 'board'] as const) {
          await openView(page, language, layout); const port = page.locator(portSelector), start = await record(`${layout}-clean`)
          if (layout === 'cards') await cardGlyphs(page.locator('.dbw-record-card').first(), info, 'cards-clean-first')
          await page.locator('.dbw-main-search input').fill('Viewport record')
          if (layout === 'cards') await page.locator('.dbw-card-checkbox').first().check()
          else { await page.locator('.dbw-layout-switcher button').nth(0).click(); await page.locator('tbody .dbw-select-column input').first().check(); await page.locator('.dbw-layout-switcher button').nth(1).click() }
          await record(`${layout}-dirty-selected`); await clearSelection(page, language); await openView(page, language, layout)
          if (layout === 'cards') {
            await wheel(page, port, 100000); await record('cards-load-more-reachable'); await page.locator('.dbw-card-load-more').click(); await expect(page.locator('.dbw-record-card')).toHaveCount(count)
            await wheel(page, port, 100000)
            const bottomCheckboxIndex = await page.locator('.dbw-card-checkbox').evaluateAll(elements => {
              const port = document.querySelector<HTMLElement>('.dbw-card-grid')!, box = port.getBoundingClientRect(), bottom = box.top + port.clientTop + port.clientHeight
              return elements.reduce((result, element, index) => { const bounds = element.getBoundingClientRect(); return bounds.top >= box.top && bounds.bottom <= bottom ? index : result }, -1)
            })
            expect(bottomCheckboxIndex).toBeGreaterThanOrEqual(0)
            await page.locator('.dbw-card-checkbox').nth(bottomCheckboxIndex).check(); await record('cards-visible-bottom-checkbox-selection-shrink', true, true)
            await clearSelection(page, language); await resize(page, app, 1000); await wheel(page, port, 100000)
            await page.locator('.dbw-card-checkbox').last().check(); await page.locator('.dbw-card-checkbox').last().uncheck(); await page.keyboard.press('Tab')
            await expect(page.locator('.dbw-card-body').last()).toBeFocused()
            await page.evaluate(() => { (globalThis as typeof globalThis & { __viewportFocusedNode?: Element }).__viewportFocusedNode = document.activeElement! })
            const large = await record('cards-bottom-button-tab-focused-1000', true, true)
            await cardGlyphs(page.locator('.dbw-record-card').last(), info, 'cards-focused-last-1000')
            expect(large.focus.focusVisible).toBe(true); expect(large.focus.outline.style).not.toBe('none'); expect(large.focus.outline.width).toBeGreaterThan(0)
            await resize(page, app); await expect(page.locator('.dbw-card-body').last()).toBeFocused(); const small = await record('cards-bottom-button-reshrink-760', true, true)
            await cardGlyphs(page.locator('.dbw-record-card').last(), info, 'cards-focused-last-reshrink-760')
            expect(small.focus.record).toBe(fixture.lastTitle); expect(small.focus.record).toBe(large.focus.record); expect(small.focus.sameNode).toBe(true); expect(small.port!.scrollLeft).toBe(large.port!.scrollLeft)
          } else {
            await resize(page, app, 1000)
            for (let pass = 0; pass < 3 && await page.locator('.dbw-board-load-more').count(); pass++) {
              await wheel(page, port, 100000); await page.locator('.dbw-board-load-more').first().click()
              if (pass === 0) {
                await page.keyboard.press('Shift+Tab'); const lastAlpha = page.locator('.dbw-board-column').first().locator('.dbw-board-card button').last()
                await expect(lastAlpha).toBeFocused()
                await page.evaluate(() => { (globalThis as typeof globalThis & { __viewportFocusedNode?: Element }).__viewportFocusedNode = document.activeElement! })
                const large = await record('board-bottom-alpha-button-tab-focused-1000', true, true)
                expect(large.focus.focusVisible).toBe(true); expect(large.focus.outline.style).not.toBe('none'); expect(large.focus.outline.width).toBeGreaterThan(0)
                await resize(page, app); await expect(lastAlpha).toBeFocused(); const small = await record('board-bottom-alpha-button-reshrink-760', true, true)
                expect(large.focus.record).toBeTruthy(); expect(small.focus.record).toBe(large.focus.record); expect(small.focus.sameNode).toBe(true); expect(small.port!.scrollLeft).toBe(large.port!.scrollLeft)
              }
            }
            await expect(page.locator('.dbw-board-card')).toHaveCount(count)
          }
          await wheel(page, port, 100000); const end = await record(`${layout}-all-records-end-wheel`); expect(end.header.bounds).toEqual(start.header.bounds); expect(end.titles).toContain(fixture.lastTitle); expect(end.port!.scrollTop).toBeGreaterThan(0)
          await wheel(page, port, -100000); await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(0)
          if (layout === 'board') { await wheel(page, port, 0, 20000); expect((await record('board-horizontal-wheel')).port!.scrollLeft).toBeGreaterThan(0); await wheel(page, port, 0, -20000) }
          await record(`${layout}-first-record-return-wheel`)
          await page.locator('.dbw-main-search input').fill('No matching viewport item'); await record(`${layout}-empty`)
          await page.getByRole('button', { name: text.clearSearchAndFilters, exact: true }).click(); await expect(page.locator('.dbw-main-search input')).toHaveValue('')
        }
        if (language === 'zh-CN') {
          await page.locator('.dbw-source-trigger').click(); await page.locator('.dbw-source-option').filter({ has: page.locator('.dbw-system-badge') }).click()
          await page.locator('.dbw-layout-switcher button').nth(0).click(); await record('catalog-table-browse')
          await page.locator('.dbw-main-search input').fill('No matching catalog item'); await record('catalog-table-empty')
          await page.getByRole('button', { name: text.clearSearchAndFilters, exact: true }).click(); await record('catalog-table-clear')
        }
        await zeroWrites(page, app, before, info, 'local-scroll-and-focus')
      }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
    })
  }

  test('high plugin slots and authenticated read retry keep the outer and empty scroll fallbacks reachable @electron', async ({}, info) => {
    await withElectronApp(async ({ page, app, tempRoot }) => {
      // Static read-only slot contributions use the real PluginSlot renderer; no plugin installation or actions run.
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
        for (const channel of ['knowbook:get-home-data', 'knowbook:get-plugin-home-data']) {
          const original = handlers.get(channel)!
          ipcMain.removeHandler(channel); ipcMain.handle(channel, async (event, ...input: unknown[]) => {
          const data = await original(event, ...input) as { pluginUiContributions: unknown[] }
          const owner = { pluginId: 'viewport-read-fixture', revisionId: 'static-view', runId: 'viewport-static-view', grantSetId: 'no-actions', scope: { kind: 'app' }, epoch: 1 }
          return { ...data, pluginUiContributions: [...data.pluginUiContributions, ...['database.view.tabs', 'database.record.actions'].map((slot, index) => ({
            owner, slot, id: `viewport-static-${index}`, order: 0, value: { kind: 'view', view: { version: 1, root: { type: 'markdown', markdown: Array.from({ length: 18 }, (_, line) => `Read-only ${index === 0 ? 'upper' : 'lower'} slot content ${line}`).join('\n') } } } }))] }
          })
        }
      })
      const language = 'en-US', text = getDatabaseWorkspaceText(language), fixture = await prepare(page, language, 'light')
      await resize(page, app); const before = await stored(page, app); await installProbe(app); const record = recorder(page, app, tempRoot, info)
      await expect(page.locator('.content.page-database > .plugin-slot')).toHaveCount(2)
      const outer = page.locator('.content.page-database'), upper = page.locator('[data-plugin-slot="database.view.tabs"]'), lower = page.locator('[data-plugin-slot="database.record.actions"]')
      await record('real-slot-upper-start', false); await wheel(page, upper, 100000); await expect.poll(() => outer.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await expect.poll(() => lower.evaluate(element => { const box = element.getBoundingClientRect(); return box.bottom <= innerHeight + .5 })).toBe(true); await record('real-slot-lower-outer-end', false)
      await wheel(page, lower, -100000); await expect.poll(() => outer.evaluate(element => element.scrollTop)).toBe(0); await record('real-slot-upper-outer-return', false)
      await page.locator('.dbw-main-search input').fill('No matching viewport item')
      const empty = page.locator('.dbw-empty-state'), clear = page.getByRole('button', { name: text.clearSearchAndFilters, exact: true })
      // Reveal the scrollport through real outer scrolling, then exercise its own overflow independently.
      await wheel(page, upper, 450); await expect(empty).toBeVisible()
      await expect.poll(() => empty.evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= -.5 && box.bottom <= innerHeight + .5 })).toBe(true)
      // At the initial top, a negative wheel is allowed to chain to the outer scrollport.
      // Test negative scrolling after this inner scrollport has consumed positive scrolling.
      await expect.poll(() => empty.evaluate(element => element.scrollTop)).toBe(0)
      const first = await record('small-empty-content-start', false)
      expect(first.empty!.scrollHeight).toBeGreaterThan(first.empty!.clientHeight)
      expect(await fullyReachable(empty.locator(':scope > span'))).toBe(true)
      await wheel(page, empty, 100000); await expect.poll(() => empty.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
      await expect(clear).toBeVisible()
      expect(await fullyReachable(clear)).toBe(true)
      await record('small-empty-clear-cta-at-end', false); await wheel(page, empty, -100000); await expect.poll(() => empty.evaluate(element => element.scrollTop)).toBe(0); await record('small-empty-negative-return', false)
      await wheel(page, empty, 100000); await clear.click(); await expect(page.locator('.dbw-main-search input')).toHaveValue(''); await expect(page.locator('.dbw-record-title strong').first()).toHaveText(firstTitle)
      await page.locator('[data-page-id="settings"]').click(); await expect(page.getByRole('tablist', { name: 'Settings categories' })).toBeVisible(); await expect(page.locator('.dbw-shell')).toHaveCount(0)
      await app.evaluate(({ ipcMain }, databaseId) => {
        const channel = 'knowbook:get-database-entities', handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers, original = handlers.get(channel)!; let fail = true
        ipcMain.removeHandler(channel); ipcMain.handle(channel, async (event, ...input: unknown[]) => { const result = await original(event, ...input); if (fail && input[0] === databaseId) { fail = false; throw new Error('Authenticated viewport read reply temporarily unavailable.') } return result })
      }, fixture.databaseId)
      await page.locator('[data-page-id="database"]').click(); const recovery = page.locator('.recovery-state'); await expect(recovery).toBeVisible()
      await recovery.locator('.recovery-details > summary').click(); const failed = await record('authenticated-read-failure-with-slots', false)
      expect(failed.outer.scrollHeight).toBeGreaterThan(failed.outer.clientHeight); expect(failed.port!.clientHeight).toBeGreaterThan(100)
      await wheel(page, upper, 100000); await record('read-failure-outer-bottom-reachable', false); await wheel(page, lower, -100000)
      const retry = recovery.getByRole('button', { name: 'Retry', exact: true }); expect(await fullyReachable(retry)).toBe(true); await retry.click()
      await expect(recovery).toHaveCount(0); await expect(page.locator('.dbw-record-title strong').first()).toHaveText(firstTitle); await record('authenticated-retry-recovered', false)
      await zeroWrites(page, app, before, info, 'fallback-scroll-and-retry')
    }, { PLAYWRIGHT_ELECTRON_LOCALE: 'en-US' })
  })
})
