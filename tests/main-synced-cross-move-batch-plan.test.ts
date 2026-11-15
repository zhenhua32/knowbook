import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import type Database from 'better-sqlite3'
import type { EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import type { KnowbookStore } from '../src/main/database/store'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { MarkdownLinkIndex } from '../src/main/database/markdown-link-index'
import { planSyncedCrossMoveBatch, type HostMoveBatchInput } from '../src/main/database/synced-host-cross-move-batch-plan'
import { applySyncedHostCommand, restoreSyncedHostOperation } from '../src/main/database/synced-host-final'
import { readStrictHostDocument } from '../src/main/database/synced-host-document-read'
import { withCrossMoveDraftCheck } from '../src/main/database/synced-cross-move-draft-guard'
import { decodeCrossHostJournal8 } from '../src/main/database/synced-cross-host-journal4'
import { hostEncode, hostHash } from '../src/main/database/synced-host-journal'
import { readSyncedExchangeCutJournal } from '../src/main/database/synced-exchange-host-cut'
import { SyncedEditingSessionRepository } from '../src/main/database/synced-editing-session'
import type { SyncedHostHistoryBranchRow } from '../src/main/database/synced-host-history-branch'
import { a, b, c, allTables, bodyBirth, bodyId, freshBlock, identity, mixedForest, request, restoreInput, totalChanges, withHostDatabase }
  from './helpers/synced-host-command-move-fixture'

function batchInput(db: Database.Database, root: string): HostMoveBatchInput {
  const original = request(db, [a, b, c])
  return { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: original.hostsWorkingBefore,
    groups: original.groups, expectedInstances: original.expectedInstances, action: { kind: 'move-batch', moves: [
      { selection: { documentId: a, selectedRootIds: [root] }, target: { documentId: b, parentBlockId: null, beforeBlockId: null, depth: 0 } },
      { selection: { documentId: b, selectedRootIds: [bodyId(b)] }, target: { documentId: c, parentBlockId: null, beforeBlockId: bodyId(c), depth: 0 } },
      { selection: { documentId: c, selectedRootIds: [bodyId(c)] }, target: { documentId: a, parentBlockId: null, beforeBlockId: bodyId(a), depth: 0 } }
    ] } }
}

test('plans simultaneous real mixed subtrees and retains unrelated W across pages without writing local SQL', () => withHostDatabase(db => {
  const mixed = mixedForest(db), input = batchInput(db, mixed.owner)
  input.action.moves[1].target.beforeBlockId = null
  input.action.moves[0].selection.selectedRootIds.push(mixed.nestedId)
  const destination = input.hostsWorkingBefore.find(side => side.documentId === b)!.workingBefore
  destination.summary = 'Other unsaved summary'
  const draft = freshBlock('an-unrelated-fresh-block', 'Other unsaved text')
  destination.blocks.push(draft)
  const original = allTables(db), changes = totalChanges(db)
  const result = db.transaction(() => planSyncedCrossMoveBatch(input))()
  assert.deepEqual(result.transfers, [
    ...[mixed.owner, mixed.nestedId, mixed.child].map(blockId => ({ blockId, from: a, to: b })),
    { blockId: bodyId(b), from: b, to: c }, { blockId: bodyId(c), from: c, to: a }
  ])
  const pages = new Map(result.after.map(side => [side.documentId, side.content]))
  const sourceOrder = input.hostsWorkingBefore.find(side => side.documentId === a)!.workingBefore.blocks
    .map(block => block.id).filter(id => !result.transfers.some(move => move.blockId === id))
  sourceOrder.splice(sourceOrder.indexOf(bodyId(a)), 0, bodyId(c))
  assert.deepEqual(pages.get(a)!.blocks.map(block => block.id), sourceOrder)
  const kept = pages.get(b)!
  assert.equal(kept.summary, 'Other unsaved summary')
  assert.deepEqual(kept.blocks.find(block => block.id === draft.id), draft)
  assert.equal(kept.blocks.find(block => block.id === mixed.nestedId)?.parentBlockId, mixed.owner)
  assert.equal(pages.get(c)!.blocks[0].id, bodyId(b))
  assert.deepEqual(result.before, input.hostsWorkingBefore.map(({ documentId, workingBefore }) => ({ documentId, content: workingBefore })))
  assert.deepEqual(allTables(db), original)
  assert.equal(totalChanges(db), changes)
}))

test('rejects an anchor departing in the same batch, overlapping transfers and inaccurate target depth', () => withHostDatabase(db => {
  const mixed = mixedForest(db), input = batchInput(db, mixed.owner)
  assert.throws(() => planSyncedCrossMoveBatch(input), /本次移出的父块或锚点/)
  input.action.moves[1].target.beforeBlockId = null
  input.action.moves.push({ ...input.action.moves[0] })
  assert.throws(() => planSyncedCrossMoveBatch(input), /同一块不能被移动两次/)
  input.action.moves.pop()
  input.action.moves[0].target.depth = 1
  assert.throws(() => planSyncedCrossMoveBatch(input), /目标深度与原父块不符/)
}))

test('one real Main batch crosses three hosts, retains original block births and undoes the same complete W after restart', t => withHostDatabase((db, reopen) => {
  const mixed = mixedForest(db)
  const index = new MarkdownLinkIndex(db)
  const oldLink = `[[Home/Host A#${mixed.nestedId}|original]] [local](Host%20A.md#^${mixed.nestedId})`
  const newLink = `[[Home/Host B#${mixed.nestedId}|original]] [local](Host%20B.md#^${mixed.nestedId})`
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run(oldLink, bodyId(c))
  index.syncDocument(c)
  assert.ok(db.prepare('SELECT 1 FROM markdown_link_sources WHERE source_document_id=? AND target_path=? AND fragment=?')
    .get(c, 'Home/Host A', mixed.nestedId))
  const actual = batchInput(db, mixed.owner)
  actual.action.moves[1].target.beforeBlockId = null
  const source = actual.hostsWorkingBefore[0].workingBefore
  source.summary = 'Keep my earlier draft'
  source.blocks.find(block => block.id === bodyId(a))!.content = 'Keep this earlier input'
  const planned = planSyncedCrossMoveBatch(actual)
  const births = new Map(planned.transfers.map(move => [move.blockId, bodyBirth(db, move.blockId)!]))

  const original = allTables(db)
  db.exec(`CREATE TRIGGER fail_actual_batch BEFORE UPDATE ON documents
    WHEN hex(OLD.id)='${Buffer.from(c).toString('hex')}' COLLATE NOCASE
    BEGIN SELECT RAISE(ABORT,'third batch host did not commit'); END`)
  assert.throws(() => applySyncedHostCommand(db, actual), /third batch host did not commit/)
  db.exec('DROP TRIGGER fail_actual_batch')
  assert.deepEqual(allTables(db), original)

  const sideDirectory = mkdtempSync(join(tmpdir(), 'knowbook-move-batch-'))
  const side = new EditorRecoveryDraftStore(sideDirectory)
  t.after(() => {
    side.close()
    assert.equal(dirname(resolve(sideDirectory)), resolve(tmpdir()))
    assert.ok(basename(sideDirectory).startsWith('knowbook-move-batch-'))
    rmSync(sideDirectory, { recursive: true, force: true })
  })
  const event = { sender: {}, senderFrame: {} } as EditorCloseIpcEvent, sender = event.senderFrame!
  const store = { getUnsafeDatabaseHandle: () => db, getDocumentDetail: (id: string) => readStrictHostDocument(db, id)?.detail } as KnowbookStore
  const recovery = new EditorRecoveryDraftService(side, store, () => undefined)
  const service = new SyncedEditingSessionRepository(db)
  const opened = service.open(sender, { kind: 'host', hostDocumentId: a })
  assert.ok(opened.status === 'ready')
  const sessionId = opened.session.sessionId
  assert.equal(service.open(sender, { kind: 'host', hostDocumentId: b }).status, 'ready')
  const beforeMissingOpen = allTables(db)
  assert.throws(() => service.invoke(sender, { sessionId, method: 'applySyncedHostStructure', input: actual }), /host birth differs/)
  assert.deepEqual(allTables(db), beforeMissingOpen)
  assert.equal(service.open(sender, { kind: 'host', hostDocumentId: c }).status, 'ready')
  const method = 'applySyncedHostStructure' as const
  const apply = (input: HostMoveBatchInput) => withCrossMoveDraftCheck(db, recovery.crossMoveDraftCheck(event), () =>
    service.invoke(sender, { sessionId, method, input }))
  assert.equal(apply(actual).status, 'conflict')
  assert.deepEqual(allTables(db), beforeMissingOpen)
  const protection = recovery.open(event, { kind: 'host', documentId: a, openRequestId: randomUUID(),
    expectedUpdatedAt: actual.hostsWorkingBefore[0].expectedPersistedUpdatedAt })
  const working = { kind: 'host' as const, ...source }
  const pending = { method, clientOperationId: actual.clientOperationId, requestHash: hostHash({ method, input: actual }),
    inputJson: JSON.stringify(actual), submittedWorking: working }
  recovery.write(event, { records: [{ draftSessionId: protection.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
    working, sources: [], pending: [pending], selection: null, composing: false, importing: false }] }, { kind: 'background' })
  assert.equal(apply({ ...actual, clientOperationId: randomUUID() }).status, 'conflict')
  assert.deepEqual(allTables(db), beforeMissingOpen)
  const acknowledgement = apply(actual)
  assert.ok(acknowledgement.status === 'applied' && acknowledgement.historyToken, JSON.stringify(acknowledgement))
  const cold = reopen(), token = acknowledgement.historyToken
  const row = cold.prepare('SELECT * FROM synced_host_history WHERE id=?').get(token) as SyncedHostHistoryBranchRow
  const originalJournal = decodeCrossHostJournal8(row)
  assert.deepEqual(originalJournal.before, planned.before)
  assert.deepEqual(originalJournal.after, planned.after.map(side => ({ ...side, content: { ...side.content,
    blocks: side.content.blocks.map(block => block.id === bodyId(c) ? { ...block, content: newLink } : block) } })))
  assert.deepEqual(cold.transaction(() => readSyncedExchangeCutJournal(cold, token))().documentIds, [a, b, c].sort())
  assert.deepEqual(applySyncedHostCommand(cold, actual), { ...acknowledgement, replayed: true })
  for (const move of planned.transfers) {
    assert.equal(identity(cold, move.blockId)?.last_owner_id, move.to)
    assert.equal(bodyBirth(cold, move.blockId), births.get(move.blockId))
  }
  const action = JSON.parse(row.action_json)
  const { kind, version, originalHash: _originalHash, ...content } = action
  content.crossMove.transfers[0].to = c
  assert.throws(() => decodeCrossHostJournal8({ ...row, action_json: hostEncode({ kind, version, ...content, originalHash: hostHash(content) }) }))

  const restoredService = new SyncedEditingSessionRepository(cold)
  const coldSession = restoredService.open(sender, { kind: 'host', hostDocumentId: c })
  assert.ok(coldSession.status === 'ready')
  const history = restoredService.invoke(sender, { sessionId: coldSession.session.sessionId, method: 'getSyncedCrossHostMoveHistory',
    input: { documentId: c } })
  assert.equal(history[0]?.historyToken, token)
  assert.equal(history[0]?.direction, 'undo')
  assert.deepEqual(Object.keys(history[0].versions).sort(), [a, b, c].sort())
  assert.equal(restoredService.open(sender, { kind: 'host', hostDocumentId: a }).status, 'ready')
  assert.equal(restoredService.open(sender, { kind: 'host', hostDocumentId: b }).status, 'ready')
  const undone = restoredService.invoke(sender, { sessionId: coldSession.session.sessionId, method: 'restoreSyncedHostOperation',
    input: restoreInput(cold, acknowledgement, 'undo') })
  assert.ok(undone.status === 'applied', JSON.stringify(undone))
  assert.equal(undone.hosts.find(host => host.documentId === a)?.after.summary, source.summary)
  assert.equal(undone.hosts.find(host => host.documentId === a)?.after.blocks.find(block => block.id === bodyId(a))?.content, 'Keep this earlier input')
  assert.equal(undone.hosts.find(host => host.documentId === c)?.after.blocks.find(block => block.id === bodyId(c))?.content, oldLink)
  for (const move of planned.transfers) assert.equal(identity(cold, move.blockId)?.last_owner_id, move.from)
  const redone = restoreSyncedHostOperation(cold, restoreInput(cold, acknowledgement, 'redo'))
  assert.ok(redone.status === 'applied', JSON.stringify(redone))
  assert.equal(redone.hosts.find(host => host.documentId === a)?.after.blocks.find(block => block.id === bodyId(c))?.content, newLink)
  for (const move of planned.transfers) {
    assert.equal(identity(cold, move.blockId)?.last_owner_id, move.to)
    assert.equal(bodyBirth(cold, move.blockId), births.get(move.blockId))
  }
  assert.deepEqual(cold.pragma('foreign_key_check'), [])
}))

test('a batch that empties two sources reuses both actual placeholder births after a cold inverse', () => withHostDatabase((db, reopen) => {
  const mixed = mixedForest(db), actual = batchInput(db, mixed.owner)
  actual.action.moves.splice(2, 1)
  for (const move of actual.action.moves) {
    const before = actual.hostsWorkingBefore.find(side => side.documentId === move.selection.documentId)!
    move.selection.selectedRootIds = before.workingBefore.blocks.filter(block => block.depth === 0).map(block => block.id)
    move.target.documentId = c
    move.target.beforeBlockId = null
  }
  const acknowledgement = applySyncedHostCommand(db, actual)
  assert.ok(acknowledgement.status === 'applied' && acknowledgement.historyToken, JSON.stringify(acknowledgement))
  const cold = reopen(), token = acknowledgement.historyToken
  const row = cold.prepare('SELECT * FROM synced_host_history WHERE id=?').get(token) as SyncedHostHistoryBranchRow
  const placeholders = decodeCrossHostJournal8(row).crossMove.sourcePlaceholders
  assert.deepEqual(placeholders.map(({ documentId }) => documentId), [a, b])
  assert.equal(new Set(placeholders.map(entry => entry.blockId)).size, 2)
  for (const { documentId, blockId, createdAt } of placeholders) {
    assert.equal(bodyBirth(cold, blockId), createdAt)
    assert.deepEqual(acknowledgement.hosts.find(page => page.documentId === documentId)?.after.blocks.map(block => block.id), [blockId])
  }
  assert.equal(restoreSyncedHostOperation(cold, restoreInput(cold, acknowledgement, 'undo')).status, 'applied')
  for (const { blockId } of placeholders) assert.equal(bodyBirth(cold, blockId), undefined)
  assert.equal(restoreSyncedHostOperation(cold, restoreInput(cold, acknowledgement, 'redo')).status, 'applied')
  for (const { blockId, createdAt } of placeholders) assert.equal(bodyBirth(cold, blockId), createdAt)
}))
