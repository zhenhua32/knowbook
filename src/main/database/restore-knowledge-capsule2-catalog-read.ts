import type Database from 'better-sqlite3'
import { isSyncedBlockId } from '../../shared/syncedBlockValidation'
import { parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2ApplicationColumns,
  capsule2RawSqlValueBytesExpression } from './restore-knowledge-capsule2-raw-model'

const tables = ['databases', 'document_database_columns', 'database_saved_views', 'database_entities',
  'database_entity_values', 'document_database_values'] as const
type Table = typeof tables[number]
type Row = Record<string, unknown>
const bad = (message: string): never => { throw new Error('capsule2 catalog无效：' + message + '；不修原件，不授认证或安装权。') }
const id = (value: unknown): string => isSyncedBlockId(value) ? value : bad('原始稳定身份无效')
const time = (value: unknown): void => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return bad('原日期不是可读TEXT')
}
function json(source: unknown): unknown {
  if (typeof source !== 'string') return bad('配置不是原TEXT')
  // Ordinary sync and stored-view readers use JSON.parse. Keep its accepted
  // legacy JSON spelling and duplicate-key meaning; do not turn stored source
  // into the stricter authored atom/export format or rewrite its original text.
  try { return JSON.parse(source) as unknown } catch { return bad('原JSON格式无效') }
}

/** Full actual SQL families only. This assertion supplies no catalog DTO,
 * remapping, seal or permit. Exact values/rowid occurrences remain in the raw
 * content capture. The complete source still needs all other certifier seams. */
export function assertRawCapsule2CatalogOwned(db: Database.Database): void {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return bad('要求真实readonly/query-only/FKON来源事务')
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return bad('未知来源schema')
  const expected = capsule2ApplicationColumns()
  let count = 0n, bytes = 0n
  for (const table of tables) {
    const columns = db.prepare('SELECT * FROM ' + table + ' LIMIT 0').columns().map(column => column.name)
    if (JSON.stringify([...columns].sort()) !== JSON.stringify([...(expected.get(table) ?? [])].sort())) return bad('原表列闭集变化')
    const measured = db.prepare('SELECT count(*),coalesce(sum(' + capsule2RawSqlValueBytesExpression(columns) + '),0) FROM ' + table)
      .safeIntegers(true).raw(true).get() as unknown[]
    if (typeof measured[0] !== 'bigint' || typeof measured[1] !== 'bigint' || measured[0] < 0n || measured[1] < 0n) return bad('原表预算无效')
    count += measured[0]; bytes += measured[1]
    if (count > BigInt(CAPSULE2_RAW_MAX_ROWS) || bytes > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES)) return bad('完整来源超raw准备预算，不截断')
  }
  const rows = new Map<Table, Row[]>()
  for (const table of tables) {
    const values = db.prepare('SELECT * FROM ' + table + ' ORDER BY _rowid_').all() as Row[]
    for (const row of values) {
      for (const [column, value] of Object.entries(row)) {
        const nullable = column === 'value_text' || table === 'database_entities' && column === 'document_id'
          || table === 'document_database_values' && (column === 'document_id' || column === 'entity_id')
        if (column === 'sort_order' || column === 'config_version') {
          // Store accepts finite rounded view orders outside the wire safe-int
          // range. Only classify them here; never project a rounded driver value
          // into evidence. The raw capture retains exact INTEGER/REAL cells.
          if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return bad('原排序/版本无效')
        } else if (typeof value !== 'string' && !(nullable && value === null)) return bad('原列不是TEXT/nullable存储')
        if ((column === 'id' || column.endsWith('_id')) && value !== null) id(value)
      }
      if (Object.hasOwn(row, 'created_at')) time(row.created_at)
      time(row.updated_at)
    }
    rows.set(table, values)
  }
  const definitions = (table: Table): Map<string, Row> => {
    const values = rows.get(table)!, result = new Map(values.map(row => [id(row.id), row]))
    if (result.size !== values.length) return bad('原定义身份重复')
    return result
  }
  const databases = definitions('databases'), columns = definitions('document_database_columns')
  const views = definitions('database_saved_views'), entities = definitions('database_entities')
  const setting = db.prepare("SELECT value FROM app_settings WHERE key='database.defaultId'").get() as Row | undefined
  if (!setting || !databases.has(id(setting.value))) return bad('真实默认数据库配置缺失')
  const documents = new Set((db.prepare('SELECT id FROM documents').all() as Row[]).map(row => id(row.id)))
  for (const row of [...columns.values(), ...views.values(), ...entities.values()]) {
    if (!databases.has(id(row.database_id))) return bad('定义的真实数据库来源缺失')
  }
  for (const row of columns.values()) {
    if (!['text', 'select', 'multi-select', 'checkbox', 'date'].includes(row.type as string)) return bad('未知字段类型')
    const options = json(row.options_json)
    if (!Array.isArray(options) || options.some(value => typeof value !== 'string')) return bad('字段options不是完整字符串数组')
  }
  for (const row of views.values()) {
    const config = json(row.config_json)
    if (row.config_version !== 1 || !config || typeof config !== 'object' || Array.isArray(config)) return bad('原保存视图版本/配置无效')
  }
  for (const row of entities.values()) if (row.document_id !== null && !documents.has(id(row.document_id))) return bad('实体文档缺失')
  // Use the original engine's collation, including NUL and UTF byte-length
  // semantics. Do not guess NOCASE with JS Unicode case folding or trim names.
  if (db.prepare('SELECT 1 FROM database_saved_views GROUP BY database_id,name COLLATE NOCASE HAVING count(*)>1 LIMIT 1').get())
    return bad('保存视图名字重复')
  if (db.prepare('SELECT 1 FROM database_entities WHERE document_id IS NOT NULL GROUP BY database_id,document_id HAVING count(*)>1 LIMIT 1').get())
    return bad('同来源实体文档重复')
  if (db.prepare('SELECT 1 FROM database_entity_values GROUP BY entity_id,column_id HAVING count(*)>1 LIMIT 1').get()
    || db.prepare('SELECT 1 FROM document_database_values WHERE document_id IS NOT NULL GROUP BY document_id,column_id HAVING count(*)>1 LIMIT 1').get())
    return bad('原非NULL值身份重复')
  for (const table of ['database_entity_values', 'document_database_values'] as const) for (const row of rows.get(table)!) {
    const column = columns.get(id(row.column_id))
    if (!column) return bad('值的字段定义缺失')
    if (table === 'document_database_values' && row.document_id !== null && !documents.has(id(row.document_id))) return bad('值的文档缺失')
    if (row.entity_id !== null) {
      const entity = entities.get(id(row.entity_id))
      if (!entity || entity.database_id !== column.database_id) return bad('实体值的数据库来源不一致')
    }
    // Every nullable legacy occurrence remains original data, including NULL
    // value versus no row and the two actual entity-value storage families.
    // No fieldValues map, migration, pruning or last-write selection is made.
  }
  for (const row of db.prepare("SELECT content FROM blocks WHERE type='database-view' UNION ALL SELECT content FROM synced_group_blocks WHERE type='database-view'")
    .iterate() as IterableIterator<{ content: string }>) {
    const atom = parseDatabaseViewPayload(row.content)
    if (atom.viewId !== null && views.has(atom.viewId) && views.get(atom.viewId)!.database_id !== atom.databaseId)
      return bad('物理文内视图绑定其它数据库来源')
  }
}
