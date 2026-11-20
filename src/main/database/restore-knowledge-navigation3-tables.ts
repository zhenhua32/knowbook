import Database from 'better-sqlite3'
import { capsuleJsonProjectedArray, capsuleJsonStoredArray, hashBoundedCapsuleJson } from './restore-knowledge-capsule-json-hash'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Key } from './restore-knowledge-graph3-data'
import { assertMerge3JsonBudget, type FinishedMerge3Table, type MergedRow3 } from './restore-knowledge-merge3-storage'
import { withStoredRestoreScopes } from './restore-knowledge-stored-scopes'

export type Navigation3Table = FinishedMerge3Table['table']
type Navigation3Rows = Iterable<MergedRow3> & {
  readonly length: number
  at(ordinal: number): MergedRow3 | undefined
  entries(): IterableIterator<[number, MergedRow3]>
}
export type Navigation3TableSource = Omit<Navigation3Table, 'rows'> & { readonly rows: Navigation3Rows }
type NavigationTableLayout = Omit<Navigation3Table, 'rows'>
export type StoreNavigation3Table = (layout: NavigationTableLayout, rows: Iterable<MergedRow3>) => void
const storedHashes = new WeakMap<Navigation3Rows, readonly MergedRow3[]>()
const scopedTables = new WeakSet<Navigation3TableSource>()

function rowSource(length: number, at: Navigation3Rows['at'], iterate: () => IterableIterator<MergedRow3>): Navigation3Rows {
  return Object.freeze({ length, at, [Symbol.iterator]: iterate, *entries() {
    let ordinal = 0
    for (const row of iterate()) yield [ordinal++, row] as [number, MergedRow3]
  } })
}

function scopedTable(layout: Omit<Navigation3Table, 'rows'>, rows: Navigation3Rows): Navigation3TableSource {
  const table = Object.freeze({ ...layout, rows })
  scopedTables.add(table)
  return table
}

export function readScopedNavigation3Rows(table: Navigation3TableSource): Navigation3Rows | undefined {
  return scopedTables.has(table) ? table.rows : undefined
}

/** The producer finishes before the first consumer of the file. Its complete
 * input array is outside the read scope and only ordered row coordinates remain. */
export function withStoredNavigation3Tables<Metadata, Result>(
  produce: () => { metadata: Metadata; tables: readonly Navigation3Table[] },
  read: (metadata: Metadata, tables: readonly Navigation3TableSource[]) => Result
): Result {
  return withStoredNavigation3TableScan(append => {
    const { metadata, tables } = produce()
    for (const { rows, ...layout } of tables) append(layout, rows)
    return metadata
  }, read)
}

/** Accept the independent SQL observer's already-verified row cursor directly. */
export function withStoredNavigation3TableScan<Metadata, Result>(
  scan: (append: StoreNavigation3Table) => Metadata,
  read: (metadata: Metadata, tables: readonly Navigation3TableSource[]) => Result
): Result {
  return withStoredRestoreScopes((append: (key: string, row: MergedRow3) => void) => {
    const layouts: Array<{ layout: NavigationTableLayout; first: number; length: number }> = []
    let start = 0
    const metadata = scan((layout, rows) => {
      const first = start
      let length = 0
      for (const row of rows) append(graph3Key(layout.name, length++), row)
      start += length
      layouts.push({ layout, first, length })
    })
    return { metadata, layouts }
  }, ({ metadata, layouts }, store) => read(metadata, layouts.map(({ layout, first, length }) => {
    const encoded = () => store.iterateEncoded(first, first + length)
    const rows = rowSource(length, ordinal => ordinal >= 0 && ordinal < length ? store.byId(graph3Key(layout.name, ordinal)) : undefined,
      function* () { for (const row of encoded()) yield JSON.parse(row) as MergedRow3 })
    storedHashes.set(rows, capsuleJsonStoredArray(encoded))
    return scopedTable(layout, rows)
  })))
}

export function projectNavigation3TableRows(table: Navigation3TableSource, project: (row: MergedRow3, ordinal: number) => MergedRow3): Navigation3TableSource {
  if (!scopedTables.has(table)) assertPlainTables([table])
  const rows = rowSource(table.rows.length, ordinal => {
    const row = table.rows.at(ordinal)
    return row && project(row, ordinal)
  }, function* () {
    for (const [ordinal, row] of table.rows.entries()) yield project(row, ordinal)
  })
  return scopedTable(table, rows)
}

export function materializeNavigation3Tables(tables: readonly Navigation3TableSource[]): Navigation3Table[] {
  return tables.map(table => Array.isArray(table.rows) ? table as Navigation3Table : { ...table, rows: [...table.rows] })
}

export function navigation3TableHashInput(tables: readonly Navigation3TableSource[]): readonly Navigation3Table[] {
  return tables.map(({ rows, ...layout }) => ({ ...layout, rows: Array.isArray(rows) ? rows : storedHashes.get(rows) ?? capsuleJsonProjectedArray(() => rows) }))
}

export function assertNavigation3TableJsonBudget(tables: readonly Navigation3TableSource[]) {
  if (!Array.isArray(tables) || Object.getPrototypeOf(tables) !== Array.prototype || Reflect.ownKeys(tables).length !== tables.length + 1)
    return graph3Conflict('navigation-table-row-source', null)
  const plain: Navigation3TableSource[] = []
  for (let ordinal = 0; ordinal < tables.length; ordinal++) {
    const descriptor = Object.getOwnPropertyDescriptor(tables, String(ordinal))
    if (!descriptor?.enumerable || !('value' in descriptor)) return graph3Conflict('navigation-table-row-source', ordinal)
    if (!scopedTables.has(descriptor.value)) plain.push(descriptor.value)
  }
  if (plain.length === tables.length) return assertPlainTables(tables)
  if (plain.length) assertPlainTables(plain)
  if (!hashBoundedCapsuleJson(navigation3TableHashInput(tables), CAPSULE2_RAW_MAX_JSON_BYTES))
    return graph3Conflict('navigation-table-json-budget', null)
}

function assertPlainTables(tables: readonly Navigation3TableSource[]) {
  assertMerge3JsonBudget(tables)
  if (tables.some(table => !Array.isArray(table.rows))) return graph3Conflict('navigation-table-row-source', null)
}

/** Preserve the exact text units of sparse edits. The final table audit still
 * owns the existing output budget, without charging scratch JSON escapes. */
export function withNavigation3TextPatches<Projection, Result>(
  produce: (write: (key: string, text: string) => void, read: (key: string) => string | undefined) => Projection,
  consume: (projection: Projection) => Result
): Result {
  const db = new Database(':memory:')
  try {
    db.pragma('temp_store=FILE')
    if (db.pragma('temp_store', { simple: true }) !== 1) return graph3Conflict('navigation-cell-file-unavailable', null)
    db.pragma('temp.cache_size=-2048')
    db.exec('CREATE TEMP TABLE navigation_patches (cell_key TEXT PRIMARY KEY, text_units BLOB NOT NULL) WITHOUT ROWID')
    const insert = db.prepare('INSERT INTO temp.navigation_patches VALUES (?,?)')
    const find = db.prepare('SELECT text_units FROM temp.navigation_patches WHERE cell_key=?').pluck()
    return consume(db.transaction(() => produce((key, text) => { insert.run(key, Buffer.from(text, 'utf16le')) },
      key => (find.get(key) as Buffer | undefined)?.toString('utf16le')))())
  } finally { db.close() }
}
