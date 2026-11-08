import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AttachmentStore } from '../src/main/attachments'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { KnowbookStore } from '../src/main/database/store'
import { assertRawSyncedHistoricalEvidenceOwned } from '../src/main/database/synced-operation-history-read'
import { requestsEmptySyncReceiver, SYNC_RECEIVER_PROFILE_KEY } from '../src/main/sync/receiver-bootstrap'
import { WebDavSyncService } from '../src/main/sync/service'
import { createWebDavServer } from './helpers/webdav-server'

const initialize = '--knowbook-initialize-sync-receiver'
const argsFor = (profile: string) => [initialize, `--knowbook-user-data-dir=${profile}`]

test('explicit empty receiver initializes a real default catalog once and refuses an existing workspace without rewriting it', () => {
  const profile = mkdtempSync(join(tmpdir(), 'kb-synced-receiver-')), databasePath = join(profile, 'storage', 'knowbook.db')
  let store: KnowbookStore | undefined
  try {
    assert.throws(() => requestsEmptySyncReceiver([initialize], profile), /显式指定/)
    assert.equal(requestsEmptySyncReceiver(argsFor(profile), profile), true)
    store = KnowbookStore.createEmptySyncedReceiver(databasePath)
    assert.deepEqual(store.getDocumentCatalog(), [])
    assert.equal(store.getDatabases().length, 1)
    assert.equal(store.getDatabases()[0].name, 'Default')
    assert.equal(store.getSettingPublic(SYNC_RECEIVER_PROFILE_KEY), 'true')
    store.destroy()
    store = undefined
    const original = readFileSync(databasePath)
    assert.throws(() => requestsEmptySyncReceiver(argsFor(profile), profile), /已有工作区/)
    assert.throws(() => KnowbookStore.createEmptySyncedReceiver(databasePath), { code: 'EEXIST' })
    assert.deepEqual(readFileSync(databasePath), original)

    store = KnowbookStore.openCanonicalRuntime(databasePath)
    assert.deepEqual(store.getDocumentCatalog(), [])
    assert.equal(store.getSettingPublic(SYNC_RECEIVER_PROFILE_KEY), 'true')
  } finally { store?.destroy(); rmSync(profile, { recursive: true, force: true }) }
})

test('ordinary startup still seeds its examples and receiver initialization does not remove any of them', () => {
  const profile = mkdtempSync(join(tmpdir(), 'kb-ordinary-profile-')), databasePath = join(profile, 'storage', 'knowbook.db')
  let store: KnowbookStore | undefined
  try {
    assert.equal(requestsEmptySyncReceiver([], profile), false)
    store = KnowbookStore.openCanonicalRuntime(databasePath)
    assert.deepEqual(store.getDocumentCatalog().map(entry => entry.title).sort(), ['Home', 'Product', 'Roadmap'])
    assert.equal(store.getSettingPublic(SYNC_RECEIVER_PROFILE_KEY), null)
    assert.throws(() => requestsEmptySyncReceiver(argsFor(profile), profile), /已有工作区/)
    assert.deepEqual(store.getDocumentCatalog().map(entry => entry.title).sort(), ['Home', 'Product', 'Roadmap'])
  } finally { store?.destroy(); rmSync(profile, { recursive: true, force: true }) }
})

test('production WebDAV opt-in and pending route are device settings, separate from strict historical evidence', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'kb-protocol5-history-'))
  const server = await createWebDavServer()
  const store = KnowbookStore.openCanonicalRuntime(join(profile, 'storage', 'knowbook.db'))
  const service = new WebDavSyncService(store, new AttachmentStore(join(profile, 'storage', 'attachments')),
    createEphemeralCredentialStorage(randomUUID), undefined, undefined, profile)
  try {
    const db = store.getUnsafeDatabaseHandle()
    const historical = db.transaction(() => assertRawSyncedHistoricalEvidenceOwned(db))
    const before = historical()
    service.saveConfig({ url: server.url, username: 'test', password: 'app-secret', directory: 'history',
      enabled: false, intervalMinutes: 5, allowInsecureHttp: true, protocol5: true })
    await assert.rejects(service.sync(), /同步块/)
    const settings = db.prepare("SELECT key FROM app_settings WHERE key LIKE '%protocol5%' ORDER BY key").all() as { key: string }[]
    assert.ok(settings.some(row => row.key.includes('.opt-in.v1.')))
    assert.ok(settings.some(row => row.key.includes('.route.v1.')))
    assert.deepEqual(historical(), before)
    store.saveSetting('sync.webdav.protocol5.unrecognized.v1.test', '{}')
    assert.throws(historical, /未知protocol5 metadata/)
  } finally {
    await service.stop()
    store.destroy()
    await server.close()
    rmSync(profile, { recursive: true, force: true })
  }
})
