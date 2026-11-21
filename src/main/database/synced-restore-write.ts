import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncDatabases, type SyncRow, type SyncTable } from '../sync/model'
import { publicationCompare, publicationInvalid, publicationJson, type InitialPublicationRecord } from '../sync/synced-publication-model'
import { MarkdownLinkIndex } from './markdown-link-index'
import { syncedLifecycleSemanticHash } from './synced-lifecycle-state'

interface SyncedRestoreWriteInput {
  records: readonly InitialPublicationRecord[]
  documentPaths: ReadonlyMap<string, string>
  reservedIds: readonly string[]
  reservationSourceKey: string
  targetCatalogId: string
}

type Document = Extract<InitialPublicationRecord, { kind: 'document' }>
type Group = Extract<InitialPublicationRecord, { kind: 'synced-group' }>
type RestoreContent = Omit<SyncedRestoreWriteInput, 'records'> & {
  documents: Iterable<Document>
  parentFirstDocuments: Iterable<Document>
  groups: Iterable<Group>
  catalogRows(table: SyncTable): Iterable<SyncRow>
}

/** Write already validated, localized records into an owned transaction.
 * The caller owns source authorization, target admission and final readback. */
export function installSyncedRestoreRecords(db: Database.Database, input: SyncedRestoreWriteInput, now: string): void {
  const documents = input.records.filter(record => record.kind === 'document'), groups = input.records.filter(record => record.kind === 'synced-group')
  const parentFirstDocuments = [...documents].sort((a, b) => input.documentPaths.get(a.id)!.split('/').length
    - input.documentPaths.get(b.id)!.split('/').length || publicationCompare(a.id, b.id))
  const catalog = input.records.find((record): record is SyncDatabases => record.kind === 'databases')!
  installSyncedRestoreContent(db, { ...input, documents, parentFirstDocuments, groups, catalogRows: table => catalog.tables[table] }, now)
}

/** The same writer also accepts replayable portable V3 records. Only host and
 * group identities carry across passes over the scoped body reader. */
export function installSyncedRestoreContent(db: Database.Database, input: RestoreContent, now: string): void {
  if (!db.open || db.readonly || !db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1)
    return publicationInvalid('同步恢复写入要求活动的可写事务及外键保护。')
  const positions = new Map<string, { groupId: string; documentId: string; bindingVersion: string; parentBlockId: string | null; depth: number }>()
  const insertDocument = db.prepare('INSERT INTO documents(id,title,slug,parent_id,path,summary,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
  const insertHostState = db.prepare('INSERT INTO synced_host_history_state(document_id,cursor,position) VALUES(?,?,0)')
  // Validated parent chains are installed in parent-first order; no cycle healer is involved.
  for (const doc of input.parentFirstDocuments) {
    insertDocument.run(doc.id, doc.content.title, 'doc-' + doc.id, doc.parentId, input.documentPaths.get(doc.id), doc.content.summary, doc.sortOrder, doc.createdAt, now)
    insertHostState.run(doc.id, randomUUID())
    for (const block of doc.content.blocks) if (block.type === 'synced-block') positions.set(block.id, {
      groupId: parseSyncedBlockPayload(block.content).groupId, documentId: doc.id, bindingVersion: randomUUID(), parentBlockId: block.parentBlockId, depth: block.depth })
  }
  const insertGroup = db.prepare('INSERT INTO synced_groups(id,creation_id,created_at,origin_json,bindings_json,revision,topology_revision,history_cursor,history_position) VALUES(?,?,?,?,?,?,?,?,0)')
  const insertLife = db.prepare("INSERT INTO synced_group_lifecycle(group_id,creation_id,state,state_version,exposure_state,create_history_id,activation_revision,activation_topology_revision,activation_hash,activation_instances_json,created_at,updated_at) VALUES(?,?,'active',1,'unknown',NULL,?,?,?,?,?,?)")
  const insertCanonical = db.prepare('INSERT INTO synced_group_blocks(id,group_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,list_start,markdown_format_json,highlight,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const byGroup = new Map<string, Array<{ instanceId: string; hostDocumentId: string; bindingVersion: string }>>()
  for (const [id, item] of positions) { const list = byGroup.get(item.groupId) ?? []; list.push({ instanceId: id, hostDocumentId: item.documentId, bindingVersion: item.bindingVersion }); byGroup.set(item.groupId, list) }
  for (const group of input.groups) {
    const revision = randomUUID(), topology = randomUUID()
    insertGroup.run(group.id, group.creationId, group.createdAt, publicationJson(group.origin), publicationJson(group.bindings), revision, topology, randomUUID())
    const instances = (byGroup.get(group.id) ?? []).sort((a, b) => publicationCompare(a.instanceId, b.instanceId))
    insertLife.run(group.id, group.creationId, revision, topology, syncedLifecycleSemanticHash(group), publicationJson(instances), now, now)
    group.blocks.forEach((block, index) => insertCanonical.run(block.id, group.id, block.parentBlockId, index, block.type, block.content,
      block.checked ? 1 : 0, block.depth, block.tags === undefined ? null : publicationJson(block.tags), block.language ?? null, block.listStart ?? null,
      block.markdownFormat === undefined ? null : publicationJson(block.markdownFormat), block.highlight ?? null, block.createdAt))
  }
  const insertBlock = db.prepare('INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,list_start,markdown_format_json,highlight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const insertInstance = db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)')
  const insertRoute = db.prepare('INSERT INTO document_block_routes(document_path,block_id) VALUES(?,?)')
  const ids: string[] = []
  for (const doc of input.documents) {
    ids.push(doc.id)
    doc.content.blocks.forEach((block, index) => insertBlock.run(block.id, doc.id, block.parentBlockId, index, block.type, block.content, block.checked ? 1 : 0,
      block.depth, publicationJson(block.tags ?? []), block.language ?? null, block.listStart ?? null, block.markdownFormat === undefined ? null : publicationJson(block.markdownFormat), block.highlight ?? null, now, now))
    for (const block of doc.content.blocks) {
      insertRoute.run(input.documentPaths.get(doc.id), block.id)
      const item = positions.get(block.id)
      if (item) insertInstance.run(block.id, item.groupId, item.documentId, item.bindingVersion, item.parentBlockId, item.depth)
    }
  }
  const reserve = db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'reserved',?,'retained',NULL)")
  for (const id of input.reservedIds) reserve.run(id, input.reservationSourceKey)
  for (const table of SYNC_TABLES) {
    const columns: readonly string[] = SYNC_TABLE_COLUMNS[table], updated = [...columns, 'updated_at']
    const insert = db.prepare('INSERT INTO ' + table + '(' + updated.join(',') + ') VALUES(' + updated.map(() => '?').join(',') + ')')
    for (const row of input.catalogRows(table)) {
      if (table === 'databases' && row.id === input.targetCatalogId) {
        if (db.prepare('UPDATE databases SET name=?,description=?,updated_at=? WHERE id=? AND created_at=?').run(row.name, row.description, now, row.id, row.created_at).changes !== 1) return publicationInvalid('默认 catalog 原 birth 在提交中已变。')
      } else insert.run(...columns.map(column => row[column]), now)
    }
  }
  const index = new MarkdownLinkIndex(db)
  for (const id of ids) index.syncDocument(id)
  const selectedDocuments = JSON.stringify(ids)
  db.prepare('DELETE FROM links WHERE source_document_id IN (SELECT value FROM json_each(?))').run(selectedDocuments)
  const links = db.prepare(`SELECT DISTINCT source.source_document_id,target.id AS target_id,source.url
    FROM markdown_link_sources source JOIN documents target ON target.path=source.target_path
    WHERE (source.kind IN ('wiki','wiki-heading') OR target.id<>source.source_document_id)
      AND source.source_document_id=?`)
  const insertLink = db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)')
  for (const id of ids) for (const row of links.all(id) as Array<{ source_document_id: string; target_id: string; url: string }>)
    insertLink.run(randomUUID(), row.source_document_id, row.target_id, row.url, now)
  const stats = db.prepare(`SELECT 1 FROM documents d WHERE d.id IN (SELECT value FROM json_each(?)) AND (
    d.block_count<>(SELECT count(*) FROM blocks WHERE document_id=d.id) OR d.link_count<>(SELECT count(*) FROM links WHERE source_document_id=d.id)
    OR d.child_count<>(SELECT count(*) FROM documents WHERE parent_id=d.id)) LIMIT 1`).get(selectedDocuments)
  if (stats) return publicationInvalid('接收 commit 前实际 stats 不完整；不会依赖 Store 重开 repair。')
  if (db.prepare(`SELECT 1 FROM blocks b LEFT JOIN block_search_ids i ON i.block_id=b.id LEFT JOIN block_search s ON s.rowid=i.search_rowid
    WHERE b.document_id IN (SELECT value FROM json_each(?)) AND (i.block_id IS NULL OR s.block_id IS NOT b.id OR s.document_id IS NOT b.document_id OR s.content IS NOT b.content) LIMIT 1`).get(selectedDocuments)
    || db.prepare(`SELECT 1 FROM documents d LEFT JOIN document_search_ids i ON i.document_id=d.id LEFT JOIN document_search s ON s.rowid=i.search_rowid
      WHERE d.id IN (SELECT value FROM json_each(?)) AND (i.document_id IS NULL OR s.document_id IS NOT d.id OR s.title IS NOT d.title OR s.path IS NOT d.path OR s.summary IS NOT d.summary) LIMIT 1`).get(selectedDocuments)) return publicationInvalid('接收 commit 前实际 FTS 闭集缺失。')
}
