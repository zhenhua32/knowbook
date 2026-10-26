// Real SQLite and old-entry gate tests. Marker bindings here are format data,
// not genuine reference/copy authorities; stage factory coverage is separate.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { copyFileSync, constants, readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { inspectOrdinaryRestoreDatabase, inspectRawRestoreConnection } from '../src/main/database/restore-safety-read'
import { advanceSyncedRecoveryEpoch } from '../src/main/database/synced-recovery-boundary'
import { assertSyncedRecoveryBoundaryRecords } from '../src/main/database/synced-recovery-boundary-read'
import { recoveryBoundaryKey } from '../src/main/database/synced-recovery-boundary-model'
import { stage3MarkerKey, stage3MarkerJson, validateRootRestoreStage3Marker,
  type RootRestoreStage3Marker, type Stage3OriginalRecoveryFamily } from '../src/main/database/restore-knowledge-stage3-marker-model'
import { readStage3OriginalRecoveryFamilyOwned, readRootRestoreStage3MarkerOwned } from '../src/main/database/restore-knowledge-stage3-marker-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import type { PayloadEncoding } from './helpers/restore-knowledge-payload-fixture'

const at = '2048-02-03T04:05:06.007Z', digest = 'a'.repeat(64)
/** Only format data. These synthetic hashes never go through a capability
 * factory, never authorize copying source files, and never authenticate K. */
function marker(originalRecoveryFamily: Stage3OriginalRecoveryFamily): RootRestoreStage3Marker {
  return validateRootRestoreStage3Marker({ kind: 'root-restore-non-executable-stage', version: 1, scope: 'physical-candidate-only',
    stageId: randomUUID(), preparedAt: at, copyId: randomUUID(), copyManifestHash: digest, stageIntentHash: digest,
    referencePlanId: randomUUID(), referenceManifestHash: digest, baseIdentityAllocationHash: digest,
    derivedReferenceAllocationHash: digest, checkedCanonicalCandidateHash: digest, sourceMaterialHash: digest,
    currentMaterialHash: digest, conservationHash: digest, originalDescriptorHash: digest, currentOriginalInventoryHash: digest,
    originalRecoveryFamily, historyCutComplete: false, acceptedCoverage: false, effective: false, permit: false })
}
function readonly<T>(file: string, run: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try { db.pragma('foreign_keys=ON'); db.pragma('query_only=ON'); return db.transaction(() => run(db))() }
  finally { db.close() }
}
function mutate(file: string, run: (db: Database.Database) => void) {
  const db = new Database(file, { fileMustExist: true })
  try { db.pragma('foreign_keys=ON'); db.pragma('journal_mode=DELETE'); db.transaction(() => run(db)).immediate() }
  finally { db.close() }
}
function writeMarker(file: string, value: RootRestoreStage3Marker) {
  mutate(file, db => { db.prepare('INSERT INTO main.app_settings(key,value,updated_at) VALUES(?,?,?)')
    .run(stage3MarkerKey(value.stageId), stage3MarkerJson(value), value.preparedAt) })
}
function exactStageClone(source: string, root: string) {
  const file = join(root, 'stage-gate-' + randomUUID() + '.db')
  copyFileSync(source, file, constants.COPYFILE_EXCL)
  // This is a closed-source gate fixture, not the genuine three-file copy seam.
  mutate(file, () => {})
  return file
}
function assertOldGates(file: string, expected: RegExp) {
  const before = readFileSync(file)
  let unexpectedlyOpened: KnowbookStore | undefined
  try { assert.throws(() => { unexpectedlyOpened = new KnowbookStore(file) }, expected) }
  finally { unexpectedlyOpened?.destroy() }
  assert.throws(() => inspectOrdinaryRestoreDatabase(file), expected)
  assert.throws(() => readonly(file, db => inspectRawRestoreConnection(db)), expected)
  assert.deepEqual(readFileSync(file), before, 'The rejecting current Store/restore entry does not alter the main DB bytes')
}
async function withClosedOrdinary(encoding: PayloadEncoding, run: (file: string, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-stage3-gates-')), file = join(root, 'profile', 'storage', 'knowbook.db')
  let initial: Database.Database | undefined, store: KnowbookStore | undefined
  try {
    mkdirSync(dirname(file), { recursive: true })
    initial = new Database(file); initial.pragma("encoding='" + encoding + "'")
    initial.exec('CREATE TABLE stage3_encoding_fixture(value TEXT)'); initial.close(); initial = undefined
    store = new KnowbookStore(file)
    const db = store.getUnsafeDatabaseHandle()
    // The encoding bootstrap is test scaffolding, not stage schema or marker.
    db.exec('DROP TABLE stage3_encoding_fixture')
    assert.equal(db.pragma('user_version', { simple: true }), 27)
    db.pragma('wal_checkpoint(TRUNCATE)'); store.destroy(); store = undefined
    run(file, root)
  } finally {
    initial?.close(); store?.destroy()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-stage3-gates-'))
    rmSync(root, { recursive: true, force: true })
  }
}

test('stage3 marker format is closed and cannot encode completed history or accepted installation permission', () => {
  const value = marker({ rows: 0, valueBytes: 0, sha256: digest })
  assert.equal(stage3MarkerKey(value.stageId), 'synced.recovery.history.stage3.v1.' + value.stageId)
  assert.throws(() => validateRootRestoreStage3Marker({ ...value, permit: true }))
  assert.throws(() => validateRootRestoreStage3Marker({ ...value, historyCutComplete: true }))
  assert.throws(() => validateRootRestoreStage3Marker({ ...value, finalManifestHash: digest }))
  let called = false
  const accessor = { ...value }
  Object.defineProperty(accessor, 'referenceManifestHash', { enumerable: true, get() { called = true; return digest } })
  assert.throws(() => validateRootRestoreStage3Marker(accessor))
  assert.equal(called, false)
})

test('stage3 reserved recovery family makes an actual zero-group schema27 Store and both restore readers refuse before opening for work', async () =>
  withClosedOrdinary('UTF-8', (source, root) => {
    const sourceBytes = readFileSync(source), file = exactStageClone(source, root)
    const control = new KnowbookStore(file)
    const groups = control.getUnsafeDatabaseHandle().prepare('SELECT count(*) AS count FROM synced_groups').get() as { count: number }
    assert.equal(groups.count, 0)
    control.destroy()
    const value = marker(readonly(file, readStage3OriginalRecoveryFamilyOwned))
    writeMarker(file, value)
    const actual = readonly(file, db => readRootRestoreStage3MarkerOwned(db, value))
    assert.equal(actual.markerVerified, true)
    assert.equal(actual.physicalStageValidatedByThisLeaf, false)
    assert.equal(actual.permit, false)
    readonly(file, db => {
      assert.equal(db.pragma('main.integrity_check', { simple: true }), 'ok')
      assert.deepEqual(db.pragma('main.foreign_key_check'), [])
      assert.equal(readRootRestoreStage3MarkerOwned(db, value).markerVerified, true)
      // Requesting the TEMP schema opens its otherwise empty native database.
      // Even without a user-created TEMP table, this is outside the owned main.
      db.pragma('temp.schema_version', { simple: true })
      assert.throws(() => readRootRestoreStage3MarkerOwned(db, value), /ATTACH\/temp/)
    })
    assertOldGates(file, /未知恢复边界metadata版本/)
    assert.deepEqual(readFileSync(source), sourceBytes)
  }))

test('stage3 nonzero real Main group and prior recovery boundary remain byte-preserved while the new stage family blocks normal readers', async () =>
  withV3Fixture(f => {
    const old = f.db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as {
      workspace_scope: string; recovery_epoch: string
    }
    const operationId = randomUUID()
    const receipt = f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, { operationId,
      expectedWorkspaceScope: old.workspace_scope, expectedRecoveryEpoch: old.recovery_epoch, workspaceScope: old.workspace_scope,
      recoveryEpoch: randomUUID(), documentBoundary: at, acceptedAt: at })).immediate()
    assert.ok(receipt, 'The prior v1 boundary comes from the true Main producer, not fixture JSON')
    assert.ok(f.db.transaction(() => assertSyncedRecoveryBoundaryRecords(f.db))().boundaries.has(operationId))
    f.db.pragma('wal_checkpoint(TRUNCATE)'); f.close()
    const sourceBytes = readFileSync(f.file), file = exactStageClone(f.file, f.root)
    const family = readonly(file, readStage3OriginalRecoveryFamilyOwned)
    assert.ok(family.rows > 0)
    const value = marker(family)
    writeMarker(file, value)
    assert.equal(readonly(file, db => readRootRestoreStage3MarkerOwned(db, value)).markerVerified, true)
    assertOldGates(file, /未知恢复边界metadata版本/)
    // A future stage reader must not silently skip old v1 rows to permit its
    // own marker: delete an actual old row and retain the exact expected hash.
    mutate(file, db => { db.prepare('DELETE FROM app_settings WHERE key=?').run(recoveryBoundaryKey(operationId)) })
    assert.throws(() => readonly(file, db => readRootRestoreStage3MarkerOwned(db, value)), /其他原recovery family/)
    assert.deepEqual(readFileSync(f.file), sourceBytes)
  }))

test('stage3 marker readback rejects another stage key changed bindings stale time and attached-database connections', async () =>
  withClosedOrdinary('UTF-8', (source, root) => {
    const file = exactStageClone(source, root), value = marker(readonly(file, readStage3OriginalRecoveryFamilyOwned))
    writeMarker(file, value)
    assert.throws(() => readonly(file, db => readRootRestoreStage3MarkerOwned(db, { ...value, copyManifestHash: 'b'.repeat(64) })), /private intent/)
    mutate(file, db => { db.prepare('UPDATE app_settings SET updated_at=? WHERE key=?').run('2049-01-01T00:00:00.000Z', stage3MarkerKey(value.stageId)) })
    assert.throws(() => readonly(file, db => readRootRestoreStage3MarkerOwned(db, value)), /private intent/)
    mutate(file, db => { db.prepare('UPDATE app_settings SET updated_at=? WHERE key=?').run(value.preparedAt, stage3MarkerKey(value.stageId)) })
    const another = { ...value, stageId: randomUUID() }
    writeMarker(file, another)
    assert.throws(() => readonly(file, db => readRootRestoreStage3MarkerOwned(db, value)), /唯一自有stage key/)
    mutate(file, db => { db.prepare('DELETE FROM app_settings WHERE key=?').run(stage3MarkerKey(another.stageId)) })
    readonly(file, db => {
      db.exec("ATTACH DATABASE ':memory:' AS unrelated")
      assert.throws(() => readRootRestoreStage3MarkerOwned(db, value), /ATTACH/)
    })
  }))

test('stage3 marker leaf preserves real UTF16 TEXT while the current old Store still refuses that marked zero-group file', async () => {
  for (const encoding of ['UTF-16le', 'UTF-16be'] as const) await withClosedOrdinary(encoding, (source, root) => {
    const file = exactStageClone(source, root), value = marker(readonly(file, readStage3OriginalRecoveryFamilyOwned))
    writeMarker(file, value)
    assert.equal(readonly(file, db => readRootRestoreStage3MarkerOwned(db, value)).markerVerified, true)
    // The legacy family reader validates CAST(TEXT AS BLOB) as UTF8, so UTF16
    // may be refused before its unknown-version branch. Do not mislabel it.
    assertOldGates(file, /原SQL TEXT不能无损读取|原SQL TEXT含非法UTF8|未知恢复边界metadata版本/)
  })
})
