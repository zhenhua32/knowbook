import { expect, test, type Page } from '@playwright/test'
import { withElectronApp } from './helpers/electron'

async function seedLongDocument(page: Page) {
  const id = await page.evaluate(async () => {
    const { id } = await window.knowbook.createDocument(null)
    const blocks: import('../src/shared/contracts').DocumentBlockDraft[] = []
    for (let section = 0; section < 40; section++) {
      blocks.push({ id: `heading-${section}`, type: 'heading-1', content: `第 ${section + 1} 章 · 长文档体验`, checked: false, depth: 0 })
      blocks.push({ type: 'heading-2', content: `章节 ${section + 1} 的背景与设计`, checked: false, depth: 0 })
      for (let paragraph = 0; paragraph < 12; paragraph++) {
        blocks.push({ type: 'paragraph', content: `段落 ${section}-${paragraph}。${'复杂长文档需要稳定的阅读位置、清晰的章节导航，以及流畅的编辑体验。'.repeat(5)} **关键结论**，检索标记 ${section}-${paragraph}。`, checked: false, depth: 0 })
      }
      blocks.push({ type: 'code', content: 'const position = { chapter: 1, offset: 24 };\nconsole.log(position);', language: 'typescript', checked: false, depth: 0 })
      blocks.push({ type: 'table', content: '| 指标 | 目标 |\n| --- | --- |\n| 阅读位置 | 稳定 |\n| 导航 | 可达 |', checked: false, depth: 0 })
    }
    blocks.push({ id: 'parent-list', type: 'bulleted-list', content: '折叠的附录', checked: false, depth: 0 })
    blocks.push({ id: 'hidden-child', parentBlockId: 'parent-list', type: 'bulleted-list', content: '折叠内的唯一命中', checked: false, depth: 1 })
    await window.knowbook.updateDocument(id, { title: '复杂长文档体验样本', summary: '40 章 · 642 个内容块 · 标题、正文、代码、表格与嵌套列表', blocks })
    return id
  })
  await page.reload()
  await page.locator('.tree-button', { hasText: '复杂长文档体验样本' }).first().click()
  await expect(page.locator('[data-block-index]')).toHaveCount(642)
  return id
}

async function topInCanvas(page: Page, index: number) {
  return page.locator(`[data-block-index="${index}"]`).evaluate((row) => {
    const panel = row.closest('.preview-panel')!
    return row.getBoundingClientRect().top - panel.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom
  })
}

test('long document keeps navigation, search and reading position usable @electron', async () => {
  test.setTimeout(120_000)
  await withElectronApp(async ({ page }) => {
    await seedLongDocument(page)
    await page.locator('.document-outline-control > button').click()
    await page.locator('.outline-filter').fill('章节 30')
    await expect(page.locator('.toc-item')).toHaveCount(2)
    await page.locator('.toc-item', { hasText: '章节 30 的背景' }).click()
    const index = 29 * 16 + 1
    await expect.poll(() => topInCanvas(page, index)).toBeGreaterThanOrEqual(10)
    await expect.poll(() => topInCanvas(page, index)).toBeLessThan(20)
    await expect(page.locator('.document-current-heading')).toHaveText('章节 30 的背景与设计')
    await expect(page.locator('.block-inline-textarea:focus')).toHaveCount(0)
    const before = await topInCanvas(page, index)
    await page.locator('.document-view-toggle').click()
    await expect(page.locator('.document-reading-row')).toHaveCount(642)
    await expect(page.locator('.block-inline-textarea')).toHaveCount(0)
    await expect.poll(async () => Math.abs(await topInCanvas(page, index) - before)).toBeLessThan(4)
    await expect(page.locator('.document-reading-row strong').first()).toHaveText('关键结论')
    await expect(page.locator('.block-markdown-table')).toHaveCount(40)
    await page.screenshot({ path: 'test-results/long-document-reading.png' })
    await page.locator('.document-view-toggle').click()
    await expect(page.locator('.block-inline-textarea')).toHaveCount(642)
    await expect.poll(async () => Math.abs(await topInCanvas(page, index) - before)).toBeLessThan(4)

    await page.keyboard.press('Control+f')
    const input = page.locator('.block-find-input')
    await expect(input).toBeFocused()
    await input.fill('检索标记')
    await expect(page.locator('.block-find-count')).toHaveText('1 / 480')
    await expect(page.locator('.block-find-result')).toHaveCount(60)
    await input.press('Enter')
    await expect(input).toBeFocused()
    await expect.poll(() => topInCanvas(page, 2)).toBeLessThan(20)
    await input.press('Enter')
    await expect(page.locator('.block-find-count')).toHaveText('2 / 480')
    await input.fill('不存在的内容')
    await input.press('Enter')
    await expect(page.locator('.block-find-result')).toHaveCount(0)
    await input.press('Escape')
    await expect(page.locator('.block-find-panel')).toHaveCount(0)

    // A target hidden by a collapsed list must be revealed before navigation.
    const parent = page.locator('[data-block-id="parent-list"]')
    await parent.locator('.block-collapse-toggle').click()
    await expect(page.locator('[data-block-id="hidden-child"]')).toHaveCount(0)
    await page.keyboard.press('Control+f')
    await input.fill('折叠内的唯一命中')
    await input.press('Enter')
    await expect(page.locator('[data-block-id="hidden-child"]')).toBeVisible()
    await expect(input).toBeFocused()
  })
})

test('long document reflows textareas after width changes and preserves editing scroll @electron', async () => {
  test.setTimeout(120_000)
  await withElectronApp(async ({ page, app }) => {
    const id = await seedLongDocument(page)
    await page.locator('.document-outline-control > button').click()
    await page.locator('.outline-filter').fill('章节 35')
    await page.locator('.toc-item', { hasText: '章节 35 的背景' }).click()
    const index = 34 * 16 + 2
    const editor = page.locator(`[data-block-index="${index}"] textarea`)
    await editor.click()
    await editor.press('End')
    const before = await page.getByTestId('document-scroll-region').evaluate((panel) => panel.scrollTop)
    const inputStarted = Date.now()
    await editor.pressSequentially(' stable-edit ')
    await page.keyboard.insertText('编辑稳定性检查')
    expect(Date.now() - inputStarted).toBeLessThan(5000)
    const after = await page.getByTestId('document-scroll-region').evaluate((panel) => panel.scrollTop)
    expect(Math.abs(after - before)).toBeLessThan(80)
    const initialWidth = await editor.evaluate((element) => element.clientWidth)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800))
    await expect.poll(() => editor.evaluate((element) => element.clientWidth)).toBeLessThan(initialWidth)
    await expect.poll(() => editor.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight))).toBeLessThanOrEqual(2)
    await page.keyboard.insertText('继续输入')
    await page.locator('.document-view-toggle').click()
    await expect(page.locator(`[data-block-index="${index}"]`)).toContainText('编辑稳定性检查继续输入')
    await page.keyboard.press('Control+z')
    await expect(page.locator(`[data-block-index="${index}"]`)).toContainText('编辑稳定性检查继续输入')
    await expect.poll(() => page.evaluate(async (documentId) => (await window.knowbook.getDocumentDetail(documentId))?.blocks.find((block) => block.content.includes('编辑稳定性检查继续输入'))?.content, id)).toBeTruthy()
  })
})
