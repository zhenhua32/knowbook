import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { syncedCreateSelection, syncedInsertionAfter } from '../src/renderer/src/features/synced-blocks/structureIntent'

const block = (id: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null): SyncedStableBlockDraft =>
  ({ id, type, content: id, depth, parentBlockId, checked: false })

test('synced create intentions include headings in complete consecutive sibling subtrees and refuse nested references, gaps and unknown identities', () => {
  const blocks = [block('parent', 'toggle'), block('child', 'paragraph', 1, 'parent'), block('next'), block('tail')]
  assert.deepEqual(syncedCreateSelection(blocks, ['parent', 'child', 'next']), { ok: true, rootIds: ['parent', 'next'], blockCount: 3 })
  assert.deepEqual(syncedCreateSelection(blocks, ['parent']), { ok: true, rootIds: ['parent'], blockCount: 2 })
  assert.deepEqual(syncedCreateSelection(blocks, ['child', 'next']), { ok: false, reason: 'selection' })
  assert.deepEqual(syncedCreateSelection(blocks, ['parent', 'tail']), { ok: false, reason: 'selection' })
  assert.deepEqual(syncedCreateSelection(blocks, ['absent']), { ok: false, reason: 'selection' })
  assert.deepEqual(syncedCreateSelection(blocks, []), { ok: false, reason: 'selection' })
  assert.deepEqual(syncedCreateSelection([block('parent', 'toggle'), block('heading', 'heading-2', 1, 'parent')], ['parent']), { ok: true, rootIds: ['parent'], blockCount: 2 })
  assert.deepEqual(syncedCreateSelection([block('parent', 'toggle'), block('reference', 'synced-block', 1, 'parent')], ['parent']), { ok: false, reason: 'nested-sync' })
})

test('synced insert intentions use the actual following sibling after a complete subtree and retain exact parent/depth for the last child', () => {
  const blocks = [block('parent', 'toggle'), block('first', 'toggle', 1, 'parent'), block('deep', 'paragraph', 2, 'first'),
    block('last', 'paragraph', 1, 'parent'), block('next')]
  assert.deepEqual(syncedInsertionAfter('host', blocks, 'first'), { documentId: 'host', parentBlockId: 'parent', depth: 1, beforeBlockId: 'last' })
  assert.deepEqual(syncedInsertionAfter('host', blocks, 'last'), { documentId: 'host', parentBlockId: 'parent', depth: 1, beforeBlockId: null })
  assert.deepEqual(syncedInsertionAfter('host', blocks, 'parent'), { documentId: 'host', parentBlockId: null, depth: 0, beforeBlockId: 'next' })
  assert.deepEqual(syncedInsertionAfter('host', blocks, null), { documentId: 'host', parentBlockId: null, depth: 0, beforeBlockId: null })
  assert.equal(syncedInsertionAfter('host', blocks, 'absent'), null)
})
