import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { WorkspaceSearchInput, WorkspaceSearchPage } from '../src/shared/workspace-search'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: IpcMainInvokeEvent, input: WorkspaceSearchInput) => WorkspaceSearchPage | Promise<WorkspaceSearchPage>
type Request = { id: number; event: IpcMainInvokeEvent; input: WorkspaceSearchInput; settled: boolean;
  resolve: (page: WorkspaceSearchPage) => void; reject: (error: Error) => void }
type Probe = { original: Handler; hold: boolean; requests: Request[]; completed: Array<{ id: number; failed: boolean }> }
type ProbeGlobal = typeof globalThis & { __knowbookPaginationReading?: Probe }
type ProgramCall = { method: 'focus' | 'scrollIntoView'; heading: string | null }
type ProbeWindow = Window & { __knowbookPaginationCalls?: ProgramCall[];
  __knowbookPaginationRoute?: Array<{ phase: string; step: number; tag: string | null; reached: boolean }> }
type Scenario = { language: 'en-US' | 'zh-CN'; theme: 'light' | 'dark'; viewport: { width: number; height: number } }
const needle = 'PaginationReading'
const tag = 'pagination-reading'
const rows = (page: Page) => page.getByTestId('workspace-search-result')
const panel = (page: Page) => page.locator('.workspace-search-results-panel')
const content = (page: Page) => page.locator('.content')
const heading = (page: Page) => page.locator('.workspace-search-results-head h3')
const query = (page: Page) => page.getByLabel(uiText('Keywords', '关键词'), { exact: true })
const field = (page: Page, en: string, zh: string) => page.getByLabel(uiText(en, zh), { exact: true })
const next = (page: Page) => page.getByRole('button', { name: uiText('Next page', '下一页'), exact: true })
const previous = (page: Page) => page.getByRole('button', { name: uiText('Previous page', '上一页'), exact: true })
const twoFrames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
const english: Scenario = { language: 'en-US', theme: 'light', viewport: { width: 1360, height: 880 } }
const chinese: Scenario = { language: 'zh-CN', theme: 'dark', viewport: { width: 760, height: 640 } }

async function keys(page: Page) {
  return rows(page).evaluateAll(elements => elements.map(element => `${element.getAttribute('data-document-id')}:${element.getAttribute('data-block-id') ?? ''}`))
}
const pageKeys = (result: WorkspaceSearchPage) => result.items.map(item => `${item.documentId}:${item.blockId ?? ''}`)

async function documents(page: Page, ids: string[]) {
  return page.evaluate(ids => Promise.all(ids.map(id => window.knowbook.getDocumentDetail(id))), ids)
}

async function prepare(page: Page, app: ElectronApplication, scenario: Scenario) {
  const fixture = await page.evaluate(async ({ language, theme, needle, tag }) => {
    const parent = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(parent.id, { title: 'Pagination reading collection', summary: 'Keep this parent.', blocks: [] })
    const ids: string[] = []
    for (let index = 0; index < 62; index++) {
      const { id } = await window.knowbook.createDocument(parent.id)
      await window.knowbook.updateDocument(id, { title: `${needle} ${String(index).padStart(2, '0')}`, summary: '', blocks: [
        { id: `${id}-body`, type: 'paragraph', content: `Original pagination body ${index}.`, tags: [tag], checked: false, depth: 0 }
      ] })
      ids.push(id)
    }
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', theme)
    return { parentId: parent.id, ids }
  }, { ...scenario, needle, tag })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize(scenario.viewport)
  await app.evaluate(({ BrowserWindow }, viewport) => BrowserWindow.getAllWindows()[0].setContentSize(viewport.width, viewport.height), scenario.viewport)
  await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
  await query(page).fill(needle)
  await page.getByRole('button', { name: uiText('Filters', '筛选'), exact: true }).click()
  await field(page, 'Search scope', '搜索范围').selectOption('documents')
  await field(page, 'Folder', '目录').selectOption(fixture.parentId)
  await field(page, 'Tag', '标签').selectOption(tag)
  await field(page, 'Sort', '排序').selectOption('updated-asc')
  await page.getByRole('button', { name: uiText('Filters', '筛选'), exact: true }).click()
  await expect(page.getByTestId('workspace-search-total')).toHaveAttribute('data-total-number', '62')
  await expect(rows(page)).toHaveCount(25)
  await expect(panel(page)).toHaveAttribute('aria-busy', 'false')
  const criteria: WorkspaceSearchInput = { query: needle, scope: 'documents', matchMode: 'all', folderId: fixture.parentId,
    tag, blockType: '', updatedFrom: '', updatedTo: '', sort: 'updated-asc', pageSize: 25 }
  const expected = await page.evaluate(async input => Promise.all([1, 2, 3].map(page => window.knowbook.searchWorkspace({ ...input, page }))), criteria)
  expect(await keys(page)).toEqual(pageKeys(expected[0]))
  const before = await documents(page, [fixture.parentId, ...fixture.ids])
  await installProbe(app)
  // These wrappers only observe calls to the stable reading heading. They
  // forward actual product calls unchanged and never move focus or scroll.
  await page.evaluate(() => {
    const target = window as ProbeWindow
    target.__knowbookPaginationCalls = []
    const nativeFocus = HTMLElement.prototype.focus, nativeScroll = Element.prototype.scrollIntoView
    HTMLElement.prototype.focus = function (options) {
      if (this.matches('.workspace-search-results-head h3')) target.__knowbookPaginationCalls!.push({ method: 'focus', heading: this.textContent })
      nativeFocus.call(this, options)
    }
    Element.prototype.scrollIntoView = function (options) {
      if (this.matches('.workspace-search-results-head h3')) target.__knowbookPaginationCalls!.push({ method: 'scrollIntoView', heading: this.textContent })
      nativeScroll.call(this, options)
    }
  })
  return { ...fixture, criteria, expected, before }
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('knowbook:search-workspace')
    if (!original) throw new Error('The real workspace search handler is required')
    const probe: Probe = { original, hold: false, requests: [], completed: [] }
    ;(globalThis as ProbeGlobal).__knowbookPaginationReading = probe
    ipcMain.removeHandler('knowbook:search-workspace')
    ipcMain.handle('knowbook:search-workspace', (event, input) => {
      if (!probe.hold) return probe.original(event, input)
      return new Promise<WorkspaceSearchPage>((resolve, reject) => {
        probe.requests.push({ id: probe.requests.length, event, input, settled: false, resolve, reject })
      })
    })
  })
}

async function hold(app: ElectronApplication, value: boolean) {
  await app.evaluate((_electron, value) => { (globalThis as ProbeGlobal).__knowbookPaginationReading!.hold = value }, value)
}

async function pending(app: ElectronApplication, pageNumber: number) {
  const actual = () => app.evaluate((_electron, { pageNumber, query }) => (globalThis as ProbeGlobal).__knowbookPaginationReading!.requests
    .filter(request => !request.settled && request.input.query === query && request.input.page === pageNumber)
    .map(({ id, input }) => ({ id, input })), { pageNumber, query: needle })
  await expect.poll(async () => (await actual()).length).toBe(1)
  return (await actual())[0]
}

async function finish(app: ElectronApplication, id: number, error: string | null = null) {
  await app.evaluate((_electron, { id, error }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookPaginationReading!, request = probe.requests[id]
    if (!request || request.settled) throw new Error('The exact original workspace search must remain pending')
    request.settled = true
    setImmediate(async () => {
      if (error !== null) { probe.completed.push({ id, failed: true }); request.reject(new Error(error)); return }
      try { const result = await probe.original(request.event, request.input); probe.completed.push({ id, failed: false }); request.resolve(result) }
      catch (cause) { probe.completed.push({ id, failed: true }); request.reject(cause instanceof Error ? cause : new Error(String(cause))) }
    })
  }, { id, error })
  await expect.poll(() => app.evaluate((_electron, id) => (globalThis as ProbeGlobal).__knowbookPaginationReading!.completed.some(result => result.id === id), id)).toBe(true)
}

async function tabTo(page: Page, target: Locator, phase: string) {
  let reached = await target.evaluate(element => document.activeElement === element)
  for (let step = 1; !reached && step <= 120; step++) {
    await page.keyboard.press('Tab')
    reached = await target.evaluate((element, { phase, step }) => {
      const stop = { phase, step, tag: document.activeElement?.tagName ?? null, reached: document.activeElement === element }
      ;((window as ProbeWindow).__knowbookPaginationRoute ??= []).push(stop)
      return stop.reached
    }, { phase, step })
  }
  expect(reached, 'Native Tab must reach the paging control without repairing focus').toBe(true)
  await expect(target).toBeFocused()
}

async function bottom(page: Page) {
  const bounds = (await content(page).boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.wheel(0, 50_000)
  await expect(next(page)).toBeInViewport({ ratio: 1 })
  await twoFrames(page)
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookPaginationReading!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(),
      bounds: window.getBounds(), contentBounds: window.getContentBounds() })), requests: probe.requests.map(({ id, input, settled }) => ({ id, input, settled })), completed: probe.completed }
  })
  const state = await page.evaluate(() => {
    const rect = (element: Element) => { const value = element.getBoundingClientRect(); return { top: value.top, left: value.left,
      right: value.right, bottom: value.bottom, width: value.width, height: value.height } }
    const box = (element: Element) => {
      const bounds = rect(element), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), value = rect(parent)
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { clip.left = Math.max(clip.left, value.left + parent.clientLeft); clip.right = Math.min(clip.right, value.left + parent.clientLeft + parent.clientWidth) }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { clip.top = Math.max(clip.top, value.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, value.top + parent.clientTop + parent.clientHeight) }
      }
      const width = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left)), height = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return { rect: bounds, clip, visibleRatio: bounds.width && bounds.height ? width * height / (bounds.width * bounds.height) : 0,
        centerHit: hit === element || Boolean(hit && element.contains(hit)) }
    }
    const active = document.activeElement as HTMLElement | null, main = document.querySelector<HTMLElement>('.content')!
    const head = document.querySelector('.workspace-search-results-head h3'), first = document.querySelector('[data-testid="workspace-search-result"]')
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      content: { className: main.className, scrollTop: main.scrollTop, clientTop: main.clientTop, clientHeight: main.clientHeight,
        scrollHeight: main.scrollHeight, scrollPaddingTop: parseFloat(getComputedStyle(main).scrollPaddingTop) || 0, rect: rect(main) },
      active: { tag: active?.tagName, text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null,
        className: active?.className, isBody: active === document.body, connected: active?.isConnected },
      readingHeading: head ? { ...box(head), focused: active === head, scrollMarginTop: parseFloat(getComputedStyle(head).scrollMarginTop) || 0 } : null,
      first: first ? { ...box(first), documentId: first.getAttribute('data-document-id') } : null,
      keys: Array.from(document.querySelectorAll('[data-testid="workspace-search-result"]')).map(element => `${element.getAttribute('data-document-id')}:${element.getAttribute('data-block-id') ?? ''}`),
      query: document.querySelector<HTMLInputElement>('.workspace-search-query input')?.value,
      filters: Array.from(document.querySelectorAll<HTMLSelectElement>('.workspace-search-filter-panel select')).map(select => select.value),
      sort: document.querySelector<HTMLSelectElement>('.workspace-search-sort select')?.value,
      pagination: document.querySelector('.workspace-search-pagination')?.textContent,
      loading: document.querySelector('.workspace-search-results-panel')?.getAttribute('aria-busy'),
      programCalls: (window as ProbeWindow).__knowbookPaginationCalls ?? [], route: (window as ProbeWindow).__knowbookPaginationRoute ?? [] }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { main, state }
}

async function accepted(page: Page, expected: WorkspaceSearchPage) {
  await expect(panel(page)).toHaveAttribute('aria-busy', 'false')
  await expect.poll(() => keys(page)).toEqual(pageKeys(expected))
}

async function criteriaPreserved(page: Page, parentId: string, searchQuery = needle) {
  await expect(query(page)).toHaveValue(searchQuery)
  await expect(field(page, 'Sort', '排序')).toHaveValue('updated-asc')
  await expect(field(page, 'Search scope', '搜索范围')).toHaveValue('documents')
  await expect(field(page, 'Folder', '目录')).toHaveValue(parentId)
  await expect(field(page, 'Tag', '标签')).toHaveValue(tag)
  await expect(field(page, 'Results per page', '每页结果')).toHaveValue('25')
}

async function readingStart(page: Page, state: Awaited<ReturnType<typeof record>>['state']) {
  expect(state.readingHeading).not.toBeNull()
  expect(state.first).not.toBeNull()
  expect(state.readingHeading!.visibleRatio).toBeGreaterThanOrEqual(0.999)
  expect(state.readingHeading!.centerHit).toBe(true)
  expect(state.first!.visibleRatio).toBeGreaterThanOrEqual(0.999)
  expect(state.first!.centerHit).toBe(true)
  const readingTop = state.content.rect.top + state.content.clientTop + state.content.scrollPaddingTop + state.readingHeading!.scrollMarginTop
  expect(Math.abs(state.readingHeading!.rect.top - readingTop)).toBeLessThanOrEqual(1)
  await expect(heading(page)).toBeFocused()
}

for (const scenario of [english, chinese]) {
  test(`explicit search pagination restores the new reading start (${scenario.language}) @electron`, async ({}, info) => {
    test.setTimeout(150_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const fixture = await prepare(page, app, scenario)
      await bottom(page)
      if (scenario.language === 'zh-CN') await tabTo(page, next(page), 'native-tab-to-next')
      const before = await record(page, app, info, 'first-page-bottom-before-explicit-next')
      expect(before.state.content.scrollTop).toBeGreaterThan(1_000)
      if (scenario.language === 'en-US') await next(page).click()
      else await page.keyboard.press('Enter')
      await accepted(page, fixture.expected[1])
      const after = await record(page, app, info, 'second-page-before-reading-start-assertion')
      await readingStart(page, after.state)
      await criteriaPreserved(page, fixture.parentId)
      expect(after.state.programCalls).toHaveLength(2)
      await bottom(page)
      if (scenario.language === 'en-US') await tabTo(page, previous(page), 'native-tab-to-previous')
      await record(page, app, info, 'second-page-bottom-before-explicit-previous')
      if (scenario.language === 'en-US') await page.keyboard.press('Enter')
      else await previous(page).click()
      await accepted(page, fixture.expected[0])
      const returned = await record(page, app, info, 'first-page-restored-before-reading-start-assertion')
      await readingStart(page, returned.state)
      await criteriaPreserved(page, fixture.parentId)
      expect(returned.state.programCalls).toHaveLength(4)
      expect(await documents(page, [fixture.parentId, ...fixture.ids])).toEqual(fixture.before)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: scenario.language })
  })
}

test('pending pagination does not jump, and failures, retry or a new query cannot revive its reading lease @electron', async ({}, info) => {
  test.setTimeout(150_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await prepare(page, app, english)
    await hold(app, true)
    await bottom(page)
    const before = await record(page, app, info, 'before-deferred-next')
    await next(page).click()
    const request = await pending(app, 2)
    const waiting = await record(page, app, info, 'next-pending-preserves-old-reading-location')
    expect(waiting.state.keys).toEqual(before.state.keys)
    expect(Math.abs(waiting.state.content.scrollTop - before.state.content.scrollTop)).toBeLessThanOrEqual(1)
    expect(waiting.state.programCalls).toEqual([])
    await expect(panel(page)).toHaveAttribute('aria-busy', 'true')
    await hold(app, false)
    await finish(app, request.id, 'Pagination fixture: temporary search failure')
    await expect(panel(page).getByRole('alert')).toContainText('Pagination fixture: temporary search failure')
    await twoFrames(page)
    const failed = await record(page, app, info, 'failure-allows-natural-layout-clamp-without-reading-handoff')
    // The existing error UI replaces the grid, so natural scroll clamping is
    // allowed. Failure must not programmatically focus or scroll the heading.
    expect(failed.state.programCalls).toEqual([])
    await expect(heading(page)).not.toBeFocused()
    await criteriaPreserved(page, fixture.parentId)
    await page.getByRole('button', { name: uiText('Retry search', '重试搜索'), exact: true }).click()
    await accepted(page, fixture.expected[1])
    const retried = await record(page, app, info, 'retry-success-does-not-revive-expired-pagination-focus')
    expect(retried.state.programCalls).toEqual([])
    await expect(heading(page)).not.toBeFocused()

    await hold(app, true)
    await bottom(page)
    await next(page).click()
    const obsolete = await pending(app, 3)
    await hold(app, false)
    const revisedQuery = `${needle} 01`
    await query(page).fill(revisedQuery)
    const revised = await page.evaluate(input => window.knowbook.searchWorkspace(input), { ...fixture.criteria, query: revisedQuery, page: 1 })
    await accepted(page, revised)
    await expect(query(page)).toBeFocused()
    const newer = await record(page, app, info, 'new-query-owns-focus-before-obsolete-page-completes')
    await finish(app, obsolete.id)
    await twoFrames(page)
    const stale = await record(page, app, info, 'obsolete-page-completion-leaves-new-query-reading-alone')
    expect(stale.state.keys).toEqual(newer.state.keys)
    expect(Math.abs(stale.state.content.scrollTop - newer.state.content.scrollTop)).toBeLessThanOrEqual(1)
    expect(stale.state.programCalls).toEqual([])
    await expect(query(page)).toBeFocused()
    await criteriaPreserved(page, fixture.parentId, revisedQuery)
    expect(await documents(page, [fixture.parentId, ...fixture.ids])).toEqual(fixture.before)
  }, { PLAYWRIGHT_ELECTRON_LOCALE: english.language })
})

test('newer scrolling, focus, background refresh and leaving search prevent pagination handoffs in compact Chinese UI @electron', async ({}, info) => {
  test.setTimeout(150_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await prepare(page, app, chinese)
    await hold(app, true)
    await bottom(page)
    await next(page).click()
    const request = await pending(app, 2)
    const waiting = await record(page, app, info, 'compact-next-waits-at-old-reading-location')
    const bounds = (await content(page).boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.wheel(0, -650)
    await expect.poll(() => content(page).evaluate(element => element.scrollTop)).toBeLessThan(waiting.state.content.scrollTop - 100)
    await twoFrames(page)
    const scrolled = await record(page, app, info, 'user-wheel-selects-a-newer-reading-location')
    await finish(app, request.id)
    await accepted(page, fixture.expected[1])
    const afterScroll = await record(page, app, info, 'page-completes-without-reclaiming-newer-wheel-position')
    expect(Math.abs(afterScroll.state.content.scrollTop - scrolled.state.content.scrollTop)).toBeLessThanOrEqual(1)
    expect(afterScroll.state.programCalls).toEqual([])
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('knowbook:workspace-mutated'))
    const refresh = await pending(app, 2)
    const refreshing = await record(page, app, info, 'background-refresh-pending-without-explicit-page-intent')
    await finish(app, refresh.id)
    await accepted(page, fixture.expected[1])
    const refreshed = await record(page, app, info, 'background-refresh-cannot-revive-canceled-reading-lease')
    expect(Math.abs(refreshed.state.content.scrollTop - refreshing.state.content.scrollTop)).toBeLessThanOrEqual(1)
    expect(refreshed.state.programCalls).toEqual([])

    await bottom(page)
    await previous(page).click()
    const back = await pending(app, 1)
    const toggle = page.getByRole('button', { name: uiText('Filters', '筛选'), exact: true })
    await toggle.click()
    await expect(toggle).toBeFocused()
    const focused = await record(page, app, info, 'newer-filter-focus-owns-the-pending-page')
    await finish(app, back.id)
    await accepted(page, fixture.expected[0])
    const afterFocus = await record(page, app, info, 'page-completes-without-reclaiming-newer-filter-focus')
    expect(Math.abs(afterFocus.state.content.scrollTop - focused.state.content.scrollTop)).toBeLessThanOrEqual(1)
    expect(afterFocus.state.programCalls).toEqual([])
    await expect(toggle).toBeFocused()
    await criteriaPreserved(page, fixture.parentId)
    await toggle.click()

    await bottom(page)
    await next(page).click()
    const departing = await pending(app, 2)
    const dashboard = page.getByTitle(uiText('Dashboard', '总览'), { exact: true })
    await dashboard.click()
    await expect(content(page)).not.toHaveClass(/page-search/)
    const departed = await record(page, app, info, 'dashboard-owns-view-before-pending-page-completes')
    await finish(app, departing.id)
    await twoFrames(page)
    const completed = await record(page, app, info, 'departed-page-does-not-scroll-or-focus-dashboard')
    expect(completed.state.content.className).toBe(departed.state.content.className)
    expect(Math.abs(completed.state.content.scrollTop - departed.state.content.scrollTop)).toBeLessThanOrEqual(1)
    expect(completed.state.programCalls).toEqual([])
    await expect(dashboard).toBeFocused()
    expect(await documents(page, [fixture.parentId, ...fixture.ids])).toEqual(fixture.before)
  }, { PLAYWRIGHT_ELECTRON_LOCALE: chinese.language })
})
