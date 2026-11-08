import type { SyncedGroupListResult, SyncedStructureApplied, SyncedStructureInput, SyncedOperationResult,
  SyncedGroupGuard, SyncedInstanceGuard, SyncedPlacement } from '@shared/synced-blocks'
import type { SyncedEditingHostResult } from '@shared/synced-editing-session'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { syncedCreateSelection, syncedInsertionAfter } from './structureIntent'
import { type SyncedGroupBinding, syncedScopeInstanceGuard, syncedSnapshotGuard } from './types'

type Guards = { groups: SyncedGroupGuard[]; expectedInstances: SyncedInstanceGuard[] }
type Item = SyncedGroupListResult['items'][number]
export interface StructureCommandPort {
  current: () => SyncedHostSourceCurrent | null
  blocked: () => boolean
  openHost: (documentId: string) => Promise<boolean>
  list: (input: { query: string; offset: number; limit: number }) => Promise<SyncedGroupListResult>
  guards: (documentId: string, extraGroupIds: readonly string[]) => Promise<Guards | null>
  flushGroups: (current: () => boolean) => Promise<boolean>
  apply: (input: SyncedStructureInput) => Promise<SyncedEditingHostResult>
  operation: (operationId: string) => Promise<SyncedOperationResult>
  adopt: (before: SyncedHostSourceCurrent, result: SyncedStructureApplied) => boolean
  changed: () => void
  notify: (zh: string, en: string) => void
  isZh: () => boolean
}
export interface StructureCommandView {
  id: object; kind: 'create' | 'insert' | 'detach'; documentId: string; blockCount: number; opener: HTMLElement | null
  busy: boolean; loading: boolean; error: string; uncertain: boolean; hasRequest: boolean
  query: string; offset: number; total: number; items: readonly Item[]; selectedGroupId: string | null
  canReturnFocus: () => boolean
}
type Opening = { before: SyncedHostSourceCurrent; view: StructureCommandView; operationId: string; instanceId: string;
  action: { kind: 'create'; rootIds: string[]; groupId: string } | { kind: 'insert'; target: SyncedPlacement }
    | { kind: 'detach'; binding: SyncedGroupBinding };
  input: SyncedStructureInput | null; listing: number; shouldContinue: () => boolean }

/** Renderer intentions only. The enclosing runtime supplies its genuine opaque
 * Main session; no UI DTO, group preview, or ACK is promoted into a Main fence. */
export class SyncedStructureCommands {
  private opening: Opening | null = null
  constructor(private readonly port: StructureCommandPort) {}
  getSnapshot = (): Readonly<StructureCommandView> | null => this.opening?.view ?? null
  pending = () => this.opening !== null
  recoveryInput = () => this.opening?.input ?? null
  private update(opening: Opening, changes: Partial<StructureCommandView>) {
    if (this.opening !== opening) return
    opening.view = Object.freeze({ ...opening.view, ...changes }); this.port.changed()
  }
  private current(opening: Opening) {
    const actual = this.port.current(), before = opening.before
    return this.opening === opening && opening.shouldContinue() && !this.port.blocked() && actual?.hostSession === before.hostSession
      && actual.editSequence === before.editSequence && actual.host.documentId === before.host.documentId
      && actual.host.expectedPersistedUpdatedAt === before.host.expectedPersistedUpdatedAt
      && actual.host.workingBefore.title === before.host.workingBefore.title && actual.host.workingBefore.summary === before.host.workingBefore.summary
      && areDocumentDraftBlocksEqual(actual.host.workingBefore.blocks, before.host.workingBefore.blocks)
  }
  async openCreate(ids: readonly string[], shouldContinue: () => boolean, opener: HTMLElement | null): Promise<boolean> {
    if (this.opening || !shouldContinue()) return false
    if (this.port.blocked()) { this.port.notify('请先完成当前保存、附件插入或输入组合，再创建同步块。', 'Finish the current save, attachment insertion, or composition before creating a synced block.'); return false }
    const before = this.port.current(); if (!before) return false
    const selection = syncedCreateSelection(before.host.workingBefore.blocks, ids)
    if (!selection.ok) {
      this.port.notify(selection.reason === 'nested-sync' ? '选区内已有同步引用，不能再嵌套创建。' : '请选择连续同级的完整内容块；子块会一起纳入。',
        selection.reason === 'nested-sync' ? 'An existing synced reference cannot be nested inside a new group.' : 'Select consecutive sibling blocks; their complete children are included.')
      return false
    }
    const opening = await this.begin(before, { kind: 'create', rootIds: selection.rootIds, groupId: crypto.randomUUID() }, selection.blockCount, shouldContinue, opener)
    return this.getSnapshot()?.id === opening.view.id && !opening.view.error
  }
  async openInsert(anchorId: string | null, shouldContinue: () => boolean, opener: HTMLElement | null): Promise<boolean> {
    if (this.opening || !shouldContinue()) return false
    if (this.port.blocked()) { this.port.notify('请先完成当前保存、附件插入或输入组合，再插入同步块。', 'Finish the current save, attachment insertion, or composition before inserting a synced block.'); return false }
    const before = this.port.current(); if (!before) return false
    const target = syncedInsertionAfter(before.host.documentId, before.host.workingBefore.blocks, anchorId); if (!target) return false
    const opening = await this.begin(before, { kind: 'insert', target }, 0, shouldContinue, opener)
    return this.getSnapshot()?.id === opening.view.id && !opening.view.error
  }
  async openDetach(binding: SyncedGroupBinding, opener: HTMLElement | null): Promise<boolean> {
    if (this.opening || !binding.isCurrent()) return false
    if (this.port.blocked()) { this.port.notify('请先完成当前保存、附件插入或输入组合，再解除同步。', 'Finish the current save, attachment insertion, or composition before unsyncing this reference.'); return false }
    const before = this.port.current(), scope = binding.scope
    if (!before || before.hostSession !== scope.hostSession || before.host.documentId !== scope.hostDocumentId) return false
    const opening = await this.begin(before, { kind: 'detach', binding }, 0, scope.isCurrent, opener)
    return this.getSnapshot()?.id === opening.view.id && !opening.view.error
  }
  private async begin(before: SyncedHostSourceCurrent, action: Opening['action'], blockCount: number, shouldContinue: () => boolean, opener: HTMLElement | null): Promise<Opening> {
    const opening: Opening = { before: { ...before, host: structuredClone(before.host) }, action,
      operationId: crypto.randomUUID(), instanceId: crypto.randomUUID(), input: null, listing: 0, shouldContinue,
      view: Object.freeze({ id: Object.freeze({}), kind: action.kind, documentId: before.host.documentId, blockCount, opener,
        busy: false, loading: true, error: '', uncertain: false, hasRequest: false, query: '', offset: 0, total: 0, items: [], selectedGroupId: null,
        canReturnFocus: () => !this.port.blocked() && this.port.current()?.hostSession === before.hostSession
          && this.port.current()?.host.documentId === before.host.documentId }) }
    this.opening = opening; this.port.changed()
    await this.load(opening, '', 0)
    return opening
  }
  private async load(opening: Opening, query: string, offset: number) {
    const serial = ++opening.listing
    this.update(opening, { query, offset, loading: true, error: '', selectedGroupId: null, items: [] })
    try {
      if (!await this.port.openHost(opening.before.host.documentId) || !this.current(opening)) throw new Error('The original host or complete working body changed; cancel and reopen.')
      if (opening.action.kind !== 'insert') { this.update(opening, { loading: false }); return }
      const result = await this.port.list({ query, offset, limit: 20 })
      if (serial !== opening.listing || this.opening !== opening) return
      if (!this.current(opening)) { this.update(opening, { loading: false, error: this.port.isZh() ? '原宿主或完整草稿已变化，请取消后重新打开。' : 'The original host or complete draft changed. Cancel and reopen.' }); return }
      if (new Set(result.items.map(item => item.groupId)).size !== result.items.length) throw new Error('The actual group list contains ambiguous identities.')
      this.update(opening, { items: Object.freeze(result.items.map(item => Object.freeze({ ...item }))), total: result.total, loading: false })
    } catch (error) {
      if (this.opening === opening && serial === opening.listing) this.update(opening, { loading: false, error: String(error) })
    }
  }
  query(query: string, offset = 0) {
    const opening = this.opening
    if (!opening || opening.action.kind !== 'insert' || opening.view.busy || opening.input || offset < 0 || !Number.isSafeInteger(offset)) return
    void this.load(opening, query, offset)
  }
  choose(groupId: string) {
    const opening = this.opening
    if (!opening || opening.action.kind !== 'insert' || opening.view.loading || opening.view.busy || opening.input
      || !opening.view.items.some(item => item.groupId === groupId)) return false
    this.update(opening, { selectedGroupId: groupId, error: '' }); return true
  }
  cancel() {
    const opening = this.opening
    if (!opening || opening.view.busy || opening.view.uncertain) return false
    opening.listing++; this.opening = null; this.port.changed(); return true
  }
  async apply(): Promise<boolean> {
    const opening = this.opening
    if (!opening || opening.view.busy || opening.view.loading) return false
    if (!this.current(opening)) { this.update(opening, { error: this.port.isZh() ? '原宿主、选区或完整草稿已变化，当前草稿已保留。' : 'The original host, selection, or complete draft changed; the current draft is retained.' }); return false }
    if (opening.action.kind === 'insert' && !opening.input && !opening.view.selectedGroupId) return false
    const recoveringOriginal = opening.input !== null
    this.update(opening, { busy: true, error: '' })
    try {
      if (!opening.input) {
        const action = opening.action, shouldContinue = () => this.current(opening)
        const flushed = action.kind === 'detach' ? await action.binding.flush({ shouldContinue }) : await this.port.flushGroups(shouldContinue)
        if (!flushed || !shouldContinue()) {
          this.update(opening, { error: this.port.isZh() ? '共享正文保存尚未完成，请先处理原草稿。' : 'The shared body has not finished saving. Resolve its original draft first.' }); return false
        }
        const groupId = action.kind === 'insert' ? opening.view.selectedGroupId : null
        const guards = await this.port.guards(opening.before.host.documentId, groupId ? [groupId] : [])
        if (!guards || !shouldContinue()) throw new Error('The original host/group guards changed; the complete draft is retained.')
        if (action.kind === 'detach' && !this.matchesDetachGuards(action.binding, guards)) {
          this.update(opening, { error: this.port.isZh() ? '原引用或共享正文版本已变化，请取消后核对。' : 'The original reference or shared body version changed. Cancel and review it.' }); return false
        }
        opening.input = { clientOperationId: opening.operationId, mode: 'command', hostsWorkingBefore: [structuredClone(opening.before.host)], ...guards,
          action: action.kind === 'create' ? { kind: 'create', documentId: opening.before.host.documentId,
            selectedRootIds: [...action.rootIds], groupId: action.groupId, instanceId: opening.instanceId }
            : action.kind === 'insert' ? { kind: 'insert', groupId: groupId!, instanceId: opening.instanceId, target: { ...action.target } }
            : { kind: 'detach', groupId: action.binding.scope.owner.groupId, instanceId: action.binding.scope.instanceId } }
        this.update(opening, { hasRequest: true })
      }
      const input = opening.input
      let result: SyncedEditingHostResult | undefined
      if (recoveringOriginal) {
        const observed = await this.port.operation(input.clientOperationId)
        if (observed.status === 'committed' && 'hosts' in observed.result) result = observed.result
        else if (observed.status !== 'unknown') throw new Error('The original receipt is not a host structure operation')
      }
      if (!result) {
        try { result = await this.port.apply(input) }
        catch (error) {
          this.update(opening, { uncertain: true })
          const observed = await this.port.operation(input.clientOperationId)
          if (observed.status !== 'committed' || !('hosts' in observed.result)) throw error
          result = observed.result
        }
      }
      if (result.status !== 'applied') {
        this.update(opening, { uncertain: false, error: this.port.isZh()
          ? result.status === 'unsupported' ? '当前选区、标题或正文结构暂不支持此操作，完整草稿已保留。' : '原结构操作未应用，完整草稿已保留，请取消后核对原正文。'
          : result.status === 'unsupported' ? 'This selection, heading, or working structure is not supported; the complete draft is retained.'
            : 'The original structure command was not applied; the complete draft is retained. Cancel and check the original body.' })
        return false
      }
      const host = result.hosts[0], before = opening.before
      if (result.operationId !== input.clientOperationId || result.hosts.length !== 1 || host?.documentId !== before.host.documentId
        || host.after.id !== before.host.documentId || host.logicalBefore.title !== before.host.workingBefore.title
        || host.logicalBefore.summary !== before.host.workingBefore.summary
        || !areDocumentDraftBlocksEqual(host.logicalBefore.blocks, before.host.workingBefore.blocks)
        || !this.current(opening) || !this.port.adopt(before, result)) {
        this.update(opening, { uncertain: true, error: 'Main returned an operation, but its original host/W acknowledgement could not be adopted. The full draft is retained; retry the same operation.' })
        return false
      }
      // Only the actual atomic host ACK is adopted. Main owns the structure
      // journal/history token; no ordinary updateDocument or local undo snapshot.
      this.opening = null; this.port.changed(); return true
    } catch (error) { this.update(opening, { error: String(error) }); return false }
    finally { this.update(opening, { busy: false }) }
  }

  private matchesDetachGuards(binding: SyncedGroupBinding, guards: Guards) {
    const state = binding.getCurrent(), instance = syncedScopeInstanceGuard(binding.scope), group = syncedSnapshotGuard(state.snapshot)
    return binding.isCurrent() && state.phase === 'clean' && !state.pending && !state.composingInstanceIds.length
      && guards.expectedInstances.some(guard => guard.hostDocumentId === instance.hostDocumentId
        && guard.instanceId === instance.instanceId && guard.bindingVersion === instance.bindingVersion)
      && guards.groups.some(guard => guard.groupId === group.groupId && guard.expectedRevision === group.expectedRevision
        && guard.expectedTopologyRevision === group.expectedTopologyRevision)
  }
}
