import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { WebClipBridgeService } from '../src/main/web-clip-bridge.ts'
import { WebClipperService } from '../src/main/web-clipper.ts'

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