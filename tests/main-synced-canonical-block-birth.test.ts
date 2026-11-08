import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSyncedCanonicalBlockBirthOriginalRows, findSyncedCanonicalBlockBirthOwned, readSyncedCanonicalBlockBirthOriginalOwned,
  type SyncedCanonicalBlockBirthOriginalAccess } from '../src/main/database/synced-canonical-block-birth'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import type { Capsule2RawContent } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { headingCreateBirthOriginalsFromRaw2 } from '../src/main/database/restore-knowledge-heading-create-birth-original2'
import type { SyncedCanonicalBlockAddress } from '../src/shared/synced-canonical-block-address'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { decodedCapsule2Table, withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { allTables, applySyncedHostCommand, applySyncedHostFinal, createRequest, created, freshBlock, randomUUID, snapshot, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup, restoreCreated } from './helpers/synced-host-command-create-fixture'
import { request, totalChanges } from './helpers/synced-host-final-fixture'

function stableAddress(f: V3Fixture, groupId: string, blockId: string): SyncedCanonicalBlockAddress {
  const group = snapshot(f.db, groupId), block = group.blocks.find(item => item.id === blockId)
  assert.ok(block)
  return { groupId, creationId: group.creationId, groupCreatedAt: group.createdAt, blockId, blockCreatedAt: block.createdAt }
}

function rawReaders(raw: Capsule2RawContent): SyncedCanonicalBlockBirthOriginalAccess {
  const journals = decodedCapsule2Table(raw, 'synced_host_history'), operations = decodedCapsule2Table(raw, 'synced_operations')
  return {
    journal: id => journals.find(item => item.id === id) as unknown as ReturnType<SyncedCanonicalBlockBirthOriginalAccess['journal']>,
    operation: id => operations.find(item => item.client_operation_id === id) as unknown as ReturnType<SyncedCanonicalBlockBirthOriginalAccess['operation']>,
    headingCreate: headingCreateBirthOriginalsFromRaw2(raw)
  }
}

function createLocal(f: V3Fixture, body: string, headingBirth = false) {
  const sourceId = f.store.createDocument(null), childId = randomUUID()
  f.store.updateDocument(sourceId, { title: headingBirth ? 'Canonical heading proof origin' : 'Canonical plain proof origin',
    summary: '', blocks: [freshBlock(randomUUID(), 'Retained ordinary paragraph')] })
  const input = createRequest(f.db, { documentId: sourceId, selectedRootIds: [childId], dirty(working) {
    working.blocks.push(freshBlock(childId, body))
  } })
  if (!headingBirth) return { input, sourceId, childId, ack: created(applySyncedHostCommand(f.db, input)) }
  const sender = Object.freeze({ frame: 'actual initial canonical child with heading birth envelope' })
  const session = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: sourceId })
  if (session.status !== 'ready') throw Error('Expected an actual fenced host session')
  const result = f.store.invokeSyncedEditingSession(sender, { sessionId: session.session.sessionId, method: 'applySyncedHostStructure', input })
  assert.equal(result.status, 'applied')
  const row = f.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as { result_json: string }
  const ack = created(JSON.parse(row.result_json).result)
  assert.equal(JSON.parse(row.result_json).kind, 'synced-host-create-heading-birth-operation')
  return { input, sourceId, childId, ack }
}

test('canonical birth uses the real original create pair and excludes a later child, including after path and instance changes', () => withV3Fixture(async f => {
  const actual = createLocal(f, 'Original canonical block'), groupId = actual.input.action.groupId
  const address = stableAddress(f, groupId, actual.childId)
  const find = (input = address) => f.db.transaction(() => findSyncedCanonicalBlockBirthOwned(f.db, input))()
  const original = find()
  if (original.status !== 'proved') throw Error('The true native create must prove the selected child birth')
  assert.deepEqual(original.address, address)
  assert.deepEqual(original.original, { operationId: actual.input.clientOperationId, historyToken: actual.ack.historyToken })
  assert.deepEqual(original.supports.map(item => [item.table, item.key[0]]),
    [['synced_operations', actual.input.clientOperationId], ['synced_host_history', actual.ack.historyToken]])
  assert.deepEqual(find({ ...address, creationId: randomUUID() }), { status: 'unsupported', reason: 'target-mismatch' })
  assert.deepEqual(find({ ...address, blockCreatedAt: '2000-01-01T00:00:00.000Z' }), { status: 'unsupported', reason: 'target-mismatch' })

  const later = randomUUID()
  const current = snapshot(f.db, groupId)
  editCreatedGroup(f.db, groupId, [...syncedCanonicalEdits(current.blocks), freshBlock(later, 'Added after initial create')])
  assert.deepEqual(find(stableAddress(f, groupId, later)), { status: 'unsupported', reason: 'not-initial-child' })
  assert.deepEqual(find(), original)

  const originalHostPath = f.store.getDocumentDetail(actual.sourceId)!.path
  const remove = request(f.db, [actual.sourceId], (after, before) => {
    before[0].workingBefore.blocks = before[0].workingBefore.blocks.filter(block => block.id !== actual.input.action.instanceId)
    after[0].blocks = structuredClone(before[0].workingBefore.blocks)
  })
  assert.equal(applySyncedHostFinal(f.db, remove).status, 'applied')
  assert.deepEqual(snapshot(f.db, groupId).instances, [])
  const host = f.store.getDocumentDetail(actual.sourceId)!
  f.store.updateDocument(actual.sourceId, { title: 'Real former host renamed', summary: host.summary, blocks: host.blocks })
  assert.notEqual(f.store.getDocumentDetail(actual.sourceId)?.path, originalHostPath)

  const before = allTables(f.db), changes = totalChanges(f.db)
  assert.deepEqual(find(), original)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    assert.deepEqual(readSyncedCanonicalBlockBirthOriginalOwned(db, address, original.original), original)
    assert.deepEqual(readSyncedCanonicalBlockBirthOriginalOwned(db, address, { ...original.original, historyToken: randomUUID() }),
      { status: 'unsupported', reason: 'missing-provenance' })
    assert.deepEqual(readSyncedCanonicalBlockBirthOriginalOwned(db, address, { ...original.original, operationId: randomUUID() }),
      { status: 'unsupported', reason: 'target-mismatch' })
    const rows = rawReaders(readRawCapsule2ContentOwned(db))
    assert.deepEqual(decodeSyncedCanonicalBlockBirthOriginalRows(address, original.original, rows), original)
    assert.deepEqual(decodeSyncedCanonicalBlockBirthOriginalRows(address, original.original, { ...rows, operation: () => undefined }),
      { status: 'unsupported', reason: 'missing-provenance' })
    const originalRow = rows.operation(original.original.operationId)!
    assert.throws(() => decodeSyncedCanonicalBlockBirthOriginalRows(address, original.original,
      { ...rows, operation: () => ({ ...originalRow, request_hash: '0'.repeat(64) }) }), /回执和实际日志不闭合/)
    assert.equal(totalChanges(db), 0)
  })())
  assert.deepEqual(allTables(f.db), before)
  assert.equal(totalChanges(f.db), changes)
}))

test('the heading-aware original envelope proves its initial canonical block after true create Undo', () => withV3Fixture(async f => {
  const actual = createLocal(f, '[Original external heading](V3%20Target.md#target-heading)', true)
  const address = stableAddress(f, actual.input.action.groupId, actual.childId)
  const initial = f.db.transaction(() => findSyncedCanonicalBlockBirthOwned(f.db, address))()
  if (initial.status !== 'proved') throw Error('Expected the committed heading-aware create original')
  assert.ok(initial.supports.some(item => item.table === 'app_settings'))
  assert.ok(initial.supports.some(item => item.table === 'synced_host_history' && item.key[0] === actual.ack.historyToken))
  restoreCreated(f.db, actual.ack, 'undo')
  assert.ok(f.store.getDocumentDetail(actual.sourceId)?.blocks.some(block => block.id === actual.childId))
  assert.equal(f.db.prepare('SELECT id FROM synced_group_blocks WHERE id=?').get(actual.childId), undefined)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    assert.deepEqual(readSyncedCanonicalBlockBirthOriginalOwned(db, address, initial.original), initial)
    assert.deepEqual(decodeSyncedCanonicalBlockBirthOriginalRows(address, initial.original, rawReaders(readRawCapsule2ContentOwned(db))), initial)
    assert.equal(totalChanges(db), 0)
  })())
}))
