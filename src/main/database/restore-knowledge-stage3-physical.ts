// Private physical restore files remain non-executable until a full history cut.
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import type { SyncedCanonicalWire, SyncedGroupWire } from '../../shared/synced-blocks'
import { validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { canonicalSyncedPortableJson, projectSyncedGroupBudget } from '../../shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue, validateDurableSqlCapsuleInventory,
  type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { graph3Encode, graph3Rows, graph3Text } from './restore-knowledge-graph3-data'
import { readRootRestoreReferenceGraphInputs3, assertRootRestoreReferenceOriginalBytes3, readRootRestoreReferenceCopySource3,
  type RootRestoreReferencePlan3 } from './restore-knowledge-reference3-read'
import { prepareRootRestoreCurrentCopy3, readRootRestoreCurrentCopyForStage3, reopenRootRestoreCurrentCopy3,
  type RootRestoreCurrentCopy3 } from './restore-knowledge-stage3-current-copy'
import { stage3MarkerJson, stage3MarkerKey, stage3MarkerHash, type RootRestoreStage3Marker } from './restore-knowledge-stage3-marker-model'
import { readStage3OriginalRecoveryFamilyOwned, readRootRestoreStage3MarkerOwned } from './restore-knowledge-stage3-marker-read'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2RawSqlValueBytesExpression,
  capsule2DerivedFtsTables, type Capsule2Encoding, type Capsule2RawSqlTable, type Capsule2RawSqlRow } from './restore-knowledge-capsule2-raw-model'
import { MERGE3_CONTENT_TABLES, assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { assertOriginCatalogDirectory, readOriginCatalogFile, copyOriginCatalogFileWithIdentity3, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { holdRootRestoreStage3Files3, holdRootRestoreStage3DatabaseFiles3, assertRootRestoreStage3FilesHeld3,
  assertRootRestoreStage3WritableMain3, assertRootRestoreStage3WrittenMainClosed3, closeRootRestoreStage3FilesHeld3 } from './restore-knowledge-stage3-files'
import { restoreDirectory, syncRestoreDirectory, syncRestoreFile } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { assertSyncedBlockSchema, syncedBlockSchemaObjectNames } from './synced-schema'
import { assertSyncedLifecycleSchemaMetadata, syncedLifecycleSchemaObjectNames } from './synced-lifecycle-schema-metadata'
import { assertSyncedLifecycleCoverage, readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from './synced-lifecycle-state'
import { assertSyncedStoredBindings } from './synced-stored-binding-read'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { assertRawCapsule2CatalogOwned } from './restore-knowledge-capsule2-catalog-read'
import { buildMerge3NavigationFinalIndex3 } from './restore-knowledge-navigation3-merge-context'
import { toReference3GraphInputs } from './restore-knowledge-reference3-model'
import { searchIndexSchema, databaseEntityConstraintSchema, documentStatisticsSchema } from './schema'
import { publicationCompare, publicationHash, publicationJson } from '../sync/synced-publication-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'

export interface RootRestorePhysicalStage3 { readonly kind: 'main-root-restore-non-executable-physical-stage' }
type Actual = Awaited<ReturnType<typeof readRootRestoreReferenceGraphInputs3>>
type Candidate = Actual['candidate']
type Table = Candidate['tables'][number]
type CopyInfo = Awaited<ReturnType<typeof readRootRestoreCurrentCopyForStage3>>
type Row = { readonly sourceRowId: string; readonly cells: readonly RawRestoreSqlCell[] }
type Planned = ReturnType<typeof planSql>
type Intent = ReturnType<typeof intentBody>
type Observation = ReturnType<typeof observeSql>
type Manifest = ReturnType<typeof manifestBody>
interface Saved {
  reference: RootRestoreReferencePlan3; copy: RootRestoreCurrentCopy3
  directory: string; databaseDirectory: string; checksDirectory: string; root: string
  intent: Intent; intentHash: string; manifest: Manifest; manifestHash: string
}
const stages = new WeakMap<RootRestorePhysicalStage3, Saved>()
const contentNames = new Set<string>(MERGE3_CONTENT_TABLES)
const ftsFootprint = new Set<string>([...capsule2DerivedFtsTables(), 'document_search_ids', 'block_search_ids'])
const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"'
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const fail = (message: string): never => { throw new Error('Root3非执行物理stage失败：' + message + '；未授安装/cut/accepted许可，失败私有目录保留。') }
const maxSmallBytes = 256 * 1024
const text = (value: unknown): string => typeof value === 'string' ? value : fail('要求实际TEXT值')
const int64 = (value: string): bigint => {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(value)) return fail('非canonical int64')
  const number = BigInt(value)
  if (number < -(2n ** 63n) || number >= 2n ** 63n) return fail('int64越界')
  return number
}
const rowOrder = (a: Row, b: Row) => int64(a.sourceRowId) < int64(b.sourceRowId) ? -1 : int64(a.sourceRowId) > int64(b.sourceRowId) ? 1 : 0
function nextIds(rows: readonly Row[]) {
  const used = new Set(rows.map(row => int64(row.sourceRowId).toString())); let next = 1n
  return () => { while (used.has(next.toString())) next++; if (next >= 2n ** 63n) return fail('未占用正int64耗尽')
    const id = next.toString(); used.add(id); next++; return id }
}
function values(table: Pick<Table,'columns'|'encoding'>, row: { cells: readonly RawRestoreSqlCell[] }) {
  return Object.fromEntries(table.columns.map((column, index) => {
    const cell = row.cells[index]
    return [column, cell[0] === 'text' ? graph3Text(cell, table.encoding) : cell[0] === 'integer' ? BigInt(cell[1])
      : cell[0] === 'null' ? null : cell[0] === 'blob' ? Buffer.from(cell[1], 'base64') : Buffer.from(cell[1], 'hex').readDoubleLE()]
  })) as Record<string, unknown>
}
function raw(actual: Actual, name: string): Capsule2RawSqlTable {
  return actual.data.inputs.current.source.sourceContent.tables.find(table => table.name === name) ?? fail('current完整原表缺失：' + name)
}
function target(actual: Actual, name: string): Table {
  return actual.candidate.tables.find(table => table.name === name) ?? fail('候选12表缺失：' + name)
}
function rawTarget(table: Table): Capsule2RawSqlTable {
  return { name: table.name, role: 'content', columns: table.columns, primaryKey: table.primaryKey,
    rows: table.rows.map(row => ({ sourceRowId: row.targetRowId, cells: row.cells })).sort(rowOrder) }
}
function encodeValues(columns: readonly string[], enc: Capsule2Encoding, value: Record<string,string|null|bigint>): RawRestoreSqlCell[] {
  return columns.map(column => value[column] === null ? ['null'] : typeof value[column] === 'bigint'
    ? ['integer', (value[column] as bigint).toString()] : typeof value[column] === 'string'
      ? graph3Encode(value[column] as string, enc) : fail('缺固定写入列：' + column))
}
function assertAddedBudget(name: string, rows: readonly Row[]) {
  let bytes = 0
  if (rows.length > CAPSULE2_RAW_MAX_ROWS) return fail('新增' + name + '超本stage格式100k行预算')
  for (const row of rows) for (const cell of row.cells) {
    bytes += cell[0] === 'text' || cell[0] === 'blob' ? Buffer.from(cell[1], 'base64').length : 8
    if (bytes > CAPSULE2_RAW_MAX_VALUE_BYTES) return fail('新增' + name + '超本stage格式64MiB值预算')
  }
  assertMerge3JsonBudget(rows)
}
function acceptCandidate(actual: Actual) {
  const value = actual.candidate
  if (!value.candidateConflictFree || value.conflicts.length || !value.finalForestValidated || !value.inactiveMaterializationComplete
    || value.inactiveGroups.some(group => group.side !== 'current')) return fail('candidate冲突或inactive source物化仍未决')
  if (actual.data.inputs.current.source.sourceContent.schemaVersion !== 27) return fail('非执行stage只接受已认证schema27 current，不迁移26')
  if (value.tables.length !== MERGE3_CONTENT_TABLES.length || new Set(value.tables.map(table => table.name)).size !== MERGE3_CONTENT_TABLES.length)
    return fail('候选不是准确完整12表')
}
function planSql(actual: Actual, preparedAt: string) {
  acceptCandidate(actual)
  const current = actual.data.inputs.current.source.sourceContent, enc = current.encoding
  const originalTables=actual.candidate.tables.map(rawTarget)
  const sourceCandidate12TablesHash=hash('knowbook.restore.stage3.planned-content.v1',originalTables)
  type Change={table:'synced_groups'|'synced_instances';targetRowId:string;targetId:string;sourceId:string;
    sourceRef:Table['rows'][number]['sourceRef'];currentSourceRef:Table['rows'][number]['sourceRef']|null;
    proofKind:'new-incoming-allocation'|'current-boundary-preserved';
    cells:Array<{column:string;before:RawRestoreSqlCell;after:RawRestoreSqlCell;allocationField:string|null}>}
  const executionChanges:Change[]=[]
  const currentRows=new Map((['synced_groups','synced_instances'] as const).map(name=>[name,
    new Map(graph3Rows(current,name).map(row=>[text(row.value[name==='synced_groups'?'id':'instance_id']),row]))] as const))
  const sourceRows=new Map((['synced_groups','synced_instances'] as const).map(name=>[name,
    new Map(graph3Rows(actual.data.inputs.source.source.sourceContent,name).map(row=>[row.original.sourceRowId,row]))] as const))
  const originalGroups=new Set(currentRows.get('synced_groups')!.keys())
  const groupExecution=new Map<string,Actual['allocation']['execution']['groups'][number]>()
  const groupExecutionBySource=new Map<string,Actual['allocation']['execution']['groups'][number]>()
  for(const execution of actual.allocation.execution.groups){
    if(groupExecution.has(execution.targetGroupId)||groupExecutionBySource.has(execution.sourceGroupId))return fail('组execution分配重复')
    groupExecution.set(execution.targetGroupId,execution);groupExecutionBySource.set(execution.sourceGroupId,execution)
  }
  const instanceExecution=new Map<string,Actual['allocation']['execution']['instances'][number]>()
  for(const execution of actual.allocation.execution.instances){
    if(instanceExecution.has(execution.targetInstanceId))return fail('实例execution分配重复')
    instanceExecution.set(execution.targetInstanceId,execution)
  }
  const intents=new Map<string,Actual['allocation']['materialization']['lifecycleIntents'][number]>()
  for(const intent of actual.allocation.materialization.lifecycleIntents){if(intents.has(intent.targetGroupId))return fail('lifecycle物化意图重复')
    intents.set(intent.targetGroupId,intent)}
  const sourceGroups=new Map(actual.data.inputs.source.knowledge.groups.map(group=>[group.tuple.groupId,group]))
  const tables=originalTables.map(table=>{
    if(table.name!=='synced_groups'&&table.name!=='synced_instances')return table
    const name=table.name,candidate=target(actual,name),candidateRows=new Map(candidate.rows.map(row=>[row.targetRowId,row]))
    return {...table,rows:table.rows.map(row=>{
      const selected=candidateRows.get(row.sourceRowId)??fail('execution缺candidate occurrence'),value=values({columns:table.columns,encoding:enc},row)
      const id=text(value[name==='synced_groups'?'id':'instance_id']),prior=currentRows.get(name)!.get(id)
      const original=selected.sourceRef.side==='source'?sourceRows.get(name)!.get(selected.sourceRef.sourceRowId):prior
      if(!original||selected.sourceRef.table!==name)return fail('execution原sourceRef缺精确原行')
      const sourceId=text(original.value[name==='synced_groups'?'id':'instance_id'])
      let currentSourceRef:Change['currentSourceRef']=null
      const updates:Array<{column:string;after:RawRestoreSqlCell;allocationField:string|null}>=[]
      if(prior){
        // A physical restore may change the body before its complete cut, but
        // never installs an older source execution boundary over real current.
        const currentTable=prior.table
        currentSourceRef={side:'current',table:name,sourceRowId:prior.original.sourceRowId,
          payload:actual.allocation.currentPayload,materialHash:actual.data.inputs.current.materialHash,witness:actual.allocation.currentWitness,
          originalRowHash:hash('knowbook.restore.merge3.original-row.v1',{table:name,columns:currentTable.columns,
            primaryKey:currentTable.primaryKey,encoding:enc,sourceRowId:prior.original.sourceRowId,cells:prior.original.cells})}
        for(const column of name==='synced_groups'?['revision','topology_revision','history_cursor','history_position']:['binding_version']){
          const index=currentTable.columns.indexOf(column)
          if(index<0)return fail('current执行列缺失')
          updates.push({column,after:prior.original.cells[index],allocationField:null})
        }
      }else{
        if(selected.sourceRef.side!=='source')return fail('新incoming execution不是原source occurrence')
        if(name==='synced_groups'){
          const execution=groupExecution.get(id),intent=intents.get(id),group=sourceGroups.get(sourceId)
          if(!execution||!intent||!group||!execution.sourceActive||execution.sourceGroupId!==sourceId||intent.sourceGroupId!==sourceId
            ||intent.mode!=='new-import-materialization'||intent.targetCreationId!==value.creation_id
            ||!same(intent.sourceGroupSource,group.source)||intent.activationRevision!==execution.revision
            ||intent.activationTopologyRevision!==execution.topologyRevision||execution.historyPosition!==0)
            return fail('新group execution不属于同genuine source/tuple/lifecycle分配')
          updates.push({column:'revision',after:graph3Encode(durableSqlDagUuid(execution.revision),enc),allocationField:'execution.groups.revision'},
            {column:'topology_revision',after:graph3Encode(durableSqlDagUuid(execution.topologyRevision),enc),allocationField:'execution.groups.topologyRevision'},
            {column:'history_cursor',after:graph3Encode(durableSqlDagUuid(execution.historyCursor),enc),allocationField:'execution.groups.historyCursor'},
            {column:'history_position',after:['integer',execution.historyPosition.toString()],allocationField:'execution.groups.historyPosition'})
        }else{
          const execution=instanceExecution.get(id),group=groupExecutionBySource.get(text(original.value.group_id))
          if(!execution||execution.sourceInstanceId!==sourceId||!group||group.targetGroupId!==value.group_id)
            return fail('新instance execution不属于同genuine source/目标group分配')
          updates.push({column:'binding_version',after:graph3Encode(durableSqlDagUuid(execution.bindingVersion),enc),allocationField:'execution.instances.bindingVersion'})
        }
      }
      const cells=[...row.cells],changed:Change['cells']=[]
      for(const update of updates){const index=table.columns.indexOf(update.column);if(index<0)return fail('物理执行列缺失')
        const before=cells[index];cells[index]=update.after
        if(!same(before,update.after))changed.push({column:update.column,before,after:update.after,allocationField:update.allocationField})}
      if(changed.length)executionChanges.push({table:name,targetRowId:row.sourceRowId,targetId:id,sourceId,sourceRef:selected.sourceRef,
        currentSourceRef,proofKind:prior?'current-boundary-preserved':'new-incoming-allocation',cells:changed})
      return {...row,cells}
    })}
  }),byName=new Map(tables.map(table=>[table.name,table]))
  for (const table of tables) {
    const before = raw(actual, table.name)
    if (!same(table.columns, before.columns) || !same(table.primaryKey, before.primaryKey)) return fail('目标列序/PK不属于current schema')
    const oldRows = new Map(before.rows.map(row => [row.sourceRowId, row]))
    for (const row of table.rows) {
      int64(row.sourceRowId)
      const old = oldRows.get(row.sourceRowId)
      if (old && table.primaryKey.some(column => !same(old.cells[table.columns.indexOf(column)], row.cells[table.columns.indexOf(column)])))
        return fail('existing targetRowId试图换主键；不能借rowid改身份')
    }
    if (table.name === 'documents' || table.name === 'synced_groups') {
      const wanted = new Map(table.rows.map(row => [row.sourceRowId, row]))
      for (const old of before.rows) {
        const next = wanted.get(old.sourceRowId)
        if (!next) return fail('本片无current document/group header删除政策')
        for (const column of table.name === 'synced_groups' ? ['id','creation_id','created_at','origin_json'] : ['id','created_at']) {
          const index = table.columns.indexOf(column)
          if (!same(old.cells[index], next.cells[index])) return fail('current header immutable tuple/birth/rawOrigin变化')
        }
      }
    }
  }
  const oldLedger = raw(actual, 'block_identities'), ledgerIds = nextIds(oldLedger.rows)
  const oldLedgerById = new Map(graph3Rows(current, 'block_identities').map(row => [text(row.value.id), row.original]))
  const ledger = actual.candidate.materialization.ledgerOverlay.map(value => {
    const old = oldLedgerById.get(value.id)
    if (old) {
      const prior = values({ columns: oldLedger.columns, encoding: enc }, old)
      if (prior.last_owner_kind !== value.last_owner_kind || prior.last_owner_id !== value.last_owner_id || prior.created_at !== value.created_at)
        return fail('禁止洗掉current ledger的已知owner/birth')
    }
    return { sourceRowId: old?.sourceRowId ?? ledgerIds(), cells: encodeValues(oldLedger.columns, enc, value) }
  }).sort(rowOrder)
  const ledgerRowIds=new Set(ledger.map(row=>row.sourceRowId)),oldLedgerRowIds=new Set(oldLedger.rows.map(row=>row.sourceRowId))
  if (ledger.length < oldLedger.rows.length || oldLedger.rows.some(row => !ledgerRowIds.has(row.sourceRowId)))
    return fail('原current ledger遗漏')
  const ledgerAdded = ledger.filter(row => !oldLedgerRowIds.has(row.sourceRowId))
  assertAddedBudget('ledger', ledgerAdded)
  const headers = new Map(byName.get('synced_groups')!.rows.map(row => [text(values({ columns: byName.get('synced_groups')!.columns, encoding: enc }, row).id), row]))
  const wireById = new Map(actual.candidate.activeGroupWires.map(wire => [wire.id, wire]))
  const instanceTable = byName.get('synced_instances')!, instancesByGroup = new Map<string, Array<{instanceId:string;hostDocumentId:string;bindingVersion:string}>>()
  for (const row of instanceTable.rows) { const value = values({columns:instanceTable.columns,encoding:enc}, row), group = text(value.group_id), list = instancesByGroup.get(group) ?? []
    list.push({ instanceId: text(value.instance_id), hostDocumentId: text(value.host_document_id), bindingVersion: text(value.binding_version) }); instancesByGroup.set(group, list) }
  const oldLife = raw(actual, 'synced_group_lifecycle'), lifeIds = nextIds(oldLife.rows), lifecycleAdded: Row[] = []
  for (const [id, row] of headers) if (!originalGroups.has(id)) {
    const intent = intents.get(id), wire = wireById.get(id), value = values({ columns: byName.get('synced_groups')!.columns, encoding: enc }, row)
    if (!intent || intent.mode !== 'new-import-materialization' || !wire || intent.targetCreationId !== value.creation_id
      || intent.activationRevision !== value.revision || intent.activationTopologyRevision !== value.topology_revision)
      return fail('new group没有严格new-import生命周期意图/最终wire')
    const instances = (instancesByGroup.get(id) ?? []).sort((a,b) => a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0)
    lifecycleAdded.push({ sourceRowId: lifeIds(), cells: encodeValues(oldLife.columns, enc, { group_id: id,
      creation_id: text(value.creation_id), state: 'active', state_version: 1n, exposure_state: 'unknown', create_history_id: null,
      activation_revision: text(value.revision), activation_topology_revision: text(value.topology_revision),
      activation_hash: syncedLifecycleSemanticHash(wire), activation_instances_json: canonicalSyncedPortableJson(instances),
      created_at: preparedAt, updated_at: preparedAt }) })
  }
  assertAddedBudget('lifecycle', lifecycleAdded)
  const app = raw(actual, 'app_settings'), markerRowId = nextIds(app.rows)()
  const physical12TablesHash=hash('knowbook.restore.stage3.planned-content.v1',tables)
  const stageExecution={scope:'new-incoming-allocation-and-current-boundary-preservation' as const,
    canonicalCandidateHash:actual.candidate.canonicalCandidateHash,checkedCanonicalCandidateHash:actual.candidate.checkedCanonicalCandidateHash,
    sourceCandidate12TablesHash,physical12TablesHash,derivedReferenceAllocationHash:actual.allocation.derivedReferenceAllocationHash,
    executionChanges,currentExecutionBoundariesPreserved:true as const,workspaceEpochAndDocumentCasAndHostCutPending:true as const,
    finalCurrentRetainedCutComplete:false as const}
  assertMerge3JsonBudget(stageExecution)
  const stageExecutionHash=hash('knowbook.restore.stage3.execution-transition.v1',stageExecution)
  return { tables, ledger: { ...oldLedger, rows: ledger }, ledgerAdded, lifecycleAdded, markerRowId,
    lifecycle: { ...oldLife, rows: [...oldLife.rows, ...lifecycleAdded].sort(rowOrder) }, encoding: enc,
    sourceCandidate12TablesHash,physical12TablesHash,executionChanges,stageExecutionHash }
}
function binding(actual: Actual, copy: CopyInfo, reference: RootRestoreReferencePlan3) {
  const value = copy.value
  if (copy.reference !== reference || actual.referencePlanId !== value.referencePlanId
    || actual.referenceManifestHash !== value.referenceManifestHash || actual.allocation.derivedReferenceAllocationHash !== value.derivedReferenceAllocationHash
    || actual.candidate.checkedCanonicalCandidateHash !== value.checkedCanonicalCandidateHash
    || actual.data.inputs.current.materialHash !== value.currentMaterialHash) return fail('fresh reference与genuine currentCopy不是同一次绑定')
  return { referencePlanId: value.referencePlanId, referenceManifestHash: value.referenceManifestHash,
    baseIdentityAllocationHash: value.baseIdentityAllocationHash, derivedReferenceAllocationHash: value.derivedReferenceAllocationHash,
    checkedCanonicalCandidateHash: value.checkedCanonicalCandidateHash, sourceMaterialHash: value.sourceMaterialHash,
    currentMaterialHash: value.currentMaterialHash, conservationHash: value.conservationHash,
    originalDescriptorHash: value.originalDescriptorHash, currentOriginalInventoryHash: value.originalInventoryHash }
}
function context(db: Database.Database, enc: Capsule2Encoding, readonly: boolean) {
  const list = db.pragma('database_list') as Array<{seq:number;name:string;file:string}>
  if (!db.open || db.memory || db.readonly !== readonly || !db.inTransaction || db.pragma('foreign_keys',{simple:true}) !== 1
    || readonly && db.pragma('query_only',{simple:true}) !== 1 || list.length !== 1 || list[0].seq !== 0 || list[0].name !== 'main' || !list[0].file
    || db.pragma('main.user_version',{simple:true}) !== 27 || db.pragma('main.encoding',{simple:true}) !== enc) return fail('非独立main/FKON/schema27准确编码的owned事务')
  assertSyncedBlockSchema(db); assertSyncedLifecycleSchemaMetadata(db)
}
function assertSchema(db: Database.Database, actual: Actual) {
  const enc = actual.data.inputs.current.source.sourceContent.encoding
  const columns = ['type','name','tbl_name','sql'], project = columns.flatMap(column => [`typeof(${quote(column)})`, `CASE WHEN typeof(${quote(column)})='text' THEN CAST(${quote(column)} AS BLOB) ELSE ${quote(column)} END`]).join(',')
  const rows = (db.prepare('SELECT '+project+' FROM main.sqlite_master').safeIntegers(true).raw(true).all() as unknown[][])
    .map(row => publicationJson(columns.map((_column,index) => rawRestoreSqlCell(row[2*index], row[2*index+1], enc)))).sort(publicationCompare)
  const schemaHash = publicationHash(publicationJson({ domain:'knowbook.raw-sql-schema.v1', encoding:enc, rows }))
  if (schemaHash !== actual.data.inputs.current.source.sourceContent.schemaHash) return fail('实际完整schema原TEXT变化')
  const normalized = (sql: string) => sql.replace(/\bIF NOT EXISTS\s+/gi,'').replace(/\s+/g,' ').trim().replace(/;$/,'')
  // Only CREATE TRIGGER declarations are consumed. The shared schema3 literal
  // also contains its original migration UPDATE, which a stage never executes.
  const compiled = Array.from((searchIndexSchema + databaseEntityConstraintSchema + documentStatisticsSchema)
    .matchAll(/CREATE TRIGGER IF NOT EXISTS ([a-z_]+)[\s\S]*?\n\s*END;/g), match => ({name:match[1],sql:match[0]}))
  const compiledLookups=Array.from(searchIndexSchema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \([\s\S]*?\n\);/g),match=>({name:match[1],sql:match[0]}))
  for(const table of compiledLookups){const declaration=db.prepare("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?").get(table.name) as {sql:string}|undefined
    if(!declaration||normalized(declaration.sql)!==normalized(table.sql))return fail('FTS lookup不等于compiled一一映射DDL')}
  const allowed = new Set([...compiled.map(item=>item.name), ...syncedBlockSchemaObjectNames().filter(item=>item.type==='trigger').map(item=>item.name),
    ...syncedLifecycleSchemaObjectNames().filter(item=>item.type==='trigger').map(item=>item.name)])
  if(new Set(compiled.map(item=>item.name)).size!==compiled.length)return fail('compiled应用trigger声明重复')
  const triggers = db.prepare("SELECT name,sql FROM main.sqlite_master WHERE type='trigger'").all() as Array<{name:string;sql:string}>
  for (const trigger of triggers) if (!allowed.has(trigger.name)) return fail('未声明trigger写入footprint：'+trigger.name)
  if(triggers.length!==allowed.size)return fail('native compiled trigger闭集缺失')
  for (const trigger of compiled) if (!triggers.some(row=>row.name===trigger.name && normalized(row.sql)===normalized(trigger.sql))) return fail('触发器不等于现compiled定义')
}
function cellsBytes(rows: readonly Row[]) { let total = 0n; for (const row of rows) for (const cell of row.cells)
  total += BigInt(cell[0]==='text'||cell[0]==='blob' ? Buffer.from(cell[1],'base64').length : 8); return total }
function exactTable(db: Database.Database, table: Capsule2RawSqlTable, enc: Capsule2Encoding) {
  const columns = db.prepare('SELECT * FROM main.'+quote(table.name)+' LIMIT 0').columns().map(column=>column.name)
  if (!same(columns,table.columns)) return fail('实际列序变化：'+table.name)
  const measured = db.prepare('SELECT count(*),coalesce(sum('+capsule2RawSqlValueBytesExpression(columns)+'),0) FROM main.'+quote(table.name))
    .safeIntegers(true).raw(true).get() as [bigint,bigint]
  if (measured[0]!==BigInt(table.rows.length)||measured[1]!==cellsBytes(table.rows)) return fail('实际行数/值bytes不符：'+table.name)
  const projection=columns.flatMap(column=>[`typeof(${quote(column)})`, `CASE WHEN typeof(${quote(column)})='text' THEN CAST(${quote(column)} AS BLOB) ELSE ${quote(column)} END`]).join(',')
  const expected=[...table.rows].sort(rowOrder), output: Capsule2RawSqlRow[]=[]
  for (const rawRow of db.prepare('SELECT _rowid_,'+projection+' FROM main.'+quote(table.name)+' ORDER BY _rowid_').safeIntegers(true).raw(true).iterate() as IterableIterator<unknown[]>) {
    if (typeof rawRow[0]!=='bigint') return fail('实际rowid非int64')
    const row={sourceRowId:rawRow[0].toString(),cells:columns.map((_column,index)=>rawRestoreSqlCell(rawRow[2*index+1],rawRow[2*index+2],enc))}
    if (!same(row,expected[output.length])) return fail('原行/targetRowId/storage class/bytes不符：'+table.name+':'+row.sourceRowId)
    output.push(row)
  }
  if(output.length!==expected.length)return fail('实际行被截断')
  return {...table,rows:output}
}
function cellParam(cell: RawRestoreSqlCell,enc:Capsule2Encoding): {sql:string; value:null|bigint|number|Buffer|string} {
  if(cell[0]==='null')return {sql:'?',value:null}
  if(cell[0]==='integer')return {sql:'?',value:int64(cell[1])}
  if(cell[0]==='real-ieee754-le')return {sql:'CAST(? AS REAL)',value:Buffer.from(cell[1],'hex').readDoubleLE()}
  // SQL prepared through the UTF-8 native API interprets a BLOB-to-TEXT cast
  // as UTF-8 even for a UTF-16 database. Bind decoded text only after proving
  // its exact original encoding round-trip; final native BLOB readback still
  // checks every persisted byte, including BOM/NUL and non-ASCII characters.
  if(cell[0]==='text'&&enc!=='UTF-8'){
    const decoded=graph3Text(cell,enc)
    if(!same(graph3Encode(decoded,enc),cell))return fail('UTF16文本不能精确原编码往返')
    return {sql:'?',value:decoded}
  }
  return {sql:cell[0]==='text'?'CAST(? AS TEXT)':'?',value:Buffer.from(cell[1],'base64')}
}
function insertRow(db:Database.Database,table:Capsule2RawSqlTable,row:Row,enc:Capsule2Encoding) {
  const params=row.cells.map(cell=>cellParam(cell,enc))
  db.prepare('INSERT INTO main.'+quote(table.name)+'(_rowid_,'+table.columns.map(quote).join(',')+') VALUES(?,'+params.map(item=>item.sql).join(',')+')')
    .run(int64(row.sourceRowId),...params.map(item=>item.value))
}
/** Actual final parent graph, not rowid/depth order. Native parent-role guards
 * execute immediately even while FK constraints are deferred. Use an iterative
 * full forest order for parents first; DELETE uses the original forest reversed. */
function parentOrdered(table:Capsule2RawSqlTable,enc:Capsule2Encoding):readonly Row[] {
  const parentColumn=table.name==='documents'?'parent_id':table.name==='blocks'||table.name==='synced_group_blocks'?'parent_block_id':null
  if(parentColumn===null)return table.rows
  const ownerColumn=table.name==='blocks'?'document_id':table.name==='synced_group_blocks'?'group_id':null
  const nodes=new Map<string,{row:Row;value:Record<string,unknown>}>(),children=new Map<string,Row[]>(),roots:Row[]=[]
  for(const row of table.rows){const value=values({columns:table.columns,encoding:enc},row),id=text(value.id)
    if(nodes.has(id))return fail('parent ordering发现重复物理id');nodes.set(id,{row,value})}
  for(const node of nodes.values()){
    const parent=node.value[parentColumn]
    if(parent===null){roots.push(node.row);continue}
    const id=text(parent),found=nodes.get(id)
    if(!found||ownerColumn!==null&&found.value[ownerColumn]!==node.value[ownerColumn])return fail('parent不在同一完整物理forest')
    if(table.name==='blocks'&&found.value.type==='synced-block')return fail('sync leaf不能拥有物理child')
    const list=children.get(id)??[];list.push(node.row);children.set(id,list)
  }
  roots.sort(rowOrder);for(const list of children.values())list.sort(rowOrder)
  const output:Row[]=[],queue=[...roots]
  for(let offset=0;offset<queue.length;offset++){
    const row=queue[offset];output.push(row)
    const id=text(values({columns:table.columns,encoding:enc},row).id)
    for(const child of children.get(id)??[])queue.push(child)
  }
  if(output.length!==table.rows.length)return fail('parent ordering发现循环/无根组件')
  return output
}
function upsertTargets(db:Database.Database,table:Capsule2RawSqlTable,before:Capsule2RawSqlTable,enc:Capsule2Encoding) {
  const old=new Map(before.rows.map(row=>[row.sourceRowId,row]))
  for(const row of parentOrdered(table,enc)){const prior=old.get(row.sourceRowId);if(!prior){insertRow(db,table,row,enc);continue}
    const changes=table.columns.flatMap((column,index)=>same(row.cells[index],prior.cells[index])?[]:[{column,param:cellParam(row.cells[index],enc)}])
    if(!changes.length)continue
    const result=db.prepare('UPDATE main.'+quote(table.name)+' SET '+changes.map(change=>quote(change.column)+'='+change.param.sql).join(',')+' WHERE _rowid_=?')
      .run(...changes.map(change=>change.param.value),int64(row.sourceRowId))
    if(result.changes!==1)return fail('在位UPDATE未命中唯一原rowid')
  }
}
/** Actual FK inventory, grouped by FK id. Before a planned DELETE, every row
 * reached by CASCADE/SET NULL/SET DEFAULT must itself be a declared removed
 * 12-table row. Non-12 history/settings/markdown sources are never swept. */
type ForeignDeletePlan={child:string;predicate:string}
function foreignDeletePlans(db:Database.Database) {
  const result=new Map<string,ForeignDeletePlan[]>()
  // Include every native table, even derived lookup/shadow tables. A fixed
  // whole-table rewrite must not overlook an inbound FK outside content/K.
  const allTables=db.prepare("SELECT name FROM main.sqlite_master WHERE type='table'").all() as Array<{name:string}>
  for(const child of allTables){
    const fks=db.pragma('main.foreign_key_list('+quote(child.name)+')') as Array<{id:number;seq:number;table:string;from:string;to:string;on_delete:string}>
    const groups=new Map<number,typeof fks>()
    for(const fk of fks){const list=groups.get(fk.id)??[];list.push(fk);groups.set(fk.id,list)}
    for(const links of groups.values()){
      links.sort((a,b)=>a.seq-b.seq)
      const declaration=db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name=? COLLATE NOCASE")
        .get(links[0].table) as {name:string}|undefined
      if(!declaration)return fail('FK指向缺失native表')
      const parent=declaration.name,list=result.get(parent)??[]
      if(links.some(link=>!link.to))return fail('尚无implicit-parent-key FK adapter')
      list.push({child:child.name,predicate:links.map(link=>'p.'+quote(link.to)+'=c.'+quote(link.from)).join(' AND ')})
      result.set(parent,list)
    }
  }
  return result
}
function deleteRemoved(db:Database.Database,table:Capsule2RawSqlTable,before:Capsule2RawSqlTable,enc:Capsule2Encoding,
  removed:Map<string,Set<string>>,foreign:Map<string,ForeignDeletePlan[]>) {
  const remove=removed.get(table.name)!
  if(!remove.size)return
  const removedJson=capsuleJson([...remove])
  // One relation scan per FK, not one full child scan per deleted parent.
  // CROSS JOIN fixes child as the outer side; the parent uses its native
  // unique FK key, with that parent's collation on the left of the equality.
  for(const child of foreign.get(table.name)??[]){
    for(const row of db.prepare('SELECT c._rowid_ AS id FROM main.'+quote(child.child)+' c CROSS JOIN main.'+quote(table.name)
      +' p WHERE '+child.predicate+' AND p._rowid_ IN (SELECT CAST(value AS INTEGER) FROM json_each(?))')
      .safeIntegers(true).iterate(removedJson) as IterableIterator<{id:bigint}>){
      if(!removed.get(child.child)?.has(row.id.toString()))return fail('DELETE会影响未声明current行：'+table.name+'→'+child.child)
    }
  }
  for(const old of [...parentOrdered(before,enc)].reverse()){
    const id=old.sourceRowId;if(!remove.has(id))continue
    if(db.prepare('DELETE FROM main.'+quote(table.name)+' WHERE _rowid_=?').run(int64(id)).changes!==1)return fail('删除目标rowid缺失')
  }
}
function ftsProjection(db:Database.Database,integrity:boolean) {
  const metrics: Array<{table:string;rows:string;lookupHash:string}>=[]
  for(const config of [{base:'documents',lookup:'document_search_ids',fts:'document_search',key:'document_id',id:'id',columns:['title','path','summary']},
    {base:'blocks',lookup:'block_search_ids',fts:'block_search',key:'block_id',id:'id',columns:['document_id','content']}]){
    const b=quote(config.base),l=quote(config.lookup),f=quote(config.fts),key=quote(config.key)
    const bad=db.prepare(`SELECT 1 FROM main.${b} b LEFT JOIN main.${l} l ON l.${key}=b.${quote(config.id)}
      LEFT JOIN main.${f} f ON f.rowid=l.search_rowid WHERE l.search_rowid IS NULL OR f.rowid IS NULL
      OR typeof(l.search_rowid)<>'integer' OR typeof(f.${key})<>'text' OR CAST(f.${key} AS BLOB) IS NOT CAST(b.${quote(config.id)} AS BLOB)
      OR ${config.columns.map(column=>`typeof(f.${quote(column)})<>typeof(b.${quote(column)}) OR CAST(f.${quote(column)} AS BLOB) IS NOT CAST(b.${quote(column)} AS BLOB)`).join(' OR ')} LIMIT 1`).get()
    const orphan=db.prepare(`SELECT 1 FROM main.${l} l LEFT JOIN main.${b} b ON l.${key}=b.${quote(config.id)} WHERE b.${quote(config.id)} IS NULL
      UNION ALL SELECT 1 FROM main.${f} f LEFT JOIN main.${l} l ON l.search_rowid=f.rowid WHERE l.search_rowid IS NULL LIMIT 1`).get()
    if(bad||orphan)return fail('FTS/lookup与实际final12投影不闭合：'+config.fts)
    const count=(name:string)=>(db.prepare('SELECT count(*) AS value FROM main.'+quote(name)).safeIntegers(true).get() as {value:bigint}).value
    if(count(config.base)!==count(config.lookup)||count(config.base)!==count(config.fts))return fail('FTS/lookup存在多缺或重复映射')
    if(integrity)db.prepare('INSERT INTO main.'+f+'('+f+") VALUES('integrity-check')").run()
    const rows=db.prepare('SELECT _rowid_,search_rowid,CAST('+key+' AS BLOB) FROM main.'+l+' ORDER BY _rowid_').safeIntegers(true).raw(true).all() as Array<[bigint,bigint,Buffer]>
    metrics.push({table:config.fts,rows:rows.length.toString(),lookupHash:hash('knowbook.restore.stage3.native-fts-lookup.v1',rows.map(row=>[row[0].toString(),row[1].toString(),row[2].toString('base64')]))})
  }
  return metrics
}
function protectedTables(actual:Actual,plan:Planned,marker:RootRestoreStage3Marker) {
  const app=raw(actual,'app_settings'), markerRow:Row={sourceRowId:plan.markerRowId,cells:encodeValues(app.columns,plan.encoding,
    {key:stage3MarkerKey(marker.stageId),value:stage3MarkerJson(marker),updated_at:marker.preparedAt})}
  return actual.data.inputs.current.source.sourceContent.tables.filter(table=>!contentNames.has(table.name)&&!ftsFootprint.has(table.name))
    .map(table=>table.name==='block_identities'?plan.ledger:table.name==='synced_group_lifecycle'?plan.lifecycle:table.name==='app_settings'
      ?{...app,rows:[...app.rows,markerRow].sort(rowOrder)}:table)
}
function observeSql(db:Database.Database,actual:Actual,plan:Planned,marker:RootRestoreStage3Marker,readonly:boolean) {
  context(db,plan.encoding,readonly);assertSchema(db,actual)
  // Unqualified integrity_check visits every SQLite schema, including the
  // dormant temp slot, and opens its empty Btree while verifying that schema.
  // This reader owns main only: scope both checks to that exact database so
  // the final marker admission can still reject any real TEMP/ATTACH database.
  if(db.pragma('main.integrity_check',{simple:true})!=='ok'||(db.pragma('main.foreign_key_check') as unknown[]).length)return fail('实际SQL/FK完整性失败')
  const tables=plan.tables.map(table=>exactTable(db,table,plan.encoding))
  const physical12TablesHash=hash('knowbook.restore.stage3.planned-content.v1',tables)
  if(physical12TablesHash!==plan.physical12TablesHash)return fail('实际physical12不等于声明execution转换')
  const actualRows=new Map(tables.map(table=>[table.name,new Map(table.rows.map(row=>[row.sourceRowId,row]))]))
  const protectedObservations=protectedTables(actual,plan,marker).map(table=>{const observed=exactTable(db,table,plan.encoding)
    return {table:table.name,rows:table.rows.length,rowHash:hash('knowbook.restore.stage3.exact-table.v1',observed)}})
  const lookup=ftsProjection(db,!readonly)
  assertSyncedLifecycleCoverage(db)
  const groups=graph3Rows({tables,encoding:plan.encoding},'synced_groups'), groupIds=groups.map(group=>text(group.value.id))
  const lifecycles=readSyncedGroupLifecycles(db,groupIds)
  assertSyncedLogicalDeletionRecords(db)
  const actualTables=actual.candidate.tables.map(table=>({...table,rows:table.rows.map(row=>({ ...row,
    cells:actualRows.get(table.name)!.get(row.targetRowId)!.cells }))}))
  const final=buildMerge3NavigationFinalIndex3(toReference3GraphInputs(actual.data,actual.allocation),actualTables)
  if(final.indexHash!==actual.candidate.finalSyntaxIndexHash)return fail('实际final index与candidate不同')
  const sortedPhysical=[...final.physicalBlocks], order=new Map<string,bigint>()
  for(const name of ['blocks','synced_group_blocks'])for(const row of graph3Rows({tables,encoding:plan.encoding},name))order.set(text(row.value.id),row.value.sort_order as bigint)
  sortedPhysical.sort((a,b)=>order.get(a.id)!<order.get(b.id)!?-1:order.get(a.id)!>order.get(b.id)!?1:0)
  const byGroup=new Map<string,typeof sortedPhysical>(),byDoc=new Map<string,typeof sortedPhysical>()
  for(const block of sortedPhysical){const map=block.groupId===null?byDoc:byGroup,id=block.groupId??block.documentId!,list=map.get(id)??[];list.push(block);map.set(id,list)}
  const wanted=new Map(actual.candidate.activeGroupWires.map(wire=>[wire.id,wire])),wires:SyncedGroupWire[]=[]
  for(const group of groups){const id=text(group.value.id);if(!wanted.has(id)){if((byGroup.get(id)??[]).length)return fail('inactive current组出现canonical体');continue}
    const wire=validateSyncedGroupWire({kind:'synced-group',id,creationId:group.value.creation_id,createdAt:group.value.created_at,
      origin:JSON.parse(text(group.value.origin_json)),bindings:JSON.parse(text(group.value.bindings_json)),
      blocks:(byGroup.get(id)??[]).map(block=>({...block.block,createdAt:block.birth})) as SyncedCanonicalWire[]})
    if(!same(wire,wanted.get(id)))return fail('实际final wire不等于固定candidate')
    projectSyncedGroupBudget(wire);assertSyncedStoredBindings(db,wire.origin,wire.blocks,wire.bindings);wires.push(wire)
  }
  validateSyncedWorkspaceGraph(final.documents.map(document=>({documentId:document.id,blocks:(byDoc.get(document.id)??[]).map(block=>block.block)})),wires)
  const instancesByGroup=new Map<string,Array<{instanceId:string;hostDocumentId:string;bindingVersion:string}>>()
  for(const instance of graph3Rows({tables,encoding:plan.encoding},'synced_instances')){
    const id=text(instance.value.group_id),list=instancesByGroup.get(id)??[]
    list.push({instanceId:text(instance.value.instance_id),hostDocumentId:text(instance.value.host_document_id),bindingVersion:text(instance.value.binding_version)})
    instancesByGroup.set(id,list)
  }
  for(const list of instancesByGroup.values())list.sort((a,b)=>a.instanceId<b.instanceId?-1:a.instanceId>b.instanceId?1:0)
  for(const row of plan.lifecycleAdded){const value=values({columns:plan.lifecycle.columns,encoding:plan.encoding},row),id=text(value.group_id),life=lifecycles.get(id),wire=wanted.get(id)
    if(!life||!wire||life.state!=='active'||life.exposure!=='unknown'||life.createHistoryId!==null||life.stateVersion!==1
      ||life.activationHash!==syncedLifecycleSemanticHash(wire))return fail('new lifecycle实际activation不等于最终wire')
    const actualInstances=instancesByGroup.get(id)??[]
    if(!same(life.activationInstances,actualInstances))return fail('new lifecycle实际activation实例闭包不符')
  }
  if(readonly){assertRawCapsule2CatalogOwned(db);readRootRestoreStage3MarkerOwned(db,marker)}
  const body={tables:actualTables,ledger:plan.ledger,lifecycleAdded:plan.lifecycleAdded,protectedObservations,nativeFtsProjection:lookup,
    canonicalCandidateHash:actual.candidate.canonicalCandidateHash,sourceCandidate12TablesHash:plan.sourceCandidate12TablesHash,
    physical12TablesHash,executionChanges:plan.executionChanges,stageExecutionHash:plan.stageExecutionHash,
    currentExecutionBoundariesPreserved:true as const,workspaceEpochAndDocumentCasAndHostCutPending:true as const,
    activeWireHashes:wires.map(wire=>({id:wire.id,hash:syncedLifecycleSemanticHash(wire)})),finalSyntaxIndexHash:final.indexHash,
    actual12TablesRead:true as const,actualLedgerRead:true as const,actualLifecycleRead:true as const,
    currentHistoryRowsPreserved:true as const,currentStageComplete:false as const,historyCutComplete:false as const,
    canonicalExpandedSearchComplete:false as const,routesRebuilt:false as const,linkCountsRebuilt:false as const,
    semanticValidationComplete:false as const,acceptedCoverage:false as const,effective:false as const,permit:false as const}
  assertMerge3JsonBudget(body)
  return freezeCapsuleValue({...body,physicalObservationHash:hash('knowbook.restore.stage3.physical-observation.v1',body)})
}
function writeSql(db:Database.Database,actual:Actual,plan:Planned,marker:RootRestoreStage3Marker) {
  db.pragma('foreign_keys=ON');db.pragma('synchronous=FULL')
  db.transaction(()=>{
    context(db,plan.encoding,false);assertSchema(db,actual)
    for(const table of actual.data.inputs.current.source.sourceContent.tables)if(!ftsFootprint.has(table.name))exactTable(db,table,plan.encoding)
    db.pragma('defer_foreign_keys=ON')
    const app=raw(actual,'app_settings');insertRow(db,app,{sourceRowId:plan.markerRowId,cells:encodeValues(app.columns,plan.encoding,
      {key:stage3MarkerKey(marker.stageId),value:stage3MarkerJson(marker),updated_at:marker.preparedAt})},plan.encoding)
    // The registry is a declared complete content table. Removing it first is
    // the schema's atomic reference-transition rule, not a cut/history delete.
    db.exec('DELETE FROM main.synced_instances')
    const removed=new Map(plan.tables.map(table=>{const wanted=new Set(table.rows.map(row=>row.sourceRowId))
      return [table.name,new Set(raw(actual,table.name).rows.filter(row=>!wanted.has(row.sourceRowId)).map(row=>row.sourceRowId))] as const}))
    const foreign=foreignDeletePlans(db)
    // Saved-view names have an immediate NOCASE uniqueness constraint. A
    // legitimate source/current name permutation cannot be applied one row
    // at a time. The compiled trigger set contains no saved-view triggers;
    // additionally require the real complete FK inventory to have no inbound
    // reference before rebuilding this declared content table in this same
    // transaction. Every final row keeps its planned int64 rowid/raw cells.
    if((foreign.get('database_saved_views')??[]).length)return fail('保存视图重建存在未支持的入站FK')
    const oldViews=raw(actual,'database_saved_views')
    if(db.prepare('DELETE FROM main.database_saved_views').run().changes!==oldViews.rows.length)return fail('保存视图过渡未删除准确原行集合')
    const beforeViews:Capsule2RawSqlTable={...oldViews,rows:[]}
    // The compiled entity trigger also checks document uniqueness immediately.
    // Release only this nullable association, in place, before a permutation;
    // keep entity IDs/rowids and all dependent values. Compare against this
    // exact transitional table so even an otherwise unchanged association is
    // restored by upsertTargets, then verify the complete final table below.
    const oldEntities=raw(actual,'database_entities'),documentColumn=oldEntities.columns.indexOf('document_id')
    if(documentColumn<0)return fail('实体过渡缺document_id列')
    const associated=oldEntities.rows.filter(row=>row.cells[documentColumn][0]!=='null').length
    if(db.prepare('UPDATE main.database_entities SET document_id=NULL WHERE document_id IS NOT NULL').run().changes!==associated)
      return fail('实体过渡未释放准确原关联集合')
    const beforeEntities:Capsule2RawSqlTable={...oldEntities,rows:oldEntities.rows.map(row=>({...row,
      cells:row.cells.map((cell,index):RawRestoreSqlCell=>index===documentColumn?['null']:cell)}))}
    exactTable(db,beforeEntities,plan.encoding)
    const ledger=raw(actual,'block_identities')
    for(const row of plan.ledgerAdded){const state=ledger.columns.indexOf('state'),cells=[...row.cells];cells[state]=graph3Encode('retained',plan.encoding)
      insertRow(db,ledger,{...row,cells},plan.encoding)}
    for(const name of ['documents','databases','document_database_columns','database_saved_views','database_entities','document_templates','synced_groups'])
      upsertTargets(db,plan.tables.find(table=>table.name===name)!,name==='database_saved_views'?beforeViews
        :name==='database_entities'?beforeEntities:raw(actual,name),plan.encoding)
    for(const row of plan.lifecycleAdded)insertRow(db,raw(actual,'synced_group_lifecycle'),row,plan.encoding)
    for(const name of ['blocks','synced_group_blocks','database_entity_values','document_database_values'])
      upsertTargets(db,plan.tables.find(table=>table.name===name)!,raw(actual,name),plan.encoding)
    for(const name of ['database_entity_values','document_database_values','synced_group_blocks','blocks','database_entities','document_database_columns','document_templates','databases'])
      deleteRemoved(db,plan.tables.find(table=>table.name===name)!,raw(actual,name),plan.encoding,removed,foreign)
    for(const row of plan.tables.find(table=>table.name==='synced_instances')!.rows)insertRow(db,raw(actual,'synced_instances'),row,plan.encoding)
    // Native block/child triggers run during every real DML. Candidate layout
    // already contains final absolute counts, so their intermediate deltas must
    // not be added a second time. Recompute only these two declared fields from
    // the actual final SQL graph; link_count/links remain a later explicit plan.
    db.exec(`UPDATE main.documents SET
      block_count=(SELECT count(*) FROM main.blocks WHERE blocks.document_id=documents.id),
      child_count=(SELECT count(*) FROM main.documents AS children WHERE children.parent_id=documents.id)`)
    const documents=plan.tables.find(table=>table.name==='documents')!,blockCountIndex=documents.columns.indexOf('block_count'),
      childCountIndex=documents.columns.indexOf('child_count'),expectedCounts=new Map(documents.rows.map(row=>[row.sourceRowId,row]))
    if(blockCountIndex<0||childCountIndex<0)return fail('candidate/layout统计列缺失')
    const counts = db.prepare('SELECT _rowid_,block_count,child_count FROM main.documents ORDER BY _rowid_').safeIntegers(true).raw(true).iterate() as IterableIterator<[bigint,bigint,bigint]>
    for(const row of counts){
      if(row.some(value=>typeof value!=='bigint'))return fail('实际统计rowid/count不是原INTEGER')
      const expected=expectedCounts.get(row[0].toString())
      if(!expected||!same(expected.cells[blockCountIndex],['integer',row[1].toString()])
        ||!same(expected.cells[childCountIndex],['integer',row[2].toString()]))return fail('实际final统计不等于candidate/layout')
      expectedCounts.delete(row[0].toString())
    }
    if(expectedCounts.size)return fail('candidate/layout统计文档遗漏')
    // Every protected original row, including history/pins/life/settings and
    // all non-FTS derived rows, is compared before commit. Native FTS has the
    // sole fixed compiled-trigger footprint and its own exact final projection.
    observeSql(db,actual,plan,marker,false)
  }).immediate()
}

function intentBody(stageId:string,preparedAt:string,actual:Actual,copy:CopyInfo,reference:RootRestoreReferencePlan3,
  plan:Planned,originalRecoveryFamily:RootRestoreStage3Marker['originalRecoveryFamily']) {
  return {kind:'root-restore-non-executable-physical-stage-intent' as const,version:1 as const,stageId,preparedAt,
    copyId:copy.copyId,copyManifestHash:copy.manifestHash,...binding(actual,copy,reference),originalRecoveryFamily,
    originalCurrentSchemaHash:actual.data.inputs.current.source.sourceContent.schemaHash,targetEncoding:plan.encoding,
    planned12TablesHash:hash('knowbook.restore.stage3.planned-content.v1',plan.tables),
    sourceCandidate12TablesHash:plan.sourceCandidate12TablesHash,stageExecutionHash:plan.stageExecutionHash,
    plannedLedgerHash:hash('knowbook.restore.stage3.planned-ledger.v1',plan.ledger),
    plannedNewLifecycleHash:hash('knowbook.restore.stage3.planned-new-lifecycle.v1',plan.lifecycleAdded),markerRowId:plan.markerRowId,
    addedRowsBudget:{version:1,maxRowsPerAddedFamily:CAPSULE2_RAW_MAX_ROWS,maxValueBytesPerAddedFamily:CAPSULE2_RAW_MAX_VALUE_BYTES,
      jsonBudget:'existing-bounded-complete-dto' as const},
    currentStageComplete:false as const,historyCutComplete:false as const,semanticValidationComplete:false as const,
    acceptedCoverage:false as const,effective:false as const,permit:false as const}
}
const intentHash=(body:Intent)=>hash('knowbook.restore.stage3.physical-intent.v1',body)
function markerFor(intent:Intent):RootRestoreStage3Marker {
  return {kind:'root-restore-non-executable-stage',version:1,scope:'physical-candidate-only',stageId:intent.stageId,preparedAt:intent.preparedAt,
    copyId:intent.copyId,copyManifestHash:intent.copyManifestHash,stageIntentHash:intentHash(intent),referencePlanId:intent.referencePlanId,
    referenceManifestHash:intent.referenceManifestHash,baseIdentityAllocationHash:intent.baseIdentityAllocationHash,
    derivedReferenceAllocationHash:intent.derivedReferenceAllocationHash,checkedCanonicalCandidateHash:intent.checkedCanonicalCandidateHash,
    sourceMaterialHash:intent.sourceMaterialHash,currentMaterialHash:intent.currentMaterialHash,conservationHash:intent.conservationHash,
    originalDescriptorHash:intent.originalDescriptorHash,currentOriginalInventoryHash:intent.currentOriginalInventoryHash,
    originalRecoveryFamily:intent.originalRecoveryFamily,historyCutComplete:false,acceptedCoverage:false,effective:false,permit:false}
}
function manifestBody(intent:Intent,inventory:readonly DurableSqlCapsuleFile[],observation:Observation) {
  return {kind:'root-restore-non-executable-physical-stage-manifest' as const,version:1 as const,stageId:intent.stageId,
    stageIntentHash:intentHash(intent),markerHash:stage3MarkerHash(markerFor(intent)),referencePlanId:intent.referencePlanId,
    referenceManifestHash:intent.referenceManifestHash,copyId:intent.copyId,copyManifestHash:intent.copyManifestHash,
    sealedInventory:inventory,physicalObservationHash:observation.physicalObservationHash,
    nativeFtsProjection:observation.nativeFtsProjection,currentStageComplete:false as const,historyCutComplete:false as const,
    semanticValidationComplete:false as const,acceptedCoverage:false as const,effective:false as const,permit:false as const}
}
const stageManifestHash=(body:Manifest)=>hash('knowbook.restore.stage3.physical-manifest.v1',body)
async function inventory(directory:string,root:string) {
  const before=await assertOriginCatalogDirectory(directory,root),names=(await readdir(directory)).sort()
  const allowed=['knowbook.db','knowbook.db-wal','knowbook.db-shm']
  if(names.some(name=>!allowed.includes(name)))return fail('三文件目录含未知项或rollback journal')
  const result:DurableSqlCapsuleFile[]=[]
  for(const name of allowed){if(!names.includes(name)){result.push({name:name as DurableSqlCapsuleFile['name'],present:false,bytes:0,sha256:null});continue}
    const file=await readOriginCatalogFile(join(directory,name),root)
    result.push({name:name as DurableSqlCapsuleFile['name'],present:true,bytes:file.bytes,sha256:file.sha256})}
  const after=await assertOriginCatalogDirectory(directory,root)
  if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs
    ||!same(names,(await readdir(directory)).sort()))return fail('三文件目录读取期间变化')
  return validateDurableSqlCapsuleInventory(result)
}
async function exactInventory(directory:string,root:string,expected:readonly DurableSqlCapsuleFile[]) {
  if(!same(await inventory(directory,root),expected))return fail('实际封存DB/WAL/SHM全bytes清单变化')
}
async function copyThree(from:string,to:string,root:string,expected:readonly DurableSqlCapsuleFile[]) {
  await exactInventory(from,root,expected);await restoreDirectory(to,root,true)
  const created: Array<{ name: DurableSqlCapsuleFile['name']; dev: bigint; ino: bigint }> = []
  for(const file of expected)if(file.present){if(file.sha256===null)return fail('present文件缺hash')
    const identity = await copyOriginCatalogFileWithIdentity3(join(from,file.name),root,join(to,file.name),root,
      {path:file.name,bytes:file.bytes,sha256:file.sha256})
    created.push({ name: file.name, ...identity }) }
  await exactInventory(to,root,expected);await exactInventory(from,root,expected);await syncRestoreDirectory(to)
  return created
}
/** Exact existing capsule rule, only for a fresh independent readonly check
 * copy. Sealed currentCopy and sealed stage database never enter SQLite. */
async function afterReadonly(directory:string,root:string,expected:readonly DurableSqlCapsuleFile[]) {
  const actual=await inventory(directory,root),wal=expected[1]
  if(!same(actual[0],expected[0])||(wal.bytes>0?!same(actual[1],wal):actual[1].bytes!==0))return fail('只读检查改变DB/非空WAL或产生新SQL frames')
}
async function writeSmall(path:string,body:unknown,root:string) {
  const bytes=Buffer.from(capsuleJson(body)+'\n')
  if(bytes.length>maxSmallBytes)return fail('stage小清单超明确格式预算')
  await writeCapsule2AssetCopy(path,bytes,root)
}
async function readSmall(path:string,expected:unknown,root:string) {
  const bytes=capsuleJson(expected)+'\n'
  await readOriginCatalogFile(path,root,{path:'stage-owned-small-manifest',bytes:Buffer.byteLength(bytes),sha256:capsuleBytesHash(bytes)})
  if(await readCapsule2AssetManifest(path,root,maxSmallBytes)!==bytes)return fail('持久intent/manifest原TEXT变化')
}
async function initialFamily(databaseDirectory:string,root:string,expected:readonly DurableSqlCapsuleFile[],enc:Capsule2Encoding) {
  await exactInventory(databaseDirectory,root,expected)
  const db=new Database(restoreSqliteFilename(join(databaseDirectory,'knowbook.db')),{readonly:true,fileMustExist:true})
  try{db.pragma('query_only=ON');db.pragma('foreign_keys=ON')
    return db.transaction(()=>{context(db,enc,true);return readStage3OriginalRecoveryFamilyOwned(db)})()
  }finally{db.close();await afterReadonly(databaseDirectory,root,expected)}
}
async function observeIndependent(saved:Pick<Saved,'root'|'databaseDirectory'|'checksDirectory'>,actual:Actual,plan:Planned,marker:RootRestoreStage3Marker,
  expected:readonly DurableSqlCapsuleFile[]):Promise<Observation> {
  const check=join(saved.checksDirectory,randomUUID())
  await copyThree(saved.databaseDirectory,check,saved.root,expected)
  const db=new Database(restoreSqliteFilename(join(check,'knowbook.db')),{readonly:true,fileMustExist:true})
  try{db.pragma('query_only=ON');db.pragma('foreign_keys=ON')
    return db.transaction(()=>observeSql(db,actual,plan,marker,true))()
  }finally{db.close();await afterReadonly(check,saved.root,expected);await exactInventory(saved.databaseDirectory,saved.root,expected)}
}
async function outer(saved:Pick<Saved,'directory'|'root'>) {
  await assertOriginCatalogDirectory(saved.directory,saved.root)
  if(!same((await readdir(saved.directory)).sort(),['checks','database','intent.json','manifest.json']))return fail('stage顶层闭集变化')
}
function stageValue(saved:Saved,observation:Observation) {
  const value={kind:'main-root-restore-non-executable-physical-stage-data' as const,version:1 as const,
    stageId:saved.intent.stageId,stageManifestHash:saved.manifestHash,stageIntentHash:saved.intentHash,
    checkedCanonicalCandidateHash:saved.intent.checkedCanonicalCandidateHash,...observation,
    materializedInIndependentSql:true as const,ordinaryNativeFtsProjectionReadback:true as const,
    finalCurrentRetainedCutComplete:false as const,portableAssetsInstalled:false as const,
    installPermit:false as const}
  assertMerge3JsonBudget(value)
  return freezeCapsuleValue(value)
}
type PreparedPhysicalStage3 = Readonly<{ stage: RootRestorePhysicalStage3; value: ReturnType<typeof stageValue>;
  stageId: string; manifestHash: string; directory: string }>
function finishHeldStageRead(saved: Saved, observation: Observation, mode: 'read'): Promise<ReturnType<typeof stageValue>>
function finishHeldStageRead(saved: Saved, observation: Observation, mode: 'mint'): Promise<PreparedPhysicalStage3>
async function finishHeldStageRead(saved: Saved, observation: Observation, mode: 'read' | 'mint') {
  const inventory = saved.manifest.sealedInventory
  const small = [['intent.json', saved.intent], ['manifest.json', saved.manifest]] as const
  const held = await holdRootRestoreStage3Files3({ profileRoot: saved.root,
    directories: [{ path: saved.directory, entries: ['checks', 'database', 'intent.json', 'manifest.json'] },
      { path: saved.databaseDirectory, entries: inventory.filter(file => file.present).map(file => file.name) }],
    files: [...small.map(([name, body]) => { const bytes = capsuleJson(body) + '\n'; return {
      path: join(saved.directory, name), bytes: Buffer.byteLength(bytes), sha256: capsuleBytesHash(bytes) } }),
      ...inventory.filter(file => file.present).map(file => ({ path: join(saved.databaseDirectory, file.name), bytes: file.bytes,
        sha256: file.sha256 ?? fail('present stage文件缺hash') }))],
    absentFiles: inventory.filter(file => !file.present).map(file => join(saved.databaseDirectory, file.name)) })
  try {
    await readRootRestoreCurrentCopyForStage3(saved.copy)
    await assertRootRestoreReferenceOriginalBytes3(saved.reference)
    await readSmall(join(saved.directory, 'intent.json'), saved.intent, saved.root)
    await readSmall(join(saved.directory, 'manifest.json'), saved.manifest, saved.root)
    const value = stageValue(saved, observation)
    assertRootRestoreStage3FilesHeld3(held)
    if (mode === 'read') return value
    const stage: RootRestorePhysicalStage3 = Object.freeze({ kind: 'main-root-restore-non-executable-physical-stage' })
    stages.set(stage, saved)
    return Object.freeze({ stage, value, stageId: saved.intent.stageId, manifestHash: saved.manifestHash, directory: saved.directory })
  } finally { closeRootRestoreStage3FilesHeld3(held) }
}
async function reconstruct(saved:Saved) {
  await outer(saved);await readSmall(join(saved.directory,'intent.json'),saved.intent,saved.root)
  await readSmall(join(saved.directory,'manifest.json'),saved.manifest,saved.root)
  await exactInventory(saved.databaseDirectory,saved.root,saved.manifest.sealedInventory)
  // Exactly one complete original SQL/K/reference joint read for this public
  // call. Copy, marker and stage readback do no second original certification.
  const actual=await readRootRestoreReferenceGraphInputs3(saved.reference),copy=await readRootRestoreCurrentCopyForStage3(saved.copy)
  const plan=planSql(actual,saved.intent.preparedAt)
  const intended=intentBody(saved.intent.stageId,saved.intent.preparedAt,actual,copy,saved.reference,plan,saved.intent.originalRecoveryFamily)
  if(!same(intended,saved.intent)||intentHash(intended)!==saved.intentHash)return fail('fresh原件/reference不等于持久物化intent')
  const observed=await observeIndependent(saved,actual,plan,markerFor(saved.intent),saved.manifest.sealedInventory)
  if(observed.physicalObservationHash!==saved.manifest.physicalObservationHash
    ||stageManifestHash(manifestBody(saved.intent,saved.manifest.sealedInventory,observed))!==saved.manifestHash)return fail('实际SQL回读不等于持久stage')
  return finishHeldStageRead(saved, observed, 'read')
}
/** Sole top-level producer. No caller DB/path/rows, mapper, loader, seed or
 * callback enters. currentCopy remains unopened; only its fresh exclusive
 * working three-file copy is opened as an independent main database. */
export async function prepareRootRestorePhysicalStage3(reference:RootRestoreReferencePlan3) {
  const actual=await readRootRestoreReferenceGraphInputs3(reference)
  acceptCandidate(actual)
  const preparedCopy=await prepareRootRestoreCurrentCopy3(reference)
  const copy=await readRootRestoreCurrentCopyForStage3(preparedCopy.copy)
  binding(actual,copy,reference)
  const stageId=randomUUID(),preparedAt=new Date().toISOString(),plan=planSql(actual,preparedAt)
  const collection=join(copy.profileRoot,'backups','database-restore',copy.operationId,'restore-physical-stages-v3')
  const directory=join(collection,stageId),databaseDirectory=join(directory,'database'),checksDirectory=join(directory,'checks')
  await restoreDirectory(collection,copy.profileRoot);await restoreDirectory(directory,copy.profileRoot,true)
  await restoreDirectory(checksDirectory,copy.profileRoot,true)
  const createdWorking = await copyThree(copy.databaseDirectory,databaseDirectory,copy.profileRoot,copy.value.originalInventory)
  // Even the initial readonly family read gets its own probe. The working
  // three files stay unopened, with their original wx creation identities,
  // until the single synchronous writable section below.
  const familyProbe = join(checksDirectory, randomUUID())
  await copyThree(copy.databaseDirectory, familyProbe, copy.profileRoot, copy.value.originalInventory)
  const originalRecoveryFamily=await initialFamily(familyProbe,copy.profileRoot,copy.value.originalInventory,plan.encoding)
  const intent=intentBody(stageId,preparedAt,actual,copy,reference,plan,originalRecoveryFamily),marker=markerFor(intent)
  await writeSmall(join(directory,'intent.json'),intent,copy.profileRoot);await syncRestoreDirectory(directory)
  const writable = await holdRootRestoreStage3DatabaseFiles3({ profileRoot: copy.profileRoot, databaseDirectory,
    inventory: copy.value.originalInventory, purpose: 'writable-open', expectedCreatedIdentities: createdWorking })
  let db: Database.Database | undefined, authorized = false
  try {
    assertRootRestoreStage3FilesHeld3(writable)
    db = new Database(restoreSqliteFilename(join(databaseDirectory, 'knowbook.db')), { fileMustExist: true })
    assertRootRestoreStage3WritableMain3(writable, db); authorized = true
    writeSql(db, actual, plan, marker)
  } finally {
    try { if (db?.open) db.close(); if (db && authorized) assertRootRestoreStage3WrittenMainClosed3(writable, db) }
    finally { closeRootRestoreStage3FilesHeld3(writable) }
  }
  const sealedInventory=await inventory(databaseDirectory,copy.profileRoot)
  for(const file of sealedInventory)if(file.present)await syncRestoreFile(join(databaseDirectory,file.name))
  await syncRestoreDirectory(databaseDirectory);await exactInventory(databaseDirectory,copy.profileRoot,sealedInventory)
  const observed=await observeIndependent({root:copy.profileRoot,databaseDirectory,checksDirectory},actual,plan,marker,sealedInventory)
  const manifest=manifestBody(intent,sealedInventory,observed)
  await writeSmall(join(directory,'manifest.json'),manifest,copy.profileRoot)
  await syncRestoreDirectory(databaseDirectory);await syncRestoreDirectory(directory);await syncRestoreDirectory(collection)
  await syncOriginCatalogAncestors(collection,copy.profileRoot)
  const saved:Saved={reference,copy:preparedCopy.copy,directory,databaseDirectory,checksDirectory,root:copy.profileRoot,
    intent,intentHash:intentHash(intent),manifest,manifestHash:stageManifestHash(manifest)}
  // Reuse only this invocation's actual SQL readback. Do not call reconstruct
  // here, which would add a second complete original SQL/K read to preparation.
  return finishHeldStageRead(saved, observed, 'mint')
}
export async function readRootRestorePhysicalStage3(stage:RootRestorePhysicalStage3) {
  const saved=stages.get(stage)
  if(!saved)return fail('不是实际Main物理stage句柄')
  return reconstruct(saved)
}

const coldIntentKeys = ['kind','version','stageId','preparedAt','copyId','copyManifestHash','referencePlanId','referenceManifestHash',
  'baseIdentityAllocationHash','derivedReferenceAllocationHash','checkedCanonicalCandidateHash','sourceMaterialHash','currentMaterialHash',
  'conservationHash','originalDescriptorHash','currentOriginalInventoryHash','originalRecoveryFamily','originalCurrentSchemaHash','targetEncoding',
  'planned12TablesHash','sourceCandidate12TablesHash','stageExecutionHash','plannedLedgerHash','plannedNewLifecycleHash','markerRowId','addedRowsBudget','currentStageComplete','historyCutComplete',
  'semanticValidationComplete','acceptedCoverage','effective','permit'] as const
const coldManifestKeys = ['kind','version','stageId','stageIntentHash','markerHash','referencePlanId','referenceManifestHash','copyId',
  'copyManifestHash','sealedInventory','physicalObservationHash','nativeFtsProjection','currentStageComplete','historyCutComplete',
  'semanticValidationComplete','acceptedCoverage','effective','permit'] as const
async function coldSmall(path:string,root:string) {
  const bytes=await readCapsule2AssetManifest(path,root,maxSmallBytes)
  let parsed:unknown
  try{parsed=JSON.parse(bytes)}catch{return fail('cold stage小清单不是完整JSON')}
  return {bytes,parsed}
}
/** Genuine reference plus finite durable locator. No expected content, stored
 * candidate, caller copy/path or seed is a factory input. Neither sealed
 * currentCopy nor sealed stage database is ever opened by SQLite. */
export async function reopenRootRestorePhysicalStage3(reference:RootRestoreReferencePlan3,
  input:{readonly stageId:string;readonly expectedManifestHash:string}) {
  const owner=await readRootRestoreReferenceCopySource3(reference)
  const locator=capsuleRecord(input,['stageId','expectedManifestHash'])
  const stageId=durableSqlDagUuid(locator.stageId),expected=durableSqlDagHash(locator.expectedManifestHash)
  const root=owner.location.profileRoot,directory=join(root,'backups','database-restore',owner.location.operationId,'restore-physical-stages-v3',stageId)
  const databaseDirectory=join(directory,'database'),checksDirectory=join(directory,'checks')
  await outer({directory,root});await assertOriginCatalogDirectory(checksDirectory,root)
  const manifestFile=await coldSmall(join(directory,'manifest.json'),root)
  const manifestRow=capsuleRecord(manifestFile.parsed,coldManifestKeys)
  if(manifestRow.kind!=='root-restore-non-executable-physical-stage-manifest'||manifestRow.version!==1
    ||manifestRow.stageId!==stageId||manifestRow.referencePlanId!==owner.referencePlanId||manifestRow.referenceManifestHash!==owner.referenceManifestHash)
    return fail('cold stage未知版本或不是同genuine reference')
  for(const key of ['currentStageComplete','historyCutComplete','semanticValidationComplete','acceptedCoverage','effective','permit'] as const)
    if(manifestRow[key]!==false)return fail('cold stage非法升级完成/许可')
  const sealedInventory=validateDurableSqlCapsuleInventory(manifestRow.sealedInventory)
  const untrustedManifest={...manifestRow,sealedInventory} as unknown as Manifest
  if(manifestFile.bytes!==capsuleJson(untrustedManifest)+'\n'||stageManifestHash(untrustedManifest)!==expected)
    return fail('cold stage完整manifest bytes/hash不符')
  const intentFile=await coldSmall(join(directory,'intent.json'),root),intentRow=capsuleRecord(intentFile.parsed,coldIntentKeys)
  const preparedAt=intentRow.preparedAt,copyId=durableSqlDagUuid(intentRow.copyId),copyHash=durableSqlDagHash(intentRow.copyManifestHash)
  if(intentRow.kind!=='root-restore-non-executable-physical-stage-intent'||intentRow.version!==1||intentRow.stageId!==stageId
    ||typeof preparedAt!=='string'||!Number.isFinite(Date.parse(preparedAt))||new Date(preparedAt).toISOString()!==preparedAt
    ||copyId!==manifestRow.copyId||copyHash!==manifestRow.copyManifestHash)return fail('cold stage intent版本/locator/原时点不闭合')
  // One complete original SQL/K read in this public call. The following extra
  // native read is only the small original recovery-family footprint, on its
  // own fresh currentCopy probe; it is not another complete certification.
  const actual=await readRootRestoreReferenceGraphInputs3(reference),plan=planSql(actual,preparedAt)
  const reopenedCopy=await reopenRootRestoreCurrentCopy3(reference,{copyId,expectedManifestHash:copyHash})
  const copy=await readRootRestoreCurrentCopyForStage3(reopenedCopy.copy)
  binding(actual,copy,reference)
  const originalProbe=join(checksDirectory,randomUUID())
  await copyThree(copy.databaseDirectory,originalProbe,root,copy.value.originalInventory)
  const originalRecoveryFamily=await initialFamily(originalProbe,root,copy.value.originalInventory,plan.encoding)
  const intended=intentBody(stageId,preparedAt,actual,copy,reference,plan,originalRecoveryFamily)
  if(intentFile.bytes!==capsuleJson(intended)+'\n'||intentHash(intended)!==manifestRow.stageIntentHash)
    return fail('cold stage intent不能从同genuine reference/currentCopy实际重建')
  await readSmall(join(directory,'intent.json'),intended,root)
  await exactInventory(databaseDirectory,root,sealedInventory)
  const observed=await observeIndependent({root,databaseDirectory,checksDirectory},actual,plan,markerFor(intended),sealedInventory)
  const manifest=manifestBody(intended,sealedInventory,observed)
  if(!same(manifest,untrustedManifest)||stageManifestHash(manifest)!==expected)return fail('cold实际SQL回读不等于持久stage')
  const saved:Saved={reference,copy:reopenedCopy.copy,directory,databaseDirectory,checksDirectory,root,intent:intended,
    intentHash:intentHash(intended),manifest,manifestHash:expected}
  return finishHeldStageRead(saved, observed, 'mint')
}
