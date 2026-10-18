import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { withV3Fixture, request, applied, applySyncedHostFinal, randomUUID } from './helpers/synced-backup-v3-fixture'
import { withDeletionPrimer, completed, encode, hash } from './helpers/synced-exchange-tombstone-primer-fixture'
import { withControlledRestore, restoreKnowbookDatabase, ordinaryBackup, noProcesses, originals,
  assertOriginals, inspect, KnowbookStore } from './helpers/controlled-restore-fixture'

test('controlled restore refuses a current produced by actual Main create rather than replacing its known group lifecycle and executable history', () => withV3Fixture(async live => {
  assert.equal(live.created.createdLifecycle.state, 'active')
  assert.ok(live.db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(live.groupId), 'The current group is an actual Main-created immutable incarnation')
  assert.ok(live.db.prepare('SELECT 1 FROM synced_host_history WHERE id=?').get(live.created.historyToken), 'The current create has its actual executable structure history')
  await withControlledRestore(async f => {
    f.close(); live.close()
    const before = originals(live.file)
    let replaced = false
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: live.userDataRoot, backupPath: f.backup, stopProcesses: noProcesses, beforeReplace: async () => { replaced = true } }))
    assert.equal(replaced, false)
    assertOriginals(live.file, before)
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  })
}))

test('controlled restore refuses a candidate backed up from actual Main group creation and leaves an ordinary current unchanged', () => withV3Fixture(async live => {
  await withControlledRestore(async f => {
    const candidate = join(f.root, 'real-synchronized-candidate.db')
    await live.db.backup(candidate)
    const sourceBytes = Buffer.from(readFileSync(candidate)), before = f.sealCurrent()
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: candidate, stopProcesses: noProcesses }))
    assertOriginals(f.database, before)
    assert.deepEqual(readFileSync(candidate), sourceBytes)
  })
}))

test('controlled restore preserves actual Main V3 exposure and its known group facts instead of rolling them back to an ordinary backup', () => withV3Fixture(async live => {
  writeSyncedBackupV3(live.db, { userDataRoot: live.userDataRoot, destination: live.destination, snapshotId: randomUUID() })
  const attempts = live.db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all()
  assert.ok(attempts.length > 0, 'The real writer committed exposure before producing its recoverable V3 files')
  await withControlledRestore(async f => {
    f.close(); live.close()
    const before = originals(live.file)
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: live.userDataRoot, backupPath: f.backup, stopProcesses: noProcesses }))
    assertOriginals(live.file, before)
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  })
}))

test('controlled restore refuses genuine accepted tombstone proof and independent denial anchor rather than resurrecting a prior ordinary backup', () => withDeletionPrimer(async deleted => {
  deleted.remoteFinal(records => {
    const old = records.get('group:' + deleted.groupId)
    assert.ok(old?.kind === 'synced-group', 'The remote deletion starts from the actual real sender group wire')
    records.set('group:' + deleted.groupId, { kind: 'synced-group-deleted', id: deleted.groupId, creationId: old.creationId, previousHash: hash(encode(old)), deletedAt: new Date().toISOString() })
  })
  const accepted = completed(await deleted.exchange(), 'applied')
  assert.ok(accepted.appliedKeys.includes('group:' + deleted.groupId), 'The actual Main tombstone consumer physically accepted this group deletion')
  const markers = deleted.B.db.prepare("SELECT * FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%'").all()
  const anchors = deleted.B.db.prepare("SELECT * FROM synced_exposure_attempts WHERE channel='logical-deletion-denial-v1'").all()
  assert.ok(markers.length > 0 && anchors.length > 0, 'Both original strict deletion markers and independent immutable anchors actually exist')
  await withControlledRestore(async f => {
    f.close(); deleted.B.db.close()
    const before = originals(deleted.B.file)
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: deleted.B.root, backupPath: f.backup, stopProcesses: noProcesses }))
    assertOriginals(deleted.B.file, before)
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  })
}))

test('controlled restore refuses genuine group-free Main host-final executable history without treating it as ordinary document history', () => withControlledRestore(async f => {
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM synced_groups').get() as { n: number }).n, 0)
  const input = request(f.db, [f.currentId], sides => { sides[0].blocks[0].content += ' actual Main structural transaction' })
  const ack = applied(applySyncedHostFinal(f.db, input))
  assert.ok(ack.historyToken, 'The actual group-free Main host-final write creates a real executable synced host journal')
  assert.ok(f.db.prepare('SELECT 1 FROM synced_host_history WHERE id=?').get(ack.historyToken), 'The actual executable token is persisted before refusal')
  const before = f.sealCurrent()
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses }))
  assertOriginals(f.database, before)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore preserves ordinary move journal and trash raw facts, makes old move CAS stale, and permits a new real move undo', () => withControlledRestore(async f => {
  const source = await ordinaryBackup(join(f.root, 'ordinary-moves'), 'Source with real ordinary moves', true)
  assert.ok(source.move, 'The supported source has a genuine Store block transfer rather than a forged operation row')
  const oldMove = source.move
  const before = inspect(source.backup, db => ({ moves: db.prepare('SELECT * FROM document_block_moves ORDER BY id').all(),
    history: db.prepare('SELECT * FROM document_history ORDER BY id').all(), trash: db.prepare('SELECT * FROM document_trash ORDER BY id').all(),
    versions: (db.prepare('SELECT updated_at FROM documents').all() as Array<{ updated_at: string }>).map(row => row.updated_at) }))
  assert.ok(before.moves.length > 0 && before.history.length > 0 && before.trash.length > 0, 'The real ordinary source contains move, document history and trash facts')
  f.sealCurrent()
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: source.backup, stopProcesses: noProcesses })
  assert.equal(result.continuity, 'ordinary-verified')
  inspect(f.database, db => {
    assert.deepEqual(db.prepare('SELECT * FROM document_block_moves ORDER BY id').all(), before.moves)
    assert.deepEqual(db.prepare('SELECT * FROM document_history ORDER BY id').all(), before.history)
    assert.deepEqual(db.prepare('SELECT * FROM document_trash ORDER BY id').all(), before.trash)
    const versions = (db.prepare('SELECT updated_at FROM documents').all() as Array<{ updated_at: string }>).map(row => row.updated_at)
    assert.ok(versions.every(value => !before.versions.includes(value) && !Object.values(oldMove.expectedUpdatedAtByDocument).includes(value)), 'The installed document boundary differs from all actual source and ordinary move expected versions')
    assert.equal(new Set(versions).size, 1)
  })
  const store = new KnowbookStore(f.database)
  try {
    const rowsBefore = store.getUnsafeDatabaseHandle().prepare('SELECT * FROM document_block_moves ORDER BY id').all()
    assert.throws(() => store.undoDocumentBlockMove({ operationId: oldMove.operationId, expectedUpdatedAtByDocument: oldMove.expectedUpdatedAtByDocument }), /文档.*变化/)
    assert.deepEqual(store.getUnsafeDatabaseHandle().prepare('SELECT * FROM document_block_moves ORDER BY id').all(), rowsBefore)
    const from = store.getDocumentDetail(oldMove.target.id), to = store.getDocumentDetail(oldMove.source.id)
    assert.ok(from && to, 'Both real installed ordinary owners remain available for a new operation')
    const moving = from.blocks.find(block => oldMove.movedBlockIds.includes(block.id))
    assert.ok(moving, 'The original stable moved block is currently owned by the actual installed target')
    const moved = store.moveDocumentBlocks({ fromDocumentId: from.id, toDocumentId: to.id, blockIds: [moving.id], expectedFromUpdatedAt: from.updatedAt, expectedToUpdatedAt: to.updatedAt })
    assert.equal(moved.state, 'applied')
    assert.equal(store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument }).state, 'undone')
  } finally { store.destroy() }
  assert.deepEqual(readFileSync(source.backup), source.sourceBytes)
}))
