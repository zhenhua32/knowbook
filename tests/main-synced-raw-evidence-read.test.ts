import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import type { SyncedPublicationCapture } from '../src/main/database/synced-publication'
import type { PublicationDescriptor } from '../src/main/sync/synced-publication-model'
import { SyncedPublicationError, publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { initialIncomingBaselineKey, type InitialIncomingRequest } from '../src/main/sync/synced-initial-incoming-model'
import { SyncedValidationError } from '../src/shared/syncedBlockValidation'
import { readRawSyncedGroupSnapshotsOwned, readRawSyncedWorkspaceScopeOwned } from '../src/main/database/synced-blocks-raw-read'
import { readRawSyncedPersistentPublicationSnapshotOwned } from '../src/main/database/synced-publication-raw-read'
import { readRawInitialIncomingWorkspaceOwned } from '../src/main/database/synced-initial-incoming-raw-read'
import { readInitialIncomingWorkspace, readInitialIncomingLocal } from '../src/main/database/synced-initial-incoming-read'
import { assertSyncedLifecycleSchemaMetadata } from '../src/main/database/synced-lifecycle-schema-metadata'
import { assertSyncedLifecycleSchema } from '../src/main/database/synced-lifecycle-schema'
import { getSyncedGroupSnapshots } from '../src/main/database/synced-blocks-read'
import { bindSyncedPublicationCapture, captureSyncedPublicationSnapshot, readSyncedPersistentPublicationSnapshot,
  readSyncedPublicationCapture } from '../src/main/database/synced-publication'
import { RECOVERY_BOUNDARY_CHANNEL, RECOVERY_EPOCH_PREFIX } from '../src/main/database/synced-recovery-boundary-model'
import { withDatabase, groupId } from './helpers/synced-content-fixture'
import { withV3Fixture, allTables, request, applied, applySyncedHostFinal } from './helpers/synced-backup-v3-fixture'

test('raw original-snapshot readers require their real owned connection transaction and cannot mint publication captures', async () => withV3Fixture(f => {
  const before = allTables(f.db)
  assert.throws(() => readRawSyncedGroupSnapshotsOwned(f.db, [f.groupId]), /事务/)
  assert.throws(() => readRawSyncedWorkspaceScopeOwned(f.db), /事务/)
  assert.throws(() => readRawSyncedPersistentPublicationSnapshotOwned(f.db), /事务/)
  assert.throws(() => readRawInitialIncomingWorkspaceOwned(f.db), /事务/)
  const facts = f.db.transaction(() => readRawSyncedPersistentPublicationSnapshotOwned(f.db))()
  assert.equal(readSyncedPublicationCapture(facts as unknown as SyncedPublicationCapture), null)
  assert.throws(() => bindSyncedPublicationCapture(f.db, facts as unknown as SyncedPublicationCapture,
    { attemptId: randomUUID(), descriptor: {} as PublicationDescriptor }),
  (error: unknown) => error instanceof SyncedPublicationError && error.code === 'unavailable',
  'A caller can serialize genuine raw facts, but cannot turn them into a Main-owned capture or claim')
  assert.deepEqual(allTables(f.db), before)
}))

test('real Main-created raw group and complete persistent snapshots retain public wire order and fingerprint without SQL writes', async () => withV3Fixture(f => {
  const before = allTables(f.db), missing = randomUUID()
  const publicGroups = getSyncedGroupSnapshots(f.db, { groupIds: [missing, f.groupId] })
  f.db.transaction(() => {
    const rawGroups = readRawSyncedGroupSnapshotsOwned(f.db, [missing, f.groupId])
    assert.equal(rawGroups.has(missing), false)
    assert.equal(readRawSyncedWorkspaceScopeOwned(f.db), publicGroups.workspaceScope)
    const ready = publicGroups.items[1]
    assert.equal(ready.status, 'ready')
    if (ready.status !== 'ready') throw new Error('The actual Main-created group must be ready')
    assert.deepEqual(rawGroups.get(f.groupId), ready.snapshot)
    const raw = readRawSyncedPersistentPublicationSnapshotOwned(f.db)
    const effective = readSyncedPersistentPublicationSnapshot(f.db)
    assert.equal(publicationJson(raw), publicationJson(effective), 'The complete persistent wire and literal fingerprint remain identical')
    assert.ok(raw.records.some(record => record.kind === 'document' && record.id === f.hostId))
    assert.ok(raw.groups.some(group => group.wire.id === f.groupId))
  })()
  assert.deepEqual(allTables(f.db), before)
}))

test('raw schema26 group evidence remains readable without querying or installing a schema27 namespace', () => withDatabase(db => {
  db.pragma('user_version=26')
  const definitions = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()
  const publicGroups = getSyncedGroupSnapshots(db, { groupIds: [groupId] })
  db.transaction(() => {
    const ready = publicGroups.items[0]
    assert.equal(ready.status, 'ready')
    if (ready.status !== 'ready') throw new Error('The original schema26 fixture has a real group')
    assert.deepEqual(readRawSyncedGroupSnapshotsOwned(db, [groupId]).get(groupId), ready.snapshot)
    assert.equal(readRawSyncedWorkspaceScopeOwned(db), publicGroups.workspaceScope)
  })()
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), definitions)
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='synced_exposure_attempts'").get(), undefined)
  assert.deepEqual(captureSyncedPublicationSnapshot(db), { status: 'unsupported', reason: 'schema-27-required' })
}))

test('an orphan recovery anchor is raw semantic evidence only while public group publication and full startup admission still reject it', async () => withV3Fixture(f => {
  const original = f.db.transaction(() => readRawSyncedPersistentPublicationSnapshotOwned(f.db))()
  const stamp = '2041-01-01T00:00:00.000Z'
  f.db.prepare(`INSERT INTO synced_exposure_attempts
    (id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at)
    VALUES(?,?,?,?,?,'possible',?,NULL)`).run(RECOVERY_EPOCH_PREFIX + randomUUID(), '1'.repeat(64),
    RECOVERY_BOUNDARY_CHANNEL, '2'.repeat(64), '3'.repeat(64), stamp)
  const before = allTables(f.db)
  f.db.transaction(() => {
    assertSyncedLifecycleSchemaMetadata(f.db)
    assert.deepEqual(readRawSyncedPersistentPublicationSnapshotOwned(f.db), original,
      'A semantic projection does not certify unrelated original evidence or create an admission permit')
    assert.deepEqual(readRawInitialIncomingWorkspaceOwned(f.db).snapshot, original)
    assert.throws(() => readSyncedPersistentPublicationSnapshot(f.db), /恢复历史边界|boundary/)
    assert.throws(() => readInitialIncomingWorkspace(f.db), /恢复历史边界|boundary/)
  })()
  assert.throws(() => getSyncedGroupSnapshots(f.db, { groupIds: [f.groupId] }), /恢复历史边界|boundary/)
  assert.throws(() => captureSyncedPublicationSnapshot(f.db), error => error instanceof SyncedPublicationError)
  assert.throws(() => assertSyncedLifecycleSchema(f.db), /恢复历史边界|boundary/)
  assert.deepEqual(allTables(f.db), before, 'Neither the raw read nor failed public admission repairs or deletes the orphan')
}))

test('raw evidence keeps reverse physical-owner closure instead of silently dropping a missing canonical row', async () => withV3Fixture(f => {
  const trigger = f.db.prepare("SELECT sql FROM sqlite_master WHERE name='trg_synced_synced_group_blocks_identity_delete'").get() as { sql: string }
  assert.ok(trigger?.sql, 'The original canonical-delete identity trigger is captured exactly')
  f.db.exec('DROP TRIGGER trg_synced_synced_group_blocks_identity_delete')
  f.db.prepare('DELETE FROM synced_group_blocks WHERE group_id=?').run(f.groupId)
  f.db.exec(trigger.sql)
  const before = allTables(f.db)
  const identityFailure = (error: unknown) => error instanceof SyncedValidationError && error.code === 'identity'
  f.db.transaction(() => {
    assertSyncedLifecycleSchemaMetadata(f.db)
    assert.throws(() => readRawSyncedGroupSnapshotsOwned(f.db, [f.groupId]), identityFailure)
    assert.throws(() => readRawSyncedPersistentPublicationSnapshotOwned(f.db), identityFailure)
  })()
  assert.throws(() => getSyncedGroupSnapshots(f.db, { groupIds: [f.groupId] }), identityFailure)
  assert.deepEqual(allTables(f.db), before)
}))

test('a later real Main host write changes raw evidence on every read while a mutated prior DTO cannot alter SQLite facts', async () => withV3Fixture(f => {
  const connection = f.connect()
  const first = connection.transaction(() => readRawSyncedPersistentPublicationSnapshotOwned(connection))()
  const original = publicationJson(first)
  first.records.length = 0
  first.groups[0].wire.blocks[0].content = 'caller-mutated diagnostic facts'
  assert.equal(publicationJson(connection.transaction(() => readRawSyncedPersistentPublicationSnapshotOwned(connection))()), original)
  const edit = request(f.db, [f.hostId], sides => {
    const block = sides[0].blocks.find(item => item.id === f.hostBodyId)
    assert.ok(block, 'The real host contains an ordinary paragraph edited through Main')
    block.content += ' changed after evidence read'
  })
  applied(applySyncedHostFinal(f.db, edit))
  const after = allTables(f.db)
  const second = connection.transaction(() => readRawSyncedPersistentPublicationSnapshotOwned(connection))()
  assert.notEqual(second.localFingerprint, JSON.parse(original).localFingerprint)
  assert.deepEqual(second, f.db.transaction(() => readSyncedPersistentPublicationSnapshot(f.db))())
  assert.deepEqual(allTables(f.db), after, 'Reading the newer committed original snapshot remains read-only')
}))

test('raw incoming history preserves literal public fingerprint preimages and never treats a request baseline as original workspace knowledge', async () => withV3Fixture(f => {
  const request: InitialIncomingRequest = { method: 'receiveInitialSyncedSnapshot', operationId: randomUUID(),
    databasePath: f.file, targetFingerprint: '4'.repeat(64) }
  const before = allTables(f.db)
  const raw = f.db.transaction(() => {
    const raw = readRawInitialIncomingWorkspaceOwned(f.db)
    assert.ok(raw.historyBlocks.size > 0 && raw.historyDocuments.has(f.hostId),
      'The genuine Main create journal contributes retained identities and participating documents')
    const workspace = readInitialIncomingWorkspace(f.db), local = readInitialIncomingLocal(f.db, request)
    assert.equal(workspace.fingerprint, publicationHash(publicationJson({ snapshot: raw.snapshot.localFingerprint,
      rawIdentities: raw.rawIdentities, historyRows: raw.historyRows })))
    assert.equal(local.fingerprint, publicationHash(publicationJson({ snapshot: raw.snapshot.localFingerprint,
      rawIdentities: raw.rawIdentities, historyRows: raw.historyRows, baseline: null })))
    assert.equal(local.baseline, null)
    return raw
  })()
  assert.deepEqual(allTables(f.db), before)
  f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)')
    .run(initialIncomingBaselineKey(request.targetFingerprint), '{"callerBaseline":true}', '2041-01-01T00:00:00.000Z')
  const withBaseline = allTables(f.db)
  f.db.transaction(() => {
    assert.deepEqual(readRawInitialIncomingWorkspaceOwned(f.db), raw)
    assert.equal(readInitialIncomingWorkspace(f.db).snapshot.localFingerprint, raw.snapshot.localFingerprint)
    assert.throws(() => readInitialIncomingLocal(f.db, request), 'The request wrapper still validates its own exact baseline and receipt')
  })()
  assert.deepEqual(allTables(f.db), withBaseline)
}))

test('an actually empty schema27 graph cannot hide an orphan recovery anchor when public publication admission no longer loops over group batches', async () => withV3Fixture(f => {
  const store = new KnowbookStore(join(f.root, 'empty-original.db'))
  try {
    const db = store.getUnsafeDatabaseHandle()
    const original = db.transaction(() => readRawSyncedPersistentPublicationSnapshotOwned(db))()
    assert.equal(original.groups.length, 0)
    assert.deepEqual(captureSyncedPublicationSnapshot(db), { status: 'unsupported', reason: 'no-active-groups' })
    db.prepare(`INSERT INTO synced_exposure_attempts
      (id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at)
      VALUES(?,?,?,?,?,'possible',?,NULL)`).run(RECOVERY_EPOCH_PREFIX + randomUUID(), '5'.repeat(64),
      RECOVERY_BOUNDARY_CHANNEL, '6'.repeat(64), '7'.repeat(64), '2041-01-01T00:00:00.000Z')
    const before = allTables(db)
    db.transaction(() => {
      assert.deepEqual(readRawSyncedPersistentPublicationSnapshotOwned(db), original)
      assert.throws(() => readSyncedPersistentPublicationSnapshot(db), /恢复历史边界|boundary/)
      assert.throws(() => readInitialIncomingWorkspace(db), /恢复历史边界|boundary/)
    })()
    assert.throws(() => captureSyncedPublicationSnapshot(db), error => error instanceof SyncedPublicationError)
    assert.deepEqual(allTables(db), before, 'Zero active groups cannot suppress evidence checks or silently repair an orphan')
  } finally { store.destroy() }
}))
