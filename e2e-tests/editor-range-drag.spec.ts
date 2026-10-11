import { expect, test, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { uiText, withElectronApp } from './helpers/electron'

const block = (id: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
  ({ id, type: 'todo', content: id, checked: true, depth, parentBlockId, tags: [id], highlight: 'blue' })
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
const row = (page: Page, id: string) => page.locator(`[data-block-id="${id}"]`)
const editor = (page: Page, id: string) => row(page, id).locator('textarea.block-inline-textarea')
async function selectReverseRange(page: Page, end: string, start: string) {
  await editor(page, end).click()
  await editor(page, end).press('End')
  await editor(page, start).click({ modifiers: ['Shift'] })
  await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
  await editor(page, end).focus()
  await editor(page, end).evaluate(element => {
    const input = element as HTMLTextAreaElement
    input.setSelectionRange(1, 1)
    input.dispatchEvent(new Event('select', { bubbles: true }))
  })
}
async function drag(page: Page, source: string, target: string, horizontalDelta: number, valid: boolean) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  const handle = row(page, source).locator('.block-drag-handle')
  const targetRow = row(page, target)
  const bounds = await targetRow.boundingBox()
  if (!bounds) throw new Error(`Missing visible drag target ${target}`)
  const clientX = bounds.x + 48 + 160 + 20 + horizontalDelta
  try {
    await handle.focus()
    await handle.dispatchEvent('dragstart', { dataTransfer })
    await targetRow.dispatchEvent('dragover', { dataTransfer, clientX })
    await expect(targetRow.locator('.block-drop-preview')).toHaveCount(valid ? 1 : 0)
    await targetRow.dispatchEvent('drop', { dataTransfer, clientX })
    await handle.dispatchEvent('dragend', { dataTransfer })
  } finally { await dataTransfer.dispose() }
}
async function persisted(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks.map(
    ({ id, content, type, checked, depth, parentBlockId, tags, highlight }) => ({ id, content, type, checked, depth, parentBlockId: parentBlockId ?? null, tags, highlight })), id)
}
async function expectCaret(page: Page, id: string) {
  await expect(editor(page, id)).toBeFocused()
  expect(await editor(page, id).evaluate(element => {
    const input = element as HTMLTextAreaElement
    return [input.selectionStart, input.selectionEnd]
  })).toEqual([1, 1])
}

test('dragging the second selected folded root moves both complete saved subtrees with history, caret and selection @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Complete folded range drag'
    const blocks = [block('before'), block('a'), block('a-child', 1, 'a'), block('a-grandchild', 2, 'a-child'),
      block('b'), block('b-child', 1, 'b'), block('after'), block('after-child', 1, 'after')]
    const id = await openEditor(page, title, blocks)
    const original = await persisted(page, id)
    await row(page, 'a').locator('.block-collapse-toggle').click()
    await row(page, 'b').locator('.block-collapse-toggle').click()
    await expect(row(page, 'a-child')).toHaveCount(0)
    await expect(row(page, 'b-child')).toHaveCount(0)
    await selectReverseRange(page, 'b', 'a')
    // The target is depth 1; cross the 72px drag threshold to keep the moved roots at depth 0.
    await drag(page, 'b', 'after-child', -160, true)
    await expect.poll(async () => page.locator('.block-editor-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-block-id'))))
      .toEqual(['before', 'after', 'after-child', 'a', 'b'])
    await expectCaret(page, 'b')
    await expect(row(page, 'a')).toHaveClass(/block-editor-row-selected/)
    await expect(row(page, 'b')).toHaveClass(/block-editor-row-selected/)
    const byId = new Map(original!.map(block => [block.id, block]))
    const expected = ['before', 'after', 'after-child', 'a', 'a-child', 'a-grandchild', 'b', 'b-child'].map(id => byId.get(id))
    await expect.poll(() => persisted(page, id)).toEqual(expected)
    await editor(page, 'b').press('Control+z')
    await expect.poll(() => persisted(page, id)).toEqual(original)
    await expectCaret(page, 'b')
    await editor(page, 'b').press('Control+Shift+z')
    await expect.poll(() => persisted(page, id)).toEqual(expected)
    await expectCaret(page, 'b')

    // The retained visible selection must still own the last root's hidden child.
    await selectReverseRange(page, 'b', 'a')
    await page.locator('.block-selection-toolbar').getByRole('button', { name: uiText('Delete', '删除'), exact: true }).click()
    await expect.poll(async () => (await persisted(page, id))?.map(block => block.id)).toEqual(['before', 'after', 'after-child'])
    await page.keyboard.press('Control+z')
    await expect.poll(() => persisted(page, id)).toEqual(expected)
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    await expect.poll(() => persisted(page, id)).toEqual(expected)
    await expect(editor(page, 'a')).toHaveValue('a')
    await expect(editor(page, 'b')).toHaveValue('b')
  })
})

test('adjacent range drag swaps in both directions and an invalid self-drop leaves redo available @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await openEditor(page, 'Adjacent range drag', [block('before'), block('a'), block('b'), block('after')])
    const ids = async () => (await persisted(page, id))?.map(block => block.id)
    await selectReverseRange(page, 'b', 'a')
    await drag(page, 'b', 'before', 0, true)
    await expect.poll(ids).toEqual(['a', 'b', 'before', 'after'])
    await expectCaret(page, 'b')
    await drag(page, 'a', 'before', 0, true)
    await expect.poll(ids).toEqual(['before', 'a', 'b', 'after'])
    await expectCaret(page, 'b')
    await editor(page, 'b').press('Control+z')
    await expect.poll(ids).toEqual(['a', 'b', 'before', 'after'])
    await selectReverseRange(page, 'b', 'a')
    await drag(page, 'a', 'b', 0, false)
    await expect.poll(ids).toEqual(['a', 'b', 'before', 'after'])
    await editor(page, 'b').press('Control+Shift+z')
    await expect.poll(ids).toEqual(['before', 'a', 'b', 'after'])
  })
})
