import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from './synced-publication-model'
import type { ExchangeDeferredReason } from './synced-exchange-model'
import type { SyncedRecordMergeChoice, SyncedRecordMergePart } from './synced-merge'

export type SyncedExchangeConflictDecision = { componentId: string; choice: 'local' | 'remote' }
  | { componentId: string; choice: 'merge'; records: Array<{ key: string; parts: Array<{ id: string; value: SyncedRecordMergeChoice }> }> }
export interface ExchangeResolutionBinding { previewId: string; previewHash: string; decisionsHash: string }
export interface ExchangeMergeProvenance { key: string; baseHash: string; localHash: string; remoteHash: string; resultHash: string }
export interface ConflictPreviewRecord {
  key: string; baseHash: string | null; localHash: string | null; remoteHash: string | null
  merge: null | { conflicts: SyncedRecordMergePart[]; unresolved: SyncedRecordMergePart[]; resultHash: string | null }
}
export interface ConflictPreviewComponent {
  componentId: string; keys: string[]; localSignature: string; remoteSignature: string; dependencySignature: string
  reason: ExchangeDeferredReason; choices: Array<'local' | 'remote' | 'merge'>; records: ConflictPreviewRecord[]
}
export interface SyncedExchangeConflictPreview {
  kind: 'synced-exchange-conflict-preview'; version: 1; previewId: string; previewHash: string
  workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string; targetFingerprint: string
  stateGeneration: string; remoteManifestHash: string; createdAt: string; components: ConflictPreviewComponent[]
}
export interface ConflictPreviewIndex {
  kind: 'synced-exchange-conflict-preview-index'; version: 1; previewId: string; databasePath: string; targetFingerprint: string
  workspaceScope: string; recoveryEpoch: string; previewHash: string; createdAt: string
}
export type SyncedExchangeConflictPreviewResult = { status: 'ready'; preview: SyncedExchangeConflictPreview }
  | { status: 'missing' } | { status: 'unsupported'; reason: 'schema-27-required' | 'protocol5-required' }
  | { status: 'stale'; side: 'local' | 'remote' }

/** Descriptor-first JSON inspection: never invoke an untrusted accessor, iterator, toJSON or prototype method. */
export function assertConflictData(value: unknown): void {
  const seen = new Set<object>()
  function visit(item: unknown, depth: number): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || seen.has(item) || depth >= 32) return publicationInvalid('conflict不是有限JSON数据。')
    seen.add(item)
    const keys = Reflect.ownKeys(item), descriptors = Object.getOwnPropertyDescriptors(item)
    if (keys.some(key => typeof key !== 'string')) return publicationInvalid('conflict拒绝symbol。')
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || keys.length !== item.length + 1) return publicationInvalid('conflict数组原型/空洞/字段无效。')
      for (let i = 0; i < item.length; i++) { const d = descriptors[String(i)]
        if (!d || !('value' in d) || !d.enumerable) return publicationInvalid('conflict数组必须为dense data。')
        visit(d.value, depth + 1) }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null)) return publicationInvalid('conflict对象原型无效。')
      for (const key of keys as string[]) { const d = descriptors[key]
        if (!d || !('value' in d) || !d.enumerable || ['__proto__', 'constructor', 'prototype'].includes(key)) return publicationInvalid('conflict拒绝非data字段。')
        visit(d.value, depth + 1) }
    }
    seen.delete(item)
  }
  visit(value, 0)
}
function shape(value: unknown, fields: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  assertConflictData(value); assertSyncedShape(value, fields, optional)
}
function str(value: unknown): string { return typeof value === 'string' ? value : publicationInvalid('conflict字符串无效。') }
function id(value: unknown): string { return isSyncedBlockId(value) ? value : publicationInvalid('conflict稳定ID无效。') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : publicationInvalid('conflict UUID无效。') }
function hash(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : publicationInvalid('conflict hash无效。') }
function maybeHash(value: unknown): string | null { return value === null ? null : hash(value) }
function time(value: unknown): string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : publicationInvalid('conflict日期无效。') }
function recordKey(value: unknown): string {
  const key = str(value)
  if (key === 'databases' || key.startsWith('doc:') && isSyncedBlockId(key.slice(4)) || key.startsWith('group:') && isSyncedUuid(key.slice(6))) return key
  return publicationInvalid('conflict record key无效。')
}
function array<T>(value: unknown, read: (raw: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > SYNCED_MAX_BLOCKS) return publicationInvalid('conflict超过原条目门槛。')
  return value.map(read)
}
function ordered<T>(values: T[], key: (value: T) => string): T[] {
  for (let i = 1; i < values.length; i++) if (publicationCompare(key(values[i - 1]), key(values[i])) >= 0) return publicationInvalid('conflict集合必须唯一排序。')
  return values
}
function choice(value: unknown): SyncedRecordMergeChoice {
  assertConflictData(value)
  const tag = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'choice')?.value : undefined
  if (tag === 'custom') { shape(value, ['choice', 'text']); return { choice: 'custom', text: str(value.text) } }
  shape(value, ['choice'])
  if (value.choice !== 'local' && value.choice !== 'remote') return publicationInvalid('conflict part choice无效。')
  return { choice: value.choice }
}
export function validateConflictDecisions(value: unknown): SyncedExchangeConflictDecision[] {
  assertConflictData(value)
  return ordered(array<SyncedExchangeConflictDecision>(value, raw => {
    const tag = raw && typeof raw === 'object' ? Object.getOwnPropertyDescriptor(raw, 'choice')?.value : undefined
    if (tag === 'merge') {
      shape(raw, ['componentId', 'choice', 'records'])
      return { componentId: hash(raw.componentId), choice: 'merge' as const, records: ordered(array(raw.records, item => {
        shape(item, ['key', 'parts'])
        return { key: recordKey(item.key), parts: ordered(array(item.parts, part => { shape(part, ['id', 'value']); return { id: id(part.id), value: choice(part.value) } }), part => part.id) }
      }), item => item.key) }
    }
    shape(raw, ['componentId', 'choice'])
    if (raw.choice !== 'local' && raw.choice !== 'remote') return publicationInvalid('conflict整forest choice无效。')
    return { componentId: hash(raw.componentId), choice: raw.choice }
  }), row => row.componentId)
}
export function validateExchangeResolutionBinding(value: unknown): ExchangeResolutionBinding | null {
  if (value === null) return null
  shape(value, ['previewId', 'previewHash', 'decisionsHash'])
  return { previewId: uuid(value.previewId), previewHash: hash(value.previewHash), decisionsHash: hash(value.decisionsHash) }
}
export function validateExchangeMerges(value: unknown): ExchangeMergeProvenance[] {
  assertConflictData(value)
  return ordered(array(value, raw => { shape(raw, ['key', 'baseHash', 'localHash', 'remoteHash', 'resultHash'])
    return { key: recordKey(raw.key), baseHash: hash(raw.baseHash), localHash: hash(raw.localHash), remoteHash: hash(raw.remoteHash), resultHash: hash(raw.resultHash) } }), row => row.key)
}
function part(value: unknown): SyncedRecordMergePart {
  shape(value, ['id', 'field', 'canEditText', 'basePreview', 'localPreview', 'remotePreview'], ['blockId', 'property'])
  const fields = ['title', 'summary', 'parentId', 'sortOrder', 'blocks', 'block-content', 'block-property'] as const
  const field = fields.find(field => field === value.field)
  if (!field || typeof value.canEditText !== 'boolean') return publicationInvalid('conflict merge part字段无效。')
  return { id: id(value.id), field, canEditText: value.canEditText, basePreview: str(value.basePreview), localPreview: str(value.localPreview), remotePreview: str(value.remotePreview),
    ...(value.blockId === undefined ? {} : { blockId: id(value.blockId) }), ...(value.property === undefined ? {} : { property: id(value.property) }) }
}
function parts(value: unknown): SyncedRecordMergePart[] {
  const result = array(value, part)
  if (new Set(result.map(part => part.id)).size !== result.length) return publicationInvalid('conflict merge part重复。')
  return result
}
export function validateConflictPreviewComponent(value: unknown): ConflictPreviewComponent {
  shape(value, ['componentId', 'keys', 'localSignature', 'remoteSignature', 'dependencySignature', 'reason', 'choices', 'records'])
  const reasons: ExchangeDeferredReason[] = ['diverged', 'incarnation', 'owner-source', 'unknown-birth', 'history-pin', 'catalog', 'path', 'dependency', 'tombstone', 'local-removal', 'baseline-missing']
  const reason = reasons.find(reason => reason === value.reason)
  if (!reason) return publicationInvalid('conflict reason无效。')
  const choices = array<'local'|'remote'|'merge'>(value.choices, raw => { if (raw !== 'local' && raw !== 'remote' && raw !== 'merge') return publicationInvalid('conflict choice无效。'); return raw })
  if (new Set(choices).size !== choices.length) return publicationInvalid('conflict choice重复。')
  const keys = ordered(array(value.keys, recordKey), key => key), records = ordered(array(value.records, raw => {
    shape(raw, ['key', 'baseHash', 'localHash', 'remoteHash', 'merge'])
    let merge: ConflictPreviewRecord['merge'] = null
    if (raw.merge !== null) { shape(raw.merge, ['conflicts', 'unresolved', 'resultHash'])
      merge = { conflicts: parts(raw.merge.conflicts), unresolved: parts(raw.merge.unresolved), resultHash: maybeHash(raw.merge.resultHash) }
      const available = new Map(merge.conflicts.map(part => [part.id, publicationJson(part)]))
      if (merge.unresolved.some(part => available.get(part.id) !== publicationJson(part))) return publicationInvalid('unresolved不属于原conflicts。') }
    return { key: recordKey(raw.key), baseHash: maybeHash(raw.baseHash), localHash: maybeHash(raw.localHash), remoteHash: maybeHash(raw.remoteHash), merge }
  }), row => row.key)
  if (publicationJson(keys) !== publicationJson(records.map(row => row.key))) return publicationInvalid('conflict records闭集不等component。')
  return { componentId: hash(value.componentId), keys, localSignature: hash(value.localSignature), remoteSignature: hash(value.remoteSignature), dependencySignature: hash(value.dependencySignature), reason, choices, records }
}
export function validateConflictPreview(value: unknown): SyncedExchangeConflictPreview {
  shape(value, ['kind', 'version', 'previewId', 'previewHash', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'targetFingerprint', 'stateGeneration', 'remoteManifestHash', 'createdAt', 'components'])
  if (value.kind !== 'synced-exchange-conflict-preview' || value.version !== 1) return publicationInvalid('conflict preview finite版本无效。')
  const components = ordered(array(value.components, validateConflictPreviewComponent), row => row.componentId), keys = components.flatMap(row => row.keys)
  if (new Set(keys).size !== keys.length) return publicationInvalid('conflict组件重叠。')
  return { kind: value.kind, version: 1, previewId: uuid(value.previewId), previewHash: hash(value.previewHash), workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), remoteWorkspaceId: uuid(value.remoteWorkspaceId), targetFingerprint: hash(value.targetFingerprint), stateGeneration: uuid(value.stateGeneration), remoteManifestHash: hash(value.remoteManifestHash), createdAt: time(value.createdAt), components }
}
export function validateConflictPreviewIndex(value: unknown): ConflictPreviewIndex {
  shape(value, ['kind', 'version', 'previewId', 'databasePath', 'targetFingerprint', 'workspaceScope', 'recoveryEpoch', 'previewHash', 'createdAt'])
  if (value.kind !== 'synced-exchange-conflict-preview-index' || value.version !== 1) return publicationInvalid('conflict preview index版本无效。')
  return { kind: value.kind, version: 1, previewId: uuid(value.previewId), databasePath: id(value.databasePath), targetFingerprint: hash(value.targetFingerprint), workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), previewHash: hash(value.previewHash), createdAt: time(value.createdAt) }
}
export const conflictPreviewKey = (previewId: string): string => 'sync.webdav.protocol5.exchange-preview.v1.' + uuid(previewId)
export const conflictDecisionsHash = (value: unknown): string => publicationHash(publicationJson(validateConflictDecisions(value)))
