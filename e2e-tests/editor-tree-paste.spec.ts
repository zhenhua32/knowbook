import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { withElectronApp } from './helpers/electron'

function item(id: string, content: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft {
  return { id, type: 'todo', content, checked: true, depth, parentBlockId, tags: [`keep-${id}`], highlight: 'blue',
    markdownFormat: { listMarker: '+', listLoose: true } }
}
function tree(nested = true): DocumentBlockDraft[] {
  const depth = nested ? 1 : 0
  return [
    ...(nested ? [item('outer', 'Outer')] : []),
    item('parent', 'Parent 中文 😀', depth, nested ? 'outer' : null),
    item('child', 'Child', depth + 1, 'parent'),
    { ...item('grandchild', 'Grandchild', depth + 2, 'child'), type: 'bulleted-list', checked: false },
    { ...item('other-child', 'Other child', depth + 1, 'parent'), type: 'numbered-todo', listStart: 4,
      markdownFormat: { listMarker: ')', listLoose: true } },
    item('tail', 'Tail', depth, nested ? 'outer' : null),
    item('tail-child', 'Tail child', depth + 1, 'tail'),
    { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0 }
  ]
}
function snapshot(blocks: DocumentBlockDraft[]) {
  return blocks.map(({ id, type, content, checked, depth, parentBlockId, tags, highlight, language, markdownFormat, listStart }) => ({
    id: id!, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
    tags: tags ?? [], highlight: highlight ?? null, language: language ?? null,
    markdownFormat: markdownFormat ?? null, listStart: listStart ?? null
  }))
}
async function savedTree(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks
    .map(({ id, type, content, checked, depth, parentBlockId, tags, highlight, language, markdownFormat, listStart }) => ({
      id, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
      tags: tags ?? [], highlight: highlight ?? null, language: language ?? null,
      markdownFormat: markdownFormat ?? null, listStart: listStart ?? null
    })) ?? [], id)
}
async function openEditor(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await reopen(page, title)
  await expect(page.locator('.block-editor-row')).toHaveCount(blocks.length)
  await expect.poll(() => savedTree(page, id)).toEqual(snapshot(blocks))
  return id
}
async function reopen(page: Page, title: string) {
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
}
const row = (page: Page, id: string) => page.locator(`[data-block-id="${id}"]`)
const input = (page: Page, id: string) => row(page, id).locator('textarea.block-inline-textarea')
async function selectAll(editor: Locator, direction: 'forward' | 'backward' = 'forward') {
  await editor.focus()
  await editor.evaluate((element, direction) => {
    const textarea = element as HTMLTextAreaElement
    textarea.setSelectionRange(0, textarea.value.length, direction)
  }, direction)
}
async function paste(editor: Locator, text: string) {
  expect(await editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }, text), 'the editor applies the simulated paste as one structural transaction').toBe(true)
}
async function expectSelection(editor: Locator, start: number, end = start, direction?: string) {
  await expect(editor).toBeFocused()
  await expect.poll(() => editor.evaluate((element, withDirection) => {
    const textarea = element as HTMLTextAreaElement
    return withDirection ? [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]
      : [textarea.selectionStart, textarea.selectionEnd]
  }, Boolean(direction))).toEqual(direction ? [start, end, direction] : [start, end])
}
async function waitSavedContents(page: Page, id: string, contents: string[]) {
  await expect.poll(async () => (await savedTree(page, id)).map(block => block.content)).toEqual(contents)
  return savedTree(page, id)
}
function assertTree(blocks: Awaited<ReturnType<typeof savedTree>>) {
  expect(new Set(blocks.map(block => block.id)).size).toBe(blocks.length)
  const ancestors: typeof blocks = []
  for (const block of blocks) {
    expect(block.depth).toBeGreaterThanOrEqual(0)
    expect(block.depth).toBeLessThanOrEqual(6)
    if (block.depth === 0) expect(block.parentBlockId).toBeNull()
    else {
      expect(['todo', 'numbered-todo', 'bulleted-list', 'numbered-list']).toContain(block.type)
      expect(ancestors[block.depth - 1]?.id).toBe(block.parentBlockId)
      expect(['todo', 'numbered-todo', 'bulleted-list', 'numbered-list']).toContain(ancestors[block.depth - 1]?.type)
    }
    ancestors.length = block.depth + 1
    ancestors[block.depth] = block
  }
}
function pasted(id: string, content: string, depth: number, parentBlockId: string | null, type = 'bulleted-list') {
  return snapshot([{ id, type, content, checked: false, depth, parentBlockId,
    markdownFormat: { listMarker: '-', listLoose: false } }])[0]
}

for (const nested of [false, true]) {
  test(`multiline paste into a ${nested ? 'nested' : 'root'} parent preserves complete child identities, backwards undo and folded reload @electron`, async () => {
    await withElectronApp(async ({ page }) => {
      const title = `Preserve ${nested ? 'nested' : 'root'} parent paste`
      const initial = tree(nested)
      const id = await openEditor(page, title, initial)
      const original = snapshot(initial)
      const offset = nested ? 1 : 0
      const parent = input(page, 'parent')
      await selectAll(parent, 'backward')
      await paste(parent, '- [ ] New parent\n  - Pasted child\n- Second\n  - Last pasted child')
      const result = await waitSavedContents(page, id, [...(nested ? ['Outer'] : []), 'New parent', 'Pasted child',
        'Child', 'Grandchild', 'Other child', 'Second', 'Last pasted child', 'Tail', 'Tail child', 'After'])
      assertTree(result)
      const firstChild = result[offset + 1]
      const second = result[offset + 5]
      const last = result[offset + 6]
      for (const block of [firstChild, second, last]) expect(original.some(old => old.id === block.id)).toBe(false)
      const expected = [
        ...original.slice(0, offset),
        { ...original[offset], content: 'New parent', checked: false, markdownFormat: { listMarker: '-' as const, listLoose: false } },
        pasted(firstChild.id, 'Pasted child', offset + 1, 'parent'), ...original.slice(offset + 1, offset + 4),
        pasted(second.id, 'Second', offset, nested ? 'outer' : null),
        pasted(last.id, 'Last pasted child', offset + 1, second.id), ...original.slice(offset + 4)
      ]
      expect(result).toEqual(expected)
      await expectSelection(input(page, last.id), last.content.length)
      await expect(row(page, 'parent').locator('.block-todo-checkbox')).not.toBeChecked()
      await expect(row(page, 'child').locator('.block-todo-checkbox')).toBeChecked()

      await input(page, last.id).press('Control+z')
      await expect.poll(() => savedTree(page, id)).toEqual(original)
      await expectSelection(parent, 0, initial[offset].content.length, 'backward')
      await parent.press('Control+Shift+z')
      await expect.poll(() => savedTree(page, id)).toEqual(expected)
      await expectSelection(input(page, last.id), last.content.length)

      await row(page, 'parent').locator('.block-collapse-toggle').click({ force: true })
      await expect(row(page, 'parent').locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
      for (const hidden of [firstChild.id, 'child', 'grandchild', 'other-child']) await expect(row(page, hidden)).toHaveCount(0)
      await expectSelection(input(page, last.id), last.content.length)
      await expect.poll(() => savedTree(page, id)).toEqual(expected)
      await reopen(page, title)
      await expect(row(page, 'parent').locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
      await expect(input(page, second.id)).toHaveValue('Second')
      for (const hidden of [firstChild.id, 'child', 'grandchild', 'other-child']) await expect(row(page, hidden)).toHaveCount(0)
      await row(page, 'parent').locator('.block-collapse-toggle').click({ force: true })
      await expect(input(page, 'grandchild')).toHaveValue('Grandchild')
      await expect(input(page, 'other-child')).toHaveValue('Other child')
      await expect.poll(() => savedTree(page, id)).toEqual(expected)
    })
  })
}

for (const headingFirst of [true, false]) {
  test(`${headingFirst ? 'first' : 'later'} pasted heading promotes the old enclosing-list tail and keeps later lists independent @electron`, async () => {
    await withElectronApp(async ({ page }) => {
      const title = `${headingFirst ? 'First' : 'Later'} heading parent paste`
      const initial = tree()
      const original = snapshot(initial)
      const id = await openEditor(page, title, initial)
      const parent = input(page, 'parent')
      await selectAll(parent, 'backward')
      await paste(parent, headingFirst ? '# Heading\n\n- New root\n  - New child'
        : '- Replacement\n  - Pasted child\n\n# Heading\n\n- New root\n  - New child')
      const result = await waitSavedContents(page, id, headingFirst
        ? ['Outer', 'Heading', 'Child', 'Grandchild', 'Other child', 'New root', 'New child', 'Tail', 'Tail child', 'After']
        : ['Outer', 'Replacement', 'Pasted child', 'Child', 'Grandchild', 'Other child', 'Heading', 'New root', 'New child', 'Tail', 'Tail child', 'After'])
      assertTree(result)
      const heading = result.find(block => block.content === 'Heading')!
      const newRoot = result.find(block => block.content === 'New root')!
      const newChild = result.find(block => block.content === 'New child')!
      const expected = [original[0], ...(headingFirst
        ? [{ ...original[1], type: 'heading-1', content: 'Heading', checked: false, depth: 0, parentBlockId: null, markdownFormat: null },
          { ...original[2], depth: 0, parentBlockId: null }, { ...original[3], depth: 1 },
          { ...original[4], depth: 0, parentBlockId: null }]
        : [{ ...original[1], type: 'bulleted-list', content: 'Replacement', checked: false,
            markdownFormat: { listMarker: '-' as const, listLoose: false } },
          pasted(result[2].id, 'Pasted child', 2, 'parent'), ...original.slice(2, 5),
          snapshot([{ id: heading.id, type: 'heading-1', content: 'Heading', checked: false, depth: 0 }])[0]]),
        pasted(newRoot.id, 'New root', 0, null), pasted(newChild.id, 'New child', 1, newRoot.id),
        { ...original[5], depth: 0, parentBlockId: null }, { ...original[6], depth: 1 }, original[7]]
      expect(result).toEqual(expected)
      expect(newRoot.parentBlockId).toBeNull()
      expect(newChild.parentBlockId).toBe(newRoot.id)
      expect(newChild.parentBlockId).not.toBe(heading.id)
      await expectSelection(input(page, newChild.id), newChild.content.length)
      await input(page, newChild.id).press('Control+z')
      await expect.poll(() => savedTree(page, id)).toEqual(original)
      await expectSelection(parent, 0, initial[1].content.length, 'backward')
      await parent.press('Control+Shift+z')
      await expect.poll(() => savedTree(page, id)).toEqual(expected)
      await expectSelection(input(page, newChild.id), newChild.content.length)
      await reopen(page, title)
      await expect(input(page, 'other-child')).toHaveValue('Other child')
      await expect(input(page, 'tail-child')).toHaveValue('Tail child')
      await expect.poll(() => savedTree(page, id)).toEqual(expected)
    })
  })
}

test('depth-five paste preserves overflowing Markdown verbatim and its original depth-six child through history and reload @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Keep overflowing nested paste source'
    const initial = Array.from({ length: 7 }, (_, depth) => item(`level-${depth}`, `Level ${depth}`, depth, depth ? `level-${depth - 1}` : null))
    const original = snapshot(initial)
    const id = await openEditor(page, title, initial)
    const target = input(page, 'level-5')
    const text = '- Replacement\n  - Child\n    - Grandchild'
    await selectAll(target, 'backward')
    await paste(target, text)
    const expected = original.map(block => block.id === 'level-5' ? { ...block, content: text } : block)
    await expect(target).toHaveValue(text)
    await expectSelection(target, text.length)
    await expect(row(page, 'level-5').locator('.block-todo-checkbox')).toBeChecked()
    await expect(input(page, 'level-6')).toHaveValue('Level 6')
    await expect(page.locator('.block-editor-row')).toHaveCount(initial.length)
    await expect.poll(() => savedTree(page, id)).toEqual(expected)
    await target.press('Control+z')
    await expect.poll(() => savedTree(page, id)).toEqual(original)
    await expectSelection(target, 0, initial[5].content.length, 'backward')
    await target.press('Control+Shift+z')
    await expectSelection(target, text.length)
    await expect.poll(() => savedTree(page, id)).toEqual(expected)
    await reopen(page, title)
    await expect(target).toHaveValue(text)
    await expect(input(page, 'level-6')).toHaveValue('Level 6')
    await expect.poll(() => savedTree(page, id)).toEqual(expected)
  })
})

test('pasting only a new child into a folded parent reveals its necessary ancestors and focuses that pasted child @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Reveal newly pasted folded child'
    const initial = tree()
    const original = snapshot(initial)
    const id = await openEditor(page, title, initial)
    for (const id of ['child', 'tail', 'parent']) {
      await row(page, id).locator('.block-collapse-toggle').click({ force: true })
      await expect(row(page, id).locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    }
    await expect(row(page, 'child')).toHaveCount(0)
    const parent = input(page, 'parent')
    await selectAll(parent)
    await paste(parent, '- Replacement\n  - New child')
    const result = await waitSavedContents(page, id, ['Outer', 'Replacement', 'New child', 'Child', 'Grandchild', 'Other child', 'Tail', 'Tail child', 'After'])
    assertTree(result)
    const child = result[2]
    const expected = [original[0], { ...original[1], type: 'bulleted-list', content: 'Replacement', checked: false,
      markdownFormat: { listMarker: '-' as const, listLoose: false } }, pasted(child.id, 'New child', 2, 'parent'), ...original.slice(2)]
    expect(result).toEqual(expected)
    await expectSelection(input(page, child.id), child.content.length)
    await expect(row(page, 'parent').locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(row(page, 'child').locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(row(page, 'tail').locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(row(page, 'grandchild')).toHaveCount(0)
    await expect(row(page, 'tail-child')).toHaveCount(0)
    await expect(input(page, 'other-child')).toHaveValue('Other child')
    await expect.poll(() => savedTree(page, id)).toEqual(expected)
    await reopen(page, title)
    await expect(input(page, child.id)).toHaveValue('New child')
    await expect(row(page, 'child').locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(row(page, 'tail-child')).toHaveCount(0)
    await expect.poll(() => savedTree(page, id)).toEqual(expected)
  })
})

test('replacing a parent and first child promotes the unselected sibling instead of adopting it into the pasted tree @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Replace partial parent block range'
    const initial = tree()
    const original = snapshot(initial)
    const id = await openEditor(page, title, initial)
    const parent = input(page, 'parent')
    await parent.click()
    await input(page, 'child').click({ modifiers: ['Shift'] })
    await expect.poll(() => page.locator('.block-editor-row-selected').evaluateAll(rows => rows.map(row => row.getAttribute('data-block-id'))))
      .toEqual(['parent', 'child'])
    await paste(parent, '- New\n  - New child')
    const result = await waitSavedContents(page, id, ['Outer', 'New', 'New child', 'Other child', 'Tail', 'Tail child', 'After'])
    assertTree(result)
    const root = result[1]
    const child = result[2]
    expect(original.some(block => block.id === root.id || block.id === child.id)).toBe(false)
    const expected = [original[0], pasted(root.id, 'New', 1, 'outer'), pasted(child.id, 'New child', 2, root.id),
      { ...original[4], depth: 1, parentBlockId: 'outer' }, ...original.slice(5)]
    expect(result).toEqual(expected)
    for (const deleted of ['parent', 'child', 'grandchild']) await expect(row(page, deleted)).toHaveCount(0)
    await expect(page.locator('.block-editor-row-selected')).toHaveCount(0)
    await expectSelection(input(page, child.id), child.content.length)
    await input(page, child.id).press('Control+z')
    await expect.poll(() => savedTree(page, id)).toEqual(original)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => savedTree(page, id)).toEqual(expected)
    await expectSelection(input(page, child.id), child.content.length)
    await reopen(page, title)
    await expect(input(page, 'other-child')).toHaveValue('Other child')
    await expect(row(page, 'other-child').locator('.block-todo-checkbox')).toBeChecked()
    await expect.poll(() => savedTree(page, id)).toEqual(expected)
  })
})
