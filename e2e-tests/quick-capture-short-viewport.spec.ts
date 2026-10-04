import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateQuickNoteInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { event: unknown; input: CreateQuickNoteInput; settled: boolean; resolve: (result: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; requests: Request[]; saved: unknown[]; failures: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookShortCaptureProbe?: Probe }
type ProbeWindow = Window & { __knowbookShortCaptureRoute?: Array<{ phase: string; tag: string | null; reached: boolean }> }
const capture = (page: Page) => page.getByRole('dialog', { name: uiText('Quick capture', '快速记录'), exact: true })
const content = (page: Page) => capture(page).getByRole('textbox', { name: uiText('Content', '正文'), exact: true })
const title = (page: Page) => capture(page).getByRole('textbox', { name: uiText('Document title (optional)', '文档标题（可选）'), exact: true })
const save = (page: Page) => capture(page).getByRole('button', { name: uiText('Save note', '保存记录'), exact: true })
const cancel = (page: Page) => capture(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true })
const parent = (page: Page) => capture(page).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true })
async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('knowbook:create-quick-note')
    if (!original) throw new Error('The real quick-note handler is required')
    const probe: Probe = { original, requests: [], saved: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookShortCaptureProbe = probe
    ipcMain.removeHandler('knowbook:create-quick-note')
    ipcMain.handle('knowbook:create-quick-note', (event, input) => new Promise((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
  })
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookShortCaptureProbe!, request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real pending quick-note request is required')
    request.settled = true
    setImmediate(async () => {
      try { const result = await probe.original(request.event, request.input); probe.saved.push(result); request.resolve(result) }
      catch (reason) { const error = reason instanceof Error ? reason : new Error(String(reason)); probe.failures.push(error.message); request.reject(error) }
    })
  }, index)
}

async function tabTo(page: Page, target: Locator, phase: string, direction: 'Tab' | 'Shift+Tab' = 'Tab') {
  let reached = false
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press(direction)
    const stop = await target.evaluate((element, phase) => {
      const value = { phase, tag: document.activeElement?.tagName ?? null, reached: document.activeElement === element }
      ;((window as ProbeWindow).__knowbookShortCaptureRoute ??= []).push(value)
      return value
    }, phase)
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookShortCaptureProbe!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds() })),
      calls: probe.requests.map(({ input, settled }) => ({ input, settled })), saved: probe.saved, failures: probe.failures }
  })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const box = (element: Element) => {
      const bounds = rect(element), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), r = rect(parent)
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { clip.left = Math.max(clip.left, r.left + parent.clientLeft); clip.right = Math.min(clip.right, r.left + parent.clientLeft + parent.clientWidth) }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { clip.top = Math.max(clip.top, r.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, r.top + parent.clientTop + parent.clientHeight) }
        if (style.position === 'fixed') break
      }
      const width = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left))
      const height = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return { rect: bounds, clip, visibleRatio: bounds.width && bounds.height ? width * height / (bounds.width * bounds.height) : 0,
        centerHit: hit === element || Boolean(hit && element.contains(hit)), hit: hit ? { tag: hit.tagName, className: hit.getAttribute('class') } : null }
    }
    const modal = document.querySelector<HTMLDialogElement>('.document-quick-capture-dialog')
    const body = modal?.querySelector<HTMLElement>('.document-capture-body'), active = document.activeElement
    const fieldset = body?.querySelector('fieldset')
    const verticalBox = (element: Element) => {
      const style = getComputedStyle(element)
      return ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
        .reduce((height, property) => height + (Number.parseFloat(style[property as keyof CSSStyleDeclaration] as string) || 0), 0)
    }
    const verticalMargin = (element: Element) => {
      const style = getComputedStyle(element)
      return (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0)
    }
    // Measure the fields' natural content independently of the flex body's
    // allocated height, so a stretched form cannot become its own oracle.
    const intrinsicBodyHeight = body && fieldset ? rect(fieldset).height + verticalMargin(fieldset) + verticalBox(body) : null
    const intrinsicModalHeight = modal && intrinsicBodyHeight !== null ? verticalBox(modal)
      + Array.from(modal.children).reduce((height, child) => height
        + (child === body ? intrinsicBodyHeight : rect(child).height) + verticalMargin(child), 0) : null
    const alert = modal?.querySelector<HTMLElement>('[role="alert"]')
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName, isBody: active === document.body },
      modal: modal ? { ...box(modal), intrinsicHeight: intrinsicModalHeight, scrollTop: modal.scrollTop, clientHeight: modal.clientHeight, scrollHeight: modal.scrollHeight, ariaBusy: modal.getAttribute('aria-busy') } : null,
      body: body ? { ...box(body), intrinsicHeight: intrinsicBodyHeight, scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight } : null,
      heading: modal?.querySelector('h2') ? box(modal.querySelector('h2')!) : null,
      header: modal?.querySelector('header') ? box(modal.querySelector('header')!) : null,
      footer: modal?.querySelector('footer') ? box(modal.querySelector('footer')!) : null,
      localError: alert ? { ...box(alert), text: alert.textContent } : null,
      parent: modal?.querySelector('select') ? { value: (modal.querySelector('select') as HTMLSelectElement).value, ...box(modal.querySelector('select')!) } : null,
      fieldsetDisabled: modal?.querySelector('fieldset')?.disabled ?? null,
      inputs: Array.from(modal?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea') ?? []).map(input => ({
        value: input.value, focused: active === input, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, ...box(input) })),
      buttons: Array.from(modal?.querySelectorAll<HTMLButtonElement>('header > button,footer > button') ?? []).map(button => ({
        text: button.textContent, focused: active === button, disabled: button.disabled, ...box(button) })),
      notifications: document.querySelectorAll('.app-notifications').length,
      route: (window as ProbeWindow).__knowbookShortCaptureRoute ?? [] }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  expect(state.notifications).toBe(0)
  return { main, state }
}

async function expectActionsReachable(page: Page, state: Awaited<ReturnType<typeof record>>['state']) {
  expect(state.buttons).toHaveLength(2)
  for (const button of state.buttons) { expect(button.visibleRatio).toBe(1); expect(button.centerHit).toBe(true) }
  expect(state.heading).not.toBeNull()
  expect(state.heading!.visibleRatio).toBe(1)
  expect(state.heading!.centerHit).toBe(true)
  await expect(save(page)).toBeInViewport({ ratio: 1 })
  await expect(cancel(page)).toBeInViewport({ ratio: 1 })
}

async function expectFocusedFieldReachable(target: Locator, state: Awaited<ReturnType<typeof record>>['state']) {
  const focused = state.inputs.filter(input => input.focused)
  expect(focused).toHaveLength(1)
  expect(focused[0].visibleRatio).toBe(1)
  expect(focused[0].centerHit).toBe(true)
  await expect(target).toBeFocused()
  await expect(target).toBeInViewport({ ratio: 1 })
}

function expectNaturalLayout(state: Awaited<ReturnType<typeof record>>['state']) {
  expect(state.modal?.intrinsicHeight).not.toBeNull()
  expect(state.body?.intrinsicHeight).not.toBeNull()
  expect(Math.abs(state.modal!.rect.height - state.modal!.intrinsicHeight!)).toBeLessThanOrEqual(1)
  expect(Math.abs(state.body!.rect.height - state.body!.intrinsicHeight!)).toBeLessThanOrEqual(1)
  expect(state.modal!.scrollHeight).toBeLessThanOrEqual(state.modal!.clientHeight + 1)
  expect(state.body!.scrollHeight).toBeLessThanOrEqual(state.body!.clientHeight + 1)
  for (const field of [...state.inputs, state.parent!]) {
    expect(field.visibleRatio).toBe(1)
    expect(field.centerHit).toBe(true)
  }
}

async function resizeFocusedField(page: Page, app: ElectronApplication, testInfo: TestInfo, target: Locator, phase: string, requireError = false) {
  const node = await target.elementHandle()
  expect(node).not.toBeNull()
  const selection = await target.evaluate(element => {
    const input = element as HTMLInputElement | HTMLTextAreaElement
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd }
  })
  for (const [size, viewport] of [['short', { width: 760, height: 440 }], ['narrow-tall', { width: 760, height: 850 }],
    ['wide-tall', { width: 1180, height: 850 }], ['short-return', { width: 760, height: 440 }]] as const) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const snapshot = await record(page, app, testInfo, `${phase}-${size}`)
    expect(await node!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true)
    expect(await target.evaluate(element => {
      const input = element as HTMLInputElement | HTMLTextAreaElement
      return { value: input.value, start: input.selectionStart, end: input.selectionEnd }
    })).toEqual(selection)
    await expectFocusedFieldReachable(target, snapshot.state)
    await expectActionsReachable(page, snapshot.state)
    if (requireError) {
      expect(snapshot.state.localError).not.toBeNull()
      expect(snapshot.state.localError!.visibleRatio).toBe(1)
      expect(snapshot.state.localError!.centerHit).toBe(true)
    }
  }
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`quick capture keeps short viewport controls reachable in ${language} @electron`, async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const parentId = await page.evaluate(async language => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Capture parent', summary: 'Unchanged parent summary', blocks: [
        { id: `${id}-body`, type: 'paragraph', content: 'Unchanged parent content', checked: false, depth: 0 }
      ] })
      await window.knowbook.saveSetting('ui.language', language)
      await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
      return id
    }, language)
    await page.reload()
    await page.setViewportSize({ width: 1180, height: 850 })
    await expect(page.getByRole('button', { name: uiText('Quick capture', '快速记录'), exact: true })).toBeEnabled()
    const before = await page.evaluate(async () => {
      const catalog = await window.knowbook.getDocumentCatalog()
      return { catalog, details: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))) }
    })
    await installProbe(app)
    await page.keyboard.press('Control+Shift+n')
    await expect(content(page)).toBeFocused()
    const natural = await record(page, app, testInfo, `${language}-wide-natural-quick-capture`)
    expect(natural.main.calls).toEqual([])
    expect(natural.state.notifications).toBe(0)
    expectNaturalLayout(natural.state)
    await expectActionsReachable(page, natural.state)
    await page.setViewportSize({ width: 760, height: 850 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const naturalNarrow = await record(page, app, testInfo, `${language}-narrow-tall-natural-quick-capture`)
    expectNaturalLayout(naturalNarrow.state)
    await expectFocusedFieldReachable(content(page), naturalNarrow.state)
    await expectActionsReachable(page, naturalNarrow.state)
    await page.keyboard.press('Escape')
    await expect(capture(page)).toHaveCount(0)
    await page.setViewportSize({ width: 760, height: 440 })
    await page.keyboard.press('Control+Shift+n')
    await expect(content(page)).toBeFocused()
    const draft = '# Captured idea\n\nKeep this complete Markdown paragraph.\n\n- [ ] Next action'
    await page.keyboard.type(draft)
    await page.keyboard.press('Tab')
    await expect(title(page)).toBeFocused()
    await page.keyboard.type('Invalid/title')
    await page.keyboard.press('Tab')
    await expect(parent(page)).toBeFocused()
    await parent(page).selectOption(parentId)
    const short = await record(page, app, testInfo, `${language}-short-quick-capture-keyboard-draft`)
    expect(short.main.calls).toEqual([])
    expect(short.state.notifications).toBe(0)
    await expect(content(page)).toHaveValue(draft)
    await expect(title(page)).toHaveValue('Invalid/title')
    await expect(parent(page)).toHaveValue(parentId)
    expect(await page.evaluate(() => window.knowbook.getDocumentCatalog())).toEqual(before.catalog)
    // Record the old layout before demanding full control visibility. No
    // button scrolling, focus repair, force click or notification is used.
    await expectActionsReachable(page, short.state)
    await page.keyboard.press('Control+Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookShortCaptureProbe!.requests.length)).toBe(1)
    await expect(capture(page).locator('fieldset')).toHaveAttribute('disabled', '')
    await expect(save(page)).toBeDisabled()
    await expect(cancel(page)).toBeDisabled()
    await expect(capture(page)).toHaveAttribute('aria-busy', 'true')
    // No newer input: this layout case also verifies normal failure autofocus.
    // Repeated busy-state input is covered by the focus ownership scenarios.
    const pending = await record(page, app, testInfo, `${language}-short-capture-pending-single-flight`)
    expect(pending.main.calls).toHaveLength(1)
    expect(pending.main.calls[0].input).toEqual({ content: draft, title: 'Invalid/title', parentId })
    await expectActionsReachable(page, pending.state)
    await settle(app, 0)
    await expect(capture(page).getByRole('alert')).toContainText(/path separators|路径/)
    await expect(content(page)).toBeFocused()
    const failed = await record(page, app, testInfo, `${language}-real-title-validation-failed-retained-draft`)
    expect(failed.main.calls).toHaveLength(1)
    expect(failed.main.saved).toEqual([])
    expect(failed.main.failures).toHaveLength(1)
    expect(failed.state.localError).not.toBeNull()
    expect(failed.state.localError!.visibleRatio).toBe(1)
    expect(failed.state.localError!.centerHit).toBe(true)
    await expectActionsReachable(page, failed.state)
    await expectFocusedFieldReachable(content(page), failed.state)
    await expect(content(page)).toHaveValue(draft)
    await expect(title(page)).toHaveValue('Invalid/title')
    await expect(parent(page)).toHaveValue(parentId)
    expect(await page.evaluate(() => window.knowbook.getDocumentCatalog())).toEqual(before.catalog)
    await page.keyboard.press('ControlOrMeta+Home')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await resizeFocusedField(page, app, testInfo, content(page), `${language}-selected-content-media`, true)
    await tabTo(page, title(page), 'content-to-corrected-title')
    const correctedTitle = 'Short viewport captured note'
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(correctedTitle)
    await expect(capture(page).getByRole('alert')).toHaveCount(0)
    await page.keyboard.press('Home')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await resizeFocusedField(page, app, testInfo, title(page), `${language}-selected-title-media`)
    const pointerReady = await record(page, app, testInfo, `${language}-short-capture-pointer-retry-ready`)
    await expectActionsReachable(page, pointerReady.state)
    await expectFocusedFieldReachable(title(page), pointerReady.state)
    await save(page).click()
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookShortCaptureProbe!.requests.length)).toBe(2)
    await settle(app, 1)
    await expect(capture(page)).toHaveCount(0)
    await expect(page.locator('.document-header-title')).toHaveText(correctedTitle)
    const persisted = await page.evaluate(async ({ originalIds, correctedTitle }) => {
      const catalog = await window.knowbook.getDocumentCatalog()
      const added = catalog.filter(document => !originalIds.includes(document.id))
      if (added.length !== 1 || added[0].title !== correctedTitle) throw new Error('Exactly one captured document is required')
      return { catalog, added: added[0], detail: await window.knowbook.getDocumentDetail(added[0].id),
        originals: await Promise.all(originalIds.map(id => window.knowbook.getDocumentDetail(id))) }
    }, { originalIds: before.catalog.map(document => document.id), correctedTitle })
    expect(persisted.added.parentId).toBe(parentId)
    expect(persisted.added.path).toBe(`Capture parent/${correctedTitle}`)
    expect(persisted.catalog.filter(document => before.catalog.some(original => original.id === document.id))).toEqual(
      before.catalog.map(document => document.id === parentId ? { ...document, childCount: document.childCount + 1 } : document))
    expect(persisted.originals).toEqual(before.details.map(document => document?.id === parentId ? {
      ...document, children: [...document.children, { id: persisted.added.id, title: correctedTitle, path: persisted.added.path }]
    } : document))
    expect(persisted.detail!.blocks.map(({ type, content, checked, depth }) => ({ type, content, checked, depth }))).toEqual([
      { type: 'heading-1', content: 'Captured idea', checked: false, depth: 0 },
      { type: 'paragraph', content: 'Keep this complete Markdown paragraph.', checked: false, depth: 0 },
      { type: 'todo', content: 'Next action', checked: false, depth: 0 }
    ])
    const saved = await record(page, app, testInfo, `${language}-one-real-created-note`)
    expect(saved.main.calls).toHaveLength(2)
    expect(saved.main.saved).toHaveLength(1)
    expect(saved.main.saved[0]).toMatchObject({ id: persisted.added.id })
    await page.reload()
    await expect(page.getByRole('button', { name: uiText('Quick capture', '快速记录'), exact: true })).toBeEnabled()
    expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.added.id)).toEqual(persisted.detail)
    await page.keyboard.press('Control+Shift+n')
    await expect(content(page)).toBeFocused()
    await page.keyboard.type('Cancel this keyboard draft without another write.')
    await page.keyboard.press('Tab')
    await expect(title(page)).toBeFocused()
    await page.keyboard.type('Canceled draft')
    const cancelReady = await record(page, app, testInfo, `${language}-new-draft-before-pointer-cancel`)
    await expectActionsReachable(page, cancelReady.state)
    await cancel(page).click()
    await expect(capture(page)).toHaveCount(0)
    const canceled = await record(page, app, testInfo, `${language}-canceled-draft-no-extra-write`)
    expect(canceled.main.calls).toHaveLength(2)
    expect(canceled.main.saved).toHaveLength(1)
    expect(await page.evaluate(() => window.knowbook.getDocumentCatalog())).toEqual(persisted.catalog)
    expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.added.id)).toEqual(persisted.detail)
    expect(errors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
