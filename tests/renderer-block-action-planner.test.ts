import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { blockActionRoots, canConvertBlockActionTargets, planBlockAction } from '../src/renderer/src/utils/documentBlockActions'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'

function fixture(): DocumentBlockDraft[] {
  return [
    { id: 'parent', type: 'todo', content: 'Parent', checked: true, depth: 0, parentBlockId: null, tags: ['tag'],
      highlight: 'blue', markdownFormat: { listMarker: '+', listLoose: true } },
    { id: 'child', type: 'todo', content: 'Child', checked: true, depth: 1, parentBlockId: 'parent' },
    { id: 'leaf', type: 'bulleted-list', content: 'Leaf', checked: false, depth: 2, parentBlockId: 'child' },
    { id: 'other', type: 'paragraph', content: 'Unselected', checked: false, depth: 0, parentBlockId: null }
  ]
}

test('conversion of a collapsed parent preserves hidden child types and promotes their complete subtree', () => {
  const blocks = fixture(), before = structuredClone(blocks)
  const next = planBlockAction(blocks, ['parent'], 'convert', 'heading-2')!
  assert.equal(next[0].type, 'heading-2')
  assert.equal(next[0].checked, false)
  assert.deepEqual(next.slice(1, 3).map(b => [b.id, b.type, b.depth, b.parentBlockId, b.checked]), [
    ['child', 'todo', 0, null, true], ['leaf', 'bulleted-list', 1, 'child', false]
  ])
  assert.equal(validateBlockTreeStructure(next).valid, true)
  assert.deepEqual(blocks, before)
  assert.notEqual(next[0].tags, blocks[0].tags)
  assert.notEqual(next[0].markdownFormat, blocks[0].markdownFormat)
})

test('conversion of explicitly selected parent and child changes both while preserving unselected descendants', () => {
  const next = planBlockAction(fixture(), ['parent', 'child'], 'convert', 'paragraph')!
  assert.deepEqual(next.map(b => [b.id, b.type, b.depth, b.parentBlockId]), [
    ['parent', 'paragraph', 0, null], ['child', 'paragraph', 0, null],
    ['leaf', 'bulleted-list', 0, null], ['other', 'paragraph', 0, null]
  ])
  assert.equal(validateBlockTreeStructure(next).valid, true)
})

test('duplicating overlapping selections copies each complete subtree once with private identities and metadata', () => {
  const blocks = fixture(), before = structuredClone(blocks)
  const next = planBlockAction(blocks, ['child', 'parent'], 'duplicate')!
  assert.deepEqual(blockActionRoots(blocks, ['child', 'parent']), ['parent'])
  assert.deepEqual(next.map(b => b.content), ['Parent', 'Child', 'Leaf', 'Parent', 'Child', 'Leaf', 'Unselected'])
  const copied = next.slice(3, 6)
  assert.equal(new Set(next.map(b => b.id)).size, next.length)
  assert.equal(copied[0].parentBlockId, null)
  assert.equal(copied[1].parentBlockId, copied[0].id)
  assert.equal(copied[2].parentBlockId, copied[1].id)
  assert.deepEqual(copied[0].markdownFormat, blocks[0].markdownFormat)
  assert.deepEqual(copied[0].tags, ['tag'])
  assert.equal(copied[0].checked, true)
  assert.equal(copied[0].highlight, 'blue')
  assert.equal(validateBlockTreeStructure(next).valid, true)
  assert.deepEqual(blocks, before)
})

test('deletion expands subtrees without deleting surrounding unselected blocks and rejects stale identities', () => {
  const blocks = fixture()
  const next = planBlockAction(blocks, ['parent', 'child'], 'delete')!
  assert.deepEqual(next, [{ ...blocks[3], tags: undefined, markdownFormat: undefined }])
  assert.equal(validateBlockTreeStructure(next).valid, true)
  assert.equal(planBlockAction(blocks, ['deleted'], 'delete'), null)
  assert.equal(planBlockAction(blocks, [], 'duplicate'), null)
  assert.equal(planBlockAction([{ ...blocks[0], parentBlockId: 'missing' }], ['parent'], 'delete'), null)
})

test('database atom conversion is rejected for single or mixed selections while atomic duplication and deletion retain normal behavior', () => {
  const content = serializeDatabaseViewPayload({ version: 1, databaseId: 'real-source', viewId: null, config: createDefaultDatabaseViewConfig() })
  const atom: DocumentBlockDraft = { id: 'database-reference', type: 'database-view', content, checked: false, depth: 0, parentBlockId: null }
  const blocks = [atom, fixture()[3]], before = structuredClone(blocks)
  for (const ids of [[atom.id!], [atom.id!, 'other']]) {
    assert.equal(canConvertBlockActionTargets(blocks, ids), false)
    for (const type of ['paragraph', 'heading-1', 'code', 'divider', 'database-view']) assert.equal(planBlockAction(blocks, ids, 'convert', type), null)
  }
  assert.equal(canConvertBlockActionTargets(blocks, ['other']), true)
  assert.equal(planBlockAction(blocks, ['other'], 'convert', 'database-view'), null, 'An ordinary conversion cannot manufacture a database payload')
  const duplicated = planBlockAction(blocks, [atom.id!], 'duplicate')!
  assert.equal(duplicated.length, 3); assert.equal(duplicated[1].type, 'database-view'); assert.equal(duplicated[1].content, content)
  assert.notEqual(duplicated[1].id, atom.id)
  assert.deepEqual(planBlockAction(blocks, [atom.id!], 'delete')!.map(block => block.id), ['other'])
  assert.deepEqual(blocks, before)
})
