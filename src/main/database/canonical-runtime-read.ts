import type Database from 'better-sqlite3'
import type { SyncedGroupWire } from '../../shared/synced-blocks'
import { SYNCED_MAX_BLOCKS, parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { projectSyncedGroupBudget, projectSyncedHostBudget } from '../../shared/syncedBlockPortable'
import { assertSyncedBlockSchema } from './synced-schema'
import { assertSyncedLifecycleSchema } from './synced-lifecycle-schema'
import { readRawSyncedGroupSnapshotsOwned } from './synced-blocks-raw-read'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'
import { assertSyncedStoredBindings } from './synced-stored-binding-read'
import { readCanonicalRuntimeHostDocumentOwned } from './synced-host-document-read'

function owned(db:Database.Database):number{
  if(!db.open||!db.inTransaction)throw new Error('Canonical runtime admission requires the actual owned SQL snapshot.')
  return db.pragma('main.user_version',{simple:true}) as number
}
/** Actual namespace detection, never a caller capability flag. */
export function hasCanonicalRuntimeDataOwned(db:Database.Database):boolean{
  const version=owned(db);if(version<26)return false
  for(const table of ['synced_groups','synced_group_blocks','synced_instances','synced_operations','synced_group_history','synced_host_history','synced_host_history_documents','synced_host_history_state','synced_group_pins'])
    if(db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get())return true
  if(db.prepare("SELECT 1 FROM blocks WHERE type='synced-block' LIMIT 1").get())return true
  if(version>=27)for(const table of ['synced_group_lifecycle','synced_group_retirements','synced_exposure_attempts','synced_group_exposure_members'])
    if(db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get())return true
  return false
}
/** Explicit full-reader admission before WAL/appSchema/seed. Old foundation
 * admission remains a separate default. No DTO, durable setting, DDL, repair,
 * publication, restoration or installation permission is accepted here. */
export function assertCanonicalRuntimeReadableOwned(db:Database.Database):void{
  const version=owned(db);if(version<26)return
  assertSyncedBlockSchema(db);if(version>=27){assertSyncedLifecycleSchema(db);assertSyncedRecoveryBoundaryRecords(db)}
  const deleted=assertSyncedLogicalDeletionRecords(db)
  if(!hasCanonicalRuntimeDataOwned(db))return
  if((db.pragma('foreign_key_check') as unknown[]).length)throw new Error('Canonical runtime found broken original foreign keys; no data was repaired.')
  const groups=new Map<string,SyncedGroupWire>(),ids=(db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{id:string}>).map(row=>row.id)
  for(let start=0;start<ids.length||start===0;start+=SYNCED_MAX_BLOCKS){
    const batch=ids.slice(start,start+SYNCED_MAX_BLOCKS),ready=readRawSyncedGroupSnapshotsOwned(db,batch),life=version>=27?readSyncedGroupLifecycles(db,batch):null
    for(const id of batch){const group=ready.get(id)
      if(!group){if(deleted.has('group:'+id)||life?.get(id)?.state==='retired-create')continue;throw new Error('Canonical runtime cannot read an actual active group.')}
      const wire:SyncedGroupWire={kind:'synced-group',id:group.groupId,creationId:group.creationId,createdAt:group.createdAt,origin:group.origin,blocks:group.blocks,bindings:group.bindings}
      assertSyncedStoredBindings(db,wire.origin,wire.blocks,wire.bindings);projectSyncedGroupBudget(wire);groups.set(id,wire)
    }
  }
  const hosts=(db.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{id:string}>).map(row=>{
    const host=readCanonicalRuntimeHostDocumentOwned(db,row.id);if(!host||deleted.has('doc:'+row.id))throw new Error('Canonical runtime host is missing or effectively deleted.')
    return host
  }),byId=new Map(hosts.map(host=>[host.detail.id,host]))
  const visited=new Set<string>()
  for(const original of hosts){let current=original;const path=new Set<string>()
    while(!visited.has(current.detail.id)){
      if(path.has(current.detail.id))throw new Error('Canonical runtime document parents contain a cycle.')
      path.add(current.detail.id)
      if(current.parentId===null)break
      const parent=byId.get(current.parentId);if(!parent)throw new Error('Canonical runtime document parent is missing.');current=parent
    }
    for(const id of path)visited.add(id)
    if(original.content.blocks.some(block=>block.type==='synced-block'))projectSyncedHostBudget({kind:'document',id:original.detail.id,parentId:original.parentId,
      sortOrder:original.sortOrder,createdAt:original.createdAt,content:original.content},groups)
  }
  validateSyncedWorkspaceGraph(hosts.filter(host=>host.content.blocks.some(block=>block.type==='synced-block')).map(host=>({documentId:host.detail.id,blocks:host.content.blocks})),[...groups.values()])
  const physical=new Map<string,{kind:'document'|'group';owner:string;createdAt:string}>(hosts.flatMap(host=>[...host.births].map(([id,createdAt])=>[id,{kind:'document',owner:host.detail.id,createdAt}] as const)))
  for(const group of groups.values())for(const block of group.blocks)physical.set(block.id,{kind:'group',owner:group.id,createdAt:block.createdAt})
  const identities=db.prepare("SELECT id,last_owner_kind,last_owner_id,created_at FROM block_identities WHERE state='live' ORDER BY id").all() as Array<{id:string;last_owner_kind:string;last_owner_id:string;created_at:string}>
  if(identities.length!==physical.size)throw new Error('Canonical runtime live identity closure differs from physical bodies.')
  for(const row of identities){const actual=physical.get(row.id)
    if(!actual||actual.kind!==row.last_owner_kind||actual.owner!==row.last_owner_id||actual.createdAt!==row.created_at)
      throw new Error('Canonical runtime physical identity/owner/birth differs.')}
  // Every ref is part of this complete graph, including empty/malformed JSON
  // and unknown/retired groups, rather than a filtered registry enumeration.
  for(const host of hosts)for(const block of host.content.blocks)if(block.type==='synced-block'&&!groups.has(parseSyncedBlockPayload(block.content).groupId))
    throw new Error('Canonical runtime reference has no actual active group.')
}
