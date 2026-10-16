import type {
  SyncedBindingClaim, SyncedBlocksApi, SyncedCanonicalEdit, SyncedGroupMutationResult, SyncedGroupSaved, SyncedGroupSnapshot,
  SyncedInstanceGuard, SyncedOriginV1, SyncedRestoreGroupInput, SyncedUpdateGroupInput
} from '@shared/synced-blocks'
import { SyncedValidationError, syncedCanonicalEdits, validateSyncedCanonicalEdit, validateSyncedCanonicalProjection,
  validateSyncedGroupSnapshot } from '@shared/syncedBlockValidation'
import type {
  SyncedGroupApply, SyncedGroupBinding, SyncedGroupController, SyncedGroupDraftState, SyncedGroupScope, SyncedScopeBookmark
} from './types'
import { syncedScopeInstanceGuard, syncedSnapshotGuard } from './types'
import { composeSyncedBindingClaims, syncedBindingClaimsAreIdentity, validateSyncedWorkingClaims } from './bindingClaims'

import type { SyncedReadSourcesPort, ControllerReadOwnerContext } from './sourceReadOwner'
import { reserveApply, planFrameUpdate, commitFramePlan, cancelPlan, cancelReservation, dropFrame, pinPending, dropPending, pendingMatches,
  type PreparedBatch, type ApplyReservation, type FramePlan, type FrameLease, type PendingLease } from './sourceCopyResources'
interface SourceCopyApply { readonly preparation: object; readonly batch: PreparedBatch }

/** Local read capabilities only. Public fields cannot reconstruct ownership. */
export interface SyncedWorkingEndpointReceipt { readonly kind: 'synced-working-endpoint' }
export interface SyncedCommittedEndpointReceipt { readonly kind: 'synced-committed-endpoint' }
export interface SyncedSourceReadOwnerFence { readonly kind: 'synced-source-read-owner-fence' }
export type SyncedWorkingEndpointRead = Readonly<{ status: 'unavailable' }> | Readonly<{
  status: 'available'; current: boolean; editSequence: number; groupId: string; creationId: string;
  working: readonly Readonly<SyncedCanonicalEdit>[];
} & (
  | { kind: 'baseline'; transactionId: null; baseline: Readonly<SyncedGroupSnapshot>; committed: null }
  | { kind: 'content'; transactionId: string; baseline: null; committed: SyncedCommittedEndpointReceipt | null }
)>;
export type SyncedCommittedEndpointFacts = Readonly<{
  submittedEditSequence: number; acceptedEditSequence: number; transactionId: string; ack: Readonly<SyncedGroupSaved>
}>;
export type SyncedEndpointApplyResult = Readonly<{ accepted: false }>
  | Readonly<{ accepted: true; endpoint: SyncedWorkingEndpointReceipt }>;
type EndpointPort = { capture: () => SyncedWorkingEndpointReceipt | null;
  source: (validation?: SyncedSourceEndpointValidation) => SyncedSourceEndpointOpening | null;
  adopt: (context: ControllerReadOwnerContext, endpoint: SyncedWorkingEndpointReceipt, validate: () => boolean,
    fence?: SyncedSourceReadOwnerFence) => SyncedSourceReadOwnerFence | null;
  apply: (input: Omit<SyncedGroupApply, 'scope'>, validateSource?: () => boolean, copy?: SourceCopyApply) => SyncedEndpointApplyResult }
interface SyncedSourceEndpointValidation {
  readonly expected: SyncedWorkingEndpointReceipt
  readonly validate: () => boolean
}
export interface SyncedSourceEndpointOpening {
  readonly snapshot: Readonly<SyncedGroupSnapshot>
  readonly readOwner: ControllerReadOwnerContext | null
  readonly endpoint: SyncedWorkingEndpointReceipt
  readonly working: readonly Readonly<SyncedCanonicalEdit>[]
  readonly origin: Readonly<SyncedOriginV1>
  readonly lease: Readonly<{
    scope: Readonly<{ groupId: string; hostDocumentId: string; windowSessionId: string; hostSession: object;
      mountEpoch: object; bindingEpoch: object; instanceId: string; bindingVersion: string }>
    expectedEditSequence: number
    guards: Readonly<{ groupId: string; expectedRevision: string; expectedTopologyRevision: string }>
  }>
}
const endpointPorts = new WeakMap<SyncedGroupBinding, EndpointPort>()
const endpointReaders = new WeakMap<SyncedWorkingEndpointReceipt, () => SyncedWorkingEndpointRead>()
const endpointIdentities = new WeakMap<SyncedWorkingEndpointReceipt, Endpoint>()
const committedEndpoints = new WeakMap<SyncedCommittedEndpointReceipt, SyncedCommittedEndpointFacts>()
const unavailableEndpoint = Object.freeze({ status: 'unavailable' as const })
const refusedEndpointApply = Object.freeze({ accepted: false as const })
export function captureSyncedWorkingEndpoint(binding: SyncedGroupBinding): SyncedWorkingEndpointReceipt | null {
  try { return endpointPorts.get(binding)?.capture() ?? null } catch { return null }
}
/** Cold Source opening authority comes from this registered port, never the
 * binding's public methods or a caller-supplied snapshot/lease. No flush. */
export function captureSyncedSourceEndpoint(binding: SyncedGroupBinding, validation?: SyncedSourceEndpointValidation): SyncedSourceEndpointOpening | null {
  try { return endpointPorts.get(binding)?.source(validation) ?? null } catch { return null }
}
/** Internal Source adoption gate: original historical endpoints need not be current. */
export function finalizeSyncedSourceReadOwner(binding: SyncedGroupBinding, context: ControllerReadOwnerContext,
  endpoint: SyncedWorkingEndpointReceipt, validate: () => boolean, fence?: SyncedSourceReadOwnerFence): SyncedSourceReadOwnerFence | null {
  try { return endpointPorts.get(binding)?.adopt(context, endpoint, validate, fence) ?? null } catch { return null }
}
export function readSyncedWorkingEndpoint(receipt: SyncedWorkingEndpointReceipt): SyncedWorkingEndpointRead {
  try { return endpointReaders.get(receipt)?.() ?? unavailableEndpoint } catch { return unavailableEndpoint }
}
/** Read-only acknowledgement mailbox for the exact minted working view.
 * This never calls scope/live/getCurrent and grants no write or adoption lease. */
export function readSyncedWorkingEndpointCommitted(receipt: SyncedWorkingEndpointReceipt): SyncedCommittedEndpointReceipt | null {
  const endpoint = endpointIdentities.get(receipt)
  return endpoint ? committedEndpointReceipt(endpoint) : null
}
export function readSyncedCommittedEndpoint(receipt: SyncedCommittedEndpointReceipt): SyncedCommittedEndpointFacts | null {
  return committedEndpoints.get(receipt) ?? null
}
/** Real binding -> shared apply core, never apply:boolean + capture-latest.
 * In particular synchronous publication/reentry cannot change the returned handle. */
export function applySyncedGroupWithEndpoint(binding: SyncedGroupBinding, input: Omit<SyncedGroupApply, 'scope'>): SyncedEndpointApplyResult {
  return endpointPorts.get(binding)?.apply(input) ?? refusedEndpointApply
}
/** Source's actual grammar/draft validator runs after the shared apply core's
 * caller-owned scope/budget callbacks, immediately before pure final checks. */
export function applySyncedSourceGroupWithEndpoint(binding: SyncedGroupBinding, input: Omit<SyncedGroupApply, 'scope'>,
  validateSource: () => boolean, copy?: SourceCopyApply): SyncedEndpointApplyResult {
  return typeof validateSource === 'function' ? endpointPorts.get(binding)?.apply(input, validateSource, copy) ?? refusedEndpointApply : refusedEndpointApply
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child)
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
const equal = (left: SyncedCanonicalEdit[], right: SyncedCanonicalEdit[]) => JSON.stringify(ordered(left)) === JSON.stringify(ordered(right))
const semantic = ({ creationId, createdAt, origin, bindings, blocks }: SyncedGroupSnapshot) =>
  JSON.stringify(ordered({ creationId, createdAt, origin, bindings, blocks }))
const cloneBlocks = (blocks: SyncedCanonicalEdit[]) => immutable(structuredClone(blocks))
const sameInstance = (left: SyncedInstanceGuard, right: SyncedInstanceGuard) => left.instanceId === right.instanceId
  && left.hostDocumentId === right.hostDocumentId && left.bindingVersion === right.bindingVersion

function keepBookmark(bookmark: SyncedScopeBookmark | null): SyncedScopeBookmark | null {
  return bookmark && Object.freeze({ ...bookmark, owner: Object.freeze({ ...bookmark.owner }), selection: immutable(structuredClone(bookmark.selection)) })
}

/** Snapshot only declared own data, without evaluating accessors or retaining
 * mutable guards. Nested authored DTOs are still checked by their real codecs. */
function ownDataSnapshot<T extends object>(value: T, required: readonly string[], optional: readonly string[] = []): T {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('Synced apply requires a closed own-data input.')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))) throw new Error('Synced apply input fields are invalid.')
  const result = {} as T
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors]
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('Synced apply accessors are unsupported.')
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true })
  }
  return Object.freeze(result)
}
function snapshotApplyInput(value: SyncedGroupApply | Omit<SyncedGroupApply, 'scope'>, scope?: SyncedGroupScope): SyncedGroupApply {
  const fields = ['expectedEditSequence', 'guards', 'blocks', 'bookmark', 'transactionId']
  const data = ownDataSnapshot(value, scope ? fields : [...fields, 'scope'], ['bindingClaims'])
  const guards = ownDataSnapshot(data.guards, ['groupId', 'expectedRevision', 'expectedTopologyRevision'])
  return Object.freeze({ ...data, scope: scope ?? (data as SyncedGroupApply).scope, guards })
}

type Mount = {
  scope: SyncedGroupScope
  lease: Pick<SyncedGroupScope, 'hostDocumentId' | 'windowSessionId' | 'hostSession' | 'mountEpoch' | 'bindingEpoch' | 'instanceId' | 'bindingVersion'> & { groupId: string }
  bookmark: SyncedScopeBookmark | null
  bookmarkSequence: number
}
function sourceScopeCallback(mount: Mount): (() => boolean) | null {
  const descriptor = Object.getOwnPropertyDescriptor(mount.scope, 'isCurrent')
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function' ? descriptor.value : null
}
/** Inspect own data only. A Source grammar callback cannot replace a lease
 * value or install an accessor and thereby add another callback after validation. */
function sourceScopeMatches(mount: Mount, callback: () => boolean): boolean {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(mount.scope)
    const value = (fields: PropertyDescriptorMap, key: string): unknown => {
      const descriptor = fields[key]
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    }
    if (value(descriptors, 'isCurrent') !== callback) return false
    for (const [key, expected] of Object.entries(mount.lease))
      if (key !== 'groupId' && value(descriptors, key) !== expected) return false
    const owner = value(descriptors, 'owner')
    if (!owner || typeof owner !== 'object') return false
    const ownerDescriptors = Object.getOwnPropertyDescriptors(owner)
    return value(ownerDescriptors, 'kind') === 'synced-group' && value(ownerDescriptors, 'groupId') === mount.lease.groupId
  } catch { return false }
}
type Frame = {
  copyLease: FrameLease | null
  before: SyncedCanonicalEdit[]; after: SyncedCanonicalEdit[]; sequence: number
  bindingClaims?: SyncedBindingClaim[]
  mount: Mount; instance: SyncedInstanceGuard; transactionId: string; sealed: boolean
  beforeBookmark: SyncedScopeBookmark | null; afterBookmark: SyncedScopeBookmark | null
}
type FrameVersion = {
  frame: Frame | null; unavailable: boolean; copyLease: FrameLease | null;
  committed: Readonly<{ submittedSequence: number; ack: Readonly<SyncedGroupSaved> }> | null
}
type Endpoint = {
  epoch: object; version: FrameVersion | null;
  working: SyncedCanonicalEdit[]; sequence: number; groupId: string; creationId: string;
  topologyRevision: string;
  transactionId: string | null; baseline: SyncedGroupSnapshot | null; committed: SyncedCommittedEndpointReceipt | null
}
type ServerRedo = {
  revision: string; cursor: string; token: string; before: string; after: string
}
type Pending = {
  kind: 'content'; input: SyncedUpdateGroupInput; frame: Frame; sequence: number; uncertain: boolean; endpointVersion: FrameVersion | null; copyLease: PendingLease | null
} | {
  kind: 'history'; input: SyncedRestoreGroupInput; sequence: number; uncertain: boolean; mount: Mount; bookmarkSequence: number
  before: SyncedGroupSnapshot; redo: ServerRedo | null
}
function committedEndpointReceipt(endpoint: Endpoint): SyncedCommittedEndpointReceipt | null {
  const committed = endpoint.version?.committed
  if (!endpoint.committed && committed) {
    const receipt: SyncedCommittedEndpointReceipt = Object.freeze({ kind: 'synced-committed-endpoint' })
    committedEndpoints.set(receipt, Object.freeze({ submittedEditSequence: committed.submittedSequence,
      acceptedEditSequence: endpoint.sequence, transactionId: endpoint.transactionId!, ack: committed.ack }))
    endpoint.committed = receipt
  }
  return endpoint.committed
}

export interface SyncedControllerOptions {
  /** Private opt-in initial owned read; no production IPC or cached-workspace retrofit. */
  readSources?: SyncedReadSourcesPort
  operationId?: () => string
  /** A later portable-budget adapter may add a pure preflight; no filesystem is read here. */
  validateBudget?: (blocks: SyncedCanonicalEdit[], snapshot: SyncedGroupSnapshot) => void
  onSubscriberError?: (error: unknown) => void
}

/** Created only by its workspace registry, never by an individual occurrence. */
class GroupController implements SyncedGroupController {
  private state: SyncedGroupDraftState
  private readonly listeners = new Set<() => void>()
  private readonly mounts = new Map<string, Mount>()
  private readonly compositions = new Set<Mount>()
  private frames: Frame[] = []
  private redoFrames: Frame[] = []
  // Server Undos sit above the local Redo branch until their precise sides have
  // been redone. Merely refreshing a revision cannot authorize those old frames.
  private serverRedo: ServerRedo[] = []
  private cutServerRedo = false
  private pending: Pending | null = null
  private queue: Promise<void> = Promise.resolve()
  private historyBusy = false
  private workspaceInvalid = false
  private readonly knownOperations = new Set<string>()
  private readonly historyBookmarks = new Map<string, { before: SyncedScopeBookmark | null; after: SyncedScopeBookmark | null }>()
  private endpointEpoch: object = Object.freeze({})
  private currentEndpoint: Endpoint
  private readonly frameVersions = new WeakMap<Frame, FrameVersion>()

  constructor(private readonly api: SyncedBlocksApi, snapshot: SyncedGroupSnapshot, private readonly options: SyncedControllerOptions,
    private readOwner: ControllerReadOwnerContext | null = null) {
    snapshot = validateSyncedGroupSnapshot(snapshot)
    const blocks = syncedCanonicalEdits(snapshot.blocks)
    validateSyncedCanonicalProjection(blocks, snapshot.instances)
    this.state = immutable({ snapshot: structuredClone(snapshot), working: cloneBlocks(blocks), editSequence: 0, dirty: false,
      phase: 'clean', incoming: null, failure: null, error: null, pending: null, composingInstanceIds: [],
      canUndo: snapshot.history.undoToken !== null, canRedo: snapshot.history.redoToken !== null })
    this.currentEndpoint = this.baselineEndpoint(this.state.working, 0, this.state.snapshot)
  }

  private baselineEndpoint(working: SyncedCanonicalEdit[], sequence: number, snapshot: SyncedGroupSnapshot): Endpoint {
    return { epoch: this.endpointEpoch, version: null,
      working, sequence, groupId: snapshot.groupId, creationId: snapshot.creationId, topologyRevision: snapshot.topologyRevision,
      transactionId: null, baseline: snapshot, committed: null }
  }
  private frameEndpoint(frame: Frame, working: SyncedCanonicalEdit[], sequence: number, changed: boolean): Endpoint {
    let version = this.frameVersions.get(frame)
    if (!version || version.unavailable || changed) {
      if (version && !version.committed) { version.unavailable = true; version.frame = null }
      version = { frame, unavailable: false, committed: null, copyLease: frame.copyLease }
      this.frameVersions.set(frame, version)
    }
    const endpoint: Endpoint = { epoch: this.endpointEpoch, version,
      working, sequence, groupId: this.state.snapshot.groupId, creationId: this.state.snapshot.creationId,
      topologyRevision: this.state.snapshot.topologyRevision,
      transactionId: frame.transactionId, baseline: null, committed: null }
    return endpoint
  }
  /** Called only at actual state transitions with their known working result.
   * It never searches for a frame by body/ID/edit sequence. */
  private adoptEndpoint(working: SyncedCanonicalEdit[], sequence: number, snapshot = this.state.snapshot, changedFrame: Frame | null = null) {
    const frame = this.frames.at(-1)
    this.currentEndpoint = frame ? this.frameEndpoint(frame, working, sequence, frame === changedFrame) : this.baselineEndpoint(working, sequence, snapshot)
  }
  private expireEndpoints() {
    this.endpointEpoch = Object.freeze({})
    for (const frame of [...this.frames, ...this.redoFrames]) {
      const version = this.frameVersions.get(frame)
      if (version && !version.committed) { version.unavailable = true; version.frame = null }
    }
  }
  private endpointAvailable(endpoint: Endpoint): boolean {
    return !this.workspaceInvalid && !this.state.incoming && this.state.failure?.status !== 'conflict'
      && endpoint.epoch === this.endpointEpoch && !endpoint.version?.unavailable
      && endpoint.groupId === this.state.snapshot.groupId && endpoint.creationId === this.state.snapshot.creationId
      && endpoint.topologyRevision === this.state.snapshot.topologyRevision
      && (!endpoint.version?.frame || this.frameVersions.get(endpoint.version.frame) === endpoint.version)
  }
  private mintEndpoint(endpoint: Endpoint, isCurrent: () => boolean): SyncedWorkingEndpointReceipt {
    const receipt: SyncedWorkingEndpointReceipt = Object.freeze({ kind: 'synced-working-endpoint' })
    endpointIdentities.set(receipt, endpoint)
    endpointReaders.set(receipt, () => {
      if (!isCurrent() || !this.endpointAvailable(endpoint)) return unavailableEndpoint
      const common = { status: 'available' as const, current: endpoint === this.currentEndpoint, editSequence: endpoint.sequence,
        groupId: endpoint.groupId, creationId: endpoint.creationId, working: endpoint.working }
      return endpoint.baseline ? Object.freeze({ ...common, kind: 'baseline' as const, transactionId: null,
        baseline: endpoint.baseline, committed: null }) : Object.freeze({ ...common, kind: 'content' as const,
        transactionId: endpoint.transactionId!, baseline: null, committed: committedEndpointReceipt(endpoint) })
    })
    return receipt
  }

  getSnapshot = () => this.state
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify) } }
  private publish(patch: Partial<SyncedGroupDraftState> = {}) {
    const next = { ...this.state, ...patch }
    next.dirty = this.frames.length > 0
    next.pending = this.pending ? immutable({ clientOperationId: this.pending.input.clientOperationId, kind: this.pending.kind, editSequence: this.pending.sequence }) : null
    next.composingInstanceIds = immutable([...new Set([...this.compositions].map(mount => mount.lease.instanceId))])
    next.failure = next.failure && immutable(structuredClone(next.failure))
    next.phase = next.incoming || next.failure?.status === 'conflict' ? 'conflict'
      : next.error || next.failure ? 'error' : this.pending ? 'saving' : next.dirty ? 'dirty' : 'clean'
    next.canUndo = this.frames.length > 0 || next.snapshot.history.undoToken !== null
    next.canRedo = this.serverRedo.length > 0 || this.redoFrames.length > 0
      || (this.frames.length === 0 && !this.cutServerRedo && next.snapshot.history.redoToken !== null)
    this.state = Object.freeze(next)
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { try { this.options.onSubscriberError?.(error) } catch { /* A listener cannot reject an accepted transaction. */ } }
    }
  }

  private live(scope: SyncedGroupScope): Mount | undefined {
    const mount = this.mounts.get(scope.instanceId)
    const lease = mount?.lease
    return mount?.scope === scope && lease && scope.isCurrent() && this.mounts.get(lease.instanceId) === mount
      && scope.owner.groupId === lease.groupId
      && scope.owner.groupId === this.state.snapshot.groupId && scope.hostDocumentId === lease.hostDocumentId
      && scope.windowSessionId === lease.windowSessionId && scope.hostSession === lease.hostSession
      && scope.mountEpoch === lease.mountEpoch && scope.bindingEpoch === lease.bindingEpoch
      && scope.instanceId === lease.instanceId && scope.bindingVersion === lease.bindingVersion
      && this.state.snapshot.instances.some(instance => sameInstance(instance, syncedScopeInstanceGuard(scope))) ? mount : undefined
  }
  private sourceLive(mount: Mount, callback: () => boolean): Mount | undefined {
    if (!sourceScopeMatches(mount, callback) || !Reflect.apply(callback, mount.scope, []) || !sourceScopeMatches(mount, callback)) return undefined
    const lease = mount.lease
    return this.mounts.get(lease.instanceId) === mount && lease.groupId === this.state.snapshot.groupId
      && this.state.snapshot.instances.some(instance => sameInstance(instance, lease)) ? mount : undefined
  }
  private hasComposition() { return this.compositions.size > 0 }
  private bookmarkFits(scope: SyncedGroupScope, bookmark: SyncedScopeBookmark | null) {
    return !bookmark || bookmark.owner.kind === 'synced-group' && bookmark.owner.groupId === scope.owner.groupId
      && bookmark.instanceId === scope.instanceId && bookmark.mountEpoch === scope.mountEpoch && bookmark.bindingEpoch === scope.bindingEpoch
  }
  private sourceBookmarkFits(mount: Mount, bookmark: SyncedScopeBookmark | null) {
    const lease = mount.lease
    return !bookmark || bookmark.owner.kind === 'synced-group' && bookmark.owner.groupId === lease.groupId
      && bookmark.instanceId === lease.instanceId && bookmark.mountEpoch === lease.mountEpoch && bookmark.bindingEpoch === lease.bindingEpoch
  }

  bind = (scope: SyncedGroupScope): SyncedGroupBinding => {
    const mount: Mount = { scope, lease: { hostDocumentId: scope.hostDocumentId, windowSessionId: scope.windowSessionId,
      hostSession: scope.hostSession, mountEpoch: scope.mountEpoch, bindingEpoch: scope.bindingEpoch,
      instanceId: scope.instanceId, bindingVersion: scope.bindingVersion, groupId: scope.owner.groupId }, bookmark: null, bookmarkSequence: 0 }
    this.mounts.set(scope.instanceId, mount)
    let disposed = false
    const adoptionFences = new WeakMap<SyncedSourceReadOwnerFence, { state: SyncedGroupDraftState; current: Endpoint; endpoint: Endpoint; callback: () => boolean }>()
    const current = () => !disposed && this.live(scope) === mount && !disposed && this.mounts.get(mount.lease.instanceId) === mount
    const binding: SyncedGroupBinding = {
      scope, getCurrent: this.getSnapshot, subscribe: this.subscribe, isCurrent: current,
      apply: input => current() && this.applyCore(input, undefined, scope).accepted,
      checkpoint: () => { if (current()) this.checkpoint() },
      undo: () => current() ? this.undo(scope) : Promise.resolve(false),
      redo: () => current() ? this.redo(scope) : Promise.resolve(false),
      flush: options => current() ? this.flush(options) : Promise.resolve(false),
      setComposing: composing => {
        // A genuine late compositionend may settle its original mount; disposal
        // itself never fabricates compositionend or silently permits a flush.
        if (!composing && this.compositions.delete(mount)) { this.checkpoint(); this.publish() }
        else if (composing && current() && !this.compositions.has(mount)) { this.compositions.add(mount); this.checkpoint(); this.publish() }
      },
      getBookmark: () => current() ? mount.bookmark : null,
      setBookmark: bookmark => {
        if (current() && this.bookmarkFits(scope, bookmark)) { mount.bookmark = keepBookmark(bookmark); mount.bookmarkSequence++ }
      },
      dispose: () => {
        disposed = true
        if (this.mounts.get(scope.instanceId) === mount) { this.mounts.delete(scope.instanceId); this.checkpoint(); this.publish() }
      }
    }
    endpointPorts.set(binding, {
      capture: () => current() && this.endpointAvailable(this.currentEndpoint) ? this.mintEndpoint(this.currentEndpoint, current) : null,
      source: validation => {
        const state = this.state, endpoint = this.currentEndpoint
        const callback = sourceScopeCallback(mount)
        if (!callback || disposed || !this.sourceLive(mount, callback) || disposed || this.state !== state
          || this.currentEndpoint !== endpoint || !this.endpointAvailable(endpoint)) return null
        if (validation && (endpointIdentities.get(validation.expected) !== endpoint || validation.validate() !== true)) return null
        // No scope/parser callbacks after the validator: its grammar getters
        // may themselves dispose/rebind the occurrence or accept another edit.
        if (!sourceScopeMatches(mount, callback) || disposed || this.mounts.get(mount.lease.instanceId) !== mount || this.state !== state
          || this.currentEndpoint !== endpoint || !this.endpointAvailable(endpoint)) return null
        return Object.freeze({ endpoint: this.mintEndpoint(endpoint, current), working: endpoint.working, origin: state.snapshot.origin,
          snapshot: state.snapshot, readOwner: this.readOwner,
          lease: Object.freeze({ scope: Object.freeze({ ...mount.lease }), expectedEditSequence: state.editSequence,
            guards: Object.freeze(syncedSnapshotGuard(state.snapshot)) }) })
      },
      adopt: (context, receipt, validate, fence) => {
        const state = this.state, currentEndpoint = this.currentEndpoint, endpoint = endpointIdentities.get(receipt)
        const prior = fence && adoptionFences.get(fence)
        const callback = sourceScopeCallback(mount)
        if (fence && (!prior || prior.state !== state || prior.current !== currentEndpoint || prior.endpoint !== endpoint || prior.callback !== callback)) return null
        if (!endpoint || !callback || disposed || this.readOwner !== context || !this.sourceLive(mount, callback)
          || this.state !== state || this.currentEndpoint !== currentEndpoint || !this.endpointAvailable(endpoint) || validate() !== true) return null
        if (!sourceScopeMatches(mount, callback) || disposed || this.mounts.get(mount.lease.instanceId) !== mount
          || this.readOwner !== context || this.state !== state || this.currentEndpoint !== currentEndpoint || !this.endpointAvailable(endpoint)) return null
        if (fence) return fence
        const captured: SyncedSourceReadOwnerFence = Object.freeze({ kind: 'synced-source-read-owner-fence' })
        adoptionFences.set(captured, { state, current: currentEndpoint, endpoint, callback })
        return captured
      },
      apply: (input, validateSource, copy) => {
        const callback = validateSource ? sourceScopeCallback(mount) : null
        if (validateSource ? !callback || disposed || !this.sourceLive(mount, callback) || disposed : !current()) return refusedEndpointApply
        const result = this.applyCore(input, current, scope, validateSource, callback ? { mount, callback } : undefined, copy)
        return result.endpoint ? Object.freeze({ accepted: true, endpoint: result.endpoint }) : refusedEndpointApply
      }
    })
    return binding
  }

  private validated(blocks: unknown): SyncedCanonicalEdit[] {
    const checked = validateSyncedCanonicalEdit(blocks)
    validateSyncedCanonicalProjection(checked, this.state.snapshot.instances)
    this.options.validateBudget?.(checked, this.state.snapshot)
    return cloneBlocks(checked)
  }
  private rejected(error: unknown) {
    this.publish(error instanceof SyncedValidationError
      ? { failure: { status: 'invalid', code: error.code, blockingInstances: error.blockingInstances }, error: null }
      : { error: error instanceof Error ? error.message : 'Synced group operation failed.' })
  }

  apply = (input: SyncedGroupApply): boolean => this.applyCore(input).accepted
  private hasPendingHistory(): boolean { return this.pending?.kind === 'history' }
  private applyCore(rawInput: SyncedGroupApply | Omit<SyncedGroupApply, 'scope'>, endpointReader?: () => boolean,
    scope?: SyncedGroupScope, validateSource?: () => boolean,
    sourceLease?: { mount: Mount; callback: () => boolean }, copy?: SourceCopyApply): { accepted: boolean; endpoint?: SyncedWorkingEndpointReceipt } {
    const before = this.state
    let input: SyncedGroupApply
    try { input = snapshotApplyInput(rawInput, scope) } catch { return { accepted: false } }
    const mount = sourceLease ? this.sourceLive(sourceLease.mount, sourceLease.callback) : this.live(input.scope)
    if (sourceLease && !mount) return { accepted: false }
    const fits = sourceLease ? this.sourceBookmarkFits(sourceLease.mount, input.bookmark) : this.bookmarkFits(input.scope, input.bookmark), snapshot = before.snapshot
    if (!mount || !fits || this.state !== before || this.workspaceInvalid || this.historyBusy || this.hasPendingHistory()
      || typeof input.transactionId !== 'string' || !input.transactionId || input.expectedEditSequence !== before.editSequence
      || input.guards.groupId !== snapshot.groupId || input.guards.expectedRevision !== snapshot.revision
      || input.guards.expectedTopologyRevision !== snapshot.topologyRevision
      || [...this.compositions].some(other => other !== mount)) return { accepted: false }
    let next: SyncedCanonicalEdit[], claims: SyncedBindingClaim[] | undefined, bookmark: SyncedScopeBookmark | null
    try {
      next = this.validated(input.blocks)
      if (Object.hasOwn(input, 'bindingClaims')) claims = immutable(validateSyncedWorkingClaims(input.bindingClaims, before.working, next))
      bookmark = keepBookmark(input.bookmark)
    } catch (error) { this.rejected(error); return { accepted: false } }
    if (equal(next, before.working) && (!claims || syncedBindingClaimsAreIdentity(claims))) return { accepted: false }
    const capturedTail = this.frames.at(-1), capturedVersion = capturedTail && this.frameVersions.get(capturedTail), capturedPending = this.pending
    const merge = !!capturedTail && !capturedTail.sealed && capturedTail.mount === mount && capturedTail.transactionId === input.transactionId
      && (capturedTail.bindingClaims === undefined) === (claims === undefined)
    const resourcePath = !!copy || !!(merge && capturedTail?.copyLease)
    const captured = capturedTail && { sealed: capturedTail.sealed, sequence: capturedTail.sequence,
      claims: capturedTail.bindingClaims, after: capturedTail.after }
    let reservation: ApplyReservation | null = null, resourcePlan: FramePlan | null = null, resourceCommitted = false
    let plannedClaims: SyncedBindingClaim[] | undefined, pop = false
    if (resourcePath) {
      try { plannedClaims = merge && claims ? immutable(composeSyncedBindingClaims(capturedTail!.bindingClaims!, claims)) : claims }
      catch (error) { this.rejected(error); return { accepted: false } }
      pop = merge && equal(capturedTail!.before, next) && (!plannedClaims || syncedBindingClaimsAreIdentity(plannedClaims))
      if (copy) {
        let permit: SourceCopyApply
        try { permit = ownDataSnapshot(copy, ['preparation', 'batch']) } catch { return { accepted: false } }
        if (!this.readOwner || !(reservation = reserveApply(this.readOwner.copyDomain, permit.batch, permit.preparation, claims ?? []))) return { accepted: false }
      }
      resourcePlan = planFrameUpdate({ action: pop ? 'pop-tail' : merge ? 'replace-tail' : 'push',
        old: merge ? capturedTail!.copyLease : null, incoming: reservation, finalClaims: plannedClaims ?? [] })
      if (!resourcePlan) { if (reservation) cancelReservation(reservation); return { accepted: false } }
    }
    try {
    // Run every caller-owned lease/property callback before the final state
    // comparison. A nested accepted edit cannot make the outer candidate fresh.
    const stillFits = sourceLease ? this.sourceBookmarkFits(sourceLease.mount, bookmark) : this.bookmarkFits(input.scope, bookmark)
    const instance = sourceLease ? { instanceId: sourceLease.mount.lease.instanceId, hostDocumentId: sourceLease.mount.lease.hostDocumentId,
      bindingVersion: sourceLease.mount.lease.bindingVersion } : syncedScopeInstanceGuard(input.scope)
    const stillMounted = (sourceLease ? this.sourceLive(sourceLease.mount, sourceLease.callback) : this.live(input.scope)) === mount
    try { if (validateSource && validateSource() !== true) return { accepted: false } } catch { return { accepted: false } }
    // Only immutable data/internal registry checks remain before acceptance.
    if (sourceLease && !sourceScopeMatches(sourceLease.mount, sourceLease.callback)) return { accepted: false }
    if (!stillMounted || !stillFits || this.state !== before || this.workspaceInvalid || this.historyBusy
      || this.hasPendingHistory() || input.expectedEditSequence !== before.editSequence
      || input.guards.groupId !== this.state.snapshot.groupId || input.guards.expectedRevision !== this.state.snapshot.revision
      || input.guards.expectedTopologyRevision !== this.state.snapshot.topologyRevision
      || this.mounts.get(instance.instanceId) !== mount || !sameInstance(instance, mount.lease)
      || [...this.compositions].some(other => other !== mount)) return { accepted: false }
    if (resourcePath && (this.frames.at(-1) !== capturedTail || this.pending !== capturedPending
      || capturedTail && (capturedTail.sealed !== captured!.sealed || capturedTail.sequence !== captured!.sequence
        || capturedTail.bindingClaims !== captured!.claims || capturedTail.after !== captured!.after
        || this.frameVersions.get(capturedTail) !== capturedVersion))) return { accepted: false }
    let frameCopyLease: FrameLease | null = null
    if (resourcePlan) {
      const committed = commitFramePlan(resourcePlan)
      if (committed.status !== 'committed') return { accepted: false }
      frameCopyLease = committed.lease; resourceCommitted = true
    }
    const previous = before.working, sequence = before.editSequence + 1
    const tail = resourcePath ? capturedTail : this.frames.at(-1)
    let changedFrame: Frame | null = null
    if (tail && !tail.sealed && tail.mount === mount && tail.transactionId === input.transactionId
      && (tail.bindingClaims === undefined) === (claims === undefined)) {
      let composed: SyncedBindingClaim[] | undefined
      try { composed = resourcePath ? plannedClaims : claims && immutable(composeSyncedBindingClaims(tail.bindingClaims!, claims)) }
      catch (error) { this.rejected(error); return { accepted: false } }
      tail.after = next; tail.sequence = sequence; tail.afterBookmark = bookmark; tail.bindingClaims = composed
      if (resourcePath) tail.copyLease = frameCopyLease
      if (equal(tail.before, next) && (!composed || syncedBindingClaimsAreIdentity(composed))) {
        this.frames.pop()
        const old = this.frameVersions.get(tail)
        if (old) { old.unavailable = true; old.frame = null }
      } else changedFrame = tail
    } else this.frames.push({ copyLease: frameCopyLease, before: previous, after: next, bindingClaims: claims, sequence, mount, instance,
      transactionId: input.transactionId, sealed: false, beforeBookmark: mount.bookmark, afterBookmark: bookmark })
    for (const frame of this.redoFrames) if (frame.copyLease) dropFrame(frame.copyLease)
    this.redoFrames = []; this.serverRedo = []; this.cutServerRedo = true
    mount.bookmark = bookmark; mount.bookmarkSequence++
    this.adoptEndpoint(next, sequence, snapshot, changedFrame)
    const endpoint = endpointReader && this.mintEndpoint(this.currentEndpoint, endpointReader)
    this.publish({ working: next, editSequence: sequence, failure: null, error: this.pending?.uncertain ? this.state.error : null })
    return { accepted: true, ...(endpoint ? { endpoint } : {}) }
    } finally {
      if (!resourceCommitted) { if (resourcePlan) cancelPlan(resourcePlan); else if (reservation) cancelReservation(reservation) }
    }
  }

  checkpoint = () => { const tail = this.frames.at(-1); if (tail) tail.sealed = true }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  private operationId() { return (this.options.operationId ?? (() => crypto.randomUUID()))() }
  private markOperation(id: string) {
    this.knownOperations.add(id)
    if (this.knownOperations.size > 256) this.knownOperations.delete(this.knownOperations.values().next().value!)
  }
  ownsOperation(id: string) { return this.knownOperations.has(id) }
  releaseReadOwner() { const owner = this.readOwner; this.readOwner = null; owner?.release() }
  invalidateWorkspace() { this.releaseReadOwner(); this.workspaceInvalid = true; this.expireEndpoints(); this.publish({ error: 'Synced workspace identity changed; preserve drafts and reopen the workspace.' }) }
  canRelease() { return !this.frames.length && !this.redoFrames.length && !this.serverRedo.length
    && !(this.cutServerRedo && this.state.snapshot.history.redoToken) && !this.pending && !this.hasComposition()
    && !this.state.incoming && !this.state.failure && !this.state.error && !this.listeners.size && !this.mounts.size }

  private failure(result: SyncedGroupMutationResult) {
    if ('snapshot' in result) return
    const incoming = result.status === 'conflict' ? result.groups.find(group => group.groupId === this.state.snapshot.groupId) : null
    this.publish({ failure: result, incoming: incoming ? immutable(structuredClone(incoming)) : this.state.incoming, error: null })
  }

  private acknowledge(pending: Pending, result: SyncedGroupSaved) {
    if (this.pending !== pending) throw new Error('Synced operation acknowledgement is not the actual pending operation.')
    if (result.operationId !== pending.input.clientOperationId || result.snapshot.groupId !== this.state.snapshot.groupId
      || result.snapshot.creationId !== this.state.snapshot.creationId) throw new Error('Synced operation acknowledgement identity mismatch.')
    const snapshot = immutable(structuredClone(validateSyncedGroupSnapshot(result.snapshot)))
    const blocks = cloneBlocks(syncedCanonicalEdits(snapshot.blocks))
    if (pending.kind === 'content' && !equal(blocks, pending.input.blocks)) throw new Error('Synced operation acknowledgement content mismatch.')
    if (pending.kind === 'history') {
      if (result.status === 'noop' && (snapshot.revision !== pending.before.revision
        || snapshot.history.cursor !== pending.before.history.cursor || semantic(snapshot) !== semantic(pending.before))) {
        throw new Error('A no-op history acknowledgement changed its history side.')
      }
      if (result.status === 'saved' && pending.redo && (this.serverRedo.at(-1) !== pending.redo
        || semantic(snapshot) !== pending.redo.after)) throw new Error('Synced Redo acknowledgement is outside its recorded history side.')
      if (result.status === 'saved' && pending.input.direction === 'undo' && !snapshot.history.redoToken) {
        throw new Error('Synced Undo acknowledgement omitted its Redo tail.')
      }
      const previousRedo = pending.redo ? this.serverRedo.at(-2) : undefined
      if (result.status === 'saved' && previousRedo && (semantic(snapshot) !== previousRedo.before || !snapshot.history.redoToken)) {
        throw new Error('Synced Redo acknowledgement changed its remaining history branch.')
      }
    }
    if (pending.kind === 'content') {
      if (this.frames[0] !== pending.frame) throw new Error('Synced operation acknowledgement is outside the pending history tail.')
      const endpoint = pending.endpointVersion
      if (endpoint) {
        if (endpoint.committed) throw new Error('Synced operation endpoint version already has an acknowledgement.')
        // The pending operation captured this exact immutable frame version.
        // Scope/epoch expiry retires write authority, never the original ACK.
        const ack = Object.freeze({ status: result.status, operationId: result.operationId, snapshot, replayed: result.replayed })
        endpoint.committed = Object.freeze({ submittedSequence: pending.sequence, ack }); endpoint.frame = null
      }
      if (result.status === 'saved' && snapshot.history.undoToken) this.historyBookmarks.set(snapshot.history.undoToken,
        { before: pending.frame.beforeBookmark, after: pending.frame.afterBookmark })
      if (pending.frame.copyLease) dropFrame(pending.frame.copyLease)
      if (pending.copyLease) dropPending(pending.copyLease)
      this.frames.shift()
    } else if (result.status === 'saved') {
      const bookmarks = this.historyBookmarks.get(pending.input.historyToken)
      const bookmark = pending.input.direction === 'undo' ? bookmarks?.before : bookmarks?.after
      if (bookmark !== undefined && this.live(pending.mount.scope) === pending.mount
        && pending.mount.bookmarkSequence === pending.bookmarkSequence && this.bookmarkFits(pending.mount.scope, bookmark)) {
        pending.mount.bookmark = bookmark; pending.mount.bookmarkSequence++
      }
      const token = pending.input.direction === 'undo' ? snapshot.history.redoToken : snapshot.history.undoToken
      if (bookmarks && token) this.historyBookmarks.set(token, bookmarks)
      if (pending.input.direction === 'undo') {
        this.serverRedo.push({ revision: snapshot.revision, cursor: snapshot.history.cursor,
          token: snapshot.history.redoToken!, before: semantic(snapshot), after: semantic(pending.before) })
      } else if (pending.redo) {
        this.serverRedo.pop()
        const next = this.serverRedo.at(-1)
        if (next) {
          next.revision = snapshot.revision; next.cursor = snapshot.history.cursor; next.token = snapshot.history.redoToken!
        }
      }
    }
    if (this.historyBookmarks.size > 256) this.historyBookmarks.delete(this.historyBookmarks.keys().next().value!)
    this.pending = null
    if (pending.kind === 'history') {
      if (result.status === 'saved') this.expireEndpoints()
      this.adoptEndpoint(this.frames.length ? this.state.working : blocks,
        result.status === 'saved' ? this.state.editSequence + 1 : this.state.editSequence, snapshot)
    }
    const incoming = this.state.incoming && this.state.incoming.revision === snapshot.revision
      && this.state.incoming.topologyRevision === snapshot.topologyRevision ? null : this.state.incoming
    this.publish({ snapshot, working: this.frames.length ? this.state.working : blocks, incoming, failure: null, error: null,
      editSequence: pending.kind === 'history' && result.status === 'saved' ? this.state.editSequence + 1 : this.state.editSequence })
  }

  /** An uncertain request keeps its original ID and exact body until lookup resolves it. */
  private async writePending(): Promise<boolean> {
    const pending = this.pending
    if (!pending) return true
    try {
      if (pending.kind === 'content' && pending.copyLease && (!pending.endpointVersion || !pendingMatches(pending.copyLease,
        { version: pending.endpointVersion, input: pending.input, operationId: pending.input.clientOperationId }))) throw new Error('Synced pending source resource identity mismatch.')
      let result: SyncedGroupMutationResult
      if (pending.uncertain) {
        const known = await this.api.getSyncedOperation({ clientOperationId: pending.input.clientOperationId })
        if (known.status === 'committed') {
          if (!('snapshot' in known.result)) throw new Error('Synced operation acknowledgement has the wrong operation kind.')
          this.acknowledge(pending, known.result)
          return true
        }
      }
      // A completed lookup may settle its original ACK after expiry, but an
      // unknown result cannot authorize a fresh request in that workspace.
      if (this.workspaceInvalid) return false
      result = pending.kind === 'content' ? await this.api.updateSyncedBlockGroup(pending.input)
        : await this.api.restoreSyncedGroupOperation(pending.input)
      if (result.status === 'saved' || result.status === 'noop') { this.acknowledge(pending, result); return true }
      this.pending = null; if (pending.kind === 'content' && pending.copyLease) dropPending(pending.copyLease); this.failure(result)
      return false
    } catch (error) {
      pending.uncertain = true
      this.rejected(error)
      return false
    }
  }

  flush = (options: { shouldContinue?: () => boolean } = {}): Promise<boolean> => {
    this.checkpoint()
    const throughSequence = this.state.editSequence
    return this.serial(async () => {
      if (this.workspaceInvalid || options.shouldContinue?.() === false || this.hasComposition()) return false
      if (this.pending && !await this.writePending()) return false
      if (options.shouldContinue?.() === false || this.state.incoming || this.state.failure?.status === 'conflict') return false
      for (;;) {
        const frame = this.frames[0]
        if (!frame || frame.sequence > throughSequence) return true
        // An ACK may settle the original in-flight operation after expiry.
        // Recheck before starting another queued write in that same flush.
        if (this.workspaceInvalid || options.shouldContinue?.() === false || this.hasComposition()) return false
        const snapshot = this.state.snapshot
        if (!snapshot.instances.some(instance => sameInstance(instance, frame.instance))) {
          this.publish({ failure: { status: 'missing', kind: 'instance', id: frame.instance.instanceId } }); return false
        }
        try { this.validated(frame.after) } catch (error) { this.rejected(error); return false }
        const input: SyncedUpdateGroupInput = immutable({ ...syncedSnapshotGuard(snapshot), clientOperationId: this.operationId(),
          expectedInstanceBinding: { ...frame.instance }, blocks: structuredClone(frame.after),
          ...(frame.bindingClaims === undefined ? {} : { bindingClaims: structuredClone(frame.bindingClaims) }) })
        const endpointVersion = this.frameVersions.get(frame) ?? null
        if (frame.copyLease && endpointVersion?.copyLease !== frame.copyLease) throw new Error('Synced queued frame version source mismatch.')
        const copyLease = frame.copyLease && endpointVersion ? pinPending(frame.copyLease,
          { version: endpointVersion, input, operationId: input.clientOperationId }) : null
        if (frame.copyLease && !copyLease) throw new Error('Synced queued source resource is unavailable.')
        this.pending = { kind: 'content', input, frame, sequence: frame.sequence, uncertain: false, endpointVersion, copyLease }
        this.markOperation(input.clientOperationId); this.publish({ error: null, failure: null })
        if (!await this.writePending()) return false
        if (this.state.incoming || options.shouldContinue?.() === false) return false
      }
    })
  }

  private history(scope: SyncedGroupScope, direction: 'undo' | 'redo'): Promise<boolean> {
    this.checkpoint()
    const sequence = this.state.editSequence
    return this.serial(async () => {
      const mount = this.live(scope)
      if (!mount || this.workspaceInvalid || this.hasComposition() || sequence !== this.state.editSequence || this.state.incoming
        || this.state.failure?.status === 'conflict') return false
      if (this.pending && !await this.writePending()) return false
      if (this.workspaceInvalid || !this.live(scope) || sequence !== this.state.editSequence) return false
      const serverRedo = direction === 'redo' ? this.serverRedo.at(-1) : undefined
      if (serverRedo && (this.state.snapshot.revision !== serverRedo.revision
        || this.state.snapshot.history.cursor !== serverRedo.cursor || this.state.snapshot.history.redoToken !== serverRedo.token
        || semantic(this.state.snapshot) !== serverRedo.before)) return false
      const local = direction === 'undo' ? this.frames.at(-1) : serverRedo ? undefined : this.redoFrames.at(-1)
      if (local) {
        const next = direction === 'undo' ? local.before : local.after
        if (direction === 'redo' && !equal(this.state.working, local.before)) return false
        try { this.validated(next) } catch (error) { this.rejected(error); return false }
        this.expireEndpoints()
        if (direction === 'undo') { this.frames.pop(); this.redoFrames.push(local) }
        else { this.redoFrames.pop(); local.sequence = sequence + 1; local.sealed = true; this.frames.push(local) }
        // A bookmark is local to the occurrence that originally owned it.
        const bookmark = direction === 'undo' ? local.beforeBookmark : local.afterBookmark
        if (this.bookmarkFits(scope, bookmark)) { mount.bookmark = bookmark; mount.bookmarkSequence++ }
        this.adoptEndpoint(next, sequence + 1)
        this.publish({ working: next, editSequence: sequence + 1, failure: null, error: null })
        return true
      }
      if (direction === 'redo' && this.frames.length) return false
      if (direction === 'redo' && !serverRedo && this.cutServerRedo) return false
      const snapshot = this.state.snapshot, token = direction === 'undo' ? snapshot.history.undoToken : snapshot.history.redoToken
      if (!token) return false
      const input: SyncedRestoreGroupInput = immutable({ ...syncedSnapshotGuard(snapshot), clientOperationId: this.operationId(),
        expectedInstanceBinding: syncedScopeInstanceGuard(scope), historyToken: token, expectedHistoryCursor: snapshot.history.cursor, direction })
      this.historyBusy = true
      this.pending = { kind: 'history', input, sequence, uncertain: false, mount, bookmarkSequence: mount.bookmarkSequence,
        before: snapshot, redo: serverRedo ?? null }
      this.markOperation(input.clientOperationId); this.publish({ failure: null, error: null })
      try { return await this.writePending() } finally { this.historyBusy = false }
    })
  }
  undo = (scope: SyncedGroupScope) => this.history(scope, 'undo')
  redo = (scope: SyncedGroupScope) => this.history(scope, 'redo')

  /** Content conflicts do not silently replace the baseline used by dirty edits. */
  receive(snapshot: SyncedGroupSnapshot) {
    // An external load is a new provenance generation even when all DTO fields match.
    this.releaseReadOwner()
    snapshot = validateSyncedGroupSnapshot(snapshot)
    if (snapshot.groupId !== this.state.snapshot.groupId) throw new Error('Synced snapshot group mismatch.')
    const blocks = cloneBlocks(syncedCanonicalEdits(snapshot.blocks))
    validateSyncedCanonicalProjection(blocks, snapshot.instances)
    const previous = this.state.snapshot
    if (snapshot.creationId !== previous.creationId) {
      this.expireEndpoints()
      this.publish({ incoming: immutable(structuredClone(snapshot)), failure: { status: 'conflict', kind: 'group', groups: [snapshot], hosts: [] } }); return
    }
    if (snapshot.revision === previous.revision && snapshot.topologyRevision === previous.topologyRevision) return
    this.expireEndpoints()
    const incoming = immutable(structuredClone(snapshot))
    if (snapshot.revision === previous.revision && !this.pending) {
      this.publish({ snapshot: incoming })
      try { this.validated(this.state.working); this.adoptEndpoint(this.state.working, this.state.editSequence, incoming); this.publish({ failure: null, error: null }) } catch (error) { this.rejected(error) }
      return
    }
    if (this.frames.length || this.pending || this.hasComposition() || this.state.incoming) {
      this.publish({ incoming }); return
    }
    for (const frame of this.redoFrames) if (frame.copyLease) dropFrame(frame.copyLease)
    this.redoFrames = []
    this.serverRedo = []; this.cutServerRedo = true
    this.historyBookmarks.clear()
    this.adoptEndpoint(blocks, this.state.editSequence + 1, incoming)
    this.publish({ snapshot: incoming, working: blocks, editSequence: this.state.editSequence + 1, failure: null, error: null })
  }

  receiveMissing() { this.releaseReadOwner(); this.expireEndpoints(); this.publish({ failure: { status: 'missing', kind: 'group', id: this.state.snapshot.groupId } }) }
  receiveError(error: unknown) { this.rejected(error) }
}

export interface SyncedWorkspaceController {
  getGroup: (groupId: string) => SyncedGroupController | undefined
  getWorkspaceScope: () => string | null
  load: (groupIds: string[]) => Promise<void>
  releaseClean: (groupId: string) => boolean
  dispose: () => boolean
}

const workspaces = new WeakMap<SyncedBlocksApi, SyncedWorkspaceController>()

/** The API port identifies a renderer workspace session; occurrences reuse this registry. */
export function getSyncedWorkspaceController(api: SyncedBlocksApi, options: SyncedControllerOptions = {}): SyncedWorkspaceController {
  const existing = workspaces.get(api)
  if (existing) return existing
  const readSources = options.readSources
  const groups = new Map<string, GroupController>(), reads = new Map<string, Promise<void>>(), epochs = new Map<string, number>()
  let workspaceScope: string | null = null, disposed = false
  const loadOne = (id: string): Promise<void> => {
    const running = reads.get(id)
    if (running) return running
    const read = (async () => {
      for (;;) {
        const epoch = epochs.get(id) ?? 0, baseline = groups.get(id)?.getSnapshot().snapshot
        const owned = !groups.has(id) && readSources
          ? await (await import('./sourceReadOwner')).captureControllerReadOwner(readSources, id) : null
        const result = owned ? { workspaceScope: owned.workspaceScope, items: [owned.status === 'ready'
          ? { status: 'ready' as const, snapshot: owned.snapshot } : { status: 'missing' as const, groupId: id }] }
          : await api.getSyncedGroupSnapshots({ groupIds: [id] })
        let adopted = false
        try {
        if (disposed) return
        if (workspaceScope !== null && workspaceScope !== result.workspaceScope) {
          for (const group of groups.values()) group.invalidateWorkspace()
          throw new Error('Synced workspace identity changed; preserve drafts and reopen the workspace.')
        }
        workspaceScope = result.workspaceScope
        if ((epochs.get(id) ?? 0) !== epoch || groups.get(id)?.getSnapshot().snapshot !== baseline) continue
        const item = result.items.find(item => item.status === 'ready' ? item.snapshot.groupId === id : item.groupId === id)
        if (!item) throw new Error('Synced snapshot response omitted the requested group.')
        if (item.status === 'missing') groups.get(id)?.receiveMissing()
        else if (groups.has(id)) groups.get(id)!.receive(item.snapshot)
        else { groups.set(id, new GroupController(api, item.snapshot, options, owned?.status === 'ready' ? owned.context : null)); adopted = true }
        return
        } finally { if (!adopted && owned?.status === 'ready') owned.context.release() }
      }
    })().catch(error => { groups.get(id)?.receiveError(error); throw error }).finally(() => { if (reads.get(id) === read) reads.delete(id) })
    reads.set(id, read)
    return read
  }
  const unsubscribe = api.onSyncedBlocksChanged(event => {
    for (const change of event.changes) {
      const group = groups.get(change.groupId)
      if (!group && !reads.has(change.groupId) || group?.ownsOperation(event.operationId)) continue
      epochs.set(change.groupId, (epochs.get(change.groupId) ?? 0) + 1)
      void loadOne(change.groupId).catch(() => {})
    }
  })
  const workspace: SyncedWorkspaceController = {
    getGroup: id => groups.get(id), getWorkspaceScope: () => workspaceScope,
    load: async ids => { if (disposed) throw new Error('Synced workspace is disposed.'); await Promise.all([...new Set(ids)].map(loadOne)) },
    releaseClean: id => { const group = groups.get(id); if (!group?.canRelease() || reads.has(id)) return false; group.releaseReadOwner(); return groups.delete(id) },
    dispose: () => {
      if (reads.size || [...groups.values()].some(group => !group.canRelease())) return false
      disposed = true; unsubscribe(); for (const group of groups.values()) group.releaseReadOwner(); groups.clear(); workspaces.delete(api); return true
    }
  }
  workspaces.set(api, workspace)
  return workspace
}
