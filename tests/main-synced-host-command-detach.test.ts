import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownBackupService, writeBackupSnapshot } from '../src/main/backup/exporter'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { getSyncedOperation } from '../src/main/database/synced-blocks-content'
import { resolveSyncedHeadingAnchor } from '../src/main/database/synced-heading-projection2'
import { SyncedEditingSessionRepository } from '../src/main/database/synced-editing-session'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { a, b, allTables, applySyncedHostCommand, bodyBirth, bodyId, command, freshBlock, groupEdit, groupId, identity,
  instanceId, logical, restoreInput, snapshot, totalChanges, withHostDatabase } from './helpers/synced-host-command-insert-fixture'
import { createRequest, created, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { seedCreateBlocks } from './helpers/synced-host-command-create-fixture'

function detach(db: Database.Database, id = instanceId, sourceGroupId = groupId) {
  const { action: _insert, ...input } = command(db, { groupId: sourceGroupId })
  return { ...input, action: { kind: 'detach' as const, instanceId: id, groupId: sourceGroupId } }
}

function openHost(db: Database.Database, documentId = a) {
  const sessions = new SyncedEditingSessionRepository(db), sender = Object.freeze({ frame: 'detach host' })
  const opened = sessions.open(sender, { kind: 'host', hostDocumentId: documentId })
  assert.ok(opened.status === 'ready')
  return { sessions, sender, sessionId: opened.session.sessionId }
}

function applyDetach(db: Database.Database, input: ReturnType<typeof detach>) {
  const { sessions, sender, sessionId } = openHost(db)
  return sessions.invoke(sender, { sessionId, method: 'applySyncedHostStructure', input })
}

function detachAck(value: ReturnType<typeof applyDetach>) {
  assert.ok(value.status === 'applied' && value.historyToken, JSON.stringify(value))
  return value
}

function restoreDetach(db: Database.Database, input: ReturnType<typeof restoreInput>) {
  const { sessions, sender, sessionId } = openHost(db)
  return sessions.invoke(sender, { sessionId, method: 'restoreSyncedHostOperation', input })
}

function restoreAck(db: Database.Database, ack: ReturnType<typeof detachAck>, direction: 'undo' | 'redo') {
  assert.equal(restoreDetach(db, restoreInput(db, ack, direction)).status, 'applied')
}

test('detaching one exact occurrence copies fresh nested identities and projected link targets with durable Undo and Redo', () => withHostDatabase((db, reopen) => {
  const [root] = syncedCanonicalEdits(snapshot(db).blocks), child = randomUUID()
  groupEdit(db, [{ ...root, type: 'toggle', content: 'Shared parent' }, { ...freshBlock(child,
    `[internal](#^${encodeURIComponent(root.id)}) [outside](../Home/Host%20B.md#^${encodeURIComponent(bodyId(b))})`), parentBlockId: root.id, depth: 1 }])
  const peer = command(db)
  detachAck(applySyncedHostCommand(db, peer))
  const original = snapshot(db), input = detach(db), logicalBefore = logical(db, a)
  input.hostsWorkingBefore[0].workingBefore.blocks.find(block => block.id === bodyId(a))!.content = 'Dirty W text'
  const ack = detachAck(applyDetach(db, input)), [copyRoot, copyChild] = ack.blockIdMap
  assert.deepEqual(ack.blockIdMap.map(item => item.from), [root.id, child])
  assert.notEqual(copyRoot.to, root.id)
  assert.notEqual(copyChild.to, child)
  assert.deepEqual(ack.affectedInstanceIds, [instanceId])
  const detached = logical(db, a), after = snapshot(db), birth = bodyBirth(db, copyChild.to)
  assert.ok(birth)
  assert.deepEqual(after.blocks, original.blocks)
  assert.deepEqual(after.bindings, original.bindings)
  assert.deepEqual(after.instances, original.instances.filter(row => row.instanceId !== instanceId))
  assert.notEqual(after.topologyRevision, original.topologyRevision)
  assert.equal(after.revision, original.revision)
  assert.equal(detached.blocks.find(row => row.id === copyChild.to)?.parentBlockId, copyRoot.to)
  assert.equal(detached.blocks.find(row => row.id === copyChild.to)?.content,
    `[internal](#^${copyRoot.to}) [outside](Host%20B.md#^${encodeURIComponent(bodyId(b))})`)
  assert.equal(detached.blocks.find(row => row.id === bodyId(a))?.content, 'Dirty W text')
  const cold = reopen()
  assert.deepEqual(getSyncedOperation(cold, { clientOperationId: ack.operationId }), { status: 'committed', result: { ...ack, replayed: true } })
  restoreAck(cold, ack, 'undo')
  assert.equal(identity(cold, copyChild.to)?.state, 'retained')
  assert.equal(logical(cold, a).blocks.find(row => row.id === bodyId(a))?.content, 'Dirty W text')
  const restored = snapshot(cold).instances.find(row => row.instanceId === instanceId)
  assert.ok(restored)
  assert.notEqual(restored.bindingVersion, original.instances.find(row => row.instanceId === instanceId)?.bindingVersion)
  assert.deepEqual(logical(cold, a).blocks.map(row => row.id), logicalBefore.blocks.map(row => row.id))
  restoreAck(cold, ack, 'redo')
  assert.deepEqual(logical(cold, a), detached)
  assert.equal(bodyBirth(cold, copyChild.to), birth)
}))

test('detach rejects a stale group guard and a fabricated occurrence without writing', () => withHostDatabase(db => {
  const stale = detach(db)
  groupEdit(db)
  const unchanged = (input: ReturnType<typeof detach>, status: string) => {
    const before = allTables(db), changes = totalChanges(db)
    assert.equal(applyDetach(db, input).status, status)
    assert.equal(totalChanges(db), changes)
    assert.deepEqual(allTables(db), before)
  }
  unchanged(stale, 'conflict')
  unchanged(detach(db, randomUUID()), 'invalid')
}))

test('redo refuses to restore stale ordinary links after their original destination path has changed', () => withHostDatabase(db => {
  groupEdit(db, syncedCanonicalEdits(snapshot(db).blocks).map(block => ({ ...block, content: '[outside](../Home/Host%20B.md)' })))
  const ack = detachAck(applyDetach(db, detach(db)))
  restoreAck(db, ack, 'undo')
  db.prepare('UPDATE documents SET title=?, path=? WHERE id=?').run('Moved B', 'Home/Moved B', b)
  const before = allTables(db), changes = totalChanges(db)
  const redo = restoreDetach(db, restoreInput(db, ack, 'redo'))
  assert.ok(redo.status === 'conflict' && redo.kind === 'history')
  assert.deepEqual(allTables(db), before)
  assert.equal(totalChanges(db), changes)
}))

test('both detach history directions preserve their token after changed group content or users', () => {
  for (const direction of ['undo', 'redo'] as const) for (const dependency of ['content', 'topology'] as const) withHostDatabase(db => {
    detachAck(applySyncedHostCommand(db, command(db, { documentId: b })))
    const ack = detachAck(applyDetach(db, detach(db)))
    if (direction === 'redo') restoreAck(db, ack, 'undo')
    if (dependency === 'content') groupEdit(db)
    else detachAck(applySyncedHostCommand(db, command(db, { documentId: b })))
    const before = allTables(db), changes = totalChanges(db)
    const result = restoreDetach(db, restoreInput(db, ack, direction))
    assert.ok(result.status === 'conflict' && result.kind === (dependency === 'content' ? 'group' : 'topology'))
    assert.deepEqual(allTables(db), before)
    assert.equal(totalChanges(db), changes)
  })
})

test('a pruned detach Redo retains the original journal and full idempotent ACK', () => withHostDatabase(db => {
  const input = detach(db), ack = detachAck(applyDetach(db, input))
  restoreAck(db, ack, 'undo')
  detachAck(applySyncedHostCommand(db, command(db)))
  assert.equal(db.prepare('SELECT 1 FROM synced_host_history_documents WHERE history_id=?').get(ack.historyToken), undefined)
  assert.ok(db.prepare('SELECT 1 FROM synced_host_history WHERE id=?').get(ack.historyToken))
  assert.deepEqual(getSyncedOperation(db, { clientOperationId: ack.operationId }), { status: 'committed', result: { ...ack, replayed: true } })
}))

test('detach preserves the exact same-host section link and duplicate heading order through cold Undo and Redo', () => withHostDatabase((db, reopen) => {
  const heading = randomUUID(), link = randomUUID(), peer = randomUUID(), text = '[section](#shared-section)'
  seedCreateBlocks(db, [{ id: heading, type: 'heading-2', content: 'Shared section' }, { id: link, content: text },
    { id: peer, type: 'heading-2', content: 'Shared section' }])
  const create = createRequest(db, { selectedRootIds: [heading, link] })
  created(applySyncedHostCommand(db, create))
  const lookup = (connection: Database.Database, anchor: string) => resolveSyncedHeadingAnchor(connection, { documentId: a, anchor,
    expectedUpdatedAt: (connection.prepare('SELECT updated_at FROM documents WHERE id=?').get(a) as { updated_at: string }).updated_at, matchText: false })
  const original = lookup(db, 'shared-section')
  assert.ok(original.status === 'ready' && original.kind === 'canonical' && original.occurrence.canonicalBlockId === heading)
  const ack = detachAck(applyDetach(db, detach(db, create.action.instanceId, create.action.groupId)))
  const [headingCopy, linkCopy] = ack.blockIdMap
  assert.equal(headingCopy.from, heading)
  assert.equal(linkCopy.from, link)
  assert.equal(ack.hosts[0].after.blocks.find(block => block.id === linkCopy.to)?.content, text)
  const cold = reopen()
  assert.deepEqual(lookup(cold, 'shared-section'), { status: 'ready', kind: 'ordinary', blockId: headingCopy.to, headingIndex: 0 })
  assert.deepEqual(lookup(cold, 'shared-section-1'), { status: 'ready', kind: 'ordinary', blockId: peer, headingIndex: 0 })
  restoreAck(cold, ack, 'undo')
  const reopened = lookup(cold, 'shared-section')
  assert.ok(reopened.status === 'ready' && reopened.kind === 'canonical' && reopened.occurrence.canonicalBlockId === heading)
  restoreAck(cold, ack, 'redo')
  assert.deepEqual(lookup(cold, 'shared-section'), { status: 'ready', kind: 'ordinary', blockId: headingCopy.to, headingIndex: 0 })
  assert.deepEqual(lookup(cold, 'shared-section-1'), { status: 'ready', kind: 'ordinary', blockId: peer, headingIndex: 0 })
}))

test('detach inverse rejects a later external heading with the same slug and preserves the original receipt', () => withHostDatabase(db => {
  const target = randomUUID(), link = randomUUID(), text = '[external](Host%20B.md#external-section)'
  seedCreateBlocks(db, [{ id: target, type: 'heading-2', content: 'External section' }], b)
  seedCreateBlocks(db, [{ id: link, content: text }])
  const create = createRequest(db, { selectedRootIds: [link] })
  const { sessions, sender, sessionId } = openHost(db)
  const result = sessions.invoke(sender, { sessionId, method: 'applySyncedHostStructure', input: create })
  assert.equal(result.status, 'applied')
  const input = detach(db, create.action.instanceId, create.action.groupId), ack = detachAck(applyDetach(db, input))
  assert.equal(ack.hosts[0].after.blocks.find(block => block.id === ack.blockIdMap[0].to)?.content, text)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Old target has a new name', target)
  seedCreateBlocks(db, [{ id: randomUUID(), type: 'heading-2', content: 'External section' }], b)
  const before = allTables(db), changes = totalChanges(db)
  assert.deepEqual(restoreDetach(db, restoreInput(db, ack, 'undo')), { status: 'unsupported', reason: 'semantic-binding' })
  assert.deepEqual(getSyncedOperation(db, { clientOperationId: ack.operationId }), { status: 'committed', result: { ...ack, replayed: true } })
  assert.deepEqual(allTables(db), before)
  assert.equal(totalChanges(db), changes)
}))

test('actual detach ACK and attachment survive cold Store open, strict history observation and V3 backup', () => withV3Fixture(async f => {
  const bytes = Buffer.from('detached shared image'), [asset] = await f.assets.import([{ name: 'copy image.png', bytes }])
  const id = randomUUID(), create = createRequest(f.db, { documentId: f.hostId, selectedRootIds: [id], dirty(working) {
    working.blocks.push(freshBlock(id, '![shared image](<' + asset.url + '>)'))
  } })
  created(applySyncedHostCommand(f.db, create))
  const { groupId, instanceId } = create.action, sender = Object.freeze({ frame: 'attachment detach' })
  const opened = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: f.hostId })
  assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw new Error('The actual Store must open the host')
  const { action: _insert, ...working } = command(f.db, { documentId: f.hostId, groupId })
  const input = { ...working, action: { kind: 'detach' as const, groupId, instanceId } }
  const ack = f.store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'applySyncedHostStructure', input })
  assert.ok(ack.status === 'applied', JSON.stringify(ack))
  assert.equal(ack.blockIdMap[0].from, id)
  f.close()
  const store = KnowbookStore.openCanonicalRuntime(f.file)
  try {
    const db = store.getUnsafeDatabaseHandle()
    const source = new Database(f.file, { readonly: true, fileMustExist: true })
    source.pragma('query_only=ON'); source.pragma('foreign_keys=ON')
    try {
      const evidence = source.transaction(() => readRawCapsule2HistoricalEvidenceOwned(source))()
      assert.ok(evidence.legacyFacts.some(fact => fact.family === 'host-detach-ack' && fact.version === 1 && fact.locator.key.includes(ack.operationId)))
    } finally { source.close() }
    assert.deepEqual(getSyncedOperation(db, { clientOperationId: ack.operationId }), { status: 'committed', result: { ...ack, replayed: true } })
    const backupRoot = join(f.root, 'detach-backup'), service = new MarkdownBackupService(store, backupRoot, undefined, async job => writeBackupSnapshot(job))
    await service.exportAll()
    const archive = readBackupV3Archive(backupRoot)
    assert.deepEqual(archive.assets.map(item => Buffer.from(item.bytes)), [bytes])
    assert.ok(archive.groups.some(item => item.wire.id === groupId))
    assert.ok(archive.documents.some(item => item.id === f.hostId && item.blocks.some(block => block.id === ack.blockIdMap[0].to)))
  } finally { store.destroy() }
}))
