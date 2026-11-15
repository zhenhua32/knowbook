import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { MarkdownLinkIndex } from '../src/main/database/markdown-link-index'
import { SyncedEditingSessionRepository } from '../src/main/database/synced-editing-session'
import { updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { decodeHostJournal as decodeHostJournalIncludingCrossMove4, hostEncode, hostHash } from '../src/main/database/synced-host-journal'
import type { SyncedHostHistoryBranchRow } from '../src/main/database/synced-host-history-branch'
import type { HostMoveInput } from '../src/main/database/synced-host-move-plan'
import { a, b, c, allTables, applySyncedHostCommand, bodyBirth, bodyId, freshBlock, groupEdit, identity, mixedForest, request, restoreInput, snapshot,
  totalChanges, withHostDatabase } from './helpers/synced-host-command-move-fixture'
import { command as insertReference, insertAck } from './helpers/synced-host-command-insert-fixture'
import { createRequest, seedCreateBlocks } from './helpers/synced-host-command-create-fixture'
import { captureCrossHostJournal4, decodeCrossHostJournal4 } from '../src/main/database/synced-cross-host-journal4'
import { applySyncedHostCommand as applyWithV4, getSyncedHostHistory, restoreSyncedHostOperation as restoreWithV4 } from '../src/main/database/synced-host-final'
import { readSyncedExchangeCutJournal } from '../src/main/database/synced-exchange-host-cut'

function command(db: Database.Database, selectedRootId: string): HostMoveInput {
  const original = request(db, [a, b])
  return { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: original.hostsWorkingBefore,
    groups: original.groups, expectedInstances: original.expectedInstances, action: { kind: 'move', selection: { documentId: a,
      selectedRootIds: [selectedRootId] }, target: { documentId: b, beforeBlockId: bodyId(b), parentBlockId: null, depth: 0 } } }
}

function commitJournalFixture(db: Database.Database, row: SyncedHostHistoryBranchRow) {
  const result = db.prepare(`INSERT INTO synced_host_history(id,action_json,before_json,after_json,before_hash,after_hash,created_at)
    VALUES(@id,@action_json,@before_json,@after_json,@before_hash,@after_hash,@created_at)`).run(row)
  assert.equal(result.changes, 1)
}

function readRow(db: Database.Database, id: string): SyncedHostHistoryBranchRow {
  const row = db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(id) as SyncedHostHistoryBranchRow | undefined
  assert.ok(row)
  return row
}

test('an actual nested list reference moves between list owners and cold Undo/Redo preserve its physical birth', () => withHostDatabase((db, reopen) => {
  groupEdit(db, syncedCanonicalEdits(snapshot(db).blocks).map(block => ({ ...block, type: 'bulleted-list' })))
  function insertUnderList(documentId: string, parentBlockId: string) {
    const input = insertReference(db, { documentId, target: { parentBlockId, depth: 1 },
      dirty: working => working.blocks.push({ ...freshBlock(parentBlockId), type: 'bulleted-list' }) })
    insertAck(applyWithV4(db, input))
    return input.action.instanceId
  }
  const sourceList = 'source-list-parent', destinationList = 'destination-list-parent'
  const selected = insertUnderList(a, sourceList), anchor = insertUnderList(b, destinationList), birth = bodyBirth(db, selected)
  assert.ok(birth)
  const group = snapshot(db), currentInstance = (connection: Database.Database) => snapshot(connection).instances.find(item => item.instanceId === selected)
  const input = command(db, selected)
  input.action.target = { documentId: b, parentBlockId: destinationList, beforeBlockId: anchor, depth: 1 }
  const bad = structuredClone(input)
  bad.hostsWorkingBefore[0].workingBefore.blocks.find(block => block.id === sourceList)!.type = 'paragraph'
  const start = allTables(db), changes = totalChanges(db)
  const invalid = applyWithV4(db, bad)
  assert.ok(invalid.status === 'invalid' && invalid.code === 'forest')
  assert.deepEqual(allTables(db), start)
  assert.equal(totalChanges(db), changes)

  const ack = applyWithV4(db, input)
  assert.ok(ack.status === 'applied' && ack.historyToken, JSON.stringify(ack))
  const originalBinding = group.instances.find(item => item.instanceId === selected)!.bindingVersion
  const moved = currentInstance(db)
  assert.ok(moved && moved.bindingVersion !== originalBinding)
  assert.deepEqual({ host: moved.hostDocumentId, parent: moved.parentBlockId, depth: moved.depth }, { host: b, parent: destinationList, depth: 1 })
  const to = ack.hosts.find(host => host.documentId === b)!.after.blocks.map(block => block.id)
  assert.ok(to.indexOf(selected) >= 0 && to.indexOf(selected) + 1 === to.indexOf(anchor))
  const cold = reopen(), row = readRow(cold, ack.historyToken)
  const original = decodeHostJournalIncludingCrossMove4(row)
  assert.ok('crossMove' in original)
  assert.deepEqual(original.crossMove.transfers, [{ blockId: selected, from: a, to: b, createdAt: birth }])
  assert.deepEqual(cold.transaction(() => readSyncedExchangeCutJournal(cold, row.id))().documentIds, [a, b].sort())
  const undone = restoreWithV4(cold, restoreInput(cold, ack, 'undo'))
  assert.ok(undone.status === 'applied', JSON.stringify(undone))
  assert.equal(currentInstance(cold)?.parentBlockId, sourceList)
  assert.equal(currentInstance(cold)?.hostDocumentId, a)
  const redone = restoreWithV4(cold, restoreInput(cold, ack, 'redo'))
  assert.ok(redone.status === 'applied', JSON.stringify(redone))
  assert.equal(currentInstance(cold)?.parentBlockId, destinationList)
  assert.equal(currentInstance(cold)?.hostDocumentId, b)
  assert.deepEqual(snapshot(cold).blocks, group.blocks)
  assert.equal(bodyBirth(cold, selected), birth)
  assert.deepEqual(readRow(cold, row.id), row)
}))

test('a real paragraph canonical root remains inadmissible under a destination list', () => withHostDatabase(db => {
  const nested = insertReference(db)
  insertAck(applyWithV4(db, nested))
  db.prepare('UPDATE blocks SET type=? WHERE id=?').run('bulleted-list', bodyId(b))
  const input = command(db, nested.action.instanceId)
  input.action.target = { documentId: b, parentBlockId: bodyId(b), beforeBlockId: null, depth: 1 }
  const start = allTables(db), changes = totalChanges(db)
  const refused = applyWithV4(db, input)
  assert.ok(refused.status === 'invalid' && refused.code === 'forest', JSON.stringify(refused))
  assert.deepEqual(allTables(db), start)
  assert.equal(totalChanges(db), changes)
}))

test('cold SQLite WAL reader rederives v4 A and keeps an unmodified genuine v1 command readable', () => withHostDatabase((db, reopen) => {
  assert.equal(db.pragma('journal_mode=WAL', { simple: true }), 'wal')
  const mixed = mixedForest(db)
  const persistedGroup = mixed.input.action.groupId
  const link = `[[Home/Host A#${mixed.nestedId}|原引用]]`, newLink = `[[Home/Host B#${mixed.nestedId}|原引用]]`
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run(link, bodyId(b))
  const index = new MarkdownLinkIndex(db)
  index.syncDocument(a); index.syncDocument(b)
  const input = command(db, mixed.owner)
  input.hostsWorkingBefore[0].workingBefore.summary = '尚未保存的来源摘要'
  input.hostsWorkingBefore[1].workingBefore.summary = '尚未保存的目标摘要'
  const changes = totalChanges(db), original = db.transaction(() => captureCrossHostJournal4(db, input, new Date().toISOString())).immediate()
  assert.equal(totalChanges(db), changes)
  assert.deepEqual(decodeCrossHostJournal4(original).after[1].content.blocks.find(block => block.id === bodyId(b))?.content, newLink)
  db.transaction(() => commitJournalFixture(db, original)).immediate()

  // Historical A must still read after a later change in current context. The
  // fixture does not physically move any user block or manufacture a receipt.
  db.prepare('UPDATE documents SET path=? WHERE id=?').run('Renamed/Today B', b)
  index.syncDocument(b)
  const reader = reopen(), cold = decodeHostJournalIncludingCrossMove4(readRow(reader, original.id))
  assert.ok('crossMove' in cold)
  assert.deepEqual(cold.crossMove.transfers.map(item => item.blockId), [mixed.owner, mixed.nestedId, mixed.child])
  assert.equal(cold.persisted[1].path, 'Home/Host B')
  assert.equal(cold.after[1].content.blocks.find(block => block.id === bodyId(b))?.content, newLink)
  assert.deepEqual(cold.after.map(side => side.content.summary), input.hostsWorkingBefore.map(side => side.workingBefore.summary))
  assert.ok(cold.groups.some(group => group.groupId === persistedGroup))
  const legacyRow = readRow(reader, mixed.ack.historyToken!)
  assert.equal(JSON.parse(legacyRow.action_json).version, 1)
  const legacy = decodeHostJournalIncludingCrossMove4(legacyRow)
  assert.ok(!('crossMove' in legacy))
  assert.equal(legacy.input.clientOperationId, mixed.input.clientOperationId)
}))

test('recomputes final content and ownership from Original even when edited bytes have matching claimed hashes', () => withHostDatabase(db => {
  const mixed = mixedForest(db)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run(`[[Home/Host A#${mixed.nestedId}|inbound]]`, bodyId(b))
  new MarkdownLinkIndex(db).syncDocument(b)
  const row = db.transaction(() => captureCrossHostJournal4(db, command(db, mixed.owner), new Date().toISOString())).immediate()
  const source = JSON.parse(row.action_json)
  const latest = JSON.parse(row.after_json)
  latest[1].content.blocks[0].content = 'undeclared change'
  assert.throws(() => decodeCrossHostJournal4({ ...row, after_json: hostEncode(latest), after_hash: hostHash(latest) }), /v4/)
  const { kind, version, originalHash: _staleHash, ...original } = source
  original.crossMove.transfers[0].from = b
  assert.throws(() => decodeCrossHostJournal4({ ...row, action_json: hostEncode({ kind, version, ...original, originalHash: hostHash(original) }) }), /v4/)
  original.crossMove.transfers[0].from = a
  original.crossMove.outsideIncoming.push([c, 'an unattributed future occurrence'])
  assert.throws(() => decodeCrossHostJournal4({ ...row, action_json: hostEncode({ kind, version, ...original, originalHash: hostHash(original) }) }), /v4/)
  original.crossMove.outsideIncoming.pop()
  assert.equal(original.persisted[1].indexedLinks.length, 1)
  original.persisted[1].indexedLinks = []
  assert.throws(() => decodeCrossHostJournal4({ ...row, action_json: hostEncode({ kind, version, ...original, originalHash: hostHash(original) }) }), /v4/)
}))

test('two-host capture rejects an actual external inbound rewrite and stale topology with zero DML', () => withHostDatabase(db => {
  const mixed = mixedForest(db)
  const capture = (input: HostMoveInput) => db.transaction(() => captureCrossHostJournal4(db, input, new Date().toISOString())).immediate()
  const badGroup = command(db, mixed.owner)
  badGroup.groups[0].expectedTopologyRevision = randomUUID()
  const before = allTables(db), changes = totalChanges(db)
  assert.throws(() => capture(badGroup), /v4/)
  assert.deepEqual(allTables(db), before)
  assert.equal(totalChanges(db), changes)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run(`[[Home/Host A#${mixed.nestedId}]]`, bodyId(c))
  new MarkdownLinkIndex(db).syncDocument(c)
  const indexed = allTables(db), indexedChanges = totalChanges(db)
  assert.throws(() => capture(command(db, mixed.owner)), /link-participants/)
  assert.deepEqual(allTables(db), indexed)
  assert.equal(totalChanges(db), indexedChanges)
}))

test('candidate routing cold reads original v2 create and v3 detach with their original native producer', () => withHostDatabase((db, reopen) => {
  seedCreateBlocks(db, [{ id: 'legacy-create-retained-body', content: 'retained host content', type: 'paragraph' }], b)
  const create = createRequest(db, { documentId: b })
  const created = applySyncedHostCommand(db, create)
  assert.ok(created.status === 'applied' && created.historyToken)
  const { clientOperationId, hostsWorkingBefore, groups, expectedInstances } = request(db, [b])
  const detach = { clientOperationId, hostsWorkingBefore, groups, expectedInstances,
    mode: 'command' as const, action: { kind: 'detach' as const, groupId: create.action.groupId, instanceId: create.action.instanceId } }
  const owner = new SyncedEditingSessionRepository(db), sender = Object.freeze({}), session = owner.open(sender, { kind: 'host', hostDocumentId: b })
  assert.ok(session.status === 'ready')
  const detached = owner.invoke(sender, { sessionId: session.session.sessionId, method: 'applySyncedHostStructure', input: detach })
  assert.ok(detached.status === 'applied' && detached.historyToken, JSON.stringify(detached))
  const cold = reopen()
  for (const expected of [{ ack: created, command: create, version: 2 }, { ack: detached, command: detach, version: 3 }]) {
    const row = readRow(cold, expected.ack.historyToken!)
    assert.equal(JSON.parse(row.action_json).version, expected.version)
    const journal = decodeHostJournalIncludingCrossMove4(row)
    assert.ok(!('crossMove' in journal))
    assert.equal(journal.input.clientOperationId, expected.command.clientOperationId)
  }
}))

test('isolated existing Main writer overlay commits native v4 ownership and paired cold Undo/Redo', () => withHostDatabase((db, reopen) => {
  const mixed = mixedForest(db), group = mixed.input.action.groupId, oldGroup = snapshot(db, group)
  const link = `[[Home/Host A#${mixed.nestedId}|原引用]]`, newLink = `[[Home/Host B#${mixed.nestedId}|原引用]]`
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run(link, bodyId(b))
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[原路径](./Host%20C.md)', mixed.child)
  const index = new MarkdownLinkIndex(db)
  index.syncDocument(a); index.syncDocument(b)
  const input = command(db, mixed.owner)
  input.hostsWorkingBefore[0].workingBefore.blocks.push(freshBlock('v4-fresh-source', '未提交的普通块'))
  input.hostsWorkingBefore.reverse()
  const result = applyWithV4(db, input)
  assert.ok(result.status === 'applied' && result.historyToken, JSON.stringify(result))
  assert.deepEqual(result.affectedInstanceIds, [mixed.nestedId])
  assert.equal(result.hosts[0].after.blocks.find(block => block.id === bodyId(b))?.content, newLink)
  const readLeaf = (source: Database.Database) => snapshot(source, group).instances.find(instance => instance.instanceId === mixed.nestedId)!
  assert.equal(readLeaf(db).hostDocumentId, b)
  const firstBinding = readLeaf(db).bindingVersion
  assert.notEqual(readLeaf(db).bindingVersion, oldGroup.instances.find(instance => instance.instanceId === mixed.nestedId)?.bindingVersion)
  assert.notEqual(snapshot(db, group).topologyRevision, oldGroup.topologyRevision)
  assert.deepEqual(snapshot(db, group).blocks, oldGroup.blocks)
  assert.deepEqual(applyWithV4(db, input), { ...result, replayed: true })
  const movedGroup = snapshot(db, group), postMoveTables = allTables(db), postMoveChanges = totalChanges(db)
  const staleGroup = updateSyncedBlockGroup(db, { clientOperationId: randomUUID(), groupId: group, expectedRevision: movedGroup.revision,
    expectedTopologyRevision: movedGroup.topologyRevision, expectedInstanceBinding: { instanceId: mixed.nestedId, hostDocumentId: a,
      bindingVersion: oldGroup.instances.find(instance => instance.instanceId === mixed.nestedId)!.bindingVersion },
    blocks: movedGroup.blocks.map(({ createdAt: _birth, ...block }) => block) })
  assert.ok(staleGroup.status === 'conflict' && staleGroup.kind === 'topology')
  assert.deepEqual(allTables(db), postMoveTables)
  assert.equal(totalChanges(db), postMoveChanges)
  const cold = reopen()
  assert.equal(getSyncedHostHistory(cold, { documentId: a }).undoToken, result.historyToken)
  assert.equal(getSyncedHostHistory(cold, { documentId: b }).undoToken, result.historyToken)
  const undo = restoreWithV4(cold, restoreInput(cold, result, 'undo'))
  assert.ok(undo.status === 'applied', JSON.stringify(undo))
  assert.equal(readLeaf(cold).hostDocumentId, a)
  assert.equal(undo.hosts[0].after.blocks.find(block => block.id === bodyId(b))?.content, link)
  assert.equal(undo.hosts[1].after.blocks.find(block => block.id === 'v4-fresh-source')?.content, '未提交的普通块')
  assert.equal(getSyncedHostHistory(cold, { documentId: a }).redoToken, result.historyToken)
  assert.equal(getSyncedHostHistory(cold, { documentId: b }).redoToken, result.historyToken)
  const redo = restoreWithV4(cold, restoreInput(cold, result, 'redo'))
  assert.ok(redo.status === 'applied', JSON.stringify(redo))
  assert.equal(readLeaf(cold).hostDocumentId, b)
  assert.notEqual(readLeaf(cold).bindingVersion, firstBinding)
  assert.equal(redo.hosts[0].after.blocks.find(block => block.id === bodyId(b))?.content, newLink)
  assert.deepEqual(cold.pragma('foreign_key_check'), [])
}))

test('isolated kernel rejects a newly indexed outside inbound and stale inverse without SQL changes', () => withHostDatabase((db, reopen) => {
  const mixed = mixedForest(db), input = command(db, mixed.owner), result = applyWithV4(db, input)
  assert.ok(result.status === 'applied' && result.historyToken, JSON.stringify(result))
  const cold = reopen(), stale = restoreInput(cold, result, 'undo')
  stale.expectedHosts[0].expectedUpdatedAt = '1999-01-01T00:00:00.000Z'
  const start = allTables(cold), changed = totalChanges(cold)
  const rejected = restoreWithV4(cold, stale)
  assert.ok(rejected.status === 'conflict' && rejected.kind === 'host')
  assert.deepEqual(allTables(cold), start); assert.equal(totalChanges(cold), changed)
  cold.prepare('UPDATE blocks SET content=? WHERE id=?').run(`[[Home/Host B#${mixed.nestedId}]]`, bodyId(c))
  new MarkdownLinkIndex(cold).syncDocument(c)
  const indexed = allTables(cold), indexedChanges = totalChanges(cold)
  const inbound = restoreWithV4(cold, restoreInput(cold, result, 'undo'))
  assert.ok(inbound.status === 'conflict' && inbound.kind === 'history')
  assert.deepEqual(allTables(cold), indexed); assert.equal(totalChanges(cold), indexedChanges)
  assert.deepEqual(applyWithV4(cold, input), { ...result, replayed: true })
}))

test('real frame-scoped editing session opens both endpoints and gates v4 apply and paired inverse', () => withHostDatabase((db, reopen) => {
  const mixed = mixedForest(db), input = command(db, mixed.owner), sender = Object.freeze({}), service = new SyncedEditingSessionRepository(db)
  const opened = service.open(sender, { kind: 'host', hostDocumentId: a })
  assert.ok(opened.status === 'ready')
  const sessionId = opened.session.sessionId
  const start = allTables(db), changes = totalChanges(db)
  assert.throws(() => service.invoke(sender, { sessionId, method: 'applySyncedHostStructure', input }), /host birth differs/)
  assert.deepEqual(allTables(db), start); assert.equal(totalChanges(db), changes)
  const destination = service.open(sender, { kind: 'host', hostDocumentId: b })
  assert.ok(destination.status === 'ready' && destination.session.sessionId === sessionId)
  const result = service.invoke(sender, { sessionId, method: 'applySyncedHostStructure', input })
  assert.ok(result.status === 'applied' && result.historyToken, JSON.stringify(result))
  const cold = reopen()
  const upstream = cold.transaction(() => readSyncedExchangeCutJournal(cold, result.historyToken!))()
  assert.deepEqual(upstream.documentIds, [a, b].sort())
  assert.match(upstream.journalHash, /^[a-f0-9]{64}$/)
  const fresh = new SyncedEditingSessionRepository(cold), target = fresh.open(sender, { kind: 'host', hostDocumentId: b })
  assert.ok(target.status === 'ready')
  const inverse = restoreInput(cold, result, 'undo'), inverseBefore = allTables(cold), inverseChanges = totalChanges(cold)
  assert.throws(() => fresh.invoke(sender, { sessionId: target.session.sessionId, method: 'restoreSyncedHostOperation', input: inverse }), /host birth differs/)
  assert.deepEqual(allTables(cold), inverseBefore); assert.equal(totalChanges(cold), inverseChanges)
  fresh.open(sender, { kind: 'host', hostDocumentId: a })
  const restored = fresh.invoke(sender, { sessionId: target.session.sessionId, method: 'restoreSyncedHostOperation', input: inverse })
  assert.ok(restored.status === 'applied' && restored.historyToken === result.historyToken)
}))

test('moving all real roots journals one source paragraph and reuses its original physical birth after cold Undo and Redo', () => withHostDatabase((db, reopen) => {
  const mixed = mixedForest(db), input = command(db, mixed.owner), working = input.hostsWorkingBefore[0].workingBefore
  input.action.selection.selectedRootIds = working.blocks.filter(block => block.depth === 0).map(block => block.id)
  working.blocks.find(block => block.id === mixed.child)!.content = 'Original unsaved W'
  working.summary = 'Unsaved source summary'
  const movedBirths = new Map(working.blocks.map(block => [block.id, bodyBirth(db, block.id)]))
  const ack = applyWithV4(db, input)
  assert.ok(ack.status === 'applied' && ack.historyToken, JSON.stringify(ack))
  const source = ack.hosts.find(host => host.documentId === a)!
  assert.equal(source.after.blocks.length, 1)
  const blank = source.after.blocks[0], cold = reopen(), row = readRow(cold, ack.historyToken)
  assert.deepEqual(blank, { id: blank.id, type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null, tags: [], sortOrder: 0 })
  const original = decodeHostJournalIncludingCrossMove4(row)
  assert.ok('crossMove' in original && 'sourcePlaceholder' in original.crossMove)
  assert.deepEqual(original.crossMove.sourcePlaceholder, { version: 1, blockId: blank.id, createdAt: row.created_at })
  assert.equal(bodyBirth(cold, blank.id), row.created_at)
  assert.deepEqual(identity(cold, blank.id), { id: blank.id, last_owner_kind: 'document', last_owner_id: a, state: 'live', created_at: row.created_at })
  assert.deepEqual(applyWithV4(cold, input), { ...ack, replayed: true })
  const owner = new SyncedEditingSessionRepository(cold), sender = Object.freeze({})
  const destination = owner.open(sender, { kind: 'host', hostDocumentId: b })
  assert.ok(destination.status === 'ready')
  const history = owner.invoke(sender, { sessionId: destination.session.sessionId,
    method: 'getSyncedCrossHostMoveHistory', input: { documentId: b } })
  assert.equal(history.find(item => item.direction === 'undo')?.historyToken, ack.historyToken)
  assert.deepEqual(cold.transaction(() => readSyncedExchangeCutJournal(cold, row.id))().documentIds, [a, b].sort())

  const { kind, version, originalHash: _staleHash, ...tampered } = JSON.parse(row.action_json)
  tampered.crossMove.sourcePlaceholder.createdAt = '1999-01-01T00:00:00.000Z'
  assert.throws(() => decodeCrossHostJournal4({ ...row,
    action_json: hostEncode({ kind, version, ...tampered, originalHash: hostHash(tampered) }) }), /v4/)
  delete tampered.crossMove.sourcePlaceholder
  assert.throws(() => decodeCrossHostJournal4({ ...row,
    action_json: hostEncode({ kind, version, ...tampered, originalHash: hostHash(tampered) }) }), /v4/)

  const stale = restoreInput(cold, ack, 'undo')
  stale.expectedHosts[0].expectedUpdatedAt = '1999-01-01T00:00:00.000Z'
  assert.ok(restoreWithV4(cold, stale).status === 'conflict')
  const index = new MarkdownLinkIndex(cold)
  cold.prepare('UPDATE blocks SET content=? WHERE id=?').run(`[[Home/Host A#${blank.id}]]`, bodyId(c))
  index.syncDocument(c)
  const protectedState = allTables(cold), protectedChanges = totalChanges(cold)
  const rejectedUndo = restoreWithV4(cold, restoreInput(cold, ack, 'undo'))
  assert.ok(rejectedUndo.status === 'conflict' && rejectedUndo.kind === 'history')
  assert.deepEqual(allTables(cold), protectedState)
  assert.equal(totalChanges(cold), protectedChanges)
  cold.prepare('UPDATE blocks SET content=? WHERE id=?').run('Body C', bodyId(c))
  index.syncDocument(c)

  const undo = restoreWithV4(cold, restoreInput(cold, ack, 'undo'))
  assert.ok(undo.status === 'applied', JSON.stringify(undo))
  const restored = undo.hosts.find(host => host.documentId === a)!.after
  assert.deepEqual(restored.blocks.map(({ sortOrder: _sortOrder, ...block }) => block), working.blocks)
  assert.equal(restored.summary, working.summary)
  assert.equal(bodyBirth(cold, blank.id), undefined)
  const retained = { id: blank.id, last_owner_kind: 'document', last_owner_id: a, state: 'retained', created_at: row.created_at }
  assert.deepEqual(identity(cold, blank.id), retained)

  const reopened = reopen()
  const wrongBirth = '1999-01-01T00:00:00.000Z'
  reopened.prepare('UPDATE block_identities SET created_at=? WHERE id=?').run(wrongBirth, blank.id)
  const wrongState = allTables(reopened), wrongChanges = totalChanges(reopened)
  const refusedRedo = restoreWithV4(reopened, restoreInput(reopened, ack, 'redo'))
  assert.ok(refusedRedo.status === 'conflict' && refusedRedo.kind === 'history')
  assert.deepEqual(allTables(reopened), wrongState)
  assert.equal(totalChanges(reopened), wrongChanges)
  reopened.prepare('UPDATE block_identities SET created_at=? WHERE id=?').run(row.created_at, blank.id)

  const redo = restoreWithV4(reopened, restoreInput(reopened, ack, 'redo'))
  assert.ok(redo.status === 'applied', JSON.stringify(redo))
  assert.deepEqual(redo.hosts.find(host => host.documentId === a)?.after.blocks, [blank])
  assert.equal(bodyBirth(reopened, blank.id), row.created_at)
  assert.deepEqual(identity(reopened, blank.id), { ...retained, state: 'live' })
  assert.deepEqual(new Map(working.blocks.map(block => [block.id, bodyBirth(reopened, block.id)])), movedBirths)
  assert.deepEqual(readRow(reopened, row.id), row)
  assert.deepEqual(reopened.pragma('foreign_key_check'), [])
}))
