import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema, type Mark, type Node as PMNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { richTextSchema as schema } from '../src/renderer/src/rich-text/schema'
import { RICH_LINK_OCCURRENCE_ATTR, richLinkOccurrence, withRichLinkOccurrence } from '../src/renderer/src/rich-text/linkProvenance'
import { createRichPmDocIndex } from '../src/renderer/src/rich-text/richPmDocIndex'

const link = (token = 'a', href = 'A.md') => withRichLinkOccurrence(schema.marks.link.create({ href }), token)
const text = (value: string, marks: readonly Mark[] = []) => schema.text(value, marks)
const draft = (id: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null) =>
  ({ id, type, content: '', checked: false, depth, parentBlockId })
const paragraph = (id: string, children: PMNode[], depth = 0, parentBlockId: string | null = null) =>
  schema.nodes.text_block.create({ block: draft(id, 'paragraph', depth, parentBlockId) }, children)
const document = (children: PMNode[]) => schema.nodes.doc.create(null, children)

/** The pre-index implementation, exercised against actual PM values. */
function legacyMarkFor(doc: PMNode, from: number, to: number, token: string, href: string): boolean {
  let covered = 0, accepted = true
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true
    const width = Math.max(0, Math.min(to, pos + node.nodeSize) - Math.max(from, pos))
    const mark = node.marks.find(item => item.type.name === 'link')
    if (width && (!mark || richLinkOccurrence(mark) !== token || mark.attrs.href !== href)) accepted = false
    covered += width; return false
  })
  return accepted && covered === to - from
}
const noHref = Symbol('No uniform actual href')
function legacyHref(doc: PMNode, from: number, to: number, token: string): string | undefined {
  try {
    let href: string | undefined
    doc.nodesBetween(from, to, node => {
      if (!node.isInline) return true
      const mark = node.marks.find(item => item.type.name === 'link')
      if (!mark || richLinkOccurrence(mark) !== token || typeof mark.attrs.href !== 'string') throw noHref
      if (href !== undefined && href !== mark.attrs.href) throw noHref
      href = mark.attrs.href; return false
    })
    return href
  } catch (error) { if (error === noHref) return undefined; throw error }
}
function legacyEntries(doc: PMNode, from: number, to: number) {
  const result: Array<{ node: PMNode; pos: number }> = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true
    result.push({ node, pos }); return false
  })
  return result
}

test('indexed link coverage clips UTF16 ranges and counts actual hard breaks without accepting unmarked whitespace', () => {
  const mark = link(), doc = document([paragraph(' 旧:正文 ', [text('😀A', [mark]), text(' '),
    schema.nodes.hard_break.create(null, null, [mark]), text('B', [mark])])])
  const index = createRichPmDocIndex(doc)
  assert.equal(index.doc, doc)
  assert.equal(index.hasLinkMark(1, 4, 'a', 'A.md'), true)
  assert.equal(index.hasLinkMark(2, 3, 'a', 'A.md'), true, 'PM offsets are UTF16 code units, including a clipped emoji')
  assert.equal(index.hasLinkMark(5, 7, 'a', 'A.md'), true, 'The hard break contributes its real nodeSize')
  assert.equal(index.hasLinkMark(4, 5, 'a', 'A.md'), false)
  assert.equal(index.hasLinkMark(1, 7, 'a', 'A.md'), false, 'Unmarked whitespace cannot inherit a nearby link')
  assert.equal(index.hasLinkMark(0, 1, 'a', 'A.md'), false)
  assert.equal(index.hasLinkMark(7, 8, 'a', 'A.md'), false)
  assert.equal(index.linkHref(1, 4, 'a'), 'A.md')
  assert.equal(index.linkHref(1, 7, 'a'), undefined)
})

test('equal link attributes across blocks never cover their intervening structural gap', () => {
  const mark = link(), doc = document([paragraph('first', [text('A', [mark])]), paragraph('second', [text('B', [mark])])])
  const index = createRichPmDocIndex(doc)
  assert.equal(index.hasLinkMark(1, 2, 'a', 'A.md'), true)
  assert.equal(index.hasLinkMark(4, 5, 'a', 'A.md'), true)
  assert.equal(index.hasLinkMark(1, 5, 'a', 'A.md'), false)
  assert.equal(index.hasLinkMark(0, doc.content.size, 'a', 'A.md'), false)
  assert.equal(index.linkHref(1, 5, 'a'), 'A.md', 'Like old hrefAt, this read alone is not full coverage authority')
  assert.deepEqual(index.inlineEntries(1, 5).map(entry => entry.pos), [1, 4])
})

test('same href with different tokens and same token with different hrefs both fail complete matching', () => {
  const doc = document([paragraph('mixed', [text('A', [link('a', 'A.md')]), text('B', [link('b', 'A.md')]),
    text('C', [link('a', 'B.md')])])]), index = createRichPmDocIndex(doc)
  assert.equal(index.hasLinkMark(1, 3, 'a', 'A.md'), false)
  assert.equal(index.hasLinkMark(1, 4, 'a', 'A.md'), false)
  assert.equal(index.hasLinkMark(3, 4, 'a', 'B.md'), true)
  assert.equal(index.linkHref(1, 3, 'a'), undefined)
  assert.equal(index.linkHref(1, 4, 'a'), undefined)
  assert.equal(index.linkHref(3, 4, 'a'), 'B.md')
})

test('the index retains real nested column/atom starts and never pretends text interiors are node starts', () => {
  const mark = link(), nested = paragraph('child', [text('😀N', [mark])], 2, 'column')
  const column = schema.nodes.column_block.create({ block: { ...draft('column', 'column', 1, 'columns'),
    markdownFormat: { columnWeight: 10000 } } }, [nested])
  const columns = schema.nodes.columns_block.create({ block: draft('columns', 'columns') }, [column])
  const atom = schema.nodes.source_block.create({ block: { ...draft('atom', 'code'), content: '[opaque](A.md)' } })
  const doc = document([paragraph('first', [text('Q', [mark])]), columns, atom]), before = doc.toJSON()
  const index = createRichPmDocIndex(doc), starts = new Map<number, PMNode>()
  doc.descendants((node, pos) => { starts.set(pos, node) })
  for (const [pos, node] of starts) assert.equal(index.nodeAtStart(pos), node)
  const nestedTextPos = [...starts].find(([, node]) => node.isText && node.text === '😀N')![0]
  assert.equal(index.hasLinkMark(nestedTextPos, nestedTextPos + 3, 'a', 'A.md'), true)
  assert.equal(index.nodeAtStart(nestedTextPos + 1), undefined)
  assert.equal(doc.nodeAt(nestedTextPos + 1), starts.get(nestedTextPos), 'Generic PM nodeAt also returns text interiors')
  assert.equal(index.nodeAtStart(0), doc.firstChild)
  assert.equal(index.nodeAtStart(doc.content.size), undefined)
  assert.equal(index.nodeAtStart(-1), undefined)
  assert.deepEqual(doc.toJSON(), before)
})

test('all valid range boundaries agree with the old actual nodesBetween mark, href and inline visit semantics', () => {
  const doc = document([
    paragraph('one', [text('😀', [link('a')]), text(' '), text('X', [link('b')]),
      schema.nodes.hard_break.create(null, null, [link('a', 'B.md')])]),
    paragraph('empty', []),
    paragraph('two', [text('中文', [link('a', 'B.md')]), schema.nodes.soft_break.create(null, null, [link('a', 'B.md')]),
      text('E', [link('empty', '')])])
  ])
  const index = createRichPmDocIndex(doc)
  for (let from = 0; from <= doc.content.size; from++) for (let to = from; to <= doc.content.size; to++) {
    const actualEntries = index.inlineEntries(from, to), expectedEntries = legacyEntries(doc, from, to)
    assert.equal(actualEntries.length, expectedEntries.length, `entry count at ${from}:${to}`)
    actualEntries.forEach((entry, ordinal) => {
      assert.equal(entry.pos, expectedEntries[ordinal].pos)
      assert.equal(entry.node, expectedEntries[ordinal].node)
    })
    for (const token of ['a', 'b', 'empty', 'absent']) {
      for (const href of ['A.md', 'B.md', '']) assert.equal(index.hasLinkMark(from, to, token, href),
        legacyMarkFor(doc, from, to, token, href), `coverage at ${from}:${to}/${token}/${href}`)
      assert.equal(index.linkHref(from, to, token), legacyHref(doc, from, to, token), `href at ${from}:${to}/${token}`)
    }
  }
})

test('empty href is preserved while empty PM ranges retain their old interior and boundary behavior', () => {
  const doc = document([paragraph('empty-href', [text('😀', [link('empty', '')])])]), index = createRichPmDocIndex(doc)
  assert.equal(index.hasLinkMark(1, 3, 'empty', ''), true)
  assert.equal(index.linkHref(1, 3, 'empty'), '')
  assert.equal(index.hasLinkMark(2, 2, 'anything', 'anything'), true)
  assert.equal(index.linkHref(2, 2, 'empty'), '', 'A zero-width interior still visits its inline node in old hrefAt')
  assert.equal(index.linkHref(1, 1, 'empty'), undefined)
  assert.equal(index.linkHref(3, 3, 'empty'), undefined)
  assert.equal(index.hasLinkMark(0, 0, 'empty', ''), true)
  assert.equal(index.linkHref(0, 0, 'empty'), undefined)
  const emptyDoc = createRichPmDocIndex(document([paragraph('empty', [])]))
  assert.equal(emptyDoc.hasLinkMark(0, 2, 'empty', ''), false)
  assert.equal(emptyDoc.hasLinkMark(1, 1, 'empty', ''), true)
  assert.deepEqual(emptyDoc.inlineEntries(0, 2), [])
})

test('malformed tokens are checked lazily only on actual query intersections and not hidden after earlier mismatch', () => {
  const bad = schema.marks.link.create({ href: 'A.md', [RICH_LINK_OCCURRENCE_ATTR]: 3 })
  const doc = document([paragraph('good', [text('good', [link()])]), paragraph('bad', [text('X', [bad])])])
  const index = createRichPmDocIndex(doc)
  assert.equal(index.hasLinkMark(1, 5, 'a', 'A.md'), true)
  assert.equal(index.linkHref(1, 5, 'a'), 'A.md')
  assert.throws(() => index.hasLinkMark(7, 8, 'a', 'A.md'), /临时来源标识/)
  assert.throws(() => index.linkHref(7, 8, 'a'), /临时来源标识/)
  assert.throws(() => index.hasLinkMark(0, 8, 'wrong', 'A.md'), /临时来源标识/)
  assert.throws(() => legacyMarkFor(doc, 0, 8, 'wrong', 'A.md'), /临时来源标识/)
  assert.equal(index.inlineEntries(7, 8)[0].node.marks[0], bad, 'Reading actual entries grants no mark/source validity')
})

test('invalid ranges cannot acquire coverage, hrefs or inline entries', () => {
  const doc = document([paragraph('one', [text('A', [link()])])]), index = createRichPmDocIndex(doc)
  for (const [from, to] of [[-1, 1], [0, doc.content.size + 1], [2, 1], [NaN, 2], [1, Infinity], [1.5, 2]]) {
    assert.equal(index.hasLinkMark(from, to, 'a', 'A.md'), false)
    assert.equal(index.linkHref(from, to, 'a'), undefined)
    assert.deepEqual(index.inlineEntries(from, to), [])
  }
})

test('separate actual PM documents keep separate immutable indexes after a real text transaction', () => {
  const doc = document([paragraph('one', [text('AB', [link()])])]), original = doc.toJSON()
  const first = createRichPmDocIndex(doc), after = EditorState.create({ doc }).tr.insertText('Z', 2).doc
  const second = createRichPmDocIndex(after)
  assert.notEqual(first.doc, second.doc)
  assert.equal(first.doc, doc)
  assert.equal(second.doc, after)
  assert.equal(first.hasLinkMark(1, 3, 'a', 'A.md'), true)
  assert.equal(first.hasLinkMark(1, 4, 'a', 'A.md'), false)
  assert.equal(second.hasLinkMark(1, 4, 'a', 'A.md'), true)
  assert.equal(first.nodeAtStart(1)!.text, 'AB')
  assert.equal(second.nodeAtStart(1)!.text, 'AZB')
  const entries = first.inlineEntries(0, doc.content.size)
  assert.ok(Object.isFrozen(first) && Object.isFrozen(entries) && Object.isFrozen(entries[0]))
  assert.deepEqual(doc.toJSON(), original)
})

test('inline nonleaf descendants stay excluded from link visits but retain their exact physical starts', () => {
  const custom = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' }, wrapper: { inline: true, group: 'inline', content: 'text*' } },
  marks: { link: { attrs: { href: {}, [RICH_LINK_OCCURRENCE_ATTR]: { default: null } } } } })
  const outer = custom.marks.link.create({ href: 'A.md', [RICH_LINK_OCCURRENCE_ATTR]: 'a' })
  const badChild = custom.marks.link.create({ href: 'B.md', [RICH_LINK_OCCURRENCE_ATTR]: 3 })
  const child = custom.text('XY', [badChild]), wrapper = custom.nodes.wrapper.create(null, child, [outer])
  const doc = custom.nodes.doc.create(null, custom.nodes.paragraph.create(null, wrapper)), index = createRichPmDocIndex(doc)
  assert.equal(index.hasLinkMark(1, 5, 'a', 'A.md'), true)
  assert.equal(index.hasLinkMark(2, 3, 'a', 'A.md'), legacyMarkFor(doc, 2, 3, 'a', 'A.md'))
  assert.equal(index.linkHref(2, 3, 'a'), legacyHref(doc, 2, 3, 'a'))
  assert.deepEqual(index.inlineEntries(1, 5).map(entry => entry.pos), [1])
  assert.equal(index.inlineEntries(1, 5)[0].node, wrapper)
  assert.equal(index.nodeAtStart(2), child)
})
