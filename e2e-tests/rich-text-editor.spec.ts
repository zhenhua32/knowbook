import { setRichTextDomSelection } from './helpers/rich-text-selection'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { closeElectronApp, launchElectronApp, uiText } from './helpers/electron'
import { selectSource, sourceValue } from './helpers/markdown-source'

const editor = (page: Page) => page.locator('.knowbook-rich-text-editor')
const rows = (page: Page) => editor(page).locator('.block-editor-row')
const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0 })

async function openFixture(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await reopen(page, title)
  await expect(editor(page)).toBeVisible()
  await expect(rows(page)).toHaveCount(blocks.length)
  return id
}

async function reopen(page: Page, title: string) {
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}

async function detail(page: Page, id: string) {
  return page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
}

async function save(page: Page) {
  await page.locator('.document-header-save-button').click()
}

type Point = { blockId: string; offset: number }

// Select through Chromium's actual DOM selection, never a ProseMirror test API.
// Input, formatting, deletion, history and clipboard commands remain real keys.
async function selectRich(page: Page, from: Point, to = from, backward = false) {
  await editor(page).evaluate(setRichTextDomSelection, { from, to, backward })
  // Let native selectionchange reach the editor before the trusted key event.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function selectionPoints(input: Locator) {
  return input.evaluate(root => {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return null
    const point = (node: Node, offset: number) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement
      const row = element?.closest<HTMLElement>('.block-editor-row')
      if (!row || !root.contains(row)) return null
      const before = document.createRange()
      before.selectNodeContents(row)
      before.setEnd(node, offset)
      return { blockId: row.dataset.blockId, offset: before.toString().length }
    }
    return { anchor: point(selection.anchorNode, selection.anchorOffset), head: point(selection.focusNode, selection.focusOffset) }
  })
}

test('rich text is the default and formatted text saves and reloads without visible Markdown markers @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context
    expect(await page.evaluate(() => localStorage.getItem('knowbook.document-editor-mode'))).toBeNull()
    const title = 'Rich formatting persistence', block = paragraph('rich-format', '**bold** *italic* ~~old~~ ==marked== `code` [Link](https://example.test)')
    const id = await openFixture(page, title, [block])
    const body = rows(page).first()
    await expect(body).toHaveText('bold italic old marked code Link')
    await expect(body.locator('strong')).toHaveText('bold')
    await expect(body.locator('em')).toHaveText('italic')
    await expect(body.locator('s')).toHaveText('old')
    await expect(body.locator('mark')).toHaveText('marked')
    await expect(body.locator('code')).toHaveText('code')
    await expect(body.locator('a')).toHaveAttribute('href', 'https://example.test')
    await page.screenshot({ path: 'test-results/rich-text-editor.png', fullPage: true })
    await selectRich(page, { blockId: block.id!, offset: 0 }, { blockId: block.id!, offset: 4 })
    await page.locator('.rich-text-toolbar').getByRole('button', { name: uiText('Bold', '加粗'), exact: true }).click()
    await expect(body.locator('strong')).toHaveCount(0)
    await page.keyboard.press('End')
    await page.keyboard.insertText(' appended')
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks[0].content).toContain('appended')
    expect((await detail(page, id))?.blocks[0].id).toBe(block.id)
    await reopen(page, title)
    await expect(editor(page)).toBeVisible()
    await expect(rows(page).first()).toHaveText('bold italic old marked code Link appended')
    await expect(rows(page).first().locator('em')).toHaveText('italic')
    await expect(rows(page).first().locator('strong')).toHaveCount(0)
  } finally {
    await closeElectronApp(context)
  }
})

test('Ctrl+B formats a real partial cross-paragraph DOM Range and preserves reversed selection through history @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich cross paragraph formatting'
    const id = await openFixture(page, title, [paragraph('range-first', 'abcdef'), paragraph('range-second', 'ghijkl')])
    const from = { blockId: 'range-first', offset: 2 }, to = { blockId: 'range-second', offset: 4 }
    await selectRich(page, from, to, true)
    await expect.poll(() => selectionPoints(editor(page))).toEqual({ anchor: to, head: from })
    await page.keyboard.press('Control+b')
    await expect(rows(page).nth(0).locator('strong')).toHaveText('cdef')
    await expect(rows(page).nth(1).locator('strong')).toHaveText('ghij')
    await expect(rows(page).nth(0)).toHaveText('abcdef')
    await expect(rows(page).nth(1)).toHaveText('ghijkl')
    await page.screenshot({ path: 'test-results/rich-text-cross-selection.png', fullPage: true })
    await page.keyboard.press('Control+z')
    await expect(editor(page).locator('strong')).toHaveCount(0)
    await expect.poll(() => selectionPoints(editor(page))).toEqual({ anchor: to, head: from })
    await page.keyboard.press('Control+Shift+z')
    await expect(editor(page).locator('strong')).toHaveCount(2)
    await expect.poll(() => selectionPoints(editor(page))).toEqual({ anchor: to, head: from })
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks.map(block => [block.id, block.content]))
      .toEqual([['range-first', 'ab**cdef**'], ['range-second', '**ghij**kl']])
    await reopen(page, title)
    await expect(rows(page).nth(0).locator('strong')).toHaveText('cdef')
    await expect(rows(page).nth(1).locator('strong')).toHaveText('ghij')
  } finally {
    await closeElectronApp(context)
  }
})

for (const action of ['replace', 'backspace'] as const) test(`partial cross-paragraph ${action} keeps the first identity and restores backward selection with Ctrl+Z @electron`, async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = `Rich cross paragraph ${action}`
    const blocks: DocumentBlockDraft[] = [
      { ...paragraph('replace-first', 'abcdef'), tags: ['keep-first'], highlight: 'yellow' },
      { ...paragraph('replace-second', 'ghijkl'), tags: ['keep-second'] },
      paragraph('replace-tail', 'Tail stays')
    ]
    const id = await openFixture(page, title, blocks)
    const from = { blockId: 'replace-first', offset: 2 }, to = { blockId: 'replace-second', offset: 4 }
    await selectRich(page, from, to, true)
    if (action === 'replace') await page.keyboard.insertText('X')
    else await page.keyboard.press('Backspace')
    await expect(rows(page)).toHaveCount(2)
    await expect(rows(page).first()).toHaveText(action === 'replace' ? 'abXkl' : 'abkl')
    await expect(rows(page).first()).toHaveAttribute('data-block-id', 'replace-first')
    await expect(rows(page).last()).toHaveText('Tail stays')
    await page.keyboard.press('Control+z')
    await expect(rows(page)).toHaveCount(3)
    await expect(rows(page).nth(0)).toHaveText('abcdef')
    await expect(rows(page).nth(1)).toHaveText('ghijkl')
    await expect.poll(() => selectionPoints(editor(page))).toEqual({ anchor: to, head: from })
    await page.keyboard.press('Control+Shift+z')
    await expect(rows(page)).toHaveCount(2)
    await expect(rows(page).first()).toHaveText(action === 'replace' ? 'abXkl' : 'abkl')
    await page.keyboard.press('Control+z')
    await expect.poll(() => selectionPoints(editor(page))).toEqual({ anchor: to, head: from })
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks.map(block => ({ id: block.id, content: block.content, tags: block.tags, highlight: block.highlight })))
      .toEqual(blocks.map(block => ({ id: block.id, content: block.content, tags: block.tags, highlight: block.highlight })))
  } finally {
    await closeElectronApp(context)
  }
})

test('Enter splits text, Shift+Enter saves a hard break, and list Backspace exits list formatting @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich structural keyboard editing'
    const id = await openFixture(page, title, [paragraph('split-text', 'abcdef')])
    await selectRich(page, { blockId: 'split-text', offset: 3 })
    await page.keyboard.press('Enter')
    await expect(rows(page)).toHaveCount(2)
    await expect(rows(page).first()).toHaveText('abc')
    await expect(rows(page).last()).toHaveText('def')
    const splitId = (await rows(page).last().getAttribute('data-block-id'))!
    expect(splitId).not.toBe('split-text')
    await page.keyboard.insertText('New')
    await page.keyboard.press('Shift+Enter')
    await expect(rows(page)).toHaveCount(2)
    await expect(rows(page).last().locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1)
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks[1].content).toMatch(/^New(?:\\| {2})\ndef$/)
    await reopen(page, title)
    await expect(rows(page).last().locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1)

    const listTitle = 'Rich list Backspace'
    const listId = await openFixture(page, listTitle, [{ ...paragraph('list-root', 'List item'), type: 'bulleted-list' }])
    await selectRich(page, { blockId: 'list-root', offset: 0 })
    await page.keyboard.press('Backspace')
    await expect(rows(page).first()).toHaveAttribute('data-block-type', 'paragraph')
    await expect(rows(page).first()).toHaveText('List item')
    await save(page)
    await expect.poll(async () => (await detail(page, listId))?.blocks[0].type).toBe('paragraph')
  } finally {
    await closeElectronApp(context)
  }
})

test('real HTML clipboard paste retains external formatting and text while discarding scripts and unsafe URLs @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { app, page } = context, title = 'Rich HTML clipboard'
    const id = await openFixture(page, title, [paragraph('paste-body', '')])
    await selectRich(page, { blockId: 'paste-body', offset: 0 })
    await app.evaluate(({ clipboard }) => {
      clipboard.clear()
      clipboard.write({
        text: 'Copied heading\nBold and italic Safe link Keep unsafe Keep image\nOne\nNested',
        html: '<h2>Copied heading</h2><p><strong>Bold</strong> and <em>italic</em> <a href="https://example.test">Safe link</a> '
          + '<a href="javascript:alert(1)">Keep unsafe</a> <img src="data:image/svg+xml,bad" alt="Keep image"></p>'
          + '<ul><li>One<ul><li>Nested</li></ul></li></ul><script>window.richClipboardUnsafe=true</script>'
      })
    })
    await page.keyboard.press('Control+v')
    await expect(editor(page).locator('h2')).toHaveText('Copied heading')
    await expect(editor(page).locator('strong')).toHaveText('Bold')
    await expect(editor(page).locator('em')).toHaveText('italic')
    await expect(editor(page).locator('a')).toHaveAttribute('href', 'https://example.test/')
    await expect(editor(page)).toContainText('Keep unsafe')
    await expect(editor(page)).toContainText('Keep image')
    await expect(editor(page)).toContainText('Nested')
    await expect(editor(page).locator('script, img[src^="data:"], a[href^="javascript:"]')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { richClipboardUnsafe?: boolean }).richClipboardUnsafe)).toBeUndefined()
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks.some(block => block.type === 'heading-2')).toBe(true)
    const pasted = (await detail(page, id))!.blocks
    expect(pasted.some(block => block.type === 'bulleted-list' && block.depth === 1)).toBe(true)
    expect(pasted.map(block => block.content).join('\n')).not.toMatch(/richClipboardUnsafe|javascript:|data:image/)
    await reopen(page, title)
    await expect(editor(page).locator('strong')).toHaveText('Bold')
    await expect(editor(page)).toContainText('Keep image')
  } finally {
    await closeElectronApp(context)
  }
})

test('switching the default rich editor to Markdown persists the user choice across reloads @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich mode preference'
    await openFixture(page, title, [paragraph('mode-body', '**Formatted** body')])
    const modes = page.locator('.document-editor-mode')
    await expect(modes.getByRole('button', { name: uiText('Rich text', '富文本'), exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => localStorage.getItem('knowbook.document-editor-mode'))).toBeNull()
    await modes.getByRole('button', { name: 'Markdown', exact: true }).click()
    await expect(editor(page)).toHaveCount(0)
    await expect(page.locator('[data-block-id="mode-body"] .block-inline-textarea')).toHaveValue('**Formatted** body')
    expect(await page.evaluate(() => localStorage.getItem('knowbook.document-editor-mode'))).toBe('markdown')
    await reopen(page, title)
    await expect(editor(page)).toHaveCount(0)
    await expect(page.locator('.document-editor-mode').getByRole('button', { name: 'Markdown', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.locator('.document-editor-mode').getByRole('button', { name: uiText('Rich text', '富文本'), exact: true }).click()
    await expect(editor(page).locator('strong')).toHaveText('Formatted')
    await reopen(page, title)
    await expect(editor(page)).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('knowbook.document-editor-mode'))).toBe('rich')
  } finally {
    await closeElectronApp(context)
  }
})

test('rich text edits and the source fallback preserve complex block IDs and metadata through save and reload @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich complex source preservation'
    const initial: DocumentBlockDraft[] = [
      { ...paragraph('source-body', 'Body'), tags: ['body-tag'], highlight: 'yellow' },
      { ...paragraph('source-code', 'const x = 1'), type: 'code', language: 'typescript', markdownFormat: { codeInfo: 'ts title=sample' }, tags: ['code-tag'], highlight: 'blue' },
      { ...paragraph('source-table', '| A | B |\n| --- | --- |\n| Keep | Value |'), type: 'table', tags: ['table-tag'] },
      { ...paragraph('source-math', 'x^2 + y^2'), type: 'math', tags: ['math-tag'] },
      { ...paragraph('source-list', 'List item'), type: 'numbered-list', listStart: 5, markdownFormat: { listMarker: ')', listLoose: false }, tags: ['list-tag'] }
    ]
    const id = await openFixture(page, title, initial)
    const original = (await detail(page, id))!.blocks
    await expect(editor(page).locator('.rich-text-source-block')).toHaveCount(3)
    await selectRich(page, { blockId: 'source-body', offset: 4 })
    await page.keyboard.insertText(' edited')
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks[0].content).toBe('Body edited')
    expect((await detail(page, id))!.blocks.slice(1)).toEqual(original.slice(1))
    await editor(page).locator('[data-block-id="source-code"]').getByRole('button', { name: uiText('Edit source', '编辑源码'), exact: true }).click()
    const sourceDialog = page.locator('.document-markdown-source')
    const source = sourceDialog.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码') })
    await expect(source).toBeVisible()
    const markdown = await sourceValue(source), start = markdown.indexOf('const x = 1')
    expect(start).toBeGreaterThanOrEqual(0)
    await selectSource(source, start, start + 'const x = 1'.length)
    await page.keyboard.insertText('const x = 2')
    await sourceDialog.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true }).click()
    await expect(sourceDialog).toHaveCount(0)
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks.find(block => block.id === 'source-code')?.content).toBe('const x = 2')
    const changed = (await detail(page, id))!.blocks
    expect(changed.map(block => ({ ...block, content: block.id === 'source-body' ? 'Body' : block.id === 'source-code' ? 'const x = 1' : block.content }))).toEqual(original)
    await reopen(page, title)
    await expect(editor(page).locator('[data-block-id="source-body"]')).toHaveText('Body edited')
    await expect(editor(page).locator('[data-block-id="source-code"] .rich-text-source-preview')).toContainText('const x = 2')
    expect((await detail(page, id))!.blocks).toEqual(changed)
  } finally {
    await closeElectronApp(context)
  }
})

test('splitting a list parent places the new sibling after its complete existing subtree @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich list subtree split'
    const initial: DocumentBlockDraft[] = [
      { ...paragraph('parent-split', 'abcdef'), type: 'bulleted-list', tags: ['parent'], highlight: 'yellow' },
      { ...paragraph('child-split', 'Existing child'), type: 'bulleted-list', depth: 1, parentBlockId: 'parent-split', tags: ['child'] },
      { ...paragraph('grandchild-split', 'Existing grandchild'), type: 'todo', depth: 2, parentBlockId: 'child-split', checked: true, tags: ['grandchild'] },
      paragraph('tail-split', 'Tail')
    ]
    const id = await openFixture(page, title, initial)
    await selectRich(page, { blockId: 'parent-split', offset: 3 })
    await page.keyboard.press('Enter')
    await expect(rows(page)).toHaveCount(5)
    await expect(rows(page).nth(0)).toHaveText('abc')
    await expect(rows(page).nth(1)).toHaveAttribute('data-block-id', 'child-split')
    await expect(rows(page).nth(2)).toHaveAttribute('data-block-id', 'grandchild-split')
    await expect(rows(page).nth(3)).toHaveText('def')
    await expect(rows(page).nth(3)).toHaveAttribute('data-block-type', 'bulleted-list')
    await expect(rows(page).nth(3)).toHaveAttribute('data-block-depth', '0')
    const siblingId = (await rows(page).nth(3).getAttribute('data-block-id'))!
    expect(siblingId).not.toBe('parent-split')
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks.map(block => [block.id, block.content, block.depth, block.parentBlockId]))
      .toEqual([
        ['parent-split', 'abc', 0, null], ['child-split', 'Existing child', 1, 'parent-split'],
        ['grandchild-split', 'Existing grandchild', 2, 'child-split'], [siblingId, 'def', 0, null], ['tail-split', 'Tail', 0, null]
      ])
    const split = (await detail(page, id))!.blocks
    expect(split[0].tags).toEqual(['parent'])
    expect(split[1].tags).toEqual(['child'])
    expect(split[2].checked).toBe(true)
    expect(split[2].tags).toEqual(['grandchild'])
    await editor(page).focus()
    await page.keyboard.press('Control+z')
    await expect(rows(page)).toHaveCount(4)
    await expect(rows(page).first()).toHaveText('abcdef')
    await page.keyboard.press('Control+Shift+z')
    await expect(rows(page).nth(3)).toHaveAttribute('data-block-id', siblingId)
    await save(page)
    await reopen(page, title)
    await expect(rows(page).nth(1)).toHaveAttribute('data-block-id', 'child-split')
    expect((await detail(page, id))!.blocks).toEqual(split)
  } finally {
    await closeElectronApp(context)
  }
})

test('task checkbox clicks still update the correct task after earlier text insertion and Enter shift positions @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich task widget identity'
    const id = await openFixture(page, title, [
      paragraph('before-tasks', 'Lead'),
      { ...paragraph('task-alpha', 'Alpha task'), type: 'todo' },
      { ...paragraph('task-beta', 'Beta task'), type: 'todo' }
    ])
    await selectRich(page, { blockId: 'before-tasks', offset: 0 })
    await page.keyboard.insertText('Prefix ')
    await editor(page).locator('[data-block-id="task-alpha"] input[type="checkbox"]').check()
    await expect(editor(page).locator('[data-block-id="task-alpha"] input[type="checkbox"]')).toBeChecked()
    await expect(editor(page).locator('[data-block-id="task-beta"] input[type="checkbox"]')).not.toBeChecked()
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks.map(block => [block.id, block.content, block.checked]))
      .toEqual([['before-tasks', 'Prefix Lead', false], ['task-alpha', 'Alpha task', true], ['task-beta', 'Beta task', false]])

    await selectRich(page, { blockId: 'before-tasks', offset: 7 })
    await page.keyboard.press('Enter')
    await expect(rows(page)).toHaveCount(4)
    const insertedId = (await rows(page).nth(1).getAttribute('data-block-id'))!
    await expect(rows(page).nth(1)).toHaveText('Lead')
    await editor(page).locator('[data-block-id="task-beta"] input[type="checkbox"]').check()
    await save(page)
    await expect.poll(async () => (await detail(page, id))?.blocks.map(block => [block.id, block.content, block.checked]))
      .toEqual([['before-tasks', 'Prefix ', false], [insertedId, 'Lead', false], ['task-alpha', 'Alpha task', true], ['task-beta', 'Beta task', true]])
    await reopen(page, title)
    await expect(editor(page).locator('[data-block-id="task-alpha"] input[type="checkbox"]')).toBeChecked()
    await expect(editor(page).locator('[data-block-id="task-beta"] input[type="checkbox"]')).toBeChecked()
    await expect(rows(page).nth(0)).toHaveText('Prefix ')
    await expect(rows(page).nth(1)).toHaveText('Lead')
  } finally {
    await closeElectronApp(context)
  }
})

test('Chinese IME candidates and keyCode 229 never split or format text and the committed input saves and undoes @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich Chinese composition'
    const id = await openFixture(page, title, [{ ...paragraph('ime-rich', 'Before'), tags: ['retain-ime'] }])
    await selectRich(page, { blockId: 'ime-rich', offset: 6 })
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Input.imeSetComposition', { text: '中文候选', selectionStart: 4, selectionEnd: 4 })
      await expect(rows(page).first()).toHaveText('Before中文候选')
      for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
        await editor(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...flags })
        await editor(page).dispatchEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true, ...flags })
        await expect(rows(page)).toHaveCount(1)
        await expect(rows(page).first()).toHaveText('Before中文候选')
        await expect(editor(page).locator('strong')).toHaveCount(0)
      }
      await cdp.send('Input.insertText', { text: '中文输入' })
      await expect(rows(page).first()).toHaveText('Before中文输入')
      // Exercise the legacy candidate key after composition has finished too.
      await editor(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })
      await editor(page).dispatchEvent('keydown', { key: 'b', ctrlKey: true, keyCode: 229, bubbles: true, cancelable: true })
      await expect(rows(page)).toHaveCount(1)
      await expect(editor(page).locator('strong')).toHaveCount(0)
      await save(page)
      await expect.poll(async () => (await detail(page, id))?.blocks[0].content).toBe('Before中文输入')
      await editor(page).focus()
      await page.keyboard.press('Control+z')
      await expect(rows(page).first()).toHaveText('Before')
      await expect(rows(page)).toHaveCount(1)
      await page.keyboard.press('Control+Shift+z')
      await expect(rows(page).first()).toHaveText('Before中文输入')
      await save(page)
      await reopen(page, title)
      await expect(rows(page).first()).toHaveText('Before中文输入')
      expect((await detail(page, id))!.blocks[0].tags).toEqual(['retain-ime'])
    } finally {
      await cdp.detach()
    }
  } finally {
    await closeElectronApp(context)
  }
})

test('typing Markdown bold and italic delimiters one key at a time applies rich formatting immediately @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context
    for (const example of [
      { token: '**bold**', text: 'bold', tag: 'strong', blockId: 'typed-bold' },
      { token: '*italic*', text: 'italic', tag: 'em', blockId: 'typed-italic' }
    ]) {
      const title = `Rich typed ${example.tag}`
      const id = await openFixture(page, title, [paragraph(example.blockId, '')])
      await selectRich(page, { blockId: example.blockId, offset: 0 })
      await page.keyboard.type(example.token)
      await expect(rows(page).first()).toHaveText(example.text)
      await expect(rows(page).first().locator(example.tag)).toHaveText(example.text)
      await expect(rows(page)).toHaveCount(1)
      await page.keyboard.type(' plain')
      await expect(rows(page).first()).toHaveText(`${example.text} plain`)
      await expect(rows(page).first().locator(example.tag)).toHaveText(example.text)
      await save(page)
      await expect.poll(async () => (await detail(page, id))?.blocks[0].content).toBe(`${example.token} plain`)
      await reopen(page, title)
      await expect(rows(page).first().locator(example.tag)).toHaveText(example.text)
      expect((await detail(page, id))!.blocks[0].id).toBe(example.blockId)
    }
  } finally {
    await closeElectronApp(context)
  }
})
