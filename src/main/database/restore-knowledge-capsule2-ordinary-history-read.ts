import type Database from 'better-sqlite3'
import { isSyncedBlockId, syncedPlainRecord, validatePersistedHostForest } from '../../shared/syncedBlockValidation'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2ApplicationColumns,
  capsule2RawSqlValueBytesExpression } from './restore-knowledge-capsule2-raw-model'

type Row = Record<string, unknown>
const bad = (message: string): never => { throw new Error('capsule2 ordinary history无效：' + message + '；不修原件，不授认证或安装权。') }
const id = (value: unknown): string => isSyncedBlockId(value) ? value : bad('原稳定身份无效')
function shape(value: unknown, keys: readonly string[]): asserts value is Row {
  if (!syncedPlainRecord(value) || keys.length !== Object.keys(value).length || keys.some(key => !Object.hasOwn(value, key))) return bad('原快照字段闭集变化')
}
function text(value: unknown): string { return typeof value === 'string' ? value : bad('原字段不是TEXT') }
function time(value: unknown): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return bad('原日期无效')
}
function title(value: unknown): string {
  const result = text(value)
  // Match the actual ordinary writer: C0 and separators are invalid; DEL is
  // preserved. This source assertion is separate from publication title rules.
  if (!result || result !== result.trim() || result === '.' || result === '..' || /[\\/\x00-\x1f]/.test(result)) return bad('原普通标题无效')
  return result
}
function json(value: unknown): unknown {
  const source = text(value)
  try { return JSON.parse(source) as unknown } catch { return bad('原JSON格式无效') }
}
function content(value: unknown): { title: string; summary: string; blocks: SyncedStableBlockDraft[] } {
  shape(value, ['title', 'summary', 'blocks'])
  const title = text(value.title), summary = text(value.summary)
  // Complete SQL bytes were bounded before JSON.parse. Preserve ordinary
  // history beyond the authored host count without relaxing its forest rules.
  try { return { title, summary, blocks: validatePersistedHostForest(value.blocks) } } catch { return bad('原正文/块forest损坏') }
}
function values(value: unknown): void {
  if (!Array.isArray(value)) return bad('原归档字段值不是数组')
  const columns = new Set<string>()
  for (const item of value) {
    shape(item, ['column_id', 'value_text'])
    const column = id(item.column_id)
    if (columns.has(column)) return bad('原归档字段列重复')
    columns.add(column)
    if (item.value_text !== null) text(item.value_text)
  }
}

/** Assert complete actual ordinary checkpoint/trash families. Historical
 * parents, field definitions, entities and groups may no longer be live.
 * Their literal source values stay in the raw capture; this mints no DTO,
 * seal, resolved root or installation permission. Templates remain separate. */
export function assertRawCapsule2OrdinaryHistoryOwned(db: Database.Database): void {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return bad('要求真实readonly/query-only/FKON来源事务')
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return bad('未知来源schema')
  const tables = ['document_history', 'document_trash'] as const, expected = capsule2ApplicationColumns()
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
  for (const row of db.prepare('SELECT * FROM document_history ORDER BY _rowid_').all() as Row[]) {
    id(row.id); id(row.document_id); text(row.path); time(row.created_at)
    if (!['edit', 'restore', 'delete', 'move'].includes(text(row.reason))) return bad('未知checkpoint原因')
    const body = content(json(row.content_json))
    if (title(row.title) !== body.title) return bad('原checkpoint标题与正文不一致')
  }
  for (const row of db.prepare('SELECT * FROM document_trash ORDER BY _rowid_').all() as Row[]) {
    const key = id(row.id)
    title(row.title); text(row.path); time(row.deleted_at)
    const saved = json(row.snapshot_json)
    shape(saved, ['document', 'content', 'values', 'entities'])
    const document = saved.document
    shape(document, ['id', 'title', 'slug', 'parent_id', 'path', 'summary', 'sort_order', 'created_at', 'updated_at'])
    if (id(document.id) !== key || document.parent_id !== null && id(document.parent_id) === key) return bad('原回收站文档归属/父身份损坏')
    id(document.slug); time(document.created_at); time(document.updated_at)
    if (typeof document.sort_order !== 'number' || !Number.isSafeInteger(document.sort_order)) return bad('原普通文档排序不是safe signed整数')
    const body = content(saved.content)
    if (title(document.title) !== row.title || document.title !== body.title || text(document.summary) !== body.summary
      || text(document.path) !== row.path) return bad('原回收站文档/正文/元数据不一致')
    values(saved.values)
    if (!Array.isArray(saved.entities)) return bad('原归档实体不是数组')
    const entities = new Set<string>()
    for (const entity of saved.entities) {
      shape(entity, ['id', 'database_id', 'title', 'created_at', 'values'])
      const entityId = id(entity.id)
      if (entities.has(entityId)) return bad('原归档实体身份重复')
      entities.add(entityId)
      id(entity.database_id); text(entity.title); time(entity.created_at); values(entity.values)
    }
  }
}
