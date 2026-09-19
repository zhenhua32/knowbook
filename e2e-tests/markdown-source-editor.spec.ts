import { expect, test } from '@playwright/test'
import { withElectronApp, uiText } from './helpers/electron'

test('full Markdown source keeps referenced identities, duplicate edits, history and IME drafts @electron', async () => {
  test.setTimeout(120_000)
  await withElectronApp(async ({ page }) => {
    const { id, original, refId } = await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Source editing', summary: '', blocks: [
        { type: 'paragraph', content: 'Same', checked: false, depth: 0, tags: ['first'], highlight: 'yellow' },
        { type: 'paragraph', content: 'Same', checked: false, depth: 0, tags: ['second'] },
        { type: 'paragraph', content: 'Tail 中文🙂', checked: false, depth: 0 }
      ] })
      const original = (await window.knowbook.getDocumentDetail(id))!.blocks
      const { id: refId } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(refId, { title: 'Source references', summary: '', blocks: [
        { type: 'paragraph', content: `[[Source editing#${original[1].id}]]`, checked: false, depth: 0 }
      ] })
      return { id, original, refId }
    })
    const detail = () => page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
    await page.reload(); await page.locator('.tree-button', { hasText: 'Source editing' }).click()
    const open = async () => {
      await page.locator('.document-header-more-button').click()
      await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    }
    await open()
    const editor = page.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码') })
    await expect(editor).toHaveValue('Same\n\nSame\n\nTail 中文🙂')
    await editor.press('Control+Home')
    await page.keyboard.insertText('Same\n\n')
    await expect(editor).toHaveValue('Same\n\nSame\n\nSame\n\nTail 中文🙂')
    await editor.evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(6, 12))
    await editor.press('Backspace')
    await expect(editor).toHaveValue('Same\n\nSame\n\nTail 中文🙂')
    await page.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true }).click()
    await expect(editor).toHaveCount(0)
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await detail())?.blocks[0].id).not.toBe(original[0].id)
    const changed = (await detail())!.blocks
    expect(changed[1].id, JSON.stringify({ original, changed })).toBe(original[1].id)
    expect(changed[1].tags).toEqual(['second'])
    const links = await page.evaluate(id => window.knowbook.checkDocumentLinks(id), refId)
    expect(links.checkedCount).toBe(1)
    expect(links.issues).toEqual([])
    await page.keyboard.press('Control+z')
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await detail())?.blocks[0].id).toBe(original[0].id)
    await page.keyboard.press('Control+Shift+Z')
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await detail())?.blocks[0].id).toBe(changed[0].id)

    await open(); await editor.press('Control+End')
    const initial = await editor.inputValue()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: '候选', selectionStart: 2, selectionEnd: 2 })
    await expect(editor).toHaveValue(initial + '候选')
    await expect(page.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true })).toBeDisabled()
    await cdp.send('Input.insertText', { text: '输入完成' })
    await expect(editor).toHaveValue(initial + '输入完成')
    await editor.press('Control+z'); await expect(editor).toHaveValue(initial)
    await editor.press('Control+Shift+Z'); await expect(editor).toHaveValue(initial + '输入完成')
    await cdp.send('Input.imeSetComposition', { text: '取消候选', selectionStart: 4, selectionEnd: 4 })
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await expect(editor).toHaveValue(initial + '输入完成')
    await expect(page.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true })).toBeEnabled()
    await editor.press('Alt+F10')
    await expect(page.getByRole('button', { name: uiText('Bold', '粗体'), exact: true }).last()).toBeFocused()
    await page.keyboard.press('Escape'); await expect(editor).toBeFocused()
    await editor.press('Control+s')
    await expect(editor).toHaveCount(0)
    await expect.poll(async () => (await detail())?.blocks[2].content).toBe('Tail 中文🙂输入完成')
    await cdp.detach()
    await page.reload(); await page.locator('.tree-button', { hasText: 'Source editing' }).click()
    await open(); await expect(editor).toHaveValue(initial + '输入完成')
    await editor.press('Control+End'); await page.keyboard.insertText(' discarded')
    await page.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    expect((await detail())?.blocks[2].content).toBe('Tail 中文🙂输入完成')
  })
})
