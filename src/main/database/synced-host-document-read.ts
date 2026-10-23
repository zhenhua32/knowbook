import type Database from 'better-sqlite3'
import type { DocumentDetail, DocumentChild, LinkedDocument } from '../../shared/contracts'
import type { SyncedHostWorkingBefore } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, SyncedValidationError, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'

export type HostContent = SyncedHostWorkingBefore['workingBefore']
export interface StrictHostDocument {
  detail: DocumentDetail; content: HostContent; createdAt: string; parentId: string | null; sortOrder: number
  births: Map<string, string>
}
const bad = (): never => { throw new SyncedValidationError('forest', '宿主原始存储或完整文档回执无效；不会修复正文。') }
const string = (value: unknown): string => typeof value === 'string' ? value : bad()
const id = (value: unknown): string => isSyncedBlockId(value) ? value : bad()
export const hostTime = (value: unknown): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : bad()
export const hostJson = (source: string): unknown => parseStrictJson(source, { maxBytes: Math.max(1, Buffer.byteLength(source)), maxDepth: 32 })
function array<T>(value: unknown, read: (item: unknown) => T): T[] { return Array.isArray(value) ? value.map(read) : bad() }

/** Complete closed DTO codec, also used for the immutable operation ACK. */
export function validateHostDocumentDetail(value: unknown): DocumentDetail {
  assertSyncedShape(value, ['id', 'title', 'path', 'summary', 'updatedAt', 'blocks', 'children', 'outgoingLinks', 'backlinks'])
  const blocks = array(value.blocks, raw => {
    assertSyncedShape(raw, ['id', 'type', 'content', 'checked', 'depth', 'parentBlockId', 'sortOrder'],
      ['tags', 'language', 'listStart', 'markdownFormat', 'highlight'])
    if (!Number.isSafeInteger(raw.sortOrder) || (raw.sortOrder as number) < 0) return bad()
    const { sortOrder, ...block } = raw
    return { block, sortOrder: sortOrder as number }
  })
  // Individual child rows are decoded below as one real forest, including depth/parent roles.
  const forest = validateSyncedHostForest(blocks.map(row => row.block))
  if (blocks.some((block, index) => index > 0 && block.sortOrder <= blocks[index - 1].sortOrder)) return bad()
  const children = array<DocumentChild>(value.children, raw => {
    assertSyncedShape(raw, ['id', 'title', 'path']); return { id: id(raw.id), title: string(raw.title), path: string(raw.path) }
  })
  if (new Set(children.map(child => child.id)).size !== children.length) return bad()
  const links = (input: unknown): LinkedDocument[] => array(input, raw => {
    assertSyncedShape(raw, ['id', 'title', 'path', 'label'], ['contextSnippet'])
    return { id: id(raw.id), title: string(raw.title), path: string(raw.path), label: string(raw.label),
      ...(raw.contextSnippet === undefined ? {} : { contextSnippet: string(raw.contextSnippet) }) }
  })
  return { id: id(value.id), title: string(value.title), path: string(value.path), summary: string(value.summary), updatedAt: hostTime(value.updatedAt),
    blocks: forest.map((block, index) => ({ ...block, sortOrder: blocks[index].sortOrder })), children,
    outgoingLinks: links(value.outgoingLinks), backlinks: links(value.backlinks) }
}

/** Original connection only. No Store, healing, normalization, DML or clamped depth. */
export function readStrictHostDocument(db: Database.Database, documentId: string): StrictHostDocument | null {
  return readHostDocument(db, documentId, false)
}

/** The ordinary sync writer accepts every safe signed document sortOrder.
 * Preserve those actual SQL values when observing a recovery source, without
 * widening the live host-operation/ACK reader or changing block-order rules.
 * This data-only leaf grants no source certification or installation right. */
export function readRawCapsule2HostDocumentOwned(db: Database.Database, documentId: string): StrictHostDocument | null {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return bad()
  return readHostDocument(db, documentId, true)
}

function readHostDocument(db: Database.Database, documentId: string, signedDocumentOrder: boolean): StrictHostDocument | null {
  const document = db.prepare('SELECT id,title,path,summary,updated_at,created_at,parent_id,sort_order FROM documents WHERE id=?')
    .get(documentId) as { id: string; title: string; path: string; summary: string; updated_at: string; created_at: string; parent_id: string | null; sort_order: number } | undefined
  if (!document) return null
  if (document.id !== documentId || document.parent_id !== null && !isSyncedBlockId(document.parent_id)
    || !Number.isSafeInteger(document.sort_order) || !signedDocumentOrder && document.sort_order < 0) return bad()
  const rows = db.prepare(`SELECT b.*,i.last_owner_kind AS identity_kind,i.last_owner_id AS identity_owner,
    i.state AS identity_state,i.created_at AS identity_created_at,
    EXISTS(SELECT 1 FROM synced_group_blocks c WHERE c.id=b.id) AS canonical_collision
    FROM blocks b LEFT JOIN block_identities i ON i.id=b.id WHERE b.document_id=? ORDER BY b.sort_order,b.id`).all(documentId) as Array<{
      id: string; type: string; content: string; checked: number; depth: number; parent_block_id: string | null; sort_order: number
      tags_json: string; language: string | null; list_start: number | null; markdown_format_json: string | null; highlight: string | null
      created_at: string; identity_kind: string | null; identity_owner: string | null; identity_state: string | null; identity_created_at: string | null; canonical_collision: number
    }>
  const births = new Map<string, string>()
  const blocks = rows.map(row => {
    if (row.identity_kind !== 'document' || row.identity_owner !== documentId || row.identity_state !== 'live'
      || row.identity_created_at !== row.created_at || row.canonical_collision || row.checked !== 0 && row.checked !== 1) return bad()
    births.set(row.id, hostTime(row.created_at))
    return { id: row.id, type: row.type, content: row.content, checked: row.checked === 1, depth: row.depth,
      parentBlockId: row.parent_block_id, sortOrder: row.sort_order, tags: hostJson(row.tags_json),
      ...(row.language === null ? {} : { language: row.language }), ...(row.list_start === null ? {} : { listStart: row.list_start }),
      ...(row.markdown_format_json === null ? {} : { markdownFormat: hostJson(row.markdown_format_json) }),
      ...(row.highlight === null ? {} : { highlight: row.highlight }) }
  })
  if (db.prepare(`SELECT 1 FROM block_identities i WHERE i.last_owner_kind='document' AND i.last_owner_id=? AND i.state='live'
    AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.id=i.id AND b.document_id=i.last_owner_id) LIMIT 1`).get(documentId)) return bad()
  const outgoingLinks = db.prepare(`SELECT target.id,target.title,target.path,links.label FROM links
    INNER JOIN documents target ON target.id=links.target_document_id WHERE links.source_document_id=? ORDER BY target.path,links.label`).all(documentId)
  const backlinks = (db.prepare(`SELECT source.id,source.title,source.path,links.label,SUBSTR(b.content,1,200) AS context_snippet
    FROM links INNER JOIN documents source ON source.id=links.source_document_id
    LEFT JOIN blocks b ON b.document_id=links.source_document_id AND b.content LIKE '%' || links.label || '%'
    WHERE links.target_document_id=? GROUP BY source.id ORDER BY source.path`).all(documentId) as Array<{
      id: string; title: string; path: string; label: string; context_snippet: string | null
    }>).map(row => ({ id: row.id, title: row.title, path: row.path, label: row.label,
      ...(row.context_snippet === null ? {} : { contextSnippet: row.context_snippet }) }))
  const children = db.prepare('SELECT id,title,path FROM documents WHERE parent_id=? ORDER BY path').all(documentId)
  const detail = validateHostDocumentDetail({ id: document.id, title: document.title, path: document.path, summary: document.summary,
    updatedAt: document.updated_at, blocks, children, outgoingLinks, backlinks })
  const content: HostContent = { title: detail.title, summary: detail.summary, blocks: detail.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) }
  return { detail, content, createdAt: hostTime(document.created_at), parentId: document.parent_id, sortOrder: document.sort_order, births }
}
