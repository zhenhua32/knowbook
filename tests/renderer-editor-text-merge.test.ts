import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { planDraftTextMerge } from '../src/renderer/src/utils/draftTreeTextMerge'
import { isDraftTreeContiguous } from '../src/renderer/src/utils/draftTreeDepthChange'

const text = (id: string, content = id, type = 'paragraph'): DocumentBlockDraft =>
  ({ id, type, content, checked: false, depth: 0, parentBlockId: null, tags: [id], highlight: 'blue' })
const item = (id: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
  ({ ...text(id, id, 'numbered-todo'), depth, parentBlockId, checked: true, listStart: 4,
    markdownFormat: { listMarker: ')', listLoose: true } })
const shape = (blocks: DocumentBlockDraft[]) => blocks.map(({ id, depth, parentBlockId }) => [id, depth, parentBlockId ?? null])
function merge(blocks: DocumentBlockDraft[], left: number, right: number) {
  const snapshot = structuredClone(blocks)
  const plan = planDraftTextMerge(blocks, left, right)
  assert.ok(plan)
  assert.equal(isDraftTreeContiguous(plan.blocks), true)
  assert.deepEqual(blocks, snapshot, 'planning must not change the source document')
  assert.deepEqual(plan.blocks[left], { ...snapshot[left], content: snapshot[left].content + snapshot[right].content })
  assert.equal(plan.focusIndex, left)
  assert.equal(plan.cursorPosition, snapshot[left].content.length)
  assert.equal(plan.blocks.some(block => block.id === snapshot[right].id), false)
  assert.equal(plan.blocks.length, blocks.length - 1)
  return plan.blocks
}

for (const [left, right] of [['你好🙂', 'Beta'], ['', 'Beta'], ['Alpha', '']]) {
  test(`forward Delete joins text ${JSON.stringify([left, right])} without changing left identity or format`, () => {
    const blocks = [text('before'), text('left', left),
      text('right', right, 'heading-2'), text('after')]
    const result = merge(blocks, 1, 2)
    assert.deepEqual(result, [blocks[0], { ...blocks[1], content: left + right }, blocks[3]])
  })
}

test('merging two list siblings retains both full child trees, checks, starting numbers and source formats', () => {
  const blocks = [item('outer'), item('left', 1, 'outer'), item('left-child', 2, 'left'),
    item('left-grandchild', 3, 'left-child'), item('right', 1, 'outer'), item('right-child', 2, 'right'),
    item('right-grandchild', 3, 'right-child'), item('other-right-child', 2, 'right'), item('tail', 1, 'outer'), text('after')]
  const result = merge(blocks, 1, 4)
  assert.deepEqual(result, [blocks[0], { ...blocks[1], content: 'leftright' }, blocks[2], blocks[3],
    { ...blocks[5], parentBlockId: 'left' }, blocks[6], { ...blocks[7], parentBlockId: 'left' }, blocks[8], blocks[9]])
})

test('a list parent absorbs its first child and promotes that child descendants alongside remaining children', () => {
  const blocks = [item('left'), item('right', 1, 'left'), item('grandchild', 2, 'right'),
    item('great-grandchild', 3, 'grandchild'), item('later-child', 1, 'left'), text('after')]
  const result = merge(blocks, 0, 1)
  assert.deepEqual(shape(result), [['left', 0, null], ['grandchild', 1, 'left'],
    ['great-grandchild', 2, 'grandchild'], ['later-child', 1, 'left'], ['after', 0, null]])
  assert.deepEqual(result[1], { ...blocks[2], depth: 1, parentBlockId: 'left' })
  assert.deepEqual(result[2], { ...blocks[3], depth: 2 })
  assert.deepEqual(result.slice(3), blocks.slice(4))
})

test('a shallower following list attaches its complete children after the left children without changing outer siblings', () => {
  const blocks = [item('outer'), item('left', 1, 'outer'), item('left-child', 2, 'left'),
    item('right'), item('right-child', 1, 'right'), item('right-grandchild', 2, 'right-child'), text('after')]
  const result = merge(blocks, 1, 3)
  assert.deepEqual(shape(result), [['outer', 0, null], ['left', 1, 'outer'], ['left-child', 2, 'left'],
    ['right-child', 2, 'left'], ['right-grandchild', 3, 'right-child'], ['after', 0, null]])
  assert.deepEqual(result[2], blocks[2])
  assert.deepEqual(result[3], { ...blocks[4], depth: 2, parentBlockId: 'left' })
  assert.deepEqual(result[4], { ...blocks[5], depth: 3 })
})

for (const type of ['paragraph', 'heading-3', 'quote']) {
  test(`${type} absorbs a list root while promoting its children and retaining their grandchildren`, () => {
    const blocks = [text('left', 'Alpha', type), item('right'), item('child', 1, 'right'),
      item('grandchild', 2, 'child'), item('other-child', 1, 'right'), text('after')]
    const result = merge(blocks, 0, 1)
    assert.deepEqual(result, [{ ...blocks[0], content: 'Alpharight' }, { ...blocks[2], depth: 0, parentBlockId: null },
      { ...blocks[3], depth: 1 }, { ...blocks[4], depth: 0, parentBlockId: null }, blocks[5]])
  })
}

test('a deepest valid following subtree can reach depth six without losing a level', () => {
  const blocks = [item('outer'), item('middle', 1, 'outer'), item('left', 2, 'middle'), item('right'),
    item('one', 1, 'right'), item('two', 2, 'one'), item('three', 3, 'two'), item('four', 4, 'three'), text('after')]
  const result = merge(blocks, 2, 3)
  assert.deepEqual(shape(result).slice(3, 7), [['one', 3, 'left'], ['two', 4, 'one'], ['three', 5, 'two'], ['four', 6, 'three']])
})

test('forward merge refuses depth overflow rather than silently flattening the following children', () => {
  const blocks = [item('outer'), item('middle', 1, 'outer'), item('left', 2, 'middle'), item('right'),
    item('one', 1, 'right'), item('two', 2, 'one'), item('three', 3, 'two'), item('four', 4, 'three'), item('five', 5, 'four')]
  const snapshot = structuredClone(blocks)
  assert.equal(isDraftTreeContiguous(blocks), true)
  assert.equal(planDraftTextMerge(blocks, 2, 3), null)
  assert.deepEqual(blocks, snapshot)
})

test('source blocks, dividers and unknown block types are boundaries in either direction', () => {
  for (const type of ['code', 'math', 'table', 'html', 'frontmatter', 'divider', 'plugin-source']) {
    assert.equal(planDraftTextMerge([text('left', 'Alpha'), text('right', 'Beta', type)], 0, 1), null, type)
    assert.equal(planDraftTextMerge([text('left', 'Alpha', type), text('right', 'Beta')], 0, 1), null, type)
  }
})

test('merge cannot skip a hidden heading body, a divider, or only part of a child tree', () => {
  assert.equal(planDraftTextMerge([text('heading', 'Title', 'heading-1'), text('hidden-body'), text('next')], 0, 2), null)
  assert.equal(planDraftTextMerge([text('left'), text('divider', '', 'divider'), text('next')], 0, 2), null)
  const blocks = [item('left'), item('first', 1, 'left'), item('grandchild', 2, 'first'), item('last', 1, 'left'), text('next')]
  assert.equal(planDraftTextMerge(blocks, 0, 3), null)
})

test('invalid indices and previously closed parent references leave the document intact', () => {
  const blocks = [text('left'), text('right')]
  for (const [left, right] of [[-1, 1], [0, 0], [1, 0], [0, 2], [0.5, 1], [0, 1.5]]) {
    assert.equal(planDraftTextMerge(blocks, left, right), null)
  }
  const closed = [item('parent'), item('other-root'), item('late-child', 1, 'parent')]
  const snapshot = structuredClone(closed)
  assert.equal(planDraftTextMerge(closed, 0, 1), null)
  assert.deepEqual(closed, snapshot)
})
