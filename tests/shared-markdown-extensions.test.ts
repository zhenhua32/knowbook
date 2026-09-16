import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownEngine } from '../src/shared/markdownEngine.ts'
import { parseMarkdownBlocks, parseMarkdownBackupDocument, serializeBlocksToMarkdown, getMarkdownListNumbers } from '../src/shared/markdown.ts'
import { parseMarkdownTable } from '../src/shared/markdownTable.ts'
import { normalizeDraftBlocks } from '../src/renderer/src/utils/draftTreeNormalization.ts'
import { materializeDraftFragment } from '../src/renderer/src/utils/draftTreeFragment.ts'
import { getMarkdownShortcut, parsePastedMarkdown } from '../src/renderer/src/utils/markdownInput.ts'
import { extensionMarkdown } from './fixtures/markdown-extensions.ts'

test('GFM table shape covers optional borders, alignment, empty and uneven rows', () => {
  assert.deepEqual(parseMarkdownTable('A | B | C\n:- | :-: | -:\none | two | three\nshort\n1 | 2 | 3 | ignored'), {
    headers: ['A', 'B', 'C'], alignments: ['left', 'center', 'right'],
    rows: [['one', 'two', 'three'], ['short', '', ''], ['1', '2', '3']]
  })
  assert.deepEqual(parseMarkdownTable('| Only |\n| - |\n| |')?.rows, [['']])
  assert.deepEqual(parseMarkdownTable('| A | B |\n| - | - |')?.rows, [])
  assert.equal(parseMarkdownTable('| A | B |\n| - |'), null)
  assert.equal(parseMarkdownTable('| A | B |\n| - | no |'), null)
  assert.deepEqual(parseMarkdownBlocks('| A | B |\n| - | - |\n| x | y |\n> End').map((block) => block.type), ['table', 'quote'])
})

test('single and double strikethrough delimiters obey nesting, escapes and block boundaries', () => {
  for (const [source, expected] of [
    ['~old~ and ~~older~~', '<del>old</del> and <del>older</del>'],
    ['~~**bold** and *italic*~~', '<del><strong>bold</strong> and <em>italic</em></del>'],
    ['**~nested~**', '<strong><del>nested</del></strong>'],
    ['~~~literal~~~ and ~~~~literal~~~~', '~~~literal~~~ and ~~~~literal~~~~'],
    ['\\~literal\\~ and `~~code~~`', '~literal~ and <code>~~code~~</code>'],
    ['~~mismatch~', '~~mismatch~'], ['~ left~ and ~right ~', '~ left~ and ~right ~'],
    ['~line\nbreak~', '<del>line\nbreak</del>']
  ]) assert.equal(markdownEngine.renderInline(source), expected, source)
  assert.doesNotMatch(markdownEngine.render('~~first\n\nsecond~~'), /<del>/)
})

test('task recognition uses raw first-paragraph source for both list types', () => {
  const source = '3. [X] Ready\n   - [\t] Pending\n4. Normal\n5. [ ] Next\n\n- \\[x] Literal\n- &#91;x] Entity\n- `[x]` Code\n- [x]joined\n- # [x] Heading'
  const blocks = parseMarkdownBlocks(source)
  assert.deepEqual(blocks.map((block) => block.type), ['numbered-todo', 'todo', 'numbered-list', 'numbered-todo', ...Array(5).fill('bulleted-list')])
  assert.deepEqual(getMarkdownListNumbers(blocks).slice(0, 4), [3, 0, 4, 5])
  assert.deepEqual(blocks.slice(0, 4).map((block) => block.checked), [true, false, false, false])
  assert.equal((markdownEngine.render(source).match(/type="checkbox"/g) ?? []).length, 3)
  assert.equal((markdownEngine.render('> - [x]\n>   next line').match(/type="checkbox"/g) ?? []).length, 1)
  const fragment = normalizeDraftBlocks(materializeDraftFragment(parsePastedMarkdown(source), null))
  assert.equal(fragment[0].checked, true)
  assert.equal(fragment[0].listStart, 3)
  assert.equal(fragment[1].parentBlockId, fragment[0].id)
  const shortcut = getMarkdownShortcut({ type: 'numbered-list', content: '', listStart: 3, checked: false, depth: 0 }, '[X] Ready')
  assert.equal(shortcut?.type, 'numbered-todo')
  assert.equal(shortcut?.checked, true)
  assert.equal(shortcut?.listStart, 3)
})

test('mixed extensions are stable through plain Markdown and metadata round trips', () => {
  const original = parseMarkdownBlocks(extensionMarkdown)
  let blocks = original
  for (let cycle = 0; cycle < 3; cycle++) {
    blocks = parseMarkdownBlocks(serializeBlocksToMarkdown(blocks))
    assert.deepEqual(blocks, original, `plain round trip ${cycle}`)
  }
  const drafts = normalizeDraftBlocks(materializeDraftFragment(parsePastedMarkdown(extensionMarkdown), null))
  const backup = serializeBlocksToMarkdown(drafts, { includeBlockMetadata: true })
  assert.equal(serializeBlocksToMarkdown(parseMarkdownBackupDocument(backup).blocks, { includeBlockMetadata: true }), backup)
})
