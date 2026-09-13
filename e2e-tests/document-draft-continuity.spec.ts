import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeElectronApp, ensureDocumentMetadataEditor, launchElectronApp, uiText, withElectronApp } from './helpers/electron'

async function createSample(page: Page, title: string, long = false) {
  return page.evaluate(async ({ title, long }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks: long
      ? Array.from({ length: 100 }, (_, index) => ({ id: `${id}-block-${index}`, type: index % 10 === 0 ? 'heading-1' : 'paragraph', content: index % 10 === 0 ? `章节 ${index / 10}` : `段落 ${index}。${'稳定位置与中文编辑。'.repeat(30)}`, checked: false, depth: 0 }))
      : [
        { id: `${id}-heading`, type: 'heading-1', content: '输入法标题', checked: false, depth: 0 },
        { id: `${id}-todo`, type: 'todo', content: '', checked: false, depth: 0 },
        { id: `${id}-body`, type: 'paragraph', content: '旧正文', checked: false, depth: 0 }
      ] })
    return id
  }, { title, long })
}

async function openSample(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  await expect(page.locator('[data-block-index]').first()).toBeVisible()
}

async function rowOffset(page: Page, blockId: string) {
  return page.locator(`[data-block-id="${blockId}"]`).evaluate((row) => row.getBoundingClientRect().top
    - row.closest('.preview-panel')!.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom)
}

test('IME candidates never trigger block or global shortcuts and committed text remains editable @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await createSample(page, '输入法回归样本')
    await page.reload()
    await openSample(page, '输入法回归样本')
    const heading = page.locator(`[data-block-id="${id}-heading"] textarea`)
    await heading.click()
    await heading.press('End')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 })
    await expect(heading).toHaveValue('输入法标题zhongwen')
    // Outlast both debounce windows: candidate text is neither saved nor committed to history.
    await page.waitForTimeout(1000)
    expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks[0].content).toBe('输入法标题')
    const allowed = await heading.evaluate((element) => ['Enter', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'Escape', 'z', 'f'].map((key) =>
      element.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: key === 'z' || key === 'f', bubbles: true, cancelable: true }))))
    expect(allowed.every(Boolean)).toBe(true)
    await expect(page.locator('[data-block-index]')).toHaveCount(3)
    await expect(page.locator('.block-find-input')).toHaveCount(0)
    await expect(heading).toBeFocused()
    await cdp.send('Input.insertText', { text: '中文' })
    await expect(heading).toHaveValue('输入法标题中文')
    await expect(heading).toHaveClass(/type-heading-1/)
    await heading.press('Control+z')
    await expect(heading).toHaveValue('输入法标题')
    await heading.press('Control+y')
    await expect(heading).toHaveValue('输入法标题中文')
    await heading.press('Enter')
    await expect(page.locator('[data-block-index]')).toHaveCount(4)

    const todo = page.locator(`[data-block-id="${id}-todo"] textarea`)
    await todo.focus()
    expect(await todo.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', keyCode: 229, bubbles: true, cancelable: true
    })))).toBe(true)
    await expect(todo).toHaveClass(/type-todo/)

    const body = page.locator(`[data-block-id="${id}-body"] textarea`)
    await body.fill('#')
    await cdp.send('Input.imeSetComposition', { text: ' ', selectionStart: 1, selectionEnd: 1 })
    await expect(body).toHaveClass(/type-paragraph/)
    await expect(body).toHaveValue('# ')
    await cdp.send('Input.insertText', { text: '中文正文' })
    await expect(body).toHaveValue('#中文正文')
    await page.keyboard.press('Control+f')
    const search = page.locator('.block-find-input')
    await search.fill('中文')
    await search.dispatchEvent('compositionstart', { data: 'zhongwen' })
    await search.dispatchEvent('keydown', { key: 'Enter' })
    await search.dispatchEvent('keydown', { key: 'Escape' })
    await expect(search).toBeFocused()
    await expect(page.locator('.block-find-count')).toHaveText('1 / 2')
    await search.dispatchEvent('compositionend', { data: '中文' })
    await search.press('Escape')
    await expect(page.locator('.block-find-input')).toHaveCount(0)
    await cdp.detach()
  })
})

test('toolbar and sidebar copy/export include unsaved title and body even after a save failure @electron', async () => {
  await withElectronApp(async ({ page, app, tempRoot }) => {
    const id = await createSample(page, '草稿导出样本')
    await page.reload()
    await openSample(page, '草稿导出样本')
    const filePath = join(tempRoot, 'draft-export.md')
    await app.evaluate(({ ipcMain, dialog }, filePath) => {
      ipcMain.removeHandler('knowbook:update-document')
      process.env.KNOWBOOK_E2E_SAVE_ATTEMPTS = '0'
      ipcMain.handle('knowbook:update-document', () => {
        process.env.KNOWBOOK_E2E_SAVE_ATTEMPTS = String(Number(process.env.KNOWBOOK_E2E_SAVE_ATTEMPTS) + 1)
        throw new Error('Simulated save failure')
      })
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        process.env.KNOWBOOK_E2E_EXPORT_DEFAULT_PATH = (args.at(-1) as { defaultPath: string }).defaultPath
        return { canceled: false, filePath }
      }) as typeof dialog.showSaveDialog
    }, filePath)
    await ensureDocumentMetadataEditor(page)
    await page.locator('.document-summary-card .editor-input').first().fill('最新草稿标题')
    const body = page.locator(`[data-block-id="${id}-body"] textarea`)
    await body.fill('尚未保存的正文')
    await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Copy MD', '复制 Markdown') }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('# 最新草稿标题')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('尚未保存的正文')
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
    await expect.poll(() => { try { return readFileSync(filePath, 'utf8') } catch { return '' } }).toContain('尚未保存的正文')
    expect(await app.evaluate(() => process.env.KNOWBOOK_E2E_EXPORT_DEFAULT_PATH)).toMatch(/最新草稿标题\.md$/)
    expect(await app.evaluate(() => process.env.KNOWBOOK_E2E_SAVE_ATTEMPTS)).toBe('1')

    await body.fill('侧栏菜单的最新草稿')
    await page.locator('.tree-button', { hasText: '草稿导出样本' }).first().click({ button: 'right' })
    await page.locator('.document-tree-context-menu').getByRole('button', { name: uiText('Copy MD', '复制 Markdown') }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('侧栏菜单的最新草稿')
    await page.locator('.tree-button', { hasText: '草稿导出样本' }).first().click({ button: 'right' })
    await page.locator('.document-tree-context-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
    await expect.poll(() => readFileSync(filePath, 'utf8')).toContain('侧栏菜单的最新草稿')
    expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.title).toBe('草稿导出样本')
    await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
    expect(await app.evaluate(() => process.env.KNOWBOOK_E2E_SAVE_ATTEMPTS)).toBe('2')
    await page.locator('.document-header-save-button').click()
    await expect.poll(() => app.evaluate(() => process.env.KNOWBOOK_E2E_SAVE_ATTEMPTS)).toBe('3')
    await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
    await page.screenshot({ path: 'test-results/document-save-failure.png' })
  })
})

test('stable reading anchors survive navigation, inserted content and a full Electron restart @electron', async () => {
  test.setTimeout(120_000)
  let context = await launchElectronApp()
  try {
    let { page } = context
    const id = await createSample(page, '位置记忆样本', true)
    await createSample(page, '另一个文档')
    await page.reload()
    await openSample(page, '位置记忆样本')
    // Consume an outline request; it must not be replayed when we later return.
    await page.locator('.document-outline-control > button').click()
    await page.locator('.toc-item', { hasText: '章节 3' }).click()
    const anchor = `${id}-block-62`
    await page.getByTestId('document-scroll-region').dispatchEvent('wheel')
    await page.locator(`[data-block-id="${anchor}"]`).evaluate((row) => {
      const panel = row.closest('.preview-panel')!
      panel.scrollTop += row.getBoundingClientRect().top - panel.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom - 12
    })
    await expect.poll(() => rowOffset(page, anchor)).toBeGreaterThan(8)
    await expect.poll(() => rowOffset(page, anchor)).toBeLessThan(16)
    await page.keyboard.press('Control+2')
    await expect(page.getByTestId('document-scroll-region')).toHaveCount(0)
    await page.keyboard.press('Control+1')
    await expect.poll(() => rowOffset(page, anchor)).toBeGreaterThan(8)
    await expect.poll(() => rowOffset(page, anchor)).toBeLessThan(16)
    await openSample(page, '另一个文档')
    // Modify preceding structure while the first document is closed.
    await page.evaluate(async (id) => {
      const detail = (await window.knowbook.getDocumentDetail(id))!
      await window.knowbook.updateDocument(id, { title: detail.title, summary: detail.summary, blocks: [
        { type: 'paragraph', content: '插入在前面的新内容。'.repeat(300), checked: false, depth: 0 }, ...detail.blocks
      ] })
    }, id)
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(page.locator(`[data-block-id="${anchor}"]`)).toBeVisible()
    await expect.poll(() => rowOffset(page, anchor)).toBeGreaterThan(8)
    await expect.poll(() => rowOffset(page, anchor)).toBeLessThan(16)
    await page.locator('.document-view-toggle').click()
    await expect.poll(() => rowOffset(page, anchor)).toBeLessThan(16)
    await expect.poll(() => rowOffset(page, anchor)).toBeGreaterThan(8)
    await page.reload()
    await openSample(page, '位置记忆样本')
    await expect.poll(() => rowOffset(page, anchor)).toBeLessThan(16)
    await expect.poll(() => rowOffset(page, anchor)).toBeGreaterThan(8)
    await openSample(page, '另一个文档')
    const { tempRoot } = context
    await closeElectronApp(context, { preserveUserData: true })
    context = await launchElectronApp({}, { userDataRoot: tempRoot })
    page = context.page
    await openSample(page, '位置记忆样本')
    await expect.poll(() => rowOffset(page, anchor)).toBeLessThan(16)
    await expect.poll(() => rowOffset(page, anchor)).toBeGreaterThan(8)
    await page.locator('.document-outline-control > button').click()
    await page.locator('.toc-item', { hasText: '章节 1' }).click()
    await expect.poll(() => rowOffset(page, `${id}-block-10`)).toBeLessThan(20)
    await expect.poll(() => rowOffset(page, `${id}-block-10`)).toBeGreaterThan(8)
  } finally {
    await closeElectronApp(context)
  }
})
