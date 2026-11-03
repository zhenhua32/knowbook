import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownBackupService, writeBackupSnapshot, type BackupV3DatabaseExportJob } from '../src/main/backup/exporter'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { readSyncedBaselineMetadataCaptureOwned2 } from '../src/main/database/synced-binding-sources'
import { SYNCED_METADATA_BASELINE2_PREFIX, SYNCED_METADATA_CAPTURE2_PIN,
  readSyncedMetadataCaptureRecordOwned2, reopenSyncedMetadataCaptureRecordOwned2 } from '../src/main/database/synced-metadata-capture-record2'
import { withV3Fixture, addV3Assets } from './helpers/synced-backup-v3-fixture'

type PointRow = { client_operation_id: string; request_hash: string; result_json: string; created_at: string; original_bytes: Buffer }

test('a genuine session asset source point survives complete Store cold startup and the real V3 backup service with both same-hash logical aliases unchanged', () => withV3Fixture(async f => {
  const added = await addV3Assets(f)
  let store: KnowbookStore | null = KnowbookStore.openCanonicalRuntime(f.file)
  const pointSql = 'SELECT client_operation_id,request_hash,result_json,created_at,CAST(result_json AS BLOB) AS original_bytes FROM synced_operations WHERE substr(client_operation_id,1,?)=? ORDER BY client_operation_id'
  const backupRoot = join(realpathSync(f.root), 'metadata2-service-backup'), jobs: BackupV3DatabaseExportJob[] = []
  try {
    const db = store.getUnsafeDatabaseHandle(), sender = Object.freeze({ frame: 'actual asset source point before cold startup' })
    const instance = db.prepare('SELECT instance_id,host_document_id FROM synced_instances WHERE group_id=? ORDER BY instance_id').get(added.groupId) as
      { instance_id: string; host_document_id: string } | undefined
    assert.ok(instance, 'The asset-bearing group has a real Main-created registered instance')
    const opened = store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: instance.host_document_id,
      instanceId: instance.instance_id, groupId: added.groupId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw new Error('The real asset instance must open')
    const captured = store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'captureBaseline', input: { groupId: added.groupId } })
    assert.equal(captured.status, 'ready'); if (captured.status !== 'ready') throw new Error('The actual session must capture its asset source point')
    const original = db.transaction(() => readSyncedBaselineMetadataCaptureOwned2(db, captured.readOwnerId))()
    assert.equal(original.status, 'captured'); if (original.status !== 'captured') throw new Error('The session owner must bind its actual persisted point')
    assert.equal(original.record.sources[0].wire.id, added.groupId)
    assert.deepEqual(original.record.sources[0].wire.blocks, captured.snapshot.blocks)
    assert.equal(original.writePermit, false); assert.equal(original.record.businessOperationCommitted, false)
    const rows = db.prepare(pointSql).all(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX) as PointRow[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0].request_hash, original.record.recordHash)
    assert.deepEqual(db.prepare('SELECT * FROM synced_group_pins WHERE kind=? OR pin_id=?').all(SYNCED_METADATA_CAPTURE2_PIN, rows[0].client_operation_id), [])

    // Close every fixture connection as well as the session Store before the
    // complete factory independently opens the persisted SQL and assets again.
    store.destroy(); store = null; f.close()
    const cold = KnowbookStore.openCanonicalRuntime(f.file); store = cold
    const reopenedDb = cold.getUnsafeDatabaseHandle()
    assert.deepEqual(reopenedDb.prepare(pointSql).all(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX), rows)
    assert.equal(reopenedDb.transaction(() => readSyncedBaselineMetadataCaptureOwned2(reopenedDb, captured.readOwnerId))().status, 'owner-unavailable',
      'Cold startup preserves original data without resurrecting the old private session capability')
    const reopened = reopenedDb.transaction(() => readSyncedMetadataCaptureRecordOwned2(reopenedDb,
      reopenSyncedMetadataCaptureRecordOwned2(reopenedDb, rows[0].client_operation_id)))()
    assert.deepEqual(reopened, original.record)

    const service = new MarkdownBackupService(cold, backupRoot, undefined, async job => {
      assert.ok('kind' in job && job.kind === 'synced-v3')
      if (!('kind' in job) || job.kind !== 'synced-v3') throw new Error('Expected the actual canonical raw database producer')
      assert.equal(realpathSync(job.databasePath), realpathSync(f.file))
      assert.equal(existsSync(job.destination), false, 'The real producer receives a fresh absent archive child')
      jobs.push(structuredClone(job))
      return writeBackupSnapshot(job)
    })
    const result = await service.exportAll(), archive = readBackupV3Archive(backupRoot)
    assert.equal(jobs.length, 1)
    assert.equal(archive.manifest.snapshotId, jobs[0].snapshotId)
    assert.equal(result.exported, archive.documents.length)
    assert.ok(archive.groups.some(group => group.wire.id === added.groupId))
    assert.equal(archive.assets.length, 2)
    assert.deepEqual(archive.assets.map(asset => asset.name).sort(), added.attachments.map(asset => asset.name).sort())
    assert.equal(new Set(archive.assets.map(asset => asset.relativePath)).size, 2, 'Equal content hashes retain two distinct logical alias files')
    for (const asset of archive.assets) {
      assert.equal(asset.hash, added.hash)
      assert.deepEqual(Buffer.from(asset.bytes), added.bytes)
      assert.deepEqual(readFileSync(join(backupRoot, ...asset.relativePath.split('/'))), added.bytes)
    }
    const version = service.listVersions()[0]
    assert.equal(version.format, 'synced-v3'); assert.equal(version.id, archive.manifest.snapshotId)
    assert.equal(readBackupV3Archive(service.resolveVersion(version.id)).manifest.snapshotId, version.id)
    assert.deepEqual(reopenedDb.prepare(pointSql).all(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX), rows,
      'Real backup exposure/version publication never rewrites the captured original SQL row or its exact bytes')
    assert.deepEqual(reopenedDb.prepare('SELECT * FROM synced_group_pins WHERE kind=? OR pin_id=?').all(SYNCED_METADATA_CAPTURE2_PIN, rows[0].client_operation_id), [],
      'The Source read point adds no business lifecycle pin during cold startup or backup')
  } finally { store?.destroy() }
}))
