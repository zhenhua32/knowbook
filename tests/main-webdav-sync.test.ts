import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../src/shared/webdav-sync'
import { normalizeWebDavConfig, WebDavClient, WebDavHttpError, type WebDavRequestActivity } from '../src/main/sync/webdav-client'
import { readWebDavEtag } from '../src/main/sync/webdav-properties'
import { createWebDavServer } from './helpers/webdav-server'

type Server = Awaited<ReturnType<typeof createWebDavServer>>
const manifest = 'manifest.json', manifestPath = '/KnowBook/' + manifest

function clientFor(server: Server) {
  return new WebDavClient(normalizeWebDavConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, url: server.url, username: 'test', allowInsecureHttp: true }), 'app-secret')
}

async function withServer(run: (client: WebDavClient, server: Server) => Promise<void>) {
  const server = await createWebDavServer()
  try { await run(clientFor(server), server) } finally { await server.close() }
}

test('Nutstore rate-limit waits are observable and clear immediately when cancelled', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(null, { status: 200 }) })
  const controller = new AbortController(), activity: WebDavRequestActivity[] = []
  const client = new WebDavClient({ ...DEFAULT_WEBDAV_SYNC_CONFIG, url: 'https://dav.jianguoyun.com/dav/', username: 'test' },
    'fixture-password', controller.signal, undefined, value => activity.push(value))
  await client.exists(manifest)
  const next = client.exists(manifest)
  const waiting = activity.at(-1)!
  assert.ok(waiting.waitingUntil && Date.parse(waiting.waitingUntil) > Date.now())
  assert.equal(waiting.completed, false)
  controller.abort()
  await assert.rejects(next, /停止/)
  assert.equal(requests, 1)
  assert.equal(activity.at(-1)!.waitingUntil, null)
})

test('a WebDAV 429 exposes the HTTP status and leaves the requested file absent', () => withServer(async (client, server) => {
  server.setHook(request => request.method === 'PUT' ? 429 : undefined)
  await assert.rejects(client.create(manifest, Buffer.from('blocked')), error => error instanceof WebDavHttpError
    && error.status === 429 && /频繁/.test(error.message))
  assert.equal(server.files.has(manifestPath), false)
  assert.deepEqual(server.requests.map(request => request.method), ['PUT'])
}))

test('connection probes reject unsafe conditional writes and weak ETags, and clean up probe objects', async t => {
  await t.test('conditional write enforcement is checked again on retest', () => withServer(async (client, server) => {
    assert.deepEqual(await client.test(), { createMode: 'conditional' })
    server.ignoreConditions()
    await assert.rejects(client.test(), /条件写入/)
    assert.equal(server.files.size, 0)
  }))
  await t.test('weak tags cannot authorize writes', () => withServer(async (client, server) => {
    server.weakEtags()
    await assert.rejects(client.test(), /ETag/)
    assert.equal(server.files.size, 0)
  }))
})

test('opaque, HEAD-only and PROPFIND-only ETags authorize exact versioned writes', async t => {
  for (const profile of [
    { etagStyle: 'bare' as const },
    { etagStyle: 'bare' as const, etagHeaders: 'none' as const, requireQuotedIfMatch: true },
    { etagHeaders: 'head' as const },
    { etagHeaders: 'none' as const }
  ]) await t.test(JSON.stringify(profile), () => withServer(async (client, server) => {
    server.setOptions(profile)
    await client.test()
    await client.create(manifest, Buffer.from('first version'))
    const first = await client.getVersioned(manifest)
    assert.ok(first)
    assert.equal(Buffer.from(first.bytes).toString(), 'first version')
    if (profile.etagStyle === 'bare') assert.match(first.etag, /^[0-9a-f]{64}$/)
    await client.put(manifest, Buffer.from('second version'), { etag: first.etag })
    await assert.rejects(client.put(manifest, Buffer.from('stale version'), { etag: first.etag }), { status: 412 })
    const second = await client.getVersioned(manifest)
    assert.ok(second)
    assert.equal(Buffer.from(second.bytes).toString(), 'second version')
    assert.notEqual(second.etag, first.etag)
    if ('etagHeaders' in profile) assert.ok(server.requests.some(request => request.method === 'HEAD' && request.path === manifestPath))
    if (profile.etagHeaders === 'none') assert.ok(server.requests.some(request => request.method === 'PROPFIND' && request.path === manifestPath))
  }))
})

test('metadata fallback does not combine an old body with a newer ETag', () => withServer(async (client, server) => {
  server.setOptions({ etagHeaders: 'none' })
  server.files.set(manifestPath, Buffer.from('old body'))
  let raced = false
  server.setHook(request => {
    if (request.method === 'HEAD' && request.url === manifestPath) {
      raced = true
      server.files.set(manifestPath, Buffer.from('new body'))
    }
  })
  const result = await client.getVersioned(manifest)
  assert.ok(raced && result)
  assert.equal(Buffer.from(result.bytes).toString(), 'new body')
  await client.put(manifest, Buffer.from('conditional write after race'), { etag: result.etag })
  assert.equal(server.files.get(manifestPath)?.toString(), 'conditional write after race')
}))

test('metadata fallback rejects servers that ignore conditional GET', () => withServer(async (client, server) => {
  server.setOptions({ etagHeaders: 'none', ignoreConditionalGet: true })
  await assert.rejects(client.test(), /按版本读取/)
  assert.equal(server.files.size, 0)
}))

test('MOVE without overwrite protects the winner of a first publication race', async t => {
  for (const moveConflictStatus of [412, 409] as const) await t.test(`MOVE conflict ${moveConflictStatus}`, () => withServer(async (first, server) => {
    server.setOptions({ ignoreIfNoneMatch: true, etagStyle: 'bare', etagHeaders: moveConflictStatus === 409 ? 'all' : 'none', moveConflictStatus })
    const second = clientFor(server)
    assert.deepEqual(await first.test(), { createMode: 'move' })
    assert.deepEqual(await second.test(), { createMode: 'move' })
    let raced = false
    server.setHook(async request => {
      if (!raced && request.method === 'MOVE' && new URL(String(request.headers.destination)).pathname === manifestPath) {
        raced = true
        await second.create(manifest, Buffer.from('winning body'))
      }
    })
    await assert.rejects(first.create(manifest, Buffer.from('losing body')), { status: 412 })
    assert.ok(raced)
    assert.deepEqual([...server.files], [[manifestPath, Buffer.from('winning body')]])
  }))
})

test('MOVE 409 without an existing target remains an error and removes the pending object', () => withServer(async (client, server) => {
  server.setOptions({ ignoreIfNoneMatch: true, moveConflictStatus: 409 })
  assert.deepEqual(await client.test(), { createMode: 'move' })
  server.setHook(request => request.method === 'MOVE' && new URL(String(request.headers.destination)).pathname === manifestPath ? 409 : undefined)
  await assert.rejects(client.create(manifest, Buffer.from('must not publish')), { status: 409 })
  assert.equal(server.requests.filter(request => request.method === 'MOVE' && request.path.includes('.pending-')).length, 1)
  assert.equal(server.files.size, 0)
}))

test('an unsafe MOVE implementation is rejected when conditional create is unavailable', () => withServer(async (client, server) => {
  server.setOptions({ ignoreIfNoneMatch: true, ignoreMoveOverwrite: true })
  await assert.rejects(client.test(), /安全的新建文件/)
  assert.equal(server.files.size, 0)
}))

test('WebDAV properties respect namespaces, resource identity and per-property status', () => {
  const target = 'https://example.com/dav/KnowBook/manifest.json'
  const response = (href: string, status: string, tag: string, namespace = 'DAV:') => `<response xmlns="${namespace}"><href>${href}</href><propstat><prop><getetag>${tag}</getetag></prop><status>HTTP/1.1 ${status}</status></propstat></response>`
  const document = (body: string) => `<multistatus xmlns="DAV:">${body}</multistatus>`
  assert.equal(readWebDavEtag(document(response('/dav/KnowBook/manifest.json', '200 OK', '&quot;rev&amp;1&quot;')), target), '"rev&1"')
  assert.equal(readWebDavEtag(document(response(target, '404 Not Found', '&quot;wrong&quot;')), target), null)
  assert.throws(() => readWebDavEtag(document(response('/other.json', '200 OK', '&quot;wrong&quot;')), target), /当前文件/)
  assert.throws(() => readWebDavEtag(document(response(target, '200 OK', '&quot;wrong&quot;', 'urn:not-dav')), target), /当前文件/)
  assert.throws(() => readWebDavEtag('<!DOCTYPE multistatus [<!ENTITY x "boom">]>' + document(''), target), /XML 声明/)
  assert.throws(() => readWebDavEtag(document(response(target, '200 OK', 'one') + response(target, '200 OK', 'two')), target), /唯一/)
})

test('WebDAV config rejects unsafe URLs, credentials and directory paths', () => {
  const base = { ...DEFAULT_WEBDAV_SYNC_CONFIG, url: 'https://example.com/dav/', username: 'user' }
  assert.throws(() => normalizeWebDavConfig({ ...base, url: 'http://example.com/dav/' }), /HTTPS/)
  assert.throws(() => normalizeWebDavConfig({ ...base, directory: '../private' }), /目录/)
  assert.throws(() => normalizeWebDavConfig({ ...base, url: 'https://user:secret@example.com/' }), /地址/)
  assert.throws(() => normalizeWebDavConfig({ ...base, url: 'https://example.com/?token=secret' }), /地址/)
  assert.throws(() => normalizeWebDavConfig({ ...base, username: 'user:password' }), /用户名/)
  assert.throws(() => normalizeWebDavConfig({ ...base, intervalMinutes: 0 }), /间隔/)
})
