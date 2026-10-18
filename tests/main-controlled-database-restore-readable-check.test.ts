import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { getSyncedGroupSnapshots } from '../src/main/database/synced-blocks-read'
import { withV3Fixture, randomUUID } from './helpers/synced-backup-v3-fixture'
import { withControlledRestore, restoreKnowbookDatabase, noProcesses, originals, assertOriginals, inspect, files } from './helpers/controlled-restore-fixture'

test('controlled restore refuses readable CHECK corruption without downgrading an actual Main group and lifecycle to unverified disaster emptiness', () => withV3Fixture(async live => {
  const realGroup = getSyncedGroupSnapshots(live.db, { groupIds: [live.groupId] })
  const originalFacts = { group: live.db.prepare('SELECT * FROM synced_groups WHERE id=?').get(live.groupId),
    lifecycle: live.db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(live.groupId),
    history: live.db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(live.created.historyToken) }
  assert.ok(originalFacts.group && originalFacts.lifecycle && originalFacts.history, 'The current owns a genuine Main group lifecycle and immutable create journal before negative input mutation')
  const id = randomUUID(), now = new Date().toISOString()
  // A bad-input fixture only: preserve all original schema and triggers. An
  // extra group row violates the original JSON-object CHECK, not physical IO.
  live.db.pragma('ignore_check_constraints=ON')
  try {
    live.db.prepare("INSERT INTO synced_groups(id,creation_id,created_at,origin_json,bindings_json,revision,topology_revision,history_cursor,history_position) VALUES(?,?,?,'[]','[]',?,?,?,0)")
      .run(id, randomUUID(), now, randomUUID(), randomUUID(), randomUUID())
  } finally { live.db.pragma('ignore_check_constraints=OFF') }
  const checks = live.db.pragma('integrity_check') as Array<Record<string, unknown>>
  assert.ok(checks.some(row => Object.values(row).some(value => typeof value === 'string' && /CHECK constraint failed in synced_groups/.test(value))), 'SQLite itself reports the exact original synced_groups CHECK violation')
  assert.deepEqual(getSyncedGroupSnapshots(live.db, { groupIds: [live.groupId] }), realGroup)
  assert.deepEqual({ group: live.db.prepare('SELECT * FROM synced_groups WHERE id=?').get(live.groupId),
    lifecycle: live.db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(live.groupId),
    history: live.db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(live.created.historyToken) }, originalFacts)
  await withControlledRestore(async f => {
    f.close(); live.close()
    const before = originals(live.file)
    let moving = false
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: live.userDataRoot, backupPath: f.backup, stopProcesses: noProcesses, beforeReplace: async () => { moving = true } }))
    assert.equal(moving, false)
    assertOriginals(live.file, before)
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
    assert.equal(existsSync(join(live.userDataRoot, 'database-restore-fence.json')), false)
    assert.equal(existsSync(join(live.userDataRoot, 'database-restore-pending.json')), false)
    const oracle = join(f.root, 'readable-check-fact-oracle')
    mkdirSync(oracle)
    for (const name of files) {
      const actual = join(live.userDataRoot, 'storage', name)
      if (existsSync(actual)) copyFileSync(actual, join(oracle, name))
    }
    inspect(join(oracle, 'knowbook.db'), db => {
      assert.deepEqual(db.prepare('SELECT * FROM synced_groups WHERE id=?').get(live.groupId), originalFacts.group)
      assert.deepEqual(db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(live.groupId), originalFacts.lifecycle)
      assert.deepEqual(db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(live.created.historyToken), originalFacts.history)
      assert.equal((db.prepare('SELECT origin_json FROM synced_groups WHERE id=?').get(id) as { origin_json: string }).origin_json, '[]')
    })
    assertOriginals(live.file, before)
  })
}))
