import type { DocumentBlockDraft } from '@shared/contracts'
import type { SyncedGroupListResult, SyncedStructureApplied, SyncedStructureInput, SyncedOperationResult,
  SyncedGroupGuard, SyncedInstanceGuard, SyncedPlacement } from '@shared/synced-blocks'
import type { SyncedEditingHostResult } from '@shared/synced-editing-session'
import { parseSyncedBlockPayload, validateSyncedHostForest } from '@shared/syncedBlockValidation'
import type { CanonicalHostEditOptions } from './inlineBridge'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { syncedCreateSelection, syncedInsertionAfter } from './structureIntent'

type Guards = { groups: SyncedGroupGuard[]; expectedInstances: SyncedInstanceGuard[] }
type Item = SyncedGroupListResult['items'][number]
type HostFinal = Extract<SyncedStructureInput, { mode: 'host-final' }>
type HostEdit = Pick<HostFinal, 'reason' | 'finalAfter' | 'newRefSources'> & Pick<CanonicalHostEditOptions, 'afterBookmark' | 'onAccepted' | 'preserveSameParentDraft'>
  & { kind: 'host-edit' }
export type HostReorderProtection = { current(): boolean; acceptsGuards(guards: Guards): boolean;
  accepts(result: SyncedStructureApplied): boolean; release(): void; groupIdentity?: object }
type DetachTarget = { instance: SyncedInstanceGuard; group: SyncedGroupGuard; canonicalIds: readonly string[]; settled: () => boolean }
export interface StructureCommandPort {
  current: () => SyncedHostSourceCurrent | null
  blocked: () => boolean
  openHost: (documentId: string) => Promise<boolean>
  list: (input: { query: string; offset: number; limit: number }) => Promise<SyncedGroupListResult>
  guards: (documentId: string, extraGroupIds: readonly string[]) => Promise<Guards | null>
  flushGroups: (current: () => boolean) => Promise<boolean>
  apply: (input: SyncedStructureInput) => Promise<SyncedEditingHostResult>
  operation: (operationId: string) => Promise<SyncedOperationResult>
  protectHostEdit: (hostSession: object, operationId: string, current: () => boolean, groupIdentity?: object) => Promise<boolean>
  protectReorder?: (before: SyncedHostSourceCurrent, after: readonly DocumentBlockDraft[]) => HostReorderProtection | null | undefined
  adopt: (before: SyncedHostSourceCurrent, result: SyncedStructureApplied, afterBookmark?: HostEdit['afterBookmark']) => boolean
  changed: () => void
  notify: (zh: string, en: string) => void
  isZh: () => boolean
}
export interface StructureCommandView {
  id: object; kind: 'create' | 'insert' | 'detach' | 'host-edit'; documentId: string; blockCount: number; opener: HTMLElement | null
  busy: boolean; loading: boolean; error: string; uncertain: boolean; hasRequest: boolean
  query: string; offset: number; total: number; items: readonly Item[]; selectedGroupId: string | null
  canReturnFocus: () => boolean
}
type Opening = { before: SyncedHostSourceCurrent; view: StructureCommandView; operationId: string; instanceId: string;
  action: { kind: 'create'; rootIds: string[]; groupId: string } | { kind: 'insert'; target: SyncedPlacement } | { kind: 'detach'; target: DetachTarget } | HostEdit;
  input: SyncedStructureInput | null; receipt: 'idle' | 'protecting' | 'dispatched'; preserveReorder?: true;
  hidden: boolean; listing: number; shouldContinue: () => boolean }

function matchesDetachAck(target: DetachTarget, result: SyncedStructureApplied): boolean {
  const { instanceId } = target.instance, { affectedInstanceIds, blockIdMap } = result
  const blocks = new Map(result.hosts[0].after.blocks.map(block => [block.id, block.type]))
  return Boolean(result.historyToken) && affectedInstanceIds.length === 1 && affectedInstanceIds[0] === instanceId && !blocks.has(instanceId)
    && blockIdMap.length === target.canonicalIds.length && new Set(blockIdMap.map(mapping => mapping.to)).size === blockIdMap.length
    && blockIdMap.every((mapping, index) => mapping.from === target.canonicalIds[index] && blocks.has(mapping.to) && blocks.get(mapping.to) !== 'synced-block')
}

/** Renderer intentions only. The enclosing runtime supplies its genuine opaque
 * Main session; no UI DTO, group preview, or ACK is promoted into a Main fence. */
export class SyncedStructureCommands {
  private opening: Opening | null = null
  constructor(private readonly port: StructureCommandPort) {}
  getSnapshot = (): Readonly<StructureCommandView> | null => this.opening?.hidden ? null : this.opening?.view ?? null
  pending = () => this.opening !== null
  runningHostEdit = () => this.opening?.action.kind === 'host-edit' && (this.opening.hidden || this.opening.view.busy)
  preservingReorder = () => this.opening?.preserveReorder === true
  pendingProtectedEdit(hostSession: object) {
    const opening = this.opening
    return opening?.before.hostSession === hostSession && opening.receipt !== 'idle' ? opening.input : null
  }
  canJournalProtectedEdit(hostSession: object) {
    return this.pendingProtectedEdit(hostSession) !== null && this.opening?.receipt === 'dispatched' && !this.opening.view.busy
  }
  private update(opening: Opening, changes: Partial<StructureCommandView>) {
    if (this.opening !== opening) return
    opening.view = Object.freeze({ ...opening.view, ...changes }); this.port.changed()
  }
  private current(opening: Opening, acknowledgedHostEdit = false) {
    const actual = this.port.current(), before = opening.before
    return this.opening === opening && (acknowledgedHostEdit || opening.shouldContinue()) && !this.port.blocked()
      && actual?.hostSession === before.hostSession
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
  async openDetach(target: DetachTarget, shouldContinue: () => boolean, opener: HTMLElement | null): Promise<boolean> {
    if (this.opening || !shouldContinue() || this.port.blocked() || !target.settled()) return false
    const before = this.port.current()
    if (!before || before.host.documentId !== target.instance.hostDocumentId || !target.canonicalIds.length) return false
    const selected = before.host.workingBefore.blocks.find(block => block.id === target.instance.instanceId)
    if (!selected || selected.type !== 'synced-block' || parseSyncedBlockPayload(selected.content).groupId !== target.group.groupId) return false
    const captured = { ...target, instance: { ...target.instance }, group: { ...target.group }, canonicalIds: [...target.canonicalIds] }
    const opening = await this.begin(before, { kind: 'detach', target: captured }, captured.canonicalIds.length, shouldContinue, opener)
    return this.getSnapshot()?.id === opening.view.id && !opening.view.error
  }
  async openHostEdit(beforeBlocks: readonly DocumentBlockDraft[], afterBlocks: readonly DocumentBlockDraft[], options: CanonicalHostEditOptions) {
    const before = this.port.current()
    if (this.pending() || !options.shouldContinue() || this.port.blocked() || !before
      || !areDocumentDraftBlocksEqual(before.host.workingBefore.blocks, beforeBlocks)) return false
    let blocks
    try { blocks = validateSyncedHostForest(afterBlocks.map(block => ({ ...block, parentBlockId: block.parentBlockId ?? null }))) }
    catch (error) { this.port.notify('目标结构无效，当前草稿已保留。', 'The destination is invalid. The current draft is retained.'); return false }
    if (areDocumentDraftBlocksEqual(beforeBlocks, blocks)) return false
    const working = before.host.workingBefore
    const action: HostEdit = { kind: 'host-edit', reason: options.reason ?? 'selection-edit', onAccepted: options.onAccepted,
      preserveSameParentDraft: options.preserveSameParentDraft,
      afterBookmark: options.afterBookmark ? structuredClone(options.afterBookmark) : undefined,
      finalAfter: [{ documentId: before.host.documentId, title: working.title, summary: working.summary, blocks }],
      newRefSources: structuredClone([...(options.newRefSources ?? [])]) }
    const opening = this.start(before, action, 0, options.shouldContinue, options.opener, true)
    const applied = await this.apply()
    if (!applied && this.opening === opening) { opening.hidden = false; this.port.changed() }
    return applied
  }
  private async begin(before: SyncedHostSourceCurrent, action: Opening['action'], blockCount: number, shouldContinue: () => boolean, opener: HTMLElement | null): Promise<Opening> {
    const opening = this.start(before, action, blockCount, shouldContinue, opener, false)
    await this.load(opening, '', 0)
    return opening
  }
  private start(before: SyncedHostSourceCurrent, action: Opening['action'], blockCount: number, shouldContinue: () => boolean,
    opener: HTMLElement | null, hidden: boolean): Opening {
    const opening: Opening = { before: { ...before, host: structuredClone(before.host) }, action,
      operationId: crypto.randomUUID(), instanceId: crypto.randomUUID(), input: null, receipt: 'idle', hidden, listing: 0, shouldContinue,
      view: Object.freeze({ id: Object.freeze({}), kind: action.kind, documentId: before.host.documentId, blockCount, opener,
        busy: false, loading: !hidden, error: '', uncertain: false, hasRequest: false, query: '', offset: 0, total: 0, items: [], selectedGroupId: null,
        canReturnFocus: () => !this.port.blocked() && this.port.current()?.hostSession === before.hostSession
          && this.port.current()?.host.documentId === before.host.documentId }) }
    this.opening = opening; this.port.changed()
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
    const detach = opening.action.kind === 'detach' ? opening.action.target : null
    const hostEdit = opening.action.kind === 'host-edit' ? opening.action : null
    const protectedEdit = detach !== null || hostEdit !== null
    if (!this.current(opening) && !(protectedEdit && opening.receipt === 'dispatched')) {
      this.update(opening, { error: this.port.isZh() ? '原宿主、选区或完整草稿已变化，当前草稿已保留。' : 'The original host, selection, or complete draft changed; the current draft is retained.' }); return false
    }
    if (opening.action.kind === 'insert' && !opening.input && !opening.view.selectedGroupId) return false
    const recoveringOriginal = opening.input !== null
    const reorder = hostEdit?.preserveSameParentDraft && this.port.protectReorder?.(opening.before, hostEdit.finalAfter[0].blocks)
    if (reorder === null || opening.preserveReorder && !reorder) {
      this.update(opening, { error: this.port.isZh() ? '原共享草稿或宿主顺序已变化，当前草稿已保留。'
        : 'The original group draft or host order has changed. The current draft is retained.' })
      return false
    }
    if (reorder) opening.preserveReorder = true
    this.update(opening, { busy: true, error: '' })
    try {
      if (!opening.input) {
        if (hostEdit && (!await this.port.openHost(opening.before.host.documentId) || !this.current(opening))) {
          throw new Error('The original host or complete working body changed; the current draft is retained.')
        }
        const groupReady = reorder ? reorder.current() : detach ? detach.settled() : await this.port.flushGroups(() => this.current(opening))
        if (!groupReady || !this.current(opening)) {
          this.update(opening, { error: this.port.isZh() ? '共享正文保存尚未完成，请先处理原草稿。' : 'The shared body has not finished saving. Resolve its original draft first.' }); return false
        }
        const groupId = detach?.group.groupId ?? (opening.action.kind === 'insert' ? opening.view.selectedGroupId! : null)
        const hostEditGroups = hostEdit ? [...opening.before.host.workingBefore.blocks, ...hostEdit.finalAfter[0].blocks]
          .flatMap(block => block.type === 'synced-block' ? [parseSyncedBlockPayload(block.content).groupId] : []) : []
        const guards = await this.port.guards(opening.before.host.documentId, groupId ? [groupId] : hostEditGroups)
        if (!guards || !this.current(opening) || reorder && !reorder.acceptsGuards(guards)) throw new Error('The original host/group guards changed; the complete draft is retained.')
        if (detach && (!detach.settled() || !guards.groups.some(group => group.groupId === detach.group.groupId
          && group.expectedRevision === detach.group.expectedRevision && group.expectedTopologyRevision === detach.group.expectedTopologyRevision)
          || !guards.expectedInstances.some(instance => instance.instanceId === detach.instance.instanceId
            && instance.hostDocumentId === detach.instance.hostDocumentId && instance.bindingVersion === detach.instance.bindingVersion))) {
          throw new Error(this.port.isZh() ? '原引用或共享正文已变化，请取消后重新打开。' : 'The original reference or shared body changed. Cancel and reopen.')
        }
        const base = { clientOperationId: opening.operationId, hostsWorkingBefore: [structuredClone(opening.before.host)], ...guards }
        const action = opening.action
        opening.input = action.kind === 'host-edit' ? { ...base, mode: 'host-final', reason: action.reason,
          finalAfter: action.finalAfter, newRefSources: action.newRefSources }
          : { ...base, mode: 'command', action: action.kind === 'create' ? { kind: 'create', documentId: opening.before.host.documentId,
              selectedRootIds: [...action.rootIds], groupId: action.groupId, instanceId: opening.instanceId }
            : action.kind === 'insert' ? { kind: 'insert', groupId: groupId!, instanceId: opening.instanceId, target: { ...action.target } }
              : { kind: 'detach', groupId: action.target.group.groupId, instanceId: action.target.instance.instanceId } }
        this.update(opening, { hasRequest: true })
      }
      const input = opening.input
      if (reorder && !reorder.acceptsGuards(input)) return false
      let result: SyncedEditingHostResult | undefined
      if (recoveringOriginal && (!protectedEdit || opening.receipt === 'dispatched')) {
        const observed = await this.port.operation(input.clientOperationId)
        if (observed.status === 'committed' && 'hosts' in observed.result) result = observed.result
        else if (observed.status !== 'unknown') throw new Error('The original receipt is not a host structure operation')
        else if (hostEdit && !opening.shouldContinue()) {
          opening.receipt = 'idle'
          this.update(opening, { uncertain: false })
          throw new Error(this.port.isZh() ? '原选区已离开，当前草稿已保留。' : 'The original selection is no longer active. Your draft is retained.')
        }
      }
      if (!result) {
        if (protectedEdit) {
          const ready = () => this.current(opening) && (!detach || detach.settled()) && (!reorder || reorder.current())
          if (!ready()) throw new Error(this.port.isZh() ? '原引用或共享正文已变化，请重新核对原操作。' : 'The original reference or shared body changed. Check the original operation again.')
          const previous = opening.receipt
          opening.receipt = 'protecting'
          this.port.changed()
          try {
            if (!await this.port.protectHostEdit(opening.before.hostSession, input.clientOperationId, ready, reorder ? reorder.groupIdentity : undefined) || !ready())
              throw new Error(this.port.isZh() ? '草稿保护尚未确认，请重试原操作。' : 'Draft protection has not been confirmed. Retry the original operation.')
          } catch (error) {
            opening.receipt = previous
            throw error
          }
          opening.receipt = 'dispatched'
        }
        try { result = await this.port.apply(input) }
        catch (error) {
          this.update(opening, { uncertain: true })
          const observed = await this.port.operation(input.clientOperationId)
          if (observed.status !== 'committed' || !('hosts' in observed.result)) throw error
          result = observed.result
        }
      }
      if (result.status !== 'applied') {
        opening.receipt = 'idle'
        this.update(opening, { uncertain: false, error: this.port.isZh()
          ? result.status === 'unsupported' ? '当前选区、标题或正文结构暂不支持此操作，完整草稿已保留。' : '原结构操作未应用，完整草稿已保留，请取消后核对原正文。'
          : result.status === 'unsupported' ? 'This selection, heading, or working structure is not supported; the complete draft is retained.'
            : 'The original structure command was not applied; the complete draft is retained. Cancel and check the original body.' })
        return false
      }
      const host = result.hosts[0], before = opening.before
      const final = hostEdit?.finalAfter[0]
      if (result.operationId !== input.clientOperationId || result.hosts.length !== 1 || host?.documentId !== before.host.documentId
        || host.after.id !== before.host.documentId || host.logicalBefore.title !== before.host.workingBefore.title
        || host.logicalBefore.summary !== before.host.workingBefore.summary
        || !areDocumentDraftBlocksEqual(host.logicalBefore.blocks, before.host.workingBefore.blocks)
        || final && (!result.historyToken || host.after.title !== final.title || host.after.summary !== final.summary
          || !areDocumentDraftBlocksEqual(host.after.blocks, final.blocks))
        || detach && !matchesDetachAck(detach, result) || reorder && !reorder.accepts(result)
        || !this.current(opening, hostEdit !== null) || !this.port.adopt(before, result, hostEdit?.afterBookmark)) {
        this.update(opening, { uncertain: true, error: 'Main returned an operation, but its original host/W acknowledgement could not be adopted. The full draft is retained; retry the same operation.' })
        return false
      }
      // Only the actual atomic host ACK is adopted. Main owns the structure
      // journal/history token; no ordinary updateDocument or local undo snapshot.
      this.opening = null; this.port.changed()
      try { hostEdit?.onAccepted?.() } catch (error) { console.warn('Could not restore selection after the accepted edit.', error) }
      return true
    } catch (error) { this.update(opening, { error: String(error) }); return false }
    finally { if (reorder) reorder.release(); this.update(opening, { busy: false }) }
  }
}
