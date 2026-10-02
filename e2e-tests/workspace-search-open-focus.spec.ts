import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { UpdateDocumentInput, UpdateDocumentResult } from '../src/shared/contracts'
import type { WorkspaceSearchInput, WorkspaceSearchPage } from '../src/shared/workspace-search'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type SaveHandler = (event: IpcMainInvokeEvent, id: string, input: UpdateDocumentInput) => Promise<UpdateDocumentResult>
type SearchHandler = (event: IpcMainInvokeEvent, input: WorkspaceSearchInput) => WorkspaceSearchPage | Promise<WorkspaceSearchPage>
type Probe = {
  currentId: string; originalSave: SaveHandler; originalSearch: SearchHandler; holdSearch: boolean; clipboardCalls: number
  saves: Array<{ id: string; input: UpdateDocumentInput }>; searches: WorkspaceSearchInput[]
  pendingSaves: Array<{ event: IpcMainInvokeEvent; id: string; input: UpdateDocumentInput;
    resolve: (value: UpdateDocumentResult) => void; reject: (error: Error) => void }>
  pendingSearches: Array<{ event: IpcMainInvokeEvent; input: WorkspaceSearchInput;
    resolve: (value: WorkspaceSearchPage) => void; reject: (error: Error) => void }>
}
type ProbeGlobal = typeof globalThis & { __knowbookSearchOpenProbe?: Probe }
type TabStop = { phase: string; step: number; tag: string | null; text: string | null; label: string | null;
  tabIndex: number | null; rowKey: string | null; reached: boolean }
type ProbeWindow = Window & { __knowbookSearchOpenRoute?: TabStop[]; __knowbookSearchOriginalTrigger?: Element }

const needle = 'WorkspaceOpenNeedle'
const initialError = 'Initial draft storage is temporarily unavailable.'
const rows = (page: Page) => page.getByTestId('workspace-search-result')
const query = (page: Page) => page.getByLabel(uiText('Keywords', '关键词'), { exact: true })
const panel = (page: Page) => page.locator('.workspace-search-results-panel')
const feedback = (page: Page) => page.locator('.workspace-search-action-feedback')
const actionName = (go: boolean) => go ? uiText('Go to block', '定位内容块') : uiText('Open document', '打开文档')

async function installProbe(app: ElectronApplication, currentId: string) {
  await app.evaluate(({ ipcMain }, currentId) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, SaveHandler | SearchHandler> })._invokeHandlers
    const originalSave = handlers.get('knowbook:update-document') as SaveHandler
    const originalSearch = handlers.get('knowbook:search-workspace') as SearchHandler
    if (!originalSave || !originalSearch) throw new Error('Missing real document/search IPC handlers')
    const probe: Probe = { currentId, originalSave, originalSearch, holdSearch: false, clipboardCalls: 0,
      saves: [], searches: [], pendingSaves: [], pendingSearches: [] }
    ;(globalThis as ProbeGlobal).__knowbookSearchOpenProbe = probe
    ipcMain.removeHandler('knowbook:update-document')
    ipcMain.handle('knowbook:update-document', (event, id: string, input: UpdateDocumentInput) => {
      if (id !== probe.currentId) return probe.originalSave(event, id, input)
      probe.saves.push({ id, input })
      if (probe.saves.length === 1) throw new Error('Initial draft storage is temporarily unavailable.')
      return new Promise<UpdateDocumentResult>((resolve, reject) => probe.pendingSaves.push({ event, id, input, resolve, reject }))
    })
    ipcMain.removeHandler('knowbook:search-workspace')
    ipcMain.handle('knowbook:search-workspace', (event, input: WorkspaceSearchInput) => {
      probe.searches.push(input)
      if (!probe.holdSearch) return probe.originalSearch(event, input)
      return new Promise<WorkspaceSearchPage>((resolve, reject) => probe.pendingSearches.push({ event, input, resolve, reject }))
    })
    // Even an accidental activation cannot touch the system clipboard.
    ipcMain.removeHandler('knowbook:write-clipboard-text')
    ipcMain.handle('knowbook:write-clipboard-text', () => {
      probe.clipboardCalls++
      throw new Error('This navigation fixture does not use the clipboard')
    })
  }, currentId)
}

async function probeState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookSearchOpenProbe!
    return { saves: probe.saves, searches: probe.searches, pendingSaves: probe.pendingSaves.length,
      pendingSearches: probe.pendingSearches.length, clipboardCalls: probe.clipboardCalls }
  })
}

async function finishSave(app: ElectronApplication, failure: string | null) {
  await app.evaluate((_electron, failure) => {
    const probe = (globalThis as ProbeGlobal).__knowbookSearchOpenProbe!
    const pending = probe.pendingSaves.shift()
    if (!pending) throw new Error('No pending document save')
    // Return Inspector before delivering the actual IPC completion. Success
    // delegates to the real store/event-bus handler and its full updateResult.
    setImmediate(async () => {
      if (failure !== null) { pending.reject(new Error(failure)); return }
      try { pending.resolve(await probe.originalSave(pending.event, pending.id, pending.input)) }
      catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }, failure)
}

async function refreshSearch(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    ;(globalThis as ProbeGlobal).__knowbookSearchOpenProbe!.holdSearch = true
    // This exact preload subscription drives useWorkspaceSearch's refresh.
    // Sending IPC never shows or focuses the native BrowserWindow.
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('knowbook:workspace-mutated')
  })
}

async function finishSearch(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookSearchOpenProbe!
    const pending = probe.pendingSearches.shift()
    if (!pending) throw new Error('No pending workspace search refresh')
    probe.holdSearch = false
    setImmediate(async () => {
      try { pending.resolve(await probe.originalSearch(pending.event, pending.input)) }
      catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
    })
  })
}

async function rowKeys(page: Page) {
  return rows(page).evaluateAll(elements => elements.map(element => {
    const row = element as HTMLElement
    return `${row.dataset.documentId}:${row.dataset.blockId ?? ''}`
  }))
}

async function tabTo(page: Page, target: Locator, app: ElectronApplication, testInfo: TestInfo, go: boolean, phase: string,
  direction: 'Tab' | 'Shift+Tab' = 'Tab') {
  let reached = false
  for (let step = 1; step <= 32; step++) {
    await page.keyboard.press(direction)
    reached = await target.evaluate((element, { step, phase }) => {
      const active = document.activeElement as HTMLElement | null
      const row = active?.closest<HTMLElement>('[data-testid="workspace-search-result"]')
      const reached = element === active
      ;((window as ProbeWindow).__knowbookSearchOpenRoute ??= []).push({ phase, step, tag: active?.tagName ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null,
        label: active?.getAttribute('aria-label') ?? null, tabIndex: active?.tabIndex ?? null,
        rowKey: row ? `${row.dataset.documentId}:${row.dataset.blockId ?? ''}` : null, reached })
      return reached
    }, { step, phase })
    if (reached) break
  }
  await record(page, app, testInfo, go, phase)
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, go: boolean, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(go => {
    const row = document.querySelector<HTMLElement>('[data-testid="workspace-search-result"]')
    const label = go ? /^(Go to block|定位内容块)$/ : /^(Open document|打开文档)$/
    const trigger = Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => label.test(button.textContent?.trim() ?? ''))
    const feedback = document.querySelector('.workspace-search-action-feedback')
    const rect = (element: Element | null | undefined) => {
      if (!element) return null
      const value = element.getBoundingClientRect()
      return { x: value.x, y: value.y, width: value.width, height: value.height, bottom: value.bottom, right: value.right }
    }
    const active = document.activeElement as HTMLElement | null
    const style = trigger ? getComputedStyle(trigger) : null
    const feedbackStyle = feedback ? getComputedStyle(feedback) : null
    const opacityAncestors: Array<{ tag: string; className: string; opacity: number }> = []
    let effectiveOpacity = 1
    for (let ancestor = feedback; ancestor; ancestor = ancestor.parentElement) {
      const opacity = Number.parseFloat(getComputedStyle(ancestor).opacity)
      effectiveOpacity *= opacity
      if (opacity !== 1) opacityAncestors.push({ tag: ancestor.tagName, className: ancestor.className, opacity })
      if (ancestor === document.body) break
    }
    const resultsGrid = document.querySelector('.workspace-search-results')
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      query: document.querySelector<HTMLInputElement>('.workspace-search-query input')?.value,
      pageSize: document.querySelector<HTMLSelectElement>('.workspace-search-page-size select')?.value,
      page: document.querySelector('.workspace-search-pagination')?.textContent?.replace(/\s+/g, ' ').trim(),
      loading: document.querySelector('.workspace-search-results-panel')?.getAttribute('aria-busy'),
      rowKey: row ? `${row.dataset.documentId}:${row.dataset.blockId ?? ''}` : null,
      rowOpacity: row ? getComputedStyle(row).opacity : null,
      resultsGridOpacity: resultsGrid ? getComputedStyle(resultsGrid).opacity : null,
      feedback: { text: feedback?.textContent, role: feedback?.getAttribute('role'), id: feedback?.id,
        belongsToRow: Boolean(row && feedback && row.contains(feedback)), rect: rect(feedback),
        color: feedbackStyle?.color, background: feedbackStyle?.backgroundColor, opacityAncestors, effectiveOpacity },
      trigger: trigger && { focused: active === trigger, disabled: trigger.disabled, ariaDisabled: trigger.getAttribute('aria-disabled'),
        ariaBusy: trigger.getAttribute('aria-busy'), describedBy: trigger.getAttribute('aria-describedby'), rect: rect(trigger),
        isOriginal: trigger === (window as ProbeWindow).__knowbookSearchOriginalTrigger,
        style: style && { cursor: style.cursor, opacity: style.opacity, transform: style.transform,
          background: style.backgroundColor, border: style.borderColor, focusVisible: trigger.matches(':focus-visible'),
          outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, outlineColor: style.outlineColor } },
      active: { tag: active?.tagName, text: active?.tagName === 'BUTTON' ? active.textContent : null,
        label: active?.getAttribute('aria-label') }, tabRoute: (window as ProbeWindow).__knowbookSearchOpenRoute ?? [] }
  }, go)
  const body = JSON.stringify({ windows, state, rows: await rowKeys(page), ipc: await probeState(app) }, null, 2)
  writeFileSync(testInfo.outputPath(`${phase}.json`), body, 'utf8')
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return state
}

async function expectBusy(trigger: Locator) {
  expect(await trigger.evaluate(element => (element as HTMLButtonElement).disabled)).toBe(false)
  await expect(trigger).toHaveAttribute('aria-disabled', 'true')
  await expect(trigger).toHaveAttribute('aria-busy', 'true')
  await expect(trigger).toBeFocused()
  expect(await trigger.evaluate(element => element === (window as ProbeWindow).__knowbookSearchOriginalTrigger)).toBe(true)
}

async function duplicates(page: Page, trigger: Locator, app: ElectronApplication, saves: number) {
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await expect(trigger).toBeInViewport({ ratio: 1 })
  expect(await trigger.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit === element || Boolean(hit && element.contains(hit))
  })).toBe(true)
  const box = (await trigger.boundingBox())!
  // Actual native pointer activation, without locator.click's ARIA wait.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  expect((await probeState(app)).saves).toHaveLength(saves)
  expect((await probeState(app)).pendingSaves).toBe(1)
  await expectBusy(trigger)
}

async function expectSettled(trigger: Locator, owner: Locator, loading = false) {
  expect(await trigger.evaluate(element => (element as HTMLButtonElement).disabled)).toBe(false)
  if (loading) await expect(trigger).toBeDisabled()
  else await expect(trigger).toBeEnabled()
  await expect(trigger).toHaveAttribute('aria-disabled', String(loading))
  await expect(trigger).toHaveAttribute('aria-busy', 'false')
  await expect(trigger).toBeFocused()
  const id = await owner.locator('.workspace-search-action-feedback').getAttribute('id')
  expect(id).toBeTruthy()
  expect((await trigger.getAttribute('aria-describedby'))?.split(/\s+/)).toContain(id)
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`workspace search ${language === 'en-US' ? 'Go to block' : 'Open document'} keeps keyboard retry focus through save and refresh (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const go = language === 'en-US'
      const fixture = await page.evaluate(async ({ language, needle }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        const currentId = (await window.knowbook.createDocument(null)).id
        await window.knowbook.updateDocument(currentId, { title: 'Current draft sample', summary: '', blocks: [
          { id: `${currentId}-body`, type: 'paragraph', content: 'Current body remains intact.', checked: false, depth: 0 }
        ] })
        const targetId = (await window.knowbook.createDocument(null)).id
        await window.knowbook.updateDocument(targetId, { title: 'Navigation target sample', summary: '', blocks:
          Array.from({ length: 3 }, (_, index) => ({ id: `${targetId}-body-${index}`, type: 'paragraph' as const,
            content: `${needle} target paragraph ${index}.`, checked: false, depth: 0 })) })
        return { current: (await window.knowbook.getDocumentDetail(currentId))!, target: (await window.knowbook.getDocumentDetail(targetId))! }
      }, { language, needle })
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 760, height: go ? 640 : 850 })
      await page.locator('.tree-button', { hasText: fixture.current.title }).first().click()
      await expect(page.locator('.document-header-title')).toHaveText(fixture.current.title)
      await installProbe(app, fixture.current.id)
      await ensureDocumentMetadataEditor(page)
      const dirtyTitle = language === 'zh-CN' ? '保留未保存的文档草稿' : 'Preserve the unsaved document draft'
      await page.locator('.document-summary-card .editor-input').first().fill(dirtyTitle)
      await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
      await expect.poll(async () => (await probeState(app)).saves.length).toBe(1)
      await expect(page.locator('.app-notifications')).toContainText(initialError)
      await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
      await query(page).fill(needle)
      await expect(rows(page)).toHaveCount(3)
      await expect(page.getByTestId('workspace-search-total')).toHaveAttribute('data-total-number', '3')
      await expect(panel(page)).toHaveAttribute('aria-busy', 'false')
      const originalRows = await rowKeys(page)
      const owner = rows(page).first()
      const targetBlockId = (await owner.getAttribute('data-block-id'))!
      const trigger = owner.getByRole('button', { name: actionName(go), exact: true })
      await tabTo(page, trigger, app, testInfo, go, 'native-tab-route-to-navigation-trigger')
      await trigger.evaluate(element => { (window as ProbeWindow).__knowbookSearchOriginalTrigger = element })
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await probeState(app)).pendingSaves).toBe(1)
      await expect(feedback(page)).toHaveAttribute('role', 'status')
      // Preserve both old pending and settled evidence before introducing any
      // new ARIA/focus assertions: old native disabled yields active BODY.
      await record(page, app, testInfo, go, 'first-navigation-pending-before-new-focus-assertions')
      await finishSave(app, 'Draft save blocked during navigation.')
      await expect(owner.locator('.workspace-search-action-feedback')).toHaveAttribute('role', 'alert')
      await expect(owner.locator('.workspace-search-action-feedback')).toContainText(uiText(
        'Could not switch documents. Your search is preserved. Resolve the save error and retry.',
        '未能切换文档，搜索已保留。请处理保存错误后重试。'))
      await expect(trigger).toBeEnabled()
      await record(page, app, testInfo, go, 'first-navigation-failed-before-direct-enter-retry')
      await expect(trigger).toBeFocused()
      await expectSettled(trigger, owner)
      await expect(query(page)).toHaveValue(needle)
      expect(await rowKeys(page)).toEqual(originalRows)
      expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), fixture.current.id))?.title).toBe(fixture.current.title)

      await page.keyboard.press('Enter')
      await expect.poll(async () => (await probeState(app)).saves.length).toBe(3)
      await expectBusy(trigger)
      await refreshSearch(app)
      await expect(panel(page)).toHaveAttribute('aria-busy', 'true')
      await expect.poll(async () => (await probeState(app)).pendingSearches).toBe(1)
      await record(page, app, testInfo, go, 'retry-retains-navigation-owner-during-live-search-refresh')
      await expectBusy(trigger)
      await duplicates(page, trigger, app, 3)
      // The save settles first while the independently held search is still
      // loading. Completed owner state must also keep native focus; loading
      // disables activation through ARIA/guard, rather than native disabled.
      await finishSave(app, 'Draft storage is still unavailable.')
      await expect(owner.locator('.workspace-search-action-feedback')).toHaveAttribute('role', 'alert')
      await expect(panel(page)).toHaveAttribute('aria-busy', 'true')
      await record(page, app, testInfo, go, 'navigation-failed-while-search-refresh-still-pending')
      await expectSettled(trigger, owner, true)
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      expect((await probeState(app)).saves).toHaveLength(3)
      expect((await probeState(app)).pendingSaves).toBe(0)
      await finishSearch(app)
      await expect(panel(page)).toHaveAttribute('aria-busy', 'false')
      expect(await rowKeys(page)).toEqual(originalRows)
      await record(page, app, testInfo, go, 'search-refresh-settled-completed-owner-still-focused')
      await expectSettled(trigger, owner)

      // A native Tab move to Keywords and actual query edit revoke the old
      // navigation owner. Its late save failure may notify globally, but must
      // neither navigate nor move the user's new query focus.
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await probeState(app)).saves.length).toBe(4)
      await expectBusy(trigger)
      await tabTo(page, query(page), app, testInfo, go, 'pending-navigation-native-tab-back-to-keywords', 'Shift+Tab')
      await query(page).fill(`${needle} NoMatch`)
      await expect(rows(page)).toHaveCount(0)
      await expect(panel(page)).toHaveAttribute('aria-busy', 'false')
      await finishSave(app, 'Obsolete navigation draft save failure.')
      await expect(page.locator('.app-notifications')).toContainText('Obsolete navigation draft save failure.')
      await record(page, app, testInfo, go, 'late-navigation-failure-keeps-new-query-and-focus')
      await expect(query(page)).toBeFocused()
      await expect(query(page)).toHaveValue(`${needle} NoMatch`)
      await expect(feedback(page)).toHaveCount(0)
      await expect(page.locator('.workspace-search-page')).toBeVisible()

      await query(page).fill(needle)
      await expect(rows(page)).toHaveCount(3)
      await expect(panel(page)).toHaveAttribute('aria-busy', 'false')
      await tabTo(page, trigger, app, testInfo, go, 'native-tab-final-navigation-save-retry')
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await probeState(app)).saves.length).toBe(5)
      await finishSave(app, null)
      await expect(page.locator('.document-header-title')).toHaveText(fixture.target.title)
      await expect(page.locator('.workspace-search-page')).toBeHidden()
      await expect(page.locator('.block-editor-row')).toHaveCount(3)
      if (go) {
        const block = page.locator(`.preview-panel [data-block-id="${targetBlockId}"]`)
        await expect(block).toHaveClass(/block-editor-row-highlighted/)
        await expect(block).toBeInViewport()
        await expect(block.locator('textarea.block-inline-textarea')).toBeFocused()
      }
      const savedCurrent = await page.evaluate(id => window.knowbook.getDocumentDetail(id), fixture.current.id)
      expect(savedCurrent?.title).toBe(dirtyTitle)
      expect(savedCurrent?.blocks).toEqual(fixture.current.blocks)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), fixture.target.id)).toEqual(fixture.target)
      const probe = await probeState(app)
      expect(probe.saves).toHaveLength(5)
      expect(probe.saves.every(save => save.id === fixture.current.id && save.input.title === dirtyTitle)).toBe(true)
      expect(probe.clipboardCalls).toBe(0)
      await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
      await expect(query(page)).toHaveValue(needle)
      await expect(rows(page)).toHaveCount(3)
      await expect(panel(page)).toHaveAttribute('aria-busy', 'false')
      expect(await rowKeys(page)).toEqual(originalRows)
      await expect(feedback(page)).toHaveCount(0)
      await record(page, app, testInfo, go, 'real-save-and-navigation-success-return-without-old-feedback')
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
