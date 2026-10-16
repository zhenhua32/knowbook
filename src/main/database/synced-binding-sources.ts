import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedBindingSource, SyncedGroupSnapshot, SyncedGroupSnapshotsWithLinkSourcesResult,
  SyncedOperationWithLinkSourceResult } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { isSyncedUuid, SyncedValidationError } from '../../shared/syncedBlockValidation'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { readSyncedBindingSources, type SyncedVerifiedBindingSource } from './synced-block-links'
import { decodeSyncedGroupOperationAck, readSyncedGroupOperationRow, validateSyncedOperationLookupInput } from './synced-group-operation-receipt'

/** No eviction: a full registry refuses new captures before returning a handle.
 * Main restart ends these private capabilities; portable data never contains them. */
export const SYNCED_BINDING_SOURCE_LIMITS = Object.freeze({ tickets: 256, bytes: 32 * 1024 * 1024 })
type Ticket = { ticketId: string; digest: string; bytes: number; entries: Map<string, SyncedVerifiedBindingSource>; publicSource: SyncedBindingSource }
type Registry = { epoch: string; bytes: number; tickets: Map<string, Ticket>; digests: Map<string, Ticket> }
type Workspace = { scope: string; epoch: string }
type CapturedSource = { entries: SyncedVerifiedBindingSource[]; digest: string }
const registries = new WeakMap<Database.Database, Registry>()
function fail(message: string): never { throw new SyncedValidationError('binding', message) }
function identity(db: Database.Database): Workspace {
  const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: unknown; recovery_epoch: unknown } | undefined
  if (!row || !isSyncedUuid(row.workspace_scope) || !isSyncedUuid(row.recovery_epoch)) {
    return fail('同步块来源票的真实工作区身份无效。')
  }
  return { scope: row.workspace_scope, epoch: JSON.stringify([row.workspace_scope, row.recovery_epoch]) }
}
function captureSource(db: Database.Database, snapshot: SyncedGroupSnapshot): CapturedSource {
  // No plannedGroupId exemption: every known block target already has a ledger.
  // A stored ACK is parsed as that exact historical side, never today's paths.
  const entries = readSyncedBindingSources(db, snapshot.origin, snapshot.blocks, snapshot.bindings)
  const source = canonicalSyncedPortableJson({ groupId: snapshot.groupId, creationId: snapshot.creationId,
    createdAt: snapshot.createdAt, origin: snapshot.origin, entries })
  return { entries, digest: createHash('sha256').update(source).digest('hex') }
}

/** All callers reach this only after their owned read has ended. Registry
 * publication is all-or-none and is shared by current and operation sources. */
function publishCapturedSources(db: Database.Database, workspace: Workspace,
  sources: readonly (CapturedSource | null)[]): Array<SyncedBindingSource | null> {
  const previous = registries.get(db)
  const registry: Registry = previous?.epoch === workspace.epoch ? previous
    : { epoch: workspace.epoch, bytes: 0, tickets: new Map(), digests: new Map() }
  const pending = new Map<string, Ticket>()
  const tickets = sources.map(source => {
    if (!source) return null
    const old = registry.digests.get(source.digest) ?? pending.get(source.digest)
    if (old) return old
    const ticketId = randomUUID(), entries = new Map<string, SyncedVerifiedBindingSource>()
    const publicSource: SyncedBindingSource = { ticketId, entries: source.entries.map(value => {
      const entryId = randomUUID()
      entries.set(entryId, structuredClone(value))
      return { entryId, key: structuredClone(value.key) }
    }) }
    const bytes = Buffer.byteLength(JSON.stringify({ ticketId, entries: [...entries] }), 'utf8')
    const ticket: Ticket = { ticketId, digest: source.digest, entries, publicSource, bytes }
    pending.set(source.digest, ticket)
    return ticket
  })
  const addedBytes = [...pending.values()].reduce((total, ticket) => total + ticket.bytes, 0)
  if (registry.tickets.size + pending.size > SYNCED_BINDING_SOURCE_LIMITS.tickets
    || registry.bytes + addedBytes > SYNCED_BINDING_SOURCE_LIMITS.bytes) {
    return fail('同步块复制来源内存容量已满，未签发新票；现有来源保持有效。')
  }
  for (const ticket of pending.values()) {
    registry.tickets.set(ticket.ticketId, ticket); registry.digests.set(ticket.digest, ticket)
  }
  registry.bytes += addedBytes
  registries.set(db, registry)
  return tickets.map(ticket => ticket ? structuredClone(ticket.publicSource) : null)
}

/** Owned read only: signing inside a writer's uncommitted after-state would let
 * a rolled-back draft become a trusted source. Publish only after this read ends. */
export function getSyncedGroupSnapshotsWithLinkSources(db: Database.Database, input: unknown): SyncedGroupSnapshotsWithLinkSourcesResult {
  if (db.inTransaction) throw new Error('同步块来源读取必须独占只读事务，不能为尚未提交的内容签票。')
  const captured = db.transaction(() => {
    const workspace = identity(db), result = getSyncedGroupSnapshots(db, input)
    if (result.workspaceScope !== workspace.scope) return fail('同步块读取与来源票不属于同一工作区。')
    const sources = result.items.map(item => item.status === 'missing' ? null : captureSource(db, item.snapshot))
    return { workspace, result, sources }
  })()
  const tickets = publishCapturedSources(db, captured.workspace, captured.sources)
  return { workspaceScope: captured.result.workspaceScope, items: captured.result.items.map((item, index) =>
    item.status === 'missing' ? item : { ...item, bindingSource: tickets[index]! }) }
}

/** Sign the original, committed group ACK's after-side. No caller-supplied
 * snapshot/target is accepted, no history row is required, and nothing is written. */
export function getSyncedOperationWithLinkSource(db: Database.Database, input: unknown): SyncedOperationWithLinkSourceResult {
  if (db.inTransaction) throw new Error('同步块来源读取必须独占只读事务，不能为尚未提交的内容签票。')
  const id = validateSyncedOperationLookupInput(input)
  const captured = db.transaction(() => {
    const workspace = identity(db), row = readSyncedGroupOperationRow(db, id)
    if (!row) return null
    const result = { ...decodeSyncedGroupOperationAck(row), replayed: true }
    return { workspace, result, source: captureSource(db, result.snapshot) }
  })()
  if (!captured) return { status: 'unknown' }
  const [bindingSource] = publishCapturedSources(db, captured.workspace, [captured.source])
  return { status: 'committed', workspaceScope: captured.workspace.scope, result: captured.result, bindingSource: bindingSource! }
}

/** Connection-bound and recovery-bound; revisions, history trimming and mounts
 * deliberately do not invalidate a successfully captured source. Never consume. */
export function resolveSyncedBindingSource(db: Database.Database, ticketId: string, entryId: string): SyncedVerifiedBindingSource {
  if (!isSyncedUuid(ticketId) || !isSyncedUuid(entryId)) return fail('同步块复制来源票格式无效。')
  const workspace = identity(db), registry = registries.get(db)
  const entry = registry?.epoch === workspace.epoch ? registry.tickets.get(ticketId)?.entries.get(entryId) : undefined
  if (!entry) return fail('同步块复制来源已失效（应用重启或恢复后需重新复制）；保留草稿，不会按 URL 重新绑定。')
  return structuredClone(entry)
}
