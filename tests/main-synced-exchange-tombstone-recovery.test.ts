import assert from 'node:assert/strict'
import test from 'node:test'
import { SyncedPublicationError } from '../src/main/sync/synced-publication'
import { withTombstones, completed, randomUUID, encode, allTables, deleteGroup, document, rawGroup, missingGroup,
  assertAbsentKnowledge, state, rejected, hostEdit, liveKnowledge, count } from './helpers/synced-exchange-tombstone-fixture'

const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
function jobRows(db: Parameters<typeof allTables>[0], operationId: string) {
  return db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-job%.%' AND instr(value,?)>0 ORDER BY key").all(operationId) as Array<{ key: string; value: string }>
}

test('actual tombstone late receipt SQL failure rolls physical deletion identity effects marker anchor and baseline back then original published job resumes on a new connection', () => withTombstones(async f => {
  const operationId = randomUUID(), key = 'group:' + f.orphanId
  f.remoteFinal(records => { deleteGroup(records, f.orphanId); document(records, f.islands[1]).content.blocks[0].content = 'Real remote U received in the delete transaction' })
  hostEdit(f.B.db, f.islands[0], 'Real B outgoing U forces combined remote publication before SQL deletion')
  const oldStateRows = f.B.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange.v1.%'").all() as Array<{ key: string; value: string }>
  assert.equal(oldStateRows.length, 1, 'The rollback oracle captures the actual one target state bytes without assuming its pre-deletion format version')
  const before = liveKnowledge(f.B.db), oldState = oldStateRows[0], oldGroup = rawGroup(f.B.db, f.orphanId)
  const witness: Array<{ canonical: number; anchors: number; markers: number; incoming: number }> = []
  f.B.db.function('deletion_scalar_witness', (canonical: number, anchors: number, markers: number, incoming: number) => { witness.push({ canonical, anchors, markers, incoming }); return 0 })
  f.B.db.exec('CREATE TRIGGER tombstone_late_receipt BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id=' + quote(operationId) +
    " BEGIN SELECT deletion_scalar_witness((SELECT count(*) FROM synced_group_blocks WHERE group_id=" + quote(f.orphanId) +
    "),(SELECT count(*) FROM synced_exposure_attempts WHERE channel='logical-deletion-denial-v1'),(SELECT count(*) FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%')," +
    '(SELECT count(*) FROM blocks WHERE document_id=' + quote(f.islands[1]) + " AND content='Real remote U received in the delete transaction')); SELECT RAISE(ABORT,'actual late tombstone receipt fixture'); END")
  try {
    await rejected(() => f.exchange(f.B, operationId), 'database')
    assert.ok(witness.some(row => row.canonical === 0 && row.anchors > 0 && row.markers > 0 && row.incoming === 1), 'Native SQL observed the actual deleted canonical body, denial proof and incoming U before aborting the finite public receipt')
    assert.deepEqual(liveKnowledge(f.B.db), before)
    assert.deepEqual(f.B.db.prepare('SELECT key,value FROM app_settings WHERE key=?').get(oldState.key), oldState)
    assert.deepEqual(rawGroup(f.B.db, f.orphanId), oldGroup)
    assert.equal(count(f.B.db, 'synced_operations', 'client_operation_id', operationId), 0)
    assert.equal((f.B.db.prepare("SELECT count(*) AS n FROM synced_exposure_attempts WHERE channel='logical-deletion-denial-v1'").get() as { n: number }).n, 0)
    const jobs = jobRows(f.B.db, operationId)
    assert.ok(jobs.some(row => JSON.parse(row.value).phase === 'published-local-deferred'), 'The actual remote-success fact survives the local SQL rollback in the original durable job')
    assert.equal(f.remote().records.get('group:' + f.orphanId)?.kind, 'synced-group-deleted')
    const u = f.remote().records.get('doc:' + f.islands[0]); assert.ok(u?.kind === 'document', 'The actual combined remote manifest still contains the outgoing ordinary record')
    assert.equal(u.content.blocks[0].content, 'Real B outgoing U forces combined remote publication before SQL deletion')
    f.B.db.exec('DROP TRIGGER tombstone_late_receipt'); f.reopenPeer()
    const retried = completed(await f.exchange(f.B, operationId), 'applied')
    assert.equal(retried.operationId, operationId); missingGroup(f.B.db, f.orphanId)
    const saved = assertAbsentKnowledge(f.B.db, key)
    assert.equal(saved.proof.application.operationId, operationId)
    assert.equal((f.B.db.prepare("SELECT count(*) AS n FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%'").get() as { n: number }).n, 1)
    const requests = f.server.requests.length, tables = allTables(f.B.db)
    assert.deepEqual(await f.exchange(f.B, operationId), { ...retried, replayed: true })
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), tables)
  } finally { if (f.B.db.open) f.B.db.exec('DROP TRIGGER IF EXISTS tombstone_late_receipt') }
}))

test('actual 412 re-read preserves deletion identity intent and accepts the new unrelated remote record instead of using stale manifest bytes', () => withTombstones(async f => {
  f.remoteFinal(records => { deleteGroup(records, f.orphanId) })
  hostEdit(f.B.db, f.islands[0], 'B genuine outgoing edit around manifest CAS')
  let raced = false
  f.server.setHook(request => {
    if (!raced && request.method === 'PUT' && request.path.endsWith('/manifest.json')) {
      raced = true; f.remoteFinal(records => { document(records, f.islands[1]).content.blocks[0].content = 'Actual concurrent remote U before first manifest CAS' })
    }
  })
  const result = completed(await f.exchange(), 'applied')
  assert.equal(raced, true); assert.ok(result.acceptedKeys.includes('group:' + f.orphanId), 'A real 412 replan still accepts the exact predecessor-bound deletion')
  assert.equal(f.B.db.prepare('SELECT content FROM blocks WHERE document_id=? ORDER BY sort_order LIMIT 1').get(f.islands[1]) &&
    (f.B.db.prepare('SELECT content FROM blocks WHERE document_id=? ORDER BY sort_order LIMIT 1').get(f.islands[1]) as { content: string }).content, 'Actual concurrent remote U before first manifest CAS')
  const puts = f.server.requests.filter(request => request.method === 'PUT' && request.path.endsWith('/manifest.json'))
  assert.ok(puts.length >= 2, 'The original conditional write is rejected and the actual consumer performs a new manifest CAS')
  assert.notEqual(puts.at(-2)?.ifMatch, puts.at(-1)?.ifMatch)
  assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId)
}))

test('actual manifest lost ACK recovers the originally published tombstone and same operation never mints a second denial anchor', () => withTombstones(async f => {
  const operationId = randomUUID()
  f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); hostEdit(f.B.db, f.islands[0], 'B combined publication for lost ACK')
  let disconnected = false
  f.server.setHook(request => { if (!disconnected && request.method === 'PUT' && request.path.endsWith('/manifest.json')) { disconnected = true; return { kind: 'persist-then-disconnect' } } })
  let first: Awaited<ReturnType<typeof f.exchange>> | undefined
  try { first = await f.exchange(f.B, operationId) } catch (error) {
    assert.ok(error instanceof SyncedPublicationError, 'The lost network ACK retains its actual finite transport error if immediate confirmation is unavailable')
    assert.equal(error.code, 'transport')
  }
  assert.equal(disconnected, true); f.server.setHook(undefined)
  f.reopenPeer(); const result = completed(await f.exchange(f.B, operationId), 'applied')
  assert.equal(result.operationId, operationId); if (first) assert.equal(completed(first).operationId, operationId)
  const saved = assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId)
  assert.equal(saved.proof.application.operationId, operationId)
  assert.equal((f.B.db.prepare("SELECT count(*) AS n FROM synced_exposure_attempts WHERE channel='logical-deletion-denial-v1'").get() as { n: number }).n, 1)
}))

test('actual committed deletion receipt replays with zero HTTP after recovery epoch changes while a new operation cannot borrow its old write authority', () => withTombstones(async f => {
  const operationId = randomUUID(); f.remoteFinal(records => { deleteGroup(records, f.orphanId) })
  const first = completed(await f.exchange(f.B, operationId), 'applied'), proof = assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId)
  f.B.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
  const before = allTables(f.B.db), requests = f.server.requests.length
  assert.deepEqual(await f.exchange(f.B, operationId), { ...first, replayed: true })
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
  missingGroup(f.B.db, f.orphanId)
  assert.equal(assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId).row.result_json, proof.row.result_json)
}))
