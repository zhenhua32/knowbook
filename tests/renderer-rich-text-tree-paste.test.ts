import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState, Selection, TextSelection } from 'prosemirror-state'
import type { DocumentBlockDraft } from '../src/shared/contracts.ts'
import { serializeBlocksToMarkdown } from '../src/shared/markdown.ts'
import { draftBlocksToRichDoc, richDocToDraftBlocks } from '../src/renderer/src/rich-text/model.ts'
import { planRichTextTreePaste } from '../src/renderer/src/rich-text/paste.ts'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization.ts'
import { isDraftTreeContiguous } from '../src/renderer/src/utils/draftTreeDepthChange.ts'

const block = (id: string, content: string, patch: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft => ({
  id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, ...patch
})
const owner = () => block('owner', 'AlphaBeta', { type: 'numbered-todo', checked: true, tags: ['owner-tag'], highlight: 'blue',
  listStart: 8, markdownFormat: { listMarker: ')', listLoose: true } })
const subtree = () => [owner(), block('child', 'Child', { type: 'todo', checked: true, depth: 1, parentBlockId: 'owner', tags: ['child-tag'] }),
  block('grandchild', 'Grandchild', { type: 'bulleted-list', depth: 2, parentBlockId: 'child' }),
  block('other-child', 'Other', { type: 'todo', depth: 1, parentBlockId: 'owner' }), block('after', 'After')]
const structured = () => [block('pasted-heading', 'Heading', { type: 'heading-2' }), block('pasted-body', 'Body')]

function run(before: DocumentBlockDraft[], target: number, from: number, to: number, pasted: DocumentBlockDraft[]) {
  const state = EditorState.create({ doc: draftBlocksToRichDoc(before) })
  const start = 1 + Array.from({ length: target }, (_value, index) => state.doc.child(index).nodeSize).reduce((sum, size) => sum + size, 0)
  const selection = TextSelection.create(state.doc, start + from, start + to)
  const plan = planRichTextTreePaste(state.doc, selection, pasted)
  assert.ok(plan)
  const transaction = state.tr.replaceWith(0, state.doc.content.size, plan.doc.content)
  transaction.setSelection(Selection.fromJSON(transaction.doc, plan.selection.toJSON()))
  const nextState = state.apply(transaction)
  const after = richDocToDraftBlocks(nextState.doc)
  assert.deepEqual(validateBlockTreeStructure(after), { valid: true, errors: [] })
  assert.equal(isDraftTreeContiguous(after), true)
  assert.equal(new Set(after.map(item => item.id)).size, after.length)
  return { beforeState: state, afterState: nextState, after }
}

test('structural paste preserves the root list owner and complete existing child trees', () => {
  const before = subtree()
  const { after, afterState, beforeState } = run(before, 0, 5, 5, structured())
  assert.deepEqual(after.slice(0, 4).map(item => [item.id, item.content, item.parentBlockId]),
    [['owner', 'Alpha', null], ['child', 'Child', 'owner'], ['grandchild', 'Grandchild', 'child'], ['other-child', 'Other', 'owner']])
  assert.deepEqual(after.slice(4).map(item => [item.type, item.content]),
    [['heading-2', 'Heading'], ['paragraph', 'Body'], ['numbered-todo', 'Beta'], ['paragraph', 'After']])
  assert.equal(after[0].checked, true)
  assert.deepEqual(after[0].tags, ['owner-tag'])
  assert.equal(after[0].highlight, 'blue')
  assert.equal(after[0].listStart, 8)
  assert.deepEqual(after[0].markdownFormat, before[0].markdownFormat)
  assert.equal(after[6].checked, false)
  for (const key of ['tags', 'highlight', 'listStart'] as const) assert.equal(after[6][key], undefined)
  assert.notEqual(after[6].id, 'owner')
  assert.equal(afterState.selection.$from.index(0), 6)
  assert.equal(afterState.selection.$from.parentOffset, 0)
  assert.deepEqual(richDocToDraftBlocks(beforeState.doc), before)
  assert.deepEqual(richDocToDraftBlocks(draftBlocksToRichDoc(after)), after)
})

test('nested owner retains descendants while standalone pasted roots exit the surrounding list safely', () => {
  const before = [block('outer', 'Outer', { type: 'todo' }),
    block('owner', 'AlphaBeta', { type: 'todo', checked: true, depth: 1, parentBlockId: 'outer' }),
    block('child', 'Child', { type: 'todo', depth: 2, parentBlockId: 'owner' }),
    block('grandchild', 'Grandchild', { type: 'todo', depth: 3, parentBlockId: 'child' }),
    block('later-sibling', 'Later', { type: 'todo', depth: 1, parentBlockId: 'outer' }), block('after', 'After')]
  const { after } = run(before, 1, 5, 5, structured())
  assert.equal(after.find(item => item.id === 'owner')!.parentBlockId, 'outer')
  assert.equal(after.find(item => item.id === 'child')!.parentBlockId, 'owner')
  assert.equal(after.find(item => item.id === 'grandchild')!.parentBlockId, 'child')
  assert.equal(after.find(item => item.content === 'Heading')!.depth, 0)
  assert.equal(after.find(item => item.content === 'Beta')!.depth, 0)
  assert.equal(after.find(item => item.id === 'later-sibling')!.content, 'Later')
})

test('pasted nested lists become following siblings and never acquire the original child tree', () => {
  const before = [block('outer', 'Outer', { type: 'todo' }),
    block('owner', 'AlphaBeta', { type: 'todo', depth: 1, parentBlockId: 'outer' }),
    block('child', 'Child', { type: 'todo', depth: 2, parentBlockId: 'owner' }), block('after', 'After')]
  const pasted = [block('incoming', 'New root', { type: 'todo', checked: true }),
    block('incoming-child', 'New child', { type: 'todo', depth: 1, parentBlockId: 'incoming' })]
  const { after } = run(before, 1, 5, 5, pasted)
  const root = after.find(item => item.content === 'New root')!, child = after.find(item => item.content === 'New child')!
  assert.equal(root.depth, 1)
  assert.equal(root.parentBlockId, 'outer')
  assert.equal(root.checked, true)
  assert.equal(child.depth, 2)
  assert.equal(child.parentBlockId, root.id)
  assert.equal(after.find(item => item.id === 'child')!.parentBlockId, 'owner')
  assert.equal(after.find(item => item.content === 'Beta')!.parentBlockId, 'outer')
  assert.equal(after.findIndex(item => item.id === 'child') < after.findIndex(item => item.id === root.id), true)
})

test('plain multiple paragraphs keep the original parent children and place the caret before the suffix', () => {
  const { after, afterState } = run(subtree(), 0, 5, 5, [block('one', 'One'), block('two', 'Two')])
  assert.deepEqual(after.slice(4, 7).map(item => item.content), ['One', 'Two', 'Beta'])
  assert.equal(after.find(item => item.id === 'child')!.parentBlockId, 'owner')
  assert.equal(afterState.selection.$from.parent.textContent, 'Beta')
  assert.equal(afterState.selection.$from.parentOffset, 0)
})

test('partial Chinese/emoji selection preserves prefix and suffix marks and the task owner metadata', () => {
  const before = subtree()
  before[0].content = '**中文😀** *后缀*'
  const { after, afterState } = run(before, 0, 4, 5, structured())
  assert.equal(after[0].content, '**中文😀**')
  const suffix = after.find(item => item.content === '*后缀*')!
  assert.ok(suffix)
  assert.equal(suffix.checked, false)
  assert.equal(after[0].checked, true)
  assert.equal(afterState.selection.$from.parentOffset, 0)
  assert.equal(afterState.selection.$from.parent.firstChild!.marks[0].type.name, 'em')
  assert.equal(after.find(item => item.id === 'child')!.checked, true)
})

test('contextual depth overflow preserves every pasted level as standalone Markdown source', () => {
  const before: DocumentBlockDraft[] = []
  for (let depth = 0; depth <= 5; depth++) before.push(block(depth === 5 ? 'owner' : `ancestor-${depth}`, depth === 5 ? 'AlphaBeta' : `Level ${depth}`,
    { type: 'todo', depth, parentBlockId: depth ? `ancestor-${depth - 1}` : null }))
  before.push(block('child', 'Existing child', { type: 'todo', depth: 6, parentBlockId: 'owner' }), block('after', 'After'))
  const pasted = [block('new-root', 'New root', { type: 'todo' }),
    block('new-child', 'New child', { type: 'todo', depth: 1, parentBlockId: 'new-root' }),
    block('new-grandchild', 'New grandchild', { type: 'todo', depth: 2, parentBlockId: 'new-child' })]
  const { after, afterState } = run(before, 5, 5, 5, pasted)
  const literalIndex = after.findIndex(item => item.content === serializeBlocksToMarkdown(pasted))
  assert.ok(literalIndex >= 0)
  assert.equal(afterState.doc.child(literalIndex).type.name, 'source_block')
  assert.equal(after.find(item => item.id === 'child')!.parentBlockId, 'owner')
  assert.equal(after.find(item => item.id === 'child')!.depth, 6)
  assert.equal(after.find(item => item.content === 'Beta')!.depth, 0)
})

test('paste at the owner end keeps descendants and places the caret at the final inserted text', () => {
  const { after, afterState } = run(subtree(), 0, 9, 9, structured())
  assert.ok(!after.some(item => item.content === 'Beta'))
  assert.equal(afterState.selection.$from.parent.textContent, 'Body')
  assert.equal(afterState.selection.$from.parentOffset, 4)
  assert.equal(after.find(item => item.id === 'child')!.parentBlockId, 'owner')
})

test('ordinary inline paste and selections crossing block boundaries are outside this planner', () => {
  const state = EditorState.create({ doc: draftBlocksToRichDoc(subtree()) })
  assert.equal(planRichTextTreePaste(state.doc, TextSelection.create(state.doc, 6), [block('inline', '**inline**')]), null)
  assert.equal(planRichTextTreePaste(state.doc, TextSelection.create(state.doc, 6, state.doc.child(0).nodeSize + 2), structured()), null)
})
