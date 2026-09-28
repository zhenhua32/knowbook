import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { KnowbookStore } from '../src/main/database/store'
import { AttachmentStore } from '../src/main/attachments'
import { WebDavSyncService } from '../src/main/sync/service'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../src/shared/webdav-sync'
import { attachmentMarkdown } from '../src/shared/attachments'
import { collectMarkdownDestinations } from '../src/shared/markdownLinks'
import { canonicalJson, hashBytes, parseManifest, recordHash, validateRecord } from '../src/main/sync/model'
import { normalizeWebDavConfig } from '../src/main/sync/webdav-client'
import { createWebDavServer } from './helpers/webdav-server'
import { readWebDavEtag } from '../src/main/sync/webdav-properties'

async function fixture(run: (a: ReturnType<typeof device>, b: ReturnType<typeof device>, server: Awaited<ReturnType<typeof createWebDavServer>>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-webdav-'))
  const server = await createWebDavServer()
  const a = device(root, 'a', server.url), b = device(root, 'b', server.url)
  try { await run(a, b, server) }
  finally { await a.sync.stop(); await b.sync.stop(); a.store.destroy(); b.store.destroy(); await server.close(); rmSync(root, { recursive: true, force: true }) }
}
function device(root: string, name: string, url: string) {
  const store = new KnowbookStore(join(root, name, 'knowbook.db'))
  for (const doc of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(doc.id)
  const assets = new AttachmentStore(join(root, name, 'assets'))
  const credentials = createEphemeralCredentialStorage(randomUUID)
  const sync = new WebDavSyncService(store, assets, credentials)
  sync.saveConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, url, username: 'test', password: 'app-secret', allowInsecureHttp: true })
  return { store, assets, sync, credentials }
}
function edit(store: KnowbookStore, id: string, text: string, title?: string) {
  const old = store.documentRecovery.readContent(id)
  store.updateDocument(id, { ...old, title: title ?? old.title, blocks: [{ ...old.blocks[0], content: text }] })
}
function content(store: KnowbookStore, id: string) { return store.getDocumentDetail(id)!.blocks[0].content }

test('two independent devices sync trees, stable IDs, attachments, and database fields with no-op incremental runs', () => fixture(async (a, b, server) => {
  const parent = a.store.createDocument(null), child = a.store.createDocument(parent)
  edit(a.store, parent, 'Parent body', '项目')
  const [image, pdf] = await a.assets.import([{ name: '截图 [1] #100%.png', bytes: Buffer.from('image-bytes') }, { name: '合同.pdf', bytes: Buffer.from('pdf-bytes') }])
  edit(a.store, child, `${attachmentMarkdown(image)}\n${attachmentMarkdown(pdf)}`, '资料')
  const column = a.store.createDocumentDatabaseColumn({ name: '状态', type: 'select', options: ['完成'] })
  a.store.updateDocumentDatabaseValue({ documentId: child, columnId: column.id, value: '完成' })
  a.store.saveSetting('ai.apiKey', 'should-never-upload')
  await a.sync.sync(); await b.sync.sync()
  assert.equal(b.store.getDocumentSnapshot(child)?.parentId, parent)
  assert.equal(b.store.getDocumentSnapshot(child)?.path, '项目/资料')
  assert.equal(b.store.getDocumentDetail(child)!.blocks[0].id, a.store.getDocumentDetail(child)!.blocks[0].id)
  const urls = collectMarkdownDestinations(content(b.store, child)).map(item => item.url)
  assert.equal(readFileSync(b.assets.resolve(urls[0]), 'utf8'), 'image-bytes')
  assert.equal(readFileSync(b.assets.resolve(urls[1]), 'utf8'), 'pdf-bytes')
  assert.notEqual(urls[0], image.url)
  assert.equal(b.store.getExportDocuments().find(doc => doc.id === child)!.documentDatabaseFieldValues[column.id], '完成')
  assert.ok(!Buffer.concat([...server.files.values()]).toString().includes('should-never-upload'))
  assert.ok(!Buffer.concat([...server.files.values()]).toString().includes('app-secret'))
  assert.match(a.store.getSettingPublic('sync.webdav.password')!, /^safe-storage:v1:/)
  const before = server.requests.length
  await a.sync.sync(); await b.sync.sync()
  assert.deepEqual(server.requests.slice(before).map(req => req.method), ['GET', 'GET'])
  const childUpdatedAt = a.store.getDocumentDetail(child)!.updatedAt
  edit(b.store, parent, 'Changed on B', '重命名')
  await b.sync.sync(); await a.sync.sync()
  assert.equal(content(a.store, parent), 'Changed on B')
  assert.equal(a.store.getDocumentSnapshot(child)?.path, '重命名/资料')
  assert.ok(a.store.getDocumentDetail(child)!.updatedAt > childUpdatedAt, 'renamed parent must refresh open descendant editors')
  const assetWrites = server.requests.filter(req => req.method === 'PUT' && req.path.includes('/assets/'))
  assert.equal(assetWrites.length, 2)
}))

test('concurrent edits keep both versions until resolved, and keep-both copies use distinct block IDs', () => fixture(async (a, b) => {
  const id = a.store.createDocument(null); edit(a.store, id, 'base', '冲突测试')
  await a.sync.sync(); await b.sync.sync()
  edit(a.store, id, 'A offline'); edit(b.store, id, 'B offline')
  await a.sync.sync(); await b.sync.sync()
  assert.equal(content(b.store, id), 'B offline')
  const conflicts = b.sync.getStatus().conflicts
  assert.equal(conflicts.length, 1); assert.match(conflicts[0].remotePreview, /A offline/)
  b.sync.resolveConflict({ key: `doc:${id}`, choice: 'both' })
  await b.sync.sync(); await a.sync.sync()
  assert.equal(b.sync.getStatus().conflicts.length, 0)
  assert.equal(content(b.store, id), 'A offline')
  const copy = b.store.getExportDocuments().find(doc => doc.id !== id)!
  assert.match(copy.title, /同步冲突副本/); assert.equal(copy.blocks[0].content, 'B offline')
  assert.notEqual(copy.blocks[0].id, b.store.getDocumentDetail(id)!.blocks[0].id)
  assert.equal(content(a.store, copy.id), 'B offline')
}))

test('deletions use tombstones, enter local Trash, and restoration syncs without resurrecting stale copies', () => fixture(async (a, b) => {
  const id = a.store.createDocument(null); edit(a.store, id, 'delete then restore')
  await a.sync.sync(); await b.sync.sync()
  a.store.deleteDocument(id); await a.sync.sync(); await b.sync.sync()
  assert.equal(b.store.getDocumentSnapshot(id), null)
  assert.ok(b.store.documentRecovery.listTrash().some(doc => doc.id === id))
  b.store.restoreTrashedDocument(id); await b.sync.sync(); await a.sync.sync()
  assert.equal(content(a.store, id), 'delete then restore')
}))

test('failed uploads do not publish manifest or advance cursor; retry converges', () => fixture(async (a, b, server) => {
  const id = a.store.createDocument(null); edit(a.store, id, 'retry content')
  server.setHook(req => req.method === 'PUT' && req.url!.endsWith('manifest.json') ? 503 : undefined)
  await assert.rejects(a.sync.sync(), /503/)
  assert.equal(a.sync.getStatus().lastSyncAt, null)
  assert.ok(!server.files.has('/KnowBook/manifest.json'))
  server.setHook(undefined)
  await a.sync.sync(); await b.sync.sync()
  assert.equal(content(b.store, id), 'retry content')
}))

test('manifest compare-and-swap retries after another device commits, preserving both independent edits', () => fixture(async (a, b, server) => {
  const first = a.store.createDocument(null); edit(a.store, first, 'base')
  await a.sync.sync(); await b.sync.sync()
  edit(a.store, first, 'edit A')
  const second = b.store.createDocument(null); edit(b.store, second, 'edit B')
  let raced = false
  server.setHook(async req => {
    if (!raced && req.method === 'PUT' && req.url!.endsWith('manifest.json')) {
      raced = true; await b.sync.sync()
    }
  })
  await a.sync.sync(); await b.sync.sync()
  assert.equal(content(a.store, second), 'edit B'); assert.equal(content(b.store, first), 'edit A')
}))

test('an edit during download is never overwritten and is surfaced as a conflict on the next run', () => fixture(async (a, b, server) => {
  const id = a.store.createDocument(null); edit(a.store, id, 'base')
  await a.sync.sync(); await b.sync.sync(); edit(a.store, id, 'remote'); await a.sync.sync()
  let edited = false
  server.setHook(req => {
    if (!edited && req.method === 'GET' && req.url!.includes('/objects/')) { edited = true; edit(b.store, id, 'edit during sync') }
  })
  await b.sync.sync()
  assert.equal(content(b.store, id), 'edit during sync')
  await b.sync.sync(); assert.equal(b.sync.getStatus().conflicts.length, 1)
}))

test('corrupt objects and missing manifests stop safely without deleting local data', () => fixture(async (a, b, server) => {
  const id = a.store.createDocument(null); edit(a.store, id, 'good'); await a.sync.sync(); await b.sync.sync()
  edit(a.store, id, 'new'); await a.sync.sync()
  const manifest = parseManifest(server.files.get('/KnowBook/manifest.json')!)
  const path = `/KnowBook/objects/${manifest.entries[`doc:${id}`]}.json`
  server.files.set(path, Buffer.from('{}'))
  await assert.rejects(b.sync.sync(), /校验失败/); assert.equal(content(b.store, id), 'good')
  server.files.delete('/KnowBook/manifest.json')
  await assert.rejects(b.sync.sync(), /清单丢失/); assert.equal(content(b.store, id), 'good')
}))

test('unsafe WebDAV conditional-write implementations and weak ETags are rejected', async () => {
  await fixture(async (a, _b, server) => { server.ignoreConditions(); await assert.rejects(a.sync.testConnection(), /条件写入/); assert.ok(!server.files.has('/KnowBook/manifest.json')) })
  await fixture(async (a, _b, server) => { server.weakEtags(); await assert.rejects(a.sync.testConnection(), /ETag/); assert.ok(!server.files.has('/KnowBook/manifest.json')) })
})

test('opaque unquoted, HEAD-only and PROPFIND-only ETags support two-device sync', async context => {
  for (const profile of [
    { etagStyle: 'bare' as const },
    { etagStyle: 'bare' as const, etagHeaders: 'none' as const, requireQuotedIfMatch: true },
    { etagHeaders: 'head' as const },
    { etagHeaders: 'none' as const }
  ]) await context.test(JSON.stringify(profile), () => fixture(async (a, b, server) => {
    server.setOptions(profile)
    const id = a.store.createDocument(null); edit(a.store, id, 'first version')
    await a.sync.testConnection(); await a.sync.sync(); await b.sync.sync()
    assert.equal(content(b.store, id), 'first version')
    edit(b.store, id, 'second version'); await b.sync.sync(); await a.sync.sync()
    assert.equal(content(a.store, id), 'second version')
    if ('etagHeaders' in profile) assert.ok(server.requests.some(request => request.method === 'HEAD'))
    if (profile.etagHeaders === 'none') assert.ok(server.requests.some(request => request.method === 'PROPFIND'))
  }))
})

test('metadata fallback never combines an old body with a newer version during a concurrent write', () => fixture(async (a, b, server) => {
  server.setOptions({ etagHeaders: 'none' })
  const id = a.store.createDocument(null); edit(a.store, id, 'base')
  await a.sync.sync(); await b.sync.sync()
  edit(a.store, id, 'remote edit after first GET')
  let raced = false
  server.setHook(async req => {
    if (!raced && req.method === 'HEAD' && req.url!.endsWith('manifest.json')) { raced = true; await a.sync.sync() }
  })
  await b.sync.sync()
  assert.ok(raced)
  assert.equal(content(b.store, id), 'remote edit after first GET')
}))

test('metadata fallback rejects servers that ignore conditional GET', () => fixture(async (a, _b, server) => {
  server.setOptions({ etagHeaders: 'none', ignoreConditionalGet: true })
  await assert.rejects(a.sync.testConnection(), /按版本读取/)
  assert.ok(!server.files.has('/KnowBook/manifest.json'))
}))

test('MOVE without overwrite safely creates a manifest when If-None-Match is ignored, including a first-sync race', async context => {
  for (const moveConflictStatus of [412, 409] as const) await context.test(`MOVE conflict ${moveConflictStatus}`, () => fixture(async (a, b, server) => {
    server.setOptions({ ignoreIfNoneMatch: true, etagStyle: 'bare', etagHeaders: moveConflictStatus === 409 ? 'all' : 'none', moveConflictStatus })
    const first = a.store.createDocument(null), second = b.store.createDocument(null)
    edit(a.store, first, 'device A'); edit(b.store, second, 'device B')
    await a.sync.testConnection(); await b.sync.testConnection()
    let raced = false
    server.setHook(async req => {
      if (!raced && req.method === 'MOVE' && String(req.headers.destination).endsWith('/manifest.json')) { raced = true; await b.sync.sync() }
    })
    await a.sync.sync(); await b.sync.sync()
    assert.ok(raced)
    assert.equal(content(a.store, second), 'device B')
    assert.equal(content(b.store, first), 'device A')
    assert.ok(![...server.files.keys()].some(path => path.includes('.probe-') || path.includes('.pending-')))
  }))
})

test('MOVE 409 without an existing target remains an error and does not publish or advance sync state', () => fixture(async (a, _b, server) => {
  server.setOptions({ ignoreIfNoneMatch: true, moveConflictStatus: 409 })
  const id = a.store.createDocument(null); edit(a.store, id, 'must remain local')
  await a.sync.testConnection()
  server.setHook(req => req.method === 'MOVE' && String(req.headers.destination).endsWith('/manifest.json') ? 409 : undefined)
  await assert.rejects(a.sync.sync(), /HTTP 409/)
  assert.equal(a.sync.getStatus().lastSyncAt, null)
  assert.equal(content(a.store, id), 'must remain local')
  assert.ok(!server.files.has('/KnowBook/manifest.json'))
  assert.equal(server.requests.filter(req => req.method === 'MOVE' && req.path.includes('.pending-')).length, 1)
  assert.ok(![...server.files.keys()].some(path => path.includes('.probe-') || path.includes('.pending-')))
}))

test('an unsafe MOVE implementation is rejected when conditional create is unavailable', () => fixture(async (a, _b, server) => {
  server.setOptions({ ignoreIfNoneMatch: true, ignoreMoveOverwrite: true })
  await assert.rejects(a.sync.testConnection(), /安全的新建文件/)
  assert.ok(!server.files.has('/KnowBook/manifest.json'))
}))

test('a failed connection retest invalidates the previously accepted capabilities', () => fixture(async (a, _b, server) => {
  await a.sync.testConnection()
  server.ignoreConditions()
  await assert.rejects(a.sync.testConnection(), /条件写入/)
  await assert.rejects(a.sync.sync(), /条件写入/)
  assert.ok(!server.files.has('/KnowBook/manifest.json'))
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

test('unsafe config and malformed remote records are rejected', () => {
  const base = { ...DEFAULT_WEBDAV_SYNC_CONFIG, url: 'https://example.com/dav/', username: 'user' }
  assert.throws(() => normalizeWebDavConfig({ ...base, url: 'http://example.com/dav/' }), /HTTPS/)
  assert.throws(() => normalizeWebDavConfig({ ...base, directory: '../private' }), /目录/)
  assert.throws(() => normalizeWebDavConfig({ ...base, url: 'https://user:secret@example.com/' }), /地址/)
  assert.throws(() => parseManifest(Buffer.from('{"version":9}')), /清单/)
  assert.throws(() => validateRecord({ kind: 'document', id: 'one' } as never, 'doc:one'), /格式/)
  const deleted = { kind: 'deleted' as const, id: 'one' }
  assert.equal(recordHash(deleted), hashBytes(canonicalJson(deleted)))
})

test('sync state survives service restart, including offline deletion and unresolved conflicts', () => fixture(async (a, b) => {
  const id = a.store.createDocument(null); edit(a.store, id, 'base')
  await a.sync.sync(); await b.sync.sync()
  edit(a.store, id, 'remote'); await a.sync.sync(); edit(b.store, id, 'local offline')
  await b.sync.stop(); b.sync = new WebDavSyncService(b.store, b.assets, b.credentials)
  await b.sync.sync(); assert.equal(b.sync.getStatus().conflicts.length, 1)
  await b.sync.stop(); b.sync = new WebDavSyncService(b.store, b.assets, b.credentials)
  assert.match(b.sync.getStatus().conflicts[0].localPreview, /local offline/)
  b.sync.resolveConflict({ key: `doc:${id}`, choice: 'local' }); await b.sync.sync(); await a.sync.sync()
  assert.equal(content(a.store, id), 'local offline')
  b.store.deleteDocument(id)
  await b.sync.stop(); b.sync = new WebDavSyncService(b.store, b.assets, b.credentials)
  await b.sync.sync(); await a.sync.sync(); assert.equal(a.store.getDocumentSnapshot(id), null)
}))

test('delete versus edit conflicts preserve the edit and stale resolutions are rejected', () => fixture(async (a, b) => {
  const id = a.store.createDocument(null); edit(a.store, id, 'base')
  await a.sync.sync(); await b.sync.sync()
  a.store.deleteDocument(id); edit(b.store, id, 'unsynced change')
  await a.sync.sync(); await b.sync.sync()
  assert.match(b.sync.getStatus().conflicts[0].remotePreview, /已删除/)
  b.sync.resolveConflict({ key: `doc:${id}`, choice: 'remote' })
  edit(b.store, id, 'changed after choosing')
  await b.sync.sync(); assert.equal(content(b.store, id), 'changed after choosing'); assert.equal(b.sync.getStatus().conflicts.length, 1)
  b.sync.resolveConflict({ key: `doc:${id}`, choice: 'both' }); await b.sync.sync(); await a.sync.sync()
  assert.equal(b.store.getDocumentSnapshot(id), null)
  assert.ok(a.store.getExportDocuments().some(doc => doc.blocks[0].content === 'changed after choosing'))
}))

test('database schema conflicts are explicit and custom records and views round-trip', () => fixture(async (a, b) => {
  const database = a.store.createDatabase({ name: 'Customers', description: 'Contacts' })
  const column = a.store.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Status', type: 'text' })
  a.store.createDatabaseEntity({ databaseId: database.id, title: 'Alice' })
  a.store.createDatabaseSavedView({ databaseId: database.id, name: 'Board', viewMode: 'board' })
  await a.sync.sync(); await b.sync.sync()
  assert.equal(b.store.getDatabaseEntities(database.id)[0].title, 'Alice')
  assert.equal(b.store.getDatabaseSavedViews(database.id)[0].name, 'Board')
  const aData = a.store.getSyncRecords().get('databases')!
  const bData = b.store.getSyncRecords().get('databases')!
  assert.deepEqual(bData, aData, 'database metadata, including creation times, must be preserved')
  a.store.renameDocumentDatabaseColumn({ columnId: column.id, name: 'A field' })
  b.store.renameDocumentDatabaseColumn({ columnId: column.id, name: 'B field' })
  await a.sync.sync(); await b.sync.sync()
  assert.equal(b.sync.getStatus().conflicts[0].key, 'databases')
  b.sync.resolveConflict({ key: 'databases', choice: 'remote' }); await b.sync.sync()
  assert.equal(b.store.getDocumentDatabaseColumns(database.id)[0].name, 'A field')
}))

test('stale editor saves cannot overwrite a version received through sync', () => fixture(async (a, b) => {
  const id = a.store.createDocument(null); edit(a.store, id, 'base')
  await a.sync.sync(); await b.sync.sync()
  const original = b.store.getDocumentDetail(id)!
  edit(a.store, id, 'new remote'); await a.sync.sync(); await b.sync.sync()
  assert.throws(() => b.store.updateDocument(id, { ...b.store.documentRecovery.readContent(id), summary: 'old draft', expectedUpdatedAt: original.updatedAt }), /草稿仍保留/)
  assert.equal(content(b.store, id), 'new remote')
}))

test('repeated incoming changes invalidate stale editor timestamps even within one millisecond', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T00:00:00.000Z') })
  await fixture(async (a, b) => {
    const id = a.store.createDocument(null); edit(a.store, id, 'first')
    await a.sync.sync(); await b.sync.sync()
    const original = b.store.getDocumentDetail(id)!
    edit(a.store, id, 'second'); await a.sync.sync(); await b.sync.sync()
    assert.ok(b.store.getDocumentDetail(id)!.updatedAt > original.updatedAt)
    assert.throws(() => b.store.updateDocument(id, { ...b.store.documentRecovery.readContent(id), expectedUpdatedAt: original.updatedAt }), /草稿仍保留/)
  })
})

test('automatic sync runs on startup and interval, and disabling it stops later uploads', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  await fixture(async (a, b) => {
    const id = a.store.createDocument(null); edit(a.store, id, 'startup')
    a.sync.saveConfig({ ...a.sync.getStatus().config, enabled: true, intervalMinutes: 1 })
    a.sync.start(); await a.sync.waitForIdle(); await b.sync.sync()
    assert.equal(content(b.store, id), 'startup')
    edit(a.store, id, 'interval')
    context.mock.timers.tick(60_000)
    await a.sync.waitForIdle(); await b.sync.sync()
    assert.equal(content(b.store, id), 'interval')
    a.sync.saveConfig({ ...a.sync.getStatus().config, enabled: false })
    edit(a.store, id, 'local only')
    context.mock.timers.tick(60_000)
    await a.sync.waitForIdle(); await b.sync.sync()
    assert.equal(content(b.store, id), 'interval')
  })
})

test('cancelling an in-flight upload preserves the cursor and permits a clean retry', () => fixture(async (a, b, server) => {
  const id = a.store.createDocument(null); edit(a.store, id, 'before cancel')
  await a.sync.sync(); await b.sync.sync()
  const previousSync = a.sync.getStatus().lastSyncAt
  edit(a.store, id, 'after cancel')
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  server.setHook(async req => { if (req.method === 'PUT' && req.url!.includes('/objects/')) { enter(); await gate } })
  const pending = a.sync.sync()
  const rejected = assert.rejects(pending, /停止/)
  try {
    await entered
    await assert.rejects(a.sync.sync(), /正在进行/)
    await a.sync.cancel(); await rejected
    assert.equal(a.sync.getStatus().phase, 'idle')
    assert.equal(a.sync.getStatus().lastSyncAt, previousSync)
    assert.equal(content(b.store, id), 'before cancel')
  } finally { release(); server.setHook(undefined) }
  await a.sync.sync(); await b.sync.sync()
  assert.equal(content(b.store, id), 'after cancel')
}))
