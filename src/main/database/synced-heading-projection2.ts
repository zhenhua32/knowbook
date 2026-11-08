import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { SyncedGroupSnapshot, SyncedGroupWire, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import type { MarkdownRenderableBlock } from '../../shared/markdown'
import type { SyncedHeadingAnchorResult, SyncedInlineInstanceAddress } from '../../shared/workspace-search-occurrence'
import { validateSyncedWorkspaceGraph, expandSyncedGraphDocument, type SyncedExpandedBlock } from '../../shared/syncedBlockGraph'
import { assertSyncedShape, isSyncedBlockId, parseSyncedBlockPayload, validatePersistedHostForest, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { projectSyncedHostBudget } from '../../shared/syncedBlockPortable'
import { getMarkdownHeadingTargets, getMarkdownHeadingRewrites, type MarkdownHeadingTarget } from '../../shared/markdownLinkMaintenance'
import { findWikiHeading } from '../../shared/markdownWiki'
import { readStrictHostDocument, type StrictHostDocument } from './synced-host-document-read'
import { assertCanonicalSearchSnapshotOwned, resolveSyncedInlineInstance } from './workspace-search-occurrences'

export type SyncedHeadingLocation2=
  | {kind:'document-title';documentId:string;documentCreatedAt:string}
  | {kind:'ordinary';documentId:string;documentCreatedAt:string;blockId:string;blockCreatedAt:string}
  | {kind:'canonical';instance:SyncedHeadingInstanceIdentity2;canonicalBlockId:string;canonicalCreatedAt:string}
export type SyncedHeadingInstanceIdentity2=Pick<SyncedInlineInstanceAddress,'hostDocumentId'|'hostCreatedAt'|'instanceId'|'instanceCreatedAt'|'groupId'|'creationId'|'groupCreatedAt'>
export type SyncedHeadingGroupFacts2=Pick<SyncedGroupSnapshot,'groupId'|'creationId'|'createdAt'|'origin'|'bindings'|'blocks'>
export interface SyncedHeadingHostFacts2 {documentId:string;createdAt:string;parentId:string|null;sortOrder:number;title:string;summary:string;blocks:SyncedStableBlockDraft[];births:ReadonlyMap<string,string>}
export type SyncedProjectedHeading2=MarkdownHeadingTarget&{location:SyncedHeadingLocation2}
const fail=(message:string):never=>{throw new Error('Synced heading projection2: '+message)}
const tuple=(value:unknown)=>JSON.stringify(value)
const identity=(location:SyncedHeadingLocation2)=>location.kind==='canonical'
  ?['canonical',location.instance.hostDocumentId,location.instance.hostCreatedAt,location.instance.instanceId,location.instance.instanceCreatedAt,
    location.instance.groupId,location.instance.creationId,location.instance.groupCreatedAt,location.canonicalBlockId,location.canonicalCreatedAt]
  :location.kind==='ordinary'?['ordinary',location.documentId,location.documentCreatedAt,location.blockId,location.blockCreatedAt]
    :['document-title',location.documentId,location.documentCreatedAt]
const parserId=(location:SyncedHeadingLocation2)=>'heading-occurrence2:'+createHash('sha256').update(tuple(identity(location))).digest('hex')
/** Pure occurrence projection over explicitly supplied facts. It mints no
 * session, source owner, target binding, original birth or write permission.
 * The actual SQL producer below is the only live-input adapter. */
export function projectSyncedHostHeadings2(host:StrictHostDocument,snapshots:ReadonlyMap<string,SyncedGroupSnapshot>,instances:ReadonlyMap<string,SyncedInlineInstanceAddress>):SyncedProjectedHeading2[]{
  return projectSyncedHostHeadingFacts2({documentId:host.detail.id,createdAt:host.createdAt,parentId:host.parentId,sortOrder:host.sortOrder,
    title:host.content.title,summary:host.content.summary,blocks:host.content.blocks,births:host.births},snapshots,instances)
}
/** Data-only historical/native adapter. Minimal real birth facts avoid fake
 * DocumentDetail/backlink DTOs or invented CAS/session fields in a journal. */
export function projectSyncedHostHeadingFacts2(host:SyncedHeadingHostFacts2,snapshots:ReadonlyMap<string,SyncedHeadingGroupFacts2>,instances:ReadonlyMap<string,SyncedHeadingInstanceIdentity2>):SyncedProjectedHeading2[]{
  const wires:SyncedGroupWire[]=[...snapshots.values()].map(group=>({kind:'synced-group',id:group.groupId,creationId:group.creationId,createdAt:group.createdAt,
    origin:group.origin,bindings:group.bindings,blocks:group.blocks})).map(validateSyncedGroupWire)
  const groupIds=new Set<string>(),canonicalIds=new Set<string>()
  for(const wire of wires){if(groupIds.has(wire.id))return fail('duplicate group identity');groupIds.add(wire.id)
    for(const block of wire.blocks){if(canonicalIds.has(block.id))return fail('duplicate physical canonical identity');canonicalIds.add(block.id)}}
  if(host.blocks.some(block=>canonicalIds.has(block.id)))return fail('ordinary and canonical identities overlap')
  const hasReferences=host.blocks.some(block=>block.type==='synced-block')
  const graph=hasReferences?validateSyncedWorkspaceGraph([{documentId:host.documentId,blocks:host.blocks}],wires):null
  if(hasReferences)projectSyncedHostBudget({kind:'document',id:host.documentId,parentId:host.parentId,sortOrder:host.sortOrder,createdAt:host.createdAt,content:{title:host.title,summary:host.summary,blocks:host.blocks}},
    new Map(wires.map(wire=>[wire.id,wire])))
  const ordinary=graph?null:validatePersistedHostForest(host.blocks)
  const locations=new Map<string,SyncedHeadingLocation2>(),physical=new Map(host.blocks.map(block=>[block.id,block]))
  const canonical=new Map([...snapshots].map(([id,group])=>[id,new Map(group.blocks.map(block=>[block.id,block]))]))
  const projected:Array<{entry:SyncedExpandedBlock;key:string}>=[]
  const occurrenceKeys=new Map<string,string>()
  const entries:Iterable<SyncedExpandedBlock>=graph?expandSyncedGraphDocument(graph,host.documentId):ordinary!.map(block=>({block,depth:block.depth,instanceId:null,
    parent:block.parentBlockId===null?null:{instanceId:null,blockId:block.parentBlockId}}))
  for(const entry of entries){
    let location:SyncedHeadingLocation2
    if(entry.instanceId===null){const birth=host.births.get(entry.block.id)??fail('ordinary row has no actual birth')
      location={kind:'ordinary',documentId:host.documentId,documentCreatedAt:host.createdAt,blockId:entry.block.id,blockCreatedAt:birth}
    }else{
      const actual=instances.get(entry.instanceId)??fail('instance has no actual SQL address'),leaf=physical.get(entry.instanceId)??fail('host leaf missing')
      const group=snapshots.get(parseSyncedBlockPayload(leaf.content).groupId)??fail('actual group missing')
      const child=canonical.get(group.groupId)?.get(entry.block.id)??fail('actual canonical child missing')
      if(actual.hostDocumentId!==host.documentId||actual.hostCreatedAt!==host.createdAt||actual.groupId!==group.groupId
        ||actual.creationId!==group.creationId||actual.groupCreatedAt!==group.createdAt||actual.instanceCreatedAt!==host.births.get(entry.instanceId))
        return fail('instance and actual group/host snapshot differ')
      location={kind:'canonical',instance:{hostDocumentId:actual.hostDocumentId,hostCreatedAt:actual.hostCreatedAt,instanceId:actual.instanceId,
        instanceCreatedAt:actual.instanceCreatedAt,groupId:actual.groupId,creationId:actual.creationId,groupCreatedAt:actual.groupCreatedAt},
        canonicalBlockId:child.id,canonicalCreatedAt:child.createdAt}
    }
    const key=parserId(location),previous=locations.get(key)
    if(previous&&tuple(previous)!==tuple(location))return fail('temporary parser identity collision')
    if(previous)return fail('duplicate actual occurrence')
    locations.set(key,location)
    occurrenceKeys.set(tuple([entry.instanceId,entry.block.id]),key);projected.push({entry,key})
  }
  // Temporary parser ids preserve exact occurrence parents, including a real
  // ordinary container outside a canonical root. No clamp or placeholder tree.
  const expanded:MarkdownRenderableBlock[]=projected.map(({entry,key})=>({...entry.block,id:key,depth:entry.depth,
    parentBlockId:entry.parent===null?null:occurrenceKeys.get(tuple([entry.parent.instanceId,entry.parent.blockId]))??fail('actual occurrence parent missing')}))
  const title:SyncedHeadingLocation2={kind:'document-title',documentId:host.documentId,documentCreatedAt:host.createdAt}
  return getMarkdownHeadingTargets(expanded,host.title).map(heading=>({...heading,
    key:heading.blockId===null?parserId(title):heading.key,
    location:heading.blockId===null?title:locations.get(heading.blockId)??fail('parsed heading lost its exact occurrence')}))
}
/** Native readonly producer. Missing/retired groups are not interpreted as an
 * empty heading namespace, and no old Origin/URL chooses another live host. */
export function readSyncedHostHeadingsOwned2(db:Database.Database,documentId:string){
  if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27)return fail('actual owned schema27 SQL snapshot required')
  assertCanonicalSearchSnapshotOwned(db)
  const host=readStrictHostDocument(db,documentId);if(!host)return null
  const snapshots=new Map<string,SyncedGroupSnapshot>(),instances=new Map<string,SyncedInlineInstanceAddress>()
  for(const leaf of host.content.blocks)if(leaf.type==='synced-block'){
    const groupId=parseSyncedBlockPayload(leaf.content).groupId,actual=resolveSyncedInlineInstance(db,{hostDocumentId:documentId,instanceId:leaf.id,groupId})
    if(actual.status!=='ready')return fail('actual live reference lacks its active group/instance')
    snapshots.set(groupId,actual.snapshot);instances.set(leaf.id,actual.instance)
  }
  return{documentId,documentCreatedAt:host.createdAt,path:host.detail.path,title:host.detail.title,
    headings:projectSyncedHostHeadings2(host,snapshots,instances)}
}
/** No caption matchRecreated fallback: only the same full occurrence/birth can
 * carry a heading identity. The existing missing-heading token rules remain. */
export function planSyncedHeadingRewrites2(before:readonly SyncedProjectedHeading2[],after:readonly SyncedProjectedHeading2[]){
  return getMarkdownHeadingRewrites([...before],[...after],false)
}

/** Resolve in one committed host/group snapshot. A duplicate slug, stale host
 * or disappeared occurrence never falls back to another copy of the heading. */
export function resolveSyncedHeadingAnchor(db: Database.Database, input: unknown): SyncedHeadingAnchorResult {
  assertSyncedShape(input, ['documentId', 'expectedUpdatedAt', 'anchor', 'matchText'])
  const { documentId, expectedUpdatedAt, anchor, matchText } = input
  if (!isSyncedBlockId(documentId) || typeof expectedUpdatedAt !== 'string' || typeof anchor !== 'string'
    || !anchor || anchor.length > 16_384 || typeof matchText !== 'boolean') return { status: 'missing' }
  return db.transaction((): SyncedHeadingAnchorResult => {
    const host = readStrictHostDocument(db, documentId)
    if (!host || host.detail.updatedAt !== expectedUpdatedAt) return { status: 'stale' }
    const source = readSyncedHostHeadingsOwned2(db, host.detail.id)
    if (!source) return { status: 'missing' }
    const exact = source.headings.filter(heading => heading.slug === anchor)
    if (exact.length > 1) return { status: 'missing' }
    const heading = matchText ? findWikiHeading(anchor, source.headings) : exact[0]
    if (!heading) return { status: 'missing' }
    const { location } = heading
    if (location.kind === 'document-title') return { status: 'ready', kind: 'title' }
    if (location.kind === 'ordinary') {
      const ordinal = /(:html)?:([0-9]+)$/.exec(heading.key)
      if (!ordinal) return { status: 'missing' }
      return { status: 'ready', kind: 'ordinary', blockId: location.blockId, headingIndex: Number(ordinal[2]) * (ordinal[1] ? -1 : 1) }
    }
    const occurrence = resolveSyncedInlineInstance(db, { hostDocumentId: host.detail.id, instanceId: location.instance.instanceId, groupId: location.instance.groupId })
    if (occurrence.status !== 'ready' || occurrence.instance.instanceCreatedAt !== location.instance.instanceCreatedAt) return { status: 'stale' }
    return { status: 'ready', kind: 'canonical', occurrence: { ...occurrence.instance,
      canonicalBlockId: location.canonicalBlockId, canonicalCreatedAt: location.canonicalCreatedAt } }
  })()
}
