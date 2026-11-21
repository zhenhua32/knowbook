import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { buildBackupV3Files } from '../src/main/backup/v3-format'
import { assertBackupV3RestoreSourceCurrent, closeBackupV3RestoreSource, copyBackupV3RestoreAsset, openBackupV3RestoreSource,
  readBackupV3RestoreSource, readScopedBackupV3RestoreSource, verifyBackupV3Archive } from '../src/main/backup/v3-reader'
import { captureSyncedBackupV3, readSyncedBackupV3Capture } from '../src/main/database/synced-backup-v3'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../src/shared/syncedBlockPortable'
import { allTables, randomUUID, withV3Fixture } from './helpers/synced-backup-v3-fixture'

async function fileHash(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

test('V3 restore source pins the parsed graph and stages an original 50 MiB alias without retaining payloads', () => withV3Fixture(async f => {
  const snapshot = readSyncedBackupV3Capture(captureSyncedBackupV3(f.db))
  assert.ok(snapshot)
  const bytes = new Uint8Array(50 * 1024 * 1024)
  bytes[0] = 13; bytes[bytes.length - 1] = 193
  const hash = createHash('sha256').update(bytes).digest('hex'), name = 'original + alias.bin'
  const uri = buildSyncedPortableAssetUri({ hash, name }), relativePath = syncedPortableAssetBackupPath(uri)
  const documents = snapshot.documents.map((doc, index) => index === 0 ? { ...doc, summary: `[asset](${uri})` } : doc)
  const files = buildBackupV3Files({ documents, catalog: snapshot.catalog, standaloneDatabases: snapshot.standaloneDatabases,
    groups: snapshot.groups, assets: [{ relativePath, bytes, hash, name }] }, randomUUID())
  for (const file of files) {
    const path = join(f.destination, ...file.relativePath.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.bytes, { flag: 'wx' })
  }
  const archive = realpathSync(f.destination), stage = join(realpathSync(f.root), 'asset-stage')
  mkdirSync(stage)
  const before = allTables(f.db), owner = openBackupV3RestoreSource(archive), inspected = readBackupV3RestoreSource(owner)
  const verified = verifyBackupV3Archive(archive)
  assert.deepEqual(inspected.archive.manifest, verified.manifest)
  assert.deepEqual(inspected.files, verified.files)
  assert.deepEqual(inspected.assets, [{ relativePath, bytes: bytes.byteLength, hash }])
  assert.ok(inspected.archive.documents.some(doc => doc.summary.includes(uri)))
  assert.equal(inspected.archive.groups.length, snapshot.groups.length)
  const { archive: scoped } = readScopedBackupV3RestoreSource(owner)
  assert.equal(Array.isArray(scoped.documents), false)
  assert.equal(Array.isArray(scoped.groups), false)
  assert.deepEqual(Array.from(scoped.documents), inspected.archive.documents)
  const location = scoped.documentLocations[0], groupId = inspected.archive.groups[0].wire.id
  const readDocument = () => scoped.readDocument(location.id)
  const readGroup = () => scoped.readGroup(groupId)
  assert.deepEqual(readDocument(), inspected.archive.documents[0])
  assert.deepEqual(readGroup(), inspected.archive.groups[0])
  inspected.archive.documents.length = 0
  inspected.assets[0].hash = '0'.repeat(64)
  assert.deepEqual(readBackupV3RestoreSource(owner).assets, [{ relativePath, bytes: bytes.byteLength, hash }])
  assert.equal(readBackupV3RestoreSource(owner).archive.documents.length, documents.length)
  assert.throws(() => assertBackupV3RestoreSourceCurrent({ kind: 'verified-v3-restore-source' }), /actual verified V3 restore source/)
  assert.doesNotThrow(() => assertBackupV3RestoreSourceCurrent(owner))

  const copied = join(stage, 'copied.bin')
  await copyBackupV3RestoreAsset(owner, relativePath, copied)
  assert.equal(await fileHash(copied), hash)
  const occupied = join(stage, 'occupied.bin')
  writeFileSync(occupied, 'existing alias', { flag: 'wx' })
  await assert.rejects(copyBackupV3RestoreAsset(owner, relativePath, occupied), { code: 'EEXIST' })
  assert.equal(readFileSync(occupied, 'utf8'), 'existing alias')
  await assert.rejects(copyBackupV3RestoreAsset(owner, '__knowbook/databases/index.md', join(stage, 'not-an-asset')), /not in the verified V3 restore inventory/)
  await assert.rejects(copyBackupV3RestoreAsset(owner, relativePath, join(archive, 'inside.bin')), /not outside the source archive/)

  const originalAsset = join(archive, ...relativePath.split('/')), originalFd = openSync(originalAsset, 'r')
  try {
    unlinkSync(originalAsset)
    writeFileSync(originalAsset, bytes, { flag: 'wx' })
  } finally { closeSync(originalFd) }
  assert.equal(await fileHash(originalAsset), hash, 'The replacement has the same bytes as the original')
  assert.throws(() => assertBackupV3RestoreSourceCurrent(owner), /original V3 restore archive changed/)
  const rejected = join(stage, 'rejected.bin')
  await assert.rejects(copyBackupV3RestoreAsset(owner, relativePath, rejected), /archive directory inventory changed|original V3 asset changed/)
  assert.equal(existsSync(rejected), false)
  assert.deepEqual(allTables(f.db), before)
  closeBackupV3RestoreSource(owner)
  assert.throws(readDocument)
  assert.throws(readGroup)
}))
