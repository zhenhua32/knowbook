import type Database from 'better-sqlite3'
import { capsuleJson } from './restore-knowledge-capsule-model'
import { rawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { readRawRestoreSqlInventoryOwned } from './restore-knowledge-sql-inventory'
import { assertSyncedBlockSchema, syncedBlockSchemaObjectNames } from './synced-schema'
import { assertSyncedLifecycleSchemaDefinition, syncedLifecycleSchemaObjectNames } from './synced-lifecycle-schema-metadata'
import { CAPSULE2_READER, CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES,
  assertCapsule2RawContentStreamHeader, capsule2ApplicationColumns,
  capsule2DerivedFtsDefinitions, capsule2DerivedFtsTables, capsule2RawInvalid, capsule2RawSqlValueBytesExpression, capsule2TableRole,
  hashCapsule2RawContentStream, validateCapsule2RawContent, type Capsule2Encoding, type Capsule2RawContent,
  type Capsule2RawContentStream, type Capsule2RawSqlRow, type Capsule2RawStreamTable } from './restore-knowledge-capsule2-raw-model'

const quote = (value: string): string => '"' + value.replace(/"/g, '""') + '"'
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const fts = new Set(capsule2DerivedFtsTables())
type Info = { name: string; columns: string[]; primaryKey: string[]; rows: bigint }

function* readOriginalRows(db: Database.Database, plan: Info, encoding: Capsule2Encoding): IterableIterator<Capsule2RawSqlRow> {
  const projection = plan.columns.flatMap(name => ['typeof(' + quote(name) + ')', 'CASE WHEN typeof(' + quote(name) + ")='text' THEN CAST(" + quote(name) + ' AS BLOB) ELSE ' + quote(name) + ' END']).join(',')
  const rows = db.prepare('SELECT _rowid_,' + projection + ' FROM ' + quote(plan.name) + ' ORDER BY _rowid_')
    .safeIntegers(true).raw(true).iterate() as IterableIterator<unknown[]>
  let previous: bigint | undefined, count = 0n
  for (const row of rows) {
    const rowId = row[0]
    if (typeof rowId !== 'bigint' || previous !== undefined && rowId <= previous) return capsule2RawInvalid('原rowid顺序不闭合')
    previous = rowId
    count++
    // Keep every occurrence, including rows with NULL composite PK.
    yield { sourceRowId: rowId.toString(), cells: plan.columns.map((_name, index) => rawRestoreSqlCell(row[index * 2 + 1], row[index * 2 + 2], encoding)) }
  }
  if (count !== plan.rows) return capsule2RawInvalid('同事务完整原行计数变化')
}

function prepareRawCapsule2Content(db: Database.Database): Capsule2RawContentStream {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return capsule2RawInvalid('要求独立readonly scratch的query-only/FKON真实owned事务')
  const version = db.pragma('user_version', { simple: true }), encoding = db.pragma('encoding', { simple: true })
  if (version !== 26 && version !== 27 || encoding !== 'UTF-8' && encoding !== 'UTF-16le' && encoding !== 'UTF-16be')
    return capsule2RawInvalid('仅准确schema26/27和已知原TEXT编码；不推empty')
  assertSyncedBlockSchema(db)
  if (version === 27) assertSyncedLifecycleSchemaDefinition(db)
  // Exact sync DDL is checked above. App columns come from the single existing
  // pure DDL plus the two actual blocks migrations and Store template schema.
  const application = capsule2ApplicationColumns(), sync = new Set([...syncedBlockSchemaObjectNames(),
    ...(version === 27 ? syncedLifecycleSchemaObjectNames() : [])].filter(item => item.type === 'table').map(item => item.name))
  const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name").all() as Array<{ name: string; sql: string | null }>
  const actual = new Set(schema.map(item => item.name)), ignored: string[] = [], plans: Info[] = []
  for (const name of [...application.keys(), ...sync]) if (!actual.has(name)) return capsule2RawInvalid('固定数据表缺失：' + name)
  const normalize = (sql: string): string => sql.replace(/\bIF NOT EXISTS\s+/gi, '').replace(/\s+/g, ' ').trim().replace(/;$/, '')
  for (const [name, expected] of capsule2DerivedFtsDefinitions()) {
    const declaration = schema.find(table => table.name === name)
    if (!declaration?.sql || normalize(declaration.sql) !== normalize(expected)) return capsule2RawInvalid('derived FTS不是固定原虚表定义')
  }
  let totalRows = 0n, totalBytes = 0n
  for (const table of schema) {
    if (fts.has(table.name)) { ignored.push(table.name); continue }
    if (!application.has(table.name) && !sync.has(table.name)) return capsule2RawInvalid('未知数据表family：' + table.name)
    if (!table.sql || /\bWITHOUT\s+ROWID\b/i.test(table.sql)) return capsule2RawInvalid('尚缺该原表rowid存储adapter：' + table.name)
    const columns = db.prepare('SELECT * FROM ' + quote(table.name) + ' LIMIT 0').columns().map(column => column.name)
    if (!columns.length || columns.length > 512 || columns.some(name => !/^[a-z_][a-z0-9_]*$/.test(name) || ['rowid', '_rowid_', 'oid'].includes(name)))
      return capsule2RawInvalid('原表列不是有限无歧义闭集：' + table.name)
    const expected = application.get(table.name)
    if (expected && capsuleJson([...expected].sort(compare)) !== capsuleJson([...columns].sort(compare))) return capsule2RawInvalid('未知/缺失普通列：' + table.name)
    const primaryKey = (db.pragma('table_info(' + quote(table.name) + ')') as Array<{ name: string; pk: number }>).filter(column => column.pk > 0)
      .sort((left, right) => left.pk - right.pk).map(column => column.name)
    // Preflight happens before a driver can materialize a giant TEXT/BLOB cell.
    // This finite preparation budget is explicit unsupported, never truncation
    // or a new public wire limit. It does not prove 1TiB SQL streaming support.
    const size = capsule2RawSqlValueBytesExpression(columns)
    const measured = db.prepare('SELECT count(*),coalesce(sum(' + size + '),0) FROM ' + quote(table.name)).safeIntegers(true).raw(true).get() as unknown[]
    if (typeof measured[0] !== 'bigint' || typeof measured[1] !== 'bigint' || measured[0] < 0n || measured[1] < 0n) return capsule2RawInvalid('原表预算不是准确非负INTEGER')
    totalRows += measured[0]; totalBytes += measured[1]
    if (totalRows > BigInt(CAPSULE2_RAW_MAX_ROWS) || totalBytes > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES)) return capsule2RawInvalid('完整raw source超准备预算，必须流式adapter，不能丢行')
    plans.push({ name: table.name, columns, primaryKey, rows: measured[0] })
  }
  if (db.pragma('main.integrity_check', { simple: true }) !== 'ok' || db.prepare('PRAGMA main.foreign_key_check').get() !== undefined)
    return capsule2RawInvalid('原SQL物理/FK完整性失败')
  // Independent original SQL inventory/hash domain is left unchanged. It is
  // not a publication projection and introduces no title500 or graph pruning.
  const inventory = readRawRestoreSqlInventoryOwned(db)
  const workspace = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { workspace_scope: string; recovery_epoch: string } | undefined
  if (!workspace) return capsule2RawInvalid('缺少原工作区标头')
  return { kind: 'restore-knowledge-capsule2-raw-content', version: 1, forReader: CAPSULE2_READER,
    schemaVersion: version, encoding, workspaceScope: workspace.workspace_scope, recoveryEpoch: workspace.recovery_epoch, schemaHash: inventory.schemaHash,
    legacyInventoryHash: inventory.inventoryHash, derivedTablesNotRepeated: ignored,
    tables: plans.map(plan => ({ name: plan.name, role: capsule2TableRole(plan.name), columns: plan.columns, primaryKey: plan.primaryKey,
      rows: readOriginalRows(db, plan, encoding) })), state: 'raw-storage-only', semanticValidationComplete: false, certified: false }
}

/** Full data-only DTO for callers that need to inspect or transform raw rows. */
export function readRawCapsule2ContentOwned(db: Database.Database): Capsule2RawContent {
  const content = prepareRawCapsule2Content(db)
  return validateCapsule2RawContent({ ...content, tables: content.tables.map(table => ({ ...table, rows: [...table.rows] })) })
}

/** Visit every inspected row in one owned transaction, with the same complete
 * JSON budget as the materialized raw DTO. Each visitor must exhaust its table. */
export function observeRawCapsule2TablesOwned(db: Database.Database,
  visit: (table: Capsule2RawStreamTable, encoding: Capsule2Encoding) => void) {
  const content = prepareRawCapsule2Content(db)
  assertCapsule2RawContentStreamHeader(content)
  const { tables, ...header } = content
  let bytes = Buffer.byteLength(capsuleJson({ ...header, tables: [] }))
  const charge = (value: object, separator: boolean) => {
    bytes += Buffer.byteLength(capsuleJson(value)) + Number(separator)
    if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return capsule2RawInvalid('完整raw JSON超预算，不截断')
  }
  for (const [index, { rows, ...layout }] of tables.entries()) {
    charge({ ...layout, rows: [] }, index > 0)
    let exhausted = false
    const observed = function* () {
      let first = true
      for (const row of rows) {
        charge(row, !first)
        first = false
        yield row
      }
      exhausted = true
    }()
    try {
      visit({ ...layout, rows: observed }, content.encoding)
      if (!exhausted) return capsule2RawInvalid('必须读完原表：' + layout.name)
    } finally { observed.return(undefined) }
  }
  return header
}

/** Exact digest for observers that need the complete scan but consume no rows. */
export function readRawCapsule2ObserverContentOwned(db: Database.Database) {
  const content = prepareRawCapsule2Content(db)
  return { schemaVersion: content.schemaVersion, rawContentHash: hashCapsule2RawContentStream('knowbook.capsule2.observer-content.v1', content) }
}
