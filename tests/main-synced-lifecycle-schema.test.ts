import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { assertSyncedLifecycleSchema, installSyncedLifecycleSchema } from '../src/main/database/synced-lifecycle-schema'
import { readSyncedGroupLifecycles } from '../src/main/database/synced-lifecycle-state'
import { getSyncedGroupSnapshots, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import { updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { initialize, groupId, now, state as legacyState, update } from './helpers/synced-content-fixture'
import { createdGroup27, retireFixture27 } from './helpers/synced-lifecycle-fixture'

function legacy(run: (db: Database.Database) => void): void {
  const db = new Database(':memory:')
  try { initialize(db); db.pragma('user_version=26'); run(db) } finally { db.close() }
}
function migrate(db: Database.Database): void {
  db.transaction(() => { installSyncedLifecycleSchema(db, now); db.pragma('user_version=27') })()
}
function snapshot(db: Database.Database): unknown {
  return { version: db.pragma('user_version', { simple: true }),
    schema: db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), data: legacyState(db) }
}

test('lifecycle installer requires the outer transaction, schema26 and foreign keys, and never advances user_version', () => legacy(db => {
  const before = snapshot(db)
  assert.throws(() => installSyncedLifecycleSchema(db), /外层/)
  db.pragma('foreign_keys=OFF')
  assert.throws(() => db.transaction(() => installSyncedLifecycleSchema(db))(), /外键/)
  db.pragma('foreign_keys=ON')
  assert.deepEqual(snapshot(db), before)
  db.transaction(() => installSyncedLifecycleSchema(db, now))()
  assert.equal(db.pragma('user_version', { simple: true }), 26)
  assertSyncedLifecycleSchema(db)
  db.pragma('user_version=27')
  const installed = snapshot(db)
  assert.throws(() => db.transaction(() => installSyncedLifecycleSchema(db))(), /仅接受/)
  assert.deepEqual(snapshot(db), installed)
}))

test('schema27 preserves all schema26 rows, definitions, IDs, timestamps and CAS; legacy groups remain active/unknown', () => legacy(db => {
  const before = snapshot(db) as { schema: unknown[]; data: unknown }
  migrate(db)
  assert.deepEqual(legacyState(db), before.data)
  const originalNames = (before.schema as Array<{ name: string }>).map(row => row.name)
  assert.deepEqual(db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?)) ORDER BY type,name`)
    .all(JSON.stringify(originalNames)), before.schema)
  const state = readSyncedGroupLifecycles(db, [groupId]).get(groupId)!
  assert.equal(state.state, 'active')
  assert.equal(state.exposure, 'unknown')
  assert.equal(state.createHistoryId, null)
  assert.equal(state.activationInstances.length, 1)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.throws(() => db.prepare(`UPDATE synced_group_lifecycle SET exposure_state='never',state_version=state_version+1
    WHERE group_id=?`).run(groupId), /Exposure|CHECK/)
}))

test('damaged original schema26 rolls back before installing any lifecycle structure', () => legacy(db => {
  db.exec('DROP TRIGGER trg_synced_identity_delete')
  const before = snapshot(db)
  assert.throws(() => db.transaction(() => installSyncedLifecycleSchema(db))(), /schema26.*关键结构/)
  assert.deepEqual(snapshot(db), before)
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='synced_group_lifecycle'").get(), undefined)
}))

test('failure after lifecycle installation rolls back all new schema and keeps the original version/data', () => legacy(db => {
  const before = snapshot(db)
  assert.throws(() => db.transaction(() => {
    installSyncedLifecycleSchema(db, now)
    db.pragma('user_version=27')
    throw new Error('controlled outer failure')
  })(), /controlled outer failure/)
  assert.deepEqual(snapshot(db), before)
  migrate(db)
  assertSyncedLifecycleSchema(db)
}))

test('normal content CAS remains readable and does not rewrite the last activation guard', () => legacy(db => {
  migrate(db)
  const before = readSyncedGroupLifecycles(db, [groupId]).get(groupId)!
  const input = update(db)
  input.blocks[0].content = 'Changed after activation'
  const result = updateSyncedBlockGroup(db, input)
  assert.equal(result.status, 'saved')
  const read = getSyncedGroupSnapshots(db, { groupIds: [groupId] }).items[0]
  assert.equal(read.status, 'ready')
  if (read.status === 'ready') {
    assert.notEqual(read.snapshot.revision, before.activationRevision)
    assert.equal(read.snapshot.blocks[0].content, 'Changed after activation')
  }
  assert.deepEqual(readSyncedGroupLifecycles(db, [groupId]).get(groupId), before)
}))

test('schema27 read assertion refuses missing state, missing structure and modified critical guards without repairs', () => {
  for (const damage of ['state', 'table', 'trigger', 'modified-trigger'] as const) legacy(db => {
    migrate(db)
    if (damage === 'state') {
      const guard = (db.prepare("SELECT sql FROM sqlite_master WHERE name='trg_synced_lifecycle_delete_guard'").get() as { sql: string }).sql
      db.exec('DROP TRIGGER trg_synced_lifecycle_delete_guard; DELETE FROM synced_group_lifecycle;')
      db.exec(guard)
    } else if (damage === 'table') db.exec('DROP TABLE synced_group_retirements')
    else {
      db.exec('DROP TRIGGER trg_synced_exposure_member_delete')
      if (damage === 'modified-trigger') db.exec('CREATE TRIGGER trg_synced_exposure_member_delete BEFORE DELETE ON synced_group_exposure_members BEGIN SELECT 1; END;')
    }
    const before = snapshot(db)
    assert.throws(() => assertSyncedLifecycleSchema(db), /schema27.*(关键结构|生命周期)/)
    assert.deepEqual(snapshot(db), before)
    assert.equal(db.inTransaction, false)
  })
})

test('requested active/retired reads and list count/page share the same active boundary, including active orphans', () => legacy(db => {
  migrate(db)
  const retired = createdGroup27(db), active = createdGroup27(db, 'Active orphan')
  retireFixture27(db, retired)
  db.prepare('DELETE FROM blocks WHERE id=?').run(active.instanceId)
  assertSyncedLifecycleSchema(db)
  const result = getSyncedGroupSnapshots(db, { groupIds: [retired.groupId, active.groupId, groupId] })
  assert.deepEqual(result.items.map(item => item.status), ['missing', 'ready', 'ready'])
  const first = listSyncedGroups(db, { query: '', offset: 0, limit: 1 })
  const second = listSyncedGroups(db, { query: '', offset: 1, limit: 1 })
  const third = listSyncedGroups(db, { query: '', offset: 2, limit: 1 })
  assert.equal(first.total, 2); assert.equal(second.total, 2); assert.equal(third.total, 2)
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 1); assert.equal(third.items.length, 0)
  assert.notEqual(first.items[0].groupId, second.items[0].groupId)
  assert.ok([...first.items, ...second.items].every(item => item.groupId !== retired.groupId))
  assert.equal(result.items[1].status === 'ready' && result.items[1].snapshot.instances.length, 0)
}))

test('missing lifecycle cannot silently disappear from snapshots or list pagination', () => legacy(db => {
  migrate(db)
  const guard = (db.prepare("SELECT sql FROM sqlite_master WHERE name='trg_synced_lifecycle_delete_guard'").get() as { sql: string }).sql
  db.exec('DROP TRIGGER trg_synced_lifecycle_delete_guard; DELETE FROM synced_group_lifecycle;')
  db.exec(guard)
  const before = snapshot(db)
  assert.throws(() => getSyncedGroupSnapshots(db, { groupIds: [groupId] }), /生命周期.*缺失/)
  assert.throws(() => listSyncedGroups(db, { query: '', offset: 0, limit: 1 }), /生命周期/)
  assert.deepEqual(snapshot(db), before)
}))

test('retired group and exact create journal retain RESTRICT lifetimes without allowing canonical resurrection', () => legacy(db => {
  migrate(db)
  const retired = createdGroup27(db)
  retireFixture27(db, retired)
  assert.throws(() => db.prepare('DELETE FROM synced_groups WHERE id=?').run(retired.groupId), /FOREIGN KEY/)
  assert.throws(() => db.prepare('DELETE FROM synced_host_history WHERE id=?').run(retired.journalId), /FOREIGN KEY/)
  assert.throws(() => db.prepare("UPDATE synced_host_history SET action_json='{}' WHERE id=?").run(retired.journalId), /cannot be rewritten/)
  assert.throws(() => db.prepare(`INSERT INTO synced_group_blocks(id,group_id,sort_order,type,content,created_at)
    VALUES(?,?,0,'paragraph','Resurrection',?)`).run(retired.childId, retired.groupId, retired.wire.blocks[0].createdAt), /active lifecycle/)
  assert.equal(getSyncedGroupSnapshots(db, { groupIds: [retired.groupId] }).items[0].status, 'missing')
}))

test('bad retired wire/hash is refused only when that real group is requested and is never repaired', () => legacy(db => {
  migrate(db)
  const retired = createdGroup27(db)
  retireFixture27(db, retired)
  db.exec('DROP TRIGGER trg_synced_retirement_update_guard')
  db.prepare('UPDATE synced_group_retirements SET semantic_hash=? WHERE group_id=?').run('0'.repeat(64), retired.groupId)
  const before = db.prepare('SELECT * FROM synced_group_retirements').all()
  assert.equal(getSyncedGroupSnapshots(db, { groupIds: [groupId] }).items[0].status, 'ready')
  assert.throws(() => getSyncedGroupSnapshots(db, { groupIds: [retired.groupId] }), /哈希/)
  assert.deepEqual(db.prepare('SELECT * FROM synced_group_retirements').all(), before)
}))

test('persistent exposure attempts/members cannot be deleted, rebound or regressed to never', () => legacy(db => {
  migrate(db)
  const fixture = createdGroup27(db), attempt = randomUUID()
  const active = getSyncedGroupSnapshots(db, { groupIds: [fixture.groupId] }).items[0]
  assert.equal(active.status, 'ready')
  if (active.status !== 'ready') return
  db.transaction(() => {
    db.prepare(`INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at)
      VALUES(?,?,'backup-v3',?,?,'possible',?)`).run(attempt, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), now)
    db.prepare(`INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash)
      VALUES(?,?,?,?,?,?)`).run(attempt, fixture.groupId, fixture.creationId, active.snapshot.revision,
      active.snapshot.topologyRevision, fixture.hash)
  })()
  assert.equal(readSyncedGroupLifecycles(db, [fixture.groupId]).get(fixture.groupId)!.exposure, 'possible')
  assert.throws(() => retireFixture27(db, fixture), /unpublished/)
  assert.throws(() => db.prepare('DELETE FROM synced_group_exposure_members WHERE attempt_id=?').run(attempt), /cannot be deleted/)
  assert.throws(() => db.prepare('UPDATE synced_group_exposure_members SET semantic_hash=? WHERE attempt_id=?').run('4'.repeat(64), attempt), /cannot be changed/)
  assert.throws(() => db.prepare('DELETE FROM synced_exposure_attempts WHERE id=?').run(attempt), /cannot be deleted/)
  db.prepare("UPDATE synced_exposure_attempts SET state='confirmed',confirmed_at=? WHERE id=?").run(now, attempt)
  assert.equal(readSyncedGroupLifecycles(db, [fixture.groupId]).get(fixture.groupId)!.exposure, 'confirmed')
  assert.throws(() => db.prepare("UPDATE synced_exposure_attempts SET state='possible',confirmed_at=NULL WHERE id=?").run(attempt), /immutable/)
  assert.throws(() => db.prepare("UPDATE synced_group_lifecycle SET exposure_state='never',state_version=state_version+1 WHERE group_id=?").run(fixture.groupId), /cannot regress/)
}))
