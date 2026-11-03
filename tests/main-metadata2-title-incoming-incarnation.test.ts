import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { readTitle2OriginalOperationOwned } from '../src/main/database/synced-host-title2-read'
import { decodeHostJournal, hostEncode } from '../src/main/database/synced-host-journal'
import { restoreInput } from './helpers/synced-host-final-fixture'
import { withIncomingFixture, accepted, request, allTables } from './helpers/synced-initial-incoming-fixture'

test('schema-restored corruption of a truly published incoming group remains Main-ready but cannot authorize its older title inverse', () => withIncomingFixture(async f => {
  await f.publish(); accepted(await f.receive())
  const groupId = f.ack.createdLifecycle.groupId
  assert.deepEqual(f.B.db.prepare('SELECT state,exposure_state,create_history_id FROM synced_group_lifecycle WHERE group_id=?').get(groupId),
    { state: 'active', exposure_state: 'unknown', create_history_id: null })
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_host_history').get() as { n: number }).n, 0)
  // The receiver really publishes its own immutable snapshot; SQL does not mint
  // a lifecycle, confirmed attempt, member, incoming receipt, or create proof.
  await f.send(f.B, { ...f.targetConfig, directory: 'Title-incoming-incarnation' })
  assert.deepEqual(f.B.db.prepare('SELECT state,exposure_state,create_history_id FROM synced_group_lifecycle WHERE group_id=?').get(groupId),
    { state: 'active', exposure_state: 'confirmed', create_history_id: null })
  const store = KnowbookStore.openCanonicalRuntime(f.B.file), sender = Object.freeze({ frame: 'original incoming title' })
  try {
    const db = store.getUnsafeDatabaseHandle(), opening = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: f.host })
    assert.equal(opening.status, 'ready'); if (opening.status !== 'ready') throw new Error('The true imported host must open')
    const input = request(db, [f.host], after => { after[0].title = 'Renamed incoming Source' })
    const saved = store.invokeSyncedEditingSession(sender, { sessionId: opening.session.sessionId, method: 'applySyncedHostStructure', input })
    assert.ok(saved.status === 'applied' || saved.status === 'noop')
    if (saved.status !== 'applied' && saved.status !== 'noop') throw new Error('A real committed title ACK is required')
    assert.ok(saved.historyToken)
    const original = db.transaction(() => readTitle2OriginalOperationOwned(db, saved.operationId))()
    assert.ok(original?.journal)
    assert.ok(decodeHostJournal(original.journal).groups.some(group => group.groupId === groupId))
    assert.equal(original.companion.groups.some(group => group.groupId === groupId), false,
      'Target.md and the self-group block URL do not change when their Source host is renamed')
    const raw = db.prepare('SELECT created_at,origin_json FROM synced_groups WHERE id=?').get(groupId) as { created_at: string; origin_json: string }
    const origin = JSON.parse(raw.origin_json) as { pathAtCreation: string }
    const changedBirth = new Date(Date.parse(raw.created_at) + 1).toISOString()
    const changedOrigin = hostEncode({ ...origin, pathAtCreation: origin.pathAtCreation + ' corruption' })
    const schema = () => db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all()
    const originalSchema = schema()
    const guardName = 'trg_synced_lifecycle_group_identity'
    const guard = db.prepare("SELECT sql FROM main.sqlite_master WHERE type='trigger' AND name=?").get(guardName) as { sql: string }
    assert.ok(guard?.sql)
    const replaceCorruptIdentity = (birth: string, originJson: string) => {
      assert.equal(db.inTransaction, false)
      assert.deepEqual(schema(), originalSchema)
      // Private temp-DB corruption, never a public ABA or a production bypass.
      // Restore every exact original DDL definition before any Main operation.
      db.transaction(() => {
        db.exec('DROP TRIGGER ' + guardName)
        assert.equal(db.prepare('UPDATE synced_groups SET created_at=?,origin_json=? WHERE id=?').run(birth, originJson, groupId).changes, 1)
        db.exec(guard.sql)
        assert.deepEqual(schema(), originalSchema, 'Every original table/index/trigger SQL definition is restored byte for byte')
      }).immediate()
      assert.equal(db.inTransaction, false)
      assert.deepEqual(schema(), originalSchema)
    }
    for (const scenario of [
      { name: 'birth', birth: changedBirth, origin: raw.origin_json },
      { name: 'Origin', birth: raw.created_at, origin: changedOrigin }
    ]) {
      const intact = allTables(db)
      assert.throws(() => db.prepare('UPDATE synced_groups SET created_at=?,origin_json=? WHERE id=?').run(scenario.birth, scenario.origin, groupId),
        (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_TRIGGER'
          && error.message === 'Lifecycle incarnation and origin are immutable')
      assert.deepEqual(allTables(db), intact, 'The genuine production trigger prevents a normal SQL identity substitution')
      assert.deepEqual(schema(), originalSchema)
      // Only the isolated original row is corrupted. All original create/
      // incoming/publication/title evidence, hashes, IDs and ref rows stay put.
      replaceCorruptIdentity(scenario.birth, scenario.origin)
      try {
        const freshSender = Object.freeze({ frame: 'fresh imported ' + scenario.name })
        const fresh = store.openSyncedEditingSession(freshSender, { kind: 'host', hostDocumentId: f.host })
        assert.equal(fresh.status, 'ready'); if (fresh.status !== 'ready') throw new Error('The substituted current host must genuinely open')
        const actual = store.invokeSyncedEditingSession(freshSender, { sessionId: fresh.session.sessionId,
          method: 'getSyncedGroupSnapshots', input: { groupIds: [groupId] } }).items[0]
        assert.equal(actual?.status, 'ready'); if (actual?.status !== 'ready') throw new Error('The real current group must remain readable before inverse')
        assert.equal(actual.snapshot.createdAt, scenario.birth)
        assert.equal(hostEncode(actual.snapshot.origin), scenario.origin)
        assert.equal((db.prepare('SELECT create_history_id FROM synced_group_lifecycle WHERE group_id=?').get(groupId) as { create_history_id: null }).create_history_id, null)
        const inverse = restoreInput(db, saved, 'undo'), before = allTables(db)
        const count = () => (db.prepare('SELECT total_changes() AS n').safeIntegers(true).get() as { n: bigint }).n
        const changes = count()
        const refused = store.invokeSyncedEditingSession(freshSender, { sessionId: fresh.session.sessionId,
          method: 'restoreSyncedHostOperation', input: inverse })
        assert.equal(refused.status, 'unsupported'); if (refused.status !== 'unsupported') throw new Error('The original journal identity must refuse this inverse')
        assert.match(refused.reason, /requires-lineage: an original journal reference incarnation changed/)
        assert.deepEqual(allTables(db), before)
        assert.equal(count(), changes, 'The original-incarnation refusal precedes every observe/capture or physical write')
        assert.equal(db.inTransaction, false)
        assert.equal(db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(inverse.clientOperationId), undefined)
      } finally {
        replaceCorruptIdentity(raw.created_at, raw.origin_json)
      }
    }
  } finally { store.destroy() }
}))
