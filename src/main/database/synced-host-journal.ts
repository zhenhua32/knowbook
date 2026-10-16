import { createHash } from 'node:crypto'
import type { SyncedOriginV1, SyncedStructureInput } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { validateSyncedStructureInput } from '../../shared/syncedBlockInputs'
import { assertSyncedShape, syncedPlainRecord, isSyncedBlockId, isSyncedUuid, parseSyncedBlockPayload, validateSyncedHostForest, validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { hostJson, hostTime, type HostContent } from './synced-host-document-read'
import { hasSyncedInsertWorkingStructure, isHostInsertInput, planSyncedHostInsert, type HostInsertInput } from './synced-host-insert-plan'

export type HostFinalInput = Extract<SyncedStructureInput, { mode: 'host-final' }>
export interface HostSide { documentId: string; content: HostContent }
export interface HostBirth { documentId: string; blockId: string; createdAt: string }
export interface HostGroupDependency { groupId: string; creationId: string; createdAt: string; origin: SyncedOriginV1 }
export interface HostJournal {
  input: HostFinalInput | HostInsertInput; persisted: Array<HostSide & { updatedAt: string }>; births: HostBirth[]; groups: HostGroupDependency[]
  before: HostSide[]; after: HostSide[]
}
export type HostFinalJournal = HostJournal & { input: HostFinalInput }
export const hostEncode = canonicalSyncedPortableJson
export const hostHash = (value: unknown): string => createHash('sha256').update(hostEncode(value)).digest('hex')
export const hostEqual = (left: unknown, right: unknown): boolean => hostEncode(left) === hostEncode(right)
const bad = (): never => { throw new Error('宿主结构日志原文、身份或完整语义哈希无效；不会猜测历史参与者。') }
const opaque = (value: unknown): string => isSyncedBlockId(value) ? value : bad()
const uuid = (value: unknown): string => isSyncedUuid(value) ? value : bad()
function list<T>(value: unknown, read: (item: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value)) return bad()
  const result = value.map(read)
  if (new Set(result.map(key)).size !== result.length) return bad()
  return result
}
export function validateHostContent(value: unknown): HostContent {
  assertSyncedShape(value, ['title', 'summary', 'blocks'])
  if (typeof value.title !== 'string' || typeof value.summary !== 'string') return bad()
  return { title: value.title, summary: value.summary, blocks: validateSyncedHostForest(value.blocks) }
}
export function validateHostSides(value: unknown): HostSide[] {
  return list(value, raw => {
    assertSyncedShape(raw, ['documentId', 'content'])
    return { documentId: opaque(raw.documentId), content: validateHostContent(raw.content) }
  }, item => item.documentId)
}
export function hostReferencedGroups(sides: readonly HostSide[]): Set<string> {
  return new Set(sides.flatMap(side => side.content.blocks.filter(block => block.type === 'synced-block').map(block => parseSyncedBlockPayload(block.content).groupId)))
}
export function hostJournalKind(row: Readonly<SyncedHostHistoryBranchRow>): 'host-final' | 'host-command' | 'bare-create' {
  const action = hostJson(row.action_json)
  if (syncedPlainRecord(action) && action.kind === 'create') {
    assertSyncedShape(action, ['kind', 'documentId', 'selectedRootIds', 'groupId', 'instanceId'])
    opaque(action.documentId); uuid(action.groupId); uuid(action.instanceId)
    if (!Array.isArray(action.selectedRootIds) || !action.selectedRootIds.length
      || action.selectedRootIds.some(id => !isSyncedBlockId(id)) || new Set(action.selectedRootIds).size !== action.selectedRootIds.length) return bad()
    return 'bare-create'
  }
  // Full new-branch validation, including side/hash/participant closure, belongs
  // to the decoder. A legacy bare create is recognized but never reinterpreted.
  return syncedPlainRecord(action) && action.kind === 'host-command' ? 'host-command' : 'host-final'
}
/** Storage has one explicit empty-tag representation; no authored text or
 * nonempty metadata is changed by this comparison. Hashes retain the exact DTO. */
export function sameHostContent(left: HostContent, right: HostContent): boolean {
  const physical = (content: HostContent) => ({ ...content, blocks: content.blocks.map(block => ({ ...block, tags: block.tags ?? [] })) })
  return hostEqual(physical(left), physical(right))
}
const matchingHosts = (left: readonly HostSide[], right: readonly HostSide[]) => {
  const ids = new Set(right.map(item => item.documentId))
  return left.length === right.length && left.every(item => ids.has(item.documentId))
}

/** Finite executable branches share side/birth/incarnation validation. The
 * original bare-create lifecycle action remains a separate, unsupported format. */
export function decodeHostJournal(row: Readonly<SyncedHostHistoryBranchRow>): HostJournal {
  try {
    if (!isSyncedUuid(row.id)) return bad()
    hostTime(row.created_at)
    const action = hostJson(row.action_json)
    assertSyncedShape(action, ['kind', 'version', 'input', 'persisted', 'births', 'groups'])
    if (action.version !== 1) return bad()
    const parsed = validateSyncedStructureInput(action.input)
    let input: HostFinalInput | HostInsertInput
    if (action.kind === 'host-final' && parsed.mode === 'host-final') input = parsed
    else if (action.kind === 'host-command' && isHostInsertInput(parsed)) input = parsed
    else return bad()
    const before = validateHostSides(hostJson(row.before_json)), after = validateHostSides(hostJson(row.after_json))
    if (!before.length || !matchingHosts(before, after) || !/^[a-f0-9]{64}$/.test(row.before_hash)
      || !/^[a-f0-9]{64}$/.test(row.after_hash) || hostHash(before) !== row.before_hash || hostHash(after) !== row.after_hash) return bad()
    const plannedAfter = input.mode === 'host-final' ? input.finalAfter.map(({ documentId, ...content }) => ({ documentId, content }))
      : [{ documentId: input.action.target.documentId, content: planSyncedHostInsert(input) }]
    if (!hostEqual(before, input.hostsWorkingBefore.map(host => ({ documentId: host.documentId, content: host.workingBefore })))
      || !hostEqual(after, plannedAfter)) return bad()
    const persisted = list(action.persisted, raw => {
      assertSyncedShape(raw, ['documentId', 'updatedAt', 'content'])
      return { documentId: opaque(raw.documentId), updatedAt: hostTime(raw.updatedAt), content: validateHostContent(raw.content) }
    }, item => item.documentId)
    const persistedById = new Map(persisted.map(item => [item.documentId, item]))
    if (!matchingHosts(before, persisted) || input.hostsWorkingBefore.some(host => persistedById.get(host.documentId)?.updatedAt !== host.expectedPersistedUpdatedAt)) return bad()
    if (input.mode === 'command' && !hasSyncedInsertWorkingStructure(persisted[0].content, before[0].content)) return bad()
    const births = list(action.births, raw => {
      assertSyncedShape(raw, ['documentId', 'blockId', 'createdAt'])
      return { documentId: opaque(raw.documentId), blockId: opaque(raw.blockId), createdAt: hostTime(raw.createdAt) }
    }, item => item.blockId)
    const neededBirths = new Map<string, string>()
    for (const side of [...before, ...after]) for (const block of side.content.blocks) {
      const old = neededBirths.get(block.id)
      if (old !== undefined && old !== side.documentId) return bad()
      neededBirths.set(block.id, side.documentId)
    }
    if (births.length !== neededBirths.size || births.some(item => neededBirths.get(item.blockId) !== item.documentId)) return bad()
    const groups = list(action.groups, raw => {
      assertSyncedShape(raw, ['groupId', 'creationId', 'createdAt', 'origin'])
      return { groupId: uuid(raw.groupId), creationId: uuid(raw.creationId), createdAt: hostTime(raw.createdAt), origin: validateSyncedOrigin(raw.origin) }
    }, item => item.groupId)
    const required = hostReferencedGroups([...before, ...after])
    if (groups.length !== required.size || groups.some(item => !required.has(item.groupId))) return bad()
    return { input, persisted, births, groups, before, after }
  } catch (cause) { throw new Error('宿主结构日志损坏或是不受支持的日志格式，未执行或裁剪。', { cause }) }
}
export function decodeHostFinalJournal(row: Readonly<SyncedHostHistoryBranchRow>): HostFinalJournal {
  const journal = decodeHostJournal(row)
  if (journal.input.mode !== 'host-final') return bad()
  return { ...journal, input: journal.input }
}
export function encodeHostJournal(journal: HostJournal): { action: string; before: string; after: string; beforeHash: string; afterHash: string } {
  return { action: hostEncode({ kind: journal.input.mode === 'host-final' ? 'host-final' : 'host-command', version: 1,
    input: journal.input, persisted: journal.persisted, births: journal.births, groups: journal.groups }),
    before: hostEncode(journal.before), after: hostEncode(journal.after), beforeHash: hostHash(journal.before), afterHash: hostHash(journal.after) }
}
export function encodeHostFinalJournal(journal: HostFinalJournal): ReturnType<typeof encodeHostJournal> { return encodeHostJournal(journal) }
