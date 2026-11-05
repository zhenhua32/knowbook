import assert from 'node:assert/strict'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { withV3Fixture, allTables, createRequest, freshBlock } from './helpers/synced-backup-v3-fixture'
import { request, snapshot } from './helpers/synced-host-final-fixture'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import type { DocumentDetail } from '../src/shared/contracts'
import type { EditorRecoveryBase, EditorRecoveryPending, EditorRecoveryRecord, EditorRecoveryWorking } from '../src/shared/editor-recovery-drafts'
import { hostHash, hostEqual } from '../src/main/database/synced-host-journal'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { attestEditorRecoveryPendingOwned } from '../src/main/editor-recovery/pending-original'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'

const fields = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
function hostWorking(detail: DocumentDetail): EditorRecoveryWorking {
  return { kind: 'host', title: detail.title, summary: detail.summary, blocks: detail.blocks.map(({ sortOrder: _sort, ...block }) => fields(block)) }
}
function packet(side: EditorRecoveryDraftStore, base: EditorRecoveryBase, pending: EditorRecoveryPending, working = pending.submittedWorking): EditorRecoveryRecord {
  const pointer = side.sealBase(base), expected = side.write([{ base: pointer, draft: {
    draftSessionId: randomUUID(), generation: 1, expectedPreviousGeneration: 0, working, pending: [pending], sources: [],
    selection: null, composing: false, importing: false
  } }], { kind: 'background' }).records[0]
  return side.read(expected)
}
function pending(method: EditorRecoveryPending['method'], input: { clientOperationId: string }, submittedWorking: EditorRecoveryWorking): EditorRecoveryPending {
  const raw = JSON.parse(JSON.stringify(input)) as { clientOperationId: string }
  return { method, clientOperationId: raw.clientOperationId, requestHash: hostHash({ method, input: raw }), inputJson: JSON.stringify(raw), submittedWorking }
}
const boundary = (db: Database.Database) => {
  const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { workspace_scope: string; recovery_epoch: string }
  return { workspaceScope: row.workspace_scope, recoveryEpoch: row.recovery_epoch }
}

test('a genuine pending group submission is attested from its exact original SQL ACK while later C remains only in the durable draft', () => withV3Fixture(f => {
  const side = new EditorRecoveryDraftStore(join(f.root, 'pending-side'))
  try {
    const before = snapshot(f.db, f.groupId), base: EditorRecoveryBase = { ...boundary(f.db), owner: { kind: 'group', groupId: before.groupId,
      creationId: before.creationId, createdAt: before.createdAt, revision: before.revision, topologyRevision: before.topologyRevision, historyCursor: before.history.cursor },
      persistedWorking: { kind: 'group', blocks: syncedCanonicalEdits(before.blocks), incoming: null }, originals: [] }
    const frame = Object.freeze({ realPendingFrame: true }), opened = f.store.openSyncedEditingSession(frame, { kind: 'host', hostDocumentId: f.hostId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw Error('Actual session missing')
    const input = { clientOperationId: randomUUID(), groupId: f.groupId, expectedRevision: before.revision, expectedTopologyRevision: before.topologyRevision,
      expectedInstanceBinding: { instanceId: f.instanceId, hostDocumentId: f.hostId, bindingVersion: before.instances[0].bindingVersion },
      blocks: syncedCanonicalEdits(before.blocks).map(block => ({ ...block, content: block.content + ' submitted A' })) }
    const ack = f.store.invokeSyncedEditingSession(frame, { sessionId: opened.session.sessionId, method: 'updateSyncedBlockGroup', input })
    assert.equal(ack.status, 'saved')
    const submitted: EditorRecoveryWorking = { kind: 'group', blocks: input.blocks, incoming: null }
    const later: EditorRecoveryWorking = { kind: 'group', blocks: input.blocks.map(block => ({ ...block, content: block.content + ' later C' })), incoming: null }
    const record = packet(side, base, pending('updateSyncedBlockGroup', input, submitted), later), sql = allTables(f.db)
    const changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const attested = f.db.transaction(() => attestEditorRecoveryPendingOwned(f.db, record))()[0]
    assert.equal(attested.status, 'committed-attested'); if (attested.status !== 'committed-attested') throw Error('Missing exact original ACK')
    assert.deepEqual(attested.result, ack); assert.deepEqual(attested.submittedWorking, submitted)
    assert.deepEqual(side.read({ recordId: record.recordId, generation: 1, hash: side.head(record.draft.draftSessionId)!.expected.hash }).draft.working, later)
    assert.equal(attested.submittedBinding, 'request-final'); assert.equal(attested.writePermit, false)
    assert.deepEqual(allTables(f.db), sql); assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
    const changed = structuredClone(record), changedInput = JSON.parse(changed.draft.pending[0].inputJson)
    changedInput.blocks[0].content += ' different request'; changed.draft.pending[0] = pending('updateSyncedBlockGroup', changedInput, { kind: 'group', blocks: changedInput.blocks, incoming: null })
    assert.equal(f.db.transaction(() => attestEditorRecoveryPendingOwned(f.db, changed))()[0].status, 'idempotency-mismatch')
    changedInput.clientOperationId = randomUUID(); changed.draft.pending[0] = pending('updateSyncedBlockGroup', changedInput, { kind: 'group', blocks: changedInput.blocks, incoming: null })
    assert.equal(f.db.transaction(() => attestEditorRecoveryPendingOwned(f.db, changed))()[0].status, 'unknown')
    const wrongW = structuredClone(record); if (wrongW.draft.pending[0].submittedWorking.kind !== 'group') throw Error('Expected group')
    wrongW.draft.pending[0].submittedWorking.blocks[0].content += ' not submitted'
    assert.throws(() => f.db.transaction(() => attestEditorRecoveryPendingOwned(f.db, wrongW))(), /submitted group differs/)
    assert.deepEqual(allTables(f.db), sql); assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  } finally { side.close() }
}))

test('a genuine host Source W to A uses the internal host-final hash and binds submitted A without replacing the original logical W or later C', () => withV3Fixture(f => {
  const side = new EditorRecoveryDraftStore(join(f.root, 'pending-host-side'))
  try {
    const detail = f.store.getDocumentDetail(f.hostId)!
    const birth = (f.db.prepare('SELECT created_at FROM documents WHERE id=?').get(f.hostId) as { created_at: string }).created_at
    const base: EditorRecoveryBase = { ...boundary(f.db), owner: { kind: 'host', documentId: f.hostId,
      createdAt: birth, updatedAt: detail.updatedAt }, persistedWorking: hostWorking(detail), originals: [] }
    const frame = Object.freeze({ hostPendingFrame: true }), opened = f.store.openSyncedEditingSession(frame, { kind: 'host', hostDocumentId: f.hostId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw Error('Actual session missing')
    const input = request(f.db, [f.hostId], after => { after[0].blocks.find(block => block.id === f.hostBodyId)!.content += ' submitted Source A' })
    const ack = f.store.invokeSyncedEditingSession(frame, { sessionId: opened.session.sessionId, method: 'applySyncedHostStructure', input })
    assert.equal(ack.status, 'applied')
    const { documentId: _id, ...a } = input.finalAfter[0], submitted: EditorRecoveryWorking = { kind: 'host', ...a }
    const later = structuredClone(submitted); if (later.kind !== 'host') throw Error('Expected host')
    later.blocks.find(block => block.id === f.hostBodyId)!.content += ' later C'
    const record = packet(side, base, pending('applySyncedHostStructure', input, submitted), later), sql = allTables(f.db)
    const changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const attested = f.db.transaction(() => attestEditorRecoveryPendingOwned(f.db, record))()[0]
    assert.equal(attested.status, 'committed-attested'); if (attested.status !== 'committed-attested') throw Error('Actual host original missing')
    assert.notEqual(attested.businessRequestHash, attested.captureRequestHash)
    assert.deepEqual(attested.result, ack); assert.deepEqual(attested.submittedWorking, submitted)
    assert.equal(hostEqual(record.draft.working, submitted), false); assert.equal(attested.submittedBinding, 'request-final')
    assert.equal(attested.sourceReplayComplete, false); assert.equal(attested.writePermit, false)
    const wrong = structuredClone(record); wrong.draft.pending[0].submittedWorking = { kind: 'host', ...input.hostsWorkingBefore[0].workingBefore }
    assert.throws(() => f.db.transaction(() => attestEditorRecoveryPendingOwned(f.db, wrong))(), /submitted host differs/)
    const tamperedHash = structuredClone(record); tamperedHash.draft.pending[0].requestHash = '0'.repeat(64)
    assert.throws(() => f.db.transaction(() => attestEditorRecoveryPendingOwned(f.db, tamperedHash))(), /public invocation capture hash differs/)
    assert.deepEqual(allTables(f.db), sql); assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  } finally { side.close() }
}))

test('real metadata2 and heading metadata3 pending titles select their original business domains and complete companions with no SQL mutation', () => withV3Fixture(f => {
  const side = new EditorRecoveryDraftStore(join(f.root, 'pending-title-side'))
  try {
    for (const domain of ['document', 'heading'] as const) {
      const targetId = f.store.createDocument(null), sourceId = f.store.createDocument(null), targetBlock = randomUUID(), sourceBlock = randomUUID()
      const title = 'Actual pending ' + domain
      f.store.updateDocument(targetId, { title, summary: '', blocks: [{ ...freshBlock(targetBlock, 'Stable'), type: 'heading-1' }] })
      f.store.updateDocument(sourceId, { title: 'Pending source ' + domain, summary: '', blocks: [freshBlock(sourceBlock,
        '[original](' + title.split('/').map(encodeURIComponent).join('/') + '.md' + (domain === 'heading' ? '#stable' : '') + ')')] })
      const frame = Object.freeze({ domain }), source = f.store.openSyncedEditingSession(frame, { kind: 'host', hostDocumentId: sourceId })
      assert.equal(source.status, 'ready'); if (source.status !== 'ready') throw Error('Actual source session missing')
      const create = createRequest(f.db, { documentId: sourceId, selectedRootIds: [sourceBlock] })
      const born = f.store.invokeSyncedEditingSession(frame, { sessionId: source.session.sessionId, method: 'applySyncedHostStructure', input: create })
      assert.equal(born.status, 'applied')
      writeSyncedBackupV3(f.db, { userDataRoot: realpathSync(f.userDataRoot), destination: join(realpathSync(f.root), 'pending-publication-' + domain), snapshotId: randomUUID() })
      const before = f.store.getDocumentDetail(targetId)!
      const birth = (f.db.prepare('SELECT created_at FROM documents WHERE id=?').get(targetId) as { created_at: string }).created_at
      const base: EditorRecoveryBase = { ...boundary(f.db), owner: { kind: 'host', documentId: targetId, createdAt: birth, updatedAt: before.updatedAt },
        persistedWorking: hostWorking(before), originals: [] }
      const target = f.store.openSyncedEditingSession(frame, { kind: 'host', hostDocumentId: targetId })
      assert.equal(target.status, 'ready'); if (target.status !== 'ready') throw Error('Actual target session missing')
      const input = request(f.db, [targetId], after => { after[0].title += ' renamed' })
      const ack = f.store.invokeSyncedEditingSession(frame, { sessionId: target.session.sessionId, method: 'applySyncedHostStructure', input })
      assert.equal(ack.status, 'applied')
      const row = f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as {
        client_operation_id: string; request_hash: string; result_json: string; created_at: string }
      assert.equal(JSON.parse(row.result_json).kind, domain === 'heading' ? 'synced-host-heading-title-metadata3-operation' : 'synced-host-title-metadata2-operation')
      const { documentId: _id, ...a } = input.finalAfter[0]
      const record = packet(side, base, pending('applySyncedHostStructure', input, { kind: 'host', ...a })), sql = allTables(f.db)
      const changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
      const attested = f.db.transaction(() => attestEditorRecoveryPendingOwned(f.db, record))()[0]
      assert.equal(attested.status, 'committed-attested'); if (attested.status !== 'committed-attested') throw Error('Original title not attested')
      assert.deepEqual(attested.result, ack); assert.equal(attested.businessRequestHash, row.request_hash)
      assert.notEqual(attested.captureRequestHash, row.request_hash); assert.equal(attested.sourceReplayComplete, false)
      assert.deepEqual(attested.original, { kind: 'synced-operation', key: row.client_operation_id, requestHash: row.request_hash, resultJson: row.result_json, createdAt: row.created_at })
      assert.deepEqual(allTables(f.db), sql); assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
    }
  } finally { side.close() }
}))
