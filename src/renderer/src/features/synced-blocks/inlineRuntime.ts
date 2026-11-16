import { adoptDocumentHostResult, restoreDocumentHostHistory, adoptDocumentLocalDraft } from '../../utils/documentHostHistory'
import type { DocumentBlockDraft, DocumentDetail } from '@shared/contracts'
import type { ControlledDocumentBlockMove } from '@shared/document-block-moves'
import type { EditorRecoveryExpected } from '@shared/editor-recovery-drafts'
import { SyncedStructureCommands, type HostReorderProtection, type StructureCommandView } from './structureCommands'
import { SyncedHostStructureHistory } from './hostStructureHistory'
import type { SyncedGroupBinding, SyncedGroupController } from './types'
import type { SyncedBlocksApi as MainSyncedApi, SyncedGroupIdentityListResult, SyncedPlacement, SyncedReferenceIdentity, SyncedRestoreHostInput, SyncedStructureAction, SyncedStructureApplied, SyncedStructureInput } from '@shared/synced-blocks'
import type { EditorHistoryBookmark } from '../../utils/editorHistoryFocus'
import type { SyncedEditingMethod, SyncedEditingMethods, SyncedEditingRequest, SyncedEditingSession } from '@shared/synced-editing-session'
import type { SyncedInlineInstanceAddress, WorkspaceSearchOccurrence } from '@shared/workspace-search-occurrence'
import { isSameWorkspaceSearchOccurrence } from '@shared/workspace-search-occurrence'
import { isSyncedUuid, parseSyncedBlockPayload } from '@shared/syncedBlockValidation'
import { readProtectedCrossMoveReference } from '@shared/synced-cross-move-recovery-forest'
import { getSyncedWorkspaceController, flushSyncedWorkspacePendingChanges, captureSyncedWorkspaceRecovery, restoreSyncedCanonicalRecovery, holdGroupForHostReorder,
  type HostReorderGroupHold } from './controller'
import { getEditorRecoveryCoordinator, recoveryOpening, type RawRecoveryPending } from '../editor-recovery/coordinator'
import { syncedCanonicalEdits } from '@shared/syncedBlockValidation'
import { recoveryData } from '../editor-recovery/sourceSnapshots'
import type { SyncedReadSourcesPort } from './sourceReadOwner'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import type { RestoredCanonicalSource } from './SyncedCanonicalSourceDialog'
import type { PreparedSyncedHostSource } from './hostSource'
import { readSyncedHostSourceSubmission, acceptSyncedHostSourceCheckpoint, restoreSyncedHostSourceDraft,
  type SyncedHostSourceSubmission, type SyncedHostSourceApplyOutcome, type RestoredSyncedHostSource } from './hostSource'
import { openColdHostSourceOwner } from '../editor-recovery/sourceColdOwner'
import type { MarkdownSourceLocalState } from '../../components/DocumentMarkdownSourceDialog'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { installCanonicalInlineTransitions, hasCanonicalInlineAsyncEdits, signalCanonicalInlineUnlock,
  type CanonicalHeadingAction, type CanonicalInlineFlushOptions } from './inlineBridge'

export interface InlineHostPort {
  getCurrent: () => SyncedHostSourceCurrent | null
  getPersisted: () => DocumentDetail | null
  adopt: (before: SyncedHostSourceCurrent, result: SyncedStructureApplied, afterBookmark?: EditorHistoryBookmark) => boolean
  adoptHistory: (before: SyncedHostSourceCurrent, result: SyncedStructureApplied) => boolean
  applyOrdinarySource?: (before: SyncedHostSourceCurrent, after: PreparedSyncedHostSource['finalAfter'][number]) => boolean
  flushHost: () => Promise<boolean>
  navigateHost: (documentId: string, instanceId: string, shouldContinue: () => boolean) => Promise<boolean>
  notify: (message: string) => void
  isReady?: () => boolean
  isComposing?: () => boolean
  canStartStructure?: () => boolean
  requiresHostSurface?: () => boolean
  isZh: boolean
  selectedHostId: () => string | null
}
export interface InlineMount {
  hostDocumentId: string; hostSession: object; instanceId: string; groupId: string; parentBlockId: string | null; depth: number
  mountEpoch: object; root: () => HTMLElement | null; isCurrent: () => boolean
  reopenAfterCrossMove?: () => void
}
export interface InlineOpening { address: SyncedInlineInstanceAddress; binding: SyncedGroupBinding; group: SyncedGroupController }
type SourceState = { id: object; local: Readonly<MarkdownSourceLocalState>; reported: boolean; report: (state: Readonly<MarkdownSourceLocalState>) => void; close: () => boolean }
type MountedInline = { mount: InlineMount; binding: SyncedGroupBinding }
type CrossDraftProtection = { instanceId: string; groupId: string; group: SyncedGroupController; identity: object; hold: HostReorderGroupHold;
  survivors: readonly MountedInline[]; current(): boolean }
type CrossWrite = { opening: SyncedHostSourceCurrent; peers: readonly DocumentDetail[]; key: string; input: SyncedStructureInput | SyncedRestoreHostInput;
  protection?: CrossDraftProtection; hostHead?: EditorRecoveryExpected }
export type InlineDialog = ({ kind: 'canonical'; binding: SyncedGroupBinding; opener: HTMLElement | null; restored?: RestoredCanonicalSource }
  | { kind: 'host'; opening: SyncedHostSourceCurrent; opener: HTMLElement | null; operationId: string; restored?: RestoredSyncedHostSource }) & SourceState
export interface InlineNavigation {
  sequence: number; occurrence: WorkspaceSearchOccurrence; shouldContinue: () => boolean
  finish: (success: boolean) => void
  committed: boolean
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const blankSource = Object.freeze({ dirty: false, composing: false, applying: false, importing: false })
const clean = (state: ReturnType<SyncedGroupController['getSnapshot']>) => !state.recoveryReview && !state.dirty && !state.pending
  && !state.composingInstanceIds.length && !state.incoming && !state.failure && !state.error && state.phase === 'clean'

/** One renderer workspace queue, backed exclusively by a Main-issued opaque
 * frame/epoch session. Every instance binds the existing shared controller. */
class InlineRuntime {
  readonly commands: SyncedStructureCommands
  readonly history: SyncedHostStructureHistory
  private session: SyncedEditingSession | null = null
  private invalid = false
  private groups = new Set<string>()
  private watchers = new Set<string>()
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private mounts = new Map<string, MountedInline>()
  private host: InlineHostPort | null = null
  private rpc = new Set<Promise<unknown>>()
  private surfaces = new Map<object, { hostSession: object; expectedInstances: readonly string[] }>()
  private openingBindings = new Set<object>()
  private hostWrites = new Map<object, { submitted: SyncedHostSourceCurrent; input: SyncedStructureInput }>()
  private crossWrite: CrossWrite | null = null
  private attention = 0
  private sourceWrites = new Map<object, { input: SyncedStructureInput; opening: SyncedHostSourceCurrent; submission: SyncedHostSourceSubmission | null }>()
  private checkpointedSources = new WeakSet<object>()
  private listeners = new Set<() => void>()
  private idle = new Set<() => void>()
  private revision = 0
  private locked = false
  private requestId: string | null = null
  private deferred = new Set<() => void>()
  private dialog: InlineDialog | null = null
  private navigation: InlineNavigation | null = null
  private ui: Readonly<{ revision: number; locked: boolean; dialog: InlineDialog | null; navigation: InlineNavigation | null; command: Readonly<StructureCommandView> | null }> = Object.freeze({ revision: 0, locked: false, dialog: null as InlineDialog | null, navigation: null as InlineNavigation | null, command: null })
  private readonly windowSessionId = crypto.randomUUID()
  private readonly port: MainSyncedApi
  private readonly readSources: SyncedReadSourcesPort
  private readonly workspace: ReturnType<typeof getSyncedWorkspaceController>
  private readonly recovery = getEditorRecoveryCoordinator()
  private recoveryHost: object | null = null
  private recoveryReview = false
  private readonly recoveryGroups = new Map<string, object>()
  constructor() {
    const invoke = <M extends SyncedEditingMethod>(method: M, input: SyncedEditingMethods[M]['input']) => this.invoke(method, input)
    this.port = {
      getSyncedGroupSnapshots: input => invoke('getSyncedGroupSnapshots', input),
      listSyncedGroups: input => invoke('listSyncedGroups', input),
      updateSyncedBlockGroup: input => invoke('updateSyncedBlockGroup', input),
      restoreSyncedGroupOperation: input => invoke('restoreSyncedGroupOperation', input),
      getSyncedOperation: input => invoke('getSyncedOperation', input),
      applySyncedHostStructure: async input => {
        const value = await invoke('applySyncedHostStructure', input)
        if (value.status === 'unsupported') throw new Error(value.reason)
        return value
      },
      restoreSyncedHostOperation: async input => {
        const value = await invoke('restoreSyncedHostOperation', input)
        if (value.status === 'unsupported') throw new Error(value.reason)
        return value
      },
      getSyncedHostHistory: input => invoke('getSyncedHostHistory', input),
      onSyncedBlocksChanged: listener => window.knowbook.onSyncedBlocksChanged(event => {
        const send = () => listener(event)
        if (this.isLocked()) this.deferred.add(send); else send()
      })
    }
    const readSources: SyncedReadSourcesPort = {
      captureBaseline: async input => {
        const sessionId = this.session?.sessionId, result = await invoke('captureBaseline', input)
        if (result.status === 'ready' && sessionId) {
          const identity = Object.freeze({}), groupId = input.groupId
          this.recoveryGroups.set(groupId, identity)
          this.recovery.register(identity, { kind: 'group', groupId }, recoveryOpening({
            kind: 'group', groupId, sessionId, readOwnerId: result.readOwnerId }), () => {
            const captured = captureSyncedWorkspaceRecovery(this.workspace).find(item => item.state.snapshot.groupId === groupId)
            if (!captured) return null
            const { state, pending } = captured
            return { working: { kind: 'group', blocks: state.working,
              incoming: state.incoming ? { kind: 'group', blocks: syncedCanonicalEdits(state.incoming.blocks), incoming: null } : null },
              authoredWork: captured.authoredWork,
              ...(captured.canonicalReadOwnerId ? { canonicalReadOwnerId: captured.canonicalReadOwnerId } : {}),
              pending: [], rawPending: pending ? [{ method: pending.method, input: pending.input,
                submittedWorking: { kind: 'group', blocks: pending.submitted, incoming: null } }] : [],
              selection: null, composing: state.composingInstanceIds.length > 0, importing: false,
              replayJson: JSON.stringify(recoveryData(captured.replay)) }
          })
        }
        return result
      }, operation: input => invoke('ownedOperation', input),
      validate: input => invoke('validateOwner', input), release: input => invoke('releaseOwner', input)
    }
    this.readSources = readSources
    this.workspace = getSyncedWorkspaceController(this.port, { readSources })
    this.history = new SyncedHostStructureHistory({ current: () => this.sourceCurrent(),
      readHost: id => window.knowbook.getDocumentDetail(id), workspaceScope: () => this.session?.workspaceScope ?? null,
      // The history's own unsettled request is intentionally excluded here so
      // the exact original Undo/Redo can recover its receipt. All other owners
      // still block it, including close, attachments, Source and commands.
      blocked: () => this.locked || this.recoveryReview || this.invalid || Boolean(this.dialog) || this.commands?.pending() === true
        || this.hostWrites.size > 0 || this.crossWrite !== null || this.sourceWrites.size > 0 || this.host?.isReady?.() !== true
        || this.host?.isComposing?.() === true || hasCanonicalInlineAsyncEdits(),
      openHost: async id => Boolean(await this.open({ kind: 'host', hostDocumentId: id })),
      openInstance: async (hostDocumentId, instanceId, groupId) => Boolean(await this.open({ kind: 'instance', hostDocumentId, instanceId, groupId })),
      readHistory: documentId => this.invoke('getSyncedHostHistory', { documentId }),
      readGroups: groupIds => this.invoke('getSyncedGroupSnapshots', { groupIds }),
      flushGroups: current => flushSyncedWorkspacePendingChanges(this.workspace, { shouldContinue: current }),
      flushHost: () => this.host?.flushHost() ?? Promise.resolve(false),
      restore: input => this.invoke('restoreSyncedHostOperation', input),
      operation: clientOperationId => this.invoke('getSyncedOperation', { clientOperationId }),
      protectReorder: (before, after) => this.protectSameParentReorder(before, after) ?? null,
      checkpointReorder: (identity, operationId, current, groupIdentity) => {
        this.observeRecoveryHost()
        return this.recovery.checkpointPendingHost(identity, operationId, current, 'restoreSyncedHostOperation', groupIdentity)
      },
      adopt: (before, result) => this.host?.adoptHistory(before, result) ?? false,
      changed: () => this.emit(), released: () => this.releaseDeferred(), notify: (zh, en) => this.notify(zh, en) })
    this.commands = new SyncedStructureCommands({ current: () => this.sourceCurrent(),
      blocked: () => this.isLocked() || this.recoveryReview || this.history.isBusy() || this.invalid || Boolean(this.dialog) || this.hostWrites.size > 0 || this.sourceWrites.size > 0
        || this.host?.isReady?.() !== true || this.host?.isComposing?.() === true || this.host?.canStartStructure?.() === false || hasCanonicalInlineAsyncEdits(),
      openHost: async id => Boolean(await this.open({ kind: 'host', hostDocumentId: id })),
      list: input => this.invoke('listSyncedGroups', input), guards: (id, extra) => this.structureGuards(id, extra),
      flushGroups: current => flushSyncedWorkspacePendingChanges(this.workspace, { shouldContinue: current }),
      apply: input => this.invoke('applySyncedHostStructure', input),
      operation: clientOperationId => this.invoke('getSyncedOperation', { clientOperationId }),
      protectHostEdit: (identity, operationId, current, groupIdentity) => {
        this.observeRecoveryHost()
        return this.recovery.checkpointPendingHost(identity, operationId, current, 'applySyncedHostStructure', groupIdentity)
      },
      protectReorder: (before, after) => this.protectSameParentReorder(before, after),
      adopt: (before, result, afterBookmark) => this.adoptStructure(before, result, afterBookmark),
      changed: () => { this.emit(); signalCanonicalInlineUnlock() },
      notify: (zh, en) => this.notify(zh, en), isZh: () => this.host?.isZh ?? true })
    window.knowbook.onWorkspaceMutated(() => {
      const refresh = () => { if (this.session && !this.invalid && this.groups.size) void this.workspace.load([...this.groups]).catch(() => this.emit()) }
      if (this.isLocked()) this.deferred.add(refresh); else refresh()
    })
    installCanonicalInlineTransitions(this, { flush: options => this.flush(options), pending: () => this.pending(), hostPending: () => this.hostWrites.size > 0 || this.crossWrite !== null,
      navigate: () => this.preparePageNavigation(), locked: () => this.isLocked() || this.commands.runningHostEdit(),
      restoreHistory: (transition, direction) => this.history.restore(transition, direction), ownsHistory: transition => this.history.owns(transition),
      adoptHostResult: adoptDocumentHostResult,
      adoptLocalDraft: adoptDocumentLocalDraft,
      runHostHistory: restoreDocumentHostHistory,
      openHeading: (...input) => this.openHeading(...input),
      openHostEdit: (...input) => this.commands.openHostEdit(...input),
      deleteHostBlocks: (before, after, next, shouldContinue, onAccepted) => {
        const blocks = after.length ? after : [{ type: 'paragraph', content: '', checked: false, depth: 0,
          id: crypto.randomUUID(), parentBlockId: null }]
        const index = Math.max(0, Math.min(next, blocks.length - 1))
        void this.commands.openHostEdit(before, blocks, { opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
          shouldContinue, onAccepted: () => onAccepted(index), afterBookmark: { index, blockId: blocks[index].id, direction: 'none', start: 0, end: 0 } })
      },
      clipboardScope: hostId => !this.invalid && this.session && this.sourceCurrent()?.host.documentId === hostId ? this.session : null,
      notifyBlocked: () => this.notify('请先完成共享正文或源码的保存。', 'Finish saving the shared body or source first.') })
  }
  /** A shell page change keeps the shared host editor hook and its ordinary W.
   * Drain only state owned by views that will unmount; a real document change
   * still uses the host writer. Never leave IME or an uncertain Main ACK. */
  private async preparePageNavigation(): Promise<boolean> {
    const blocked = () => this.isLocked() || this.history.isBusy() || this.host?.isComposing?.() === true || this.hostWrites.size > 0
    return !blocked() && await this.flush() && !blocked()
  }
  configure(host: InlineHostPort) { this.host = host }
  beginRecoveryReview(): boolean {
    if (this.isLocked() || this.dialog || this.commands.pending() || this.history.isBusy() || this.pending()) return false
    this.recoveryReview = true; this.emit(); return true
  }
  finishRecoveryReview(): void { this.recoveryReview = false; this.emit() }
  reviewingRecovery(): boolean { return this.recoveryReview }
  observeRecoveryHost() {
    const current = this.sourceCurrent(), persisted = this.host?.getPersisted()
    if (!current || !persisted || persisted.id !== current.host.documentId) return
    if (this.recoveryHost && this.recoveryHost !== current.hostSession) this.recovery.detach(this.recoveryHost)
    this.recoveryHost = current.hostSession
    if (!this.recovery.has(current.hostSession)) {
      const identity = current.hostSession, documentId = current.host.documentId
      this.recovery.register(identity, { kind: 'host', documentId }, recoveryOpening({
        kind: 'host', documentId, expectedUpdatedAt: current.host.expectedPersistedUpdatedAt }), () => {
        const now = this.sourceCurrent()
        if (!now || now.hostSession !== identity || now.host.documentId !== documentId) return null
        const rawPending: RawRecoveryPending[] = []
        if (this.crossWrite?.opening.hostSession === identity) {
          const { input, opening } = this.crossWrite
          rawPending.push({ method: 'mode' in input ? 'applySyncedHostStructure' : 'restoreSyncedHostOperation', input,
            submittedWorking: { kind: 'host', ...opening.host.workingBefore } })
        }
        const write = this.hostWrites.get(identity)
        if (write) rawPending.push({ method: 'applySyncedHostStructure', input: write.input,
          submittedWorking: { kind: 'host', ...write.submitted.host.workingBefore } })
        const inverse = this.history.pendingProtectedReorder(identity)
        if (inverse) rawPending.push({ method: 'restoreSyncedHostOperation', input: inverse.input,
          submittedWorking: { kind: 'host', ...inverse.before.host.workingBefore } })
        const edit = this.commands.pendingProtectedEdit(identity)
        if (edit) {
          const { title, summary, blocks } = edit.mode === 'host-final' ? edit.finalAfter[0] : edit.hostsWorkingBefore[0].workingBefore
          rawPending.push({ method: 'applySyncedHostStructure', input: edit, submittedWorking: { kind: 'host', title, summary, blocks } })
        }
        for (const source of this.sourceWrites.values()) if (source.opening.hostSession === identity
          && !rawPending.some(item => item.input.clientOperationId === source.input.clientOperationId)) {
          const submitted = source.input.mode === 'host-final' ? source.input.finalAfter.find(host => host.documentId === documentId) : null
          rawPending.push({ method: 'applySyncedHostStructure', input: source.input,
            submittedWorking: submitted ? { kind: 'host', title: submitted.title, summary: submitted.summary, blocks: submitted.blocks }
              : { kind: 'host', ...source.opening.host.workingBefore } })
        }
        return { working: { kind: 'host', ...now.host.workingBefore }, pending: [], rawPending,
          selection: null, composing: this.host?.isComposing?.() === true, importing: hasCanonicalInlineAsyncEdits() }
      })
    }
    this.recovery.observe(current.hostSession)
    this.recovery.changed()
  }
  async journalClose(requestId: string) {
    if (!this.sourceHasReported()) throw new Error('The open Source has not reported its first editor snapshot')
    this.observeRecoveryHost()
    // No caller group allowlist: verify every actual controller has its genuine
    // initial Main capture before asking the side store for one whole receipt.
    for (const item of captureSyncedWorkspaceRecovery(this.workspace)) {
      const identity = this.recoveryGroups.get(item.state.snapshot.groupId)
      if (!identity || !this.recovery.has(identity)) throw new Error('A shared body recovery opening is unavailable')
    }
    const host = this.sourceCurrent()
    if (this.openingBindings.size || this.host?.isComposing?.() || hasCanonicalInlineAsyncEdits() || this.history.isBusy()
      || this.commands.pending() && (!host || !this.commands.canJournalProtectedEdit(host.hostSession))) throw new Error('An editor operation is unfinished')
    return this.recovery.journalClose(requestId, () => this.ownsClose(requestId) && this.sourceHasReported())
  }
  checkpointFlushedClose(requestId: string): Promise<boolean> {
    this.observeRecoveryHost()
    return this.recovery.checkpointFlushed(() => this.ownsClose(requestId) && this.sourceHasReported())
  }
  getSnapshot = () => this.ui
  retainedCrossMoveRevision = 0
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit() {
    this.recovery.changed()
    this.ui = Object.freeze({ revision: ++this.revision, locked: this.isLocked(), dialog: this.dialog, navigation: this.navigation, command: this.commands.getSnapshot() })
    for (const listener of [...this.listeners, ...this.idle]) { try { listener() } catch (error) { console.error('Synced view observer failed', error) } }
  }
  private adoptStructure(before: SyncedHostSourceCurrent, result: SyncedStructureApplied, afterBookmark?: EditorHistoryBookmark) {
    const accepted = this.host?.adopt(before, result, afterBookmark) ?? false
    if (accepted) this.history.remember(before, result, this.commands.preservingReorder())
    return accepted
  }
  private protectSameParentReorder(before: SyncedHostSourceCurrent,
    after: readonly DocumentBlockDraft[]): HostReorderProtection | null | undefined {
    const { documentId, expectedPersistedUpdatedAt, workingBefore } = before.host, persisted = this.host?.getPersisted()
    const unavailable = () => [...this.groups].some(id => {
      const group = this.workspace.getGroup(id)
      return group && !clean(group.getSnapshot())
    }) ? null : undefined
    if (persisted?.id !== documentId || persisted.updatedAt !== expectedPersistedUpdatedAt || persisted.title !== workingBefore.title
      || persisted.summary !== workingBefore.summary || !areDocumentDraftBlocksEqual(persisted.blocks, workingBefore.blocks)) return unavailable()
    const ordered = new Map(after.map(block => [block.id, block]))
    if (ordered.size !== workingBefore.blocks.length || workingBefore.blocks.some(block => {
      const next = ordered.get(block.id)
      return !next || !areDocumentDraftBlocksEqual([block], [next])
    })) return unavailable()
    const ids = new Set(workingBefore.blocks.flatMap(block => block.type === 'synced-block' ? [parseSyncedBlockPayload(block.content).groupId] : []))
    if (!ids.size) return null
    const dirty = [...ids].flatMap(id => {
      const group = this.workspace.getGroup(id)
      return group && !clean(group.getSnapshot()) ? [{ id, group }] : []
    })
    if (dirty.length > 1) return null
    const only = dirty[0], groupIdentity = only && this.recoveryGroups.get(only.id)
    const active = only && [...this.mounts.values()].find(item => item.mount.hostSession === before.hostSession
      && item.mount.groupId === only.id && item.binding.isCurrent())
    if (only && (!groupIdentity || !active)) return null
    const lease = only && holdGroupForHostReorder(only.group)
    if (only && !lease) return null
    const snapshot = only?.group.getSnapshot().snapshot
    const current = () => (!lease || lease.current() && active?.binding.isCurrent() === true) && [...ids].every(id => {
      const group = this.workspace.getGroup(id)
      return id === only?.id ? group === only.group : !group || clean(group.getSnapshot())
    })
    if (only) this.cancelGroupSave(only.id)
    return { current, groupIdentity, release: () => lease?.release(),
      acceptsGuards: guards => current() && (!snapshot || guards.groups.some(group => group.groupId === snapshot.groupId
        && group.expectedRevision === snapshot.revision && group.expectedTopologyRevision === snapshot.topologyRevision)
        && snapshot.instances.filter(instance => instance.hostDocumentId === documentId).every(instance =>
          guards.expectedInstances.some(guard => guard.instanceId === instance.instanceId && guard.hostDocumentId === instance.hostDocumentId
            && guard.bindingVersion === instance.bindingVersion))),
      accepts: result => current()
      && !result.affectedInstanceIds.length && (!snapshot || result.groups.some(group => same(group, snapshot))) }
  }
  private notify(zh: string, en: string) { this.host?.notify(this.host.isZh ? zh : en) }
  private invoke<M extends SyncedEditingMethod>(method: M, input: SyncedEditingMethods[M]['input']): Promise<SyncedEditingMethods[M]['result']> {
    if (!this.session || this.invalid && method !== 'releaseOwner') return Promise.reject(new Error('The original editing session is unavailable'))
    const sessionId = this.session.sessionId
    const pending = window.knowbook.invokeSyncedEditingSession<M>({ sessionId, method, input } as SyncedEditingRequest<M>)
    this.rpc.add(pending)
    return pending.catch(error => {
      if (String(error).includes('Synced editing session')) { this.invalid = true; this.emit() }
      throw error
    }).finally(() => { this.rpc.delete(pending); this.emit() })
  }
  private async open(input: Parameters<typeof window.knowbook.openSyncedEditingSession>[0]) {
    const result = await window.knowbook.openSyncedEditingSession(input)
    if (result.status !== 'ready') return null
    if (this.session && (this.session.sessionId !== result.session.sessionId || this.session.workspaceScope !== result.session.workspaceScope
      || this.session.recoveryEpoch !== result.session.recoveryEpoch)) {
      this.invalid = true
      if (this.session.sessionId !== result.session.sessionId) await window.knowbook.releaseSyncedEditingSession(result.session.sessionId)
      this.emit(); throw new Error('The workspace changed; existing drafts are retained')
    }
    if (this.invalid) throw new Error('The original editing session must be reopened')
    this.session = Object.freeze({ ...result.session })
    return result
  }
  registerHostSurface(hostSession: object, identity: object, expectedInstances: readonly string[] = []) {
    if (this.sourceCurrent()?.hostSession !== hostSession) return () => undefined
    this.surfaces.set(identity, { hostSession, expectedInstances: [...expectedInstances] })
    return () => { this.surfaces.delete(identity) }
  }
  closeReady() {
    if (this.host?.isReady?.() !== true || this.openingBindings.size || !this.sourceHasReported()) return false
    if (!this.host.requiresHostSurface?.()) return true
    const current = this.sourceCurrent()
    return Boolean(current && [...this.surfaces.values()].some(surface => surface.hostSession === current.hostSession
      && surface.expectedInstances.every(instanceId => {
        const original = this.mounts.get(JSON.stringify([current.host.documentId, instanceId]))
        return original?.mount.hostSession === current.hostSession && original.mount.isCurrent()
      })))
  }
  hasComposition() {
    return Boolean(this.host?.isComposing?.() || this.dialog?.local.composing
      || [...this.groups].some(id => this.workspace.getGroup(id)?.getSnapshot().composingInstanceIds.length))
  }
  async bind(mount: InlineMount): Promise<InlineOpening | null> {
    const original = Object.freeze({}); this.openingBindings.add(original)
    try { return await this.bindOriginal(mount) }
    finally { this.openingBindings.delete(original); this.emit() }
  }
  private async bindOriginal(mount: InlineMount): Promise<InlineOpening | null> {
    if (!mount.isCurrent() || this.isLocked()) return null
    let opened = await this.open({ kind: 'instance', hostDocumentId: mount.hostDocumentId, instanceId: mount.instanceId, groupId: mount.groupId })
    if (opened?.instance && (opened.instance.parentBlockId !== mount.parentBlockId || opened.instance.depth !== mount.depth)) {
      // A W-only relocation is an intention, not the persisted instance fence.
      // Save its complete host first, then reopen the actual new binding.
      if (!mount.isCurrent() || !await this.host?.flushHost()) return null
      opened = await this.open({ kind: 'instance', hostDocumentId: mount.hostDocumentId, instanceId: mount.instanceId, groupId: mount.groupId })
    }
    if (!opened || !mount.isCurrent() || this.isLocked()) return null
    const address = opened.instance, snapshot = opened.snapshot
    if (!address || !snapshot || address.workspaceScope !== opened.session.workspaceScope || address.recoveryEpoch !== opened.session.recoveryEpoch
      || opened.host.documentId !== address.hostDocumentId || opened.host.createdAt !== address.hostCreatedAt
      || address.hostDocumentId !== mount.hostDocumentId || address.instanceId !== mount.instanceId
      || address.groupId !== mount.groupId || address.parentBlockId !== mount.parentBlockId || address.depth !== mount.depth || snapshot.groupId !== address.groupId || snapshot.creationId !== address.creationId
      || snapshot.createdAt !== address.groupCreatedAt) throw new Error('The exact original inline instance was not returned')
    const mirrored = snapshot.instances.filter(instance => instance.instanceId === address.instanceId && instance.hostDocumentId === address.hostDocumentId
      && instance.bindingVersion === address.bindingVersion && instance.parentBlockId === address.parentBlockId && instance.depth === address.depth)
    if (mirrored.length !== 1) throw new Error('The actual host/instance mirror changed')
    this.groups.add(mount.groupId)
    await this.workspace.load([mount.groupId])
    if (!mount.isCurrent() || this.isLocked() || this.invalid) return null
    const group = this.workspace.getGroup(mount.groupId)
    if (!group) return null
    const state = group.getSnapshot()
    if (state.snapshot.creationId !== address.creationId || !state.snapshot.instances.some(instance => instance.instanceId === address.instanceId
      && instance.hostDocumentId === address.hostDocumentId && instance.bindingVersion === address.bindingVersion)) return null
    const key = JSON.stringify([mount.hostDocumentId, mount.instanceId]), previous = this.mounts.get(key)
    if (previous?.mount.isCurrent()) throw new Error('This exact instance already has its own mounted view')
    previous?.binding.dispose()
    const scope = { owner: { kind: 'synced-group' as const, groupId: address.groupId }, hostDocumentId: address.hostDocumentId,
      instanceId: address.instanceId, bindingVersion: address.bindingVersion, windowSessionId: this.windowSessionId,
      hostSession: mount.hostSession, mountEpoch: mount.mountEpoch, bindingEpoch: Object.freeze({}),
      domNamespace: JSON.stringify([this.windowSessionId, address.hostDocumentId, address.instanceId]), root: mount.root,
      isCurrent: () => !this.invalid && mount.isCurrent() && this.host?.getCurrent()?.hostSession === mount.hostSession }
    const binding = group.bind(scope)
    this.mounts.set(key, { mount, binding })
    if (!this.watchers.has(mount.groupId)) { this.watchers.add(mount.groupId); group.subscribe(() => {
      if (this.workspace.getGroup(mount.groupId) !== group) return
      this.scheduleGroupSave(mount.groupId, group); this.emit()
    }) }
    return { address, binding, group }
  }
  private scheduleGroupSave(id: string, group: SyncedGroupController) {
    this.cancelGroupSave(id)
    const state = group.getSnapshot()
    if (this.isLocked() || this.invalid || state.recoveryReview || !state.dirty || state.pending || state.composingInstanceIds.length
      || state.incoming || state.failure || state.error) return
    this.saveTimers.set(id, setTimeout(() => {
      this.saveTimers.delete(id)
      if (this.isLocked() || this.invalid) return
      void group.flush().then(saved => { if (!saved) this.emit() }).catch(error => { this.report(String(error)); this.emit() })
    }, 800))
  }
  private cancelGroupSave(id: string) {
    clearTimeout(this.saveTimers.get(id))
    this.saveTimers.delete(id)
  }
  unbind(opening: InlineOpening) {
    const key = JSON.stringify([opening.address.hostDocumentId, opening.address.instanceId])
    if (this.mounts.get(key)?.binding === opening.binding) this.mounts.delete(key)
    opening.binding.dispose()
  }
  hostSavePending(hostSession: object) { return this.hostWrites.has(hostSession) || this.crossWrite?.opening.hostSession === hostSession }
  pending() {
    if (this.crossWrite) return true
    if (this.history.pending() || this.history.isBusy() || this.commands.pending()) return true
    if (hasCanonicalInlineAsyncEdits()) return true
    if (this.sourceWrites.size) return true
    if (this.dialog && Object.values(this.dialog.local).some(Boolean)) return true
    return [...this.groups].some(id => { const group = this.workspace.getGroup(id); return Boolean(group && !clean(group.getSnapshot())) })
  }
  async flush(options: CanonicalInlineFlushOptions = {}) {
    if (this.crossWrite) return false
    if (this.recoveryReview) return false
    const current = () => options.shouldContinue?.() !== false && this.sourceHasReported()
      && (options.purpose !== 'document-navigation' || !this.isLocked())
    if (!current()) return false
    if (this.history.pending()) { this.notify('原结构撤销或重做回执尚未确认，请重试同一操作。', 'Retry the original Undo or Redo to settle its acknowledgement.'); return false }
    if (this.commands.pending()) { this.notify('请先完成或取消当前同步块操作。', 'Finish or cancel the current synced block operation first.'); return false }
    if (hasCanonicalInlineAsyncEdits() && options.purpose !== 'document-navigation') { this.notify('请等待当前附件插入完成。', 'Wait for the original attachment insertion to finish.'); return false }
    if (this.dialog?.local.applying || this.dialog?.local.importing) await new Promise<void>(resolve => {
      const changed = () => { if (!this.dialog?.local.applying && !this.dialog?.local.importing || !current()) { this.idle.delete(changed); resolve() } }
      this.idle.add(changed); changed()
    })
    if (!current() || this.sourceWrites.size || this.dialog && Object.values(this.dialog.local).some(Boolean)) {
      this.notify('请先应用或取消当前源码编辑。', 'Apply or cancel the current source edits first.'); return false
    }
    // The ordinary source save precedes discovery of other participating
    // pages. Running their shared-body writers here would cross that fence.
    const ordinaryMove = options.purpose === 'move'
    if (!ordinaryMove && !await flushSyncedWorkspacePendingChanges(this.workspace, { shouldContinue: current })) return false
    const calls = [...this.rpc]
    if (calls.length) {
      const results = await Promise.allSettled(calls)
      if (results.some(result => result.status === 'rejected')) return false
    }
    return current() && (!this.dialog || !Object.values(this.dialog.local).some(Boolean))
      && (ordinaryMove ? !this.isLocked() && !this.hostWrites.size : await flushSyncedWorkspacePendingChanges(this.workspace, { shouldContinue: current }))
  }
  private sourceHasReported(): boolean { return !this.dialog || this.dialog.reported }
  private sourceState(): SourceState {
    const id = Object.freeze({})
    return { id, local: blankSource, reported: false, report: state => {
      if (this.dialog?.id !== id) return
      // The Source component updates its recovery snapshot before this report.
      if (this.dialog.reported && same(this.dialog.local, state)) return
      this.dialog.reported = true
      this.dialog.local = Object.freeze({ ...state }); this.emit()
    }, close: () => { if (this.dialog?.id === id) {
      if (this.sourceWrites.has(id)) { this.notify('原源码操作回执尚未确认，请重试应用以核对。', 'Retry Apply to settle the original source operation.'); return false }
      this.dialog = null; this.emit(); return true } return false } }
  }
  openCanonicalSource(binding: SyncedGroupBinding, opener: HTMLElement | null) {
    if (this.isLocked() || this.dialog || this.history.isBusy() || this.commands.pending() || !binding.isCurrent()) return false
    this.dialog = { ...this.sourceState(), kind: 'canonical', binding, opener }; this.emit(); return true
  }
  async openDetach(opening: InlineOpening, opener: HTMLElement | null): Promise<boolean> {
    const { address, binding } = opening
    const key = JSON.stringify([address.hostDocumentId, address.instanceId])
    const original = this.mounts.get(key)
    if (original?.binding !== binding) return false
    const { snapshot, editSequence } = binding.getCurrent()
    const mounted = () => this.mounts.get(key) === original && original.mount.isCurrent()
    const settled = () => {
      const state = binding.getCurrent()
      return mounted() && binding.isCurrent() && clean(state) && state.editSequence === editSequence
        && state.snapshot.revision === snapshot.revision && state.snapshot.topologyRevision === snapshot.topologyRevision
    }
    return this.commands.openDetach({ instance: { instanceId: address.instanceId, hostDocumentId: address.hostDocumentId, bindingVersion: address.bindingVersion },
      group: { groupId: address.groupId, expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision },
      canonicalIds: snapshot.blocks.map(block => block.id), settled }, mounted, opener)
  }
  async openHostSource(opener: HTMLElement | null) {
    if (this.isLocked() || this.dialog || this.history.isBusy() || this.commands.pending() || !await this.host?.flushHost()) return false
    const opening = this.host?.getCurrent()
    if (!opening || !await this.open({ kind: 'host', hostDocumentId: opening.host.documentId })) return false
    this.observeRecoveryHost()
    try { await this.recovery.renewHost(opening.hostSession, { kind: 'host', documentId: opening.host.documentId,
      expectedUpdatedAt: opening.host.expectedPersistedUpdatedAt, source: true }) }
    catch (error) {
      console.warn('Editor recovery opening is unavailable; no journal close acknowledgement will be issued.', error)
      this.notify('草稿保护暂时不可用，源码未应用时请保留此窗口。', 'Draft protection is temporarily unavailable. Keep this window open while source changes remain unapplied.')
    }
    const after = this.host?.getCurrent()
    if (after?.hostSession !== opening.hostSession || after.editSequence !== opening.editSequence
      || after.host.expectedPersistedUpdatedAt !== opening.host.expectedPersistedUpdatedAt || this.dialog || this.isLocked()) return false
    this.dialog = { ...this.sourceState(), kind: 'host', opening, opener, operationId: crypto.randomUUID() }; this.emit(); return true
  }
  async restoreRecoverySource(recoveryOwnerId: string, before: SyncedHostSourceCurrent): Promise<boolean> {
    const unchanged = () => {
      const current = this.sourceCurrent()
      return !this.isLocked() && !this.dialog && !this.pending() && !this.recoveryReview && current?.hostSession === before.hostSession
        && current.editSequence === before.editSequence && current.host.documentId === before.host.documentId
        && current.host.expectedPersistedUpdatedAt === before.host.expectedPersistedUpdatedAt
        && current.host.workingBefore.title === before.host.workingBefore.title && current.host.workingBefore.summary === before.host.workingBefore.summary
        && areDocumentDraftBlocksEqual(current.host.workingBefore.blocks, before.host.workingBefore.blocks)
    }
    if (!unchanged() || !await this.open({ kind: 'host', hostDocumentId: before.host.documentId }) || !unchanged()) return false
    const owner = await openColdHostSourceOwner(recoveryOwnerId)
    if (!unchanged()) return false
    const restored = restoreSyncedHostSourceDraft(owner, this.sourceCurrent()!)
    if (restored.pinnedOpening) {
      this.observeRecoveryHost()
      const opened = await this.recovery.renewHost(before.hostSession, { kind: 'host', documentId: before.host.documentId,
        expectedUpdatedAt: before.host.expectedPersistedUpdatedAt, source: true })
      const pinned = restored.pinnedOpening
      if (!unchanged() || opened.base.workspaceScope !== pinned.workspaceScope || opened.base.recoveryEpoch !== pinned.recoveryEpoch
        || !same(opened.base.hostSourcePins, pinned.hostSourcePins)) return false
    }
    this.dialog = { ...this.sourceState(), kind: 'host', opening: before, restored, opener: null, operationId: crypto.randomUUID() }
    this.emit(); return true
  }
  /** Navigation uses a current actual Main snapshot. Persisted replay fields
   * never choose an arbitrary host/key to mint a new read owner. */
  recoveryGroupTarget(groupId: string, canonicalHostDocumentId?: string): string | null {
    const mounted = [...this.mounts.values()].find(item => item.mount.groupId === groupId && item.binding.isCurrent())
    return mounted?.mount.hostDocumentId ?? canonicalHostDocumentId ?? null
  }
  async restoreRecoveryGroup(recoveryOwnerId: string, groupId: string, before: SyncedHostSourceCurrent,
    kind: 'body' | 'body-followup' | 'source' | { proofHash: string; instanceId?: string } = 'body'): Promise<boolean> {
    const exactInstance = typeof kind === 'object' && kind.instanceId
    const actual = [...this.mounts.values()].find(item => item.mount.groupId === groupId && item.mount.hostSession === before.hostSession
      && (!exactInstance || item.mount.instanceId === exactInstance) && item.binding.isCurrent())
    const sessionId = this.session?.sessionId, state = actual?.binding.getCurrent()
    const unchanged = () => {
      const current = this.sourceCurrent()
      return Boolean(actual && state && this.session?.sessionId === sessionId && !this.isLocked() && !this.dialog && !this.pending()
        && this.host?.isComposing?.() !== true
        && !this.recoveryReview && !this.invalid && actual.binding.isCurrent() && actual.binding.getCurrent() === state
        && !state.dirty && !state.incoming && !state.failure && !state.error && !state.pending && !state.composingInstanceIds.length
        && current?.hostSession === before.hostSession && current.editSequence === before.editSequence
        && current.host.documentId === before.host.documentId && current.host.expectedPersistedUpdatedAt === before.host.expectedPersistedUpdatedAt)
    }
    if (!actual || !state || !sessionId || !unchanged()) return false
    if (kind === 'source') {
      const { readCanonicalRecoverySource } = await import('@shared/editor-recovery-canonical-source')
      if (!unchanged() || !clean(state)) return false
      const record = await window.knowbook.decideEditorRecoveryDraft({ recoveryOwnerId, decision: 'restore-draft' })
      if (!record || !unchanged()) return false
      const { draft, opening, accepted, selection } = readCanonicalRecoverySource(record)
      const owner = record.base.owner
      const snapshot = state.snapshot
      if (owner.kind !== 'group' || owner.groupId !== snapshot.groupId || owner.creationId !== snapshot.creationId
        || owner.revision !== snapshot.revision || owner.topologyRevision !== snapshot.topologyRevision || owner.historyCursor !== snapshot.history.cursor
        || !areDocumentDraftBlocksEqual(accepted.initialBlocks, state.working)) return false
      const canApply = () => {
        const current = actual.binding.getCurrent()
        return current.editSequence === state.editSequence && current.snapshot.revision === snapshot.revision
          && current.snapshot.topologyRevision === snapshot.topologyRevision && current.snapshot.history.cursor === snapshot.history.cursor
      }
      this.dialog = { ...this.sourceState(), kind: 'canonical', binding: actual.binding, opener: null,
        restored: { draft, opening, accepted, selection, canApply } }
      this.emit(); return true
    }
    const recovery = await import('../editor-recovery/canonicalColdOwner')
    if (!unchanged()) return false
    const { instanceId, hostDocumentId, bindingVersion } = actual.binding.scope
    const instance = { instanceId, hostDocumentId, bindingVersion }
    if (typeof kind === 'object') {
      const identity = this.recoveryGroups.get(groupId)
      if (!identity || hostDocumentId !== before.host.documentId) return false
      return this.recovery.adoptCrossMove(identity, unchanged, targetDraftSessionId =>
        recovery.requestColdCanonicalCrossMove({ recoveryOwnerId, sessionId, instance, targetDraftSessionId, proofHash: kind.proofHash }),
      async (prepared, current) => {
        const base = prepared.record.base, mounted = actual.binding.scope, session = this.session
        if (!current() || mounted.instanceId !== instanceId || mounted.hostDocumentId !== hostDocumentId || mounted.bindingVersion !== bindingVersion
          || !session || base.workspaceScope !== session.workspaceScope || base.recoveryEpoch !== session.recoveryEpoch) return false
        const owner = recovery.openColdCanonicalCrossMoveOwner(prepared)
        try { return await restoreSyncedCanonicalRecovery(actual.binding, owner, current) }
        finally { recovery.closeColdCanonicalRecoveryOwner(owner) }
      })
    }
    const owner = kind === 'body-followup'
      ? await recovery.openColdCanonicalFollowupOwner(recoveryOwnerId, sessionId, instance)
      : await recovery.openColdCanonicalRecoveryOwner(recoveryOwnerId, sessionId, this.readSources)
    try { return unchanged() && await restoreSyncedCanonicalRecovery(actual.binding, owner, unchanged) }
    finally { recovery.closeColdCanonicalRecoveryOwner(owner) }
  }
  sourceCurrent = () => this.host?.getCurrent() ?? null
  sourceIsCurrent(dialog: InlineDialog) { return !this.invalid && this.dialog?.id === dialog.id
    && (dialog.kind !== 'host' || this.sourceCurrent()?.hostSession === dialog.opening.hostSession) }
  async listHostSourceReferences(dialog: Extract<InlineDialog, { kind: 'host' }>, query: string, offset: number): Promise<SyncedGroupIdentityListResult> {
    const session = this.session
    if (!session || this.isLocked() || !this.sourceIsCurrent(dialog)) throw new Error('The original Source session is unavailable')
    const result = await this.invoke('listSyncedGroups', { query, offset, limit: 20, includeCreationId: true })
    if (this.session?.sessionId !== session.sessionId || this.isLocked() || !this.sourceIsCurrent(dialog))
      throw new Error('The original Source session changed')
    const items = result.items.map(item => {
      if (!('creationId' in item) || !isSyncedUuid(item.creationId) || !isSyncedUuid(item.groupId)) throw new Error('The actual group identity is unavailable')
      return { ...item, creationId: item.creationId }
    })
    if (new Set(items.map(item => item.groupId)).size !== items.length) throw new Error('The actual group list contains ambiguous identities')
    return { total: result.total, items }
  }
  async resolveHostSourceReference(dialog: Extract<InlineDialog, { kind: 'host' }>,
    { groupId, creationId }: { groupId: string; creationId: string }): Promise<SyncedReferenceIdentity | null> {
    const session = this.session
    if (!session || this.isLocked() || !this.sourceIsCurrent(dialog)) return null
    const result = await this.invoke('getSyncedGroupSnapshots', { groupIds: [groupId] })
    const item = result.items[0]
    if (this.session?.sessionId !== session.sessionId || this.isLocked() || !this.sourceIsCurrent(dialog)
      || result.workspaceScope !== session.workspaceScope || result.items.length !== 1 || item?.status !== 'ready'
      || item.snapshot.groupId !== groupId || item.snapshot.creationId !== creationId) return null
    return { workspaceScope: result.workspaceScope, groupId, creationId }
  }
  private async structureGuards(hostDocumentId: string, groupIds: readonly string[], pinned?: RestoredSyncedHostSource['pinnedOpening']) {
    const persisted = this.host?.getPersisted()
    if (!persisted || persisted.id !== hostDocumentId) return null
    const pGroups = persisted.blocks.filter(block => block.type === 'synced-block').map(block => parseSyncedBlockPayload(block.content).groupId)
    const snapshots = await this.invoke('getSyncedGroupSnapshots', { groupIds: [...new Set([...groupIds, ...pGroups])] })
    if (snapshots.workspaceScope !== this.session?.workspaceScope || snapshots.items.some(item => item.status !== 'ready')) return null
    const ready = snapshots.items.flatMap(item => item.status === 'ready' ? [item.snapshot] : [])
    if (pinned && (pinned.workspaceScope !== snapshots.workspaceScope || pinned.recoveryEpoch !== this.session?.recoveryEpoch
      || pinned.hostSourcePins.groups.some(group => {
        const current = ready.find(snapshot => snapshot.groupId === group.groupId)
        if (!current || current.creationId !== group.creationId || current.createdAt !== group.createdAt || current.revision !== group.revision
          || current.topologyRevision !== group.topologyRevision || current.history.cursor !== group.historyCursor) return true
        const instances = current.instances.filter(instance => instance.hostDocumentId === hostDocumentId)
        return instances.length !== group.instances.length || group.instances.some(expected => !instances.some(instance =>
          instance.instanceId === expected.instanceId && instance.bindingVersion === expected.bindingVersion
          && instance.parentBlockId === expected.parentBlockId && instance.parentType === expected.parentType && instance.depth === expected.depth))
      }))) return null
    const instances = ready.flatMap(snapshot => snapshot.instances.filter(instance => instance.hostDocumentId === hostDocumentId)
      .map(instance => ({ ...instance, groupId: snapshot.groupId })))
    // Only actual persisted instances can be reopened here. W-only/new refs
    // remain intentions for Main's existing newRefSources/identity planner.
    for (const instance of instances) if (!await this.open({ kind: 'instance', hostDocumentId,
      instanceId: instance.instanceId, groupId: instance.groupId })) return null
    return { groups: ready.map(snapshot => ({ groupId: snapshot.groupId, expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision })),
      expectedInstances: instances.map(({ instanceId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion })) }
  }
  private async settleOriginalHostWrite(input: SyncedStructureInput, recoveringOriginal: boolean) {
    if (recoveringOriginal) {
      // The actual commit can remove/rebind the very instance in the old
      // writer fence. Recover its original receipt before replaying that fence.
      // invoke still proves this genuine session belongs to the SAME epoch.
      const known = await this.invoke('getSyncedOperation', { clientOperationId: input.clientOperationId })
      if (known.status === 'committed') {
        if (!('hosts' in known.result)) throw new Error('The original host nonce belongs to another operation kind')
        return known.result
      }
    }
    try { return await this.invoke('applySyncedHostStructure', input) }
    catch (error) {
      const known = await this.invoke('getSyncedOperation', { clientOperationId: input.clientOperationId })
      if (known.status !== 'committed' || !('hosts' in known.result)) throw error
      return known.result
    }
  }

  async crossMoveHistory(documentId: string, current: () => boolean) {
    if (!current() || this.isLocked() || this.invalid || !await this.open({ kind: 'host', hostDocumentId: documentId }) || !current()) return []
    return this.invoke('getSyncedCrossHostMoveHistory', { documentId })
  }

  originalCrossMovePeer(documentId: string) {
    const pending = this.crossWrite
    return pending && this.sourceCurrent()?.hostSession === pending.opening.hostSession
      ? pending.peers.find(peer => peer.id === documentId) ?? null : null
  }
  private protectCrossMoveDraft(opening: SyncedHostSourceCurrent, source: DocumentDetail, rootIds: readonly string[], targetId: string,
    batch = false): CrossDraftProtection | undefined {
    const selected = readProtectedCrossMoveReference(source.blocks, rootIds)
    if (!selected || batch && (rootIds.length !== 1 || selected.id !== rootIds[0] || selected.depth !== 0)) return undefined
    const instanceId = selected.id
    const { groupId } = parseSyncedBlockPayload(selected.content), group = this.workspace.getGroup(groupId), identity = this.recoveryGroups.get(groupId)
    const active = [...this.mounts.values()].find(item => item.mount.hostSession === opening.hostSession
      && item.mount.instanceId === instanceId && item.mount.groupId === groupId && item.binding.isCurrent())
    if (!group || !identity || !active) return undefined
    const state = group.getSnapshot()
    if (clean(state)) return undefined
    const instances = state.snapshot.instances, moving = instances.find(item => item.instanceId === instanceId)
    if (!moving || batch && instances.length !== 1 || moving.hostDocumentId !== source.id
      || moving.bindingVersion !== active.binding.scope.bindingVersion || moving.depth !== selected.depth || moving.depth !== active.mount.depth
      || moving.parentBlockId !== selected.parentBlockId || moving.parentBlockId !== active.mount.parentBlockId
      || moving.parentType !== (source.blocks.find(block => block.id === moving.parentBlockId)?.type ?? null)) return undefined
    const survivors: MountedInline[] = []
    for (const instance of instances) {
      if (instance === moving) continue
      if (rootIds.length !== 1 || rootIds[0] !== instanceId && (instances.length !== 2 || instance.hostDocumentId !== targetId)) return undefined
      if (instance.hostDocumentId === targetId) continue
      if (instance.hostDocumentId !== source.id) return undefined
      const current = this.mounts.get(JSON.stringify([source.id, instance.instanceId]))
      if (!current?.mount.reopenAfterCrossMove || current.mount.hostSession !== opening.hostSession || current.mount.groupId !== groupId
        || current.mount.depth !== instance.depth || current.mount.parentBlockId !== instance.parentBlockId
        || current.binding.scope.bindingVersion !== instance.bindingVersion || !current.binding.isCurrent()) return undefined
      survivors.push(current)
    }
    const hold = holdGroupForHostReorder(group)
    if (!hold) return undefined
    this.cancelGroupSave(groupId)
    return { instanceId, groupId, group, identity, hold, survivors,
      current: () => hold.current() && active.binding.isCurrent() && survivors.every(item => item.binding.isCurrent()) }
  }

  async moveBetweenHosts(opening: SyncedHostSourceCurrent, source: DocumentDetail, peers: readonly DocumentDetail[],
    input: Pick<SyncedStructureInput, 'hostsWorkingBefore'> & ({ selection: string[]; placement?: SyncedPlacement }
      | { action: Extract<SyncedStructureAction, { kind: 'move-batch' }> }) | { historyToken: string; direction: 'undo' | 'redo'; groupIds: string[] },
    current: () => boolean, adopt: (result: SyncedStructureApplied, peers: readonly DocumentDetail[]) => boolean,
    requiredDependencies?: ControlledDocumentBlockMove['dependencies']): Promise<boolean> {
    const prior = this.crossWrite
    let protection = prior?.protection
    try {
      const exact = () => current() && same(this.sourceCurrent(), opening)
      const groupsClean = (ids: Iterable<string>) => {
        for (const id of ids) {
          const group = this.workspace.getGroup(id)
          if (id === protection?.groupId && group === protection.group && protection.current()) continue
          if (group && !clean(group.getSnapshot())) return false
        }
        return true
      }
      const reportDirty = () => {
        this.notify('参与此操作的共享正文还有未保存或待解决的草稿。草稿和选区已保留。',
          'A shared body involved in this operation has unsaved or unresolved edits. The draft and selection are retained.')
        return false
      }
      const canSubmit = () => exact() && !this.isLocked() && !this.recoveryReview && !this.dialog && !this.commands.pending()
        && !this.history.isBusy() && !this.sourceWrites.size && !this.hostWrites.size && !this.host?.isComposing?.() && !hasCanonicalInlineAsyncEdits()
      const key = JSON.stringify([peers.map(peer => [peer.id, peer.updatedAt]), input])
      if (!exact() || this.invalid || this.isLocked() || this.recoveryReview || this.host?.isReady?.() !== true
        || prior && (prior.opening.hostSession !== opening.hostSession || prior.key !== key || !same(prior.opening, opening))) return false
      if (!prior) {
        if (!canSubmit()) return false
        if ('selection' in input && peers.length === 1) {
          protection = this.protectCrossMoveDraft(opening, source, input.selection, peers[0].id)
        } else if ('action' in input && input.action.moves.length === 2 && input.action.moves.every(move => move.selection.selectedRootIds.length === 1)) {
          const currentMove = input.action.moves.find(move => move.selection.documentId === source.id)
          if (currentMove) protection = this.protectCrossMoveDraft(opening, source, currentMove.selection.selectedRootIds, currentMove.target.documentId, true)
        }
        const pages = [source, ...peers]
        this.observeRecoveryHost()
        await this.recovery.settleDetachedHosts(pages.map(page => page.id))
        if (!canSubmit()) return false
        const ids = new Set('groupIds' in input ? input.groupIds : [])
        const refs = (page: { blocks: readonly { id?: string; type: string; content: string }[] }) => page.blocks
          .filter(block => block.type === 'synced-block').map(block => ({ instanceId: block.id!, groupId: parseSyncedBlockPayload(block.content).groupId }))
        if ('hostsWorkingBefore' in input) for (const side of input.hostsWorkingBefore) for (const ref of refs(side.workingBefore)) ids.add(ref.groupId)
        const readGuards = async () => {
          const persisted = pages.flatMap(page => refs(page).map(ref => ({ ...ref, hostDocumentId: page.id })))
          for (const ref of persisted) ids.add(ref.groupId)
          if (!groupsClean(ids)) { reportDirty(); return null }
          const snapshots = await this.invoke('getSyncedGroupSnapshots', { groupIds: [...ids] })
          if (!canSubmit() || snapshots.workspaceScope !== this.session?.workspaceScope || snapshots.items.length !== ids.size
            || snapshots.items.some(item => item.status !== 'ready' || !ids.has(item.snapshot.groupId))) return null
          const groups = snapshots.items.flatMap(item => item.status === 'ready' ? [item.snapshot] : [])
          const expectedInstances = []
          for (const { hostDocumentId, instanceId, groupId } of persisted) {
            const instance = groups.find(group => group.groupId === groupId)?.instances.find(item => item.instanceId === instanceId)
            if (!instance || instance.hostDocumentId !== hostDocumentId) return null
            expectedInstances.push({ hostDocumentId, instanceId, bindingVersion: instance.bindingVersion })
          }
          return { expectedInstances, groups: groups.map(group => ({ groupId: group.groupId,
            expectedRevision: group.revision, expectedTopologyRevision: group.topologyRevision })) }
        }
        // A shallow move uses committed content for its CAS and final graph. It
        // must never flush a controller or rebind an instance with queued edits.
        for (const page of pages) if (!await this.open({ kind: 'host', hostDocumentId: page.id }) || !canSubmit()) return false
        const guards = await readGuards()
        if (!guards) return false
        const clientOperationId = crypto.randomUUID()
        let request: CrossWrite['input'] = 'hostsWorkingBefore' in input
          ? { ...guards, clientOperationId, mode: 'command', hostsWorkingBefore: input.hostsWorkingBefore,
              action: 'action' in input ? input.action : { kind: 'move', selection: { documentId: source.id, selectedRootIds: input.selection },
                target: input.placement ?? { documentId: peers[0].id, parentBlockId: null, beforeBlockId: null, depth: 0 } } }
          : { ...guards, clientOperationId, historyToken: input.historyToken, direction: input.direction,
              expectedHosts: pages.map(page => ({ documentId: page.id, expectedUpdatedAt: page.updatedAt })) }
        if ('mode' in request) {
          const plan = await this.invoke('prepareSyncedCrossHostMove', request)
          if (!canSubmit() || plan.status !== 'ready') return false
          if (protection && plan.dependencies.length && request.action.kind === 'move'
            && (request.action.selection.selectedRootIds.length !== 1 || request.action.selection.selectedRootIds[0] !== protection.instanceId)) return reportDirty()
          const newWorking = []
          const syncedDependencies = new Map<string, string>()
          for (const { documentId, updatedAt } of plan.dependencies) {
            const page = await window.knowbook.getDocumentDetail(documentId)
            if (!page || page.id !== documentId || page.updatedAt !== updatedAt
              || !canSubmit() || !await this.open({ kind: 'host', hostDocumentId: page.id }) || !canSubmit()) return false
            pages.push(page)
            if (page.blocks.some(block => block.type === 'synced-block')) syncedDependencies.set(documentId, updatedAt)
            const { id, title, summary, blocks } = page
            const workingBefore = { title, summary, blocks: blocks.map(({ sortOrder: _sortOrder, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })) }
            newWorking.push({ documentId: id, expectedPersistedUpdatedAt: updatedAt, workingBefore })
          }
          if (newWorking.length) request = { ...request, hostsWorkingBefore: [...request.hostsWorkingBefore, ...newWorking] }
          if (requiredDependencies && (requiredDependencies.length !== syncedDependencies.size
            || requiredDependencies.some(({ documentId, updatedAt }) => syncedDependencies.get(documentId) !== updatedAt))) return false
          if (syncedDependencies.size) {
            const finalGuards = await readGuards()
            if (!finalGuards || !same(guards.groups, finalGuards.groups.slice(0, guards.groups.length))
              || !same(guards.expectedInstances, finalGuards.expectedInstances.slice(0, guards.expectedInstances.length))) return false
            request = { ...request, ...finalGuards }
          }
        }
        if (!canSubmit() || this.crossWrite) return false
        if (!groupsClean(ids)) return reportDirty()
        this.observeRecoveryHost()
        const write: CrossWrite = { opening, peers: pages.slice(1), key, input: request, protection }
        this.crossWrite = write; this.emit()
        const ready = () => this.crossWrite === write && canSubmit() && groupsClean(ids)
        let protectedOriginal = false
        try {
          protectedOriginal = await this.recovery.checkpointPendingHost(opening.hostSession, request.clientOperationId, ready,
            'mode' in request ? 'applySyncedHostStructure' : 'restoreSyncedHostOperation', protection?.identity, Boolean(protection)) && ready()
          if (protectedOriginal && protection) {
            write.hostHead = this.recovery.durableHead(opening.hostSession) ?? undefined
            protectedOriginal = !!write.hostHead
          }
          if (!protectedOriginal) return false
        } finally {
          if (!protectedOriginal && this.crossWrite === write) { this.crossWrite = null; this.emit() }
        }
      }
      const write = this.crossWrite!, { input: request, peers: participants } = write
      if (protection) {
        const sessionId = this.session?.sessionId
        if (!write.hostHead || !sessionId || !canSubmit() || !protection.current()) return false
        protection.hold.expectCrossMove(request.clientOperationId)
        const invoke = () => window.knowbook.applyEditorRecoveryCrossMove({ sessionId, hostHead: write.hostHead! })
        const moved = await invoke().catch(invoke)
        if (moved.status === 'rejected') {
          this.crossWrite = null; this.emit()
          return reportDirty()
        }
        const result = moved.result
        if (result.operationId !== request.clientOperationId || !result.historyToken) throw new Error('The original protected cross-page receipt changed')
        this.recovery.releaseCompletedCrossMove(opening.hostSession, protection.identity)
        const retired = this.workspace.releaseCrossMove(protection.groupId, protection.group, protection.hold)
        if (retired) {
          this.recoveryGroups.delete(protection.groupId); this.watchers.delete(protection.groupId)
        }
        const accepted = exact() && adopt(result, participants)
        this.crossWrite = null
        if (retired) for (const { mount, binding } of protection.survivors) if (binding.isCurrent()) {
          binding.dispose()
          mount.reopenAfterCrossMove?.()
        }
        if (accepted) this.observeRecoveryHost()
        this.retainedCrossMoveRevision++
        this.emit()
        this.notify('共享正文草稿已保留。请在新文档打开「检查保留的编辑草稿」继续。', 'The shared body draft is retained. Open Review retained editor drafts in the new document to continue.')
        return accepted
      }
      const known = async () => {
        const result = await this.invoke('getSyncedOperation', { clientOperationId: request.clientOperationId })
        if (result.status === 'committed' && !('hosts' in result.result)) throw new Error('Cross-page operation receipt kind changed')
        return result.status === 'committed' && 'hosts' in result.result ? result.result : null
      }
      let result = prior ? await known() : null
      if (!result) {
        if (!canSubmit()) return false
        if (!groupsClean(request.groups.map(group => group.groupId))) return reportDirty()
        try {
          const value = 'mode' in request ? await this.invoke('applySyncedHostStructure', request) : await this.invoke('restoreSyncedHostOperation', request)
          if (value.status !== 'applied' && value.status !== 'noop') {
            this.crossWrite = null; this.emit()
            throw new Error('跨页移动或撤销未提交，完整正文仍保留。')
          }
          result = value
        } catch (error) { result = await known(); if (!result) throw error }
      }
      if (result.status === 'noop') { this.crossWrite = null; this.emit(); return false }
      if (!exact() || result.operationId !== request.clientOperationId || !result.historyToken
        || 'historyToken' in request && result.historyToken !== request.historyToken || !adopt(result, participants)) return false
      this.crossWrite = null; this.emit()
      const saved = this.sourceCurrent(), accepted = result.hosts.find(host => host.documentId === source.id)?.after
      if (saved?.hostSession === opening.hostSession && accepted && saved.host.documentId === accepted.id
        && saved.host.expectedPersistedUpdatedAt === accepted.updatedAt) {
        try {
          await this.recovery.renewHost(saved.hostSession, { kind: 'host', documentId: accepted.id, expectedUpdatedAt: accepted.updatedAt })
        } catch (error) { console.warn('The committed move recovery baseline could not be renewed.', error) }
      }
      return true
    } finally {
      if (protection && this.crossWrite?.protection !== protection) protection.hold.release()
    }
  }
  async saveHostWorking(before: SyncedHostSourceCurrent): Promise<{ result: SyncedStructureApplied; submitted: SyncedHostSourceCurrent }> {
    if (this.crossWrite) throw new Error('Resolve the original cross-page operation before saving')
    let write = this.hostWrites.get(before.hostSession)
    const recoveringOriginal = Boolean(write)
    if (!write) {
      if (!await this.open({ kind: 'host', hostDocumentId: before.host.documentId }) || this.invalid) throw new Error('The actual host session is unavailable')
      if (!await flushSyncedWorkspacePendingChanges(this.workspace)) throw new Error('Shared body changes have not finished saving')
      const ids = before.host.workingBefore.blocks.filter(block => block.type === 'synced-block').map(block => parseSyncedBlockPayload(block.content).groupId)
      const guards = await this.structureGuards(before.host.documentId, ids)
      if (!guards || this.sourceCurrent()?.hostSession !== before.hostSession) throw new Error('The actual host changed before saving')
      const submitted = { ...before, host: structuredClone(before.host) }
      const input: SyncedStructureInput = { clientOperationId: crypto.randomUUID(), ...guards, mode: 'host-final', reason: 'selection-edit',
        hostsWorkingBefore: [submitted.host], finalAfter: [{ documentId: submitted.host.documentId, ...submitted.host.workingBefore }], newRefSources: [] }
      write = { submitted, input }; this.hostWrites.set(before.hostSession, write); this.emit()
    }
    // The immutable original nonce/body survives a lost IPC reply. A newer W
    // first adopts this real old ACK, then sends its own next full W.
    const result = await this.settleOriginalHostWrite(write.input, recoveringOriginal)
    if ((result.status !== 'applied' && result.status !== 'noop') || result.operationId !== write.input.clientOperationId) {
      this.hostWrites.delete(before.hostSession); this.emit()
      throw new Error(this.host?.isZh ? '当前修改尚未保存，完整正文草稿已保留。' : 'The changes were not saved; the complete body draft is retained.')
    }
    if (result.hosts.length !== 1 || result.hosts[0].documentId !== write.submitted.host.documentId)
      throw new Error('The original host acknowledgement did not match')
    this.hostWrites.delete(before.hostSession); this.emit()
    return { result, submitted: write.submitted }
  }
  async applyHostSource(dialog: Extract<InlineDialog, { kind: 'host' }>, prepared: PreparedSyncedHostSource) {
    return (await this.applyHostSourceOwned(dialog, prepared, null)).accepted
  }
  async applyHostSourceSubmission(dialog: Extract<InlineDialog, { kind: 'host' }>, submission: SyncedHostSourceSubmission): Promise<SyncedHostSourceApplyOutcome> {
    return this.applyHostSourceOwned(dialog, readSyncedHostSourceSubmission(submission), submission)
  }
  private async applyHostSourceOwned(dialog: Extract<InlineDialog, { kind: 'host' }>, prepared: PreparedSyncedHostSource,
    submission: SyncedHostSourceSubmission | null): Promise<SyncedHostSourceApplyOutcome> {
    const before = prepared.hostsWorkingBefore[0], original = dialog.opening.host
    if (this.isLocked() || !this.sourceIsCurrent(dialog) || prepared.hostsWorkingBefore.length !== 1 || !before
      || before.documentId !== original.documentId || before.expectedPersistedUpdatedAt !== original.expectedPersistedUpdatedAt
      || before.workingBefore.title !== original.workingBefore.title || before.workingBefore.summary !== original.workingBefore.summary
      || !areDocumentDraftBlocksEqual(before.workingBefore.blocks, original.workingBefore.blocks)) return { accepted: false }
    // Do not ask the Source blocker to flush itself. This is its registered
    // Apply callback, and Main still proves every actual structure guard.
    if (!await flushSyncedWorkspacePendingChanges(this.workspace)) return { accepted: false }
    const ordinary = !this.checkpointedSources.has(dialog.id) && !this.sourceWrites.has(dialog.id) && !prepared.newRefSources.length && prepared.finalAfter.length === 1
      && !this.host?.getPersisted()?.blocks.some(block => block.type === 'synced-block')
      && ![...prepared.hostsWorkingBefore.flatMap(host => host.workingBefore.blocks), ...prepared.finalAfter.flatMap(host => host.blocks)]
        .some(block => block.type === 'synced-block')
    if (ordinary) return { accepted: this.host?.applyOrdinarySource?.(dialog.opening, prepared.finalAfter[0]) ?? false }
    const groupIds = new Set<string>()
    for (const body of [...prepared.hostsWorkingBefore.map(host => host.workingBefore), ...prepared.finalAfter])
      for (const block of body.blocks) if (block.type === 'synced-block') groupIds.add(parseSyncedBlockPayload(block.content).groupId)
    let write = this.sourceWrites.get(dialog.id)
    const recoveringOriginal = Boolean(write)
    if (!write) {
      const pinned = this.checkpointedSources.has(dialog.id) ? undefined : dialog.restored?.pinnedOpening
      const guards = await this.structureGuards(dialog.opening.host.documentId, [...groupIds], pinned)
      if (!guards || !this.sourceIsCurrent(dialog)) return { accepted: false }
      const input: SyncedStructureInput = { clientOperationId: dialog.operationId, ...guards, mode: 'host-final', reason: 'source-apply', ...structuredClone(prepared) }
      write = { input, opening: { ...dialog.opening, host: structuredClone(dialog.opening.host) }, submission }
      this.sourceWrites.set(dialog.id, write)
    }
    const input = write.input
    const result = await this.settleOriginalHostWrite(input, recoveringOriginal)
    if (result.status !== 'applied' && result.status !== 'noop') { this.sourceWrites.delete(dialog.id); return { accepted: false } }
    if (result.operationId !== input.clientOperationId || !this.sourceIsCurrent(dialog)) return { accepted: false }
    const acceptedCandidate = input.mode === 'host-final' && same(input.finalAfter, prepared.finalAfter) && same(input.newRefSources, prepared.newRefSources)
    const adopted = this.adoptStructure(write.opening, result)
    if (!adopted) return { accepted: false } // Keep the original nonce while its committed receipt cannot yet be adopted.
    // The actual receipt is now known AND adopted. A local checkpoint failure
    // must retain CM text and allow explicit Cancel/copy-reopen, rather than
    // pinning this settled nonce as an unknown operation forever.
    this.sourceWrites.delete(dialog.id)
    try {
      let checkpoint
      if (write.submission) {
        const next = this.sourceCurrent()
        if (!next) throw new Error('The actual accepted host opening is unavailable; the complete Source remains retained')
        checkpoint = acceptSyncedHostSourceCheckpoint(write.submission, input, result, write.opening, next)
        this.checkpointedSources.add(dialog.id)
        // Advance only from this actual accepted receipt, never get-latest after
        // an await. The unchanged dialog identity keeps the real CM view alive.
        dialog.opening = { ...next, host: structuredClone(next.host) }
        dialog.operationId = crypto.randomUUID()
      }
      return { accepted: acceptedCandidate, ...(checkpoint ? { checkpoint } : {}) }
    } finally { this.emit() }
  }
  async openSearch(occurrence: WorkspaceSearchOccurrence, shouldContinue: () => boolean) {
    if (this.isLocked() || !shouldContinue() || !await this.host?.flushHost()) return false
    const exact = await window.knowbook.resolveWorkspaceSearchOccurrence(occurrence)
    if (!shouldContinue() || exact.status !== 'ready' || !isSameWorkspaceSearchOccurrence(exact.occurrence, occurrence)) return false
    this.navigation?.finish(false)
    const attention = this.attention
    let request!: InlineNavigation
    const success = new Promise<boolean>(finish => {
      request = { sequence: ++this.revision, occurrence, committed: false,
        shouldContinue: () => this.navigation === request && !this.isLocked() && !this.invalid && this.attention === attention
          && (request.committed ? this.host?.selectedHostId() === occurrence.hostDocumentId : shouldContinue()),
        finish: value => { if (this.navigation === request) { this.navigation = null; this.emit() }; finish(value) } }
      this.navigation = request; this.emit()
    })
    // Consume the SearchPage continuation through its real navigation commit.
    // Its own route change is then replaced by our exact-host mount/token guard.
    if (!await this.host?.navigateHost(occurrence.hostDocumentId, occurrence.instanceId, request.shouldContinue)) request.finish(false)
    else if (this.navigation === request && this.attention === attention && !this.isLocked()) { request.committed = true; this.emit() }
    else request.finish(false)
    return success
  }
  private openHeading(...[target, blocks, callbacks, clear]: Parameters<CanonicalHeadingAction>) {
    const { documentId, anchor } = target
    if (!anchor || !blocks.some(block => block.type === 'synced-block')) return
    const attention = this.attention
    let active = true
    const isCurrent = () => active && this.attention === attention && !this.isLocked()
    const missing = () => {
      if (!isCurrent()) return
      callbacks.onPendingTargetMissing()
      clear()
    }
    const resolve = async () => {
      if (!isCurrent() || !await this.host?.flushHost() || !isCurrent()) return missing()
      const saved = this.host?.getPersisted()
      if (saved?.id !== documentId) return missing()
      const result = await window.knowbook.resolveSyncedHeadingAnchor({
        documentId, expectedUpdatedAt: saved.updatedAt, anchor, matchText: target.wiki ?? false
      })
      if (!isCurrent()) return
      if (result.status !== 'ready') return missing()
      if (result.kind === 'canonical') {
        if (!await this.openSearch(result.occurrence, isCurrent)) missing()
        return
      }
      if (result.kind === 'title') callbacks.onPendingTargetResolved(-1, '', 0)
      else {
        const index = blocks.findIndex(block => block.id === result.blockId)
        if (index < 0) return missing()
        callbacks.onPendingTargetResolved(index, result.blockId, result.headingIndex)
      }
      clear()
    }
    void resolve().catch(missing)
    return () => { active = false }
  }
  cancelNavigation = () => { this.attention++; this.navigation?.finish(false) }
  navigationFor(hostId: string, instanceId: string) { const request = this.navigation
    return request?.occurrence.hostDocumentId === hostId && request.occurrence.instanceId === instanceId ? request : null }
  freeze(requestId: string) {
    this.observeRecoveryHost(); this.recovery.freeze()
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.saveTimers.clear()
    this.requestId = requestId; this.locked = true; this.navigation?.finish(false); this.emit()
  }
  cancelFreeze(requestId: string) {
    if (this.requestId !== requestId) return
    this.requestId = null; this.locked = false; this.releaseDeferred()
    this.recovery.unfreeze()
  }
  private releaseDeferred() {
    this.emit()
    if (this.isLocked()) return
    signalCanonicalInlineUnlock()
    const pending = [...this.deferred]; this.deferred.clear(); for (const run of pending) run()
    for (const id of this.groups) { const group = this.workspace.getGroup(id); if (group) this.scheduleGroupSave(id, group) }
  }
  ownsClose(requestId: string) { return this.locked && this.requestId === requestId }
  report(message: string) { this.host?.notify(message) }
  isLocked = () => this.locked || this.history?.pending() === true
}
let instance: InlineRuntime | null = null
export function peekCanonicalInlineRuntime() { return instance }
export function getCanonicalInlineRuntime() { return instance ??= new InlineRuntime() }
export type CanonicalInlineRuntime = InlineRuntime
