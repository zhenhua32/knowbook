import assert from 'node:assert/strict'
import test from 'node:test'
import { previewSyncedExchangeConflicts } from '../src/main/sync/synced-exchange'
import { ready, component } from './helpers/synced-exchange-conflict-fixture'
import { withTombstones, divergentUnpinnedGroup, realNewReference, snapshot, count, runtime, randomUUID, allTables } from './helpers/synced-deletion-choice-setup'

test('original live-only conflict preview accurately blocks real divergent same-creation G deletion despite an actual unpinned orphan source', () => withTombstones(async f => {
  const conflict = divergentUnpinnedGroup(f), before = allTables(f.B.db)
  const p = ready(await f.track(previewSyncedExchangeConflicts(f.B.db, { previewId: randomUUID(), userDataRoot: f.B.root, target: f.targetConfig }, runtime)))
  const c = component(p, conflict.key)
  assert.deepEqual(c.choices, []); assert.equal(c.reason, 'tombstone')
  assert.deepEqual(snapshot(f.B.db, conflict.id), conflict.local)
  assert.equal(count(f.B.db, 'synced_group_pins', 'group_id', conflict.id), 0)
  assert.deepEqual((allTables(f.B.db).synced_operations as unknown[]), (before.synced_operations as unknown[]), 'The old preview does not pretend to execute a deletion decision')
}))

test('original live-only conflict preview accurately blocks delete versus a genuine Main new reference and keeps its producer-created history pin', () => withTombstones(async f => {
  const conflict = realNewReference(f), p = ready(await f.track(previewSyncedExchangeConflicts(f.B.db, { previewId: randomUUID(), userDataRoot: f.B.root, target: f.targetConfig }, runtime)))
  const c = component(p, conflict.key)
  assert.deepEqual(c.choices, []); assert.equal(c.reason, 'tombstone')
  assert.deepEqual(snapshot(f.B.db, conflict.id), conflict.local)
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_group_pins WHERE group_id=? ORDER BY kind,pin_id').all(conflict.id), conflict.pins)
  assert.equal(f.B.db.prepare("SELECT count(*) AS n FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%'").get() && (f.B.db.prepare("SELECT count(*) AS n FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%'").get() as { n: number }).n, 0)
}))
