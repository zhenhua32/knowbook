import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Outcome = 'cancel' | 'delete'
type Handler = (event: unknown, id: string) => unknown | Promise<unknown>
type Request = { event: unknown; id: string; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type MainProbe = { original: Handler; requests: Request[]; deleted: string[]; failures: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookTemplateDeleteFocus?: MainProbe }
type FocusCall = { field: string | null; tag: string; connected: boolean; disabled: boolean; wasActive: boolean; activeAfter: boolean }
type RendererProbe = {
  calls: FocusCall[]; startCapture: () => void; endCapture: () => number; release: () => void; restore: () => void
  pending: () => number; twoFrames: () => Promise<void>
}
type ProbeWindow = Window & { __knowbookTemplateDeleteFocus?: RendererProbe }
const manualTitle = 'Manual nested deletion title'
const query = 'Nested focus'
const picker = (page: Page) => page.getByRole('dialog', { name: uiText('From template', '从模板新建'), exact: true })
const title = (page: Page) => picker(page).getByRole('textbox', { name: uiText('Document title', '文档标题'), exact: true })
const parent = (page: Page) => picker(page).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true })
const search = (page: Page) => picker(page).getByRole('searchbox', { name: uiText('Search templates', '搜索模板'), exact: true })
const remove = (page: Page) => picker(page).getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true })
const confirmation = (page: Page) => page.getByRole('alertdialog', { name: uiText('Delete template “Nested focus Alpha”', '删除模板“Nested focus Alpha”'), exact: true })

async function readStored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { catalog, documents: await Promise.all(catalog.map(entry => window.knowbook.getDocumentDetail(entry.id))),
      templates: await window.knowbook.listDocumentTemplates(language) }
  }, language)
}

async function installMainProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const channel = 'knowbook:delete-document-template'
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get(channel)
    if (!original) throw new Error('The real template deletion handler is required')
    const probe: MainProbe = { original, requests: [], deleted: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookTemplateDeleteFocus = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, id) => new Promise((resolve, reject) => {
      probe.requests.push({ event, id, settled: false, resolve, reject })
    }))
  })
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookTemplateDeleteFocus!, request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real pending template deletion is required')
    request.settled = true
    setImmediate(async () => {
      try { const result = await probe.original(request.event, request.id); probe.deleted.push(request.id); request.resolve(result) }
      catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); probe.failures.push(error.message); request.reject(error) }
    })
  }, index)
}

async function count(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as ProbeGlobal).__knowbookTemplateDeleteFocus!.requests.length)
}

async function installRendererProbe(page: Page) {
  await page.evaluate(() => {
    const nativeFrame = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window)
    const originalFrame = window.requestAnimationFrame, originalCancel = window.cancelAnimationFrame, originalFocus = HTMLElement.prototype.focus
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
      const record: FocusCall = { field: this.getAttribute('data-delete-focus-field'), tag: this.tagName,
        connected: this.isConnected, disabled: this.matches(':disabled'), wasActive: document.activeElement === this, activeAfter: false }
      calls.push(record)
      originalFocus.call(this, options)
      record.activeAfter = document.activeElement === this
    }
    ;(window as ProbeWindow).__knowbookTemplateDeleteFocus = {
      calls, startCapture: () => { capturing = true },
      // New user actions keep native scheduling after capture ends; only the closing callbacks stay held.
      endCapture: () => { capturing = false; return [...frames.values()].filter(entry => entry.blocked).length },
      release: () => {
        capturing = false
        for (const [id, entry] of frames) if (entry.blocked) {
          nativeCancel(entry.nativeId)
          entry.blocked = false
          entry.nativeId = nativeFrame(timestamp => run(id, entry, timestamp))
        }
      },
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

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookTemplateDeleteFocus!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
      requests: probe.requests.map(({ id, settled }) => ({ id, settled })), deleted: probe.deleted, failures: probe.failures }
  })
  const state = await page.evaluate(() => {
    const modal = document.querySelector<HTMLDialogElement>('.document-template-dialog'), child = document.querySelector<HTMLDialogElement>('.app-confirm-dialog')
    const draft = modal?.querySelector<HTMLInputElement>('[name="document-title"]'), port = modal?.querySelector<HTMLSelectElement>('select')
    const probe = (window as ProbeWindow).__knowbookTemplateDeleteFocus
    return { modal: Boolean(modal?.open), child: Boolean(child?.open), busy: modal?.getAttribute('aria-busy'), childBusy: child?.getAttribute('aria-busy') ?? null,
      active: { tag: document.activeElement?.tagName, field: document.activeElement?.getAttribute('data-delete-focus-field') ?? null, isBody: document.activeElement === document.body },
      title: draft?.value ?? null, selection: draft ? { start: draft.selectionStart, end: draft.selectionEnd } : null,
      parentId: port?.value ?? null, query: modal?.querySelector<HTMLInputElement>('input[type="search"]')?.value ?? null,
      selected: modal?.querySelector('.document-template-item[aria-pressed="true"] strong')?.textContent ?? null,
      preview: modal?.querySelector('.document-template-preview')?.textContent ?? null,
      error: modal?.querySelector('[role="alert"]')?.textContent ?? null,
      deleteButton: (() => { const button = modal?.querySelector<HTMLButtonElement>('.document-template-delete'); return { present: Boolean(button), disabled: button?.disabled ?? null } })(),
      calls: probe?.calls ?? [], heldFrames: probe?.pending() ?? 0 }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { main, state }
}

for (const language of ['en-US', 'zh-CN'] as const) for (const outcome of ['cancel', 'delete'] as const) {
test(`nested template ${outcome} keeps newer editing focus in ${language} @electron`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const ids = await page.evaluate(async language => {
        const { id: parentId } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(parentId, { title: 'Nested focus parent', summary: 'Keep parent summary', blocks: [
          { id: `${parentId}-body`, type: 'paragraph', content: 'Keep original parent body', checked: false, depth: 0 }
        ] })
        const alpha = await window.knowbook.saveDocumentTemplate({ name: 'Nested focus Alpha', description: 'Alpha recipe', title: 'Alpha automatic title', summary: 'Alpha summary', blocks: [
          { id: 'alpha-body', type: 'paragraph', content: 'Alpha nested body {{title}}', checked: false, depth: 0 }
        ] })
        const beta = await window.knowbook.saveDocumentTemplate({ name: 'Nested focus Beta', description: 'Beta recipe', title: 'Beta automatic title', summary: 'Beta summary', blocks: [
          { id: 'beta-body', type: 'paragraph', content: 'Beta nested body {{title}}', checked: false, depth: 0 }
        ] })
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        return { parentId, alphaId: alpha.id, betaId: beta.id }
      }, language)
      await page.reload()
      await page.setViewportSize({ width: 1180, height: 850 })
      const before = await readStored(page, language)
      await installMainProbe(app)
      await page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true }).click()
      await picker(page).getByRole('button', { name: uiText('Custom', '自定义模板'), exact: true }).click()
      const alpha = picker(page).locator('.document-template-item').filter({ has: page.getByText('Nested focus Alpha', { exact: true }) })
      await alpha.click()
      await title(page).fill(manualTitle)
      await parent(page).selectOption(ids.parentId)
      await search(page).fill(query)
      await expect(picker(page).locator('.document-template-item')).toHaveCount(2)
      await expect(alpha).toHaveAttribute('aria-pressed', 'true')
      await expect(picker(page).locator('.document-template-preview')).toContainText('Alpha nested body')
      await title(page).evaluate(field => field.setAttribute('data-delete-focus-field', 'title'))
      await search(page).evaluate(field => field.setAttribute('data-delete-focus-field', 'search'))
      await remove(page).evaluate(field => field.setAttribute('data-delete-focus-field', 'delete'))
      const deleteOpener = await remove(page).elementHandle()
      expect(deleteOpener).not.toBeNull()
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await installRendererProbe(page)

      // A separate uninterrupted cancellation keeps the normal Search handoff contract.
      // It performs no mutation before either of the raced Cancel/Delete paths below.
      await remove(page).click()
      await expect(confirmation(page)).toBeVisible()
      await expect(picker(page)).toHaveAttribute('aria-busy', 'true')
      const normalCancel = confirmation(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true })
      await expect(normalCancel).toBeEnabled()
      await expect(normalCancel).toBeFocused()
      const normalBeforeCancelCalls = await page.evaluate(() => (window as ProbeWindow).__knowbookTemplateDeleteFocus!.calls.length)
      await normalCancel.click()
      await expect(confirmation(page)).toHaveCount(0)
      await expect(picker(page)).toHaveAttribute('aria-busy', 'false')
      await page.evaluate(() => (window as ProbeWindow).__knowbookTemplateDeleteFocus!.twoFrames())
      const normal = await record(page, app, info, `${language}-${outcome}-uninterrupted-cancel-focuses-search-once`)
      expect(normal.state.calls.slice(normalBeforeCancelCalls).filter(call => call.field === 'search')).toHaveLength(1)
      await expect(search(page)).toBeEnabled()
      await expect(search(page)).toBeFocused()
      expect(normal.state.title).toBe(manualTitle)
      expect(normal.state.parentId).toBe(ids.parentId)
      expect(normal.state.query).toBe(query)
      expect(normal.state.selected).toBe('Nested focus Alpha')
      expect(normal.state.preview).toContain('Alpha nested body')
      expect(normal.state.error).toBeNull()
      expect(normal.main.requests).toHaveLength(0)
      expect(normal.main.deleted).toHaveLength(0)
      expect(normal.main.failures).toHaveLength(0)
      expect(await readStored(page, language)).toEqual(before)

      await remove(page).click()
      await expect(confirmation(page)).toBeVisible()
      await expect(picker(page)).toHaveAttribute('aria-busy', 'true')
      await expect(remove(page)).toBeDisabled()
      await expect(title(page)).toBeDisabled()
      await expect(search(page)).toBeDisabled()
      await record(page, app, info, `${language}-${outcome}-nested-confirmation-open`)
      if (outcome === 'delete') {
        const confirm = confirmation(page).getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true })
        await confirm.click()
        await expect.poll(() => count(app)).toBe(1)
        await expect(confirmation(page)).toHaveAttribute('aria-busy', 'true')
        await expect(confirm).toBeDisabled()
        await expect(confirmation(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true })).toBeDisabled()
        await page.keyboard.press('Enter')
        await page.keyboard.press('Space')
        const bounds = await confirm.boundingBox()
        expect(bounds).not.toBeNull()
        await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
        const pending = await record(page, app, info, `${language}-${outcome}-one-real-delete-pending`)
        expect(pending.main.requests).toEqual([{ id: ids.alphaId, settled: false }])
        expect(pending.main.deleted).toHaveLength(0)
        expect(await readStored(page, language)).toEqual(before)
        await page.evaluate(() => (window as ProbeWindow).__knowbookTemplateDeleteFocus!.startCapture())
        await settle(app, 0)
      } else {
        const cancel = confirmation(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true })
        // Start only when the actual click arrives, after Playwright's native actionability frames.
        await cancel.evaluate(button => button.addEventListener('click', () => (window as ProbeWindow).__knowbookTemplateDeleteFocus!.startCapture(), { capture: true, once: true }))
        await cancel.click()
      }
      await expect(confirmation(page)).toHaveCount(0)
      await expect(picker(page)).toHaveAttribute('aria-busy', 'false')
      const held = await page.evaluate(() => (window as ProbeWindow).__knowbookTemplateDeleteFocus!.endCapture())
      expect(held).toBeGreaterThan(0)
      const closed = await record(page, app, info, `${language}-${outcome}-child-closed-handoff-frames-held`)
      expect(closed.state.deleteButton).toEqual({ present: true, disabled: false })
      expect(await deleteOpener!.evaluate(button => button.isConnected && button === document.querySelector('.document-template-delete'))).toBe(true)
      expect(closed.state.selected).toBe(outcome === 'delete' ? 'Nested focus Beta' : 'Nested focus Alpha')
      expect(closed.state.preview).toContain(outcome === 'delete' ? 'Beta nested body' : 'Alpha nested body')
      expect(closed.state.title).toBe(manualTitle)
      expect(closed.state.parentId).toBe(ids.parentId)
      expect(closed.state.query).toBe(query)
      expect(closed.main.requests).toHaveLength(outcome === 'delete' ? 1 : 0)
      expect(closed.main.deleted).toEqual(outcome === 'delete' ? [ids.alphaId] : [])

      // Native pointer focus plus renderer composition proves neither closing layer can reclaim this owner.
      await title(page).click()
      await title(page).evaluate(field => (field as HTMLInputElement).setSelectionRange(2, 8))
      await title(page).dispatchEvent('compositionstart', { data: 'candidate' })
      const selection = await title(page).evaluate(field => ({ start: (field as HTMLInputElement).selectionStart, end: (field as HTMLInputElement).selectionEnd }))
      const focusCount = await page.evaluate(() => (window as ProbeWindow).__knowbookTemplateDeleteFocus!.calls.length)
      await expect(title(page)).toBeFocused()
      await page.evaluate(() => (window as ProbeWindow).__knowbookTemplateDeleteFocus!.release())
      await page.evaluate(() => (window as ProbeWindow).__knowbookTemplateDeleteFocus!.twoFrames())
      const preserved = await record(page, app, info, `${language}-${outcome}-new-title-selection-after-old-handoff-release`)
      expect(preserved.state.calls).toHaveLength(focusCount)
      await expect(title(page)).toBeFocused()
      expect(preserved.state.selection).toEqual(selection)
      expect(preserved.state.title).toBe(manualTitle)
      expect(preserved.state.parentId).toBe(ids.parentId)
      expect(preserved.state.query).toBe(query)
      expect(preserved.state.error).toBeNull()
      expect(preserved.main.failures).toHaveLength(0)
      const after = await readStored(page, language)
      expect(after).toEqual({ ...before, templates: outcome === 'delete' ? before.templates.filter(template => template.id !== ids.alphaId) : before.templates })
      expect(after.templates.some(template => template.id === ids.betaId)).toBe(true)
      await title(page).dispatchEvent('compositionend', { data: 'candidate' })
      await page.evaluate(() => (window as ProbeWindow).__knowbookTemplateDeleteFocus!.restore())
      await picker(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(picker(page)).toHaveCount(0)
      await page.reload()
      await expect(page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true })).toBeEnabled()
      expect(await readStored(page, language)).toEqual(after)
      await record(page, app, info, `${language}-${outcome}-real-template-change-survives-reload`)
      expect(await count(app)).toBe(outcome === 'delete' ? 1 : 0)
      expect(errors).toEqual([])
    } finally {
      await page.evaluate(() => (window as ProbeWindow).__knowbookTemplateDeleteFocus?.restore()).catch(() => undefined)
    }
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
