import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownTable } from '../src/shared/markdownTable.ts'
import { editMarkdownTable, parseEditableMarkdownTable, parseTableClipboard, serializeEditableMarkdownTable } from '../src/shared/markdownTableEditing.ts'
import { parseMarkdownBlocks } from '../src/shared/markdown.ts'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument.ts'
import { markdownTaskPatch } from '../src/shared/markdownTasks.ts'
import { formatMarkdownSelection, markdownFormatShortcut } from '../src/renderer/src/utils/markdownFormatting.ts'
import { markdownEngine } from '../src/shared/markdownEngine.ts'

test('cell editing preserves escaped pipes, code, overflow and reference definitions', () => {
  const source = '| A | B |\n| :- | -: |\n| a\\|b | `c\\|d` | ignored |\n| [ref][r] | \\\\| |\n\n[r]: https://example.com'
  const table = parseEditableMarkdownTable(source)!
  assert.deepEqual(table.rows, [['a|b', '`c|d`'], ['[ref][r]', '\\|']])
  const edited = serializeEditableMarkdownTable(editMarkdownTable(table, { kind: 'cell', row: 1, column: 0, value: '**changed** | okay' }))
  assert.deepEqual(parseMarkdownTable(edited)?.rows, [['**changed** | okay', '`c|d`'], ['[ref][r]', '\\|']])
  assert.ok(edited.includes('| ignored |'))
  assert.ok(edited.endsWith('[r]: https://example.com'))
  assert.equal(serializeEditableMarkdownTable(parseEditableMarkdownTable(edited)!), edited)
})

test('table row, column and alignment operations keep header-only and single-column tables valid', () => {
  let table = parseEditableMarkdownTable('| A |\n| --- |')!
  table = editMarkdownTable(table, { kind: 'delete-column', column: 0 })
  assert.equal(table.headers.length, 1)
  table = editMarkdownTable(table, { kind: 'insert-row', row: 1 })
  table = editMarkdownTable(table, { kind: 'insert-column', column: 1 })
  table = editMarkdownTable(table, { kind: 'align', column: 1, alignment: 'center' })
  table = editMarkdownTable(table, { kind: 'cell', row: 1, column: 1, value: '$x$' })
  assert.deepEqual(parseMarkdownTable(serializeEditableMarkdownTable(table)), { headers: ['A', ''], alignments: [null, 'center'], rows: [['', '$x$']] })
  table = editMarkdownTable(table, { kind: 'delete-row', row: 1 })
  assert.deepEqual(parseMarkdownTable(serializeEditableMarkdownTable(table))?.rows, [])
})

test('spreadsheet paste grows the table and preserves quoted multiline cells as entities', () => {
  const cells = parseTableClipboard('Name\t"a\tb"\n"line 1\nline 2"\t"a""b"\n')
  assert.deepEqual(cells, [['Name', 'a\tb'], ['line 1\nline 2', 'a"b']])
  const table = editMarkdownTable(parseEditableMarkdownTable('| A |\n| - |')!, { kind: 'paste', row: 0, column: 1, cells })
  assert.deepEqual(parseMarkdownTable(serializeEditableMarkdownTable(table)), { headers: ['A', 'Name', 'a&#9;b'], alignments: [null, null, null], rows: [['', 'line 1&#10;line 2', 'a"b']] })
})

test('task edits address exact source markers in nested lists, callouts and footnotes', () => {
  const blocks = parseMarkdownBlocks('- [ ] Parent\n  - [x] Child\n\n> [!note] Work\n> - [ ] Quoted\n>   continuation\n\nText[^n]\n\n[^n]: - [ ] Note\n\n`- [ ] code`\n\n```\n- [ ] fenced\n```')
  const model = parseMarkdownDocumentBlocks(blocks)
  assert.equal(model.taskTargets.size, 4)
  for (const target of model.taskTargets.values()) {
    const patch = markdownTaskPatch(blocks[target.index], target, true)!
    assert.ok(patch)
    if ('content' in patch) {
      assert.equal(patch.content.length, blocks[target.index].content.length)
      assert.equal(patch.content[target.offset!], 'x')
    } else assert.equal(patch.checked, true)
    assert.equal(markdownTaskPatch({ ...blocks[target.index], content: 'changed' }, target, true), null)
  }
})

test('reading list groups follow parsed list boundaries and retain loose paragraphs', () => {
  const blocks = parseMarkdownBlocks('- first\n- second\n\n* third\n\n* fourth\n\n3. ordered\n4. last')
  const model = parseMarkdownDocumentBlocks(blocks)
  assert.equal(model.readingLists.length, 3)
  assert.deepEqual(model.readingLists.map((group) => group.indices.length), [2, 2, 2])
  assert.equal(model.readingLists[0].node.children[0].children[0].token.hidden, true)
  assert.equal(model.readingLists[1].node.children[0].children[0].token.hidden, false)
  assert.equal(Number(model.readingLists[2].node.token.attrGet('start')), 3)
})

test('formatting keeps whitespace outside styles and toggles bold and italic independently', () => {
  const bold = formatMarkdownSelection('前 中文 😀 后', 1, 8, 'bold')
  assert.equal(bold.content, '前 **中文 😀** 后')
  const italic = formatMarkdownSelection(bold.content, bold.start, bold.end, 'italic')
  assert.equal(italic.content, '前 ***中文 😀*** 后')
  const plainBold = formatMarkdownSelection(italic.content, italic.start, italic.end, 'italic')
  assert.deepEqual(plainBold, bold)
  assert.equal(formatMarkdownSelection(bold.content, bold.start, bold.end, 'bold').content, '前 中文 😀 后')
  assert.match(markdownEngine.renderInline(italic.content), /<em><strong>中文 😀<\/strong><\/em>|<strong><em>中文 😀<\/em><\/strong>/)
})

test('code formatting chooses fences for literal backticks and supports removing a complete code span', () => {
  const value = '`a` and b'
  const code = formatMarkdownSelection(value, 0, value.length, 'code')
  assert.equal(markdownEngine.renderInline(code.content), '<code>`a` and b</code>')
  assert.equal(formatMarkdownSelection(code.content, code.start, code.end, 'code').content, value)
  assert.equal(formatMarkdownSelection('`code`', 0, 6, 'code').content, 'code')
})

test('link formatting selects its URL and formatting shortcuts leave global search available', () => {
  const link = formatMarkdownSelection('hello 中文', 6, 8, 'link')
  assert.equal(link.content, 'hello [中文](https://)')
  assert.equal(link.content.slice(link.start, link.end), 'https://')
  assert.equal(markdownFormatShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), null)
  assert.equal(markdownFormatShortcut({ key: 'K', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true }), 'link')
})

test('multiline styles respect paragraph boundaries and toggle a mixed selection as one action', () => {
  for (const [format, tag, marker] of [['bold', 'strong', '**'], ['italic', 'em', '*'], ['strike', 'del', '~~'], ['highlight', 'mark', '=='], ['code', 'code', '`']] as const) {
    for (const newline of ['\n', '\r\n', '\r']) {
      const source = `前 中文 😀${newline}软换行${newline} ${newline}后 日本語`
      const formatted = formatMarkdownSelection(source, 0, source.length, format)
      assert.equal((markdownEngine.render(formatted.content).match(new RegExp(`<${tag}>`, 'g')) ?? []).length, 2)
      assert.equal((markdownEngine.render(formatted.content).match(/<p>/g) ?? []).length, 2)
      assert.equal(formatMarkdownSelection(formatted.content, formatted.start, formatted.end, format).content, source)
      const mixed = `${marker}One${marker}${newline}${newline}Two`
      const uniform = formatMarkdownSelection(mixed, 0, mixed.length, format)
      assert.equal(uniform.content, `${marker}One${marker}${newline}${newline}${marker}Two${marker}`)
      assert.equal(formatMarkdownSelection(uniform.content, uniform.start, uniform.end, format).content, `One${newline}${newline}Two`)
    }
  }
})

test('cross-block formatting preserves structural markers, literal blocks and unreferenced footnotes', () => {
  const source = '# Title\n\n- [ ] Task\n- List\n\n> Quote\n> continued\n\n> [!note] Note\n> Body\n\n```ts\nconst literal = 1\n```\n\n$$\nx + y\n$$\n\n[^unused]: Footnote\n\nLast'
  const result = formatMarkdownSelection(source, 0, source.length, 'bold')
  assert.equal(result.content, '# **Title**\n\n- [ ] **Task**\n- **List**\n\n> **Quote\n> continued**\n\n> [!note] **Note**\n> **Body**\n\n```ts\nconst literal = 1\n```\n\n$$\nx + y\n$$\n\n[^unused]: **Footnote**\n\n**Last**')
  const html = markdownEngine.render(result.content)
  assert.match(html, /<h1[^>]*><strong>Title<\/strong><\/h1>/)
  assert.match(html, /type="checkbox"[^>]*> <strong>Task<\/strong>/)
  assert.match(html, /<code class="language-ts">const literal = 1\n<\/code>/)
  assert.equal(formatMarkdownSelection(result.content, result.start, result.end, 'bold').content, source)
})

test('cross-paragraph link formatting creates valid separate links and selects the first URL', () => {
  const result = formatMarkdownSelection('One\n\nTwo', 0, 8, 'link')
  assert.equal(result.content, '[One](https://)\n\n[Two](https://)')
  assert.equal(result.content.slice(result.start, result.end), 'https://')
  assert.equal((markdownEngine.render(result.content).match(/<a /g) ?? []).length, 2)
})
