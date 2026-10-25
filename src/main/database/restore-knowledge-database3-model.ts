import { createHmac } from 'node:crypto'
import { DATABASE_SYSTEM_FIELD_IDS } from '../../shared/database-workspace'
import { collectDatabaseViewConfigFieldIds, mapDatabaseViewConfigFieldIds, mapDatabaseViewReferences,
  parseDatabaseViewPayload, serializeDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { strictSavedViewConfig } from '../backup/v2-format'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Key, graph3PatchTable, graph3Rows, graph3Text, type Graph3Inputs } from './restore-knowledge-graph3-data'

type Kind = 'database' | 'column' | 'view' | 'entity' | 'document'
type Reference = { kind: 'database' | 'column' | 'view'; sourceDatabaseId: string | null; sourceId: string;
  targetId: string; state: 'physical' | 'missing-reservation' | 'symbolic'; allocation: 'identity-plan' | 'qualified-missing' | 'system-field' }
const systemFields = new Set<string>(Object.values(DATABASE_SYSTEM_FIELD_IDS))
const text = (value: unknown): string => typeof value === 'string' ? value : graph3Conflict('expected-original-text', typeof value)

/** A deterministic data transform, never a handle/coverage/installation factory.
 * The Main owner supplies one fresh authenticated allocation + original read.
 * Only declared database references are interpreted; queries, values and other
 * business TEXT are opaque, even when they contain IDs or URL-like strings. */
export function deriveRootRestoreDatabaseReferences3(data: Graph3Inputs) {
  const source = data.inputs.source.source.sourceContent, current = data.inputs.current.source.sourceContent
  const rows = (name: string) => graph3Rows(source, name)
  const physical = new Map<Kind, Map<string, Record<string,unknown>>>([
    ['database', new Map(rows('databases').map(row=>[text(row.value.id),row.value]))],
    ['column', new Map(rows('document_database_columns').map(row=>[text(row.value.id),row.value]))],
    ['view', new Map(rows('database_saved_views').map(row=>[text(row.value.id),row.value]))],
    ['entity', new Map(rows('database_entities').map(row=>[text(row.value.id),row.value]))],
    ['document', new Map(rows('documents').map(row=>[text(row.value.id),row.value]))]
  ])
  const byIdentity = new Map<string, typeof data.value.assignments>()
  for (const item of data.value.assignments) {
    const key = graph3Key(item.kind,item.sourceId), values = byIdentity.get(key) ?? []
    byIdentity.set(key,[...values,item])
  }
  const references = new Map<string,Reference>(), used = new Set<string>()
  // Full original K contains retained execution tokens and history literals.
  // They only exclude fresh IDs here; scanning cannot mint semantic references.
  for (const payload of data.inputs.knowledge.constraints.payloads) {
    const projection = payload.input.knowledge.projection
    for (const item of projection.occupancy) used.add(item.id)
    for (const table of projection.originals) for (const row of table.rows) for (const cell of row.cells) {
      if (cell[0] !== 'text') continue
      for (const match of graph3Text(cell,projection.encoding).matchAll(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi)) used.add(match[0].toLowerCase())
    }
  }
  for (const content of [source,current]) for (const table of content.tables) for (const row of table.rows) for (const cell of row.cells) {
    if (cell[0] !== 'text') continue
    for (const match of graph3Text(cell,content.encoding).matchAll(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi)) used.add(match[0].toLowerCase())
  }
  for (const item of data.value.assignments) { used.add(item.targetId); if (item.targetCreationId) used.add(item.targetCreationId) }
  for (const match of capsuleJson(data.value.execution).matchAll(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi)) used.add(match[0].toLowerCase())
  // A qualified missing slot is distinct from a physical object with the same
  // spelling under another DB, and from a missing slot under another DB.
  const fresh = (purpose: string): string => {
    for (let attempt=0; attempt<64; attempt++) {
      const bytes = createHmac('sha256',Buffer.from(data.kernel.seed,'hex')).update(graph3Key('knowbook.restore.database3.uuid.v1',
        data.value.allocationHash,purpose,attempt)).digest().subarray(0,16)
      bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128
      const hex=bytes.toString('hex'), id=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
      if (used.has(id)) continue
      used.add(id); return id
    }
    return graph3Conflict('qualified-missing-identity-budget',purpose)
  }
  const physicalId = (kind: Kind, id: string): string => {
    if (!physical.get(kind)!.has(id)) return graph3Conflict('missing-physical-database-row',{kind,id})
    const slots = (byIdentity.get(graph3Key(kind,id)) ?? []).filter(item=>item.physical && !item.ambiguous)
    if (slots.length !== 1) return graph3Conflict('ambiguous-physical-database-row',{kind,id})
    return slots[0].targetId
  }
  const resolve = (kind: Reference['kind'], id: string, databaseId: string | null = null): string => {
    const key = graph3Key(kind,databaseId,id), previous = references.get(key)
    if (previous) return previous.targetId
    const row = physical.get(kind)!.get(id), live = row !== undefined && (kind === 'database' || row.database_id === databaseId)
    const symbolic = kind === 'column' && systemFields.has(id)
    let targetId: string, allocation: Reference['allocation'], state: Reference['state']
    if (symbolic) { targetId=id; allocation='system-field'; state='symbolic' }
    else if (live) { targetId=physicalId(kind,id); allocation='identity-plan'; state='physical' }
    else {
      const slots = (byIdentity.get(graph3Key(kind,id)) ?? []).filter(item=>!item.physical && !item.ambiguous
        && (kind === 'database' || item.ownerKind === 'database' && item.ownerId === databaseId))
      if (slots.length > 1) return graph3Conflict('ambiguous-missing-database-reference',{kind,id,databaseId})
      targetId=slots.length ? slots[0].targetId : fresh(key)
      allocation=slots.length ? 'identity-plan' : 'qualified-missing'; state='missing-reservation'
    }
    references.set(key,{kind,sourceDatabaseId:databaseId,sourceId:id,targetId,state,allocation})
    return targetId
  }
  const mapPayload = (raw: string): string => {
    const before = parseDatabaseViewPayload(raw), after = mapDatabaseViewReferences(before,{
      databaseId:id=>resolve('database',id), viewId:(db,id)=>resolve('view',id,db), fieldId:(db,id)=>resolve('column',id,db)
    })
    return capsuleJson(before) === capsuleJson(after) ? raw : serializeDatabaseViewPayload(after)
  }
  const mapTemplate = (raw: string): string => {
    const blocks: unknown = JSON.parse(raw)
    if (!Array.isArray(blocks)) return graph3Conflict('template-block-array',null)
    let changed = false
    const mapped = blocks.map((block: unknown)=>{
      if (!block || typeof block !== 'object' || Array.isArray(block)) return graph3Conflict('template-block-object',null)
      const value=block as Record<string,unknown>
      if (value.type !== 'database-view') return value
      const before=text(value.content), content=mapPayload(before)
      if (before === content) return value
      changed=true; return {...value,content}
    })
    return changed ? JSON.stringify(mapped) : raw
  }
  const changedCells: {table:string;sourceRowId:string;columns:string[]}[] = []
  const tables = source.tables.filter(table=>table.role === 'content').map(table=>graph3PatchTable(table,source.encoding,(row,rowId)=>{
    let changes: Record<string,string | null | bigint> = {}
    const id=()=>text(row.id), db=()=>text(row.database_id)
    switch (table.name) {
      case 'databases': changes={id:physicalId('database',id())}; break
      case 'document_database_columns': changes={id:physicalId('column',id()),database_id:physicalId('database',db())}; break
      case 'database_saved_views': {
        const before = strictSavedViewConfig(text(row.config_json),Number(row.config_version),{
          filterQuery:text(row.filter_query),filterScope:text(row.filter_scope),sortMode:text(row.sort_mode),viewMode:text(row.view_mode)
        })
        // Read every declared field, including missing fields that K's block
        // reference projection cannot see in a stored saved-view config.
        for (const field of collectDatabaseViewConfigFieldIds(before)) resolve('column',field,db())
        const after=mapDatabaseViewConfigFieldIds(before,field=>resolve('column',field,db()))
        changes={id:physicalId('view',id()),database_id:physicalId('database',db()),
          config_json:capsuleJson(before) === capsuleJson(after) ? text(row.config_json) : capsuleJson(after)}
        break
      }
      case 'database_entities': changes={id:physicalId('entity',id()),database_id:physicalId('database',db()),
        document_id:row.document_id === null ? null : physicalId('document',text(row.document_id))}; break
      case 'database_entity_values': {
        const entity=text(row.entity_id), column=text(row.column_id)
        const owner=physical.get('entity')!.get(entity), field=physical.get('column')!.get(column)
        if (!owner || !field || owner.database_id !== field.database_id) return graph3Conflict('cross-database-entity-value',{entity,column})
        changes={entity_id:physicalId('entity',entity),column_id:physicalId('column',column)}; break
      }
      case 'document_database_values': changes={column_id:physicalId('column',text(row.column_id)),
        document_id:row.document_id === null ? null : physicalId('document',text(row.document_id)),
        entity_id:row.entity_id === null ? null : physicalId('entity',text(row.entity_id))}; break
      case 'blocks': case 'synced_group_blocks': if (row.type === 'database-view') changes={content:mapPayload(text(row.content))}; break
      case 'document_templates': changes={blocks_json:mapTemplate(text(row.blocks_json))}; break
    }
    const columns=Object.keys(changes).filter(column=>changes[column] !== row[column])
    if (columns.length) changedCells.push({table:table.name,sourceRowId:rowId,columns})
    return changes
  }))
  // Check every missing slot against the *candidate* DB namespace as well as
  // current's physical IDs. A missing reference must not turn into a live field
  // when the default source and target catalogs are intentionally identified.
  const candidateIds = new Map<Reference['kind'],Set<string>>(), currentIds = new Map<Reference['kind'],Set<string>>()
  for (const [kind,name] of [['database','databases'],['column','document_database_columns'],['view','database_saved_views']] as const) {
    candidateIds.set(kind,new Set([...physical.get(kind)!.keys()].map(id=>physicalId(kind,id))))
    currentIds.set(kind,new Set(graph3Rows(current,name).map(row=>text(row.value.id))))
  }
  for (const reference of references.values()) if (reference.state === 'missing-reservation') {
    if (candidateIds.get(reference.kind)!.has(reference.targetId) || currentIds.get(reference.kind)!.has(reference.targetId))
      return graph3Conflict('missing-reference-would-activate',reference)
  }
  const body = { kind:'complete-root-restore-database-reference-candidate' as const,version:3 as const,
    conservationHash:data.inputs.knowledge.conservationHash,identityAllocationHash:data.value.allocationHash,
    sourceMaterialHash:data.inputs.source.materialHash,currentMaterialHash:data.inputs.current.materialHash,
    tables,changedCells,references:[...references.values()],databaseReferencesRewritten:true as const,
    sourcePolicyReplayed:false as const,sourceHistoryReplayed:false as const,structuralMergeStillRequired:true as const,
    referenceRewriteComplete:false as const,semanticValidationComplete:false as const,acceptedCoverage:false as const,effective:false as const,permit:false as const }
  const encoded=capsuleJson(body)
  if (Buffer.byteLength(encoded)>CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-database-reference-candidate-budget',null)
  return freezeCapsuleValue({...body,databaseReferenceHash:capsuleBytesHash('knowbook.restore.database3.candidate.v1\0'+encoded)})
}
