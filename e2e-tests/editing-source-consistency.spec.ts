import { expect, test, type Page } from '@playwright/test'
import { uiText, withElectronApp } from './helpers/electron'
import { expectSource, selectSource } from './helpers/markdown-source'

async function openSourceSample(page: Page, title: string) {
  const id = await page.evaluate(async title => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks: [
      { id: `${id}-body`, type: 'paragraph', content: 'Alpha 中文😀', checked: false, depth: 0 }
    ] })
    return id
  }, title)
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  await page.locator('.document-header-more-button').click()
  await page.locator('.document-header-action-menu').getByRole('button', {
    name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true
  }).click()
  const dialog = page.locator('.document-markdown-source')
  const editor = dialog.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码') })
  await expect(editor).toBeFocused()
  return { id, dialog, editor }
}

test('unapplied source blocks background navigation and capture while retaining nested shortcut help @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const { id, dialog, editor } = await openSourceSample(page, 'Source shortcut isolation')
    await editor.press('Control+End')
    await page.keyboard.insertText(' retained draft')
    const draft = 'Alpha 中文😀 retained draft'
    const bold = dialog.getByRole('button', { name: uiText('Bold', '粗体'), exact: true })
    await editor.press('Alt+F10')
    await expect(bold).toBeFocused()
    for (const key of ['Control+Shift+f', 'Control+k', 'Control+Shift+p', 'Control+Shift+n',
      ...Array.from({ length: 6 }, (_, index) => `Control+${index + 1}`), 'Alt+ArrowLeft', 'Alt+ArrowRight']) {
      await bold.press(key)
      await expect(dialog).toBeVisible()
      await expect(bold).toBeFocused()
      await expectSource(editor, draft)
      await expect(page.locator('.global-search-modal')).toHaveCount(0)
      await expect(page.locator('.document-quick-capture-dialog')).toHaveCount(0)
      await expect(page.locator('.page-documents')).toBeVisible()
    }
    await bold.press('F1')
    const help = page.locator('.shortcut-help-dialog')
    await expect(help).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await expect(bold).toBeFocused()
    await expectSource(editor, draft)
    await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))?.blocks[0].content).toBe('Alpha 中文😀')
    await expect(page.locator('.document-header-more-button')).toBeFocused()
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', {
      name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true
    }).click()
    await expect(editor).toBeFocused()
    await editor.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.document-header-more-button')).toBeFocused()
  })
})

test('source controls share editor formatting, undo, redo and apply shortcuts without double replay or IME commits @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const { id, dialog, editor } = await openSourceSample(page, 'Source control shortcuts')
    await editor.press('Control+End')
    await page.keyboard.insertText(' edited')
    await selectSource(editor, 0, 5)
    await editor.press('Alt+F10')
    const bold = dialog.getByRole('button', { name: uiText('Bold', '粗体'), exact: true })
    const apply = dialog.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true })
    const cancel = dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true })
    await expect(bold).toBeFocused()
    await bold.press('Control+b')
    await expectSource(editor, '**Alpha** 中文😀 edited')
    await expect(editor).toBeFocused()
    await apply.focus()
    await apply.press('Control+z')
    await expectSource(editor, 'Alpha 中文😀 edited')
    await expect(editor).toBeFocused()
    await cancel.focus()
    await cancel.press('Control+Shift+z')
    await expectSource(editor, '**Alpha** 中文😀 edited')
    await expect(editor).toBeFocused()
    // An editor event must be applied once, even though it also bubbles through
    // the dialog's shared shortcut handler.
    await editor.press('Control+z')
    await expectSource(editor, 'Alpha 中文😀 edited')
    await editor.press('Control+y')
    await expectSource(editor, '**Alpha** 中文😀 edited')
    await editor.press('Control+End')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: '候选', selectionStart: 2, selectionEnd: 2 })
    await expectSource(editor, '**Alpha** 中文😀 edited候选')
    await editor.dispatchEvent('keydown', { key: 's', ctrlKey: true, isComposing: true })
    await editor.dispatchEvent('keydown', { key: 'z', ctrlKey: true, isComposing: true })
    await expect(dialog).toBeVisible()
    await expect(apply).toBeDisabled()
    await expectSource(editor, '**Alpha** 中文😀 edited候选')
    await cdp.send('Input.insertText', { text: '输入完成' })
    await expectSource(editor, '**Alpha** 中文😀 edited输入完成')
    await expect(apply).toBeEnabled()
    await apply.focus()
    await apply.press('Control+s')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.document-header-more-button')).toBeFocused()
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))?.blocks
      .map(block => ({ id: block.id, content: block.content }))).toEqual([
      { id: `${id}-body`, content: '**Alpha** 中文😀 edited输入完成' }
    ])
    await cdp.detach()
  })
})
