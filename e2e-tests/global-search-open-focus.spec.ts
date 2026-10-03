import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { UpdateDocumentInput, UpdateDocumentResult } from '../src/shared/contracts'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type SaveHandler = (event: unknown, id: string, input: UpdateDocumentInput) => UpdateDocumentResult | Promise<UpdateDocumentResult>
type SaveRequest = { event: unknown; id: string; input: UpdateDocumentInput; settled: boolean;
  resolve: (result: UpdateDocumentResult) => void; reject: (error: Error) => void }
type SaveProbe = { original: SaveHandler; requests: SaveRequest[]; writes: UpdateDocumentResult[]; failures: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookPaletteOpenFocus?: SaveProbe }
type FocusCall = { field: string | null; tag: string; connected: boolean; disabled: boolean; activeAfter: boolean; preventScroll: boolean }
type FocusEntry = { field: string | null; tag: string; connected: boolean }
type TabStep = { phase: string; step: number; field: string | null; tag: string | null; label: string | null; reached: boolean }
type RendererProbe = { calls: FocusCall[]; focusIns: FocusEntry[]; route: TabStep[]; restore: () => void; twoFrames: () => Promise<void> }
type ProbeWindow = Window & { __knowbookPaletteOpenFocus?: RendererProbe }

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const sourceTitle = 'Palette opening source'
const draftTitle = 'Palette source draft kept during delayed open'
const targetTitle = 'PaletteOpenFocusDestinationUnique'
const saveFailure = 'Palette draft save blocked'

function controls(page: Page) {
  const palette = page.locator('.global-search-modal')
  const actions = palette.getByRole('group', { name: uiText('Selected result actions', '所选搜索结果操作'), exact: true })
  return { palette,
    input: palette.getByRole('combobox', { name: uiText('Search documents or commands', '搜索文档或命令'), exact: true }),
    close: palette.getByRole('button', { name: uiText('Close search', '关闭搜索'), exact: true }),
    open: actions.getByRole('button', { name: uiText('Open document', '打开文档'), exact: true }),
    selected: palette.locator('.global-search-result[aria-selected="true"]'),
    results: palette.locator('.global-search-result'), feedback: palette.locator('.palette-action-feedback') }
}

async function readStored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { catalog, documents: await Promise.all(catalog.map(entry => window.knowbook.getDocumentDetail(entry.id))),
      templates: await window.knowbook.listDocumentTemplates(language) }
  }, language)
}

async function installSaveProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const channel = 'knowbook:update-document'
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, SaveHandler> })._invokeHandlers.get(channel)
    if (!original) throw new Error('The real document update handler is required')
    const probe: SaveProbe = { original, requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookPaletteOpenFocus = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, id: string, input: UpdateDocumentInput) => new Promise<UpdateDocumentResult>((resolve, reject) => {
      probe.requests.push({ event, id, input, settled: false, resolve, reject })
    }))
  })
}

async function saveState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookPaletteOpenFocus!
    return { requests: probe.requests.map(({ id, input, settled }) => ({ id, input, settled })), writes: probe.writes, failures: probe.failures }
  })
}

async function finishSave(app: ElectronApplication, fail: boolean) {
  await app.evaluate((_electron, fail) => {
    const probe = (globalThis as ProbeGlobal).__knowbookPaletteOpenFocus!
    const request = probe.requests.find(request => !request.settled)
    if (!request) throw new Error('One real document update must remain pending')
    request.settled = true
    setImmediate(async () => {
      if (fail) {
        const error = new Error('Palette draft save blocked')
        probe.failures.push(error.message)
        request.reject(error)
        return
      }
      try {
        const result = await probe.original(request.event, request.id, request.input)
        probe.writes.push(result)
        request.resolve(result)
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        probe.failures.push(error.message)
        request.reject(error)
      }
    })
  }, fail)
}

async function installRendererProbe(page: Page) {
  const current = controls(page)
  await current.input.evaluate(element => element.setAttribute('data-palette-open-field', 'query'))
  await current.close.evaluate(element => element.setAttribute('data-palette-open-field', 'close'))
  await current.open.evaluate(element => element.setAttribute('data-palette-open-field', 'open'))
  await page.evaluate(() => {
    const nativeFocus = HTMLElement.prototype.focus, nativeFrame = window.requestAnimationFrame.bind(window)
    const calls: FocusCall[] = [], focusIns: FocusEntry[] = []
    const focusEntered = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) focusIns.push({ field: event.target.getAttribute('data-palette-open-field'),
        tag: event.target.tagName, connected: event.target.isConnected })
    }
    document.addEventListener('focusin', focusEntered, true)
    HTMLElement.prototype.focus = function (options) {
      const call: FocusCall = { field: this.getAttribute('data-palette-open-field'), tag: this.tagName,
        connected: this.isConnected, disabled: this.matches(':disabled'), activeAfter: false, preventScroll: options?.preventScroll ?? false }
      calls.push(call)
      nativeFocus.call(this, options)
      call.activeAfter = document.activeElement === this
    }
    ;(window as ProbeWindow).__knowbookPaletteOpenFocus = {
      calls, focusIns, route: [],
      restore: () => { HTMLElement.prototype.focus = nativeFocus; document.removeEventListener('focusin', focusEntered, true) },
      twoFrames: () => new Promise(resolve => nativeFrame(() => nativeFrame(() => resolve())))
    }
  })
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const ipc = await saveState(app)
  const state = await page.evaluate(() => {
    const palette = document.querySelector<HTMLDialogElement>('.global-search-modal')
    const input = palette?.querySelector<HTMLInputElement>('.global-search-input')
    const close = palette?.querySelector<HTMLButtonElement>('[data-palette-open-field="close"]')
    const open = palette?.querySelector<HTMLButtonElement>('[data-palette-open-field="open"]')
    const selected = palette?.querySelector<HTMLElement>('.global-search-result[aria-selected="true"]')
    const probe = (window as ProbeWindow).__knowbookPaletteOpenFocus
    return { paletteOpen: palette?.open ?? false, busy: palette?.querySelector('[role="listbox"]')?.getAttribute('aria-busy') ?? null,
      query: input?.value ?? null, activeDescendant: input?.getAttribute('aria-activedescendant') ?? null,
      selectedId: selected?.id ?? null, selectedTitle: selected?.querySelector('.global-search-doc-title')?.textContent ?? null,
      header: document.querySelector('.document-header-title')?.textContent ?? null,
      draftTitle: document.querySelector<HTMLInputElement>('.document-summary-card .editor-input')?.value ?? null,
      feedback: palette?.querySelector('.palette-action-feedback')?.textContent ?? null,
      feedbackRole: palette?.querySelector('.palette-action-feedback')?.getAttribute('role') ?? null,
      active: { tag: document.activeElement?.tagName ?? null, field: document.activeElement?.getAttribute('data-palette-open-field') ?? null,
        isBody: document.activeElement === document.body, insidePalette: Boolean(palette?.contains(document.activeElement)) },
      inputFocused: Boolean(input && input === document.activeElement), closeFocused: Boolean(close && close === document.activeElement),
      closeDisabled: close?.disabled ?? null, openFocused: Boolean(open && open === document.activeElement), openDisabled: open?.disabled ?? null,
      hasFocus: document.hasFocus(), calls: probe?.calls ?? [], focusIns: probe?.focusIns ?? [], route: probe?.route ?? [] }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, ipc, state }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { ipc, state }
}

async function tabTo(page: Page, target: Locator, app: ElectronApplication, info: TestInfo, phase: string) {
  let reached = false
  for (let step = 1; step <= 8; step++) {
    await page.keyboard.press('Tab')
    reached = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement
      const reached = active === element
      ;(window as ProbeWindow).__knowbookPaletteOpenFocus!.route.push({ phase, step, reached,
        field: active?.getAttribute('data-palette-open-field') ?? null, tag: active?.tagName ?? null, label: active?.getAttribute('aria-label') ?? null })
      return reached
    }, { phase, step })
    if (reached) break
  }
  await record(page, app, info, phase)
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function expectPreserved(page: Page, selectedId: string) {
  const current = controls(page)
  await expect(current.palette).toBeVisible()
  await expect(current.input).toHaveValue(targetTitle)
  await expect(current.results).toHaveCount(1)
  await expect(current.selected).toHaveAttribute('id', selectedId)
  await expect(current.input).toHaveAttribute('aria-activedescendant', selectedId)
  await expect(current.selected.locator('.global-search-doc-title')).toHaveText(targetTitle)
  await expect(page.locator('.document-summary-card .editor-input').first()).toHaveValue(draftTitle)
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`global search failed opening respects the new Close focus in ${language} @electron`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const ids = await page.evaluate(async ({ language, sourceTitle, targetTitle }) => {
        const source = await window.knowbook.createDocument(null), target = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(source.id, { title: sourceTitle, summary: 'Keep source summary', blocks: [
          { id: `${source.id}-body`, type: 'paragraph', content: 'Keep source body intact.', checked: false, depth: 0 }
        ] })
        await window.knowbook.updateDocument(target.id, { title: targetTitle, summary: 'Keep destination summary', blocks: [
          { id: `${target.id}-body`, type: 'paragraph', content: 'Destination original body.', checked: false, depth: 0 }
        ] })
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        return { sourceId: source.id, targetId: target.id }
      }, { language, sourceTitle, targetTitle })
      await page.reload()
      await page.setViewportSize({ width: 1180, height: 850 })
      await page.getByRole('treeitem', { name: sourceTitle, exact: true }).locator('.tree-button').click()
      await expect(page.locator('.document-header-title')).toHaveText(sourceTitle)
      await ensureDocumentMetadataEditor(page)
      const before = await readStored(page, language)
      const source = before.documents.find(document => document?.id === ids.sourceId)!
      await installSaveProbe(app)
      const editorTitle = page.locator('.document-summary-card .editor-input').first()
      await editorTitle.fill(draftTitle)
      // Autosave and navigation must share this actual deferred write, rather than fabricating a navigation failure.
      await expect.poll(async () => (await saveState(app)).requests.length).toBe(1)
      await page.keyboard.press(`${mod}+k`)
      const current = controls(page)
      await current.input.fill(targetTitle)
      await expect(current.results).toHaveCount(1)
      await expect(current.selected.locator('.global-search-doc-title')).toHaveText(targetTitle)
      await expect(current.input).toBeFocused()
      const selectedId = (await current.selected.getAttribute('id'))!
      await installRendererProbe(page)
      await page.keyboard.press('Enter')
      await expect(current.feedback).toHaveText(uiText('Opening…', '正在打开…'))
      await expect(current.open).toBeDisabled()
      await expect(current.close).toBeEnabled()
      const accepted = await record(page, app, info, `${language}-accepted-open-awaits-single-real-draft-save`)
      expect(accepted.ipc.requests).toHaveLength(1)
      expect(accepted.ipc.writes).toHaveLength(0)
      expect(accepted.ipc.requests[0]).toMatchObject({ id: ids.sourceId, settled: false,
        input: { expectedUpdatedAt: source.updatedAt, title: draftTitle, summary: source.summary } })
      expect(await readStored(page, language)).toEqual(before)

      // The enabled Close receives real native Tab focus without being activated.
      await tabTo(page, current.close, app, info, `${language}-pending-native-tab-chooses-close`)
      const departed = await record(page, app, info, `${language}-close-focused-before-failed-save-reply`)
      await finishSave(app, true)
      await expect(current.feedback).toHaveAttribute('role', 'alert')
      await expect(current.feedback).toContainText(uiText(
        'Could not switch documents. Your draft and search are preserved. Resolve the save error and retry.',
        '未能切换文档，草稿和搜索已保留。请处理保存错误后重试。'))
      await expect(current.open).toBeEnabled()
      await expect(current.palette.getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
      await page.evaluate(() => (window as ProbeWindow).__knowbookPaletteOpenFocus!.twoFrames())
      // Capture the old unconditional input.focus() before asserting the new focus owner.
      const failed = await record(page, app, info, `${language}-late-failed-opening-keeps-close-focus`)
      expect(failed.state.closeFocused).toBe(true)
      expect(failed.state.calls.slice(departed.state.calls.length).filter(call => call.field === 'query')).toHaveLength(0)
      expect(failed.state.focusIns.slice(departed.state.focusIns.length).filter(entry => entry.field === 'query')).toHaveLength(0)
      await expect(current.close).toBeFocused()
      await expectPreserved(page, selectedId)
      expect(failed.ipc.requests).toHaveLength(1)
      expect(failed.ipc.failures).toEqual([saveFailure])
      expect(failed.ipc.writes).toHaveLength(0)
      expect(await readStored(page, language)).toEqual(before)

      // With no intervening activity, disabling the actual Open button may lose native focus to BODY.
      // Its failure still restores the enabled query once, keeping keyboard retry available.
      await page.keyboard.press('Shift+Tab')
      await expect(current.input).toBeFocused()
      await tabTo(page, current.open, app, info, `${language}-native-tab-to-normal-open-button`)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await saveState(app)).requests.length).toBe(2)
      await expect(current.feedback).toHaveText(uiText('Opening…', '正在打开…'))
      await expect(current.open).toBeDisabled()
      const normalPending = await record(page, app, info, `${language}-normal-open-disabled-origin-before-rejection`)
      expect(normalPending.state.active.isBody).toBe(true)
      await finishSave(app, true)
      await expect(current.feedback).toHaveAttribute('role', 'alert')
      await expect(current.open).toBeEnabled()
      await page.evaluate(() => (window as ProbeWindow).__knowbookPaletteOpenFocus!.twoFrames())
      const normal = await record(page, app, info, `${language}-normal-failed-open-focuses-query-once`)
      const returns = normal.state.calls.slice(normalPending.state.calls.length).filter(call => call.field === 'query')
      expect(returns).toHaveLength(1)
      expect(returns[0]).toMatchObject({ connected: true, disabled: false, activeAfter: true })
      expect(normal.state.focusIns.slice(normalPending.state.focusIns.length).filter(entry => entry.field === 'query')).toHaveLength(1)
      await expect(current.input).toBeFocused()
      await expectPreserved(page, selectedId)
      expect(normal.ipc.requests).toHaveLength(2)
      expect(normal.ipc.writes).toHaveLength(0)
      expect(normal.ipc.failures).toEqual([saveFailure, saveFailure])
      expect(await readStored(page, language)).toEqual(before)

      // Real Enter retries the unchanged selected B and commits A through the original main handler exactly once.
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await saveState(app)).requests.length).toBe(3)
      await expect(current.feedback).toHaveText(uiText('Opening…', '正在打开…'))
      await record(page, app, info, `${language}-keyboard-retry-awaits-original-write`)
      await finishSave(app, false)
      await expect(current.palette).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText(targetTitle)
      await page.evaluate(() => (window as ProbeWindow).__knowbookPaletteOpenFocus!.twoFrames())
      const completed = await record(page, app, info, `${language}-retry-saves-source-once-and-opens-destination`)
      expect(completed.ipc.requests).toHaveLength(3)
      expect(completed.ipc.requests.every(request => request.id === ids.sourceId && request.settled)).toBe(true)
      expect(completed.ipc.requests.map(request => request.input)).toEqual(Array(3).fill(accepted.ipc.requests[0].input))
      expect(completed.ipc.writes).toHaveLength(1)
      expect(completed.ipc.failures).toEqual([saveFailure, saveFailure])
      const after = await readStored(page, language)
      expect(after.catalog).toHaveLength(before.catalog.length)
      expect(after.templates).toEqual(before.templates)
      expect(after.documents.filter(document => document?.id !== ids.sourceId)).toEqual(before.documents.filter(document => document?.id !== ids.sourceId))
      expect(after.catalog.filter(document => document.id !== ids.sourceId)).toEqual(before.catalog.filter(document => document.id !== ids.sourceId))
      const savedSource = after.documents.find(document => document?.id === ids.sourceId)!
      expect(savedSource).toEqual(completed.ipc.writes[0].document)
      expect(savedSource).toMatchObject({ id: ids.sourceId, title: draftTitle, path: draftTitle, summary: source.summary, blocks: source.blocks })
      expect(after.documents.find(document => document?.id === ids.targetId)).toEqual(before.documents.find(document => document?.id === ids.targetId))
      await page.evaluate(() => (window as ProbeWindow).__knowbookPaletteOpenFocus!.restore())
      await page.reload()
      await expect(page.locator('[data-testid="shell"]')).toBeVisible()
      expect(await readStored(page, language)).toEqual(after)
      await record(page, app, info, `${language}-single-source-write-and-unchanged-data-survive-reload`)
      expect(errors).toEqual([])
    } finally {
      await page.evaluate(() => (window as ProbeWindow).__knowbookPaletteOpenFocus?.restore()).catch(() => undefined)
    }
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
