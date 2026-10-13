import assert from 'node:assert/strict'
import test from 'node:test'
import { DOMParser, Fragment, type Node } from 'prosemirror-model'
import { JSDOM } from 'jsdom'
import { EditorState } from 'prosemirror-state'
import type { DocumentBlockDraft } from '../src/shared/contracts.ts'
import { markdownEngine } from '../src/shared/markdownEngine.ts'
import { draftBlocksToRichDoc, reconcileRichTextBlockIds, richDocToDraftBlocks, richTextInlineFingerprint } from '../src/renderer/src/rich-text/model.ts'
import { richTextSchema, richTextSourceDom, richTextSourceMarkdown } from '../src/renderer/src/rich-text/schema.ts'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown.ts'
import { htmlClipboardToMarkdown } from '../src/shared/htmlClipboard.ts'

const paragraph = (content: string, patch: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft => ({
  id: 'first', type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, ...patch
})
const changed = (node: Node, content: Node[] | Fragment): Node => node.type.create(node.attrs, content)
const document = (...nodes: Node[]) => richTextSchema.nodes.doc.create(null, nodes)

test('rich-text parsing retains Markdown formatting and exact untouched source including Chinese and emoji', () => {
  const sources = ['**粗体 😀** and _斜体_ ~~删除~~ ==高亮== `代码` [中文](https://example.com "标题")',
    'soft\nline  \nhard', 'one &amp; two \\*literal\\*', '', '\\# plain', '***both***', 'https://example.com']
  for (const source of sources) {
    const doc = draftBlocksToRichDoc([paragraph(source)])
    assert.equal(doc.firstChild!.type.name, 'text_block', source)
    assert.equal(richDocToDraftBlocks(doc)[0].content, source)
  }
  const node = draftBlocksToRichDoc([paragraph('**粗体 😀** _斜体_ ~~删除~~ ==高亮== `代码` [链接](https://example.com)')]).firstChild!
  const marks: string[] = []
  node.forEach(child => marks.push(...child.marks.map(mark => mark.type.name)))
  for (const kind of ['strong', 'em', 'strike', 'highlight', 'code', 'link']) assert.ok(marks.includes(kind), kind)
})

test('unsupported inline and non-text syntax falls back to an exact source block', () => {
  const blocks = ['before $x+y$ after', 'before [[Target]] after', 'before ![图](image.png) after',
    'note[^missing]', '<sub>HTML</sub>', '[ref]: https://example.com'].map((content, index) => paragraph(content, { id: `source-${index}` }))
  blocks.push(paragraph('const a = 1', { id: 'code', type: 'code', language: 'typescript' }),
    paragraph('| A |\n| --- |', { id: 'table', type: 'table' }), paragraph('---\na: 1\n---', { id: 'frontmatter', type: 'frontmatter' }))
  const doc = draftBlocksToRichDoc(blocks)
  doc.forEach(node => assert.equal(node.type.name, 'source_block', node.attrs.block.content))
  assert.deepEqual(richDocToDraftBlocks(doc), blocks)
})

test('callouts, document directives and multiple-paragraph blocks retain their full source and metadata', () => {
  const blocks = [paragraph('[!NOTE] 注意\n正文', { type: 'quote', tags: ['callout'], highlight: 'blue' }),
    paragraph('first\n\nsecond', { id: 'multi', tags: ['multi'] }),
    paragraph('[TOC]', { id: 'toc' }), paragraph('first\n\n<!-- comment -->\n\nsecond', { id: 'comment' })]
  const doc = draftBlocksToRichDoc(blocks)
  doc.forEach(node => assert.equal(node.type.name, 'source_block', node.attrs.block.content))
  assert.deepEqual(richDocToDraftBlocks(doc), blocks)
})

test('metadata survives rich edits and mutable metadata is never shared with the original draft', () => {
  const input = paragraph('_original_', { type: 'numbered-todo', checked: true, tags: ['tag'], highlight: 'yellow',
    listStart: 7, markdownFormat: { listMarker: ')', listLoose: true } })
  const node = draftBlocksToRichDoc([input]).firstChild!
  const output = richDocToDraftBlocks(document(changed(node, [richTextSchema.text('new', [richTextSchema.marks.strong.create()])])))
  assert.equal(output[0].content, '**new**')
  assert.deepEqual({ ...output[0], content: input.content }, input)
  output[0].tags!.push('other')
  output[0].markdownFormat!.listMarker = '.'
  assert.deepEqual(input.tags, ['tag'])
  assert.equal(input.markdownFormat!.listMarker, ')')
})

test('empty and default blocks receive independent metadata and fresh identities', () => {
  const original = draftBlocksToRichDoc([paragraph('')])
  assert.equal(richDocToDraftBlocks(original)[0].content, '')
  const doc = reconcileRichTextBlockIds(document(richTextSchema.nodes.text_block.create(), richTextSchema.nodes.text_block.create()))
  const first = doc.child(0).attrs.block as DocumentBlockDraft, second = doc.child(1).attrs.block as DocumentBlockDraft
  assert.notEqual(first, second)
  assert.notEqual(first.id, second.id)
  assert.equal(first.type, 'paragraph')
  assert.equal(richDocToDraftBlocks(draftBlocksToRichDoc([])).length, 1)
})

test('split nodes retain the first ID and copied list subtrees attach to their new parent', () => {
  const original = draftBlocksToRichDoc([paragraph('AlphaBeta', { type: 'todo', checked: true, tags: ['keep'] })]).firstChild!
  const left = changed(original, [richTextSchema.text('Alpha')]), right = changed(original, [richTextSchema.text('Beta')])
  const split = reconcileRichTextBlockIds(document(left, right))
  const blocks = richDocToDraftBlocks(split)
  assert.equal(blocks[0].id, 'first')
  assert.notEqual(blocks[1].id, 'first')
  assert.deepEqual(blocks.map(block => block.content), ['Alpha', 'Beta'])
  assert.deepEqual(blocks[1].tags, ['keep'])
  assert.equal(reconcileRichTextBlockIds(split), split)

  const subtree = draftBlocksToRichDoc([paragraph('Parent', { type: 'todo' }),
    paragraph('Child', { id: 'child', type: 'todo', depth: 1, parentBlockId: 'first' })])
  const duplicated = richDocToDraftBlocks(document(subtree.child(0), subtree.child(1), subtree.child(0), subtree.child(1)))
  assert.equal(duplicated[1].parentBlockId, duplicated[0].id)
  assert.equal(duplicated[3].parentBlockId, duplicated[2].id)
  assert.equal(new Set(duplicated.map(block => block.id)).size, 4)
})

test('an actual ProseMirror split repairs copied attrs without changing positions or prior snapshots', () => {
  const initial = [paragraph('中文😀 tail', { tags: ['original'], highlight: 'blue' })]
  const state = EditorState.create({ doc: draftBlocksToRichDoc(initial) })
  const transaction = state.tr.split(5)
  assert.equal(transaction.doc.child(0).attrs.block.id, transaction.doc.child(1).attrs.block.id)
  const repaired = reconcileRichTextBlockIds(transaction.doc)
  assert.equal(repaired.content.size, transaction.doc.content.size)
  const after = richDocToDraftBlocks(repaired)
  assert.equal(after[0].id, 'first')
  assert.notEqual(after[1].id, 'first')
  assert.deepEqual(after.map(block => block.content), ['中文😀', ' tail'])
  assert.deepEqual(richDocToDraftBlocks(state.doc), initial)
  assert.deepEqual(richDocToDraftBlocks(draftBlocksToRichDoc(after)), after)
})

test('orphan depths collapse to a valid ancestor and prose can never parent list content', () => {
  const blocks = richDocToDraftBlocks(draftBlocksToRichDoc([
    paragraph('orphan', { type: 'todo', depth: 6, parentBlockId: 'missing' }),
    paragraph('gap', { id: 'gap', type: 'todo', depth: 6 }),
    paragraph('prose', { id: 'prose' }),
    paragraph('after prose', { id: 'after', type: 'todo', depth: 3, parentBlockId: 'prose' })
  ]))
  assert.deepEqual(blocks.map(block => [block.depth, block.parentBlockId]), [[0, null], [1, 'first'], [0, null], [0, null]])
})

test('clipboard DOM retains safe heading/marks while assigning fresh identities and discarding claimed metadata', () => {
  const dom = new JSDOM('<div><h2 data-block-id="stolen" data-block-depth="5"><strong>中文</strong> 😀</h2><p data-block-id="stolen">next</p></div>')
  const doc = DOMParser.fromSchema(richTextSchema).parse(dom.window.document.querySelector('div')!)
  const blocks = richDocToDraftBlocks(doc)
  assert.deepEqual(blocks.map(block => block.type), ['heading-2', 'paragraph'])
  assert.equal(blocks[0].content, '**中文** 😀')
  assert.equal(blocks[0].depth, 0)
  assert.equal(new Set(blocks.map(block => block.id)).size, 2)
  assert.ok(blocks.every(block => block.id !== 'stolen'))
  dom.window.close()
})

test('edited inline formatting serializes with legal Markdown and reparses to the same inline model', () => {
  const marks = richTextSchema.marks
  const cases = [
    [richTextSchema.text('中文 😀 ', [marks.strong.create()]), richTextSchema.text('斜体', [marks.strong.create(), marks.em.create()]), richTextSchema.text(' 普通')],
    [richTextSchema.text('a', [marks.em.create()]), richTextSchema.text('b', [marks.strong.create()])],
    [richTextSchema.text('a`b', [marks.code.create()]), richTextSchema.text(' and ', []), richTextSchema.text('label', [marks.link.create({ href: 'https://example.com/a(b)', title: 'A "title"' })])],
    [richTextSchema.text('literal **bold** ==highlight== $math$ <tag> | [[wiki]]')],
    [richTextSchema.text('before'), richTextSchema.nodes.soft_break.create(), richTextSchema.text('after'), richTextSchema.nodes.hard_break.create(), richTextSchema.text('tail')],
    [richTextSchema.text('marked', [marks.strike.create(), marks.highlight.create()])],
    [richTextSchema.text(' code with boundary spaces ', [marks.code.create()])],
    [richTextSchema.text('tail'), richTextSchema.nodes.hard_break.create()]
  ]
  for (const content of cases) {
    const node = richTextSchema.nodes.text_block.create({ block: paragraph(''), originalInline: 'changed' }, content)
    const source = richDocToDraftBlocks(document(node))[0].content
    const reparsed = draftBlocksToRichDoc([paragraph(source)]).firstChild!
    assert.equal(reparsed.type.name, 'text_block', source)
    assert.equal(richTextInlineFingerprint(reparsed), richTextInlineFingerprint(node), source)
    assert.ok(markdownEngine.renderInline(source).length > 0)
  }
})

test('nested link, code and emphasis marks survive edit, save and model reconstruction', () => {
  const sources = ['**[中文 `x` 😀](https://example.com "标题")**', '==~~**bold *mixed* text**~~==',
    '*italic **bold** italic*', '[**bold** and *italic*](https://example.com/a(b))', '**` code `**']
  for (const source of sources) {
    const original = draftBlocksToRichDoc([paragraph(source)]).firstChild!
    assert.equal(original.type.name, 'text_block', source)
    const edited = changed(original, original.content.append(Fragment.from(richTextSchema.text(' tail'))))
    const snapshot = richDocToDraftBlocks(document(edited))
    const restored = draftBlocksToRichDoc(snapshot).firstChild!
    assert.equal(restored.type.name, 'text_block', snapshot[0].content)
    assert.equal(richTextInlineFingerprint(restored), richTextInlineFingerprint(edited), snapshot[0].content)
    assert.equal(snapshot[0].id, 'first')
  }
})

test('schema keeps heading levels, list depth and actual ordered-list display numbers', () => {
  const doc = draftBlocksToRichDoc([paragraph('Heading', { type: 'heading-6' }),
    paragraph('Parent', { id: 'parent', type: 'numbered-list', listStart: 8 }),
    paragraph('Nested', { id: 'nested', type: 'numbered-list', depth: 1, parentBlockId: 'parent' }),
    paragraph('Next', { id: 'next', type: 'numbered-list' })])
  const headingDom = richTextSchema.nodes.text_block.spec.toDOM!(doc.child(0)) as [string, Record<string, string>, number]
  assert.equal(headingDom[0], 'h6')
  assert.equal(doc.child(1).attrs.listNumber, 8)
  assert.equal(doc.child(2).attrs.listNumber, 1)
  assert.equal(doc.child(3).attrs.listNumber, 9)
  const nestedDom = richTextSchema.nodes.text_block.spec.toDOM!(doc.child(2)) as [string, Record<string, string>, number]
  assert.equal(nestedDom[1].style, 'padding-left: 24px')
})

test('fresh-node link DOM parsing refuses executable URLs', () => {
  const rule = richTextSchema.marks.link.spec.parseDOM![0]
  assert.ok('getAttrs' in rule)
  const attrs = rule.getAttrs as (element: HTMLElement) => unknown
  const element = (href: string) => ({ getAttribute: (name: string) => name === 'href' ? href : null }) as unknown as HTMLElement
  assert.equal(attrs(element('javascript:alert(1)')), false)
  assert.deepEqual(attrs(element('https://example.com')), { href: 'https://example.com', title: null })
})

test('source clipboard DOM retains safe code/table semantics and complete plain Markdown', () => {
  const dom = new JSDOM('')
  const code = paragraph('const x = "<script>alert(1)</script>"', { type: 'code', language: 'typescript' })
  const table = paragraph('| A | B |\n| --- | --- |\n| **中文** | `code` |', { id: 'table', type: 'table' })
  const doc = draftBlocksToRichDoc([code, table])
  const codeDom = richTextSourceDom(doc.child(0), dom.window.document) as HTMLElement
  const tableDom = richTextSourceDom(doc.child(1), dom.window.document) as HTMLElement
  assert.equal(codeDom.querySelector('pre code')!.textContent!.trimEnd(), code.content)
  assert.equal(codeDom.querySelector('script'), null)
  assert.equal(tableDom.querySelectorAll('table td').length, 2)
  assert.equal(tableDom.querySelector('td strong')!.textContent, '中文')
  assert.equal(parseMarkdownBlocks(htmlClipboardToMarkdown(codeDom.outerHTML))[0].type, 'code')
  assert.equal(parseMarkdownBlocks(htmlClipboardToMarkdown(tableDom.outerHTML))[0].type, 'table')
  assert.equal(richTextSourceMarkdown(doc.child(0)), serializeBlocksToMarkdown([code]))
  assert.equal(doc.child(0).type.spec.leafText!(doc.child(0)), serializeBlocksToMarkdown([code]))
  dom.window.close()
})

test('source clipboard falls back to full literal Markdown for math, callouts and server rendering', () => {
  const dom = new JSDOM('')
  const blocks = [paragraph('x+y', { type: 'math' }), paragraph('[!NOTE] Title\nBody', { id: 'note', type: 'quote' })]
  const doc = draftBlocksToRichDoc(blocks)
  doc.forEach((node, _offset, index) => {
    const output = richTextSourceDom(node, dom.window.document) as HTMLElement
    assert.equal(output.getAttribute('data-knowbook-markdown-source'), 'true')
    assert.equal(output.textContent, serializeBlocksToMarkdown([blocks[index]]))
  })
  const serverOutput = richTextSchema.nodes.source_block.spec.toDOM!(doc.child(0)) as [string, Record<string, string>, string]
  assert.equal(serverOutput[2], serializeBlocksToMarkdown([blocks[0]]))
  dom.window.close()
})
