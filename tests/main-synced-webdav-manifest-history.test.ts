import assert from 'node:assert/strict'
import test from 'node:test'
import { exchangeSyncedSnapshot } from '../src/main/sync/synced-exchange'
import { prepareInitialSyncedPublication, publishInitialSyncedPublication, disposePreparedSyncedPublication,
  receiveInitialSyncedSnapshot } from '../src/main/sync/synced-publication'
import { validateInitialManifest5 } from '../src/main/sync/synced-publication-model'
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
  assert.deepEqual(await f.track(receiveInitialSyncedSnapshot(fresh.db, f.input(randomUUID(), fresh), runtime)),
    { status: 'unsupported', reason: 'initial-snapshot-only' })
  await assert.rejects(f.track(exchangeSyncedSnapshot(fresh.db, f.input(randomUUID(), fresh), runtime)), /缺少原首发或接收回执/)
  f.server.files.set(head, root)
  await assert.rejects(f.track(exchangeSyncedSnapshot(f.B.db, f.input(randomUUID(), f.B), runtime)), /历史没有到达本机已接受/)
  f.server.files.set(head, successor)
  assert.deepEqual(f.server.files.get(archive), root)
}))
