import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { updateSyncedBlockGroup } from '../../src/main/database/synced-blocks-content'
import { syncedCanonicalEdits } from '../../src/shared/syncedBlockValidation'
import { applySyncedHostCommand, applySyncedHostFinal, createRequest, request, snapshot, type V3Fixture } from './synced-backup-v3-fixture'

/** Reserve the actual list placement with normal Main writers. The durable
 * group and both documents are then opened by the caller's own session. */
export function seedHotNestedCrossMove(fixture: V3Fixture, targetParentDepth = 0, forest?: 'single-reference' | 'two-references') {
  const { db, store, hostId, targetId, groupId, instanceId, hostBodyId } = fixture
  const original = snapshot(db, groupId), occurrence = original.instances[0]
  const edited = updateSyncedBlockGroup(db, { groupId, clientOperationId: randomUUID(), expectedRevision: original.revision,
    expectedTopologyRevision: original.topologyRevision, expectedInstanceBinding: { instanceId, hostDocumentId: hostId, bindingVersion: occurrence.bindingVersion },
    blocks: syncedCanonicalEdits(original.blocks).map(block => ({ ...block, type: 'bulleted-list' })) })
  assert.equal(edited.status, 'saved')
  const childId = forest && randomUUID(), outsideId = forest && randomUUID()
  const extraId = forest === 'two-references' ? randomUUID() : undefined
  const nested = request(db, [hostId], ([after]) => {
    after.blocks.find(block => block.id === hostBodyId)!.type = 'bulleted-list'
    const leaf = after.blocks.find(block => block.id === instanceId)!
    leaf.parentBlockId = hostBodyId
    leaf.depth = 1
    if (childId && outsideId) {
      after.blocks.push({ id: childId, type: 'bulleted-list', content: 'Ordinary moved child', checked: false, depth: 1, parentBlockId: hostBodyId })
      if (extraId) after.blocks.push({ id: extraId, type: 'bulleted-list', content: 'Second shared original', checked: false, depth: 1, parentBlockId: hostBodyId })
      after.blocks.push({ id: outsideId, type: 'paragraph', content: 'Ordinary source tail', checked: false, depth: 0, parentBlockId: null })
    }
  })
  assert.equal(applySyncedHostFinal(db, nested).status, 'applied')
  const second = extraId && createRequest(db, { documentId: hostId, selectedRootIds: [extraId] })
  if (second) assert.equal(applySyncedHostCommand(db, second).status, 'applied')
  const destination = store.getDocumentDetail(targetId)!
  const parents = Array.from({ length: targetParentDepth + 1 }, (_, depth) => ({ id: randomUUID(), type: 'bulleted-list' as const,
    content: depth === targetParentDepth ? 'Receiving list item' : `Parent list ${depth}`, checked: false, depth, parentBlockId: null as string | null }))
  for (let index = 1; index < parents.length; index++) parents[index].parentBlockId = parents[index - 1].id
  store.updateDocument(targetId, { title: destination.title, summary: destination.summary, blocks: [...destination.blocks, ...parents] })
  return { sourceParentId: hostBodyId, targetParentId: parents.at(-1)!.id, targetDepth: targetParentDepth + 1,
    forest: childId && outsideId ? { childId, outsideId, otherReferenceId: second ? second.action.instanceId : undefined } : undefined }
}
