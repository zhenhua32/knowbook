import type { DocumentDetail } from '@shared/contracts'
import type { SyncedGroupSnapshotsResult, SyncedHistoryState, SyncedInstanceGuard, SyncedOperationResult,
  SyncedRestoreHostInput, SyncedStructureApplied, SyncedGroupGuard } from '@shared/synced-blocks'
import type { SyncedEditingHostResult } from '@shared/synced-editing-session'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import type { SyncedHostHistoryTransition } from './hostHistoryTypes'
import { parseSyncedBlockPayload } from '@shared/syncedBlockValidation'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'

type Content = SyncedHostSourceCurrent['host']['workingBefore']
// A private projection read only from the real Main ACK below. It never mints
// a binding, active snapshot or restoration permission, and imports no Main code.
type ActualLifecycleGuard = { groupId: string; createHistoryId: string; state: 'active' | 'retired-create'; revision: string; topologyRevision: string }
type Boundary = { transition: SyncedHostHistoryTransition; before: Content; after: Content; groupIds: readonly string[];
  retired: ReadonlyMap<string, SyncedGroupGuard> }
type OriginalRestore = { transition: SyncedHostHistoryTransition; direction: 'undo' | 'redo'; before: SyncedHostSourceCurrent;
  boundary: Boundary; input: SyncedRestoreHostInput }
export interface HostStructureHistoryPort {
  current: () => SyncedHostSourceCurrent | null
  readHost: (id: string) => Promise<DocumentDetail | null>
  blocked: () => boolean
  workspaceScope: () => string | null
  openHost: (id: string) => Promise<boolean>
  openInstance: (hostId: string, instanceId: string, groupId: string) => Promise<boolean>
  readHistory: (id: string) => Promise<SyncedHistoryState>
  readGroups: (ids: string[]) => Promise<SyncedGroupSnapshotsResult>
  flushGroups: (current: () => boolean) => Promise<boolean>
  flushHost: () => Promise<boolean>
  restore: (input: SyncedRestoreHostInput) => Promise<SyncedEditingHostResult>
  operation: (id: string) => Promise<SyncedOperationResult>
  adopt: (before: SyncedHostSourceCurrent, result: SyncedStructureApplied) => boolean
  changed: () => void
  released: () => void
  notify: (zh: string, en: string) => void
}
const key = (value: SyncedHostHistoryTransition) => JSON.stringify([value.documentId, value.operationId, value.historyToken])
const sameContent = (left: Content, right: Content) => left.title === right.title && left.summary === right.summary
  && areDocumentDraftBlocksEqual(left.blocks, right.blocks)
const content = (detail: DocumentDetail): Content => ({ title: detail.title, summary: detail.summary,
  blocks: detail.blocks.map(({ sortOrder: _order, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })) })

/** Fixed Undo/Redo route, not a general restore DTO entry point. A boundary is
 * recorded only from the enclosing runtime's actual accepted Main receipt. */
export class SyncedHostStructureHistory {
  private boundaries = new Map<string, Boundary>()
  private original: OriginalRestore | null = null
  private busy = false
  constructor(private readonly port: HostStructureHistoryPort) {}
  pending = () => this.original !== null
  isBusy = () => this.busy
  owns(transition: SyncedHostHistoryTransition) { return this.original !== null && key(this.original.transition) === key(transition) }
  remember(before: SyncedHostSourceCurrent, result: SyncedStructureApplied) {
    const row = result.hosts[0]
    if (!result.historyToken || result.hosts.length !== 1 || row?.documentId !== before.host.documentId
      || row.after.id !== before.host.documentId || !sameContent(row.logicalBefore, before.host.workingBefore)) return
    const transition = Object.freeze({ documentId: before.host.documentId, operationId: result.operationId, historyToken: result.historyToken })
    const ids = new Set(result.groups.map(group => group.groupId))
    for (const side of [row.logicalBefore, content(row.after)]) for (const block of side.blocks) {
      if (block.type === 'synced-block') ids.add(parseSyncedBlockPayload(block.content).groupId)
    }
    this.boundaries.set(key(transition), { transition, before: structuredClone(row.logicalBefore), after: content(row.after), groupIds: [...ids], retired: new Map() })
  }
  private sameOpening(before: SyncedHostSourceCurrent, compareVersion = true) {
    const actual = this.port.current()
    return !this.port.blocked() && actual?.hostSession === before.hostSession && actual.editSequence === before.editSequence
      && actual.host.documentId === before.host.documentId && (!compareVersion || actual.host.expectedPersistedUpdatedAt === before.host.expectedPersistedUpdatedAt)
      && sameContent(actual.host.workingBefore, before.host.workingBefore)
  }
  private async guards(boundary: Boundary, before: SyncedHostSourceCurrent) {
    const result = await this.port.readGroups([...boundary.groupIds])
    if (result.workspaceScope !== this.port.workspaceScope() || !this.sameOpening(before)) return null
    const groups: SyncedGroupGuard[] = [], expectedInstances: SyncedInstanceGuard[] = []
    for (const item of result.items) {
      if (item.status === 'missing') {
        // A create Undo really retires the original group. Its genuine prior
        // restore ACK supplies only revision guards; Main rechecks retirement,
        // the original create journal and epoch. Never invent an active snapshot.
        const guard = boundary.retired.get(item.groupId)
        if (!guard) return null
        groups.push({ ...guard }); continue
      }
      groups.push({ groupId: item.snapshot.groupId, expectedRevision: item.snapshot.revision, expectedTopologyRevision: item.snapshot.topologyRevision })
      for (const instance of item.snapshot.instances.filter(instance => instance.hostDocumentId === before.host.documentId)) {
        if (!await this.port.openInstance(before.host.documentId, instance.instanceId, item.snapshot.groupId) || !this.sameOpening(before)) return null
        expectedInstances.push({ instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion })
      }
    }
    if (result.items.length !== boundary.groupIds.length || new Set(groups.map(group => group.groupId)).size !== boundary.groupIds.length
      || groups.some(group => !boundary.groupIds.includes(group.groupId))) return null
    return { groups, expectedInstances }
  }
  private noteLifecycle(boundary: Boundary, result: SyncedStructureApplied) {
    if (!('createdLifecycle' in result)) return
    const side = result.createdLifecycle as ActualLifecycleGuard
    if (!side || side.createHistoryId !== boundary.transition.historyToken || !boundary.groupIds.includes(side.groupId)
      || !['active', 'retired-create'].includes(side.state) || typeof side.revision !== 'string' || typeof side.topologyRevision !== 'string') throw Error('The actual create lifecycle receipt does not match the original history boundary')
    const retired = new Map(boundary.retired)
    if (side.state === 'retired-create') retired.set(side.groupId, { groupId: side.groupId, expectedRevision: side.revision, expectedTopologyRevision: side.topologyRevision })
    else retired.delete(side.groupId)
    boundary.retired = retired
  }
  async restore(transition: SyncedHostHistoryTransition, direction: 'undo' | 'redo'): Promise<boolean> {
    if (this.busy || this.port.blocked()) return false
    const recoveringOriginal = this.original !== null
    const boundary = this.boundaries.get(key(transition)), opening = this.port.current()
    if (!boundary || !opening || opening.host.documentId !== transition.documentId
      || !sameContent(opening.host.workingBefore, direction === 'undo' ? boundary.after : boundary.before)) {
      this.port.notify('当前普通编辑尚未回到原结构边界，完整草稿已保留。', 'Ordinary edits are not at the original structure boundary; the complete draft is retained.'); return false
    }
    if (this.original && (key(this.original.transition) !== key(transition) || this.original.direction !== direction)) return false
    this.busy = true; this.port.changed()
    try {
      if (!this.original) {
        if (!await this.port.openHost(transition.documentId) || !this.sameOpening(opening)) return false
        const firstHistory = await this.port.readHistory(transition.documentId)
        if ((direction === 'undo' ? firstHistory.undoToken : firstHistory.redoToken) !== transition.historyToken || !this.sameOpening(opening)) {
          this.port.notify('原结构历史或宿主会话已变化，完整草稿和普通撤销记录已保留。', 'The original structure history or host session changed; the complete draft and ordinary history are retained.'); return false
        }
        // This flush uses the existing writer only after W exactly matches the
        // real structure boundary. It cannot save a later unrelated ordinary W
        // merely to make an old inverse appear applicable.
        if (!await this.port.flushGroups(() => this.sameOpening(opening, false)) || !this.sameOpening(opening, false)
          || !await this.port.flushHost() || !this.sameOpening(opening, false)) return false
        const submitted = this.port.current(), persisted = await this.port.readHost(transition.documentId)
        if (!submitted || !this.sameOpening(submitted) || !persisted || persisted.id !== transition.documentId
          || persisted.updatedAt !== submitted.host.expectedPersistedUpdatedAt || !sameContent(submitted.host.workingBefore, content(persisted))) return false
        const history = await this.port.readHistory(transition.documentId)
        if (history.cursor !== firstHistory.cursor || (direction === 'undo' ? history.undoToken : history.redoToken) !== transition.historyToken || !this.sameOpening(submitted)) return false
        const guards = await this.guards(boundary, submitted)
        if (!guards || !this.sameOpening(submitted)) return false
        const input: SyncedRestoreHostInput = { clientOperationId: crypto.randomUUID(), historyToken: transition.historyToken, direction,
          expectedHosts: [{ documentId: transition.documentId, expectedUpdatedAt: submitted.host.expectedPersistedUpdatedAt }], ...guards }
        this.original = { transition: { ...transition }, direction, boundary, before: { ...submitted, host: structuredClone(submitted.host) }, input }
        this.port.changed()
      }
      const original = this.original
      if (!this.sameOpening(original.before)) return false
      let result: SyncedEditingHostResult | undefined
      if (recoveringOriginal) {
        // A successful inverse may remove/rebind an old captured instance.
        // Read its genuine receipt before trying that spent writer fence again;
        // otherwise a lost ACK could incorrectly invalidate this live session.
        const known = await this.port.operation(original.input.clientOperationId)
        if (known.status === 'committed' && 'hosts' in known.result) result = known.result
        else if (known.status !== 'unknown') throw Error('The original inverse receipt is not a host operation')
      }
      if (!result) {
        try { result = await this.port.restore(original.input) }
        catch (error) {
          const known = await this.port.operation(original.input.clientOperationId)
          if (known.status !== 'committed' || !('hosts' in known.result)) throw error
          result = known.result
        }
      }
      if (result.status !== 'applied') {
        this.original = null
        this.port.notify('原结构历史未恢复，当前正文和普通撤销记录已保留。', 'The original structure history was not restored; the body and ordinary history are retained.'); return false
      }
      const row = result.hosts[0]
      if (result.operationId !== original.input.clientOperationId || result.historyToken !== transition.historyToken || result.hosts.length !== 1
        || row?.documentId !== transition.documentId || row.after.id !== transition.documentId
        || !sameContent(row.logicalBefore, original.before.host.workingBefore) || !this.sameOpening(original.before)
        || !sameContent(content(row.after), direction === 'undo' ? boundary.before : boundary.after)) throw Error('The actual inverse acknowledgement does not match the original host/whole W/history boundary')
      this.noteLifecycle(boundary, result)
      if (!this.port.adopt(original.before, result)) throw Error('The actual inverse committed but this original host could not adopt it; retry the same operation')
      this.original = null; return true
    } catch (error) {
      this.port.notify('原结构回执尚未确认，完整正文已保留；请重试同一撤销或重做。' + String(error), 'The original structure acknowledgement is unsettled; the complete body is retained. Retry the same Undo or Redo. ' + String(error))
      return false
    } finally {
      this.busy = false; this.port.changed()
      if (!this.original) this.port.released()
    }
  }
}
