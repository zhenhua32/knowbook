import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { openBackupV3RestoreSource, readBackupV3RestoreSource } from '../src/main/backup/v3-reader'
import { assertBackupV3RestoreSqlArchiveProjection, assertBackupV3RestoreSqlStageOriginal, prepareBackupV3RestoreSqlStage } from '../src/main/backup/v3-restore-sql-stage'
import { buildBackupV3Files } from '../src/main/backup/v3-format'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../src/shared/syncedBlockPortable'
import { readOwnedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { captureSyncedBackupV3, readSyncedBackupV3Capture } from '../src/main/database/synced-backup-v3'
import { readRawValidatedSyncedPersistentPublicationSnapshotOwned } from '../src/main/database/synced-publication-sql-read'
import { allTables, randomUUID, sha256, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('verified V3 becomes a separate cold SQLite source with its original shared body and typed catalog values', () => withV3Fixture(async f => {
  const snapshotId = randomUUID(), captured = readSyncedBackupV3Capture(captureSyncedBackupV3(f.db))
  assert.ok(captured)
  const bytes = Buffer.from('independent V3 SQL attachment'), hash = sha256(bytes), name = 'proof.png'
  const uri = buildSyncedPortableAssetUri({ hash, name }), relativePath = syncedPortableAssetBackupPath(uri)
  const documents = captured.documents.map(doc => doc.id === f.hostId ? { ...doc, summary: `![proof](<${uri}>)` } : doc)
  for (const file of buildBackupV3Files({ documents, catalog: captured.catalog, standaloneDatabases: captured.standaloneDatabases,
    groups: captured.groups, assets: [{ relativePath, bytes, hash, name }] }, snapshotId)) {
    const path = join(f.destination, ...file.relativePath.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.bytes, { flag: 'wx' })
  }
  const original = allTables(f.db), live = await readFile(f.file)
  const operationId = randomUUID()
  await mkdir(join(f.userDataRoot, 'backups', 'database-restore', operationId), { recursive: true })
  const owner = openBackupV3RestoreSource(f.destination)
  const stage = await prepareBackupV3RestoreSqlStage(owner, f.userDataRoot, operationId)
  assert.equal(stage.snapshotId, snapshotId)
  assert.notEqual(stage.database, f.file)
  await assert.rejects(assertBackupV3RestoreSqlStageOriginal({ ...stage }, owner), /does not belong/)
  await assert.rejects(assertBackupV3RestoreSqlStageOriginal(stage, openBackupV3RestoreSource(f.destination)), /does not belong/)
  const rawOriginal = readOwnedRawCapsuleOriginal(await assertBackupV3RestoreSqlStageOriginal(stage, owner))
  assert.equal(rawOriginal.sealedDirectory, dirname(stage.database))
  assert.notEqual(rawOriginal.databasePath, stage.database)
  const db = new Database(rawOriginal.databasePath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('foreign_keys=ON')
    const { archive } = readBackupV3RestoreSource(owner)
    const snapshot = db.transaction(() => {
      assertBackupV3RestoreSqlArchiveProjection(db, archive)
      assert.throws(() => assertBackupV3RestoreSqlArchiveProjection(db, { ...archive, documents: archive.documents.map(doc =>
        doc.id === f.hostId ? { ...doc, title: 'different text, same attachment references' } : doc) }), /differs from its source records/)
      return readRawValidatedSyncedPersistentPublicationSnapshotOwned(db)
    })()
    assert.equal(snapshot.catalogId, f.catalogId)
    assert.equal(snapshot.groups.length, 1)
    const group = snapshot.groups[0]
    assert.equal(group.wire.id, f.groupId)
    assert.equal(group.wire.blocks[0].content, f.raw)
    assert.equal(group.wire.blocks[0].createdAt, f.sourceBirth)
    assert.equal(group.wire.bindings[0].target.kind, 'heading')
    assert.equal(db.prepare('SELECT instance_id FROM synced_instances WHERE group_id=?').pluck().get(f.groupId), f.instanceId)
    assert.equal(db.prepare('SELECT value_text FROM document_database_values WHERE document_id=? AND column_id=?').pluck().get(f.hostId, f.catalogColumn.id), 'catalog actual value')
    assert.equal(db.prepare('SELECT value_text FROM database_entity_values WHERE entity_id=? AND column_id=?').pluck().get(f.entity.id, f.customColumn.id), 'original custom value')
    const summary = db.prepare('SELECT summary FROM documents WHERE id=?').pluck().get(f.hostId)
    assert.equal(summary, `![proof](<${uri}>)`)
    const relativeAsset = relativePath.slice('__knowbook/assets/'.length)
    assert.deepEqual(await readFile(join(f.destination, ...relativePath.split('/'))), bytes)
    await assert.rejects(readFile(join(f.userDataRoot, 'storage', 'assets', ...relativeAsset.split('/'))), { code: 'ENOENT' })
  } finally { db.close() }
  assert.deepEqual(allTables(f.db), original)
  assert.deepEqual(await readFile(f.file), live)
  await writeFile(stage.database, Buffer.from('changed private source'), { flag: 'a' })
  await assert.rejects(assertBackupV3RestoreSqlStageOriginal(stage, owner), /bytes已改变/)
}))
