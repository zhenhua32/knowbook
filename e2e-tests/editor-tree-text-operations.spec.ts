import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { withElectronApp } from './helpers/electron'

function tree(parentContent = 'Beta'): DocumentBlockDraft[] {
  return [
    { id: 'before', type: 'paragraph', content: 'Alpha', checked: false, depth: 0 },
    { id: 'parent', type: 'bulleted-list', content: parentContent, checked: false, depth: 0 },
    { id: 'child', type: 'todo', content: 'Child', checked: true, depth: 1, parentBlockId: 'parent' },
    { id: 'grandchild', type: 'bulleted-list', content: 'Grandchild', checked: false, depth: 2, parentBlockId: 'child' },
    { id: 'other-child', type: 'bulleted-list', content: 'Other child', checked: false, depth: 1, parentBlockId: 'parent' },
    { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0 }
  ]
}

async function openTreeEditor(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('textarea.block-inline-textarea')).toHaveCount(blocks.length)
  return id
}

async function putCaretAtStart(editor: Locator) {
  await editor.focus()
  await editor.evaluate(element => {
    const textarea = element as HTMLTextAreaElement
    textarea.setSelectionRange(0, 0)
    textarea.dispatchEvent(new Event('select', { bubbles: true }))
  })
}

async function persistedTree(page: Page, documentId: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks
    .map(({ id, type, content, depth, parentBlockId }) => [id, type, content, depth, parentBlockId ?? null]), documentId)
}

test('Backspace downgrades then merges a list parent while preserving its saved child trees and undo focus @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Preserve list children during Backspace'
    const id = await openTreeEditor(page, title, tree())
    const parent = page.locator('[data-block-id="parent"] textarea')
    await putCaretAtStart(parent)
    await parent.press('Backspace')
    await expect(parent).toHaveClass(/type-paragraph/)
    await expect(parent).toBeFocused()
    const downgraded = [
      ['before', 'paragraph', 'Alpha', 0, null], ['parent', 'paragraph', 'Beta', 0, null],
      ['child', 'todo', 'Child', 0, null], ['grandchild', 'bulleted-list', 'Grandchild', 1, 'child'],
      ['other-child', 'bulleted-list', 'Other child', 0, null], ['after', 'paragraph', 'After', 0, null]
    ]
    await expect.poll(() => persistedTree(page, id)).toEqual(downgraded)
    await expect(page.locator('[data-block-id="child"] .block-todo-checkbox')).toBeChecked()

    await parent.press('Backspace')
    const merged = page.locator('[data-block-id="before"] textarea')
    await expect(merged).toHaveValue('AlphaBeta')
    await expect(merged).toBeFocused()
    expect(await merged.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(5)
    const expected = [['before', 'paragraph', 'AlphaBeta', 0, null], ...downgraded.slice(2)]
    await expect.poll(() => persistedTree(page, id)).toEqual(expected)
    await merged.press('Control+z')
    await expect(parent).toBeFocused()
    await expect(parent).toHaveValue('Beta')
    expect(await parent.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(0)
    await expect.poll(() => persistedTree(page, id)).toEqual(downgraded)
    await parent.press('Control+Shift+z')
    await expect(merged).toBeFocused()
    await expect.poll(() => persistedTree(page, id)).toEqual(expected)
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    await expect(page.locator('textarea.block-inline-textarea')).toHaveCount(5)
    await expect(page.locator('[data-block-id="grandchild"] textarea')).toHaveValue('Grandchild')
    await expect(page.locator('[data-block-id="other-child"] textarea')).toHaveValue('Other child')
    await expect.poll(() => persistedTree(page, id)).toEqual(expected)
  })
})

test('Enter exits an empty list parent while keeping all descendants saved with valid relationships @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await openTreeEditor(page, 'Exit empty list parent', tree(''))
    const parent = page.locator('[data-block-id="parent"] textarea')
    await putCaretAtStart(parent)
    await parent.press('Enter')
    await expect(parent).toHaveClass(/type-paragraph/)
    await expect(parent).toBeFocused()
    await expect.poll(() => persistedTree(page, id)).toEqual([
      ['before', 'paragraph', 'Alpha', 0, null], ['parent', 'paragraph', '', 0, null],
      ['child', 'todo', 'Child', 0, null], ['grandchild', 'bulleted-list', 'Grandchild', 1, 'child'],
      ['other-child', 'bulleted-list', 'Other child', 0, null], ['after', 'paragraph', 'After', 0, null]
    ])
    await parent.press('Control+z')
    await expect(parent).toHaveClass(/type-bulleted-list/)
    await expect.poll(() => persistedTree(page, id)).toEqual([
      ['before', 'paragraph', 'Alpha', 0, null], ['parent', 'bulleted-list', '', 0, null],
      ['child', 'todo', 'Child', 1, 'parent'], ['grandchild', 'bulleted-list', 'Grandchild', 2, 'child'],
      ['other-child', 'bulleted-list', 'Other child', 1, 'parent'], ['after', 'paragraph', 'After', 0, null]
    ])
  })
})
