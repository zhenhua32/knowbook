import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, id: unknown) => unknown | Promise<unknown>
type Request = { event: unknown; id: string; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; requests: Request[]; deleted: string[]; failures: string[]; templateDeletes: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookShortConfirmationProbe?: Probe }
const confirmation = (page: Page) => page.locator('.app-confirm-dialog[open]')
const cancel = (page: Page) => confirmation(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true })
const picker = (page: Page) => page.getByRole('dialog', { name: uiText('From template', '从模板新建'), exact: true })

async function readStored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { catalog, details: await Promise.all(catalog.map(entry => window.knowbook.getDocumentDetail(entry.id))),
      templates: await window.knowbook.listDocumentTemplates(language), trash: await window.knowbook.listTrashedDocuments() }
  }, language)
}

async function installDeleteSpy(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('knowbook:delete-document'), deleteTemplate = handlers.get('knowbook:delete-document-template')
    if (!original || !deleteTemplate) throw new Error('The real document and template delete handlers are required')
    const probe: Probe = { original, requests: [], deleted: [], failures: [], templateDeletes: [] }
    ;(globalThis as ProbeGlobal).__knowbookShortConfirmationProbe = probe
    ipcMain.removeHandler('knowbook:delete-document')
    ipcMain.handle('knowbook:delete-document', (event, id) => new Promise((resolve, reject) => {
      probe.requests.push({ event, id, settled: false, resolve, reject })
    }))
    ipcMain.removeHandler('knowbook:delete-document-template')
    ipcMain.handle('knowbook:delete-document-template', (event, id) => {
      probe.templateDeletes.push(id)
      return deleteTemplate(event, id)
    })
  })
}

async function settleDelete(app: ElectronApplication, index: number, message?: string) {
  await app.evaluate((_electron, { index, message }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookShortConfirmationProbe!, request = probe.requests[index]
    if (!request || request.settled) throw new Error('A pending deletion is required')
    request.settled = true
    setImmediate(async () => {
      try {
        if (message) throw new Error(message)
        const result = await probe.original(request.event, request.id)
        probe.deleted.push(request.id)
        request.resolve(result)
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        probe.failures.push(error.message)
        request.reject(error)
      }
    })
  }, { index, message })
}

async function openDocumentDelete(page: Page) {
  await page.getByRole('button', { name: uiText('More actions', '更多操作'), exact: true }).click()
  await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Delete', '删除'), exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: uiText('Delete document', '删除文档'), exact: true })).toBeVisible()
}

async function tabTo(page: Page, target: Locator, direction: 'Tab' | 'Shift+Tab' = 'Tab') {
  for (let step = 0; step < 6; step++) {
    if (await target.evaluate(element => element === document.activeElement)) return
    await page.keyboard.press(direction)
  }
  await expect(target).toBeFocused()
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookShortConfirmationProbe!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds() })),
      deleteCalls: probe.requests.map(request => request.id), requests: probe.requests.map(({ id, settled }) => ({ id, settled })),
      deleted: probe.deleted, failures: probe.failures, templateDeletes: probe.templateDeletes }
  })
  const state = await confirmation(page).evaluate(element => {
    const rect = (target: Element) => { const r = target.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const intersectClip = (parent: Element, clip: { left: number; top: number; right: number; bottom: number }) => {
      const style = getComputedStyle(parent), r = rect(parent), port = parent as HTMLElement
      // clientLeft rounds fractional CSS borders at display scaling. Use the
      // rendered border widths, while still excluding actual scrollbars.
      const left = parseFloat(style.borderLeftWidth) || 0, right = parseFloat(style.borderRightWidth) || 0
      const top = parseFloat(style.borderTopWidth) || 0, bottom = parseFloat(style.borderBottomWidth) || 0
      const verticalBar = Math.max(0, port.offsetWidth - port.clientWidth - left - right)
      const horizontalBar = Math.max(0, port.offsetHeight - port.clientHeight - top - bottom)
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { clip.left = Math.max(clip.left, r.left + left); clip.right = Math.min(clip.right, r.right - right - verticalBar) }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { clip.top = Math.max(clip.top, r.top + top); clip.bottom = Math.min(clip.bottom, r.bottom - bottom - horizontalBar) }
      return style.position === 'fixed'
    }
    const box = (target: Element) => {
      const bounds = rect(target), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        if (intersectClip(parent, clip)) break
      }
      const width = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left))
      const height = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return { rect: bounds, clip, visibleRatio: bounds.width && bounds.height ? width * height / (bounds.width * bounds.height) : 0,
        centerHit: hit === target || Boolean(hit && target.contains(hit)), hit: hit ? { tag: hit.tagName, className: hit.getAttribute('class') } : null }
    }
    const glyph = (target: Element, end: boolean) => {
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT), texts: Text[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.trim()) texts.push(node as Text)
      const text = texts[end ? texts.length - 1 : 0]
      if (!text) return null
      const range = document.createRange(), position = end ? text.length - 1 : 0
      range.setStart(text, position); range.setEnd(text, position + 1)
      const r = range.getBoundingClientRect(), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let parent: Element | null = target; parent; parent = parent.parentElement) {
        if (intersectClip(parent, clip)) break
      }
      const width = Math.max(0, Math.min(r.right, clip.right) - Math.max(r.left, clip.left)), height = Math.max(0, Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top))
      return { text: text.data.slice(position, position + 1), rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }, clip,
        visibleRatio: r.width && r.height ? width * height / (r.width * r.height) : 0 }
    }
    const modal = element as HTMLDialogElement, body = modal.querySelector<HTMLElement>('.app-confirm-body')!, active = document.activeElement
    const heading = modal.querySelector<HTMLElement>('h2')!, note = modal.querySelector('.app-confirm-note'), error = modal.querySelector('.app-confirm-error')
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName, text: active?.tagName === 'BUTTON' ? active.textContent : null, isBody: active === document.body },
      dialog: { ...box(modal), scrollTop: modal.scrollTop, clientHeight: modal.clientHeight, scrollHeight: modal.scrollHeight, ariaBusy: modal.getAttribute('aria-busy') },
      header: box(modal.querySelector('header')!), heading: { text: heading.textContent, ...box(heading), scrollTop: heading.scrollTop, clientHeight: heading.clientHeight, scrollHeight: heading.scrollHeight, tabIndex: heading.tabIndex, focused: active === heading,
        firstGlyph: glyph(heading, false), lastGlyph: glyph(heading, true) },
      body: { ...box(body), scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, overflowY: getComputedStyle(body).overflowY, tabIndex: body.tabIndex, focused: active === body },
      description: { text: body.querySelector('p')!.textContent, ...box(body.querySelector('p')!) },
      note: note ? { text: note.textContent, ...box(note), lastGlyph: glyph(note, true) } : null,
      error: error ? { text: error.textContent, ...box(error), firstGlyph: glyph(error, false), lastGlyph: glyph(error, true) } : null,
      footer: box(modal.querySelector('footer')!),
      buttons: Array.from(modal.querySelectorAll<HTMLButtonElement>('footer button')).map(button => ({ text: button.textContent, disabled: button.disabled, focused: active === button, ...box(button) })) }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { main, state }
}

function expectFixedActions(snapshot: Awaited<ReturnType<typeof record>>) {
  expect(snapshot.state.dialog.scrollTop).toBe(0)
  expect(snapshot.state.heading.visibleRatio).toBe(1)
  expect(snapshot.state.heading.centerHit).toBe(true)
  // Computed border widths and serialized DOMRects can differ below a CSS subpixel.
  expect(snapshot.state.header.visibleRatio).toBeCloseTo(1, 5)
  expect(snapshot.state.buttons).toHaveLength(2)
  for (const button of snapshot.state.buttons) { expect(button.visibleRatio).toBe(1); expect(button.centerHit).toBe(true) }
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`long document confirmation keeps short viewport actions reachable in ${language} @electron`, async ({}, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const longTitle = '长标题确认时应保留全部文档名称'.repeat(30).slice(0, 300)
    const longTemplateName = '模板删除确认需要读完整名称'.repeat(30).slice(0, 196) + '名称终点'
    expect(longTitle.length).toBe(300)
    expect(longTemplateName.length).toBe(200)
    const ids = await page.evaluate(async ({ longTitle, longTemplateName, language }) => {
      const parent = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(parent.id, { title: longTitle, summary: 'Keep the original parent summary', blocks: [
        { id: `${parent.id}-body`, type: 'paragraph', content: 'Keep the original long-title document content', checked: false, depth: 0 }
      ] })
      const child = await window.knowbook.createDocument(parent.id)
      await window.knowbook.updateDocument(child.id, { title: 'Preserved confirmation child', summary: 'Keep the original child summary', blocks: [
        { id: `${child.id}-body`, type: 'paragraph', content: 'Keep the original child content', checked: false, depth: 0 }
      ] })
      const template = await window.knowbook.saveDocumentTemplate({ name: longTemplateName, description: 'Keep the original long-name template',
        title: 'Preserved template document title', summary: 'Keep the original template summary', blocks: [
          { id: 'confirmation-template-body', type: 'paragraph', content: 'Keep the original template content', checked: false, depth: 0 }
        ] })
      await window.knowbook.saveSetting('ui.language', language)
      await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
      return { documentId: parent.id, childId: child.id, templateId: template.id }
    }, { longTitle, longTemplateName, language })
    await page.reload()
    await page.setViewportSize({ width: 1180, height: 850 })
    const target = page.getByRole('treeitem', { name: longTitle, exact: true }).locator('.tree-button')
    await expect(target).toHaveCount(1)
    await target.click()
    await expect(page.locator('.document-header-title')).toHaveText(longTitle)
    const before = await readStored(page, language)
    expect(before.details.find(detail => detail?.id === ids.documentId)?.children).toHaveLength(1)
    await installDeleteSpy(app)
    await openDocumentDelete(page)
    const natural = await record(page, app, testInfo, `${language}-long-document-confirmation-natural-height`)
    expect(natural.main.deleteCalls).toEqual([])
    expectFixedActions(natural)
    expect(natural.state.description.visibleRatio).toBe(1)
    expect(natural.state.note!.visibleRatio).toBe(1)
    expect(natural.state.body.scrollHeight).toBeLessThanOrEqual(natural.state.body.clientHeight + 1)
    expect(natural.state.heading.scrollHeight).toBeLessThanOrEqual(natural.state.heading.clientHeight + 1)
    expect(natural.state.dialog.rect.height).toBeLessThan(natural.state.viewport.height - 32)
    expect(Math.abs(natural.state.dialog.rect.height - natural.state.header.rect.height - natural.state.body.rect.height - natural.state.footer.rect.height - 2)).toBeLessThanOrEqual(2)
    await expect(cancel(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: uiText('More actions', '更多操作'), exact: true })).toBeFocused()
    expect(await readStored(page, language)).toEqual(before)
    await page.setViewportSize({ width: 760, height: 440 })
    await openDocumentDelete(page)
    await expect(confirmation(page)).toContainText(longTitle)
    // Capture the old layout before any reachability oracle or user scrolling.
    const opened = await record(page, app, testInfo, `${language}-long-document-confirmation-short-opened`)
    expect(opened.main.deleteCalls).toEqual([])
    expectFixedActions(opened)
    const body = confirmation(page).getByRole('region', { name: uiText('Confirmation details', '确认详情'), exact: true })
    await expect(body).toHaveAttribute('tabindex', '0')
    await expect(cancel(page)).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(body).toBeFocused()
    await page.keyboard.press('PageDown')
    await page.keyboard.press('End')
    await expect.poll(() => body.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
    const readEnd = await record(page, app, testInfo, `${language}-keyboard-reads-description-and-note-end`)
    expectFixedActions(readEnd)
    expect(readEnd.state.body.focused).toBe(true)
    expect(readEnd.state.note!.lastGlyph!.visibleRatio).toBe(1)
    await page.keyboard.press('Tab')
    await expect(cancel(page)).toBeFocused()
    const remove = confirmation(page).getByRole('button', { name: uiText('Delete document', '删除文档'), exact: true })
    await expect(cancel(page)).toBeInViewport({ ratio: 1 })
    await expect(remove).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Enter') // Default action is cancellation, never deletion.
    await expect(confirmation(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: uiText('More actions', '更多操作'), exact: true })).toBeFocused()
    expect(await readStored(page, language)).toEqual(before)

    // A genuine saved template supplies a long accessible heading, rather than a synthetic dialog.
    await page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true }).click()
    await expect(picker(page)).toBeVisible()
    await picker(page).getByRole('button', { name: uiText('Custom', '自定义模板'), exact: true }).click()
    const template = picker(page).locator('.document-template-item').filter({ has: page.getByText(longTemplateName, { exact: true }) })
    await expect(template).toHaveCount(1)
    await template.click()
    await expect(template).toHaveAttribute('aria-pressed', 'true')
    await picker(page).getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true }).click()
    const templateHeading = confirmation(page).getByRole('heading', { level: 2, name: language === 'zh-CN' ? `删除模板“${longTemplateName}”` : `Delete template “${longTemplateName}”`, exact: true })
    await expect(templateHeading).toBeVisible()
    const templateOpened = await record(page, app, testInfo, `${language}-real-template-long-heading-opened`)
    expectFixedActions(templateOpened)
    expect(templateOpened.state.heading.scrollHeight).toBeGreaterThan(templateOpened.state.heading.clientHeight)
    await page.setViewportSize({ width: 360, height: 440 })
    const narrow = await record(page, app, testInfo, `${language}-long-heading-narrow-viewport`)
    expectFixedActions(narrow)
    await tabTo(page, templateHeading, 'Shift+Tab')
    await expect(templateHeading).toHaveAttribute('tabindex', '0')
    await page.keyboard.press('End')
    await expect.poll(() => templateHeading.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
    const headingEnd = await record(page, app, testInfo, `${language}-keyboard-reads-template-heading-end`)
    expectFixedActions(headingEnd)
    expect(headingEnd.state.heading.focused).toBe(true)
    expect(headingEnd.state.heading.lastGlyph!.visibleRatio).toBe(1)
    await tabTo(page, cancel(page))
    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toHaveCount(0)
    await expect(picker(page)).toHaveAttribute('aria-busy', 'false')
    await expect(picker(page).getByRole('searchbox', { name: uiText('Search templates', '搜索模板'), exact: true })).toBeFocused()
    await expect(template).toHaveAttribute('aria-pressed', 'true')
    await expect(picker(page).locator('.document-template-preview')).toContainText('Keep the original template content')
    expect(await readStored(page, language)).toEqual(before)
    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
    await page.setViewportSize({ width: 760, height: 440 })

    // Only the first accepted request fails in this isolated transport fixture; retry delegates to real SQLite.
    await openDocumentDelete(page)
    await page.keyboard.press('Tab')
    await expect(remove).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookShortConfirmationProbe!.requests.length)).toBe(1)
    await expect(confirmation(page)).toHaveAttribute('aria-busy', 'true')
    await expect(cancel(page)).toBeDisabled()
    await expect(remove).toBeDisabled()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await page.keyboard.press('Escape')
    const pending = await record(page, app, testInfo, `${language}-one-accepted-document-delete-pending`)
    expectFixedActions(pending)
    expect(pending.main.requests).toEqual([{ id: ids.documentId, settled: false }])
    expect(pending.main.templateDeletes).toEqual([])
    expect(await readStored(page, language)).toEqual(before)
    const reason = language === 'zh-CN'
      ? '无法完成删除：临时存储写入被拒绝，原文档和子文档仍然保留。请检查存储目录后重试。\n' + '诊断说明：此请求尚未写入回收站，重试仍应处理刚才选择的同一文档。'.repeat(8)
      : 'Deletion could not finish: a temporary storage write was rejected. The document and its child are preserved. Check the storage location and retry.\n' + 'Diagnostic detail: this request has not written to Trash. Retry must still target the same selected document. '.repeat(8)
    await settleDelete(app, 0, reason)
    await expect(confirmation(page).getByRole('alert')).toHaveText(reason)
    await expect(confirmation(page)).toHaveAttribute('aria-busy', 'false')
    // Capture the first failed render before keyboard scrolling can reveal a buried message.
    const failed = await record(page, app, testInfo, `${language}-first-failure-error-start-and-fixed-actions`)
    expectFixedActions(failed)
    expect(failed.state.error!.firstGlyph!.visibleRatio).toBe(1)
    expect(failed.main.failures).toEqual([reason])
    expect(failed.main.deleted).toEqual([])
    await expect(cancel(page)).toBeFocused()
    expect(await readStored(page, language)).toEqual(before)
    const retry = confirmation(page).getByRole('button', { name: uiText('Retry', '重试'), exact: true })
    await page.keyboard.press('Shift+Tab')
    await expect(body).toBeFocused()
    await page.keyboard.press('End')
    await expect.poll(() => body.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
    const errorEnd = await record(page, app, testInfo, `${language}-keyboard-reads-full-failure-reason`)
    expectFixedActions(errorEnd)
    expect(errorEnd.state.body.focused).toBe(true)
    expect(errorEnd.state.error!.lastGlyph!.visibleRatio).toBe(1)
    await page.keyboard.press('Tab')
    await expect(cancel(page)).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(retry).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookShortConfirmationProbe!.requests.length)).toBe(2)
    const retryPending = await record(page, app, testInfo, `${language}-retry-still-targets-original-document`)
    expectFixedActions(retryPending)
    expect(retryPending.main.requests).toEqual([{ id: ids.documentId, settled: true }, { id: ids.documentId, settled: false }])
    await settleDelete(app, 1)
    await expect(confirmation(page)).toHaveCount(0)
    await expect.poll(() => page.evaluate(id => window.knowbook.getDocumentCatalog().then(catalog => catalog.some(entry => entry.id === id)), ids.documentId)).toBe(false)
    const after = await readStored(page, language)
    expect(after.catalog).toHaveLength(before.catalog.length - 1)
    expect(after.templates).toEqual(before.templates)
    expect(after.trash).toHaveLength(before.trash.length + 1)
    expect(after.trash.filter(entry => !before.trash.some(original => original.id === entry.id))).toEqual([
      expect.objectContaining({ documentId: ids.documentId, title: longTitle, path: longTitle, reason: 'delete' })
    ])
    const originalParent = before.details.find(detail => detail?.id === ids.documentId)!
    // Recovery returns an UpdateDocumentInput payload rather than database-only
    // block metadata such as sortOrder and undefined optional properties.
    expect(await page.evaluate(id => window.knowbook.getTrashedDocument(id), ids.documentId)).toEqual({
      title: originalParent.title, summary: originalParent.summary, blocks: [{
        id: `${ids.documentId}-body`, type: 'paragraph', content: 'Keep the original long-title document content',
        checked: false, depth: 0, parentBlockId: null, tags: []
      }]
    })
    const originalChild = before.details.find(detail => detail?.id === ids.childId)!, child = after.details.find(detail => detail?.id === ids.childId)!
    expect(child).toEqual({ ...originalChild, path: 'Preserved confirmation child', updatedAt: child.updatedAt })
    expect(after.catalog.find(entry => entry.id === ids.childId)).toMatchObject({ parentId: null, parentTitle: null, path: 'Preserved confirmation child' })
    expect(after.catalog.filter(entry => ![ids.documentId, ids.childId].includes(entry.id))).toEqual(before.catalog.filter(entry => ![ids.documentId, ids.childId].includes(entry.id)))
    expect(after.details.filter(detail => detail?.id !== ids.childId)).toEqual(before.details.filter(detail => detail && ![ids.documentId, ids.childId].includes(detail.id)))
    const finalProbe = await app.evaluate(({ BrowserWindow }) => {
      const probe = (globalThis as ProbeGlobal).__knowbookShortConfirmationProbe!
      return { deleted: probe.deleted, requests: probe.requests.map(({ id, settled }) => ({ id, settled })), templateDeletes: probe.templateDeletes,
        windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }
    })
    expect(finalProbe.deleted).toEqual([ids.documentId])
    expect(finalProbe.requests).toEqual([{ id: ids.documentId, settled: true }, { id: ids.documentId, settled: true }])
    expect(finalProbe.templateDeletes).toEqual([])
    expect(finalProbe.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
    await page.reload()
    await expect(page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true })).toBeEnabled()
    expect(await readStored(page, language)).toEqual(after)
    expect(errors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
