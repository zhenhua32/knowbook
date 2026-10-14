import { expect, test, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { closeElectronApp, launchElectronApp, uiText } from './helpers/electron'

type Mode = 'rich' | 'markdown'
const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0 })
const menu = (page: Page) => page.locator('.block-context-menu[aria-label="Block actions"], .block-context-menu[aria-label="内容块操作"]')
async function createDocument(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  return page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
}
async function openDocument(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
async function waitForHistory(page: Page, action: 'Undo' | 'Redo') {
  await page.locator('.document-header-more-button').click()
  const popup = page.locator('.document-header-action-menu')
  await expect(popup.getByRole('button', { name: uiText(action, action === 'Undo' ? '撤销' : '重做'), exact: true })).toBeEnabled()
  await popup.press('Escape')
  await expect(popup).toHaveCount(0)
}
async function savedIds(page: Page, documentId: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(block => block.id), documentId)
}
async function focusBody(page: Page, mode: Mode, id: string) {
  if (mode === 'markdown') await page.locator(`[data-block-id="${id}"] .block-inline-textarea`).focus()
  else await page.locator('.knowbook-rich-text-editor').focus()
}

for (const mode of ['markdown', 'rich'] as const) test(`${mode} shared block menu copies a stable link and moves a complete subtree with paired undo and redo @electron`, async () => {
  test.setTimeout(120000)
  const context = await launchElectronApp({}, { editorMode: mode })
  try {
    const { page, app } = context
    await page.setViewportSize({ width: 1360, height: 1000 })
    const title = `Block actions ${mode}`, targetTitle = `Destination ${mode}`
    const owner = `menu-${mode}-owner`, child = `menu-${mode}-child`, tail = `menu-${mode}-tail`, destination = `menu-${mode}-destination`
    const sourceId = await createDocument(page, title, [
      { id: owner, type: 'bulleted-list', content: 'Move this parent', checked: false, depth: 0 },
      { id: child, type: 'numbered-todo', content: 'Keep child identity and state', checked: true, depth: 1, parentBlockId: owner },
      paragraph(tail, 'Source stays here')
    ])
    const targetId = await createDocument(page, targetTitle, [paragraph(destination, 'Destination stays here')])
    await page.reload()
    await openDocument(page, title)
    const ownerRow = page.locator(`.block-editor-row[data-block-id="${owner}"]`)
    await ownerRow.click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await expect(menu(page).getByRole('button', { name: uiText('Heading 6', '六级标题'), exact: true })).toBeVisible()
    await menu(page).getByRole('button', { name: uiText('Copy block links', '复制块链接'), exact: true }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain(`#^${owner}`)
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copied).toContain(title)
    await expect(menu(page)).toHaveCount(0)

    if (mode === 'rich') {
      const editor = page.locator('.knowbook-rich-text-editor')
      // The first native right-click above exercises a cold menu chunk. The
      // initiating gesture may place a caret, but later activity cancels it.
      for (const laterActivity of ['foreign-focus', 'window-blur'] as const) {
        await editor.focus()
        await page.evaluate(({ owner, laterActivity }) => {
          const editor = document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!
          document.querySelector(`[data-block-id="${owner}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
          if (laterActivity === 'foreign-focus') document.querySelector<HTMLButtonElement>('.document-header-more-button')!.focus()
          else window.dispatchEvent(new Event('blur'))
          editor.focus()
        }, { owner, laterActivity })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await expect(menu(page)).toHaveCount(0)
        await expect(editor).toBeFocused()
      }
      await editor.press('Control+Home')
      await page.keyboard.press('Control+Shift+End')
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await ownerRow.click({ button: 'right' })
      await expect(menu(page).locator('.context-menu-label').first()).toHaveText(uiText('3 blocks selected', '已选 3 个内容块'))
      await menu(page).press('Escape')
      // Decoration widgets stop editor events; their own right-click handler
      // must still open the same menu and preserve the multi-block selection.
      await ownerRow.locator('.rich-text-block-actions').click({ button: 'right' })
      await expect(menu(page).locator('.context-menu-label').first()).toHaveText(uiText('3 blocks selected', '已选 3 个内容块'))
      await menu(page).getByRole('button', { name: uiText('Copy block links', '复制块链接'), exact: true }).click()
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain(`#^${tail}`)
      const selectedLinks = await app.evaluate(({ clipboard }) => clipboard.readText())
      expect(selectedLinks).toContain(`#^${owner}`); expect(selectedLinks).toContain(`#^${child}`)
      await expect(menu(page)).toHaveCount(0)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await editor.focus(); await editor.press('ArrowLeft')
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }

    await ownerRow.click({ button: 'right' })
    await menu(page).getByRole('button', { name: uiText('Move to document…', '移动到文档…'), exact: true }).click()
    const dialog = page.locator('.document-block-move-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator(`input[value="${sourceId}"]`)).toHaveCount(0)
    await dialog.locator('.document-capture-field input').fill(targetTitle)
    await dialog.locator(`input[value="${targetId}"]`).check()
    await dialog.getByRole('button', { name: uiText('Move', '移动'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(ownerRow).toHaveCount(0)
    await expect.poll(() => savedIds(page, sourceId)).toEqual([tail])
    await expect.poll(() => savedIds(page, targetId)).toEqual([destination, owner, child])
    const moved = await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.find(block => block.id.endsWith('-child')), targetId)
    expect(moved?.id).toBe(child); expect(moved?.parentBlockId).toBe(owner); expect(moved?.depth).toBe(1); expect(moved?.checked).toBe(true)

    await focusBody(page, mode, tail)
    await page.keyboard.press('Control+z')
    await expect.poll(() => savedIds(page, sourceId)).toEqual([owner, child, tail])
    await expect.poll(() => savedIds(page, targetId)).toEqual([destination])
    await focusBody(page, mode, tail)
    await page.keyboard.press('Control+y')
    await expect.poll(() => savedIds(page, sourceId)).toEqual([tail])
    await expect.poll(() => savedIds(page, targetId)).toEqual([destination, owner, child])

    // The destination has an independent editor history, hydrated from the
    // paired operation journal. Undo there must restore both documents too.
    await openDocument(page, targetTitle)
    await waitForHistory(page, 'Undo')
    await focusBody(page, mode, destination)
    await page.keyboard.press('Control+z')
    await expect.poll(() => savedIds(page, sourceId)).toEqual([owner, child, tail])
    await expect.poll(() => savedIds(page, targetId)).toEqual([destination])
    await waitForHistory(page, 'Redo')
    await focusBody(page, mode, destination)
    await page.keyboard.press('Control+y')
    await expect.poll(() => savedIds(page, targetId)).toEqual([destination, owner, child])
    await expect.poll(() => savedIds(page, sourceId)).toEqual([tail])
  } finally { await closeElectronApp(context) }
})

test('Markdown source underline and finite text/background colors retain the selected text, history and rich rendering after reload @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'markdown' })
  try {
    const { page } = context, title = 'Source inline presentation', blockId = 'source-presentation-body'
    const documentId = await createDocument(page, title, [paragraph(blockId, '**alpha** 中文 beta')])
    await page.reload(); await openDocument(page, title)
    const input = page.locator(`[data-block-id="${blockId}"] .block-inline-textarea`)
    await input.focus()
    await input.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(2, 7, 'backward'))
    await input.press('Control+u')
    await expect(input).toHaveValue(/<u>alpha<\/u>/)
    expect(await input.evaluate((field: HTMLTextAreaElement) => [field.value.slice(field.selectionStart, field.selectionEnd), field.selectionDirection])).toEqual(['alpha', 'backward'])
    await input.press('Control+z')
    await expect(input).toHaveValue('**alpha** 中文 beta')
    await input.press('Control+y')
    await expect(input).toHaveValue(/<u>alpha<\/u>/)
    const toolbar = page.locator('.source-inline-presentation-toolbar')
    await toolbar.getByRole('button', { name: uiText('Text color', '文字颜色'), exact: true }).click()
    await toolbar.locator('[data-palette-color="blue"]').click()
    await expect(input).toHaveValue(/data-knowbook-text-color="blue"/)
    await toolbar.getByRole('button', { name: uiText('Background color', '背景颜色'), exact: true }).click()
    await toolbar.locator('[data-palette-color="yellow"]').click()
    await expect(input).toHaveValue(/data-knowbook-background-color="yellow"/)
    expect(await input.evaluate((field: HTMLTextAreaElement) => field.value.slice(field.selectionStart, field.selectionEnd))).toBe('alpha')
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), documentId))!.blocks[0].content).toContain('data-knowbook-background-color="yellow"')
    await page.reload(); await openDocument(page, title)
    await page.locator('.document-editor-mode').getByRole('button', { name: uiText('Rich text', '富文本'), exact: true }).click()
    const rich = page.locator(`.knowbook-rich-text-editor [data-block-id="${blockId}"]`)
    await expect(rich.locator('u')).toHaveText('alpha')
    await expect(rich.locator('[data-knowbook-text-color="blue"]')).toHaveText('alpha')
    await expect(rich.locator('[data-knowbook-background-color="yellow"]')).toHaveText('alpha')
    await expect(rich).toContainText('中文 beta')
  } finally { await closeElectronApp(context) }
})


test('rich underline and independent text/background palettes preserve a backward selection, history and reload @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich inline presentation', blockId = 'rich-presentation-body'
    const documentId = await createDocument(page, title, [paragraph(blockId, 'alpha 中文 beta')])
    await page.reload(); await openDocument(page, title)
    const editor = page.locator('.knowbook-rich-text-editor')
    const row = editor.locator('[data-block-id="rich-presentation-body"]')
    await editor.focus()
    await row.evaluate(root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement?.closest('[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      })
      const text = walker.nextNode()
      if (!text || !text.textContent?.startsWith('alpha')) throw new Error('Missing actual rich selection text')
      window.getSelection()!.setBaseAndExtent(text, 5, text, 0)
    })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const selectedOffsets = () => row.evaluate(root => {
      const selection = window.getSelection()
      if (!selection?.anchorNode || !selection.focusNode) return null
      const offset = (node: Node, end: number) => {
        if (!root.contains(node)) return null
        const range = document.createRange()
        range.selectNodeContents(root); range.setEnd(node, end)
        return range.toString().length
      }
      return [offset(selection.anchorNode, selection.anchorOffset), offset(selection.focusNode, selection.focusOffset)]
    })
    await expect.poll(selectedOffsets).toEqual([5, 0])
    await page.keyboard.press('Control+u')
    await expect(row.locator('u')).toHaveText('alpha')
    await expect.poll(selectedOffsets).toEqual([5, 0])
    const toolbar = page.locator('.rich-text-toolbar')
    const palette = page.locator('.rich-text-color-palette')
    await toolbar.getByRole('button', { name: uiText('Text color', '文字颜色'), exact: true }).click()
    await palette.locator('[data-palette-color="blue"]').click()
    await toolbar.getByRole('button', { name: uiText('Background color', '背景颜色'), exact: true }).click()
    await palette.locator('[data-palette-color="yellow"]').click()
    await expect(row.locator('[data-knowbook-text-color="blue"]')).toHaveText('alpha')
    await expect(row.locator('[data-knowbook-background-color="yellow"]')).toHaveText('alpha')
    await expect.poll(selectedOffsets).toEqual([5, 0])
    await toolbar.getByRole('button', { name: uiText('Text color', '文字颜色'), exact: true }).click()
    await palette.getByRole('button', { name: uiText('Default', '恢复默认'), exact: true }).click()
    await expect(row.locator('[data-knowbook-text-color]')).toHaveCount(0)
    await expect(row.locator('[data-knowbook-background-color="yellow"]')).toHaveText('alpha')
    await page.keyboard.press('Control+z')
    await expect(row.locator('[data-knowbook-text-color="blue"]')).toHaveText('alpha')
    await expect.poll(selectedOffsets).toEqual([5, 0])
    await page.keyboard.press('Control+Shift+z')
    await expect(row.locator('[data-knowbook-text-color]')).toHaveCount(0)
    await expect.poll(selectedOffsets).toEqual([5, 0])
    await toolbar.getByRole('button', { name: uiText('Background color', '背景颜色'), exact: true }).click()
    await palette.getByRole('button', { name: uiText('Default', '恢复默认'), exact: true }).click()
    await expect(row.locator('[data-knowbook-background-color]')).toHaveCount(0)
    await expect(row.locator('u')).toHaveText('alpha')
    await page.keyboard.press('Control+z')
    await expect(row.locator('[data-knowbook-background-color="yellow"]')).toHaveText('alpha')
    await page.keyboard.press('Control+Shift+z')
    await expect(row.locator('[data-knowbook-background-color]')).toHaveCount(0)
    await expect.poll(selectedOffsets).toEqual([5, 0])
    await page.keyboard.press('Control+z')
    await toolbar.getByRole('button', { name: uiText('Text color', '文字颜色'), exact: true }).click()
    await palette.locator('[data-palette-color="blue"]').click()
    await expect(row).toHaveText('alpha 中文 beta')
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), documentId))!.blocks[0].content).toContain('data-knowbook-text-color="blue"')
    const saved = (await page.evaluate(id => window.knowbook.getDocumentDetail(id), documentId))!.blocks[0]
    expect(saved.id).toBe(blockId); expect(saved.content).toContain('data-knowbook-background-color="yellow"')
    await page.reload(); await openDocument(page, title)
    await expect(row).toHaveText('alpha 中文 beta')
    await expect(row.locator('u')).toHaveText('alpha')
    await expect(row.locator('[data-knowbook-text-color="blue"]')).toHaveText('alpha')
    await expect(row.locator('[data-knowbook-background-color="yellow"]')).toHaveText('alpha')
  } finally { await closeElectronApp(context) }
})
