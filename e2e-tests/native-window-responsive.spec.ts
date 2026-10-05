import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __nativeWindowResponsiveProbe?: Probe }
const prefix = 'Atlas shared identity '
const sourceName = (suffix: string) => prefix + 'SharedIdentityWithoutBreaks'.repeat(5) + ' ' + suffix
const names = { alpha: sourceName('AlphaDistinctEnd'), beta: sourceName('BetaDistinctEnd'), tall: prefix + 'Large description' }
const descriptions = {
  alpha: 'Shared description for closely related project collections. '.repeat(3) + 'AlphaDescriptionEnd',
  beta: 'Shared description for closely related project collections. '.repeat(3) + 'BetaDescriptionEnd',
  tall: 'Scrollable description keeps every detail available. '.repeat(35) + 'TallDescriptionEnd'
}
const documentTitle = 'Native narrow document details'
const documentBody = 'Original native narrow document body. Keep its content, identity and metadata unchanged.'
const documentBlockId = 'native-narrow-original-body'
const databaseControls = { source: '.dbw-source-trigger', refresh: '.dbw-refresh-button',
  newRecord: '.dbw-header-actions > .dbw-primary-button', query: '.dbw-main-search input' }
const documentControls = { more: '.document-header-more-button', save: '.document-header-save-button',
  auxiliary: '.document-header-aux-button', reading: '.document-view-toggle' }

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function waitLayout(page: Page) {
  // Crossing 1080px starts the sidebar's real 180ms width transition. Wait for
  // that CSS lifecycle, then allow RO -> RAF -> React positioning to commit.
  await expect.poll(() => page.locator('.sidebar').evaluate(element => {
    element.getBoundingClientRect()
    return element.getAnimations().filter(animation => animation.playState === 'running' || animation.pending).length
  })).toBe(0)
  await twoFrames(page)
}
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 64; step++) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}
async function nativeResize(page: Page, app: ElectronApplication, width: number) {
  const contentSize = await app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width, height: 800 })
    return window.getContentSize()
  }, width)
  // Synchronize the actual native resize event, not a business geometry oracle.
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(contentSize)
  await waitLayout(page)
}
async function prepare(page: Page, language: Language) {
  const ids = await page.evaluate(async ({ language, names, descriptions, documentTitle, documentBody, documentBlockId }) => {
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
      ids[key + 'View'] = view.id
      localStorage.setItem('knowbook.database.last-view.' + source.id, view.id)
    }
    const document = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(document.id, { title: documentTitle, summary: 'Preserve native document metadata.',
      blocks: [{ id: documentBlockId, type: 'paragraph', content: documentBody, checked: false, depth: 0 }] })
    ids.document = document.id
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', ids.alpha)
    return ids
  }, { language, names, descriptions, documentTitle, documentBody, documentBlockId })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', language === 'zh-CN' ? 'dark' : 'light')
  // No renderer viewport emulation: every subsequent size comes from the
  // hidden native BrowserWindow, including its real platform frame difference.
  return ids
}
async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__nativeWindowResponsiveProbe = probe
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
      probe: (globalThis as ProbeGlobal).__nativeWindowResponsiveProbe!,
      sql: {
        schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        columns: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        values: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all(),
        documents: database.prepare('SELECT * FROM documents ORDER BY id').all(),
        blocks: database.prepare('SELECT * FROM blocks ORDER BY id').all(),
        views: database.prepare('SELECT * FROM database_saved_views ORDER BY id').all()
      }
    } } finally { database.close() }
  })
}
type Stored = Awaited<ReturnType<typeof readApi>> & { sql: Awaited<ReturnType<typeof readMain>>['sql'] }
async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, requestedWidth: number,
  before: Stored, phase: string, selectors: Record<string, string>) {
  const state = await page.evaluate(selectors => {
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
        const verticalScrollbar = Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - bl - br)
        const horizontalScrollbar = Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - bt - bb)
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, bounds.left + bl); right = Math.min(right, bounds.right - br - verticalScrollbar) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, bounds.top + bt); bottom = Math.min(bottom, bounds.bottom - bb - horizontalScrollbar) }
        clips.push({ className: ancestor.className, position: style.position, overflowX: style.overflowX, overflowY: style.overflowY,
          box: rectangle(ancestor) })
        if (style.position === 'fixed') break
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { box, clip: { left, top, right, bottom }, clips,
        fullyVisible: box.width > 0 && box.height > 0 && box.left >= left - .01 && box.right <= right + .01
          && box.top >= top - .01 && box.bottom <= bottom + .01,
        centerHit: hit === element || Boolean(hit && element.contains(hit)), focused: document.activeElement === element }
    }
    const query = document.querySelector<HTMLInputElement>('.dbw-main-search input')
    const search = document.querySelector<HTMLInputElement>('.dbw-source-search input')
    const observed = window as unknown as { __nativeResponsiveSearch?: HTMLInputElement }
    const active = document.activeElement
    const canvas = document.querySelector<HTMLElement>('.content')
    return { viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme,
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      sourceId: localStorage.getItem('knowbook.database.last-source'),
      viewId: document.querySelector('.dbw-view-tab-wrap.is-active')?.getAttribute('data-view-id') ?? null,
      savedView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: query?.value ?? null, sourceQuery: search?.value ?? null,
      selection: search ? [search.selectionStart, search.selectionEnd] : null,
      searchRetained: Boolean(search && search === observed.__nativeResponsiveSearch),
      sourceSearchFocused: Boolean(search && active === search),
      controls: Object.fromEntries(Object.entries(selectors).map(([key, selector]) => [key, metric(document.querySelector<HTMLElement>(selector))])),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      canvasOverflow: canvas ? canvas.scrollWidth - canvas.clientWidth : 0,
      forms: document.querySelectorAll('.dbw-form-dialog, .dbw-create-record-dialog, .app-confirm-dialog').length,
      documentTitle: document.querySelector('.document-header-title')?.textContent,
      reading: document.querySelector('.document-view-toggle')?.getAttribute('aria-pressed'),
      auxiliary: document.querySelector('.document-header-aux-button')?.getAttribute('aria-pressed'),
      active: active instanceof HTMLElement ? { className: active.className, tag: active.tagName,
        label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 100) } : null }
  }, selectors)
  const main = await readMain(app), api = await readApi(page, language)
  const stored = { ...api, sql: main.sql }
  const result = { phase, language, requestedWidth, state, ...main, before, stored }
  const path = info.outputPath(`${language}-${requestedWidth}-${phase}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${requestedWidth}-${phase}.png`) })
  return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function assertNative(result: Evidence, outerWidth: number, forms = 0) {
  expect(result.windows).toHaveLength(1)
  const native = result.windows[0]
  expect(native.minimumSize[0]).toBeLessThanOrEqual(760)
  expect(native.minimumSize[1]).toBe(760)
  expect(native.bounds.width).toBe(outerWidth)
  expect(native.bounds.height).toBe(800)
  expect(native.size).toEqual([native.bounds.width, native.bounds.height])
  expect(native.contentSize).toEqual([native.contentBounds.width, native.contentBounds.height])
  expect(result.state.viewport).toEqual(native.contentSize)
  expect(native.contentSize[0]).toBeGreaterThan(0)
  expect(native.contentSize[0]).toBeLessThanOrEqual(outerWidth)
  expect(result.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(result.probe).toEqual({ requests: [], writes: [], failures: [] })
  expect(result.stored).toEqual(result.before)
  expect(result.state.horizontalOverflow).toBe(false)
  expect(result.state.canvasOverflow).toBeLessThanOrEqual(1)
  expect(result.state.forms).toBe(forms)
}
function assertControls(result: Evidence) {
  expect(Object.keys(result.state.controls).length).toBeGreaterThan(0)
  for (const [name, metric] of Object.entries(result.state.controls)) {
    expect(metric, `${name} must be a real current-page element`).not.toBeNull()
    expect(metric!.fullyVisible, `${name} must fit the native client and its actual ancestor clips`).toBe(true)
    expect(metric!.centerHit, `${name} must receive an actual center pointer`).toBe(true)
  }
}

for (const language of ['en-US', 'zh-CN'] as const) for (const width of [760, 900]) {
  test(`Hidden native window supports ${width}px desktop navigation and stable input in ${language} @electron`, async ({}, info) => {
    test.setTimeout(180000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ app, page }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language), text = getDatabaseWorkspaceText(language)
      await nativeResize(page, app, width)
      await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
      await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', names.alpha)
      await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(1)
      await waitLayout(page)
      await installProbe(app)
      const before: Stored = { ...await readApi(page, language), sql: (await readMain(app)).sql }
      const first = await record(page, app, info, language, width, before, 'native-minimum-before-first-business-oracle', databaseControls)
      // This is deliberately the first business assertion. The old 1180px
      // native minimum clamps setBounds, even when emulated page viewports fit.
      expect(first.windows[0].minimumSize[0]).toBeLessThanOrEqual(760)
      expect(first.windows[0].minimumSize[1]).toBe(760)
      assertNative(first, width); assertControls(first)
      expect(first.state.sourceId).toBe(ids.alpha)
      expect(first.state.savedView).toBe('alpha original table')
      expect(first.state.query).toBe('alpha')

      const primary = page.locator(databaseControls.newRecord)
      await tabTo(page, primary)
      await page.keyboard.press('Enter')
      const recordForm = page.locator('.dbw-create-record-dialog')
      await expect(recordForm).toBeVisible()
      const createRecord = await record(page, app, info, language, width, before, 'native-new-record-dialog-without-writing', {
        title: '.dbw-create-record-dialog input', close: '.dbw-create-record-dialog header .dbw-icon-button',
        create: '.dbw-create-record-dialog footer .dbw-primary-button' })
      assertNative(createRecord, width, 1); assertControls(createRecord)
      await tabTo(page, recordForm.getByRole('button', { name: uiText('Close', '关闭'), exact: true }))
      await page.keyboard.press('Enter')
      await expect(recordForm).toHaveCount(0)
      await expect(primary).toBeFocused()

      const query = page.locator(databaseControls.query)
      await query.click(); await page.keyboard.press('Control+A'); await page.keyboard.type('alpha original')
      await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight')
      const querySelection = await query.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])
      await page.locator(databaseControls.refresh).click()
      await expect(query).toBeFocused()
      await expect(page.locator(databaseControls.refresh)).not.toHaveAttribute('aria-busy', 'true')
      expect(await query.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])).toEqual(querySelection)
      const draft = await record(page, app, info, language, width, before, 'native-query-draft-and-read-only-header-refresh', databaseControls)
      assertNative(draft, width); assertControls(draft)
      expect(draft.state.query).toBe('alpha original')

      const trigger = page.locator(databaseControls.source), search = page.locator('.dbw-source-search input')
      await trigger.click(); await expect(search).toBeFocused(); await page.keyboard.type(prefix)
      await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight')
      const selection = await search.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])
      await page.evaluate(() => {
        ;(window as unknown as { __nativeResponsiveSearch?: HTMLInputElement }).__nativeResponsiveSearch = document.querySelector<HTMLInputElement>('.dbw-source-search input')!
      })
      await twoFrames(page)
      const pickerControls = { picker: '.dbw-source-picker', search: '.dbw-source-search input', create: '.dbw-menu-create' }
      for (const [phase, targetWidth] of [['source-picker-native-narrow-draft', width],
        ['source-picker-native-wide-retains-input', 1280], ['source-picker-native-return-narrow-retains-input', width]] as const) {
        if (phase !== 'source-picker-native-narrow-draft') await nativeResize(page, app, targetWidth)
        const result = await record(page, app, info, language, width, before, phase, pickerControls)
        assertNative(result, targetWidth); assertControls(result)
        expect(result.state.searchRetained).toBe(true); expect(result.state.sourceSearchFocused).toBe(true)
        expect(result.state.selection).toEqual(selection); expect(result.state.sourceQuery).toBe(prefix)
        expect(result.state.query).toBe('alpha original'); expect(result.state.sourceId).toBe(ids.alpha)
      }
      await page.keyboard.press('Control+A'); await page.keyboard.type('BetaDistinctEnd')
      const beta = page.locator('.dbw-source-option').filter({ has: page.getByText(names.beta, { exact: true }) })
      await expect(beta).toHaveCount(1)
      await tabTo(page, beta); await page.keyboard.press('Enter')
      await expect(trigger).toHaveAttribute('title', names.beta)
      await expect(query).toHaveValue('beta')
      await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('beta original Notes')
      await waitLayout(page)
      const selected = await record(page, app, info, language, width, before, 'native-tab-enter-selects-exact-beta-and-original-view', databaseControls)
      assertNative(selected, width); assertControls(selected)
      expect(selected.state.sourceId).toBe(ids.beta)
      expect(selected.state.savedView).toBe('beta original table')
      expect(await page.evaluate(id => localStorage.getItem('knowbook.database.last-view.' + id), ids.beta)).toBe(ids.betaView)

      await trigger.click(); await expect(search).toBeFocused()
      await tabTo(page, page.locator('.dbw-menu-create')); await page.keyboard.press('Enter')
      const form = page.locator('.dbw-form-dialog')
      await expect(form.getByRole('heading')).toHaveText(text.newDatabase)
      await expect(form.getByRole('textbox', { name: text.name, exact: true })).toBeFocused()
      const opened = await record(page, app, info, language, width, before, 'native-new-database-form-cancel-is-reachable', {
        name: '.dbw-form-dialog input', description: '.dbw-form-dialog textarea',
        cancel: '.dbw-form-dialog footer .dbw-quiet-button', create: '.dbw-form-dialog footer .dbw-primary-button' })
      assertNative(opened, width, 1); assertControls(opened)
      await tabTo(page, form.getByRole('button', { name: text.cancel, exact: true })); await page.keyboard.press('Enter')
      await expect(form).toHaveCount(0); await expect(trigger).toBeFocused()
      const cancelled = await record(page, app, info, language, width, before, 'native-create-cancel-preserves-beta-and-all-storage', databaseControls)
      assertNative(cancelled, width); assertControls(cancelled)
      expect(cancelled.state.sourceId).toBe(ids.beta); expect(cancelled.state.query).toBe('beta')

      const management = [
        { id: 'dashboard', en: 'Dashboard', zh: '总览', ready: '.hero', heading: '.hero h2' },
        { id: 'ai', en: 'AI Assistant', zh: 'AI 助手', ready: '.management-page-header', heading: '.management-page-heading h2' },
        { id: 'plugins', en: 'Plugins', zh: '插件中心', ready: '.plugins-page', heading: '.plugin-page-heading h3' },
        { id: 'settings', en: 'Settings', zh: '配置中心', ready: '.settings-layout', heading: '.management-page-heading h2' }
      ]
      for (const item of management) {
        const title = language === 'zh-CN' ? item.zh : item.en
        await page.getByTitle(title, { exact: true }).click()
        await expect(page.locator('.content.management-page')).toBeVisible()
        await expect(page.locator(item.ready).first()).toBeVisible(); await waitLayout(page)
        const result = await record(page, app, info, language, width, before, 'native-narrow-' + item.en.replaceAll(' ', '-').toLowerCase(), {
          entry: `.sidebar button[data-page-id="${item.id}"]`, heading: item.heading })
        assertNative(result, width); assertControls(result)
      }

      await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click()
      const documentEntry = page.locator('.tree-button').filter({ has: page.getByText(documentTitle, { exact: true }) })
      await expect(documentEntry).toHaveCount(1); await documentEntry.click()
      await expect(page.locator('.document-header-title')).toHaveText(documentTitle)
      const reading = page.locator('.document-view-toggle')
      if (await reading.getAttribute('aria-pressed') !== 'true') await reading.click()
      await expect(page.locator('.preview-panel')).toHaveClass(/preview-panel-reading/)
      const body = page.locator(`[data-block-id="${documentBlockId}"]`)
      await expect(body).toContainText(documentBody)
      // A reading paragraph has no Tab stop; use its real pointer surface,
      // without adding focusability or modifying the document.
      await body.click()
      const details = await record(page, app, info, language, width, before, 'native-narrow-original-document-reading', {
        ...documentControls, body: `[data-block-id="${documentBlockId}"]` })
      assertNative(details, width); assertControls(details)
      expect(details.state.documentTitle).toBe(documentTitle); expect(details.state.reading).toBe('true')

      const more = page.locator(documentControls.more), auxiliary = page.locator(documentControls.auxiliary)
      await tabTo(page, more); await page.keyboard.press('Enter')
      await expect(page.locator('.document-header-action-menu')).toBeVisible(); await twoFrames(page)
      const moreMenu = await record(page, app, info, language, width, before, 'native-document-more-real-enter-and-escape', {
        menu: '.document-header-action-menu', firstAction: '.document-header-action-menu .context-menu-item' })
      assertNative(moreMenu, width); assertControls(moreMenu)
      await page.keyboard.press('Escape'); await expect(page.locator('.document-header-action-menu')).toHaveCount(0)
      await expect(more).toBeFocused()
      await auxiliary.click(); await expect(auxiliary).toHaveAttribute('aria-pressed', 'true'); await waitLayout(page)
      const auxiliaryOpen = await record(page, app, info, language, width, before, 'native-document-auxiliary-open-keeps-save-more-and-close-reachable', documentControls)
      assertNative(auxiliaryOpen, width); assertControls(auxiliaryOpen)
      await auxiliary.click(); await expect(auxiliary).toHaveAttribute('aria-pressed', 'false'); await waitLayout(page)
      await body.click()
      const final = await record(page, app, info, language, width, before, 'native-document-auxiliary-close-restores-original-reading', {
        ...documentControls, body: `[data-block-id="${documentBlockId}"]` })
      assertNative(final, width); assertControls(final)
      expect(final.state.documentTitle).toBe(documentTitle); expect(final.state.auxiliary).toBe('false')
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
