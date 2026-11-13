import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { readRawCapsule2ContentOwned } from './restore-knowledge-capsule2-content-raw-read'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { assertOriginCatalogDirectory, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { assertRootRestoreStage3FilesHeld3, closeRootRestoreStage3FilesHeld3, holdRootRestoreStage3DatabaseFiles3,
  verifyRootRestoreStage3FilesHeld3 } from './restore-knowledge-stage3-files'
import { assertRootRestoreStage3DatabaseReadonly3, copyRootRestoreStage3Database3,
  holdRootRestorePhysicalStageOriginalBytes3, readRootRestoreStage3HistoryPreimage3,
  type RootRestorePhysicalStage3 } from './restore-knowledge-stage3-physical'
import { assertRestorePath, restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { readSyncedExchangeCutJournal } from './synced-exchange-host-cut'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { recoveryBoundaryHash, recoveryEpochRequestHash, recoveryOperationRowHash, validateSyncedRecoveryEpochReceipt,
  validateSyncedRecoveryHistoryBoundary } from './synced-recovery-boundary-model'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'

type Preimage = Awaited<ReturnType<typeof readRootRestoreStage3HistoryPreimage3>>
type Locator = { readonly evidenceId: string; readonly expectedManifestHash: string }
type GroupGuard = ReturnType<typeof groupGuard>
const fail = (reason: string): never => { throw new Error('Root3 历史切点证据失败：' + reason) }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const text = (value: unknown): string => typeof value === 'string' ? value : fail('原单元格不是 TEXT')
const position = (value: unknown): number => typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
  ? Number(value) : fail('原历史位置不是安全整数')
const collection = ({ copy }: Preimage) => join(copy.profileRoot, 'backups', 'database-restore', copy.operationId,
  'restore-history-boundary-evidence-v1')

function groupGuard(row: Record<string, unknown>) {
  return { revision: text(row.revision), topologyRevision: text(row.topology_revision),
    historyCursor: text(row.history_cursor), historyPosition: position(row.history_position) }
}

function allocatedGuard(guard: Omit<GroupGuard, 'historyPosition'> & { historyPosition: string }): GroupGuard {
  return { ...guard, historyPosition: position(BigInt(guard.historyPosition)) }
}

function observe(db: Database.Database, { copy, retainedCut, value, stageManifestHash }: Preimage) {
  const raw = readRawCapsule2ContentOwned(db)
  if (raw.schemaVersion !== 27 || raw.encoding !== retainedCut.encoding) return fail('原 current schema/encoding 不同')
  const originalTables = new Map(raw.tables.map(table => [table.name, table]))
  for (const { table, rows, rawTableHash } of retainedCut.archiveTables) {
    const original = originalTables.get(table)
    if (!original || original.rows.length !== rows
      || capsuleBytesHash('knowbook.restore.stage3.retained-cut.original-table.v1\0' + capsuleJson(original)) !== rawTableHash)
      return fail('原 current 切点支持表不同：' + table)
  }
  const prior = assertSyncedRecoveryBoundaryRecords(db)
  if (prior.boundaries.has(copy.operationId)) return fail('原 current 已有本次 operation 的恢复边界')
  const { allocation } = retainedCut
  const [workspace] = graph3Rows(raw, 'synced_workspace_state')
  if (workspace?.value.workspace_scope !== allocation.workspace.workspaceScope
    || workspace.value.recovery_epoch !== allocation.workspace.beforeEpoch) return fail('原 current scope/epoch 不闭合')

  const originalRows = (name: string, key: string) => new Map(graph3Rows(raw, name).map(row => [text(row.value[key]), row]))
  const originalDocuments = originalRows('documents', 'id')
  const originalHosts = originalRows('synced_host_history_state', 'document_id')
  const originalGroups = originalRows('synced_groups', 'id')
  const originalInstances = originalRows('synced_instances', 'instance_id')
  const documents = new Map(allocation.documents.map(row => [row.documentId, row]))
  const hosts = new Map(allocation.hosts.map(row => [row.documentId, row]))
  const groups = new Map(allocation.groups.map(row => [row.groupId, row]))
  const instances = new Map(allocation.instances.map(row => [row.instanceId, row]))
  const differences = (family: string, original: ReadonlyMap<string, unknown>, target: ReadonlyMap<string, unknown>) => ({
    family, added: [...target.keys()].filter(id => !original.has(id)).sort(compare),
    removed: [...original.keys()].filter(id => !target.has(id)).sort(compare)
  })
  const uncovered = [differences('documents', originalDocuments, documents), differences('hosts', originalHosts, hosts),
    differences('groups', originalGroups, groups), differences('instances', originalInstances, instances)]
  const scopeChanged = [...originalInstances].filter(([id, row]) => {
    const target = instances.get(id)
    return target && (target.groupId !== row.value.group_id || target.hostDocumentId !== row.value.host_document_id)
  }).map(([id]) => id).sort(compare)

  const groupsById = value.tables.find(table => table.name === 'synced_groups') ?? fail('缺已验证的 Stage3 组表')
  const finalGroups = new Map(groupsById.rows.map(row => [row.targetRowId, row.cells]))
  const lifecycles = readSyncedGroupLifecycles(db, [...originalGroups.keys()])
  const deletions = assertSyncedLogicalDeletionRecords(db)
  const originalHistory = new Map<string, ReturnType<typeof readGroupHistory>[]>()
  for (const { value: row } of graph3Rows(raw, 'synced_group_history')) {
    const history = readGroupHistory(row)
    const rows = originalHistory.get(history.group_id) ?? []
    rows.push(history)
    originalHistory.set(history.group_id, rows)
  }
  const mappings = new Map<string, Array<{ documentId: string; position: number }>>()
  for (const { value: row } of graph3Rows(raw, 'synced_host_history_documents')) {
    const token = text(row.history_id), participants = mappings.get(token) ?? []
    participants.push({ documentId: text(row.document_id), position: position(row.position) })
    mappings.set(token, participants)
  }
  const hostCuts = [...mappings].sort(([a], [b]) => compare(a, b)).map(([historyToken, participants]) => ({
    historyToken, ...readSyncedExchangeCutJournal(db, historyToken),
    mappings: participants.sort((a, b) => compare(a.documentId, b.documentId))
  }))
  const retainedOperations = graph3Rows(raw, 'synced_operations').map(({ value: row }) => ({
    operationId: text(row.client_operation_id), rowHash: recoveryOperationRowHash({
      client_operation_id: text(row.client_operation_id), request_hash: text(row.request_hash),
      result_json: text(row.result_json), created_at: text(row.created_at)
    })
  })).sort((a, b) => compare(a.operationId, b.operationId))
  const retainedPins = graph3Rows(raw, 'synced_group_pins').map(({ value: row }) => ({
    groupId: text(row.group_id), kind: text(row.kind), pinId: text(row.pin_id), createdAt: text(row.created_at)
  })).sort((a, b) => compare(capsuleJson([a.groupId, a.kind, a.pinId]), capsuleJson([b.groupId, b.kind, b.pinId])))

  const oldDocuments = [...originalDocuments].sort(([a], [b]) => compare(a, b)).flatMap(([documentId, before]) => {
    const after = documents.get(documentId)
    if (!after) return []
    const beforeUpdatedAt = text(before.value.updated_at)
    if (after.currentSourceRowId !== before.original.sourceRowId || after.beforeUpdatedAt !== beforeUpdatedAt
      || after.afterUpdatedAt !== allocation.documentBoundary) return fail('文档原行/CAS 与切点不闭合')
    return [{ documentId, beforeUpdatedAt, afterUpdatedAt: after.afterUpdatedAt }]
  })
  const oldHosts = [...originalHosts].sort(([a], [b]) => compare(a, b)).flatMap(([documentId, before]) => {
    const after = hosts.get(documentId)
    if (!after) return []
    const beforeCursor = text(before.value.cursor), beforePosition = position(before.value.position)
    if (after.targetRowId !== before.original.sourceRowId || after.beforeCursor !== beforeCursor
      || after.beforePosition !== String(beforePosition) || after.afterPosition !== '0') return fail('原宿主 rowid/cursor/position 与切点不闭合')
    return [{ documentId, beforeCursor, beforePosition, afterCursor: after.afterCursor }]
  })
  const changedGroupDispositions: string[] = []
  const oldGroups = [...originalGroups].sort(([a], [b]) => compare(a, b)).flatMap(([groupId, row]) => {
    const target = groups.get(groupId)
    if (!target) return []
    const before = groupGuard(row.value), after = allocatedGuard(target.after), lifecycle = lifecycles.get(groupId)
    const final = finalGroups.get(target.targetRowId)
    if (!target.beforeCurrent || target.currentSourceRowId !== row.original.sourceRowId
      || !same(allocatedGuard(target.beforeCurrent), before) || !lifecycle || !final || after.historyPosition !== 0)
      return fail('原组 rowid/guard/lifecycle 与切点不闭合')
    for (const column of ['id', 'creation_id', 'created_at', 'origin_json']) {
      if (!same(final[groupsById.columns.indexOf(column)], row.original.cells[row.table.columns.indexOf(column)]))
        return fail('原组完整 immutable tuple 与最终 SQL 不同')
    }
    const disposition = deletions.has('group:' + groupId) ? 'deleted-evidence' as const
      : lifecycle.state === 'retired-create' ? 'retired-evidence' as const : 'active' as const
    if ((target.disposition === 'active') !== (disposition === 'active')) changedGroupDispositions.push(groupId)
    return [{ groupId, creationId: text(row.value.creation_id), createdAt: text(row.value.created_at), originJson: text(row.value.origin_json),
      disposition, before, after, rows: (originalHistory.get(groupId) ?? []).sort((a, b) => a.position - b.position) }]
  })
  const oldInstances = [...originalInstances].sort(([a], [b]) => compare(a, b)).flatMap(([instanceId, row]) => {
    const target = instances.get(instanceId)
    if (!target) return []
    const beforeBindingVersion = text(row.value.binding_version)
    if (target.currentSourceRowId !== row.original.sourceRowId || target.beforeBindingVersion !== beforeBindingVersion)
      return fail('原实例 rowid/binding 与切点不闭合')
    return [{ instanceId, groupId: text(row.value.group_id), hostDocumentId: text(row.value.host_document_id),
      beforeBindingVersion, afterBindingVersion: target.afterBindingVersion }]
  })
  const currentHistory = { documents: oldDocuments, hosts: oldHosts, hostCuts, groups: oldGroups, instances: oldInstances,
    retainedOperations, retainedPins }
  const canRepresentCurrent = !uncovered.some(row => row.removed.length) && !scopeChanged.length && !changedGroupDispositions.length
    && Boolean(oldHosts.length || hostCuts.length || oldGroups.length || oldInstances.length)
  const boundary = canRepresentCurrent ? validateSyncedRecoveryHistoryBoundary({
    kind: 'synced-recovery-history-boundary', version: 1, operationId: copy.operationId,
    ...allocation.workspace, acceptedAt: retainedCut.context.preparedAt, documentBoundary: allocation.documentBoundary,
    ...currentHistory
  }) : null
  const receipt = boundary ? validateSyncedRecoveryEpochReceipt({
    kind: 'synced-recovery-epoch', version: 1, operationId: boundary.operationId, workspaceScope: boundary.workspaceScope,
    beforeEpoch: boundary.beforeEpoch, afterEpoch: boundary.afterEpoch, boundaryHash: recoveryBoundaryHash(boundary),
    acceptedAt: boundary.acceptedAt
  }) : null
  return {
    operationId: copy.operationId, stageId: retainedCut.context.stageId, stageManifestHash,
    physicalObservationHash: value.physicalObservationHash, currentCopyManifestHash: copy.manifestHash,
    originalInventoryHash: copy.value.originalInventoryHash, retainedCutHash: retainedCut.cutHash,
    retainedCutRecordHash: retainedCut.record.hash, retainedArchiveTables: retainedCut.archiveTables,
    proposedBoundary: boundary, proposedReceipt: receipt, proposedEpochRequestHash: receipt ? recoveryEpochRequestHash(receipt) : null,
    unresolvedCurrentHistory: boundary ? null : currentHistory, uncovered, changedInstanceOwners: scopeChanged, changedGroupDispositions,
    noCurrentSyncHistory: !originalHosts.size && !hostCuts.length && !originalGroups.size && !originalInstances.size,
    historyCutComplete: false as const, acceptedCoverage: false as const, effective: false as const, installPermit: false as const
  }
}

function readGroupHistory(row: Record<string, unknown>) {
  return { id: text(row.id), group_id: text(row.group_id), position: position(row.position),
    before_json: text(row.before_json), after_json: text(row.after_json), before_hash: text(row.before_hash),
    after_hash: text(row.after_hash), created_at: text(row.created_at) }
}

async function readCurrent(preimage: Preimage) {
  const { copy } = preimage, { profileRoot, databaseDirectory } = copy, inventory = copy.value.originalInventory
  const probe = join(profileRoot, 'backups', 'database-restore', copy.operationId, 'history-evidence-probe-' + randomUUID())
  await copyRootRestoreStage3Database3(databaseDirectory, probe, profileRoot, inventory)
  const identity = await assertOriginCatalogDirectory(probe, profileRoot)
  const db = new Database(restoreSqliteFilename(join(probe, 'knowbook.db')), { readonly: true, fileMustExist: true })
  let result: ReturnType<typeof observe>
  try {
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=ON')
    result = db.transaction(() => observe(db, preimage))()
  } finally { db.close() }
  // Readonly SQLite can create an empty WAL and a shared-memory sidecar.
  // Only clean the validated post-read inventory of a successful probe.
  const observedInventory = await assertRootRestoreStage3DatabaseReadonly3(probe, profileRoot, inventory)
  const current = await assertOriginCatalogDirectory(probe, profileRoot)
  if (current.dev !== identity.dev || current.ino !== identity.ino) return fail('独立 SQL 检查目录身份变化')
  for (const entry of observedInventory) if (entry.present) {
    const file = join(probe, entry.name)
    await assertRestorePath(file, probe)
    await unlink(file)
  }
  await rmdir(probe)
  return result
}

async function evidence(stage: RootRestorePhysicalStage3, evidenceId: string, expectedHash?: string) {
  const physical = await holdRootRestorePhysicalStageOriginalBytes3(stage)
  try {
    const preimage = await readRootRestoreStage3HistoryPreimage3(stage)
    const { copy } = preimage, root = copy.profileRoot, base = collection(preimage)
    const directory = join(base, evidenceId), path = join(directory, 'manifest.json')
    const stored = expectedHash === undefined ? null : await readCapsule2AssetManifest(path, root, CAPSULE2_RAW_MAX_JSON_BYTES)
    if (stored !== null && capsuleBytesHash(stored) !== expectedHash) return fail('冷证据清单哈希不同')
    const current = await holdRootRestoreStage3DatabaseFiles3({ profileRoot: root, databaseDirectory: copy.databaseDirectory,
      inventory: copy.value.originalInventory })
    try {
      const facts = await readCurrent(preimage)
      const value = freezeCapsuleValue({ kind: 'root-restore-non-executable-history-evidence-v1' as const, version: 1 as const, evidenceId, ...facts })
      const text = capsuleJson(value) + '\n', manifestHash = capsuleBytesHash(text)
      if (Buffer.byteLength(text) > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('完整切点证据超预算，不能截断')
      if (stored === null) {
        await restoreDirectory(base, root)
        await restoreDirectory(directory, root, true)
        await writeCapsule2AssetCopy(path, Buffer.from(text), root)
        await syncRestoreDirectory(directory)
        await syncOriginCatalogAncestors(base, root)
      } else if (stored !== text) return fail('冷证据不等于实际原 current 与 Stage3 切点')
      if (!same((await readdir(directory)).sort(), ['manifest.json'])
        || await readCapsule2AssetManifest(path, root, CAPSULE2_RAW_MAX_JSON_BYTES) !== text) return fail('切点证据原件变化')
      await verifyRootRestoreStage3FilesHeld3(current)
      await verifyRootRestoreStage3FilesHeld3(physical)
      assertRootRestoreStage3FilesHeld3(current)
      assertRootRestoreStage3FilesHeld3(physical)
      return Object.freeze({ evidenceId, manifestHash, directory, value })
    } finally { closeRootRestoreStage3FilesHeld3(current) }
  } finally { closeRootRestoreStage3FilesHeld3(physical) }
}

/** This candidate seals the preimage only. It does not add B, R, or C to SQL. */
export function prepareRootRestoreHistoryBoundaryCandidate3(stage: RootRestorePhysicalStage3) {
  return evidence(stage, randomUUID())
}

export function reopenRootRestoreHistoryBoundaryCandidate3(stage: RootRestorePhysicalStage3, input: Locator) {
  const locator = capsuleRecord(input, ['evidenceId', 'expectedManifestHash'])
  return evidence(stage, durableSqlDagUuid(locator.evidenceId), durableSqlDagHash(locator.expectedManifestHash))
}
