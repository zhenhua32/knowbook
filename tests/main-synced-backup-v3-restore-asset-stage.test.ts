import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildBackupV3Files } from '../src/main/backup/v3-format'
import { openBackupV3RestoreSource, readBackupV3RestoreSource } from '../src/main/backup/v3-reader'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { prepareBackupV3RestoreAssetStage } from '../src/main/backup/v3-restore-asset-stage'
import { reopenRestoreAssetTransfer4 } from '../src/main/database/restore-asset-transfer4'
import { restorePaths } from '../src/main/database/restore-safety-files'
import { captureSyncedBackupV3, readSyncedBackupV3Capture } from '../src/main/database/synced-backup-v3'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../src/shared/syncedBlockPortable'
import { allTables, fileInventory, randomUUID, sha256, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('V3 restore stages both exact aliases and authenticates the private transfer locator without publishing', () => withV3Fixture(async f => {
  const snapshot = readSyncedBackupV3Capture(captureSyncedBackupV3(f.db)), bytes = Buffer.from('same bytes, two names'), hash = sha256(bytes)
  assert.ok(snapshot)
  const names = ['first +@,.png', 'second [alias]~(1).png'], uris = names.map(name => buildSyncedPortableAssetUri({ hash, name }))
  const documents = snapshot.documents.map((doc, index) => index === 0 ? { ...doc, summary: uris.map(uri => `[asset](<${uri}>)`).join(' ') } : doc)
  for (const file of buildBackupV3Files({ documents, catalog: snapshot.catalog, standaloneDatabases: snapshot.standaloneDatabases,
    groups: snapshot.groups, assets: names.map((name, index) => ({ relativePath: syncedPortableAssetBackupPath(uris[index]), bytes, hash, name })) }, randomUUID())) {
    const path = join(f.destination, ...file.relativePath.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.bytes, { flag: 'wx' })
  }
  const owner = openBackupV3RestoreSource(realpathSync(f.destination)), profileRoot = join(realpathSync(f.root), 'target')
  const operationId = randomUUID(), operation = restorePaths(profileRoot, operationId).recovery
  mkdirSync(operation, { recursive: true })
  const actualRoot = realpathSync(profileRoot)
  const expected = names.map((name, index) => ({ uri: uris[index],
    path: join(profileRoot, 'storage', 'assets', 'attachments', hash.slice(0, 2), hash, name) }))
  mkdirSync(dirname(expected[0].path), { recursive: true })
  writeFileSync(expected[0].path, bytes, { flag: 'wx' })
  const existing = lstatSync(expected[0].path, { bigint: true }), tables = allTables(f.db), files = fileInventory(f.destination)

  const staged = await prepareBackupV3RestoreAssetStage(owner, profileRoot, operationId)
  assert.equal(staged.inventoryHash, readBackupV3RestoreSource(owner).inventoryHash)
  assert.equal(staged.operationId, operationId)
  assert.ok(staged.transfer)
  assert.notEqual(expected[0].uri, expected[1].uri)
  for (const alias of expected) {
    const restoredPath = fileURLToPath(staged.resolveAssetUri(alias.uri))
    assert.equal(relative(actualRoot, restoredPath), relative(profileRoot, alias.path))
  }
  assert.throws(() => staged.resolveAssetUri(buildSyncedPortableAssetUri({ hash, name: 'unrelated alias.png' })), /missing from the verified/)
  assert.throws(() => staged.resolveAssetUri(`file:///${hash}`), /missing from the verified/)
  assert.deepEqual(readdirSync(operation), ['asset-transfer-v4'], 'Intermediate verified bytes have been cleaned after transfer staging')
  assert.deepEqual(readFileSync(expected[0].path), bytes)
  assert.equal(lstatSync(expected[0].path, { bigint: true }).ino, existing.ino)
  assert.equal(existsSync(expected[1].path), false)
  const reopened = await reopenRestoreAssetTransfer4(profileRoot, operationId, staged.transfer.transferId, staged.transfer.manifestHash)
  assert.equal(reopened.manifestHash, staged.transfer.manifestHash)
  await assert.rejects(reopenRestoreAssetTransfer4(profileRoot, operationId, staged.transfer.transferId, '0'.repeat(64)), /凭据/)
  assert.deepEqual(allTables(f.db), tables)
  assert.deepEqual(fileInventory(f.destination), files)
}))

test('V3 restore asset stage leaves no transfer for an asset-free archive and rejects a changed source before staging', () => withV3Fixture(async f => {
  writeSyncedBackupV3(f.db, { userDataRoot: realpathSync(f.userDataRoot), destination: f.destination, snapshotId: randomUUID() })
  const owner = openBackupV3RestoreSource(realpathSync(f.destination)), profileRoot = join(realpathSync(f.root), 'target')
  const operationId = randomUUID(), operation = restorePaths(profileRoot, operationId).recovery
  mkdirSync(operation, { recursive: true })
  const staged = await prepareBackupV3RestoreAssetStage(owner, profileRoot, operationId)
  assert.equal(staged.transfer, null)
  assert.deepEqual(readdirSync(operation), [])
  writeFileSync(join(f.destination, 'unexpected.md'), 'archive changed', { flag: 'wx' })
  await assert.rejects(prepareBackupV3RestoreAssetStage(owner, profileRoot, operationId), /original V3 restore archive changed/)
  assert.deepEqual(readdirSync(operation), [])
  assert.equal(existsSync(join(profileRoot, 'storage')), false)
}))
