import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { buildBackupV3Files, BACKUP_V3_MAX_ASSET_BYTES, isBackupV3AssetPath } from '../src/main/backup/v3-format'
import { openBackupV3RestoreSource, readBackupV3RestoreSource } from '../src/main/backup/v3-reader'
import { prepareBackupV3RestorePlan } from '../src/main/backup/v3-restore-prepare'
import { ATTACHMENT_MAX_FILE_BYTES } from '../src/shared/attachments'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../src/shared/syncedBlockPortable'
import { validateCapsule2ManagedTree } from '../src/main/database/restore-knowledge-capsule2-assets-model'
import { captureReopenedQualifiedOriginalContent5 } from '../src/main/database/restore-knowledge-qualified-originals'
import { prepareRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { prepareRootRestoreCanonicalAliasDerivationFromCombined5 } from '../src/main/database/restore-knowledge-sql-asset-alias-stage5'
import { referenceContextObjectPath } from '../src/main/database/restore-knowledge-reference-context-model'
import { restoreSqliteFilename } from '../src/main/database/restore-safety-sqlite-path'
import { KnowbookStore } from '../src/main/database/store'
import { captureSyncedBackupV3, readSyncedBackupV3Capture } from '../src/main/database/synced-backup-v3'
import { randomUUID, sha256, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('verified V3 50 MiB survives qualified cold capture and only its exact selected alias receives the expanded limit', () => withV3Fixture(async f => {
  const captured = readSyncedBackupV3Capture(captureSyncedBackupV3(f.db))
  assert.ok(captured)
  const bytes = Buffer.alloc(BACKUP_V3_MAX_ASSET_BYTES, 0xa5), name = 'verified V3 large original.png', hash = sha256(bytes)
  assert.ok(bytes.length > ATTACHMENT_MAX_FILE_BYTES)
  const uri = buildSyncedPortableAssetUri({ hash, name }), snapshotId = randomUUID()
  const documents = captured.documents.map(doc => doc.id === f.hostId ? {
    ...doc, summary: `![exact summary](<${uri}>)`, blocks: doc.blocks.map(block => block.id === f.hostBodyId
      ? { ...block, content: block.content + `\n\n![exact body](<${uri}>)` } : block)
  } : doc)
  for (const file of buildBackupV3Files({ documents, catalog: captured.catalog, groups: captured.groups,
    standaloneDatabases: captured.standaloneDatabases, assets: [{ bytes, name, hash, relativePath: syncedPortableAssetBackupPath(uri) }] }, snapshotId)) {
    const path = join(f.destination, ...file.relativePath.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.bytes, { flag: 'wx' })
  }

  const v3 = openBackupV3RestoreSource(await realpath(f.destination)), expectedInventory = readBackupV3RestoreSource(v3).inventoryHash
  const currentRoot = join(f.root, 'empty-current')
  await mkdir(currentRoot)
  const profileRoot = await realpath(currentRoot), operationId = randomUUID()
  const safety = join(profileRoot, 'backups', 'database-restore', operationId, 'safety')
  await mkdir(safety, { recursive: true })
  const current = KnowbookStore.createEmptySyncedReceiver(join(profileRoot, 'storage', 'knowbook.db'))
  try {
    await current.getUnsafeDatabaseHandle().backup(join(safety, 'knowbook.db'))
    const { root: captured, reference } = await prepareBackupV3RestorePlan({ profileRoot, operationId, source: v3,
      choices: { originPolicy: 'isolate-incoming', anonymousValues: 'source' } })
    const originalBackup = f.destination + '-retired'
    await rename(f.destination, originalBackup)
    const reopened = await captureReopenedQualifiedOriginalContent5({ profileRoot, operationId, mountId: captured.mountId,
      expectedDescriptorHash: captured.descriptorHash })
    const restored = reopened.pair.source.assetArchive
    assert.equal(restored.version, 6)
    if (restored.version !== 6) throw new Error('Cold qualified reader must retain the V3 archive version')
    assert.throws(() => validateCapsule2ManagedTree(restored.tree), /附件|asset|原件/i, 'The same tree still exceeds the old archive limit')
    assert.equal(restored.backupV3.snapshotId, snapshotId)
    assert.equal(restored.backupV3.inventoryHash, expectedInventory)
    for (const file of restored.backupV3.files.filter(file => !isBackupV3AssetPath(file.relativePath))) {
      const original = reopened.originalPackage.files.find(item => item.path.endsWith('/v3-content/' + file.relativePath))
      assert.equal(original?.bytes, file.bytes)
      assert.equal(original.sha256, file.hash)
    }

    assert.deepEqual(reference.value.candidate.conflicts, [])
    const combined = await prepareRootRestoreSqlAssetStage5(reference.plan)
    const selection = combined.assets.value.selected.filter(row => row.hash === hash)
    assert.deepEqual(selection.map(row => row.column).sort(), ['content', 'summary'])
    for (const row of selection) assert.deepEqual(row.backupV3, { archiveHash: reopened.pair.source.assetArchiveHash, inventoryHash: expectedInventory, snapshotId })
    const { aliases, source: sql } = await prepareRootRestoreCanonicalAliasDerivationFromCombined5(reference.plan, combined.stage)
    const path = `attachments/${hash.slice(0, 2)}/${hash}/${name}`
    assert.deepEqual(aliases.value.aliases, [{ hash, bytes: bytes.length, logicalName: name, path, occurrences: 2 }])
    const alias = join(aliases.directory, referenceContextObjectPath([], path)), actual = await lstat(alias)
    assert.equal(actual.size, bytes.length)
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(alias)) digest.update(chunk)
    assert.equal(digest.digest('hex'), hash)
    assert.equal(aliases.value.installPermit, false)
    assert.equal(sql.alias.value.rewrittenOccurrences, 2)
    assert.equal(sql.alias.value.remaining.finalSqlOccurrences, 0)
    const db = new Database(restoreSqliteFilename(join(sql.databaseDirectory, 'knowbook.db')), { readonly: true, fileMustExist: true })
    try {
      const summary = db.prepare('SELECT summary FROM documents WHERE id=?').pluck().get(f.hostId) as string
      const body = db.prepare('SELECT content FROM blocks WHERE id=?').pluck().get(f.hostBodyId) as string
      for (const [content, label] of [[summary, 'summary'], [body, 'body']]) {
        const url = new RegExp('!\\[exact ' + label + '\\]\\(<([^>]+)>\\)').exec(content)?.[1]
        assert.ok(url)
        assert.equal(fileURLToPath(url), join(profileRoot, 'storage', 'assets', ...path.split('/')))
      }
    } finally { db.close() }
  } finally { current.destroy() }
}))
