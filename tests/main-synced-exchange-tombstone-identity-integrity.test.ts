import assert from 'node:assert/strict'
import test from 'node:test'
import { SyncedPublicationError } from '../src/main/sync/synced-publication'
import { withTombstones, completed, randomUUID, allTables, deleteGroup, assertAbsentKnowledge,
  getSyncedGroupSnapshots, listSyncedGroups } from './helpers/synced-exchange-tombstone-fixture'

async function rejectDegradedIdentity(fault: 'reserved-null-known-birth' | 'retained-null-known-birth') {
  return withTombstones(async f => {
    const key = 'group:' + f.orphanId
    f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(), 'applied')
    const saved = assertAbsentKnowledge(f.B.db, key), effect = saved.proof.identities[0]
    assert.ok(effect && effect.after.kind === 'retained', 'The real successful deletion has an actual retained child whose nonnull birth is already proven')
    const id = effect.before.id, original = f.B.db.prepare('SELECT * FROM block_identities WHERE id=?').get(id) as
      { id: string; last_owner_kind: string; last_owner_id: string; state: string; created_at: string | null }
    assert.ok(original && original.state === 'retained' && original.created_at !== null, 'The bad-input fixture begins with the actual proof-backed known-birth retained ledger row')
    assert.equal(f.B.db.prepare('SELECT 1 FROM blocks WHERE id=? UNION ALL SELECT 1 FROM synced_group_blocks WHERE id=?').get(id, id), undefined)
    // The existing exact DDL permits a retained row without physical content to
    // lose birth or become reserved. No trigger/schema/physical row is removed.
    // A live-without-physical UPDATE would instead be rejected by the original
    // consistency trigger, and is deliberately not used as this regression.
    const changed = fault === 'reserved-null-known-birth'
      ? f.B.db.prepare("UPDATE block_identities SET last_owner_kind='reserved',last_owner_id=?,created_at=NULL WHERE id=? AND state='retained'").run('historical-input:' + randomUUID(), id)
      : f.B.db.prepare("UPDATE block_identities SET created_at=NULL WHERE id=? AND state='retained'").run(id)
    assert.equal(changed.changes, 1, 'The actual existing DDL accepts this historical corrupted-input fixture before the reader is exercised')
    const bad = f.B.db.prepare('SELECT * FROM block_identities WHERE id=?').get(id) as typeof original
    assert.equal(bad.state, 'retained'); assert.equal(bad.created_at, null)
    if (fault === 'reserved-null-known-birth') assert.equal(bad.last_owner_kind, 'reserved')
    assert.equal((f.B.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(saved.row.client_operation_id) as { result_json: string }).result_json, saved.row.result_json)
    const before = allTables(f.B.db), requests = f.server.requests.length
    f.reopenPeer()
    const failures: unknown[] = []
    for (const read of [() => getSyncedGroupSnapshots(f.B.db, { groupIds: [] }), () => getSyncedGroupSnapshots(f.B.db, { groupIds: [f.orphanId] }),
      () => listSyncedGroups(f.B.db, { query: '', offset: 0, limit: 10 })]) {
      try { read(); failures.push(null) } catch (error) { failures.push(error) }
    }
    let exchangeError: unknown
    try { await f.exchange() } catch (error) { exchangeError = error }
    assert.ok(failures.every(error => error instanceof Error), 'Empty and selected public group reads and list all reject a proof-backed child that has lost its known-birth identity')
    assert.ok(exchangeError instanceof SyncedPublicationError, 'The real exchange rejects the permanent proof identity inconsistency with its finite error')
    assert.equal(exchangeError.code, 'invalid')
    assert.equal(f.server.requests.length, requests, 'Corrupt durable deletion facts are rejected before the first HTTP request or new operation job')
    assert.deepEqual(allTables(f.B.db), before, 'Readers preserve the historical corrupted row and all original proof facts without repair or partial state advancement')
  })
}

test('actual permanent deletion rejects DDL-permitted reserved retained null-birth degradation of its proven original child', () => rejectDegradedIdentity('reserved-null-known-birth'))
test('actual permanent deletion rejects DDL-permitted retained unknown-birth degradation of its proven original child', () => rejectDegradedIdentity('retained-null-known-birth'))
