import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __outlineCurrentProbe?: Probe }
const heading = (language: Language, number: number) => language === 'zh-CN'
  ? `第${String(number).padStart(2, '0')}节`
  : `Section ${String(number).padStart(2, '0')}`

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function resize(page: Page, app: ElectronApplication, width: number, height = 800) {
  const size = await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width, height }); return window.getContentSize()
  }, { width, height })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size)
  await expect.poll(() => page.locator('.sidebar').evaluate(element => {
    element.getBoundingClientRect()
    return element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' || animation.pending).length
  })).toBe(0)
  await frames(page)
}
function controls(page: Page) {
  const popup = page.locator('.document-outline-popover')
  return { popup, toggle: page.locator('.document-outline-control > button'),
    filter: popup.locator('.outline-filter'), current: popup.locator('.toc-item[aria-current="location"]'),
    list: popup.getByRole('navigation', { name: uiText('Outline', '大纲'), exact: true }),
    fold: popup.getByRole('button', { name: uiText('Fold all', '全部折叠'), exact: true }),
    expand: popup.getByRole('button', { name: uiText('Expand all', '全部展开'), exact: true }),
    focusCurrent: popup.getByRole('button', { name: uiText('Focus current', '只看本章'), exact: true }),
    find: page.locator('.document-navigation-bar').getByRole('button', { name: uiText('Find', '查找'), exact: true }) }
}
async function readApi(page: Page, language: Language) {
  return page.evaluate(async language => {
    const catalog = (await window.knowbook.getDocumentCatalog()).sort((a, b) => a.id.localeCompare(b.id))
    const databases = (await window.knowbook.getDatabases()).sort((a, b) => a.id.localeCompare(b.id))
    return { catalog, databases, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: (await window.knowbook.listDocumentTemplates(language)).sort((a, b) => a.id.localeCompare(b.id)),
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort((a, b) => a.id.localeCompare(b.id)),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort((a, b) => a.id.localeCompare(b.id)),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort((a, b) => a.id.localeCompare(b.id)) }))) }
  }, language)
}
async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }; (globalThis as ProbeGlobal).__outlineCurrentProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) if (/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) {
      ipcMain.removeHandler(channel); ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        const request = { channel, input: structuredClone(input) }; probe.requests.push(request)
        try { const result = await original(event, ...input); probe.writes.push(request); return result }
        catch (error) { probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) }); throw error }
      })
    }
  })
}
async function readMain(app: ElectronApplication) {
  return app.evaluate(({ app, BrowserWindow }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try { return { probe: (globalThis as ProbeGlobal).__outlineCurrentProbe!,
      windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(),
        contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(),
        visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
      sql: { schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        documents: database.prepare('SELECT * FROM documents ORDER BY id').all(), blocks: database.prepare('SELECT * FROM blocks ORDER BY id').all(),
        fields: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        values: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all(),
        views: database.prepare('SELECT * FROM database_saved_views ORDER BY id').all() } }
    } finally { database.close() }
  })
}
type Stored = Awaited<ReturnType<typeof readApi>> & { sql: Awaited<ReturnType<typeof readMain>>['sql'] }
async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, width: number, before: Stored, phase: string, height = 800) {
  const state = await page.evaluate(() => {
    const box = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
    const metric = (element: HTMLElement | null) => {
      if (!element) return null
      const bounds = box(element.getBoundingClientRect()), clips: Array<{ className: string; box: ReturnType<typeof box>; overflowX: string; overflowY: string }> = []
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node), rect = box(node.getBoundingClientRect())
        const bl = parseFloat(style.borderLeftWidth) || 0, br = parseFloat(style.borderRightWidth) || 0
        const bt = parseFloat(style.borderTopWidth) || 0, bb = parseFloat(style.borderBottomWidth) || 0
        const vs = /auto|scroll/.test(style.overflowY) ? Math.max(0, node.offsetWidth - node.clientWidth - Math.round(bl + br)) : 0
        const hs = /auto|scroll/.test(style.overflowX) ? Math.max(0, node.offsetHeight - node.clientHeight - Math.round(bt + bb)) : 0
        clips.push({ className: node.className, box: rect, overflowX: style.overflowX, overflowY: style.overflowY })
        if (/hidden|clip|auto|scroll/.test(style.overflowX)) { left = Math.max(left, rect.left + bl); right = Math.min(right, rect.right - br - vs) }
        if (/hidden|clip|auto|scroll/.test(style.overflowY)) { top = Math.max(top, rect.top + bt); bottom = Math.min(bottom, rect.bottom - bb - hs) }
        if (style.position === 'fixed') break
      }
      const visible = (rect: ReturnType<typeof box>) => rect.width > 0 && rect.height > 0
        && rect.left >= left && rect.right <= right && rect.top >= top && rect.bottom <= bottom
      // A Range can extend through an ellipsized button's own hidden content;
      // ancestor visibility alone would count those unpainted glyphs as visible.
      const ownStyle = getComputedStyle(element)
      const bl = parseFloat(ownStyle.borderLeftWidth) || 0, br = parseFloat(ownStyle.borderRightWidth) || 0
      const bt = parseFloat(ownStyle.borderTopWidth) || 0, bb = parseFloat(ownStyle.borderBottomWidth) || 0
      const vs = /auto|scroll/.test(ownStyle.overflowY) ? Math.max(0, element.offsetWidth - element.clientWidth - Math.round(bl + br)) : 0
      const hs = /auto|scroll/.test(ownStyle.overflowX) ? Math.max(0, element.offsetHeight - element.clientHeight - Math.round(bt + bb)) : 0
      const textClip = { left: /hidden|clip|auto|scroll/.test(ownStyle.overflowX) ? Math.max(left, bounds.left + bl) : left,
        right: /hidden|clip|auto|scroll/.test(ownStyle.overflowX) ? Math.min(right, bounds.right - br - vs) : right,
        top: /hidden|clip|auto|scroll/.test(ownStyle.overflowY) ? Math.max(top, bounds.top + bt) : top,
        bottom: /hidden|clip|auto|scroll/.test(ownStyle.overflowY) ? Math.min(bottom, bounds.bottom - bb - hs) : bottom }
      const textVisible = (rect: ReturnType<typeof box>) => visible(rect) && rect.left >= textClip.left
        && rect.right <= textClip.right && rect.top >= textClip.top && rect.bottom <= textClip.bottom
      const nodes: Text[] = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.length) nodes.push(node as Text)
      const textRects = nodes.flatMap(node => { const range = document.createRange(); range.selectNodeContents(node)
        return Array.from(range.getClientRects()).map(box) })
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return { text: element.textContent, box: bounds, clip: { left, top, right, bottom }, textClip, clips,
        fullyVisible: visible(bounds), wholeTextVisible: textRects.length > 0 && textRects.every(textVisible), textRects,
        centerHit: hit === element || Boolean(hit && element.contains(hit)), focused: document.activeElement === element }
    }
    const popup = document.querySelector<HTMLElement>('.document-outline-popover'), panel = popup?.querySelector<HTMLElement>('.toc-panel')
    const list = popup?.querySelector<HTMLElement>('nav'), preview = document.querySelector<HTMLElement>('.preview-panel')
    return { viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme,
      title: document.querySelector('.document-header-title')?.textContent, currentHeading: document.querySelector('.document-current-heading')?.textContent,
      active: { tag: document.activeElement?.tagName, className: document.activeElement?.className, text: document.activeElement?.textContent },
      previewScrollTop: preview?.scrollTop ?? null, preview: preview ? box(preview.getBoundingClientRect()) : null,
      popupCount: document.querySelectorAll('.document-outline-popover').length, popup: metric(popup ?? null),
      toggle: metric(document.querySelector('.document-outline-control > button')),
      current: metric(popup?.querySelector('.toc-item[aria-current="location"]') ?? null),
      filter: metric(popup?.querySelector('.outline-filter') ?? null), filterValue: popup?.querySelector<HTMLInputElement>('.outline-filter')?.value ?? null,
      actions: Array.from(popup?.querySelectorAll<HTMLButtonElement>('.outline-fold-actions button') ?? []).map(metric),
      headings: Array.from(popup?.querySelectorAll<HTMLButtonElement>('.toc-item') ?? []).map(element => element.textContent),
      emptyText: popup?.querySelector('.empty-text')?.textContent ?? null,
      list: list ? { box: box(list.getBoundingClientRect()), top: list.scrollTop, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight } : null,
      panel: panel ? { box: box(panel.getBoundingClientRect()), top: panel.scrollTop, clientHeight: panel.clientHeight, scrollHeight: panel.scrollHeight } : null }
  })
  const main = await readMain(app), stored = { ...await readApi(page, language), sql: main.sql }
  const result = { phase, language, width, height, state, ...main, before, stored }
  const path = info.outputPath(`${language}-${width}-${phase}.json`); writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' }); await page.screenshot({ path: info.outputPath(`${language}-${width}-${phase}.png`) })
  return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function invariant(value: Evidence, title: string) {
  expect(value.windows).toHaveLength(1); const window = value.windows[0]
  expect(window.bounds).toMatchObject({ width: value.width, height: value.height }); expect(window.minimumSize).toEqual([760, 760])
  expect(value.state.viewport).toEqual(window.contentSize); expect(window.contentSize).toEqual([window.contentBounds.width, window.contentBounds.height])
  expect(value.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(value.probe).toEqual({ requests: [], writes: [], failures: [] }); expect(value.stored).toEqual(value.before)
  expect(value.state.title).toBe(title); expect(value.state.theme).toBe(value.language === 'zh-CN' ? 'dark' : 'light')
}
function fixedControls(value: Evidence) {
  expect(value.state.filter).toMatchObject({ fullyVisible: true, centerHit: true })
  expect(value.state.actions).toHaveLength(3)
  for (const action of value.state.actions) expect(action).toMatchObject({ fullyVisible: true, wholeTextVisible: true, centerHit: true })
}
async function wheelList(page: Page, list: Locator, direction: 'top' | 'bottom') {
  const point = await list.evaluate(element => {
    const rect = element.getBoundingClientRect(), panel = element.closest('.toc-panel')!.getBoundingClientRect()
    const left = Math.max(0, rect.left, panel.left), right = Math.min(innerWidth, rect.right, panel.right)
    const top = Math.max(0, rect.top, panel.top), bottom = Math.min(innerHeight, rect.bottom, panel.bottom)
    return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top }
  })
  expect(point.width).toBeGreaterThan(0); expect(point.height).toBeGreaterThan(0)
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, direction === 'top' ? -20000 : 20000)
  await expect.poll(() => list.evaluate((element, direction) => direction === 'top' ? element.scrollTop <= 1
    : Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1, direction)).toBe(true)
  await frames(page)
}
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 8; step++) { if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press('Tab') }
  await expect(target).toBeFocused()
}

for (const language of ['en-US', 'zh-CN'] as const) for (const width of [1360, 760]) {
  test(`The outline reveals the current chapter and keeps its controls available in ${language} at native ${width}px @electron`, async ({}, info) => {
    test.setTimeout(90000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const title = language === 'zh-CN' ? '六十章节原始大纲位置' : 'Original sixty-section outline location'
      const currentTitle = heading(language, 45), nextTitle = heading(language, 46)
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const id = await page.evaluate(async ({ title, language, headings }) => {
        const document = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(document.id, { title, summary: 'Original long document summary; no edits in this test.',
          blocks: headings.flatMap((content, index) => [
            { id: `outline-current-heading-${index + 1}`, type: index % 3 === 0 ? 'heading-1' as const : 'heading-2' as const, content, checked: false, depth: 0 },
            { id: `outline-current-body-${index + 1}`, type: 'paragraph' as const,
              content: `Original paragraph ${index + 1}. ` + 'Keep every original word and block identity unchanged. '.repeat(8), checked: false, depth: 0 }
          ]) })
        await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        return document.id
      }, { title, language, headings: Array.from({ length: 60 }, (_, index) => heading(language, index + 1)) })
      await page.reload(); await resize(page, app, width)
      await page.locator('.tree-button').filter({ hasText: title }).first().click()
      await expect(page.locator('.document-header-title')).toHaveText(title)
      const reading = page.locator('.document-view-toggle')
      if (await reading.getAttribute('aria-pressed') !== 'true') await reading.click()
      await expect(reading).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('[data-block-id="outline-current-body-45"]')).toContainText('Original paragraph 45.')
      await frames(page)
      const before: Stored = { ...await readApi(page, language), sql: (await readMain(app)).sql }
      expect(before.documents.find(document => document?.id === id)?.blocks).toHaveLength(120)
      await installProbe(app)
      const capture = (phase: string) => record(page, app, info, language, width, before, phase)
      const current = controls(page)
      await current.toggle.click(); await expect(current.popup).toBeVisible()
      await current.filter.fill(currentTitle)
      await current.popup.getByRole('button', { name: currentTitle, exact: true }).click()
      await expect(current.popup).toHaveCount(0); await expect(current.toggle).toBeFocused()
      await expect(page.locator('.document-current-heading')).toHaveText(currentTitle)
      await frames(page)
      const navigated = await capture('real-filter-navigation-to-section-45'); invariant(navigated, title)
      expect(navigated.state.previewScrollTop).toBeGreaterThan(0)
      // Reopen a newly mounted, unfiltered outline. No manual outline scrolling
      // or renderer focus/scroll repair precedes this first old-build oracle.
      await page.keyboard.press('Enter'); await expect(current.popup).toBeVisible(); await frames(page)
      const opened = await capture('reopened-outline-before-current-location-oracle'); invariant(opened, title)
      expect(opened.state.current?.text).toBe(currentTitle); expect(opened.state.headings).toHaveLength(60)
      expect(opened.state.previewScrollTop).toBe(navigated.state.previewScrollTop)
      expect(opened.state.toggle?.focused).toBe(true)
      expect(opened.state.current?.fullyVisible ?? false, 'Opening the outline must reveal the current chapter in its own viewport.').toBe(true)
      expect(opened.state.current).toMatchObject({ wholeTextVisible: true, centerHit: true }); fixedControls(opened)

      await wheelList(page, current.list, 'top')
      const top = await capture('real-list-wheel-to-first-heading'); invariant(top, title); fixedControls(top)
      expect(top.state.previewScrollTop).toBe(opened.state.previewScrollTop); expect(top.state.toggle?.focused).toBe(true)
      await wheelList(page, current.list, 'bottom')
      const bottom = await capture('real-list-wheel-to-last-heading'); invariant(bottom, title); fixedControls(bottom)
      expect(bottom.state.list!.top).toBeGreaterThan(0); expect(bottom.state.panel!.top).toBe(0)
      expect(bottom.state.previewScrollTop).toBe(opened.state.previewScrollTop); expect(bottom.state.toggle?.focused).toBe(true)

      await current.filter.click(); await current.filter.fill(language === 'zh-CN' ? '第4' : 'Section 4')
      await expect(current.popup.getByRole('button', { name: currentTitle, exact: true })).toHaveCount(1)
      await expect(current.popup.getByRole('button', { name: nextTitle, exact: true })).toHaveCount(1)
      const filtered = await capture('native-filter-neighboring-chapters'); invariant(filtered, title); fixedControls(filtered)
      expect(filtered.state.filter?.focused).toBe(true); expect(filtered.state.previewScrollTop).toBe(opened.state.previewScrollTop)
      await current.filter.fill('NoOriginalHeadingCanMatchThisQuery')
      await expect(current.popup.locator('.toc-item')).toHaveCount(0)
      const empty = await capture('native-filter-has-no-matching-chapter'); invariant(empty, title); fixedControls(empty)
      expect(empty.state.emptyText).toBe(language === 'zh-CN' ? '没有匹配的章节' : 'No matching headings')
      expect(empty.state.previewScrollTop).toBe(opened.state.previewScrollTop)
      await page.keyboard.press('Escape'); await expect(current.popup).toHaveCount(0); await expect(current.toggle).toBeFocused()
      await page.keyboard.press('Enter'); await expect(current.popup).toBeVisible(); await frames(page)
      const reopened = await capture('escape-and-native-reopen-current-chapter'); invariant(reopened, title); fixedControls(reopened)
      expect(reopened.state.filterValue).toBe(''); expect(reopened.state.current).toMatchObject({ text: currentTitle, fullyVisible: true, wholeTextVisible: true, centerHit: true })
      expect(reopened.state.previewScrollTop).toBe(opened.state.previewScrollTop); expect(reopened.state.toggle?.focused).toBe(true)
      await tabTo(page, current.filter); await current.filter.fill('NoOriginalHeadingCanMatchThisQuery')
      await page.keyboard.press('Tab'); await expect(current.find).toBeFocused(); await expect(current.popup).toHaveCount(0)
      const departed = await capture('real-tab-leaves-empty-outline-for-find'); invariant(departed, title)
      expect(departed.state.previewScrollTop).toBe(opened.state.previewScrollTop); expect(departed.state.active.text).toBe(language === 'zh-CN' ? '查找' : 'Find')
      if (width === 760) {
        // Respect the real native minimum instead of emulating a 640px window.
        await resize(page, app, width, 760)
        await page.keyboard.press('Shift+Tab'); await expect(current.toggle).toBeFocused()
        await page.keyboard.press('Enter'); await expect(current.popup).toBeVisible(); await frames(page)
        const short = await record(page, app, info, language, width, before, 'native-minimum-height-reopens-current-chapter', 760)
        invariant(short, title); fixedControls(short)
        expect(short.state.current).toMatchObject({ text: currentTitle, fullyVisible: true, wholeTextVisible: true, centerHit: true })
        expect(short.state.toggle?.focused).toBe(true)
        expect(short.state.list!.clientHeight).toBeGreaterThanOrEqual(short.state.current!.box.height)
      }
      expect(errors).toEqual([])
    })
  })
}
