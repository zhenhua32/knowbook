import { expect, test, type Page } from '@playwright/test'
import { ensureDocumentMetadataEditor, uiText, withElectronApp } from './helpers/electron'

async function createSample(page: Page, title: string) {
  return page.evaluate(async title => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks: [
      { id: `${id}-body`, type: 'paragraph', content: 'abcdef 中文正文', checked: false, depth: 0 },
      { id: `${id}-table`, type: 'table', content: '| Name | Status |\n| --- | --- |\n| abcdef | Pending |', checked: false, depth: 0 }
    ] })
    return id
  }, title)
}

async function openSample(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}

test('undo and redo preserve block focus and selections, and new typing retires redo immediately @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await createSample(page, '编辑历史一致性')
    await page.reload()
    await openSample(page, '编辑历史一致性')
    const body = page.locator(`[data-block-id="${id}-body"] textarea`)
    await body.focus()
    await body.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(2, 5))
    await body.press('Control+b')
    await expect(body).toHaveValue('ab**cde**f 中文正文')
    await body.press('Control+z')
    await expect(body).toHaveValue('abcdef 中文正文')
    await expect(body).toBeFocused()
    expect(await body.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 5])
    await body.press('Control+y')
    await expect(body).toHaveValue('ab**cde**f 中文正文')
    expect(await body.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([4, 7])
    await body.press('Control+z')
    await body.fill('新分支正文')
    await body.press('Control+y')
    await expect(body).toHaveValue('新分支正文')
    await page.locator('.document-header-more-button').click()
    await expect(page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Redo', '重做'), exact: true })).toBeDisabled()
    await page.locator('.context-menu-overlay').click({ position: { x: 10, y: 10 } })

    await body.focus()
    await body.press('End')
    await body.press('Control+Enter')
    const added = page.locator('.block-inline-textarea').nth(1)
    await expect(added).toBeFocused()
    await added.press('Control+z')
    await expect(page.locator('[data-block-index]')).toHaveCount(2)
    await expect(body).toBeFocused()
    await page.keyboard.type('继续')
    await expect(body).toHaveValue('新分支正文继续')
  })
})

test('table format undo restores the cell selection and keeps subsequent typing in that cell @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await createSample(page, '表格编辑历史一致性')
    await page.reload()
    await openSample(page, '表格编辑历史一致性')
    const table = page.locator(`[data-block-id="${id}-table"] .markdown-table-editor`)
    await table.locator('[data-row="1"][data-column="0"]').click()
    const input = table.locator('textarea')
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 5, 'backward'))
    await input.press('Control+b')
    await expect(input).toHaveValue('ab**cde**f')
    await input.press('Control+z')
    await expect(input).toHaveValue('abcdef')
    await expect(input).toBeFocused()
    expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual([2, 5, 'backward'])
    await input.press('Control+y')
    await expect(input).toHaveValue('ab**cde**f')
    expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([4, 7])
    await input.press('Control+z')
    await page.keyboard.type('新')
    await expect(input).toHaveValue('ab新f')
  })
})

test('properties open at the title, follow the draft heading, and reset for another document @electron', async () => {
  await withElectronApp(async ({ page }) => {
    await createSample(page, '属性一致性一')
    await createSample(page, '属性一致性二')
    await page.reload()
    await openSample(page, '属性一致性一')
    await ensureDocumentMetadataEditor(page)
    const title = page.locator('.document-summary-card .editor-input')
    await expect(title).toBeFocused()
    await title.fill('当前草稿标题')
    await expect(page.locator('.document-header-title')).toHaveText('当前草稿标题')
    await title.press('Escape')
    await expect(page.locator('.document-summary-edit-button')).toBeFocused()
    await expect(page.locator('.document-summary-edit-button')).toHaveAttribute('aria-expanded', 'false')
    await ensureDocumentMetadataEditor(page)
    await page.locator('.tree-button', { hasText: '属性一致性二' }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText('属性一致性二')
    await expect(page.locator('.document-summary-edit-button')).toHaveAttribute('aria-expanded', 'false')
  })
})

test('menu undo reveals a folded chapter and restores its body selection @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: '折叠章节编辑历史', summary: '', blocks: [
        { id: `${id}-heading`, type: 'heading-1', content: '第一章', checked: false, depth: 0 },
        { id: `${id}-body`, type: 'paragraph', content: 'abcdef 中文正文', checked: false, depth: 0 },
        { id: `${id}-next`, type: 'heading-1', content: '第二章', checked: false, depth: 0 }
      ] })
      return id
    })
    await page.reload()
    await openSample(page, '折叠章节编辑历史')
    const body = page.locator(`[data-block-id="${id}-body"] textarea`)
    await body.focus()
    await body.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(2, 5))
    await body.press('Control+b')
    await expect(body).toHaveValue('ab**cde**f 中文正文')
    await page.locator(`[data-block-id="${id}-heading"] .section-collapse-toggle`).click()
    await expect(body).toHaveCount(0)
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
    await expect(body).toHaveValue('abcdef 中文正文')
    await expect(body).toBeFocused()
    expect(await body.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 5])
  })
})

test('a failed workspace refresh after a successful save preserves document undo @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    const id = await createSample(page, '保存后撤销历史')
    await page.reload()
    await openSample(page, '保存后撤销历史')
    await ensureDocumentMetadataEditor(page)
    await page.clock.install()
    await page.clock.pauseAt(new Date())
    await app.evaluate(({ ipcMain }) => {
      process.env.KNOWBOOK_EDITING_REFRESH_ATTEMPTS = '0'
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', () => {
        process.env.KNOWBOOK_EDITING_REFRESH_ATTEMPTS = String(Number(process.env.KNOWBOOK_EDITING_REFRESH_ATTEMPTS) + 1)
        throw new Error('Editing consistency: simulated workspace refresh failure')
      })
    })
    const body = page.locator(`[data-block-id="${id}-body"] textarea`)
    await body.fill('保存成功的新正文')
    await page.locator('.document-summary-card .editor-input').fill('保存成功的新标题')
    await body.press('Control+s')
    await expect.poll(() => app.evaluate(() => Number(process.env.KNOWBOOK_EDITING_REFRESH_ATTEMPTS))).toBeGreaterThan(0)
    await expect(page.locator('.document-save-status')).toHaveClass(/status-saved/)
    // Give the catalog/detail reconciliation time to read the committed revision.
    await page.waitForTimeout(200)
    expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))?.blocks[0].content).toBe('保存成功的新正文')
    await page.locator('.document-header-more-button').click()
    const undo = page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Undo', '撤销'), exact: true })
    await expect(undo).toBeEnabled()
    await undo.click()
    await expect(body).toHaveValue('abcdef 中文正文')
    await expect(page.locator('.document-header-title')).toHaveText('保存成功的新标题')
  })
})
