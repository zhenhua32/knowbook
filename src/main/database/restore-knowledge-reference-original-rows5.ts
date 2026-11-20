import Database from 'better-sqlite3'
import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { capsule2RawInvalid, scopedCapsule2RawSqlTable, type Capsule2RawContent, type Capsule2RawContentStream,
  type Capsule2RawSqlRow, type Capsule2RawStreamTable } from './restore-knowledge-capsule2-raw-model'
import { graph3Value } from './restore-knowledge-graph3-data'

type Side = 'source' | 'current'
type OriginalTable = Capsule2RawStreamTable & {
  byId(id: string): Capsule2RawSqlRow | undefined
  readonly count: number
  encoded(): IterableIterator<string>
  byRowId(sourceRowId: string): Capsule2RawSqlRow | undefined
}
export type ReferenceOriginalRows5 = Omit<Capsule2RawContentStream, 'tables'> & { readonly tables: readonly OriginalTable[] }

/** A cold Reference3 read admits rows only after the genuine original, both
 * manifests and candidate checks. The producer can release its DTOs before a
 * consumer reads one ordered table or an individual identity. */
export async function withReferenceOriginalRows5<Projection, Result>(
  produce: (store: (side: Side, original: Capsule2RawContent) => ReferenceOriginalRows5) => Promise<Projection>,
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
      role TEXT NOT NULL, table_name TEXT NOT NULL, source_rowid INTEGER NOT NULL, identity TEXT, encoded TEXT NOT NULL,
      PRIMARY KEY (role, table_name, source_rowid)
    ) WITHOUT ROWID;
    CREATE INDEX temp.reference_original_identity ON reference_original_rows(role, table_name, identity, source_rowid)`)
    const insert = db.prepare('INSERT INTO temp.reference_original_rows VALUES (?, ?, ?, ?, ?)')
    const scan = db.prepare('SELECT encoded FROM temp.reference_original_rows WHERE role=? AND table_name=? ORDER BY source_rowid').pluck()
    const lookup = db.prepare(`SELECT encoded FROM temp.reference_original_rows
      WHERE role=? AND table_name=? AND identity=? ORDER BY source_rowid DESC LIMIT 1`).pluck()
    const lookupRow = db.prepare(`SELECT encoded FROM temp.reference_original_rows
      WHERE role=? AND table_name=? AND source_rowid=?`).pluck()
    const sides = new Set<Side>()
    const decode = (text: string): Capsule2RawSqlRow => freezeCapsuleValue(JSON.parse(text) as Capsule2RawSqlRow)
    const put = db.transaction((side: Side, { tables, ...header }: Capsule2RawContent): ReferenceOriginalRows5 => {
      const stored = tables.map(({ rows, ...layout }): OriginalTable => {
        const { name, columns } = layout
        const key = columns.indexOf(name === 'synced_instances' ? 'instance_id' : 'id')
        for (const row of rows) {
          const identity = key < 0 ? null : graph3Value(row.cells[key], header.encoding)
          insert.run(side, name, BigInt(row.sourceRowId), typeof identity === 'string' ? identity : null, capsuleJson(row))
        }
        function* encoded() {
          assertActive()
          yield* scan.iterate(side, name) as IterableIterator<string>
        }
        const table: OriginalTable = { ...layout, rows: Object.freeze({ *[Symbol.iterator]() {
          for (const row of encoded()) yield decode(row)
        } }), count: rows.length, encoded, byId(id: string) {
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
        for (const key of ['byId', 'byRowId', 'count', 'encoded']) Object.defineProperty(table, key, { enumerable: false })
        return Object.freeze(table)
      })
      return Object.freeze({ ...header, tables: Object.freeze(stored) })
    })
    const projection = await produce((side, original) => {
      if (sides.has(side)) return capsule2RawInvalid('Reference3同次原件角色重复')
      const scoped = put(side, original)
      sides.add(side)
      return scoped
    })
    return await read(projection)
  } finally { active = false; db.close() }
}

/** These incoming history tables contribute evidence to planning. The active
 * candidate reads them in original row order and installs current history. */
export function scopeIncomingReferenceHistory5(original: Capsule2RawContent,
  store: (side: Side, original: Capsule2RawContent) => ReferenceOriginalRows5): Capsule2RawContent {
  const selected = original.tables.filter(table => table.name === 'document_history' || table.name === 'document_trash')
  const stored = new Map(store('source', { ...original, tables: selected }).tables.map(table => {
    const { rows: _rows, ...layout } = table
    return [table.name, scopedCapsule2RawSqlTable(layout, table)] as const
  }))
  return Object.freeze({ ...original, tables: Object.freeze(original.tables.map(table => stored.get(table.name) ?? table)) })
}
