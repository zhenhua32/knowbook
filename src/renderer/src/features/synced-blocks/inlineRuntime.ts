import { adoptDocumentHostResult, restoreDocumentHostHistory } from '../../utils/documentHostHistory'
import type { DocumentDetail } from '@shared/contracts'
import { SyncedStructureCommands, type StructureCommandView } from './structureCommands'
import { SyncedHostStructureHistory } from './hostStructureHistory'
import { syncedSnapshotGuard, type SyncedGroupBinding, type SyncedGroupController } from './types'
import type { SyncedBlocksApi as MainSyncedApi, SyncedGroupSnapshot, SyncedHostWorkingBefore, SyncedStructureApplied, SyncedStructureInput } from '@shared/synced-blocks'
import type { SyncedEditingMethod, SyncedEditingMethods, SyncedEditingRequest, SyncedEditingSession } from '@shared/synced-editing-session'
import type { SyncedInlineInstanceAddress, WorkspaceSearchOccurrence } from '@shared/workspace-search-occurrence'
import type { EditorRecoveryDraft, EditorRecoveryWorkspace } from '@shared/editor-recovery-drafts'
import { isSameWorkspaceSearchOccurrence } from '@shared/workspace-search-occurrence'
import { isSyncedUuid, parseSyncedBlockPayload, validateSyncedCanonicalEdit, validateSyncedGroupSnapshot } from '@shared/syncedBlockValidation'
import { getSyncedWorkspaceController, flushSyncedWorkspacePendingChanges } from './controller'
import type { SyncedReadSourcesPort } from './sourceReadOwner'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import type { PreparedSyncedHostSource } from './hostSource'
import { readSyncedHostSourceSubmission, acceptSyncedHostSourceCheckpoint, createSyncedHostSourceDraft, restoreHostRecoverySource, type SyncedHostSourceDraft,
  type SyncedHostSourceSubmission, type SyncedHostSourceApplyOutcome } from './hostSource'
import type { MarkdownSourceLocalState, MarkdownSourceRecoveryOpening, MarkdownSourceRecoverySnapshot } from '../../components/DocumentMarkdownSourceDialog'
import type { MarkdownSourceDraft } from '../../utils/markdownSourceDraft'
import { createCanonicalSourceDraft } from './canonicalSource'
import { areDocumentDraftBlocksEqual, normalizeComparableDocumentTitle } from '../../utils/documentDraftComparison'
import { installCanonicalInlineTransitions, hasCanonicalInlineAsyncEdits, signalCanonicalInlineUnlock, type CanonicalInlineFlushOptions,
  type CanonicalHeadingAction } from './inlineBridge'
import { EditorRecoveryJournal, type EditorRecoveryCapture } from './editorRecoveryJournal'
import { isDirectlyRecoverable, readRecoveryHost, readRecoveryHostAddress, readRecoveryPayload, readRecoverySource,
  recoveryDocumentHash, sameRecoveryDocument, unchangedRecoveryBindings } from './editorRecoveryPayload'
import { restoreRecoveryAnchors } from './recoverySourceAnchors'

export interface InlineHostPort {
  getCurrent: () => SyncedHostSourceCurrent | null
  getPersisted: () => DocumentDetail | null
  adopt: (before: SyncedHostSourceCurrent, result: SyncedStructureApplied) => boolean
  adoptHistory: (before: SyncedHostSourceCurrent, result: SyncedStructureApplied) => boolean
  applyOrdinarySource?: (before: SyncedHostSourceCurrent, after: PreparedSyncedHostSource['finalAfter'][number]) => boolean
  flushHost: () => Promise<boolean>
  navigateHost: (documentId: string, instanceId: string, shouldContinue: () => boolean) => Promise<boolean>
  navigateDocument?: (documentId: string, shouldContinue: () => boolean) => Promise<boolean>
  stageRecovery?: (working: SyncedHostWorkingBefore['workingBefore']) => boolean
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
}
export interface InlineOpening { address: SyncedInlineInstanceAddress; binding: SyncedGroupBinding; group: SyncedGroupController }
type SourceState = { id: object; local: Readonly<MarkdownSourceLocalState>; recovery: Readonly<MarkdownSourceRecoverySnapshot> | null;
  report: (state: Readonly<MarkdownSourceLocalState>) => void;
  reportRecovery: (snapshot: Readonly<MarkdownSourceRecoverySnapshot> | null) => void; close: () => void }
export type InlineDialog = ({ kind: 'canonical'; binding: SyncedGroupBinding; opener: HTMLElement | null;
  baseline: ReturnType<SyncedGroupBinding['getCurrent']>; initialRecovery?: MarkdownSourceRecoveryOpening<MarkdownSourceDraft> }
  | { kind: 'host'; opening: SyncedHostSourceCurrent; opener: HTMLElement | null; operationId: string;
    initialRecovery?: MarkdownSourceRecoveryOpening<SyncedHostSourceDraft> }) & SourceState
export interface InlineNavigation {
  sequence: number; occurrence: WorkspaceSearchOccurrence; shouldContinue: () => boolean
  finish: (success: boolean) => void
  committed: boolean
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const blankSource = Object.freeze({ dirty: false, composing: false, applying: false, importing: false })
const clean = (state: ReturnType<SyncedGroupController['getSnapshot']>) => !state.dirty && !state.pending
  && !state.composingInstanceIds.length && !state.incoming && !state.failure && !state.error && state.phase === 'clean'

/** One renderer workspace queue, backed exclusively by a Main-issued opaque
 * frame/epoch session. Every instance binds the existing shared controller. */
class InlineRuntime {
  readonly commands: SyncedStructureCommands
  readonly history: SyncedHostStructureHistory
  readonly recovery = new EditorRecoveryJournal(() => this.captureRecovery(), error => this.report(String(error)))
  private session: SyncedEditingSession | null = null
  private invalid = false
  private groups = new Set<string>()
  private watchers = new Set<string>()
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private mounts = new Map<string, { mount: InlineMount; binding: SyncedGroupBinding }>()
  private host: InlineHostPort | null = null
  private rpc = new Set<Promise<unknown>>()
  private surfaces = new Map<object, { hostSession: object; expectedInstances: readonly string[] }>()
  private openingBindings = new Set<object>()
  private hostWrites = new Map<object, { submitted: SyncedHostSourceCurrent; input: SyncedStructureInput }>()
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
  private readonly workspace: ReturnType<typeof getSyncedWorkspaceController>
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
      captureBaseline: input => invoke('captureBaseline', input), operation: input => invoke('ownedOperation', input),
      validate: input => invoke('validateOwner', input), release: input => invoke('releaseOwner', input)
    }
    this.workspace = getSyncedWorkspaceController(this.port, { readSources })
    this.history = new SyncedHostStructureHistory({ current: () => this.sourceCurrent(),
      readHost: id => window.knowbook.getDocumentDetail(id), workspaceScope: () => this.session?.workspaceScope ?? null,
      // The history's own unsettled request is intentionally excluded here so
      // the exact original Undo/Redo can recover its receipt. All other owners
      // still block it, including close, attachments, Source and commands.
      blocked: () => this.locked || this.invalid || Boolean(this.dialog) || this.commands?.pending() === true
        || this.hostWrites.size > 0 || this.sourceWrites.size > 0 || this.host?.isReady?.() !== true
        || this.host?.isComposing?.() === true || hasCanonicalInlineAsyncEdits(),
      openHost: async id => Boolean(await this.open({ kind: 'host', hostDocumentId: id })),
      openInstance: async (hostDocumentId, instanceId, groupId) => Boolean(await this.open({ kind: 'instance', hostDocumentId, instanceId, groupId })),
      readHistory: documentId => this.invoke('getSyncedHostHistory', { documentId }),
      readGroups: groupIds => this.invoke('getSyncedGroupSnapshots', { groupIds }),
      flushGroups: current => flushSyncedWorkspacePendingChanges(this.workspace, { shouldContinue: current }),
      flushHost: () => this.host?.flushHost() ?? Promise.resolve(false),
      restore: input => this.invoke('restoreSyncedHostOperation', input),
      operation: clientOperationId => this.invoke('getSyncedOperation', { clientOperationId }),
      adopt: (before, result) => this.host?.adoptHistory(before, result) ?? false,
      changed: () => this.emit(), released: () => this.releaseDeferred(), notify: (zh, en) => this.notify(zh, en) })
    this.commands = new SyncedStructureCommands({ current: () => this.sourceCurrent(),
      blocked: () => this.isLocked() || this.history.isBusy() || this.invalid || Boolean(this.dialog) || this.hostWrites.size > 0 || this.sourceWrites.size > 0
        || this.host?.isReady?.() !== true || this.host?.isComposing?.() === true || this.host?.canStartStructure?.() === false || hasCanonicalInlineAsyncEdits(),
      openHost: async id => Boolean(await this.open({ kind: 'host', hostDocumentId: id })),
      list: input => this.invoke('listSyncedGroups', input), guards: (id, extra) => this.structureGuards(id, extra),
      flushGroups: current => flushSyncedWorkspacePendingChanges(this.workspace, { shouldContinue: current }),
      apply: input => this.invoke('applySyncedHostStructure', input),
      operation: clientOperationId => this.invoke('getSyncedOperation', { clientOperationId }),
      adopt: (before, result) => this.adoptStructure(before, result),
      changed: () => this.emit(), notify: (zh, en) => this.notify(zh, en), isZh: () => this.host?.isZh ?? true })
    window.knowbook.onWorkspaceMutated(() => {
      const refresh = () => { if (this.session && !this.invalid && this.groups.size) void this.workspace.load([...this.groups]).catch(() => this.emit()) }
      if (this.isLocked()) this.deferred.add(refresh); else refresh()
    })
    installCanonicalInlineTransitions(this, { flush: options => this.flush(options), pending: () => this.pending(), hostPending: () => this.hostWrites.size > 0, navigate: () => this.preparePageNavigation(), locked: () => this.isLocked(),
      restoreHistory: (transition, direction) => this.history.restore(transition, direction), ownsHistory: transition => this.history.owns(transition),
      adoptHostResult: adoptDocumentHostResult,
      runHostHistory: restoreDocumentHostHistory,
      openHeading: (...input) => this.openHeading(...input),
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
  getSnapshot = () => this.ui
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit() {
    this.ui = Object.freeze({ revision: ++this.revision, locked: this.isLocked(), dialog: this.dialog, navigation: this.navigation, command: this.commands.getSnapshot() })
    for (const listener of [...this.listeners, ...this.idle]) { try { listener() } catch (error) { console.error('Synced view observer failed', error) } }
    if (!this.locked) this.recovery.schedule()
  }

  private captureRecovery(): EditorRecoveryCapture[] {
    const captured: EditorRecoveryCapture[] = [], current = this.sourceCurrent(), persisted = this.host?.getPersisted()
    if (current && persisted?.id === current.host.documentId) {
      const { host, hostSession } = current, working = host.workingBefore
      const pending = this.hostWrites.get(hostSession)?.input ?? this.history.recoveryInput() ?? this.commands.recoveryInput()
      if (this.host?.isComposing?.()) captured.push({ owner: hostSession })
      else if (pending || normalizeComparableDocumentTitle(working.title) !== normalizeComparableDocumentTitle(persisted.title)
        || working.summary.trim() !== persisted.summary.trim() || !areDocumentDraftBlocksEqual(working.blocks, persisted.blocks)) {
        captured.push({ owner: hostSession, draft: { kind: 'document', targetId: host.documentId,
          data: recoveryDocumentHash(persisted).then(persistedHash => ({ version: 1, host, persistedHash, pending })) } })
      }
    }
    for (const id of this.groups) {
      const group = this.workspace.getGroup(id)
      if (!group) continue
      const state = group.getSnapshot()
      if (state.composingInstanceIds.length) captured.push({ owner: group })
      else if (!clean(state)) captured.push({ owner: group, draft: { kind: 'group', targetId: id, data: {
        version: 1, snapshot: state.snapshot, working: state.working, incoming: state.incoming,
        bindingClaims: group.recoveryClaims?.(), pending: group.recoveryInput?.() ?? state.pending
      } } })
    }
    const dialog = this.dialog
    if (dialog?.local.composing) captured.push({ owner: dialog.id })
    else if (dialog) {
      const pending = this.sourceWrites.get(dialog.id)?.input
      if (dialog.recovery || pending) {
        const targetId = dialog.kind === 'host' ? dialog.opening.host.documentId : dialog.binding.scope.owner.groupId
        const { captureAnchors, ...text } = dialog.recovery ?? {}
        const working = dialog.recovery && { ...text, anchors: captureAnchors?.() }
        const data = { version: 1, sourceKind: dialog.kind, working, pending }
        if (dialog.kind === 'host') {
          const { workingBefore, ...host } = dialog.opening.host
          captured.push({ owner: dialog.id, draft: { kind: 'source', targetId,
            data: recoveryDocumentHash(workingBefore).then(hostHash => ({ ...data, base: { host, hostHash } })) } })
        } else {
          const base = { snapshot: dialog.baseline.snapshot, working: dialog.baseline.working, instanceId: dialog.binding.scope.instanceId }
          captured.push({ owner: dialog.id, draft: { kind: 'source', targetId, data: { ...data, base } } })
        }
      }
    }
    return captured
  }

  journalClose(requestId: string) {
    const canJournal = () => this.ownsClose(requestId) && this.closeReady() && !this.rpc.size
      && !hasCanonicalInlineAsyncEdits() && !this.host?.isComposing?.() && !this.dialog?.local.applying && !this.dialog?.local.importing
    return this.recovery.close(requestId, canJournal)
  }

  hasComposition() {
    return Boolean(this.host?.isComposing?.() || this.dialog?.local.composing
      || [...this.groups].some(id => this.workspace.getGroup(id)?.getSnapshot().composingInstanceIds.length))
  }

  async readRecoveryOperation(workspace: EditorRecoveryWorkspace, documentId: string, operationId: string) {
    if (this.isLocked() || !isSyncedUuid(operationId)) return 'unavailable' as const
    const live = await window.knowbook.getEditorRecoveryWorkspace()
    if (this.isLocked() || live.workspaceScope !== workspace.workspaceScope || live.recoveryEpoch !== workspace.recoveryEpoch) return 'unavailable' as const
    const opened = await this.open({ kind: 'host', hostDocumentId: documentId })
    if (!opened || this.isLocked() || opened.session.workspaceScope !== workspace.workspaceScope
      || opened.session.recoveryEpoch !== workspace.recoveryEpoch) return 'unavailable' as const
    return (await this.invoke('getSyncedOperation', { clientOperationId: operationId })).status
  }

  async recoverDraft(record: EditorRecoveryDraft) {
    const payload = readRecoveryPayload(record), host = this.host, attention = this.attention
    const current = () => this.host !== null && this.attention === attention && !this.isLocked() && !this.invalid && !this.dialog
      && !this.history.isBusy() && !this.commands.pending() && !this.hasComposition() && !hasCanonicalInlineAsyncEdits()
    if (!host || !payload || !isDirectlyRecoverable(record, payload) || !current()) return false
    const workspaceMatches = (live: EditorRecoveryWorkspace) => live.workspaceScope === record.workspace.workspaceScope
      && live.recoveryEpoch === record.workspace.recoveryEpoch
    if (!workspaceMatches(await window.knowbook.getEditorRecoveryWorkspace()) || !current()) return false
    const stillRetained = async () => {
      const row = await window.knowbook.readEditorRecoveryDraft(record.recordId)
      return current() && row?.generation === record.generation && row.hash === record.hash && workspaceMatches(row.workspace)
        && workspaceMatches(await window.knowbook.getEditorRecoveryWorkspace()) && current()
    }

    if (record.kind === 'document' || payload.sourceKind === 'host') {
      const document = record.kind === 'document' ? readRecoveryHost(payload.host) : null
      const original = document ?? readRecoveryHostAddress(payload.base?.host)
      const { documentId, expectedPersistedUpdatedAt } = original
      if (documentId !== record.targetId || !host.navigateDocument || !await host.navigateDocument(documentId, current)) return false
      const opening = await this.waitForRecoveryTarget(documentId, current, () => this.sourceCurrent())
      if (!opening || opening.host.expectedPersistedUpdatedAt !== expectedPersistedUpdatedAt) return false
      const opened = await this.open({ kind: 'host', hostDocumentId: documentId })
      const persisted = await window.knowbook.getDocumentDetail(documentId)
      if (!opened || !workspaceMatches(opened.session) || !persisted || persisted.updatedAt !== expectedPersistedUpdatedAt
        || !sameRecoveryDocument(opening.host.workingBefore, persisted)) return false
      const base = document ? payload.persisted : payload.base?.host?.workingBefore
      const hash = document ? payload.persistedHash : payload.base?.hostHash
      const exact = hash ? await recoveryDocumentHash(document ? persisted : opening.host.workingBefore) === hash
        : base && sameRecoveryDocument(base, persisted)
      if (!exact || !await stillRetained()) return false
      const latest = this.sourceCurrent()
      if (latest?.hostSession !== opening.hostSession || latest.editSequence !== opening.editSequence
        || latest.host.expectedPersistedUpdatedAt !== expectedPersistedUpdatedAt || host.canStartStructure?.() === false) return false
      if (document) return host.stageRecovery?.(document.workingBefore) ?? false
      const { source, start, end, anchors } = readRecoverySource(payload.working)
      const baseDraft = createSyncedHostSourceDraft(latest.host)
      const draft = restoreHostRecoverySource(baseDraft, source, anchors)
      this.dialog = { ...this.sourceState(), kind: 'host', opening: latest, opener: null, operationId: crypto.randomUUID(),
        initialRecovery: { base: baseDraft, draft, start, end } }
      this.emit()
      return true
    }

    const baseline = validateSyncedGroupSnapshot(record.kind === 'group' ? payload.snapshot : payload.base?.snapshot)
    const instance = record.kind === 'source' ? baseline.instances.find(item => item.instanceId === payload.base?.instanceId)
      : baseline.instances.find(item => item.hostDocumentId === host.selectedHostId()) ?? baseline.instances[0]
    if (!instance || baseline.groupId !== record.targetId || !await host.navigateHost(instance.hostDocumentId, instance.instanceId, current)) return false
    const key = JSON.stringify([instance.hostDocumentId, instance.instanceId])
    const binding = await this.waitForRecoveryTarget(instance.hostDocumentId, current, () => this.mounts.get(key)?.binding)
    if (!binding?.isCurrent() || binding.scope.bindingVersion !== instance.bindingVersion) return false
    const opened = await this.open({ kind: 'instance', hostDocumentId: instance.hostDocumentId, instanceId: instance.instanceId, groupId: baseline.groupId })
    if (!opened?.snapshot || !workspaceMatches(opened.session) || !this.matchesRecoveryGroup(baseline, opened.snapshot) || !await stillRetained()) return false
    const state = binding.getCurrent()
    if (!binding.isCurrent() || !clean(state) || !this.matchesRecoveryGroup(baseline, state.snapshot)) return false
    if (record.kind === 'group') {
      const working = validateSyncedCanonicalEdit(payload.working), recorded = payload.bindingClaims
      const claims = recorded === 'legacy' || recorded === undefined && !baseline.bindings.length ? unchangedRecoveryBindings(baseline, working) : recorded
      if (!claims || claims.some(claim => claim.kind === 'copy' && claim.source.kind === 'ticket')) return false
      return binding.apply({ blocks: working, expectedEditSequence: state.editSequence, guards: syncedSnapshotGuard(state.snapshot),
        bindingClaims: claims, bookmark: null, transactionId: crypto.randomUUID() })
    }
    if (payload.sourceKind !== 'canonical' || !payload.base?.working || !areDocumentDraftBlocksEqual(payload.base.working, state.working)) return false
    const { source, start, end, anchors } = readRecoverySource(payload.working)
    const base = createCanonicalSourceDraft(state.working), draft = restoreRecoveryAnchors(base, source, anchors)
    this.dialog = { ...this.sourceState(), kind: 'canonical', binding, opener: null, baseline: state,
      initialRecovery: { base, draft, start, end } }
    this.emit()
    return true
  }

  private matchesRecoveryGroup(expected: SyncedGroupSnapshot, actual: SyncedGroupSnapshot) {
    return expected.groupId === actual.groupId && expected.creationId === actual.creationId && expected.createdAt === actual.createdAt
      && expected.revision === actual.revision && expected.topologyRevision === actual.topologyRevision
  }

  private async waitForRecoveryTarget<T>(documentId: string, current: () => boolean, read: () => T | null | undefined) {
    const deadline = performance.now() + 5000
    while (current()) {
      if (this.host?.selectedHostId() === documentId && this.host.isReady?.()) {
        const result = read()
        if (result) return result
      }
      if (performance.now() >= deadline) return null
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return null
  }
  private adoptStructure(before: SyncedHostSourceCurrent, result: SyncedStructureApplied) {
    const accepted = this.host?.adopt(before, result) ?? false
    if (accepted) this.history.remember(before, result)
    return accepted
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
    if (this.host?.isReady?.() !== true || this.openingBindings.size) return false
    if (!this.host.requiresHostSurface?.()) return true
    const current = this.sourceCurrent()
    return Boolean(current && [...this.surfaces.values()].some(surface => surface.hostSession === current.hostSession
      && surface.expectedInstances.every(instanceId => {
        const original = this.mounts.get(JSON.stringify([current.host.documentId, instanceId]))
        return original?.mount.hostSession === current.hostSession && original.mount.isCurrent()
      })))
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
    if (!this.watchers.has(mount.groupId)) { this.watchers.add(mount.groupId); group.subscribe(() => { this.scheduleGroupSave(mount.groupId, group); this.emit() }) }
    return { address, binding, group }
  }
  private scheduleGroupSave(id: string, group: SyncedGroupController) {
    const previous = this.saveTimers.get(id)
    if (previous) clearTimeout(previous)
    this.saveTimers.delete(id)
    const state = group.getSnapshot()
    if (this.isLocked() || this.invalid || !state.dirty || state.pending || state.composingInstanceIds.length
      || state.incoming || state.failure || state.error) return
    this.saveTimers.set(id, setTimeout(() => {
      this.saveTimers.delete(id)
      if (this.isLocked() || this.invalid) return
      void group.flush().then(saved => { if (!saved) this.emit() }).catch(error => { this.report(String(error)); this.emit() })
    }, 800))
  }
  unbind(opening: InlineOpening) {
    const key = JSON.stringify([opening.address.hostDocumentId, opening.address.instanceId])
    if (this.mounts.get(key)?.binding === opening.binding) this.mounts.delete(key)
    opening.binding.dispose()
  }
  hostSavePending(hostSession: object) { return this.hostWrites.has(hostSession) }
  pending() {
    if (this.history.pending() || this.history.isBusy() || this.commands.pending()) return true
    if (hasCanonicalInlineAsyncEdits()) return true
    if (this.sourceWrites.size) return true
    if (this.dialog && Object.values(this.dialog.local).some(Boolean)) return true
    return [...this.groups].some(id => { const group = this.workspace.getGroup(id); return Boolean(group && !clean(group.getSnapshot())) })
  }
  async flush(options: CanonicalInlineFlushOptions = {}) {
    const current = () => options.shouldContinue?.() !== false && (options.purpose !== 'document-navigation' || !this.isLocked())
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
    if (!await flushSyncedWorkspacePendingChanges(this.workspace, { shouldContinue: current })) return false
    const calls = [...this.rpc]
    if (calls.length) {
      const results = await Promise.allSettled(calls)
      if (results.some(result => result.status === 'rejected')) return false
    }
    return current() && (!this.dialog || !Object.values(this.dialog.local).some(Boolean))
      && await flushSyncedWorkspacePendingChanges(this.workspace, { shouldContinue: current })
  }
  private sourceState(): SourceState {
    const id = Object.freeze({})
    return { id, local: blankSource, recovery: null, reportRecovery: snapshot => {
      if (this.dialog?.id !== id) return
      this.dialog.recovery = snapshot
      if (!this.locked) this.recovery.schedule()
    }, report: state => {
      if (this.dialog?.id !== id || same(this.dialog.local, state)) return
      this.dialog.local = Object.freeze({ ...state }); this.emit()
    }, close: () => { if (this.dialog?.id === id) {
      if (this.sourceWrites.has(id)) { this.notify('原源码操作回执尚未确认，请重试应用以核对。', 'Retry Apply to settle the original source operation.'); return }
      this.dialog = null; this.emit() } } }
  }
  openCanonicalSource(binding: SyncedGroupBinding, opener: HTMLElement | null) {
    if (this.isLocked() || this.dialog || this.history.isBusy() || this.commands.pending() || !binding.isCurrent()) return false
    this.dialog = { ...this.sourceState(), kind: 'canonical', binding, opener, baseline: binding.getCurrent() }; this.emit(); return true
  }
  async openHostSource(opener: HTMLElement | null) {
    if (this.isLocked() || this.dialog || this.history.isBusy() || this.commands.pending() || !await this.host?.flushHost()) return false
    const opening = this.host?.getCurrent()
    if (!opening || !await this.open({ kind: 'host', hostDocumentId: opening.host.documentId })) return false
    if (this.host?.getCurrent()?.hostSession !== opening.hostSession || this.dialog || this.isLocked()) return false
    this.dialog = { ...this.sourceState(), kind: 'host', opening, opener, operationId: crypto.randomUUID() }; this.emit(); return true
  }
  sourceCurrent = () => this.host?.getCurrent() ?? null
  sourceIsCurrent(dialog: InlineDialog) { return !this.invalid && this.dialog?.id === dialog.id
    && (dialog.kind !== 'host' || this.sourceCurrent()?.hostSession === dialog.opening.hostSession) }
  private async structureGuards(hostDocumentId: string, groupIds: readonly string[]) {
    const persisted = this.host?.getPersisted()
    if (!persisted || persisted.id !== hostDocumentId) return null
    const pGroups = persisted.blocks.filter(block => block.type === 'synced-block').map(block => parseSyncedBlockPayload(block.content).groupId)
    const snapshots = await this.invoke('getSyncedGroupSnapshots', { groupIds: [...new Set([...groupIds, ...pGroups])] })
    if (snapshots.workspaceScope !== this.session?.workspaceScope || snapshots.items.some(item => item.status !== 'ready')) return null
    const ready = snapshots.items.flatMap(item => item.status === 'ready' ? [item.snapshot] : [])
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
  async saveHostWorking(before: SyncedHostSourceCurrent): Promise<{ result: SyncedStructureApplied; submitted: SyncedHostSourceCurrent }> {
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
      const guards = await this.structureGuards(dialog.opening.host.documentId, [...groupIds])
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
  async resolveHeading(documentId: string, anchor: string, matchText: boolean, shouldContinue: () => boolean) {
    if (this.isLocked() || !shouldContinue() || !await this.host?.flushHost()) return null
    const saved = this.host?.getPersisted()
    if (!shouldContinue() || saved?.id !== documentId) return null
    return window.knowbook.resolveSyncedHeadingAnchor({ documentId, expectedUpdatedAt: saved.updatedAt, anchor, matchText })
  }
  private openHeading(...[target, blocks, callbacks, clear]: Parameters<CanonicalHeadingAction>) {
    if (!target.anchor || !blocks.some(block => block.type === 'synced-block')) return
    let current = true
    const isCurrent = () => current
    const missing = () => { if (current) { callbacks.onPendingTargetMissing(); clear() } }
    void this.resolveHeading(target.documentId, target.anchor, target.wiki ?? false, isCurrent).then(async result => {
      if (!current) return
      if (result?.status !== 'ready') return missing()
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
    }).catch(missing)
    return () => { current = false }
  }
  cancelNavigation = () => { this.attention++; this.navigation?.finish(false) }
  navigationFor(hostId: string, instanceId: string) { const request = this.navigation
    return request?.occurrence.hostDocumentId === hostId && request.occurrence.instanceId === instanceId ? request : null }
  freeze(requestId: string) {
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.saveTimers.clear()
    this.recovery.pause()
    this.requestId = requestId; this.locked = true; this.navigation?.finish(false); this.emit()
  }
  cancelFreeze(requestId: string) {
    if (this.requestId !== requestId) return
    this.requestId = null; this.locked = false; this.releaseDeferred()
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
export function getCanonicalInlineRuntime() { return instance ??= new InlineRuntime() }
export type CanonicalInlineRuntime = InlineRuntime
