import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { captureActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { serializeSyncedBlockPayload } from '../../src/shared/syncedBlockValidation'
import { captureMixedSource } from './mixed-required-source-fixture'
import { command, insertAck } from './synced-host-command-insert-fixture'
import { withV3Fixture, allTables, randomUUID, createRequest, created, freshBlock, applySyncedHostCommand,
  snapshot, type V3Fixture } from './synced-backup-v3-fixture'

function createCollisionGroup(f: V3Fixture, ids: { groupId: string; rootId: string; childId: string; instanceId: string }, side: 'source' | 'current') {
  const input = createRequest(f.db, { documentId: f.hostId, groupId: ids.groupId, instanceId: ids.instanceId,
    selectedRootIds: [ids.rootId], dirty(working) {
      working.blocks.push({ ...freshBlock(ids.rootId, side + ' canonical root'), type: 'callout' },
        { ...freshBlock(ids.childId, '[' + side + ' target](/V3%20Target.md#^' + f.targetBodyId + ')'),
          depth: 1, parentBlockId: ids.rootId })
    } })
  const ack = created(applySyncedHostCommand(f.db, input))
  return { input, ack }
}
async function setup(source: V3Fixture, current: V3Fixture) {
  const ids = { groupId: randomUUID(), rootId: randomUUID(), childId: randomUUID(), instanceId: randomUUID() }
  const leftCreate = createCollisionGroup(source, ids, 'source')
  const freeInstanceId = randomUUID(), insertion = command(source.db, { documentId: source.hostId,
    groupId: ids.groupId, instanceId: freeInstanceId })
  insertAck(applySyncedHostCommand(source.db, insertion))
  // Distinct births come from actual Main clocks, not edited SQL or fabricated
  // lifecycle/ACK rows. The second Store creates the same IDs independently.
  await delay(2)
  const rightCreate = createCollisionGroup(current, ids, 'current')
  assert.notEqual(leftCreate.ack.createdLifecycle.creationId, rightCreate.ack.createdLifecycle.creationId)
  assert.notEqual(leftCreate.ack.createdLifecycle.createdAt, rightCreate.ack.createdLifecycle.createdAt)
  assert.equal(current.db.prepare('SELECT 1 FROM blocks WHERE id=?').get(freeInstanceId), undefined)
  assert.equal(current.db.prepare('SELECT 1 FROM synced_instances WHERE instance_id=?').get(freeInstanceId), undefined)
  const sourceGroup = snapshot(source.db, ids.groupId), currentGroup = snapshot(current.db, ids.groupId)
  assert.notEqual(sourceGroup.blocks.find(block => block.id === ids.childId)!.createdAt,
    currentGroup.blocks.find(block => block.id === ids.childId)!.createdAt)
  const sourceFirstBirth = (source.db.prepare('SELECT created_at FROM blocks WHERE id=?').get(ids.instanceId) as { created_at: string }).created_at
  const currentFirstBirth = (current.db.prepare('SELECT created_at FROM blocks WHERE id=?').get(ids.instanceId) as { created_at: string }).created_at
  assert.notEqual(sourceFirstBirth, currentFirstBirth)
  const currentRaw = current.db.prepare('SELECT origin_json,bindings_json FROM synced_groups WHERE id=?').get(ids.groupId) as {
    origin_json: string; bindings_json: string
  }
  const longTitle = '源'.repeat(501), target = source.store.getDocumentDetail(source.targetId)
  assert.ok(target)
  assert.equal(target.blocks.some(block => block.type === 'synced-block'), false)
  const targetBlockIds = target.blocks.map(block => block.id)
  source.store.updateDocument(source.targetId, { title: longTitle, summary: target.summary, blocks: target.blocks })
  assert.deepEqual(source.store.getDocumentDetail(source.targetId)!.blocks.map(block => block.id), targetBlockIds)
  const template = source.store.saveDocumentTemplate({ name: 'Reference policy synced template', title: 'Saved local draft',
    summary: 'Local template references stay deferred', blocks: [{ ...freshBlock(ids.childId,
      serializeSyncedBlockPayload({ version: 1, groupId: ids.groupId })), type: 'synced-block' }] })
  const left = await captureMixedSource(source, 2)
  // Use the same immutable-original catalog, while retaining the independent
  // current Store and its real births. No fixture asset needs a second root.
  const right = await captureMixedSource({ ...current, userDataRoot: source.userDataRoot }, 2)
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
    operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  const captured = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: current.userDataRoot,
    operationId: randomUUID(), sourceDirectory: exported.directory })
  return { source, current, ids, freeInstanceId, leftCreate, rightCreate, sourceGroup, currentGroup,
    sourceFirstBirth, currentFirstBirth, currentRaw, longTitle, template, targetBlockIds, captured,
    beforeSource: allTables(source.db), beforeCurrent: allTables(current.db) }
}

/** Two independent real Stores and real Main create/insert writers. Neither
 * group tuple, operation receipt, birth, ledger nor K fact is synthesized. */
export async function withReference3PolicyForkFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  await withV3Fixture(source => withV3Fixture(async current => run(await setup(source, current))))
}
