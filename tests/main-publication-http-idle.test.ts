import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { WebDavClient, normalizeWebDavConfig } from '../src/main/sync/webdav-client'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../src/shared/webdav-sync'
import { createPublicationHttpServer } from './helpers/synced-publication-http-fixture'

test('publication HTTP fixture keeps an idle connection usable across synchronous host work without a request retry', async () => {
  const server = await createPublicationHttpServer()
  try {
    const bytes = Buffer.from('Stable original publication object')
    server.files.set('/Publication/objects/idle.json', bytes)
    const target = normalizeWebDavConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, enabled: true, url: server.url,
      username: 'test', directory: 'Publication', allowInsecureHttp: true })
    const client = new WebDavClient(target, 'app-secret')
    const before = await client.getVersioned('objects/idle.json')
    assert.ok(before); assert.deepEqual(Buffer.from(before.bytes), bytes)
    await setImmediate()
    // Reproduce a synchronous Main interval beyond Node 22.16's default five
    // second server idle window. A sleep that yields would miss the race.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6100)
    assert.deepEqual(await client.getVersioned('objects/idle.json'), before)
    assert.deepEqual(server.requests.map(request => request.method), ['GET', 'GET'])
    assert.deepEqual(server.files.get('/Publication/objects/idle.json'), bytes)
    server.assertNoHookErrors()
  } finally { await server.close() }
})

test('publication HTTP fixture still delivers an explicit disconnect as a real transport failure without retrying', async () => {
  const server = await createPublicationHttpServer()
  try {
    const bytes = Buffer.from('Original bytes survive an explicit disconnect')
    server.files.set('/Publication/objects/disconnect.json', bytes)
    const target = normalizeWebDavConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, enabled: true, url: server.url,
      username: 'test', directory: 'Publication', allowInsecureHttp: true })
    const client = new WebDavClient(target, 'app-secret')
    assert.ok(await client.getVersioned('objects/disconnect.json'))
    server.setHook(() => ({ kind: 'disconnect' }))
    await assert.rejects(client.getVersioned('objects/disconnect.json'), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error)
      assert.match(error.message, /无法连接 WebDAV/)
      return true
    })
    assert.deepEqual(server.requests.map(request => request.method), ['GET', 'GET'])
    assert.deepEqual(server.files.get('/Publication/objects/disconnect.json'), bytes)
    server.assertNoHookErrors()
  } finally { await server.close() }
})
