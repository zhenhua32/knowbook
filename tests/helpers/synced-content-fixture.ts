import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { appSchema } from '../../src/main/database/schema'
import { installSyncedBlockSchema } from '../../src/main/database/synced-schema'
import { getSyncedGroupSnapshots } from '../../src/main/database/synced-blocks-read'
import type { SyncedCanonicalEdit, SyncedCanonicalWire, SyncedGroupMutationResult, SyncedGroupSaved, SyncedGroupSnapshot,
  SyncedLinkBinding, SyncedRestoreGroupInput, SyncedUpdateGroupInput } from '../../src/shared/synced-blocks'

export const born = '2020-01-02T03:04:05+08:00', now = '2026-10-16T00:00:00.000Z'
export const uuid = (value: number): string => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`
export const host = ' 宿主:__proto__ ', other = 'other', groupId = uuid(10), instanceId = uuid(100)
export const paragraph = (id = ' old:正文\0 ', content = 'A'): SyncedCanonicalWire => ({
  id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, createdAt: born
})
export const edits = (blocks: readonly SyncedCanonicalWire[]): SyncedCanonicalEdit[] => blocks.map(({ createdAt: _createdAt, ...block }) => block)
export function createGroup(db: Database.Database, id: string, blocks: SyncedCanonicalWire[] = [paragraph()], bindings: SyncedLinkBinding[] = []): void {
  db.prepare(`INSERT INTO synced_groups(id,creation_id,created_at,origin_json,bindings_json,revision,topology_revision,history_cursor,history_position)
    VALUES(?,?,?,?,?,?,?,?,0)`).run(id, randomUUID(), born,
    JSON.stringify({ version: 1, documentId: host, pathAtCreation: 'Original/Host', firstInstanceId: id === groupId ? instanceId : randomUUID() }),
    JSON.stringify(bindings), randomUUID(), randomUUID(), randomUUID())
  const insert = db.prepare(`INSERT INTO synced_group_blocks(id,group_id,parent_block_id,sort_order,type,content,checked,depth,
    tags_json,language,list_start,markdown_format_json,highlight,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  blocks.forEach((block, index) => insert.run(block.id, id, block.parentBlockId, index, block.type, block.content, block.checked ? 1 : 0,
    block.depth, block.tags === undefined ? null : JSON.stringify(block.tags), block.language ?? null, block.listStart ?? null,
    block.markdownFormat === undefined ? null : JSON.stringify(block.markdownFormat), block.highlight ?? null, block.createdAt))
}
export function ordinary(db: Database.Database, id: string, options: { owner?: string; parent?: string; depth?: number; sort?: number; type?: string } = {}): void {
  db.prepare(`INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,created_at,updated_at)
    VALUES(?,?,?,?,?,'Parent',0,?,?,?)`).run(id, options.owner ?? host, options.parent ?? null, options.sort ?? 0,
    options.type ?? 'toggle', options.depth ?? 0, born, now)
}
export function addInstance(db: Database.Database, id: string, source = groupId,
  options: { owner?: string; parent?: string; depth?: number; sort?: number } = {}): void {
  const owner = options.owner ?? host, parent = options.parent ?? null, depth = options.depth ?? (parent === null ? 0 : 1)
  const sort = options.sort ?? (db.prepare('SELECT coalesce(max(sort_order),-1)+1 AS next FROM blocks WHERE document_id=?')
    .get(owner) as { next: number }).next
  db.prepare(`INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,created_at,updated_at)
    VALUES(?,?,?,?,'synced-block',?,0,?,?,?)`).run(id, owner, parent, sort, JSON.stringify({ version: 1, groupId: source }), depth, born, now)
  db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)')
    .run(id, source, owner, randomUUID(), parent, depth)
}
export function initialize(db: Database.Database): void {
  db.pragma('foreign_keys=ON')
  db.exec(appSchema)
  db.exec('ALTER TABLE blocks ADD COLUMN list_start INTEGER; ALTER TABLE blocks ADD COLUMN markdown_format_json TEXT;')
  for (const id of [host, other]) db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, id, id, born, now)
  db.transaction(() => installSyncedBlockSchema(db, { workspaceScope: uuid(900), recoveryEpoch: uuid(901), now }))()
  createGroup(db, groupId)
  addInstance(db, instanceId)
}
export function withDatabase(run: (db: Database.Database) => void): void {
  const db = new Database(':memory:')
  try { initialize(db); run(db) } finally { db.close() }
}
export function withTwoClients(run: (a: Database.Database, b: Database.Database) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-synced-content-')), file = join(root, 'isolated.db')
  const a = new Database(file)
  let b: Database.Database | undefined
  try {
    initialize(a); a.pragma('journal_mode=WAL')
    b = new Database(file); b.pragma('foreign_keys=ON')
    run(a, b)
  } finally {
    b?.close(); a.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-synced-content-'))
    rmSync(root, { recursive: true, force: true })
  }
}
export function snapshot(db: Database.Database, id = groupId): SyncedGroupSnapshot {
  const item = getSyncedGroupSnapshots(db, { groupIds: [id] }).items[0]
  assert.ok(item.status === 'ready')
  return item.snapshot
}
export function update(db: Database.Database, blocks?: SyncedCanonicalEdit[], operationId: string = randomUUID()): SyncedUpdateGroupInput {
  const before = snapshot(db), instance = before.instances[0]
  assert.ok(instance)
  return { groupId, expectedRevision: before.revision, expectedTopologyRevision: before.topologyRevision,
    expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
    clientOperationId: operationId, blocks: blocks ?? edits(before.blocks) }
}
export function restore(db: Database.Database, direction: 'undo' | 'redo', operationId: string = randomUUID()): SyncedRestoreGroupInput {
  const before = snapshot(db), token = direction === 'undo' ? before.history.undoToken : before.history.redoToken
  assert.ok(token)
  const { blocks: _blocks, ...base } = update(db, undefined, operationId)
  return { ...base, expectedHistoryCursor: before.history.cursor, historyToken: token, direction }
}
export function saved(result: SyncedGroupMutationResult): SyncedGroupSaved {
  assert.ok('snapshot' in result, JSON.stringify(result))
  return result
}
export function state(db: Database.Database): Record<string, unknown> {
  return Object.fromEntries(['documents', 'blocks', 'document_history', 'document_trash', 'document_block_routes', 'document_block_moves',
    'markdown_link_sources', 'links', 'app_settings', 'block_identities', 'synced_workspace_state', 'synced_groups', 'synced_group_blocks',
    'synced_instances', 'synced_operations', 'synced_group_history', 'synced_host_history', 'synced_host_history_documents',
    'synced_host_history_state', 'synced_group_pins'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}
