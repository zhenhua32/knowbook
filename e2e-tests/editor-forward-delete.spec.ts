import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { withElectronApp } from './helpers/electron'

function text(id: string, content: string, type = 'paragraph'): DocumentBlockDraft {
  return { id, type, content, checked: false, depth: 0, tags: [`keep-${id}`], highlight: 'yellow' }
}
function item(id: string, content: string, depth = 0, parentBlockId: string | null = null, type = 'todo'): DocumentBlockDraft {
  const ordered = type.startsWith('numbered-')
  return { id, type, content, checked: type.endsWith('todo'), depth, parentBlockId,
    tags: [`keep-${id}`], highlight: 'blue', ...(ordered ? { listStart: 4 } : {}),
    markdownFormat: { listMarker: ordered ? ')' : '+', listLoose: true } }
}
function snapshot(blocks: DocumentBlockDraft[]) {
  return blocks.map(({ id, type, content, checked, depth, parentBlockId, tags, highlight, language, listStart, markdownFormat }) => ({
    id: id!, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
    tags: tags ?? [], highlight: highlight ?? null, language: language ?? null,
    listStart: listStart ?? null, markdownFormat: markdownFormat ?? null
  }))
}
async function saved(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks.map(
    ({ id, type, content, checked, depth, parentBlockId, tags, highlight, language, listStart, markdownFormat }) => ({
      id, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
      tags: tags ?? [], highlight: highlight ?? null, language: language ?? null,
      listStart: listStart ?? null, markdownFormat: markdownFormat ?? null
    })) ?? [], id)
}
async function reopen(page: Page, title: string) {
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
}
async function openEditor(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await reopen(page, title)
  await expect(page.locator('.block-editor-row')).toHaveCount(blocks.length)
  await expect.poll(() => saved(page, id)).toEqual(snapshot(blocks))
  return id
}
const row = (page: Page, id: string) => page.locator(`[data-block-id="${id}"]`)
const input = (page: Page, id: string) => row(page, id).locator('textarea.block-inline-textarea')
async function select(editor: Locator, start: number, end = start, direction: 'forward' | 'backward' | 'none' = 'none') {
  await editor.focus()
  await editor.evaluate((element, { start, end, direction }) => {
    const textarea = element as HTMLTextAreaElement
    textarea.setSelectionRange(start, end, direction)
  }, { start, end, direction })
}
async function expectCaret(editor: Locator, position: number) {
  await expect(editor).toBeFocused()
  await expect.poll(() => editor.evaluate(element => {
    const textarea = element as HTMLTextAreaElement
    return [textarea.selectionStart, textarea.selectionEnd]
  })).toEqual([position, position])
}
function assertTree(blocks: DocumentBlockDraft[]) {
  expect(new Set(blocks.map(block => block.id)).size).toBe(blocks.length)
  const ancestors: DocumentBlockDraft[] = []
  for (const block of blocks) {
    expect(Number.isInteger(block.depth)).toBe(true)
    expect(block.depth).toBeGreaterThanOrEqual(0)
    expect(block.depth).toBeLessThanOrEqual(6)
    if (block.depth === 0) expect(block.parentBlockId ?? null).toBeNull()
    else {
      expect(['todo', 'numbered-todo', 'bulleted-list', 'numbered-list']).toContain(block.type)
      expect(ancestors[block.depth - 1]?.id).toBe(block.parentBlockId)
      expect(['todo', 'numbered-todo', 'bulleted-list', 'numbered-list']).toContain(ancestors[block.depth - 1]?.type)
    }
    ancestors.length = block.depth + 1
    ancestors[block.depth] = block
  }
}
async function mergeAndRoundTrip(page: Page, id: string, title: string, before: DocumentBlockDraft[], after: DocumentBlockDraft[], leftId: string, rightId: string) {
  assertTree(after)
  const position = before.find(block => block.id === leftId)!.content.length
  const left = input(page, leftId)
  await select(left, position)
  await left.press('Delete')
  await expectCaret(left, position)
  await expect(row(page, rightId)).toHaveCount(0)
  await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
  await left.press('Control+z')
  await expectCaret(left, position)
  await expect.poll(() => saved(page, id)).toEqual(snapshot(before))
  await left.press('Control+Shift+z')
  await expectCaret(left, position)
  await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
  await reopen(page, title)
  await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
  await expect(left).toHaveValue(after.find(block => block.id === leftId)!.content)
}

test('Delete joins ordinary and empty text blocks under the left identity with reversible caret and saved metadata @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Forward text and empty joins'
    let blocks = [text('left', 'Left 中文 😀'), text('right', 'Right', 'quote'), text('separator-a', 'Separator A'),
      text('empty-left', ''), text('nonempty-right', 'Kept text'), text('separator-b', 'Separator B'),
      text('nonempty-left', 'Keep left'), text('empty-right', ''), text('after', 'After')]
    const id = await openEditor(page, title, blocks)
    for (const [leftId, rightId] of [['left', 'right'], ['empty-left', 'nonempty-right'], ['nonempty-left', 'empty-right']]) {
      const left = blocks.find(block => block.id === leftId)!
      const right = blocks.find(block => block.id === rightId)!
      const next = blocks.filter(block => block.id !== rightId).map(block => block.id === leftId
        ? { ...block, content: left.content + right.content } : block)
      await mergeAndRoundTrip(page, id, title, blocks, next, leftId, rightId)
      blocks = next
    }
    expect(blocks.filter(block => ['left', 'empty-left', 'nonempty-left'].includes(block.id!)).map(block => block.tags))
      .toEqual([['keep-left'], ['keep-empty-left'], ['keep-nonempty-left']])
  })
})

test('paragraph Delete absorbs a folded list root and promotes its retained child forest with grandchild identities @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Forward paragraph absorbs list parent'
    const before = [text('left', 'Prefix'), item('right', 'Task'), item('child', 'Child', 1, 'right', 'numbered-todo'),
      item('grandchild', 'Grandchild', 2, 'child'), item('other-child', 'Other child', 1, 'right'), text('after', 'After')]
    const id = await openEditor(page, title, before)
    await row(page, 'right').locator('.block-collapse-toggle').click({ force: true })
    await expect(row(page, 'child')).toHaveCount(0)
    const after = [{ ...before[0], content: 'PrefixTask' },
      { ...before[2], depth: 0, parentBlockId: null }, { ...before[3], depth: 1 },
      { ...before[4], depth: 0, parentBlockId: null }, before[5]]
    await mergeAndRoundTrip(page, id, title, before, after, 'left', 'right')
    await expect(input(page, 'grandchild')).toHaveValue('Grandchild')
    await expect(row(page, 'child').locator('.block-todo-checkbox')).toBeChecked()
    await expect(row(page, 'other-child').locator('.block-todo-checkbox')).toBeChecked()
  })
})

test('list Delete consumes its visible first child and promotes grandchildren before the remaining child siblings @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Forward list consumes first child'
    const before = [item('left', 'Parent', 0, null, 'numbered-todo'), item('right', 'First child', 1, 'left'),
      item('grandchild', 'Grandchild', 2, 'right'), item('great-grandchild', 'Great grandchild', 3, 'grandchild'),
      item('later-child', 'Later child', 1, 'left'), item('later-grandchild', 'Later grandchild', 2, 'later-child'), text('after', 'After')]
    const id = await openEditor(page, title, before)
    const after = [{ ...before[0], content: 'ParentFirst child' },
      { ...before[2], depth: 1, parentBlockId: 'left' }, { ...before[3], depth: 2 }, ...before.slice(4)]
    await mergeAndRoundTrip(page, id, title, before, after, 'left', 'right')
    await expect(row(page, 'left').locator('.block-todo-checkbox')).toBeChecked()
    await row(page, 'left').locator('.block-collapse-toggle').click({ force: true })
    for (const hidden of ['grandchild', 'great-grandchild', 'later-child', 'later-grandchild']) await expect(row(page, hidden)).toHaveCount(0)
    await expect(input(page, 'after')).toHaveValue('After')
    await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
    await reopen(page, title)
    await expect(row(page, 'left').locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    await row(page, 'left').locator('.block-collapse-toggle').click({ force: true })
    await expect(input(page, 'great-grandchild')).toHaveValue('Great grandchild')
  })
})

test('Delete between folded list siblings keeps the left subtree before all reparented right descendants @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Forward folded list sibling joins'
    const before = [item('left', 'Left', 0, null, 'numbered-todo'), item('left-child', 'Left child', 1, 'left'),
      item('left-grandchild', 'Left grandchild', 2, 'left-child'), item('right', 'Right', 0, null, 'bulleted-list'),
      item('right-child', 'Right child', 1, 'right', 'numbered-todo'), item('right-grandchild', 'Right grandchild', 2, 'right-child'), text('after', 'After')]
    const id = await openEditor(page, title, before)
    for (const id of ['left', 'right']) await row(page, id).locator('.block-collapse-toggle').click({ force: true })
    for (const hidden of ['left-child', 'left-grandchild', 'right-child', 'right-grandchild']) await expect(row(page, hidden)).toHaveCount(0)
    const after = [{ ...before[0], content: 'LeftRight' }, before[1], before[2],
      { ...before[4], parentBlockId: 'left' }, before[5], before[6]]
    await mergeAndRoundTrip(page, id, title, before, after, 'left', 'right')
    await expect(row(page, 'left').locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    for (const hidden of ['left-child', 'left-grandchild', 'right-child', 'right-grandchild']) await expect(row(page, hidden)).toHaveCount(0)
    await row(page, 'left').locator('.block-collapse-toggle').click({ force: true })
    for (const child of ['left-child', 'left-grandchild', 'right-child', 'right-grandchild']) await expect(input(page, child)).toBeVisible()
    await expect(row(page, 'right-child').locator('.block-todo-checkbox')).toBeChecked()
    await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
  })
})

test('folded list Delete can absorb a shallower successor while depth overflow rejects the whole next merge @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Forward joins across nesting depths'
    const before = [item('outer', 'Outer'), item('branch', 'Branch', 1, 'outer'), item('left', 'Left', 2, 'branch'),
      item('left-child', 'Left child', 3, 'left'), item('left-grandchild', 'Left grandchild', 4, 'left-child'),
      item('right', 'Right', 1, 'outer'), item('right-child', 'Right child', 2, 'right'), item('right-grandchild', 'Right grandchild', 3, 'right-child'),
      item('tail', 'Tail', 1, 'outer'), item('overflow-root', 'Overflow root'),
      ...Array.from({ length: 5 }, (_, index) => item(`overflow-${index + 1}`, `Overflow ${index + 1}`, index + 1,
        index ? `overflow-${index}` : 'overflow-root')),
      item('overflow-old-child', 'Old depth-six child', 6, 'overflow-5'), item('overflow-right', 'Deep right', 1, 'overflow-root'),
      ...Array.from({ length: 5 }, (_, index) => item(`overflow-right-${index + 2}`, `Deep child ${index + 2}`, index + 2,
        index ? `overflow-right-${index + 1}` : 'overflow-right')),
      text('after', 'After')]
    const id = await openEditor(page, title, before)
    await row(page, 'left').locator('.block-collapse-toggle').click({ force: true })
    await row(page, 'right').locator('.block-collapse-toggle').click({ force: true })
    const after = before.filter(block => block.id !== 'right').map(block => block.id === 'left'
      ? { ...block, content: 'LeftRight' } : block.id === 'right-child'
        ? { ...block, depth: 3, parentBlockId: 'left' } : block.id === 'right-grandchild' ? { ...block, depth: 4 } : block)
    await mergeAndRoundTrip(page, id, title, before, after, 'left', 'right')
    await row(page, 'overflow-5').locator('.block-collapse-toggle').click({ force: true })
    await expect(row(page, 'overflow-old-child')).toHaveCount(0)
    const overflow = input(page, 'overflow-5')
    await select(overflow, 'Overflow 5'.length)
    await overflow.press('Delete')
    await expectCaret(overflow, 'Overflow 5'.length)
    await expect(input(page, 'overflow-right')).toHaveValue('Deep right')
    await expect(input(page, 'overflow-right-6')).toHaveValue('Deep child 6')
    await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
    await reopen(page, title)
    await expect(row(page, 'overflow-5').locator('.block-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
  })
})

test('structured blocks and a folded heading body stop forward Delete without destroying an existing redo @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Forward merge hard boundaries'
    const structured: DocumentBlockDraft[] = [
      { ...text('code', 'console.log("code")', 'code'), language: 'typescript', markdownFormat: { codeInfo: 'typescript' } },
      text('table', '| Name | Value |\n| --- | --- |\n| A | B |', 'table'), text('math', 'x^2', 'math'),
      text('html', '<details><summary>Info</summary>Body</details>', 'html'), text('frontmatter', 'title: Boundary', 'frontmatter'),
      text('divider', '', 'divider')]
    const before = [text('probe-left', 'Probe'), text('probe-right', 'Redo'), ...structured.flatMap(block =>
      [text(`before-${block.id}`, `Before ${block.type}`), block, text(`after-${block.id}`, `After ${block.type}`)]),
      text('heading', 'Folded section', 'heading-1'), text('hidden-body', 'Hidden body'), item('hidden-list', 'Hidden list'),
      item('hidden-child', 'Hidden child', 1, 'hidden-list'), text('next-heading', 'Next section', 'heading-1'), text('last', 'Last')]
    const id = await openEditor(page, title, before)
    const probe = input(page, 'probe-left')
    await select(probe, 'Probe'.length)
    await probe.press('Delete')
    const redone = before.filter(block => block.id !== 'probe-right').map(block => block.id === 'probe-left' ? { ...block, content: 'ProbeRedo' } : block)
    await expect.poll(() => saved(page, id)).toEqual(snapshot(redone))
    await probe.press('Control+z')
    await expect.poll(() => saved(page, id)).toEqual(snapshot(before))
    for (const block of structured) {
      const editor = input(page, `before-${block.id}`)
      const position = `Before ${block.type}`.length
      await select(editor, position)
      await editor.press('Delete')
      await expectCaret(editor, position)
      await expect(row(page, block.id!)).toHaveCount(1)
    }
    await row(page, 'heading').locator('.section-collapse-toggle').click({ force: true })
    await expect(row(page, 'hidden-body')).toHaveCount(0)
    await expect(row(page, 'hidden-list')).toHaveCount(0)
    const heading = input(page, 'heading')
    await select(heading, 'Folded section'.length)
    await heading.press('Delete')
    await expectCaret(heading, 'Folded section'.length)
    await expect(row(page, 'heading').locator('.section-collapse-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(input(page, 'next-heading')).toHaveValue('Next section')
    const last = input(page, 'last')
    await select(last, 'Last'.length)
    await last.press('Delete')
    await expectCaret(last, 'Last'.length)
    await expect.poll(() => saved(page, id)).toEqual(snapshot(before))
    await last.press('Control+Shift+z')
    await expectCaret(probe, 'Probe'.length)
    await expect.poll(() => saved(page, id)).toEqual(snapshot(redone))
    await reopen(page, title)
    await expect(row(page, 'hidden-body')).toHaveCount(0)
    await expect.poll(() => saved(page, id)).toEqual(snapshot(redone))
  })
})

test('middle Delete and selected-text Delete remain native while IME and modifiers cannot merge blocks @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Forward Delete native and composition guards'
    const before = [text('left', 'ABCDE'), text('right', 'Right'), text('after', 'After')]
    const id = await openEditor(page, title, before)
    const left = input(page, 'left')
    await select(left, 2)
    await left.press('Delete')
    await expectCaret(left, 2)
    await expect.poll(() => saved(page, id)).toEqual(snapshot([{ ...before[0], content: 'ABDE' }, ...before.slice(1)]))
    await left.press('Control+z')
    await expect.poll(() => saved(page, id)).toEqual(snapshot(before))
    await select(left, 1, 4, 'backward')
    await left.press('Delete')
    const selectedDelete = [{ ...before[0], content: 'AE' }, ...before.slice(1)]
    await expectCaret(left, 1)
    await expect.poll(() => saved(page, id)).toEqual(snapshot(selectedDelete))
    await left.press('Control+z')
    await expect.poll(() => saved(page, id)).toEqual(snapshot(before))
    await select(left, before[0].content.length)
    const guarded = await left.evaluate(element => {
      const options = [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]
      const results = options.map(option => {
        const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true, ...option })
        element.dispatchEvent(event)
        return event.defaultPrevented
      })
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }))
      const composing = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      element.dispatchEvent(composing)
      results.push(composing.defaultPrevented)
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
      return results
    })
    expect(guarded).toEqual(Array(7).fill(false))
    await expectCaret(left, before[0].content.length)
    await expect(page.locator('.block-editor-row')).toHaveCount(before.length)
    await expect.poll(() => saved(page, id)).toEqual(snapshot(before))
    await left.press('Control+Shift+z')
    await expectCaret(left, 1)
    await expect.poll(() => saved(page, id)).toEqual(snapshot(selectedDelete))
    await reopen(page, title)
    await expect(input(page, 'right')).toHaveValue('Right')
    await expect.poll(() => saved(page, id)).toEqual(snapshot(selectedDelete))
  })
})

test('Delete keeps the existing folded multi-block selection deletion ahead of forward text merging @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Forward Delete retains multi-block deletion'
    const before = [text('before', 'Before'), item('first', 'First'), item('first-child', 'First child', 1, 'first'),
      item('first-grandchild', 'First grandchild', 2, 'first-child'), item('second', 'Second'), item('second-child', 'Second child', 1, 'second'), text('after', 'After')]
    const id = await openEditor(page, title, before)
    for (const id of ['first', 'second']) await row(page, id).locator('.block-collapse-toggle').click({ force: true })
    const first = input(page, 'first')
    await first.click()
    await first.press('End')
    await first.press('Shift+ArrowDown')
    await expect.poll(() => page.locator('.block-editor-row-selected').evaluateAll(rows => rows.map(row => row.getAttribute('data-block-id'))))
      .toEqual(['first', 'second'])
    const second = input(page, 'second')
    await expect(second).toBeFocused()
    await second.press('Delete')
    const after = [before[0], before.at(-1)!]
    await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
    await expect(page.locator('.block-editor-row-selected')).toHaveCount(0)
    await expect(input(page, 'before')).toHaveValue('Before')
    await expectCaret(input(page, 'after'), 0)
    await input(page, 'after').press('Control+z')
    await expect.poll(() => saved(page, id)).toEqual(snapshot(before))
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
    await reopen(page, title)
    await expect(page.locator('.block-editor-row')).toHaveCount(2)
    await expect.poll(() => saved(page, id)).toEqual(snapshot(after))
  })
})
