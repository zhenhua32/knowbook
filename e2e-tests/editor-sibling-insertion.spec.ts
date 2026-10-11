import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { withElectronApp } from './helpers/electron'

function tree(content = 'Parent'): DocumentBlockDraft[] {
  return [
    { id: 'outer', type: 'bulleted-list', content: 'Outer', checked: false, depth: 0 },
    { id: 'parent', type: 'todo', content, checked: true, depth: 1, parentBlockId: 'outer',
      tags: ['keep'], highlight: 'yellow', markdownFormat: { listMarker: '+', listLoose: true } },
    { id: 'child', type: 'bulleted-list', content: 'Child', checked: false, depth: 2, parentBlockId: 'parent' },
    { id: 'grandchild', type: 'todo', content: 'Grandchild', checked: true, depth: 3, parentBlockId: 'child' },
    { id: 'sibling', type: 'bulleted-list', content: 'Sibling', checked: false, depth: 1, parentBlockId: 'outer' },
    { id: 'sibling-child', type: 'bulleted-list', content: 'Sibling child', checked: false, depth: 2, parentBlockId: 'sibling' },
    { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0 }
  ]
}

function snapshot(blocks: DocumentBlockDraft[]) {
  return blocks.map(({ id, type, content, checked, depth, parentBlockId, tags, highlight, markdownFormat, listStart }) => ({
    id, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
    tags: tags ?? [], highlight: highlight ?? null, markdownFormat: markdownFormat ?? null, listStart: listStart ?? null
  }))
}

async function savedTree(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks
    .map(({ id, type, content, checked, depth, parentBlockId, tags, highlight, markdownFormat, listStart }) => ({
      id, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
      tags: tags ?? [], highlight: highlight ?? null, markdownFormat: markdownFormat ?? null, listStart: listStart ?? null
    })), id)
}

async function caret(editor: Locator, position: number) {
  await editor.focus()
  await editor.evaluate((element, position) => {
    const textarea = element as HTMLTextAreaElement
    textarea.setSelectionRange(position, position)
    textarea.dispatchEvent(new Event('select', { bubbles: true }))
  }, position)
}

async function expectCaret(editor: Locator, position: number) {
  await expect(editor).toBeFocused()
  await expect.poll(() => editor.evaluate(element => {
    const textarea = element as HTMLTextAreaElement
    return [textarea.selectionStart, textarea.selectionEnd]
  })).toEqual([position, position])
}

for (const mode of ['keyboard', 'button', 'slash-below', 'slash-above'] as const) {
  test(`${mode} inserts a nested sibling without splitting child trees and persists undo/redo @electron`, async () => {
    await withElectronApp(async ({ page }) => {
      const title = `Sibling insertion ${mode}`
      const command = mode === 'slash-above' ? 'above' : 'below'
      const initial = tree(mode.startsWith('slash') ? `/${command} Parent` : 'Parent')
      const originalCaret = mode.startsWith('slash') ? command.length + 1 : initial[1].content.length
      const id = await page.evaluate(async ({ title, blocks }) => {
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title, summary: '', blocks })
        return id
      }, { title, blocks: initial })
      await page.reload()
      await page.locator('.tree-button', { hasText: title }).first().click()
      await expect(page.locator('.block-editor-row')).toHaveCount(initial.length)
      const parent = page.locator('[data-block-id="parent"] textarea')
      await caret(parent, originalCaret)
      if (mode.startsWith('slash')) {
        // Native key events update React's selection tracking after positioning
        // the caret in seeded text, just as navigating an existing note does.
        await parent.press('ArrowLeft')
        await parent.press('ArrowRight')
        await expectCaret(parent, originalCaret)
      }
      if (mode === 'keyboard') await parent.press('Control+Enter')
      else if (mode === 'button') await page.locator('[data-block-id="parent"] .block-hover-add').click({ force: true })
      else await page.locator('.slash-command-item').filter({ has: page.locator('.slash-command-id', { hasText: `/${command}` }) }).click()

      await expect(page.locator('.block-editor-row')).toHaveCount(initial.length + 1)
      const insertionIndex = mode === 'slash-above' ? 1 : 4
      const newRow = page.locator('.block-editor-row').nth(insertionIndex)
      const newId = await newRow.getAttribute('data-block-id')
      expect(newId).toBeTruthy()
      expect(initial.some(block => block.id === newId)).toBe(false)
      const inserted = newRow.locator('textarea')
      await expectCaret(inserted, 0)
      const expected = initial.map(block => block.id === 'parent' && mode.startsWith('slash')
        ? { ...block, content: ' Parent' } : block)
      expected.splice(insertionIndex, 0, { id: newId!, type: 'todo', content: '', checked: false,
        depth: 1, parentBlockId: 'outer', markdownFormat: { listMarker: '+', listLoose: true } })
      await expect.poll(() => savedTree(page, id)).toEqual(snapshot(expected))
      await expect(page.locator('[data-block-id="parent"] .block-todo-checkbox')).toBeChecked()
      await expect(newRow.locator('.block-todo-checkbox')).not.toBeChecked()

      await inserted.press('Control+z')
      await expect(page.locator('.block-editor-row')).toHaveCount(initial.length)
      await expect.poll(() => savedTree(page, id)).toEqual(snapshot(initial))
      await expectCaret(parent, originalCaret)
      await parent.press('Control+Shift+z')
      const restored = page.locator(`[data-block-id="${newId}"] textarea`)
      await expectCaret(restored, 0)
      await expect.poll(() => savedTree(page, id)).toEqual(snapshot(expected))

      const toggle = page.locator('[data-block-id="parent"] .block-collapse-toggle')
      await toggle.click({ force: true })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('[data-block-id="child"]')).toHaveCount(0)
      await expect(page.locator('[data-block-id="grandchild"]')).toHaveCount(0)
      await expect(page.locator(`[data-block-id="${newId}"]`)).toBeVisible()
      await expect(page.locator('[data-block-id="sibling-child"]')).toBeVisible()
      await expect.poll(() => savedTree(page, id)).toEqual(snapshot(expected))
      await page.reload()
      await page.locator('.tree-button', { hasText: title }).first().click()
      await expect.poll(() => savedTree(page, id)).toEqual(snapshot(expected))
      await expect(page.locator(`[data-block-id="${newId}"] textarea`)).toHaveValue('')
      await expect(page.locator('[data-block-id="sibling-child"] textarea')).toHaveValue('Sibling child')
    })
  })
}
