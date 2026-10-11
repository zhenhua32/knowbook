import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { withElectronApp } from './helpers/electron'

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0 })
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
async function select(input: Locator, start: number, end = start, direction: 'forward' | 'backward' | 'none' = 'none') {
  await input.focus()
  await input.evaluate((element, { start, end, direction }) => {
    const textarea = element as HTMLTextAreaElement
    textarea.setSelectionRange(start, end, direction)
    textarea.dispatchEvent(new Event('select', { bubbles: true }))
  }, { start, end, direction })
}
async function caret(input: Locator) {
  return input.evaluate(element => {
    const textarea = element as HTMLTextAreaElement
    return [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]
  })
}
async function persisted(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks, id)
}

test('paragraph Enter creates a block with reversible selection while Shift+Enter keeps a saved soft line @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Continuous paragraph editing'
    const id = await openEditor(page, title, [paragraph('text', 'Alpha selected Omega'), paragraph('after', 'After')])
    const original = page.locator('[data-block-id="text"] textarea')
    await select(original, 6, 15, 'backward')
    await original.press('Enter')
    const rows = page.locator('.block-editor-row')
    await expect(rows).toHaveCount(3)
    const next = rows.nth(1).locator('textarea')
    await expect(original).toHaveValue('Alpha ')
    await expect(next).toHaveValue('Omega')
    await expect(next).toBeFocused()
    expect((await caret(next)).slice(0, 2)).toEqual([0, 0])
    const newId = await rows.nth(1).getAttribute('data-block-id')
    expect(newId).not.toBe('text')
    await next.press('Control+z')
    await expect(rows).toHaveCount(2)
    await expect(original).toBeFocused()
    await expect(original).toHaveValue('Alpha selected Omega')
    expect(await caret(original)).toEqual([6, 15, 'backward'])
    await original.press('Control+Shift+z')
    await expect(rows).toHaveCount(3)
    expect(await rows.nth(1).getAttribute('data-block-id')).toBe(newId)
    await expect(next).toBeFocused()
    expect((await caret(next)).slice(0, 2)).toEqual([0, 0])
    await next.pressSequentially('New ')
    await expect(next).toHaveValue('New Omega')
    await next.press('Shift+Enter')
    await expect(next).toHaveValue('New \nOmega')
    await expect(rows).toHaveCount(3)
    await expect.poll(async () => (await persisted(page, id))?.map(block => [block.id, block.content]))
      .toEqual([['text', 'Alpha '], [newId, 'New \nOmega'], ['after', 'After']])
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    await expect(page.locator('.block-editor-row').nth(1).locator('textarea')).toHaveValue('New \nOmega')
  })
})

test('list parent Enter preserves saved descendants, task state, sibling placement and undo focus @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const blocks: DocumentBlockDraft[] = [
      { ...paragraph('outer', 'Outer'), type: 'bulleted-list' },
      { ...paragraph('parent', 'AlphaBeta'), type: 'numbered-todo', depth: 1, parentBlockId: 'outer', checked: true, listStart: 4 },
      { ...paragraph('child', 'Child'), type: 'todo', depth: 2, parentBlockId: 'parent', checked: true, tags: ['keep'] },
      { ...paragraph('grandchild', 'Grandchild'), type: 'bulleted-list', depth: 3, parentBlockId: 'child' },
      { ...paragraph('sibling', 'Sibling'), type: 'bulleted-list', depth: 1, parentBlockId: 'outer' }, paragraph('after', 'After')
    ]
    const id = await openEditor(page, 'Continue parent list text', blocks)
    const parent = page.locator('[data-block-id="parent"] textarea')
    await select(parent, 5)
    await parent.press('Enter')
    const rows = page.locator('.block-editor-row')
    await expect(rows).toHaveCount(7)
    const next = rows.nth(4).locator('textarea')
    await expect(parent).toHaveValue('Alpha'); await expect(next).toHaveValue('Beta')
    await expect(next).toBeFocused()
    expect((await caret(next)).slice(0, 2)).toEqual([0, 0])
    const newId = await rows.nth(4).getAttribute('data-block-id')
    const expected = [
      ['outer', 'Outer', 0, null, false], ['parent', 'Alpha', 1, 'outer', true],
      ['child', 'Child', 2, 'parent', true], ['grandchild', 'Grandchild', 3, 'child', false],
      [newId, 'Beta', 1, 'outer', false], ['sibling', 'Sibling', 1, 'outer', false], ['after', 'After', 0, null, false]
    ]
    const savedTree = async () => (await persisted(page, id))?.map(block => [block.id, block.content, block.depth, block.parentBlockId ?? null, block.checked])
    await expect.poll(savedTree).toEqual(expected)
    expect((await persisted(page, id))?.find(block => block.id === 'child')?.tags).toEqual(['keep'])
    await next.press('Control+z')
    await expect(rows).toHaveCount(6)
    await expect(parent).toBeFocused(); await expect(parent).toHaveValue('AlphaBeta')
    expect((await caret(parent)).slice(0, 2)).toEqual([5, 5])
    await parent.press('Control+Shift+z')
    await expect(next).toBeFocused(); await expect.poll(savedTree).toEqual(expected)
  })
})

test('horizontal caret navigation skips folded children and dividers and preserves text selection @electron', async () => {
  await withElectronApp(async ({ page }) => {
    await openEditor(page, 'Cross block caret navigation', [paragraph('before', 'Before'),
      { ...paragraph('heading', 'Folded'), type: 'heading-1' }, paragraph('hidden', 'Hidden child'),
      { ...paragraph('divider', ''), type: 'divider' },
      { ...paragraph('next-heading', 'Next section'), type: 'heading-1' }, paragraph('after', 'After')])
    const heading = page.locator('[data-block-id="heading"] textarea')
    const after = page.locator('[data-block-id="next-heading"] textarea')
    await page.locator('[data-block-id="heading"] .section-collapse-toggle').click()
    await expect(page.locator('[data-block-id="hidden"]')).toHaveCount(0)
    await select(heading, 6)
    await heading.press('ArrowRight')
    await expect(after).toBeFocused()
    expect((await caret(after)).slice(0, 2)).toEqual([0, 0])
    await after.press('ArrowLeft')
    await expect(heading).toBeFocused()
    expect((await caret(heading)).slice(0, 2)).toEqual([6, 6])
    await select(heading, 0, 6, 'backward')
    await heading.press('ArrowRight')
    await expect(heading).toBeFocused()
    expect((await caret(heading)).slice(0, 2)).toEqual([6, 6])
    await heading.press('Shift+ArrowLeft')
    await expect(heading).toBeFocused()
    expect((await caret(heading)).slice(0, 2)).toEqual([5, 6])
  })
})
