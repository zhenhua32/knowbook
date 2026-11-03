import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedStructureApplied } from '../src/shared/synced-blocks'
import { decodeHostJournal } from '../src/main/database/synced-host-journal'
import { readTitle2OriginalOperationOwned, title2OriginalSupportsOwned } from '../src/main/database/synced-host-title2-read'
import { historicalRowLocator } from '../src/main/database/synced-history-evidence-support'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { withTitle2Fixture } from './helpers/metadata2-title-fixture'

type Fixture = Parameters<Parameters<typeof withTitle2Fixture>[0]>[0]
type Pin = { group_id: string; kind: string; pin_id: string; created_at: string }

function unchangedReference(t: Fixture, saved: SyncedStructureApplied) {
  const db = t.store.getUnsafeDatabaseHandle(), token = saved.historyToken
  assert.ok(token, 'A real W!=A title action must have its genuine Main journal')
  const original = db.transaction(() => readTitle2OriginalOperationOwned(db, saved.operationId))()
  assert.ok(original?.journal)
  const journal = decodeHostJournal(original.journal)
  assert.ok(journal.groups.some(group => group.groupId === t.f.groupId), 'The unchanged host reference belongs to raw W/A dependencies')
  assert.equal(original.companion.groups.some(group => group.groupId === t.f.groupId), false,
    'This reference retains its V3 Target URI, so URI-maintenance-only companion groups cannot supply the closure')
  const pins = db.prepare('SELECT group_id,kind,pin_id,created_at FROM synced_group_pins WHERE kind=? AND pin_id=?')
    .all('host-history', token) as Pin[]
  assert.equal(pins.length, journal.groups.length)
  return { db, token, original, pins }
}

function refusedWithoutWrites(t: Fixture, saved: SyncedStructureApplied) {
  const db = t.store.getUnsafeDatabaseHandle(), before = allTables(db)
  // Go through the actual Store's authenticated session dispatch and fresh
  // current restore input. No handler, ACK, snapshot, journal or pin is faked.
  const totalChanges = () => BigInt((db.prepare('SELECT total_changes() AS count').get() as { count: number | bigint }).count)
  const changesBefore = totalChanges()
  assert.throws(() => t.restore(saved, 'undo'), /Metadata2 title original invalid:.*host-history pin/)
  assert.equal(totalChanges() - changesBefore, 0n, 'The pin refusal precedes any SQL mutation, including a later rolled-back one')
  assert.deepEqual(allTables(db), before, 'The original SQL stays exactly at the post-corruption pre-attempt state')
  assert.equal(db.inTransaction, false, 'The real outer transaction has rolled back completely')
  assert.throws(() => db.transaction(() => readTitle2OriginalOperationOwned(db, saved.operationId))(),
    /Metadata2 title original invalid:.*host-history pin/)
  assert.deepEqual(allTables(db), before)
}

test('title restore and original evidence reject a missing original pin for a raw W/A reference outside companion URI maintenance', () => withTitle2Fixture(t => {
  const saved = t.apply(t.titleInput('V3 Host', 'Pinned title'))
  const { db, token } = unchangedReference(t, saved)
  assert.equal(db.prepare('DELETE FROM synced_group_pins WHERE group_id=? AND kind=? AND pin_id=?')
    .run(t.f.groupId, 'host-history', token).changes, 1)
  refusedWithoutWrites(t, saved)
}))

test('title restore and original evidence reject an extra host-history pin instead of accepting a superset of the journal dependencies', () => withTitle2Fixture(t => {
  const saved = t.apply(t.titleInput('V3 Host', 'Pinned title'))
  const { db, token, original } = unchangedReference(t, saved)
  const journal = decodeHostJournal(original.journal!)
  assert.equal(journal.groups.some(group => group.groupId === t.groupId), false)
  db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)')
    .run(t.groupId, 'host-history', token, original.journal!.created_at)
  refusedWithoutWrites(t, saved)
}))

test('title restore and original evidence reject a changed original host-history pin timestamp despite an unchanged key and journal', () => withTitle2Fixture(t => {
  const saved = t.apply(t.titleInput('V3 Host', 'Pinned title'))
  const { db, token, original } = unchangedReference(t, saved)
  const changedAt = new Date(Date.parse(original.journal!.created_at) + 1).toISOString()
  assert.equal(db.prepare('UPDATE synced_group_pins SET created_at=? WHERE group_id=? AND kind=? AND pin_id=?')
    .run(changedAt, t.f.groupId, 'host-history', token).changes, 1)
  refusedWithoutWrites(t, saved)
}))

test('title original supports include the actual complete four-column pins for every raw journal reference', () => withTitle2Fixture(t => {
  const saved = t.apply(t.titleInput('V3 Host', 'Pinned title'))
  const { db, pins } = unchangedReference(t, saved)
  const { supports } = db.transaction(() => title2OriginalSupportsOwned(db, saved.operationId))()
  const locators = supports.filter(locator => locator.table === 'synced_group_pins')
  assert.equal(locators.length, pins.length, 'Original evidence retains every actual four-column journal pin')
  for (const pin of pins) assert.ok(locators.some(locator =>
    JSON.stringify(locator) === JSON.stringify(historicalRowLocator('synced_group_pins', [pin.group_id, pin.kind, pin.pin_id], pin))))
}))
