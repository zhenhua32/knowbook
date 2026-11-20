import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { observeRawCapsule2TablesOwned } from './restore-knowledge-capsule2-content-raw-read'
import { CAPSULE2_RAW_MAX_JSON_BYTES, hashValidatedCapsule2RawSqlTable, type Capsule2Encoding } from './restore-knowledge-capsule2-raw-model'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { graph3Value } from './restore-knowledge-graph3-data'
import { assertOriginCatalogDirectory, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { assertRootRestoreStage3FilesHeld3, closeRootRestoreStage3FilesHeld3, holdRootRestoreStage3DatabaseFiles3,
  verifyRootRestoreStage3FilesHeld3 } from './restore-knowledge-stage3-files'
import { assertRootRestoreStage3DatabaseReadonly3, copyRootRestoreStage3Database3,
  holdRootRestorePhysicalStageOriginalBytes3, readRootRestoreStage3HistoryPreimage3, retainedGroupIdentityColumns3,
  type RootRestorePhysicalStage3, type PreparedRestoreHistoryScope3 } from './restore-knowledge-stage3-physical'
import { assertRestorePath, restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { assertEmptyRestoreKnowledge, auditRestoreKnowledgeConnection, readRestoreKnowledgeCapture } from './restore-safety-knowledge'
import { readRawPriorKnowledgeCoverageOwned } from './restore-knowledge-coverage-raw-read'
import type { CoverageCutReference } from './restore-knowledge-coverage-model'
import { readSyncedExchangeCutJournal } from './synced-exchange-host-cut'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { readV3SourceGroupRetirementsOwned } from './v3-source-group-retirement'
import { recoveryBoundaryHash, recoveryEpochRequestHash, recoveryOperationRowHash, validateSyncedRecoveryEpochReceipt,
  validateSyncedRecoveryHistoryBoundary, type SyncedRecoveryRemovedInstance } from './synced-recovery-boundary-model'
import { assertSyncedRecoveryBoundaryRecords, isRetainedProtocol5Operation } from './synced-recovery-boundary-read'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from './restore-knowledge-sql-cell'

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

const historyFields = new Map<string, readonly string[]>([
  ['documents', ['id', 'updated_at']],
  ['synced_workspace_state', ['workspace_scope', 'recovery_epoch']],
  ['synced_host_history_state', ['document_id', 'cursor', 'position']],
  ['synced_groups', [...retainedGroupIdentityColumns3, 'revision', 'topology_revision', 'history_cursor', 'history_position']],
  ['synced_instances', ['instance_id', 'group_id', 'host_document_id', 'binding_version', 'parent_block_id', 'depth']],
  ['synced_group_history', ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at']],
  ['synced_host_history_documents', ['history_id', 'document_id', 'position']],
  ['synced_group_pins', ['group_id', 'kind', 'pin_id', 'created_at']],
  ['synced_operations', ['client_operation_id', 'request_hash', 'result_json', 'created_at']]
])

type ObservedRow = { sourceRowId: string; value: Record<string, unknown>; groupCells?: readonly RawRestoreSqlCell[] }
function readHistoryOriginals(db: Database.Database, retainedCut: Preimage['retainedCut']) {
  const archives = new Map<string, typeof retainedCut.archiveTables[number]>(retainedCut.archiveTables.map(archive => [archive.table, archive]))
  const projected = new Map<string, ObservedRow[]>()
  const rows = (name: string): readonly ObservedRow[] => projected.get(name) ?? []
  const structuralHistory = () => Boolean(rows('synced_host_history_state').length || rows('synced_host_history_documents').length
    || rows('synced_groups').length || rows('synced_instances').length)
  const retainedOperations: Array<{ operationId: string; rowHash: string }> = []
  let operationOnly = false
  const header = observeRawCapsule2TablesOwned(db, (table, encoding) => {
    const archive = archives.get(table.name)
    const columns = historyFields.get(table.name), selected: ObservedRow[] = []
    const indexes = columns?.map(column => {
      const index = table.columns.indexOf(column)
      return index < 0 ? fail('原历史见证缺列：' + table.name + '.' + column) : index
    })
    let count = 0
    const stream = function* () {
      for (const row of table.rows) {
        count++
        if (columns && indexes) {
          const value = Object.fromEntries(columns.map((column, ordinal) => [column, graph3Value(row.cells[indexes[ordinal]], encoding)]))
          if (table.name === 'synced_operations') {
            const operation = { client_operation_id: text(value.client_operation_id), request_hash: text(value.request_hash),
              result_json: text(value.result_json), created_at: text(value.created_at) }
            retainedOperations.push({ operationId: operation.client_operation_id, rowHash: recoveryOperationRowHash(operation) })
            // The fixed raw catalog visits the group, host and instance
            // tables before operations in lexical order.
            if (!operationOnly && !structuralHistory())
              operationOnly = isRetainedProtocol5Operation(db, operation, retainedCut.allocation.workspace.workspaceScope)
          } else {
            const groupCells = table.name === 'synced_groups' ? indexes.slice(0, retainedGroupIdentityColumns3.length).map(index => row.cells[index]) : undefined
            selected.push({ sourceRowId: row.sourceRowId, value, groupCells })
          }
        }
        yield row
      }
    }()
    // Exhaust the real ordered SQLite rows independently of the candidate.
    // Only the declared history projection survives the complete raw hash.
    if (archive) {
      const hash = hashValidatedCapsule2RawSqlTable('knowbook.restore.stage3.retained-cut.original-table.v1', { ...table, rows: stream })
      if (hash !== archive.rawTableHash || count !== archive.rows) return fail('原 current 切点支持表不同：' + table.name)
      archives.delete(archive.table)
    } else for (const _row of stream) { /* All table rows count toward the original raw budget. */ }
    if (columns) projected.set(table.name, selected)
  })
  for (const table of archives.keys()) return fail('原 current 切点支持表不同：' + table)
  retainedOperations.sort((left, right) => compare(left.operationId, right.operationId))
  return { header, rows, retainedOperations, operationOnly, hasStructuralHistory: structuralHistory() }
}

const removedMirrorColumns = {
  blocks: ['type', 'document_id', 'depth', 'parent_block_id', 'content', 'created_at'],
  block_identities: ['last_owner_kind', 'last_owner_id', 'state', 'created_at']
} as const
function readRemovedMirror(db: Database.Database, table: keyof typeof removedMirrorColumns, id: string, encoding: Capsule2Encoding) {
  const columns = removedMirrorColumns[table]
  const projection = columns.flatMap(column => ['typeof(' + column + ')', 'CASE WHEN typeof(' + column + ")='text' THEN CAST(" + column + ' AS BLOB) ELSE ' + column + ' END'])
  const row = db.prepare('SELECT ' + projection.join(',') + ' FROM main.' + table + ' WHERE id=? COLLATE BINARY')
    .safeIntegers(true).raw(true).get(id) as unknown[] | undefined
  return row && Object.fromEntries(columns.map((column, index) => [column,
    graph3Value(rawRestoreSqlCell(row[index * 2], row[index * 2 + 1], encoding), encoding)]))
}

function groupGuard(row: Record<string, unknown>) {
  return { revision: text(row.revision), topologyRevision: text(row.topology_revision),
    historyCursor: text(row.history_cursor), historyPosition: position(row.history_position) }
}

function allocatedGuard(guard: Omit<GroupGuard, 'historyPosition'> & { historyPosition: string }): GroupGuard {
  return { ...guard, historyPosition: position(BigInt(guard.historyPosition)) }
}

function observe(db: Database.Database, { copy, retainedCut, physicalObservationHash, finalGroups, finalInstanceIds, stageManifestHash }: Preimage,
  allowInstanceRemoval: boolean, allowOrdinaryCut: boolean) {
  const { header, rows, retainedOperations, operationOnly, hasStructuralHistory } = readHistoryOriginals(db, retainedCut)
  if (header.schemaVersion !== 27 || header.encoding !== retainedCut.encoding) return fail('原 current schema/encoding 不同')
  const prior = assertSyncedRecoveryBoundaryRecords(db)
  if (prior.boundaries.has(copy.operationId)) return fail('原 current 已有本次 operation 的恢复边界')
  const { allocation } = retainedCut
  const [workspace] = rows('synced_workspace_state')
  if (workspace?.value.workspace_scope !== allocation.workspace.workspaceScope
    || workspace.value.recovery_epoch !== allocation.workspace.beforeEpoch) return fail('原 current scope/epoch 不闭合')

  const originalRows = (name: string, key: string) => new Map(rows(name).map(row => [text(row.value[key]), row]))
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

  const groupsById = new Map(finalGroups.map(row => [row.targetRowId, row.cells]))
  const lifecycles = readSyncedGroupLifecycles(db, [...originalGroups.keys()])
  const deletions = assertSyncedLogicalDeletionRecords(db)
  const sourceRetirements = readV3SourceGroupRetirementsOwned(db)
  const originalHistory = new Map<string, ReturnType<typeof readGroupHistory>[]>()
  for (const { value: row } of rows('synced_group_history')) {
    const history = readGroupHistory(row)
    const rows = originalHistory.get(history.group_id) ?? []
    rows.push(history)
    originalHistory.set(history.group_id, rows)
  }
  const mappings = new Map<string, Array<{ documentId: string; position: number }>>()
  for (const { value: row } of rows('synced_host_history_documents')) {
    const token = text(row.history_id), participants = mappings.get(token) ?? []
    participants.push({ documentId: text(row.document_id), position: position(row.position) })
    mappings.set(token, participants)
  }
  const hostCuts = [...mappings].sort(([a], [b]) => compare(a, b)).map(([historyToken, participants]) => ({
    historyToken, ...readSyncedExchangeCutJournal(db, historyToken),
    mappings: participants.sort((a, b) => compare(a.documentId, b.documentId))
  }))
  const retainedPins = rows('synced_group_pins').map(({ value: row }) => ({
    groupId: text(row.group_id), kind: text(row.kind), pinId: text(row.pin_id), createdAt: text(row.created_at)
  })).sort((a, b) => compare(capsuleJson([a.groupId, a.kind, a.pinId]), capsuleJson([b.groupId, b.kind, b.pinId])))

  const oldDocuments = [...originalDocuments].sort(([a], [b]) => compare(a, b)).flatMap(([documentId, before]) => {
    const after = documents.get(documentId)
    if (!after) return []
    const beforeUpdatedAt = text(before.value.updated_at)
    if (after.currentSourceRowId !== before.sourceRowId || after.beforeUpdatedAt !== beforeUpdatedAt
      || after.afterUpdatedAt !== allocation.documentBoundary) return fail('文档原行/CAS 与切点不闭合')
    return [{ documentId, beforeUpdatedAt, afterUpdatedAt: after.afterUpdatedAt }]
  })
  const retainedDeletedHostIds = new Set(retainedCut.retainedDeletedHostIds)
  const oldHosts = [...originalHosts].sort(([a], [b]) => compare(a, b)).flatMap(([documentId, before]) => {
    const after = hosts.get(documentId)
    if (!after) return []
    const beforeCursor = text(before.value.cursor), beforePosition = position(before.value.position)
    if (after.targetRowId !== before.sourceRowId || after.beforeCursor !== beforeCursor
      || after.beforePosition !== String(beforePosition) || after.afterPosition !== '0') return fail('原宿主 rowid/cursor/position 与切点不闭合')
    if (retainedDeletedHostIds.has(documentId)
      && (!deletions.has('doc:' + documentId) || originalDocuments.has(documentId) || documents.has(documentId)))
      return fail('保留墓碑宿主缺准确原 SQLite 删除证明')
    return [{ documentId, beforeCursor, beforePosition, afterCursor: after.afterCursor }]
  })
  const changedGroupDispositions: string[] = []
  const oldGroups = [...originalGroups].sort(([a], [b]) => compare(a, b)).flatMap(([groupId, row]) => {
    const target = groups.get(groupId)
    if (!target) return []
    const before = groupGuard(row.value), after = allocatedGuard(target.after), lifecycle = lifecycles.get(groupId)
    const final = groupsById.get(target.targetRowId)
    if (!target.beforeCurrent || target.currentSourceRowId !== row.sourceRowId
      || !same(allocatedGuard(target.beforeCurrent), before) || !lifecycle || !final || after.historyPosition !== 0)
      return fail('原组 rowid/guard/lifecycle 与切点不闭合')
    if (!same(final, row.groupCells)) return fail('原组完整 immutable tuple 与最终 SQL 不同')
    const disposition = deletions.has('group:' + groupId) || sourceRetirements.has(groupId) ? 'deleted-evidence' as const
      : lifecycle.state === 'retired-create' ? 'retired-evidence' as const : 'active' as const
    if ((target.disposition === 'active') !== (disposition === 'active')) changedGroupDispositions.push(groupId)
    return [{ groupId, creationId: text(row.value.creation_id), createdAt: text(row.value.created_at), originJson: text(row.value.origin_json),
      disposition, before, after, rows: (originalHistory.get(groupId) ?? []).sort((a, b) => a.position - b.position) }]
  })
  const oldInstances = [...originalInstances].sort(([a], [b]) => compare(a, b)).flatMap(([instanceId, row]) => {
    const target = instances.get(instanceId)
    if (!target) return []
    const beforeBindingVersion = text(row.value.binding_version)
    if (target.currentSourceRowId !== row.sourceRowId || target.beforeBindingVersion !== beforeBindingVersion)
      return fail('原实例 rowid/binding 与切点不闭合')
    return [{ instanceId, groupId: text(row.value.group_id), hostDocumentId: text(row.value.host_document_id),
      beforeBindingVersion, afterBindingVersion: target.afterBindingVersion }]
  })
  const instanceChanges: SyncedRecoveryRemovedInstance[] = []
  const removedInstances = uncovered.find(row => row.family === 'instances')?.removed ?? []
  if (allowInstanceRemoval && removedInstances.length) {
    const remainingIds = new Set(finalInstanceIds)
    for (const instanceId of removedInstances) {
      const instance = originalInstances.get(instanceId) ?? fail('移除实例缺原 SQL 行')
      const block = readRemovedMirror(db, 'blocks', instanceId, header.encoding)
      const ledger = readRemovedMirror(db, 'block_identities', instanceId, header.encoding)
      const groupId = text(instance.value.group_id), hostDocumentId = text(instance.value.host_document_id)
      if (!block || block.type !== 'synced-block' || block.document_id !== hostDocumentId || block.depth !== instance.value.depth
        || block.parent_block_id !== instance.value.parent_block_id || parseSyncedBlockPayload(text(block.content)).groupId !== groupId
        || !ledger || ledger.last_owner_kind !== 'document' || ledger.last_owner_id !== hostDocumentId || ledger.state !== 'live'
        || ledger.created_at !== block.created_at || remainingIds.has(instanceId)) return fail('移除实例的原镜像、出生或目标 SQL 不闭合')
      instanceChanges.push({ instanceId, createdAt: text(block.created_at), before: { groupId, hostDocumentId,
        bindingVersion: text(instance.value.binding_version), rowId: instance.sourceRowId,
        parentBlockId: instance.value.parent_block_id === null ? null : text(instance.value.parent_block_id),
        depth: position(instance.value.depth) }, after: null })
    }
  }
  const currentHistory = { documents: oldDocuments, hosts: oldHosts, hostCuts, groups: oldGroups, instances: oldInstances,
    retainedOperations, retainedPins }
  const canRepresentCurrent = !uncovered.some(row => row.removed.length && (row.family !== 'instances' || !allowInstanceRemoval))
    && !scopeChanged.length && !changedGroupDispositions.length
    && Boolean(oldHosts.length || hostCuts.length || oldGroups.length || oldInstances.length || operationOnly)
  const boundary = canRepresentCurrent ? validateSyncedRecoveryHistoryBoundary({
    kind: 'synced-recovery-history-boundary', operationId: copy.operationId,
    ...allocation.workspace, acceptedAt: retainedCut.context.preparedAt, documentBoundary: allocation.documentBoundary,
    ...currentHistory, ...(instanceChanges.length ? { version: 2, instanceChanges } : { version: 1 })
  }) : null
  const receipt = boundary ? validateSyncedRecoveryEpochReceipt({
    kind: 'synced-recovery-epoch', version: 1, operationId: boundary.operationId, workspaceScope: boundary.workspaceScope,
    beforeEpoch: boundary.beforeEpoch, afterEpoch: boundary.afterEpoch, boundaryHash: recoveryBoundaryHash(boundary),
    acceptedAt: boundary.acceptedAt
  }) : null
  let ordinaryCut: Extract<CoverageCutReference, { kind: 'ordinary-empty-epoch-cut' }> | undefined
  const noCurrentSyncHistory = !hasStructuralHistory && !operationOnly
  if (allowOrdinaryCut && noCurrentSyncHistory) {
    const capture = auditRestoreKnowledgeConnection(db)
    assertEmptyRestoreKnowledge(db, capture)
    const diagnostic = readRestoreKnowledgeCapture(capture), coverage = readRawPriorKnowledgeCoverageOwned(db)
    if (!diagnostic || diagnostic.schemaVersion !== header.schemaVersion || diagnostic.workspaceScope !== header.workspaceScope
      || diagnostic.recoveryEpoch !== header.recoveryEpoch || prior.boundaries.size || coverage.entries.length)
      return fail('普通切点必须由真实原 current 空史和原 scope/epoch 证明')
    ordinaryCut = { kind: 'ordinary-empty-epoch-cut', version: 1, operationId: copy.operationId,
      beforeWorkspaceScope: allocation.workspace.workspaceScope, afterWorkspaceScope: allocation.workspace.workspaceScope,
      beforeEpoch: allocation.workspace.beforeEpoch, afterEpoch: allocation.workspace.afterEpoch,
      documentBoundary: allocation.documentBoundary, acceptedAt: retainedCut.context.preparedAt }
  }
  return {
    operationId: copy.operationId, stageId: retainedCut.context.stageId, stageManifestHash,
    physicalObservationHash, currentCopyManifestHash: copy.manifestHash,
    originalInventoryHash: copy.value.originalInventoryHash, retainedCutHash: retainedCut.cutHash,
    retainedCutRecordHash: retainedCut.recordHash, retainedArchiveTables: retainedCut.archiveTables,
    proposedBoundary: boundary, proposedReceipt: receipt, proposedEpochRequestHash: receipt ? recoveryEpochRequestHash(receipt) : null,
    unresolvedCurrentHistory: boundary ? null : currentHistory, uncovered, changedInstanceOwners: scopeChanged, changedGroupDispositions,
    noCurrentSyncHistory, ...(ordinaryCut ? { ordinaryCut } : {}),
    historyCutComplete: false as const, acceptedCoverage: false as const, effective: false as const, installPermit: false as const
  }
}

function readGroupHistory(row: Record<string, unknown>) {
  return { id: text(row.id), group_id: text(row.group_id), position: position(row.position),
    before_json: text(row.before_json), after_json: text(row.after_json), before_hash: text(row.before_hash),
    after_hash: text(row.after_hash), created_at: text(row.created_at) }
}

async function readCurrent(preimage: Preimage, allowInstanceRemoval: boolean, allowOrdinaryCut: boolean) {
  const { copy } = preimage, { profileRoot, databaseDirectory } = copy, inventory = copy.value.originalInventory
  const probe = join(profileRoot, 'backups', 'database-restore', copy.operationId, 'history-evidence-probe-' + randomUUID())
  await copyRootRestoreStage3Database3(databaseDirectory, probe, profileRoot, inventory)
  const identity = await assertOriginCatalogDirectory(probe, profileRoot)
  const db = new Database(restoreSqliteFilename(join(probe, 'knowbook.db')), { readonly: true, fileMustExist: true })
  let result: ReturnType<typeof observe>
  try {
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=ON')
    result = db.transaction(() => observe(db, preimage, allowInstanceRemoval, allowOrdinaryCut))()
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

async function evidence(stage: RootRestorePhysicalStage3, evidenceId: string, expectedHash?: string, allowOrdinaryCut = false,
  historyScope?: PreparedRestoreHistoryScope3) {
  const physical = await holdRootRestorePhysicalStageOriginalBytes3(stage)
  try {
    const preimage = await readRootRestoreStage3HistoryPreimage3(stage, historyScope)
    const { copy } = preimage, root = copy.profileRoot, base = collection(preimage)
    const directory = join(base, evidenceId), path = join(directory, 'manifest.json')
    const stored = expectedHash === undefined ? null : await readCapsule2AssetManifest(path, root, CAPSULE2_RAW_MAX_JSON_BYTES)
    if (stored !== null && capsuleBytesHash(stored) !== expectedHash) return fail('冷证据清单哈希不同')
    const current = await holdRootRestoreStage3DatabaseFiles3({ profileRoot: root, databaseDirectory: copy.databaseDirectory,
      inventory: copy.value.originalInventory })
    try {
      // Persisted v1 previews can include unsupported instance removals. Their
      // old locator must still re-read exactly the same evidence after upgrade.
      const allowInstanceRemoval = stored === null || JSON.parse(stored).version === 2
      const facts = await readCurrent(preimage, allowInstanceRemoval, allowOrdinaryCut)
      const version = facts.ordinaryCut ? 3 : facts.proposedBoundary?.version ?? 1
      const kind = version === 3 ? 'root-restore-non-executable-ordinary-evidence-v3'
        : version === 2 ? 'root-restore-non-executable-history-evidence-v2' : 'root-restore-non-executable-history-evidence-v1'
      const value = freezeCapsuleValue({ kind, version, evidenceId, ...facts })
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

/** Only C consumes an ordinary empty-history cut; earlier history APIs keep
 * their original manifest format and admission. */
export function readRootRestoreCoverageCutEvidence3(stage: RootRestorePhysicalStage3, input?: Locator, historyScope?: PreparedRestoreHistoryScope3) {
  if (!input) return evidence(stage, randomUUID(), undefined, true, historyScope)
  const locator = capsuleRecord(input, ['evidenceId', 'expectedManifestHash'])
  return evidence(stage, durableSqlDagUuid(locator.evidenceId), durableSqlDagHash(locator.expectedManifestHash), true)
}
