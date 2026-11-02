import type Database from 'better-sqlite3'
import type { WorkspaceSearchOccurrence, WorkspaceSearchOccurrenceResult, SyncedInlineInstanceResult } from '../../shared/workspace-search-occurrence'
import { validateWorkspaceSearchOccurrence, isSameWorkspaceSearchOccurrence, validateSyncedInlineInstanceAddress } from '../../shared/workspace-search-occurrence'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'
import { assertSyncedLifecycleCoverage } from './synced-lifecycle-state'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { readRawSyncedGroupSnapshotsOwned } from './synced-blocks-raw-read'
import { readStrictHostDocument, readRawCapsule2HostDocumentOwned } from './synced-host-document-read'
import { LOGICAL_DELETION_PREFIX } from '../sync/synced-logical-deletion-model'
import { canonicalSearchSnippet, sqliteTrigramTermsMatch } from './workspace-search-trigram'

export interface SyncedInlineInstanceSqlRow {
  document_id:string;document_title:string;document_path:string;updated_at:string
  instance_order:number
  workspace_scope:string;recovery_epoch:string;host_created_at:string
  instance_id:string;instance_created_at:string;binding_version:string;parent_block_id:string|null;instance_depth:number
  group_id:string;creation_id:string;group_created_at:string;revision:string;topology_revision:string
}
export interface CanonicalSearchOccurrenceRow extends SyncedInlineInstanceSqlRow {
  block_id:string;block_type:string;content:string;tags_json:string;block_order:number;canonical_created_at:string
}
/** A readonly SQL projection over actual physical rows. It has no transient
 * host copies, JSON-text search index, generated persistent ID or install right.
 * Native restore probes can use the same projection on their own independent
 * SQL main. Every occurrence remains (host, instance, group, child). */
const instanceColumns=`d.id AS document_id,d.title AS document_title,d.path AS document_path,d.updated_at,h.sort_order AS instance_order,
  w.workspace_scope,w.recovery_epoch,d.created_at AS host_created_at,i.instance_id,h.created_at AS instance_created_at,
  i.binding_version,i.parent_block_id,i.depth AS instance_depth,g.id AS group_id,g.creation_id,g.created_at AS group_created_at,
  g.revision,g.topology_revision`
const instanceFrom=`FROM main.synced_groups g
  JOIN main.synced_group_lifecycle l ON l.group_id=g.id AND l.creation_id=g.creation_id AND l.state='active'
  JOIN main.synced_instances i ON i.group_id=g.id JOIN main.blocks h ON h.id=i.instance_id
  JOIN main.documents d ON d.id=i.host_document_id AND d.id=h.document_id
  JOIN main.synced_workspace_state w ON w.singleton=1
  JOIN main.block_identities hi ON hi.id=h.id AND hi.last_owner_kind='document' AND hi.last_owner_id=d.id AND hi.state='live' AND hi.created_at=h.created_at`
const instanceWhere=`h.type='synced-block' AND h.parent_block_id IS i.parent_block_id AND h.depth=i.depth
  AND CASE WHEN json_valid(h.content) THEN json_extract(h.content,'$.groupId') ELSE NULL END=g.id
  AND NOT EXISTS(SELECT 1 FROM main.synced_operations o WHERE o.client_operation_id='${LOGICAL_DELETION_PREFIX}group:'||g.id||':'||g.creation_id)`
export const syncedInlineInstancesSql=`SELECT ${instanceColumns} ${instanceFrom} WHERE ${instanceWhere}`
export const canonicalSearchOccurrencesSql=`SELECT ${instanceColumns},c.id AS block_id,c.type AS block_type,c.content,
  coalesce(c.tags_json,'[]') AS tags_json,c.sort_order AS block_order,c.created_at AS canonical_created_at
  ${instanceFrom} JOIN main.synced_group_blocks c ON c.group_id=g.id
  JOIN main.block_identities ci ON ci.id=c.id AND ci.last_owner_kind='group' AND ci.last_owner_id=g.id AND ci.state='live' AND ci.created_at=c.created_at
  WHERE ${instanceWhere}`

function owned(db:Database.Database){if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27)throw new Error('Canonical search requires the actual schema27 SQL snapshot.')}
const registered=new WeakSet<Database.Database>()
export function registerCanonicalSearchFunctions(db:Database.Database):void {
  if(registered.has(db))return
  const terms=(encoded:unknown):string[]=>{
    if(typeof encoded!=='string')throw new Error('Canonical search terms must be encoded TEXT.')
    const values:unknown=JSON.parse(encoded)
    if(!Array.isArray(values)||values.length>32||values.some(value=>typeof value!=='string'))throw new Error('Canonical search terms differ from the normalized literal query.')
    return values as string[]
  }
  db.function('knowbook_canonical_terms_v1',{deterministic:true},(content:unknown,encoded:unknown,any:unknown)=>{
    if(typeof content!=='string'||any!==0&&any!==1)throw new Error('Canonical search literal must be actual SQL TEXT.')
    return Number(sqliteTrigramTermsMatch(content,terms(encoded),any===1))
  })
  db.function('knowbook_canonical_snippet_v1',{deterministic:true},(content:unknown,encoded:unknown)=>{
    if(typeof content!=='string')throw new Error('Canonical snippet must use actual SQL TEXT.')
    return canonicalSearchSnippet(content,terms(encoded))
  })
  registered.add(db)
}
/** Boundary records are denial evidence. Invalid live joins are rejected,
 * never silently filtered into a smaller count or an apparently empty page. */
export function assertCanonicalSearchSnapshotOwned(db:Database.Database):void {
  owned(db);assertSyncedRecoveryBoundaryRecords(db);assertSyncedLifecycleCoverage(db);assertSyncedLogicalDeletionRecords(db)
  if(db.prepare(`SELECT 1 FROM synced_group_blocks c JOIN synced_group_lifecycle l ON l.group_id=c.group_id AND l.state='active'
    LEFT JOIN block_identities ci ON ci.id=c.id WHERE ci.id IS NULL OR ci.last_owner_kind<>'group' OR ci.last_owner_id<>c.group_id
    OR ci.state<>'live' OR ci.created_at IS NOT c.created_at OR EXISTS(SELECT 1 FROM blocks b WHERE b.id=c.id) LIMIT 1`).get())
    throw new Error('Canonical search encountered an invalid physical canonical owner/birth.')
  if(db.prepare(`SELECT 1 FROM block_identities ci JOIN synced_group_lifecycle l ON l.group_id=ci.last_owner_id AND l.state='active'
    WHERE ci.last_owner_kind='group' AND ci.state='live' AND NOT EXISTS(SELECT 1 FROM synced_group_blocks c WHERE c.id=ci.id AND c.group_id=ci.last_owner_id) LIMIT 1`).get())
    throw new Error('Canonical search encountered a live identity without its actual canonical row.')
  if(db.prepare(`SELECT 1 FROM synced_instances i JOIN synced_group_lifecycle l ON l.group_id=i.group_id AND l.state='active'
    LEFT JOIN blocks h ON h.id=i.instance_id LEFT JOIN documents d ON d.id=i.host_document_id LEFT JOIN blocks p ON p.id=h.parent_block_id
    LEFT JOIN block_identities hi ON hi.id=h.id WHERE h.id IS NULL OR d.id IS NULL OR h.document_id IS NOT i.host_document_id
    OR h.type<>'synced-block' OR h.parent_block_id IS NOT i.parent_block_id OR h.depth IS NOT i.depth
    OR CASE WHEN json_valid(h.content) THEN json_extract(h.content,'$.groupId') ELSE NULL END IS NOT i.group_id
    OR hi.state IS NOT 'live' OR hi.last_owner_kind IS NOT 'document' OR hi.last_owner_id IS NOT d.id OR hi.created_at IS NOT h.created_at
    OR (i.depth=0 AND i.parent_block_id IS NOT NULL) OR (i.depth>0 AND (p.id IS NULL OR p.document_id IS NOT d.id OR p.depth<>i.depth-1))
    OR EXISTS(SELECT 1 FROM blocks child WHERE child.parent_block_id=h.id) LIMIT 1`).get())
    throw new Error('Canonical search encountered an invalid real host instance binding.')
  if(db.prepare(`SELECT 1 FROM blocks h JOIN synced_groups g ON CASE WHEN json_valid(h.content) THEN json_extract(h.content,'$.groupId') ELSE NULL END=g.id
    JOIN synced_group_lifecycle l ON l.group_id=g.id AND l.state='active' LEFT JOIN synced_instances i ON i.instance_id=h.id
    WHERE h.type='synced-block' AND (i.instance_id IS NULL OR i.group_id<>g.id OR i.host_document_id<>h.document_id) LIMIT 1`).get())
    throw new Error('Canonical search encountered an unregistered actual host leaf.')
}
export function occurrenceFromCanonicalSearchRow(row:CanonicalSearchOccurrenceRow):WorkspaceSearchOccurrence {
  return validateWorkspaceSearchOccurrence({...inlineInstanceFromRow(row),canonicalBlockId:row.block_id,canonicalCreatedAt:row.canonical_created_at})
}
export function inlineInstanceFromRow(row:SyncedInlineInstanceSqlRow) {
  return validateSyncedInlineInstanceAddress({version:1,workspaceScope:row.workspace_scope,recoveryEpoch:row.recovery_epoch,
    hostDocumentId:row.document_id,hostCreatedAt:row.host_created_at,instanceId:row.instance_id,instanceCreatedAt:row.instance_created_at,
    bindingVersion:row.binding_version,parentBlockId:row.parent_block_id,depth:row.instance_depth,groupId:row.group_id,creationId:row.creation_id,
    groupCreatedAt:row.group_created_at,revision:row.revision,topologyRevision:row.topology_revision})
}
export function validateCanonicalSearchPageOwned(db:Database.Database,rows:readonly CanonicalSearchOccurrenceRow[],
  representation:{kind:'raw'}|{kind:'snippet';terms:readonly string[]}={kind:'raw'}) {
  owned(db)
  const snapshots=readRawSyncedGroupSnapshotsOwned(db,[...new Set(rows.map(row=>row.group_id))])
  const hosts=new Map<string,ReturnType<typeof readStrictHostDocument>>()
  const snippets=new Map<string,string>()
  for(const row of rows){let host=hosts.get(row.document_id);if(!hosts.has(row.document_id)){
      host=db.readonly?readRawCapsule2HostDocumentOwned(db,row.document_id):readStrictHostDocument(db,row.document_id);hosts.set(row.document_id,host)}
    const group=snapshots.get(row.group_id),child=group?.blocks.find(block=>block.id===row.block_id),instance=group?.instances.find(item=>item.instanceId===row.instance_id)
    let expectedContent=child?.content
    if(child&&representation.kind==='snippet'){
      const key=JSON.stringify([row.group_id,row.block_id]);let snippet=snippets.get(key)
      if(snippet===undefined){snippet=canonicalSearchSnippet(child.content,representation.terms);snippets.set(key,snippet)}
      expectedContent=snippet
    }
    if(!host||host.createdAt!==row.host_created_at||host.births.get(row.instance_id)!==row.instance_created_at||!group||!child||!instance
      ||group.creationId!==row.creation_id||group.createdAt!==row.group_created_at||group.revision!==row.revision||group.topologyRevision!==row.topology_revision
      ||child.createdAt!==row.canonical_created_at||expectedContent!==row.content||instance.hostDocumentId!==row.document_id||instance.bindingVersion!==row.binding_version
      ||instance.parentBlockId!==row.parent_block_id||instance.depth!==row.instance_depth)
      throw new Error('Canonical search page differs from the same actual strict group/host projection.')
  }
  return snapshots
}
/** Normal inline admission does not guess an epoch or a host birth from the
 * renderer's legacy DocumentDetail. All address fields derive from real SQL. */
export function resolveSyncedInlineInstance(db:Database.Database,input:unknown):SyncedInlineInstanceResult {
  assertSyncedShape(input,['hostDocumentId','instanceId','groupId'])
  if(!isSyncedBlockId(input.hostDocumentId)||!isSyncedUuid(input.instanceId)||!isSyncedUuid(input.groupId))throw new Error('Invalid inline instance read address.')
  return db.transaction(()=>{
    assertCanonicalSearchSnapshotOwned(db)
    const row=db.prepare(`SELECT * FROM (${syncedInlineInstancesSql}) WHERE document_id=? AND instance_id=? AND group_id=?`)
      .get(input.hostDocumentId,input.instanceId,input.groupId) as SyncedInlineInstanceSqlRow|undefined
    if(!row)return{status:'missing' as const}
    const snapshot=readRawSyncedGroupSnapshotsOwned(db,[row.group_id]).get(row.group_id)
    const host=db.readonly?readRawCapsule2HostDocumentOwned(db,row.document_id):readStrictHostDocument(db,row.document_id)
    const instance=snapshot?.instances.find(item=>item.instanceId===row.instance_id)
    if(!snapshot||!host||!instance||host.createdAt!==row.host_created_at||host.births.get(row.instance_id)!==row.instance_created_at
      ||snapshot.creationId!==row.creation_id||snapshot.createdAt!==row.group_created_at||snapshot.revision!==row.revision||snapshot.topologyRevision!==row.topology_revision
      ||instance.hostDocumentId!==row.document_id||instance.bindingVersion!==row.binding_version||instance.depth!==row.instance_depth||instance.parentBlockId!==row.parent_block_id)
      throw new Error('Inline instance differs from the same actual strict group and host.')
    return{status:'ready' as const,instance:inlineInstanceFromRow(row),snapshot}
  })()
}
export function resolveWorkspaceSearchOccurrence(db:Database.Database,input:unknown):WorkspaceSearchOccurrenceResult {
  const expected=validateWorkspaceSearchOccurrence(input)
  return db.transaction(()=>{
    assertCanonicalSearchSnapshotOwned(db)
    const row=db.prepare(`SELECT * FROM (${canonicalSearchOccurrencesSql}) WHERE document_id=? AND instance_id=? AND group_id=? AND block_id=?`)
      .get(expected.hostDocumentId,expected.instanceId,expected.groupId,expected.canonicalBlockId) as CanonicalSearchOccurrenceRow|undefined
    if(!row)return{status:'missing' as const}
    const snapshots=validateCanonicalSearchPageOwned(db,[row])
    const occurrence=occurrenceFromCanonicalSearchRow(row)
    if(!isSameWorkspaceSearchOccurrence(occurrence,expected))return{status:'stale' as const}
    const snapshot=snapshots.get(row.group_id)
    if(!snapshot)throw new Error('Canonical occurrence disappeared inside one actual SQLite snapshot.')
    return{status:'ready' as const,occurrence,snapshot}
  })()
}
