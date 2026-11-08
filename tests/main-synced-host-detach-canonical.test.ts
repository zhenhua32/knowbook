import assert from 'node:assert/strict'
import test from 'node:test'
import { hostDetachOriginalsFromRaw } from '../src/main/database/restore-knowledge-host-detach-original'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { resolveSyncedCanonicalBlockAddress } from '../src/main/database/synced-canonical-block-navigation'
import { formatSyncedCanonicalBlockAddress } from '../src/shared/synced-canonical-block-address'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import type { SyncedStructureApplied, SyncedStructureInput } from '../src/shared/synced-blocks'
import { decodedCapsule2Table, withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { allTables, createRequest, freshBlock, randomUUID, snapshot, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { command } from './helpers/synced-host-command-insert-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { request, restoreInput, totalChanges } from './helpers/synced-host-final-fixture'

const body = (destination: string) => `[原外组块](${destination} "保留标题")`
const wiki = (destination: string, alias?: string) => `[[${destination}${alias === undefined ? '' : '|' + alias}]]`

function prepare(f: V3Fixture, useLaterChild = false) {
  const document = (title: string) => {
    const id = f.store.createDocument(null)
    f.store.updateDocument(id, { title, summary: '', blocks: [freshBlock(randomUUID(), title)] })
    return id
  }
  const targetHost = document('Canonical target host'), sourceHost = document('Canonical link source')
  const destination = document('Canonical link receiver'), sender = Object.freeze({ frame: 'cross-group detach test' })
  const open = (documentId: string) => {
    const opened = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: documentId })
    if (opened.status !== 'ready') throw Error('Expected an actual editing session for the host')
    return opened.session.sessionId
  }
  const apply = (documentId: string, input: SyncedStructureInput) => f.store.invokeSyncedEditingSession(sender, {
    sessionId: open(documentId), method: 'applySyncedHostStructure', input
  })
  const create = (documentId: string, blockId: string, content: string) => {
    const input = createRequest(f.db, { documentId, selectedRootIds: [blockId], dirty(working) {
      working.blocks.push(freshBlock(blockId, content))
    } })
    const ack = apply(documentId, input)
    if (ack.status !== 'applied' || !('createdLifecycle' in ack)) throw Error('Expected an actual group create: ' + JSON.stringify(ack))
    return { input, ack }
  }
  const initialId = randomUUID(), targetCreate = create(targetHost, initialId, 'True initial canonical target')
  const targetGroup = targetCreate.input.action.groupId
  const targetId = useLaterChild ? randomUUID() : initialId
  if (useLaterChild) {
    const initial = snapshot(f.db, targetGroup)
    editCreatedGroup(f.db, targetGroup, [...syncedCanonicalEdits(initial.blocks), freshBlock(targetId, 'Real child added after create')])
  }
  const target = snapshot(f.db, targetGroup), targetBlock = target.blocks.find(block => block.id === targetId)
  assert.ok(targetBlock)
  assert.equal(target.instances.length, 1)
  const address = { groupId: target.groupId, creationId: target.creationId, groupCreatedAt: target.createdAt,
    blockId: targetBlock.id, blockCreatedAt: targetBlock.createdAt }

  const originalUrl = '#^' + targetId
  const linkId = randomUUID(), sourceCreate = create(sourceHost, linkId,
    [body(originalUrl), wiki(originalUrl, '  保留别名 '), wiki(originalUrl)].join(' '))
  const groupId = sourceCreate.input.action.groupId
  assert.deepEqual(snapshot(f.db, groupId).bindings.map(binding => binding.target),
    Array.from({ length: 3 }, () => ({ kind: 'block', id: targetId, documentId: null, state: 'live' })), 'Main captured the other actual canonical owner')
  const insert = command(f.db, { documentId: destination, groupId })
  assert.equal(apply(destination, insert).status, 'applied')
  const detachInput = (): SyncedStructureInput => {
    const { hostsWorkingBefore, groups, expectedInstances } = request(f.db, [destination])
    return { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore, groups, expectedInstances,
      action: { kind: 'detach', groupId, instanceId: insert.action.instanceId } }
  }
  const restore = (result: SyncedStructureApplied, direction: 'undo' | 'redo') => f.store.invokeSyncedEditingSession(sender, {
    sessionId: open(destination), method: 'restoreSyncedHostOperation', input: restoreInput(f.db, result, direction)
  })
  return { address, target, targetCreate, targetHost, sourceHost, destination, groupId, instanceId: insert.action.instanceId,
    linkId, apply, detachInput, restore }
}

test('detach preserves the stable external canonical address and proves the target creation after true inverse and instance ambiguity', () => withV3Fixture(async f => {
  const actual = prepare(f), sourceBefore = snapshot(f.db, actual.groupId), input = actual.detachInput()
  const originalHost = f.store.getDocumentDetail(actual.sourceHost)
  const ack = actual.apply(actual.destination, input)
  if (ack.status !== 'applied') throw Error('Expected a detached copy of the originally bound canonical destination: ' + JSON.stringify(ack))
  const copiedId = ack.blockIdMap.find(item => item.from === actual.linkId)?.to
  assert.ok(copiedId && copiedId !== actual.linkId)
  const uri = formatSyncedCanonicalBlockAddress(actual.address)
  const expected = [body(uri), wiki(uri, '  保留别名 '), wiki(uri, '#^' + actual.address.blockId)].join(' ')
  assert.equal(ack.hosts[0].after.blocks.find(block => block.id === copiedId)?.content, expected)
  const navigation = resolveSyncedCanonicalBlockAddress(f.db, uri)
  if (navigation.status !== 'ready') throw Error('The real unique destination must resolve: ' + JSON.stringify(navigation))
  assert.equal(navigation.occurrence.instanceId, actual.targetCreate.input.action.instanceId)
  assert.equal(navigation.occurrence.canonicalBlockId, actual.address.blockId)
  assert.equal(f.store.resolveWorkspaceSearchOccurrence(navigation.occurrence).status, 'ready')

  const sourceAfter = snapshot(f.db, actual.groupId)
  assert.deepEqual(sourceAfter.blocks, sourceBefore.blocks)
  assert.deepEqual(sourceAfter.bindings, sourceBefore.bindings)
  assert.equal(sourceAfter.revision, sourceBefore.revision)
  assert.deepEqual(sourceAfter.instances, sourceBefore.instances.filter(instance => instance.instanceId !== actual.instanceId))
  assert.deepEqual(snapshot(f.db, actual.target.groupId), actual.target)
  assert.deepEqual(f.store.getDocumentDetail(actual.sourceHost), originalHost)

  assert.equal(actual.restore(ack, 'undo').status, 'applied')
  assert.equal(actual.restore(ack, 'redo').status, 'applied')
  assert.equal(f.store.getDocumentDetail(actual.destination)?.blocks.find(block => block.id === copiedId)?.content, expected)
  assert.deepEqual(snapshot(f.db, actual.target.groupId), actual.target)
  assert.equal(actual.restore(ack, 'undo').status, 'applied')

  const second = command(f.db, { documentId: actual.targetHost, groupId: actual.target.groupId })
  assert.equal(actual.apply(actual.targetHost, second).status, 'applied')
  assert.equal(snapshot(f.db, actual.target.groupId).instances.length, 2)
  assert.deepEqual(resolveSyncedCanonicalBlockAddress(f.db, uri), { status: 'ambiguous-instance' })
  const before = allTables(f.db), changes = totalChanges(f.db)
  const redo = actual.restore(ack, 'redo')
  assert.ok(redo.status === 'unsupported' || redo.status === 'conflict', JSON.stringify(redo))
  assert.deepEqual(allTables(f.db), before)
  assert.equal(totalChanges(f.db), changes)
  assert.deepEqual(actual.apply(actual.destination, actual.detachInput()), { status: 'unsupported', reason: 'semantic-binding' })
  assert.deepEqual(allTables(f.db), before)
  assert.equal(totalChanges(f.db), changes)

  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const history = readRawCapsule2HistoricalEvidenceOwned(db)
    const fact = history.legacyFacts.find(item => item.family === 'host-detach-ack' && item.locator.key[0] === input.clientOperationId)
    assert.ok(fact)
    assert.ok(fact.supports.some(item => item.table === 'synced_operations' && item.key[0] === actual.targetCreate.input.clientOperationId))
    assert.ok(fact.supports.some(item => item.table === 'synced_host_history' && item.key[0] === actual.targetCreate.ack.historyToken))
    const raw = readRawCapsule2ContentOwned(db), operations = decodedCapsule2Table(raw, 'synced_operations')
    const operation = operations.find(row => row.client_operation_id === input.clientOperationId)!
    const original = hostDetachOriginalsFromRaw(raw)(operation)
    assert.equal(original.result.hosts[0].after.blocks.find(block => block.id === copiedId)?.content, expected)
    const withoutTargetCreate = { ...raw, tables: raw.tables.map(table => table.name !== 'synced_operations' ? table :
      { ...table, rows: table.rows.filter((_row, index) => operations[index].client_operation_id !== actual.targetCreate.input.clientOperationId) }) }
    assert.throws(() => hostDetachOriginalsFromRaw(withoutTargetCreate)(operation))
    assert.equal(totalChanges(db), 0)
  })())
}))

test('detach rejects a real live external canonical child introduced after the target group create and makes no SQLite changes', () => withV3Fixture(f => {
  const actual = prepare(f, true), input = actual.detachInput()
  const before = allTables(f.db), changes = totalChanges(f.db)
  assert.deepEqual(actual.apply(actual.destination, input), { status: 'unsupported', reason: 'semantic-binding' })
  assert.deepEqual(allTables(f.db), before)
  assert.equal(totalChanges(f.db), changes)
}))
