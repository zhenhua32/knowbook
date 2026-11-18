import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { exchangeSyncedSnapshot } from '../src/main/sync/synced-exchange'
import { prepareInitialSyncedPublication, publishInitialSyncedPublication, disposePreparedSyncedPublication,
  receiveInitialSyncedSnapshot } from '../src/main/sync/synced-publication'
import { validateInitialManifest5, publicationJson, protocol5HistoryLink } from '../src/main/sync/synced-publication-model'
import { assertRawSyncedExchangeHistoricalMetadataOwned } from '../src/main/database/synced-exchange-history-metadata-read'
import { accepted, readonlyRequests, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'
import { completed, hash, hostEdit, randomUUID, runtime } from './helpers/synced-exchange-fixture'

test('chained protocol 5 publishes the original predecessor with the real CAS and cold-recovers its exact durable job', () => withIncomingFixture(async f => {
  const preparation = await prepareInitialSyncedPublication(f.A.db, { attemptId: randomUUID(), userDataRoot: f.A.root, target: f.targetConfig }, true)
  assert.equal(preparation.status, 'prepared')
  if (preparation.status !== 'prepared') throw new Error('Expected the real chained initial publication')
  try { assert.equal((await publishInitialSyncedPublication(f.A.db, preparation.prepared, runtime)).status, 'confirmed') }
  finally { disposePreparedSyncedPublication(preparation.prepared) }
  accepted(await f.receive())
  const head = '/Incoming/manifest.json', root = Buffer.from(f.server.files.get(head)!), rootHash = hash(root)
  assert.equal(validateInitialManifest5(JSON.parse(root.toString())).history?.previousHash, null)
  const archive = '/Incoming/objects/manifest-' + rootHash + '.json'
  hostEdit(f.A.db, f.other, 'Exact chained source edit')
  const operationId = randomUUID(), input = f.input(operationId, f.A)
  let interrupted = false
  f.server.setHook(request => {
    if (request.method === 'PUT' && request.path === head) {
      assert.equal(request.ifMatch, '"' + rootHash + '"')
      assert.equal(validateInitialManifest5(JSON.parse(request.bytes.toString())).history?.previousHash, rootHash)
      assert.deepEqual(f.server.files.get(archive), root)
      interrupted = true
      return { kind: 'persist-then-disconnect' }
    }
    if (interrupted && request.method === 'GET' && request.path === head) return { kind: 'status', status: 403 }
  })
  await assert.rejects(f.track(exchangeSyncedSnapshot(f.A.db, input, runtime)), /原possible/)
  f.server.setHook(undefined)
  assert.equal(interrupted, true)
  assert.ok(f.server.requests.some(request => request.path === archive && request.ifNoneMatch === '*'))
  const successor = Buffer.from(f.server.files.get(head)!), successorHash = hash(successor)
  assert.notEqual(successorHash, rootHash)
  assert.equal(f.A.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined)
  f.A.db.close(); f.A.db = f.connect(f.A)
  const readbackStart = f.server.requests.length
  const result = completed(await f.track(exchangeSyncedSnapshot(f.A.db, input, runtime)), 'applied')
  assert.equal(result.beforeManifestHash, rootHash)
  assert.equal(result.afterManifestHash, successorHash)
  readonlyRequests(f.server.requests.slice(readbackStart))
  f.server.files.delete(archive)
  await assert.rejects(f.track(exchangeSyncedSnapshot(f.B.db, f.input(randomUUID(), f.B), runtime)), /前驱原字节缺失/)
  f.server.files.set(archive, root)
  const downloaded = completed(await f.track(exchangeSyncedSnapshot(f.B.db, f.input(randomUUID(), f.B), runtime)), 'applied')
  assert.equal(downloaded.afterManifestHash, successorHash)
  const fresh = f.newPristine('unanchored-successor')
  await assert.rejects(f.track(exchangeSyncedSnapshot(fresh.db, f.input(randomUUID(), fresh), runtime)), /缺少原首发或接收回执/)
  f.server.files.delete(archive)
  await assert.rejects(f.track(receiveInitialSyncedSnapshot(fresh.db, f.input(randomUUID(), fresh), runtime)), /前驱原字节缺失/)
  assert.equal(fresh.db.prepare('SELECT id FROM documents LIMIT 1').get(), undefined)
  f.server.files.set(archive, root)
  const joined = accepted(await f.track(receiveInitialSyncedSnapshot(fresh.db, f.input(randomUUID(), fresh), runtime)))
  assert.equal(joined.manifestHash, successorHash)
  fresh.db.close(); fresh.db = f.connect(fresh)
  hostEdit(fresh.db, f.other, 'The late receiver now publishes')
  const uploaded = completed(await f.track(exchangeSyncedSnapshot(fresh.db, f.input(randomUUID(), fresh), runtime)), 'applied')
  assert.deepEqual(uploaded.publishedKeys, ['doc:' + f.other])
  const newHead = Buffer.from(f.server.files.get(head)!)
  f.server.files.set(head, root)
  await assert.rejects(f.track(exchangeSyncedSnapshot(f.B.db, f.input(randomUUID(), f.B), runtime)), /历史没有到达本机已接受/)
  f.server.files.set(head, newHead)
  assert.deepEqual(f.server.files.get(archive), root)
}))

test('a new profile preserves document and group deletions from the verified current head and exchanges normally after reopen', () => withIncomingFixture(async f => {
  const backup = join(f.folder, 'v3-before-deletions')
  writeSyncedBackupV3(f.A.db, { userDataRoot: f.A.root, destination: backup, snapshotId: randomUUID() })
  const preparation = await prepareInitialSyncedPublication(f.A.db, { attemptId: randomUUID(), userDataRoot: f.A.root, target: f.targetConfig }, true)
  assert.equal(preparation.status, 'prepared')
  if (preparation.status !== 'prepared') throw new Error('Expected the real chained initial publication')
  try { assert.equal((await publishInitialSyncedPublication(f.A.db, preparation.prepared, runtime)).status, 'confirmed') }
  finally { disposePreparedSyncedPublication(preparation.prepared) }
  const headPath = '/Incoming/manifest.json', root = Buffer.from(f.server.files.get(headPath)!), rootHash = hash(root)
  const initial = validateInitialManifest5(JSON.parse(root.toString()))
  const groupKey = 'group:' + f.orphanId!, docKey = 'doc:' + f.other
  const group = JSON.parse(f.server.files.get('/Incoming/objects/' + initial.entries[groupKey] + '.json')!.toString())
  const tombstones = [[docKey, { kind: 'deleted', id: f.other }],
    [groupKey, { kind: 'synced-group-deleted', id: group.id, creationId: group.creationId,
      previousHash: initial.entries[groupKey], deletedAt: new Date().toISOString() }]] as const
  const entries = { ...initial.entries }
  for (const [key, record] of tombstones) {
    const bytes = Buffer.from(publicationJson(record)); entries[key] = hash(bytes)
    f.server.files.set('/Incoming/objects/' + entries[key] + '.json', bytes)
  }
  f.server.files.set('/Incoming/objects/manifest-' + rootHash + '.json', root)
  const successor = { ...initial, entries, history: protocol5HistoryLink(initial.history!.targetFingerprint, randomUUID(), rootHash) }
  const successorBytes = Buffer.from(publicationJson(successor))
  f.server.files.set(headPath, successorBytes)
  const joinStart = f.server.requests.length
  const joined = accepted(await f.receive())
  readonlyRequests(f.server.requests.slice(joinStart))
  assert.equal(joined.manifestHash, hash(successorBytes))
  assert.equal(f.B.db.prepare('SELECT 1 FROM documents WHERE id=?').get(f.other), undefined)
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(f.orphanId), undefined)
  f.B.db.close()
  const sealedCurrent = await readFile(f.B.file)
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => false }
  await assert.rejects(restoreControlledBackupV3({ userDataRoot: f.B.root, backupDirectory: backup,
    stopProcesses: async () => [] }, legacy, async () => assert.fail('The stale backup must be rejected before installation confirmation')),
  /已从 WebDAV 接收永久删除的记录/)
  assert.deepEqual(await readFile(f.B.file), sealedCurrent)
  f.reopen()
  hostEdit(f.B.db, f.child, 'Independent edit from a late receiver with deletions')
  const exchanged = completed(await f.track(exchangeSyncedSnapshot(f.B.db, f.input(randomUUID(), f.B), runtime)), 'applied')
  assert.deepEqual(exchanged.publishedKeys, ['doc:' + f.child])
  assert.deepEqual(exchanged.deferred, [])
  const currentBytes = Buffer.from(f.server.files.get(headPath)!), currentHash = hash(currentBytes)
  const current = validateInitialManifest5(JSON.parse(currentBytes.toString()))
  for (const [key] of tombstones) assert.equal(current.entries[key], entries[key])
  f.B.db.transaction(() => assertRawSyncedExchangeHistoricalMetadataOwned(f.B.db))()
  f.reopen()
  const alreadyCurrent = completed(await f.track(exchangeSyncedSnapshot(f.B.db, f.input(randomUUID(), f.B), runtime)), 'noop')
  assert.equal(alreadyCurrent.afterManifestHash, currentHash)
  // A newly published-looking head cannot restore either inherited ID.
  f.server.files.set('/Incoming/objects/manifest-' + currentHash + '.json', currentBytes)
  f.server.files.set(headPath, Buffer.from(publicationJson({ ...current,
    entries: { ...current.entries, [docKey]: initial.entries[docKey], [groupKey]: initial.entries[groupKey] },
    history: protocol5HistoryLink(current.history!.targetFingerprint, randomUUID(), currentHash) })))
  const refused = completed(await f.track(exchangeSyncedSnapshot(f.B.db, f.input(randomUUID(), f.B), runtime)), 'deferred')
  for (const [key] of tombstones) assert.ok(refused.deferred.some(component => component.keys.includes(key)))
  assert.equal(f.B.db.prepare('SELECT 1 FROM documents WHERE id=?').get(f.other), undefined)
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(f.orphanId), undefined)
}, { orphan: true }))
