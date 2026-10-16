import assert from 'node:assert/strict'
import test from 'node:test'
import { MarkdownSerializerState } from 'prosemirror-markdown'
import type { Mark, Node } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { richTextSchema as schema } from '../src/renderer/src/rich-text/schema'
import { reconcileRichTextBlockIds, serializeRichTextInline, serializeRichTextInlineHtml, serializeRichTextInlineHtmlWithLinkTrace,
  serializeRichTextInlineWithLinkTrace } from '../src/renderer/src/rich-text/model'
import { withRichLinkOccurrence, type RichInlineLinkSerialization } from '../src/renderer/src/rich-text/linkProvenance'

const link = (token = 'actual-source', href = 'Target.md', title: string | null = null) =>
  withRichLinkOccurrence(schema.marks.link.create({ href, title }), token)
const strong = schema.marks.strong.create(), em = schema.marks.em.create(), code = schema.marks.code.create()
const text = (value: string, marks: readonly Mark[] = []) => schema.text(value, marks)
const block = (children: Node[]) => schema.nodes.text_block.create({ block: {
  id: ' 旧:正文 ', type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null
} }, children)
function emitted(input: Node): RichInlineLinkSerialization {
  const before = input.toJSON(), originalWriter = MarkdownSerializerState.prototype.renderInline
  const result = serializeRichTextInlineWithLinkTrace(input)
  assert.equal(result.content, serializeRichTextInline(input), 'The cold observer uses the ordinary writer bytes')
  assert.deepEqual(input.toJSON(), before, 'Serialization never patches or normalizes its PM input')
  assert.equal(MarkdownSerializerState.prototype.renderInline, originalWriter)
  for (const destination of result.linkDestinations) {
    assert.equal(result.content.slice(destination.from, destination.to), destination.raw)
    assert.ok(Object.isFrozen(destination.pmSpans))
    let previous = -1
    for (const span of destination.pmSpans) {
      assert.ok(Object.isFrozen(span))
      assert.ok(Number.isSafeInteger(span.from) && Number.isSafeInteger(span.to))
      assert.ok(span.from >= previous && span.to > span.from && span.to <= input.content.size)
      previous = span.to
    }
  }
  return result
}
const spans = (result: RichInlineLinkSerialization) => result.linkDestinations.map(item => item.pmSpans)

test('observed Markdown href writes keep distinct PM occurrence spans for adjacent identical URLs', () => {
  const result = emitted(block([text('😀A', [link('first')]), text('中文', [link('second')])]))
  assert.deepEqual(spans(result), [[{ from: 0, to: 3 }], [{ from: 3, to: 5 }]])
  assert.deepEqual(result.linkDestinations.map(item => [item.token, item.occurrenceIndex]), [['first', 0], ['second', 0]])
})

test('leading and trailing emphasis whitespace stays outside a newly opened link PM run', () => {
  for (const presentation of [strong, em, schema.marks.strike.create(), schema.marks.highlight.create()]) {
    const result = emitted(block([text('  label  ', [link(), presentation])]))
    assert.deepEqual(spans(result), [[{ from: 2, to: 7 }]])
    assert.ok(result.content.startsWith('  ['))
    assert.ok(result.content.endsWith('](Target.md)  '))
  }
})

test('expelled whitespace inside an already active link retains its actual PM pieces across format changes', () => {
  const mark = link(), result = emitted(block([
    text('A', [mark]), text('  B  ', [mark, strong]), text('C', [mark])
  ]))
  assert.equal(result.content, '[A  **B**  C](Target.md)')
  assert.deepEqual(spans(result), [[{ from: 0, to: 7 }]])
})

test('an all-whitespace child follows the real active link even when its own marks differ', () => {
  const mark = link(), result = emitted(block([text('A', [mark]), text('  ', [strong]), text('B', [mark])]))
  assert.equal(result.content, '[A  B](Target.md)')
  assert.deepEqual(spans(result), [[{ from: 0, to: 4 }]], 'parent child marks alone would miss the middle two positions')
  const finalWhitespace = emitted(block([text('A', [mark]), text('  ', [mark, strong])]))
  assert.deepEqual(spans(finalWhitespace), [[{ from: 0, to: 3 }]])
  const onlyWhitespace = emitted(block([text('  ', [mark, strong])]))
  assert.equal(onlyWhitespace.content, '  ')
  assert.deepEqual(spans(onlyWhitespace), [], 'No actual link opening means no invented emission')
})

test('code is observed in the real non-escaping branch without counting code delimiters as PM content', () => {
  const mark = link(), plain = emitted(block([text('a`b', [mark, code])]))
  assert.deepEqual(spans(plain), [[{ from: 0, to: 3 }]])
  assert.ok(plain.content.includes('`` a`b ``'))
  const trimmed = emitted(block([text('  a`b  ', [mark, strong, code])]))
  assert.deepEqual(spans(trimmed), [[{ from: 2, to: 5 }]])
  const mixed = emitted(block([text('A', [mark]), text('B', [mark, code]), text('C', [mark, strong])]))
  assert.deepEqual(spans(mixed), [[{ from: 0, to: 3 }]])
})

test('middle hard breaks are inside the link but terminal or uncontinued hard breaks lose that mark', () => {
  const mark = link(), hard = () => schema.nodes.hard_break.create(null, null, [mark])
  const middle = emitted(block([text('A', [mark]), hard(), text('B', [mark])]))
  assert.deepEqual(spans(middle), [[{ from: 0, to: 3 }]])
  assert.equal(middle.content, '[A\\\nB](Target.md)')
  const terminal = emitted(block([text('A', [mark]), hard()]))
  assert.deepEqual(spans(terminal), [[{ from: 0, to: 1 }]])
  assert.equal(terminal.content, '[A](Target.md)\\\n')
  const notContinued = emitted(block([text('A', [mark]), hard(), text(' ') ]))
  assert.deepEqual(spans(notContinued), [[{ from: 0, to: 1 }]])
})

test('consecutive hard-break traversal and mixable formatting keep the installed writer behavior', () => {
  const mark = link(), hard = () => schema.nodes.hard_break.create(null, null, [mark, strong])
  const result = emitted(block([text('A ', [mark, strong]), hard(), hard(), text('B', [mark, strong])]))
  assert.ok(result.linkDestinations.length > 0)
  assert.deepEqual(spans(result), [[{ from: 0, to: 5 }]])
})

test('soft breaks remain actual inline positions including at the end of a link run', () => {
  const mark = link(), soft = () => schema.nodes.soft_break.create(null, null, [mark])
  const middle = emitted(block([text('A', [mark]), soft(), text('B', [mark])]))
  assert.deepEqual(spans(middle), [[{ from: 0, to: 3 }]])
  const terminal = emitted(block([text('A', [mark]), soft()]))
  assert.deepEqual(spans(terminal), [[{ from: 0, to: 2 }]])
})

test('autolink PM spans use real UTF16 content positions independently from the href write offset', () => {
  const href = 'https://example.test/a(b)?x=1&y=2', result = emitted(block([
    text('🙂 '), text(href, [link('auto', href)]), text(' tail')
  ]))
  assert.equal(result.linkDestinations[0].format, 'autolink')
  assert.deepEqual(spans(result), [[{ from: 3, to: 3 + href.length }]])
  assert.equal(result.content.slice(result.linkDestinations[0].from - 1, result.linkDestinations[0].to + 1), `<${href}>`)
})

test('an empty href plus a quoted emoji title has a zero-width destination and a nonempty PM label span', () => {
  const result = emitted(block([text('🙂 '), text('中文😀', [link('empty', '', 'Title "😀"'), strong])]))
  const destination = result.linkDestinations[0]
  assert.equal(destination.from, destination.to)
  assert.equal(result.content.slice(destination.from - 1, destination.to + 1), '<>')
  assert.deepEqual(destination.pmSpans, [{ from: 3, to: 7 }])
})

test('real PM split, ID repair and join retain the token while spans stay local to each emitted inline node', () => {
  const state = EditorState.create({ doc: schema.nodes.doc.create(null, block([text('ABCD', [link()])])) })
  const split = reconcileRichTextBlockIds(state.tr.split(3).doc)
  assert.equal(split.childCount, 2)
  assert.notEqual(split.child(0).attrs.block.id, split.child(1).attrs.block.id)
  for (const child of [split.child(0), split.child(1)]) {
    const result = emitted(child)
    assert.deepEqual(spans(result), [[{ from: 0, to: 2 }]])
    assert.equal(result.linkDestinations[0].token, 'actual-source')
  }
  const joined = EditorState.create({ doc: split }).tr.join(split.child(0).nodeSize).doc
  const result = emitted(joined.firstChild!)
  assert.deepEqual(spans(result), [[{ from: 0, to: 4 }]])
  assert.equal(result.linkDestinations[0].token, 'actual-source')
})

test('HTML href emissions retain per-child PM spans through entities, code and line breaks', () => {
  const mark = link('html', 'Target.md?x="&<😀>'), underline = schema.marks.underline.create()
  const input = block([
    text('🙂', [mark, underline]), text('<&>', [mark, underline, strong]),
    schema.nodes.soft_break.create(null, null, [mark, underline]),
    schema.nodes.hard_break.create(null, null, [mark, underline]), text('`code`', [mark, underline, code])
  ])
  const result = emitted(input), html = serializeRichTextInlineHtmlWithLinkTrace(input)
  assert.equal(html.content, serializeRichTextInlineHtml(input).content)
  assert.deepEqual(result.linkDestinations, html.linkDestinations)
  assert.deepEqual(spans(result), [[{ from: 0, to: 2 }], [{ from: 2, to: 5 }],
    [{ from: 5, to: 6 }], [{ from: 6, to: 7 }], [{ from: 7, to: 13 }]])
  assert.deepEqual(result.linkDestinations.map(item => item.occurrenceIndex), [0, 1, 2, 3, 4])
})

test('unprovable multiline whitespace-expulsion branches reject without modifying the PM document', () => {
  const input = block([text('first\nsecond', [link(), strong])]), before = input.toJSON()
  assert.throws(() => serializeRichTextInlineWithLinkTrace(input), /无法证明 PM 来源范围/)
  assert.deepEqual(input.toJSON(), before)
  const plain = emitted(block([text('first\nsecond', [link()])]))
  assert.deepEqual(spans(plain), [[{ from: 0, to: 12 }]])
})
