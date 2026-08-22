import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts.ts'
import { isNestableBlock, normalizeBlockDepth, toDraftBlock } from '../src/renderer/src/utils/draftBlockShape.ts'
import { serializeDraftBlockRange } from '../src/renderer/src/utils/draftClipboard.ts'
import { materializeDraftFragment, shiftDraftFragmentDepth } from '../src/renderer/src/utils/draftTreeFragment.ts'
import { normalizeDraftBlocks, validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization.ts'
import {
  getBlockDropPreview,
  reparentOrphanedBlocksAfterRangeDeletion,
  resolveDraftBlockRelationship,
  resolveDraftInsertionPlacement
} from '../src/renderer/src/utils/draftTreePlacement.ts'
import {
  getBlockSubtreeEndIndex,
  getFragmentLocalRootIds,
  getNextSiblingSubtreeStartIndex,
  getPreviousSiblingSubtreeStartIndex,
  moveContiguousBlockRange,
  remapIndexAfterSubtreeMove
} from '../src/renderer/src/utils/draftTreeMove.ts'

function block(
  id: string,
  type = 'bulleted-list',
  depth = 0,
  parentBlockId: string | null = null,
  content = id
): DocumentBlockDraft {
  return {
    id,
    type,
    content,
    checked: false,
    depth,
    parentBlockId
  }
}

test('toDraftBlock preserves editable metadata without sharing the tags array', () => {
  const tags = ['important', 'review']
  const draft = toDraftBlock({
    id: 'block-1',
    type: 'todo',
    content: 'Ship release',
    checked: true,
    depth: 9,
    parentBlockId: 'parent',
    tags,
    language: 'typescript',
    highlight: 'yellow'
  })

  assert.deepEqual(draft, {
    id: 'block-1',
    type: 'todo',
    content: 'Ship release',
    checked: true,
    depth: 6,
    parentBlockId: 'parent',
    tags: ['important', 'review'],
    language: 'typescript',
    highlight: 'yellow'
  })
  assert.notEqual(draft.tags, tags)
})

test('block shape helpers clamp nestable depth and flatten other block types', () => {
  assert.equal(isNestableBlock('todo'), true)
  assert.equal(isNestableBlock('paragraph'), false)
  assert.equal(normalizeBlockDepth('numbered-list', -4), 0)
  assert.equal(normalizeBlockDepth('bulleted-list', 9.8), 6)
  assert.equal(normalizeBlockDepth('heading-1', 4), 0)
})

test('normalizeDraftBlocks repairs ids and parent relationships while preserving tags', () => {
  const normalized = normalizeDraftBlocks([
    { ...block('root', 'bulleted-list', 0), tags: ['tag'] },
    block('child', 'todo', 5, 'root'),
    block('child', 'paragraph', 4, 'missing', 'const value = 1'),
    { ...block('', 'code', 0, null, '{"ok":true}'), language: '' }
  ])

  assert.equal(normalized.length, 4)
  assert.equal(normalized[0]?.id, 'root')
  assert.deepEqual(normalized[0]?.tags, ['tag'])
  assert.equal(normalized[1]?.depth, 1)
  assert.equal(normalized[1]?.parentBlockId, 'root')
  assert.notEqual(normalized[2]?.id, 'child')
  assert.equal(normalized[2]?.depth, 0)
  assert.equal(normalized[2]?.parentBlockId, null)
  assert.equal(normalized[3]?.language, 'json')
  assert.equal(validateBlockTreeStructure(normalized).valid, true)
})

test('validateBlockTreeStructure reports duplicate, forward, and invalid non-nestable relationships', () => {
  const result = validateBlockTreeStructure([
    block('duplicate', 'paragraph', 2, 'later'),
    block('duplicate', 'bulleted-list', 7, null),
    block('later', 'paragraph', 0)
  ])

  assert.equal(result.valid, false)
  assert.equal(result.errors.some((error) => error.includes('duplicate ID')), true)
  assert.equal(result.errors.some((error) => error.includes('non-nestable')), true)
  assert.equal(result.errors.some((error) => error.includes('must appear before')), true)
  assert.equal(result.errors.some((error) => error.includes('exceeds maximum')), true)
})

test('relationship and insertion placement prefer an explicit prior parent and expose parent text', () => {
  const relationship = resolveDraftBlockRelationship(
    'todo',
    6,
    'root',
    'child',
    new Map([['root', 0]]),
    ['root']
  )
  assert.deepEqual(relationship, { depth: 1, parentBlockId: 'root' })

  const placement = resolveDraftInsertionPlacement(
    [
      block('root', 'bulleted-list', 0, null, 'A parent with useful context'),
      block('child', 'todo', 1, 'root')
    ],
    2,
    'todo',
    2
  )
  assert.deepEqual(placement, {
    depth: 2,
    parentBlockId: 'child',
    parentText: 'child'
  })
})

test('subtree helpers use parent ids and find adjacent siblings', () => {
  const blocks = [
    block('a'),
    block('a-1', 'todo', 1, 'a'),
    block('a-1-1', 'todo', 2, 'a-1'),
    block('b'),
    block('b-1', 'todo', 1, 'b'),
    block('c')
  ]

  assert.equal(getBlockSubtreeEndIndex(blocks, 0), 2)
  assert.equal(getBlockSubtreeEndIndex(blocks, 3), 4)
  assert.equal(getPreviousSiblingSubtreeStartIndex(blocks, 3), 0)
  assert.equal(getNextSiblingSubtreeStartIndex(blocks, 3), 5)
  assert.equal(getPreviousSiblingSubtreeStartIndex(blocks, 1), null)
})

test('fragment helpers generate fresh ids and retain internal parent relationships', () => {
  const source = [
    block('source-root', 'bulleted-list', 2, 'old-parent'),
    block('source-child', 'todo', 3, 'source-root')
  ]
  const materialized = materializeDraftFragment(source, 'new-parent')

  assert.notEqual(materialized[0]?.id, 'source-root')
  assert.notEqual(materialized[1]?.id, 'source-child')
  assert.equal(materialized[0]?.parentBlockId, 'new-parent')
  assert.equal(materialized[1]?.parentBlockId, materialized[0]?.id)

  const roots = getFragmentLocalRootIds(materialized)
  assert.deepEqual([...roots], [materialized[0]?.id])

  const shifted = shiftDraftFragmentDepth(materialized, -1, 'shallower-parent', roots)
  assert.equal(shifted[0]?.depth, 1)
  assert.equal(shifted[0]?.parentBlockId, 'shallower-parent')
  assert.equal(shifted[1]?.depth, 2)
  assert.equal(shifted[1]?.parentBlockId, materialized[0]?.id)
})

test('contiguous moves and index remapping keep a moved subtree together', () => {
  const blocks = [
    block('a'),
    block('b'),
    block('b-child', 'todo', 1, 'b'),
    block('c'),
    block('d')
  ]
  const moved = moveContiguousBlockRange(blocks, { start: 1, end: 2 }, 4)

  assert.deepEqual(moved.map((item) => item.id), ['a', 'c', 'd', 'b', 'b-child'])
  assert.equal(remapIndexAfterSubtreeMove(1, 1, 2, 3), 3)
  assert.equal(remapIndexAfterSubtreeMove(2, 1, 2, 3), 4)
  assert.equal(remapIndexAfterSubtreeMove(3, 1, 2, 3), 1)
  assert.equal(remapIndexAfterSubtreeMove(null, 1, 2, 3), null)
})

test('drop preview rejects drops into the source subtree and resolves an external target', () => {
  const blocks = [
    block('a'),
    block('a-child', 'todo', 1, 'a'),
    block('b'),
    block('c')
  ]

  assert.equal(getBlockDropPreview(blocks, 0, 1, 1), null)
  assert.deepEqual(getBlockDropPreview(blocks, 0, 3, 0), {
    positionLabel: 'Drop after',
    effectiveDepth: 0,
    parentText: null
  })
})

test('serializeDraftBlockRange covers structured clipboard formats and requested ranges', () => {
  const text = serializeDraftBlockRange([
    block('heading', 'heading-1', 0, null, 'Title'),
    { ...block('todo', 'todo', 1, 'heading', 'Done'), checked: true },
    { ...block('code', 'code', 0, null, 'const ok = true'), language: 'typescript' },
    block('math', 'math', 0, null, 'x^2')
  ], { start: 1, end: 3 })

  assert.equal(text, [
    '  - [x] Done',
    '',
    '```typescript',
    'const ok = true',
    '```',
    '',
    '$$',
    'x^2',
    '$$'
  ].join('\n'))
})

test('range deletion reparents trailing orphans while preserving their relative nesting', () => {
  const blocks = [
    block('a'),
    block('b', 'bulleted-list', 1, 'a'),
    block('c', 'bulleted-list', 1, 'b'),
    block('d', 'bulleted-list', 2, 'c')
  ]

  const result = reparentOrphanedBlocksAfterRangeDeletion(blocks, 0, 1)

  assert.deepEqual(result.map((item) => [item.id, item.depth]), [['c', 0], ['d', 1]])
  assert.equal(result.find((item) => item.id === 'c')?.parentBlockId, null)
  assert.equal(result.find((item) => item.id === 'd')?.parentBlockId, 'c')
})

test('range deletion stops reparenting at the first surviving shallower block', () => {
  const blocks = [
    block('a'),
    block('b', 'bulleted-list', 1, 'a'),
    block('c', 'bulleted-list', 1, 'b'),
    block('d', 'bulleted-list', 2, 'c'),
    block('e'),
    block('f', 'bulleted-list', 1, 'e')
  ]

  const result = reparentOrphanedBlocksAfterRangeDeletion(blocks, 0, 1)

  assert.deepEqual(result.map((item) => [item.id, item.depth]), [['c', 0], ['d', 1], ['e', 0], ['f', 1]])
  assert.equal(result.find((item) => item.id === 'e')?.parentBlockId, null)
  assert.equal(result.find((item) => item.id === 'f')?.parentBlockId, 'e')
})

test('range deletion grafts deep orphans onto the closest surviving ancestor', () => {
  const blocks = [
    block('x'),
    block('y', 'bulleted-list', 1, 'x'),
    block('z', 'bulleted-list', 2, 'y'),
    block('w', 'bulleted-list', 3, 'z')
  ]

  const result = reparentOrphanedBlocksAfterRangeDeletion(blocks, 1, 2)

  assert.equal(result.length, 2)
  assert.equal(result[0]?.id, 'x')
  const orphan = result[1]
  assert.equal(orphan?.id, 'w')
  assert.equal(orphan?.depth, 1)
  assert.equal(orphan?.parentBlockId, 'x')
})

test('range deletion without trailing deeper blocks leaves survivors untouched', () => {
  const blocks = [
    block('a'),
    block('b')
  ]

  assert.deepEqual(
    reparentOrphanedBlocksAfterRangeDeletion(blocks, 0, 0).map((item) => item.id),
    ['b']
  )
})
