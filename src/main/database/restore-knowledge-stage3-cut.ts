// Data planning and native SQL leaves for the private, non-executable stage.
// The fixed stage owner supplies freshly authenticated originals, owns the
// exact main path/FD and outer transaction, and repeats the source/copy tails.
// Neither a plan, SQL connection, hash nor these observations grants install,
// accepted coverage, old-epoch replay or a public write capability.
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import type { readRootRestoreReferenceGraphInputs3 } from './restore-knowledge-reference3-read'
import { graph3Encode, graph3Text } from './restore-knowledge-graph3-data'
import type { Capsule2Encoding, Capsule2RawSqlTable } from './restore-knowledge-capsule2-raw-model'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'

type Actual = Awaited<ReturnType<typeof readRootRestoreReferenceGraphInputs3>>
type Row = Capsule2RawSqlTable['rows'][number]
export interface RootRestoreStage3RetainedCutContext3 {
  readonly stageId: string
  readonly preparedAt: string
  readonly copyId: string
  readonly copyManifestHash: string
}
export const ROOT3_RETAINED_CUT_PREFIX = 'knowbook.root.restore.retained-cut.v1.'
const supports = ['app_settings', 'documents', 'document_block_moves', 'synced_workspace_state', 'synced_groups',
  'synced_instances', 'synced_host_history_state', 'synced_host_history_documents', 'synced_host_history',
  'synced_group_history', 'synced_operations', 'synced_group_pins', 'synced_group_lifecycle'] as const
const retainedNames = ['synced_host_history', 'synced_operations', 'synced_group_pins', 'document_block_moves'] as const
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const fail = (message: string): never => { throw new Error('Root3 current retained cut失败：' + message + '；没有授予安装/accepted/执行许可。') }
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const text = (cell: RawRestoreSqlCell, encoding: Capsule2Encoding) => cell[0] === 'text' ? graph3Text(cell, encoding) : fail('原guard/identity不是准确TEXT')
const integer = (cell: RawRestoreSqlCell) => cell[0] === 'integer' ? cell[1] : fail('原position不是准确INTEGER')
const rowOrder = (left: Row, right: Row) => BigInt(left.sourceRowId) < BigInt(right.sourceRowId) ? -1 : BigInt(left.sourceRowId) > BigInt(right.sourceRowId) ? 1 : 0
function column(table: Capsule2RawSqlTable, name: string): number {
  const index = table.columns.indexOf(name)
  return index < 0 ? fail('原表缺列：' + table.name + '.' + name) : index
}
function cell(table: Capsule2RawSqlTable, row: Row, name: string) { return row.cells[column(table, name)] }
function tableNamed(tables: readonly Capsule2RawSqlTable[], name: string) {
  const matches = tables.filter(table => table.name === name)
  return matches.length === 1 ? matches[0] : fail('原/目标表不是唯一完整表：' + name)
}
function original(actual: Actual, name: string) { return tableNamed(actual.data.inputs.current.source.sourceContent.tables, name) }
function change(table: Capsule2RawSqlTable, row: Row, updates: Record<string, RawRestoreSqlCell>): Row {
  const cells = [...row.cells]
  for (const [name, value] of Object.entries(updates)) cells[column(table, name)] = value
  return { sourceRowId: row.sourceRowId, cells }
}
function indexed(table: Capsule2RawSqlTable, key: string, encoding: Capsule2Encoding) {
  const rows = new Map<string, Row>()
  for (const row of table.rows) {
    const id = text(cell(table, row, key), encoding)
    if (rows.has(id)) return fail('原/目标身份重复：' + table.name)
    rows.set(id, row)
  }
  return rows
}
function rowAllocator(table: Capsule2RawSqlTable) {
  const used = new Set(table.rows.map(row => row.sourceRowId)); let value = 1n
  return () => {
    while (used.has(value.toString())) value++
    if (value >= 2n ** 63n) return fail('准确未占用rowid耗尽')
    const result = value.toString(); used.add(result); value++; return result
  }
}
function guard(table: Capsule2RawSqlTable, row: Row, encoding: Capsule2Encoding) {
  return { revision: text(cell(table, row, 'revision'), encoding), topologyRevision: text(cell(table, row, 'topology_revision'), encoding),
    historyCursor: text(cell(table, row, 'history_cursor'), encoding), historyPosition: integer(cell(table, row, 'history_position')) }
}
/** Include escaped JSON guards as well as literal SQL TEXT. Old history and
 * recovery records remain occupied even when they no longer execute. Only
 * guard-shaped strings are retained; large content strings are not duplicated
 * into another all-source string collection. */
function occupied(actual: Actual, target: readonly Capsule2RawSqlTable[], context: RootRestoreStage3RetainedCutContext3) {
  const uuids = new Set<string>(), times = new Set<string>()
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  const iso = /(?:[+-][0-9]{6}|[0-9]{4})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z/g
  const collect = (source: string) => {
    for (const match of source.matchAll(uuid)) uuids.add(match[0].toLowerCase())
    for (const match of source.matchAll(iso)) times.add(match[0])
  }
  const jsonStrings = (source: string) => {
    let value: unknown
    try { value = JSON.parse(source) } catch { return }
    const stack: unknown[] = [value]
    while (stack.length) {
      const item = stack.pop()
      if (typeof item === 'string') collect(item)
      else if (item && typeof item === 'object') for (const [key, nested] of Object.entries(item)) { collect(key); stack.push(nested) }
    }
  }
  const visit = (tables: readonly Capsule2RawSqlTable[], encoding: Capsule2Encoding) => {
    for (const table of tables) for (const row of table.rows) for (const [index, value] of row.cells.entries()) if (value[0] === 'text') {
      const source = graph3Text(value, encoding)
      collect(source)
      // Unknown ordinary settings/content are opaque TEXT in the original raw
      // format. Parsing their arbitrary inner JSON would introduce an extra
      // allocation/depth domain that their original Base64 cell never needed.
      // Only already authenticated execution JSON can contain escaped guards.
      const executionJson = (table.name.startsWith('synced_') || table.name === 'document_block_moves') && table.columns[index].endsWith('_json')
        || table.name === 'app_settings' && table.columns[index] === 'value' && text(cell(table, row, 'key'), encoding).startsWith('synced.')
      if (executionJson) jsonStrings(source)
    }
  }
  for (const side of [actual.data.inputs.source, actual.data.inputs.current]) visit(side.source.sourceContent.tables, side.source.sourceContent.encoding)
  visit(target, actual.data.inputs.current.source.sourceContent.encoding)
  for (const value of [context.stageId, context.copyId, actual.referencePlanId]) uuids.add(value.toLowerCase())
  return { uuids, times }
}

export function planRootRestoreStage3RetainedCut3(actual: Actual, physicalTables: readonly Capsule2RawSqlTable[], context: RootRestoreStage3RetainedCutContext3) {
  if (!isSyncedUuid(context.stageId) || !isSyncedUuid(context.copyId) || !/^[a-f0-9]{64}$/.test(context.copyManifestHash)
    || typeof context.preparedAt !== 'string' || !Number.isFinite(Date.parse(context.preparedAt))) return fail('固定stage/copy分配无效')
  const encoding = actual.data.inputs.current.source.sourceContent.encoding
  const bindings = { ...context, referencePlanId: actual.referencePlanId, referenceManifestHash: actual.referenceManifestHash,
    currentMaterialHash: actual.data.inputs.current.materialHash, sourceMaterialHash: actual.data.inputs.source.materialHash,
    derivedReferenceAllocationHash: actual.allocation.derivedReferenceAllocationHash, currentPayload: actual.allocation.currentPayload,
    currentWitness: actual.allocation.currentWitness, conservationHash: actual.data.inputs.knowledge.conservationHash }
  const occupiedValues = occupied(actual, physicalTables, context)
  const fresh = (purpose: string, id: string): string => {
    const bytes = createHash('sha256').update('knowbook.restore.stage3.retained-cut.guard.v1\0' + capsuleJson({ bindings, purpose, id })).digest()
    bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128
    const hex = bytes.subarray(0, 16).toString('hex'), value = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
    if (occupiedValues.uuids.has(value)) return fail('固定guard与任何来源/历史/本次分配碰撞')
    occupiedValues.uuids.add(value); return value
  }
  let documentTime = Date.parse(context.preparedAt), documentBoundary = new Date(documentTime).toISOString()
  while (occupiedValues.times.has(documentBoundary)) {
    documentTime = documentTime === 8640000000000000 ? -8640000000000000 : documentTime + 1
    documentBoundary = new Date(documentTime).toISOString()
  }
  const oldWorkspace = original(actual, 'synced_workspace_state')
  if (oldWorkspace.rows.length !== 1 || integer(cell(oldWorkspace, oldWorkspace.rows[0], 'singleton')) !== '1') return fail('原workspace singleton不完整')
  const workspaceScope = text(cell(oldWorkspace, oldWorkspace.rows[0], 'workspace_scope'), encoding)
  const beforeEpoch = text(cell(oldWorkspace, oldWorkspace.rows[0], 'recovery_epoch'), encoding)
  if (!isSyncedUuid(workspaceScope) || !isSyncedUuid(beforeEpoch)) return fail('原workspace身份不是准确UUID')
  const afterEpoch = fresh('workspace-recovery-epoch', workspaceScope)
  const documentTable = tableNamed(physicalTables, 'documents'), originalDocuments = original(actual, 'documents')
  const beforeDocuments = indexed(originalDocuments, 'id', encoding)
  const documentAllocations = [...indexed(documentTable, 'id', encoding)].sort(([a], [b]) => compare(a, b)).map(([id, row]) => {
    const before = beforeDocuments.get(id)
    return { documentId: id, targetRowId: row.sourceRowId, currentSourceRowId: before?.sourceRowId ?? null,
      beforeUpdatedAt: before ? text(cell(originalDocuments, before, 'updated_at'), encoding) : null,
      candidateUpdatedAt: text(cell(documentTable, row, 'updated_at'), encoding), afterUpdatedAt: documentBoundary }
  })
  const oldStates = original(actual, 'synced_host_history_state'), beforeStates = indexed(oldStates, 'document_id', encoding), allocateStateRow = rowAllocator(oldStates)
  const hostAllocations = documentAllocations.map(document => {
    const before = beforeStates.get(document.documentId)
    return { documentId: document.documentId, targetRowId: before?.sourceRowId ?? allocateStateRow(),
      beforeCursor: before ? text(cell(oldStates, before, 'cursor'), encoding) : null,
      beforePosition: before ? integer(cell(oldStates, before, 'position')) : null,
      afterCursor: fresh('host-history-cursor', document.documentId), afterPosition: '0' }
  })
  const oldGroups = original(actual, 'synced_groups'), beforeGroups = indexed(oldGroups, 'id', encoding)
  const groupTable = tableNamed(physicalTables, 'synced_groups'), active = new Set(actual.candidate.activeGroupWires.map(group => group.id))
  const groupAllocations = [...indexed(groupTable, 'id', encoding)].sort(([a], [b]) => compare(a, b)).map(([id, row]) => {
    const before = beforeGroups.get(id), beforePhysical = guard(groupTable, row, encoding), current = before ? guard(oldGroups, before, encoding) : null
    if (!active.has(id) && (!before || beforePhysical.historyPosition !== '0')) return fail('inactive保留组不是原current的非执行状态')
    return { groupId: id, targetRowId: row.sourceRowId, currentSourceRowId: before?.sourceRowId ?? null, disposition: active.has(id) ? 'active' as const : 'inactive-current-evidence' as const,
      beforeCurrent: current, beforePhysical, after: active.has(id)
        ? { revision: fresh('group-revision', id), topologyRevision: fresh('group-topology', id), historyCursor: fresh('group-history-cursor', id), historyPosition: '0' }
        : { ...beforePhysical, historyPosition: '0' } }
  })
  const oldInstances = original(actual, 'synced_instances'), beforeInstances = indexed(oldInstances, 'instance_id', encoding)
  const instanceTable = tableNamed(physicalTables, 'synced_instances')
  const instanceAllocations = [...indexed(instanceTable, 'instance_id', encoding)].sort(([a], [b]) => compare(a, b)).map(([id, row]) => {
    const before = beforeInstances.get(id)
    return { instanceId: id, targetRowId: row.sourceRowId, currentSourceRowId: before?.sourceRowId ?? null,
      groupId: text(cell(instanceTable, row, 'group_id'), encoding), hostDocumentId: text(cell(instanceTable, row, 'host_document_id'), encoding),
      beforeBindingVersion: before ? text(cell(oldInstances, before, 'binding_version'), encoding) : null,
      candidateBindingVersion: text(cell(instanceTable, row, 'binding_version'), encoding), afterBindingVersion: fresh('instance-binding', id) }
  })
  const byGroup = new Map(groupAllocations.map(row => [row.targetRowId, row])), byInstance = new Map(instanceAllocations.map(row => [row.targetRowId, row]))
  const tables: Capsule2RawSqlTable[] = physicalTables.map(table => table.name === 'documents'
    ? { ...table, rows: table.rows.map(row => change(table, row, { updated_at: graph3Encode(documentBoundary, encoding) })) }
    : table.name === 'synced_groups' ? { ...table, rows: table.rows.map(row => { const allocated = byGroup.get(row.sourceRowId) ?? fail('组cut分配遗漏')
      return change(table, row, { revision: graph3Encode(allocated.after.revision, encoding), topology_revision: graph3Encode(allocated.after.topologyRevision, encoding),
        history_cursor: graph3Encode(allocated.after.historyCursor, encoding), history_position: ['integer', '0'] }) }) }
    : table.name === 'synced_instances' ? { ...table, rows: table.rows.map(row => change(table, row,
      { binding_version: graph3Encode((byInstance.get(row.sourceRowId) ?? fail('实例cut分配遗漏')).afterBindingVersion, encoding) })) } : table)
  const workspaceTable: Capsule2RawSqlTable = { ...oldWorkspace, rows: [change(oldWorkspace, oldWorkspace.rows[0], { recovery_epoch: graph3Encode(afterEpoch, encoding) })] }
  const hostTable: Capsule2RawSqlTable = { ...oldStates, rows: hostAllocations.map(row => ({ sourceRowId: row.targetRowId,
    cells: oldStates.columns.map(name => name === 'document_id' ? graph3Encode(row.documentId, encoding)
      : name === 'cursor' ? graph3Encode(row.afterCursor, encoding) : name === 'position' ? ['integer', '0'] as RawRestoreSqlCell : fail('未知host state列')) })).sort(rowOrder) }
  const protectedTables: Capsule2RawSqlTable[] = [workspaceTable, hostTable,
    { ...original(actual, 'synced_host_history_documents'), rows: [] }, { ...original(actual, 'synced_group_history'), rows: [] }]
  const archiveTables = supports.map(name => { const table = original(actual, name)
    return { table: name, rows: table.rows.length, columns: table.columns, primaryKey: table.primaryKey,
      rawTableHash: hash('knowbook.restore.stage3.retained-cut.original-table.v1', table) } })
  const allocation = { workspace: { workspaceScope, beforeEpoch, afterEpoch }, documentBoundary,
    documents: documentAllocations, hosts: hostAllocations, groups: groupAllocations, instances: instanceAllocations }
  // Full allocations are transient, deterministically rebuilt from these
  // bound originals and the fixed context. Final native-table commitments
  // already bind every new CAS/guard/rowid; serializing all decoded before
  // values again would unnecessarily expand otherwise legal raw TEXT.
  const executionHash = hash('knowbook.restore.stage3.retained-cut.execution.v1', { bindings,
    beforePhysical12TablesHash: hash('knowbook.restore.stage3.retained-cut.physical12.v1', physicalTables),
    afterPhysical12TablesHash: hash('knowbook.restore.stage3.retained-cut.physical12.v1', tables),
    protectedTablesHash: hash('knowbook.restore.stage3.retained-cut.protected-tables.v1', protectedTables), archiveTables })
  const recordBody = { kind: 'root-restore-current-retained-cut' as const, version: 1 as const, policyVersion: 1 as const,
    bindings, workspace: allocation.workspace, documentBoundary, cutHash: executionHash,
    archive: { storage: 'genuine-current-copy-and-qualified-originals' as const, encoding, tables: archiveTables,
      currentOriginalRawTablesHash: hash('knowbook.restore.stage3.retained-cut.all-original-tables.v1', actual.data.inputs.current.source.sourceContent.tables) },
    finalTablesHash: hash('knowbook.restore.stage3.retained-cut.final-tables.v1', { tables, protectedTables }),
    counts: { documents: documentAllocations.length, hosts: hostAllocations.length, groups: groupAllocations.length,
      activeGroups: groupAllocations.filter(row => row.disposition === 'active').length, instances: instanceAllocations.length,
      archivedHostMappings: original(actual, 'synced_host_history_documents').rows.length,
      archivedGroupHistory: original(actual, 'synced_group_history').rows.length,
      retainedOperations: original(actual, 'synced_operations').rows.length, retainedPins: original(actual, 'synced_group_pins').rows.length },
    finalCurrentRetainedCutComplete: true as const, currentStageComplete: false as const, historyCutComplete: false as const,
    semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  const record = { key: ROOT3_RETAINED_CUT_PREFIX + context.stageId, json: capsuleJson(recordBody), hash: hash('knowbook.restore.stage3.retained-cut.record.v1', recordBody) }
  if (original(actual, 'app_settings').rows.some(row => text(cell(original(actual, 'app_settings'), row, 'key'), encoding) === record.key)) return fail('新cut key已被原件占用')
  const plan = { encoding, context: { ...context }, tables, protectedTables, allocation, archiveTables, record, cutHash: executionHash,
    retainedTables: retainedNames.map(name => original(actual, name)), finalCurrentRetainedCutComplete: true as const,
    historyCutComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  // Each raw family already passed the original source/candidate budgets.
  // Transient allocations duplicate authenticated before/current values and
  // are never another input or persisted format. Applying an extra aggregate
  // JSON budget to them would shrink the original raw TEXT domain. Only the
  // actual compact durable record is subject to the original JSON budget.
  assertMerge3JsonBudget(recordBody)
  return freezeCapsuleValue(plan)
}
export type RootRestoreStage3RetainedCutPlan3 = ReturnType<typeof planRootRestoreStage3RetainedCut3>

function ownedMain(db: Database.Database, encoding: Capsule2Encoding) {
  const databases = db.pragma('database_list') as Array<{ seq: number; name: string; file: string }>
  if (!db.open || !db.inTransaction || db.memory || db.pragma('foreign_keys', { simple: true }) !== 1
    || db.readonly && db.pragma('query_only', { simple: true }) !== 1 || databases.length !== 1 || databases[0].seq !== 0
    || databases[0].name !== 'main' || !databases[0].file || db.pragma('main.user_version', { simple: true }) !== 27
    || db.pragma('main.encoding', { simple: true }) !== encoding) return fail('cut观察要求独立main/FK事务及原准确编码')
}
function exactNativeTable(db: Database.Database, expected: Capsule2RawSqlTable, encoding: Capsule2Encoding) {
  if (!same(db.prepare('SELECT * FROM main.' + quote(expected.name) + ' LIMIT 0').columns().map(value => value.name), expected.columns)) return fail('cut实际列序改变：' + expected.name)
  const projection = expected.columns.flatMap(name => [`typeof(${quote(name)})`, `CASE WHEN typeof(${quote(name)})='text' THEN CAST(${quote(name)} AS BLOB) ELSE ${quote(name)} END`]).join(',')
  const rows = [...expected.rows].sort(rowOrder); let index = 0
  for (const raw of db.prepare('SELECT _rowid_,' + projection + ' FROM main.' + quote(expected.name) + ' ORDER BY _rowid_').safeIntegers(true).raw(true).iterate() as IterableIterator<unknown[]>) {
    if (typeof raw[0] !== 'bigint') return fail('cut实际rowid不是int64')
    const observed = { sourceRowId: raw[0].toString(), cells: expected.columns.map((_name, columnIndex) => rawRestoreSqlCell(raw[columnIndex * 2 + 1], raw[columnIndex * 2 + 2], encoding)) }
    if (!rows[index] || !same(observed, rows[index++])) return fail('cut实际rows/cells/storage class变化：' + expected.name)
  }
  if (index !== rows.length) return fail('cut实际行集合缺失：' + expected.name)
  return { table: expected.name, rows: index, rawTableHash: hash('knowbook.restore.stage3.retained-cut.observed-table.v1', expected) }
}
function assertRecord(db: Database.Database, plan: RootRestoreStage3RetainedCutPlan3) {
  const row = db.prepare(`SELECT typeof(value),CAST(value AS BLOB),typeof(updated_at),CAST(updated_at AS BLOB) FROM main.app_settings WHERE key=?`).raw(true).get(plan.record.key) as unknown[] | undefined
  if (!row || !same(rawRestoreSqlCell(row[0], row[1], plan.encoding), graph3Encode(plan.record.json, plan.encoding))
    || !same(rawRestoreSqlCell(row[2], row[3], plan.encoding), graph3Encode(plan.context.preparedAt, plan.encoding))) return fail('cut真实持久record原字节不符')
}
export function assertRootRestoreStage3RetainedCutObserved3(db: Database.Database, actual: Actual, plan: RootRestoreStage3RetainedCutPlan3) {
  ownedMain(db, plan.encoding)
  // The fixed owner reconstructs the complete plan from its genuine pre-cut
  // candidate and compares the intent before calling this SQL leaf. Replanning
  // from post-cut tables would wrongly treat this plan's own fresh guards as
  // pre-existing occupied IDs. This leaf does not authenticate copy/originals.
  for (const descriptor of plan.archiveTables) {
    const table = original(actual, descriptor.table)
    if (hash('knowbook.restore.stage3.retained-cut.original-table.v1', table) !== descriptor.rawTableHash) return fail('cut qualified原件支持变化')
  }
  assertRecord(db, plan)
  const observations = [...plan.tables.filter(table => ['documents', 'synced_groups', 'synced_instances'].includes(table.name)), ...plan.protectedTables, ...plan.retainedTables]
    .map(table => exactNativeTable(db, table, plan.encoding))
  const body = { cutHash: plan.cutHash, recordHash: plan.record.hash, observations, finalCurrentRetainedCutComplete: true as const,
    originalRowsSupportedByGenuineCopyAndQualifiedOriginals: true as const, oldGroupHistoryExecutable: false as const,
    oldHostHistoryMappingsExecutable: false as const, originalCommittedAcksRetained: true as const,
    historyCutComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  return freezeCapsuleValue({ ...body, observationHash: hash('knowbook.restore.stage3.retained-cut.observation.v1', body) })
}

export interface RootRestoreStage3CutRequestProbe3 {
  readonly operationId: string; readonly requestHash: string
  readonly expectedWorkspaceScope: string; readonly expectedRecoveryEpoch: string
}
/** A native diagnostic consumer, never a write. Exact old committed ACKs are
 * immutable facts and can still settle. An unknown old-epoch pending request
 * cannot become a new operation merely by being retried against the new SQL.
 * The caller must have completed the full owned-stage observation first. */
export function probeRootRestoreStage3CutRequest3(db: Database.Database, plan: RootRestoreStage3RetainedCutPlan3, request: RootRestoreStage3CutRequestProbe3) {
  ownedMain(db, plan.encoding); assertRecord(db, plan)
  if (typeof request.operationId !== 'string' || !request.operationId.length || !/^[a-f0-9]{64}$/.test(request.requestHash)
    || !isSyncedUuid(request.expectedWorkspaceScope) || !isSyncedUuid(request.expectedRecoveryEpoch)) return fail('原请求probe身份/hash无效')
  const operations = tableNamed(plan.retainedTables, 'synced_operations'), originalRow = indexed(operations, 'client_operation_id', plan.encoding).get(request.operationId)
  if (originalRow) {
    exactNativeTable(db, operations, plan.encoding)
    const requestHash = text(cell(operations, originalRow, 'request_hash'), plan.encoding)
    if (requestHash !== request.requestHash) return fail('原已提交operation ID不能被另一请求复用')
    return Object.freeze({ kind: 'original-committed-ack' as const, operationId: request.operationId, requestHash,
      resultJson: text(cell(operations, originalRow, 'result_json'), plan.encoding),
      createdAt: text(cell(operations, originalRow, 'created_at'), plan.encoding), originalRowId: originalRow.sourceRowId,
      cutHash: plan.cutHash, executable: false as const, permit: false as const })
  }
  const workspace = tableNamed(plan.protectedTables, 'synced_workspace_state')
  exactNativeTable(db, workspace, plan.encoding)
  if (request.expectedWorkspaceScope !== plan.allocation.workspace.workspaceScope || request.expectedRecoveryEpoch !== plan.allocation.workspace.afterEpoch)
    return fail('未知旧epoch pending请求已失效；不得发新请求或重放')
  if (db.prepare('SELECT 1 FROM main.synced_operations WHERE client_operation_id=?').get(request.operationId)) return fail('stage出现非原件的operation')
  return Object.freeze({ kind: 'uncommitted-new-generation' as const, operationId: request.operationId,
    recoveryEpoch: plan.allocation.workspace.afterEpoch, accepted: false as const, executable: false as const, permit: false as const })
}
