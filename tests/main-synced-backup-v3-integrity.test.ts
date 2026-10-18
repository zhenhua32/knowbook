import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import type { SyncedGroupWire } from '../src/shared/synced-blocks'
import { withV3Fixture, type V3Fixture, randomUUID, sha256, fileInventory, addV3Assets, allTables } from './helpers/synced-backup-v3-fixture'

function written(run: (f: V3Fixture) => void) {
  return withV3Fixture(f => {
    writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
    run(f)
  })
}
const indexPath = (f: V3Fixture) => join(f.destination, '__knowbook', 'databases', 'index.md')
const groupPath = (f: V3Fixture) => join(f.destination, '__knowbook', 'synced', 'group-' + sha256(f.groupId) + '.json')
function changeScalar(path: string, key: string, change: (value: string) => string) {
  const source = readFileSync(path, 'utf8'), expression = new RegExp('^' + key + ': ([^\\r\\n]+)$', 'm')
  let hits = 0
  const next = source.replace(expression, (_line, raw: string) => {
    hits++; const value: unknown = JSON.parse(raw)
    assert.equal(typeof value, 'string', 'The generated own frontmatter field is a JSON string scalar')
    return key + ': ' + JSON.stringify(change(value as string))
  })
  assert.equal(hits, 1, 'Exactly one real generated header field is changed by this negative fixture')
  writeFileSync(path, next)
}
function changeGroup(f: V3Fixture, change: (wire: SyncedGroupWire) => void, rehash = true) {
  const path = groupPath(f), wire = JSON.parse(readFileSync(path, 'utf8')) as SyncedGroupWire
  change(wire)
  const bytes = canonicalSyncedPortableJson(wire)
  writeFileSync(path, bytes)
  if (rehash) changeScalar(indexPath(f), 'syncedGroups', value => JSON.stringify((JSON.parse(value) as Array<{ id: string; recordHash: string }>)
    .map(row => row.id === f.groupId ? { ...row, recordHash: sha256(bytes) } : row)))
}

test('V3 strict reader rejects a missing canonical file and leaves the actual source database unchanged', () => written(f => {
  const before = allTables(f.db)
  rmSync(groupPath(f))
  assert.throws(() => readBackupV3Archive(f.destination))
  assert.deepEqual(allTables(f.db), before)
}))

test('V3 strict reader rejects extra version metadata instead of silently accepting a V2 rotation sidecar', () => written(f => {
  writeFileSync(join(f.destination, '__knowbook', 'snapshot.json'), JSON.stringify({ id: randomUUID(), documentCount: 0 }))
  assert.throws(() => readBackupV3Archive(f.destination))
}))

test('V3 strict reader rejects noncanonical group JSON even when the index is updated to its actual new hash', () => written(f => {
  const wire = JSON.parse(readFileSync(groupPath(f), 'utf8')) as SyncedGroupWire
  const bytes = JSON.stringify(wire, null, 2)
  writeFileSync(groupPath(f), bytes)
  changeScalar(indexPath(f), 'syncedGroups', value => JSON.stringify((JSON.parse(value) as Array<{ id: string; recordHash: string }>)
    .map(row => row.id === f.groupId ? { ...row, recordHash: sha256(bytes) } : row)))
  assert.throws(() => readBackupV3Archive(f.destination))
}))

test('V3 strict reader rejects a rehashed malformed complete binding Key rather than trusting the index hash', () => written(f => {
  changeGroup(f, wire => { wire.bindings[0].from++ })
  assert.throws(() => readBackupV3Archive(f.destination))
}))

test('V3 strict reader rejects unknown GroupWire fields after exact rehashing', () => written(f => {
  changeGroup(f, wire => { Object.assign(wire, { sourceRevision: randomUUID() }) })
  assert.throws(() => readBackupV3Archive(f.destination))
}))

test('V3 strict reader rejects an instance dependency with a different original source revision', () => written(f => {
  changeScalar(indexPath(f), 'syncedInstances', value => JSON.stringify((JSON.parse(value) as Array<{ sourceGroupRevision: string }>)
    .map(row => ({ ...row, sourceGroupRevision: randomUUID() }))))
  assert.throws(() => readBackupV3Archive(f.destination))
}))

test('V3 strict reader rejects false missing declarations for a truly live ordinary document', () => written(f => {
  changeScalar(indexPath(f), 'syncedMissingReferences', value => {
    const missing = JSON.parse(value) as { documentIds: string[] }
    return JSON.stringify({ ...missing, documentIds: [...missing.documentIds, f.targetId].sort() })
  })
  assert.throws(() => readBackupV3Archive(f.destination))
}))

test('V3 strict reader rejects a mixed snapshot rather than normalizing or downgrading the complete archive', () => written(f => {
  changeScalar(indexPath(f), 'backupSnapshotId', () => randomUUID())
  assert.throws(() => readBackupV3Archive(f.destination))
}))

test('V3 strict reader rejects duplicate own frontmatter keys from actual directory bytes', () => written(f => {
  const path = indexPath(f), source = readFileSync(path, 'utf8')
  writeFileSync(path, source.replace(/^backupFormatVersion: ([^\r\n]+)$/m, line => line + '\n' + line))
  assert.throws(() => readBackupV3Archive(f.destination))
}))

test('V3 strict reader rejects either missing same-hash asset alias instead of treating the first alias as sufficient', () => withV3Fixture(async f => {
  const added = await addV3Assets(f)
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(f.destination)
  assert.equal(archive.assets.length, 2)
  const second = archive.assets.find(asset => asset.name === added.attachments[1].name)
  assert.ok(second, 'The independent original second alias is actually present before corruption')
  rmSync(join(f.destination, ...second.relativePath.split('/')))
  assert.throws(() => readBackupV3Archive(f.destination))
}))

test('V3 strict reader rejects actual damaged asset bytes without changing the source or rewriting the damaged archive', () => withV3Fixture(async f => {
  await addV3Assets(f)
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(f.destination), path = join(f.destination, ...archive.assets[0].relativePath.split('/'))
  writeFileSync(path, Buffer.from('wrong actual bytes'))
  const before = fileInventory(f.destination), tables = allTables(f.db)
  assert.throws(() => readBackupV3Archive(f.destination))
  assert.deepEqual(fileInventory(f.destination), before)
  assert.deepEqual(allTables(f.db), tables)
}))

test('V3 directory reader enforces the original per-content-file five MiB budget before interpreting a group JSON file', () => written(f => {
  const path = groupPath(f)
  truncateSync(path, 5 * 1024 * 1024 + 1)
  assert.throws(() => readBackupV3Archive(f.destination), /content budget/)
}))

test('V3 directory reader enforces the original per-asset fifty MiB budget rather than a protocol network budget', () => written(f => {
  const folder = join(f.destination, '__knowbook', 'assets', 'attachments', '00', '0'.repeat(64))
  mkdirSync(folder, { recursive: true })
  const path = join(folder, 'over-budget.bin')
  writeFileSync(path, '')
  truncateSync(path, 50 * 1024 * 1024 + 1)
  assert.throws(() => readBackupV3Archive(f.destination), /asset budget/)
}))

test('V3 write-once writer rejects an existing destination and preserves its original bytes without claiming exposure', () => withV3Fixture(f => {
  mkdirSync(f.destination)
  writeFileSync(join(f.destination, 'existing.txt'), 'pre-existing independent bytes')
  const files = fileInventory(f.destination), tables = allTables(f.db)
  assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() }))
  assert.deepEqual(fileInventory(f.destination), files)
  assert.deepEqual(allTables(f.db), tables)
}))

test('V3 claim SQL failure leaves zero external directory and restores all database rows', () => withV3Fixture(f => {
  f.db.exec("CREATE TEMP TRIGGER v3_test_claim_failure BEFORE INSERT ON synced_exposure_attempts BEGIN SELECT RAISE(ABORT,'real v3 claim failure'); END")
  const before = allTables(f.db)
  assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() }))
  assert.equal(existsSync(f.destination), false)
  assert.deepEqual(allTables(f.db), before)
}))

test('V3 confirmation SQL failure keeps a strict readable complete archive and the original durable possible fact', () => withV3Fixture(f => {
  f.db.exec("CREATE TEMP TRIGGER v3_test_confirm_failure BEFORE UPDATE OF state ON synced_exposure_attempts WHEN NEW.state='confirmed' BEGIN SELECT RAISE(ABORT,'real v3 confirm failure'); END")
  const snapshotId = randomUUID()
  assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId }))
  assert.equal(readBackupV3Archive(f.destination).manifest.snapshotId, snapshotId)
  const rows = f.db.prepare('SELECT state FROM synced_exposure_attempts').all() as Array<{ state: string }>
  assert.deepEqual(rows, [{ state: 'possible' }])
}))
