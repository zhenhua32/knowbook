import type Database from 'better-sqlite3'
import { assertPersistedTemplateForest, isSyncedBlockId } from '../../shared/syncedBlockValidation'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2ApplicationColumns,
  capsule2RawSqlValueBytesExpression } from './restore-knowledge-capsule2-raw-model'

type Row = Record<string, unknown>
const bad = (message: string): never => { throw new Error('capsule2 template无效：' + message + '；不修原件，不授认证或安装权。') }
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return bad('原模板TEXT字段格式/长度无效')
  return value
}

/** Full actual saved-template family. These are independently stored drafts,
 * not live documents, group/instance facts or ledger reservations. Variable
 * strings and unresolved references remain literal in the raw SQL capture. */
export function assertRawCapsule2TemplatesOwned(db: Database.Database): void {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return bad('要求真实readonly/query-only/FKON来源事务')
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return bad('未知来源schema')
  const columns = db.prepare('SELECT * FROM document_templates LIMIT 0').columns().map(column => column.name)
  const expected = capsule2ApplicationColumns().get('document_templates')!
  if (JSON.stringify([...columns].sort()) !== JSON.stringify([...expected].sort())) return bad('原表列闭集变化')
  const measured = db.prepare('SELECT count(*),coalesce(sum(' + capsule2RawSqlValueBytesExpression(columns) + '),0) FROM document_templates')
    .safeIntegers(true).raw(true).get() as unknown[]
  if (typeof measured[0] !== 'bigint' || typeof measured[1] !== 'bigint' || measured[0] < 0n || measured[1] < 0n
    || measured[0] > BigInt(CAPSULE2_RAW_MAX_ROWS) || measured[1] > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES)) return bad('完整来源超raw准备预算或预算无效，不截断')
  const ids = new Set<string>()
  for (const row of db.prepare('SELECT * FROM document_templates ORDER BY _rowid_').all() as Row[]) {
    const key = text(row.id, 200), name = text(row.name, 200), description = text(row.description, 2000)
    if (!isSyncedBlockId(key) || ids.has(key)) return bad('原模板身份缺失/重复')
    ids.add(key)
    if (!name || name !== name.trim() || description !== description.trim()) return bad('原模板名称/说明未按存储格式保存')
    // These limits belong to the real template writer since its introduction,
    // not the publication document-title limit. Title/summary are not trimmed.
    text(row.title, 500); text(row.summary, 100_000)
    if (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return bad('原模板时间无效')
    if (typeof row.blocks_json !== 'string') return bad('原模板正文不是TEXT')
    let blocks: unknown
    try { blocks = JSON.parse(row.blocks_json) as unknown } catch { return bad('原模板JSON损坏') }
    if (!Array.isArray(blocks) || blocks.length > 10_000) return bad('原模板块数组/数量无效')
    try { assertPersistedTemplateForest(blocks) } catch { return bad('原模板完整forest/atom损坏') }
    let contentLength = 0
    for (const block of blocks as Row[]) {
      text(block.id, 200); text(block.type, 100)
      contentLength += text(block.content, 4_000_000).length
      if (contentLength > 4_000_000) return bad('原模板正文总长度无效')
      if (block.parentBlockId !== null) text(block.parentBlockId, 200)
      if (block.language !== undefined) text(block.language, 200)
      if (block.highlight !== undefined) text(block.highlight, 100)
      if (block.listStart !== undefined && (block.listStart as number) < 1) return bad('原模板列表起点无效')
      // Tags/codeInfo have their real writer rules, including literal NUL in
      // these strings; do not apply templateText() to fields it never owned.
      if (block.tags !== undefined && ((block.tags as string[]).length > 200 || (block.tags as string[]).some(tag => tag.length > 200))) return bad('原模板标签数量/长度无效')
    }
  }
}
