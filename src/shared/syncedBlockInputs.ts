import type {
  SyncedGroupGuard, SyncedHostWorkingBefore, SyncedInstanceGuard, SyncedNewRefSource,
  SyncedPlacement, SyncedReferenceIdentity, SyncedRestoreGroupInput, SyncedRestoreHostInput,
  SyncedRootSelection, SyncedStructureAction, SyncedStructureInput, SyncedUpdateGroupInput
} from './synced-blocks'
import {
  assertSyncedShape, isSyncedBlockId, isSyncedUuid, syncedPlainRecord, SYNCED_MAX_BLOCKS,
  SYNCED_MAX_DEPTH, SyncedValidationError, validateSyncedCanonicalEdit, validateSyncedHostForest
} from './syncedBlockValidation'

function invalid(code: 'forest' | 'identity' | 'binding' | 'depth' = 'forest'): never {
  throw new SyncedValidationError(code, '同步块请求的字段或结构无效，未修改正文。')
}
function opaque(value: unknown): string { return isSyncedBlockId(value) ? value : invalid('identity') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : invalid('identity') }
function text(value: unknown): string { return typeof value === 'string' ? value : invalid() }
function timestamp(value: unknown): string {
  return typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? value : invalid()
}
function array<T>(value: unknown, read: (item: unknown) => T, nonempty = false): T[] {
  if (!Array.isArray(value) || value.length > SYNCED_MAX_BLOCKS || nonempty && !value.length) return invalid()
  return Array.from(value, read)
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const ids = new Set<string>()
  for (const item of items) {
    const id = key(item)
    if (ids.has(id)) return invalid('identity')
    ids.add(id)
  }
  return items
}

const groupKeys = ['groupId', 'expectedRevision', 'expectedTopologyRevision'] as const
const instanceKeys = ['instanceId', 'hostDocumentId', 'bindingVersion'] as const
function groupFields(value: Record<string, unknown>): SyncedGroupGuard {
  return { groupId: uuid(value.groupId), expectedRevision: uuid(value.expectedRevision),
    expectedTopologyRevision: uuid(value.expectedTopologyRevision) }
}
export function validateSyncedGroupGuard(value: unknown): SyncedGroupGuard {
  assertSyncedShape(value, groupKeys)
  return groupFields(value)
}
export function validateSyncedInstanceGuard(value: unknown): SyncedInstanceGuard {
  assertSyncedShape(value, instanceKeys)
  return { instanceId: uuid(value.instanceId), hostDocumentId: opaque(value.hostDocumentId), bindingVersion: uuid(value.bindingVersion) }
}
export function validateSyncedUpdateGroupInput(value: unknown): SyncedUpdateGroupInput {
  assertSyncedShape(value, [...groupKeys, 'clientOperationId', 'expectedInstanceBinding', 'blocks'])
  return { ...groupFields(value), clientOperationId: uuid(value.clientOperationId),
    expectedInstanceBinding: validateSyncedInstanceGuard(value.expectedInstanceBinding), blocks: validateSyncedCanonicalEdit(value.blocks) }
}
export function validateSyncedRestoreGroupInput(value: unknown): SyncedRestoreGroupInput {
  assertSyncedShape(value, [...groupKeys, 'clientOperationId', 'expectedInstanceBinding', 'historyToken', 'expectedHistoryCursor', 'direction'])
  if (value.direction !== 'undo' && value.direction !== 'redo') return invalid()
  return { ...groupFields(value), clientOperationId: uuid(value.clientOperationId),
    expectedInstanceBinding: validateSyncedInstanceGuard(value.expectedInstanceBinding), historyToken: uuid(value.historyToken),
    expectedHistoryCursor: uuid(value.expectedHistoryCursor), direction: value.direction }
}

function workingBefore(value: unknown): SyncedHostWorkingBefore {
  assertSyncedShape(value, ['documentId', 'expectedPersistedUpdatedAt', 'workingBefore'])
  const before = value.workingBefore
  assertSyncedShape(before, ['title', 'summary', 'blocks'])
  return { documentId: opaque(value.documentId), expectedPersistedUpdatedAt: timestamp(value.expectedPersistedUpdatedAt),
    workingBefore: { title: text(before.title), summary: text(before.summary), blocks: validateSyncedHostForest(before.blocks) } }
}
function selection(value: unknown): SyncedRootSelection {
  assertSyncedShape(value, ['documentId', 'selectedRootIds'])
  // Selection order and overlapping roots are planner inputs, never silently deduplicated before request hashing.
  return { documentId: opaque(value.documentId), selectedRootIds: array(value.selectedRootIds, opaque, true) }
}
function placement(value: unknown): SyncedPlacement {
  assertSyncedShape(value, ['documentId', 'beforeBlockId', 'parentBlockId', 'depth'])
  if (typeof value.depth !== 'number' || !Number.isSafeInteger(value.depth) || value.depth < 0 || value.depth > SYNCED_MAX_DEPTH) return invalid('depth')
  return { documentId: opaque(value.documentId), beforeBlockId: value.beforeBlockId === null ? null : opaque(value.beforeBlockId),
    parentBlockId: value.parentBlockId === null ? null : opaque(value.parentBlockId), depth: value.depth }
}
function identity(value: unknown): SyncedReferenceIdentity {
  assertSyncedShape(value, ['workspaceScope', 'groupId', 'creationId'])
  return { workspaceScope: uuid(value.workspaceScope), groupId: uuid(value.groupId), creationId: uuid(value.creationId) }
}
function source(value: unknown): SyncedNewRefSource {
  if (!syncedPlainRecord(value)) return invalid('binding')
  if (value.kind === 'working') {
    assertSyncedShape(value, ['kind', 'instanceId', 'sourceDocumentId', 'sourceInstanceId'])
    return { kind: 'working', instanceId: uuid(value.instanceId), sourceDocumentId: opaque(value.sourceDocumentId),
      sourceInstanceId: uuid(value.sourceInstanceId) }
  }
  if (value.kind === 'internal') {
    assertSyncedShape(value, ['kind', 'instanceId', 'identity'])
    return { kind: 'internal', instanceId: uuid(value.instanceId), identity: identity(value.identity) }
  }
  return invalid('binding')
}
function action(value: unknown): SyncedStructureAction {
  if (!syncedPlainRecord(value)) return invalid()
  switch (value.kind) {
    case 'create':
      assertSyncedShape(value, ['kind', 'documentId', 'selectedRootIds', 'groupId', 'instanceId'])
      return { kind: 'create', documentId: opaque(value.documentId), selectedRootIds: array(value.selectedRootIds, opaque, true),
        groupId: uuid(value.groupId), instanceId: uuid(value.instanceId) }
    case 'insert':
      assertSyncedShape(value, ['kind', 'groupId', 'instanceId', 'target'])
      return { kind: 'insert', groupId: uuid(value.groupId), instanceId: uuid(value.instanceId), target: placement(value.target) }
    case 'move': case 'duplicate':
      assertSyncedShape(value, ['kind', 'selection', 'target'])
      return { kind: value.kind, selection: selection(value.selection), target: placement(value.target) }
    case 'move-batch':
      assertSyncedShape(value, ['kind', 'moves'])
      return { kind: 'move-batch', moves: array(value.moves, move => {
        assertSyncedShape(move, ['selection', 'target'])
        return { selection: selection(move.selection), target: placement(move.target) }
      }, true) }
    case 'delete':
      assertSyncedShape(value, ['kind', 'selection'])
      return { kind: 'delete', selection: selection(value.selection) }
    case 'paste':
      assertSyncedShape(value, ['kind', 'fragment', 'refSources', 'replace', 'target'])
      return { kind: 'paste', fragment: validateSyncedHostForest(value.fragment),
        refSources: unique(array(value.refSources, item => {
          assertSyncedShape(item, ['fragmentBlockId', 'identity'])
          return { fragmentBlockId: uuid(item.fragmentBlockId), identity: identity(item.identity) }
        }), item => item.fragmentBlockId), replace: value.replace === null ? null : selection(value.replace), target: placement(value.target) }
    case 'detach':
      assertSyncedShape(value, ['kind', 'instanceId', 'groupId'])
      return { kind: 'detach', instanceId: uuid(value.instanceId), groupId: uuid(value.groupId) }
    default: return invalid()
  }
}

/** Shape validation is deliberately separate from Main's ownership, parsed-link and final-graph authority checks. */
export function validateSyncedStructureInput(value: unknown): SyncedStructureInput {
  if (!syncedPlainRecord(value)) return invalid()
  const keys = ['clientOperationId', 'hostsWorkingBefore', 'groups', 'expectedInstances', 'mode']
  if (value.mode === 'command') assertSyncedShape(value, [...keys, 'action'])
  else if (value.mode === 'host-final') assertSyncedShape(value, [...keys, 'reason', 'finalAfter', 'newRefSources'])
  else return invalid()
  const base = { clientOperationId: uuid(value.clientOperationId),
    hostsWorkingBefore: unique(array(value.hostsWorkingBefore, workingBefore, true), item => item.documentId),
    groups: unique(array(value.groups, validateSyncedGroupGuard), item => item.groupId),
    expectedInstances: unique(array(value.expectedInstances, validateSyncedInstanceGuard), item => item.instanceId) }
  if (value.mode === 'command') return { ...base, mode: 'command', action: action(value.action) }
  if (value.reason !== 'source-apply' && value.reason !== 'selection-edit' && value.reason !== 'drop' && value.reason !== 'paste') return invalid()
  const finalAfter = unique(array(value.finalAfter, item => {
    assertSyncedShape(item, ['documentId', 'title', 'summary', 'blocks'])
    return { documentId: opaque(item.documentId), title: text(item.title), summary: text(item.summary), blocks: validateSyncedHostForest(item.blocks) }
  }, true), item => item.documentId)
  const hostIds = new Set(base.hostsWorkingBefore.map(host => host.documentId))
  if (finalAfter.length !== hostIds.size || finalAfter.some(host => !hostIds.has(host.documentId))) return invalid('identity')
  return { ...base, mode: 'host-final', reason: value.reason, finalAfter,
    newRefSources: unique(array(value.newRefSources, source), item => item.instanceId) }
}

export function validateSyncedRestoreHostInput(value: unknown): SyncedRestoreHostInput {
  assertSyncedShape(value, ['clientOperationId', 'historyToken', 'direction', 'expectedHosts', 'groups', 'expectedInstances'])
  if (value.direction !== 'undo' && value.direction !== 'redo') return invalid()
  return { clientOperationId: uuid(value.clientOperationId), historyToken: uuid(value.historyToken), direction: value.direction,
    expectedHosts: unique(array(value.expectedHosts, item => {
      assertSyncedShape(item, ['documentId', 'expectedUpdatedAt'])
      return { documentId: opaque(item.documentId), expectedUpdatedAt: timestamp(item.expectedUpdatedAt) }
    }, true), item => item.documentId),
    groups: unique(array(value.groups, validateSyncedGroupGuard), item => item.groupId),
    expectedInstances: unique(array(value.expectedInstances, validateSyncedInstanceGuard), item => item.instanceId) }
}
