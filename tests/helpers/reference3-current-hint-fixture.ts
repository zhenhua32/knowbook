import assert from 'node:assert/strict'
import { basename } from 'node:path'
import type { DocumentBlockDraft } from '../../src/shared/contracts'
import { captureActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { captureMixedSource } from './mixed-required-source-fixture'
import { command, insertAck } from './synced-host-command-insert-fixture'
import { withV3Fixture, allTables, randomUUID, createRequest, created, applySyncedHostCommand,
  snapshot, type V3Fixture } from './synced-backup-v3-fixture'

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null })
function document(f: V3Fixture, title: string, blocks: DocumentBlockDraft[]) {
  const id = f.store.createDocument(null)
  f.store.updateDocument(id, { title, summary: '', blocks })
  return id
}
async function setup(source: V3Fixture, receiver: V3Fixture, phase: (name: string) => void) {
  const target = source.store.getDocumentDetail(source.targetId)!
  const originalBlocks = structuredClone(target.blocks), targetId = source.targetId, blockId = source.targetBodyId
  const birth = (source.db.prepare('SELECT created_at FROM blocks WHERE id=?').get(blockId) as { created_at: string }).created_at
  const left = await captureMixedSource(source, 2)
  phase('source-captured-with-live-block')

  // Real ordinary Store deletion retains the exact global owner/birth.
  source.store.updateDocument(targetId, { title: target.title, summary: target.summary,
    blocks: originalBlocks.filter(block => block.id !== blockId) })
  assert.equal(source.db.prepare('SELECT 1 FROM blocks WHERE id=?').get(blockId), undefined)
  const retained = source.db.prepare('SELECT last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(blockId) as {
    last_owner_kind: string; last_owner_id: string; state: string; created_at: string
  }
  assert.deepEqual(retained, { last_owner_kind: 'document', last_owner_id: targetId, state: 'retained', created_at: birth })
  const definitionId = randomUUID(), url = '/V3%20Target.md#^' + blockId, definition = '[ref]: ' + url
  const definitionHostId = document(source, 'Current Hint Definition Owner', [paragraph(definitionId, definition)])
  const create = createRequest(source.db, { documentId: definitionHostId, selectedRootIds: [definitionId] })
  created(applySyncedHostCommand(source.db, create))
  const missingGroup = snapshot(source.db, create.action.groupId)
  const missingBinding = missingGroup.bindings.find(binding => binding.blockId === definitionId)!
  assert.ok(missingBinding)
  assert.deepEqual(missingBinding.target, { kind: 'block', id: blockId, documentId: targetId, state: 'missing' })
  phase('current-captured-real-missing-binding')

  // Restore through the real Store. It uses retained created_at at store.ts's
  // insert, without modifying an ACK, group binding hint, ledger or SQL birth.
  source.store.updateDocument(targetId, { title: target.title, summary: target.summary, blocks: originalBlocks })
  const restoredBirth = (source.db.prepare('SELECT created_at FROM blocks WHERE id=?').get(blockId) as { created_at: string }).created_at
  assert.equal(restoredBirth, birth)
  const live = source.db.prepare('SELECT last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(blockId) as typeof retained
  assert.deepEqual(live, { last_owner_kind: 'document', last_owner_id: targetId, state: 'live', created_at: birth })
  assert.deepEqual(snapshot(source.db, create.action.groupId).bindings, missingGroup.bindings,
    'The captured missing state remains a legal stale hint after same-owner same-birth restoration')
  phase('current-block-restored-with-original-birth')

  // The independent consumer is necessary: create in a document that already
  // contains the use would prepend a host-survivor definition. Insert instead
  // makes the real canonical definition win in this separate host E.
  const useId = randomUUID(), fallbackId = randomUUID(), use = '[use][ref]'
  const consumerHostId = document(source, 'Current Hint Consumer', [paragraph(useId, use),
    paragraph(fallbackId, '[ref]: https://example.invalid/fallback')])
  const insertion = command(source.db, { documentId: consumerHostId, groupId: create.action.groupId,
    target: { beforeBlockId: useId } })
  insertAck(applySyncedHostCommand(source.db, insertion))
  assert.deepEqual(snapshot(source.db, create.action.groupId).bindings, missingGroup.bindings)
  const right = await captureMixedSource(source, 2)
  phase('current-captured-with-live-block-and-stale-binding-hint')
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
    operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  const captured = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot,
    operationId: randomUUID(), sourceDirectory: exported.directory })
  phase('knowledge-captured')
  return { source, receiver, captured, targetId, blockId, birth, restoredBirth, groupId: create.action.groupId,
    definitionHostId, definitionId, definition, url, missingBinding, consumerHostId, useId, use,
    beforeSource: allTables(source.db), beforeReceiver: allTables(receiver.db) }
}

/** Independent real Main regression fixture; only ordinary and sync writers
 * create/delete/restore content. Source B stays live in the immutable source. */
export async function withReference3CurrentHintFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>, phase: (name: string) => void = () => {}) {
  await withV3Fixture(source => withV3Fixture(async receiver => run(await setup(source, receiver, phase))))
}
