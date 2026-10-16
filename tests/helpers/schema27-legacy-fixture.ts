import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { assertSyncedBlockSchema } from '../../src/main/database/synced-schema'
import { assertSyncedLifecycleSchema } from '../../src/main/database/synced-lifecycle-schema'

/** These narrow old-column migration fixtures start from today's Store. Remove
 * its later schema27 namespace before applying the fixture's old columns and
 * user_version. This is test construction, never a production repair path or
 * a claim that the fixture reproduces every historical DDL statement. */
export function removeSchema27ForLegacyFixture(db: Database.Database): void {
  assert.equal(db.inTransaction, false)
  assert.equal(db.pragma('user_version', { simple: true }), 27)
  assertSyncedBlockSchema(db)
  assertSyncedLifecycleSchema(db)
  const tables = ['synced_group_exposure_members', 'synced_group_retirements',
    'synced_exposure_attempts', 'synced_group_lifecycle']
  for (const table of tables) {
    assert.equal((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count, 0,
      `The legacy fixture must not discard schema27 state: ${table}`)
  }
  db.transaction(() => {
    // Several schema27 guards are attached to schema26 tables, so dropping just
    // the four new tables would leave dangling guards in the old fixture.
    const guards = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND (name GLOB 'trg_synced_lifecycle_*' OR name GLOB 'trg_synced_retirement_*'
        OR name GLOB 'trg_synced_exposure_*') ORDER BY name`).all() as Array<{ name: string }>
    assert.ok(guards.length > 0)
    for (const { name } of guards) {
      assert.match(name, /^[a-z_]+$/)
      db.exec(`DROP TRIGGER ${name}`)
    }
    for (const table of tables) db.exec(`DROP TABLE ${table}`)
    const remaining = db.prepare(`SELECT name FROM sqlite_master
      WHERE name IN (SELECT value FROM json_each(?))
        OR instr(sql,?)>0 OR instr(sql,?)>0 OR instr(sql,?)>0 OR instr(sql,?)>0`).all(JSON.stringify(tables), ...tables)
    assert.deepEqual(remaining, [], 'The old fixture must have no schema27 objects or dangling guards')
    assertSyncedBlockSchema(db)
    assert.equal(db.pragma('user_version', { simple: true }), 27)
  })()
}
