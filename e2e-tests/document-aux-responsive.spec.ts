import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __documentAuxResponsiveProbe?: Probe }
const title = 'Auxiliary responsive document'
const urlDraft = 'https://example.invalid/auxiliary-responsive-draft'
const questionDraft = 'Keep this document question and its selection while resizing.'
const header = { save: '.document-header-save-button', more: '.document-header-more-button', closeAux: '.document-header-aux-button' }
const urlSelector = '.document-aux-web-clip input[type="url"]'
const questionSelector = '.document-aux-ai-prompt'
const mainSelector = '[data-testid="document-scroll-region"]'
const auxSelector = '[data-testid="document-aux-scroll-region"]'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function waitLayout(page: Page) {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => {
    element.getBoundingClientRect()
    return element.getAnimations().filter(animation => animation.playState === 'running' || animation.pending).length
  })).toBe(0)
  await twoFrames(page)
}
async function resize(page: Page, app: ElectronApplication, width: number, height = 800) {
  const contentSize = await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width, height })
    return window.getContentSize()
  }, { width, height })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(contentSize)
  await waitLayout(page)
}
async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let step = 0; step < 96; step++) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
  }
  await expect(target).toBeFocused()
}
async function prepare(page: Page, language: Language) {
  const id = await page.evaluate(async ({ language, title }) => {
    const main = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(main.id, { title, summary: 'Original summary must remain unchanged during auxiliary layout and keyboard operations.',
      blocks: Array.from({ length: 50 }, (_, index) => ({ id: 'aux-original-paragraph-' + index, type: 'paragraph' as const,
        content: `Original paragraph ${index + 1}. This retained body provides genuine independent document scrolling. `
          + 'Read the complete text without changing the stored content. '.repeat(3), checked: false, depth: 0 })) })
    const child = await window.knowbook.createDocument(main.id)
    await window.knowbook.updateDocument(child.id, { title: 'Auxiliary responsive child', summary: 'Original child metadata.',
      blocks: [{ id: 'aux-child-body', type: 'paragraph', content: 'Original related child body.', checked: false, depth: 0 }] })
    const backlink = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(backlink.id, { title: 'Auxiliary responsive backlink', summary: 'Original backlink metadata.',
      blocks: [{ id: 'aux-backlink-body', type: 'paragraph', content: `Reference [[${title}]] without changing the original document.`, checked: false, depth: 0 }] })
    const database = await window.knowbook.createDocumentDatabase({ name: 'Auxiliary preserved database', description: 'Unchanged database metadata.' })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Auxiliary preserved record', fieldValues: { [notes.id]: 'Original Notes' } })
    await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Auxiliary preserved view', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', notes.id], fieldOrder: ['__title__', notes.id], columnWidths: {}, cardFieldIds: [notes.id] } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.documents.auxPanelWidth', '360')
    return main.id
  }, { language, title })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', language === 'zh-CN' ? 'dark' : 'light')
  return id
}
async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__documentAuxResponsiveProbe = probe
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
async function readApi(page: Page, language: Language) {
  return page.evaluate(async language => {
    const databases = (await window.knowbook.getDatabases()).sort((left, right) => left.id.localeCompare(right.id))
    const catalog = (await window.knowbook.getDocumentCatalog()).sort((left, right) => left.id.localeCompare(right.id))
    return { databases, catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: (await window.knowbook.listDocumentTemplates(language)).sort((left, right) => left.id.localeCompare(right.id)),
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort((left, right) => left.id.localeCompare(right.id)),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort((left, right) => left.id.localeCompare(right.id)),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort((left, right) => left.id.localeCompare(right.id)) }))) }
  }, language)
}
async function readMain(app: ElectronApplication) {
  return app.evaluate(({ app, BrowserWindow }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try { return {
      windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(),
        size: window.getSize(), contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(),
        visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
      probe: (globalThis as ProbeGlobal).__documentAuxResponsiveProbe!,
      sql: {
        schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        documents: database.prepare('SELECT * FROM documents ORDER BY id').all(), blocks: database.prepare('SELECT * FROM blocks ORDER BY id').all(),
        columns: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        values: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all(),
        views: database.prepare('SELECT * FROM database_saved_views ORDER BY id').all()
      }
    } } finally { database.close() }
  })
}
type Stored = Awaited<ReturnType<typeof readApi>> & { sql: Awaited<ReturnType<typeof readMain>>['sql'] }
async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, width: number, before: Stored, phase: string) {
  const state = await page.evaluate(({ urlSelector, questionSelector, mainSelector, auxSelector, header }) => {
    const rectangle = (element: Element) => { const rect = element.getBoundingClientRect(); return {
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } }
    const metric = (element: HTMLElement | null) => {
      if (!element) return null
      const box = rectangle(element)
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      const clips = []
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
        const bl = parseFloat(style.borderLeftWidth) || 0, br = parseFloat(style.borderRightWidth) || 0
        const bt = parseFloat(style.borderTopWidth) || 0, bb = parseFloat(style.borderBottomWidth) || 0
        // offset/client dimensions are integers; round borders in the same
        // coordinate system and only subtract scrollbars on scrollable axes.
        const verticalScrollbar = /auto|scroll/.test(style.overflowY)
          ? Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - Math.round(bl + br)) : 0
        const horizontalScrollbar = /auto|scroll/.test(style.overflowX)
          ? Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - Math.round(bt + bb)) : 0
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, bounds.left + bl); right = Math.min(right, bounds.right - br - verticalScrollbar) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, bounds.top + bt); bottom = Math.min(bottom, bounds.bottom - bb - horizontalScrollbar) }
        clips.push({ className: ancestor.className, box: rectangle(ancestor), overflowX: style.overflowX, overflowY: style.overflowY })
        if (style.position === 'fixed') break
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { box, clip: { left, top, right, bottom }, clips,
        fullyVisible: box.width > 0 && box.height > 0 && box.left >= left - .01 && box.right <= right + .01
          && box.top >= top - .01 && box.bottom <= bottom + .01,
        centerHit: hit === element || Boolean(hit && element.contains(hit)), focused: document.activeElement === element }
    }
    const main = document.querySelector<HTMLElement>(mainSelector), aux = document.querySelector<HTMLElement>(auxSelector)
    const aside = document.querySelector<HTMLElement>('.document-aux-sidebar')
    const url = document.querySelector<HTMLInputElement>(urlSelector), question = document.querySelector<HTMLTextAreaElement>(questionSelector)
    const observed = window as unknown as { __auxObserved?: { main: HTMLElement; aside: HTMLElement; url: HTMLInputElement; question: HTMLTextAreaElement } }
    const scroll = (element: HTMLElement | null) => element ? { top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight,
      maximum: Math.max(0, element.scrollHeight - element.clientHeight) } : null
    const input = (element: HTMLInputElement | HTMLTextAreaElement | null) => element ? { ...metric(element)!, value: element.value,
      selection: [element.selectionStart, element.selectionEnd], retained: element === observed.__auxObserved?.url || element === observed.__auxObserved?.question } : null
    const separator = document.querySelector<HTMLElement>('.document-aux-resizer')
    return { viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme,
      content: metric(document.querySelector<HTMLElement>('.content')), workspace: metric(document.querySelector<HTMLElement>('.workspace-grid')),
      preview: metric(main), aside: metric(aside), mainScroll: scroll(main), auxScroll: scroll(aux),
      mainRetained: Boolean(main && main === observed.__auxObserved?.main), asideRetained: Boolean(aside && aside === observed.__auxObserved?.aside),
      url: input(url), question: input(question),
      header: Object.fromEntries(Object.entries(header).map(([key, selector]) => [key, metric(document.querySelector<HTMLElement>(selector))])),
      related: metric(document.querySelector<HTMLElement>('.document-aux-ai-actions .secondary-button')),
      separator: separator ? { ...metric(separator)!, orientation: separator.getAttribute('aria-orientation'),
        minimum: separator.getAttribute('aria-valuemin'), maximum: separator.getAttribute('aria-valuemax'), value: separator.getAttribute('aria-valuenow') } : null,
      savedWidth: localStorage.getItem('knowbook.documents.auxPanelWidth'),
      bodyCursor: document.body.style.cursor, bodyUserSelect: document.body.style.userSelect,
      title: document.querySelector('.document-header-title')?.textContent, reading: document.querySelector('.document-view-toggle')?.getAttribute('aria-pressed'),
      auxiliary: document.querySelector('.document-header-aux-button')?.getAttribute('aria-pressed'),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      canvasOverflow: (document.querySelector('.content')?.scrollWidth ?? 0) - (document.querySelector('.content')?.clientWidth ?? 0),
      active: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName, className: document.activeElement.className } : null }
  }, { urlSelector, questionSelector, mainSelector, auxSelector, header })
  const main = await readMain(app), api = await readApi(page, language)
  const result = { phase, language, width, state, ...main, before, stored: { ...api, sql: main.sql } }
  const path = info.outputPath(`${language}-${width}-${phase}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2)); await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${width}-${phase}.png`) })
  return result
}
type Evidence = Awaited<ReturnType<typeof record>>
type Metric = NonNullable<Evidence['state']['preview']>
function reachable(metric: Metric | null, label: string) {
  expect(metric, `${label} must be an actual element`).not.toBeNull()
  expect(metric!.fullyVisible, `${label} must fit every actual viewport and ancestor clip`).toBe(true)
  expect(metric!.centerHit, `${label} must receive the actual center pointer`).toBe(true)
}
function invariant(result: Evidence, width: number, height = 800) {
  expect(result.windows).toHaveLength(1)
  expect(result.windows[0].bounds.width).toBe(width); expect(result.windows[0].bounds.height).toBe(height)
  expect(result.state.viewport).toEqual(result.windows[0].contentSize)
  expect(result.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(result.probe).toEqual({ requests: [], writes: [], failures: [] }); expect(result.stored).toEqual(result.before)
  expect(result.state.horizontalOverflow).toBe(false); expect(result.state.canvasOverflow).toBeLessThanOrEqual(1)
  expect(result.state.title).toBe(title); expect(result.state.reading).toBe('true')
  for (const [name, metric] of Object.entries(result.state.header)) reachable(metric, name)
}
function stacked(result: Evidence) {
  reachable(result.state.preview, 'stacked preview'); reachable(result.state.aside, 'stacked auxiliary')
  expect(result.state.workspace!.box.width).toBeLessThan(710)
  expect(Math.abs(result.state.preview!.box.width - result.state.workspace!.box.width)).toBeLessThanOrEqual(1)
  expect(result.state.aside!.box.top).toBeGreaterThanOrEqual(result.state.preview!.box.bottom - .01)
}
function retainedDraft(result: Evidence, urlSelection: Array<number | null>, questionSelection: Array<number | null>) {
  expect(result.state.mainRetained).toBe(true); expect(result.state.asideRetained).toBe(true)
  expect(result.state.url!.retained).toBe(true); expect(result.state.question!.retained).toBe(true)
  expect(result.state.url!.value).toBe(urlDraft); expect(result.state.question!.value).toBe(questionDraft)
  expect(result.state.url!.selection).toEqual(urlSelection); expect(result.state.question!.selection).toEqual(questionSelection)
}

for (const language of ['en-US', 'zh-CN'] as const) for (const width of [760, 900]) {
  test(`Document auxiliary panel keeps independent readable surfaces in native ${width}px ${language} @electron`, async ({}, info) => {
    test.setTimeout(180000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ app, page }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      await prepare(page, language); await resize(page, app, width)
      await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click()
      const entry = page.locator('.tree-button').filter({ has: page.getByText(title, { exact: true }) })
      await expect(entry).toHaveCount(1); await entry.click(); await expect(page.locator('.document-header-title')).toHaveText(title)
      if (await page.locator('.document-view-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('.document-view-toggle').click()
      await expect(page.locator(`${mainSelector} [data-block-id="aux-original-paragraph-0"]`)).toContainText('Original paragraph 1.')
      await waitLayout(page); await installProbe(app)
      const before: Stored = { ...await readApi(page, language), sql: (await readMain(app)).sql }
      const capture = (phase: string) => record(page, app, info, language, width, before, phase)
      const closed = await capture('closed-native-original-document')
      const toggle = page.locator(header.closeAux)
      await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await waitLayout(page)
      const opened = await capture('open-native-narrow-before-first-business-oracle')
      // The old side-by-side grid compresses the body to about 226px. These
      // first assertions use only actual existing boxes, not a new CSS class.
      expect(Math.abs(opened.state.preview!.box.width - closed.state.preview!.box.width)).toBeLessThanOrEqual(1)
      expect(opened.state.aside!.box.top).toBeGreaterThanOrEqual(opened.state.preview!.box.bottom - .01)
      invariant(closed, width); invariant(opened, width); stacked(opened)
      expect(opened.state.savedWidth).toBe('360')
      await page.evaluate(({ mainSelector, urlSelector, questionSelector }) => {
        ;(window as unknown as { __auxObserved?: unknown }).__auxObserved = { main: document.querySelector(mainSelector),
          aside: document.querySelector('.document-aux-sidebar'), url: document.querySelector(urlSelector), question: document.querySelector(questionSelector) }
      }, { mainSelector, urlSelector, questionSelector })
      const url = page.locator(urlSelector), question = page.locator(questionSelector)
      await tabTo(page, url); await page.keyboard.type(urlDraft); await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight')
      let urlSelection = await url.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])
      const web = await capture('narrow-web-url-real-keyboard-draft'); invariant(web, width); stacked(web); reachable(web.state.url, 'Webpage URL')
      expect(web.state.url!.focused).toBe(true); expect(web.state.url!.value).toBe(urlDraft)
      for (const [phase, targetWidth] of [['web-url-native-wide-selection', 1360], ['web-url-native-return-narrow-selection', width]] as const) {
        await resize(page, app, targetWidth)
        const result = await capture(phase); invariant(result, targetWidth); reachable(result.state.url, 'retained Webpage URL')
        expect(result.state.url!.retained).toBe(true); expect(result.state.mainRetained).toBe(true); expect(result.state.asideRetained).toBe(true)
        expect(result.state.url!.focused).toBe(true); expect(result.state.url!.selection).toEqual(urlSelection)
        expect(result.state.url!.value).toBe(urlDraft); expect(result.state.savedWidth).toBe('360')
      }
      await tabTo(page, question); await page.keyboard.type(questionDraft); await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight')
      let questionSelection = await question.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])
      const drafted = await capture('narrow-document-question-real-keyboard-draft')
      invariant(drafted, width); stacked(drafted); retainedDraft(drafted, urlSelection, questionSelection)
      reachable(drafted.state.question, 'Document question'); expect(drafted.state.question!.focused).toBe(true)

      const preview = page.locator(mainSelector), aux = page.locator(auxSelector)
      const previewBox = (await preview.boundingBox())!
      await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height - 32); await page.mouse.wheel(0, 650)
      await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(drafted.state.mainScroll!.top)
      await twoFrames(page)
      const mainScrolled = await capture('native-document-wheel-does-not-scroll-auxiliary')
      invariant(mainScrolled, width); stacked(mainScrolled); retainedDraft(mainScrolled, urlSelection, questionSelection)
      expect(mainScrolled.state.auxScroll!.top).toBe(drafted.state.auxScroll!.top)
      const auxBox = (await aux.boundingBox())!
      await page.mouse.move(auxBox.x + 8, auxBox.y + auxBox.height / 2); await page.mouse.wheel(0, -450)
      await expect.poll(() => aux.evaluate(element => element.scrollTop)).toBeLessThan(mainScrolled.state.auxScroll!.top)
      await twoFrames(page)
      const auxScrolled = await capture('native-auxiliary-wheel-does-not-scroll-document')
      invariant(auxScrolled, width); stacked(auxScrolled); retainedDraft(auxScrolled, urlSelection, questionSelection)
      expect(auxScrolled.state.mainScroll!.top).toBe(mainScrolled.state.mainScroll!.top)
      const related = page.locator('.document-aux-ai-actions .secondary-button').first()
      await tabTo(page, related)
      const bottom = await capture('narrow-bottom-action-real-tab-reachable-without-request')
      invariant(bottom, width); stacked(bottom); retainedDraft(bottom, urlSelection, questionSelection)
      reachable(bottom.state.related, 'Find related notes'); expect(bottom.state.related!.focused).toBe(true)
      await tabTo(page, question, true); await expect(question).toBeFocused()
      questionSelection = await question.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])
      const beforeResizeTop = await aux.evaluate(element => element.scrollTop)
      await resize(page, app, 1360)
      const wide = await capture('native-wide-keeps-same-inputs-drafts-selection-and-scroll')
      invariant(wide, 1360); retainedDraft(wide, urlSelection, questionSelection); reachable(wide.state.question, 'wide Document question')
      expect(wide.state.question!.focused).toBe(true); expect(wide.state.savedWidth).toBe('360')
      expect(wide.state.workspace!.box.width).toBeGreaterThanOrEqual(710)
      expect(wide.state.aside!.box.left).toBeGreaterThanOrEqual(wide.state.preview!.box.right)
      expect(wide.state.auxScroll!.top).toBeCloseTo(Math.min(beforeResizeTop, wide.state.auxScroll!.maximum), 1)
      const separator = page.locator('.document-aux-resizer')
      await tabTo(page, separator, true); await page.keyboard.press('ArrowLeft'); await twoFrames(page)
      // The actual reverse Tab route visits the URL field. Native focus may
      // select its text; capture that new user selection before resize checks.
      urlSelection = await url.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])
      const resized = await capture('wide-separator-arrow-left-saves-only-user-376-preference')
      invariant(resized, 1360); retainedDraft(resized, urlSelection, questionSelection); reachable(resized.state.separator, 'wide separator')
      expect(resized.state.separator!.focused).toBe(true); expect(resized.state.separator!.orientation).toBe('vertical')
      expect(resized.state.separator!.value).toBe('376'); expect(resized.state.savedWidth).toBe('376')
      await resize(page, app, width, 760)
      const bridge = await capture('native-narrow-removing-focused-separator-returns-to-header-auxiliary')
      invariant(bridge, width, 760); stacked(bridge); retainedDraft(bridge, urlSelection, questionSelection)
      expect(bridge.state.savedWidth).toBe('376'); await expect(toggle).toBeFocused()
      await resize(page, app, 1360)
      await tabTo(page, question)
      urlSelection = await url.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])
      questionSelection = await question.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])
      await resize(page, app, width, 760)
      const short = await capture('native-short-760-keeps-preference-and-focused-question')
      invariant(short, width, 760); stacked(short); retainedDraft(short, urlSelection, questionSelection)
      reachable(short.state.question, 'short Document question'); expect(short.state.question!.focused).toBe(true)
      expect(short.state.savedWidth).toBe('376')
      await resize(page, app, 1360)
      const returned = await capture('native-wide-restores-user-376-width-without-remount')
      invariant(returned, 1360); retainedDraft(returned, urlSelection, questionSelection); reachable(returned.state.separator, 'returned wide separator')
      reachable(returned.state.question, 'returned wide Document question')
      expect(returned.state.separator!.value).toBe('376'); expect(returned.state.savedWidth).toBe('376')
      expect(returned.state.question!.focused).toBe(true)

      const separatorBox = (await separator.boundingBox())!
      await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + separatorBox.height / 2); await page.mouse.down()
      expect(await page.evaluate(() => document.body.style.cursor)).toBe('col-resize')
      await resize(page, app, width)
      await page.mouse.move(90, 90); await page.mouse.up(); await twoFrames(page)
      const dragCancelled = await capture('native-cross-breakpoint-cancels-real-pointer-drag')
      invariant(dragCancelled, width); stacked(dragCancelled); retainedDraft(dragCancelled, urlSelection, questionSelection)
      expect(dragCancelled.state.bodyCursor).toBe(''); expect(dragCancelled.state.bodyUserSelect).toBe('')
      expect(dragCancelled.state.savedWidth).toBe('376')
      await toggle.click(); await expect(page.locator('.document-aux-sidebar')).toHaveCount(0); await waitLayout(page)
      const hidden = await capture('narrow-close-restores-entire-document-height')
      invariant(hidden, width); expect(hidden.state.auxiliary).toBe('false')
      expect(hidden.state.preview!.box.height).toBeGreaterThan(dragCancelled.state.preview!.box.height)
      expect(Math.abs(hidden.state.preview!.box.width - closed.state.preview!.box.width)).toBeLessThanOrEqual(1)
      expect(hidden.state.mainRetained).toBe(true); expect(hidden.state.savedWidth).toBe('376')
      await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await waitLayout(page)
      await expect(url).toHaveValue(urlDraft); await expect(question).toHaveValue(questionDraft)
      // Closing legitimately unmounts the auxiliary subtree; only the parent
      // drafts must survive this operation. Resize identity was proved above.
      await tabTo(page, question)
      const final = await capture('narrow-reopen-preserves-parent-drafts-and-final-action-access')
      invariant(final, width); stacked(final); reachable(final.state.question, 'reopened Document question')
      expect(final.state.question!.focused).toBe(true); expect(final.state.url!.value).toBe(urlDraft)
      expect(final.state.question!.value).toBe(questionDraft); expect(final.state.savedWidth).toBe('376')
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
