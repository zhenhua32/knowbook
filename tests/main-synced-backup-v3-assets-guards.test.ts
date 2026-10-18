import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { buildBackupV3Files } from '../src/main/backup/v3-format'
import { captureSyncedBackupV3, readSyncedBackupV3Capture, claimSyncedBackupV3 } from '../src/main/database/synced-backup-v3'
import { publicationCompare, publicationJson, publicationHash } from '../src/main/sync/synced-publication-model'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { withV3Fixture, addV3Assets, randomUUID, allTables } from './helpers/synced-backup-v3-fixture'

test('V3 prepare reads each same-hash source alias and rejects a missing second name before claim or external directory', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), path = f.assets.resolve(added.attachments[1].url)
  rmSync(path)
  const before = allTables(f.db)
  assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() }))
  assert.equal(existsSync(f.destination), false)
  assert.deepEqual(allTables(f.db), before)
}))

test('V3 prepare hashes the actual second same-hash source alias instead of trusting the first name cache', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), path = f.assets.resolve(added.attachments[1].url)
  writeFileSync(path, 'damaged second source alias')
  const before = allTables(f.db)
  assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() }))
  assert.equal(existsSync(f.destination), false)
  assert.deepEqual(allTables(f.db), before)
}))

test('V3 true opaque capture rejects a real second-connection canonical edit before claim and leaves zero external output', () => withV3Fixture(f => {
  const capture = captureSyncedBackupV3(f.db), source = readSyncedBackupV3Capture(capture), snapshotId = randomUUID()
  assert.ok(source, 'The stale test begins from a real private connection-bound Main capture')
  const files = buildBackupV3Files({ documents: source.documents, catalog: source.catalog,
    standaloneDatabases: source.standaloneDatabases, groups: source.groups, assets: [] }, snapshotId)
  const archiveHash = publicationHash(publicationJson(files.map(file => ({ relativePath: file.relativePath,
    hash: publicationHash(file.bytes), bytes: file.bytes.byteLength })).sort((a, b) => publicationCompare(a.relativePath, b.relativePath))))
  const second = f.connect()
  const edit = editCreatedGroup(second, f.groupId)
  assert.equal(edit.status, 'saved')
  const before = allTables(f.db)
  assert.throws(() => claimSyncedBackupV3(f.db, capture, { snapshotId, destination: f.destination, archiveHash }))
  assert.equal(existsSync(f.destination), false)
  assert.deepEqual(allTables(f.db), before)
}))
