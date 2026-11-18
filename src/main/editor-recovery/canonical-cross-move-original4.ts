import type Database from 'better-sqlite3'
import type { EditorRecoveryRecord, EditorRecoveryWorking } from '../../shared/editor-recovery-drafts'
import type { SyncedGroupWire, SyncedInstancePosition } from '../../shared/synced-blocks'
import { readProtectedCrossMoveReference, readProtectedCrossMoveSubtrees } from '../../shared/synced-cross-move-recovery-forest'
import { assertSyncedShape, isSyncedUuid, parseSyncedBlockPayload, syncedPlainRecord, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { BlockIdentityRepository } from '../database/block-identities'
import { getSyncedGroupSnapshots, getSyncedHostHistory } from '../database/synced-blocks-read'
import { assertNoOutsideCrossMoveLinks, CrossMoveJournalError, decodeCrossHostJournal4, decodeCrossHostJournal6, decodeCrossHostJournal7,
  decodeCrossHostJournal8, decodeCrossHostJournal9, decodeCrossHostJournal10, decodeCrossHostJournal11,
  decodeCrossHostJournal12 } from '../database/synced-cross-host-journal4'
import { readSyncedExchangeHostCut } from '../database/synced-exchange-host-cut'
import { decodeMainHostOperationWithHeadingBirthOwned2 } from '../database/synced-heading-create-birth-read2'
import { readHistoricalExactRows, readHistoricalTextRows, type HistoricalOperationRow } from '../database/synced-history-evidence-support'
import { hostJson, readStrictHostDocument, type HostContent } from '../database/synced-host-document-read'
import { crossMoveReceiptMatches, matchesCrossMovePlaceholder } from '../database/synced-host-final'
import type { HostMoveBatchInput } from '../database/synced-host-cross-move-batch-plan'
import type { SyncedHostHistoryBranchRow } from '../database/synced-host-history-branch'
import { hostEqual, hostHash, sameHostContent } from '../database/synced-host-journal'
import { readSyncedMetadataCaptureRecordOwned2, reopenSyncedMetadataCaptureRecordOwned2,
  SYNCED_METADATA_BASELINE2_PREFIX } from '../database/synced-metadata-capture-record2'
import { readSyncedRecoveryHostCut } from '../database/synced-recovery-boundary-read'
import { readEditorRecoveryPendingRequest } from './pending-original'

const fail = (): never => { throw new Error('The original v4 canonical move binding transition cannot be proved.') }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const operationFields = ['client_operation_id', 'request_hash', 'result_json', 'created_at'] as const
const journalFields = ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'] as const
const groupHistoryFields = ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'] as const
type GroupHistoryRow = { id: string; group_id: string; position: number; before_json: string; after_json: string;
  before_hash: string; after_hash: string; created_at: string }

/** The V4 decoder already rederives every transfer and its birth. Identify
 * the unique moved reference using the original persisted source blocks. */
export function matchesCanonicalV4CrossMoveForest(original: ReturnType<typeof decodeCrossHostJournal4>, instanceId: string): boolean {
  const { selection } = original.input.action, { selectedRootIds } = selection
  if (original.crossMove.outsideIncoming.length) return false
  const source = original.persisted.find(page => page.documentId === selection.documentId)
  if (!source || selectedRootIds.length === 1 && readProtectedCrossMoveReference(source.content.blocks, selectedRootIds)?.id !== instanceId) return false
  const selected = readProtectedCrossMoveSubtrees(source.content.blocks, selectedRootIds)
  return selected?.reference.id === instanceId
    && hostEqual(selected.movedIds, original.crossMove.transfers.map(transfer => transfer.blockId))
}

/** Data only for a future recovery adapter. The caller must still own the old
 * group draft and its exact pending host request. No session, alias or write
 * authority is created by reopening the actual SQL originals. */
export function readCanonicalCrossMoveOriginal4Owned(db: Database.Database, input: unknown, movedReferenceId?: string) {
  return readCanonicalCrossMoveOriginalOwned(db, input, false, movedReferenceId)
}

/** Uses only the closed single-move journals. Each decoder rederives the
 * appropriate dependency syntax, page set, original B and A. */
export function readCanonicalLinkedCrossMoveJournal(row: Readonly<SyncedHostHistoryBranchRow>) {
  const action = hostJson(row.action_json)
  if (!syncedPlainRecord(action)) throw new CrossMoveJournalError()
  const version = action.version
  if (version !== 6 && version !== 7 && version !== 9 && version !== 10 && version !== 11) throw new CrossMoveJournalError()
  const decode = { 6: decodeCrossHostJournal6, 7: decodeCrossHostJournal7, 9: decodeCrossHostJournal9,
    10: decodeCrossHostJournal10, 11: decodeCrossHostJournal11 }[version]
  const original = decode(row), ids = new Set(original.crossMove.outsideIncoming)
  const dependents = original.persisted.filter(page => ids.has(page.documentId))
  const { selection, target } = original.input.action
  const oldBlock = original.persisted.find(page => page.documentId === selection.documentId)?.content.blocks
    .find(block => block.id === selection.selectedRootIds[0])
  if (selection.selectedRootIds.length !== 1 || original.crossMove.transfers.length !== 1
    || !dependents.length || dependents.length !== ids.size
    || oldBlock?.type !== 'synced-block' || oldBlock.parentBlockId !== null || oldBlock.depth !== 0
    || target.parentBlockId !== null || target.depth !== 0) throw new CrossMoveJournalError()
  return { version, original, dependents }
}

export function readCanonicalLinkedCrossMoveOriginalOwned(db: Database.Database, input: unknown) {
  return readCanonicalCrossMoveOriginalOwned(db, input, true)
}

/** A batch can carry a single direct reference and an independent ordinary
 * root. The actual persisted transfer set is checked by the journal reader. */
export function readCanonicalBatchMoveSelection(input: HostMoveBatchInput) {
  const moves = input.action.moves
  if (moves.length !== 2 || moves[0].selection.documentId === moves[1].selection.documentId
    || moves.some(({ selection, target }) => selection.selectedRootIds.length !== 1 || target.parentBlockId !== null || target.depth !== 0)) return undefined
  const references = []
  for (const move of moves) {
    const [rootId] = move.selection.selectedRootIds
    const source = input.hostsWorkingBefore.find(side => side.documentId === move.selection.documentId)
    const leaf = source?.workingBefore.blocks.find(block => block.id === rootId)
    if (!leaf) return undefined
    if (leaf.type === 'synced-block') {
      if (leaf.parentBlockId !== null || leaf.depth !== 0) return undefined
      references.push(move)
    }
  }
  return references.length === 1 ? references[0] : undefined
}

export function readCanonicalBatchCrossMoveJournal(row: Readonly<SyncedHostHistoryBranchRow>) {
  const wire = hostJson(row.action_json)
  const version = syncedPlainRecord(wire) ? wire.version : undefined
  if (version !== 8 && version !== 12) throw new CrossMoveJournalError()
  const original = (version === 8 ? decodeCrossHostJournal8 : decodeCrossHostJournal12)(row)
  const selected = readCanonicalBatchMoveSelection(original.input)
  if (!selected) throw new CrossMoveJournalError()
  const [instanceId] = selected.selection.selectedRootIds
  const transfers = new Map(original.crossMove.transfers.map(move => [move.blockId, move]))
  const protectedTransfer = transfers.get(instanceId)
  const references = original.persisted.flatMap(page => page.content.blocks.filter(block => block.type === 'synced-block' && transfers.has(block.id)))
  if (references.length !== 1 || references[0].id !== instanceId || references[0].parentBlockId !== null || references[0].depth !== 0
    || protectedTransfer?.from !== selected.selection.documentId || protectedTransfer.to !== selected.target.documentId) throw new CrossMoveJournalError()
  return { original, version, selected }
}

function sameCapturedHost(value: EditorRecoveryWorking, content: HostContent): boolean {
  return value.kind === 'host' && sameHostContent({ title: value.title, summary: value.summary, blocks: validateSyncedHostForest(value.blocks) }, content)
}

export function readCanonicalBatchInitiatingHost(original: ReturnType<typeof readCanonicalBatchCrossMoveJournal>['original'], host: EditorRecoveryRecord) {
  const { owner } = host.base, { draft } = host, [pending] = draft.pending
  if (owner.kind !== 'host' || draft.pending.length !== 1 || pending.method !== 'applySyncedHostStructure'
    || draft.sources.length || draft.composing || draft.importing || draft.replayJson !== undefined || draft.canonicalReadOwnerId !== undefined
    || !hostEqual(readEditorRecoveryPendingRequest(pending), original.input)
    || !original.input.action.moves.some(move => move.selection.documentId === owner.documentId)) return undefined
  const page = original.persisted.find(side => side.documentId === owner.documentId)
  const before = original.before.find(side => side.documentId === owner.documentId)
  if (!page || !before || page.createdAt !== owner.createdAt || page.updatedAt !== owner.updatedAt
    || !sameCapturedHost(host.base.persistedWorking, page.content) || !sameCapturedHost(draft.working, before.content)
    || !sameCapturedHost(pending.submittedWorking, before.content)) return undefined
  return page
}

export function readCanonicalBatchCrossMoveOriginalOwned(db: Database.Database, input: unknown, host: EditorRecoveryRecord, movedReferenceId: string) {
  return readCanonicalCrossMoveOriginalOwned(db, input, false, movedReferenceId, host)
}

/** Read the exact untouched memberships from the original P/guards and
 * require the same physical leaf and placement throughout its derived plan. */
export function readCanonicalStationaryInstances(original: ReturnType<typeof decodeCrossHostJournal4>, groupId: string, movedId: string) {
  const retained: Array<{ position: SyncedInstancePosition; createdAt: string }> = []
  if (original.input.expectedInstances.length < 2) return retained
  const guards = new Map(original.input.expectedInstances.map(guard => [guard.instanceId, guard]))
  for (const page of original.persisted) {
    const stationary = page.content.blocks.filter(block => block.id !== movedId && block.type === 'synced-block'
      && parseSyncedBlockPayload(block.content).groupId === groupId)
    if (!stationary.length) continue
    const births = new Map(page.births.map(item => [item.blockId, item.createdAt]))
    const blocks = new Map(page.content.blocks.map(block => [block.id, block]))
    const sides = [...original.before, ...original.after].filter(side => side.documentId === page.documentId)
      .map(side => new Map(side.content.blocks.map(block => [block.id, block])))
    for (const block of stationary) {
      const guard = guards.get(block.id), createdAt = births.get(block.id)
      const parentType = block.parentBlockId === null ? null : blocks.get(block.parentBlockId)?.type ?? null
      if (guard?.hostDocumentId !== page.documentId || !createdAt || sides.length !== 2 || !sides.every(blocks => {
        const found = blocks.get(block.id)
        return found?.type === block.type && found.content === block.content && found.parentBlockId === block.parentBlockId
          && found.depth === block.depth && (found.parentBlockId === null ? null : blocks.get(found.parentBlockId)?.type) === parentType
      })) return undefined
      retained.push({ position: { ...guard, parentBlockId: block.parentBlockId, depth: block.depth, parentType }, createdAt })
    }
  }
  return retained
}

function readCanonicalCrossMoveOriginalOwned(db: Database.Database, input: unknown, hasDependencies: boolean,
  movedReferenceId?: string, batchHost?: EditorRecoveryRecord) {
  if (!db.open || !db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1
    || db.pragma('main.user_version', { simple: true }) !== 27) return fail()
  assertSyncedShape(input, ['operationId', 'requestHash', 'baselineKey', 'baselineHash'])
  const { operationId, requestHash, baselineKey, baselineHash } = input
  if (!isSyncedUuid(operationId) || !sha(requestHash) || !sha(baselineHash) || typeof baselineKey !== 'string'
    || !baselineKey.startsWith(SYNCED_METADATA_BASELINE2_PREFIX)) return fail()

  const point = readSyncedMetadataCaptureRecordOwned2(db, reopenSyncedMetadataCaptureRecordOwned2(db, baselineKey))
  const workspace = new BlockIdentityRepository(db).getWorkspaceIdentity()
  if (point.kind !== 'synced-metadata2-read-baseline-record' || point.recordHash !== baselineHash
    || point.workspaceScope !== workspace.workspaceScope || point.recoveryEpoch !== workspace.recoveryEpoch) return fail()
  const [source] = point.sources, [history] = point.groupHistories
  if (!source || !history || source.wire.id !== history.groupId) return fail()

  const [operation] = readHistoricalTextRows<HistoricalOperationRow>(db, 'synced_operations', operationFields, 'client_operation_id=?', [operationId])
  if (!operation || operation.client_operation_id !== operationId || operation.request_hash !== requestHash
    || Date.parse(point.capturedAt) > Date.parse(operation.created_at)) return fail()
  const receipt = decodeMainHostOperationWithHeadingBirthOwned2(db, operation)
  if ('createdLifecycle' in receipt || !receipt.historyToken || receipt.operationId !== operationId
    || receipt.affectedInstanceIds.length !== 1) return fail()
  const [row] = readHistoricalTextRows<SyncedHostHistoryBranchRow>(db, 'synced_host_history', journalFields, 'id=?', [receipt.historyToken])
  if (!row || row.id !== receipt.historyToken || row.created_at !== operation.created_at
    || readSyncedRecoveryHostCut(db, row.id) || readSyncedExchangeHostCut(db, row.id)) return fail()
  const linked = hasDependencies ? readCanonicalLinkedCrossMoveJournal(row) : undefined
  const batch = batchHost && readCanonicalBatchCrossMoveJournal(row)
  const single = batch ? undefined : linked?.original ?? decodeCrossHostJournal4(row)
  const original = batch?.original ?? single
  if (!original) return fail()
  const initiatingPage = batchHost && batch && readCanonicalBatchInitiatingHost(batch.original, batchHost)
  if (batch && (!initiatingPage || batch.selected.selection.selectedRootIds[0] !== movedReferenceId)) return fail()
  if (original.input.clientOperationId !== operationId || requestHash !== hostHash({ method: 'applySyncedHostCommand', input: original.input })
    || !crossMoveReceiptMatches(receipt, original, row.id) || !matchesCrossMovePlaceholder(db, original, true)
    || movedReferenceId !== undefined && receipt.affectedInstanceIds[0] !== movedReferenceId
    || movedReferenceId !== undefined && single && !matchesCanonicalV4CrossMoveForest(single, movedReferenceId)) return fail()

  const groupId = source.wire.id, instanceId = receipt.affectedInstanceIds[0]
  const dependency = original.groups.find(group => group.groupId === groupId)
  const guard = original.input.groups.find(group => group.groupId === groupId)
  const transfer = original.crossMove.transfers.find(move => move.blockId === instanceId)
  const oldBinding = original.input.expectedInstances.find(instance => instance.instanceId === instanceId)
  const newGroup = receipt.groups.find(group => group.groupId === groupId)
  const [actual] = getSyncedGroupSnapshots(db, { groupIds: [groupId] }).items
  if (!dependency || !guard || !transfer || !oldBinding || !newGroup || actual?.status !== 'ready'
    || !hostEqual(newGroup, actual.snapshot)
    || transfer.from !== oldBinding.hostDocumentId || guard.expectedRevision !== source.revision
    || guard.expectedTopologyRevision !== source.topologyRevision || newGroup.revision !== source.revision
    || newGroup.topologyRevision === source.topologyRevision
    || dependency.creationId !== source.wire.creationId || dependency.createdAt !== source.wire.createdAt
    || !hostEqual(dependency.origin, source.wire.origin)) return fail()
  const wire: SyncedGroupWire = { kind: 'synced-group', id: groupId, creationId: newGroup.creationId, createdAt: newGroup.createdAt,
    origin: newGroup.origin, bindings: newGroup.bindings, blocks: newGroup.blocks }
  if (!hostEqual(wire, source.wire) || !hostEqual(newGroup.history, history.history)) return fail()

  const groupPosition = db.prepare('SELECT history_position AS position FROM synced_groups WHERE id=?').get(groupId) as { position: number } | undefined
  if (groupPosition?.position !== history.position) return fail()
  for (const tail of [history.undoSide, history.redoSide]) {
    if (!tail) continue
    const [actualTail] = readHistoricalExactRows<GroupHistoryRow>(db, 'synced_group_history', groupHistoryFields, 'id=? AND group_id=?', [tail.id, groupId])
    if (!actualTail || hostHash({ kind: 'metadata2-original-group-history-row', row: actualTail }) !== tail.rowHash) return fail()
  }
  const mapped = db.prepare('SELECT document_id FROM synced_host_history_documents WHERE history_id=?').all(row.id) as { document_id: string }[]
  if (mapped.length !== original.persisted.length || mapped.some(mapping => !original.persisted.some(page => page.documentId === mapping.document_id))) return fail()
  const currentHosts = new Map<string, NonNullable<ReturnType<typeof readStrictHostDocument>>>()
  for (const before of original.persisted) {
    const current = readStrictHostDocument(db, before.documentId)
    const after = original.after.find(side => side.documentId === before.documentId)
    const recorded = receipt.hosts.find(side => side.documentId === before.documentId)?.after
    if (!current || !after || !recorded || current.createdAt !== before.createdAt || current.detail.path !== before.path
      || current.detail.updatedAt !== recorded.updatedAt || recorded.updatedAt !== row.created_at
      || !sameHostContent(current.content, after.content) || getSyncedHostHistory(db, { documentId: before.documentId }).undoToken !== row.id) return fail()
    currentHosts.set(before.documentId, current)
  }
  if (single && single.input.action.selection.selectedRootIds.length > 1 && single.crossMove.transfers.some(transfer =>
    currentHosts.get(transfer.to)?.births.get(transfer.blockId) !== transfer.createdAt)) return fail()
  if (batch) {
    const transfers = new Map(batch.original.crossMove.transfers.map(move => [move.blockId, move]))
    const participants = [...currentHosts.keys()]
    for (const move of transfers.values()) if (currentHosts.get(move.to)?.births.get(move.blockId) !== move.createdAt) return fail()
    for (const page of batch.original.persisted) {
      const oldBirths = new Map(page.births.map(birth => [birth.blockId, birth.createdAt]))
      for (const [id, birth] of currentHosts.get(page.documentId)!.births) {
        if (!transfers.has(id) && birth !== (oldBirths.get(id) ?? row.created_at)) return fail()
      }
      assertNoOutsideCrossMoveLinks(db, page.path, batch.original.crossMove.transfers, participants)
    }
  }
  const stationaryPages = batch?.original.persisted ?? (linked?.version === 11 ? linked.dependents : [])
  if (stationaryPages.length) {
    const stationary = stationaryPages.flatMap(page => page.content.blocks.filter(block => block.type === 'synced-block' && block.id !== instanceId)
      .map(block => ({ page, block, groupId: parseSyncedBlockPayload(block.content).groupId })))
    const ids = [...new Set(stationary.map(item => item.groupId))]
    const currentGroups = getSyncedGroupSnapshots(db, { groupIds: ids }).items
    const actual = new Map(currentGroups.flatMap(item => item.status === 'ready' ? [[item.snapshot.groupId, item.snapshot] as const] : []))
    const recorded = new Map(receipt.groups.map(group => [group.groupId, group]))
    const incarnation = new Map(original.groups.map(group => [group.groupId, group]))
    const groupGuards = new Map(original.input.groups.map(guard => [guard.groupId, guard]))
    const instanceGuards = new Map(original.input.expectedInstances.map(guard => [guard.instanceId, guard]))
    const identities = new BlockIdentityRepository(db)
    for (const { page, block, groupId: stationaryGroupId } of stationary) {
      const group = actual.get(stationaryGroupId), stamp = incarnation.get(stationaryGroupId), expectedGroup = groupGuards.get(stationaryGroupId)
      const guard = instanceGuards.get(block.id), binding = group?.instances.find(item => item.instanceId === block.id)
      const birth = page.births.find(item => item.blockId === block.id)?.createdAt
      const physical = identities.get(block.id), parentType = page.content.blocks.find(item => item.id === block.parentBlockId)?.type ?? null
      if (!group || !stamp || !expectedGroup || !birth || !guard || !binding || stationaryGroupId === groupId
        || !hostEqual(group, recorded.get(stationaryGroupId)) || group.creationId !== stamp.creationId || group.createdAt !== stamp.createdAt
        || !hostEqual(group.origin, stamp.origin) || group.revision !== expectedGroup.expectedRevision || group.topologyRevision !== expectedGroup.expectedTopologyRevision
        || guard.hostDocumentId !== page.documentId || binding.hostDocumentId !== page.documentId || binding.bindingVersion !== guard.bindingVersion
        || binding.parentBlockId !== block.parentBlockId || binding.depth !== block.depth || binding.parentType !== parentType
        || currentHosts.get(page.documentId)?.births.get(block.id) !== birth
        || physical?.state !== 'live' || physical.owner.kind !== 'document' || physical.owner.id !== page.documentId || physical.createdAt !== birth) return fail()
    }
  }

  const oldHost = original.persisted.find(page => page.documentId === transfer.from)
  const newHost = currentHosts.get(transfer.to)
  const oldLeaf = oldHost?.content.blocks.find(block => block.id === instanceId)
  const newLeaf = newHost?.content.blocks.find(block => block.id === instanceId)
  const newBinding = newGroup.instances.find(instance => instance.instanceId === instanceId)
  if (!oldHost || !newHost || oldLeaf?.type !== 'synced-block' || newLeaf?.type !== 'synced-block'
    || parseSyncedBlockPayload(oldLeaf.content).groupId !== groupId || newLeaf.content !== oldLeaf.content
    || oldHost.births.find(birth => birth.blockId === instanceId)?.createdAt !== transfer.createdAt
    || newHost.births.get(instanceId) !== transfer.createdAt || !newBinding
    || newBinding.hostDocumentId !== transfer.to || newBinding.bindingVersion === oldBinding.bindingVersion
    || newBinding.parentBlockId !== newLeaf.parentBlockId || newBinding.depth !== newLeaf.depth) return fail()

  const before = { ...oldBinding, hostCreatedAt: oldHost.createdAt, topologyRevision: source.topologyRevision,
    parentBlockId: oldLeaf.parentBlockId, depth: oldLeaf.depth,
    parentType: oldHost.content.blocks.find(block => block.id === oldLeaf.parentBlockId)?.type ?? null }
  const { hostCreatedAt: _hostCreatedAt, topologyRevision: _topologyRevision, ...movedBefore } = before
  let beforeInstances: SyncedInstancePosition[] = [movedBefore]
  let retained: ReturnType<typeof readCanonicalStationaryInstances>
  if (newGroup.instances.length > 1) {
    if (!single) return fail()
    const { selectedRootIds } = single.input.action.selection
    const direct = selectedRootIds.length === 1 && selectedRootIds[0] === instanceId && single.crossMove.transfers.length === 1
    if (!direct && (linked || !matchesCanonicalV4CrossMoveForest(single, instanceId)
      || single.crossMove.transfers.some(move => currentHosts.get(move.to)?.births.get(move.blockId) !== move.createdAt))) return fail()
    retained = readCanonicalStationaryInstances(single, groupId, instanceId)
    const after = new Map(newGroup.instances.map(instance => [instance.instanceId, instance]))
    if (!retained || retained.length !== after.size - 1 || !retained.every(({ position, createdAt }) =>
      (position.hostDocumentId === transfer.to || position.hostDocumentId === transfer.from)
      && hostEqual(position, after.get(position.instanceId)) && currentHosts.get(position.hostDocumentId)?.births.get(position.instanceId) === createdAt)) return fail()
    beforeInstances.push(...retained.map(item => item.position))
    // Match the original SQLite BINARY order of the complete group snapshot.
    const order = db.prepare(`SELECT CAST(key AS INTEGER) AS ordinal FROM json_each(?)
      ORDER BY json_extract(value,'$.hostDocumentId') COLLATE BINARY, json_extract(value,'$.instanceId') COLLATE BINARY`)
      .all(JSON.stringify(beforeInstances)) as Array<{ ordinal: number }>
    beforeInstances = order.map(row => beforeInstances[row.ordinal])
  }
  const version = batch?.version ?? linked?.version ?? 4
  const facts = {
    kind: retained ? `canonical-cross-move-original${version}-multi-instance` as const : `canonical-cross-move-original${version}` as const,
    ...(initiatingPage ? { initiator: { documentId: initiatingPage.documentId, createdAt: initiatingPage.createdAt,
      updatedAt: initiatingPage.updatedAt } } : {}),
    operationId, requestHash, historyToken: row.id,
    baselineKey, baselineHash, workspaceScope: workspace.workspaceScope, recoveryEpoch: workspace.recoveryEpoch,
    groupId, creationId: wire.creationId, createdAt: wire.createdAt, canonicalRevision: newGroup.revision,
    canonicalWireHash: hostHash(wire), canonicalHistory: newGroup.history, canonicalHistoryPosition: history.position,
    instanceCreatedAt: transfer.createdAt,
    before,
    after: { ...newBinding, hostCreatedAt: newHost.createdAt, topologyRevision: newGroup.topologyRevision },
    ...(retained ? { retainedInstances: retained } : {}),
    originalJournalHash: hostHash(row), originalReceiptHash: hostHash(operation), writePermit: false as const
  }
  return { ...facts, proofHash: hostHash(facts), beforeInstances }
}
