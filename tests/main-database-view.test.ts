import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { AttachmentStore } from '../src/main/attachments'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { WebDavSyncService } from '../src/main/sync/service'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../src/shared/webdav-sync'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { parseDatabaseViewPayload, serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version'
import { removeSchema27ForLegacyFixture } from './helpers/schema27-legacy-fixture'
import { parseManifest, type SyncDocument, type SyncDatabases } from '../src/main/sync/model'
import { syncAssetReferences } from '../src/main/sync/assets'
import { createWebDavServer } from './helpers/webdav-server'

async function fixture(run: (a: KnowbookStore, b: KnowbookStore, root: string) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-inline-database-'))
  const a = new KnowbookStore(join(root, 'a.sqlite')), b = new KnowbookStore(join(root, 'b.sqlite'))
  try { await run(a, b, root) } finally { a.destroy(); b.destroy(); rmSync(root, { recursive: true, force: true }) }
}
const catalog = (store: KnowbookStore) => store.getDatabases().find(database => database.kind === 'document-catalog')!
const config = () => createDefaultDatabaseViewConfig('table')
function insert(store: KnowbookStore, databaseId: string, viewId: string | null = null) {
  const id = store.createDocument(null)
  store.updateDocument(id, { title: 'Inline database host', summary: '', blocks: [{ id: 'atom-' + id, type: 'database-view', checked: false, depth: 0,
    content: serializeDatabaseViewPayload({ version: 1, databaseId, viewId, config: { ...config(), query: '[Opaque](file:///private/never-read.md)' } }) }] })
  return id
}

test('embed snapshot reads exact empty/missing sources and never repairs a missing default setting', () => fixture((store) => {
  for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
  const source = catalog(store), custom = store.createDatabase({ name: 'Empty source' }), db = store.getUnsafeDatabaseHandle()
  const detached = store.createDatabaseEntity({ databaseId: source.id, title: 'Detached' })
  const column = store.createDocumentDatabaseColumn({ databaseId: custom.id, name: 'Field', type: 'text' })
  const view = store.createDatabaseSavedView({ databaseId: custom.id, name: 'View', config: config() })
  const before = db.prepare('SELECT total_changes() AS changes').get()
  const snapshot = store.getDatabaseEmbedSnapshot(custom.id)
  assert.equal(snapshot.status, 'ready')
  if (snapshot.status === 'ready') {
    assert.equal(snapshot.database.id, custom.id); assert.deepEqual(snapshot.columns.map(item => item.id), [column.id])
    assert.deepEqual(snapshot.savedViews.map(item => item.id), [view.id]); assert.deepEqual(snapshot.entities, []); assert.deepEqual(snapshot.catalogDocuments, [])
  }
  const defaultSnapshot = store.getDatabaseEmbedSnapshot(source.id)
  assert.equal(defaultSnapshot.status, 'ready')
  if (defaultSnapshot.status === 'ready') {
    assert.deepEqual(defaultSnapshot.entities.map(item => item.id), [detached.id]); assert.deepEqual(defaultSnapshot.catalogDocuments, [])
  }
  assert.deepEqual(store.getDatabaseEmbedSnapshot('missing-source'), { status: 'missing', databaseId: 'missing-source' })
  assert.deepEqual(db.prepare('SELECT total_changes() AS changes').get(), before)
  db.prepare("DELETE FROM app_settings WHERE key='database.defaultId'").run()
  const broken = db.prepare('SELECT total_changes() AS changes').get()
  assert.throws(() => store.getDatabaseEmbedSnapshot(source.id), /默认数据库配置缺失/)
  assert.deepEqual(store.getDatabaseEmbedSnapshot('missing-source'), { status: 'missing', databaseId: 'missing-source' })
  assert.deepEqual(db.prepare('SELECT total_changes() AS changes').get(), broken)
}))

test('embed snapshot distinguishes linked documents and detached entities and rejects corrupt saved view bytes', () => fixture((store) => {
  const source = catalog(store), id = store.createDocument(null)
  const detached = store.createDatabaseEntity({ databaseId: source.id, title: 'Detached' })
  const snapshot = store.getDatabaseEmbedSnapshot(source.id)
  assert.equal(snapshot.status, 'ready')
  if (snapshot.status === 'ready') {
    assert.ok(snapshot.catalogDocuments.some(document => document.id === id))
    assert.ok(!snapshot.catalogDocuments.some(document => document.id === detached.id))
  }
  const view = store.createDatabaseSavedView({ databaseId: source.id, name: 'Corrupt' })
  store.getUnsafeDatabaseHandle().prepare('UPDATE database_saved_views SET config_json=? WHERE id=?').run('{"version":1}', view.id)
  const before = store.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS changes').get()
  assert.throws(() => store.getDatabaseEmbedSnapshot(source.id))
  assert.deepEqual(store.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS changes').get(), before)
}))

test('Store rejects invalid atom shape and ownership before touching document, history, links or workspace records', () => fixture((store) => {
  const id = insert(store, 'deliberately-missing-source'), original = store.getDocumentDetail(id)!, records = store.getSyncRecords()
  for (const extra of [{ checked: true }, { language: 'json' }, { listStart: 1 }, { markdownFormat: {} }, { depth: 1 }, { parentBlockId: 'foreign' }, { content: '{bad}' }]) {
    assert.throws(() => store.updateDocument(id, { title: original.title, summary: original.summary, blocks: [{ ...original.blocks[0], ...extra }] }))
    assert.deepEqual(store.getDocumentDetail(id), original); assert.deepEqual(store.getSyncRecords(), records)
  }
}))

test('document templates clone database host identities while keeping configuration opaque to variable and link expansion', () => fixture((store) => {
  const payload = { version: 1 as const, databaseId: catalog(store).id, viewId: null, config: { ...config(),
    query: '{{title}} {{date}} [[original-view]] [literal](file:///private/{{title}}.md)',
    filters: { operator: 'and' as const, rules: [{ id: 'query-rule', fieldId: '__title__', operator: 'contains' as const, value: '{{title}}' }] } } }
  const content = serializeDatabaseViewPayload(payload)
  const template = store.saveDocumentTemplate({ name: 'Database template', title: 'Template', summary: 'Summary {{title}}', blocks: [
    { id: 'original-owner', type: 'callout', content: 'Owner {{title}}', depth: 0, checked: false },
    { id: 'original-view', type: 'database-view', content, depth: 1, parentBlockId: 'original-owner', checked: false }
  ] })
  const id = store.createDocumentFromTemplate({ templateId: template.id, parentId: null, title: 'Name "quoted"' })
  const result = store.getDocumentDetail(id)!
  assert.equal(result.title, 'Name "quoted"'); assert.equal(result.summary, 'Summary Name "quoted"')
  assert.equal(result.blocks[0].content, 'Owner Name "quoted"')
  assert.equal(result.blocks[1].content, content); assert.deepEqual(parseDatabaseViewPayload(result.blocks[1].content), payload)
  assert.equal(result.blocks[1].parentBlockId, result.blocks[0].id)
  assert.notEqual(result.blocks[0].id, 'original-owner'); assert.notEqual(result.blocks[1].id, 'original-view')
  assert.equal(store.documentRecovery.listHistory(id).length, 0)
  assert.equal(store.listDocumentTemplates().find(item => item.id === template.id)!.blocks[1].content, content)
}))

test('schema24 upgrade first preserves an exact safety copy before the current semantic gate', () => fixture((store, _other, root) => {
  const id = insert(store, 'missing-source'), before = store.getDocumentDetail(id)!
  const path = store.getDatabasePath()
  removeSchema27ForLegacyFixture(store.getUnsafeDatabaseHandle())
  store.getUnsafeDatabaseHandle().pragma('user_version = 24'); store.destroy()
  const reopened = new KnowbookStore(path)
  try {
    assert.equal(reopened.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION)
    assert.equal(CURRENT_DATABASE_SCHEMA_VERSION, 27); assert.deepEqual(reopened.getDocumentDetail(id), before)
    const copies = readdirSync(root).filter(name => name.includes(`pre-migration-v24-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`))
    assert.equal(copies.length, 1)
    const copy = new Database(join(root, copies[0]), { readonly: true })
    try { assert.equal(copy.pragma('user_version', { simple: true }), 24) } finally { copy.close() }
  } finally { reopened.destroy() }
}))

test('two stores map only catalog references across portable snapshots and apply host/source batches in either order', () => fixture((a, b) => {
  for (const store of [a, b]) for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
  const sourceA = catalog(a), sourceB = catalog(b), id = insert(a, sourceA.id)
  const custom = a.createDatabase({ name: 'Custom source' }), customHost = insert(a, custom.id)
  const records = [...a.getSyncRecords().values()]
  const portable = records.find(record => record.kind === 'document' && record.id === id) as SyncDocument
  assert.equal(parseDatabaseViewPayload(portable.content.blocks[0].content).databaseId, 'catalog')
  assert.deepEqual(syncAssetReferences(portable), [])
  b.applySyncRecords(records.reverse())
  assert.equal(parseDatabaseViewPayload(b.getDocumentDetail(id)!.blocks[0].content).databaseId, sourceB.id)
  assert.equal(parseDatabaseViewPayload(b.getDocumentDetail(customHost)!.blocks[0].content).databaseId, custom.id)
  assert.equal(parseDatabaseViewPayload(b.getDocumentDetail(id)!.blocks[0].content).config.query, '[Opaque](file:///private/never-read.md)')
  assert.deepEqual(b.getSyncRecords(), a.getSyncRecords())
  b.applySyncRecords([...a.getSyncRecords().values()])
  assert.deepEqual(b.getSyncRecords(), a.getSyncRecords())
}))

test('reserved catalog wire identity cannot rebind a literal missing or custom source on another installation', () => fixture((a, b) => {
  const id = insert(a, 'catalog'), original = a.getDocumentDetail(id)!, other = b.getSyncRecords()
  assert.notEqual(catalog(a).id, 'catalog')
  assert.throws(() => a.getSyncRecords(), /同步保留/)
  assert.deepEqual(a.getDocumentDetail(id), original); assert.deepEqual(b.getSyncRecords(), other)
  a.deleteDocument(id)
  const custom = a.createDatabase({ name: 'Legacy reserved identity' })
  a.getUnsafeDatabaseHandle().prepare('UPDATE databases SET id=? WHERE id=?').run('catalog', custom.id)
  assert.throws(() => a.getSyncRecords(), /同步保留/)
  assert.deepEqual(b.getSyncRecords(), other)
}))

function persistentState(store: KnowbookStore) {
  const db = store.getUnsafeDatabaseHandle()
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()]))
}

test('direct sync apply rejects dangling raw catalog database_id references before writes while preserving format errors and unrelated row IDs', () => fixture((a, b) => {
  for (const store of [a, b]) for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
  const sourceCatalog = catalog(a), receiverCatalog = catalog(b)
  const column = a.createDocumentDatabaseColumn({ databaseId: sourceCatalog.id, name: 'Source field', type: 'text' })
  // An ordinary column ID may equal a database ID; only its owner is reserved.
  a.getUnsafeDatabaseHandle().prepare('UPDATE document_database_columns SET id=? WHERE id=?').run(receiverCatalog.id, column.id)
  a.createDatabaseSavedView({ databaseId: sourceCatalog.id, name: 'Source view', config: config() })
  a.createDatabaseEntity({ databaseId: sourceCatalog.id, title: 'Source record' })
  const source = a.getSyncRecords().get('databases') as SyncDatabases
  assert.ok(!source.tables.databases.some(row => row.id === receiverCatalog.id))
  const before = persistentState(b)
  for (const table of ['document_database_columns', 'database_saved_views', 'database_entities'] as const) {
    const invalid = structuredClone(source)
    assert.equal(invalid.tables[table][0].database_id, 'catalog')
    invalid.tables[table][0].database_id = receiverCatalog.id
    assert.throws(() => b.applySyncRecords([invalid]), /本机默认数据库.*冲突/)
    assert.deepEqual(persistentState(b), before)
    assert.deepEqual(catalog(b), receiverCatalog)
  }
  const malformed = structuredClone(source)
  malformed.tables.databases = null as unknown as typeof malformed.tables.databases
  assert.throws(() => b.applySyncRecords([malformed]), error => error instanceof Error && !(error instanceof TypeError)
    && /远端文档或数据库格式无效/.test(error.message))
  assert.deepEqual(persistentState(b), before)
  b.applySyncRecords([source])
  assert.ok(b.getDocumentDatabaseColumns(receiverCatalog.id).some(item => item.id === receiverCatalog.id))
  assert.equal(catalog(b).id, receiverCatalog.id); assert.equal(catalog(b).kind, 'document-catalog')
  assert.deepEqual(b.getSyncRecords(), a.getSyncRecords())
}))

for (const sourceKind of ['missing', 'custom'] as const) {
  test(`HTTP sync rejects a ${sourceKind} source colliding with the receiving catalog UUID before publication or apply, then safely retries`, () => fixture(async (a, b, root) => {
    for (const store of [a, b]) for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
    const server = await createWebDavServer(), services: WebDavSyncService[] = []
    const service = (store: KnowbookStore, name: string) => {
      const sync = new WebDavSyncService(store, new AttachmentStore(join(root, name)), createEphemeralCredentialStorage(randomUUID))
      sync.saveConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, url: server.url, username: 'test', password: 'app-secret', allowInsecureHttp: true })
      services.push(sync); return sync
    }
    const first = service(a, 'collision-assets-a'), second = service(b, 'collision-assets-b')
    try {
      const shared = a.createDocument(null)
      await first.sync(); await second.sync()
      const receiverCatalog = catalog(b), collisionId = receiverCatalog.id
      assert.notEqual(collisionId, 'catalog'); assert.notEqual(catalog(a).id, collisionId)
      if (sourceKind === 'custom') {
        const custom = a.createDatabase({ name: 'Independent custom source' })
        // Imported identities can coincide with another installation's implicit catalog.
        a.getUnsafeDatabaseHandle().prepare('UPDATE databases SET id=? WHERE id=?').run(collisionId, custom.id)
        a.createDocumentDatabaseColumn({ databaseId: collisionId, name: 'Custom field', type: 'text' })
        a.createDatabaseEntity({ databaseId: collisionId, title: 'Custom record' })
      }
      const host = insert(a, collisionId)
      assert.equal(a.getDatabaseEmbedSnapshot(collisionId).status, sourceKind === 'missing' ? 'missing' : 'ready')
      await first.sync()
      const records = [...a.getSyncRecords().values()]
      const wireHost = records.find(record => record.kind === 'document' && record.id === host) as SyncDocument
      assert.equal(parseDatabaseViewPayload(wireHost.content.blocks[0].content).databaseId, collisionId)
      const local = b.getDocumentDetail(shared)!
      b.updateDocument(shared, { title: local.title, summary: local.summary, blocks: local.blocks.map(block => ({ ...block, content: 'Independent local edit to publish' })) })
      const beforeA = persistentState(a), beforeB = persistentState(b), manifest = Buffer.from(server.files.get('/KnowBook/manifest.json')!)
      const lastSyncAt = second.getStatus().lastSyncAt
      assert.ok(lastSyncAt)

      for (let attempt = 0; attempt < 2; attempt++) {
        let failure: unknown
        try { await second.sync() } catch (error) { failure = error }
        const received = b.getDocumentDetail(host)
        const rebound = received && parseDatabaseViewPayload(received.blocks[0].content).databaseId
        assert.ok(failure instanceof Error, `Must reject before binding the missing/custom source; received databaseId=${rebound}, snapshot=${b.getDatabaseEmbedSnapshot(collisionId).status}`)
        assert.match(failure.message, /本机默认数据库.*冲突/)
        assert.deepEqual(persistentState(a), beforeA)
        assert.deepEqual(persistentState(b), beforeB)
        assert.equal(second.getStatus().lastSyncAt, lastSyncAt)
        assert.deepEqual(server.files.get('/KnowBook/manifest.json'), manifest)
        assert.deepEqual(catalog(b), receiverCatalog)
      }

      // The direct batch path must also reject before a host can bind, or a
      // custom source definition can replace/collide with the implicit catalog.
      assert.throws(() => b.applySyncRecords(records), /本机默认数据库.*冲突/)
      assert.deepEqual(persistentState(b), beforeB)

      let repairedSource: string
      if (sourceKind === 'custom') {
        a.deleteDatabase(collisionId)
        repairedSource = a.createDatabase({ name: 'Reimported custom source' }).id
      } else repairedSource = catalog(a).id
      const original = a.getDocumentDetail(host)!, payload = parseDatabaseViewPayload(original.blocks[0].content)
      a.updateDocument(host, { title: original.title, summary: original.summary, blocks: [{ ...original.blocks[0],
        content: serializeDatabaseViewPayload({ ...payload, databaseId: repairedSource }) }] })
      const legalCatalogHost = insert(a, catalog(a).id)
      await first.sync(); await second.sync(); await first.sync()
      const expectedSource = sourceKind === 'custom' ? repairedSource : collisionId
      assert.equal(parseDatabaseViewPayload(b.getDocumentDetail(host)!.blocks[0].content).databaseId, expectedSource)
      assert.equal(b.getDatabaseEmbedSnapshot(expectedSource).status, 'ready')
      assert.equal(parseDatabaseViewPayload(b.getDocumentDetail(legalCatalogHost)!.blocks[0].content).databaseId, collisionId)
      assert.equal(catalog(b).id, receiverCatalog.id); assert.equal(catalog(b).kind, 'document-catalog')
      assert.equal(a.getDocumentDetail(shared)!.blocks[0].content, 'Independent local edit to publish')
      assert.deepEqual(b.getSyncRecords(), a.getSyncRecords())
      assert.equal(second.getStatus().conflicts.length, 0)
    } finally { for (const sync of services) await sync.stop(); await server.close() }
  }))
}

test('HTTP synchronization publishes protocol4 atom and complete source together and never downgrades after columns/plain edits', () => fixture(async (a, b, root) => {
  for (const store of [a, b]) for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
  const server = await createWebDavServer(), services: WebDavSyncService[] = []
  const service = (store: KnowbookStore, name: string) => {
    const sync = new WebDavSyncService(store, new AttachmentStore(join(root, name)), createEphemeralCredentialStorage(randomUUID))
    sync.saveConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, url: server.url, username: 'test', password: 'app-secret', allowInsecureHttp: true })
    services.push(sync); return sync
  }
  const first = service(a, 'assets-a'), second = service(b, 'assets-b')
  try {
    const source = a.createDatabase({ name: 'Shared source' }), column = a.createDocumentDatabaseColumn({ databaseId: source.id, name: 'Status', type: 'text' })
    const view = a.createDatabaseSavedView({ databaseId: source.id, name: 'Saved', config: config() })
    const entity = a.createDatabaseEntity({ databaseId: source.id, title: 'Record', fieldValues: { [column.id]: 'Initial' } })
    const id = insert(a, source.id, view.id), defaultHost = insert(a, catalog(a).id)
    await first.sync(); await second.sync()
    assert.equal(parseManifest(server.files.get('/KnowBook/manifest.json')!).version, 4)
    const snapshot = b.getDatabaseEmbedSnapshot(source.id); assert.equal(snapshot.status, 'ready')
    if (snapshot.status === 'ready') {
      assert.deepEqual(snapshot.entities.map(item => item.id), [entity.id]); assert.equal(snapshot.savedViews[0].id, view.id)
    }
    assert.equal(parseDatabaseViewPayload(b.getDocumentDetail(defaultHost)!.blocks[0].content).databaseId, catalog(b).id)
    assert.equal(first.getStatus().conflicts.length, 0); assert.equal(second.getStatus().conflicts.length, 0)
    a.updateDocument(id, { title: 'Inline database host', summary: '', blocks: [
      { id: 'layout-after-atom', type: 'columns', content: '', checked: false, depth: 0 },
      { id: 'single-column', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'layout-after-atom', markdownFormat: { columnWeight: 10000 } }
    ] })
    await first.sync(); await second.sync(); assert.equal(parseManifest(server.files.get('/KnowBook/manifest.json')!).version, 4)
    a.updateDocument(id, { title: 'Inline database host', summary: '', blocks: [{ id: 'plain-after-atom', type: 'paragraph', content: 'Plain', checked: false, depth: 0 }] })
    await first.sync(); await second.sync(); assert.equal(parseManifest(server.files.get('/KnowBook/manifest.json')!).version, 4)
    assert.equal(b.getDocumentDetail(id)!.blocks[0].content, 'Plain')
  } finally { for (const sync of services) await sync.stop(); await server.close() }
}))
