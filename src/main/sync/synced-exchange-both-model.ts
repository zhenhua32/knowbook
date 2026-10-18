import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import type { SyncedLinkTarget } from '../../shared/synced-blocks'
import { assertConflictData } from './synced-exchange-conflict-model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from './synced-publication-model'
import type * as T from './synced-exchange-both-types'

export interface BothRequest {
  method: 'resolveSyncedExchangeBoth'; operationId: string; databasePath: string; targetFingerprint: string
  previewId: string; decisions: T.SyncedExchangeBothDecision[]
}
export interface BothResolution { previewId: string; previewHash: string; decisionsHash: string; allocationHash: string }
export interface BothPreviewIndex {
  kind: 'synced-exchange-both-preview-index'; version: 1; previewId: string; databasePath: string; targetFingerprint: string
  workspaceScope: string; recoveryEpoch: string; previewHash: string; allocationHash: string; createdAt: string
}
export interface BothPrivateSelection {
  preview: T.SyncedExchangeBothPreviewComponent; decision: T.SyncedExchangeBothDecision
  component: T.SyncedBothSourceComponent; allocation: T.SyncedBothAllocation
  sourceLinks: T.SyncedBothOwnerSourceLinks[]; conflictedKeys: string[]
  poolAllocation: T.SyncedBothAllocation
}
const reasons: readonly T.SyncedExchangeBothBlockedReason[] = ['diverged', 'incarnation', 'owner-source', 'unknown-birth', 'history-pin',
  'catalog', 'path', 'dependency', 'tombstone', 'local-removal', 'baseline-missing', 'semantic-binding', 'budget']
function shape(value: unknown, fields: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> { assertSyncedShape(value, fields, optional) }
function string(value: unknown): string { return typeof value === 'string' ? value : publicationInvalid('both string无效。') }
function id(value: unknown): string { return isSyncedBlockId(value) ? value : publicationInvalid('both opaque ID无效。') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : publicationInvalid('both UUID无效。') }
function hash(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : publicationInvalid('both hash无效。') }
function maybeHash(value: unknown): string | null { return value === null ? null : hash(value) }
function date(value: unknown): string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : publicationInvalid('both date无效。') }
function integer(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : publicationInvalid('both offset无效。') }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : publicationInvalid('both boolean无效。') }
function array<T>(value: unknown, read: (raw: unknown) => T): T[] {
  if (!Array.isArray(value)) return publicationInvalid('both集合不是原dense数组。')
  return value.map(read)
}
function ordered<T>(rows: T[], key: (row: T) => string): T[] {
  for (let index = 1; index < rows.length; index++) if (publicationCompare(key(rows[index - 1]), key(rows[index])) >= 0) return publicationInvalid('both集合未准确唯一排序。')
  return rows
}
function recordKey(value: unknown): string {
  const key = string(value)
  if (key === 'databases' || key.startsWith('doc:') && isSyncedBlockId(key.slice(4)) || key.startsWith('group:') && isSyncedUuid(key.slice(6))) return key
  return publicationInvalid('both record key无效。')
}
function physicalOwner(value: unknown): string { const key = recordKey(value); return key === 'databases' ? publicationInvalid('both physical owner不是doc/group。') : key }
function keys(value: unknown): string[] { return ordered(array(value, recordKey), row => row) }
function ids(value: unknown): string[] { return ordered(array(value, id), row => row) }
function uuids(value: unknown): string[] { return ordered(array(value, uuid), row => row) }
function destination(value: unknown): 'existing' | 'copied' { return value === 'existing' || value === 'copied' ? value : publicationInvalid('both host目的地无效。') }
function parent(value: unknown): string | null { return value === null ? null : id(value) }
function title(value: unknown): string {
  const text = string(value)
  if (!text || text !== text.trim() || text.length > 500 || /[/\\\x00-\x1f]/.test(text) || text === '.' || text === '..') return publicationInvalid('both标题不属于原canonical路径规则。')
  return text
}
function selector(raw: unknown): T.SyncedExchangeBothHostSelector {
  shape(raw, ['sourceDocumentId', 'sourceInstanceId', 'destination'])
  return { sourceDocumentId: id(raw.sourceDocumentId), sourceInstanceId: uuid(raw.sourceInstanceId), destination: destination(raw.destination) }
}
export function bothHostSelectorKey(value: T.SyncedExchangeBothHostSelector): string { return publicationJson([value.sourceDocumentId, value.sourceInstanceId, value.destination]) }
export function validateBothDecisions(value: unknown): T.SyncedExchangeBothDecision[] {
  assertConflictData(value)
  const result = ordered(array(value, raw => {
    shape(raw, ['componentId', 'copyDocumentIds', 'groups'])
    const groups = ordered(array(raw.groups, row => { shape(row, ['groupId', 'hosts']); return {
      groupId: uuid(row.groupId), hosts: ordered(array(row.hosts, selector), bothHostSelectorKey)
    } }), row => row.groupId)
    const copyDocumentIds = ids(raw.copyDocumentIds)
    if (!groups.length && !copyDocumentIds.length) return publicationInvalid('both决定没有实际fork。')
    return { componentId: hash(raw.componentId), copyDocumentIds, groups }
  }), row => row.componentId)
  if (!result.length) return publicationInvalid('both需要至少一个真实决定。')
  return result
}
export function validateBothRequest(value: unknown): BothRequest {
  assertConflictData(value); shape(value, ['method', 'operationId', 'databasePath', 'targetFingerprint', 'previewId', 'decisions'])
  if (value.method !== 'resolveSyncedExchangeBoth') return publicationInvalid('both method无效。')
  return { method: 'resolveSyncedExchangeBoth', operationId: uuid(value.operationId), databasePath: id(value.databasePath),
    targetFingerprint: hash(value.targetFingerprint), previewId: uuid(value.previewId), decisions: validateBothDecisions(value.decisions) }
}
export function bothPreviewKey(previewId: string): string { return 'sync.webdav.protocol5.exchange-both-preview.v1.' + uuid(previewId) }
export function bothAllocationHash(value: T.SyncedBothAllocation): string { return publicationHash(publicationJson(value)) }
export function validateBothAllocation(value: unknown): T.SyncedBothAllocation {
  assertConflictData(value); shape(value, ['kind', 'version', 'previewId', 'allocatedAt', 'documents', 'groups', 'blocks', 'instances', 'entities', 'missing'])
  if (value.kind !== 'synced-exchange-both-allocation' || value.version !== 1) return publicationInvalid('both allocation版本无效。')
  const documents = ordered(array(value.documents, raw => { shape(raw, ['sourceDocumentId', 'documentId', 'createdAt', 'title', 'parentId', 'path']); return {
    sourceDocumentId: id(raw.sourceDocumentId), documentId: uuid(raw.documentId), createdAt: date(raw.createdAt), title: title(raw.title), parentId: parent(raw.parentId), path: string(raw.path)
  } }), row => row.sourceDocumentId)
  const groups = ordered(array(value.groups, raw => { shape(raw, ['sourceGroupId', 'groupId', 'creationId', 'createdAt', 'firstInstanceId']); return {
    sourceGroupId: uuid(raw.sourceGroupId), groupId: uuid(raw.groupId), creationId: uuid(raw.creationId), createdAt: date(raw.createdAt), firstInstanceId: uuid(raw.firstInstanceId)
  } }), row => row.sourceGroupId)
  const blocks = ordered(array(value.blocks, raw => { shape(raw, ['sourceOwnerKey', 'sourceBlockId', 'ownerKey', 'blockId', 'createdAt']); return {
    sourceOwnerKey: physicalOwner(raw.sourceOwnerKey), sourceBlockId: id(raw.sourceBlockId), ownerKey: physicalOwner(raw.ownerKey), blockId: uuid(raw.blockId), createdAt: date(raw.createdAt)
  } }), row => publicationJson([row.sourceOwnerKey, row.sourceBlockId]))
  const instances = ordered(array(value.instances, raw => { shape(raw, ['sourceDocumentId', 'sourceInstanceId', 'destination', 'documentId', 'instanceId', 'groupId', 'createdAt']); return {
    sourceDocumentId: id(raw.sourceDocumentId), sourceInstanceId: uuid(raw.sourceInstanceId), destination: destination(raw.destination), documentId: id(raw.documentId),
    instanceId: uuid(raw.instanceId), groupId: uuid(raw.groupId), createdAt: date(raw.createdAt)
  } }), bothHostSelectorKey)
  const entities = ordered(array(value.entities, raw => { shape(raw, ['sourceEntityId', 'entityId', 'createdAt']); return {
    sourceEntityId: id(raw.sourceEntityId), entityId: uuid(raw.entityId), createdAt: date(raw.createdAt)
  } }), row => row.sourceEntityId)
  const missing = ordered(array(value.missing, raw => { shape(raw, ['sourceId', 'id']); return { sourceId: id(raw.sourceId), id: uuid(raw.id) } }), row => row.sourceId)
  const minted = [...documents.map(row => row.documentId), ...groups.flatMap(row => [row.groupId, row.creationId]), ...blocks.map(row => row.blockId),
    ...instances.map(row => row.instanceId), ...entities.map(row => row.entityId), ...missing.map(row => row.id)]
  if (new Set(minted).size !== minted.length) return publicationInvalid('both新身份跨角色重复。')
  const first = new Set([...instances.map(row => row.instanceId), ...missing.map(row => row.id)])
  if (groups.some(row => !first.has(row.firstInstanceId))) return publicationInvalid('both Origin.firstInstanceId没有原allocation来源。')
  return { kind: 'synced-exchange-both-allocation', version: 1, previewId: uuid(value.previewId), allocatedAt: date(value.allocatedAt), documents, groups, blocks, instances, entities, missing }
}
function sourceKey(value: unknown): T.SyncedBothSourceKey {
  shape(value, ['field', 'blockId', 'from', 'to', 'raw', 'syntax'])
  if (value.field !== 'block' && value.field !== 'summary' || value.syntax !== 'markdown' && value.syntax !== 'wiki') return publicationInvalid('both物理Key角色无效。')
  const blockId = value.field === 'summary' ? value.blockId === null ? null : publicationInvalid('summary不能造block身份。') : id(value.blockId)
  const from = integer(value.from), to = integer(value.to), raw = string(value.raw)
  if (to < from || to - from !== raw.length) return publicationInvalid('both原Key范围与UTF16 raw不等。')
  return { field: value.field, blockId, from, to, raw, syntax: value.syntax }
}
function target(value: unknown): SyncedLinkTarget {
  shape(value, ['kind'], ['id', 'state', 'documentId', 'slug', 'path', 'fragment'])
  if (value.kind === 'unresolved-url') { shape(value, ['kind', 'path', 'fragment']); return { kind: 'unresolved-url', path: string(value.path), fragment: value.fragment === null ? null : string(value.fragment) } }
  if (value.state !== 'live' && value.state !== 'missing') return publicationInvalid('both target state无效。')
  if (value.kind === 'document') { shape(value, ['kind', 'id', 'state']); return { kind: 'document', id: id(value.id), state: value.state } }
  if (value.kind === 'block') { shape(value, ['kind', 'id', 'documentId', 'state']); return { kind: 'block', id: id(value.id), documentId: parent(value.documentId), state: value.state } }
  if (value.kind === 'heading') { shape(value, ['kind', 'documentId', 'slug', 'state']); return { kind: 'heading', documentId: id(value.documentId), slug: string(value.slug), state: value.state } }
  return publicationInvalid('both typed target kind无效。')
}
export function bothSourceKey(value: T.SyncedBothSourceKey): string { return publicationJson([value.field, value.blockId, value.from, value.to, value.raw, value.syntax]) }
export function validateBothSourceLinks(value: unknown): T.SyncedBothOwnerSourceLinks[] {
  assertConflictData(value)
  return ordered(array(value, raw => { shape(raw, ['ownerKey', 'recordHash', 'path', 'complete', 'links', 'images']); return {
    ownerKey: physicalOwner(raw.ownerKey), recordHash: hash(raw.recordHash), path: raw.path === null ? null : string(raw.path), complete: bool(raw.complete),
    links: ordered(array(raw.links, row => { shape(row, ['key', 'url', 'target']); return { key: sourceKey(row.key), url: string(row.url), target: target(row.target) } }), row => bothSourceKey(row.key)),
    images: ordered(array(raw.images, row => { shape(row, ['key', 'url']); return { key: sourceKey(row.key), url: string(row.url) } }), row => bothSourceKey(row.key))
  } }), row => row.ownerKey)
}
export function validateBothProjections(value: unknown): T.SyncedBothLinkProjection[] {
  assertConflictData(value)
  return ordered(array(value, raw => { shape(raw, ['sourceOwnerKey', 'source', 'destinationOwnerKey', 'destination', 'target']); return {
    sourceOwnerKey: physicalOwner(raw.sourceOwnerKey), source: sourceKey(raw.source), destinationOwnerKey: physicalOwner(raw.destinationOwnerKey), destination: sourceKey(raw.destination), target: target(raw.target)
  } }), row => publicationJson([row.sourceOwnerKey, row.source, row.destinationOwnerKey, row.destination]))
}
function summary(raw: unknown): T.SyncedExchangeBothForkSummary {
  shape(raw, ['componentId', 'allocationHash', 'documents', 'groups', 'instances', 'entities'])
  return { componentId: hash(raw.componentId), allocationHash: hash(raw.allocationHash),
    documents: ordered(array(raw.documents, row => { shape(row, ['sourceDocumentId', 'documentId', 'title', 'parentId', 'path']); return {
      sourceDocumentId: id(row.sourceDocumentId), documentId: uuid(row.documentId), title: title(row.title), parentId: parent(row.parentId), path: string(row.path)
    } }), row => row.sourceDocumentId),
    groups: ordered(array(raw.groups, row => { shape(row, ['sourceGroupId', 'groupId', 'creationId']); return { sourceGroupId: uuid(row.sourceGroupId), groupId: uuid(row.groupId), creationId: uuid(row.creationId) } }), row => row.sourceGroupId),
    instances: ordered(array(raw.instances, row => { shape(row, ['sourceDocumentId', 'sourceInstanceId', 'destination', 'documentId', 'instanceId', 'groupId']); return {
      sourceDocumentId: id(row.sourceDocumentId), sourceInstanceId: uuid(row.sourceInstanceId), destination: destination(row.destination), documentId: id(row.documentId), instanceId: uuid(row.instanceId), groupId: uuid(row.groupId)
    } }), bothHostSelectorKey),
    entities: ordered(array(raw.entities, row => { shape(row, ['sourceEntityId', 'entityId', 'documentId']); return { sourceEntityId: id(row.sourceEntityId), entityId: uuid(row.entityId), documentId: parent(row.documentId) } }), row => row.sourceEntityId)
  }
}
export function validateBothSummaries(value: unknown): T.SyncedExchangeBothForkSummary[] { assertConflictData(value); return ordered(array(value, summary), row => row.componentId) }
export function validateBothForkProofs(value: unknown): T.SyncedBothForkProof[] {
  assertConflictData(value)
  return ordered(array(value, raw => { shape(raw, ['componentId', 'allocationHash', 'sources', 'results', 'projectionsHash', 'summary'])
    const entries = (items: unknown) => ordered(array(items, item => { shape(item, ['key', 'hash']); return { key: recordKey(item.key), hash: hash(item.hash) } }), row => row.key)
    const result = { componentId: hash(raw.componentId), allocationHash: hash(raw.allocationHash), sources: entries(raw.sources), results: entries(raw.results), projectionsHash: hash(raw.projectionsHash), summary: summary(raw.summary) }
    if (result.summary.componentId !== result.componentId || result.summary.allocationHash !== result.allocationHash) return publicationInvalid('both summary/proof不一致。')
    return result
  }), row => row.componentId)
}
export function validateBothResolution(value: unknown): BothResolution {
  assertConflictData(value); shape(value, ['previewId', 'previewHash', 'decisionsHash', 'allocationHash'])
  return { previewId: uuid(value.previewId), previewHash: hash(value.previewHash), decisionsHash: hash(value.decisionsHash), allocationHash: hash(value.allocationHash) }
}
export function validateBothPreviewIndex(value: unknown): BothPreviewIndex {
  assertConflictData(value); shape(value, ['kind', 'version', 'previewId', 'databasePath', 'targetFingerprint', 'workspaceScope', 'recoveryEpoch', 'previewHash', 'allocationHash', 'createdAt'])
  if (value.kind !== 'synced-exchange-both-preview-index' || value.version !== 1) return publicationInvalid('both preview index版本无效。')
  return { kind: 'synced-exchange-both-preview-index', version: 1, previewId: uuid(value.previewId), databasePath: id(value.databasePath), targetFingerprint: hash(value.targetFingerprint),
    workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), previewHash: hash(value.previewHash), allocationHash: hash(value.allocationHash), createdAt: date(value.createdAt) }
}
export function validateBothPreviewComponent(value: unknown): T.SyncedExchangeBothPreviewComponent {
  assertConflictData(value); shape(value, ['componentId', 'keys', 'localSignature', 'remoteSignature', 'dependencySignature', 'reason', 'choices', 'records', 'copyDocuments', 'groups', 'entities'])
  const reason = value.reason === null ? null : reasons.includes(value.reason as T.SyncedExchangeBothBlockedReason) ? value.reason as T.SyncedExchangeBothBlockedReason : publicationInvalid('both blocked reason无效。')
  const choices = array(value.choices, raw => raw === 'both' ? 'both' as const : publicationInvalid('both choice无效。'))
  if (choices.length > 1) return publicationInvalid('both choice重复。')
  const records = ordered(array(value.records, raw => { shape(raw, ['key', 'baseHash', 'localHash', 'remoteHash']); return {
    key: recordKey(raw.key), baseHash: maybeHash(raw.baseHash), localHash: maybeHash(raw.localHash), remoteHash: maybeHash(raw.remoteHash)
  } }), row => row.key)
  const componentKeys = keys(value.keys)
  if (!componentKeys.length || publicationJson(componentKeys) !== publicationJson(records.map(row => row.key))) return publicationInvalid('both records没有准确覆盖原组件。')
  return { componentId: hash(value.componentId), keys: componentKeys, localSignature: hash(value.localSignature), remoteSignature: hash(value.remoteSignature), dependencySignature: hash(value.dependencySignature), reason, choices, records,
    copyDocuments: ordered(array(value.copyDocuments, raw => { shape(raw, ['sourceDocumentId', 'sourceHash', 'sourceTitle', 'documentId', 'title', 'parentId', 'path', 'required', 'requiredCopyDocumentIds', 'requiredGroupIds']); return {
      sourceDocumentId: id(raw.sourceDocumentId), sourceHash: hash(raw.sourceHash), sourceTitle: string(raw.sourceTitle), documentId: uuid(raw.documentId), title: title(raw.title), parentId: parent(raw.parentId), path: string(raw.path), required: bool(raw.required), requiredCopyDocumentIds: ids(raw.requiredCopyDocumentIds), requiredGroupIds: uuids(raw.requiredGroupIds)
    } }), row => row.sourceDocumentId),
    groups: ordered(array(value.groups, raw => { shape(raw, ['sourceGroupId', 'sourceHash', 'groupId', 'creationId', 'createdAt', 'required', 'hosts']); return {
      sourceGroupId: uuid(raw.sourceGroupId), sourceHash: hash(raw.sourceHash), groupId: uuid(raw.groupId), creationId: uuid(raw.creationId), createdAt: date(raw.createdAt), required: bool(raw.required),
      hosts: ordered(array(raw.hosts, row => { shape(row, ['sourceDocumentId', 'sourceInstanceId', 'destination', 'documentId', 'instanceId', 'required']); return {
        sourceDocumentId: id(row.sourceDocumentId), sourceInstanceId: uuid(row.sourceInstanceId), destination: destination(row.destination), documentId: id(row.documentId), instanceId: uuid(row.instanceId), required: bool(row.required)
      } }), bothHostSelectorKey)
    } }), row => row.sourceGroupId),
    entities: ordered(array(value.entities, raw => { shape(raw, ['sourceEntityId', 'entityId', 'sourceDocumentId', 'databaseId', 'title']); return {
      sourceEntityId: id(raw.sourceEntityId), entityId: uuid(raw.entityId), sourceDocumentId: id(raw.sourceDocumentId), databaseId: id(raw.databaseId), title: string(raw.title)
    } }), row => row.sourceEntityId)
  }
}
export function validateBothPreview(value: unknown): T.SyncedExchangeBothPreview {
  assertConflictData(value); shape(value, ['kind', 'version', 'previewId', 'previewHash', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'targetFingerprint', 'stateGeneration', 'remoteManifestHash', 'createdAt', 'components'])
  if (value.kind !== 'synced-exchange-both-preview' || value.version !== 1) return publicationInvalid('both preview版本无效。')
  return { kind: 'synced-exchange-both-preview', version: 1, previewId: uuid(value.previewId), previewHash: hash(value.previewHash), workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch),
    remoteWorkspaceId: uuid(value.remoteWorkspaceId), targetFingerprint: hash(value.targetFingerprint), stateGeneration: uuid(value.stateGeneration), remoteManifestHash: hash(value.remoteManifestHash), createdAt: date(value.createdAt),
    components: ordered(array(value.components, validateBothPreviewComponent), row => row.componentId) }
}
export function validateBothPublishedBlock(value: unknown): T.SyncedExchangeBothPublishedBlock {
  assertConflictData(value); shape(value, ['status', 'stage', 'reason', 'operationId', 'attemptId', 'allocationHash', 'publishedManifestHash', 'publishedManifestETag', 'componentIds', 'collisions'])
  if (value.status !== 'blocked' || value.stage !== 'published-local' || !['identity-collision', 'path-collision', 'catalog-collision', 'source-stale'].includes(string(value.reason))) return publicationInvalid('both published block tag无效。')
  const reason = value.reason as T.SyncedExchangeBothPublishedBlock['reason']
  return { status: 'blocked', stage: 'published-local', reason, operationId: uuid(value.operationId), attemptId: uuid(value.attemptId), allocationHash: hash(value.allocationHash),
    publishedManifestHash: hash(value.publishedManifestHash), publishedManifestETag: string(value.publishedManifestETag), componentIds: ordered(array(value.componentIds, hash), row => row),
    collisions: ordered(array(value.collisions, raw => { shape(raw, ['kind', 'id'])
      if (!['document', 'group', 'block', 'instance', 'entity', 'path'].includes(string(raw.kind))) return publicationInvalid('both碰撞身份域无效。')
      return { kind: raw.kind as T.SyncedExchangeBothPublishedBlock['collisions'][number]['kind'], id: string(raw.id) }
    }), row => publicationJson([row.kind, row.id])) }
}
