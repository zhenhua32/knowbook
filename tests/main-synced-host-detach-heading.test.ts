import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { allTables, createRequest, freshBlock, randomUUID, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { command } from './helpers/synced-host-command-insert-fixture'
import { request, restoreInput, totalChanges } from './helpers/synced-host-final-fixture'
import { decodedCapsule2Table, withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { hostDetachOriginalsFromRaw } from '../src/main/database/restore-knowledge-host-detach-original'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import type { SyncedStructureInput } from '../src/shared/synced-blocks'
import type { SyncedEditingHostResult } from '../src/shared/synced-editing-session'

function prepare(f: V3Fixture, titleTransition = false) {
  const sender = Object.freeze({ frame: 'detach actual bound heading' })
  const open = (documentId: string) => {
    const opened = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: documentId })
    if (opened.status !== 'ready') throw Error('The actual heading detach host must open')
    return opened.session.sessionId
  }
  const apply = (documentId: string, input: SyncedStructureInput) => f.store.invokeSyncedEditingSession(sender, {
    sessionId: open(documentId), method: 'applySyncedHostStructure', input
  })
  const targetId = titleTransition ? f.store.createDocument(null) : f.targetId
  const targetBlockId = titleTransition ? randomUUID() : f.targetBodyId
  const initialTitle = titleTransition ? 'Detach Heading Target' : 'V3 Target'
  if (titleTransition) f.store.updateDocument(targetId, { title: initialTitle, summary: '',
    blocks: [{ ...freshBlock(targetBlockId, 'Target heading'), type: 'heading-1' }] })
  const link = randomUUID(), body = `[actual original heading](${encodeURIComponent(initialTitle)}.md#target-heading)`
  const create = createRequest(f.db, { documentId: f.hostId, selectedRootIds: [link], dirty(working) { working.blocks.push(freshBlock(link, body)) } })
  const created = apply(f.hostId, create)
  assert.equal(created.status, 'applied')
  const birth = f.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(create.clientOperationId) as { result_json: string }
  assert.equal(JSON.parse(birth.result_json).kind, 'synced-host-create-heading-birth-operation')
  const groupId = create.action.groupId
  const rename = titleTransition ? request(f.db, [targetId], after => { after[0].title = 'Renamed Detach Target' }) : null
  if (rename) {
    writeSyncedBackupV3(f.db, { userDataRoot: realpathSync(f.userDataRoot),
      destination: join(realpathSync(f.root), 'detach-heading-title-initial-publication'), snapshotId: randomUUID() })
    assert.equal(apply(targetId, rename).status, 'applied')
  }
  const folder = f.store.createDocument(null), destination = f.store.createDocument(folder)
  f.store.updateDocument(folder, { title: 'Detach heading folder', summary: '', blocks: [freshBlock(randomUUID(), 'Folder body')] })
  f.store.updateDocument(destination, { title: 'Detach heading destination', summary: '', blocks: [freshBlock(randomUUID(), 'Destination body')] })
  const insert = command(f.db, { documentId: destination, groupId })
  assert.equal(apply(destination, insert).status, 'applied')
  const { hostsWorkingBefore, groups, expectedInstances } = request(f.db, [destination])
  const input: SyncedStructureInput = { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore, groups, expectedInstances,
    action: { kind: 'detach', groupId, instanceId: insert.action.instanceId } }
  return { input, create, destination, link, apply, sender, open, rename, targetBlockId }
}

test('a genuine fresh heading birth survives attaching, detaching, exact inverse and cold historical proof', () => withV3Fixture(async f => {
  const actual = prepare(f), result = actual.apply(actual.destination, actual.input)
  if (result.status !== 'applied') throw Error('The fresh original heading must copy: ' + JSON.stringify(result))
  const copiedId = result.blockIdMap.find(item => item.from === actual.link)?.to
  assert.ok(copiedId)
  const copy = result.hosts[0].after.blocks.find(item => item.id === copiedId)
  assert.equal(copy?.content, '[actual original heading](../V3%20Target.md#target-heading)')
  assert.deepEqual(f.db.prepare('SELECT target_path,fragment FROM markdown_link_sources WHERE source_document_id=? AND source_block_id=?')
    .get(actual.destination, copiedId), { target_path: 'V3 Target', fragment: 'target-heading' })
  const stored = f.db.prepare('SELECT action_json FROM synced_host_history WHERE id=?').get(result.historyToken) as { action_json: string }
  const proof = JSON.parse(stored.action_json).detach.projection.links[0].resolved.heading
  assert.equal(proof.blockId, f.targetBodyId)
  assert.equal(proof.original.operationId, actual.create.clientOperationId)
  for (const direction of ['undo', 'redo'] as const) {
    const inverse: SyncedEditingHostResult = f.store.invokeSyncedEditingSession(actual.sender, { sessionId: actual.open(actual.destination),
      method: 'restoreSyncedHostOperation', input: restoreInput(f.db, result, direction) })
    assert.equal(inverse.status, 'applied')
  }
  assert.equal(f.store.getDocumentDetail(actual.destination)?.blocks.find(item => item.id === copiedId)?.content, copy?.content)
  await withCapsule2RawCopy(f, db => {
    const history = db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))()
    const detach = history.legacyFacts.find(item => item.family === 'host-detach-ack' && item.locator.key[0] === actual.input.clientOperationId)
    assert.ok(detach)
    assert.ok(detach.supports.some(item => item.table === 'synced_operations' && item.key[0] === actual.create.clientOperationId))
    const raw = db.transaction(() => readRawCapsule2ContentOwned(db))()
    const operations = decodedCapsule2Table(raw, 'synced_operations')
    const operation = operations.find(item => item.client_operation_id === actual.input.clientOperationId)!
    const source = hostDetachOriginalsFromRaw(raw)(operation)
    assert.ok(source.headingSources.some(item => item.value.client_operation_id === actual.create.clientOperationId))
    const withoutBirth = { ...raw, tables: raw.tables.map(table => table.name !== 'synced_operations' ? table :
      { ...table, rows: table.rows.filter((_row, index) => operations[index].client_operation_id !== actual.create.clientOperationId) }) }
    assert.throws(() => hostDetachOriginalsFromRaw(withoutBirth)(operation), /original support missing/)
  })
}))

test('a genuine title transition remains the original for copied heading links after a later attach', () => withV3Fixture(async f => {
  const actual = prepare(f, true), result = actual.apply(actual.destination, actual.input)
  if (result.status !== 'applied') throw Error('The title transition heading must copy: ' + JSON.stringify(result))
  const copiedId = result.blockIdMap.find(item => item.from === actual.link)?.to
  assert.ok(copiedId)
  assert.equal(result.hosts[0].after.blocks.find(item => item.id === copiedId)?.content,
    '[actual original heading](../Renamed%20Detach%20Target.md#target-heading)')
  const stored = f.db.prepare('SELECT action_json FROM synced_host_history WHERE id=?').get(result.historyToken) as { action_json: string }
  const proof = JSON.parse(stored.action_json).detach.projection.links[0].resolved.heading
  assert.equal(proof.blockId, actual.targetBlockId)
  assert.equal(proof.original.kind, 'heading-title-transition')
  assert.equal(proof.original.operationId, actual.rename?.clientOperationId)
  await withCapsule2RawCopy(f, db => {
    const history = db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))()
    const detach = history.legacyFacts.find(item => item.family === 'host-detach-ack' && item.locator.key[0] === actual.input.clientOperationId)
    assert.ok(detach)
    for (const predecessor of [actual.create.clientOperationId, actual.rename?.clientOperationId])
      assert.ok(detach.supports.some(item => item.table === 'synced_operations' && item.key[0] === predecessor))
    const raw = db.transaction(() => readRawCapsule2ContentOwned(db))()
    const operation = decodedCapsule2Table(raw, 'synced_operations').find(item => item.client_operation_id === actual.input.clientOperationId)!
    const source = hostDetachOriginalsFromRaw(raw)(operation)
    for (const predecessor of [actual.create.clientOperationId, actual.rename?.clientOperationId])
      assert.ok(source.headingSources.some(item => item.value.client_operation_id === predecessor))
  })
}))

test('a replacement ordinary heading at the original slug cannot authorize detach and leaves zero SQLite changes', () => withV3Fixture(f => {
  const actual = prepare(f), old = f.store.getDocumentDetail(f.targetId)!, replacementId = randomUUID()
  f.store.updateDocument(old.id, { expectedUpdatedAt: old.updatedAt, title: old.title, summary: old.summary,
    blocks: [{ ...freshBlock(replacementId, 'Target heading'), type: 'heading-1' }] })
  assert.equal(f.store.getDocumentDetail(old.id)?.blocks[0].id, replacementId)
  const before = allTables(f.db), changes = totalChanges(f.db)
  assert.deepEqual(actual.apply(actual.destination, actual.input), { status: 'unsupported', reason: 'semantic-binding' })
  assert.deepEqual(allTables(f.db), before)
  assert.equal(totalChanges(f.db), changes)
}))
