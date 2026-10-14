import assert from 'node:assert/strict'
import test from 'node:test'
import { DOMParser, Fragment } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts.ts'
import { INLINE_TEXT_COLORS } from '../src/shared/inlineTextPresentation.ts'
import { markdownEngine } from '../src/shared/markdownEngine.ts'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown.ts'
import { htmlClipboardToMarkdown } from '../src/shared/htmlClipboard.ts'
import { richTextSchema as schema } from '../src/renderer/src/rich-text/schema.ts'
import { draftBlocksToRichDoc, richDocToDraftBlocks, richTextInlineFingerprint } from '../src/renderer/src/rich-text/model.ts'
import { selectedRichTextColor, setRichTextColor } from '../src/renderer/src/rich-text/presentation.ts'

const block = (id: string, content: string, patch: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, ...patch })
const importedDrafts = (source: string): DocumentBlockDraft[] => parseMarkdownBlocks(source).map(item => ({ ...item, language: item.language ?? undefined, checked: Boolean(item.checked), depth: item.depth ?? 0, parentBlockId: item.parentBlockId ?? null }))

test('each finite color pair and underline survives nested marks, literal punctuation and repeated save/load', () => {
  for (const foreground of INLINE_TEXT_COLORS) for (const background of INLINE_TEXT_COLORS) for (const underlined of [false, true]) {
    const marks = [schema.marks.link.create({ href: 'https://example.test/a?q=1&x=2', title: '中文 "标题"' }), schema.marks.strong.create(),
      schema.marks.em.create(), schema.marks.strike.create(), schema.marks.highlight.create(),
      ...(underlined ? [schema.marks.underline.create()] : []), schema.marks.textColor.create({ color: foreground }), schema.marks.backgroundColor.create({ color: background })]
    const input = schema.nodes.text_block.create({ block: block('stable', '', { tags: ['tag'], highlight: 'blue' }) }, [
      schema.text('# literal **not a mark** [text](url) 中文 😀 '), schema.text('formatted <&>', marks),
      schema.text(' ` code ** == ', [...marks, schema.marks.code.create()]), schema.nodes.soft_break.create(null, null, marks),
      schema.text('soft'), schema.nodes.hard_break.create(null, null, marks), schema.text('hard')])
    const snapshot = richDocToDraftBlocks(schema.nodes.doc.create(null, input))
    assert.ok(snapshot[0].content.startsWith('<span data-knowbook-inline="true">'))
    assert.ok(snapshot[0].content.includes('&#10;') && snapshot[0].content.includes('<br>'))
    let next = snapshot
    for (let round = 0; round < 3; round++) {
      const restored = draftBlocksToRichDoc(next).firstChild!
      assert.equal(restored.type.name, 'text_block', next[0].content)
      assert.equal(richTextInlineFingerprint(restored), richTextInlineFingerprint(input), next[0].content)
      next = richDocToDraftBlocks(schema.nodes.doc.create(null, restored))
      assert.deepEqual(next, snapshot)
    }
    const html = JSDOM.fragment(markdownEngine.render(snapshot[0].content))
    assert.equal(html.querySelector('h1'), null)
    assert.equal(html.querySelector('[data-knowbook-text-color]')?.getAttribute('data-knowbook-text-color'), foreground)
    assert.equal(html.querySelector('[data-knowbook-background-color]')?.getAttribute('data-knowbook-background-color'), background)
    assert.equal(html.querySelector('a')?.getAttribute('title'), '中文 "标题"')
    assert.equal(html.querySelector('code')?.textContent, ' ` code ** == ')
  }
})

test('partial cross-block forward and backward color actions preserve independent marks, IDs and selection direction', () => {
  const original = [block('first', '**abcdef**'), block('second', 'uvwxyz', { type: 'heading-2' })]
  const doc = draftBlocksToRichDoc(original), head = doc.child(0).nodeSize + 4
  for (const backwards of [false, true]) {
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, backwards ? head : 3, backwards ? 3 : head) })
    const dispatch = (transaction: Parameters<EditorState['apply']>[0]) => { state = state.apply(transaction) }
    const bookmark = state.selection.toJSON()
    assert.ok(toggleMark(schema.marks.underline)(state, dispatch))
    assert.ok(setRichTextColor('textColor', 'red')(state, dispatch))
    assert.ok(setRichTextColor('backgroundColor', 'blue')(state, dispatch))
    assert.deepEqual(state.selection.toJSON(), bookmark)
    assert.equal(selectedRichTextColor(state, 'textColor'), 'red')
    assert.equal(selectedRichTextColor(state, 'backgroundColor'), 'blue')
    assert.ok(setRichTextColor('textColor')(state, dispatch))
    assert.equal(selectedRichTextColor(state, 'textColor'), undefined)
    assert.equal(selectedRichTextColor(state, 'backgroundColor'), 'blue')
    assert.equal(state.doc.child(0).child(1).marks.some(mark => mark.type === schema.marks.strong), true)
    assert.equal(state.doc.child(0).child(1).marks.some(mark => mark.type === schema.marks.underline), true)
    assert.deepEqual(richDocToDraftBlocks(state.doc).map(item => [item.id, item.type]), [['first', 'paragraph'], ['second', 'heading-2']])
    assert.equal(state.doc.child(0).firstChild!.marks.some(mark => mark.type === schema.marks.backgroundColor), false)
    assert.equal(state.doc.child(1).lastChild!.marks.some(mark => mark.type === schema.marks.backgroundColor), false)
    const restored = draftBlocksToRichDoc(richDocToDraftBlocks(state.doc))
    assert.equal(richTextInlineFingerprint(restored.child(0)), richTextInlineFingerprint(state.doc.child(0)))
    assert.equal(richTextInlineFingerprint(restored.child(1)), richTextInlineFingerprint(state.doc.child(1)))
    assert.deepEqual(richDocToDraftBlocks(doc), original)
  }
})

test('stored colors apply to new text independently, mixed selections are reported and source atoms remain unchanged', () => {
  let state = EditorState.create({ doc: draftBlocksToRichDoc([block('one', 'abcd')]) })
  const dispatch = (transaction: Parameters<EditorState['apply']>[0]) => { state = state.apply(transaction) }
  setRichTextColor('textColor', 'green')(state, dispatch)
  setRichTextColor('backgroundColor', 'pink')(state, dispatch)
  assert.equal(selectedRichTextColor(state, 'textColor'), 'green')
  dispatch(state.tr.insertText('新'))
  assert.deepEqual(state.doc.firstChild!.firstChild!.marks.map(mark => [mark.type.name, mark.attrs.color]), [['textColor', 'green'], ['backgroundColor', 'pink']])
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1, 4)))
  assert.equal(selectedRichTextColor(state, 'textColor'), null)
  const code = block('source', 'const x = 1', { type: 'code' })
  const sourceState = EditorState.create({ doc: draftBlocksToRichDoc([code]) })
  assert.equal(setRichTextColor('textColor', 'red')(sourceState), false)
  assert.deepEqual(richDocToDraftBlocks(sourceState.doc), [code])
  assert.throws(() => setRichTextColor('textColor', '#fff' as 'red'))
})

test('invalid colors, arbitrary CSS, duplicate attrs and unknown HTML keep exact source fallback without executable rendering', () => {
  for (const source of ['<u style="color:red">text</u>', '<span data-knowbook-text-color="cyan">text</span>',
    '<u onclick="evil()">text</u>', '<span data-knowbook-text-color="red" data-knowbook-text-color="blue">text</span>',
    '<span data-knowbook-background-color="url(x)">text</span>', '<span><unknown>text</unknown></span>', '<u>missing close',
    '<span><strong style="position:fixed">text</strong></span>']) {
    const draft = block('safe', source), doc = draftBlocksToRichDoc([draft])
    assert.equal(doc.firstChild!.type.name, 'source_block', source)
    assert.deepEqual(richDocToDraftBlocks(doc), [draft])
    const html = JSDOM.fragment(markdownEngine.render(source))
    assert.equal(html.querySelectorAll('[style],[onclick],script,unknown').length, 0, source)
  }
  const literal = draftBlocksToRichDoc([block('literal', '`<u>code</u>` \\<u>escaped\\</u>')])
  assert.equal(literal.firstChild!.type.name, 'text_block')
  assert.equal(literal.firstChild!.content.content.some(node => node.marks.some(mark => mark.type === schema.marks.underline)), false)
})

test('external and internal HTML clipboard retain finite colors and nested marks while dropping foreign identities and CSS', () => {
  const source = '<p data-block-id="stolen"><u data-block-id="foreign" onclick="evil()"><span data-knowbook-text-color="purple" data-knowbook-background-color="yellow" style="position:fixed"><strong>中文 **literal**</strong> <code>`code`</code><br><a href="https://example.test" title="Title">link</a></span></u></p>'
  const markdown = htmlClipboardToMarkdown(source), html = JSDOM.fragment(markdownEngine.render(markdown))
  assert.equal(html.querySelector('u strong')?.textContent, '中文 **literal**')
  assert.equal(html.querySelector('u code')?.textContent, '`code`')
  assert.equal(html.querySelector('[data-knowbook-text-color]')?.getAttribute('data-knowbook-text-color'), 'purple')
  assert.equal(html.querySelector('[data-knowbook-background-color]')?.getAttribute('data-knowbook-background-color'), 'yellow')
  assert.equal(html.querySelectorAll('[style],[onclick],[data-block-id]').length, 0)
  const drafts = parseMarkdownBlocks(markdown)
  assert.ok(drafts.every(item => !item.id))
  const doc = draftBlocksToRichDoc(importedDrafts(markdown))
  assert.equal(doc.firstChild!.type.name, 'text_block')
  const copied = htmlClipboardToMarkdown(markdownEngine.render(richDocToDraftBlocks(doc)[0].content))
  const pasted = draftBlocksToRichDoc(importedDrafts(copied))
  assert.equal(richTextInlineFingerprint(pasted.firstChild!), richTextInlineFingerprint(doc.firstChild!))
  assert.notEqual(pasted.firstChild!.attrs.block.id, doc.firstChild!.attrs.block.id)
})

test('plain and portable Markdown retain color source, list metadata and rich editing after import', () => {
  const source = [block('parent', '<u data-knowbook-text-color="orange"><strong>Parent</strong></u>', { type: 'numbered-todo', listStart: 7, checked: true }),
    block('child', '<span data-knowbook-background-color="green">Child&#10;line<br>hard</span>', { type: 'todo', depth: 1, parentBlockId: 'parent', tags: ['keep'] })]
  for (const includeMetadata of [false, true]) {
    const exported = serializeBlocksToMarkdown(source, { includeBlockMetadata: includeMetadata })
    const imported = parseMarkdownBlocks(exported), doc = draftBlocksToRichDoc(importedDrafts(exported))
    assert.ok(doc.content.content.every(node => node.type.name === 'text_block'))
    assert.deepEqual(imported.map(item => item.content), source.map(item => item.content))
    assert.deepEqual(imported.map(item => [item.type, item.checked, item.depth]), source.map(item => [item.type, item.checked, item.depth]))
    if (includeMetadata) assert.deepEqual(imported.map(item => [item.id, item.tags]), source.map(item => [item.id, item.tags]))
    const current = doc.child(1), edited = current.copy(current.content.append(Fragment.from(schema.text(' tail'))))
    const blocks = richDocToDraftBlocks(doc.copy(Fragment.fromArray([doc.child(0), edited])))
    const restored = draftBlocksToRichDoc(blocks)
    assert.equal(richTextInlineFingerprint(restored.child(1)), richTextInlineFingerprint(edited))
  }
})

test('DOM clipboard schema reads validated independent presentation marks without claimed metadata', () => {
  const dom = new JSDOM('<div><p data-block-id="foreign"><u data-knowbook-text-color="red" data-knowbook-background-color="blue">text</u></p><p><span data-knowbook-text-color="cyan">plain</span></p></div>')
  const doc = DOMParser.fromSchema(schema).parse(dom.window.document.querySelector('div')!)
  assert.deepEqual(doc.firstChild!.firstChild!.marks.map(mark => mark.type.name), ['underline', 'textColor', 'backgroundColor'])
  assert.equal(doc.child(1).firstChild!.marks.length, 0)
  assert.ok(richDocToDraftBlocks(doc).every(item => item.id !== 'foreign'))
  dom.window.close()
})
