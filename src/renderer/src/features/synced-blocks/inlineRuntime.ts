import type { DocumentDetail } from '@shared/contracts'
import type { SyncedGroupBinding, SyncedGroupController } from './types'
import type { SyncedBlocksApi as MainSyncedApi, SyncedStructureApplied, SyncedStructureInput } from '@shared/synced-blocks'
import type { SyncedEditingMethod, SyncedEditingMethods, SyncedEditingRequest, SyncedEditingSession } from '@shared/synced-editing-session'
import type { SyncedInlineInstanceAddress, WorkspaceSearchOccurrence } from '@shared/workspace-search-occurrence'
import { isSameWorkspaceSearchOccurrence } from '@shared/workspace-search-occurrence'
import { parseSyncedBlockPayload } from '@shared/syncedBlockValidation'
import { getSyncedWorkspaceController, flushSyncedWorkspacePendingChanges } from './controller'
import type { SyncedReadSourcesPort } from './sourceReadOwner'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import type { PreparedSyncedHostSource } from './hostSource'
import type { MarkdownSourceLocalState } from '../../components/DocumentMarkdownSourceDialog'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { installCanonicalInlineTransitions, hasCanonicalInlineAsyncEdits, signalCanonicalInlineUnlock } from './inlineBridge'

export interface InlineHostPort {
  getCurrent: () => SyncedHostSourceCurrent | null
  getPersisted: () => DocumentDetail | null
  adopt: (before: SyncedHostSourceCurrent, result: SyncedStructureApplied) => boolean
  applyOrdinarySource?: (before: SyncedHostSourceCurrent, after: PreparedSyncedHostSource['finalAfter'][number]) => boolean
  flushHost: () => Promise<boolean>
  navigateHost: (documentId: string, instanceId: string, shouldContinue: () => boolean) => Promise<boolean>
  notify: (message: string) => void
  isReady?: () => boolean
  requiresHostSurface?: () => boolean
  isZh: boolean
  selectedHostId: () => string | null
}
export interface InlineMount {
  hostDocumentId: string; hostSession: object; instanceId: string; groupId: string; parentBlockId: string | null; depth: number
  mountEpoch: object; root: () => HTMLElement | null; isCurrent: () => boolean
}
export interface InlineOpening { address: SyncedInlineInstanceAddress; binding: SyncedGroupBinding; group: SyncedGroupController }
type SourceState = { id: object; local: Readonly<MarkdownSourceLocalState>; report: (state: Readonly<MarkdownSourceLocalState>) => void; close: () => void }
export type InlineDialog = ({ kind: 'canonical'; binding: SyncedGroupBinding; opener: HTMLElement | null }
  | { kind: 'host'; opening: SyncedHostSourceCurrent; opener: HTMLElement | null; operationId: string }) & SourceState
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
  private sourceWrites = new Map<object, SyncedStructureInput>()
  private listeners = new Set<() => void>()
  private idle = new Set<() => void>()
  private revision = 0
  private locked = false
  private requestId: string | null = null
  private deferred = new Set<() => void>()
  private dialog: InlineDialog | null = null
  private navigation: InlineNavigation | null = null
  private ui: Readonly<{ revision: number; locked: boolean; dialog: InlineDialog | null; navigation: InlineNavigation | null }> = Object.freeze({ revision: 0, locked: false, dialog: null as InlineDialog | null, navigation: null as InlineNavigation | null })
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
        if (this.locked) this.deferred.add(send); else send()
      })
    }
    const readSources: SyncedReadSourcesPort = {
      captureBaseline: input => invoke('captureBaseline', input), operation: input => invoke('ownedOperation', input),
      validate: input => invoke('validateOwner', input), release: input => invoke('releaseOwner', input)
    }
    this.workspace = getSyncedWorkspaceController(this.port, { readSources })
    window.knowbook.onWorkspaceMutated(() => {
      const refresh = () => { if (this.session && !this.invalid && this.groups.size) void this.workspace.load([...this.groups]).catch(() => this.emit()) }
      if (this.locked) this.deferred.add(refresh); else refresh()
    })
    installCanonicalInlineTransitions(this, { flush: options => this.flush(options), pending: () => this.pending(), hostPending: () => this.hostWrites.size > 0, navigate: () => this.host?.flushHost() ?? this.flush(), locked: () => this.locked,
      notifyBlocked: () => this.notify('请先完成共享正文或源码的保存。', 'Finish saving the shared body or source first.') })
  }
  configure(host: InlineHostPort) { this.host = host }
  getSnapshot = () => this.ui
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit() {
    this.ui = Object.freeze({ revision: ++this.revision, locked: this.locked, dialog: this.dialog, navigation: this.navigation })
    for (const listener of [...this.listeners, ...this.idle]) { try { listener() } catch (error) { console.error('Synced view observer failed', error) } }
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
    if (!mount.isCurrent() || this.locked) return null
    let opened = await this.open({ kind: 'instance', hostDocumentId: mount.hostDocumentId, instanceId: mount.instanceId, groupId: mount.groupId })
    if (opened?.instance && (opened.instance.parentBlockId !== mount.parentBlockId || opened.instance.depth !== mount.depth)) {
      // A W-only relocation is an intention, not the persisted instance fence.
      // Save its complete host first, then reopen the actual new binding.
      if (!mount.isCurrent() || !await this.host?.flushHost()) return null
      opened = await this.open({ kind: 'instance', hostDocumentId: mount.hostDocumentId, instanceId: mount.instanceId, groupId: mount.groupId })
    }
    if (!opened || !mount.isCurrent() || this.locked) return null
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
    if (!mount.isCurrent() || this.locked || this.invalid) return null
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
    if (this.locked || this.invalid || !state.dirty || state.pending || state.composingInstanceIds.length
      || state.incoming || state.failure || state.error) return
    this.saveTimers.set(id, setTimeout(() => {
      this.saveTimers.delete(id)
      if (this.locked || this.invalid) return
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
    if (hasCanonicalInlineAsyncEdits()) return true
    if (this.sourceWrites.size) return true
    if (this.dialog && Object.values(this.dialog.local).some(Boolean)) return true
    return [...this.groups].some(id => { const group = this.workspace.getGroup(id); return Boolean(group && !clean(group.getSnapshot())) })
  }
  async flush(options: { shouldContinue?: () => boolean } = {}) {
    const current = () => options.shouldContinue?.() !== false
    if (!current()) return false
    if (hasCanonicalInlineAsyncEdits()) { this.notify('请等待当前附件插入完成。', 'Wait for the original attachment insertion to finish.'); return false }
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
    return { id, local: blankSource, report: state => {
      if (this.dialog?.id !== id || same(this.dialog.local, state)) return
      this.dialog.local = Object.freeze({ ...state }); this.emit()
    }, close: () => { if (this.dialog?.id === id) {
      if (this.sourceWrites.has(id)) { this.notify('原源码操作回执尚未确认，请重试应用以核对。', 'Retry Apply to settle the original source operation.'); return }
      this.dialog = null; this.emit() } } }
  }
  openCanonicalSource(binding: SyncedGroupBinding, opener: HTMLElement | null) {
    if (this.locked || this.dialog || !binding.isCurrent()) return false
    this.dialog = { ...this.sourceState(), kind: 'canonical', binding, opener }; this.emit(); return true
  }
  async openHostSource(opener: HTMLElement | null) {
    if (this.locked || this.dialog || !await this.host?.flushHost()) return false
    const opening = this.host?.getCurrent()
    if (!opening || !await this.open({ kind: 'host', hostDocumentId: opening.host.documentId })) return false
    if (this.host?.getCurrent()?.hostSession !== opening.hostSession || this.dialog || this.locked) return false
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
  async saveHostWorking(before: SyncedHostSourceCurrent): Promise<{ result: SyncedStructureApplied; submitted: SyncedHostSourceCurrent }> {
    let write = this.hostWrites.get(before.hostSession)
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
    let result
    try { result = await this.invoke('applySyncedHostStructure', write.input) }
    catch (error) {
      const known = await this.invoke('getSyncedOperation', { clientOperationId: write.input.clientOperationId })
      if (known.status !== 'committed' || !('hosts' in known.result)) throw error
      result = known.result
    }
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
    const before = prepared.hostsWorkingBefore[0], original = dialog.opening.host
    if (this.locked || !this.sourceIsCurrent(dialog) || prepared.hostsWorkingBefore.length !== 1 || !before
      || before.documentId !== original.documentId || before.expectedPersistedUpdatedAt !== original.expectedPersistedUpdatedAt
      || before.workingBefore.title !== original.workingBefore.title || before.workingBefore.summary !== original.workingBefore.summary
      || !areDocumentDraftBlocksEqual(before.workingBefore.blocks, original.workingBefore.blocks)) return false
    // Do not ask the Source blocker to flush itself. This is its registered
    // Apply callback, and Main still proves every actual structure guard.
    if (!await flushSyncedWorkspacePendingChanges(this.workspace)) return false
    const ordinary = !this.sourceWrites.has(dialog.id) && !prepared.newRefSources.length && prepared.finalAfter.length === 1
      && !this.host?.getPersisted()?.blocks.some(block => block.type === 'synced-block')
      && ![...prepared.hostsWorkingBefore.flatMap(host => host.workingBefore.blocks), ...prepared.finalAfter.flatMap(host => host.blocks)]
        .some(block => block.type === 'synced-block')
    if (ordinary) return this.host?.applyOrdinarySource?.(dialog.opening, prepared.finalAfter[0]) ?? false
    const groupIds = new Set<string>()
    for (const body of [...prepared.hostsWorkingBefore.map(host => host.workingBefore), ...prepared.finalAfter])
      for (const block of body.blocks) if (block.type === 'synced-block') groupIds.add(parseSyncedBlockPayload(block.content).groupId)
    let input = this.sourceWrites.get(dialog.id)
    if (!input) {
      const guards = await this.structureGuards(dialog.opening.host.documentId, [...groupIds])
      if (!guards || !this.sourceIsCurrent(dialog)) return false
      input = { clientOperationId: dialog.operationId, ...guards, mode: 'host-final', reason: 'source-apply', ...structuredClone(prepared) }
      this.sourceWrites.set(dialog.id, input)
    }
    let result
    try { result = await this.invoke('applySyncedHostStructure', input) }
    catch (error) {
      const known = await this.invoke('getSyncedOperation', { clientOperationId: dialog.operationId })
      if (known.status !== 'committed' || !('hosts' in known.result)) throw error
      result = known.result
    }
    if (result.status !== 'applied' && result.status !== 'noop') { this.sourceWrites.delete(dialog.id); return false }
    if (result.operationId !== dialog.operationId || !this.sourceIsCurrent(dialog)) return false
    const acceptedCandidate = input.mode === 'host-final' && same(input.finalAfter, prepared.finalAfter) && same(input.newRefSources, prepared.newRefSources)
    this.sourceWrites.delete(dialog.id)
    const adopted = this.host?.adopt(dialog.opening, result) ?? false
    // A retry may carry later CM input. Settle the old real ACK without marking
    // those later bytes as accepted or closing that retained Source buffer.
    return acceptedCandidate && adopted
  }
  async openSearch(occurrence: WorkspaceSearchOccurrence, shouldContinue: () => boolean) {
    if (this.locked || !shouldContinue() || !await this.host?.flushHost()) return false
    const exact = await window.knowbook.resolveWorkspaceSearchOccurrence(occurrence)
    if (!shouldContinue() || exact.status !== 'ready' || !isSameWorkspaceSearchOccurrence(exact.occurrence, occurrence)) return false
    this.navigation?.finish(false)
    const attention = this.attention
    let request!: InlineNavigation
    const success = new Promise<boolean>(finish => {
      request = { sequence: ++this.revision, occurrence, committed: false,
        shouldContinue: () => this.navigation === request && !this.locked && !this.invalid && this.attention === attention
          && (request.committed ? this.host?.selectedHostId() === occurrence.hostDocumentId : shouldContinue()),
        finish: value => { if (this.navigation === request) { this.navigation = null; this.emit() }; finish(value) } }
      this.navigation = request; this.emit()
    })
    // Consume the SearchPage continuation through its real navigation commit.
    // Its own route change is then replaced by our exact-host mount/token guard.
    if (!await this.host?.navigateHost(occurrence.hostDocumentId, occurrence.instanceId, request.shouldContinue)) request.finish(false)
    else if (this.navigation === request && this.attention === attention && !this.locked) { request.committed = true; this.emit() }
    else request.finish(false)
    return success
  }
  cancelNavigation = () => { this.attention++; this.navigation?.finish(false) }
  navigationFor(hostId: string, instanceId: string) { const request = this.navigation
    return request?.occurrence.hostDocumentId === hostId && request.occurrence.instanceId === instanceId ? request : null }
  freeze(requestId: string) {
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.saveTimers.clear()
    this.requestId = requestId; this.locked = true; this.navigation?.finish(false); this.emit()
  }
  cancelFreeze(requestId: string) {
    if (this.requestId !== requestId) return
    this.requestId = null; this.locked = false; signalCanonicalInlineUnlock()
    const pending = [...this.deferred]; this.deferred.clear(); this.emit(); for (const run of pending) run()
    for (const id of this.groups) { const group = this.workspace.getGroup(id); if (group) this.scheduleGroupSave(id, group) }
  }
  ownsClose(requestId: string) { return this.locked && this.requestId === requestId }
  report(message: string) { this.host?.notify(message) }
  isLocked = () => this.locked
}
let instance: InlineRuntime | null = null
export function getCanonicalInlineRuntime() { return instance ??= new InlineRuntime() }
export type CanonicalInlineRuntime = InlineRuntime
