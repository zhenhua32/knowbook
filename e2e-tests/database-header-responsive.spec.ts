import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type ProbeGlobal = typeof globalThis & { __headerResponsiveWrites?: WriteRequest[] }
const customName = 'Long custom database — ' + 'Quarterly research and project archive '.repeat(4).trim()

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function prepare(page: Page, language: Language) {
  const ids = await page.evaluate(async ({ language, customName }) => {
    const catalog = (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')
    if (!catalog) throw new Error('The real catalog source is required')
    const custom = await window.knowbook.createDocumentDatabase({ name: customName,
      description: 'Keep this custom source description and all record metadata.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: custom.id, name: 'Notes', type: 'text' })
    await window.knowbook.createDatabaseEntity({ databaseId: custom.id, title: 'Keep original Header test record',
      fieldValues: { [field.id]: 'Keep original Notes value' } })
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: custom.id, name: 'Keep original Header table', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id], columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id]
    } })
    for (let index = 1; index <= 12; index++) {
      const document = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(document.id, { title: 'Header reachability catalog record ' + index,
        summary: 'Keep catalog record metadata unchanged.',
        blocks: [{ type: 'paragraph', content: 'Keep this Header reachability document body.', checked: false, depth: 0 }] })
    }
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', catalog.id)
    localStorage.setItem('knowbook.database.last-view.' + custom.id, view.id)
    return { catalogId: catalog.id, customId: custom.id }
  }, { language, customName })
  await page.reload()
  await page.setViewportSize({ width: 760, height: 650 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', language === 'zh-CN' ? '全部文档' : 'All documents')
  await expect(page.locator('.sidebar-workspace-navigation')).not.toHaveClass(/collapsed/)
  await twoFrames(page)
  return ids
}

async function installWriteProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const writes: WriteRequest[] = []
    ;(globalThis as ProbeGlobal).__headerResponsiveWrites = writes
    // Observe actual authenticated persistence calls. Every handler receives
    // its original sender/senderFrame and payload; nothing is short-circuited.
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        writes.push({ channel, input: structuredClone(input) })
        return original(event, ...input)
      })
    }
  })
}

async function readStored(page: Page, app: ElectronApplication, language: Language) {
  const api = await page.evaluate(async language => {
    const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)
    const databases = (await window.knowbook.getDatabases()).sort(byId)
    const catalog = (await window.knowbook.getDocumentCatalog()).sort(byId)
    return { databases, catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: (await window.knowbook.listDocumentTemplates(language)).sort(byId),
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort(byId),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort(byId),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort(byId) }))) }
  }, language)
  const sql = await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try {
      return { schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        entityValues: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all() }
    } finally { database.close() }
  })
  return { ...api, sql }
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string, custom = false) {
  const writes = await app.evaluate(() => (globalThis as ProbeGlobal).__headerResponsiveWrites ?? [])
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const state = await page.locator('.dbw-header').evaluate((header, { language, custom }) => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const textMetric = (element: HTMLElement, expected: string) => {
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect()
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, rect.left + ancestor.clientLeft); right = Math.min(right, rect.right, rect.left + ancestor.clientLeft + ancestor.clientWidth) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, rect.top + ancestor.clientTop); bottom = Math.min(bottom, rect.bottom, rect.top + ancestor.clientTop + ancestor.clientHeight) }
      }
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const glyphs: Array<{ text: string; full: boolean; box: ReturnType<typeof box> }> = []
      let node: Node | null, consumed = 0
      while ((node = walker.nextNode()) && consumed < expected.length) {
        const value = node.textContent ?? ''
        for (let index = 0; index < value.length && consumed < expected.length;) {
          const glyph = String.fromCodePoint(value.codePointAt(index)!)
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + glyph.length)
          const rect = range.getBoundingClientRect()
          if (glyph.trim()) glyphs.push({ text: glyph,
            full: rect.left >= left - 1 && rect.right <= right + 1 && rect.top >= top - 1 && rect.bottom <= bottom + 1,
            box: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } })
          index += glyph.length
          consumed += glyph.length
        }
      }
      return { text: element.textContent, expected, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        glyphCount: glyphs.length, visibleGlyphs: glyphs.filter(glyph => glyph.full).length, glyphs, box: box(element) }
    }
    const title = header.querySelector<HTMLElement>('.dbw-source-trigger > span:first-child')!
    const description = header.querySelector<HTMLElement>('.dbw-source-wrap > p')!
    const headerRect = header.getBoundingClientRect()
    const scrollers = []
    for (let ancestor: HTMLElement | null = header as HTMLElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      scrollers.push({ tag: ancestor.tagName, id: ancestor.id, className: ancestor.className,
        scrollTop: ancestor.scrollTop, scrollLeft: ancestor.scrollLeft, scrollHeight: ancestor.scrollHeight,
        clientHeight: ancestor.clientHeight, overflowY: style.overflowY, overflowAnchor: style.overflowAnchor, box: box(ancestor) })
    }
    const active = document.activeElement
    const toggle = document.querySelector<HTMLElement>('.rail-toggle-btn')
    const buttons = Array.from(header.querySelectorAll<HTMLButtonElement>('.dbw-header-actions > button, .dbw-header-actions .dbw-menu-wrap > button')).map(button => {
      const rect = button.getBoundingClientRect()
      let left = Math.max(0, headerRect.left), top = Math.max(0, headerRect.top)
      let right = Math.min(innerWidth, headerRect.right), bottom = Math.min(innerHeight, headerRect.bottom)
      for (let ancestor = button.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, bounds.left + ancestor.clientLeft); right = Math.min(right, bounds.right, bounds.left + ancestor.clientLeft + ancestor.clientWidth) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, bounds.top + ancestor.clientTop); bottom = Math.min(bottom, bounds.bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight) }
        if (style.position === 'fixed') break
      }
      const ratio = Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left)) *
        Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top)) / (rect.width * rect.height)
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { label: button.getAttribute('aria-label') || button.textContent?.trim(), disabled: button.disabled,
        ratio, hit: hit === button || Boolean(hit && button.contains(hit)), box: box(button) }
    })
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      sidebarCollapsed: document.querySelector('.sidebar-workspace-navigation')?.classList.contains('collapsed'),
      scroll: { windowX: scrollX, windowY: scrollY, document: document.scrollingElement?.scrollTop,
        body: document.body.scrollTop, canvas: document.querySelector('.content.page-database')?.scrollTop,
        root: document.getElementById('root')?.scrollTop, ancestors: scrollers },
      active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className,
        label: active.getAttribute('aria-label'), text: active.textContent, box: box(active) } : null,
      sidebarToggle: toggle ? { label: toggle.getAttribute('aria-label'), box: box(toggle), focused: active === toggle } : null,
      header: box(header), identity: box(header.querySelector('.dbw-identity')!), actions: box(header.querySelector('.dbw-header-actions')!),
      title: { ...textMetric(title, custom ? title.textContent ?? '' : language === 'zh-CN' ? '全部文档' : 'All documents'),
        tooltip: header.querySelector<HTMLButtonElement>('.dbw-source-trigger')!.title },
      description: textMetric(description, custom ? description.textContent ?? '' : language === 'zh-CN' ? '工作区中的全部文档，可使用字段进行分类和组织。' : 'All workspace documents'),
      buttons, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
  }, { language, custom })
  const stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, windows, writes, state, stored }, null, 2))
  await info.attach(phase + '-state', { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { windows, writes, state, stored }
}

function assertHeaderActions(state: Awaited<ReturnType<typeof record>>['state'], count: number) {
  expect(state.buttons).toHaveLength(count)
  expect(state.horizontalOverflow).toBe(false)
  for (const button of state.buttons) {
    expect(button.box.height).toBeGreaterThanOrEqual(40)
    expect(button.box.width).toBeGreaterThanOrEqual(40)
    expect(button.ratio).toBeCloseTo(1, 5)
    expect(button.hit).toBe(true)
    expect(button.disabled).toBe(false)
  }
}

async function waitLayoutStable(page: Page, collapsed?: boolean, previousWidth?: number) {
  let previous: number[] | null = null, stable = 0
  await expect.poll(async () => {
    const sample = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar-workspace-navigation')!, header = document.querySelector('.dbw-header')!
      const side = sidebar.getBoundingClientRect(), box = header.getBoundingClientRect()
      return { collapsed: sidebar.classList.contains('collapsed'), values: [side.width, box.left, box.width, box.height] }
    })
    if (collapsed !== undefined && sample.collapsed !== collapsed) return false
    if (previousWidth !== undefined && (collapsed ? sample.values[0] >= previousWidth - 20 : sample.values[0] <= previousWidth + 20)) return false
    stable = previous?.every((value, index) => Math.abs(value - sample.values[index]) < 0.2) ? stable + 1 : 0
    previous = sample.values
    return stable >= 3
  }, { intervals: [50, 100, 150], timeout: 5_000 }).toBe(true)
}

async function tabTo(page: Page, target: Locator, reverse = false) {
  await expect(target).toBeVisible()
  for (let index = 0; index < 12 && !(await target.evaluate(element => document.activeElement === element)); index++) {
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
  }
  await expect(target).toBeFocused()
}

async function recordSurface(page: Page, app: ElectronApplication, info: TestInfo, language: Language,
  phase: string, selector: string, controls: string, requireWholeSurface = true) {
  const writes = await app.evaluate(() => (globalThis as ProbeGlobal).__headerResponsiveWrites ?? [])
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const surface = await page.locator(selector).evaluate((root, controls) => {
    const metric = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, bounds.left + ancestor.clientLeft); right = Math.min(right, bounds.right, bounds.left + ancestor.clientLeft + ancestor.clientWidth) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, bounds.top + ancestor.clientTop); bottom = Math.min(bottom, bounds.bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight) }
        // Modal forms are fixed to the viewport, not clipped by the ordinary
        // database shell above this actual fixed containing surface.
        if (style.position === 'fixed') break
      }
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { text: element.textContent, label: element.getAttribute('aria-label'), focused: document.activeElement === element,
        width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
        ratio: Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left)) *
          Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top)) / (rect.width * rect.height),
        hit: hit === element || Boolean(hit && element.contains(hit)) }
    }
    return { root: metric(root as HTMLElement), controls: Array.from(root.querySelectorAll<HTMLElement>(controls)).map(metric),
      scrollTop: root.scrollTop, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight }
  }, controls)
  const stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, windows, writes, surface, stored }, null, 2))
  await info.attach(phase + '-state', { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  if (requireWholeSurface) {
    expect(surface.root.ratio).toBeCloseTo(1, 5)
    expect(surface.root.hit).toBe(true)
  }
  expect(surface.controls.length).toBeGreaterThan(0)
  for (const control of surface.controls) {
    expect(control.ratio).toBeCloseTo(1, 5)
    expect(control.hit).toBe(true)
  }
  return { windows, writes, surface, stored }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('catalog Header stays readable with an expanded sidebar at 760px in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(90_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language)
      const before = await readStored(page, app, language)
      await installWriteProbe(app)
      await twoFrames(page)
      const narrow = await record(page, app, info, language, language + '-expanded-sidebar-catalog-header-before-readable-oracle')
      expect(narrow.writes).toEqual([])
      expect(narrow.stored).toEqual(before)
      expect(narrow.state.sidebarCollapsed).toBe(false)
      expect(narrow.state.horizontalOverflow).toBe(false)
      expect(narrow.state.buttons).toHaveLength(2)
      for (const button of narrow.state.buttons) {
        expect(button.box.height).toBeGreaterThanOrEqual(40)
        expect(button.box.width).toBeGreaterThanOrEqual(40)
        expect(button.ratio).toBeCloseTo(1, 5)
        expect(button.hit).toBe(true)
        expect(button.disabled).toBe(false)
      }
      // Readability, not a particular flex basis or forced row count: the
      // catalog title and its identifying description must actually be visible.
      expect(narrow.state.title.text).toBe(language === 'zh-CN' ? '全部文档' : 'All documents')
      expect((narrow.state.description.text ?? '').startsWith(narrow.state.description.expected)).toBe(true)
      expect(narrow.state.title.visibleGlyphs).toBe(narrow.state.title.glyphCount)
      expect(narrow.state.title.scrollWidth).toBeLessThanOrEqual(narrow.state.title.clientWidth + 1)
      expect(narrow.state.description.visibleGlyphs).toBe(narrow.state.description.glyphCount)
      if (language === 'zh-CN') expect(narrow.state.description.scrollWidth).toBeLessThanOrEqual(narrow.state.description.clientWidth + 1)
      expect(narrow.state.actions.top).toBeGreaterThanOrEqual(narrow.state.identity.bottom - 1)

      // The readable taller Header must leave real content usable below it.
      // Wheel the actual table port, prove the last title is reachable, then
      // return to the first row without navigating or changing any record.
      const port = page.getByTestId('database-table-view')
      await expect(port).toBeVisible()
      const canvas = page.locator('.content.page-database')
      const canvasBox = await canvas.boundingBox()
      if (!canvasBox) throw new Error('The database page canvas must remain connected')
      // Pointer automation must not scroll overflow:hidden ancestors for us.
      // Move within visible page padding and use the same wheel path as a user.
      await page.mouse.move(canvasBox.x + 3, Math.max(3, canvasBox.y + 80))
      await page.mouse.wheel(0, 2_000)
      await expect.poll(() => canvas.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
      const outerScroll = await record(page, app, info, language, language + '-real-outer-wheel-before-inner-table-scroll')
      expect(outerScroll.state.scroll.canvas).toBeGreaterThan(0)
      expect(outerScroll.state.scroll.ancestors.find(ancestor => ancestor.className === 'dbw-shell')?.scrollTop).toBe(0)
      expect(outerScroll.writes).toEqual([])
      expect(outerScroll.stored).toEqual(before)
      const portBox = await port.boundingBox()
      if (!portBox) throw new Error('The real table port must remain connected')
      const viewport = page.viewportSize()!
      const visibleTop = Math.max(1, portBox.y + 1)
      const visibleBottom = Math.min(viewport.height - 1, portBox.y + portBox.height - 1)
      expect(visibleBottom).toBeGreaterThan(visibleTop)
      await page.mouse.move(portBox.x + portBox.width / 2, (visibleTop + visibleBottom) / 2)
      await page.mouse.wheel(0, 1_000)
      await expect.poll(() => port.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      const content = await recordSurface(page, app, info, language, language + '-taller-header-still-allows-native-table-wheel-to-last-title',
        '.dbw-table-scroll', 'tbody > tr:not(.dbw-virtual-spacer):last-child .dbw-record-title', false)
      expect(content.writes).toEqual([])
      expect(content.stored).toEqual(before)
      expect(content.surface.scrollTop).toBeGreaterThan(0)
      await page.mouse.wheel(0, -1_000)
      await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(0)
      // A legitimate outer page scroll may be needed to reach a 420px table
      // port below the Header. Restore it through real wheel input on padding,
      // rather than demanding that the whole port fit beside the Header.
      await page.mouse.move(canvasBox.x + 3, Math.max(3, canvasBox.y + 80))
      await page.mouse.wheel(0, -2_000)
      await expect.poll(() => canvas.evaluate(element => element.scrollTop)).toBe(0)
      await waitLayoutStable(page, false)
      const restored = await record(page, app, info, language, language + '-native-table-and-page-wheel-return-to-visible-header')
      assertHeaderActions(restored.state, 2)
      expect(restored.state.title.visibleGlyphs).toBe(restored.state.title.glyphCount)
      expect(restored.state.scroll.ancestors.find(ancestor => ancestor.className === 'dbw-shell')?.scrollTop).toBe(0)
      expect(restored.writes).toEqual([])
      expect(restored.stored).toEqual(before)

      const expandedWidth = await page.locator('.sidebar-workspace-navigation').evaluate(element => element.getBoundingClientRect().width)
      await page.getByRole('button', { name: language === 'zh-CN' ? '收起左侧栏' : 'Collapse sidebar', exact: true }).click()
      await waitLayoutStable(page, true, expandedWidth)
      const collapsed = await record(page, app, info, language, language + '-same-760-viewport-with-sidebar-collapsed')
      assertHeaderActions(collapsed.state, 2)
      expect(Math.min(collapsed.state.identity.bottom, collapsed.state.actions.bottom) - Math.max(collapsed.state.identity.top, collapsed.state.actions.top)).toBeGreaterThan(0)
      expect(collapsed.state.title.visibleGlyphs).toBe(collapsed.state.title.glyphCount)
      expect(collapsed.writes).toEqual([])
      expect(collapsed.stored).toEqual(before)

      const collapsedWidth = await page.locator('.sidebar-workspace-navigation').evaluate(element => element.getBoundingClientRect().width)
      await page.getByRole('button', { name: language === 'zh-CN' ? '展开左侧栏' : 'Expand sidebar', exact: true }).click()
      await waitLayoutStable(page, false, collapsedWidth)
      const expandedAgain = await record(page, app, info, language, language + '-same-760-viewport-expanded-again-with-separated-readable-actions')
      assertHeaderActions(expandedAgain.state, 2)
      expect(expandedAgain.state.actions.top).toBeGreaterThanOrEqual(expandedAgain.state.identity.bottom - 1)
      expect(expandedAgain.state.title.visibleGlyphs).toBe(expandedAgain.state.title.glyphCount)
      expect(expandedAgain.state.description.visibleGlyphs).toBe(expandedAgain.state.description.glyphCount)
      expect(expandedAgain.writes).toEqual([])
      expect(expandedAgain.stored).toEqual(before)

      await page.setViewportSize({ width: 1360, height: 850 })
      await waitLayoutStable(page, false)
      const wide = await record(page, app, info, language, language + '-1360-wide-keeps-identity-and-actions-on-one-readable-line')
      assertHeaderActions(wide.state, 2)
      expect(Math.min(wide.state.identity.bottom, wide.state.actions.bottom) - Math.max(wide.state.identity.top, wide.state.actions.top)).toBeGreaterThan(0)
      expect(wide.state.title.visibleGlyphs).toBe(wide.state.title.glyphCount)
      expect(wide.state.description.visibleGlyphs).toBe(wide.state.description.glyphCount)
      expect(wide.writes).toEqual([])
      expect(wide.stored).toEqual(before)

      await page.setViewportSize({ width: 760, height: 650 })
      await waitLayoutStable(page, false)
      const source = page.locator('.dbw-source-trigger')
      const searchName = language === 'zh-CN' ? '搜索数据库…' : 'Search databases…'
      // Use the real picker search and Tab/Enter New database path. Its empty
      // search leaves the single create entry reachable without a fake click.
      await source.click()
      const search = page.getByRole('textbox', { name: searchName, exact: true })
      await expect(search).toBeFocused()
      await page.keyboard.type('No matching Header source')
      await expect(page.locator('.dbw-source-option')).toHaveCount(0)
      const emptyPicker = await recordSurface(page, app, info, language, language + '-narrow-picker-empty-search-and-new-database-entry-full-hit',
        '.dbw-source-picker', '.dbw-source-search input, .dbw-menu-create')
      expect(emptyPicker.writes).toEqual([])
      expect(emptyPicker.stored).toEqual(before)
      const newDatabase = page.locator('.dbw-menu-create')
      await tabTo(page, newDatabase)
      await page.keyboard.press('Enter')
      const newForm = page.locator('.dbw-form-dialog')
      await expect(newForm.getByRole('heading')).toHaveText(language === 'zh-CN' ? '新建数据库' : 'New database')
      await expect(newForm.getByRole('textbox', { name: language === 'zh-CN' ? '名称' : 'Name', exact: true })).toBeFocused()
      const newDialog = await recordSurface(page, app, info, language, language + '-keyboard-new-database-dialog-remains-reachable-without-writing',
        '.dbw-form-dialog', 'input, textarea, button')
      expect(newDialog.writes).toEqual([])
      expect(newDialog.stored).toEqual(before)
      await tabTo(page, newForm.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }))
      await page.keyboard.press('Enter')
      await expect(newForm).toHaveCount(0)
      await expect(source).toBeFocused()

      // The long custom source is selected through the real filtered option,
      // then its full tooltip and compact, reachable three actions are checked.
      await source.click()
      await expect(search).toBeFocused()
      await page.keyboard.press('Control+A')
      await page.keyboard.type('Long custom database')
      const option = page.locator('.dbw-source-option').filter({ hasText: customName })
      await expect(option).toHaveCount(1)
      const filteredPicker = await recordSurface(page, app, info, language, language + '-narrow-picker-long-custom-option-and-create-entry-full-hit',
        '.dbw-source-picker', '.dbw-source-search input, .dbw-source-option, .dbw-menu-create')
      expect(filteredPicker.writes).toEqual([])
      expect(filteredPicker.stored).toEqual(before)
      await tabTo(page, option)
      await page.keyboard.press('Enter')
      await expect(source).toHaveAttribute('title', customName)
      await expect(page.locator('.catalog-cell-input')).toHaveValue('Keep original Notes value')
      await waitLayoutStable(page, false)
      const custom = await record(page, app, info, language, language + '-narrow-long-custom-title-keeps-full-tooltip-and-three-visible-actions', true)
      assertHeaderActions(custom.state, 3)
      expect(custom.state.title.text).toBe(customName)
      expect(custom.state.title.tooltip).toBe(customName)
      expect(custom.state.title.visibleGlyphs).toBeGreaterThan(4)
      expect(custom.state.title.scrollWidth).toBeGreaterThan(custom.state.title.clientWidth + 1)
      expect(custom.writes).toEqual([])
      expect(custom.stored).toEqual(before)
      expect(custom.stored.databases.find(database => database.id === ids.customId)?.name).toBe(customName)

      const settings = page.getByRole('button', { name: language === 'zh-CN' ? '数据库设置' : 'Database settings', exact: true })
      await settings.click()
      const edit = page.locator('.dbw-action-menu').getByRole('button', { name: uiText('Edit database', '编辑数据库'), exact: true })
      const menu = await recordSurface(page, app, info, language, language + '-narrow-custom-settings-menu-whole-box-and-keyboard-actions',
        '.dbw-action-menu', 'button')
      expect(menu.writes).toEqual([])
      expect(menu.stored).toEqual(before)
      await tabTo(page, edit)
      await page.keyboard.press('Enter')
      const editForm = page.locator('.dbw-form-dialog')
      await expect(editForm.getByRole('heading')).toHaveText(language === 'zh-CN' ? '编辑数据库' : 'Edit database')
      await expect(editForm.getByRole('textbox', { name: language === 'zh-CN' ? '名称' : 'Name', exact: true })).toBeFocused()
      const editDialog = await recordSurface(page, app, info, language, language + '-keyboard-edit-dialog-keeps-original-custom-name-and-metadata',
        '.dbw-form-dialog', 'input, textarea, button')
      expect(editDialog.writes).toEqual([])
      expect(editDialog.stored).toEqual(before)
      await tabTo(page, editForm.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }))
      await page.keyboard.press('Enter')
      await expect(editForm).toHaveCount(0)
      await expect(settings).toBeFocused()

      const primary = page.locator('.dbw-header-actions > .dbw-primary-button')
      await tabTo(page, primary, true)
      await page.keyboard.press('Enter')
      const recordForm = page.locator('.dbw-create-record-dialog')
      await expect(recordForm.getByRole('heading')).toHaveText(language === 'zh-CN' ? '新建记录' : 'Create record')
      await expect(recordForm.getByRole('textbox', { name: language === 'zh-CN' ? /^标题/ : /^Title/ })).toBeFocused()
      const recordDialog = await recordSurface(page, app, info, language, language + '-keyboard-record-dialog-and-close-remain-reachable-without-creating',
        '.dbw-create-record-dialog', 'input, select, button')
      expect(recordDialog.writes).toEqual([])
      expect(recordDialog.stored).toEqual(before)
      await tabTo(page, recordForm.getByRole('button', { name: uiText('Close', '关闭'), exact: true }), true)
      await page.keyboard.press('Enter')
      await expect(recordForm).toHaveCount(0)
      await expect(primary).toBeFocused()
      const final = await record(page, app, info, language, language + '-all-native-header-paths-close-to-stable-entry-with-zero-persistence', true)
      assertHeaderActions(final.state, 3)
      expect(final.writes).toEqual([])
      expect(final.stored).toEqual(before)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
