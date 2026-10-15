import assert from 'node:assert/strict'
import test from 'node:test'
import { Slice } from 'prosemirror-model'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import type { DocumentBlockDraft } from '../src/shared/contracts.ts'
import { validColumnStructure } from '../src/shared/columns.ts'
import { parseMarkdownBlocks } from '../src/shared/markdown.ts'
import { draftBlocksToRichDoc, reconcileRichTextBlockIds, richBlockEntries, richDocToDraftBlocks } from '../src/renderer/src/rich-text/model.ts'
import { richEndpoint, richPositionOf, richTextSelectionBlockIds } from '../src/renderer/src/rich-text/positions.ts'
import { richTextSliceMarkdown } from '../src/renderer/src/rich-text/clipboard.ts'
import { deleteCrossColumnSelection } from '../src/renderer/src/rich-text/columnEditing.ts'
import { planRichTextTreePaste } from '../src/renderer/src/rich-text/paste.ts'
import { reorderColumn } from '../src/renderer/src/utils/columnOperations.ts'
import { richTextSchema } from '../src/renderer/src/rich-text/schema.ts'

const block = (id: string, type: string, content = '', depth = 0, parentBlockId: string | null = null,
  patch: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft => ({ id, type, content, depth, parentBlockId, checked: false, ...patch })
function fixture(): DocumentBlockDraft[] {
  return [block('before', 'paragraph', 'Outside before'), block('group', 'columns'),
    block('left', 'column', '', 1, 'group', { markdownFormat: { columnWeight: 3500 } }),
    block('alpha', 'paragraph', 'Alpha😀Tail', 2, 'left', { tags: ['keep'], highlight: 'blue' }),
    block('table', 'table', '| A | B |\n| --- | --- |\n| One | Two |', 2, 'left'),
    block('right', 'column', '', 1, 'group', { markdownFormat: { columnWeight: 6500 } }),
    block('beta', 'paragraph', 'Beta😀End', 2, 'right'), block('after', 'paragraph', 'Outside after')]
}
const entry = (state: EditorState, id: string) => richBlockEntries(state.doc).find(({ node }) => node.attrs.block.id === id)!
function selected(fromId: string, fromOffset: number, toId = fromId, toOffset = fromOffset) {
  const state = EditorState.create({ doc: draftBlocksToRichDoc(fixture()) })
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, entry(state, fromId).pos + 1 + fromOffset, entry(state, toId).pos + 1 + toOffset)))
}

test('columns form real nested non-atomic PM nodes while DFS entries retain every persisted identity', () => {
  const before = fixture(), doc = draftBlocksToRichDoc(before)
  assert.equal(doc.childCount, 3)
  const group = doc.child(1)
  assert.equal(group.type.name, 'columns_block')
  assert.equal(group.isAtom, false)
  assert.equal(group.childCount, 2)
  assert.equal(group.child(0).type.name, 'column_block')
  assert.equal(group.child(0).childCount, 2)
  assert.deepEqual(richBlockEntries(doc).map(({ node, index }) => [index, node.attrs.block.id]), before.map((value, index) => [index, value.id]))
  assert.deepEqual(richDocToDraftBlocks(doc), before)
})

test('an empty authored column survives without a synthetic paragraph or invented child identity', () => {
  const before = fixture().filter(value => !['alpha', 'table'].includes(value.id!))
  const doc = draftBlocksToRichDoc(before)
  assert.equal(doc.child(1).child(0).childCount, 0)
  assert.deepEqual(richDocToDraftBlocks(doc), before)
})

test('deep typing and an actual ProseMirror split preserve the column and other trees', () => {
  const initial = selected('alpha', 5), position = initial.selection.from
  const typed = initial.apply(initial.tr.insertText('中文', position))
  assert.equal(richDocToDraftBlocks(typed.doc).find(value => value.id === 'alpha')!.content, 'Alpha中文😀Tail')
  const split = reconcileRichTextBlockIds(typed.tr.split(position + 2).doc)
  const after = richDocToDraftBlocks(split)
  assert.deepEqual(after.filter(value => value.parentBlockId === 'left' && value.type === 'paragraph').map(value => value.content), ['Alpha中文', '😀Tail'])
  assert.equal(new Set(after.map(value => value.id)).size, after.length)
  assert.equal(validColumnStructure(after, { checkParentIds: true }), true)
  assert.deepEqual(after.find(value => value.id === 'beta'), fixture().find(value => value.id === 'beta'))
  assert.deepEqual(richDocToDraftBlocks(initial.doc), fixture())
})

test('duplicating the same PM layout node gives its second entire forest fresh identities and matching owners', () => {
  const original = draftBlocksToRichDoc(fixture()).child(1)
  const doc = reconcileRichTextBlockIds(richTextSchema.nodes.doc.create(null, [original, original]))
  const after = richDocToDraftBlocks(doc)
  assert.equal(after[0].id, 'group')
  assert.equal(new Set(after.map(value => value.id)).size, after.length)
  const groups = after.filter(value => value.type === 'columns')
  assert.equal(groups.length, 2)
  for (const group of groups) assert.equal(after.filter(value => value.type === 'column' && value.parentBlockId === group.id).length, 2)
  assert.equal(validColumnStructure(after, { checkParentIds: true }), true)
})

test('deep backward bookmarks follow their block IDs through a real column reorder', () => {
  const state = selected('beta', 6, 'alpha', 2)
  const anchor = richEndpoint(state.doc, state.selection.anchor), head = richEndpoint(state.doc, state.selection.head)
  assert.equal(anchor.blockId, 'beta'); assert.equal(head.blockId, 'alpha')
  const next = reorderColumn(fixture(), 'right', 0)!
  assert.ok(next)
  const doc = draftBlocksToRichDoc(next)
  const selection = TextSelection.create(doc, richPositionOf(doc, anchor), richPositionOf(doc, head))
  assert.equal(richEndpoint(doc, selection.anchor).blockId, 'beta')
  assert.equal(richEndpoint(doc, selection.head).blockId, 'alpha')
  assert.equal(richEndpoint(doc, selection.anchor).offset, 6)
  assert.equal(richEndpoint(doc, selection.head).offset, 2)
})

test('ordinary text selection targets leaves, while complete layout NodeSelection includes its structures', () => {
  const state = selected('alpha', 2, 'beta', 3)
  assert.deepEqual(richTextSelectionBlockIds(state), ['alpha', 'table', 'beta'])
  const group = entry(state, 'group')
  const whole = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, group.pos)))
  assert.deepEqual(richTextSelectionBlockIds(whole), ['group', 'left', 'alpha', 'table', 'right', 'beta'])
  assert.deepEqual(richTextSelectionBlockIds(selected('beta', 1)), ['beta'])
})

test('one actual cross-column mark transaction formats both columns and leaves outside text untouched', () => {
  const state = selected('alpha', 5, 'beta', 4)
  const next = state.apply(state.tr.addMark(state.selection.from, state.selection.to, richTextSchema.marks.strong.create()))
  const after = richDocToDraftBlocks(next.doc)
  assert.match(after.find(value => value.id === 'alpha')!.content, /\*\*😀Tail\*\*/)
  assert.match(after.find(value => value.id === 'beta')!.content, /\*\*Beta\*\*/)
  assert.deepEqual(after.find(value => value.id === 'before'), fixture()[0])
  assert.equal(validColumnStructure(after, { checkParentIds: true }), true)
})

test('copying an open selection inside a column produces a closed valid Markdown forest', () => {
  const state = selected('alpha', 1, 'alpha', 7)
  const markdown = richTextSliceMarkdown(state.selection.content())
  const parsed = parseMarkdownBlocks(markdown)
  assert.equal(validColumnStructure(parsed), true)
  assert.ok(parsed.some(value => value.content.includes('lpha😀')))
  assert.ok(!markdown.includes('"id":"alpha"'))
  assert.deepEqual(richDocToDraftBlocks(state.doc), fixture())
})

test('a detached copied column becomes a complete independent single-column group with weight 10000', () => {
  const doc = draftBlocksToRichDoc(fixture()), column = doc.child(1).child(0)
  const markdown = richTextSliceMarkdown(new Slice(column.content.size ? richTextSchema.nodes.doc.create(null, column).content : doc.content, 0, 0))
  const parsed = parseMarkdownBlocks(markdown)
  assert.equal(validColumnStructure(parsed), true)
  const columns = parsed.filter(value => value.type === 'column')
  assert.equal(columns.length, 1)
  assert.equal(columns[0].markdownFormat?.columnWeight, 10000)
  assert.ok(parsed.some(value => value.content === 'Alpha😀Tail'))
})

test('cross-column deletion preserves both shells, authored ratios and existing text identities', () => {
  const state = selected('alpha', 5, 'beta', 4)
  const tr = deleteCrossColumnSelection(state)
  assert.ok(tr)
  const after = richDocToDraftBlocks(state.apply(tr).doc)
  assert.equal(after.find(value => value.id === 'alpha')!.content, 'Alpha')
  assert.equal(after.find(value => value.id === 'beta')!.content, '😀End')
  assert.equal(after.some(value => value.id === 'table'), false)
  for (const id of ['group', 'left', 'right', 'before', 'after']) assert.deepEqual(after.find(value => value.id === id), fixture().find(value => value.id === id))
  assert.equal(validColumnStructure(after, { checkParentIds: true }), true)
  assert.deepEqual(richDocToDraftBlocks(state.doc), fixture())
})

test('a real insertion after cross-column deletion replaces selected text without moving a column', () => {
  const state = selected('alpha', 5, 'beta', 4)
  const tr = deleteCrossColumnSelection(state)!
  tr.insertText('中文😀')
  const after = richDocToDraftBlocks(state.apply(tr).doc)
  assert.equal(after.find(value => value.id === 'alpha')!.content, 'Alpha中文😀')
  assert.equal(after.find(value => value.id === 'beta')!.content, '😀End')
  assert.deepEqual(after.filter(value => value.type === 'column'), fixture().filter(value => value.type === 'column'))
  assert.equal(validColumnStructure(after, { checkParentIds: true }), true)
})

test('nested layouts preserve their own proportions and resolve deepest paragraph bookmarks', () => {
  const before = fixture()
  before.splice(4, 0, block('nested', 'columns', '', 2, 'left'),
    block('nested-left', 'column', '', 3, 'nested', { markdownFormat: { columnWeight: 7000 } }),
    block('nested-text', 'paragraph', 'Nested 中文😀', 4, 'nested-left'),
    block('nested-right', 'column', '', 3, 'nested', { markdownFormat: { columnWeight: 3000 } }))
  const doc = draftBlocksToRichDoc(before)
  assert.equal(validColumnStructure(richDocToDraftBlocks(doc), { checkParentIds: true }), true)
  const node = richBlockEntries(doc).find(value => value.node.attrs.block.id === 'nested-text')!
  const point = richEndpoint(doc, node.pos + 1 + 7)
  assert.equal(point.blockId, 'nested-text'); assert.equal(point.offset, 7)
  assert.equal(richPositionOf(doc, point), node.pos + 8)
  assert.deepEqual(richDocToDraftBlocks(doc), before)
})

test('structured paste inside a column retains its mixed context and the untouched neighboring column', () => {
  const state = selected('alpha', 5)
  const pasted = [block('incoming-heading', 'heading-2', 'Mixed heading'), block('incoming-task', 'todo', 'Mixed task')]
  const plan = planRichTextTreePaste(state.doc, state.selection, pasted)
  assert.ok(plan)
  const after = richDocToDraftBlocks(plan.doc)
  for (const content of ['Mixed heading', 'Mixed task']) assert.equal(after.find(value => value.content === content)!.parentBlockId, 'left')
  assert.deepEqual(after.find(value => value.id === 'beta'), fixture().find(value => value.id === 'beta'))
  assert.equal(validColumnStructure(after, { checkParentIds: true }), true)
})
