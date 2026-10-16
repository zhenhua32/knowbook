import type { SyncedGroupSaved, SyncedStructureApplied } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, validateSyncedGroupSnapshot } from '../../shared/syncedBlockValidation'
import { decodeSyncedGroupOperationAck, type SyncedGroupOperationRow } from './synced-group-operation-receipt'
import { hostJson, validateHostDocumentDetail } from './synced-host-document-read'
import { hostHash, hostReferencedGroups, sameHostContent, validateHostContent } from './synced-host-journal'

const bad = (): never => { throw new Error('宿主结构操作完整回执损坏，不能重建今日状态或重发。') }
function unique<T>(value: unknown, read: (raw: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value)) return bad()
  const result = value.map(read)
  if (new Set(result.map(key)).size !== result.length) return bad()
  return result
}
export function validateHostOperationAck(value: unknown, operationId: string): SyncedStructureApplied {
  assertSyncedShape(value, ['status', 'operationId', 'historyToken', 'replayed', 'hosts', 'groups', 'affectedInstanceIds', 'blockIdMap'])
  if (!isSyncedUuid(operationId) || value.operationId !== operationId || value.replayed !== false
    || value.status !== 'applied' && value.status !== 'noop' || value.historyToken !== null && !isSyncedUuid(value.historyToken)
    || value.status === 'noop' && value.historyToken !== null) return bad()
  const hosts = unique(value.hosts, raw => {
    assertSyncedShape(raw, ['documentId', 'logicalBefore', 'logicalBeforeHash', 'after'])
    if (!isSyncedBlockId(raw.documentId) || typeof raw.logicalBeforeHash !== 'string') return bad()
    const logicalBefore = validateHostContent(raw.logicalBefore), after = validateHostDocumentDetail(raw.after)
    if (after.id !== raw.documentId || !after.blocks.length || hostHash(logicalBefore) !== raw.logicalBeforeHash) return bad()
    if (value.status === 'noop' && !sameHostContent(logicalBefore, { title: after.title, summary: after.summary,
      blocks: after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) })) return bad()
    return { documentId: raw.documentId, logicalBefore, logicalBeforeHash: raw.logicalBeforeHash, after }
  }, item => item.documentId)
  if (!hosts.length) return bad()
  const groups = unique(value.groups, validateSyncedGroupSnapshot, item => item.groupId)
  const afterIds = new Set<string>()
  for (const host of hosts) for (const block of host.after.blocks) {
    if (afterIds.has(block.id)) return bad()
    afterIds.add(block.id)
  }
  const groupIds = new Set(groups.map(group => group.groupId))
  const requiredGroups = hostReferencedGroups(hosts.flatMap(host => [{ documentId: host.documentId, content: host.logicalBefore },
    { documentId: host.documentId, content: { title: host.after.title, summary: host.after.summary,
      blocks: host.after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) } }]))
  if ([...requiredGroups].some(id => !groupIds.has(id))) return bad()
  const affectedInstanceIds = unique(value.affectedInstanceIds, raw => isSyncedUuid(raw) ? raw : bad(), item => item)
  const logicalChange = hosts.some(host => !sameHostContent(host.logicalBefore, { title: host.after.title, summary: host.after.summary,
    blocks: host.after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) }))
  if (logicalChange !== (value.historyToken !== null) || value.status === 'noop' && (logicalChange || affectedInstanceIds.length)) return bad()
  // This finite host-final namespace never changes stable IDs or creates groups.
  if (!Array.isArray(value.blockIdMap) || value.blockIdMap.length) return bad()
  return { status: value.status, operationId, historyToken: value.historyToken, replayed: false, hosts, groups, affectedInstanceIds, blockIdMap: [] }
}
export function decodeHostOperationAck(row: SyncedGroupOperationRow): SyncedStructureApplied {
  try {
    if (!/^[a-f0-9]{64}$/.test(row.request_hash)) return bad()
    const envelope = hostJson(row.result_json)
    assertSyncedShape(envelope, ['kind', 'version', 'result'])
    if (envelope.kind !== 'synced-host-operation' || envelope.version !== 1) return bad()
    return validateHostOperationAck(envelope.result, row.client_operation_id)
  } catch (cause) { throw new Error('宿主结构操作回执损坏，未重发或重建。', { cause }) }
}
/** Generic operation lookup dispatches only a validated finite envelope. Group
 * source-signing readers continue to call their group-only decoder directly. */
export function decodeSyncedOperationAck(row: SyncedGroupOperationRow): SyncedGroupSaved | SyncedStructureApplied {
  try {
    const value = hostJson(row.result_json)
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'kind')) return decodeHostOperationAck(row)
    return decodeSyncedGroupOperationAck(row)
  } catch (cause) { throw new Error('同步块操作收据损坏，不能猜测提交结果或重新执行。', { cause }) }
}
