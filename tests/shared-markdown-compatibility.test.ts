import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownBlocks, parseMarkdownBackupDocument, serializeBlocksToMarkdown, getMarkdownListNumbers } from '../src/shared/markdown.ts'
import { collectMarkdownReferences, markdownEngine } from '../src/shared/markdownEngine.ts'
import { parseMarkdownTable } from '../src/shared/markdownTable.ts'
import { parsePastedMarkdown, getMarkdownShortcut } from '../src/renderer/src/utils/markdownInput.ts'

test('CommonMark block forms share the same import and paste grammar', () => {
  const cases: Array<[string, string[]]> = [
    ['# A\n## B\n### C\n#### D\n##### E\n###### F', [1, 2, 3, 4, 5, 6].map((n) => `heading-${n}`)],
    ['Title\n=====\n\nSubtitle\n---', ['heading-1', 'heading-2']],
    ['Paragraph\n### Heading\n> Quote\n\n***\n\n___', ['paragraph', 'heading-3', 'quote', 'divider', 'divider']],
    ['* a\n* b\n\n+ c\n\n- d', Array(4).fill('bulleted-list')],
    ['1. a\n2. b\n3. c', Array(3).fill('numbered-list')],
    ['0) a\n1) b', Array(2).fill('numbered-list')],
    ['* [ ] a\n* [x] b\n* [X] c', Array(3).fill('todo')],
    ['    x = 1\n    y = 2', ['code']],
    ['~~~js\nconst a = 1\n~~~', ['code']],
    ['| A | B |\n| - | - |\n| x | y |\n\nAfter', ['table', 'paragraph']],
    ['$$\nx^2\n$$', ['math']]
  ]
  for (const [source, types] of cases) {
    const imported = parseMarkdownBackupDocument(source).blocks
    const pasted = parsePastedMarkdown(source)
    assert.deepEqual(imported.map((block) => block.type), types, source)
    assert.deepEqual(pasted.map(({ type, content, depth }) => ({ type, content, depth })), imported.map(({ type, content, depth }) => ({ type, content, depth })), source)
  }
  assert.deepEqual(parseMarkdownBlocks('* [ ] a\n* [x] b').map((block) => block.checked), [false, true])
  assert.equal(parseMarkdownBlocks('    x = 1')[0].content, 'x = 1')
  assert.equal(parseMarkdownBackupDocument('---\nordinary text\n---\n').blocks[0].type, 'divider')
})

test('nested lists, multiline list bodies and non-one starts survive repeated exports', () => {
  const fixtures = [
    '3. Parent\n   - Child\n     + Grandchild\n4. Sibling',
    '- First\n\n  Second paragraph\n\n  ```js\n  const a = 1\n  ```\n\n- Last',
    '- [x] Task\n  - Child\n- [ ] Next',
    '> outer\n>\n> > inner\n> > - nested',
    '10) First\n    continuation\n11) Second',
    '1. First list\n2. Next\n\n1) Restart\n2) Next again'
  ]
  for (const source of fixtures) {
    const blocks = parseMarkdownBlocks(source)
    const exported = serializeBlocksToMarkdown(blocks)
    assert.deepEqual(parseMarkdownBlocks(exported), blocks, source)
    assert.equal(serializeBlocksToMarkdown(parseMarkdownBlocks(exported)), exported)
  }
  const blocks = parseMarkdownBlocks(fixtures[0])
  assert.deepEqual(getMarkdownListNumbers(blocks), [3, 0, 0, 4])
  assert.match(serializeBlocksToMarkdown(blocks), /\n   - Child/)
})

test('code fences protect embedded fences, blank lines, indentation and language', () => {
  const content = '\n  ```js\nconst x = `value`\n  ```\n~~~~\n'
  const source = serializeBlocksToMarkdown([{ type: 'code', language: 'markdown', content }])
  assert.match(source, /^````markdown/)
  assert.equal(parseMarkdownBlocks(source)[0].content, content)
  const tilde = serializeBlocksToMarkdown([{ type: 'code', language: 'lang`info', content }])
  assert.match(tilde, /^~~~~~/)
  assert.equal(parseMarkdownBlocks(tilde)[0].content, content)
})

test('reference definitions are retained across block boundaries and are editable', () => {
  const source = '[site]: https://example.com/a_(b) "Title"\n\n### [Heading][site]\n\n[Link][SITE] and ![Image][img]\n\n[img]: https://example.com/image.png'
  const exported = serializeBlocksToMarkdown(parseMarkdownBlocks(source))
  assert.deepEqual(collectMarkdownReferences(exported), collectMarkdownReferences(source))
  assert.match(exported, /\[site\]:/)
  assert.match(markdownEngine.renderInline('[Link][site]', { references: collectMarkdownReferences(exported) }), /href="https:\/\/example.com\/a_\(b\)"/)
  assert.match(markdownEngine.renderInline('[Link][site]', { references: collectMarkdownReferences(exported.replace('a_(b)', 'changed')) }), /\/changed/)
})

test('tables understand escaped separators, inline code and missing/extra cells', () => {
  const table = parseMarkdownTable('| A | B |\n| :- | -: |\n| a\\|b | `c\\|d` |\n| short |\n| one | two | ignored |')!
  assert.deepEqual(table.alignments, ['left', 'right'])
  assert.deepEqual(table.rows, [['a|b', '`c|d`'], ['short', ''], ['one', 'two']])
  assert.ok(parseMarkdownTable('| A |\n| - |\n| x |'))
  assert.equal(parseMarkdownTable('| A | B |\n| - | - |\n\nFollowing text'), null)
})

test('typed backup metadata keeps block boundaries, identity, hierarchy and restart intent', () => {
  const original = [
    { id: 'h6', type: 'heading-6', content: 'Deep heading', depth: 0 },
    { id: 'first', type: 'numbered-list', content: 'First', listStart: 7, depth: 0, tags: ['keep'], highlight: 'green' },
    { id: 'child', type: 'bulleted-list', content: 'Child', parentBlockId: 'first', depth: 1 },
    { id: 'second', type: 'numbered-list', content: 'Second', depth: 0 },
    { id: 'literal', type: 'paragraph', content: '# Literal\n\n- stays one block', depth: 0 },
    { id: 'empty', type: 'paragraph', content: '', depth: 0 }
  ]
  const exported = serializeBlocksToMarkdown(original, { includeBlockMetadata: true })
  const restored = parseMarkdownBackupDocument(exported).blocks
  assert.equal(restored.length, original.length)
  assert.deepEqual(restored.map((block) => block.id), original.map((block) => block.id))
  assert.equal(restored[2].parentBlockId, 'first')
  assert.equal(restored[2].depth, 1)
  assert.equal(restored[3].listStart, undefined)
  assert.equal(restored[4].content, original[4].content)
  assert.equal(restored[5].content, '')
  assert.equal(serializeBlocksToMarkdown(restored, { includeBlockMetadata: true }), exported)
})

test('shortcuts preserve code, quote and math source and parse complete fences', () => {
  const paragraph = { type: 'paragraph', content: '', depth: 0, checked: false }
  for (const marker of ['#', '##', '###', '-', '+', '*', '1.', '7)', '>']) {
    assert.equal(getMarkdownShortcut(paragraph, marker), null, marker)
  }
  assert.equal(getMarkdownShortcut(paragraph, '---')?.type, 'divider')
  assert.equal(getMarkdownShortcut(paragraph, '###### ')?.type, 'heading-6')
  assert.equal(getMarkdownShortcut(paragraph, '```js\nconst n = 1\n```')?.content, 'const n = 1')
  assert.equal(getMarkdownShortcut({ ...paragraph, type: 'code' }, '# literal'), null)
  assert.equal(getMarkdownShortcut({ ...paragraph, type: 'quote' }, '> nested'), null)
  assert.equal(getMarkdownShortcut({ ...paragraph, type: 'math' }, '- x'), null)
  assert.equal(getMarkdownShortcut(paragraph, '\\# literal'), null)
})

test('lazy code spans, terminal hashes, blank code lines and large ordered counts retain meaning', () => {
  for (const source of [
    '> foo `\n===\n`', '> foo\n===\nbar `\n===\n`',
    '> foo `\n===\n`\n>\n> bar\n===',
    '   - foo\n    - bar\n\n     ```\n     code\n     ```',
    '999999999. a\n1. b', 'Foo #\n===', '```\n\n```',
    '- first\n\n  - nested\n- last', '- a\n  - b\n\n- c'
  ]) {
    let exported = source
    for (let cycle = 0; cycle < 3; cycle++) {
      exported = serializeBlocksToMarkdown(parseMarkdownBlocks(exported))
      assert.equal(markdownEngine.render(exported), markdownEngine.render(source), source)
    }
  }
})

test('explicit numbering restarts survive even when an editor retains the original list marker', () => {
  const blocks = parseMarkdownBlocks('1. First\n2. Second\n3. Third\n4. Fourth')
  blocks[2].listStart = 1
  const exported = serializeBlocksToMarkdown(blocks)
  assert.equal(markdownEngine.render(exported), '<ol>\n<li>First</li>\n<li>Second</li>\n</ol>\n<ol>\n<li>Third</li>\n<li>Fourth</li>\n</ol>\n')
  assert.deepEqual(getMarkdownListNumbers(parseMarkdownBlocks(exported)), [1, 2, 1, 2])
})
