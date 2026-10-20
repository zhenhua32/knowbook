import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { AttachmentStore } from '../src/main/attachments'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { WebDavSyncService } from '../src/main/sync/service'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../src/shared/webdav-sync'

async function withService(run: (sync: WebDavSyncService) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-webdav-diagnostics-'))
  const store = new KnowbookStore(join(root, 'knowbook.db'))
  const sync = new WebDavSyncService(store, new AttachmentStore(join(root, 'assets')), createEphemeralCredentialStorage(randomUUID))
  try {
    sync.saveConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, url: 'http://127.0.0.1:12345/', username: 'test',
      password: 'fixture-password', allowInsecureHttp: true })
    await run(sync)
  } finally {
    await sync.stop()
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
}

test('WebDAV connection failures preserve the original fetch cause through client and service messages', async context => {
  const transportError = new TypeError('fixture fetch failure')
  const message = '无法连接 WebDAV 或请求超时，请检查网络、地址和证书。'
  let requests = 0
  context.mock.method(globalThis, 'fetch', async () => { requests++; throw transportError })
  await withService(async sync => {
    await assert.rejects(sync.testConnection(), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, message)
      assert.ok(error.cause instanceof Error)
      assert.equal(error.cause.message, message)
      assert.equal(error.cause.cause, transportError)
      return true
    })
    assert.equal(requests, 1, 'a diagnostic cause must not add a transport retry')
    assert.equal(sync.getStatus().phase, 'error')
    assert.equal(sync.getStatus().message, message)
    assert.equal(sync.getStatus().progress, null)
  })
})

test('WebDAV response body failures preserve the original reader error through service diagnostics', async context => {
  const transportError = new Error('fixture response body failure')
  const methods: string[] = []
  context.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    methods.push(method)
    if (method === 'GET') return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(transportError) }
    }), { status: 200 })
    return new Response(null, { status: method === 'DELETE' ? 204 : 201 })
  })
  await withService(async sync => {
    await assert.rejects(sync.testConnection(), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, transportError.message)
      assert.equal(error.cause, transportError)
      return true
    })
    assert.deepEqual(methods, ['MKCOL', 'MKCOL', 'MKCOL', 'PUT', 'GET', 'DELETE'])
    assert.equal(sync.getStatus().phase, 'error')
    assert.equal(sync.getStatus().message, transportError.message)
    assert.equal(sync.getStatus().progress, null)
  })
})
