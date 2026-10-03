import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateQuickNoteInput, SaveDocumentTemplateInput } from '../src/shared/contracts'
import { closeElectronApp, hasBuiltElectronApp, launchElectronApp, uiText, withElectronApp } from './helpers/electron'

type Kind = 'quick' | 'template'
type Input = CreateQuickNoteInput | SaveDocumentTemplateInput
type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { event: unknown; input: Input; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; requests: Request[]; saved: unknown[]; failures: string[] }
type MainGlobal = typeof globalThis & { __knowbookDocumentSaveOwnership?: Probe }
type FocusCall = { field: string | null; tag: string; connected: boolean; disabled: boolean; wasActive: boolean; activeAfter: boolean }
type RendererProbe = {
  calls: FocusCall[]; startCapture: () => void; endCapture: () => number; release: () => void; restore: () => void
  pending: () => number; twoFrames: () => Promise<void>
}
type ProbeWindow = Window & { __knowbookDocumentSaveOwnership?: RendererProbe }
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const captureDraft = '# Ownership capture\n\nKept Markdown paragraph.\n\n- [ ] Next action'
const descriptionDraft = 'Description kept while retry waits.'
const invalidTitle = 'Invalid/ownership/title'
const invalidName = 'N'.repeat(201)
const dialog = (page: Page, kind: Kind) => page.getByRole('dialog', { name: kind === 'quick'
  ? uiText('Quick capture', '快速记录') : uiText('Save as template', '保存为模板'), exact: true })
const fallback = (page: Page, kind: Kind) => kind === 'quick'
  ? dialog(page, kind).getByRole('textbox', { name: uiText('Content', '正文'), exact: true })
  : dialog(page, kind).getByRole('textbox', { name: uiText('Template name', '模板名称'), exact: true })
const newOwner = (page: Page, kind: Kind) => kind === 'quick'
  ? dialog(page, kind).getByRole('textbox', { name: uiText('Document title (optional)', '文档标题（可选）'), exact: true })
  : dialog(page, kind).getByRole('textbox', { name: uiText('Template description (optional)', '模板说明（可选）'), exact: true })
const save = (page: Page, kind: Kind) => dialog(page, kind).getByRole('button', {
  name: kind === 'quick' ? uiText('Save note', '保存记录') : uiText('Save template', '保存模板'), exact: true
})

async function readStored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { catalog, documents: await Promise.all(catalog.map(entry => window.knowbook.getDocumentDetail(entry.id))),
      templates: await window.knowbook.listDocumentTemplates(language) }
  }, language)
}

async function installMainProbe(app: ElectronApplication, kind: Kind) {
  await app.evaluate(({ ipcMain }, kind) => {
    const channel = kind === 'quick' ? 'knowbook:create-quick-note' : 'knowbook:save-document-template'
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get(channel)
    if (!original) throw new Error('The real document saving handler is required')
    const probe: Probe = { original, requests: [], saved: [], failures: [] }
    ;(globalThis as MainGlobal).__knowbookDocumentSaveOwnership = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input) => new Promise((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
  }, kind)
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as MainGlobal).__knowbookDocumentSaveOwnership!, request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real pending document saving request is required')
    request.settled = true
    setImmediate(async () => {
      try { const result = await probe.original(request.event, request.input); probe.saved.push(result); request.resolve(result) }
      catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); probe.failures.push(error.message); request.reject(error) }
    })
  }, index)
}

async function count(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as MainGlobal).__knowbookDocumentSaveOwnership!.requests.length)
}

async function installRendererProbe(page: Page) {
  await page.evaluate(() => {
    const nativeFrame = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window)
    const originalFrame = window.requestAnimationFrame, originalCancel = window.cancelAnimationFrame
    const originalFocus = HTMLElement.prototype.focus
    const calls: FocusCall[] = []
    let capturing = false
    type Entry = { callback: FrameRequestCallback; nativeId: number; blocked: boolean }
    const frames = new Map<number, Entry>()
    const run = (id: number, entry: Entry, timestamp: number) => {
      if (frames.get(id) !== entry || entry.blocked) return
      frames.delete(id)
      entry.callback(timestamp)
    }
    window.requestAnimationFrame = callback => {
      const entry: Entry = { callback, nativeId: 0, blocked: capturing }
      const id = nativeFrame(timestamp => run(id, entry, timestamp))
      entry.nativeId = id
      frames.set(id, entry)
      return id
    }
    window.cancelAnimationFrame = id => {
      const entry = frames.get(id)
      nativeCancel(entry?.nativeId ?? id)
      frames.delete(id)
    }
    HTMLElement.prototype.focus = function (options) {
      const record: FocusCall = { field: this.getAttribute('data-ownership-field'), tag: this.tagName,
        connected: this.isConnected, disabled: this.matches(':disabled'), wasActive: document.activeElement === this, activeAfter: false }
      calls.push(record)
      originalFocus.call(this, options)
      record.activeAfter = document.activeElement === this
    }
    const release = () => {
      capturing = false
      for (const [id, entry] of frames) if (entry.blocked) {
        nativeCancel(entry.nativeId)
        entry.blocked = false
        entry.nativeId = nativeFrame(timestamp => run(id, entry, timestamp))
      }
    }
    ;(window as ProbeWindow).__knowbookDocumentSaveOwnership = {
      calls, startCapture: () => { capturing = true },
      // New Playwright/user actions use native frames while the already captured application callbacks remain held.
      endCapture: () => { capturing = false; return [...frames.values()].filter(entry => entry.blocked).length }, release,
      pending: () => [...frames.values()].filter(entry => entry.blocked).length,
      twoFrames: () => new Promise(resolve => nativeFrame(() => nativeFrame(() => resolve()))),
      restore: () => {
        capturing = false
        for (const [id, entry] of frames) if (entry.blocked) { nativeCancel(entry.nativeId); frames.delete(id) }
        window.requestAnimationFrame = originalFrame
        window.cancelAnimationFrame = originalCancel
        HTMLElement.prototype.focus = originalFocus
      }
    }
  })
}

async function naturalFrames(page: Page) {
  await page.evaluate(() => (window as ProbeWindow).__knowbookDocumentSaveOwnership!.twoFrames())
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, kind: Kind, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as MainGlobal).__knowbookDocumentSaveOwnership
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
      requests: probe?.requests.map(({ input, settled }) => ({ input, settled })) ?? [], saved: probe?.saved ?? [], failures: probe?.failures ?? [] }
  })
  const state = await page.evaluate(kind => {
    const modal = document.querySelector<HTMLDialogElement>(kind === 'quick' ? '.document-quick-capture-dialog' : '.document-save-template-dialog')
    const probe = (window as ProbeWindow).__knowbookDocumentSaveOwnership
    return { modal: Boolean(modal), busy: modal?.getAttribute('aria-busy') ?? null, error: modal?.querySelector('[role="alert"]')?.textContent ?? null,
      active: { tag: document.activeElement?.tagName, field: document.activeElement?.getAttribute('data-ownership-field') ?? null, isBody: document.activeElement === document.body },
      controls: Array.from(modal?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select') ?? []).map(field => ({
        tag: field.tagName, field: field.getAttribute('data-ownership-field'), value: field.value, disabled: field.matches(':disabled'), focused: document.activeElement === field,
        start: field instanceof HTMLSelectElement ? null : field.selectionStart, end: field instanceof HTMLSelectElement ? null : field.selectionEnd
      })), calls: probe?.calls ?? [], heldFrames: probe?.pending() ?? 0 }
  }, kind)
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { main, state }
}

async function startSave(page: Page, kind: Kind) {
  await fallback(page, kind).press(kind === 'quick' ? `${mod}+Enter` : 'Enter')
}

async function expectBusy(page: Page, kind: Kind) {
  await expect(dialog(page, kind)).toHaveAttribute('aria-busy', 'true')
  await expect(save(page, kind)).toBeDisabled()
  await expect(fallback(page, kind)).toBeDisabled()
  await expect(newOwner(page, kind)).toBeDisabled()
  const allDisabled = await dialog(page, kind).evaluate(modal => [...modal.querySelectorAll('input,textarea,select')].every(field => field.matches(':disabled')))
  expect(allDisabled).toBe(true)
}

async function expectFailure(page: Page, kind: Kind) {
  await expect(dialog(page, kind).getByRole('alert')).toHaveText(kind === 'quick'
    ? 'Document title cannot contain path separators, control characters, or dot segments' : 'Template name is invalid or too long.')
  await expect(dialog(page, kind)).toHaveAttribute('aria-busy', 'false')
}

async function selected(target: Locator) {
  return target.evaluate(element => {
    const field = element as HTMLInputElement | HTMLTextAreaElement
    return { value: field.value, start: field.selectionStart, end: field.selectionEnd }
  })
}

for (const language of ['en-US', 'zh-CN'] as const) for (const kind of ['quick', 'template'] as const) {
test(`new editing focus survives a queued ${kind} save failure callback in ${language} @electron`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  const env = { PLAYWRIGHT_ELECTRON_LOCALE: language }
  await withElectronApp(async context => {
    const { page, app } = context
    let restarted: Awaited<ReturnType<typeof launchElectronApp>> | null = null
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const sourceId = await page.evaluate(async language => {
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title: 'Ownership source', summary: 'Unchanged source summary', blocks: [
          { id: `${id}-body`, type: 'paragraph', content: 'Original source body {{title}}', checked: false, depth: 0 }
        ] })
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        return id
      }, language)
      await page.reload()
      await page.setViewportSize({ width: 1180, height: 850 })
      const before = await readStored(page, language)
      await installMainProbe(app, kind)
      if (kind === 'quick') {
        await page.getByRole('button', { name: uiText('Quick capture', '快速记录'), exact: true }).click()
        await fallback(page, kind).fill(captureDraft)
        await newOwner(page, kind).fill(invalidTitle)
        await dialog(page, kind).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true }).selectOption(sourceId)
      } else {
        await page.locator('.tree-button', { hasText: 'Ownership source' }).first().click()
        await expect(page.locator('.document-header-title')).toHaveText('Ownership source')
        await page.getByRole('button', { name: uiText('More actions', '更多操作'), exact: true }).click()
        await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save as template', '保存为模板'), exact: true }).click()
        await fallback(page, kind).fill(invalidName)
        await newOwner(page, kind).fill(descriptionDraft)
      }
      await fallback(page, kind).evaluate(field => field.setAttribute('data-ownership-field', 'fallback'))
      await newOwner(page, kind).evaluate(field => field.setAttribute('data-ownership-field', 'new-owner'))
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await installRendererProbe(page)

      // With no new pending activity, failure preserves the existing Content/Name retry focus contract.
      await startSave(page, kind)
      await expect.poll(() => count(app)).toBe(1)
      await expectBusy(page, kind)
      const normalAcceptedCalls = await page.evaluate(() => (window as ProbeWindow).__knowbookDocumentSaveOwnership!.calls.slice())
      await settle(app, 0)
      await expectFailure(page, kind)
      await naturalFrames(page)
      const normal = await record(page, app, info, kind, `${language}-${kind}-uninterrupted-real-validation-failure`)
      await expect(fallback(page, kind)).toBeFocused()
      const normalCompletionCalls = normal.state.calls.slice(normalAcceptedCalls.length)
      expect(normalCompletionCalls).toHaveLength(1)
      expect(normalCompletionCalls[0].field).toBe('fallback')
      expect(normal.main.saved).toHaveLength(0)
      expect(normal.main.failures).toHaveLength(1)
      expect(await readStored(page, language)).toEqual(before)

      // Capture only completion-phase frames; later locator clicks remain backed by native RAF.
      await startSave(page, kind)
      await expect.poll(() => count(app)).toBe(2)
      await expectBusy(page, kind)
      const queuedAcceptedCalls = await page.evaluate(() => (window as ProbeWindow).__knowbookDocumentSaveOwnership!.calls.slice())
      await page.evaluate(() => (window as ProbeWindow).__knowbookDocumentSaveOwnership!.startCapture())
      await settle(app, 1)
      await expectFailure(page, kind)
      const held = await page.evaluate(() => (window as ProbeWindow).__knowbookDocumentSaveOwnership!.endCapture())
      expect(held).toBeGreaterThan(0)
      const queued = await record(page, app, info, kind, `${language}-${kind}-failure-completion-frame-held`)
      expect(queued.main.requests).toHaveLength(2)
      expect(queued.main.requests[1].input).toEqual(queued.main.requests[0].input)
      expect(queued.state.calls).toEqual(queuedAcceptedCalls)

      // This is a real pointer focus transfer, followed by renderer composition events, not an OS IME window.
      await newOwner(page, kind).click()
      await newOwner(page, kind).evaluate(element => (element as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(2, 8))
      await newOwner(page, kind).dispatchEvent('compositionstart', { data: 'candidate' })
      const selection = await selected(newOwner(page, kind))
      const focusCount = await page.evaluate(() => (window as ProbeWindow).__knowbookDocumentSaveOwnership!.calls.length)
      await expect(newOwner(page, kind)).toBeFocused()
      await page.evaluate(() => (window as ProbeWindow).__knowbookDocumentSaveOwnership!.release())
      await naturalFrames(page)
      const preserved = await record(page, app, info, kind, `${language}-${kind}-new-selection-survives-released-old-frame`)
      expect(preserved.state.calls).toHaveLength(focusCount)
      await expect(newOwner(page, kind)).toBeFocused()
      expect(await selected(newOwner(page, kind))).toEqual(selection)
      await expect(fallback(page, kind)).toHaveValue(kind === 'quick' ? captureDraft : invalidName)
      await expect(newOwner(page, kind)).toHaveValue(kind === 'quick' ? invalidTitle : descriptionDraft)
      if (kind === 'quick') await expect(dialog(page, kind).getByRole('combobox')).toHaveValue(sourceId)
      expect(preserved.main.saved).toHaveLength(0)
      expect(preserved.main.failures).toHaveLength(2)
      expect(await readStored(page, language)).toEqual(before)

      await newOwner(page, kind).dispatchEvent('compositionend', { data: 'candidate' })
      const corrected = kind === 'quick' ? 'Captured after focus ownership' : 'Template after focus ownership'
      if (kind === 'quick') {
        await page.keyboard.press(`${mod}+A`)
        await page.keyboard.type(corrected)
        await newOwner(page, kind).press(`${mod}+Enter`)
      } else {
        await fallback(page, kind).fill(corrected)
        await fallback(page, kind).press('Enter')
      }
      await expect.poll(() => count(app)).toBe(3)
      await expectBusy(page, kind)
      // Repeated pending activity cancels autofocus eligibility; only single-flight persistence is asserted here.
      await page.keyboard.press(kind === 'quick' ? `${mod}+Enter` : 'Enter')
      await page.keyboard.press('Space')
      const bounds = await save(page, kind).boundingBox()
      expect(bounds).not.toBeNull()
      await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
      expect(await count(app)).toBe(3)
      await settle(app, 2)
      await expect(dialog(page, kind)).toHaveCount(0)
      const after = await readStored(page, language)
      if (kind === 'quick') {
        const added = after.catalog.filter(entry => !before.catalog.some(original => original.id === entry.id))
        expect(added).toHaveLength(1)
        expect(added[0]).toMatchObject({ title: corrected, parentId: sourceId, path: `Ownership source/${corrected}` })
        const note = after.documents.find(document => document?.id === added[0].id)!
        expect(note.blocks.map(({ type, content, checked, depth }) => ({ type, content, checked, depth }))).toEqual([
          { type: 'heading-1', content: 'Ownership capture', checked: false, depth: 0 },
          { type: 'paragraph', content: 'Kept Markdown paragraph.', checked: false, depth: 0 },
          { type: 'todo', content: 'Next action', checked: false, depth: 0 }
        ])
        expect(after.templates).toEqual(before.templates)
        expect(after.catalog.filter(entry => before.catalog.some(original => original.id === entry.id))).toEqual(
          before.catalog.map(entry => entry.id === sourceId ? { ...entry, childCount: entry.childCount + 1 } : entry))
        expect(before.documents.map(original => after.documents.find(document => document?.id === original!.id))).toEqual(
          before.documents.map(original => original?.id === sourceId ? { ...original, children: [...original.children,
            { id: added[0].id, title: corrected, path: added[0].path }] } : original))
      } else {
        expect(after.catalog).toEqual(before.catalog)
        expect(after.documents).toEqual(before.documents)
        const added = after.templates.filter(template => !before.templates.some(original => original.id === template.id))
        expect(added).toHaveLength(1)
        expect(added[0]).toMatchObject({ name: corrected, description: descriptionDraft, title: 'Ownership source', summary: 'Unchanged source summary', builtIn: false })
        expect(added[0].blocks.map(({ type, content, checked, depth }) => ({ type, content, checked, depth }))).toEqual([
          { type: 'paragraph', content: 'Original source body {{title}}', checked: false, depth: 0 }
        ])
        expect(after.templates.filter(template => before.templates.some(original => original.id === template.id))).toEqual(before.templates)
      }
      const saved = await record(page, app, info, kind, `${language}-${kind}-only-corrected-retry-persists-once`)
      expect(saved.main.requests).toHaveLength(3)
      expect(saved.main.saved).toHaveLength(1)
      expect(saved.main.failures).toHaveLength(2)
      expect(errors).toEqual([])
      await page.evaluate(() => (window as ProbeWindow).__knowbookDocumentSaveOwnership?.restore())

      await closeElectronApp(context, { preserveUserData: true })
      restarted = await launchElectronApp(env, { userDataRoot: context.tempRoot })
      expect(await readStored(restarted.page, language)).toEqual(after)
      await record(restarted.page, restarted.app, info, kind, `${language}-${kind}-actual-restart-preserves-the-single-write`)
    } finally {
      await page.evaluate(() => (window as ProbeWindow).__knowbookDocumentSaveOwnership?.restore()).catch(() => undefined)
      if (restarted) await closeElectronApp(restarted, { preserveUserData: true })
    }
  }, env)
})
}
