import { createHash } from 'node:crypto'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { isSyncedBlockId, isSyncedUuid, validateSyncedGroupWire, validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'

export const RECOVERY_BOUNDARY_PREFIX = 'synced.recovery.history.v1.'
export const RECOVERY_EPOCH_PREFIX = 'synced:recovery-epoch:v1:'
export const RECOVERY_BOUNDARY_CHANNEL = 'recovery-history-boundary-v1'
export interface SyncedRecoveryGroupHistoryRow {
  id: string; group_id: string; position: number; before_json: string; after_json: string
  before_hash: string; after_hash: string; created_at: string
}
export interface SyncedRecoveryGroupGuard { revision: string; topologyRevision: string; historyCursor: string; historyPosition: number }
export interface SyncedRecoveryGroupArchive {
  groupId: string; creationId: string; createdAt: string; originJson: string
  disposition: 'active' | 'retired-evidence' | 'deleted-evidence'
  before: SyncedRecoveryGroupGuard; after: SyncedRecoveryGroupGuard & { historyPosition: 0 }
  rows: SyncedRecoveryGroupHistoryRow[]
}
export interface SyncedRecoveryHostCut {
  historyToken: string; journalHash: string; documentIds: string[]
  mappings: Array<{ documentId: string; position: number }>
}
export interface SyncedRecoveryHistoryBoundary {
  kind: 'synced-recovery-history-boundary'; version: 1; operationId: string; workspaceScope: string
  beforeEpoch: string; afterEpoch: string; acceptedAt: string; documentBoundary: string
  documents: Array<{ documentId: string; beforeUpdatedAt: string; afterUpdatedAt: string }>
  hosts: Array<{ documentId: string; beforeCursor: string; beforePosition: number; afterCursor: string }>
  hostCuts: SyncedRecoveryHostCut[]; groups: SyncedRecoveryGroupArchive[]
  instances: Array<{ instanceId: string; groupId: string; hostDocumentId: string; beforeBindingVersion: string; afterBindingVersion: string }>
  retainedOperations: Array<{ operationId: string; rowHash: string }>
  retainedPins: Array<{ groupId: string; kind: string; pinId: string; createdAt: string }>
}
export interface SyncedRecoveryEpochReceipt {
  kind: 'synced-recovery-epoch'; version: 1; operationId: string; workspaceScope: string
  beforeEpoch: string; afterEpoch: string; boundaryHash: string; acceptedAt: string
}
export interface SyncedRecoveryOperationRow { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
export function recoveryBoundaryInvalid(message: string): never { throw new Error('同步恢复历史边界损坏：' + message + '；不会修复或授予执行权。') }
export const recoveryBoundaryJson = canonicalSyncedPortableJson
const hash = (value: unknown): string => createHash('sha256').update(recoveryBoundaryJson(value)).digest('hex')
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const uuid = (value: unknown): string => isSyncedUuid(value) ? value : recoveryBoundaryInvalid('UUID无效')
const opaque = (value: unknown): string => isSyncedBlockId(value) ? value : recoveryBoundaryInvalid('原身份无效')
const text = (value: unknown): string => typeof value === 'string' ? value : recoveryBoundaryInvalid('原SQL字符串无效')
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : recoveryBoundaryInvalid('SHA256无效')
const time = (value: unknown): string => typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value)) ? value : recoveryBoundaryInvalid('原时点无效')
const integer = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : recoveryBoundaryInvalid('历史位置无效')

function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) return recoveryBoundaryInvalid('记录不是闭形普通对象')
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) return recoveryBoundaryInvalid('记录字段不闭合')
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return recoveryBoundaryInvalid('记录含访问器或缺字段')
  }
}
function list<T>(value: unknown, read: (raw: unknown) => T): T[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return recoveryBoundaryInvalid('集合含空洞或额外字段')
  const result: T[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return recoveryBoundaryInvalid('集合含访问器或空洞')
    result.push(read(descriptor.value))
  }
  return result
}
function ordered<T>(rows: T[], key: (value: T) => string): T[] {
  for (let index = 1; index < rows.length; index++) if (compare(key(rows[index - 1]), key(rows[index])) >= 0) return recoveryBoundaryInvalid('集合未严格排序或身份重复')
  return rows
}
function originalJson(source: string): unknown {
  return parseStrictJson(source, { maxBytes: Math.max(1, Buffer.byteLength(source, 'utf8')), maxDepth: 32 })
}
function guard(value: unknown): SyncedRecoveryGroupGuard {
  shape(value, ['revision', 'topologyRevision', 'historyCursor', 'historyPosition'])
  return { revision: uuid(value.revision), topologyRevision: uuid(value.topologyRevision), historyCursor: uuid(value.historyCursor), historyPosition: integer(value.historyPosition) }
}
function groupArchive(value: unknown): SyncedRecoveryGroupArchive {
  shape(value, ['groupId', 'creationId', 'createdAt', 'originJson', 'disposition', 'before', 'after', 'rows'])
  const groupId = uuid(value.groupId), creationId = uuid(value.creationId), createdAt = time(value.createdAt), originJson = text(value.originJson)
  const origin = validateSyncedOrigin(originalJson(originJson)), before = guard(value.before), after = guard(value.after)
  const disposition = value.disposition
  if (typeof disposition !== 'string' || !['active', 'retired-evidence', 'deleted-evidence'].includes(disposition) || after.historyPosition !== 0) return recoveryBoundaryInvalid('组归档状态或新历史位置无效')
  if (disposition === 'active'
    ? after.revision === before.revision || after.topologyRevision === before.topologyRevision || after.historyCursor === before.historyCursor
    : after.revision !== before.revision || after.topologyRevision !== before.topologyRevision || after.historyCursor !== before.historyCursor || before.historyPosition !== 0)
    return recoveryBoundaryInvalid('活动fresh guard或证据组原CAS不符')
  let previousAfter: string | null = null
  const ids = new Set<string>()
  const rows = list(value.rows, raw => {
    shape(raw, ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'])
    const row: SyncedRecoveryGroupHistoryRow = { id: uuid(raw.id), group_id: uuid(raw.group_id), position: integer(raw.position),
      before_json: text(raw.before_json), after_json: text(raw.after_json), before_hash: digest(raw.before_hash), after_hash: digest(raw.after_hash), created_at: time(raw.created_at) }
    if (row.group_id !== groupId || ids.has(row.id)) return recoveryBoundaryInvalid('归档历史原组/身份重复')
    ids.add(row.id)
    const left = validateSyncedGroupWire(originalJson(row.before_json)), right = validateSyncedGroupWire(originalJson(row.after_json))
    for (const [wire, expected] of [[left, row.before_hash], [right, row.after_hash]] as const) {
      if (wire.id !== groupId || wire.creationId !== creationId || wire.createdAt !== createdAt
        || recoveryBoundaryJson(wire.origin) !== recoveryBoundaryJson(origin) || hash(wire) !== expected)
        return recoveryBoundaryInvalid('原历史wire/hash/immutable tuple不闭合')
    }
    if (previousAfter !== null && previousAfter !== recoveryBoundaryJson(left)) return recoveryBoundaryInvalid('原组历史两侧不连续')
    previousAfter = recoveryBoundaryJson(right)
    return row
  })
  if (rows.some((row, index) => row.position !== index + 1) || before.historyPosition > rows.length) return recoveryBoundaryInvalid('完整原组历史位置链不连续')
  return { groupId, creationId, createdAt, originJson, disposition: disposition as SyncedRecoveryGroupArchive['disposition'],
    before, after: { ...after, historyPosition: 0 }, rows }
}

export function validateSyncedRecoveryHistoryBoundary(value: unknown): SyncedRecoveryHistoryBoundary {
  shape(value, ['kind', 'version', 'operationId', 'workspaceScope', 'beforeEpoch', 'afterEpoch', 'acceptedAt', 'documentBoundary', 'documents', 'hosts', 'hostCuts', 'groups', 'instances', 'retainedOperations', 'retainedPins'])
  if (value.kind !== 'synced-recovery-history-boundary' || value.version !== 1) return recoveryBoundaryInvalid('边界域/版本无效')
  const operationId = uuid(value.operationId), workspaceScope = uuid(value.workspaceScope), beforeEpoch = uuid(value.beforeEpoch), afterEpoch = uuid(value.afterEpoch), acceptedAt = time(value.acceptedAt), documentBoundary = time(value.documentBoundary)
  if (beforeEpoch === afterEpoch) return recoveryBoundaryInvalid('恢复世代未推进')
  const documents = ordered(list(value.documents, raw => {
    shape(raw, ['documentId', 'beforeUpdatedAt', 'afterUpdatedAt'])
    const document = { documentId: opaque(raw.documentId), beforeUpdatedAt: time(raw.beforeUpdatedAt), afterUpdatedAt: time(raw.afterUpdatedAt) }
    if (document.beforeUpdatedAt === document.afterUpdatedAt || document.afterUpdatedAt !== documentBoundary) return recoveryBoundaryInvalid('文档CAS未推进或与固定边界不符')
    return document
  }), row => row.documentId)
  const hosts = ordered(list(value.hosts, raw => {
    shape(raw, ['documentId', 'beforeCursor', 'beforePosition', 'afterCursor'])
    const host = { documentId: opaque(raw.documentId), beforeCursor: uuid(raw.beforeCursor), beforePosition: integer(raw.beforePosition), afterCursor: uuid(raw.afterCursor) }
    if (host.beforeCursor === host.afterCursor) return recoveryBoundaryInvalid('宿主cursor未推进')
    return host
  }), row => row.documentId)
  const hostIds = new Set(hosts.map(row => row.documentId)), positions = new Map<string, number[]>()
  const hostCuts = ordered(list(value.hostCuts, raw => {
    shape(raw, ['historyToken', 'journalHash', 'documentIds', 'mappings'])
    const historyToken = uuid(raw.historyToken), journalHash = digest(raw.journalHash), documentIds = ordered(list(raw.documentIds, opaque), id => id)
    const mappings = ordered(list(raw.mappings, entry => {
      shape(entry, ['documentId', 'position'])
      const documentId = opaque(entry.documentId), position = integer(entry.position)
      if (!position || !hostIds.has(documentId)) return recoveryBoundaryInvalid('原mapping没有完整宿主状态')
      const chain = positions.get(documentId) ?? []; chain.push(position); positions.set(documentId, chain)
      return { documentId, position }
    }), row => row.documentId)
    if (!documentIds.length || recoveryBoundaryJson(documentIds) !== recoveryBoundaryJson(mappings.map(row => row.documentId))) return recoveryBoundaryInvalid('原journal/mapping完整参与者不闭合')
    return { historyToken, journalHash, documentIds, mappings }
  }), row => row.historyToken)
  for (const host of hosts) {
    const chain = (positions.get(host.documentId) ?? []).sort((a, b) => a - b)
    if (chain.some((position, index) => position !== index + 1) || host.beforePosition > chain.length) return recoveryBoundaryInvalid('原宿主完整mapping链不连续')
  }
  const groups = ordered(list(value.groups, groupArchive), row => row.groupId), groupIds = new Set(groups.map(row => row.groupId)), rowIds = new Set<string>()
  for (const group of groups) for (const row of group.rows) {
    if (rowIds.has(row.id)) return recoveryBoundaryInvalid('不同组归档重复原history ID')
    rowIds.add(row.id)
  }
  const instances = ordered(list(value.instances, raw => {
    shape(raw, ['instanceId', 'groupId', 'hostDocumentId', 'beforeBindingVersion', 'afterBindingVersion'])
    const instance = { instanceId: uuid(raw.instanceId), groupId: uuid(raw.groupId), hostDocumentId: opaque(raw.hostDocumentId), beforeBindingVersion: uuid(raw.beforeBindingVersion), afterBindingVersion: uuid(raw.afterBindingVersion) }
    if (!groupIds.has(instance.groupId) || groups.find(group => group.groupId === instance.groupId)?.disposition !== 'active'
      || instance.beforeBindingVersion === instance.afterBindingVersion) return recoveryBoundaryInvalid('实例fresh binding或所属活动组无效')
    return instance
  }), row => row.instanceId)
  const retainedOperations = ordered(list(value.retainedOperations, raw => {
    shape(raw, ['operationId', 'rowHash'])
    return { operationId: opaque(raw.operationId), rowHash: digest(raw.rowHash) }
  }), row => row.operationId)
  if (retainedOperations.some(row => row.operationId === recoveryEpochMarkerId(operationId))) return recoveryBoundaryInvalid('原operation清单不能包含本次新marker')
  const retainedPins = ordered(list(value.retainedPins, raw => {
    shape(raw, ['groupId', 'kind', 'pinId', 'createdAt'])
    return { groupId: uuid(raw.groupId), kind: opaque(raw.kind), pinId: opaque(raw.pinId), createdAt: time(raw.createdAt) }
  }), row => recoveryBoundaryJson([row.groupId, row.kind, row.pinId]))
  if (!hosts.length && !hostCuts.length && !groups.length && !instances.length) return recoveryBoundaryInvalid('普通空历史不能伪造同步边界anchor')
  return { kind: 'synced-recovery-history-boundary', version: 1, operationId, workspaceScope, beforeEpoch, afterEpoch, acceptedAt, documentBoundary, documents, hosts, hostCuts, groups, instances, retainedOperations, retainedPins }
}
export function validateSyncedRecoveryEpochReceipt(value: unknown): SyncedRecoveryEpochReceipt {
  shape(value, ['kind', 'version', 'operationId', 'workspaceScope', 'beforeEpoch', 'afterEpoch', 'boundaryHash', 'acceptedAt'])
  if (value.kind !== 'synced-recovery-epoch' || value.version !== 1) return recoveryBoundaryInvalid('epoch receipt域/版本无效')
  const receipt: SyncedRecoveryEpochReceipt = { kind: value.kind, version: 1, operationId: uuid(value.operationId), workspaceScope: uuid(value.workspaceScope),
    beforeEpoch: uuid(value.beforeEpoch), afterEpoch: uuid(value.afterEpoch), boundaryHash: digest(value.boundaryHash), acceptedAt: time(value.acceptedAt) }
  if (receipt.beforeEpoch === receipt.afterEpoch) return recoveryBoundaryInvalid('receipt世代未推进')
  return receipt
}
export const recoveryBoundaryKey = (operationId: string): string => RECOVERY_BOUNDARY_PREFIX + uuid(operationId)
export const recoveryEpochMarkerId = (operationId: string): string => RECOVERY_EPOCH_PREFIX + uuid(operationId)
export const recoveryBoundaryHash = (boundary: SyncedRecoveryHistoryBoundary): string => hash(boundary)
export const recoveryEpochRequestHash = (receipt: SyncedRecoveryEpochReceipt): string => hash({ domain: 'synced.recovery-epoch.v1', receipt })
export const recoveryEpochTargetFingerprint = (workspaceScope: string): string => hash({ domain: 'synced.recovery-epoch.v1', workspaceScope: uuid(workspaceScope) })
/** Exact original SQL strings, never decoded/re-encoded ACK JSON. */
export function recoveryOperationRowHash(value: SyncedRecoveryOperationRow): string {
  shape(value, ['client_operation_id', 'request_hash', 'result_json', 'created_at'])
  return hash({ client_operation_id: opaque(value.client_operation_id), request_hash: digest(value.request_hash),
    result_json: text(value.result_json), created_at: time(value.created_at) })
}
export function parseRecoveryBoundaryJson(source: string): unknown {
  const value = originalJson(source)
  if (recoveryBoundaryJson(value) !== source) return recoveryBoundaryInvalid('记录不是原canonical JSON')
  return value
}
