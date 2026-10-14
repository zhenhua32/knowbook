import { expect, test, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { uiText, withElectronApp } from './helpers/electron'

const row = (page: Page, id: string) => page.locator(`[data-block-id="${id}"]`)
const input = (page: Page, id: string) => row(page, id).locator('textarea.block-inline-textarea')
async function read(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(
    ({ id, type, content, checked, depth, parentBlockId, tags, highlight, listStart, markdownFormat }) => ({
      id, type, content, checked, depth, parentBlockId: parentBlockId ?? null, tags, highlight,
      listStart: listStart ?? null, markdownFormat: markdownFormat ?? null
    })), id)
}
async function seed(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.block-editor-row')).toHaveCount(blocks.length)
  return { id, before: await read(page, id) }
}
async function convert(page: Page, first: string, last: string, type: string) {
  await input(page, first).click()
  await input(page, last).click({ modifiers: ['Shift'] })
  // Shift-click extends the block range without moving the editing caret.
  await expect(input(page, first)).toBeFocused()
  const caret = await input(page, first).evaluate((element: HTMLTextAreaElement) => element.selectionStart)
  const toolbar = page.locator('.block-selection-toolbar')
  await expect(toolbar).toBeVisible()
  await toolbar.locator('select').selectOption(type)
  await toolbar.getByRole('button', { name: uiText('Convert', '转换'), exact: true }).click()
  await expect(input(page, first)).toBeFocused()
  expect(await input(page, first).evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([caret, caret])
}
async function references(page: Page, documentId: string, ids: string[]) {
  return page.evaluate(async ({ documentId, ids }) => {
    const { path } = (await window.knowbook.getDocumentDetail(documentId))!
    return Promise.all(ids.map(async id => (await window.knowbook.getBlockReference(path, id))?.block.id ?? null))
  }, { documentId, ids })
}

test('bulk type conversion preserves block references, tags and highlights through undo, redo and reload @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Bulk conversion keeps referenced identities'
    const blocks: DocumentBlockDraft[] = [
      { id: 'convert-first', type: 'paragraph', content: 'First 中文 😀', depth: 0, checked: false, tags: ['first'], highlight: 'yellow' },
      { id: 'convert-second', type: 'quote', content: 'Second', depth: 0, checked: false, tags: ['second'], highlight: 'blue' },
      { id: 'convert-after', type: 'paragraph', content: 'After', depth: 0, checked: false, tags: ['after'], highlight: 'purple' }
    ]
    const { id, before } = await seed(page, title, blocks)
    const ids = blocks.map(block => block.id!)
    expect(await references(page, id, ids)).toEqual(ids)
    await convert(page, ids[0], ids[1], 'todo')
    const after = before.map((block, index) => index < 2 ? { ...block, type: 'todo' } : block)
    await expect.poll(() => read(page, id)).toEqual(after)
    await expect(input(page, ids[0])).toBeFocused()
    await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
    expect(await references(page, id, ids)).toEqual(ids)
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(page, id)).toEqual(before)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => read(page, id)).toEqual(after)
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    await expect.poll(() => read(page, id)).toEqual(after)
    expect(await references(page, id, ids)).toEqual(ids)
  })
})

test('bulk list conversions preserve numbered metadata and folded child identities while removing list parenthood @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Bulk conversion keeps folded list descendants'
    const blocks: DocumentBlockDraft[] = [
      { id: 'convert-parent', type: 'numbered-list', content: 'Parent', depth: 0, checked: false, listStart: 4, tags: ['parent'], highlight: 'yellow', markdownFormat: { listMarker: ')', listLoose: true } },
      { id: 'convert-child', type: 'numbered-todo', content: 'Checked child', depth: 1, parentBlockId: 'convert-parent', checked: true, listStart: 7, tags: ['child'], highlight: 'blue', markdownFormat: { listMarker: ')', listLoose: true } },
      { id: 'convert-grandchild', type: 'numbered-list', content: 'Grandchild', depth: 2, parentBlockId: 'convert-child', checked: false, listStart: 9, tags: ['grandchild'], highlight: 'purple', markdownFormat: { listMarker: ')', listLoose: true } },
      { id: 'convert-sibling', type: 'numbered-list', content: 'Sibling', depth: 0, checked: false, listStart: 12, tags: ['sibling'], highlight: 'green', markdownFormat: { listMarker: ')', listLoose: true } }
    ]
    const { id, before } = await seed(page, title, blocks)
    const ids = blocks.map(block => block.id!)
    await row(page, ids[0]).locator('.block-collapse-toggle').click({ force: true })
    await expect(row(page, ids[1])).toHaveCount(0)
    await convert(page, ids[0], ids[3], 'numbered-todo')
    // Only the two visible selected roots change type; their folded descendants
    // retain their independent type, checked state and ordered-list metadata.
    const numbered = [
      { ...before[0], type: 'numbered-todo' }, before[1], before[2],
      { ...before[3], type: 'numbered-todo' }
    ]
    const expectRetainedDescendantMetadata = async () => {
      const saved = await read(page, id)
      expect(saved.slice(1, 3).map(({ id, type, checked, listStart, markdownFormat }) => ({ id, type, checked, listStart, markdownFormat }))).toEqual([
        { id: ids[1], type: 'numbered-todo', checked: true, listStart: 7, markdownFormat: { listMarker: ')', listLoose: true } },
        { id: ids[2], type: 'numbered-list', checked: false, listStart: 9, markdownFormat: { listMarker: ')', listLoose: true } }
      ])
      expect(await references(page, id, ids)).toEqual(ids)
    }
    await expect.poll(() => read(page, id)).toEqual(numbered)
    await expect(row(page, ids[1])).toHaveCount(0)
    await expect(row(page, ids[2])).toHaveCount(0)
    await expectRetainedDescendantMetadata()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(page, id)).toEqual(before)
    await expectRetainedDescendantMetadata()
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => read(page, id)).toEqual(numbered)
    await expect(row(page, ids[1])).toHaveCount(0)
    await expectRetainedDescendantMetadata()
    await convert(page, ids[0], ids[3], 'paragraph')
    const paragraphs = [
      { ...before[0], type: 'paragraph', checked: false, depth: 0, parentBlockId: null, listStart: null, markdownFormat: null },
      { ...before[1], depth: 0, parentBlockId: null },
      { ...before[2], depth: 1, parentBlockId: ids[1] },
      { ...before[3], type: 'paragraph', checked: false, depth: 0, parentBlockId: null, listStart: null, markdownFormat: null }
    ]
    await expect.poll(() => read(page, id)).toEqual(paragraphs)
    for (const blockId of ids) await expect(input(page, blockId)).toBeVisible()
    await expectRetainedDescendantMetadata()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(page, id)).toEqual(numbered)
    await expectRetainedDescendantMetadata()
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => read(page, id)).toEqual(paragraphs)
    await expectRetainedDescendantMetadata()
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    await expect.poll(() => read(page, id)).toEqual(paragraphs)
    await expectRetainedDescendantMetadata()
  })
})
