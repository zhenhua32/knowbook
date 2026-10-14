import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { parseEditableMarkdownTable } from '../src/shared/markdownTableEditing'
import { closeElectronApp, launchElectronApp, uiText } from './helpers/electron'
import { setRichTextDomSelection } from './helpers/rich-text-selection'
import type { ElectronAppContext } from './helpers/electron'

type Mode = 'markdown' | 'rich'
const initial = '<!-- knowbook:table-widths:v1 [160,null,240] -->\n| A | B | C |\n| :-- | :-: | --: |\n| [ref][r] | `x\\|y` | 一 | overflow one |\n| 😀 | two | 三 | overflow two | extra |\n| third | four | 五 | overflow three |\n\n[r]: https://example.test/docs "Ref 中文"'
const region = (page: Page, id: string) => page.locator(`[data-block-id="${id}"] .markdown-table-editor`)
async function installExternalLinkProbe(app: ElectronAppContext['app']) {
  await app.evaluate(({ ipcMain }) => {
    const urls: string[] = []
    ;(globalThis as typeof globalThis & { tableLayoutOpenedUrls?: string[] }).tableLayoutOpenedUrls = urls
    // Public IPC fixture records the requested destination before any OS action.
    ipcMain.removeHandler('knowbook:open-external-url')
    ipcMain.handle('knowbook:open-external-url', async (_event, url: string) => { urls.push(url) })
  })
}
async function openedUrls(app: ElectronAppContext['app']) {
  return app.evaluate(() => (globalThis as typeof globalThis & { tableLayoutOpenedUrls?: string[] }).tableLayoutOpenedUrls ?? [])
}
async function saved(page: Page, id: string, blockId: string) {
  return (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))!.blocks.find(block => block.id === blockId)!
}
async function open(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
async function seed(page: Page, title: string, blockId: string, content = initial) {
  const blocks: DocumentBlockDraft[] = [{ id: blockId, type: 'table', content, checked: false, depth: 0, tags: ['table-tag'], highlight: 'blue' }]
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks }); return id
  }, { title, blocks })
  await page.reload(); await open(page, title)
  await expect(region(page, blockId)).toBeVisible()
  return id
}
async function history(page: Page, action: 'Undo' | 'Redo') {
  await page.locator('.document-header-more-button').click()
  const menu = page.locator('.document-header-action-menu')
  await menu.getByRole('button', { name: uiText(action, action === 'Undo' ? '撤销' : '重做'), exact: true }).click()
  await expect(menu).toHaveCount(0)
}
async function startResize(page: Page, handle: Locator, amount: number) {
  await handle.scrollIntoViewIfNeeded()
  const box = await handle.boundingBox(); expect(box).not.toBeNull()
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + amount, y, { steps: 5 })
}
async function drag(page: Page, handle: Locator, target: Locator) {
  await handle.scrollIntoViewIfNeeded()
  const from = await handle.boundingBox(), to = await target.boundingBox()
  expect(from).not.toBeNull(); expect(to).not.toBeNull()
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down(); await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 6 }); await page.mouse.up()
}

for (const mode of ['markdown', 'rich'] as const) test(`${mode} table pointer width commits once, cancellation preserves source, and row/column drags retain coupled data @electron`, async () => {
  test.setTimeout(150000)
  const context = await launchElectronApp({}, { editorMode: mode })
  try {
    const { app, page } = context
    await installExternalLinkProbe(app)
    await page.setViewportSize({ width: 1420, height: 1080 })
    const title = `Table layout ${mode}`, blockId = `layout-${mode}-table`, id = await seed(page, title, blockId)
    const table = region(page, blockId), resize = table.getByRole('separator', { name: uiText('Resize column 1', '调整第 1 列宽') })
    await expect(resize).toHaveAttribute('aria-valuenow', '160')
    await startResize(page, resize, 40)
    await expect(table).toHaveAttribute('data-table-gesture', 'preview')
    await expect(resize).toHaveAttribute('aria-valuenow', '200')
    expect((await saved(page, id, blockId)).content).toBe(initial)
    await page.mouse.up()
    await expect.poll(async () => parseEditableMarkdownTable((await saved(page, id, blockId)).content)?.widths).toEqual([200, null, 240])
    const resized = (await saved(page, id, blockId)).content
    await history(page, 'Undo')
    await expect.poll(async () => (await saved(page, id, blockId)).content).toBe(initial)
    await page.locator('.document-header-more-button').click()
    await expect(page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Undo', '撤销'), exact: true })).toBeDisabled()
    await page.locator('.document-header-action-menu').press('Escape')
    await history(page, 'Redo')
    await expect.poll(async () => (await saved(page, id, blockId)).content).toBe(resized)

    for (const cancel of ['Escape', 'pointercancel', 'blur'] as const) {
      await startResize(page, resize, 55)
      await expect(table).toHaveAttribute('data-table-gesture', 'preview')
      if (cancel === 'Escape') await page.keyboard.press('Escape')
      else await page.evaluate(kind => window.dispatchEvent(kind === 'blur' ? new Event('blur') : new PointerEvent('pointercancel')), cancel)
      await page.mouse.up()
      await expect(resize).toHaveAttribute('aria-valuenow', '200')
      await page.locator('.document-header-save-button').click()
      expect((await saved(page, id, blockId)).content).toBe(resized)
    }
    await drag(page, table.getByRole('button', { name: uiText('Drag row 1', '拖动第 1 行') }), table.locator('[data-row="3"][data-column="0"]'))
    await expect.poll(async () => parseEditableMarkdownTable((await saved(page, id, blockId)).content)?.overflow)
      .toEqual([['overflow two', 'extra'], ['overflow three'], ['overflow one']])
    await drag(page, table.getByRole('button', { name: uiText('Drag column 3', '拖动第 3 列') }), table.locator('[data-row="0"][data-column="0"]'))
    await expect.poll(async () => parseEditableMarkdownTable((await saved(page, id, blockId)).content)?.headers).toEqual(['C', 'A', 'B'])
    const stored = await saved(page, id, blockId), model = parseEditableMarkdownTable(stored.content)!
    expect(model.alignments).toEqual(['right', 'left', 'center'])
    expect(model.widths).toEqual([240, 200, null])
    expect(model.rows).toEqual([['三', '😀', 'two'], ['五', 'third', 'four'], ['一', '[ref][r]', '`x|y`']])
    expect(model.overflow).toEqual([['overflow two', 'extra'], ['overflow three'], ['overflow one']])
    expect(stored.id).toBe(blockId); expect(stored.tags).toEqual(['table-tag']); expect(stored.highlight).toBe('blue')
    expect((stored.content.match(/knowbook:table-widths:/g) ?? []).length).toBe(1)
    expect(stored.content.endsWith('[r]: https://example.test/docs "Ref 中文"')).toBe(true)
    await expect(table.locator('[data-row="0"][data-column="0"]')).toContainText('C')
    const editorLink = table.locator('[data-row="3"][data-column="1"] button.inline-link')
    await expect(editorLink).toHaveText('ref')
    await expect(editorLink).toHaveAttribute('title', 'Ref 中文')
    await editorLink.click()
    await expect.poll(() => openedUrls(app)).toEqual(['https://example.test/docs'])
    await page.locator('.document-header-save-button').click()
    await page.reload(); await open(page, title)
    await expect(region(page, blockId).getByRole('separator', { name: uiText('Resize column 1', '调整第 1 列宽') })).toHaveAttribute('aria-valuenow', '240')
    expect((await saved(page, id, blockId)).content).toBe(stored.content)
    await page.locator('.document-view-toggle').click()
    const reading = page.locator(`.document-reading-row[data-block-id="${blockId}"]`)
    await expect(reading.locator('table[data-knowbook-table-layout="true"]')).toBeVisible()
    const readingLink = reading.locator('button.inline-link')
    await expect(readingLink).toHaveText('ref')
    await expect(readingLink).toHaveAttribute('title', 'Ref 中文')
    await readingLink.click()
    await expect.poll(() => openedUrls(app)).toEqual(['https://example.test/docs', 'https://example.test/docs'])
    expect((await saved(page, id, blockId)).content).toBe(stored.content)
  } finally { await closeElectronApp(context) }
})

test('rich table portal restores a backward cell selection through history and cancels stale gestures across documents @electron', async () => {
  test.setTimeout(120000)
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context
    await page.setViewportSize({ width: 1420, height: 1080 })
    const title = 'Rich table portal history', blockId = 'portal-table', content = '| A | B |\n| - | - |\n| 中文😀 alpha | second |'
    const otherTitle = 'Other portal document', otherBlock = 'other-portal-body'
    await page.evaluate(async ({ title, blockId }) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks: [{ id: blockId, type: 'paragraph', content: 'New focus stays here', checked: false, depth: 0 }] })
    }, { title: otherTitle, blockId: otherBlock })
    const id = await seed(page, title, blockId, content)
    const table = region(page, blockId)
    await expect(table.locator('thead .markdown-table-row-handle')).toHaveCount(0)
    await table.locator('[data-row="1"][data-column="0"]').click()
    const input = table.locator('textarea')
    await expect(input).toHaveValue('中文😀 alpha')
    await input.evaluate((input: HTMLTextAreaElement) => { input.focus(); input.setSelectionRange(0, 4, 'backward') })
    await input.press('Control+b')
    await expect(input).toHaveValue('**中文😀** alpha')
    await expect.poll(async () => (await saved(page, id, blockId)).content).toContain('**中文😀** alpha')
    const formattedContent = (await saved(page, id, blockId)).content
    await input.press('Control+z')
    await expect.poll(async () => (await saved(page, id, blockId)).content).toBe(content)
    await expect(input).toBeFocused()
    expect(await input.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([0, 4, 'backward'])
    await input.press('Control+y')
    await expect(input).toHaveValue('**中文😀** alpha')
    // The restored cell renders before debounced autosave acknowledges the redo.
    await expect.poll(async () => (await saved(page, id, blockId)).content).toBe(formattedContent)
    const beforeSwitch = (await saved(page, id, blockId)).content
    await startResize(page, table.getByRole('separator', { name: uiText('Resize column 1', '调整第 1 列宽') }), 40)
    await expect(table).toHaveAttribute('data-table-gesture', 'preview')
    const navigation = page.locator('.tree-button', { hasText: otherTitle }).first()
    await navigation.focus(); await navigation.press('Enter')
    await expect(page.locator('.document-header-title')).toHaveText(otherTitle)
    await page.mouse.up()
    const editor = page.locator('.knowbook-rich-text-editor')
    await editor.evaluate(setRichTextDomSelection, { from: { blockId: otherBlock, offset: 2 } })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(editor).toBeFocused()
    expect(await editor.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('[data-block-id]')?.getAttribute('data-block-id'))).toBe(otherBlock)
    expect((await saved(page, id, blockId)).content).toBe(beforeSwitch)
    await open(page, title)
    await expect(region(page, blockId).getByRole('separator', { name: uiText('Resize column 1', '调整第 1 列宽') })).toHaveAttribute('aria-valuenow', '120')
    expect((await saved(page, id, blockId)).content).toBe(beforeSwitch)
  } finally { await closeElectronApp(context) }
})
