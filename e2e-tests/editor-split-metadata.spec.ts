import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { withElectronApp } from './helpers/electron'

async function openEditor(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.block-editor-row')).toHaveCount(blocks.length)
  return id
}
async function read(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(
    ({ id, type, content, checked, depth, parentBlockId, tags, highlight, language, listStart, markdownFormat }) =>
      ({ id, type, content, checked, depth, parentBlockId, tags, highlight, language, listStart, markdownFormat })), id)
}
async function select(input: Locator, start: number, end = start, direction: 'forward' | 'backward' | 'none' = 'none') {
  await input.focus()
  await input.evaluate((element: HTMLTextAreaElement, { start, end, direction }) => {
    element.setSelectionRange(start, end, direction)
    element.dispatchEvent(new Event('select', { bubbles: true }))
  }, { start, end, direction })
}
async function expectCaret(input: Locator, position: number) {
  await expect(input).toBeFocused()
  expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([position, position])
}
const afterBlock: DocumentBlockDraft = { id: 'after', type: 'paragraph', content: 'Keep after', depth: 0, checked: false }

test('Alt Enter keeps a manually chosen code language and content metadata through undo redo and reload @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Split manually configured code'
    const content = 'x = 1\ny = 2'
    const id = await openEditor(page, title, [
      { id: 'source', type: 'code', content, depth: 0, checked: false, tags: ['source'], highlight: 'yellow' }, afterBlock
    ])
    const row = page.locator('[data-block-id="source"]')
    await row.locator('.block-code-language-badge').click()
    await row.locator('.code-block-language-selector').selectOption('python')
    await expect.poll(async () => (await read(page, id))[0].language).toBe('python')
    const before = await read(page, id)
    const input = row.locator('textarea.block-inline-textarea')
    const position = content.indexOf('y')
    await select(input, position)
    await page.keyboard.press('Alt+Enter')
    await expect(page.locator('.block-editor-row')).toHaveCount(3)
    const rightRow = page.locator('.block-editor-row').nth(1)
    const right = rightRow.locator('textarea.block-inline-textarea')
    const rightId = await rightRow.getAttribute('data-block-id')
    expect(rightId).toBeTruthy()
    expect(rightId).not.toBe('source')
    await expect(input).toHaveValue('x = 1\n')
    await expect(right).toHaveValue('y = 2')
    await expectCaret(right, 0)
    await expect(rightRow.locator('.block-code-language-badge')).toHaveText('python')
    const expected = [{ ...before[0], content: 'x = 1\n' },
      { ...before[0], id: rightId!, content: 'y = 2' }, before[1]]
    await expect.poll(() => read(page, id)).toEqual(expected)
    await page.keyboard.press('Control+z')
    await expect(page.locator('.block-editor-row')).toHaveCount(2)
    await expectCaret(input, position)
    await expect.poll(() => read(page, id)).toEqual(before)
    await page.keyboard.press('Control+Shift+z')
    await expect(page.locator('.block-editor-row')).toHaveCount(3)
    await expectCaret(page.locator(`[data-block-id="${rightId}"] textarea`), 0)
    await expect.poll(() => read(page, id)).toEqual(expected)
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    expect(await read(page, id)).toEqual(expected)
    await expect(page.locator(`[data-block-id="${rightId}"] .block-code-language-badge`)).toHaveText('python')
  })
})

test('unconfigured code fragments keep automatic detection and original fence info after a selected split @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Split automatic code and fence info'
    const content = 'prefix remove😀 \n{"value":1}'
    const id = await openEditor(page, title, [
      { id: 'source', type: 'code', content, depth: 0, checked: false,
        tags: ['source'], highlight: 'blue', markdownFormat: { codeInfo: 'custom extra' } }, afterBlock
    ])
    const before = await read(page, id)
    expect(before[0].language).toBeUndefined()
    const input = page.locator('[data-block-id="source"] textarea')
    const start = 'prefix '.length, end = content.indexOf('{')
    await select(input, start, end, 'backward')
    await page.keyboard.press('Alt+Enter')
    await expect(page.locator('.block-editor-row')).toHaveCount(3)
    const rightId = await page.locator('.block-editor-row').nth(1).getAttribute('data-block-id')
    const right = page.locator(`[data-block-id="${rightId}"] textarea`)
    await expect(input).toHaveValue('prefix ')
    await expect(right).toHaveValue('{"value":1}')
    await expectCaret(right, 0)
    await expect(page.locator(`[data-block-id="${rightId}"] .block-code-language-badge`)).toHaveText('json')
    const expected = [{ ...before[0], content: 'prefix ' },
      { ...before[0], id: rightId!, content: '{"value":1}', language: 'json' }, before[1]]
    await expect.poll(() => read(page, id)).toEqual(expected)
    await page.keyboard.press('Control+z')
    await expect(input).toHaveValue(content)
    await expect(input).toBeFocused()
    expect(await input.evaluate((element: HTMLTextAreaElement) =>
      [element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual([start, end, 'backward'])
    await expect.poll(() => read(page, id)).toEqual(before)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => read(page, id)).toEqual(expected)
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    expect(await read(page, id)).toEqual(expected)
  })
})

test('splitting a checked list parent retains classification and style without duplicating its task state or children @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Split task metadata and children'
    const id = await openEditor(page, title, [
      { id: 'outer', type: 'bulleted-list', content: 'Outer', depth: 0, checked: false },
      { id: 'parent', type: 'numbered-todo', content: 'AlphaBeta', depth: 1, parentBlockId: 'outer', checked: true,
        tags: ['keep'], highlight: 'blue', listStart: 4, markdownFormat: { listMarker: ')' } },
      { id: 'child', type: 'todo', content: 'Child', depth: 2, parentBlockId: 'parent', checked: true }, afterBlock
    ])
    const before = await read(page, id)
    const input = page.locator('[data-block-id="parent"] textarea')
    await select(input, 5)
    await page.keyboard.press('Alt+Enter')
    await expect(page.locator('.block-editor-row')).toHaveCount(5)
    const rightRow = page.locator('.block-editor-row').nth(3)
    const rightId = await rightRow.getAttribute('data-block-id')
    await expectCaret(rightRow.locator('textarea'), 0)
    await expect(rightRow.locator('.block-todo-checkbox')).not.toBeChecked()
    await expect(page.locator('[data-block-id="child"] .block-todo-checkbox')).toBeChecked()
    const expected = [before[0], { ...before[1], content: 'Alpha' }, before[2],
      { ...before[1], id: rightId!, content: 'Beta', checked: false, listStart: undefined }, before[3]]
    await expect.poll(() => read(page, id)).toEqual(expected)
    await page.keyboard.press('Control+z')
    await expectCaret(input, 5)
    await expect.poll(() => read(page, id)).toEqual(before)
    await page.keyboard.press('Control+Shift+z')
    await expectCaret(page.locator(`[data-block-id="${rightId}"] textarea`), 0)
    await expect.poll(() => read(page, id)).toEqual(expected)
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    expect(await read(page, id)).toEqual(expected)
  })
})
