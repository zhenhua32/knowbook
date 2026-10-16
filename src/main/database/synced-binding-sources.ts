import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedBindingSource, SyncedGroupSnapshot, SyncedGroupSnapshotsWithLinkSourcesResult,
  SyncedOperationWithLinkSourceResult } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { assertSyncedShape, isSyncedUuid, SyncedValidationError, validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { readSyncedBindingSources, type SyncedVerifiedBindingSource } from './synced-block-links'
import { decodeSyncedGroupOperationAck, readSyncedGroupOperationRow, validateSyncedOperationLookupInput } from './synced-group-operation-receipt'

/** No eviction: owners and ticket aliases share the original count/byte budget.
 * Main restart ends these private capabilities; portable data never contains them. */
export const SYNCED_BINDING_SOURCE_LIMITS = Object.freeze({ tickets: 256, bytes: 32 * 1024 * 1024 })

/** Main-only read capabilities. They are not writer leases or portable history. */
export type SyncedBaselineOwnerResult =
  | { status: 'ready'; workspaceScope: string; readOwnerId: string; snapshot: SyncedGroupSnapshot; bindingSource: SyncedBindingSource }
  | { status: 'missing'; workspaceScope: string; groupId: string }
export type SyncedReadOwnerValidationResult =
  | { status: 'ready'; workspaceScope: string }
  | { status: 'owner-unavailable' }
export type SyncedOwnedOperationWithLinkSourceResult =
  | { status: 'owner-unavailable' }
  | { status: 'unknown-operation' }
  | Extract<SyncedOperationWithLinkSourceResult, { status: 'committed' }>

type Payload = { digest: string; entries: SyncedVerifiedBindingSource[]; bytes: number; references: number }
type Ticket = {
  ticketId: string; digest: string; ownerId: string | null; payload: Payload; bytes: number
  entryIndices: Map<string, number>; publicSource: SyncedBindingSource
}
type ReadOwner = {
  readOwnerId: string; groupId: string; incarnation: string; bytes: number; aliases: Map<string, Ticket>
}
type Registry = {
  epoch: string; bytes: number; tickets: Map<string, Ticket>; digests: Map<string, Ticket>
  payloads: Map<string, Payload>; owners: Map<string, ReadOwner>
}
type Workspace = { scope: string; epoch: string }
type CapturedSource = { entries: SyncedVerifiedBindingSource[]; digest: string }
const registries = new WeakMap<Database.Database, Registry>()
function fail(message: string): never { throw new SyncedValidationError('binding', message) }
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
function identity(db: Database.Database): Workspace {
  const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: unknown; recovery_epoch: unknown } | undefined
  if (!row || !isSyncedUuid(row.workspace_scope) || !isSyncedUuid(row.recovery_epoch)) {
    return fail('同步块来源票的真实工作区身份无效。')
  }
  return { scope: row.workspace_scope, epoch: JSON.stringify([row.workspace_scope, row.recovery_epoch]) }
}
function incarnation(snapshot: Pick<SyncedGroupSnapshot, 'groupId' | 'creationId' | 'createdAt' | 'origin'>): string {
  return canonicalSyncedPortableJson({ groupId: snapshot.groupId, creationId: snapshot.creationId,
    createdAt: snapshot.createdAt, origin: snapshot.origin })
}
/** History sources survive content edits, retirement and reactivation of this
 * same incarnation. A current writer/mount guard is a different capability. */
function currentIncarnation(db: Database.Database, groupId: string): string | null {
  const row = db.prepare('SELECT creation_id,created_at,origin_json FROM synced_groups WHERE id=?').get(groupId) as
    { creation_id: unknown; created_at: unknown; origin_json: unknown } | undefined
  if (!row) return null
  if (!isSyncedUuid(row.creation_id) || typeof row.created_at !== 'string' || !row.created_at.trim()
    || !Number.isFinite(Date.parse(row.created_at)) || typeof row.origin_json !== 'string') {
    return fail('同步块来源 owner 的真实组身份无效。')
  }
  const origin = validateSyncedOrigin(parseStrictJson(row.origin_json,
    { maxBytes: Math.max(1, Buffer.byteLength(row.origin_json, 'utf8')), maxDepth: 32 }))
  return incarnation({ groupId, creationId: row.creation_id, createdAt: row.created_at, origin })
}
function captureSource(db: Database.Database, snapshot: SyncedGroupSnapshot): CapturedSource {
  // No plannedGroupId exemption: every known block target already has a ledger.
  // A stored ACK is parsed as that exact historical side, never today's paths.
  const entries = readSyncedBindingSources(db, snapshot.origin, snapshot.blocks, snapshot.bindings)
  const source = canonicalSyncedPortableJson({ groupId: snapshot.groupId, creationId: snapshot.creationId,
    createdAt: snapshot.createdAt, origin: snapshot.origin, entries })
  return { entries, digest: createHash('sha256').update(source).digest('hex') }
}
function ownRead(db: Database.Database): void {
  if (db.inTransaction) throw new Error('同步块来源读取必须独占只读事务，不能为尚未提交的内容签票。')
}
function ownerInput(input: unknown, fields: readonly string[]): Record<string, string> {
  assertSyncedShape(input, fields)
  const descriptors = Object.getOwnPropertyDescriptors(input), result: Record<string, string> = {}
  if (Reflect.ownKeys(descriptors).length !== fields.length) return fail('同步块来源 owner 参数必须为封闭 UUID 对象。')
  for (const field of fields) {
    const descriptor = descriptors[field]
    if (!descriptor || !('value' in descriptor) || !isSyncedUuid(descriptor.value)) {
      return fail('同步块来源 owner 身份无效。')
    }
    result[field] = descriptor.value
  }
  return result
}
function newRegistry(workspace: Workspace): Registry {
  // Serialized retained data and all index keys/references count. Numeric
  // counters are charged at their maximum width rather than on every mutation.
  const bytes = bytesOf({ epoch: workspace.epoch, bytes: SYNCED_BINDING_SOURCE_LIMITS.bytes,
    tickets: [], digests: [], payloads: [], owners: [] })
  return { epoch: workspace.epoch, bytes, tickets: new Map(), digests: new Map(), payloads: new Map(), owners: new Map() }
}
function newPayload(source: CapturedSource): Payload {
  const entries = structuredClone(source.entries), digest = source.digest
  const bytes = bytesOf({ digest, entries, references: SYNCED_BINDING_SOURCE_LIMITS.tickets,
    payloadIndex: [digest, digest], bytes: SYNCED_BINDING_SOURCE_LIMITS.bytes })
  return { digest, entries, bytes, references: 0 }
}
function newTicket(payload: Payload, owner: ReadOwner | null): Ticket {
  const ticketId = randomUUID(), ownerId = owner?.readOwnerId ?? null, digest = payload.digest
  const entryIndices = new Map<string, number>()
  const publicSource: SyncedBindingSource = { ticketId, entries: payload.entries.map((value, index) => {
    const entryId = randomUUID()
    entryIndices.set(entryId, index)
    return { entryId, key: structuredClone(value.key) }
  }) }
  const bytes = bytesOf({ ticketId, digest, ownerId, payloadDigest: payload.digest, entryIndices: [...entryIndices], publicSource,
    ticketIndex: [ticketId, ticketId], sourceIndex: [digest, ticketId], payloadReference: ticketId,
    bytes: SYNCED_BINDING_SOURCE_LIMITS.bytes })
  return { ticketId, digest, ownerId, payload, entryIndices, publicSource, bytes }
}
function newOwner(groupId: string, capturedIncarnation: string): ReadOwner {
  const readOwnerId = randomUUID()
  const bytes = bytesOf({ readOwnerId, groupId, incarnation: capturedIncarnation, aliases: [],
    ownerIndex: [readOwnerId, readOwnerId], bytes: SYNCED_BINDING_SOURCE_LIMITS.bytes })
  return { readOwnerId, groupId, incarnation: capturedIncarnation, aliases: new Map(), bytes }
}

/** All callers reach this only after their owned read has ended. Reuse and all
 * new payloads/aliases/owners are planned before the registry changes at all. */
function publishCapturedSources(db: Database.Database, workspace: Workspace,
  sources: readonly (CapturedSource | null)[], owner: ReadOwner | null = null, publishOwner = false): Array<SyncedBindingSource | null> {
  const previous = registries.get(db)
  const registry = previous?.epoch === workspace.epoch ? previous : newRegistry(workspace)
  if (owner && !publishOwner && registry.owners.get(owner.readOwnerId) !== owner) return fail('同步块来源 owner 已失效。')
  const pendingPayloads = new Map<string, Payload>(), pendingTickets = new Map<string, Ticket>()
  const tickets = sources.map(source => {
    if (!source) return null
    // Legacy dedup never borrows an owned alias; an owner never borrows a
    // different owner's alias even when their immutable payload is shared.
    const old = (owner ? owner.aliases : registry.digests).get(source.digest) ?? pendingTickets.get(source.digest)
    if (old) return old
    let payload = registry.payloads.get(source.digest) ?? pendingPayloads.get(source.digest)
    if (!payload) { payload = newPayload(source); pendingPayloads.set(source.digest, payload) }
    const ticket = newTicket(payload, owner)
    pendingTickets.set(source.digest, ticket)
    return ticket
  })
  const addedBytes = [...pendingPayloads.values()].reduce((total, payload) => total + payload.bytes, 0)
    + [...pendingTickets.values()].reduce((total, ticket) => total + ticket.bytes, 0) + (publishOwner ? owner!.bytes : 0)
  const addedSlots = pendingTickets.size + (publishOwner ? 1 : 0)
  if (registry.tickets.size + registry.owners.size + addedSlots > SYNCED_BINDING_SOURCE_LIMITS.tickets
    || registry.bytes + addedBytes > SYNCED_BINDING_SOURCE_LIMITS.bytes) {
    return fail('同步块复制来源内存容量已满，未签发新票；现有来源保持有效。')
  }
  // Clone all outward handles before publication, including the reuse path.
  const result = tickets.map(ticket => ticket ? structuredClone(ticket.publicSource) : null)
  for (const payload of pendingPayloads.values()) registry.payloads.set(payload.digest, payload)
  for (const ticket of pendingTickets.values()) {
    registry.tickets.set(ticket.ticketId, ticket)
    ;(owner ? owner.aliases : registry.digests).set(ticket.digest, ticket)
    ticket.payload.references++
  }
  if (publishOwner) registry.owners.set(owner!.readOwnerId, owner!)
  registry.bytes += addedBytes
  registries.set(db, registry)
  return result
}

/** Owned read only: signing inside a writer's uncommitted after-state would let
 * a rolled-back draft become a trusted source. Publish only after this read ends. */
export function getSyncedGroupSnapshotsWithLinkSources(db: Database.Database, input: unknown): SyncedGroupSnapshotsWithLinkSourcesResult {
  ownRead(db)
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
  ownRead(db)
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

/** One real baseline, its sources and immutable group identity share the same
 * SQLite read. A missing/retired snapshot publishes neither an owner nor a ticket. */
export function captureSyncedBaselineOwner(db: Database.Database, input: unknown): SyncedBaselineOwnerResult {
  ownRead(db)
  const { groupId } = ownerInput(input, ['groupId'])
  const captured = db.transaction(() => {
    const workspace = identity(db), result = getSyncedGroupSnapshots(db, { groupIds: [groupId] })
    if (result.workspaceScope !== workspace.scope) return fail('同步块读取与来源 owner 不属于同一工作区。')
    const item = result.items[0]
    if (item.status === 'missing') return { workspace, item, capturedIncarnation: null, source: null }
    const capturedIncarnation = currentIncarnation(db, groupId)
    if (capturedIncarnation !== incarnation(item.snapshot)) return fail('同步块完整基线与真实组身份不一致。')
    return { workspace, item, capturedIncarnation, source: captureSource(db, item.snapshot) }
  })()
  if (captured.item.status === 'missing') return { status: 'missing', workspaceScope: captured.workspace.scope, groupId }
  const owner = newOwner(groupId, captured.capturedIncarnation!)
  const [bindingSource] = publishCapturedSources(db, captured.workspace, [captured.source!], owner, true)
  return { status: 'ready', workspaceScope: captured.workspace.scope, readOwnerId: owner.readOwnerId,
    snapshot: captured.item.snapshot, bindingSource: bindingSource! }
}

/** Validate this original capability in one owned read without allocating a
 * ticket or probing an unrelated operation. Final copy resolution still rechecks
 * the owner: this result describes this read, not a future writer lease. */
export function validateSyncedReadOwner(db: Database.Database, input: unknown): SyncedReadOwnerValidationResult {
  ownRead(db)
  const { readOwnerId } = ownerInput(input, ['readOwnerId'])
  const registry = registries.get(db), owner = registry?.owners.get(readOwnerId)
  if (!registry || !owner) return { status: 'owner-unavailable' }
  return db.transaction((): SyncedReadOwnerValidationResult => {
    const workspace = identity(db)
    if (registry.epoch !== workspace.epoch || currentIncarnation(db, owner.groupId) !== owner.incarnation) {
      return { status: 'owner-unavailable' }
    }
    return { status: 'ready', workspaceScope: workspace.scope }
  })()
}

/** Read the original stored ACK for this exact owner incarnation. No current
 * path lookup, executable history row, current CAS or mount may substitute it. */
export function getSyncedOperationWithOwnedLinkSource(db: Database.Database, input: unknown): SyncedOwnedOperationWithLinkSourceResult {
  ownRead(db)
  const { readOwnerId, clientOperationId } = ownerInput(input, ['readOwnerId', 'clientOperationId'])
  const registry = registries.get(db), owner = registry?.owners.get(readOwnerId)
  if (!registry || !owner) return { status: 'owner-unavailable' }
  const captured = db.transaction(() => {
    const workspace = identity(db)
    if (registry.epoch !== workspace.epoch || currentIncarnation(db, owner.groupId) !== owner.incarnation) return null
    const row = readSyncedGroupOperationRow(db, clientOperationId)
    if (!row) return { workspace, operation: null }
    const result = { ...decodeSyncedGroupOperationAck(row), replayed: true }
    if (incarnation(result.snapshot) !== owner.incarnation) return fail('同步块原操作收据与来源 owner 的原组身份不一致。')
    return { workspace, operation: { result, source: captureSource(db, result.snapshot) } }
  })()
  if (!captured) return { status: 'owner-unavailable' }
  if (!captured.operation) return { status: 'unknown-operation' }
  const [bindingSource] = publishCapturedSources(db, captured.workspace, [captured.operation.source], owner)
  return { status: 'committed', workspaceScope: captured.workspace.scope,
    result: captured.operation.result, bindingSource: bindingSource! }
}

/** Pure memory cleanup, including inside a writer or after epoch replacement.
 * It never signs a new source, reads SQLite, or revokes another owner's alias. */
export function releaseSyncedReadOwner(db: Database.Database, input: unknown): void {
  const { readOwnerId } = ownerInput(input, ['readOwnerId']), registry = registries.get(db), owner = registry?.owners.get(readOwnerId)
  if (!registry || !owner) return
  for (const ticket of owner.aliases.values()) {
    registry.tickets.delete(ticket.ticketId)
    registry.bytes -= ticket.bytes
    if (--ticket.payload.references === 0) {
      registry.payloads.delete(ticket.digest)
      registry.bytes -= ticket.payload.bytes
    }
  }
  owner.aliases.clear()
  registry.owners.delete(readOwnerId)
  registry.bytes -= owner.bytes
}

/** Connection-bound and recovery-bound; revisions/history trimming do not
 * invalidate sources. Owned aliases additionally require their original owner. */
export function resolveSyncedBindingSource(db: Database.Database, ticketId: string, entryId: string): SyncedVerifiedBindingSource {
  if (!isSyncedUuid(ticketId) || !isSyncedUuid(entryId)) return fail('同步块复制来源票格式无效。')
  const workspace = identity(db), registry = registries.get(db)
  const ticket = registry?.epoch === workspace.epoch ? registry.tickets.get(ticketId) : undefined
  const index = ticket?.entryIndices.get(entryId)
  if (ticket?.ownerId) {
    const owner = registry!.owners.get(ticket.ownerId)
    // No transaction is opened here: a copy claim resolves in its writer's
    // real transaction. A temporary mismatch does not destroy the old owner.
    if (!owner || owner.aliases.get(ticket.digest) !== ticket || currentIncarnation(db, owner.groupId) !== owner.incarnation) {
      return fail('同步块复制来源 owner 已失效；保留草稿，不会按 URL 重新绑定。')
    }
  }
  const entry = index === undefined ? undefined : ticket!.payload.entries[index]
  if (!entry) return fail('同步块复制来源已失效（应用重启或恢复后需重新复制）；保留草稿，不会按 URL 重新绑定。')
  return structuredClone(entry)
}
