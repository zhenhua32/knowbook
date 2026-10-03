import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateDocumentFromTemplateInput, CreateQuickNoteInput, SaveDocumentTemplateInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type CaptureKind = 'quick' | 'save-template' | 'create-template'
type Input = CreateQuickNoteInput | SaveDocumentTemplateInput | CreateDocumentFromTemplateInput
type Handler = (event: unknown, input: Input) => unknown | Promise<unknown>
type Request = { event: unknown; input: Input; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type MainProbe = { original: Handler; requests: Request[]; saved: unknown[]; failures: string[]; deleteRequests?: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookCaptureCloseFocus?: MainProbe }
type FocusCall = { field: string | null; tag: string; connected: boolean; disabled: boolean; wasActive: boolean; activeAfter: boolean }
type FocusEntry = { field: string | null; tag: string; connected: boolean }
type Opening = { dialog: HTMLDialogElement; opener: HTMLElement | null; connectedAtOpen: boolean }
type RendererProbe = { calls: FocusCall[]; focusIns: FocusEntry[]; openings: Opening[]; dialog: HTMLDialogElement | null; restore: () => void; twoFrames: () => Promise<void> }
type ProbeWindow = Window & { __knowbookCaptureCloseFocus?: RendererProbe }
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const draft = '# Capture close ownership\n\nKept paragraph while attention is away.\n\n- [ ] Keep next action'
const noteTitle = 'Saved while attention was away'
const opener = (page: Page) => page.getByRole('button', { name: uiText('Quick capture', '快速记录'), exact: true })
const dialog = (page: Page) => page.getByRole('dialog', { name: uiText('Quick capture', '快速记录'), exact: true })
const content = (page: Page) => dialog(page).getByRole('textbox', { name: uiText('Content', '正文'), exact: true })
const title = (page: Page) => dialog(page).getByRole('textbox', { name: uiText('Document title (optional)', '文档标题（可选）'), exact: true })
const parent = (page: Page) => dialog(page).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true })

async function readStored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { catalog, documents: await Promise.all(catalog.map(entry => window.knowbook.getDocumentDetail(entry.id))),
      templates: await window.knowbook.listDocumentTemplates(language) }
  }, language)
}

async function installMainProbe(app: ElectronApplication, kind: CaptureKind = 'quick') {
  await app.evaluate(({ ipcMain }, kind) => {
    const channel = kind === 'quick' ? 'knowbook:create-quick-note' : kind === 'save-template' ? 'knowbook:save-document-template' : 'knowbook:create-document-from-template'
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)
    if (!original) throw new Error('The real document capture handler is required')
    const probe: MainProbe = { original, requests: [], saved: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookCaptureCloseFocus = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input) => new Promise((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
  }, kind)
}

async function settle(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookCaptureCloseFocus!, request = probe.requests[0]
    if (!request || request.settled) throw new Error('One real pending quick capture request is required')
    request.settled = true
    setImmediate(async () => {
      try { const result = await probe.original(request.event, request.input); probe.saved.push(result); request.resolve(result) }
      catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); probe.failures.push(error.message); request.reject(error) }
    })
  })
}

async function installRendererProbe(page: Page) {
  await page.evaluate(() => {
    const nativeFocus = HTMLElement.prototype.focus, nativeFrame = window.requestAnimationFrame.bind(window), nativeShowModal = HTMLDialogElement.prototype.showModal
    const calls: FocusCall[] = [], focusIns: FocusEntry[] = [], openings: Opening[] = []
    const focusEntered = (event: FocusEvent) => {
      const element = event.target
      if (element instanceof HTMLElement) focusIns.push({ field: element.getAttribute('data-capture-close-field'), tag: element.tagName, connected: element.isConnected })
    }
    document.addEventListener('focusin', focusEntered, true)
    HTMLDialogElement.prototype.showModal = function () {
      if (this.classList.contains('document-capture-dialog')) {
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
        openings.push({ dialog: this, opener, connectedAtOpen: Boolean(opener?.isConnected) })
        const probe = (window as ProbeWindow).__knowbookCaptureCloseFocus
        if (probe) probe.dialog = this
      }
      nativeShowModal.call(this)
    }
    HTMLElement.prototype.focus = function (options) {
      const call: FocusCall = { field: this.getAttribute('data-capture-close-field'), tag: this.tagName,
        connected: this.isConnected, disabled: this.matches(':disabled'), wasActive: document.activeElement === this, activeAfter: false }
      calls.push(call)
      nativeFocus.call(this, options)
      call.activeAfter = document.activeElement === this
    }
    ;(window as ProbeWindow).__knowbookCaptureCloseFocus = {
      calls, focusIns, openings, dialog: document.querySelector<HTMLDialogElement>('dialog.document-capture-dialog[open]'),
      restore: () => { document.removeEventListener('focusin', focusEntered, true); HTMLElement.prototype.focus = nativeFocus; HTMLDialogElement.prototype.showModal = nativeShowModal },
      twoFrames: () => new Promise(resolve => nativeFrame(() => nativeFrame(() => resolve())))
    }
  })
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookCaptureCloseFocus!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
      requests: probe.requests.map(({ input, settled }) => ({ input, settled })), saved: probe.saved, failures: probe.failures,
      ...(probe.deleteRequests ? { deleteRequests: probe.deleteRequests } : {}) }
  })
  const state = await page.evaluate(() => {
    const modal = document.querySelector<HTMLDialogElement>('dialog.document-capture-dialog[open]'), entry = document.querySelector<HTMLElement>('[data-capture-close-field="opener"]')
    const probe = (window as ProbeWindow).__knowbookCaptureCloseFocus
    return { modal: Boolean(modal?.open), busy: modal?.getAttribute('aria-busy') ?? null, hasFocus: document.hasFocus(),
      active: { tag: document.activeElement?.tagName, field: document.activeElement?.getAttribute('data-capture-close-field') ?? null, isBody: document.activeElement === document.body,
        isOldDialog: document.activeElement === probe?.dialog, insideOldDialog: probe?.dialog?.contains(document.activeElement) ?? false },
      opener: { connected: Boolean(entry?.isConnected), disabled: entry?.matches(':disabled') ?? null, focused: entry === document.activeElement,
        inert: entry?.inert ?? null, inertAttribute: entry?.getAttribute('inert') ?? null },
      controls: Array.from(modal?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select') ?? []).map(field => ({
        field: field.getAttribute('data-capture-close-field'), value: field.value, disabled: field.matches(':disabled')
      })), calls: probe?.calls ?? [], focusIns: probe?.focusIns ?? [],
      openings: probe?.openings.map(opening => ({ dialogClass: opening.dialog.className, openerTag: opening.opener?.tagName ?? null,
        openerField: opening.opener?.getAttribute('data-capture-close-field') ?? null, connectedAtOpen: opening.connectedAtOpen,
        connectedNow: Boolean(opening.opener?.isConnected), isBody: opening.opener === document.body, isDocumentElement: opening.opener === document.documentElement,
        isStableEntry: opening.opener === entry })) ?? [] }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { main, state }
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`quick capture successful close respects departed attention in ${language} @electron`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const parentId = await page.evaluate(async language => {
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title: 'Capture close parent', summary: 'Keep original parent summary', blocks: [
          { id: `${id}-body`, type: 'paragraph', content: 'Keep original parent body', checked: false, depth: 0 }
        ] })
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        return id
      }, language)
      await page.reload()
      await page.setViewportSize({ width: 1180, height: 850 })
      const before = await readStored(page, language)
      await installMainProbe(app)
      await opener(page).evaluate(element => element.setAttribute('data-capture-close-field', 'opener'))
      const originalOpener = await opener(page).elementHandle()
      expect(originalOpener).not.toBeNull()
      const originalInert = await originalOpener!.evaluate(element => ({ inert: (element as HTMLElement).inert, inertAttribute: element.getAttribute('inert') }))
      await opener(page).click()
      await expect(dialog(page)).toBeVisible()
      await content(page).fill(draft)
      await title(page).fill(noteTitle)
      await parent(page).selectOption(parentId)
      await content(page).evaluate(element => element.setAttribute('data-capture-close-field', 'content'))
      await title(page).evaluate(element => element.setAttribute('data-capture-close-field', 'title'))
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await installRendererProbe(page)

      // An independent normal cancellation still restores the real enabled entry once, without saving.
      const normalBeforeCancel = await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.calls.length)
      const normalBeforeFocusIn = await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.focusIns.length)
      await dialog(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(dialog(page)).toHaveCount(0)
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.twoFrames())
      const normal = await record(page, app, info, `${language}-normal-cancel-restores-enabled-entry-once`)
      const normalReturns = normal.state.calls.slice(normalBeforeCancel).filter(call => call.field === 'opener')
      expect(normalReturns).toHaveLength(1)
      expect(normalReturns[0]).toMatchObject({ connected: true, disabled: false, activeAfter: true })
      expect(normal.state.opener).toEqual({ connected: true, disabled: false, focused: true, ...originalInert })
      expect(normal.state.focusIns.slice(normalBeforeFocusIn).filter(entry => entry.field === 'opener')).toHaveLength(1)
      await expect(opener(page)).toBeFocused()
      expect(normal.main.requests).toHaveLength(0)
      expect(normal.main.saved).toHaveLength(0)
      expect(normal.main.failures).toHaveLength(0)
      expect(await readStored(page, language)).toEqual(before)

      await opener(page).click()
      await expect(dialog(page)).toBeVisible()
      await content(page).fill(draft)
      await title(page).fill(noteTitle)
      await parent(page).selectOption(parentId)
      await content(page).evaluate(element => element.setAttribute('data-capture-close-field', 'content'))
      await title(page).evaluate(element => element.setAttribute('data-capture-close-field', 'title'))
      await page.evaluate(() => {
        const probe = (window as ProbeWindow).__knowbookCaptureCloseFocus!
        probe.dialog = document.querySelector<HTMLDialogElement>('.document-quick-capture-dialog')
        return probe.twoFrames()
      })
      await content(page).press(`${mod}+Enter`)
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookCaptureCloseFocus!.requests.length)).toBe(1)
      await expect(dialog(page)).toHaveAttribute('aria-busy', 'true')
      await expect(content(page)).toBeDisabled()
      await expect(title(page)).toBeDisabled()
      await expect(parent(page)).toBeDisabled()
      const accepted = await record(page, app, info, `${language}-real-capture-pending-before-attention-departs`)
      expect(accepted.main.requests).toEqual([{ input: { content: draft, title: noteTitle, parentId }, settled: false }])
      expect(accepted.state.opener).toMatchObject({ connected: true, disabled: false })
      expect(await readStored(page, language)).toEqual(before)

      // Renderer attention simulation only: no OS application or native window is activated.
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      const departed = await record(page, app, info, `${language}-window-blur-before-real-success-ack`)
      await settle(app)
      await expect(dialog(page)).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText(noteTitle)
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.twoFrames())
      // Save the old cleanup focus attempt before any test action can repair the owner.
      const closed = await record(page, app, info, `${language}-successful-close-without-old-opener-focus`)
      expect(await originalOpener!.evaluate(element => element.isConnected && !element.matches(':disabled'))).toBe(true)
      expect(closed.state.opener).toMatchObject({ connected: true, disabled: false })
      expect(closed.state.calls.slice(departed.state.calls.length).filter(call => call.field === 'opener')).toHaveLength(0)
      expect(closed.state.focusIns.slice(departed.state.focusIns.length).filter(entry => entry.field === 'opener')).toHaveLength(0)
      expect(closed.state.opener).toMatchObject(originalInert)
      expect(closed.state.opener.focused).toBe(false)
      expect(closed.state.active.isOldDialog).toBe(false)
      expect(closed.main.requests).toHaveLength(1)
      expect(closed.main.saved).toHaveLength(1)
      expect(closed.main.failures).toHaveLength(0)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.twoFrames())
      const resumed = await record(page, app, info, `${language}-attention-return-does-not-replay-close-focus`)
      expect(resumed.state.calls.slice(departed.state.calls.length).filter(call => call.field === 'opener')).toHaveLength(0)
      expect(resumed.state.focusIns.slice(departed.state.focusIns.length).filter(entry => entry.field === 'opener')).toHaveLength(0)
      expect(resumed.state.opener).toMatchObject(originalInert)
      expect(resumed.state.opener.focused).toBe(false)

      const after = await readStored(page, language)
      const added = after.catalog.filter(entry => !before.catalog.some(original => original.id === entry.id))
      expect(added).toHaveLength(1)
      expect(added[0]).toMatchObject({ title: noteTitle, parentId, path: `Capture close parent/${noteTitle}` })
      expect(closed.main.saved).toEqual([{ id: added[0].id }])
      const note = after.documents.find(document => document?.id === added[0].id)!
      expect(note.blocks.map(({ type, content, checked, depth }) => ({ type, content, checked, depth }))).toEqual([
        { type: 'heading-1', content: 'Capture close ownership', checked: false, depth: 0 },
        { type: 'paragraph', content: 'Kept paragraph while attention is away.', checked: false, depth: 0 },
        { type: 'todo', content: 'Keep next action', checked: false, depth: 0 }
      ])
      expect(after.templates).toEqual(before.templates)
      expect(after.catalog.filter(entry => before.catalog.some(original => original.id === entry.id))).toEqual(
        before.catalog.map(entry => entry.id === parentId ? { ...entry, childCount: entry.childCount + 1 } : entry))
      expect(before.documents.map(original => after.documents.find(document => document?.id === original!.id))).toEqual(
        before.documents.map(original => original?.id === parentId ? { ...original, children: [...original.children,
          { id: added[0].id, title: noteTitle, path: added[0].path }] } : original))
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.restore())
      await page.reload()
      await expect(page.locator('.document-header-title')).toHaveText(noteTitle)
      expect(await readStored(page, language)).toEqual(after)
      await record(page, app, info, `${language}-single-real-note-and-original-data-survive-reload`)
      expect(errors).toEqual([])
    } finally {
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus?.restore()).catch(() => undefined)
    }
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}

type PassiveKind = Exclude<CaptureKind, 'quick'>
const passiveDialog = (page: Page, kind: PassiveKind) => page.getByRole('dialog', { name: kind === 'save-template'
  ? uiText('Save as template', '保存为模板') : uiText('From template', '从模板新建'), exact: true })
const passiveEntry = (page: Page, kind: PassiveKind) => page.getByRole('button', { name: kind === 'save-template'
  ? uiText('More actions', '更多操作') : uiText('New from template', '从模板新建'), exact: true })

async function openPassive(page: Page, kind: PassiveKind, parentId: string) {
  await passiveEntry(page, kind).click()
  if (kind === 'save-template') await page.locator('.document-header-action-menu').getByRole('button', {
    name: uiText('Save as template', '保存为模板'), exact: true
  }).click()
  const modal = passiveDialog(page, kind)
  await expect(modal).toBeVisible()
  if (kind === 'save-template') {
    await modal.getByRole('textbox', { name: uiText('Template name', '模板名称'), exact: true }).fill('Passive close template draft')
    await modal.getByRole('textbox', { name: uiText('Template description (optional)', '模板说明（可选）'), exact: true }).fill('Kept passive description')
  } else {
    await modal.getByRole('button', { name: uiText('Custom', '自定义模板'), exact: true }).click()
    await modal.locator('.document-template-item').filter({ has: page.getByText('Passive Alpha', { exact: true }) }).click()
    await modal.getByRole('textbox', { name: uiText('Document title', '文档标题'), exact: true }).fill('Manual passive create draft')
    await modal.getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true }).selectOption(parentId)
    await modal.getByRole('searchbox', { name: uiText('Search templates', '搜索模板'), exact: true }).fill('Passive')
    await expect(modal.locator('.document-template-preview')).toContainText('Passive template body')
  }
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

for (const language of ['en-US', 'zh-CN'] as const) for (const kind of ['save-template', 'create-template'] as const) {
test(`${kind} passive close respects departed attention in ${language} @electron`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const parentId = await page.evaluate(async language => {
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title: 'Passive close source', summary: 'Preserve passive source summary', blocks: [
          { id: `${id}-body`, type: 'paragraph', content: 'Preserve passive source body', checked: false, depth: 0 }
        ] })
        await window.knowbook.saveDocumentTemplate({ name: 'Passive Alpha', description: 'Passive recipe', title: 'Automatic passive title', summary: 'Preserve passive template summary', blocks: [
          { id: 'passive-alpha-body', type: 'paragraph', content: 'Passive template body {{title}}', checked: false, depth: 0 }
        ] })
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        return id
      }, language)
      await page.reload()
      await page.setViewportSize({ width: 1180, height: 850 })
      await page.getByRole('treeitem', { name: 'Passive close source', exact: true }).locator('.tree-button').click()
      await expect(page.locator('.document-header-title')).toHaveText('Passive close source')
      const before = await readStored(page, language)
      await installMainProbe(app, kind)
      await passiveEntry(page, kind).evaluate(element => element.setAttribute('data-capture-close-field', 'opener'))
      const originalOpener = await passiveEntry(page, kind).elementHandle()
      expect(originalOpener).not.toBeNull()
      const originalInert = await originalOpener!.evaluate(element => ({ inert: (element as HTMLElement).inert, inertAttribute: element.getAttribute('inert') }))
      await installRendererProbe(page)
      await openPassive(page, kind, parentId)
      const openingOwner = await page.evaluate(() => {
        const opening = (window as ProbeWindow).__knowbookCaptureCloseFocus!.openings.at(-1)
        if (!opening) throw new Error('The actual native capture opening must be observed')
        return { stable: opening.opener === document.querySelector('[data-capture-close-field="opener"]'),
          connected: Boolean(opening.opener?.isConnected), body: opening.opener === document.body, documentElement: opening.opener === document.documentElement }
      })
      if (kind === 'create-template') expect(openingOwner.stable).toBe(true)
      else expect(openingOwner.stable || openingOwner.body || openingOwner.documentElement || !openingOwner.connected).toBe(true)
      if (kind === 'create-template') {
        await app.evaluate(({ ipcMain }) => {
          const channel = 'knowbook:delete-document-template'
          const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, id: string) => unknown | Promise<unknown>> })._invokeHandlers.get(channel)
          if (!original) throw new Error('The real template deletion handler is required')
          const probe = (globalThis as ProbeGlobal).__knowbookCaptureCloseFocus!
          probe.deleteRequests = []
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, (event, id: string) => {
            probe.deleteRequests!.push(id)
            return original(event, id)
          })
        })
        await passiveDialog(page, kind).locator('.document-template-delete').click()
        const child = page.locator('.app-confirm-dialog')
        await expect(child).toBeVisible()
        const childCancel = child.getByRole('button', { name: uiText('Cancel', '取消'), exact: true })
        await expect(childCancel).toBeFocused()
        await childCancel.click()
        await expect(child).toHaveCount(0)
        await expect(passiveDialog(page, kind)).toHaveAttribute('aria-busy', 'false')
        await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.twoFrames())
        const nested = await record(page, app, info, `${language}-${kind}-nested-cancel-preserves-parent-close-owner`)
        await expect(passiveDialog(page, kind).getByRole('searchbox', { name: uiText('Search templates', '搜索模板'), exact: true })).toBeFocused()
        await expect(passiveDialog(page, kind).getByRole('textbox', { name: uiText('Document title', '文档标题'), exact: true })).toHaveValue('Manual passive create draft')
        await expect(passiveDialog(page, kind).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true })).toHaveValue(parentId)
        await expect(passiveDialog(page, kind).getByRole('searchbox', { name: uiText('Search templates', '搜索模板'), exact: true })).toHaveValue('Passive')
        expect(nested.main.deleteRequests).toEqual([])
        expect(nested.main.requests).toHaveLength(0)
        expect(await readStored(page, language)).toEqual(before)
      }
      const normalBefore = await page.evaluate(() => ({ calls: (window as ProbeWindow).__knowbookCaptureCloseFocus!.calls.length,
        focusIns: (window as ProbeWindow).__knowbookCaptureCloseFocus!.focusIns.length }))
      await passiveDialog(page, kind).getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(passiveDialog(page, kind)).toHaveCount(0)
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.twoFrames())
      const normal = await record(page, app, info, `${language}-${kind}-normal-cancel-returns-to-exact-entry`)
      const normalReturnCount = openingOwner.stable ? 1 : 0
      expect(normal.state.calls.slice(normalBefore.calls).filter(call => call.field === 'opener')).toHaveLength(normalReturnCount)
      expect(normal.state.focusIns.slice(normalBefore.focusIns).filter(entry => entry.field === 'opener')).toHaveLength(normalReturnCount)
      expect(normal.state.opener).toEqual({ connected: true, disabled: false, focused: openingOwner.stable, ...originalInert })
      if (openingOwner.stable) await expect(passiveEntry(page, kind)).toBeFocused()
      else await expect(passiveEntry(page, kind)).not.toBeFocused()
      expect(normal.main.requests).toHaveLength(0)
      expect(await readStored(page, language)).toEqual(before)

      await openPassive(page, kind, parentId)
      await page.evaluate(() => { (window as ProbeWindow).__knowbookCaptureCloseFocus!.dialog = document.querySelector<HTMLDialogElement>('dialog.document-capture-dialog[open]') })
      const opened = await record(page, app, info, `${language}-${kind}-unchanged-passive-draft-before-blur`)
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      const departed = await record(page, app, info, `${language}-${kind}-passive-window-blur-before-cancel`)
      expect(departed.state.controls).toEqual(opened.state.controls)
      // This remains a real renderer pointer action; window.blur above is not an OS application switch.
      await passiveDialog(page, kind).getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(passiveDialog(page, kind)).toHaveCount(0)
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.twoFrames())
      const closed = await record(page, app, info, `${language}-${kind}-departed-cancel-has-no-native-or-program-return`)
      expect(closed.state.calls.slice(departed.state.calls.length).filter(call => call.field === 'opener')).toHaveLength(0)
      expect(closed.state.focusIns.slice(departed.state.focusIns.length).filter(entry => entry.field === 'opener')).toHaveLength(0)
      expect(closed.state.opener).toEqual({ connected: true, disabled: false, focused: false, ...originalInert })
      expect(await originalOpener!.evaluate(element => element.isConnected && !element.matches(':disabled'))).toBe(true)
      expect(closed.state.active.isOldDialog).toBe(false)
      expect(closed.main.requests).toHaveLength(0)
      expect(closed.main.saved).toHaveLength(0)
      expect(closed.main.failures).toHaveLength(0)
      expect(await readStored(page, language)).toEqual(before)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.twoFrames())
      const resumed = await record(page, app, info, `${language}-${kind}-passive-attention-return-does-not-replay`)
      expect(resumed.state.calls.slice(departed.state.calls.length).filter(call => call.field === 'opener')).toHaveLength(0)
      expect(resumed.state.focusIns.slice(departed.state.focusIns.length).filter(entry => entry.field === 'opener')).toHaveLength(0)
      expect(resumed.state.opener).toEqual({ connected: true, disabled: false, focused: false, ...originalInert })
      expect(await readStored(page, language)).toEqual(before)
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus!.restore())
      await page.reload()
      await expect(page.locator('.document-header-title')).toHaveText('Passive close source')
      expect(await readStored(page, language)).toEqual(before)
      await record(page, app, info, `${language}-${kind}-passive-cancel-preserves-all-data-after-reload`)
      expect(errors).toEqual([])
    } finally {
      await page.evaluate(() => (window as ProbeWindow).__knowbookCaptureCloseFocus?.restore()).catch(() => undefined)
    }
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
