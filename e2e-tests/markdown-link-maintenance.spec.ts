import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withElectronApp, uiText } from './helpers/electron'

test('heading and document edits maintain links across a real UI move and reload @electron', async () => {
  test.setTimeout(150_000)
  await withElectronApp(async ({ page }) => {
    const ids = await page.evaluate(async () => {
      const create = async (title: string, blocks: Array<{ type: string; content: string }>, parent: string | null = null) => {
        const { id } = await window.knowbook.createDocument(parent)
        await window.knowbook.updateDocument(id, { title, summary: '', blocks: blocks.map((block) => ({ ...block, checked: false, depth: 0 })) })
        return id
      }
      const archive = await create('Link Archive', [])
      const target = await create('Link Target', [{ type: 'heading-2', content: '安装' }, { type: 'paragraph', content: 'First' }, { type: 'heading-2', content: '安装' }, { type: 'paragraph', content: 'Second' }])
      const source = await create('Link Source', [{ type: 'paragraph', content: '[第一章](Link%20Target.md#安装) [第二章](Link%20Target.md#安装-1) [[Link Target]]' }])
      return { archive, target, source }
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Link Target' }).first().click()
    await page.locator('textarea.type-heading-2').last().fill('下一步')
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), ids.source))?.blocks[0].content).toContain('#%E4%B8%8B%E4%B8%80%E6%AD%A5')
    await page.locator('.document-summary-edit-button').click()
    await page.locator('.document-summary-card .editor-input').fill('Link Renamed')
    await page.locator('.document-header-save-button').click()
    await expect(page.locator('.document-header-title')).toHaveText('Link Renamed')
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-menu-select').selectOption(ids.archive)
    await page.locator('.document-header-menu-move-button').click()
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), ids.target))?.path).toBe('Link Archive/Link Renamed')
    const source = await page.evaluate((id) => window.knowbook.getDocumentDetail(id), ids.source)
    expect(source!.blocks[0].content).toContain('Link%20Archive/Link%20Renamed.md')
    expect(source!.blocks[0].content).toContain('[[Link Archive/Link Renamed]]')
    expect((await page.evaluate((id) => window.knowbook.checkDocumentLinks(id), ids.source)).issues).toEqual([])
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Link Source' }).first().click()
    await page.locator('.document-view-toggle').click()
    await page.locator('.document-reading-content .inline-link', { hasText: '第二章' }).click()
    await expect(page.locator('.document-header-title')).toHaveText('Link Renamed')
    await expect(page.locator('.document-reading-row.type-heading-2').last()).toBeInViewport()
    await expect(page.locator('.document-reading-row.type-heading-2').last()).toContainText('下一步')
  })
})

test('link check saves the draft, diagnoses hidden content, restores focus and exports the entire folded document @electron', async () => {
  test.setTimeout(150_000)
  await withElectronApp(async ({ app, page, tempRoot }) => {
    const id = await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Check links sample', summary: '', blocks: [
        { type: 'heading-1', content: 'Hidden section', checked: false, depth: 0 },
        { type: 'paragraph', content: '[Broken](Missing.md#chapter)', checked: false, depth: 0 },
        { type: 'paragraph', content: '[Web](https://example.com)', checked: false, depth: 0 }
      ] })
      return id
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Check links sample' }).first().click()
    await page.locator('textarea.type-paragraph').first().fill('[Broken](Missing.md#chapter) [Bad heading](#absent)')
    const check = async () => {
      await page.locator('.document-header-more-button').click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Check links', '检查链接'), exact: true }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('dialog').getByRole('status')).toContainText(/found 2 issues|发现 2 处问题/)
    }
    await check()
    expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))!.blocks[1].content).toContain('[Bad heading](#absent)')
    await expect(page.getByRole('dialog')).toContainText(/Document not found|找不到文档/)
    await expect(page.getByRole('dialog')).toContainText(/Heading not found|找不到章节/)
    const again = page.getByRole('dialog').getByRole('button', { name: uiText('Check again', '重新检查'), exact: true })
    await again.focus(); await page.keyboard.press('Tab')
    await expect(page.getByRole('dialog').getByRole('button', { name: uiText('Close', '关闭'), exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab'); await expect(again).toBeFocused()
    await again.click()
    await expect(page.getByRole('dialog').getByRole('status')).toContainText(/found 2 issues|发现 2 处问题/)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.document-header-more-button')).toBeFocused()
    await page.locator('.document-view-toggle').click()
    const collapse = page.locator('.document-reading-row.type-heading-1 .reading-collapse')
    await collapse.click()
    await expect(page.locator('.document-reading-content .inline-link', { hasText: 'Broken' })).toHaveCount(0)
    const output = join(tempRoot, 'folded.md')
    await app.evaluate(({ dialog }, output) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: output })) as typeof dialog.showSaveDialog
    }, output)
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
    await expect.poll(() => { try { return readFileSync(output, 'utf8') } catch { return '' } }).toContain('[Bad heading](#absent)')
    expect(readFileSync(output, 'utf8')).toContain('[Web](https://example.com)')
    await check()
    await page.getByRole('dialog').getByRole('button', { name: /Missing\.md/ }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.document-reading-content .inline-link', { hasText: 'Broken' })).toBeVisible()
    await check()
    await page.screenshot({ path: 'test-results/markdown-link-check.png' })
  })
})
