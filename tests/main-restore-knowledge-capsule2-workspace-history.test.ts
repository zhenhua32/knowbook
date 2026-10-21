import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { readRawInitialIncomingWorkspaceOwned } from '../src/main/database/synced-initial-incoming-raw-read'
import { withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { edit, restoreAck } from './helpers/synced-host-final-fixture'
import { actualHistorySyntax, insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'
import { withObserver2Copy } from './helpers/capsule2-observer-fixture'

// PREPARED / UNRUN. Every group/journal/ordinary history below comes from real
// Main/Store writers. NEW C fixture rows remain untrusted syntax, never an
// accepted producer, resolved root, certification or installation fixture.
function ordinaryDocument(f: V3Fixture, title: string, text: string) {
  const id = f.store.createDocument(null), blockId = randomUUID()
  const block: DocumentBlockDraft = { id: blockId, type: 'paragraph', content: text, checked: false, depth: 0, parentBlockId: null }
  f.store.updateDocument(id, { title, summary: '', blocks: [block] })
  return { id, blockId }
}

test('workspace history2 keeps genuine Main history plus untrusted C syntax and Store ordinary501 checkpoint trash template and move undo redo without publication admission', () => withV3Fixture(async f => {
  editCreatedGroup(f.db, f.groupId)
  const syntax = actualHistorySyntax(f.db, '2052-01-02T03:04:05.006Z')
  const long = ordinaryDocument(f, '史'.repeat(501), 'source ordinary body')
  const target = ordinaryDocument(f, 'History target', 'target body')
  f.store.documentRecovery.checkpoint(long.id, 'edit', true)
  const sourceDetail = f.store.getDocumentDetail(long.id), targetDetail = f.store.getDocumentDetail(target.id)
  assert.ok(sourceDetail && targetDetail)
  const moved = f.store.moveDocumentBlocks({ fromDocumentId: long.id, toDocumentId: target.id, blockIds: [long.blockId],
    expectedFromUpdatedAt: sourceDetail.updatedAt, expectedToUpdatedAt: targetDetail.updatedAt })
  const undone = f.store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument })
  const redone = f.store.redoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: undone.expectedUpdatedAtByDocument })
  assert.equal(redone.state, 'applied')
  const trashed = ordinaryDocument(f, 'Historical deleted owner', 'retained trash body')
  f.store.deleteDocument(trashed.id)
  const templateBlock = randomUUID()
  f.store.saveDocumentTemplate({ name: 'History-only ordinary template', title: 'Template', summary: '', blocks: [
    { id: templateBlock, type: 'paragraph', content: 'not a reservation', checked: false, depth: 0, parentBlockId: null }
  ] })
  assert.equal(f.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(templateBlock), undefined)
  insertCoverageSyntax(f.db, syntax)
  await withObserver2Copy(f.db, f.file, db => {
    const before = db.prepare('SELECT total_changes() AS n').get()
    const value = db.transaction(() => readRawCapsule2WorkspaceHistoryOwned(db))()
    assert.ok(value.historyDocuments.includes(long.id)); assert.ok(value.historyDocuments.includes(trashed.id))
    assert.ok(value.historyBlocks.includes(long.blockId)); assert.ok(value.historyBlocks.includes(trashed.blockId))
    assert.ok(value.unregisteredTemplateBlocks.includes(templateBlock)); assert.ok(value.groupIds.includes(f.groupId))
    assert.deepEqual(value.rawIdentities, db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities ORDER BY id').all())
    assert.deepEqual(value.historyRows[0], db.prepare('SELECT * FROM document_history ORDER BY id').all())
    assert.deepEqual(value.historyRows[1], db.prepare('SELECT * FROM document_trash ORDER BY id').all())
    assert.deepEqual(value.historyRows[2], db.prepare('SELECT * FROM document_block_moves ORDER BY id').all())
    assert.match(value.totalHistoricalObservationHash, /^[a-f0-9]{64}$/)
    assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false)
    assert.equal(value.accepted, false); assert.equal(value.effective, false); assert.equal(value.permit, false)
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before)
    assert.throws(() => db.transaction(() => readRawInitialIncomingWorkspaceOwned(db))(), /文档标题无效/)
  })
}))

test('workspace history2 keeps a genuine detached shared Main journal after redo pruning and refuses partial participants of a later real shared journal', () => withV3Fixture(async f => {
  // The stock V3 target starts with a heading; edit() changes the first
  // ordinary block, and the real Main correctly refuses heading rewrites.
  // Use another actual Store document with a paragraph for the shared edit.
  const target = ordinaryDocument(f, 'Shared history participant', 'Actual paragraph body')
  const targetId = target.id
  const shared = edit(f.db, [f.hostId, targetId], 'Real shared body before prune').ack
  assert.ok(shared.historyToken)
  restoreAck(f.db, shared, 'undo')
  edit(f.db, [f.hostId], 'Real new branch prunes complete shared redo')
  assert.ok(f.db.prepare('SELECT 1 FROM synced_host_history WHERE id=?').get(shared.historyToken))
  assert.equal(f.db.prepare('SELECT 1 FROM synced_host_history_documents WHERE history_id=?').get(shared.historyToken), undefined)
  await withObserver2Copy(f.db, f.file, db => {
    const value = db.transaction(() => readRawCapsule2WorkspaceHistoryOwned(db))()
    assert.ok(value.historyDocuments.includes(f.hostId)); assert.ok(value.historyDocuments.includes(targetId))
  })
  const later = edit(f.db, [f.hostId, targetId], 'Real later shared journal for negative copy').ack
  assert.ok(later.historyToken)
  const members = f.db.prepare('SELECT document_id FROM synced_host_history_documents WHERE history_id=?').all(later.historyToken)
  assert.equal(members.length, 2)
  // A deliberate corrupt-original negative, after a real Main event. No fake ACK.
  assert.equal(f.db.prepare('DELETE FROM synced_host_history_documents WHERE history_id=? AND document_id=?').run(later.historyToken, targetId).changes, 1)
  await withObserver2Copy(f.db, f.file, db => {
    const before = db.prepare('SELECT total_changes() AS n').get()
    assert.throws(() => db.transaction(() => readRawCapsule2WorkspaceHistoryOwned(db))(), /宿主历史|宿主 history|共享日志|历史位置/)
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before)
  })
}))

test('workspace history2 checks every genuine canonical history side beyond the current tail and refuses an altered dormant original hash', () => withV3Fixture(async f => {
  editCreatedGroup(f.db, f.groupId); editCreatedGroup(f.db, f.groupId)
  const dormant = f.db.prepare(`SELECT h.id FROM synced_group_history h JOIN synced_groups g ON g.id=h.group_id
    WHERE h.group_id=? AND h.position<g.history_position ORDER BY h.position LIMIT 1`).get(f.groupId) as { id: string } | undefined
  assert.ok(dormant, 'Two actual content writes leave an earlier noncurrent canonical history row')
  await withObserver2Copy(f.db, f.file, db => assert.ok(db.transaction(() => readRawCapsule2WorkspaceHistoryOwned(db))().groupIds.includes(f.groupId)))
  f.db.prepare('UPDATE synced_group_history SET before_hash=? WHERE id=?').run('0'.repeat(64), dormant.id)
  await withObserver2Copy(f.db, f.file, db => {
    const before = db.prepare('SELECT total_changes() AS n').get()
    assert.throws(() => db.transaction(() => readRawCapsule2WorkspaceHistoryOwned(db))(), /canonical history side\/hash/)
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before)
  })
}))

test('workspace history2 fails closed on unknown reserved metadata and marker rows after real Main history without repairing either original', () => withV3Fixture(async f => {
  editCreatedGroup(f.db, f.groupId)
  const key = 'synced.future-workspace-history.v99.' + randomUUID()
  f.db.prepare('INSERT INTO app_settings VALUES(?,?,?)').run(key, '{}', '2052-02-02T03:04:05.006Z')
  await withObserver2Copy(f.db, f.file, db => {
    const before = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(key)
    assert.throws(() => db.transaction(() => readRawCapsule2WorkspaceHistoryOwned(db))(), /未知|reserved/)
    assert.deepEqual(db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(key), before)
  })
  f.db.prepare('DELETE FROM app_settings WHERE key=?').run(key)
  const marker = 'synced:workspace-history-unknown:v99:' + randomUUID()
  f.db.prepare('INSERT INTO synced_operations VALUES(?,?,?,?)').run(marker, 'f'.repeat(64), '{}', '2052-03-02T03:04:05.006Z')
  await withObserver2Copy(f.db, f.file, db => {
    const before = db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(marker)
    assert.throws(() => db.transaction(() => readRawCapsule2WorkspaceHistoryOwned(db))(), /未知|reserved/)
    assert.deepEqual(db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(marker), before)
  })
}))
