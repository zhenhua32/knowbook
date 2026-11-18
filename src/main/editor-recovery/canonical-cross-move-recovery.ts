import type Database from 'better-sqlite3'
import { readCanonicalRecoveryClosedFrames } from '../../shared/editor-recovery-canonical'
import { editorRecoveryInvalid, type EditorRecoveryBase, type EditorRecoveryCandidate, type EditorRecoveryDraftInput,
  type EditorRecoveryRecord } from '../../shared/editor-recovery-drafts'
import type { SyncedInstanceGuard, SyncedInstancePosition } from '../../shared/synced-blocks'
import { parseSyncedBlockPayload, SyncedValidationError, validateSyncedCanonicalProjection } from '../../shared/syncedBlockValidation'
import { readProtectedCrossMoveReference } from '../../shared/synced-cross-move-recovery-forest'
import { getSyncedGroupSnapshots } from '../database/synced-blocks-read'
import { readHistoricalExactRows, type HistoricalOperationRow } from '../database/synced-history-evidence-support'
import { readStrictHostDocument } from '../database/synced-host-document-read'
import { isHostMoveInput } from '../database/synced-host-move-plan'
import { isHostMoveBatchInput } from '../database/synced-host-cross-move-batch-plan'
import { readCanonicalBatchCrossMoveOriginalOwned, readCanonicalBatchMoveSelection, readCanonicalCrossMoveOriginal4Owned,
  readCanonicalLinkedCrossMoveOriginalOwned } from './canonical-cross-move-original4'
import { attestEditorRecoveryPendingOwned, readEditorRecoveryPendingRequest } from './pending-original'

export function readCanonicalCrossMoveRequest(base: EditorRecoveryBase, draft: EditorRecoveryDraftInput) {
  const [pending] = draft.pending
  if (base.owner.kind !== 'host' || draft.pending.length !== 1 || pending.method !== 'applySyncedHostStructure'
    || draft.composing || draft.importing || draft.sources.length) return undefined
  const input = readEditorRecoveryPendingRequest(pending)
  if (!('mode' in input) || input.hostsWorkingBefore.length < 2) return undefined
  const command = isHostMoveBatchInput(input) ? { kind: 'batch' as const, input, selected: readCanonicalBatchMoveSelection(input) }
    : isHostMoveInput(input) ? { kind: 'single' as const, input, selected: input.action } : undefined
  if (!command?.selected) return undefined
  if (command.kind === 'batch' && (draft.replayJson !== undefined || draft.canonicalReadOwnerId !== undefined)) return undefined
  const { selection, target } = command.selected, { selectedRootIds } = selection
  const initiatorId = base.owner.documentId
  if (command.kind === 'batch' && selectedRootIds.length !== 1 || selection.documentId === target.documentId) return undefined
  const movePages = new Set(command.kind === 'batch' ? command.input.action.moves.flatMap(move => [move.selection.documentId, move.target.documentId])
    : [selection.documentId, target.documentId])
  if (command.kind === 'batch' ? !command.input.action.moves.some(move => move.selection.documentId === initiatorId)
    : selection.documentId !== initiatorId) return undefined
  const initiator = input.hostsWorkingBefore.find(host => host.documentId === initiatorId)
  const source = input.hostsWorkingBefore.find(host => host.documentId === selection.documentId)
  if (!source || initiator?.expectedPersistedUpdatedAt !== base.owner.updatedAt
    || !input.hostsWorkingBefore.some(host => host.documentId === target.documentId)) return undefined
  const block = readProtectedCrossMoveReference(source.workingBefore.blocks, selectedRootIds)
  if (!block || (selectedRootIds.length !== 1 || block.id !== selectedRootIds[0]) && input.hostsWorkingBefore.length !== 2) return undefined
  const { groupId } = parseSyncedBlockPayload(block.content)
  const binding = input.expectedInstances.find(instance => instance.instanceId === block.id && instance.hostDocumentId === selection.documentId)
  const guard = input.groups.find(group => group.groupId === groupId)
  if (!binding || !guard) return undefined
  const dependencyDocumentIds = input.hostsWorkingBefore.filter(host => !movePages.has(host.documentId))
    .map(host => host.documentId).sort()
  return { ...command, pending, groupId, binding, guard, selectedRootIds, targetDocumentId: target.documentId, dependencyDocumentIds }
}

function originalBaseline(db: Database.Database, group: EditorRecoveryRecord) {
  const [original] = group.base.originals
  if (group.base.owner.kind !== 'group' || group.base.originals.length !== 1 || original.kind !== 'metadata2-baseline') return undefined
  const [row] = readHistoricalExactRows<HistoricalOperationRow>(db, 'synced_operations',
    ['client_operation_id', 'request_hash', 'result_json', 'created_at'], 'client_operation_id=?', [original.key])
  if (!row || row.client_operation_id !== original.key || row.request_hash !== original.requestHash
    || row.result_json !== original.resultJson || row.created_at !== original.createdAt) return undefined
  return original
}

/** Before the move, only the actual sealed original and its uncommitted
 * closed W at the original occurrence can be attached to the host request. */
export function canCaptureCanonicalCrossMoveGroupOwned(db: Database.Database, host: EditorRecoveryBase,
  move: NonNullable<ReturnType<typeof readCanonicalCrossMoveRequest>>, group: EditorRecoveryRecord,
  placement?: Pick<SyncedInstancePosition, 'depth' | 'parentBlockId' | 'parentType'>,
  stationary?: readonly SyncedInstancePosition[]): boolean {
  if (!db.inTransaction || host.workspaceScope !== group.base.workspaceScope || host.recoveryEpoch !== group.base.recoveryEpoch
    || group.base.owner.kind !== 'group' || group.base.owner.groupId !== move.groupId || !originalBaseline(db, group)
    || db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(move.pending.clientOperationId)) return false
  const [actual] = getSyncedGroupSnapshots(db, { groupIds: [move.groupId] }).items
  if (actual?.status !== 'ready' || actual.snapshot.revision !== move.guard.expectedRevision
    || actual.snapshot.topologyRevision !== move.guard.expectedTopologyRevision) return false
  const instances = actual.snapshot.instances
  const instance = instances.find(item => item.instanceId === move.binding.instanceId)
  if (!instance || instance.hostDocumentId !== move.binding.hostDocumentId
    || instance.bindingVersion !== move.binding.bindingVersion) return false
  const direct = move.selectedRootIds.length === 1 && move.selectedRootIds[0] === instance.instanceId
  if (!placement && (move.kind === 'batch' || !direct)) {
    if (host.owner.kind !== 'host') return false
    const source = readStrictHostDocument(db, instance.hostDocumentId)
    const reference = source && readProtectedCrossMoveReference(source.content.blocks, move.selectedRootIds)
    const initiator = host.owner.documentId === instance.hostDocumentId ? source : readStrictHostDocument(db, host.owner.documentId)
    const sourceVersion = move.input.hostsWorkingBefore.find(side => side.documentId === instance.hostDocumentId)?.expectedPersistedUpdatedAt
    if (!source || source.detail.updatedAt !== sourceVersion || !initiator || initiator.detail.updatedAt !== host.owner.updatedAt || initiator.createdAt !== host.owner.createdAt
      || reference?.id !== instance.instanceId || parseSyncedBlockPayload(reference.content).groupId !== move.groupId) return false
  }
  if (instances.length > 1) {
    const guards = new Map(move.input.expectedInstances.map(guard => [guard.instanceId, guard]))
    if (move.kind === 'batch' || !direct && move.dependencyDocumentIds.length > 0 || instances.some(item => {
      const guard = guards.get(item.instanceId)
      return guard?.hostDocumentId !== item.hostDocumentId || guard.bindingVersion !== item.bindingVersion
        || item.hostDocumentId !== move.binding.hostDocumentId && item.hostDocumentId !== move.targetDocumentId
    })) return false
    if (placement && (!stationary || stationary.length !== instances.length - 1 || stationary.some(item => {
      const current = instances.find(instance => instance.instanceId === item.instanceId)
      return !current || item.instanceId === move.binding.instanceId || current.hostDocumentId !== item.hostDocumentId
        || current.bindingVersion !== item.bindingVersion || current.parentBlockId !== item.parentBlockId || current.depth !== item.depth || current.parentType !== item.parentType
    }))) return false
  }
  const replay = readCanonicalRecoveryClosedFrames(group, actual.snapshot, host.workspaceScope)
  const frames = [...replay.frames, ...replay.redoFrames]
  if (frames.some(frame => frame.instance.instanceId !== instance.instanceId)) return false
  if (placement) {
    const target = { ...instance, ...placement, hostDocumentId: move.targetDocumentId }
    const positions = instances.map(item => item === instance ? target : item)
    try { for (const frame of frames) validateSyncedCanonicalProjection(frame.after, positions) }
    catch (error) { if (error instanceof SyncedValidationError) return false; throw error }
  }
  return frames.length > 0
}

/** The side-store has independently verified that both linked captures are
 * still current. Return an address to the old W and a read-only move proof. */
export function readCanonicalCrossMoveRecoveryOwned(db: Database.Database, host: EditorRecoveryRecord,
  group: EditorRecoveryRecord): EditorRecoveryCandidate['canonicalCrossMoveRecovery'] {
  return readCanonicalCrossMoveEvidenceOwned(db, host, group)?.candidate
}

function readCanonicalCrossMoveEvidenceOwned(db: Database.Database, host: EditorRecoveryRecord, group: EditorRecoveryRecord) {
  const link = host.crossMoveGroupHead, hostOwner = host.base.owner
  if (!db.inTransaction || !link || hostOwner.kind !== 'host' || group.recordId !== link.recordId
    || group.draft.draftSessionId !== link.draftSessionId || group.draft.generation !== link.generation
    || host.base.workspaceScope !== group.base.workspaceScope || host.base.recoveryEpoch !== group.base.recoveryEpoch) return undefined
  const move = readCanonicalCrossMoveRequest(host.base, host.draft), original = originalBaseline(db, group)
  if (!move || !original) return undefined
  const [attested] = attestEditorRecoveryPendingOwned(db, host)
  if (attested?.status !== 'committed-attested') return undefined
  const proofInput = { operationId: attested.clientOperationId,
    requestHash: attested.businessRequestHash, baselineKey: original.key, baselineHash: original.requestHash }
  const proof = move.kind === 'batch' ? readCanonicalBatchCrossMoveOriginalOwned(db, proofInput, host, move.binding.instanceId)
    : move.dependencyDocumentIds.length ? readCanonicalLinkedCrossMoveOriginalOwned(db, proofInput)
      : readCanonicalCrossMoveOriginal4Owned(db, proofInput, move.binding.instanceId)
  if (proof.groupId !== move.groupId || proof.before.instanceId !== move.binding.instanceId
    || proof.before.hostDocumentId !== move.binding.hostDocumentId || move.kind === 'single' && proof.before.hostCreatedAt !== hostOwner.createdAt
    || proof.after.hostDocumentId !== move.targetDocumentId || proof.workspaceScope !== host.base.workspaceScope
    || proof.recoveryEpoch !== host.base.recoveryEpoch) return undefined
  const [actual] = getSyncedGroupSnapshots(db, { groupIds: [proof.groupId] }).items
  if (actual?.status !== 'ready') return undefined
  const before = { ...actual.snapshot, topologyRevision: proof.before.topologyRevision, instances: proof.beforeInstances }
  const replay = readCanonicalRecoveryClosedFrames(group, before, proof.workspaceScope)
  const frames = [...replay.frames, ...replay.redoFrames]
  if (!frames.length || frames.some(frame => frame.instance.instanceId !== proof.before.instanceId)) return undefined
  if (move.kind === 'batch' || proof.beforeInstances.length > 1) {
    try { for (const frame of frames) validateSyncedCanonicalProjection(frame.after, actual.snapshot.instances) }
    catch (error) { if (error instanceof SyncedValidationError) return undefined; throw error }
  }
  return { candidate: { group: { recordId: link.recordId, generation: link.generation, hash: link.hash },
    hostDocumentId: proof.after.hostDocumentId, proofHash: proof.proofHash, writePermit: false as const,
    ...(proof.beforeInstances.length > 1 ? { instanceId: proof.after.instanceId } : {}) },
    snapshot: actual.snapshot, moved: proof.after, replay, retireBatchHost: move.kind === 'batch' }
}

/** Rebind only the private occurrence guard of a verified old frame chain.
 * The new baseline is the exact authenticated target, not a rewritten old B. */
export function prepareCanonicalCrossMoveTransferOwned(db: Database.Database, host: EditorRecoveryRecord, group: EditorRecoveryRecord,
  target: { base: EditorRecoveryBase; draftSessionId: string; instance: SyncedInstanceGuard; proofHash: string }) {
  const evidence = readCanonicalCrossMoveEvidenceOwned(db, host, group), base = target.base, owner = base.owner
  if (!evidence || evidence.candidate.proofHash !== target.proofHash || owner.kind !== 'group') {
    return editorRecoveryInvalid('the original committed cross-host move no longer proves a transfer')
  }
  const { snapshot, replay, moved: actual } = evidence, guard = target.instance
  if (base.workspaceScope !== group.base.workspaceScope || base.recoveryEpoch !== group.base.recoveryEpoch
    || owner.groupId !== snapshot.groupId || owner.creationId !== snapshot.creationId || owner.createdAt !== snapshot.createdAt
    || owner.revision !== snapshot.revision || owner.topologyRevision !== snapshot.topologyRevision || owner.historyCursor !== snapshot.history.cursor
    || actual.instanceId !== guard.instanceId || actual.hostDocumentId !== guard.hostDocumentId || actual.bindingVersion !== guard.bindingVersion) {
    return editorRecoveryInvalid('the receiving producer or mounted occurrence changed')
  }
  const frame = (item: typeof replay.frames[number]) => ({ ...item, copySources: [], instance: guard })
  const draft: EditorRecoveryDraftInput = { draftSessionId: target.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
    working: group.draft.working, selection: group.draft.selection, pending: [], sources: [], composing: false, importing: false,
    replayJson: JSON.stringify({ kind: 'knowbook-canonical-recovery-data', version: 2, snapshot, readSource: null, accepted: null,
      frames: replay.frames.map(frame), redoFrames: replay.redoFrames.map(frame), serverRedo: [], cutServerRedo: replay.cutServerRedo }) }
  return { snapshot, draft, retireBatchHost: evidence.retireBatchHost }
}
