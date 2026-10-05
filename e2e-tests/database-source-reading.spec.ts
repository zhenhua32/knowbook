import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __sourceReadingProbe?: Probe }
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
  await page.setViewportSize({ width, height: 760 })
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
    ;(globalThis as ProbeGlobal).__sourceReadingProbe = probe
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
  before: Awaited<ReturnType<typeof readStored>>, phase: string) {
  const state = await page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const metric = (element: HTMLElement) => {
      const text = element.textContent ?? '', node = element.firstChild!, glyphs = []
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      const clips = []
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect()
        const borderLeft = parseFloat(style.borderLeftWidth), borderRight = parseFloat(style.borderRightWidth)
        const borderTop = parseFloat(style.borderTopWidth), borderBottom = parseFloat(style.borderBottomWidth)
        const verticalScrollbar = Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - borderLeft - borderRight)
        const horizontalScrollbar = Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - borderTop - borderBottom)
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, rect.left + borderLeft); right = Math.min(right, rect.right - borderRight - verticalScrollbar) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, rect.top + borderTop); bottom = Math.min(bottom, rect.bottom - borderBottom - horizontalScrollbar) }
        clips.push({ className: ancestor.className, overflowX: style.overflowX, overflowY: style.overflowY, box: box(ancestor) })
      }
      for (let index = Math.max(0, text.length - 20); index < text.length; index++) {
        if (/\s/.test(text[index])) continue
        const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1)
        const rect = range.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        const option = element.closest('.dbw-source-option')!
        glyphs.push({ character: text[index], box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          visible: rect.width > 0 && rect.left >= left && rect.right <= right && rect.top >= top && rect.bottom <= bottom,
          hit: hit === option || Boolean(hit && option.contains(hit)) })
      }
      return { text, whiteSpace: getComputedStyle(element).whiteSpace, box: box(element), clips, glyphs,
        suffixVisible: glyphs.length > 0 && glyphs.every(glyph => glyph.visible && glyph.hit) }
    }
    const list = document.querySelector<HTMLElement>('.dbw-source-list')
    const active = document.activeElement
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'), sourceId: localStorage.getItem('knowbook.database.last-source'),
      savedView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      sourceQuery: document.querySelector<HTMLInputElement>('.dbw-source-search input')?.value ?? null,
      pickerCount: document.querySelectorAll('.dbw-source-picker').length,
      formCount: document.querySelectorAll('.dbw-form-dialog, .dbw-create-record-dialog, .app-confirm-dialog').length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      outerScroll: { windowX: scrollX, windowY: scrollY, document: document.scrollingElement?.scrollTop,
        canvas: document.querySelector('.content.page-database')?.scrollTop },
      active: active instanceof HTMLElement ? { className: active.className, text: active.textContent,
        sourceTrigger: active.matches('.dbw-source-trigger'), sourceSearch: active.matches('.dbw-source-search input'), create: active.matches('.dbw-menu-create') } : null,
      list: list ? { box: box(list), scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } : null,
      options: Array.from(document.querySelectorAll<HTMLButtonElement>('.dbw-source-option')).map(option => ({
        name: option.querySelector('strong')!.textContent, focused: active === option, hovered: option.matches(':hover'),
        current: option.getAttribute('aria-current'), box: box(option), nameMetric: metric(option.querySelector('strong')!),
        descriptionMetric: metric(option.querySelector('small')!) })) }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const probe = await app.evaluate(() => (globalThis as ProbeGlobal).__sourceReadingProbe!)
  const stored = await readStored(page, app, language)
  const accessibility = await page.locator('.dbw-source-picker').count() ? await page.locator('.dbw-source-picker').ariaSnapshot() : ''
  const result = { phase, language, width, state, windows, probe, accessibility, before, stored }
  const path = info.outputPath(language + '-' + width + '-' + phase + '.json')
  writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(language + '-' + width + '-' + phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(probe).toEqual({ requests: [], writes: [], failures: [] })
  expect(stored).toEqual(before)
  expect(state.horizontalOverflow).toBe(false)
  expect(state.formCount).toBe(0)
  return result
}
async function moveToOption(page: Page, option: Locator) {
  const list = page.locator('.dbw-source-list'), bounds = await list.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width - 8, bounds!.y + bounds!.height / 2)
  for (let step = 0; step < 30; step++) {
    const position = await option.evaluate(element => {
      const rect = element.getBoundingClientRect(), list = element.closest('.dbw-source-list')!.getBoundingClientRect()
      return { visible: rect.top >= list.top && rect.bottom <= list.bottom, direction: rect.top < list.top ? -1 : 1,
        x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    if (position.visible) { await page.mouse.move(position.x, position.y); return }
    await page.mouse.wheel(0, position.direction * 80)
    await twoFrames(page)
  }
  throw new Error('The source option must become fully reachable through native list scrolling')
}
async function wheelToSuffix(page: Page, option: Locator, suffix: string) {
  const list = page.locator('.dbw-source-list'), bounds = await list.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width - 8, bounds!.y + bounds!.height / 2)
  for (let step = 0; step < 30; step++) {
    const visible = await option.locator('small').evaluate((element, suffix) => {
      const text = element.textContent!, index = text.lastIndexOf(suffix), range = document.createRange()
      range.setStart(element.firstChild!, index); range.setEnd(element.firstChild!, text.length)
      const rect = range.getBoundingClientRect(), list = element.closest('.dbw-source-list')!.getBoundingClientRect()
      return rect.top >= list.top && rect.bottom <= list.bottom
    }, suffix)
    if (visible) return
    await page.mouse.wheel(0, 120)
    await twoFrames(page)
  }
}
function assertReadable(result: Awaited<ReturnType<typeof record>>, key: 'alpha' | 'beta', focused: boolean) {
  const option = result.state.options.find(option => option.name === names[key])!
  expect(option).toBeTruthy()
  expect(option.focused).toBe(focused)
  expect(option.nameMetric.text).toBe(names[key])
  expect(option.descriptionMetric.text).toBe(descriptions[key])
  expect(result.accessibility).toContain(names[key])
  expect(result.accessibility).toContain(descriptions[key])
  expect(option.nameMetric.suffixVisible, 'The distinguishing source name suffix must be painted inside every clip').toBe(true)
  expect(option.descriptionMetric.suffixVisible, 'The distinguishing description suffix must be painted inside every clip').toBe(true)
}

for (const language of ['en-US', 'zh-CN'] as const) for (const width of [760, 1100]) {
  test(`Source names and descriptions remain readable by keyboard and pointer in ${language} at ${width}px @electron`, async ({}, info) => {
    test.setTimeout(120000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language, width), text = getDatabaseWorkspaceText(language)
      const before = await readStored(page, app, language)
      await installProbe(app)
      const trigger = page.locator('.dbw-source-trigger'), search = page.locator('.dbw-source-search input')
      const alpha = page.locator('.dbw-source-option').filter({ has: page.locator('strong', { hasText: names.alpha }) })
      const beta = page.locator('.dbw-source-option').filter({ has: page.locator('strong', { hasText: names.beta }) })
      const tall = page.locator('.dbw-source-option').filter({ has: page.locator('strong', { hasText: names.tall }) })
      await page.mouse.move(1, 1)
      await trigger.click()
      await expect(search).toBeFocused()
      await search.fill(prefix)
      await expect(page.locator('.dbw-source-option')).toHaveCount(3)
      await tabTo(page, alpha)
      await twoFrames(page)
      const first = await record(page, app, info, language, width, before, 'keyboard-alpha-distinct-suffix-before-first-reading-oracle')
      assertReadable(first, 'alpha', true)
      expect(first.state.sourceId).toBe(ids.alpha)
      expect(first.state.sourceQuery).toBe(prefix)
      await tabTo(page, beta)
      await twoFrames(page)
      const second = await record(page, app, info, language, width, before, 'keyboard-beta-distinct-suffix-and-neighbor-separation')
      assertReadable(second, 'beta', true)
      const a = second.state.options.find(option => option.name === names.alpha)!, b = second.state.options.find(option => option.name === names.beta)!
      expect(a.descriptionMetric.box.bottom).toBeLessThan(b.nameMetric.box.top)
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(search).toHaveValue(prefix)
      await expect(search).toBeFocused()
      await moveToOption(page, alpha)
      await twoFrames(page)
      const hovered = await record(page, app, info, language, width, before, 'pointer-alpha-full-suffix-with-search-focus-and-query-preserved')
      assertReadable(hovered, 'alpha', false)
      expect(hovered.state.active?.sourceSearch).toBe(true)
      expect(hovered.state.options.find(option => option.name === names.alpha)?.hovered).toBe(true)
      expect(hovered.state.sourceQuery).toBe(prefix)
      expect(hovered.state.outerScroll).toEqual(first.state.outerScroll)
      await page.mouse.move(1, 1)
      await tabTo(page, tall)
      await twoFrames(page)
      await wheelToSuffix(page, tall, 'TallDescriptionEnd')
      const scrolled = await record(page, app, info, language, width, before, 'oversized-description-native-wheel-reveals-final-suffix')
      const tallState = scrolled.state.options.find(option => option.name === names.tall)!
      expect(tallState.focused).toBe(true)
      expect(tallState.descriptionMetric.text).toBe(descriptions.tall)
      expect(tallState.descriptionMetric.suffixVisible).toBe(true)
      expect(scrolled.state.list!.scrollHeight).toBeGreaterThan(scrolled.state.list!.clientHeight)
      expect(scrolled.state.list!.scrollTop).toBeGreaterThan(0)
      const create = page.getByRole('button', { name: text.newDatabase, exact: true })
      await tabTo(page, create)
      await expect(create).toBeFocused()
      const footer = await record(page, app, info, language, width, before, 'new-database-entry-remains-keyboard-reachable-after-long-description')
      expect(footer.state.active?.create).toBe(true)
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(search).toHaveValue(prefix)
      await page.mouse.move(1, 1)
      await tabTo(page, beta)
      await page.keyboard.press('Enter')
      await expect(page.locator('.dbw-source-picker')).toHaveCount(0)
      await expect(trigger).toHaveAttribute('title', names.beta)
      await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(1)
      const selected = await record(page, app, info, language, width, before, 'genuine-enter-selects-exact-beta-id-and-original-view-without-writes')
      expect(selected.state.sourceId).toBe(ids.beta)
      expect(selected.state.savedView).toBe('beta original table')
      expect(selected.state.query).toBe('beta')
      await trigger.click()
      await expect(search).toHaveValue('')
      const reset = await record(page, app, info, language, width, before, 'only-explicit-source-selection-resets-source-search')
      expect(reset.state.sourceQuery).toBe('')
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
