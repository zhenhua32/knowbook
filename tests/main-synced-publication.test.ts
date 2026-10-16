import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serializeDatabaseViewPayload, parseDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { parseSyncedPortableAssetUri } from '../src/shared/syncedBlockPortable'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from '../src/main/database/synced-lifecycle-state'
import { WebDavClient } from '../src/main/sync/webdav-client'
import { withPublicationFixture, prepared, facts, remote, rejectedCode, runtime, hash, encode, contentRequests,
  publicationRows, catalogId, customId, catalogColumn, customColumn, savedViewId, entityId,
  prepareInitialSyncedPublication, publishInitialSyncedPublication, queryInitialSyncedPublication,
  recoverInitialSyncedPublication, disposePreparedSyncedPublication, readPreparedSyncedPublication,
  readSyncedPublishedSnapshot, readSyncedPublishedSnapshotFacts, createDefaultDatabaseViewConfig,
  a, b, c, bodyId, groupId, secondGroup, born, now, uuid, createGroup, paragraph,
  createRequest, created, createRestoreInput, restoreCreated, restoreInput, applySyncedHostCommand,
  applySyncedHostFinal, restoreSyncedHostOperation, request, freshBlock, logical, snapshot,
  seedCreateBlocks, editCreatedGroup, allTables, totalChanges, identity, copy
} from './helpers/synced-publication-fixture'

// Draft against exact API design 9a068055...; no execution claimed before Root lane.
const manifestPath = '/Publication/manifest.json'
const groupWire = (value: ReturnType<typeof snapshot>) => ({ kind: 'synced-group' as const, id: value.groupId, creationId: value.creationId,
  createdAt: value.createdAt, origin: value.origin, blocks: value.blocks, bindings: value.bindings })
const deepFrozen = (value: unknown): boolean => value === null || typeof value !== 'object' || Object.isFrozen(value)
  && Object.values(value).every(deepFrozen)
const activeIds = (db: Parameters<typeof snapshot>[0]) => (db.prepare("SELECT group_id FROM synced_group_lifecycle WHERE state='active' ORDER BY group_id").all() as Array<{ group_id: string }>).map(row => row.group_id)
function assertExposure(db: Parameters<typeof snapshot>[0], attemptId: string, expected: 'possible' | 'confirmed', ids = activeIds(db)) {
  const attempt = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(attemptId) as { state: string; publication_hash: string; request_hash: string } | undefined
  assert.ok(attempt, 'The actual durable attempt is visible from the independent SQLite connection'); assert.equal(attempt.state, expected)
  const members = db.prepare('SELECT group_id FROM synced_group_exposure_members WHERE attempt_id=? ORDER BY group_id').all(attemptId) as Array<{ group_id: string }>
  assert.deepEqual(members.map(row => row.group_id), [...ids].sort())
  for (const id of ids) assert.equal(readSyncedGroupLifecycles(db, [id]).get(id)!.exposure, expected)
  return attempt
}
async function publishAndRead(f: Parameters<Parameters<typeof withPublicationFixture>[0]>[0]) {
  const input = f.input(), handle = await prepared(f.db, input), original = facts(handle)
  const result = await publishInitialSyncedPublication(f.db, handle, runtime)
  assert.deepEqual(result, { status: 'confirmed', attemptId: input.attemptId, publicationHash: original.publicationHash, replayed: false })
  return { input, handle, original, read: await remote(f.client()) }
}

test('prepare captures all persistent active groups including orphan and excludes a real retired create without SQL or HTTP', () => withPublicationFixture(async f => {
  const inputCreate = createRequest(f.db), creation = created(applySyncedHostCommand(f.db, inputCreate)), retired = restoreCreated(f.db, creation, 'undo').ack
  const dirty = createRequest(f.db, { dirty: working => { working.summary = 'Unaccepted dirty W'; working.blocks.find(block => block.id === bodyId(a))!.content = 'Never publish this draft' } })
  const before = allTables(f.db), changes = totalChanges(f.db), input = f.input(), handle = await prepared(f.db, input), value = facts(handle)
  assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes); assert.equal(f.server.requests.length, 0)
  assert.deepEqual(value.descriptor.members.map(item => item.groupId), activeIds(f.db)); assert.ok(value.descriptor.members.some(item => item.groupId === secondGroup), 'The actual zero-instance active orphan belongs to this full publication')
  assert.ok(!value.descriptor.members.some(item => item.groupId === retired.createdLifecycle.groupId), 'A genuinely retired create is validated then excluded rather than emitted as a live group')
  assert.equal(value.workspaceScope, uuid(900)); assert.equal(value.recoveryEpoch, uuid(901)); assert.equal(value.attemptId, input.attemptId)
  assert.equal(deepFrozen(value), true); assert.equal(hash(encode(value.descriptor)), value.publicationHash)
  assert.equal(value.descriptor.manifest.path, 'manifest.json')
  assert.deepEqual(Object.keys(value.descriptor).sort(), ['kind', 'version', 'channel', 'workspaceScope', 'recoveryEpoch', 'targetFingerprint', 'localFingerprint', 'manifest', 'objects', 'assets', 'members'].sort())
  assert.ok(value.descriptor.objects.every(item => !readFileSync(join(f.spool(input.attemptId), item.path), 'utf8').includes(dirty.hostsWorkingBefore[0].workingBefore.summary)), 'Unaccepted draft metadata never enters any actual persistent object bytes')
  assert.deepEqual(publicationRows(f.db), { attempts: [], members: [] })
}))

test('the first actual object HTTP observes a committed possible attempt and every active incarnation from a second connection', () => withPublicationFixture(async f => {
  const createdAck = created(applySyncedHostCommand(f.db, createRequest(f.db))), other = f.connect(), ids = activeIds(f.db)
  const input = f.input(), handle = await prepared(f.db, input), value = facts(handle), observed: Array<{ kind: string; id: string }> = []
  f.server.setHook(req => { if (contentRequests([req]).length && !observed.length) { const row = assertExposure(other, input.attemptId, 'possible', ids); observed.push({ kind: row.state, id: input.attemptId }) } })
  const result = await publishInitialSyncedPublication(f.db, handle, runtime)
  assert.equal(result.status, 'confirmed'); assert.deepEqual(observed, [{ kind: 'possible', id: input.attemptId }]); assertExposure(other, input.attemptId, 'confirmed', ids)
  const members = other.prepare('SELECT group_id,creation_id,revision,topology_revision,semantic_hash FROM synced_group_exposure_members WHERE attempt_id=? ORDER BY group_id').all(input.attemptId)
  assert.deepEqual(members, value.descriptor.members.map(member => ({ group_id: member.groupId, creation_id: member.creationId, revision: member.revision, topology_revision: member.topologyRevision, semantic_hash: member.semanticHash })))
  assert.equal(readSyncedGroupLifecycles(other, [createdAck.createdLifecycle.groupId]).get(createdAck.createdLifecycle.groupId)!.exposure, 'confirmed')
}))

test('actual asset HEAD PUT and MOVE temporary manifest bodies all follow committed claim and use exact frozen spool bytes', () => withPublicationFixture(async f => {
  const [asset] = await f.assets.import([{ name: "真实 asset !'().png", bytes: Buffer.from('original publication asset') }])
  f.db.prepare('UPDATE blocks SET content=? WHERE id=?').run('![asset](<' + asset.url + '>) [stable](Host%20B.md)', bodyId(a))
  f.db.prepare('UPDATE blocks SET content=? WHERE id=?').run('![ordinary host asset](<' + asset.url + '>) [ordinary link](Host%20A.md)', bodyId(b))
  const creation = created(applySyncedHostCommand(f.db, createRequest(f.db))), input = f.input(), handle = await prepared(f.db, input), value = facts(handle), other = f.connect()
  f.server.setOptions({ ignoreIfNoneMatch: true }); const observed: string[] = []
  f.server.setHook(req => { if (contentRequests([req]).length) { assertExposure(other, input.attemptId, 'possible'); observed.push(req.method + ' ' + req.path) } })
  assert.equal((await publishInitialSyncedPublication(f.db, handle, runtime)).status, 'confirmed')
  assert.ok(observed.some(line => line.includes('HEAD /Publication/assets/')), 'The real asset existence request belongs to this already committed attempt')
  assert.ok(observed.some(line => line.includes('PUT /Publication/objects/.pending-')), 'The real MOVE fallback temporary manifest PUT also follows the durable claim')
  assert.ok(f.server.requests.some(req => req.method === 'MOVE' && req.destination?.endsWith('/manifest.json')), 'Conditional capability verification selects the actual no-overwrite MOVE path')
  assert.deepEqual(f.server.files.get(manifestPath), readFileSync(join(f.spool(input.attemptId), 'manifest.json')))
  for (const object of value.descriptor.objects) assert.deepEqual(f.server.files.get('/Publication/' + object.path), readFileSync(join(f.spool(input.attemptId), object.path)))
  for (const item of value.descriptor.assets) { const bytes = f.server.files.get('/Publication/' + item.path); assert.ok(bytes, 'Every descriptor asset has the original real server bytes'); assert.equal(hash(bytes), item.hash); assert.equal(bytes.length, item.bytes) }
  f.server.setHook(undefined)
  const read = await remote(f.client()), record = read.facts.records.find(item => item.key === 'group:' + creation.createdLifecycle.groupId)
  assert.ok(record && record.record.kind === 'synced-group', 'The actual sender portable group is consumed by the strict network reader')
  if (!record || record.record.kind !== 'synced-group') throw new Error('Actual group required')
  const portable = record.record, binding = portable.bindings.find(item => item.target.kind === 'document' && item.target.id === b)
  assert.ok(binding, 'A destination after the rewritten asset keeps its original stable target')
  const block = portable.blocks.find(item => item.id === binding.blockId)!
  assert.equal(block.content.slice(binding.from, binding.to), binding.raw); assert.ok(block.content.includes('knowbook-asset://'), 'The actual canonical body contains a verified real portable asset URI')
  const host = read.facts.records.find(item => item.key === 'doc:' + b)
  assert.ok(host && host.record.kind === 'document', 'A real ordinary host asset owner is included in the full snapshot')
  if (!host || host.record.kind !== 'document') throw new Error('Actual ordinary host required')
  assert.equal(host.record.content.blocks.find(item => item.id === bodyId(b))!.content.includes('knowbook-asset://'), true)
}))

test('claim first commits possible before a fresh exact-tail create Undo which leaves owners history and original ACK untouched', () => withPublicationFixture(async f => {
  const creation = created(applySyncedHostCommand(f.db, createRequest(f.db))), input = f.input(), handle = await prepared(f.db, input), other = f.connect()
  const reached = f.gate(), release = f.gate(); let observed = false
  f.server.setHook(async req => { if (!observed && contentRequests([req]).length) { observed = true; reached.release(); await release.promise } })
  const publishing = f.track(publishInitialSyncedPublication(f.db, handle, runtime))
  await Promise.race([reached.promise, publishing.then(() => { throw new Error('Publication must reach the controlled content request before settling') })])
  try {
    assertExposure(other, input.attemptId, 'possible')
    const fresh = restoreInput(other, creation, 'undo'), before = allTables(other), changes = totalChanges(other)
    const refused = restoreSyncedHostOperation(other, fresh)
    assert.ok(refused.status === 'unsupported' && refused.reason === 'lifecycle', 'The actual create inverse refuses after the durable publication won the SQLite commit order')
    assert.deepEqual(allTables(other), before); assert.equal(totalChanges(other), changes)
  } finally { release.release() }
  assert.equal((await publishing).status, 'confirmed')
}))

test('real create Undo first makes the original prepared publication stale with no content HTTP or partial attempt members', () => withPublicationFixture(async f => {
  const creation = created(applySyncedHostCommand(f.db, createRequest(f.db))), input = f.input(), handle = await prepared(f.db, input), other = f.connect()
  const undo = restoreCreated(other, creation, 'undo').ack, before = allTables(other), child = creation.hosts[0].logicalBefore.blocks.find(block => block.id === bodyId(a))!
  assert.equal(undo.createdLifecycle.state, 'retired-create'); assert.equal(identity(other, child.id)!.last_owner_kind, 'document')
  const result = await publishInitialSyncedPublication(f.db, handle, runtime)
  assert.equal(result.status, 'stale'); assert.deepEqual(allTables(other), before); assert.deepEqual(publicationRows(other), { attempts: [], members: [] }); assert.deepEqual(contentRequests(f.server.requests), [])
}))

test('a late member SQL failure rolls back the whole claim before any content HTTP and leaves accurate create Undo available', () => withPublicationFixture(async f => {
  const creation = created(applySyncedHostCommand(f.db, createRequest(f.db))), input = f.input(), handle = await prepared(f.db, input), before = allTables(f.db)
  f.db.exec("CREATE TRIGGER fail_publication_member BEFORE INSERT ON synced_group_exposure_members WHEN EXISTS(SELECT 1 FROM synced_group_exposure_members WHERE attempt_id=NEW.attempt_id) BEGIN SELECT RAISE(ABORT,'publication late member fixture'); END;")
  const error = await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'database')
  assert.ok(error.cause, 'The publication database error retains its actual late SQLite cause')
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(contentRequests(f.server.requests), []); assert.deepEqual(publicationRows(f.db), { attempts: [], members: [] })
  f.db.exec('DROP TRIGGER fail_publication_member'); assert.equal(restoreCreated(f.db, creation, 'undo').ack.createdLifecycle.state, 'retired-create')
}))

test('confirm SQL failure preserves possible and an explicit read-only query confirms only the original remote bytes', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input), value = facts(handle)
  f.db.exec("CREATE TRIGGER fail_publication_confirm BEFORE UPDATE OF state ON synced_exposure_attempts WHEN NEW.state='confirmed' BEGIN SELECT RAISE(ABORT,'publication confirm fixture'); END;")
  await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'database'); assertExposure(f.db, input.attemptId, 'possible')
  const members = publicationRows(f.db).members, before = f.server.requests.length
  assert.equal(editCreatedGroup(f.db, groupId).status, 'saved')
  f.db.exec('DROP TRIGGER fail_publication_confirm')
  assert.deepEqual(await queryInitialSyncedPublication(f.db, handle, runtime), { status: 'confirmed', attemptId: input.attemptId, publicationHash: value.publicationHash, replayed: false })
  assert.ok(f.server.requests.slice(before).every(req => ['GET', 'HEAD', 'PROPFIND'].includes(req.method)), 'Explicit query performs only versioned read requests and never capability probes or writes')
  assert.deepEqual(publicationRows(f.db).members, members); assertExposure(f.db, input.attemptId, 'confirmed')
}))

test('the same possible attempt retries the original bytes without duplicating members or treating its own exposure version as stale', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input); let failed = false
  f.server.setHook(req => { if (!failed && req.method === 'PUT' && /\/objects\/[a-f0-9]{64}\.json$/.test(req.path)) { failed = true; return { kind: 'status', status: 503 } } })
  await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'transport')
  const originalRows = publicationRows(f.db), versions = activeIds(f.db).map(id => [id, readSyncedGroupLifecycles(f.db, [id]).get(id)!.stateVersion] as const)
  assertExposure(f.db, input.attemptId, 'possible'); f.server.setHook(undefined)
  assert.equal((await publishInitialSyncedPublication(f.db, handle, runtime)).status, 'confirmed')
  assert.deepEqual(publicationRows(f.db).members, originalRows.members); assert.equal(publicationRows(f.db).attempts.length, 1)
  for (const [id, version] of versions) assert.equal(readSyncedGroupLifecycles(f.db, [id]).get(id)!.stateVersion, version + 1)
}))

test('two actual conditional initial senders race one manifest and the 412 loser preserves its own committed possible fact', () => withPublicationFixture(async f => {
  const other = f.variant(27); created(applySyncedHostCommand(other.db, createRequest(other.db)))
  const leftInput = f.input(), rightInput = other.input(), left = await prepared(f.db, leftInput), right = await prepared(other.db, rightInput)
  const both = f.gate(); let arrivals = 0
  f.server.setHook(async req => { if (req.method === 'PUT' && req.path === manifestPath) { arrivals++; if (arrivals === 2) both.release(); await both.promise } })
  const jobs = [f.track(publishInitialSyncedPublication(f.db, left, runtime)), f.track(publishInitialSyncedPublication(other.db, right, runtime))]
  await Promise.race([both.promise, Promise.race(jobs).then(() => { if (arrivals < 2) throw new Error('Both actual senders must reach the controlled conditional manifest request before either settles') })])
  const results = await Promise.all(jobs)
  assert.deepEqual(results.map(result => result.status).sort(), ['confirmed', 'conflict'])
  const leftWon = results[0].status === 'confirmed', winning = leftWon ? facts(left) : facts(right), loserDb = leftWon ? other.db : f.db, loserInput = leftWon ? rightInput : leftInput
  assert.equal(hash(f.server.files.get(manifestPath)!), winning.descriptor.manifest.hash); assertExposure(loserDb, loserInput.attemptId, 'possible')
  assert.equal(f.server.requests.filter(req => req.method === 'PUT' && req.path === manifestPath).length, 2)
  assert.ok(f.server.requests.filter(req => req.method === 'PUT' && req.path === manifestPath).every(req => req.ifNoneMatch === '*'), 'Both real senders use conditional create and never unconditional manifest overwrite')
}))

test('a server that stores the actual manifest then drops its ACK leaves possible until explicit original-plan query', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input), value = facts(handle); let dropped = false
  f.server.setHook(req => { if (!dropped && req.method === 'PUT' && req.path === manifestPath) { dropped = true; return { kind: 'persist-then-disconnect' } } })
  await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'transport'); assert.equal(dropped, true); assertExposure(f.db, input.attemptId, 'possible')
  assert.deepEqual(f.server.files.get(manifestPath), readFileSync(join(f.spool(input.attemptId), 'manifest.json')))
  const start = f.server.requests.length
  assert.deepEqual(await queryInitialSyncedPublication(f.db, handle, runtime), { status: 'confirmed', attemptId: input.attemptId, publicationHash: value.publicationHash, replayed: false })
  assert.ok(f.server.requests.slice(start).every(req => ['GET', 'HEAD', 'PROPFIND'].includes(req.method)), 'Lost ACK recovery proves the original publication with read-only real HTTP')
}))

test('confirmed publish replays durable original facts with zero HTTP and never advances lifecycle twice', () => withPublicationFixture(async f => {
  const { handle, original, input } = await publishAndRead(f), before = allTables(f.db), changes = totalChanges(f.db), start = f.server.requests.length
  f.server.files.delete(manifestPath)
  assert.deepEqual(await publishInitialSyncedPublication(f.db, handle, runtime), { status: 'confirmed', attemptId: input.attemptId, publicationHash: original.publicationHash, replayed: true })
  assert.equal(f.server.requests.length, start); assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes)
  assert.equal((await queryInitialSyncedPublication(f.db, handle, runtime)).status, 'missing'); assert.deepEqual(allTables(f.db), before)
}))

test('real manifest conditional 412 confirms only the exact original full remote closure and otherwise keeps possible conflict', async () => {
  for (const exact of [true, false]) await withPublicationFixture(async f => {
    const input = f.input(), handle = await prepared(f.db, input), value = facts(handle); let raced = false
    f.server.setHook(req => { if (!raced && req.method === 'PUT' && req.path === manifestPath) {
      raced = true; const raw = JSON.parse(req.bytes.toString()); if (!exact) raw.workspaceId = randomUUID()
      f.server.files.set(manifestPath, exact ? Buffer.from(req.bytes) : Buffer.from(encode(raw))); return { kind: 'status', status: 412 }
    } })
    const result = await publishInitialSyncedPublication(f.db, handle, runtime)
    assert.equal(raced, true); assert.equal(result.status, exact ? 'confirmed' : 'conflict')
    assert.equal(result.attemptId, input.attemptId); assert.equal(result.publicationHash, value.publicationHash)
    assertExposure(f.db, input.attemptId, exact ? 'confirmed' : 'possible')
    assert.ok(f.server.requests.some(req => req.method === 'GET' && req.path === manifestPath), 'An actual 412 must be resolved by reading the actual complete remote snapshot')
  })
})

test('another existing remote manifest is conflict before any claim or content upload and is never overwritten', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input), raw = JSON.parse(readFileSync(join(f.spool(input.attemptId), 'manifest.json'), 'utf8'))
  raw.workspaceId = randomUUID(); const existing = Buffer.from(encode(raw)); f.server.files.set(manifestPath, existing)
  const before = allTables(f.db)
  assert.equal((await publishInitialSyncedPublication(f.db, handle, runtime)).status, 'conflict')
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(publicationRows(f.db), { attempts: [], members: [] }); assert.deepEqual(contentRequests(f.server.requests), [])
  assert.deepEqual(f.server.files.get(manifestPath), existing)
}))

test('caller transactions disabled foreign keys and another database layout cannot be used to capture or publish Main authority', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input), before = allTables(f.db)
  f.db.exec('BEGIN')
  try { await rejectedCode(() => prepareInitialSyncedPublication(f.db, f.input()), 'invalid'); await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'invalid') } finally { f.db.exec('ROLLBACK') }
  f.db.pragma('foreign_keys=OFF')
  try { await rejectedCode(() => prepareInitialSyncedPublication(f.db, f.input()), 'invalid'); await rejectedCode(() => queryInitialSyncedPublication(f.db, handle, runtime), 'invalid') } finally { f.db.pragma('foreign_keys=ON') }
  await rejectedCode(() => prepareInitialSyncedPublication(f.db, { ...input, userDataRoot: join(f.root, 'wrong-profile') }), 'unavailable')
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(f.server.requests, [])
}))

test('a real readonly original-path connection cannot prepare recover or publish and is refused before HTTP or new spool creation', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input)
  f.server.setHook(req => req.method === 'PUT' && /\/objects\/[a-f0-9]{64}\.json$/.test(req.path) ? { kind: 'status', status: 503 } : undefined)
  await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'transport'); assertExposure(f.db, input.attemptId, 'possible')
  const readonly = f.connectReadOnly(), before = allTables(f.db), start = f.server.requests.length, folders = readdirSync(join(f.userDataRoot, 'storage', 'synced-publications-v1')).sort()
  assert.equal(readonly.readonly, true); assert.equal(readonly.pragma('foreign_keys', { simple: true }), 1)
  await rejectedCode(() => prepareInitialSyncedPublication(readonly, f.input()), 'unavailable')
  await rejectedCode(() => recoverInitialSyncedPublication(readonly, input), 'unavailable')
  await rejectedCode(() => publishInitialSyncedPublication(readonly, handle, runtime), 'unavailable')
  assert.deepEqual(allTables(f.db), before); assert.equal(f.server.requests.length, start)
  assert.deepEqual(readdirSync(join(f.userDataRoot, 'storage', 'synced-publications-v1')).sort(), folders)
}))

test('a busy real handle rejects a second job while the original signal cancellation preserves its committed possible members', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input), reached = f.gate(), release = f.gate(), abort = new AbortController(); let held = false
  f.server.setHook(async req => { if (!held && req.method === 'PUT' && /\/objects\/[a-f0-9]{64}\.json$/.test(req.path)) { held = true; reached.release(); await release.promise } })
  const publishing = f.track(publishInitialSyncedPublication(f.db, handle, { ...runtime, signal: abort.signal }))
  const rejected = rejectedCode(() => publishing, 'transport')
  await Promise.race([reached.promise, publishing.then(() => { throw new Error('The real original job must reach the controlled object request') })])
  try { await rejectedCode(() => queryInitialSyncedPublication(f.db, handle, runtime), 'unavailable'); assertExposure(f.db, input.attemptId, 'possible'); abort.abort() } finally { release.release() }
  await rejected; assertExposure(f.db, input.attemptId, 'possible'); assert.equal(f.server.files.has(manifestPath), false)
}))

test('a preaborted original signal cannot claim an attempt or emit knowledge content', () => withPublicationFixture(async f => {
  const handle = await prepared(f.db, f.input()), abort = new AbortController(); abort.abort()
  await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, { ...runtime, signal: abort.signal }), 'transport')
  assert.deepEqual(publicationRows(f.db), { attempts: [], members: [] }); assert.deepEqual(contentRequests(f.server.requests), [])
}))

test('a native toggle forest at the unchanged depth six limit roundtrips both real host and canonical snapshot readers', () => withPublicationFixture(async f => {
  const roots = Array.from({ length: 7 }, (_, depth) => ({ id: ' publication:native-depth\0:' + depth, type: depth === 6 ? 'paragraph' : 'toggle', content: 'Native depth ' + depth, depth, ...(depth ? { parent: ' publication:native-depth\0:' + (depth - 1) } : {}) }))
  seedCreateBlocks(f.db, roots, b); seedCreateBlocks(f.db, roots.map(item => ({ ...item, id: item.id + ':group', ...(item.parent ? { parent: item.parent + ':group' } : {}) })))
  const creation = created(applySyncedHostCommand(f.db, createRequest(f.db, { selectedRootIds: [roots[0].id + ':group'] }))), { read } = await publishAndRead(f)
  for (const key of ['doc:' + b, 'group:' + creation.createdLifecycle.groupId]) {
    const item = read.facts.records.find(record => record.key === key)
    assert.ok(item, 'The complete real snapshot includes each actual deep native owner')
    const blocks = item.record.kind === 'document' ? item.record.content.blocks : item.record.kind === 'synced-group' ? item.record.blocks : []
    assert.equal(Math.max(...blocks.map(block => block.depth)), 6)
  }
}))

test('a corrupt local depth seven forest is rejected without broadening the unchanged synced forest depth budget', () => withPublicationFixture(async f => {
  seedCreateBlocks(f.db, Array.from({ length: 8 }, (_, depth) => ({ id: ' publication:overdepth-local:' + depth, type: depth === 7 ? 'paragraph' : 'toggle', content: 'Overdepth fixture', depth,
    ...(depth ? { parent: ' publication:overdepth-local:' + (depth - 1) } : {}) })), b)
  const before = allTables(f.db), changes = totalChanges(f.db)
  await rejectedCode(() => prepareInitialSyncedPublication(f.db, f.input()), 'invalid')
  assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes); assert.deepEqual(f.server.requests, [])
}))

test('current local edits during network wait can commit independently and prevent final manifest while preserving possible', () => withPublicationFixture(async f => {
  const creation = created(applySyncedHostCommand(f.db, createRequest(f.db))), handle = await prepared(f.db, f.input()), value = facts(handle), other = f.connect()
  const reached = f.gate(), release = f.gate(); let held = false
  f.server.setHook(async req => { if (!held && req.method === 'PUT' && /\/objects\/[a-f0-9]{64}\.json$/.test(req.path)) { held = true; reached.release(); await release.promise } })
  const publishing = f.track(publishInitialSyncedPublication(f.db, handle, runtime))
  await Promise.race([reached.promise, publishing.then(() => { throw new Error('Publication must reach the controlled object PUT before settling') })])
  try { const edited = editCreatedGroup(other, creation.createdLifecycle.groupId); assert.equal(edited.status, 'saved'); assert.equal(other.inTransaction, false) } finally { release.release() }
  assert.equal((await publishing).status, 'stale'); assert.equal(f.server.files.has(manifestPath), false); assertExposure(other, value.attemptId, 'possible')
}))

test('prepare records no member authority from a caller DTO and live opaque handles bind original connection target and epoch', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input), value = facts(handle), other = f.connect(), before = allTables(f.db)
  await rejectedCode(() => publishInitialSyncedPublication(f.db, { ...value } as never, runtime), 'unavailable')
  await rejectedCode(() => publishInitialSyncedPublication(other, handle, runtime), 'unavailable')
  await rejectedCode(() => prepareInitialSyncedPublication(f.db, { ...input, members: value.descriptor.members } as never), 'invalid')
  await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, { ...runtime, target: f.target } as never), 'invalid')
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(contentRequests(f.server.requests), [])
  f.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=?').run(randomUUID())
  await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'unavailable')
}))

test('all-zero-active and schema26 are explicit unsupported preparation without durable empty attempts or downgrade HTTP', () => withPublicationFixture(async f => {
  const empty = f.variant(27), before = allTables(empty.db), changes = totalChanges(empty.db)
  assert.deepEqual(await prepareInitialSyncedPublication(empty.db, empty.input()), { status: 'unsupported', reason: 'no-active-groups' })
  assert.deepEqual(allTables(empty.db), before); assert.equal(totalChanges(empty.db), changes)
  const creation = created(applySyncedHostCommand(empty.db, createRequest(empty.db))), undo = restoreCreated(empty.db, creation, 'undo').ack
  assert.equal(undo.createdLifecycle.state, 'retired-create'); const retiredBefore = allTables(empty.db)
  assert.deepEqual(await prepareInitialSyncedPublication(empty.db, empty.input()), { status: 'unsupported', reason: 'no-active-groups' })
  assert.deepEqual(allTables(empty.db), retiredBefore); assert.deepEqual(publicationRows(empty.db), { attempts: [], members: [] })
  const old = f.variant(26), oldBefore = allTables(old.db)
  assert.deepEqual(await prepareInitialSyncedPublication(old.db, old.input()), { status: 'unsupported', reason: 'schema-27-required' })
  assert.deepEqual(allTables(old.db), oldBefore); assert.deepEqual(f.server.requests, [])
}))

test('canonical whole-forest references and named-note assets roundtrip real bytes without scanning code or config literals', () => withPublicationFixture(async f => {
  const bytes = Buffer.from('cross-block attachment bytes'), [one, two] = await f.assets.import([{ name: 'one image.png', bytes }, { name: 'second alias.png', bytes }])
  f.db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Use [reference][asset] and a note[^n] plus [ordinary](Host%20B.md)', bodyId(a))
  const def = ' publication:ref definition ', note = ' publication:note definition ', code = ' publication:literal code '
  seedCreateBlocks(f.db, [{ id: def, content: '[asset]: <' + one.url + '>' }, { id: note, content: '[^n]: Note ![second](<' + two.url + '>)' }, { id: code, type: 'code', content: one.url }])
  const input = createRequest(f.db, { selectedRootIds: [bodyId(a), def, note, code] }), creation = created(applySyncedHostCommand(f.db, input))
  const { original, read } = await publishAndRead(f), group = read.facts.records.find(item => item.key === 'group:' + creation.createdLifecycle.groupId)
  assert.ok(group && group.record.kind === 'synced-group', 'The actual source forest becomes a real portable group record')
  if (!group || group.record.kind !== 'synced-group') throw new Error('Actual group required')
  const wire = group.record, codeBlock = wire.blocks.find(block => block.id === code)!
  assert.equal(codeBlock.content, one.url)
  const asset = original.descriptor.assets.find(item => item.hash === hash(bytes))
  assert.ok(asset, 'Both active cross-block attachment uses share a verified real hash')
  assert.deepEqual(asset.names, [one.name, two.name].sort()); assert.deepEqual(f.server.files.get('/Publication/' + asset.path), bytes)
  assert.equal(wire.blocks.find(block => block.id === note)!.content.includes('knowbook-asset://'), true)
  for (const binding of wire.bindings) assert.equal(wire.blocks.find(block => block.id === binding.blockId)!.content.slice(binding.from, binding.to), binding.raw)
  assert.ok(wire.bindings.some(binding => binding.target.kind === 'document' && binding.target.id === b), 'Asset range changes do not substitute a surviving ordinary target')
  const dbRecord = read.facts.records.find(item => item.key === 'databases')
  assert.ok(dbRecord && dbRecord.record.kind === 'databases', 'The actual complete database record is present')
  if (!dbRecord || dbRecord.record.kind !== 'databases') throw new Error('Actual database record required')
  assert.ok(dbRecord.record.tables.database_saved_views.some(row => String(row.config_json).includes('file:///not-an-asset')), 'Opaque database query/config strings are not recursively scanned as attachment sources')
}))

test('same raw local URL preserves two real historical targets through reversed explicit claims and portable physical Keys', () => withPublicationFixture(async f => {
  f.db.prepare("UPDATE documents SET title='Target',path='Home/Target' WHERE id=?").run(b)
  f.db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[old](Target.md)', bodyId(a))
  const creation = created(applySyncedHostCommand(f.db, createRequest(f.db))), before = snapshot(f.db, creation.createdLifecycle.groupId)
  f.db.prepare("UPDATE documents SET title='Renamed',path='Home/Renamed' WHERE id=?").run(b)
  f.db.prepare("UPDATE documents SET title='Target',path='Home/Target' WHERE id=?").run(c)
  const blocks = before.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, content: 'before [old](Target.md) middle [new](Target.md)' }))
  const destinations = captureSyncedGroupBindings(f.db, before.origin, blocks.map(block => ({ ...block, createdAt: before.blocks[0].createdAt })))
  const key = ({ blockId, from, to, raw, syntax }: typeof destinations[number]) => ({ blockId, from, to, raw, syntax })
  const instance = before.instances[0], result = updateSyncedBlockGroup(f.db, { clientOperationId: randomUUID(), groupId: before.groupId, expectedRevision: before.revision, expectedTopologyRevision: before.topologyRevision,
    expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion }, blocks,
    bindingClaims: [{ kind: 'new', destination: key(destinations[1]) }, { kind: 'continue', source: key(before.bindings[0]), destination: key(destinations[0]) }] })
  assert.equal(result.status, 'saved')
  const local = snapshot(f.db, before.groupId), { read } = await publishAndRead(f), remoteRecord = read.facts.records.find(item => item.key === 'group:' + before.groupId)
  assert.ok(remoteRecord && remoteRecord.record.kind === 'synced-group', 'The real same-URL source is consumed by the strict remote reader')
  if (!remoteRecord || remoteRecord.record.kind !== 'synced-group') throw new Error('Actual group required')
  const keyed = (bindings: typeof local.bindings) => bindings.map(binding => ({ key: key(binding), target: binding.target })).sort((left, right) => left.key.from - right.key.from)
  assert.deepEqual(keyed(remoteRecord.record.bindings), keyed(local.bindings)); assert.deepEqual(keyed(local.bindings).map(item => item.target), [{ kind: 'document', id: b, state: 'live' }, { kind: 'document', id: c, state: 'live' }])
  assert.equal(destinations[0].raw, destinations[1].raw); assert.notEqual(destinations[0].from, destinations[1].from)
}))

test('catalog sentinel mapping reaches host and canonical typed views while custom IDs and configuration strings remain original', () => withPublicationFixture(async f => {
  const config = createDefaultDatabaseViewConfig('table', [catalogColumn]); config.query = catalogId + ' literal file:///unmanaged'
  const payload = serializeDatabaseViewPayload({ version: 1, databaseId: catalogId, viewId: null, config }), groupBlock = ' publication:canonical catalog atom ', hostBlock = ' publication:host catalog atom '
  seedCreateBlocks(f.db, [{ id: groupBlock, type: 'database-view', content: payload }])
  const creation = created(applySyncedHostCommand(f.db, createRequest(f.db, { selectedRootIds: [groupBlock] })))
  seedCreateBlocks(f.db, [{ id: hostBlock, type: 'database-view', content: payload }], b)
  const { read } = await publishAndRead(f)
  for (const key of ['group:' + creation.createdLifecycle.groupId, 'doc:' + b]) {
    const item = read.facts.records.find(record => record.key === key)
    assert.ok(item, 'The real catalog typed-view owner is included in the complete snapshot')
    const blocks = item.record.kind === 'synced-group' ? item.record.blocks : item.record.kind === 'document' ? item.record.content.blocks : []
    const block = blocks.find(block => block.type === 'database-view')!
    const parsed = parseDatabaseViewPayload(block.content); assert.equal(parsed.databaseId, 'catalog'); assert.equal(parsed.config.query, config.query); assert.deepEqual(parsed.config.visibleFieldIds, [catalogColumn])
  }
  const databases = read.facts.records.find(item => item.key === 'databases')
  assert.ok(databases && databases.record.kind === 'databases', 'The actual database definitions accompany all typed-view references')
  if (!databases || databases.record.kind !== 'databases') throw new Error('Database record required')
  assert.deepEqual(databases.record.tables.databases.map(row => row.id).sort(), ['catalog', customId].sort())
  assert.equal(databases.record.tables.databases.find(row => row.id === 'catalog')!.created_at, '1970-01-01T00:00:00.000Z')
  assert.ok(databases.record.tables.database_entity_values.some(row => row.entity_id === entityId && row.column_id === customColumn), 'Orphan custom entities and their values are included without a host join')
}))

test('reserved catalog custom definitions and explicit missing catalog references reject before any claim or HTTP', async () => {
  for (const mode of ['definition', 'host-reference', 'group-reference'] as const) await withPublicationFixture(async f => {
    if (mode === 'definition') f.db.prepare('INSERT INTO databases(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)').run('catalog', 'Conflicting custom', '', born, now)
    else {
      const payload = serializeDatabaseViewPayload({ version: 1, databaseId: 'catalog', viewId: null, config: createDefaultDatabaseViewConfig() }), id = ' publication:conflicting-view '
      seedCreateBlocks(f.db, [{ id, type: 'database-view', content: payload }])
      if (mode === 'group-reference') created(applySyncedHostCommand(f.db, createRequest(f.db, { selectedRootIds: [id] })))
    }
    const before = allTables(f.db); await rejectedCode(() => prepareInitialSyncedPublication(f.db, f.input()), 'invalid'); assert.deepEqual(allTables(f.db), before); assert.deepEqual(f.server.requests, [])
  })
})

test('new active orphan same wire new CAS host metadata catalog and topology each make the old exact plan stale', async () => {
  for (const kind of ['new-orphan', 'same-wire-CAS', 'topology', 'host-summary', 'catalog-value'] as const) await withPublicationFixture(async f => {
    const input = f.input(), handle = await prepared(f.db, input), other = f.connect()
    if (kind === 'new-orphan') {
      const command = request(other, [b], after => { after[0].summary = 'new orphan preparation host' }); assert.equal(applySyncedHostFinal(other, command).status, 'applied')
      const createdInput = createRequest(other, { documentId: b }), ack = created(applySyncedHostCommand(other, createdInput))
      const removal = request(other, [b], after => { after[0].blocks = [freshBlock(' publication:new orphan host body ', 'ordinary replacement')] })
      assert.equal(applySyncedHostFinal(other, removal).status, 'applied'); assert.equal(snapshot(other, ack.createdLifecycle.groupId).instances.length, 0)
    } else if (kind === 'same-wire-CAS') other.prepare('UPDATE synced_groups SET revision=? WHERE id=?').run(randomUUID(), groupId)
    else if (kind === 'topology') other.prepare('UPDATE synced_groups SET topology_revision=? WHERE id=?').run(randomUUID(), groupId)
    else if (kind === 'host-summary') other.prepare('UPDATE documents SET summary=? WHERE id=?').run('Actually changed persistent summary', b)
    else other.prepare('UPDATE document_database_values SET value_text=? WHERE document_id=? AND column_id=?').run('Changed catalog', a, catalogColumn)
    const before = allTables(other); assert.equal((await publishInitialSyncedPublication(f.db, handle, runtime)).status, 'stale'); assert.deepEqual(allTables(other), before); assert.deepEqual(publicationRows(other), { attempts: [], members: [] }); assert.deepEqual(contentRequests(f.server.requests), [])
  })
})

test('dispose revokes only future calls while the already accepted real sender settles its original job and retains durable evidence', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input), value = facts(handle), reached = f.gate(), release = f.gate(); let held = false
  f.server.setHook(async req => { if (!held && contentRequests([req]).length) { held = true; reached.release(); await release.promise } })
  const publishing = f.track(publishInitialSyncedPublication(f.db, handle, runtime))
  await Promise.race([reached.promise, publishing.then(() => { throw new Error('The accepted job must reach its controlled request') })])
  assert.equal(disposePreparedSyncedPublication(handle), true); assert.equal(disposePreparedSyncedPublication(handle), false); assert.equal(readPreparedSyncedPublication(handle), null)
  try { await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'unavailable') } finally { release.release() }
  assert.deepEqual(await publishing, { status: 'confirmed', attemptId: input.attemptId, publicationHash: value.publicationHash, replayed: false })
  assert.equal(readdirSync(f.spool(input.attemptId)).includes('ready.json'), true); assertExposure(f.db, input.attemptId, 'confirmed')
}))

test('spool corruption extra files or absent ready marker cannot mint a resumed attempt or send bytes', async () => {
  for (const kind of ['manifest', 'state', 'ready-missing', 'extra-file'] as const) await withPublicationFixture(async f => {
    const input = f.input(), handle = await prepared(f.db, input), spool = f.spool(input.attemptId)
    if (kind === 'manifest') writeFileSync(join(spool, 'manifest.json'), '{}')
    else if (kind === 'state') writeFileSync(join(spool, 'state.json'), '{}')
    else if (kind === 'ready-missing') rmSync(join(spool, 'ready.json'))
    else writeFileSync(join(spool, 'unexpected.txt'), 'Never a permitted spool member')
    const before = allTables(f.db); await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'spool'); assert.deepEqual(allTables(f.db), before); assert.deepEqual(contentRequests(f.server.requests), [])
  })
})

test('explicit recover binds durable original attempt bytes and target after a fresh connection while query cannot regrant send authority', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input), value = facts(handle)
  f.server.setHook(req => req.method === 'PUT' && /\/objects\/[a-f0-9]{64}\.json$/.test(req.path) ? { kind: 'status', status: 503 } : undefined)
  await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'transport'); assertExposure(f.db, input.attemptId, 'possible')
  disposePreparedSyncedPublication(handle); f.server.setHook(undefined)
  const other = f.connect(), recovered = await recoverInitialSyncedPublication(other, input)
  assert.equal(facts(recovered.prepared).publicationHash, value.publicationHash)
  assert.equal((await publishInitialSyncedPublication(other, recovered.prepared, runtime)).status, 'confirmed')
  const next = request(other, [b], after => { after[0].summary = 'local later change' }); assert.equal(applySyncedHostFinal(other, next).status, 'applied')
  const before = allTables(other), start = f.server.requests.length
  assert.equal((await queryInitialSyncedPublication(other, recovered.prepared, runtime)).status, 'confirmed')
  assert.deepEqual(allTables(other), before); assert.ok(f.server.requests.slice(start).every(req => ['GET', 'HEAD', 'PROPFIND'].includes(req.method)), 'Query of the earlier published fact never performs a new upload')
}))

test('a durable possible attempt cannot recover under another target or workspace epoch and preserves its original spool', () => withPublicationFixture(async f => {
  const input = f.input(), handle = await prepared(f.db, input), value = facts(handle)
  f.server.setHook(req => req.method === 'PUT' && /\/objects\/[a-f0-9]{64}\.json$/.test(req.path) ? { kind: 'status', status: 503 } : undefined)
  await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'transport'); assertExposure(f.db, input.attemptId, 'possible')
  const before = allTables(f.db), manifest = readFileSync(join(f.spool(input.attemptId), 'manifest.json')), start = f.server.requests.length
  await rejectedCode(() => recoverInitialSyncedPublication(f.connect(), { ...input, target: { ...input.target, directory: 'OtherTarget' } }), 'unavailable')
  assert.deepEqual(allTables(f.db), before); assert.equal(f.server.requests.length, start)
  f.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=?').run(randomUUID())
  await rejectedCode(() => recoverInitialSyncedPublication(f.connect(), input), 'unavailable')
  assert.equal(f.server.requests.length, start); assert.deepEqual(readFileSync(join(f.spool(input.attemptId), 'manifest.json')), manifest)
  assert.equal(facts(handle).publicationHash, value.publicationHash)
}))

test('every real same-hash attachment alias is verified independently before prepare and probe completion is rechecked before claim', async () => {
  for (const phase of ['prepare', 'probe'] as const) for (const damage of ['missing', 'wrong-bytes', 'unsafe-directory'] as const) await withPublicationFixture(async f => {
    const bytes = Buffer.from('same hash independently verified aliases'), [first, second] = await f.assets.import([{ name: 'first.png', bytes }, { name: 'second.png', bytes }])
    f.db.prepare('UPDATE blocks SET content=? WHERE id=?').run('![one](<' + first.url + '>) ![two](<' + second.url + '>)', bodyId(a))
    const creation = created(applySyncedHostCommand(f.db, createRequest(f.db))), secondPath = f.assets.resolve(second.url)
    const change = () => { if (damage === 'wrong-bytes') writeFileSync(secondPath, Buffer.from('corrupt second alias')); else { rmSync(secondPath); if (damage === 'unsafe-directory') mkdirSync(secondPath) } }
    if (phase === 'prepare') { change(); await rejectedCode(() => prepareInitialSyncedPublication(f.db, f.input()), 'asset') }
    else {
      const input = f.input(), handle = await prepared(f.db, input); let changed = false
      f.server.setHook(req => { if (!changed && req.method === 'DELETE' && /\/\.probe-[^/]+$/.test(req.path)) { changed = true; change() } })
      await rejectedCode(() => publishInitialSyncedPublication(f.db, handle, runtime), 'asset'); assert.equal(changed, true)
    }
    assert.deepEqual(contentRequests(f.server.requests), []); assert.deepEqual(publicationRows(f.db), { attempts: [], members: [] })
    assert.equal(restoreCreated(f.db, creation, 'undo').ack.createdLifecycle.state, 'retired-create')
  })
})

test('the complete snapshot may contain twenty-one real assets imported in legal batches and never applies the import batch cap to publication', () => withPublicationFixture(async f => {
  const assets = []
  for (let i = 0; i < 21; i++) assets.push((await f.assets.import([{ name: 'snapshot-' + i + '.png', bytes: Buffer.from('independent asset ' + i) }]))[0])
  f.db.prepare('UPDATE blocks SET content=? WHERE id=?').run(assets.map(item => '![](<'+item.url+'>)').join(' '), bodyId(a))
  created(applySyncedHostCommand(f.db, createRequest(f.db))); const { original, read } = await publishAndRead(f)
  assert.equal(original.descriptor.assets.length, 21); assert.equal(read.facts.assets.length, 21)
  for (const asset of assets) { const bytes = readFileSync(f.assets.resolve(asset.url)); assert.deepEqual(f.server.files.get('/Publication/assets/' + hash(bytes)), bytes) }
}))

