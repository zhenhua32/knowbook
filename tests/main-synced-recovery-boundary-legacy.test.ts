import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { assertSyncedBlockSchema } from '../src/main/database/synced-schema'
import { getSyncedCreateRestoreContext } from '../src/main/database/synced-host-final'
import { withDatabase, ordinary, host, other } from './helpers/synced-content-fixture'
import { request, applied, logical, restoreInput, applySyncedHostFinal, restoreSyncedHostOperation,
  allTables, totalChanges, snapshot } from './helpers/synced-host-final-fixture'

function schema(db: Database.Database) {
  return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
}
function assertLegacy(db: Database.Database) {
  assert.equal(db.pragma('user_version', { simple: true }), 26)
  assertSyncedBlockSchema(db)
  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_master WHERE name IN
    ('synced_group_lifecycle','synced_group_retirements','synced_exposure_attempts','synced_group_exposure_members')`).all(), [],
  'A legacy host operation cannot fabricate or query a schema27 lifecycle/publication namespace')
}
/** Reuse the original schema26 fixture and real Main host writer. The fixture
 * contains no history rows; every executable journal below comes from Main. */
function withLegacyHosts(run: (db: Database.Database) => void) {
  withDatabase(db => {
    for (const [id, title] of [[host, 'Legacy Host A'], [other, 'Legacy Host B']]) {
      db.prepare('UPDATE documents SET title=?,path=?,summary=? WHERE id=?').run(title, title, '', id)
      ordinary(db, id + ':ordinary', { owner: id, sort: 1, type: 'paragraph' })
      db.prepare('UPDATE blocks SET content=?,tags_json=? WHERE id=?').run('Original ' + title, '[]', id + ':ordinary')
    }
    db.prepare("UPDATE blocks SET tags_json='[]' WHERE type='synced-block'").run()
    db.pragma('user_version=26')
    assertLegacy(db)
    assert.deepEqual(db.prepare('SELECT * FROM synced_host_history').all(), [])
    run(db)
  })
}

test('schema26 unknown create-restore tokens remain unavailable history without consulting schema27 tables or mutating SQL', () => withLegacyHosts(db => {
  const before = allTables(db), definitions = schema(db), changes = totalChanges(db)
  for (const direction of ['undo', 'redo'] as const) {
    assert.deepEqual(getSyncedCreateRestoreContext(db, { historyToken: randomUUID(), direction }),
      { status: 'unavailable', reason: 'history' })
  }
  assert.deepEqual(allTables(db), before)
  assert.deepEqual(schema(db), definitions)
  assert.equal(totalChanges(db), changes)
  assertLegacy(db)
}))

test('schema26 real shared host-final history retains actual Undo and Redo without introducing a recovery boundary or schema27 namespace', () => withLegacyHosts(db => {
  const before = [logical(db, host), logical(db, other)], groupBefore = snapshot(db), definitions = schema(db)
  const input = request(db, [host, other], sides => {
    for (const side of sides) side.blocks.find(block => block.id === side.documentId + ':ordinary')!.content += ' changed by Main'
  })
  const ack = applied(applySyncedHostFinal(db, input))
  assert.ok(ack.historyToken, 'The actual schema26 Main writer creates its own executable journal')
  assert.equal((db.prepare('SELECT count(*) AS count FROM synced_host_history_documents WHERE history_id=?').get(ack.historyToken) as { count: number }).count, 2)
  applied(restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')))
  assert.deepEqual([logical(db, host), logical(db, other)], before)
  applied(restoreSyncedHostOperation(db, restoreInput(db, ack, 'redo')))
  assert.deepEqual([logical(db, host), logical(db, other)], input.finalAfter)
  assert.deepEqual(snapshot(db).blocks, groupBefore.blocks)
  assert.equal(snapshot(db).creationId, groupBefore.creationId)
  assert.deepEqual(schema(db), definitions)
  assert.deepEqual(db.prepare("SELECT key FROM app_settings WHERE key LIKE 'synced.recovery.history.%'").all(), [])
  assertLegacy(db)
}))

test('schema26 original host and inverse ACKs replay before history admission even after a genuinely newer Main branch', () => withLegacyHosts(db => {
  const firstInput = request(db, [host], sides => {
    sides[0].blocks.find(block => block.id === host + ':ordinary')!.content += ' first Main edit'
  })
  const first = applied(applySyncedHostFinal(db, firstInput))
  assert.ok(first.historyToken)
  const undoInput = restoreInput(db, first, 'undo')
  const undo = applied(restoreSyncedHostOperation(db, undoInput))
  const nextInput = request(db, [host], sides => {
    sides[0].blocks.find(block => block.id === host + ':ordinary')!.content += ' newer Main branch'
  })
  const next = applied(applySyncedHostFinal(db, nextInput))
  assert.ok(next.historyToken && next.historyToken !== first.historyToken)
  const beforeReplay = allTables(db), definitions = schema(db), changes = totalChanges(db)
  assert.deepEqual(applied(applySyncedHostFinal(db, firstInput)), { ...first, replayed: true })
  assert.deepEqual(applied(restoreSyncedHostOperation(db, undoInput)), { ...undo, replayed: true })
  assert.deepEqual(allTables(db), beforeReplay, 'Original ACK replay cannot recut the current real branch or rewrite its guards')
  assert.deepEqual(schema(db), definitions)
  assert.equal(totalChanges(db), changes)
  assert.deepEqual(logical(db, host), nextInput.finalAfter[0])
  assertLegacy(db)
}))
