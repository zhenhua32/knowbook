import { isAbsolute, resolve } from 'node:path'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'

export const RESTORE_FILES = ['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm'] as const
export type RestoreFile = typeof RESTORE_FILES[number]
export type RestoreContinuity = 'ordinary-verified' | 'legacy-disaster-unverified'
export interface RestoreRawFile { name: RestoreFile; present: boolean; bytes: number; sha256: string | null }
export interface RestoreCurrent {
  classification: RestoreContinuity | 'missing'; schemaVersion: number | null
  workspaceScope: string | null; recoveryEpoch: string | null; inventory: RestoreRawFile[]
}
export interface RestoreReceipt {
  kind: 'controlled-database-restore-receipt'; version: 1; operationId: string; profileRoot: string
  sourceSha256: string; sourceSchemaVersion: number; cloneSha256: string; currentInventoryHash: string
  workspaceScope: string; recoveryEpoch: string; documentBoundary: string; continuity: RestoreContinuity; acceptedAt: string
}
export interface RestoreIntent {
  kind: 'controlled-database-restore-intent'; version: 2; operationId: string; profileRoot: string; databasePath: string
  createdAt: string; source: { path: string; sha256: string; schemaVersion: number }; current: RestoreCurrent
  candidateAuthority: { workspaceScope: string | null; recoveryEpoch: string | null }
  parentFenceHash: string | null; receipt: RestoreReceipt; receiptHash: string; stagedSha256: string
}
export interface RestoreFence {
  kind: 'controlled-database-restore-fence'; version: 1; operationId: string; intentHash: string
  phase: 'prepared' | 'installed' | 'rolledback'; parentFenceHash: string | null
}
export interface RestoreJournal {
  kind: 'controlled-database-restore-journal'; version: 2; operationId: string; intentHash: string; phase: 'moving' | 'installed'
}
export const restoreReceiptKey = (id: string): string => 'database.restore.receipt.' + restoreUuid(id)
export const restoreJson = (value: unknown): string => publicationJson(value)
export const restoreHash = (value: unknown): string => publicationHash(restoreJson(value))
export function restoreFail(message: string): never { throw new Error('受控数据库恢复安全认证失败：' + message) }
function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return restoreFail('记录字段不是准确闭集。')
}
export function restoreUuid(value: unknown): string {
  return isSyncedUuid(value) ? value : restoreFail('operation/scope/epoch UUID 无效。')
}
function hash(value: unknown): string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : restoreFail('SHA256无效。') }
function nullableHash(value: unknown): string | null { return value === null ? null : hash(value) }
function path(value: unknown): string {
  return typeof value === 'string' && !value.includes('\0') && isAbsolute(value) && resolve(value) === value ? value : restoreFail('原绝对路径无效。')
}
function date(value: unknown): string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : restoreFail('时间无效。') }
function version(value: unknown): number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 27 ? value : restoreFail('源版本不在1–27。') }
function continuity(value: unknown): RestoreContinuity {
  return value === 'ordinary-verified' || value === 'legacy-disaster-unverified' ? value : restoreFail('连续性分类无效。')
}
export function validateRestoreInventory(value: unknown): RestoreRawFile[] {
  if (!Array.isArray(value) || value.length !== RESTORE_FILES.length) return restoreFail('原三文件清单不完整。')
  return value.map((raw, index) => {
    shape(raw, ['name', 'present', 'bytes', 'sha256'])
    if (raw.name !== RESTORE_FILES[index] || typeof raw.present !== 'boolean' || typeof raw.bytes !== 'number'
      || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) return restoreFail('原三文件状态／长度无效。')
    const digest = nullableHash(raw.sha256)
    if (raw.present ? digest === null : raw.bytes !== 0 || digest !== null) return restoreFail('原文件缺省状态不闭合。')
    return { name: RESTORE_FILES[index], present: raw.present, bytes: raw.bytes, sha256: digest }
  })
}
export function validateRestoreReceipt(value: unknown): RestoreReceipt {
  shape(value, ['kind','version','operationId','profileRoot','sourceSha256','sourceSchemaVersion','cloneSha256','currentInventoryHash',
    'workspaceScope','recoveryEpoch','documentBoundary','continuity','acceptedAt'])
  if (value.kind !== 'controlled-database-restore-receipt' || value.version !== 1) return restoreFail('恢复receipt域无效。')
  return { kind: value.kind, version: 1, operationId: restoreUuid(value.operationId), profileRoot: path(value.profileRoot),
    sourceSha256: hash(value.sourceSha256), sourceSchemaVersion: version(value.sourceSchemaVersion), cloneSha256: hash(value.cloneSha256),
    currentInventoryHash: hash(value.currentInventoryHash), workspaceScope: restoreUuid(value.workspaceScope), recoveryEpoch: restoreUuid(value.recoveryEpoch),
    documentBoundary: date(value.documentBoundary), continuity: continuity(value.continuity), acceptedAt: date(value.acceptedAt) }
}
export function validateRestoreIntent(value: unknown): RestoreIntent {
  shape(value, ['kind','version','operationId','profileRoot','databasePath','createdAt','source','current','candidateAuthority','parentFenceHash','receipt','receiptHash','stagedSha256'])
  if (value.kind !== 'controlled-database-restore-intent' || value.version !== 2) return restoreFail('恢复intent域无效。')
  const source = value.source, current = value.current, candidate=value.candidateAuthority
  shape(source, ['path','sha256','schemaVersion']); shape(current, ['classification','schemaVersion','workspaceScope','recoveryEpoch','inventory'])
  shape(candidate,['workspaceScope','recoveryEpoch'])
  const operationId = restoreUuid(value.operationId), profileRoot = path(value.profileRoot), receipt = validateRestoreReceipt(value.receipt)
  const classification = current.classification === 'missing' ? 'missing' : continuity(current.classification)
  const state: RestoreCurrent = { classification, schemaVersion: current.schemaVersion === null ? null : version(current.schemaVersion),
    workspaceScope: current.workspaceScope === null ? null : restoreUuid(current.workspaceScope),
    recoveryEpoch: current.recoveryEpoch === null ? null : restoreUuid(current.recoveryEpoch), inventory: validateRestoreInventory(current.inventory) }
  if ((state.workspaceScope === null) !== (state.recoveryEpoch === null) || classification === 'ordinary-verified' && state.schemaVersion === null
    || classification !== 'ordinary-verified' && (state.schemaVersion !== null || state.workspaceScope !== null)) return restoreFail('current分类与原scope/version不闭合。')
  if (classification === 'missing' && state.inventory.some(row=>row.present)
    || classification === 'ordinary-verified' && (!state.inventory[0].present || (state.schemaVersion! >= 26) !== (state.workspaceScope !== null))) return restoreFail('current分类与三文件／原scope版本不闭合。')
  const result: RestoreIntent = { kind: value.kind, version: 2, operationId, profileRoot, databasePath: path(value.databasePath), createdAt: date(value.createdAt),
    source: { path: path(source.path), sha256: hash(source.sha256), schemaVersion: version(source.schemaVersion) }, current: state,
    candidateAuthority:{workspaceScope:candidate.workspaceScope===null?null:restoreUuid(candidate.workspaceScope),recoveryEpoch:candidate.recoveryEpoch===null?null:restoreUuid(candidate.recoveryEpoch)},
    parentFenceHash: nullableHash(value.parentFenceHash), receipt, receiptHash: hash(value.receiptHash), stagedSha256: hash(value.stagedSha256) }
  if (receipt.operationId !== operationId || receipt.profileRoot !== profileRoot || receipt.sourceSha256 !== result.source.sha256
    || receipt.sourceSchemaVersion !== result.source.schemaVersion || receipt.cloneSha256 !== result.source.sha256
    || receipt.currentInventoryHash !== restoreHash(state.inventory) || result.receiptHash !== restoreHash(receipt)
    || receipt.continuity !== (classification === 'legacy-disaster-unverified' ? classification : 'ordinary-verified')
    || state.workspaceScope !== null && state.workspaceScope !== receipt.workspaceScope
    || state.recoveryEpoch !== null && state.recoveryEpoch === receipt.recoveryEpoch
    || result.candidateAuthority.recoveryEpoch!==null&&result.candidateAuthority.recoveryEpoch===receipt.recoveryEpoch
    || (result.source.schemaVersion>=26)!==(result.candidateAuthority.workspaceScope!==null)
    || (result.candidateAuthority.workspaceScope===null)!==(result.candidateAuthority.recoveryEpoch===null)
    || state.workspaceScope===null&&result.candidateAuthority.workspaceScope!==null&&receipt.workspaceScope!==result.candidateAuthority.workspaceScope
    || receipt.acceptedAt!==result.createdAt) return restoreFail('intent/receipt/current/source不闭合。')
  return result
}
export function validateRestoreFence(value: unknown): RestoreFence {
  shape(value, ['kind','version','operationId','intentHash','phase','parentFenceHash'])
  if (value.kind !== 'controlled-database-restore-fence' || value.version !== 1
    || value.phase !== 'prepared' && value.phase !== 'installed' && value.phase !== 'rolledback') return restoreFail('外fence域/phase无效。')
  return { kind: value.kind, version: 1, operationId: restoreUuid(value.operationId), intentHash: hash(value.intentHash), phase: value.phase, parentFenceHash: nullableHash(value.parentFenceHash) }
}
export function validateRestoreJournal(value: unknown): RestoreJournal {
  shape(value, ['kind','version','operationId','intentHash','phase'])
  if (value.kind !== 'controlled-database-restore-journal' || value.version !== 2 || value.phase !== 'moving' && value.phase !== 'installed') return restoreFail('恢复journal2域/phase无效。')
  return { kind: value.kind, version: 2, operationId: restoreUuid(value.operationId), intentHash: hash(value.intentHash), phase: value.phase }
}
export function parseRestoreJson(source: string): unknown {
  let value: unknown
  try { value = JSON.parse(source) } catch (cause) { throw new Error('恢复记录JSON损坏。', { cause }) }
  if (restoreJson(value) !== source) return restoreFail('恢复记录不是原canonical JSON，可能有重复键或被替换。')
  return value
}
