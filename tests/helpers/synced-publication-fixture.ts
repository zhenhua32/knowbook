import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AttachmentStore } from '../../src/main/attachments'
import { appSchema } from '../../src/main/database/schema'
import { installSyncedBlockSchema } from '../../src/main/database/synced-schema'
import { installSyncedLifecycleSchema } from '../../src/main/database/synced-lifecycle-schema'
import { createDefaultDatabaseViewConfig } from '../../src/shared/database-workspace'
import { canonicalSyncedPortableJson } from '../../src/shared/syncedBlockPortable'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../../src/shared/webdav-sync'
import { normalizeWebDavConfig, WebDavClient } from '../../src/main/sync/webdav-client'
import { initialize, ordinary, createGroup, paragraph, uuid } from './synced-content-fixture'
import { a, b, c, bodyId, born, now, secondGroup } from './synced-host-final-fixture'
import { createPublicationHttpServer, publicationGate } from './synced-publication-http-fixture'
import { prepareInitialSyncedPublication, publishInitialSyncedPublication, queryInitialSyncedPublication,
  recoverInitialSyncedPublication, disposePreparedSyncedPublication, readPreparedSyncedPublication,
  readSyncedPublishedSnapshot, readSyncedPublishedSnapshotFacts, SyncedPublicationError } from '../../src/main/sync/synced-publication'

export * from './synced-host-command-create-fixture'
export { uuid, createGroup, paragraph, ordinary, publicationGate, createDefaultDatabaseViewConfig,
  prepareInitialSyncedPublication, publishInitialSyncedPublication, queryInitialSyncedPublication,
  recoverInitialSyncedPublication, disposePreparedSyncedPublication, readPreparedSyncedPublication,
  readSyncedPublishedSnapshot, readSyncedPublishedSnapshotFacts, SyncedPublicationError }
export const encode = canonicalSyncedPortableJson
export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const catalogId = uuid(700), customId = uuid(701), catalogColumn = uuid(702), customColumn = uuid(703), savedViewId = uuid(704), entityId = uuid(705)
export type Prepared = Extract<Awaited<ReturnType<typeof prepareInitialSyncedPublication>>, { status: 'prepared' }>['prepared']
export const runtime = { password: 'app-secret' }

function seedCatalog(db: Database.Database) {
  const insert = db.prepare('INSERT INTO databases(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)')
  insert.run(catalogId, 'Document catalog', 'Real source catalog', born, now); insert.run(customId, 'Custom data', 'Do not rewrite catalog text', born, now)
  db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('database.defaultId', catalogId, now)
  const column = db.prepare('INSERT INTO document_database_columns(id,database_id,name,type,options_json,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  column.run(catalogColumn, catalogId, 'Catalog field', 'text', '[]', 0, born, now); column.run(customColumn, customId, 'Custom field', 'text', '[]', 0, born, now)
  const config = createDefaultDatabaseViewConfig('table', [customColumn]); config.query = 'literal catalog target and file:///not-an-asset'
  db.prepare('INSERT INTO database_saved_views(id,database_id,name,config_json,config_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(savedViewId, customId, 'Actual custom saved view', encode(config), 1, born, now)
  db.prepare('INSERT INTO database_entities(id,database_id,title,document_id,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(entityId, customId, 'Actual orphan entity', null, born, now)
  db.prepare('INSERT INTO database_entity_values(entity_id,column_id,value_text,updated_at) VALUES(?,?,?,?)').run(entityId, customColumn, 'literal catalog', now)
  db.prepare('INSERT INTO document_database_values(document_id,column_id,value_text,updated_at,entity_id) VALUES(?,?,?,?,?)').run(a, catalogColumn, 'Original catalog value', now, null)
}
function seedDatabase(file: string) {
  mkdirSync(dirname(file), { recursive: true }); const db = new Database(file)
  initialize(db)
  db.prepare('UPDATE documents SET title=?,path=?,summary=? WHERE id=?').run('Host A', 'Home/Host A', '', a)
  db.prepare('UPDATE documents SET title=?,path=?,summary=? WHERE id=?').run('Host B', 'Home/Host B', '', b)
  db.prepare('INSERT INTO documents(id,title,slug,path,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(c, 'Host C', 'host-c', 'Home/Host C', '', born, now)
  for (const id of [a, b, c]) { ordinary(db, bodyId(id), { owner: id, type: 'paragraph', sort: id === a ? 1 : 0 }); db.prepare('UPDATE blocks SET content=?,tags_json=? WHERE id=?').run('Original ' + id, '[]', bodyId(id)) }
  db.prepare("UPDATE blocks SET tags_json='[]' WHERE type='synced-block'").run()
  createGroup(db, secondGroup, [paragraph(' orphan:publication-child\0 ', 'Actual orphan canonical')])
  seedCatalog(db)
  db.pragma('user_version=26'); db.transaction(() => { installSyncedLifecycleSchema(db, now); db.pragma('user_version=27') })()
  db.pragma('journal_mode=WAL')
  return db
}
function seedEmptyDatabase(file: string, version: 26 | 27) {
  mkdirSync(dirname(file), { recursive: true }); const db = new Database(file)
  db.pragma('foreign_keys=ON'); db.exec(appSchema)
  db.exec('ALTER TABLE blocks ADD COLUMN list_start INTEGER; ALTER TABLE blocks ADD COLUMN markdown_format_json TEXT;')
  db.transaction(() => installSyncedBlockSchema(db, { workspaceScope: uuid(900), recoveryEpoch: uuid(901), now }))()
  db.prepare('INSERT INTO documents(id,title,slug,path,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(a, 'Host A', 'host-a', 'Home/Host A', '', born, now)
  ordinary(db, bodyId(a), { owner: a, type: 'paragraph' }); seedCatalog(db)
  db.pragma('user_version=26')
  if (version === 27) db.transaction(() => { installSyncedLifecycleSchema(db, now); db.pragma('user_version=27') })()
  return db
}

/** An await-safe replacement fixture. Existing synchronous helpers remain raw. */
export async function withPublicationFixture(run: (fixture: Awaited<ReturnType<typeof makePublicationFixture>>) => Promise<void>) {
  const fixture = await makePublicationFixture()
  try { await run(fixture); fixture.server.assertNoHookErrors() } finally { await fixture.close() }
}
async function makePublicationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-publication-')), userDataRoot = join(root, 'profile')
  const file = join(userDataRoot, 'storage', 'knowbook.db'), db = seedDatabase(file), connections: Database.Database[] = []
  const assets = new AttachmentStore(join(userDataRoot, 'storage', 'assets')), server = await createPublicationHttpServer()
  const target = normalizeWebDavConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, enabled: true, url: server.url, username: 'test', directory: 'Publication', allowInsecureHttp: true })
  const gates: Array<ReturnType<typeof publicationGate>> = []
  const pending = new Set<Promise<unknown>>()
  return { root, userDataRoot, file, db, assets, server, target,
    variant: (version: 26 | 27) => { const userDataRoot = join(root, 'variant-' + version + '-' + randomUUID()), file = join(userDataRoot, 'storage', 'knowbook.db'), db = seedEmptyDatabase(file, version); connections.push(db); return { db, file, userDataRoot, assets: new AttachmentStore(join(userDataRoot, 'storage', 'assets')), input: (attemptId = randomUUID()) => ({ attemptId, userDataRoot, target }) } },
    connect: () => { const next = new Database(file); next.pragma('foreign_keys=ON'); connections.push(next); return next },
    connectReadOnly: () => { const next = new Database(file, { readonly: true, fileMustExist: true }); next.pragma('foreign_keys=ON'); connections.push(next); return next },
    gate: () => { const gate = publicationGate(); gates.push(gate); return gate },
    track: <T>(promise: Promise<T>): Promise<T> => { pending.add(promise); void promise.catch(() => {}); return promise },
    client: () => new WebDavClient(target, runtime.password),
    input: (attemptId = randomUUID()) => ({ attemptId, userDataRoot, target }),
    spool: (attemptId: string) => join(userDataRoot, 'storage', 'synced-publications-v1', attemptId),
    close: async () => { gates.forEach(gate => gate.release()); await Promise.allSettled([...pending]); await server.close(); for (const next of connections) if (next.open) next.close(); if (db.open) db.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('knowbook-publication-'), 'Only the isolated publication fixture directory is removed'); rmSync(root, { recursive: true, force: true }) } }
}
export async function prepared(db: Database.Database, input: Parameters<typeof prepareInitialSyncedPublication>[1]): Promise<Prepared> {
  const result = await prepareInitialSyncedPublication(db, input)
  assert.ok(result.status === 'prepared', 'A real complete supported SQLite snapshot becomes a Main-owned prepared handle')
  if (result.status !== 'prepared') throw new Error('An actual prepared publication is required')
  return result.prepared
}
export function facts(handle: Prepared) {
  const value = readPreparedSyncedPublication(handle)
  assert.ok(value, 'An actual live publication handle exposes immutable diagnostic facts'); return value
}
export async function remote(client: WebDavClient) {
  const result = await readSyncedPublishedSnapshot(client)
  assert.ok(result.status === 'ready', 'The actual HTTP bytes pass the real strict initial-snapshot reader')
  if (result.status !== 'ready') throw new Error('An actual ready remote snapshot is required')
  const value = readSyncedPublishedSnapshotFacts(result.plan)
  assert.ok(value, 'A genuine remote read plan has complete read-only diagnostic facts'); return { plan: result.plan, facts: value }
}
export async function rejectedCode(run: () => unknown | Promise<unknown>, code: 'invalid' | 'unsupported' | 'unavailable' | 'asset' | 'spool' | 'transport' | 'database') {
  let caught: unknown
  try { await run() } catch (error) { caught = error }
  assert.ok(caught instanceof SyncedPublicationError, 'A rejected publication uses the finite Main publication error type')
  assert.equal(caught.code, code); return caught
}
export function spoolState(folder: string) { return JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8')) as { descriptor: ReturnType<typeof facts>['descriptor']; publicationHash: string; requestHash: string } }
export const contentRequests = (requests: Array<{ method: string; path: string }>) => requests.filter(request => request.method !== 'MKCOL' && /\/(?:assets\/[a-f0-9]{64}|objects\/(?:[a-f0-9]{64}\.json|\.pending-[^/]+\.json))$/.test(request.path) || (request.method === 'PUT' || request.method === 'MOVE') && request.path.endsWith('/manifest.json'))
export const publicationRows = (db: Database.Database) => ({ attempts: db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all(), members: db.prepare('SELECT * FROM synced_group_exposure_members ORDER BY attempt_id,group_id').all() })
