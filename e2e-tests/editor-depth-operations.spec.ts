import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { uiText, withElectronApp } from './helpers/electron'

function nestedTree(): DocumentBlockDraft[] {
  return [
    { id: 'outer', type: 'bulleted-list', content: 'Outer', checked: false, depth: 0 },
    { id: 'b', type: 'todo', content: 'Task B', checked: true, depth: 1, parentBlockId: 'outer', tags: ['keep-task'], highlight: 'yellow' },
    { id: 'c', type: 'bulleted-list', content: 'Child C', checked: false, depth: 2, parentBlockId: 'b' },
    { id: 's', type: 'bulleted-list', content: 'Sibling S', checked: false, depth: 1, parentBlockId: 'outer' },
    { id: 's-child', type: 'bulleted-list', content: 'Sibling child', checked: false, depth: 2, parentBlockId: 's' },
    { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0 }
  ]
}

function snapshot(blocks: DocumentBlockDraft[]) {
  return blocks.map(({ id, type, content, checked, depth, parentBlockId, tags, highlight }) => ({
    id, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
    tags: tags ?? [], highlight: highlight ?? null
  }))
}

async function persistedTree(page: Page, documentId: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks
    .map(({ id, type, content, checked, depth, parentBlockId, tags, highlight }) => ({
      id, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
      tags: tags ?? [], highlight: highlight ?? null
    })), documentId)
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

async function putCaret(editor: Locator, position: number) {
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

async function visibleIds(page: Page, selected = false) {
  return page.locator(selected ? '.block-editor-row-selected' : '.block-editor-row')
    .evaluateAll(rows => rows.map(row => row.getAttribute('data-block-id')))
}

test('Shift+Tab moves a nested task subtree beyond its old parent and preserves focus, undo and saved identity @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Outdent nested task subtree'
    const initial = nestedTree()
    const id = await openTreeEditor(page, title, initial)
    const task = page.locator('[data-block-id="b"] textarea')
    const outdented = [
      initial[0], initial[3], initial[4],
      { ...initial[1], depth: 0, parentBlockId: null },
      { ...initial[2], depth: 1 }, initial[5]
    ]

    await putCaret(task, 3)
    await task.press('Shift+Tab')
    await expectCaret(task, 3)
    await expect.poll(() => visibleIds(page)).toEqual(['outer', 's', 's-child', 'b', 'c', 'after'])
    await expect(page.locator('[data-block-id="b"] .block-todo-checkbox')).toBeChecked()
    await expect.poll(() => persistedTree(page, id)).toEqual(snapshot(outdented))

    await task.press('Control+z')
    await expectCaret(task, 3)
    await expect.poll(() => visibleIds(page)).toEqual(['outer', 'b', 'c', 's', 's-child', 'after'])
    await expect.poll(() => persistedTree(page, id)).toEqual(snapshot(initial))
    await task.press('Control+Shift+z')
    await expectCaret(task, 3)
    await expect.poll(() => persistedTree(page, id)).toEqual(snapshot(outdented))

    const outer = page.locator('[data-block-id="outer"]')
    await outer.locator('.block-collapse-toggle').click({ force: true })
    await expect(outer.locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => visibleIds(page)).toEqual(['outer', 'b', 'c', 'after'])
    await expect(page.locator('[data-block-id="c"] textarea')).toHaveValue('Child C')
    await expectCaret(task, 3)

    // A selected folded parent deletes its complete subtree; a plain row delete promotes children.
    const outerText = outer.locator('textarea')
    await outerText.focus()
    await outerText.click({ modifiers: ['Shift'] })
    await outer.hover()
    await outer.locator('.block-drag-handle').click()
    const menu = page.locator('.block-context-menu')
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: uiText('Delete', '删除'), exact: true }).click()
    await expect(menu).toHaveCount(0)
    const remaining = outdented.slice(3)
    await expect.poll(() => visibleIds(page)).toEqual(['b', 'c', 'after'])
    await expect(page.locator('[data-block-id="b"] .block-todo-checkbox')).toBeChecked()
    await expect.poll(() => persistedTree(page, id)).toEqual(snapshot(remaining))

    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    await expect.poll(() => visibleIds(page)).toEqual(['b', 'c', 'after'])
    await expect(task).toHaveValue('Task B')
    await expect(page.locator('[data-block-id="c"] textarea')).toHaveValue('Child C')
    await expect(page.locator('[data-block-id="b"] .block-todo-checkbox')).toBeChecked()
    await expect.poll(() => persistedTree(page, id)).toEqual(snapshot(remaining))
  })
})

test('Shift+Tab and Tab move selected folded sibling subtrees together and retain their visible selection @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const initial = nestedTree()
    initial.splice(3, 0,
      { id: 'd', type: 'bulleted-list', content: 'Sibling D', checked: false, depth: 1, parentBlockId: 'outer' },
      { id: 'e', type: 'bulleted-list', content: 'Child E', checked: false, depth: 2, parentBlockId: 'd' })
    const id = await openTreeEditor(page, 'Outdent selected folded siblings', initial)
    const task = page.locator('[data-block-id="b"] textarea')
    for (const blockId of ['b', 'd']) {
      const toggle = page.locator(`[data-block-id="${blockId}"] .block-collapse-toggle`)
      await toggle.click({ force: true })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    }
    await expect.poll(() => visibleIds(page)).toEqual(['outer', 'b', 'd', 's', 's-child', 'after'])
    await task.click()
    await task.press('End')
    await task.press('Shift+ArrowDown')
    await expect(page.locator('.block-selection-toolbar')).toBeVisible()
    await expect.poll(() => visibleIds(page, true)).toEqual(['b', 'd'])

    await task.press('Shift+Tab')
    const outdented = [
      initial[0], initial[5], initial[6],
      { ...initial[1], depth: 0, parentBlockId: null }, { ...initial[2], depth: 1 },
      { ...initial[3], depth: 0, parentBlockId: null }, { ...initial[4], depth: 1 }, initial[7]
    ]
    await expectCaret(task, 'Task B'.length)
    await expect.poll(() => visibleIds(page)).toEqual(['outer', 's', 's-child', 'b', 'd', 'after'])
    await expect.poll(() => visibleIds(page, true)).toEqual(['b', 'd'])
    await expect(page.locator('[data-block-id="c"]')).toHaveCount(0)
    await expect(page.locator('[data-block-id="e"]')).toHaveCount(0)
    await expect.poll(() => persistedTree(page, id)).toEqual(snapshot(outdented))

    await task.press('Tab')
    const indented = [initial[0], initial[5], initial[6], initial[1], initial[2], initial[3], initial[4], initial[7]]
    await expectCaret(task, 'Task B'.length)
    await expect.poll(() => visibleIds(page, true)).toEqual(['b', 'd'])
    await expect.poll(() => persistedTree(page, id)).toEqual(snapshot(indented))
    for (const blockId of ['b', 'd']) {
      await expect(page.locator(`[data-block-id="${blockId}"] .block-collapse-toggle`))
        .toHaveAttribute('aria-expanded', 'false')
    }
    await expect(page.locator('[data-block-id="b"] .block-todo-checkbox')).toBeChecked()
    await expect(page.locator('[data-block-id="c"]')).toHaveCount(0)
    await expect(page.locator('[data-block-id="e"]')).toHaveCount(0)
  })
})
