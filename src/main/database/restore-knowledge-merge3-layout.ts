import Database from 'better-sqlite3'
import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_VALUE_BYTES } from './restore-knowledge-capsule2-raw-model'
import { hashBoundedCapsuleJson } from './restore-knowledge-capsule-json-hash'
import { findGraph3OriginalRow, graph3Conflict, graph3Encode, graph3Value, type Graph3Inputs } from './restore-knowledge-graph3-data'
import type { RawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { assertMerge3JsonBudget, type MergedRow3 } from './restore-knowledge-merge3-storage'
import { materializeNavigation3Tables, navigation3TableHashInput, withStoredNavigation3TableScan,
  type Navigation3TableSource } from './restore-knowledge-navigation3-tables'

type Table = Navigation3TableSource
export interface Merge3LayoutConflict {
  readonly code: string; readonly table: 'documents'; readonly rowKeys: readonly string[]; readonly detail: unknown
}
type Change = { rowKey: string; targetDocumentId: string; column: string; before: RawRestoreSqlCell; after: RawRestoreSqlCell; reason: string }
const text = (value: unknown): string => typeof value === 'string' ? value : graph3Conflict('merge-layout-text', typeof value)
// An unsigned big-endian BLOB compares exactly like JavaScript UTF-16 code units,
// and preserves embedded NULs in stable IDs and slugs.
const sortKey = (value: string) => Buffer.from(value, 'utf16le').swap16()
const fromKey = (value: Buffer) => value.swap16().toString('utf16le')
function readColumn(table: Pick<Table, 'columns' | 'encoding'>, name: string) {
  const index = table.columns.indexOf(name)
  return (row: Pick<MergedRow3, 'cells'>) => index < 0 ? undefined : graph3Value(row.cells[index], table.encoding)
}

function layoutForest(db: Database.Database, documents: Table, blocks: Table, conflicts: Merge3LayoutConflict[]) {
  db.exec(`CREATE TEMP TABLE layout_document (ordinal INTEGER PRIMARY KEY, id BLOB NOT NULL UNIQUE,
    parent BLOB, title BLOB, path BLOB, path_bytes INTEGER, slug BLOB);
    CREATE INDEX temp.layout_parent ON layout_document(parent,id);
    CREATE TEMP TABLE layout_block_count (owner BLOB PRIMARY KEY, count INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TEMP TABLE layout_queue (position INTEGER PRIMARY KEY, ordinal INTEGER NOT NULL);`)
  db.pragma('temp.cache_size=-2048')
  const insert = db.prepare('INSERT OR IGNORE INTO layout_document(ordinal,id) VALUES(?,?)')
  const readId = readColumn(documents, 'id'), readParent = readColumn(documents, 'parent_id'), readTitle = readColumn(documents, 'title')
  for (const [ordinal, row] of documents.rows.entries()) {
    if (insert.run(ordinal, sortKey(text(readId(row)))).changes !== 1) return graph3Conflict('merge-layout-duplicate-document-id', null)
  }
  const addBlock = db.prepare(`INSERT INTO layout_block_count VALUES(?,1)
    ON CONFLICT(owner) DO UPDATE SET count=count+1`)
  const readBlockOwner = readColumn(blocks, 'document_id')
  for (const row of blocks.rows) addBlock.run(sortKey(text(readBlockOwner(row))))
  const hasDocument = db.prepare('SELECT 1 FROM layout_document WHERE id=?')
  const setParent = db.prepare('UPDATE layout_document SET parent=?,title=? WHERE ordinal=?')
  for (const [ordinal, row] of documents.rows.entries()) {
    const owner = readParent(row), parent = owner === null ? null : text(owner), title = text(readTitle(row))
    if (!title || title.trim() !== title || title === '.' || title === '..' || /[/\\\x00-\x1f]/.test(title))
      return graph3Conflict('merge-layout-original-title', text(readId(row)))
    const parentKey = parent === null ? null : sortKey(parent)
    if (parentKey !== null && !hasDocument.get(parentKey)) conflicts.push({ code: 'missing-document-parent', table: 'documents',
      rowKeys: [row.key], detail: { documentId: text(readId(row)), parentId: parent } })
    setParent.run(parentKey, sortKey(title), ordinal)
  }
  const queued = db.prepare(`SELECT child.ordinal,child.id,child.title,base.path AS parentPath,base.path_bytes AS parentBytes
    FROM layout_queue pos JOIN layout_document child ON child.ordinal=pos.ordinal
    LEFT JOIN layout_document base ON base.id=child.parent WHERE pos.position=?`)
  const setPath = db.prepare('UPDATE layout_document SET path=?,path_bytes=? WHERE ordinal=?')
  const appendChildren = db.prepare(`INSERT INTO layout_queue(ordinal) SELECT ordinal FROM layout_document WHERE parent=? ORDER BY id`)
  const rootCount = db.prepare(`INSERT INTO layout_queue(ordinal) SELECT ordinal FROM layout_document WHERE parent IS NULL ORDER BY id`).run().changes
  const separatorBytes = documents.encoding === 'UTF-8' ? 1 : 2
  let pathBytes = 0
  let count = rootCount
  for (let position = 1; position <= count; position++) {
    const entry = queued.get(position) as { ordinal: number; id: Buffer; title: Buffer; parentPath: Buffer | null; parentBytes: number | null }
    const title = fromKey(entry.title)
    const titleBytes = documents.encoding === 'UTF-8' ? Buffer.byteLength(title) : title.length * 2
    const bytes = (entry.parentBytes === null ? 0 : entry.parentBytes + separatorBytes) + titleBytes
    if (!Number.isSafeInteger(bytes) || bytes > CAPSULE2_RAW_MAX_VALUE_BYTES - pathBytes)
      return graph3Conflict('merge-layout-complete-path-budget', null)
    pathBytes += bytes
    const path = entry.parentPath === null ? title : fromKey(entry.parentPath) + '/' + title
    setPath.run(sortKey(path), bytes, entry.ordinal)
    count += appendChildren.run(entry.id).changes
  }
  if (count !== documents.rows.length) {
    const ordinals = db.prepare('SELECT ordinal FROM layout_document WHERE path IS NULL ORDER BY ordinal').pluck().iterate() as IterableIterator<number>
    conflicts.push({ code: 'cyclic-or-unreachable-document-layout', table: 'documents',
      rowKeys: Array.from(ordinals, ordinal => documents.rows.at(ordinal)!.key), detail: null })
  }
}

function retainedSlug(data: Graph3Inputs) {
  const raw = data.inputs.current.source.sourceContent
  const table = raw.tables.find(item => item.name === 'documents') ?? graph3Conflict('missing-source-table', 'documents')
  const readSlug = readColumn({ columns: table.columns, encoding: raw.encoding }, 'slug')
  return (sourceRowId: string, documentId: string) => {
    const original = findGraph3OriginalRow(table, sourceRowId) ?? graph3Conflict('merge-layout-missing-replaced-document', documentId)
    return text(readSlug(original))
  }
}

function appendDuplicates(db: Database.Database, rows: Table['rows'], conflicts: Merge3LayoutConflict[], column: 'slug' | 'path') {
  // Key each collision by its first physical input occurrence, like the original
  // insertion-ordered grouping. Member keys also retain that input order.
  const duplicates = db.prepare(`WITH repeated AS (SELECT ${column} AS value,min(ordinal) AS first FROM layout_document
    WHERE ${column} IS NOT NULL GROUP BY ${column} HAVING count(*)>1)
    SELECT repeated.first,repeated.value,doc.ordinal FROM repeated JOIN layout_document doc ON doc.${column}=repeated.value
    ORDER BY repeated.first,doc.ordinal`).iterate() as IterableIterator<{ first: number; value: Buffer; ordinal: number }>
  let first = -1, rowKeys: string[] = []
  for (const item of duplicates) {
    if (first !== item.first) {
      first = item.first
      rowKeys = []
      conflicts.push({ code: 'duplicate-document-' + column, table: 'documents', rowKeys, detail: { [column]: fromKey(item.value) } })
    }
    rowKeys.push(rows.at(item.ordinal)!.key)
  }
}

function* layoutRows(db: Database.Database, data: Graph3Inputs, documents: Table, conflicts: Merge3LayoutConflict[],
  changes: Change[]): IterableIterator<MergedRow3> {
  const readId = readColumn(documents, 'id'), readSlug = readColumn(documents, 'slug'), previousSlug = retainedSlug(data)
  const layout = db.prepare(`SELECT path,(SELECT count(*) FROM layout_document child WHERE child.parent=doc.id) AS childCount,
    coalesce((SELECT count FROM layout_block_count WHERE owner=doc.id),0) AS blockCount FROM layout_document doc WHERE ordinal=?`)
  const setSlug = db.prepare('UPDATE layout_document SET slug=? WHERE ordinal=?')
  let changeBytes = 0
  for (const [ordinal, row] of documents.rows.entries()) {
    const id = text(readId(row))
    const planned = layout.get(ordinal) as { path: Buffer | null; childCount: number; blockCount: number }
    const next: Record<string, string | bigint> = {
      block_count: BigInt(planned.blockCount), child_count: BigInt(planned.childCount)
    }
    const reasons: Record<string, string> = { block_count: 'rebuild-physical-block-count', child_count: 'rebuild-physical-child-count' }
    if (planned.path !== null) { next.path = fromKey(planned.path); reasons.path = 'layout-complete-document-parent-forest' }
    if (row.sourceRef.side === 'source') {
      next.slug = row.replaces ? previousSlug(row.replaces.sourceRowId, id) : 'doc-' + id
      reasons.slug = row.replaces ? 'preserve-current-document-slug' : 'allocate-target-document-slug'
    }
    const cells = row.cells.map((before, index) => {
      const column = documents.columns[index]
      if (!Object.hasOwn(next, column) || next[column] === graph3Value(before, documents.encoding)) return before
      const after: RawRestoreSqlCell = typeof next[column] === 'bigint' ? ['integer', next[column].toString()] : graph3Encode(next[column], documents.encoding)
      const change: Change = { rowKey: row.key, targetDocumentId: id, column, before, after, reason: reasons[column] }
      // Storage payloads are validated ASCII decimal/hex/base64 strings. Size
      // their JSON directly instead of first materializing a giant change DTO.
      const cellBytes = (cell: RawRestoreSqlCell) => cell[0] === 'null' ? 8 : cell[0].length + cell[1].length + 7
      const bytes = Buffer.byteLength(capsuleJson({ ...change, before: null, after: null })) - 8 + cellBytes(before) + cellBytes(after)
      if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES - changeBytes) return graph3Conflict('merge-layout-complete-change-budget', null)
      changeBytes += bytes; changes.push(change); return after
    })
    setSlug.run(sortKey(typeof next.slug === 'string' ? next.slug : text(readSlug(row))), ordinal)
    yield { ...row, cells }
  }
  appendDuplicates(db, documents.rows, conflicts, 'slug')
  appendDuplicates(db, documents.rows, conflicts, 'path')
}

/** Layout the selected forest, including current descendants. The file-backed
 * index holds only layout fields, while exact original cells stay with their rows. */
export function applyMerge3DocumentLayout3(data: Graph3Inputs, tables: readonly Table[]) {
  return withMerge3DocumentLayout3(data, tables, result => freezeCapsuleValue({ ...result, tables: materializeNavigation3Tables(result.tables) }))
}

export function withMerge3DocumentLayout3<Result>(data: Graph3Inputs, tables: readonly Table[],
  read: (result: ReturnType<typeof layoutResult>) => Result): Result {
  const documents = tables.find(table => table.name === 'documents') ?? graph3Conflict('merge-layout-missing-documents', null)
  const blocks = tables.find(table => table.name === 'blocks') ?? graph3Conflict('merge-layout-missing-blocks', null)
  return withStoredNavigation3TableScan(append => {
    const db = new Database(':memory:'), conflicts: Merge3LayoutConflict[] = [], changes: Change[] = []
    try {
      db.pragma('temp_store=FILE')
      if (db.pragma('temp_store', { simple: true }) !== 1) return graph3Conflict('merge-layout-file-index-unavailable', null)
      return db.transaction(() => {
        layoutForest(db, documents, blocks, conflicts)
        const { rows: _rows, ...layout } = documents
        append(layout, layoutRows(db, data, documents, conflicts, changes))
        return { changes, conflicts }
      })()
    } finally { db.close() }
  }, ({ changes, conflicts }, [laidOut]) => read(layoutResult(tables, laidOut, changes, conflicts)))
}

function layoutResult(tables: readonly Table[], laidOut: Table, changes: Change[], conflicts: Merge3LayoutConflict[]) {
  const result = tables.map(table => table.name === 'documents' ? laidOut : table)
  const body = { changes, conflicts, documentHierarchyLaidOut: conflicts.length === 0, navigationRewritten: false as const,
    sourceHistoryReplayed: false as const, permit: false as const }
  const hashInput = { ...body, documents: navigation3TableHashInput([laidOut])[0] }
  assertMerge3JsonBudget(hashInput)
  const layoutHash = hashBoundedCapsuleJson(hashInput, CAPSULE2_RAW_MAX_JSON_BYTES, 'knowbook.restore.merge3.document-layout.v1\0')
  if (layoutHash === null) return graph3Conflict('merge-layout-complete-json-budget', null)
  return freezeCapsuleValue({ tables: result, ...body, layoutHash })
}
