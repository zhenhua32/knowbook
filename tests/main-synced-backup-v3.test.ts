import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { SyncedCanonicalWire } from '../src/shared/synced-blocks'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { getSyncedCreateRestoreContext } from '../src/main/database/synced-host-final'
import { command, insertAck, applySyncedHostCommand } from './helpers/synced-host-command-insert-fixture'
import { withV3Fixture, snapshot, oldChildId, randomUUID, sha256, fileInventory, addV3Assets,
  makeV3Orphan, createRestoreInput, restoreSyncedHostOperation, allTables } from './helpers/synced-backup-v3-fixture'

test('V3 true Main create and complete database export roundtrip preserve raw canonical identity, birth, Origin, full Key and catalog values', () => withV3Fixture(f => {
  const before = snapshot(f.db, f.groupId), snapshotId = randomUUID()
  const expectedWire = { kind: 'synced-group', id: before.groupId, creationId: before.creationId, createdAt: before.createdAt,
    origin: before.origin, bindings: before.bindings, blocks: before.blocks }
  const result = writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId })
  assert.equal(result.documents, f.sourceDocumentIds.length)
  assert.equal(result.groups, 1)
  const archive = readBackupV3Archive(f.destination), group = archive.groups.find(row => row.wire.id === f.groupId)
  assert.ok(group, 'The strict whole-directory reader includes the group created by the actual Main writer')
  assert.deepEqual(group.wire, expectedWire)
  assert.equal(group.sourceRevision, before.revision)
  assert.equal(group.wire.blocks[0].id, oldChildId)
  assert.equal(group.wire.blocks[0].createdAt, f.sourceBirth)
  assert.equal(group.wire.bindings.length, 1)
  assert.equal(group.wire.bindings[0].blockId, oldChildId)
  assert.equal(group.wire.bindings[0].raw, 'V3%20Target.md#target-heading')
  assert.equal(group.wire.bindings[0].target.kind, 'heading')
  assert.equal(archive.manifest.snapshotId, snapshotId)
  assert.deepEqual([...archive.manifest.documentIds].sort(), [...f.sourceDocumentIds].sort())
  assert.equal(archive.catalog.id, f.catalogId)
  const host = archive.documents.find(row => row.id === f.hostId)
  assert.ok(host, 'The actual host is present as a structural reference document')
  assert.equal(host.documentDatabaseFieldValues[f.catalogColumn.id], 'catalog actual value')
  const custom = archive.standaloneDatabases.find(row => row.id === f.customId)
  assert.ok(custom, 'The independent custom source is included without same-name substitution')
  assert.equal(custom.description, 'The literal knowbook-asset:// text is opaque')
  assert.equal(custom.savedViews[0].config.query, 'literal file:///opaque/config and knowbook-asset://not-a-semantic-asset')
  assert.equal(custom.entities[0].documentId, null)
  assert.equal(custom.entities[0].fieldValues[f.customColumn.id], 'original custom value')
  const groupBytes = readFileSync(join(f.destination, '__knowbook', 'synced', 'group-' + sha256(f.groupId) + '.json'))
  assert.equal(groupBytes.toString('utf8'), canonicalSyncedPortableJson(expectedWire))
  const declared = archive.manifest.syncedGroups.find(row => row.id === f.groupId)
  assert.ok(declared, 'The index authenticates the exact original group incarnation and raw portable bytes')
  assert.equal(declared.recordHash, sha256(groupBytes))
  assert.deepEqual(archive.manifest.syncedInstances, [{ id: f.instanceId, ownerDocumentId: f.hostId,
    groupId: f.groupId, sourceGroupRevision: before.revision, sourceGroupHash: sha256(groupBytes) }])
  assert.equal(existsSync(join(f.destination, '__knowbook', 'snapshot.json')), false)
  assert.ok(fileInventory(f.destination).every(row => !/operations|credentials|journal|spool/.test(row.path)),
    'No private executable or recovery metadata is placed in the semantic V3 archive')
}))

test('V3 real orphan export keeps its canonical file and declares the truly missing original first instance', () => withV3Fixture(f => {
  makeV3Orphan(f)
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(f.destination)
  assert.equal(archive.groups.length, 1)
  assert.equal(archive.groups[0].wire.origin.firstInstanceId, f.instanceId)
  assert.equal(archive.manifest.syncedInstances.length, 0)
  assert.deepEqual(archive.manifest.syncedMissingReferences.instanceIds, [f.instanceId])
  assert.equal(archive.manifest.syncedMissingReferences.blockIds.includes(oldChildId), false)
}))

test('V3 real Main insert exports two actual occurrences with one canonical group and exact per-host dependencies', () => withV3Fixture(f => {
  const input = command(f.db, { documentId: f.targetId, groupId: f.groupId })
  insertAck(applySyncedHostCommand(f.db, input))
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(f.destination)
  assert.equal(archive.groups.length, 1)
  const expected = [{ id: f.instanceId, ownerDocumentId: f.hostId }, { id: input.action.instanceId, ownerDocumentId: f.targetId }]
    .sort((a, b) => a.ownerDocumentId < b.ownerDocumentId ? -1 : a.ownerDocumentId > b.ownerDocumentId ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  assert.deepEqual(archive.manifest.syncedInstances.map(row => ({ id: row.id, ownerDocumentId: row.ownerDocumentId })), expected)
  assert.ok(archive.manifest.syncedInstances.every(row => row.groupId === f.groupId
    && row.sourceGroupHash === archive.manifest.syncedGroups[0].recordHash), 'Both real occurrences bind the one exact exported canonical record')
}))

test('V3 real attachments include both same-hash aliases through cross-block reference and named note semantics with exact portable binding shifts', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), before = snapshot(f.db, added.groupId)
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(f.destination), group = archive.groups.find(row => row.wire.id === added.groupId)
  assert.ok(group, 'The actual asset-bearing Main-created group is exported')
  assert.equal(archive.assets.length, 2)
  assert.deepEqual(archive.assets.map(asset => asset.name).sort(), added.attachments.map(asset => asset.name).sort())
  for (const asset of archive.assets) {
    assert.equal(asset.hash, added.hash)
    assert.deepEqual(Buffer.from(asset.bytes), added.bytes)
    assert.deepEqual(readFileSync(join(f.destination, ...asset.relativePath.split('/'))), added.bytes)
  }
  assert.equal(group.wire.blocks.some(block => block.content.includes('file:')), true,
    'Opaque code text remains a file-like literal without becoming an attachment')
  assert.equal(group.wire.blocks.some(block => block.content.includes('knowbook-asset://' + added.hash)), true)
  assert.equal(group.wire.blocks.some(block => block.content.includes(added.attachments[0].url)), false)
  assert.equal(group.wire.blocks.some(block => block.content.includes(added.attachments[1].url)), false)
  const host = archive.documents.find(document => document.id === f.hostId)
  assert.ok(host, 'The real Main saved the asset-bearing host summary outside the canonical group')
  assert.ok(host.summary.includes('knowbook-asset://' + added.hash), 'The typed summary asset is portable after independent archive reading')
  for (const binding of group.wire.bindings) {
    const block: SyncedCanonicalWire | undefined = group.wire.blocks.find(row => row.id === binding.blockId)
    assert.ok(block, 'Every exported complete binding Key belongs to an actual canonical child')
    assert.equal(block.content.slice(binding.from, binding.to), binding.raw)
  }
  const previousKey = before.bindings.find(binding => binding.blockId === added.ids[3])
  const finalKey = group.wire.bindings.find(binding => binding.blockId === added.ids[3])
  assert.ok(previousKey && finalKey, 'The real navigation Key following a localized attachment is present on both sides')
  const finalContent = group.wire.blocks.find(block => block.id === added.ids[3])!.content
  assert.equal(finalKey.from, finalContent.indexOf('[target](') + '[target]('.length)
  assert.equal(finalKey.to, finalKey.from + finalKey.raw.length)
  assert.deepEqual(finalKey.target, previousKey.target)
  assert.equal(finalKey.raw, 'V3%20Target.md#target-heading')
  assert.deepEqual(group.wire.blocks.map(block => [block.id, block.createdAt]), before.blocks.map(block => [block.id, block.createdAt]))
}))

test('V3 read-only inspection has no database or filesystem mutation and keeps source CAS and history unchanged', () => withV3Fixture(f => {
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const tables = allTables(f.db), files = fileInventory(f.destination), group = snapshot(f.db, f.groupId)
  readBackupV3Archive(f.destination)
  readBackupV3Archive(f.destination)
  assert.deepEqual(allTables(f.db), tables)
  assert.deepEqual(fileInventory(f.destination), files)
  assert.deepEqual(snapshot(f.db, f.groupId), group)
}))

test('V3 export commits real exposure and prevents create inverse without replacing the original Main ACK', () => withV3Fixture(f => {
  const operationBefore = f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId)
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const member = f.db.prepare(`SELECT a.id,a.state,a.channel,m.group_id FROM synced_exposure_attempts a
    JOIN synced_group_exposure_members m ON m.attempt_id=a.id WHERE m.group_id=?`).all(f.groupId) as Array<{ id: string; state: string; channel: string; group_id: string }>
  assert.equal(member.length, 1)
  assert.ok(member[0].state === 'possible' || member[0].state === 'confirmed', 'The actual archive has an irreversible durable exposure member')
  const context = getSyncedCreateRestoreContext(f.db, { historyToken: f.created.historyToken, direction: 'undo' })
  assert.equal(context.status, 'unavailable')
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId), operationBefore)
}))

test('V3 real create Undo first leaves no exported group or empty group exposure attempt', () => withV3Fixture(f => {
  const restore = createRestoreInput(f.db, f.created, 'undo')
  const ack = restoreSyncedHostOperation(f.db, restore.input)
  assert.equal(ack.status, 'applied')
  const before = f.db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all()
  const result = writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  assert.equal(result.groups, 0)
  const archive = readBackupV3Archive(f.destination)
  assert.deepEqual(archive.groups, [])
  assert.deepEqual(archive.manifest.syncedGroups, [])
  assert.deepEqual(archive.manifest.syncedInstances, [])
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all(), before)
}))
