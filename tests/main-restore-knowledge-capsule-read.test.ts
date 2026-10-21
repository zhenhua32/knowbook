import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { copyRestoreInventory, restoreInventory } from '../src/main/database/restore-safety-files'
import { prepareDurableSqlCapsuleOriginal, readOwnedRawCapsuleOriginal, readDurableSqlCapsuleSeal,
  type OwnedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { certifyDurableSqlCapsuleOriginal, certifyDurableSqlCapsuleIfSupported, diagnoseCertifiedDurableSqlCapsule,
  readCertifiedDurableSqlCapsule, type CertifiedDurableSqlCapsule } from '../src/main/database/restore-knowledge-capsule-read'
import { readRawRestoreSqlInventoryOwned } from '../src/main/database/restore-knowledge-sql-inventory'
import { readSyncedPublicationCapture, type SyncedPublicationCapture } from '../src/main/database/synced-publication'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { advanceSyncedRecoveryEpoch } from '../src/main/database/synced-recovery-boundary'
import { withV3Fixture, type V3Fixture, request, applied, applySyncedHostFinal } from './helpers/synced-backup-v3-fixture'
import { withControlledRestore, restoreKnowbookDatabase, noProcesses, assertOriginals, files, digest } from './helpers/controlled-restore-fixture'
import { withDeletionPrimer, completed, encode, hash } from './helpers/synced-exchange-tombstone-primer-fixture'

async function original(f: Pick<V3Fixture, 'userDataRoot' | 'file'>, label = 'source') {
  const recoveryDirectory = join(f.userDataRoot, 'backups', 'database-restore', randomUUID())
  await mkdir(recoveryDirectory, { recursive: true })
  const sealedDirectory = join(recoveryDirectory, 'sealed')
  const inventory = await restoreInventory(dirname(f.file))
  await copyRestoreInventory(dirname(f.file), sealedDirectory, inventory, f.userDataRoot)
  const handle = await prepareDurableSqlCapsuleOriginal({ profileRoot: f.userDataRoot, recoveryDirectory,
    sealedDirectory, capsuleId: randomUUID(), label })
  return { handle, sealedDirectory, inventory, recoveryDirectory }
}

test('durable SQL capsule certifies two non-equal real Main originals and preserves later V3 exposure without authorizing installation', async () => withV3Fixture(async f => {
  const source = await original(f), sourceHandle = await certifyDurableSqlCapsuleOriginal(source.handle)
  const old = await readCertifiedDurableSqlCapsule(sourceHandle)
  assert.ok(old.facts.some(fact => fact.family === 'host-create-ack'))
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  applied(applySyncedHostFinal(f.db, request(f.db, [f.hostId], sides => { sides[0].blocks[0].content += ' later actual Main edit' })))
  const current = await original(f, 'current'), currentHandle = await certifyDurableSqlCapsuleOriginal(current.handle)
  const next = await readCertifiedDurableSqlCapsule(currentHandle)
  assert.notEqual(old.manifestHash, next.manifestHash)
  assert.notEqual(old.manifest.workspaceHash, next.manifest.workspaceHash)
  assert.ok(next.facts.some(fact => fact.family === 'backup-v3'))
  assert.equal(old.facts.some(fact => fact.family === 'backup-v3'), false)
  assert.equal((await readCertifiedDurableSqlCapsule(sourceHandle)).manifestHash, old.manifestHash,
    'Later live writes do not rewrite or invalidate a distinct sealed historical original')
  assert.deepEqual(await restoreInventory(source.sealedDirectory), source.inventory)
  assert.deepEqual(await restoreInventory(current.sealedDirectory), current.inventory)
  const diagnostic = await diagnoseCertifiedDurableSqlCapsule(currentHandle)
  assert.equal(diagnostic.certifiedForInstallation, false)
  assert.ok(Object.isFrozen(diagnostic) && Object.isFrozen(next.facts) && Object.isFrozen(next.manifest))
  assert.equal(readSyncedPublicationCapture(currentHandle as unknown as SyncedPublicationCapture), null)
  await assert.rejects(readCertifiedDurableSqlCapsule(diagnostic as unknown as CertifiedDurableSqlCapsule), /句柄/)
}))

test('independent real Main workspace scopes and incarnations can each be certified without a source/current equality condition', () => withV3Fixture(source => withV3Fixture(async current => {
  const a = await original(source), b = await original(current, 'current')
  const first = await readCertifiedDurableSqlCapsule(await certifyDurableSqlCapsuleOriginal(a.handle))
  const second = await readCertifiedDurableSqlCapsule(await certifyDurableSqlCapsuleOriginal(b.handle))
  assert.notEqual(first.manifest.workspaceScope, second.manifest.workspaceScope)
  assert.notEqual(first.manifest.recoveryEpoch, second.manifest.recoveryEpoch)
  assert.notEqual(source.groupId, current.groupId)
  assert.notEqual(first.manifestHash, second.manifestHash)
  assert.ok(first.facts.some(fact => fact.family === 'host-create-ack'))
  assert.ok(second.facts.some(fact => fact.family === 'host-create-ack'))
})))

test('durable SQL certification authenticates the original recovery marker, archive and retained full-row supports after later writes', async () => withV3Fixture(async f => {
  const state = f.db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state').get() as { workspace_scope: string; recovery_epoch: string }
  f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, { operationId: randomUUID(), expectedWorkspaceScope: state.workspace_scope,
    expectedRecoveryEpoch: state.recovery_epoch, workspaceScope: state.workspace_scope, recoveryEpoch: randomUUID(),
    acceptedAt: '2041-01-01T00:00:00.000Z', documentBoundary: '2041-01-01T00:00:00.000Z' })).immediate()
  applied(applySyncedHostFinal(f.db, request(f.db, [f.hostId], sides => { sides[0].blocks[0].content += ' new branch' })))
  const input = await original(f), seal = await readCertifiedDurableSqlCapsule(await certifyDurableSqlCapsuleOriginal(input.handle))
  const boundary = seal.facts.find(fact => fact.family === 'recovery-boundary')
  assert.ok(boundary && boundary.supports.some(row => row.table === 'synced_host_history'))
  assert.ok(seal.facts.some(fact => fact.family === 'recovery-epoch'))
  assert.deepEqual(await restoreInventory(input.sealedDirectory), input.inventory)
}))

test('a genuine raw-original handle and a caller-built serializable artifact cannot be replayed as certification', async () => withV3Fixture(async f => {
  const input = await original(f)
  await assert.rejects(readCertifiedDurableSqlCapsule(input.handle as unknown as CertifiedDurableSqlCapsule), /句柄/)
  await assert.rejects(certifyDurableSqlCapsuleOriginal({ kind: 'owned-raw-capsule-original' } as OwnedRawCapsuleOriginal), /句柄/)
  await assert.rejects(readDurableSqlCapsuleSeal(input.handle), /没有已完成/)
  assert.deepEqual(await restoreInventory(input.sealedDirectory), input.inventory)
}))

test('unknown dormant historical operation and protocol metadata are refused instead of being certified by their hashes', async () => withV3Fixture(async f => {
  const input = await original(f), info = readOwnedRawCapsuleOriginal(input.handle)
  // Corrupt the real input and then prepare a new genuine owner; this is not a
  // caller DTO injected into the certifier or a change to its readonly scratch.
  const db = new Database(join(input.sealedDirectory, 'knowbook.db'))
  try { db.prepare('INSERT INTO synced_operations VALUES(?,?,?,?)').run(randomUUID(), '1'.repeat(64),
    JSON.stringify({ kind: 'unknown-future-operation', version: 999 }), '2041-01-01T00:00:00.000Z') } finally { db.close() }
  const bad = await prepareDurableSqlCapsuleOriginal({ profileRoot: f.userDataRoot, recoveryDirectory: input.recoveryDirectory,
    sealedDirectory: input.sealedDirectory, capsuleId: randomUUID(), label: 'unknown-history' })
  await assert.rejects(certifyDurableSqlCapsuleOriginal(bad), /未知原operation/)
  await assert.rejects(readDurableSqlCapsuleSeal(bad), /没有已完成/)
  assert.equal(info.label, 'source')
  f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('sync.webdav.protocol5.future-v999', '{}', '2041-01-01T00:00:00.000Z')
  const unknownMetadata = await original(f)
  await assert.rejects(certifyDurableSqlCapsuleOriginal(unknownMetadata.handle), /未知.*metadata|metadata.*未知/)
}))

test('every certified use rechecks exact archived originals and manifest bytes without rereading the live current', async () => withV3Fixture(async f => {
  const input = await original(f), handle = await certifyDurableSqlCapsuleOriginal(input.handle)
  const seal = await readCertifiedDurableSqlCapsule(handle)
  await writeFile(seal.manifestPath, (await readFile(seal.manifestPath, 'utf8')) + '\n')
  await assert.rejects(readCertifiedDurableSqlCapsule(handle), /canonical/)
  const another = await original(f), other = await certifyDurableSqlCapsuleOriginal(another.handle)
  const path = join(readOwnedRawCapsuleOriginal(another.handle).originalDirectory, 'knowbook.db')
  const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes)
  await assert.rejects(readCertifiedDurableSqlCapsule(other), /清单或bytes/)
}))

test('raw SQL inventory distinguishes typed original integer and blob bytes and rejects malformed UTF-8 rather than replacement text', async () => withV3Fixture(async f => {
  assert.throws(() => readRawRestoreSqlInventoryOwned(f.db), /事务/)
  const before = f.db.transaction(() => readRawRestoreSqlInventoryOwned(f.db))()
  const position = (f.db.prepare('SELECT sort_order FROM blocks WHERE id=?').get(f.hostBodyId) as { sort_order: number }).sort_order
  f.db.prepare('UPDATE blocks SET sort_order=9223372036854775807 WHERE id=?').run(f.hostBodyId)
  const big = f.db.transaction(() => readRawRestoreSqlInventoryOwned(f.db))()
  f.db.prepare('UPDATE blocks SET sort_order=9223372036854775806 WHERE id=?').run(f.hostBodyId)
  assert.notEqual(f.db.transaction(() => readRawRestoreSqlInventoryOwned(f.db))().inventoryHash, big.inventoryHash,
    'Distinct original 64-bit integers remain distinct beyond JavaScript safe integer precision')
  f.db.prepare('UPDATE blocks SET sort_order=? WHERE id=?').run(position, f.hostBodyId)
  f.db.prepare("INSERT INTO app_settings VALUES('typed-inventory',?,?)").run(Buffer.from([0xff, 0]), '2041-01-01T00:00:00.000Z')
  const blob = f.db.transaction(() => readRawRestoreSqlInventoryOwned(f.db))()
  assert.notEqual(before.inventoryHash, blob.inventoryHash)
  f.db.prepare("UPDATE app_settings SET value=CAST(x'ff' AS TEXT) WHERE key='typed-inventory'").run()
  assert.throws(() => f.db.transaction(() => readRawRestoreSqlInventoryOwned(f.db))(), /非法编码/)
}))

test('typed SQL inventory respects a real UTF-16 database encoding and closes unknown case-variant synced namespace', async () => withV3Fixture(async f => {
  for (const encoding of ['UTF-16le', 'UTF-16be']) {
    const db = new Database(join(f.root, encoding + '.db'))
    try {
      db.pragma("encoding='" + encoding + "'")
      db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);PRAGMA user_version=26')
      db.prepare('INSERT INTO app_settings VALUES(?,?,?)').run('original-encoding', '原始中文字节\ufeff', '2041-01-01T00:00:00.000Z')
      const first = db.transaction(() => readRawRestoreSqlInventoryOwned(db))()
      assert.equal(first.encoding, encoding)
      assert.equal(first.tables[0].rows, 1)
      db.exec('CREATE VIEW SYNCED_unknown_capsule AS SELECT 1')
      assert.throws(() => db.transaction(() => readRawRestoreSqlInventoryOwned(db))(), /未知同步namespace/)
    } finally { db.close() }
  }
}))

test('actual ordinary controlled restore captures independent source/current durable SQL originals while retaining its original receipt gate', async () => withControlledRestore(async f => {
  const before = f.sealCurrent(), result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  const source = JSON.parse(await readFile(join(result.recoveryDirectory, 'source-durable-sql.json'), 'utf8'))
  const current = JSON.parse(await readFile(join(result.recoveryDirectory, 'current-durable-sql.json'), 'utf8'))
  assert.equal(source.status, 'certified'); assert.equal(current.status, 'certified')
  assert.notEqual(source.manifestHash, current.manifestHash)
  assert.equal(source.certifiedForInstallation, false)
  const archived = JSON.parse(await readFile(current.manifestPath, 'utf8'))
  assert.deepEqual(archived.files, files.map(name => {
    const row = before.find(item => item.name === name)
    return { name, present: Boolean(row), bytes: row?.bytes.length ?? 0, sha256: row ? digest(row.bytes) : null }
  }))
  assert.equal(result.continuity, 'ordinary-verified')
  assert.deepEqual(await readFile(f.backup), f.sourceBytes)
  // Existing original archive remains exact even after successful installation.
  assertOriginals(join(result.recoveryDirectory, 'original', 'knowbook.db'), before)
}))

test('schema adapters not implemented for legacy SQL remain explicit unsupported and cannot mint certified empty knowledge', async () => withV3Fixture(async f => {
  const input = await original(f)
  const db = new Database(join(input.sealedDirectory, 'knowbook.db'))
  try { db.pragma('user_version=25') } finally { db.close() }
  const handle = await prepareDurableSqlCapsuleOriginal({ profileRoot: f.userDataRoot, recoveryDirectory: input.recoveryDirectory,
    sealedDirectory: input.sealedDirectory, capsuleId: randomUUID(), label: 'legacy-schema' })
  assert.deepEqual(await certifyDurableSqlCapsuleIfSupported(handle), { status: 'unsupported-schema', schemaVersion: 25 })
  await assert.rejects(readCertifiedDurableSqlCapsule(handle as unknown as CertifiedDurableSqlCapsule), /句柄/)
}))

test('durable SQL capsule certifies actual accepted deletion and exchange history without requiring a removable network spool', async () => withDeletionPrimer(async f => {
  f.remoteFinal(records => {
    const old = records.get('group:' + f.groupId)
    assert.ok(old?.kind === 'synced-group')
    records.set('group:' + f.groupId, { kind: 'synced-group-deleted', id: f.groupId, creationId: old.creationId,
      previousHash: hash(encode(old)), deletedAt: new Date().toISOString() })
  })
  completed(await f.exchange(), 'applied')
  const input = await original({ userDataRoot: f.B.root, file: f.B.file }, 'current-deletion')
  const seal = await readCertifiedDurableSqlCapsule(await certifyDurableSqlCapsuleOriginal(input.handle))
  assert.ok(seal.facts.some(fact => fact.family === 'logical-deletion-proof'))
  assert.ok(seal.facts.some(fact => fact.family === 'exchange-receipt'))
  assert.ok(seal.facts.some(fact => fact.family === 'exchange-job'))
  assert.ok(seal.facts.some(fact => fact.family === 'remote-observation'))
  assert.deepEqual(await restoreInventory(input.sealedDirectory), input.inventory)
}))

for (const side of ['source', 'current'] as const) test(`real maintenance refuses a nonempty ${side} rollback journal before replacing any original`, () => withControlledRestore(async f => {
  const before = f.sealCurrent(), path = (side === 'source' ? f.backup : f.database) + '-journal'
  const bytes = Buffer.from('uninterpreted original rollback journal bytes')
  await writeFile(path, bytes, { flag: 'wx' })
  let replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
    beforeReplace: async () => { replaced = true } }), /rollback journal/)
  assert.equal(replaced, false)
  assertOriginals(f.database, before)
  assert.deepEqual(await readFile(f.backup), f.sourceBytes)
  assert.deepEqual(await readFile(path), bytes)
}))

for (const side of ['source', 'current'] as const) test(`late ${side} capsule manifest tampering rolls back actual maintenance to the exact original three files`, () => withControlledRestore(async f => {
  const before = f.sealCurrent()
  let tampered: string | undefined
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
    beforeReplace: async () => {
      const base = join(f.profile, 'backups', 'database-restore'), entries = await readdir(base)
      assert.equal(entries.length, 1)
      const diagnostic = JSON.parse(await readFile(join(base, entries[0], side + '-durable-sql.json'), 'utf8'))
      tampered = diagnostic.manifestPath
      assert.equal(typeof tampered, 'string')
      await writeFile(tampered!, (await readFile(tampered!, 'utf8')) + '\n')
    } }), /canonical/)
  assert.ok(tampered)
  assertOriginals(f.database, before)
  assert.deepEqual(await readFile(f.backup), f.sourceBytes)
  assert.ok((await readFile(tampered, 'utf8')).endsWith('\n'), 'The invalid artifact is preserved as evidence')
}))

for (const side of ['source', 'current'] as const) test(`a late nonempty ${side} rollback journal blocks installation and preserves its evidence`, () => withControlledRestore(async f => {
  const before = f.sealCurrent(), path = (side === 'source' ? f.backup : f.database) + '-journal'
  const bytes = Buffer.from('late uninterpreted rollback journal')
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
    beforeReplace: async () => { await writeFile(path, bytes, { flag: 'wx' }) } }), /rollback journal/)
  assertOriginals(f.database, before)
  assert.deepEqual(await readFile(f.backup), f.sourceBytes)
  assert.deepEqual(await readFile(path), bytes)
}))

test('a late change to the real external source is refused even when its sealed historical capsule remains intact', () => withControlledRestore(async f => {
  const before = f.sealCurrent(), changed = Buffer.concat([f.sourceBytes, Buffer.from('late source change')])
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
    beforeReplace: async () => { await writeFile(f.backup, changed) } }), /源原三文件.*安装前变化/)
  assertOriginals(f.database, before)
  assert.deepEqual(await readFile(f.backup), changed, 'A failed maintenance operation never overwrites the changed external source')
}))
