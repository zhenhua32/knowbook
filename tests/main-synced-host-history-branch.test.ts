import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { pruneSyncedHostRedoBranches, type SyncedHostHistoryBranchRow } from '../src/main/database/synced-host-history-branch'
import { getSyncedHostHistory } from '../src/main/database/synced-blocks-read'
import { updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { validateSyncedStructureInput } from '../src/shared/syncedBlockInputs'
import { assertSyncedShape, validateSyncedHostForest } from '../src/shared/syncedBlockValidation'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { parseStrictJson } from '../src/shared/strictJson'
import type { SyncedStructureInput } from '../src/shared/synced-blocks'
import { host, other, now, uuid, withDatabase, state, update, saved } from './helpers/synced-content-fixture'

type HostSide = Extract<SyncedStructureInput, { mode: 'host-final' }>['finalAfter'][number]
const third = ' constructor:第三\0 '
const encode = canonicalSyncedPortableJson
const hash = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex')
const parse = (value: string): unknown => parseStrictJson(value, { maxBytes: Math.max(1, Buffer.byteLength(value)), maxDepth: 32 })
const sorted = (values: readonly string[]) => [...values].sort()

/** This test codec reads real host-final DTOs, not the mapping table. A future
 * production journal codec may choose its own closed action/audit envelope. */
function participants(row: Readonly<SyncedHostHistoryBranchRow>): string[] {
  const sides = (source: string, expectedHash: string): HostSide[] => {
    const value = parse(source)
    if (!Array.isArray(value) || !value.length) throw new Error('Invalid host side')
    const result = Array.from(value, raw => {
      assertSyncedShape(raw, ['documentId', 'title', 'summary', 'blocks'])
      if (typeof raw.documentId !== 'string' || !raw.documentId.trim() || typeof raw.title !== 'string' || typeof raw.summary !== 'string') {
        throw new Error('Invalid host side')
      }
      return { documentId: raw.documentId, title: raw.title, summary: raw.summary, blocks: validateSyncedHostForest(raw.blocks) }
    })
    if (new Set(result.map(item => item.documentId)).size !== result.length) throw new Error('Duplicate host side')
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || hash(result) !== expectedHash) throw new Error('Invalid host side hash')
    return result
  }
  const before = sides(row.before_json, row.before_hash), after = sides(row.after_json, row.after_hash)
  assert.deepEqual(sorted(before.map(item => item.documentId)), sorted(after.map(item => item.documentId)), 'Unequal host side participants')
  const action = validateSyncedStructureInput(parse(row.action_json))
  if (action.mode !== 'host-final') throw new Error('Invalid test journal action')
  assert.equal(encode(action.hostsWorkingBefore.map(item => ({ documentId: item.documentId, ...item.workingBefore }))), encode(before))
  assert.equal(encode(action.finalAfter), encode(after))
  return before.map(item => item.documentId)
}

function side(documentIds: readonly string[], content: string): HostSide[] {
  return documentIds.map(documentId => ({ documentId, title: 'History host', summary: '', blocks: [{
    id: documentId + ':body', parentBlockId: null, type: 'paragraph', content, checked: false, depth: 0
  }] }))
}
function journal(db: Database.Database, index: number, members: Array<[string, number]>): string {
  const id = uuid(index), before = side(members.map(([documentId]) => documentId), 'Before ' + index)
  const after = side(members.map(([documentId]) => documentId), 'After ' + index)
  const action: SyncedStructureInput = { clientOperationId: randomUUID(), mode: 'host-final', reason: 'selection-edit',
    hostsWorkingBefore: before.map(({ documentId, ...workingBefore }) => ({ documentId, expectedPersistedUpdatedAt: now, workingBefore })),
    groups: [], expectedInstances: [], finalAfter: after, newRefSources: [] }
  db.prepare('INSERT INTO synced_host_history(id,action_json,before_json,after_json,before_hash,after_hash,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, encode(action), encode(before), encode(after), hash(before), hash(after), now)
  for (const [documentId, position] of members) db.prepare('INSERT INTO synced_host_history_documents(history_id,document_id,position) VALUES(?,?,?)')
    .run(id, documentId, position)
  return id
}
function position(db: Database.Database, documentId: string, value = 0): string {
  const cursor = randomUUID()
  db.prepare('INSERT INTO synced_host_history_state(document_id,cursor,position) VALUES(?,?,?)').run(documentId, cursor, value)
  return cursor
}
function prune(db: Database.Database, documentIds: string[]) {
  return db.transaction(() => pruneSyncedHostRedoBranches(db, documentIds, participants)).immediate()
}
const mappings = (db: Database.Database) => db.prepare('SELECT history_id,document_id,position FROM synced_host_history_documents ORDER BY document_id,position').all()

test('Redo pruning closes shared suffix dependencies while preserving peer prefixes, immutable journals, pins and original ACKs', () => withDatabase(db => {
  const earlier = journal(db, 1010, [[other, 1]])
  const shared = journal(db, 1011, [[host, 1], [other, 2]])
  const nextShared = journal(db, 1012, [[other, 3], [third, 1]])
  const final = journal(db, 1013, [[third, 2]])
  const cursors = new Map([host, other, third].map(documentId => [documentId, position(db, documentId)]))
  db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)').run(uuid(10), 'host-history', shared, now)
  assert.equal(saved(updateSyncedBlockGroup(db, update(db, undefined, uuid(1100)))).status, 'noop')
  const before = state(db), result = prune(db, [host])
  assert.deepEqual(result.discardedHistoryIds, sorted([shared, nextShared, final]))
  assert.deepEqual(mappings(db), [{ history_id: earlier, document_id: other, position: 1 }])
  assert.deepEqual(result.changedStates.map(item => item.documentId), sorted([host, other, third]))
  for (const item of result.changedStates) {
    assert.equal(item.position, 0); assert.notEqual(item.cursor, cursors.get(item.documentId))
    assert.equal(getSyncedHostHistory(db, { documentId: item.documentId }).cursor, item.cursor)
  }
  assert.deepEqual(getSyncedHostHistory(db, { documentId: other }), {
    cursor: result.changedStates.find(item => item.documentId === other)!.cursor, undoToken: null, redoToken: earlier
  })
  for (const documentId of [host, third]) {
    const history = getSyncedHostHistory(db, { documentId })
    assert.equal(history.undoToken, null); assert.equal(history.redoToken, null)
  }
  const after = state(db)
  for (const table of Object.keys(before)) if (!['synced_host_history_documents', 'synced_host_history_state'].includes(table)) {
    assert.deepEqual(after[table], before[table], table)
  }
  // Reusing the freed position cannot turn an old detached token executable.
  const replacement = journal(db, 1014, [[host, 1]])
  assert.equal(getSyncedHostHistory(db, { documentId: host }).redoToken, replacement)
  assert.equal(db.prepare('SELECT 1 FROM synced_host_history_documents WHERE history_id=?').get(shared), undefined)
  assert.ok(db.prepare('SELECT 1 FROM synced_host_history WHERE id=?').get(shared))
}))

test('a shared cut retains applied history and independent Redo before the shared peer position', () => withDatabase(db => {
  const aBefore = journal(db, 1020, [[host, 1]]), bApplied = journal(db, 1021, [[other, 1]])
  const bRedo = journal(db, 1022, [[other, 2]]), shared = journal(db, 1023, [[host, 2], [other, 3]])
  const later = journal(db, 1024, [[other, 4]])
  position(db, host, 1); position(db, other, 1)
  const result = prune(db, [host])
  assert.deepEqual(result.discardedHistoryIds, [shared, later])
  assert.deepEqual(mappings(db), [
    { history_id: aBefore, document_id: host, position: 1 },
    { history_id: bApplied, document_id: other, position: 1 },
    { history_id: bRedo, document_id: other, position: 2 }
  ])
  assert.deepEqual(result.changedStates.map(item => item.position), [1, 1])
  const b = getSyncedHostHistory(db, { documentId: other })
  assert.equal(b.undoToken, bApplied); assert.equal(b.redoToken, bRedo)
}))

test('a later dependency lowers an already scanned peer cut and the fixed point still keeps its independent prefix', () => withDatabase(db => {
  const fourth = 'fourth'
  const prefix = journal(db, 1025, [[other, 1]])
  const earlyShared = journal(db, 1026, [[third, 1], [fourth, 1]])
  const connecting = journal(db, 1027, [[other, 2], [fourth, 2]])
  const firstShared = journal(db, 1028, [[host, 1], [other, 3]])
  const tail = journal(db, 1029, [[other, 4]])
  for (const documentId of [host, other, third, fourth]) position(db, documentId)
  // host first discovers other:3. The third -> fourth path subsequently finds
  // other:2, after other's initial suffix has already been scanned.
  const result = prune(db, [host, third])
  assert.deepEqual(result.discardedHistoryIds, [earlyShared, connecting, firstShared, tail])
  assert.deepEqual(mappings(db), [{ history_id: prefix, document_id: other, position: 1 }])
  assert.equal(result.changedStates.length, 4)
  assert.equal(getSyncedHostHistory(db, { documentId: other }).redoToken, prefix)
}))

test('a shared history item still applied by another host rejects with zero table mutations', () => withDatabase(db => {
  journal(db, 1030, [[host, 1], [other, 1]])
  position(db, host); position(db, other, 1)
  const before = state(db)
  assert.throws(() => prune(db, [host]), /均已撤销/)
  assert.deepEqual(state(db), before)
}))

test('bad hashes, closed sides and participant mismatches are decoded before any pruning writes', () => {
  for (const corruption of ['hash', 'closed-side', 'unequal-side', 'extra-mapping', 'missing-mapping', 'duplicate-side']) withDatabase(db => {
    const id = journal(db, 1040, [[host, 1], [other, 1]])
    position(db, host); position(db, other); position(db, third)
    if (corruption === 'hash') db.prepare('UPDATE synced_host_history SET after_hash=? WHERE id=?').run('0'.repeat(64), id)
    if (corruption === 'closed-side') {
      const value = side([host, other], 'After 1040').map(item => ({ ...item, unexpected: true }))
      db.prepare('UPDATE synced_host_history SET after_json=?,after_hash=? WHERE id=?').run(encode(value), hash(value), id)
    }
    if (corruption === 'unequal-side' || corruption === 'duplicate-side') {
      const value = side(corruption === 'unequal-side' ? [host] : [host, host], 'After 1040')
      db.prepare('UPDATE synced_host_history SET after_json=?,after_hash=? WHERE id=?').run(encode(value), hash(value), id)
    }
    if (corruption === 'extra-mapping') db.prepare('INSERT INTO synced_host_history_documents VALUES(?,?,1)').run(id, third)
    if (corruption === 'missing-mapping') db.prepare('DELETE FROM synced_host_history_documents WHERE history_id=? AND document_id=?').run(id, other)
    const before = state(db)
    assert.throws(() => prune(db, [host]))
    assert.deepEqual(state(db), before, corruption)
  })
})

test('missing states, invalid cursors and noncontiguous positions reject without inventing a usable branch', () => {
  for (const corruption of ['missing-state', 'cursor', 'gap', 'position']) withDatabase(db => {
    journal(db, 1050, [[host, 1], [other, 1]])
    position(db, host); position(db, other)
    if (corruption === 'missing-state') db.prepare('DELETE FROM synced_host_history_state WHERE document_id=?').run(other)
    if (corruption === 'cursor') db.prepare('UPDATE synced_host_history_state SET cursor=? WHERE document_id=?').run('not-a-uuid', other)
    if (corruption === 'gap') db.prepare('UPDATE synced_host_history_documents SET position=3 WHERE document_id=?').run(other)
    if (corruption === 'position') db.prepare('UPDATE synced_host_history_state SET position=2 WHERE document_id=?').run(other)
    const before = state(db)
    assert.throws(() => prune(db, [host]), /宿主.*无效/)
    assert.deepEqual(state(db), before, corruption)
  })
})

test('a late cursor SQL failure rolls back the whole prune savepoint even if the outer owner catches it, and exact retry can succeed', () => withDatabase(db => {
  const id = journal(db, 1060, [[host, 1], [other, 1]])
  position(db, host); position(db, other)
  const before = state(db)
  db.exec(`CREATE TEMP TRIGGER reject_branch_cursor BEFORE UPDATE ON synced_host_history_state
    WHEN NEW.document_id='${other}' BEGIN SELECT RAISE(ABORT,'injected branch cursor failure'); END`)
  db.transaction(() => {
    assert.throws(() => pruneSyncedHostRedoBranches(db, [host], participants), /injected branch cursor failure/)
    assert.equal(db.inTransaction, true)
    assert.deepEqual(state(db), before)
  }).immediate()
  assert.deepEqual(state(db), before)
  db.exec('DROP TRIGGER reject_branch_cursor')
  assert.deepEqual(prune(db, [host]).discardedHistoryIds, [id])
}))

test('an empty Redo suffix leaves the cursor unchanged and does not decode or write historical prefixes', () => withDatabase(db => {
  journal(db, 1070, [[host, 1]])
  position(db, host, 1)
  const before = state(db)
  const result = db.transaction(() => pruneSyncedHostRedoBranches(db, [host], () => { throw new Error('No Redo to decode') })).immediate()
  assert.deepEqual(result, { discardedHistoryIds: [], changedStates: [] })
  assert.deepEqual(state(db), before)
}))

test('the independent helper requires an outer write owner, foreign keys and strict opaque seed IDs', () => withDatabase(db => {
  journal(db, 1080, [[host, 1]])
  position(db, host)
  const before = state(db)
  assert.throws(() => pruneSyncedHostRedoBranches(db, [host], participants), /外层 IMMEDIATE/)
  for (const input of [[], [host, host], ['   '], new Array<string>(1)]) {
    assert.throws(() => prune(db, input), /宿主共享历史分支无效/)
    assert.deepEqual(state(db), before)
  }
  db.pragma('foreign_keys=OFF')
  assert.throws(() => prune(db, [host]), /启用 SQLite 外键/)
  assert.deepEqual(state(db), before)
  db.pragma('foreign_keys=ON')
}))
