import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { withElectronApp } from './helpers/electron'

const input = (page: Page, id: string) => page.locator(`[data-block-id="${id}"] textarea.block-inline-textarea`)

async function readBlocks(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(
    ({ id, type, content, checked, depth, parentBlockId, tags, highlight, language }) => ({
      id, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
      tags: tags ?? [], highlight: highlight ?? null, language: language ?? null
    })), id)
}

async function reopen(page: Page, title: string) {
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}

async function openFixture(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await reopen(page, title)
  await expect(page.locator('.block-editor-row')).toHaveCount(blocks.length)
  return id
}

async function select(editor: Locator, start: number, end: number, direction: 'forward' | 'backward' = 'forward') {
  await editor.focus()
  await editor.evaluate((element: HTMLTextAreaElement, { start, end, direction }) => {
    element.setSelectionRange(start, end, direction)
    element.dispatchEvent(new Event('select', { bubbles: true }))
  }, { start, end, direction })
}

async function expectSelection(editor: Locator, start: number, end = start, direction?: string) {
  await expect(editor).toBeFocused()
  await expect.poll(() => editor.evaluate((element: HTMLTextAreaElement, withDirection) => withDirection
    ? [element.selectionStart, element.selectionEnd, element.selectionDirection]
    : [element.selectionStart, element.selectionEnd], Boolean(direction)))
    .toEqual(direction ? [start, end, direction] : [start, end])
}

// Electron's clipboard fixture plus a trusted key exercises Chromium's real
// default plain-text paste too, including source blocks whose handler returns.
async function pasteHtml(app: ElectronApplication, editor: Locator, html: string, text: string) {
  await app.evaluate(({ clipboard }, data) => { clipboard.write(data) }, { html, text })
  await editor.press('Control+v')
}

test('Markdown single-line HTML paste keeps formatting, identity, caret and separate typing undo through reload @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    const title = 'Markdown HTML inline clipboard', original = 'Before original After'
    const id = await openFixture(page, title, [
      { id: 'html-inline', type: 'paragraph', content: original, checked: false, depth: 0,
        tags: ['keep-inline'], highlight: 'yellow' }
    ])
    const before = await readBlocks(page, id), editor = input(page, 'html-inline')
    const markdown = '**Bold** [Link](<https://example.test/path>)'
    const pasted = 'Before ' + markdown + ' After', cursor = 7 + markdown.length
    await select(editor, 7, 15, 'backward')
    await pasteHtml(app, editor,
      '<p data-block-id="foreign-inline"><strong>Bold</strong> <a href="https://example.test/path">Link</a></p>',
      'Plain alternative must not replace formatting')
    await expect(editor).toHaveValue(pasted)
    await expectSelection(editor, cursor)
    const after = before.map(block => ({ ...block, content: pasted }))
    await expect.poll(() => readBlocks(page, id)).toEqual(after)
    await editor.pressSequentially('!')
    await expect(editor).toHaveValue(pasted.slice(0, cursor) + '!' + pasted.slice(cursor))
    await editor.press('Control+z')
    await expect(editor).toHaveValue(pasted)
    await expectSelection(editor, cursor)
    await editor.press('Control+z')
    await expect(editor).toHaveValue(original)
    await expectSelection(editor, 7, 15, 'backward')
    await editor.press('Control+Shift+z')
    await expect(editor).toHaveValue(pasted)
    await expectSelection(editor, cursor)
    await expect.poll(() => readBlocks(page, id)).toEqual(after)
    await reopen(page, title)
    await expect(input(page, 'html-inline')).toHaveValue(pasted)
    expect(await readBlocks(page, id)).toEqual(after)
  })
})

test('Markdown structural HTML paste preserves old children and converts headings, nested lists and tables with fresh identities @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    const title = 'Markdown HTML structure clipboard'
    const id = await openFixture(page, title, [
      { id: 'html-parent', type: 'todo', content: 'Original parent', checked: true, depth: 0,
        tags: ['keep-parent'], highlight: 'blue' },
      { id: 'html-old-child', type: 'todo', content: 'Original child', checked: true, depth: 1,
        parentBlockId: 'html-parent', tags: ['keep-child'], highlight: 'yellow' },
      { id: 'html-tail', type: 'paragraph', content: 'Tail stays', checked: false, depth: 0 }
    ])
    const before = await readBlocks(page, id), parent = input(page, 'html-parent')
    await select(parent, 0, 'Original parent'.length, 'backward')
    await pasteHtml(app, parent,
      '<h2 data-block-id="foreign-heading">Copied heading</h2>'
        + '<ul><li id="foreign-parent">New list<ul><li data-block-id="foreign-child">Nested</li></ul></li></ul>'
        + '<table><tr><th>Name</th><th>Value</th></tr><tr><td><strong>One</strong></td><td>Two</td></tr></table>'
        + '<p>Last line</p><script>window.sourceClipboardUnsafe=true</script>',
      'Plain alternative must not replace structure')
    await expect(page.locator('.block-editor-row')).toHaveCount(7)
    await expect.poll(async () => (await readBlocks(page, id)).map(block => block.type))
      .toEqual(['heading-2', 'todo', 'bulleted-list', 'bulleted-list', 'table', 'paragraph', 'paragraph'])
    const after = await readBlocks(page, id)
    expect(after[0]).toEqual({ ...before[0], type: 'heading-2', content: 'Copied heading', checked: false })
    expect(after[1]).toEqual({ ...before[1], depth: 0, parentBlockId: null })
    expect(after[2]).toMatchObject({ content: 'New list', depth: 0, parentBlockId: null })
    expect(after[3]).toMatchObject({ content: 'Nested', depth: 1, parentBlockId: after[2].id })
    expect(after[4]).toMatchObject({ type: 'table', depth: 0, parentBlockId: null })
    expect(after[4].content).toContain('| **One** | Two |')
    expect(after[5]).toMatchObject({ content: 'Last line', depth: 0, parentBlockId: null })
    expect(after[6]).toEqual(before[2])
    expect(new Set(after.map(block => block.id)).size).toBe(after.length)
    for (const block of after.slice(2, 6)) {
      expect(before.some(old => old.id === block.id)).toBe(false)
      expect(block.id).not.toMatch(/^foreign-/)
    }
    expect(after.map(block => block.content).join('\n')).not.toContain('sourceClipboardUnsafe')
    expect(await page.evaluate(() => (window as unknown as { sourceClipboardUnsafe?: boolean }).sourceClipboardUnsafe)).toBeUndefined()
    await expectSelection(input(page, after[5].id), 'Last line'.length)
    await input(page, after[5].id).press('Control+z')
    await expect.poll(() => readBlocks(page, id)).toEqual(before)
    await expectSelection(parent, 0, 'Original parent'.length, 'backward')
    await parent.press('Control+Shift+z')
    await expect.poll(() => readBlocks(page, id)).toEqual(after)
    await expectSelection(input(page, after[5].id), 'Last line'.length)
    await reopen(page, title)
    await expect(input(page, after[3].id)).toHaveValue('Nested')
    expect(await readBlocks(page, id)).toEqual(after)
  })
})

test('code, math, table, frontmatter and HTML source paste retain literal plain text instead of clipboard HTML conversion @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    const types = ['code', 'math', 'table', 'frontmatter', 'html'], title = 'Literal source HTML clipboard'
    const id = await openFixture(page, title, types.map(type => ({
      id: `html-source-${type}`, type, content: 'Original source', checked: false, depth: 0,
      tags: ['keep-source'], highlight: 'yellow', ...(type === 'code' ? { language: 'python' } : {})
    })))
    const before = await readBlocks(page, id)
    const literal = 'literal **stars**\n# Still source\n<ul>markup stays</ul>'
    for (const type of types) {
      const row = page.locator(`[data-block-id="html-source-${type}"]`)
      if (type === 'table') await row.locator('details.markdown-table-source summary').click()
      const editor = input(page, `html-source-${type}`)
      await select(editor, 0, 'Original source'.length)
      await pasteHtml(app, editor, '<h2>Converted heading</h2><p><strong>Converted bold</strong></p>', literal)
      await expect(editor).toHaveValue(literal)
      await expect(editor).toHaveClass(new RegExp(`type-${type}(?:\\s|$)`))
    }
    const after = before.map(block => ({ ...block, content: literal }))
    await expect.poll(() => readBlocks(page, id)).toEqual(after)
    await expect(page.locator('.block-editor-row')).toHaveCount(types.length)
    await reopen(page, title)
    expect(await readBlocks(page, id)).toEqual(after)
    for (const type of types) await expect(input(page, `html-source-${type}`)).toHaveValue(literal)
  })
})
