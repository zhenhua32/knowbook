import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'

export interface SyncedHostHistoryBranchRow {
  id: string
  action_json: string
  before_json: string
  after_json: string
  before_hash: string
  after_hash: string
  created_at: string
}

export interface SyncedHostHistoryBranchState {
  documentId: string
  cursor: string
  position: number
}

export interface SyncedHostHistoryBranchPrune {
  discardedHistoryIds: string[]
  changedStates: SyncedHostHistoryBranchState[]
}

/** The caller must use its closed journal codec, verify both semantic hashes,
 * and prove equal, unique before/after host sets. Returning mapping-table IDs
 * instead would let a missing or extra participant silently authorize pruning. */
export type DecodeSyncedHostHistoryParticipants = (row: Readonly<SyncedHostHistoryBranchRow>) => readonly string[]

type Mapping = { history_id: string; document_id: string; position: number }
type State = { document_id: string; cursor: string; position: number }
type Chain = { state: State; rows: Mapping[] }
const opaque = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
function invalid(message: string): never { throw new Error(`宿主共享历史分支无效：${message}`) }
function ids(value: readonly string[], description: string): string[] {
  if (!Array.isArray(value) || !value.length) return invalid(`${description}为空或不是数组。`)
  const result = Array.from(value, id => opaque(id) ? id : invalid(`${description}包含无效身份。`))
  if (new Set(result).size !== result.length) return invalid(`${description}包含重复身份。`)
  return result
}
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

/** Prune only for a new, non-noop host operation. The caller owns an IMMEDIATE
 * transaction covering final-graph validation, this prune, the new host write,
 * journal and exact operation ACK. inTransaction cannot prove its lock mode.
 *
 * This helper does not commit or append a new history item. Its own savepoint
 * also restores the branch if a late SQL failure is caught by the caller.
 * Immutable journal rows, pins, bodies and old ACKs remain untouched. */
export function pruneSyncedHostRedoBranches(db: Database.Database, documentIds: readonly string[],
  decodeParticipants: DecodeSyncedHostHistoryParticipants): SyncedHostHistoryBranchPrune {
  if (!db.inTransaction) throw new Error('宿主 Redo 裁剪必须由外层 IMMEDIATE 写事务调用。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('宿主 Redo 裁剪必须启用 SQLite 外键。')
  const seeds = ids(documentIds, '新操作宿主集合')
  if (typeof decodeParticipants !== 'function') throw new Error('宿主 Redo 裁剪要求严格日志参与者解码器。')
  return db.transaction(() => {
    const chains = new Map<string, Chain>(), cuts = new Map<string, number>(), scanned = new Map<string, number>()
    const queue: string[] = [], discarded = new Map<string, Mapping[]>()
    const readState = db.prepare('SELECT document_id,cursor,position FROM synced_host_history_state WHERE document_id=?')
    const readChain = db.prepare('SELECT history_id,document_id,position FROM synced_host_history_documents WHERE document_id=? ORDER BY position')
    const readHistory = db.prepare(`SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at
      FROM synced_host_history WHERE id=?`)
    const readMembers = db.prepare('SELECT history_id,document_id,position FROM synced_host_history_documents WHERE history_id=? ORDER BY document_id')
    const chain = (documentId: string): Chain => {
      const cached = chains.get(documentId)
      if (cached) return cached
      const state = readState.get(documentId) as State | undefined
      if (!state || state.document_id !== documentId || !isSyncedUuid(state.cursor)
        || !Number.isSafeInteger(state.position) || state.position < 0) invalid('宿主状态缺失或游标无效。')
      const rows = readChain.all(documentId) as Mapping[]
      if (state.position > rows.length || rows.some((row, index) => row.document_id !== documentId
        || !isSyncedUuid(row.history_id) || row.position !== index + 1)) invalid('宿主位置链缺失或不连续。')
      const result = { state, rows }
      chains.set(documentId, result)
      return result
    }
    const cut = (documentId: string, from: number) => {
      const current = chain(documentId)
      if (!Number.isSafeInteger(from) || from <= current.state.position) invalid('不能裁剪已经执行的共享历史。')
      if (from > current.rows.length) return
      if (from < (cuts.get(documentId) ?? Infinity)) { cuts.set(documentId, from); queue.push(documentId) }
    }
    for (const documentId of seeds) {
      const current = chain(documentId)
      // With no Redo there is no branch mutation, even at the largest position.
      if (current.state.position < current.rows.length) cut(documentId, current.state.position + 1)
    }
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const documentId = queue[cursor], current = chain(documentId), from = cuts.get(documentId)!
      const previousFrom = scanned.get(documentId) ?? current.rows.length + 1
      if (from >= previousFrom) continue
      scanned.set(documentId, from)
      for (const entry of current.rows.slice(from - 1, previousFrom - 1)) {
        if (discarded.has(entry.history_id)) continue
        const row = readHistory.get(entry.history_id) as SyncedHostHistoryBranchRow | undefined
        if (!row || row.id !== entry.history_id || Object.values(row).some(value => typeof value !== 'string')) {
          invalid('共享日志原文缺失或无效。')
        }
        const declared = new Set(ids(decodeParticipants(Object.freeze({ ...row })), '可信日志参与者集合'))
        const members = readMembers.all(entry.history_id) as Mapping[]
        if (members.length !== declared.size || members.some(member => !declared.has(member.document_id))) {
          invalid('共享日志映射与可信两侧参与者不一致。')
        }
        for (const member of members) {
          const owner = chain(member.document_id)
          if (!Number.isSafeInteger(member.position) || member.position <= owner.state.position
            || owner.rows[member.position - 1]?.history_id !== entry.history_id) {
            invalid('共享项并非所有宿主均已撤销，不能裁剪。')
          }
        }
        discarded.set(entry.history_id, members)
        for (const member of members) cut(member.document_id, member.position)
      }
    }
    if (!discarded.size) return { discardedHistoryIds: [], changedStates: [] }
    const discardedHistoryIds = [...discarded.keys()].sort(compare)
    const expectedCount = [...discarded.values()].reduce((count, members) => count + members.length, 0)
    const removed = db.prepare('DELETE FROM synced_host_history_documents WHERE history_id IN (SELECT value FROM json_each(?))')
      .run(JSON.stringify(discardedHistoryIds)).changes
    if (removed !== expectedCount) invalid('裁剪前共享映射发生变化。')
    const changedStates: SyncedHostHistoryBranchState[] = []
    const updateState = db.prepare(`UPDATE synced_host_history_state SET cursor=?
      WHERE document_id=? AND cursor=? AND position=?`)
    for (const documentId of [...cuts.keys()].sort(compare)) {
      const before = chain(documentId), expected = before.rows.slice(0, cuts.get(documentId)! - 1)
      if (JSON.stringify(readChain.all(documentId)) !== JSON.stringify(expected)) invalid('裁剪后宿主位置链不再是完整前缀。')
      let nextCursor: string
      do { nextCursor = randomUUID() } while (nextCursor === before.state.cursor)
      if (updateState.run(nextCursor, documentId, before.state.cursor, before.state.position).changes !== 1) {
        invalid('裁剪前宿主游标或位置发生变化。')
      }
      changedStates.push({ documentId, cursor: nextCursor, position: before.state.position })
    }
    return { discardedHistoryIds, changedStates }
  })()
}
