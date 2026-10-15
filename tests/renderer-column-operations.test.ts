import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { validColumnStructure } from '../src/shared/columns'
import { addColumn, appendColumnParagraph, getColumnGroup, insertColumnsAt, moveBlockToColumn, removeColumn, reorderColumn,
  resizeColumnPair, unwrapColumns, wrapBlocksInColumns } from '../src/renderer/src/utils/columnOperations'
import { planBlockAction } from '../src/renderer/src/utils/documentBlockActions'
import { planDraftBlockPaste } from '../src/renderer/src/utils/draftTreePaste'
import { planDraftBlockDepthChange } from '../src/renderer/src/utils/draftTreeDepthChange'
import { areDocumentDraftBlocksEqual } from '../src/renderer/src/utils/documentDraftComparison'

const block = (id: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null, content = id): DocumentBlockDraft =>
  ({ id, type, content, checked: false, depth, parentBlockId })
const column = (id: string, weight: number): DocumentBlockDraft => ({ ...block(id, 'column', 1, 'group', ''), markdownFormat: { columnWeight: weight } })
const fixture = (): DocumentBlockDraft[] => [block('before'), block('group', 'columns', 0, null, ''), column('left', 4000),
  { ...block('task', 'numbered-todo', 2, 'left'), checked: true, listStart: 9, tags: ['keep'], highlight: 'red', markdownFormat: { listMarker: ')' } },
  block('nested', 'todo', 3, 'task'), column('right', 6000), block('right-text', 'paragraph', 2, 'right'), block('after')]
const ids = (blocks: DocumentBlockDraft[]) => blocks.map(block => block.id)
const weights = (blocks: DocumentBlockDraft[]) => getColumnGroup(blocks, 'group')!.columns.map(column => column.weight)

test('explicit empty layout contains exactly two empty columns and no placeholder paragraph', () => {
  const next = insertColumnsAt([], 0)!
  assert.equal(next.length, 3)
  assert.deepEqual(next.map(block => [block.type, block.content, block.depth]), [['columns', '', 0], ['column', '', 1], ['column', '', 1]])
  assert.deepEqual(next.slice(1).map(block => [block.parentBlockId, block.markdownFormat?.columnWeight]), [[next[0].id, 5000], [next[0].id, 5000]])
  assert.ok(validColumnStructure(next, { checkParentIds: true }))
})

test('wrap keeps selected sibling subtrees and metadata while allocating only structural identities', () => {
  const source = [block('one'), { ...block('list', 'numbered-todo'), checked: true, tags: ['tag'], listStart: 4, markdownFormat: { listMarker: ')' as const } },
    block('child', 'todo', 1, 'list'), block('tail')]
  const original = structuredClone(source)
  const next = wrapBlocksInColumns(source, ['one', 'list', 'child'])!
  assert.deepEqual(source, original)
  assert.deepEqual(next.map(block => block.type), ['columns', 'column', 'paragraph', 'numbered-todo', 'todo', 'column', 'paragraph'])
  assert.deepEqual(next.filter(block => ['one', 'list', 'child'].includes(block.id!)).map(block => block.depth), [2, 2, 3])
  assert.equal(next.find(block => block.id === 'child')!.parentBlockId, 'list')
  assert.deepEqual({ ...next.find(block => block.id === 'list'), depth: 0, parentBlockId: null }, source[1])
  assert.equal(next.at(-1), source.at(-1))
})

test('blank insertion can retain the existing host identity and metadata without a fake paragraph', () => {
  const source = [{ ...block('linked-empty', 'paragraph', 0, null, ''), tags: ['tag'], highlight: 'blue' }]
  const next = insertColumnsAt(source, 0, null, 'linked-empty')!
  assert.deepEqual(next.map(block => block.type), ['columns', 'column', 'column'])
  assert.equal(next[0].id, 'linked-empty'); assert.deepEqual(next[0].tags, ['tag']); assert.equal(next[0].highlight, 'blue')
  assert.deepEqual(next.slice(1).map(block => block.parentBlockId), ['linked-empty', 'linked-empty'])
  assert.equal(insertColumnsAt([block('nonempty')], 0, null, 'nonempty'), null)
})

test('wrap rejects gaps, frontmatter, naked columns and any descendant beyond six levels', () => {
  assert.equal(wrapBlocksInColumns([block('a'), block('b'), block('c')], ['a', 'c']), null)
  assert.equal(wrapBlocksInColumns([block('yaml', 'frontmatter')], ['yaml']), null)
  assert.equal(wrapBlocksInColumns(fixture(), ['left']), null)
  const deep = Array.from({ length: 6 }, (_, depth) => block(`d${depth}`, 'todo', depth, depth ? `d${depth - 1}` : null))
  assert.equal(wrapBlocksInColumns(deep, ['d0']), null)
})

test('adding a column conserves total width and the full authored forest through the six-column limit', () => {
  const source = fixture(), original = structuredClone(source)
  let next = source
  for (let count = 3; count <= 6; count++) {
    next = addColumn(next, 'group', 'left')!
    assert.equal(getColumnGroup(next, 'group')!.columns.length, count)
    assert.equal(weights(next).reduce((sum, value) => sum + value), 10_000)
    assert.equal(next.find(block => block.id === 'task'), source.find(block => block.id === 'task'))
  }
  assert.equal(addColumn(next, 'group'), null)
  assert.deepEqual(source, original)
})

test('removing first or last column preserves content in document order and merges width', () => {
  for (const id of ['left', 'right']) {
    const source = fixture(), next = removeColumn(source, id)!
    assert.deepEqual(ids(next), ['before', 'group', id === 'left' ? 'right' : 'left', 'task', 'nested', 'right-text', 'after'])
    assert.deepEqual(weights(next), [10_000])
    assert.equal(next.find(block => block.id === 'nested')!.parentBlockId, 'task')
    assert.equal(next.find(block => block.id === 'task')!.checked, true)
    assert.equal(removeColumn(next, id === 'left' ? 'right' : 'left'), null)
  }
})

test('column reorder moves each complete subtree and its width without changing identities', () => {
  const source = fixture(), next = reorderColumn(source, 'right', 0)!
  assert.deepEqual(ids(next), ['before', 'group', 'right', 'right-text', 'left', 'task', 'nested', 'after'])
  assert.deepEqual(weights(next), [6000, 4000])
  assert.deepEqual(reorderColumn(next, 'right', 1), source)
  assert.equal(reorderColumn(source, 'left', 0), null)
  assert.equal(reorderColumn(source, 'left', 2), null)
})

test('adjacent resize preserves pair sum exactly and refuses invalid or unchanged ratios', () => {
  const source = addColumn(fixture(), 'group')!, before = weights(source)
  const next = resizeColumnPair(source, 'left', 1234)!
  assert.deepEqual(weights(next), [1234, before[0] + before[1] - 1234, before[2]])
  for (const value of [0, -1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, before[0], before[0] + before[1]]) {
    assert.equal(resizeColumnPair(source, 'left', value), null)
  }
  assert.equal(resizeColumnPair(fixture(), 'right', 4000), null)
})

test('a width-only change participates in document dirty comparison and returns equal after inverse resize', () => {
  const source = fixture(), resized = resizeColumnPair(source, 'left', 3500)!
  assert.equal(areDocumentDraftBlocksEqual(source, resized), false)
  assert.equal(areDocumentDraftBlocksEqual(source, resizeColumnPair(resized, 'left', 4000)!), true)
})

test('cross-column move transports one complete mixed subtree and retains local descendant ownership', () => {
  const source = fixture(), next = moveBlockToColumn(source, 'task', 'right', 'right-text')!
  assert.deepEqual(ids(next), ['before', 'group', 'left', 'right', 'task', 'nested', 'right-text', 'after'])
  assert.equal(next.find(block => block.id === 'task')!.parentBlockId, 'right')
  assert.equal(next.find(block => block.id === 'nested')!.parentBlockId, 'task')
  assert.deepEqual({ ...next.find(block => block.id === 'task'), parentBlockId: 'left' }, source[3])
  assert.deepEqual(weights(next), [4000, 6000])
  assert.equal(moveBlockToColumn(source, 'right-text', 'right'), null)
})

test('cross-column move rejects cycles, naked structure roles and a destination at maximum depth', () => {
  assert.equal(moveBlockToColumn(fixture(), 'group', 'left'), null)
  assert.equal(moveBlockToColumn(fixture(), 'left', 'right'), null)
  assert.equal(moveBlockToColumn(fixture(), 'task', 'right', 'after'), null)
  const roots = [block('a0', 'toggle', 0), block('a1', 'toggle', 1, 'a0'), block('a2', 'toggle', 2, 'a1'),
    block('a3', 'toggle', 3, 'a2'), block('a4', 'toggle', 4, 'a3')]
  const deep = insertColumnsAt(roots, roots.length, 'a4')!
  const col = deep.find(block => block.type === 'column')!
  assert.equal(appendColumnParagraph(deep, col.id!), null)
  assert.equal(moveBlockToColumn([...deep, block('tail')], 'tail', col.id!), null)
})

test('unwrap restores content depth and metadata in column order without creating content for empty columns', () => {
  const next = unwrapColumns(fixture(), 'group')!
  assert.deepEqual(ids(next), ['before', 'task', 'nested', 'right-text', 'after'])
  assert.deepEqual(next.map(block => [block.depth, block.parentBlockId]), [[0, null], [0, null], [1, 'task'], [0, null], [0, null]])
  const empty = insertColumnsAt([], 0)!
  assert.deepEqual(unwrapColumns(empty, empty[0].id!), [])
})

test('explicit add-content action creates one real paragraph in the selected column', () => {
  const source = fixture(), next = appendColumnParagraph(source, 'right')!
  assert.equal(next.length, source.length + 1)
  const child = next.at(-2)!
  assert.equal(child.type, 'paragraph'); assert.equal(child.content, ''); assert.equal(child.parentBlockId, 'right'); assert.equal(child.depth, 2)
  assert.ok(child.id && !source.some(block => block.id === child.id))
})

test('damaged input never becomes a silent normalized layout', () => {
  const malformed = fixture().map(block => block.id === 'left' ? { ...block, markdownFormat: { columnWeight: 9999 } } : block)
  assert.equal(getColumnGroup(malformed, 'group'), null)
  assert.equal(addColumn(malformed, 'group'), null)
  assert.equal(unwrapColumns(malformed, 'group'), null)
  assert.equal(resizeColumnPair(malformed, 'left', 4000), null)
})

test('ordinary block operations reject partial structural edits but allow deleting complete groups', () => {
  const source = fixture()
  assert.equal(planBlockAction(source, ['left'], 'delete'), null)
  assert.equal(planBlockAction(source, ['left'], 'convert', 'paragraph'), null)
  assert.equal(planBlockAction(source, ['left'], 'duplicate'), null)
  assert.deepEqual(ids(planBlockAction(source, ['group'], 'delete')!), ['before', 'after'])
  assert.equal(planDraftBlockDepthChange(source, { start: 2, end: 4 }, -1), null)
})

test('pasting mixed content into a column keeps the existing source identity and column ownership', () => {
  const source = fixture()
  const next = planDraftBlockPaste(source, { start: 6, end: 6 }, [block('fresh', 'heading-2', 2, 'right', 'Pasted heading')], true)!
  assert.equal(next.blocks[6].id, 'right-text')
  assert.equal(next.blocks[6].parentBlockId, 'right')
  assert.ok(validColumnStructure(next.blocks, { checkParentIds: true }))
})
