import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { DocumentBlockDraft, UpdateDocumentInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Entry = 'title' | 'more'
type Handler = (event: unknown, documentId: string, input: UpdateDocumentInput) => unknown | Promise<unknown>
type Request = { documentId: string; input: UpdateDocumentInput; settled: boolean; error?: string }
type Probe = { original: Handler; requests: Request[]; rejectOriginal: string | null; rejectRenameOnce: string | null }
type MainGlobal = typeof globalThis & { __knowbookRenameProbe?: Probe }
type Anchor = { blockId: string; offset: number }
const originalSummary = 'Original meaningful article summary. Keep this summary and every source block unchanged.'
const failureMessage = 'Controlled rename IPC failure; the current draft is preserved.'
const draftFailure = 'Controlled draft IPC failure before renaming.'
const sectionTitle = (language: Language, section: number) => language === 'zh-CN' ? `第${section}章：阅读连续性` : `Chapter ${section}: reading continuity`
const subsectionTitle = (language: Language, section: number) => language === 'zh-CN' ? `第${section}章的折叠小节` : `Folded subsection of chapter ${section}`
const titleButton = (page: Page) => page.locator('.document-header-title-button')
const dialog = (page: Page) => page.locator('.document-rename-dialog')
const nameField = (page: Page) => dialog(page).getByRole('textbox', { name: uiText('Document name', '文档名称'), exact: true })
const renameButton = (page: Page) => dialog(page).getByRole('button', { name: uiText('Rename', '重命名'), exact: true })
const cancelButton = (page: Page) => dialog(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true })
const row = (page: Page, id: string) => page.locator(`[data-block-id="${id}"]`)

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

// A locator click scrolls sticky controls to their unscrolled layout position.
// Hit-test the actual visible control and dispatch native pointer input instead.
async function clickVisible(page: Page, target: Locator) {
  await expect(target).toBeVisible()
  const point = await target.evaluate(element => {
    const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
      centerHit: Boolean(hit && element.contains(hit)) }
  })
  expect(point.visible).toBe(true)
  expect(point.centerHit).toBe(true)
  await page.mouse.click(point.x, point.y)
}

async function resize(page: Page, app: ElectronApplication, width: number) {
  const size = await app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width, height: 900 })
    return window.getContentSize()
  }, width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size)
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await frames(page)
}

async function seed(page: Page, app: ElectronApplication, language: Language, width: number) {
  const title = language === 'zh-CN' ? '长文阅读中的直接重命名' : 'Direct renaming while reading a long article'
  const blocks: DocumentBlockDraft[] = [{ id: 'rename-source-title', type: 'heading-1', content: title, depth: 0, checked: false }]
  for (let section = 1; section <= 6; section++) {
    blocks.push({ id: `rename-section-${section}`, type: 'heading-1', content: sectionTitle(language, section), depth: 0, checked: false })
    for (let paragraph = 1; paragraph <= 8; paragraph++) {
      if (paragraph === 3) blocks.push({ id: `rename-subsection-${section}`, type: 'heading-2', content: subsectionTitle(language, section), depth: 0, checked: false })
      blocks.push({ id: `rename-body-${section}-${paragraph}`, type: 'paragraph', depth: 0, checked: false,
        content: language === 'zh-CN' ? `原始第${section}章第${paragraph}段。` + '改名时保留稳定块、阅读位置和原始文章内容。'.repeat(12)
          : `Original chapter ${section}, paragraph ${paragraph}. ` + 'Renaming preserves the stable block, reading position and original source content. '.repeat(8) })
    }
  }
  const documentId = await page.evaluate(async ({ title, language, blocks, summary }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary, blocks })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    return id
  }, { title, language, blocks, summary: originalSummary })
  await page.reload()
  await resize(page, app, width)
  await page.locator('.tree-button').filter({ has: page.locator('.tree-document-title', { hasText: title }) }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  await expect(page.locator('html')).toHaveAttribute('data-theme', language === 'zh-CN' ? 'dark' : 'light')
  const auxiliary = page.locator('.document-header-aux-button')
  if (await auxiliary.getAttribute('aria-pressed') === 'true') await clickVisible(page, auxiliary)
  const before = (await page.evaluate(id => window.knowbook.getDocumentDetail(id), documentId))!
  expect(before.blocks).toHaveLength(blocks.length)
  return { documentId, title, blocks, before }
}

async function setReading(page: Page, reading = true) {
  const toggle = page.locator('.document-view-toggle')
  if (await toggle.getAttribute('aria-pressed') !== String(reading)) await clickVisible(page, toggle)
  await expect(toggle).toHaveAttribute('aria-pressed', String(reading))
  await frames(page)
}

async function openOutline(page: Page) {
  const popup = page.locator('.document-outline-popover')
  if (!await popup.isVisible()) await clickVisible(page, page.locator('.document-outline-control > button'))
  await expect(popup).toBeVisible()
  return popup
}

async function navigateChapter(page: Page, language: Language, section = 4) {
  const popup = await openOutline(page)
  await popup.locator('.outline-filter').fill(sectionTitle(language, section))
  await clickVisible(page, popup.getByRole('button', { name: sectionTitle(language, section), exact: true }))
  await expect(popup).toHaveCount(0)
  await expect(page.locator('.document-current-heading')).toHaveText(sectionTitle(language, section))
  await frames(page)
}

async function wheelReading(page: Page, delta = 180) {
  const region = page.getByTestId('document-scroll-region')
  const topBefore = await region.evaluate(element => element.scrollTop)
  const point = await region.evaluate(element => {
    const rect = element.getBoundingClientRect(), header = element.querySelector('.document-sticky-header')!.getBoundingClientRect()
    return { x: rect.right - 24, y: (Math.max(rect.top, header.bottom) + Math.min(rect.bottom, innerHeight)) / 2 }
  })
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, delta)
  await expect.poll(() => region.evaluate(element => element.scrollTop)).not.toBe(topBefore)
  await frames(page)
}

async function captureAnchor(page: Page): Promise<Anchor> {
  return page.getByTestId('document-scroll-region').evaluate(element => {
    const header = element.querySelector('.document-sticky-header')!.getBoundingClientRect()
    const bottom = Math.min(element.getBoundingClientRect().bottom, innerHeight)
    const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-block-id]')).find(block => {
      const rect = block.getBoundingClientRect()
      return rect.bottom > header.bottom + 14 && rect.top < bottom
    })
    if (!anchor?.dataset.blockId) throw new Error('A stable visible reading block is required')
    return { blockId: anchor.dataset.blockId, offset: anchor.getBoundingClientRect().top - header.bottom }
  })
}

async function anchorOffset(page: Page, anchor: Anchor) {
  return row(page, anchor.blockId).evaluate(element => element.getBoundingClientRect().top
    - element.closest('.preview-panel')!.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom)
}

async function expectAnchor(page: Page, anchor: Anchor) {
  await expect.poll(async () => Math.abs(await anchorOffset(page, anchor) - anchor.offset), {
    message: 'The same source block must keep its offset relative to the sticky header within 2px.'
  }).toBeLessThanOrEqual(2)
  await frames(page)
  expect(Math.abs(await anchorOffset(page, anchor) - anchor.offset)).toBeLessThanOrEqual(2)
}

async function installProbe(app: ElectronApplication, options: { rejectOriginal?: string; rejectRenameOnce?: string } = {}) {
  await app.evaluate(({ ipcMain }, options) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('knowbook:update-document')
    if (!original) throw new Error('The real document update handler must exist')
    const probe: Probe = { original, requests: [], rejectOriginal: options.rejectOriginal ?? null, rejectRenameOnce: options.rejectRenameOnce ?? null }
    ;(globalThis as MainGlobal).__knowbookRenameProbe = probe
    ipcMain.removeHandler('knowbook:update-document')
    ipcMain.handle('knowbook:update-document', async (event, documentId: string, input: UpdateDocumentInput) => {
      const request: Request = { documentId, input: structuredClone(input), settled: false }
      probe.requests.push(request)
      try {
        if (input.title === probe.rejectOriginal) throw new Error('Controlled draft IPC failure before renaming.')
        if (input.title === probe.rejectRenameOnce) {
          probe.rejectRenameOnce = null
          probe.rejectOriginal = null
          throw new Error('Controlled rename IPC failure; the current draft is preserved.')
        }
        return await probe.original(event, documentId, input)
      } catch (cause) {
        request.error = cause instanceof Error ? cause.message : String(cause)
        throw cause
      } finally { request.settled = true }
    })
  }, options)
}

async function requests(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as MainGlobal).__knowbookRenameProbe!.requests)
}

async function openRename(page: Page, entry: Entry) {
  const opener = entry === 'title' ? titleButton(page) : page.locator('.document-header-more-button')
  if (entry === 'title') {
    await expect(opener).toHaveAttribute('aria-label', uiText('Rename document', '重命名文档'))
    await clickVisible(page, opener)
  } else {
    await clickVisible(page, opener)
    const menu = page.locator('.document-header-action-menu')
    await expect(menu).toBeVisible()
    await clickVisible(page, menu.getByRole('button', { name: uiText('Rename document', '重命名文档'), exact: true }))
    await expect(menu).toHaveCount(0)
  }
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole('heading', { name: uiText('Rename document', '重命名文档'), exact: true })).toBeVisible()
  await expect(nameField(page)).toBeFocused()
  return opener
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string, anchor?: Anchor) {
  const main = await app.evaluate(({ app, BrowserWindow }) => ({
    userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({
      bounds: window.getBounds(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
    })), requests: (globalThis as MainGlobal).__knowbookRenameProbe?.requests ?? []
  }))
  expect(main.windows).toHaveLength(1)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => ({
    title: document.querySelector('.document-header-title')?.textContent,
    reading: document.querySelector('.document-view-toggle')?.getAttribute('aria-pressed'),
    chapter: document.querySelector('.document-current-heading')?.textContent,
    focusedSection: document.querySelector('.document-section-focus')?.textContent,
    modal: Boolean(document.querySelector('.document-rename-dialog')),
    active: { tag: document.activeElement?.tagName, className: document.activeElement?.className, ariaLabel: document.activeElement?.getAttribute('aria-label') },
    overflow: document.documentElement.scrollWidth - innerWidth,
    scrollTop: document.querySelector('.preview-panel')?.scrollTop
  }))
  expect(state.overflow).toBeLessThanOrEqual(1)
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state, anchor, offset: anchor ? await anchorOffset(page, anchor) : null }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`), animations: 'disabled' })
}

test.describe('Direct document renaming @electron', () => {
  test.beforeEach(() => test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.'))

  for (const [language, width, firstEntry] of [['en-US', 1360, 'more'], ['zh-CN', 760, 'title']] as const) {
    test(`rename and restore a matching article title without losing the middle reading position in ${language} at ${width}px`, async ({}, info) => {
      test.setTimeout(120_000)
      await withElectronApp(async ({ page, app, tempRoot }) => {
        const sample = await seed(page, app, language, width)
        await setReading(page)
        await expect(page.locator('.preview-panel > .document-reading-summary')).toHaveCount(0)
        await expect(page.locator('.document-reading-opening')).toContainText(originalSummary)
        await navigateChapter(page, language)
        await wheelReading(page)
        const anchor = await captureAnchor(page)
        expect(await page.getByTestId('document-scroll-region').evaluate(element => element.scrollTop)).toBeGreaterThan(1000)
        const chapter = await page.locator('.document-current-heading').textContent()
        await installProbe(app)
        await record(page, app, info, 'before-rename', anchor)
        const opener = await openRename(page, firstEntry)
        await expectAnchor(page, anchor)
        const renamed = language === 'zh-CN' ? '中文长篇阅读的新文档名称：改名后仍保留当前章节、摘要与来源文章的标题'
          : 'A new document name for the original article, keeping its chapter, summary and source title intact'
        await nameField(page).fill(renamed)
        await expect(page.locator('.document-header-title')).toHaveText(sample.title)
        expect(await requests(app)).toHaveLength(0)
        await expectAnchor(page, anchor)
        await record(page, app, info, 'local-candidate-before-confirmation', anchor)
        await clickVisible(page, renameButton(page))
        await expect(dialog(page)).toHaveCount(0)
        await expect(opener).toBeFocused()
        await expect(page.locator('.document-header-title')).toHaveText(renamed)
        await expect(page.locator('.document-reading-summary h1')).toHaveText(renamed)
        await expect(page.locator('.document-reading-summary')).toContainText(originalSummary)
        await expect(page.locator('.document-reading-opening')).toHaveCount(0)
        await expect(row(page, 'rename-source-title').locator('h1')).toHaveText(sample.title)
        await expectAnchor(page, anchor)
        const stored = (await page.evaluate(id => window.knowbook.getDocumentDetail(id), sample.documentId))!
        expect(stored.summary).toBe(sample.before.summary)
        expect(stored.blocks).toEqual(sample.before.blocks)
        expect(await requests(app)).toHaveLength(1)
        expect((await requests(app))[0].input.expectedUpdatedAt).toBe(sample.before.updatedAt)
        await record(page, app, info, 'renamed-and-acknowledged', anchor)

        const otherEntry: Entry = firstEntry === 'title' ? 'more' : 'title'
        const otherOpener = await openRename(page, otherEntry)
        await nameField(page).fill(sample.title)
        await clickVisible(page, renameButton(page))
        await expect(dialog(page)).toHaveCount(0)
        await expect(otherOpener).toBeFocused()
        await expect(page.locator('.document-header-title')).toHaveText(sample.title)
        await expect(page.locator('.preview-panel > .document-reading-summary')).toHaveCount(0)
        await expect(page.locator('.document-reading-opening')).toContainText(originalSummary)
        await expectAnchor(page, anchor)
        await expect(page.locator('.document-view-toggle')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('.document-current-heading')).toHaveText(chapter!)
        const restored = (await page.evaluate(id => window.knowbook.getDocumentDetail(id), sample.documentId))!
        expect(restored.blocks).toEqual(sample.before.blocks)
        expect(restored.summary).toBe(sample.before.summary)
        expect(await requests(app)).toHaveLength(2)
        expect((await requests(app))[1].input.expectedUpdatedAt).toBe(stored.updatedAt)
        await record(page, app, info, 'matching-title-restored', anchor)
        await info.attach('isolated-user-data', { body: tempRoot, contentType: 'text/plain' })
      }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
    })
  }

  test('Chinese IME candidates stay local; cancel and unchanged confirmation never write or replay an old reading snapshot', async ({}, info) => {
    test.setTimeout(120_000)
    await withElectronApp(async ({ page, app }) => {
      const sample = await seed(page, app, 'zh-CN', 760)
      await setReading(page)
      await navigateChapter(page, 'zh-CN')
      await wheelReading(page)
      const initial = await captureAnchor(page)
      await installProbe(app)
      const opener = await openRename(page, 'title')
      await nameField(page).press('End')
      const cdp = await page.context().newCDPSession(page)
      try {
        await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 })
        await expect(nameField(page)).toHaveValue(`${sample.title}zhongwen`)
        await page.waitForTimeout(1000)
        expect(await requests(app)).toHaveLength(0)
        expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), sample.documentId))?.title).toBe(sample.title)
        // The real composition stays active while both keys bubble to the dialog.
        for (const key of ['Enter', 'Escape']) await nameField(page).dispatchEvent('keydown', { key, bubbles: true, cancelable: true })
        await expect(dialog(page)).toBeVisible()
        await expect(nameField(page)).toBeFocused()
        expect(await requests(app)).toHaveLength(0)
        await cdp.send('Input.insertText', { text: '中文' })
        await expect(nameField(page)).toHaveValue(`${sample.title}中文`)
        // Browser/platform fallback can mark a key as 229 after compositionend.
        for (const key of ['Enter', 'Escape']) await nameField(page).dispatchEvent('keydown', { key, keyCode: 229, bubbles: true, cancelable: true })
        await expect(dialog(page)).toBeVisible()
        expect(await requests(app)).toHaveLength(0)
      } finally { await cdp.detach() }
      await expectAnchor(page, initial)
      await record(page, app, info, 'ime-committed-but-unconfirmed', initial)
      await clickVisible(page, cancelButton(page))
      await expect(dialog(page)).toHaveCount(0)
      await expect(opener).toBeFocused()
      await expect(page.locator('.document-header-title')).toHaveText(sample.title)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), sample.documentId)).toEqual(sample.before)
      expect(await requests(app)).toHaveLength(0)

      const more = await openRename(page, 'more')
      await expect(nameField(page)).toHaveValue(sample.title)
      await nameField(page).press('Enter')
      await expect(dialog(page)).toHaveCount(0)
      await expect(more).toBeFocused()
      expect(await requests(app)).toHaveLength(0)
      await expectAnchor(page, initial)
      await wheelReading(page, 460)
      const later = await captureAnchor(page)
      expect(later.blockId !== initial.blockId || Math.abs(later.offset - initial.offset) > 20).toBe(true)
      await setReading(page, false)
      await setReading(page, true)
      await expectAnchor(page, later)
      expect(await requests(app)).toHaveLength(0)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), sample.documentId)).toEqual(sample.before)
      await record(page, app, info, 'cancel-followed-by-new-reading-and-mode-roundtrip', later)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: 'zh-CN' })
  })

  test('a real rename IPC failure keeps unsaved body and summary; one retry writes the latest draft and revision', async ({}, info) => {
    test.setTimeout(120_000)
    await withElectronApp(async ({ page, app }) => {
      const sample = await seed(page, app, 'en-US', 1360)
      const candidate = 'Renamed after a controlled IPC failure'
      const summaryDraft = 'Latest summary draft survives both the failed rename and its successful retry.'
      const bodyDraft = 'Latest body draft, never replace it with the stale saved body. '.repeat(10)
      await installProbe(app, { rejectOriginal: sample.title, rejectRenameOnce: candidate })
      await clickVisible(page, page.locator('.document-summary-edit-button'))
      await page.locator('.document-summary-card .editor-textarea').fill(summaryDraft)
      await row(page, 'rename-body-1-1').locator('textarea').fill(bodyDraft)
      await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
      await expect.poll(async () => (await requests(app)).some(request => request.error === draftFailure
        && request.input.summary === summaryDraft && request.input.blocks.some(block => block.id === 'rename-body-1-1' && block.content === bodyDraft))).toBe(true)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), sample.documentId)).toEqual(sample.before)
      await setReading(page)
      await navigateChapter(page, 'en-US')
      await wheelReading(page)
      const anchor = await captureAnchor(page)
      const opener = await openRename(page, 'more')
      await nameField(page).fill(candidate)
      await clickVisible(page, renameButton(page))
      await expect(dialog(page).getByRole('alert')).toContainText(failureMessage)
      await expect(nameField(page)).toHaveValue(candidate)
      await expect(nameField(page)).toBeFocused()
      await expect(page.locator('.document-header-title')).toHaveText(sample.title)
      await expect(page.locator('.document-view-toggle')).toHaveAttribute('aria-pressed', 'true')
      await expectAnchor(page, anchor)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), sample.documentId)).toEqual(sample.before)
      const attemptsBeforeWait = (await requests(app)).length
      // A failed local title intent must not become an automatic rename retry.
      await page.waitForTimeout(1000)
      expect(await requests(app)).toHaveLength(attemptsBeforeWait)
      await record(page, app, info, 'rename-failed-and-latest-draft-kept', anchor)

      await clickVisible(page, renameButton(page))
      await expect(dialog(page)).toHaveCount(0)
      await expect(opener).toBeFocused()
      await expect(page.locator('.document-header-title')).toHaveText(candidate)
      await expectAnchor(page, anchor)
      const renameRequests = (await requests(app)).filter(request => request.input.title === candidate)
      expect(renameRequests).toHaveLength(2)
      expect(renameRequests[0].error).toBe(failureMessage)
      expect(renameRequests[1].error).toBeUndefined()
      for (const request of renameRequests) {
        expect(request.documentId).toBe(sample.documentId)
        expect(request.input.expectedUpdatedAt).toBe(sample.before.updatedAt)
        expect(request.input.summary).toBe(summaryDraft)
        expect(request.input.blocks.find(block => block.id === 'rename-body-1-1')?.content).toBe(bodyDraft)
        expect(request.input.blocks.find(block => block.id === 'rename-source-title')?.content).toBe(sample.title)
      }
      const stored = (await page.evaluate(id => window.knowbook.getDocumentDetail(id), sample.documentId))!
      expect(stored.title).toBe(candidate)
      expect(stored.summary).toBe(summaryDraft)
      expect(stored.blocks).toEqual(sample.before.blocks.map(block => block.id === 'rename-body-1-1' ? { ...block, content: bodyDraft } : block))
      await record(page, app, info, 'rename-retried-with-latest-draft', anchor)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: 'en-US' })
  })

  test('direct renaming inside a focused chapter preserves the chapter, nested fold and source content', async ({}, info) => {
    test.setTimeout(120_000)
    await withElectronApp(async ({ page, app }) => {
      const sample = await seed(page, app, 'zh-CN', 760)
      await setReading(page)
      const popup = await openOutline(page)
      await popup.locator('.outline-filter').fill(sectionTitle('zh-CN', 4))
      await clickVisible(page, popup.getByRole('button', { name: `只看本章：${sectionTitle('zh-CN', 4)}`, exact: true }))
      await expect(page.locator('.document-section-focus')).toContainText(sectionTitle('zh-CN', 4))
      await expect(popup).toHaveCount(0)
      // Entering chapter focus deliberately expands that chapter's nested
      // sections. Establish the user's nested fold after entering focus.
      await expect(row(page, 'rename-body-4-3')).toHaveCount(1)
      await openOutline(page)
      await popup.locator('.outline-filter').fill(subsectionTitle('zh-CN', 4))
      await clickVisible(page, popup.getByRole('button', { name: `折叠章节：${subsectionTitle('zh-CN', 4)}`, exact: true }))
      await page.keyboard.press('Escape')
      await expect(popup).toHaveCount(0)
      await expect(row(page, 'rename-section-1')).toHaveCount(0)
      await expect(row(page, 'rename-body-4-3')).toHaveCount(0)
      await expect(row(page, 'rename-subsection-4').locator('.reading-collapse')).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('.document-reading-summary')).toHaveCount(0)
      const visibleIds = await page.locator('.document-reading-row[data-block-id]').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.blockId))
      await installProbe(app)
      await record(page, app, info, 'focused-chapter-before-rename-with-user-fold')
      const opener = await openRename(page, 'title')
      const renamed = '聚焦章节中的新文档名'
      await nameField(page).fill(renamed)
      await clickVisible(page, renameButton(page))
      await expect(dialog(page)).toHaveCount(0)
      await expect(opener).toBeFocused()
      await expect(page.locator('.document-header-title')).toHaveText(renamed)
      await expect(page.locator('.document-section-focus')).toContainText(sectionTitle('zh-CN', 4))
      await expect(page.locator('.document-view-toggle')).toHaveAttribute('aria-pressed', 'true')
      await expect(row(page, 'rename-subsection-4').locator('.reading-collapse')).toHaveAttribute('aria-expanded', 'false')
      await expect(row(page, 'rename-body-4-3')).toHaveCount(0)
      await expect(page.locator('.document-reading-summary')).toHaveCount(0)
      expect(await page.locator('.document-reading-row[data-block-id]').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.blockId))).toEqual(visibleIds)
      const stored = (await page.evaluate(id => window.knowbook.getDocumentDetail(id), sample.documentId))!
      expect(stored.blocks).toEqual(sample.before.blocks)
      expect(stored.summary).toBe(sample.before.summary)
      expect(await requests(app)).toHaveLength(1)
      await record(page, app, info, 'focused-chapter-renamed-with-fold-retained')
    }, { PLAYWRIGHT_ELECTRON_LOCALE: 'zh-CN' })
  })
})
