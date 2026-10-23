import type Database from 'better-sqlite3'
import { isSyncedBlockId, isSyncedUuid, syncedPlainRecord, validatePersistedHostForest } from '../../shared/syncedBlockValidation'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { parseInitialIncomingStored } from '../sync/synced-initial-incoming-model'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2ApplicationColumns,
  capsule2RawSqlValueBytesExpression } from './restore-knowledge-capsule2-raw-model'

type Row = Record<string, unknown>
type Side = { documents: Map<string, SyncedStableBlockDraft[]>; owners: Map<string, string> }
const bad = (message: string): never => { throw new Error('capsule2 move history无效：' + message + '；不修原件，不授认证或安装权。') }
const id = (value: unknown): string => isSyncedBlockId(value) ? value : bad('原稳定身份无效')
const text = (value: unknown): string => typeof value === 'string' ? value : bad('原字段不是TEXT')
function shape(value: unknown, keys: readonly string[]): asserts value is Row {
  if (!syncedPlainRecord(value) || keys.length !== Object.keys(value).length || keys.some(key => !Object.hasOwn(value, key))) return bad('原快照字段闭集变化')
}
function time(value: unknown): void {
  if (!Number.isFinite(Date.parse(text(value)))) return bad('原日期无效')
}
function json(value: unknown): unknown {
  try { return parseInitialIncomingStored(text(value)) } catch { return bad('原JSON格式无效') }
}
function side(value: unknown): Side {
  if (!Array.isArray(value) || !value.length) return bad('原side不是非空数组')
  const documents = new Map<string, SyncedStableBlockDraft[]>(), owners = new Map<string, string>()
  for (const item of value) {
    shape(item, ['documentId', 'path', 'updatedAt', 'content'])
    const key = id(item.documentId)
    if (documents.has(key)) return bad('原参与文档重复')
    // A historical route is literal TEXT. Old astral-prefix SQL produced empty,
    // repeated and noncanonical paths; none is a filesystem or title authority.
    text(item.path); time(item.updatedAt)
    shape(item.content, ['title', 'summary', 'blocks'])
    const title = text(item.content.title)
    if (!title || title !== title.trim() || title === '.' || title === '..' || /[\\/\x00-\x1f]/.test(title)) return bad('原普通标题无效')
    text(item.content.summary)
    let blocks: SyncedStableBlockDraft[]
    try { blocks = validatePersistedHostForest(item.content.blocks) } catch { return bad('原完整块forest损坏') }
    documents.set(key, blocks)
    for (const block of blocks) {
      if (owners.has(block.id)) return bad('原同侧物理身份重复')
      owners.set(block.id, key)
    }
  }
  return { documents, owners }
}
function contiguous(blocks: SyncedStableBlockDraft[], ids: string[]): boolean {
  const start = blocks.findIndex(block => block.id === ids[0])
  return start >= 0 && ids.every((id, index) => blocks[start + index]?.id === id)
}

/** Complete actual move family, within the readonly source owner and original
 * SQL budget. Frozen sides and later undo/redo guards are independent: never
 * compare their timestamps, routes or participants to today's live documents.
 * This assertion creates no replay DTO, host ACK, root or install permission. */
export function assertRawCapsule2MovesOwned(db: Database.Database): void {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return bad('要求真实readonly/query-only/FKON来源事务')
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return bad('未知来源schema')
  const columns = db.prepare('SELECT * FROM document_block_moves LIMIT 0').columns().map(column => column.name)
  if (JSON.stringify([...columns].sort()) !== JSON.stringify([...(capsule2ApplicationColumns().get('document_block_moves') ?? [])].sort())) return bad('原表列闭集变化')
  const measured = db.prepare('SELECT count(*),coalesce(sum(' + capsule2RawSqlValueBytesExpression(columns) + '),0) FROM document_block_moves')
    .safeIntegers(true).raw(true).get() as unknown[]
  if (typeof measured[0] !== 'bigint' || typeof measured[1] !== 'bigint' || measured[0] < 0n || measured[1] < 0n
    || measured[0] > BigInt(CAPSULE2_RAW_MAX_ROWS) || measured[1] > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES)) return bad('完整来源超raw准备预算，不截断')
  for (const row of db.prepare('SELECT * FROM document_block_moves ORDER BY _rowid_').all() as Row[]) {
    if (!isSyncedUuid(row.id) || row.state !== 'applied' && row.state !== 'undone') return bad('原移动身份/状态无效')
    const source = id(row.source_document_id), target = id(row.target_document_id)
    if (source === target) return bad('原移动两端相同')
    time(row.created_at); time(row.updated_at)
    const rawIds = json(row.moved_ids_json)
    if (!Array.isArray(rawIds) || !rawIds.length) return bad('原移动身份闭集无效')
    const ids = rawIds.map(id), moved = new Set(ids)
    if (moved.size !== ids.length) return bad('原移动身份重复')
    const before = side(json(row.before_json)), after = side(json(row.after_json)), expected = json(row.expected_versions_json)
    if (!before.documents.has(source) || !before.documents.has(target) || before.documents.size !== after.documents.size
      || [...before.documents.keys()].some(key => !after.documents.has(key)) || !syncedPlainRecord(expected)
      || Object.keys(expected).length !== before.documents.size || Object.keys(expected).some(key => !before.documents.has(key))) return bad('原完整参与者/版本闭集损坏')
    Object.values(expected).forEach(time)
    if (!contiguous(before.documents.get(source)!, ids) || !contiguous(after.documents.get(target)!, ids)
      || ids.some(key => before.owners.get(key) !== source || after.owners.get(key) !== target)) return bad('原移动顺序/归属损坏')
    for (const [key, owner] of before.owners) {
      const next = after.owners.get(key)
      if (!next || !moved.has(key) && next !== owner) return bad('原未声明删除/跨宿主迁移')
    }
    const added = [...after.owners.keys()].filter(key => !before.owners.has(key))
    if (added.length) {
      const replacement = after.documents.get(source)!
      // The ordinary Store creates one empty paragraph only when moving the
      // complete source body. All original IDs still survive at their owners.
      if (before.documents.get(source)!.length !== ids.length || added.length !== 1 || replacement.length !== 1
        || replacement[0].id !== added[0] || replacement[0].type !== 'paragraph' || replacement[0].content !== ''
        || replacement[0].depth !== 0 || replacement[0].parentBlockId !== null) return bad('原新增身份不属于空来源占位')
    }
  }
}
