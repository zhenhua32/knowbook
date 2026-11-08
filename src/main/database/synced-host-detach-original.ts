import type Database from 'better-sqlite3'
import { markdownEngine } from '../../shared/markdownEngine'
import { collectDocumentMarkdownLinks } from '../../shared/markdownLinkMaintenance'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { assertSyncedShape, syncedPlainRecord } from '../../shared/syncedBlockValidation'
import { readSyncedGroupOperationRow, type SyncedGroupOperationRow } from './synced-group-operation-receipt'
import { hostJson } from './synced-host-document-read'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { decodeHostJournal, hostEncode, hostEqual, hostHash, sameHostContent } from './synced-host-journal'
import { validateHostDetachOperationAck } from './synced-host-operation-receipt'
import { readDetachHeadingSqlSupports } from './synced-host-detach-heading'
import { createPhysicalKey } from './synced-host-create-plan'
import { renderDetachedUnresolvedDestination } from './synced-host-detach-unresolved'
import { parseDetachedCanonicalDestination, readDetachCanonicalSqlSupports, renderDetachedCanonicalDestination } from './synced-host-detach-canonical'

export const HOST_DETACH_OPERATION_KIND = 'synced-host-detach-operation'
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function invalid(): never { throw new Error('解除同步回执与同一次实际请求、历史原件或同步组不一致。') }

type TimedOperation = SyncedGroupOperationRow & { created_at: string }

function nativeDestinations(blocks: readonly SyncedStableBlockDraft[]) {
  return new Map(collectDocumentMarkdownLinks([...blocks]).map(link => {
    const block = blocks[link.blockIndex]
    return [createPhysicalKey({ blockId: block.id, from: link.start, to: link.end, raw: block.content.slice(link.start, link.end),
      syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' }), link] as const
  }))
}

export function decodeHostDetachOriginalRows<Row extends SyncedHostHistoryBranchRow>(operation: TimedOperation, read: (id: string) => Row | undefined) {
  if (typeof operation.result_json !== 'string' || !operation.result_json.includes(HOST_DETACH_OPERATION_KIND)) return null
  let envelope: unknown
  try { envelope = hostJson(operation.result_json) } catch { return null }
  if (!syncedPlainRecord(envelope) || envelope.kind !== HOST_DETACH_OPERATION_KIND) return null
  if (!hash(operation.request_hash)) return invalid()
  assertSyncedShape(envelope, ['kind', 'version', 'journalHash', 'result'])
  if (envelope.version !== 1 || !hash(envelope.journalHash)) return invalid()
  const result = validateHostDetachOperationAck(envelope.result, operation.client_operation_id)
  if (hostEncode({ kind: HOST_DETACH_OPERATION_KIND, version: 1, journalHash: envelope.journalHash, result }) !== operation.result_json) return invalid()
  const row = read(result.historyToken!)
  if (!row || row.id !== result.historyToken || row.created_at !== operation.created_at || hostHash(row) !== envelope.journalHash) return invalid()
  const journal = decodeHostJournal(row)
  if (!('detach' in journal) || journal.input.clientOperationId !== operation.client_operation_id
    || hostHash({ method: 'applySyncedHostCommand', input: journal.input }) !== operation.request_hash) return invalid()
  const { documentId, logicalBefore, after } = result.hosts[0]
  const group = result.groups.find(item => item.groupId === journal.input.action.groupId)
  if (!group || group.revision !== journal.detach.revision || group.topologyRevision === journal.input.groups.find(item => item.groupId === group.groupId)?.expectedTopologyRevision
    || result.groups.length !== journal.input.groups.length || result.groups.some(item => !journal.input.groups.some(guard => guard.groupId === item.groupId))
    || documentId !== journal.before[0].documentId || !hostEqual(logicalBefore, journal.before[0].content)
    || !sameHostContent({ title: after.title, summary: after.summary, blocks: after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) }, journal.after[0].content)
    || !hostEqual(result.blockIdMap, journal.detach.allocation) || !hostEqual(result.affectedInstanceIds, [journal.input.action.instanceId])) return invalid()
  const savedWire = { kind: 'synced-group', id: group.groupId, creationId: group.creationId, createdAt: group.createdAt,
    origin: group.origin, blocks: group.blocks, bindings: group.bindings }
  const survivors = group.instances.map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion }))
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  if (!hostEqual(savedWire, journal.detach.wire) || !hostEqual(survivors, journal.detach.survivors)) return invalid()
  const rebased = journal.detach.projection.links.filter(link => link.resolved.target.kind === 'unresolved-url' || link.resolved.canonical)
  if (rebased.length) {
    // Reconstruct the two saved Markdown scopes without treating later target creation as historical tampering.
    const origin = nativeDestinations(journal.detach.wire.blocks), copied = nativeDestinations(journal.after[0].content.blocks)
    for (const { source, destination, url, resolved: { target, canonical } } of rebased) {
      const beforeLink = origin.get(createPhysicalKey(source)), afterLink = copied.get(createPhysicalKey(destination))
      if (!beforeLink || beforeLink.kind === 'image' || !afterLink || afterLink.kind === 'image') return invalid()
      const link = { key: source, url: beforeLink.url, grammar: { kind: beforeLink.kind,
        syntax: beforeLink.kind === 'wiki' ? 'wiki' as const : beforeLink.syntax ?? null } }
      const address = canonical ? parseDetachedCanonicalDestination(source.syntax, url) : null
      const rendered = address ? renderDetachedCanonicalDestination(link, address)
        : target.kind === 'unresolved-url' ? renderDetachedUnresolvedDestination(link, journal.detach.wire.origin.pathAtCreation, after.path, target) : null
      if (!rendered || destination.raw !== rendered.replacement || afterLink.url !== url
        || url !== (source.syntax === 'markdown' ? markdownEngine.normalizeLink(rendered.url) : rendered.url)) return invalid()
    }
  }
  return { result, row, journal }
}

export function decodeHostDetachOriginalOwned(db: Database.Database, operation: SyncedGroupOperationRow) {
  if (typeof operation.result_json !== 'string' || !operation.result_json.includes(HOST_DETACH_OPERATION_KIND)) return null
  if (!db.inTransaction) return invalid()
  const original = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
    .get(operation.client_operation_id) as TimedOperation | undefined
  if (!original || original.result_json !== operation.result_json || original.request_hash !== operation.request_hash) return invalid()
  const read = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?')
  const decoded = decodeHostDetachOriginalRows(original, id => read.get(id) as SyncedHostHistoryBranchRow | undefined)
  return decoded && { ...decoded, headingSupports: readDetachHeadingSqlSupports(db, decoded.journal.detach),
    canonicalSupports: readDetachCanonicalSqlSupports(db, decoded.journal.detach) }
}

export function requireHostDetachOriginalOwned(db: Database.Database, operationId: string) {
  const operation = readSyncedGroupOperationRow(db, operationId)
  return operation && decodeHostDetachOriginalOwned(db, operation) || invalid()
}
