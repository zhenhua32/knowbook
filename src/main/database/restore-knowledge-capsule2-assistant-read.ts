import type Database from 'better-sqlite3'
import { ASSISTANT_EVENT_SURFACES, assistantSessionId, type AssistantEventType } from '../../shared/assistant-session'
import type { PluginJsonValue } from '../../shared/plugin-platform'
import { assertAssistantEventPayload, assertAssistantSessionTransition, projectAssistantSessionState,
  type AssistantReplayState } from '../assistant/session-repository'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2ApplicationColumns,
  capsule2RawSqlValueBytesExpression } from './restore-knowledge-capsule2-raw-model'

type Row = Record<string, unknown>
const bad = (message: string): never => { throw new Error('capsule2 assistant history无效：' + message + '；不修原件，不恢复会话或授予approval/执行/安装权。') }
const text = (value: unknown): string => typeof value === 'string' ? value : bad('原字段不是TEXT')
const id = (value: unknown): string => { const raw = text(value); return raw.trim() ? raw : bad('原身份为空') }
const nullable = (value: unknown): string | null => value === null ? null : text(value)
const integer = (value: unknown, minimum: number): number => typeof value === 'bigint' && value >= BigInt(minimum)
  && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : bad('原序列不是准确安全INTEGER')
function time(value: unknown): string {
  const raw = text(value)
  if (!Number.isFinite(Date.parse(raw))) return bad('原事件或会话日期无效')
  return raw
}
function json(value: unknown): PluginJsonValue {
  // Stored Main reads use JSON.parse. Keep legacy spelling and last-key
  // meaning after the complete SQL byte preflight, independently of authored
  // JSON complexity/key restrictions; the original TEXT is never rewritten.
  try { return JSON.parse(text(value)) as PluginJsonValue }
  catch { return bad('原JSON格式损坏') }
}
function sameStoredJson(left: PluginJsonValue, right: PluginJsonValue): boolean {
  const pending: Array<[PluginJsonValue, PluginJsonValue]> = [[left, right]]
  while (pending.length) {
    const [a, b] = pending.pop()!
    if (a === b) continue
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false
      for (let index = 0; index < a.length; index++) pending.push([a[index], b[index]])
    } else {
      if (Array.isArray(b)) return false
      const keys = Object.keys(a)
      if (keys.length !== Object.keys(b).length) return false
      for (const key of keys) {
        if (!Object.hasOwn(b, key)) return false
        pending.push([a[key], b[key]])
      }
    }
  }
  return true
}

/** The complete actual assistant family, independently bounded before reading
 * rows. Reuses the writer's pure payload/transition/projection rules, never the
 * repository constructor, paginated getters or recoverInterruptedSessions.
 * Pending approvals and crash-left active turns remain historical data. No
 * timestamps/IDs/JSON are normalized and no authoring page/JSON cap truncates
 * the stored source. This is one family assertion, not a capsule certificate. */
export function assertRawCapsule2AssistantHistoryOwned(db: Database.Database): void {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return bad('要求真实readonly/query-only/FKON来源事务')
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return bad('仅准确schema26/27')
  const application = capsule2ApplicationColumns()
  let totalRows = 0n, totalBytes = 0n
  for (const table of ['assistant_sessions', 'assistant_events']) {
    const columns = application.get(table)!
    const actual = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>
    if (actual.length !== columns.length || actual.some((column, index) => column.name !== columns[index])) return bad('原助手表列闭集变化')
    const cost = capsule2RawSqlValueBytesExpression(columns)
    const measured = db.prepare('SELECT count(*),COALESCE(sum(' + cost + '),0) FROM ' + table).safeIntegers(true).raw(true).get() as unknown[]
    if (typeof measured[0] !== 'bigint' || typeof measured[1] !== 'bigint' || measured[0] < 0n || measured[1] < 0n) return bad('原完整表预算无效')
    totalRows += measured[0]; totalBytes += measured[1]
    if (totalRows > BigInt(CAPSULE2_RAW_MAX_ROWS) || totalBytes > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES)) return bad('完整助手family超来源预算，不能分页或截断')
  }
  const sessions = db.prepare('SELECT * FROM assistant_sessions ORDER BY id').safeIntegers(true).all() as Row[]
  const events = db.prepare('SELECT * FROM assistant_events ORDER BY session_id,seq').safeIntegers(true).all() as Row[]
  const bySession = new Map<string, Row[]>(), eventIds = new Set<string>()
  for (const row of sessions) {
    const key = id(row.id)
    if (bySession.has(key)) return bad('原会话身份重复')
    bySession.set(key, [])
  }
  for (const row of events) {
    const key = id(row.id), owner = bySession.get(id(row.session_id))
    if (!owner || eventIds.has(key)) return bad('原事件孤立或身份重复')
    eventIds.add(key); owner.push(row)
  }
  for (const row of sessions) {
    const sessionId = id(row.id), workspace = id(row.workspace_id), activeDocument = nullable(row.active_document_id)
    const createdAt = time(row.created_at), updatedAt = time(row.updated_at), config = json(row.model_config_json)
    const nextSeq = integer(row.next_seq, 2), own = bySession.get(sessionId)!
    if (!own.length || own.length !== nextSeq - 1) return bad('完整事件尾与next_seq不相等或缺初始事件')
    let state: AssistantReplayState | undefined
    for (const [index, saved] of own.entries()) {
      if (integer(saved.seq, 1) !== index + 1) return bad('原事件序列不连续')
      const type = text(saved.type)
      if (!Object.hasOwn(ASSISTANT_EVENT_SURFACES, type)) return bad('未知原事件type')
      const eventType = type as AssistantEventType
      if (text(saved.surface) !== ASSISTANT_EVENT_SURFACES[eventType]) return bad('原事件surface不符')
      const payload = json(saved.payload_json)
      try { assertAssistantEventPayload(eventType, payload) }
      catch { return bad('原事件payload不符合已知完整格式') }
      const candidate = payload as Record<string, PluginJsonValue>
      if (nullable(saved.turn_id) !== (typeof candidate.turnId === 'string' ? candidate.turnId : null)
        || nullable(saved.step_id) !== (typeof candidate.stepId === 'string' ? candidate.stepId : null)) return bad('原事件turn/step索引不符payload')
      const at = time(saved.created_at)
      if (index === 0) {
        const firstKeys = ['title', 'workspaceId', 'activeDocumentId', 'modelConfig']
        if (eventType !== 'session.created' || Object.keys(candidate).length !== firstKeys.length || firstKeys.some(key => !Object.hasOwn(candidate, key))
          || candidate.workspaceId !== workspace
          || candidate.activeDocumentId !== null && typeof candidate.activeDocumentId !== 'string'
          || activeDocument !== null && activeDocument !== candidate.activeDocumentId
          || !sameStoredJson(candidate.modelConfig, config) || at !== createdAt) return bad('初始会话事实与原来源不符')
        // ON DELETE SET NULL may erase the live document pointer. The original
        // event identity stays literal even if that document is later restored.
        state = { id: assistantSessionId(sessionId), title: candidate.title as string, status: 'active', activeTurnId: null }
      } else {
        if (eventType === 'session.created' || !state) return bad('原初始事件重复或缺失')
        try { assertAssistantSessionTransition(state, eventType, payload) }
        catch { return bad('原会话转换不符合完整事件顺序') }
        state = projectAssistantSessionState(state, eventType, payload)
      }
      if (index === own.length - 1 && at !== updatedAt) return bad('完整事件尾与会话updated_at不符')
    }
    if (!state || text(row.title) !== state.title || text(row.status) !== state.status || nullable(row.active_turn_id) !== state.activeTurnId)
      return bad('完整原事件投影与会话状态不符')
  }
}
