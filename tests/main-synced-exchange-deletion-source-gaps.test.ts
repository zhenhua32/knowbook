import assert from 'node:assert/strict'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { previewSyncedExchangeDeletions, resolveSyncedExchangeDeletions } from '../src/main/sync/synced-exchange'
import { readSyncedExchangeReceiptById } from '../src/main/database/synced-exchange-receipt'
import { readSyncedPersistentPublicationSnapshot } from '../src/main/database/synced-publication'
import type { SyncedLogicalDeletionChoiceProof } from '../src/main/sync/synced-logical-deletion-choice-model'
import { withDocumentOnlyTombstone, withDeletionChoices, ready, component, choose, completed,
  snapshot, count, randomUUID, runtime, encode, hash, localPortable, missingGroup, hostEdit,
  changeGroup, deleteDocument, deleteGroup, removeGroupReferences, document, allTables } from './helpers/synced-deletion-choice-fixture'

function actualProof(db: Database.Database, operationId: string, key: string) {
  const rows = db.prepare("SELECT * FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%' ORDER BY client_operation_id").all() as Array<{
    client_operation_id: string; request_hash: string; result_json: string; created_at: string
  }>
  const marker = rows.find(row => (JSON.parse(row.result_json) as { key: string }).key === key)
  assert.ok(marker, 'The actual Main transaction persisted its permanent denial marker')
  const proof = JSON.parse(marker.result_json) as SyncedLogicalDeletionChoiceProof
  assert.equal(proof.kind, 'synced-logical-deletion-proof'); assert.equal(proof.version, 2)
  assert.equal(proof.application.operationId, operationId); assert.equal(proof.key, key)
  assert.equal(proof.baseLiveHash, hash(encode(proof.base))); assert.equal(proof.localBeforeHash, hash(encode(proof.before)))
  assert.notEqual(proof.baseLiveHash, proof.localBeforeHash, 'Actual changed L is not relabelled as remote predecessor B')
  assert.equal(marker.result_json, encode(proof)); assert.equal(marker.request_hash, hash(encode({ domain: 'synced.logical-deletion.apply.v2', proof })))
  assert.equal(marker.created_at, proof.application.acceptedAt)
  const anchor = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(proof.persistence.anchorId) as Record<string, unknown> | undefined
  assert.ok(anchor, 'The same genuine commit persisted its independent nondeletable denial anchor')
  assert.equal(anchor.id, marker.client_operation_id); assert.equal(anchor.channel, 'logical-deletion-denial-v1')
  assert.equal(anchor.state, 'possible'); assert.equal(anchor.confirmed_at, null)
  assert.equal(anchor.request_hash, marker.request_hash); assert.equal(anchor.publication_hash, proof.tombstoneHash)
  assert.deepEqual(db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=?').all(anchor.id), [])
  const receipt = db.transaction(() => readSyncedExchangeReceiptById(db, operationId))()
  assert.ok(receipt?.version === 7, 'The strict real historical reader authenticates the original job7 and settled phase chain')
  assert.equal(receipt.provenance.plannerVersion, 'delete-choices-v1')
  assert.deepEqual(receipt.provenance.deletions.find(ref => ref.key === key), { key, intentHash: proof.intentHash, proofHash: hash(marker.result_json), anchorId: proof.persistence.anchorId })
  return { marker, proof, anchor, receipt }
}
function noRawGroups(db: Database.Database) {
  for (const table of ['synced_groups', 'synced_group_lifecycle', 'synced_group_blocks', 'synced_instances', 'synced_group_pins'])
    assert.equal(count(db, table), 0, 'The real group-free peer never invents a group or future publication member')
}

test('a genuine zero-group opaque-NUL document conflict accepts keep-delete as job7 proof2 and reopens with zero-HTTP exact ACK', () => withDocumentOnlyTombstone(async f => {
  noRawGroups(f.S.db); noRawGroups(f.B.db)
  const id = f.ordinaryId, key = 'doc:' + id, originalId = Buffer.from(id, 'utf8')
  assert.ok(id.includes('\0'), 'The actual source document identity has its original NUL and opaque prefix')
  const base = localPortable(f.B).records.find(record => record.kind === 'document' && record.id === id)
  assert.ok(base?.kind === 'document', 'The real initial receiver and common noop own the original document B')
  hostEdit(f.B.db, id, 'Real group-free local edit before explicit deletion')
  const changed = localPortable(f.B).records.find(record => record.kind === 'document' && record.id === id)
  assert.ok(changed?.kind === 'document', 'The actual Main host writer produced the changed physical L')
  assert.notEqual(hash(encode(changed)), hash(encode(base)))
  f.remoteFinal(records => { deleteDocument(records, id) })
  noRawGroups(f.S.db); noRawGroups(f.B.db)
  const p = ready(await f.track(previewSyncedExchangeDeletions(f.B.db, { previewId: randomUUID(), userDataRoot: f.B.root, target: f.targetConfig }, runtime)))
  const c = component(p, key), operationId = randomUUID(), input = { ...f.input(operationId), previewId: p.previewId, decisions: [choose(c, 'keep-delete')] }
  noRawGroups(f.B.db)
  const result = completed(await f.track(resolveSyncedExchangeDeletions(f.B.db, input, runtime)), 'applied')
  assert.ok(result.appliedKeys.includes(key) && result.acceptedKeys.includes(key), 'The true group-free consumer installed and accepted this explicit deletion')
  noRawGroups(f.S.db); noRawGroups(f.B.db)
  assert.equal(count(f.B.db, 'documents', 'id', id), 0); assert.equal(count(f.B.db, 'blocks', 'document_id', id), 0)
  const saved = actualProof(f.B.db, operationId, key)
  assert.deepEqual(saved.proof.base, base); assert.deepEqual(saved.proof.before, changed); assert.deepEqual(saved.proof.deletion, { kind: 'deleted', id })
  for (const value of [saved.proof.base.id, saved.proof.before.id, saved.proof.deletion.id]) assert.deepEqual(Buffer.from(value, 'utf8'), originalId)
  assert.deepEqual(Buffer.from(saved.proof.key.slice(4), 'utf8'), originalId)
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_exposure_attempts WHERE id=?').get(saved.receipt.provenance.attemptId), undefined, 'Zero real groups never create an ordinary zero-member publication attempt')
  assert.deepEqual(f.B.db.pragma('foreign_key_check'), [])
  f.B.db.close(); f.B.db = f.connect(f.B)
  noRawGroups(f.B.db)
  const strict = f.B.db.transaction(() => readSyncedPersistentPublicationSnapshot(f.B.db))()
  assert.ok(strict.deletions?.some(proof => proof.key === key), 'A new connection authenticates permanent absence through the strict Main snapshot reader')
  assert.deepEqual(actualProof(f.B.db, operationId, key), saved)
  const beforeReplay = allTables(f.B.db), requestCount = f.server.requests.length
  assert.deepEqual(await f.track(resolveSyncedExchangeDeletions(f.B.db, input, runtime)), { ...result, replayed: true })
  assert.equal(f.server.requests.length, requestCount); assert.deepEqual(allTables(f.B.db), beforeReplay); noRawGroups(f.B.db)
}))

test('keep-delete applies a complete R host replacement before deleting truly edited G while its original unpinned instance still exists', () => withDeletionChoices(async f => {
  const id = f.groupId, key = 'group:' + id, base = f.remote().records.get(key)
  assert.ok(base?.kind === 'synced-group', 'The tombstone starts from the actual shared complete predecessor B')
  const before = snapshot(f.B.db, id), originalInstanceIds = before.instances.map(row => row.instanceId)
  assert.ok(before.instances.some(row => row.hostDocumentId === f.host), 'Original physical P still authorizes the true Main group edit')
  assert.equal(count(f.B.db, 'synced_group_pins', 'group_id', id), 0); assert.equal(count(f.B.db, 'synced_host_history_documents', 'document_id', f.host), 0)
  assert.equal(changeGroup(f.B.db, id, blocks => { blocks[0].content = 'Actual edited local G while its original host reference remains in P' }).status, 'saved')
  assert.ok(count(f.B.db, 'synced_group_history', 'group_id', id) > 0, 'The real group writer persisted own history without creating or clearing an external pin')
  assert.equal(count(f.B.db, 'synced_group_pins', 'group_id', id), 0)
  assert.deepEqual(snapshot(f.B.db, id).instances.map(row => row.instanceId), originalInstanceIds, 'No local W=A ref removal manufactures this positive case')
  const local = localPortable(f.B).records.find(record => record.kind === 'synced-group' && record.id === id)
  assert.ok(local?.kind === 'synced-group', 'Current L is the actual portable Main capture')
  f.remoteFinal(records => {
    removeGroupReferences(records, id)
    const host = document(records, f.host); host.content.summary = 'Complete remote summary retained alongside explicit G deletion'
    const paragraph = host.content.blocks.find(block => block.type === 'paragraph')
    assert.ok(paragraph, 'Complete R has an ordinary paragraph after real reference removal')
    paragraph.content += '\nRemote ordinary text outside deleted G stays exact.'
    deleteGroup(records, id)
  })
  const remote = f.remote(), remoteHost = remote.records.get('doc:' + f.host)
  assert.ok(remoteHost?.kind === 'document', 'The complete R contains the ordinary host replacement')
  const p = ready(await f.preview()), c = component(p, key), operationId = randomUUID()
  assert.ok(c.keys.includes('doc:' + f.host), 'The actual whole component binds the referenced host and deleted G')
  assert.ok(c.choices.includes('keep-delete'), 'Own content history is not a persistent external group pin')
  const deletionOrder: Array<{ instances: number; referenceBlocks: number }> = []
  f.B.db.function('deletion_gap_order', (instances: number, referenceBlocks: number) => { deletionOrder.push({ instances, referenceBlocks }); return 0 })
  const groupLiteral = "'" + id.replaceAll("'", "''") + "'"
  f.B.db.exec('CREATE TRIGGER deletion_gap_order AFTER DELETE ON synced_group_blocks WHEN OLD.group_id=' + groupLiteral
    + ' BEGIN SELECT deletion_gap_order((SELECT count(*) FROM synced_instances WHERE group_id=OLD.group_id),'
    + "(SELECT count(*) FROM blocks WHERE type='synced-block' AND CASE WHEN json_valid(content) THEN json_extract(content,'$.groupId') ELSE NULL END=OLD.group_id)); END")
  try {
    const result = completed(await f.resolve(p, [choose(c, 'keep-delete')], operationId), 'applied')
    assert.ok(result.appliedKeys.includes(key) && result.appliedKeys.includes('doc:' + f.host), 'The same real transaction applies complete host replacement and G deletion')
  } finally { f.B.db.exec('DROP TRIGGER deletion_gap_order') }
  assert.ok(deletionOrder.length > 0, 'Native SQL witnessed real canonical removal rather than a DTO-only result')
  assert.ok(deletionOrder.every(row => row.instances === 0 && row.referenceBlocks === 0), 'Every canonical DELETE follows removal of actual host refs and exact instances')
  missingGroup(f.B.db, id); assert.equal(count(f.B.db, 'synced_group_blocks', 'group_id', id), 0); assert.equal(count(f.B.db, 'synced_instances', 'group_id', id), 0)
  const saved = actualProof(f.B.db, operationId, key)
  assert.deepEqual(saved.proof.base, base); assert.deepEqual(saved.proof.before, local)
  assert.equal(saved.proof.deletion.kind, 'synced-group-deleted')
  if (saved.proof.deletion.kind !== 'synced-group-deleted') throw new Error('Expected actual group tombstone')
  assert.equal(saved.proof.deletion.previousHash, hash(encode(base))); assert.equal(saved.proof.deletion.creationId, before.creationId)
  for (const effect of saved.proof.identities) {
    assert.deepEqual(effect.after, { kind: 'retained' })
    assert.deepEqual(f.B.db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(effect.before.id), { ...effect.before, state: 'retained' })
  }
  for (const instanceId of originalInstanceIds) assert.equal((f.B.db.prepare('SELECT state FROM block_identities WHERE id=?').get(instanceId) as { state: string }).state, 'retained')
  const actual = localPortable(f.B), expectedPhysicalEntries = Object.fromEntries([...remote.records].filter(([, record]) => record.kind !== 'deleted' && record.kind !== 'synced-group-deleted').map(([key]) => [key, remote.manifest.entries[key]]))
  assert.deepEqual(actual.entries, expectedPhysicalEntries, 'Actual SQL preserves every complete retained R record')
  assert.deepEqual(actual.records.find(record => record.kind === 'document' && record.id === f.host), remoteHost, 'The entire R host including unrelated ordinary text and summary stays exact')
  assert.deepEqual(f.B.db.pragma('foreign_key_check'), [])
}))
