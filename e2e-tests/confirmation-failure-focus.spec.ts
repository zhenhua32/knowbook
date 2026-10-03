import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, id: string) => unknown | Promise<unknown>
type Request = { event: unknown; id: string; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type MainProbe = { original: Handler; requests: Request[]; deleted: string[]; failures: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookConfirmationFailureFocus?: MainProbe }
type FocusCall = { field: string | null; tag: string; disabled: boolean; activeAfter: boolean }
type RendererProbe = {
  calls: FocusCall[]; restore: () => void; twoFrames: () => Promise<void>
  reading: { start: Node; end: Node; startOffset: number; endOffset: number; text: string } | null
}
type ProbeWindow = Window & { __knowbookConfirmationFailureFocus?: RendererProbe }
const confirmation = (page: Page) => page.getByRole('alertdialog', { name: uiText('Delete document', '删除文档'), exact: true })
const details = (page: Page) => confirmation(page).getByRole('region', { name: uiText('Confirmation details', '确认详情'), exact: true })
const cancel = (page: Page) => confirmation(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true })

async function readStored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { catalog, documents: await Promise.all(catalog.map(entry => window.knowbook.getDocumentDetail(entry.id))),
      templates: await window.knowbook.listDocumentTemplates(language), trash: await window.knowbook.listTrashedDocuments() }
  }, language)
}

async function installMainProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const channel = 'knowbook:delete-document'
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)
    if (!original) throw new Error('The real document deletion handler is required')
    const probe: MainProbe = { original, requests: [], deleted: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookConfirmationFailureFocus = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, id) => new Promise((resolve, reject) => {
      probe.requests.push({ event, id, settled: false, resolve, reject })
    }))
  })
}

async function settle(app: ElectronApplication, index: number, reason?: string) {
  await app.evaluate((_electron, { index, reason }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookConfirmationFailureFocus!, request = probe.requests[index]
    if (!request || request.settled) throw new Error('A pending document deletion is required')
    request.settled = true
    setImmediate(async () => {
      try {
        // This isolated transport fault does not call the real handler; the final retry does.
        if (reason) throw new Error(reason)
        const result = await probe.original(request.event, request.id)
        probe.deleted.push(request.id)
        request.resolve(result)
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        probe.failures.push(error.message)
        request.reject(error)
      }
    })
  }, { index, reason })
}

async function count(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as ProbeGlobal).__knowbookConfirmationFailureFocus!.requests.length)
}

async function installRendererProbe(page: Page) {
  await page.evaluate(() => {
    const nativeFocus = HTMLElement.prototype.focus, nativeFrame = window.requestAnimationFrame.bind(window)
    const calls: FocusCall[] = []
    HTMLElement.prototype.focus = function (options) {
      const call: FocusCall = { field: this.getAttribute('data-confirmation-focus-field'), tag: this.tagName,
        disabled: this.matches(':disabled'), activeAfter: false }
      calls.push(call)
      nativeFocus.call(this, options)
      call.activeAfter = document.activeElement === this
    }
    ;(window as ProbeWindow).__knowbookConfirmationFailureFocus = {
      calls, reading: null, restore: () => { HTMLElement.prototype.focus = nativeFocus },
      twoFrames: () => new Promise(resolve => nativeFrame(() => nativeFrame(() => resolve())))
    }
  })
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookConfirmationFailureFocus!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
      requests: probe.requests.map(({ id, settled }) => ({ id, settled })), deleted: probe.deleted, failures: probe.failures }
  })
  const state = await page.evaluate(() => {
    const modal = document.querySelector<HTMLDialogElement>('.app-confirm-dialog[open]'), port = modal?.querySelector<HTMLElement>('.app-confirm-body')
    const probe = (window as ProbeWindow).__knowbookConfirmationFailureFocus, selection = window.getSelection(), prior = probe?.reading
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const error = modal?.querySelector<HTMLElement>('[role="alert"]')
    const firstErrorGlyph = (() => {
      if (!error?.firstChild?.textContent?.length || !port) return null
      const range = document.createRange()
      range.setStart(error.firstChild, 0); range.setEnd(error.firstChild, 1)
      const glyph = range.getBoundingClientRect(), clip = port.getBoundingClientRect()
      return { top: glyph.top, bottom: glyph.bottom, visible: glyph.top >= clip.top && glyph.bottom <= clip.bottom }
    })()
    return { modal: Boolean(modal), busy: modal?.getAttribute('aria-busy') ?? null,
      active: { tag: document.activeElement?.tagName, field: document.activeElement?.getAttribute('data-confirmation-focus-field') ?? null, isBody: document.activeElement === document.body },
      port: port ? { focused: port === document.activeElement, scrollTop: port.scrollTop, scrollHeight: port.scrollHeight, clientHeight: port.clientHeight, tabIndex: port.tabIndex } : null,
      selection: { text: selection?.toString() ?? '', startOffset: range?.startOffset ?? null, endOffset: range?.endOffset ?? null,
        sameNodes: !!range && !!prior && range.startContainer === prior.start && range.endContainer === prior.end },
      error: error?.textContent ?? null, firstErrorGlyph,
      buttons: Array.from(modal?.querySelectorAll<HTMLButtonElement>('footer button') ?? []).map(button => ({ text: button.textContent, disabled: button.disabled, focused: button === document.activeElement })),
      calls: probe?.calls ?? [] }
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
test(`confirmation failure respects pending reading focus in ${language} @electron`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const longTitle = '长标题确认时应保留全部文档名称'.repeat(30).slice(0, 300)
      const ids = await page.evaluate(async ({ language, longTitle }) => {
        const target = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(target.id, { title: longTitle, summary: 'Keep original parent summary', blocks: [
          { id: `${target.id}-body`, type: 'paragraph', content: 'Keep original parent body', checked: false, depth: 0 }
        ] })
        const child = await window.knowbook.createDocument(target.id)
        await window.knowbook.updateDocument(child.id, { title: 'Preserved failure-focus child', summary: 'Keep original child summary', blocks: [
          { id: `${child.id}-body`, type: 'paragraph', content: 'Keep original child body', checked: false, depth: 0 }
        ] })
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        return { documentId: target.id, childId: child.id }
      }, { language, longTitle })
      await page.reload()
      await page.setViewportSize({ width: 760, height: 440 })
      await page.getByRole('treeitem', { name: longTitle, exact: true }).locator('.tree-button').click()
      await expect(page.locator('.document-header-title')).toHaveText(longTitle)
      const before = await readStored(page, language)
      await installMainProbe(app)
      await page.getByRole('button', { name: uiText('More actions', '更多操作'), exact: true }).click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Delete', '删除'), exact: true }).click()
      await expect(confirmation(page)).toBeVisible()
      await expect(cancel(page)).toBeFocused()
      await expect(details(page)).toHaveAttribute('tabindex', '0')
      await cancel(page).evaluate(element => element.setAttribute('data-confirmation-focus-field', 'cancel'))
      await details(page).evaluate(element => element.setAttribute('data-confirmation-focus-field', 'details'))
      const bodyNode = await details(page).elementHandle()
      expect(bodyNode).not.toBeNull()
      await installRendererProbe(page)
      const remove = confirmation(page).getByRole('button', { name: uiText('Delete document', '删除文档'), exact: true })
      await remove.click()
      await expect.poll(() => count(app)).toBe(1)
      await expect(confirmation(page)).toHaveAttribute('aria-busy', 'true')
      await expect(cancel(page)).toBeDisabled()
      await expect(remove).toBeDisabled()

      // The busy footer is disabled, but the real overflow region remains a native keyboard reading target.
      await page.keyboard.press('Tab')
      await expect(details(page)).toBeFocused()
      await page.keyboard.press('PageDown')
      await page.keyboard.press('End')
      await expect.poll(() => details(page).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
      await details(page).evaluate(element => {
        const note = element.querySelector('.app-confirm-note') ?? element.querySelector('p')!
        const walker = document.createTreeWalker(note, NodeFilter.SHOW_TEXT), nodes: Text[] = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.trim()) nodes.push(node as Text)
        const text = nodes[nodes.length - 1]
        if (!text) throw new Error('The real confirmation reading text is required')
        const range = document.createRange()
        range.setStart(text, Math.max(0, text.length - 24)); range.setEnd(text, text.length)
        const selection = window.getSelection()!
        selection.removeAllRanges(); selection.addRange(range)
        ;(window as ProbeWindow).__knowbookConfirmationFailureFocus!.reading = {
          start: range.startContainer, end: range.endContainer, startOffset: range.startOffset, endOffset: range.endOffset, text: selection.toString()
        }
      })
      const reading = await record(page, app, info, `${language}-pending-native-details-reading`)
      expect(reading.state.port!.focused).toBe(true)
      expect(reading.state.port!.scrollTop).toBeGreaterThan(0)
      expect(reading.state.selection.text.length).toBeGreaterThan(0)
      expect(reading.state.selection.sameNodes).toBe(true)
      expect(reading.main.requests).toEqual([{ id: ids.documentId, settled: false }])
      expect(await readStored(page, language)).toEqual(before)
      const reason = language === 'zh-CN'
        ? '临时存储写入被拒绝，原文档和子文档仍保留。可以重试。' + ' 此请求尚未写入回收站。'.repeat(12)
        : 'A temporary storage write was rejected. The original document and child are preserved. You can retry. ' + 'This request has not written to Trash. '.repeat(12)
      await settle(app, 0, reason)
      await expect(confirmation(page).getByRole('alert')).toHaveText(reason)
      await expect(confirmation(page)).toHaveAttribute('aria-busy', 'false')
      await page.evaluate(() => (window as ProbeWindow).__knowbookConfirmationFailureFocus!.twoFrames())
      // Save old-build proof before any oracle or user action can repair focus/scroll.
      const failedReading = await record(page, app, info, `${language}-failure-does-not-reclaim-reading`)
      await expect(details(page)).toBeFocused()
      expect(await bodyNode!.evaluate(element => element.isConnected && element === document.querySelector('.app-confirm-body'))).toBe(true)
      expect(failedReading.state.calls.slice(reading.state.calls.length)).toHaveLength(0)
      expect(failedReading.state.selection).toEqual(reading.state.selection)
      expect(failedReading.state.port!.scrollTop).toBe(reading.state.port!.scrollTop)
      expect(failedReading.main.deleted).toHaveLength(0)
      expect(await readStored(page, language)).toEqual(before)

      // An independent accepted retry has no new pending activity, so normal failure still returns to enabled Cancel once.
      const retry = confirmation(page).getByRole('button', { name: uiText('Retry', '重试'), exact: true })
      await retry.click()
      await expect.poll(() => count(app)).toBe(2)
      await expect(confirmation(page)).toHaveAttribute('aria-busy', 'true')
      const normalAccepted = await page.evaluate(() => (window as ProbeWindow).__knowbookConfirmationFailureFocus!.calls.length)
      const normalReason = language === 'zh-CN' ? '此次写入仍暂时不可用。输入和目标未改变，请重试。' : 'This write is still temporarily unavailable. The target is unchanged; try again.'
      await settle(app, 1, normalReason)
      await expect(confirmation(page).getByRole('alert')).toHaveText(normalReason)
      await expect(confirmation(page)).toHaveAttribute('aria-busy', 'false')
      await page.evaluate(() => (window as ProbeWindow).__knowbookConfirmationFailureFocus!.twoFrames())
      const normal = await record(page, app, info, `${language}-uninterrupted-failure-focuses-enabled-cancel-once`)
      const cancelCalls = normal.state.calls.slice(normalAccepted).filter(call => call.field === 'cancel')
      expect(cancelCalls).toHaveLength(1)
      expect(cancelCalls[0]).toMatchObject({ disabled: false, activeAfter: true })
      await expect(cancel(page)).toBeEnabled()
      await expect(cancel(page)).toBeFocused()
      expect(normal.state.firstErrorGlyph?.visible).toBe(true)
      expect(normal.main.deleted).toHaveLength(0)
      expect(await readStored(page, language)).toEqual(before)

      await retry.click()
      await expect.poll(() => count(app)).toBe(3)
      await expect(confirmation(page)).toHaveAttribute('aria-busy', 'true')
      // Busy duplicate attempts remain locked; no autofocus is promised for this successful final request.
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      await page.keyboard.press('Escape')
      expect(await count(app)).toBe(3)
      await expect(confirmation(page)).toBeVisible()
      await settle(app, 2)
      await expect(confirmation(page)).toHaveCount(0)
      await expect.poll(() => page.evaluate(id => window.knowbook.getDocumentCatalog().then(catalog => catalog.some(entry => entry.id === id)), ids.documentId)).toBe(false)
      const after = await readStored(page, language)
      expect(after.templates).toEqual(before.templates)
      expect(after.catalog).toHaveLength(before.catalog.length - 1)
      const newTrash = after.trash.filter(entry => !before.trash.some(original => original.id === entry.id))
      expect(newTrash).toEqual([expect.objectContaining({ documentId: ids.documentId, title: longTitle, path: longTitle, reason: 'delete' })])
      const previousChild = before.documents.find(document => document?.id === ids.childId)!, child = after.documents.find(document => document?.id === ids.childId)!
      expect(child).toEqual({ ...previousChild, path: 'Preserved failure-focus child', updatedAt: child.updatedAt })
      expect(after.catalog.find(entry => entry.id === ids.childId)).toMatchObject({ parentId: null, parentTitle: null, path: 'Preserved failure-focus child' })
      expect(after.catalog.filter(entry => ![ids.documentId, ids.childId].includes(entry.id))).toEqual(before.catalog.filter(entry => ![ids.documentId, ids.childId].includes(entry.id)))
      expect(after.documents.filter(document => document?.id !== ids.childId)).toEqual(before.documents.filter(document => document && ![ids.documentId, ids.childId].includes(document.id)))
      const saved = await record(page, app, info, `${language}-one-real-target-delete-after-two-preserved-failures`)
      expect(saved.main.requests).toEqual([{ id: ids.documentId, settled: true }, { id: ids.documentId, settled: true }, { id: ids.documentId, settled: true }])
      expect(saved.main.deleted).toEqual([ids.documentId])
      expect(saved.main.failures).toEqual([reason, normalReason])
      await page.evaluate(() => (window as ProbeWindow).__knowbookConfirmationFailureFocus!.restore())
      await page.reload()
      await expect(page.getByRole('button', { name: uiText('More actions', '更多操作'), exact: true })).toBeEnabled()
      expect(await readStored(page, language)).toEqual(after)
      await record(page, app, info, `${language}-real-delete-and-child-preservation-survive-reload`)
      expect(errors).toEqual([])
    } finally {
      await page.evaluate(() => (window as ProbeWindow).__knowbookConfirmationFailureFocus?.restore()).catch(() => undefined)
    }
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
