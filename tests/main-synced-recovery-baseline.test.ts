import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { withV3Fixture, allTables, freshBlock, randomUUID } from './helpers/synced-backup-v3-fixture'
import { readSyncedBaselineMetadataCaptureOwned2 } from '../src/main/database/synced-binding-sources'
import { SYNCED_METADATA_BASELINE2_PREFIX } from '../src/main/database/synced-metadata-capture-record2'

// Implementation tests, not a claimed pre-implementation red: the new private
// adapter and these files are adopted together after independent review.
type Fixture = Parameters<Parameters<typeof withV3Fixture>[0]>[0]
function original(f: Fixture) {
  const sender = Object.freeze({ frame: 'actual initial source capture' })
  const opened = f.store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
  assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw Error('Actual inline opening required')
  const source = f.store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
  assert.equal(source.status, 'ready'); if (source.status !== 'ready') throw Error('Actual initial Source owner required')
  const captured = f.db.transaction(() => readSyncedBaselineMetadataCaptureOwned2(f.db, source.readOwnerId))()
  assert.equal(captured.status, 'captured'); if (captured.status !== 'captured' || !captured.record.pointHash) throw Error('Actual persisted point required')
  return { sender, sessionId: opened.session.sessionId, source, input: { groupId: f.groupId,
    originalKey: SYNCED_METADATA_BASELINE2_PREFIX + captured.record.pointHash, originalRecordHash: captured.record.recordHash } }
}

test('an independent cold Main process reopens the exact original Source point without a fresh SQL capture or old capability reuse', () => withV3Fixture(f => {
  const old = original(f), file = f.file, groupId = f.groupId, hostId = f.hostId, instanceId = f.instanceId
  f.close()
  const output = execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/synced-recovery-baseline-cold.cjs', import.meta.url)), JSON.stringify({
    file, groupId, hostId, instanceId, original: old.input, oldReadOwnerId: old.source.readOwnerId, oldTicketId: old.source.bindingSource.ticketId,
    oldEntryId: old.source.bindingSource.entries[0]?.entryId, keys: old.source.bindingSource.entries.map(item => item.key)
  })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
  const result = JSON.parse(output) as { readOwnerId: string; zeroSql: boolean; originalKey: string; headingBirth: boolean; historyLineage: boolean }
  assert.notEqual(result.readOwnerId, old.source.readOwnerId)
  assert.equal(result.zeroSql, true)
  assert.equal(result.originalKey, old.input.originalKey)
  assert.equal(result.headingBirth, false)
  assert.equal(result.historyLineage, false)
}))

test('a different frame, changed original hash and same-slug new native birth cannot mint a recovery Source or revoke an existing one', () => withV3Fixture(f => {
  const old = original(f), request = { sessionId: old.sessionId, ...old.input }
  const before = allTables(f.db), changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  assert.throws(() => f.store.reopenSyncedRecoveryBaseline(Object.freeze({ frame: 'foreign actual frame' }), request), /recovery frame session/)
  assert.throws(() => f.store.reopenSyncedRecoveryBaseline(old.sender, { ...request, originalRecordHash: '0'.repeat(64) }), /sealed source/)
  assert.deepEqual(allTables(f.db), before)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  assert.equal(f.store.invokeSyncedEditingSession(old.sender, { sessionId: old.sessionId, method: 'validateOwner', input: { readOwnerId: old.source.readOwnerId } }).status, 'ready')
  const target = f.store.getDocumentDetail(f.targetId)!, replacement = randomUUID()
  f.store.updateDocument(target.id, { expectedUpdatedAt: target.updatedAt, title: target.title, summary: target.summary,
    blocks: [{ ...freshBlock(replacement, 'Target heading'), type: 'heading-1' }] })
  assert.notEqual(replacement, f.targetBodyId)
  const changed = allTables(f.db), afterChanges = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  assert.throws(() => f.store.reopenSyncedRecoveryBaseline(old.sender, request), /complete target namespace changed/)
  assert.deepEqual(allTables(f.db), changed)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, afterChanges)
}))
