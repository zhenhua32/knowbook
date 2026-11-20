import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, openSync, closeSync, readFileSync, readdirSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { backupV3FileDigest, backupV3InventoryHash, buildBackupV3Files, isBackupV3AssetPath } from '../src/main/backup/v3-format'
import { openBackupV3RestoreSource } from '../src/main/backup/v3-reader'
import { prepareBackupV3RestoreSqlStage } from '../src/main/backup/v3-restore-sql-stage'
import { capsule2AssetArchiveOriginalBytes3, parseCapsule2CompleteAssetArchiveManifest, prepareCapsule2AssetArchiveFromVerifiedV3,
  readCapsule2ArchiveSourceOriginal, readCapsule2AssetArchive, reopenCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { validateCapsule2ManagedTree } from '../src/main/database/restore-knowledge-capsule2-assets-model'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { capsule2RawTableRowCount, hashValidatedCapsule2RawSqlTable,
  scopedCapsule2TableRowEncoding } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { captureReopenedSealedCapsule2SourceWithWorking5, captureSealedCapsule2SourceFromArchive } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { scopeIncomingReferenceTables5, withReferenceOriginalRows5 } from '../src/main/database/restore-knowledge-reference-original-rows5'
import { readOwnedRawCapsuleOriginal, reopenPreparedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { CAPSULE_V3_ASSET_MAX_FILE_BYTES } from '../src/main/database/restore-knowledge-capsule-v3-assets'
import { captureSyncedBackupV3, readSyncedBackupV3Capture } from '../src/main/database/synced-backup-v3'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../src/shared/syncedBlockPortable'
import { allTables, randomUUID, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'

function material(f: V3Fixture, bytes: Uint8Array, options?: { snapshotId: string; extraSummary: string }) {
  const snapshot = readSyncedBackupV3Capture(captureSyncedBackupV3(f.db))
  assert.ok(snapshot)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const assets = ['archive + alias.bin', '同份备份.bin'].map(name => {
    const uri = buildSyncedPortableAssetUri({ hash, name })
    return { relativePath: syncedPortableAssetBackupPath(uri), name, uri, hash, bytes }
  })
  const summary = assets.map(asset => `[local](<${asset.uri}>)`).join('\n') + (options?.extraSummary ?? '')
  const documents = snapshot.documents.map((doc, index) => index === 0 ? { ...doc, summary } : doc)
  const snapshotId = options?.snapshotId ?? randomUUID()
  const files = buildBackupV3Files({ documents, catalog: snapshot.catalog, standaloneDatabases: snapshot.standaloneDatabases,
    groups: snapshot.groups, assets: assets.map(({ uri: _uri, ...asset }) => asset) }, snapshotId)
  for (const file of options ? [] : files) {
    const path = join(f.destination, ...file.relativePath.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.bytes, { flag: 'wx' })
  }
  return { hash, assets, files, snapshotId }
}

const manifestHash = (value: { version: number }) =>
  capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v' + value.version + '\0' + capsuleJson(value))

async function fileHash(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

test('archive6 seals two genuine 50 MiB V3 aliases as one physical blob and cold-reopens without the export folder', () => withV3Fixture(async f => {
  const bytes = new Uint8Array(CAPSULE_V3_ASSET_MAX_FILE_BYTES)
  bytes[0] = 9
  bytes[bytes.length - 1] = 117
  const data = material(f, bytes), before = allTables(f.db)
  const owner = openBackupV3RestoreSource(f.destination), operationId = randomUUID()
  mkdirSync(join(f.userDataRoot, 'backups', 'database-restore', operationId), { recursive: true })
  const stage = await prepareBackupV3RestoreSqlStage(owner, f.userDataRoot, operationId)
  await assert.rejects(prepareCapsule2AssetArchiveFromVerifiedV3({ ...stage }, owner), /does not belong to this archive owner/)
  await assert.rejects(prepareCapsule2AssetArchiveFromVerifiedV3(stage, openBackupV3RestoreSource(f.destination)), /does not belong to this archive owner/)
  const prepared = await prepareCapsule2AssetArchiveFromVerifiedV3(stage, owner)
  const info = await readCapsule2AssetArchive(prepared), { manifest } = info
  assert.equal(manifest.version, 6)
  if (manifest.version !== 6) throw new Error('Expected a V3-owned archive')
  assert.equal(manifest.backupV3.snapshotId, data.snapshotId)
  assert.equal(manifest.backupV3.files.length, data.files.length)
  assert.equal(manifest.referenceProvenance.identities.length, 0)
  assert.equal(manifest.referenceProvenance.rootSpellings.length, 0)
  assert.equal(manifest.referenceProvenance.entries.filter(entry => entry[1] === 'portable').length, 2)
  assert.equal(manifest.certified, false)
  assert.equal(manifest.coverage.finalAssetClosureComplete, false)
  assert.equal(manifest.permit, false)
  assert.deepEqual(readdirSync(join(info.directory, 'files')), [data.hash])
  const copied = join(info.directory, 'files', data.hash)
  assert.equal(await fileHash(copied), data.hash)
  const copiedBytes = capsule2AssetArchiveOriginalBytes3(manifest)
  assert.equal(copiedBytes, bytes.length + data.files.filter(file => !data.assets.some(asset => asset.relativePath === file.relativePath))
    .reduce((total, file) => total + file.bytes.length, 0))
  assert.throws(() => validateCapsule2ManagedTree(manifest.tree), /有限整数无效/)
  const disk = readFileSync(join(info.directory, 'manifest.json'), 'utf8')
  assert.deepEqual(parseCapsule2CompleteAssetArchiveManifest(disk, manifest.capsuleId, info.manifestHash), manifest)
  const fake = { ...manifest, backupV3: { ...manifest.backupV3, inventoryHash: '0'.repeat(64) } }
  assert.throws(() => parseCapsule2CompleteAssetArchiveManifest(capsuleJson(fake) + '\n', manifest.capsuleId, manifestHash(fake)), /库存摘要/)
  const badProvenance = { ...manifest, referenceProvenance: { ...manifest.referenceProvenance,
    entries: manifest.referenceProvenance.entries.map(entry => [entry[0], 'unresolved', 'foreign-uri']) } }
  assert.throws(() => parseCapsule2CompleteAssetArchiveManifest(capsuleJson(badProvenance) + '\n', manifest.capsuleId, manifestHash(badProvenance)), /严格限定在原portable alias/)

  const original = readOwnedRawCapsuleOriginal(await readCapsule2ArchiveSourceOriginal(prepared))
  const reopen = async () => reopenCapsule2AssetArchive(await reopenPreparedRawCapsuleOriginal({
    profileRoot: original.profileRoot, operationId: basename(original.recoveryDirectory),
    capsuleId: manifest.capsuleId, expectedInventory: original.originalInventory
  }), info.manifestHash)
  for (const file of data.files) unlinkSync(join(f.destination, ...file.relativePath.split('/')))
  assert.deepEqual((await readCapsule2AssetArchive(await reopen())).manifest, manifest)
  assert.deepEqual(allTables(f.db), before)

  const index = join(info.directory, 'v3-content', '__knowbook', 'databases', 'index.md')
  const contents = readFileSync(index)
  const changed = Buffer.from(contents)
  changed[0] ^= 1
  writeFileSync(index, changed)
  await assert.rejects(reopen(), /原字节hash不符/)
  writeFileSync(index, contents)
  const unexpected = join(info.directory, 'v3-content', 'unexpected.md')
  writeFileSync(unexpected, '', { flag: 'wx' })
  await assert.rejects(reopen(), /目录闭集变化/)
  unlinkSync(unexpected)
  const fd = openSync(copied, 'r+')
  try { writeSync(fd, Buffer.from([118]), 0, 1, bytes.length - 1) } finally { closeSync(fd) }
  await assert.rejects(reopen(), /全部bytes\/FD\/path变化/)
}))

test('archive6 cold reopen rejects independently valid V3 contents paired with different SQLite business content', () => withV3Fixture(async f => {
  const bytes = new Uint8Array([19, 29, 239])
  const data = material(f, bytes), owner = openBackupV3RestoreSource(f.destination), operationId = randomUUID()
  mkdirSync(join(f.userDataRoot, 'backups', 'database-restore', operationId), { recursive: true })
  const stage = await prepareBackupV3RestoreSqlStage(owner, f.userDataRoot, operationId)
  const prepared = await prepareCapsule2AssetArchiveFromVerifiedV3(stage, owner)
  const info = await readCapsule2AssetArchive(prepared), { manifest } = info
  if (manifest.version !== 6) throw new Error('Expected a V3-owned archive')
  const original = readOwnedRawCapsuleOriginal(await readCapsule2ArchiveSourceOriginal(prepared))
  const altered = material(f, bytes, { snapshotId: data.snapshotId, extraSummary: '\nA different summary in the V3 original' })
  for (const file of altered.files.filter(file => !isBackupV3AssetPath(file.relativePath))) {
    writeFileSync(join(info.directory, 'v3-content', ...file.relativePath.split('/')), file.bytes)
  }
  const files = altered.files.map(backupV3FileDigest).sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
  const forged = { ...manifest, backupV3: { snapshotId: data.snapshotId, files, inventoryHash: backupV3InventoryHash(files) } }
  const disk = capsuleJson(forged) + '\n', pinned = manifestHash(forged)
  assert.deepEqual(parseCapsule2CompleteAssetArchiveManifest(disk, manifest.capsuleId, pinned), forged)
  writeFileSync(join(info.directory, 'manifest.json'), disk)
  const raw = await reopenPreparedRawCapsuleOriginal({ profileRoot: original.profileRoot, operationId,
    capsuleId: manifest.capsuleId, expectedInventory: original.originalInventory })
  await assert.rejects(reopenCapsule2AssetArchive(raw, pinned), /private V3 SQL readback differs from its source records/)
}))

test('archive6 seal verifies direct file-backed block rows against the original material', () => withV3Fixture(async f => {
  material(f, new Uint8Array([19, 29, 239]))
  const owner = openBackupV3RestoreSource(f.destination), operationId = randomUUID()
  mkdirSync(join(f.userDataRoot, 'backups', 'database-restore', operationId), { recursive: true })
  const stage = await prepareBackupV3RestoreSqlStage(owner, f.userDataRoot, operationId)
  const archive = await prepareCapsule2AssetArchiveFromVerifiedV3(stage, owner)
  const sealed = await captureSealedCapsule2SourceFromArchive(archive)
  const readBlocks = await withReferenceOriginalRows5(async (store, _groups, stageBlocks) => {
    const reopened = await captureReopenedSealedCapsule2SourceWithWorking5({ profileRoot: f.userDataRoot, operationId,
      capsuleId: sealed.value.capsuleId, expectedManifestHash: sealed.info.manifestHash }, stageBlocks)
    return { reopened, scoped: scopeIncomingReferenceTables5(reopened.value.source.sourceContent, store) }
  }, async ({ reopened, scoped }) => {
    assert.equal(reopened.value.materialHash, sealed.value.materialHash)
    assert.equal(reopened.value.knowledge.observationHash, sealed.value.knowledge.observationHash)
    assert.equal(reopened.value.source.policy.observationHash, sealed.value.source.policy.observationHash)
    const selected = []
    for (const name of ['blocks', 'synced_group_blocks']) {
      const table = reopened.value.source.sourceContent.tables.find(entry => entry.name === name)!
      const original = sealed.value.source.sourceContent.tables.find(entry => entry.name === name)!
      assert.equal(scoped.tables.find(entry => entry.name === name), table, 'the qualified scope reuses the producer table')
      assert.ok(capsule2RawTableRowCount(table) > 0)
      assert.equal(capsule2RawTableRowCount(table), original.rows.length)
      assert.equal(hashValidatedCapsule2RawSqlTable('test.archive6', table), hashValidatedCapsule2RawSqlTable('test.archive6', original))
      assert.throws(() => table.rows, /逐行读取范围/)
      selected.push(scopedCapsule2TableRowEncoding(table)!)
    }
    return selected
  })
  for (const blocks of readBlocks) assert.throws(() => [...blocks()], /读取范围已结束/)
}))
