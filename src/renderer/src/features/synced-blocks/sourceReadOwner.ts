import type { SyncedBindingSource, SyncedGroupSaved, SyncedGroupSnapshot } from '@shared/synced-blocks'
import { isSyncedUuid, syncedCanonicalEdits, validateSyncedGroupSnapshot } from '@shared/syncedBlockValidation'
import { validateSyncedBindingKey } from '@shared/syncedBlockInputs'
import { collectDocumentMarkdownLinks } from '@shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '@shared/markdownLinks'
import { readSyncedCommittedEndpoint, readSyncedWorkingEndpoint, readSyncedWorkingEndpointCommitted,
  type SyncedCommittedEndpointReceipt, type SyncedWorkingEndpointReceipt, type SyncedSourceReadOwnerFence } from './controller'
import { readSourceReadOwnerAccess, installSourceHistorySide, revokeSourceHistoryOwner, type SourceCheckpoint, type AcceptedSourceCheckpoint, type AcceptedSourceCheckpointFacts } from './sourceLedger'
import { createDomain, createConsumer, issueWitness, revokeConsumer, whenDomainDrained, domainDrained,
  type CopyDomain, type DomainIssuer, type ConsumerIssuer, type WitnessLease } from './sourceCopyResources'
import type { SyncedBindingKey } from '@shared/synced-blocks'

/** Trusted private adapters only. No production Store/IPC/UI is connected here. */
export interface SyncedReadSourcesPort {
  captureBaseline(input: { groupId: string }): Promise<
    | { status: 'ready'; workspaceScope: string; readOwnerId: string; snapshot: SyncedGroupSnapshot; bindingSource: SyncedBindingSource }
    | { status: 'missing'; workspaceScope: string; groupId: string }>
  operation(input: { readOwnerId: string; clientOperationId: string }): Promise<
    | { status: 'owner-unavailable' } | { status: 'unknown-operation' }
    | { status: 'committed'; workspaceScope: string; result: SyncedGroupSaved; bindingSource: SyncedBindingSource }>
  validate(input: { readOwnerId: string }): Promise<
    | { status: 'ready'; workspaceScope: string } | { status: 'owner-unavailable' }>
  release(input: { readOwnerId: string }): Promise<void>
}

/** Only the registry's original initial-load context can reach a checkpoint. */
export interface ControllerReadOwnerContext { readonly kind: 'controller-read-owner'; readonly copyDomain: CopyDomain; release(): void }
export interface SourceReadOwner { readonly kind: 'source-read-owner' }
export interface AdoptedSourceSide { readonly kind: 'adopted-source-side' }
export interface AdoptedSourceSideFacts {
  readonly kind: 'baseline' | 'accepted' | 'opening'
  readonly snapshot: Readonly<SyncedGroupSnapshot>
  readonly bindingSource: Readonly<SyncedBindingSource>
  readonly endpoint: SyncedWorkingEndpointReceipt
  readonly committed: SyncedCommittedEndpointReceipt | null
}
export type SourceSideAdoptionResult = Readonly<{ status: 'adopted'; side: AdoptedSourceSide }>
  | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{ status: 'owner-unavailable' | 'unknown-operation' | 'waiting-original-ack' }>

/** Built inside the real ledger registry; raw response/operation IDs have no adoption entry point. */
export interface SourceReadOwnerAccess {
  readonly context: ControllerReadOwnerContext
  readonly endpoint: SyncedWorkingEndpointReceipt
  readonly snapshot: Readonly<SyncedGroupSnapshot>
  accepted(value: AcceptedSourceCheckpoint): AcceptedSourceCheckpointFacts | null
  capture(endpoint: SyncedWorkingEndpointReceipt): SyncedSourceReadOwnerFence | null
  finalize(endpoint: SyncedWorkingEndpointReceipt, fence: SyncedSourceReadOwnerFence, validate: () => boolean,
    accepted?: AcceptedSourceCheckpoint): boolean
}
export interface SourceHistoryRegistrationPermit { readonly kind: 'source-history-registration-permit' }
export type SourceHistoryRegistrationResult = Readonly<{ status: 'registered' | 'unavailable' | 'owner-unavailable' }>
type Context = {
  copyDomain: CopyDomain; copyIssuer: DomainIssuer
  port: SyncedReadSourcesPort; readOwnerId: string; workspaceScope: string
  snapshot: SyncedGroupSnapshot; source: SyncedBindingSource
  references: number; cleanup: Promise<void> | null; cleanupFailed: boolean
}
type Owner = { checkpoint: SourceCheckpoint; issuer: ConsumerIssuer; context: Context; access: SourceReadOwnerAccess; closed: boolean; requests: number; idle: Array<() => void> }
type SideProvenance = Readonly<{ kind: 'baseline' }>
  | Readonly<{ kind: 'accepted'; accepted: AcceptedSourceCheckpoint }>
  | Readonly<{ kind: 'opening'; endpoint: SyncedWorkingEndpointReceipt; committed: SyncedCommittedEndpointReceipt }>
const contexts = new WeakMap<ControllerReadOwnerContext, Context>()
const owners = new WeakMap<SourceReadOwner, Owner>()
const sides = new WeakMap<AdoptedSourceSide, { facts: AdoptedSourceSideFacts; owner: SourceReadOwner; provenance: SideProvenance }>()
const historyPermits = new WeakMap<SourceHistoryRegistrationPermit, { checkpoint: SourceCheckpoint; owner: SourceReadOwner; side: AdoptedSourceSide; accepted: AcceptedSourceCheckpoint | null; facts: AdoptedSourceSideFacts }>()
const historyEntryIndices = new WeakMap<SourceHistoryRegistrationPermit, ReadonlyMap<string, string>>()
const refused = (reason: string): SourceSideAdoptionResult => Object.freeze({ status: 'unavailable', reason })
const ownerUnavailable = Object.freeze({ status: 'owner-unavailable' as const })
const unknownOperation = Object.freeze({ status: 'unknown-operation' as const })
const waiting = Object.freeze({ status: 'waiting-original-ack' as const })

function fail(): never { throw new Error('Synced source read response is not exact closed data.') }
/** Reject accessors/symbols/cycles before any DTO codec reads a field. */
function copyData(input: unknown, depth = 0, active = new Set<object>()): unknown {
  if (input === null || typeof input === 'string' || typeof input === 'boolean' || typeof input === 'number') return input
  if (typeof input !== 'object' || depth > 32 || active.has(input)) return fail()
  const array = Array.isArray(input)
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail()
  const descriptors = Object.getOwnPropertyDescriptors(input), result: unknown[] | Record<string, unknown> = array ? [] : {}
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => typeof key !== 'string') || array && keys.length !== input.length + 1) return fail()
  active.add(input)
  try {
    for (const key of keys as string[]) {
      if (array && key === 'length') continue
      const descriptor = descriptors[key]
      if (!Object.hasOwn(descriptor, 'value') || array && !/^(0|[1-9]\d*)$/.test(key)) return fail()
      Object.defineProperty(result, key, { value: copyData(descriptor.value, depth + 1, active), enumerable: true,
        writable: true, configurable: true })
    }
  } finally { active.delete(input) }
  return result
}
function fields(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
  const value = input as Record<string, unknown>, keys = Object.keys(value)
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) return fail()
  return value
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, ordered(item)]))
  return value
}
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(ordered(left)) === JSON.stringify(ordered(right))
const keyId = (key: { blockId: string; from: number; to: number; raw: string; syntax: string }) =>
  JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
function sourceFor(snapshot: SyncedGroupSnapshot, input: unknown): SyncedBindingSource {
  const source = fields(input, ['ticketId', 'entries'])
  if (!isSyncedUuid(source.ticketId) || !Array.isArray(source.entries)) return fail()
  const actual = new Set<string>()
  for (const link of collectDocumentMarkdownLinks(snapshot.blocks)) {
    if (link.kind === 'image' || link.kind !== 'wiki' && !resolveMarkdownDocumentPath(snapshot.origin.pathAtCreation, link.url)) continue
    const block = snapshot.blocks[link.blockIndex]
    if (!block || block.id !== link.blockId || link.start < 0 || link.end > block.content.length || link.end < link.start) return fail()
    const id = keyId({ blockId: block.id, from: link.start, to: link.end,
      raw: block.content.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' })
    if (actual.has(id)) return fail()
    actual.add(id)
  }
  if (snapshot.bindings.length !== actual.size || snapshot.bindings.some(key => !actual.delete(keyId(key))) || actual.size) return fail()
  const expected = new Set(snapshot.bindings.map(keyId)), ids = new Set<string>()
  const entries = source.entries.map(raw => {
    const entry = fields(raw, ['entryId', 'key'])
    if (!isSyncedUuid(entry.entryId) || ids.has(entry.entryId)) return fail()
    ids.add(entry.entryId)
    const key = validateSyncedBindingKey(entry.key)
    if (!expected.delete(keyId(key))) return fail()
    return { entryId: entry.entryId, key }
  })
  if (expected.size) return fail()
  return freeze({ ticketId: source.ticketId, entries })
}
function portSnapshot(input: SyncedReadSourcesPort): SyncedReadSourcesPort {
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const methods = ['captureBaseline', 'operation', 'validate', 'release'] as const
  const result = {} as SyncedReadSourcesPort
  for (const key of methods) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return fail()
    const method = descriptor.value as (...args: unknown[]) => unknown
    Object.defineProperty(result, key, { value: (...args: unknown[]) => Reflect.apply(method, input, args), enumerable: true })
  }
  return Object.freeze(result)
}
function release(context: Context): Promise<void> | null {
  if (--context.references !== 0) return context.cleanup
  context.cleanup = Promise.resolve().then(async () => {
    await whenDomainDrained(context.copyIssuer)
    // references reached zero before this wait, so new retains are already refused.
    await context.port.release({ readOwnerId: context.readOwnerId })
  })
    .catch(() => { context.cleanupFailed = true })
  return context.cleanup
}
function retain(context: Context): boolean {
  if (context.references <= 0 || context.cleanupFailed) return false
  context.references++
  return true
}
function cleanupId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  try {
    const descriptors = Object.getOwnPropertyDescriptors(raw)
    const status = descriptors.status, id = descriptors.readOwnerId
    return status && 'value' in status && status.value === 'ready' && id && 'value' in id && isSyncedUuid(id.value) ? id.value : null
  } catch { return null }
}

/** Capture and validate in one initial-load branch. A failed ready DTO still
 * releases its own safely extracted Main owner exactly once. */
export async function captureControllerReadOwner(input: SyncedReadSourcesPort, groupId: string): Promise<
  | { status: 'ready'; workspaceScope: string; snapshot: SyncedGroupSnapshot; context: ControllerReadOwnerContext }
  | { status: 'missing'; workspaceScope: string; groupId: string }> {
  const port = portSnapshot(input), raw = await port.captureBaseline({ groupId }), issuedId = cleanupId(raw)
  try {
    const value = copyData(raw) as Record<string, unknown>
    if (value.status === 'missing') {
      fields(value, ['status', 'workspaceScope', 'groupId'])
      if (!isSyncedUuid(value.workspaceScope) || value.groupId !== groupId) return fail()
      return { status: 'missing', workspaceScope: value.workspaceScope, groupId }
    }
    fields(value, ['status', 'workspaceScope', 'readOwnerId', 'snapshot', 'bindingSource'])
    if (value.status !== 'ready' || !isSyncedUuid(value.workspaceScope) || !isSyncedUuid(value.readOwnerId)) return fail()
    const snapshot = freeze(validateSyncedGroupSnapshot(value.snapshot))
    if (snapshot.groupId !== groupId) return fail()
    const source = sourceFor(snapshot, value.bindingSource)
    const domain = createDomain()
    const saved: Context = { copyDomain: domain.domain, copyIssuer: domain.issuer, port, readOwnerId: value.readOwnerId, workspaceScope: value.workspaceScope,
      snapshot, source, references: 1, cleanup: null, cleanupFailed: false }
    let dropped = false
    const context: ControllerReadOwnerContext = Object.freeze({ kind: 'controller-read-owner', copyDomain: domain.domain, release: () => {
      if (!dropped) { dropped = true; release(saved) }
    } })
    contexts.set(context, saved)
    return { status: 'ready', workspaceScope: saved.workspaceScope, snapshot, context }
  } catch (error) {
    if (issuedId) { try { await port.release({ readOwnerId: issuedId }) } catch { /* No confirmed cleanup; never register the malformed owner. */ } }
    throw error
  }
}

export function openSourceReadOwner(checkpoint: SourceCheckpoint): SourceReadOwner | null {
  const access = readSourceReadOwnerAccess(checkpoint)
  if (!access) return null
  const context = contexts.get(access.context)
  if (!context || !retain(context)) return null
  if (!access.capture(access.endpoint)) { release(context); return null }
  const owner: SourceReadOwner = Object.freeze({ kind: 'source-read-owner' })
  owners.set(owner, { checkpoint, issuer: createConsumer(context.copyIssuer).issuer, context, access, closed: false, requests: 0, idle: [] })
  return owner
}
function begin(value: SourceReadOwner): Owner | null {
  const owner = owners.get(value)
  if (!owner || owner.closed || !retain(owner.context)) return null
  owner.requests++
  return owner
}
function finish(owner: Owner): void {
  release(owner.context)
  if (--owner.requests === 0) for (const resolve of owner.idle.splice(0)) resolve()
}
function final(owner: Owner, endpoint: SyncedWorkingEndpointReceipt, fence: SyncedSourceReadOwnerFence,
  accepted?: AcceptedSourceCheckpoint): boolean {
  return !owner.closed && owner.access.finalize(endpoint, fence, () => !owner.closed, accepted) && !owner.closed
}
function adopted(value: SourceReadOwner, owner: Owner, facts: AdoptedSourceSideFacts, provenance: SideProvenance): SourceSideAdoptionResult {
  if (owner.closed) return refused('closed')
  const side: AdoptedSourceSide = Object.freeze({ kind: 'adopted-source-side' })
  sides.set(side, { facts: Object.freeze(facts), owner: value, provenance: Object.freeze(provenance) })
  return Object.freeze({ status: 'adopted', side })
}
export async function adoptSourceBaseline(value: SourceReadOwner): Promise<SourceSideAdoptionResult> {
  const owner = begin(value)
  if (!owner) return refused('unknown-or-closed-owner')
  try {
    const { access, context } = owner, fence = access.capture(access.endpoint)
    if (!fence) return refused('stale-local-context')
    const endpoint = readSyncedWorkingEndpoint(access.endpoint)
    if (endpoint.status !== 'available') return refused('not-original-baseline')
    if (endpoint.kind !== 'baseline') return endpoint.committed ? refused('not-original-baseline') : waiting
    if (!equal(endpoint.baseline, access.snapshot) || !equal(access.snapshot, context.snapshot)) return refused('baseline-mismatch')
    const raw = copyData(await context.port.validate({ readOwnerId: context.readOwnerId })) as Record<string, unknown>
    if (raw.status === 'owner-unavailable') { fields(raw, ['status']); return ownerUnavailable }
    fields(raw, ['status', 'workspaceScope'])
    if (raw.status !== 'ready' || raw.workspaceScope !== context.workspaceScope || !isSyncedUuid(raw.workspaceScope)) return refused('workspace-mismatch')
    if (!final(owner, access.endpoint, fence)) return refused('stale-local-context')
    return adopted(value, owner, { kind: 'baseline', snapshot: context.snapshot, bindingSource: context.source, endpoint: access.endpoint, committed: null }, { kind: 'baseline' })
  } catch { return refused('invalid-or-failed-read') } finally { finish(owner) }
}
export async function adoptAcceptedSource(value: SourceReadOwner, accepted: AcceptedSourceCheckpoint): Promise<SourceSideAdoptionResult> {
  const owner = begin(value)
  if (!owner) return refused('unknown-or-closed-owner')
  try {
    const facts = owner.access.accepted(accepted)
    if (!facts) return refused('foreign-acceptance')
    if (!facts.committed) return waiting
    const fence = owner.access.capture(facts.endpoint)
    if (!fence) return refused('stale-local-context')
    const committed = readSyncedCommittedEndpoint(facts.committed)
    if (!committed) return refused('missing-original-ack')
    const { context } = owner, raw = copyData(await context.port.operation({ readOwnerId: context.readOwnerId,
      clientOperationId: committed.ack.operationId })) as Record<string, unknown>
    if (raw.status === 'owner-unavailable' || raw.status === 'unknown-operation') {
      fields(raw, ['status']); return raw.status === 'owner-unavailable' ? ownerUnavailable : unknownOperation
    }
    fields(raw, ['status', 'workspaceScope', 'result', 'bindingSource'])
    if (raw.status !== 'committed' || raw.workspaceScope !== context.workspaceScope || !isSyncedUuid(raw.workspaceScope)) return refused('workspace-mismatch')
    const result = fields(raw.result, ['status', 'operationId', 'snapshot', 'replayed'])
    if ((result.status !== 'saved' && result.status !== 'noop') || !isSyncedUuid(result.operationId) || result.replayed !== true
      || result.operationId !== committed.ack.operationId || result.status !== committed.ack.status) return refused('ack-mismatch')
    const snapshot = freeze(validateSyncedGroupSnapshot(result.snapshot))
    if (!equal(snapshot, committed.ack.snapshot)) return refused('ack-snapshot-mismatch')
    const bindingSource = sourceFor(snapshot, raw.bindingSource)
    if (owner.access.accepted(accepted)?.committed !== facts.committed || !final(owner, facts.endpoint, fence, accepted)) return refused('stale-local-context')
    return adopted(value, owner, { kind: 'accepted', snapshot, bindingSource, endpoint: facts.endpoint, committed: facts.committed }, { kind: 'accepted', accepted })
  } catch { return refused('invalid-or-failed-read') } finally { finish(owner) }
}
/** A Rich opening has no SourceAccepted handle. Only its original content
 * Endpoint's own mailbox can select an operation; this never flushes or guesses. */
export async function adoptSourceOpening(value: SourceReadOwner): Promise<SourceSideAdoptionResult> {
  const owner = begin(value)
  if (!owner) return refused('unknown-or-closed-owner')
  try {
    const { access, context } = owner, fence = access.capture(access.endpoint)
    if (!fence) return refused('stale-local-context')
    const opening = readSyncedWorkingEndpoint(access.endpoint)
    if (opening.status !== 'available' || opening.kind !== 'content') return refused('not-content-opening')
    const receipt = readSyncedWorkingEndpointCommitted(access.endpoint)
    if (!receipt) return final(owner, access.endpoint, fence) ? waiting : refused('stale-local-context')
    const committed = readSyncedCommittedEndpoint(receipt), baseline = access.snapshot
    if (!committed || committed.ack.snapshot.groupId !== baseline.groupId || committed.ack.snapshot.creationId !== baseline.creationId
      || committed.ack.snapshot.createdAt !== baseline.createdAt || !equal(committed.ack.snapshot.origin, baseline.origin)
      || !equal(syncedCanonicalEdits(committed.ack.snapshot.blocks), opening.working)) return refused('opening-ack-mismatch')
    const raw = copyData(await context.port.operation({ readOwnerId: context.readOwnerId,
      clientOperationId: committed.ack.operationId })) as Record<string, unknown>
    if (raw.status === 'owner-unavailable' || raw.status === 'unknown-operation') {
      fields(raw, ['status']); return raw.status === 'owner-unavailable' ? ownerUnavailable : unknownOperation
    }
    fields(raw, ['status', 'workspaceScope', 'result', 'bindingSource'])
    if (raw.status !== 'committed' || raw.workspaceScope !== context.workspaceScope || !isSyncedUuid(raw.workspaceScope)) return refused('workspace-mismatch')
    const result = fields(raw.result, ['status', 'operationId', 'snapshot', 'replayed'])
    if ((result.status !== 'saved' && result.status !== 'noop') || !isSyncedUuid(result.operationId) || result.replayed !== true
      || result.operationId !== committed.ack.operationId || result.status !== committed.ack.status) return refused('ack-mismatch')
    const snapshot = freeze(validateSyncedGroupSnapshot(result.snapshot))
    if (!equal(snapshot, committed.ack.snapshot) || !equal(syncedCanonicalEdits(snapshot.blocks), opening.working)) return refused('ack-snapshot-mismatch')
    const bindingSource = sourceFor(snapshot, raw.bindingSource)
    if (readSyncedWorkingEndpointCommitted(access.endpoint) !== receipt || !final(owner, access.endpoint, fence)) return refused('stale-local-context')
    return adopted(value, owner, { kind: 'opening', snapshot, bindingSource, endpoint: access.endpoint, committed: receipt },
      { kind: 'opening', endpoint: access.endpoint, committed: receipt })
  } catch { return refused('invalid-or-failed-read') } finally { finish(owner) }
}
export async function closeSourceReadOwner(value: SourceReadOwner): Promise<void> {
  const owner = owners.get(value)
  if (!owner) return
  if (!owner.closed) { owner.closed = true; revokeConsumer(owner.issuer); revokeSourceHistoryOwner(value); release(owner.context) }
  if (owner.requests) await new Promise<void>(resolve => owner.idle.push(resolve))
  if (domainDrained(owner.context.copyIssuer)) await owner.context.cleanup
}
/** Frozen facts describe the successful read instant, not a permanent writer lease. */
export function readAdoptedSourceSide(side: AdoptedSourceSide): AdoptedSourceSideFacts | null { return sides.get(side)?.facts ?? null }

const historyKey = (key: Readonly<SyncedBindingKey>) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
export async function registerHistorySide(checkpoint: SourceCheckpoint, side: AdoptedSourceSide): Promise<SourceHistoryRegistrationResult> {
  const record = sides.get(side), value = record?.owner, owner = value && begin(value)
  if (!record || !value || !owner) return { status: 'unavailable' }
  try {
    if (owner.checkpoint !== checkpoint) return { status: 'unavailable' }
    const accepted = record.provenance.kind === 'accepted' ? record.provenance.accepted : null
    if (record.provenance.kind === 'opening' && (record.provenance.endpoint !== owner.access.endpoint
      || record.facts.endpoint !== record.provenance.endpoint || record.facts.committed !== record.provenance.committed
      || readSyncedWorkingEndpointCommitted(record.provenance.endpoint) !== record.provenance.committed)) return { status: 'unavailable' }
    const fence = owner.access.capture(record.facts.endpoint)
    if (!fence) return { status: 'unavailable' }
    const raw = copyData(await owner.context.port.validate({ readOwnerId: owner.context.readOwnerId })) as Record<string, unknown>
    if (raw.status === 'owner-unavailable') { fields(raw, ['status']); return ownerUnavailable }
    fields(raw, ['status', 'workspaceScope'])
    if (raw.status !== 'ready' || raw.workspaceScope !== owner.context.workspaceScope
      || !final(owner, record.facts.endpoint, fence, accepted ?? undefined)) return { status: 'unavailable' }
    const permit: SourceHistoryRegistrationPermit = Object.freeze({ kind: 'source-history-registration-permit' })
    historyEntryIndices.set(permit, new Map(record.facts.bindingSource.entries.map(entry => [historyKey(entry.key), entry.entryId])))
    historyPermits.set(permit, { checkpoint, owner: value, side, accepted, facts: record.facts })
    try { return { status: installSourceHistorySide(permit) ? 'registered' : 'unavailable' } }
    finally { historyPermits.delete(permit); historyEntryIndices.delete(permit) }
  } catch { return { status: 'unavailable' } } finally { finish(owner) }
}
export function readHistoryRegistration(permit: SourceHistoryRegistrationPermit) { return historyPermits.get(permit) ?? null }
export function issueHistoryWitness(permit: SourceHistoryRegistrationPermit, key: Readonly<SyncedBindingKey>): WitnessLease | null {
  const record = historyPermits.get(permit), owner = record && owners.get(record.owner)
  if (!record || !owner || owner.closed) return null
  const entryId = historyEntryIndices.get(permit)?.get(historyKey(key))
  return entryId ? issueWitness(owner.issuer, { ticketId: record.facts.bindingSource.ticketId, entryId }) : null
}
