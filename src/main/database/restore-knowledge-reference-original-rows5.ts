import Database from 'better-sqlite3'
import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { capsule2RawInvalid, capsule2RawTableRows, scopedCapsule2RawSqlTable,
  type Capsule2Encoding, type Capsule2RawContent, type Capsule2RawContentStream, type Capsule2RawSqlRow,
  type Capsule2RawSqlTable, type Capsule2RawStreamTable, type StoreCapsule2Archive6Blocks5 } from './restore-knowledge-capsule2-raw-model'
import { graph3TableLayout, graph3Value } from './restore-knowledge-graph3-data'
import { isOwnedCapsule2PhysicalGraph, type RawCapsule2PhysicalGraph } from './restore-knowledge-capsule2-physical-raw-read'
import type { SyncedGroupSnapshot } from '../../shared/synced-blocks'

type Side = 'source' | 'current'
type OriginalTable = Capsule2RawStreamTable & {
  byId(id: string): Capsule2RawSqlRow | undefined
  readonly count: number
  encoded(): IterableIterator<string>
  byRowId(sourceRowId: string): Capsule2RawSqlRow | undefined
  byOwner?(id: string): IterableIterator<Capsule2RawSqlRow>
  ownsRow(row: Capsule2RawSqlRow): boolean
}
export type ReferenceOriginalRows5 = Omit<Capsule2RawContentStream, 'tables'> & { readonly tables: readonly OriginalTable[] }

const originalTableViews = new WeakMap<Capsule2RawSqlTable, { side: Side; table: OriginalTable }>()
const scopedGroupGraphs = new WeakSet<RawCapsule2PhysicalGraph>()
export function hasScopedReferenceGroupBodies5(graph: RawCapsule2PhysicalGraph): boolean {
  return scopedGroupGraphs.has(graph)
}

function scopeDocumentBodies(db: Database.Database, side: Side, documents: RawCapsule2PhysicalGraph['documents'], assertActive: () => void) {
  const write = db.prepare('INSERT INTO temp.reference_document_bodies VALUES (?,?,?)')
  const read = db.prepare('SELECT encoded FROM temp.reference_document_bodies WHERE role=? AND document_id=?').pluck()
  const scoped = db.transaction(() => documents.map(({ blocks, ...document }) => {
    const key = Buffer.from(document.documentId, 'utf16le')
    write.run(side, key, capsuleJson(blocks))
    return Object.freeze({ ...document, get blocks() {
      assertActive()
      const encoded = read.get(side, key)
      if (typeof encoded !== 'string') return capsule2RawInvalid('Reference3找不到实际原文档正文：' + document.documentId)
      return freezeCapsuleValue(JSON.parse(encoded) as RawCapsule2PhysicalGraph['documents'][number]['blocks'])
    } })
  }))()
  Object.freeze(scoped)
  return scoped
}

/** A cold Reference3 read admits rows only after the genuine original, both
 * manifests and candidate checks. The producer can release its DTOs before a
 * consumer reads one ordered table or an individual identity. */
export async function withReferenceOriginalRows5<Projection, Result>(
  produce: (store: (side: Side, original: Capsule2RawContent) => ReferenceOriginalRows5,
    storePhysical: (graph: RawCapsule2PhysicalGraph, side?: Side) => RawCapsule2PhysicalGraph,
    storeArchive6Blocks: StoreCapsule2Archive6Blocks5) => Promise<Projection>,
  read: (projection: Projection) => Promise<Result>
): Promise<Result> {
  const db = new Database(':memory:')
  let active = true
  const assertActive = () => { if (!active) return capsule2RawInvalid('Reference3原始行读取范围已结束') }
  try {
    db.pragma('temp_store=FILE')
    if (db.pragma('temp_store', { simple: true }) !== 1) return capsule2RawInvalid('Reference3原始行外存不可用')
    db.pragma('temp.cache_size=-2048')
    db.exec(`CREATE TEMP TABLE reference_original_rows (
      role TEXT NOT NULL, table_name TEXT NOT NULL, source_rowid INTEGER NOT NULL, identity TEXT, owner TEXT, encoded TEXT NOT NULL,
      PRIMARY KEY (role, table_name, source_rowid)
    ) WITHOUT ROWID;
    CREATE INDEX temp.reference_original_identity ON reference_original_rows(role, table_name, identity, source_rowid);
    CREATE UNIQUE INDEX temp.reference_original_block_identity ON reference_original_rows(role, table_name, identity)
      WHERE table_name IN ('blocks', 'synced_group_blocks');
    CREATE INDEX temp.reference_original_block_owner ON reference_original_rows(role, table_name, owner, source_rowid)
      WHERE owner IS NOT NULL;
    CREATE TEMP TABLE reference_group_bodies (
      role TEXT NOT NULL, group_id TEXT NOT NULL, encoded TEXT NOT NULL,
      PRIMARY KEY (role, group_id)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE reference_document_bodies (
      role TEXT NOT NULL, document_id BLOB NOT NULL, encoded TEXT NOT NULL,
      PRIMARY KEY (role, document_id)
    ) WITHOUT ROWID`)
    const insert = db.prepare('INSERT INTO temp.reference_original_rows VALUES (?, ?, ?, ?, ?, ?)')
    const scan = 'SELECT encoded FROM temp.reference_original_rows WHERE role=? AND table_name=? ORDER BY source_rowid'
    const scanOwner = 'SELECT encoded FROM temp.reference_original_rows WHERE role=? AND table_name=? AND owner=? ORDER BY source_rowid'
    const lookup = db.prepare(`SELECT encoded FROM temp.reference_original_rows
      WHERE role=? AND table_name=? AND identity=? ORDER BY source_rowid DESC LIMIT 1`).pluck()
    const lookupRow = db.prepare(`SELECT encoded FROM temp.reference_original_rows
      WHERE role=? AND table_name=? AND source_rowid=?`).pluck()
    const sides = new Set<Side>()
    const physicalSides = new Set<Side>()
    const writeGroup = db.prepare('INSERT INTO temp.reference_group_bodies VALUES (?,?,?)')
    const readGroup = db.prepare('SELECT encoded FROM temp.reference_group_bodies WHERE role=? AND group_id=?').pluck()
    function scopedGroupSnapshot(side: Side, id: string, header: Omit<SyncedGroupSnapshot, 'blocks'>): SyncedGroupSnapshot {
      return Object.freeze({ ...header, get blocks() {
        assertActive()
        const encoded = readGroup.get(side, id)
        if (typeof encoded !== 'string') return capsule2RawInvalid('Reference3找不到实际原组正文：' + id)
        return freezeCapsuleValue(JSON.parse(encoded) as SyncedGroupSnapshot['blocks'])
      } })
    }
    const putTable = (side: Side, layout: Omit<Capsule2RawSqlTable, 'rows'>, rows: Iterable<Capsule2RawSqlRow>,
      encoding: Capsule2Encoding): OriginalTable => {
      assertActive()
      const { name, columns } = layout
      const ownerColumn = name === 'blocks' ? 'document_id' : name === 'synced_group_blocks' ? 'group_id' : undefined
      const key = columns.indexOf(name === 'synced_instances' ? 'instance_id' : 'id')
      const ownerKey = ownerColumn === undefined ? -1 : columns.indexOf(ownerColumn)
      let count = 0
      for (const row of rows) {
        const identity = key < 0 ? null : graph3Value(row.cells[key], encoding)
        const owner = ownerKey < 0 ? null : graph3Value(row.cells[ownerKey], encoding)
        if (ownerColumn !== undefined && (typeof identity !== 'string' || typeof owner !== 'string'))
          return capsule2RawInvalid('原块身份或宿主不是确切TEXT：' + name)
        insert.run(side, name, BigInt(row.sourceRowId), typeof identity === 'string' ? identity : null,
          typeof owner === 'string' ? owner : null, capsuleJson(row))
        count++
      }
      const decodedRows = new WeakSet<Capsule2RawSqlRow>()
      function decode(text: string): Capsule2RawSqlRow {
        const row = freezeCapsuleValue(JSON.parse(text) as Capsule2RawSqlRow)
        decodedRows.add(row)
        return row
      }
      function* encoded() {
        assertActive()
        yield* db.prepare(scan).pluck().iterate(side, name) as IterableIterator<string>
      }
      function* byOwner(owner: string) {
        assertActive()
        for (const row of db.prepare(scanOwner).pluck().iterate(side, name, owner) as IterableIterator<string>) yield decode(row)
      }
      const table: OriginalTable = { ...layout, rows: Object.freeze({ *[Symbol.iterator]() {
        for (const row of encoded()) yield decode(row)
      } }), count, encoded, byOwner: ownerColumn === undefined ? undefined : byOwner, ownsRow(row) {
        assertActive()
        return decodedRows.has(row)
      }, byId(id: string) {
        assertActive()
        const row = lookup.get(side, name, id)
        return typeof row === 'string' ? decode(row) : undefined
      }, byRowId(sourceRowId: string) {
        assertActive()
        if (!/^(?:0|-?[1-9][0-9]{0,18})$/.test(sourceRowId)) return
        const id = BigInt(sourceRowId)
        if (id < -(2n ** 63n) || id >= 2n ** 63n) return
        const row = lookupRow.get(side, name, id)
        return typeof row === 'string' ? decode(row) : undefined
      } }
      for (const key of ['byId', 'byOwner', 'byRowId', 'count', 'encoded', 'ownsRow']) Object.defineProperty(table, key, { enumerable: false })
      return Object.freeze(table)
    }
    const put = db.transaction((side: Side, { tables, ...header }: Capsule2RawContent): ReferenceOriginalRows5 => {
      const stored = tables.map(original => {
        const existing = originalTableViews.get(original)
        return existing?.side === side ? existing.table : putTable(side, graph3TableLayout(original), capsule2RawTableRows(original), header.encoding)
      })
      return Object.freeze({ ...header, tables: Object.freeze(stored) })
    })
    const stagedBlocks = new Set<string>()
    const putArchive6Blocks = db.transaction<StoreCapsule2Archive6Blocks5>((layout, rows, encoding) => {
      if (sides.has('source') || stagedBlocks.has(layout.name)
        || layout.name !== 'blocks' && layout.name !== 'synced_group_blocks') return capsule2RawInvalid('archive6原块表范围不符')
      const stored = putTable('source', layout, rows, encoding)
      stagedBlocks.add(layout.name)
      const scoped = scopedCapsule2RawSqlTable({ ...layout, columns: Object.freeze(layout.columns), primaryKey: Object.freeze(layout.primaryKey) }, stored)
      originalTableViews.set(scoped, { side: 'source', table: stored })
      return scoped
    })
    const projection = await produce((side, original) => {
      if (sides.has(side)) return capsule2RawInvalid('Reference3同次原件角色重复')
      const scoped = put(side, original)
      sides.add(side)
      return scoped
    }, (graph, side = 'source') => {
      assertActive()
      if (!isOwnedCapsule2PhysicalGraph(graph)) return capsule2RawInvalid('Reference3语义正文需要本次已验证的物理原件')
      if (physicalSides.has(side)) return capsule2RawInvalid('Reference3同次语义正文角色重复')
      const groups = db.transaction(() => graph.groups.map(group => {
        if (!group.snapshot) return group
        const { blocks, ...snapshot } = group.snapshot
        const id = group.groupId
        writeGroup.run(side, id, capsuleJson(blocks))
        return Object.freeze({ ...group, snapshot: scopedGroupSnapshot(side, id, snapshot) })
      }))()
      Object.freeze(groups)
      const documents = scopeDocumentBodies(db, side, graph.documents, assertActive)
      physicalSides.add(side)
      const scoped = Object.freeze({ ...graph, documents, groups })
      scopedGroupGraphs.add(scoped)
      return scoped
    }, putArchive6Blocks)
    return await read(projection)
  } finally { active = false; db.close() }
}

/** The input owner has already checked these originals and their complete
 * digest. Reference3 borrows their exact ordered rows within this scope. */
export function scopeIncomingReferenceTables5(original: Capsule2RawContent,
  store: (side: Side, original: Capsule2RawContent) => ReferenceOriginalRows5): Capsule2RawContent {
  return scopeReferenceTables(original, store, 'source', ['blocks', 'synced_group_blocks', 'document_history', 'document_trash'])
}

export function scopeCurrentReferenceBlocks5(original: Capsule2RawContent,
  store: (side: Side, original: Capsule2RawContent) => ReferenceOriginalRows5): Capsule2RawContent {
  return scopeReferenceTables(original, store, 'current', ['blocks', 'synced_group_blocks'])
}

function scopeReferenceTables(original: Capsule2RawContent, store: (side: Side, original: Capsule2RawContent) => ReferenceOriginalRows5,
  side: Side, names: readonly string[]): Capsule2RawContent {
  const selected = original.tables.filter(table => names.includes(table.name) && originalTableViews.get(table)?.side !== side)
  if (!selected.length) return original
  const stored = new Map(store(side, { ...original, tables: selected }).tables.map(table => {
    const { rows: _rows, ...layout } = table
    const scoped = scopedCapsule2RawSqlTable(layout, table)
    originalTableViews.set(scoped, { side, table })
    return [table.name, scoped] as const
  }))
  return Object.freeze({ ...original, tables: Object.freeze(original.tables.map(table => stored.get(table.name) ?? table)) })
}
