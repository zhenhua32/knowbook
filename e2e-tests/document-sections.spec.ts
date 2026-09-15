import { expect, test, type Page } from '@playwright/test'
import { closeElectronApp, launchElectronApp, uiText, withElectronApp } from './helpers/electron'

async function seed(page: Page) {
  const id = await page.evaluate(async () => {
    const { id } = await window.knowbook.createDocument(null)
    const b = (key: string, type: import('../src/shared/contracts').DocumentBlockDraft['type'], content: string, depth = 0, parentBlockId: string | null = null) => ({ id: `${id}-${key}`, type, content, depth, parentBlockId, checked: false })
    await window.knowbook.updateDocument(id, { title: '章节折叠样本', summary: '标题、嵌套列表与跨章引用', blocks: [
      b('intro', 'paragraph', '文档前言'),
      b('a', 'heading-1', '第一章'), b('a-body', 'paragraph', '第一章正文与编辑选区'),
      b('a1', 'heading-2', '第一节'), b('a1-body', 'paragraph', '第一节正文'),
      b('list', 'bulleted-list', '嵌套列表'), b('child', 'bulleted-list', '嵌套唯一命中', 1, `${id}-list`),
      b('a2', 'heading-2', '第二节'), b('a2-body', 'paragraph', `第二节正文，跳转 [[章节折叠样本#${id}-b-body]]`),
      b('b', 'heading-1', '第二章'), b('b-body', 'paragraph', '第二章唯一命中'),
      b('b1', 'heading-2', '第三节'), b('b1-body', 'paragraph', '第三节正文'),
      b('c', 'heading-1', '第三章'), b('c-body', 'paragraph', '第三章正文')
    ] })
    return id
  })
  await page.reload()
  await page.locator('.tree-button', { hasText: '章节折叠样本' }).first().click()
  await expect(page.locator('[data-block-index]')).toHaveCount(15)
  return id
}

const row = (page: Page, id: string, key: string) => page.locator(`[data-block-id="${id}-${key}"]`)
async function outline(page: Page) {
  if (!await page.locator('.document-outline-popover').isVisible()) await page.locator('.document-outline-control > button').click()
  return page.locator('.document-outline-popover')
}

test('chapter ranges fold in editing and reading without changing document content @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await seed(page)
    const before = await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id)
    await row(page, id, 'a').locator('.section-collapse-toggle').click()
    await expect(row(page, id, 'a-body')).toHaveCount(0)
    await expect(row(page, id, 'a1')).toHaveCount(0)
    await expect(row(page, id, 'b')).toBeVisible()
    await row(page, id, 'a').locator('.section-collapse-toggle').click()
    await row(page, id, 'a1').locator('.section-collapse-toggle').click()
    await expect(row(page, id, 'list')).toHaveCount(0)
    await expect(row(page, id, 'a2-body')).toBeVisible()
    let menu = await outline(page)
    await menu.getByRole('button', { name: uiText('Fold all', '全部折叠') }).click()
    await expect(page.locator('[data-block-index]')).toHaveCount(4)
    await menu.getByRole('button', { name: uiText('Expand all', '全部展开') }).click()
    await expect(page.locator('[data-block-index]')).toHaveCount(15)
    await page.locator('.document-outline-control > button').click()
    await row(page, id, 'a').hover()
    await page.screenshot({ path: 'test-results/chapter-editor.png' })
    await page.locator('.document-view-toggle').click()
    await row(page, id, 'a').locator('.reading-collapse').click()
    await expect(row(page, id, 'a2')).toHaveCount(0)
    await row(page, id, 'a').locator('.reading-collapse').click()
    await expect(page.locator('[data-block-index]')).toHaveCount(15)
    menu = await outline(page)
    await page.screenshot({ path: 'test-results/chapter-outline.png' })
    expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks).toEqual(before?.blocks)
  })
})

test('folding parks and restores text selections and protects hidden block selections @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await seed(page)
    const body = row(page, id, 'a-body').locator('textarea')
    await body.click()
    await body.press('Home')
    for (let index = 0; index < 3; index++) await body.press('Shift+ArrowRight')
    await row(page, id, 'a').locator('.section-collapse-toggle').click()
    await expect(row(page, id, 'a-body')).toHaveCount(0)
    await expect(row(page, id, 'a').locator('textarea')).toBeFocused()
    await row(page, id, 'a').locator('.section-collapse-toggle').click()
    await expect(body).toBeFocused()
    expect(await body.evaluate((element) => { const input = element as HTMLTextAreaElement; return [input.selectionStart, input.selectionEnd] })).toEqual([0, 3])
    await body.click()
    await row(page, id, 'a1-body').locator('textarea').click({ modifiers: ['Shift'] })
    await expect(page.locator('.block-selection-toolbar')).toBeVisible()
    await row(page, id, 'a1').locator('.section-collapse-toggle').click()
    await expect(page.locator('.block-selection-toolbar')).toHaveCount(0)
    // Nested folds must retain the original selection while the outer fold changes.
    await row(page, id, 'a').locator('.section-collapse-toggle').click()
    await row(page, id, 'a').locator('.section-collapse-toggle').click()
    await row(page, id, 'a1').locator('.section-collapse-toggle').click()
    await expect(page.locator('.block-selection-toolbar')).toBeVisible()
    await page.keyboard.press('Escape')
    await row(page, id, 'a').locator('.section-collapse-toggle').click()
    const heading = row(page, id, 'a').locator('textarea')
    await heading.click()
    await heading.press('End')
    await heading.press('ArrowDown')
    await expect(row(page, id, 'b').locator('textarea')).toBeFocused()
    // Editing after a folded heading must reveal the newly inserted paragraph.
    await heading.click()
    await heading.press('End')
    await heading.press('Enter')
    await expect(row(page, id, 'a-body')).toBeVisible()
    const inserted = page.locator('[data-block-index="2"] textarea')
    await expect(inserted).toBeFocused()
    await expect(inserted).toHaveValue('')
    await page.keyboard.insertText('折叠后新增段落')
    await expect(inserted).toHaveValue('折叠后新增段落')
  })
})

test('focus scopes block selection and deletion to the chapter and reveals nested search results @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    const id = await seed(page)
    await row(page, id, 'list').hover()
    await row(page, id, 'list').locator('.block-collapse-toggle').click()
    await expect(row(page, id, 'child')).toHaveCount(0)
    let menu = await outline(page)
    await menu.getByRole('button', { name: '只看本章：第二章', exact: true }).click()
    await page.keyboard.press('Control+f')
    await page.locator('.block-find-input').fill('嵌套唯一命中')
    await page.locator('.block-find-input').press('Enter')
    await expect(page.locator('.document-section-focus')).toContainText('第一节')
    await expect(row(page, id, 'child')).toBeVisible()
    await page.locator('.block-find-input').press('Escape')
    // The footer creates a paragraph even when this section ends in a nested list.
    await page.getByRole('button', { name: uiText('Add block', '新增块'), exact: true }).click()
    await expect(page.locator('.block-inline-textarea').last()).toBeFocused()
    await expect(page.locator('.block-inline-textarea:focus')).toHaveClass(/type-paragraph/)
    await page.keyboard.insertText('节末新增正文')
    menu = await outline(page)
    await menu.getByRole('button', { name: '只看本章：第一章', exact: true }).click()
    const body = row(page, id, 'a-body').locator('textarea')
    await body.click()
    await body.press('Control+a')
    await body.press('Control+a')
    await expect(page.locator('.block-editor-row-selected')).toHaveCount(9)
    await page.keyboard.press('Control+c')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('第一章正文与编辑选区')
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copied).not.toContain('文档前言')
    expect(copied).not.toContain('第二章唯一命中')
    await page.keyboard.press('Delete')
    await expect(page.locator('.document-section-focus')).toHaveCount(0)
    await expect(row(page, id, 'intro')).toBeVisible()
    await expect(row(page, id, 'b-body')).toBeVisible()
    await expect(row(page, id, 'a')).toHaveCount(0)
  })
})

test('folding ends composition before hiding the editor so autosave can resume @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await seed(page)
    const body = row(page, id, 'a-body').locator('textarea')
    await body.click()
    await body.dispatchEvent('compositionstart', { data: '' })
    await body.fill('收起时输入的文字')
    await row(page, id, 'a').locator('.section-collapse-toggle').click()
    await expect(row(page, id, 'a-body')).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks.find((block) => block.id === `${id}-a-body`)?.content).toBe('收起时输入的文字')
    await expect(page.locator('.document-save-status')).toHaveClass(/status-saved/)
  })
})

test('a cross-document reference restores preferences then reveals its hidden target @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await seed(page)
    await page.evaluate(async (id) => {
      const source = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(source.id, { title: '引用入口', summary: '', blocks: [
        { type: 'paragraph', content: `[[章节折叠样本#${id}-a1-body]]`, depth: 0, checked: false }
      ] })
    }, id)
    await page.reload()
    await page.locator('.tree-button', { hasText: '章节折叠样本' }).first().click()
    await row(page, id, 'a').locator('.section-collapse-toggle').click()
    const menu = await outline(page)
    await menu.getByRole('button', { name: '只看本章：第二章', exact: true }).click()
    await page.locator('.tree-button', { hasText: '引用入口' }).first().click()
    await expect(page.locator('.document-section-focus')).toHaveCount(0)
    await page.locator('.document-view-toggle').click()
    await page.locator('.document-reading-row').getByRole('button', { name: new RegExp('章节折叠样本#') }).click()
    await expect(page.locator('.document-section-focus')).toContainText('第一节')
    await expect(row(page, id, 'a1-body')).toBeVisible()
    await expect(row(page, id, 'b')).toHaveCount(0)
  })
})

test('focus follows search and references, scopes editing, and persists with folds across restart @electron', async () => {
  test.setTimeout(120_000)
  let context = await launchElectronApp()
  try {
    let { page } = context
    const id = await seed(page)
    let menu = await outline(page)
    await menu.getByRole('button', { name: '只看本章：第一章', exact: true }).click()
    await expect(page.locator('.document-section-focus')).toContainText('第一章')
    await expect(page.locator('[data-block-index]')).toHaveCount(8)
    await expect(row(page, id, 'intro')).toHaveCount(0)
    await expect(row(page, id, 'b')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/chapter-focus.png' })
    await page.getByRole('button', { name: uiText('Add block', '新增块'), exact: true }).click()
    await expect(page.locator('.block-inline-textarea').last()).toBeFocused()
    await page.keyboard.insertText('仅在第一章追加')
    await expect(page.locator('.block-inline-textarea:focus')).toHaveValue('仅在第一章追加')
    await expect(page.locator('[data-block-index]')).toHaveCount(9)
    await page.keyboard.press('Control+f')
    await page.locator('.block-find-input').fill('第二章唯一命中')
    await page.locator('.block-find-input').press('Enter')
    await expect(page.locator('.document-section-focus')).toContainText('第二章')
    await expect(row(page, id, 'b-body')).toBeVisible()
    await expect(page.locator('.block-find-input')).toBeFocused()
    await page.locator('.block-find-input').press('Escape')
    menu = await outline(page)
    await menu.getByRole('button', { name: '只看本章：第二节', exact: true }).click()
    await page.locator('.document-view-toggle').click()
    await row(page, id, 'a2-body').getByRole('button', { name: new RegExp('章节折叠样本#') }).click()
    await expect(page.locator('.document-section-focus')).toContainText('第二章')
    await expect(row(page, id, 'b-body')).toBeVisible()
    await page.locator('.document-section-focus button').click()
    await row(page, id, 'a').locator('.reading-collapse').click()
    await expect(row(page, id, 'a1')).toHaveCount(0)
    await page.reload()
    await page.locator('.tree-button', { hasText: '章节折叠样本' }).first().click()
    await expect(row(page, id, 'a1')).toHaveCount(0)
    await expect(row(page, id, 'a').locator('.section-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    menu = await outline(page)
    await menu.getByRole('button', { name: '只看本章：第二章', exact: true }).click()
    const { tempRoot } = context
    await closeElectronApp(context, { preserveUserData: true })
    context = await launchElectronApp({}, { userDataRoot: tempRoot })
    page = context.page
    await page.locator('.tree-button', { hasText: '章节折叠样本' }).first().click()
    await expect(page.locator('.document-section-focus')).toContainText('第二章')
    await expect(row(page, id, 'a')).toHaveCount(0)
    await page.locator('.document-section-focus button').click()
    await expect(row(page, id, 'a1')).toHaveCount(0)
    await expect(row(page, id, 'b-body')).toBeVisible()
  } finally { await closeElectronApp(context) }
})
