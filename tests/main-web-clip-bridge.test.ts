import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import test from 'node:test'
import type { WebClipBridgeStatus } from '../src/shared/contracts'
import { KnowbookStore } from '../src/main/database/store.ts'
import { WebClipBridgeService } from '../src/main/web-clip-bridge.ts'
import { WebClipperService } from '../src/main/web-clipper.ts'

test('bridge status retains the configured port without claiming a stopped service is listening', async () => {
  const events: WebClipBridgeStatus[] = []
  const bridge = new WebClipBridgeService({
    onImport: async () => { throw new Error('No import expected') },
    onStateChange: status => events.push(status)
  })
  try {
    assert.equal(bridge.getStatus().configuredPort, 3210)
    const stopped = await bridge.applyConfig({ enabled: false, port: 4321, token: 'saved-token' })
    assert.equal(stopped.configuredPort, 4321)
    assert.equal(stopped.port, null)
    assert.equal(stopped.endpoint, null)
    assert.equal(stopped.running, false)
    assert.equal(events.at(-1)?.configuredPort, 4321)
    stopped.configuredPort = 9999
    assert.equal(bridge.getStatus().configuredPort, 4321)
    const regenerated = await bridge.applyConfig({ enabled: false, port: 5432, token: 'new-token' })
    assert.equal(regenerated.configuredPort, 5432)
    assert.equal(regenerated.token, 'new-token')
    assert.equal(regenerated.port, null)
  } finally {
    await bridge.destroy()
  }
})

test('bridge startup failure retains the requested port for a settings recovery', async () => {
  const occupied = createServer()
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject)
    occupied.listen(0, '127.0.0.1', resolve)
  })
  const port = (occupied.address() as AddressInfo).port
  const bridge = new WebClipBridgeService({ onImport: async () => { throw new Error('No import expected') } })
  try {
    const failed = await bridge.applyConfig({ enabled: true, port, token: 'saved-token' })
    assert.equal(failed.enabled, true)
    assert.equal(failed.running, false)
    assert.equal(failed.port, null)
    assert.equal(failed.endpoint, null)
    assert.equal(failed.configuredPort, port)
    assert.match(failed.lastError ?? '', /EADDRINUSE/)
    await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()))
    const recovered = await bridge.applyConfig({ enabled: true, port, token: 'saved-token' })
    assert.equal(recovered.configuredPort, port)
    assert.equal(recovered.port, port)
    assert.equal(recovered.running, true)
    assert.equal(recovered.lastError, null)
  } finally {
    await bridge.destroy()
    if (occupied.listening) await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()))
  }
})

test('WebClipBridgeService accepts authorized POST payloads and persists a clipped document', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-bridge-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const clipper = new WebClipperService(store, join(tempRoot, 'assets'))
  const bridge = new WebClipBridgeService({
    onImport: (payload) => clipper.importWebClipPayload(payload)
  })

  try {
    const status = await bridge.applyConfig({
      enabled: true,
      port: 0,
      token: 'test-token'
    })

    assert.equal(status.running, true)
    assert.ok(status.endpoint)

    const response = await fetch(status.endpoint!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token'
      },
      body: JSON.stringify({
        url: 'https://example.com/article',
        parentId: null,
        title: 'Bridge Article',
        text: 'Bridge article body with enough text to be stored as a clipped note.'
      })
    })

    assert.equal(response.status, 200)
    const payload = await response.json() as { documentId: string; title: string; created: boolean }
    assert.equal(payload.created, true)
    assert.equal(payload.title, 'Bridge Article')

    const detail = store.getDocumentDetail(payload.documentId)
    assert.ok(detail)
    assert.equal(detail.title, 'Bridge Article')
    assert.equal(detail.blocks.some((block) => block.content.includes('Bridge article body')), true)
  } finally {
    await bridge.destroy()
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipBridgeService rejects unauthorized payloads', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-bridge-auth-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const clipper = new WebClipperService(store, join(tempRoot, 'assets'))
  const bridge = new WebClipBridgeService({
    onImport: (payload) => clipper.importWebClipPayload(payload)
  })

  try {
    const status = await bridge.applyConfig({
      enabled: true,
      port: 0,
      token: 'secret-token'
    })

    const response = await fetch(status.endpoint!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token'
      },
      body: JSON.stringify({
        url: 'https://example.com/article',
        parentId: null,
        title: 'Should Fail',
        text: 'This should never be imported.'
      })
    })

    assert.equal(response.status, 401)
    assert.equal(store.getHomeData(join(tempRoot, 'backup')).documentCatalog.some((entry) => entry.title === 'Should Fail'), false)
  } finally {
    await bridge.destroy()
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipBridgeService reports malformed JSON as a client error', async () => {
  const bridge = new WebClipBridgeService({
    onImport: async () => {
      throw new Error('onImport must not be called')
    }
  })

  try {
    const status = await bridge.applyConfig({
      enabled: true,
      port: 0,
      token: 'test-token'
    })
    const response = await fetch(status.endpoint!, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json'
      },
      body: '{broken-json'
    })

    assert.equal(response.status, 400)
    assert.match(await response.text(), /valid JSON/)
  } finally {
    await bridge.destroy()
  }
})
