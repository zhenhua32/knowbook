import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownEngine, markdownTokenTree, type MarkdownNode } from '../src/shared/markdownEngine.ts'
import { parseMarkdownBlocks, parseMarkdownBackupDocument, serializeBlocksToMarkdown } from '../src/shared/markdown.ts'
import { parseMarkdownDocumentBlocks, hasAdvancedMarkdown } from '../src/shared/markdownDocument.ts'
import { collectMarkdownAnchors } from '../src/shared/markdownAnchors.ts'
import { advancedMarkdown } from './fixtures/markdown-advanced.ts'
import { parseMarkdownTable } from '../src/shared/markdownTable.ts'
import { collectMarkdownDestinations } from '../src/shared/markdownLinks.ts'

const walk = (nodes: MarkdownNode[]): MarkdownNode[] => nodes.flatMap((node) => [node, ...walk(node.children)])
const refs = (nodes: MarkdownNode[]) => walk(nodes).filter(({ token }) => token.type === 'footnote_ref').map(({ token }) => [token.meta?.id, token.meta?.subId])

test('whole-document notes have stable global numbering across tasks, callout titles and table cells', () => {
  const blocks = parseMarkdownBlocks(advancedMarkdown).map((block, index) => ({ ...block, id: `b${index}` }))
  const doc = parseMarkdownDocumentBlocks(blocks, 'Advanced')
  assert.deepEqual(doc.blockNodes.flatMap(refs), [[0, 0], [0, 1], [1, 0], [0, 2], [3, 0], [0, 3]])
  assert.deepEqual(refs(doc.footnotes), [[2, 0]])
  assert.equal(walk(doc.footnotes).filter(({ token }) => token.type === 'footnote_open').length, 4)
  assert.equal(walk(doc.footnotes).filter(({ token }) => token.type === 'footnote_anchor').length, 7)
  for (const [key, index] of doc.footnoteOrigins) {
    assert.ok(refs(doc.blockNodes[index]).some(([id, sub]) => key === `${id}:${sub}`))
    assert.equal(doc.blockIds[index], `b${index}`)
  }
  assert.equal(walk(doc.blockNodes.flat()).filter(({ token }) => token.type === 'footnote_missing').length, 1)
  assert.equal(walk(doc.footnotes).find(({ token }) => token.type === 'link_open')?.token.attrGet('href'), 'https://example.com/guide')
  const task = blocks.findIndex((block) => block.type === 'todo')
  assert.equal(walk(doc.blockNodes[task]).some(({ token }) => token.type === 'task_checkbox'), false, 'row owns the leading checkbox')
  assert.ok(hasAdvancedMarkdown(doc.blockNodes[task]))
  const definitions = blocks.findIndex((block) => block.content.startsWith('[^note]:'))
  assert.deepEqual(doc.blockNodes[definitions], [], 'definition bodies render once in the footer')
})

test('advanced source and rendered semantics survive three plain and backup round trips', () => {
  const expected = markdownEngine.render(advancedMarkdown)
  for (const metadata of [false, true]) {
    let source = advancedMarkdown
    for (let cycle = 0; cycle < 3; cycle++) {
      const blocks = parseMarkdownBlocks(source)
      source = serializeBlocksToMarkdown(blocks, { includeBlockMetadata: metadata })
      assert.equal(markdownEngine.render(serializeBlocksToMarkdown(parseMarkdownBackupDocument(source).blocks)), expected)
      assert.match(source, /\[\^note\]: Definition/)
      assert.match(source, /\[!tip\]\+ A \*\*formatted\*\* title\[\^tip\]/)
      assert.match(source, /flowchart LR/)
    }
  }
})

test('moving definitions cannot change numbering and unused definitions cannot create ghost notes', () => {
  const definitions = '[^a]: A with another reference[^b].\n\n[^b]: B.\n\n[^unused]: Not cited, with ^[hidden inline note] and [^ghost].\n\n[^ghost]: Invisible.'
  const content = 'Visible[^a], later[^b], again[^a].'
  const first = parseMarkdownDocumentBlocks(parseMarkdownBlocks(`${definitions}\n\n${content}`))
  const last = parseMarkdownDocumentBlocks(parseMarkdownBlocks(`${content}\n\n${definitions}`))
  assert.deepEqual(first.blockNodes.flatMap(refs), [[0, 0], [1, 0], [0, 1]])
  assert.deepEqual(first.blockNodes.flatMap(refs), last.blockNodes.flatMap(refs))
  assert.deepEqual(refs(first.footnotes), [[1, 1]])
  assert.equal(walk(first.footnotes).filter(({ token }) => token.type === 'footnote_open').length, 2)
  assert.equal(walk(first.footnotes).filter(({ token }) => token.type === 'footnote_anchor').length, 4)
  assert.equal(markdownEngine.render(definitions), '')
  const cycle = 'Read[^a].\n\n[^a]: A[^b].\n\n[^b]: B[^a].'
  assert.equal(parseMarkdownDocumentBlocks(parseMarkdownBlocks(cycle)).footnoteOrigins.size, 1)
})

test('inline math respects escapes, currency, code spans and delimiter runs', () => {
  const cases: Array<[string, string[]]> = [
    ['$a$ and \\(b\\)', ['a', 'b']], ['$5 and $10', []], ['US$5, US$10.', []],
    ['\\$literal$ and `$code$`', []], ['$ spaced $', []], ['$unclosed', []],
    ['$x$$', []], ['$x$$y$', ['x$$y']], ['$x\\$y$', ['x\\$y']], ['$$inline$$', []]
  ]
  for (const [source, expected] of cases) {
    const tokens = walk(markdownTokenTree(markdownEngine.parseInline(source, {})))
    assert.deepEqual(tokens.filter(({ token }) => token.type === 'math_inline').map(({ token }) => token.content), expected, source)
  }
  assert.doesNotMatch(markdownEngine.render('```tex\n$x$\n```'), /markdown-math/)
  assert.equal(parseMarkdownBlocks('$$unclosed\nsource')[0].content, '$$unclosed\nsource')
  assert.equal(parseMarkdownBlocks('\\[unclosed')[0].content, '\\[unclosed')
  assert.deepEqual(parseMarkdownBlocks('$$a$$\n\n\\[b\\]').map((block) => [block.type, block.content]), [['math', 'a'], ['math', 'b']])
})

test('callouts preserve nested structure, literal markers and title inline parsing', () => {
  const html = markdownEngine.render('> [!NOTE]- Title **bold**\n> Body\n>\n> > [!tip]+ Nested\n> > ==text==')
  assert.match(html, /<details class="markdown-callout" data-callout="note"><summary>Title <strong>bold<\/strong><\/summary>/)
  assert.match(html, /data-callout="tip" open=""/)
  assert.match(html, /<mark>text<\/mark>/)
  assert.equal((html.match(/<details/g) ?? []).length, 2)
  assert.doesNotMatch(markdownEngine.render('> \\[!note] Literal\n\n`==literal==`'), /markdown-callout|<mark>/)
})

test('TOC and navigation agree for repeated headings, inline math and footnote captions', () => {
  const blocks = parseMarkdownBlocks(advancedMarkdown + '\n\nRef[^head]\n\n[^head]: ## A heading inside a footnote')
  const model = parseMarkdownDocumentBlocks(blocks, '**Advanced**')
  const anchors = collectMarkdownAnchors('**Advanced**', blocks.map((block) => ({ ...block, checked: block.checked ?? false, depth: block.depth ?? 0 })))
  assert.deepEqual(model.headings.map(({ slug }) => slug), anchors.slice(1).map(({ slug }) => slug))
  assert.deepEqual(model.headings.map(({ slug }) => slug), ['advanced-1', 'repeated-x', 'repeated-x-1'])
})

test('source slicing does not duplicate nested list items or lose complex container bodies', () => {
  const blocks = parseMarkdownBlocks('- Parent[^x]\n  - Child[^x]\n- Next[^x]\n\n  Second paragraph\n\n  > [!note] Title\n  > Body\n\n[^x]: note')
  const model = parseMarkdownDocumentBlocks(blocks)
  assert.deepEqual(model.blockNodes.flatMap(refs), [[0, 0], [0, 1], [0, 2]])
  assert.equal(walk(model.blockNodes[0]).some(({ token }) => token.content.includes('Child')), false)
  assert.ok(walk(model.blockNodes[2]).some(({ token }) => token.meta?.callout))
  assert.doesNotThrow(() => markdownEngine.parse('^['.repeat(200) + 'body' + ']'.repeat(200), {}))
})

test('a table containing inline footnotes keeps its table shape and document-wide footer', () => {
  const source = '| Header ^[Header note] | Value |\n| :- | -: |\n| Body ^[Cell note] | $x$ |'
  assert.deepEqual(parseMarkdownTable(source), { headers: ['Header ^[Header note]', 'Value'], alignments: ['left', 'right'], rows: [['Body ^[Cell note]', '$x$']] })
  const model = parseMarkdownDocumentBlocks(parseMarkdownBlocks(source))
  assert.equal(model.blockNodes[0][0].token.type, 'table_open')
  assert.deepEqual(refs(model.blockNodes[0]), [[0, 0], [1, 0]])
  assert.equal(walk(model.footnotes).filter(({ token }) => token.type === 'footnote_open').length, 2)
})

test('unused note assets are retained without rewriting literal links in code or math', () => {
  const source = '[^unused]: ![image](asset.png)\n\n    `[literal](asset.png)`\n\n    ```md\n    [code](asset.png)\n    ```\n\n    $$\n    [math](asset.png)\n    $$\n\nText without a citation.'
  assert.deepEqual(collectMarkdownDestinations(source).map(({ url, kind }) => ({ url, kind })), [{ url: 'asset.png', kind: 'image' }])
})

test('large documents retain exact row ownership through long lists and paragraph boundaries', () => {
  const blocks = parseMarkdownBlocks(Array.from({ length: 1200 }, (_, index) => index < 600 ? `- Item ${index}${index === 599 ? '\n' : ''}` : `Paragraph ${index}\n`).join('\n'))
  const model = parseMarkdownDocumentBlocks(blocks)
  assert.equal(model.blockNodes.length, 1200)
  model.blockNodes.forEach((nodes, index) => {
    assert.deepEqual(walk(nodes).filter(({ token }) => token.type === 'text').map(({ token }) => token.content), [`${index < 600 ? 'Item' : 'Paragraph'} ${index}`])
  })
})
