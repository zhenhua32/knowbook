import type { SyncedGroupWire, SyncedLinkBinding } from '../../shared/synced-blocks'
import { parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { hostHash } from './synced-host-journal'
import { projectSyncedHostHeadingFacts2, type SyncedHeadingHostFacts2, type SyncedHeadingInstanceIdentity2 } from './synced-heading-projection2'
import type { SyncedMetadataWorkspaceView2, SyncedMetadataHostView2 } from './synced-metadata-view2'

const key=({blockId,from,to,raw,syntax}:SyncedLinkBinding)=>({blockId,from,to,raw,syntax})
const identity=(value:SyncedMetadataHostView2)=>
  [...value.instances.values()].map(({hostDocumentId,hostCreatedAt,instanceId,instanceCreatedAt,groupId,creationId,groupCreatedAt}):SyncedHeadingInstanceIdentity2=>
    ({hostDocumentId,hostCreatedAt,instanceId,instanceCreatedAt,groupId,creationId,groupCreatedAt}))
/** Data-only capture builder. The native transition owner invokes it only
 * after genuine original-connection validation. Its result/hash never grants
 * an original capture birth, historic Key lineage or a write capability. */
export function captureSyncedMetadataCurrentTargetBatch2(base:SyncedMetadataWorkspaceView2,sources:readonly SyncedGroupWire[]){
  const unique=new Set<string>(),sourceHeaders=sources.map(source=>{
    const actualSource=base.groups.get(source.id)
    if(unique.has(source.id)||!actualSource||actualSource.creationId!==source.creationId||actualSource.createdAt!==source.createdAt
      ||hostHash(source)!==hostHash({kind:'synced-group',id:actualSource.groupId,creationId:actualSource.creationId,createdAt:actualSource.createdAt,
        origin:actualSource.origin,blocks:actualSource.blocks,bindings:actualSource.bindings}))throw new Error('Metadata2 current capture differs from the native original group.')
    unique.add(source.id)
    return{groupId:source.id,creationId:source.creationId,groupCreatedAt:source.createdAt,sourceRevision:actualSource.revision,
      sourceTopologyRevision:actualSource.topologyRevision,sourceWireHash:hostHash(source)}
  })
  const headingDocuments=new Set(sources.flatMap(source=>source.bindings.flatMap(binding=>binding.target.kind==='heading'?[binding.target.documentId]:[])))
  const namespaces=new Map<string,{host:SyncedHeadingHostFacts2;path:string;updatedAt:string;instances:SyncedHeadingInstanceIdentity2[];
    headings:ReturnType<typeof projectSyncedHostHeadingFacts2>;namespaceHash:string}>()
  const groups=new Map<string,({kind:'namespace-material';wire:SyncedGroupWire}|{kind:'transition-source';groupId:string;sourceWireHash:string})
    &{revision:string;topologyRevision:string}>()
  for(const documentId of headingDocuments){
    const original=base.hosts.get(documentId);if(!original)continue
    const host:SyncedHeadingHostFacts2={documentId,createdAt:original.host.createdAt,parentId:original.host.parentId,sortOrder:original.host.sortOrder,
      title:original.host.content.title,summary:original.host.content.summary,blocks:original.host.content.blocks,births:original.host.births}
    const instances=identity(original),headings=projectSyncedHostHeadingFacts2(host,base.groups,new Map(instances.map(item=>[item.instanceId,item])))
    for(const leaf of host.blocks)if(leaf.type==='synced-block'){
      const id=parseSyncedBlockPayload(leaf.content).groupId,group=base.groups.get(id)!
      const wire:SyncedGroupWire={kind:'synced-group',id,creationId:group.creationId,createdAt:group.createdAt,origin:group.origin,blocks:group.blocks,bindings:group.bindings}
      groups.set(id,{...(unique.has(id)?{kind:'transition-source' as const,groupId:id,sourceWireHash:hostHash(wire)}:{kind:'namespace-material' as const,wire}),
        revision:group.revision,topologyRevision:group.topologyRevision})
    }
    const namespaceHash=hostHash({documentId,createdAt:host.createdAt,path:original.host.detail.path,contentHash:hostHash(original.host.content),
      births:[...host.births],instances,headings})
    namespaces.set(documentId,{host,path:original.host.detail.path,updatedAt:original.host.detail.updatedAt,instances,headings,namespaceHash})
  }
  const blocks=new Map<string,{owner:'document'|'group';ownerId:string;createdAt:string}>(),required=new Set(sources.flatMap(source=>source.bindings.flatMap(binding=>binding.target.kind==='block'?[binding.target.id]:[])))
  if(required.size){
    for(const [documentId,value] of base.hosts)for(const [id,createdAt] of value.host.births)if(required.has(id))blocks.set(id,{owner:'document',ownerId:documentId,createdAt})
    for(const [groupId,value] of base.groups)for(const block of value.blocks)if(required.has(block.id))blocks.set(block.id,{owner:'group',ownerId:groupId,createdAt:block.createdAt})
  }
  const targets=sources.flatMap(source=>source.bindings.map(binding=>{
    const common={sourceGroupId:source.id,sourceCreationId:source.creationId,sourceGroupCreatedAt:source.createdAt,key:key(binding),storedTarget:binding.target,captureDomain:'metadata2-current-P' as const,
      originalCaptureBirthProved:false as const,historicalKeyLineageProved:false as const}
    const target=binding.target
    if(target.kind==='unresolved-url')return{...common,status:'unresolved-literal' as const}
    if(target.kind==='document'){
      const document=base.hosts.get(target.id)
      return document?{...common,status:'current-document' as const,documentId:target.id,documentCreatedAt:document.host.createdAt,path:document.host.detail.path}
        :{...common,status:'current-missing' as const}
    }
    if(target.kind==='block'){
      const actual=blocks.get(target.id)
      return actual?{...common,status:'current-block' as const,blockId:target.id,...actual}:{...common,status:'current-missing' as const}
    }
    const namespace=namespaces.get(target.documentId),matches=namespace?.headings.filter(heading=>heading.slug===target.slug)??[]
    if(!namespace||matches.length!==1)return{...common,status:'requires-heading-evidence' as const}
    return{...common,status:'current-heading' as const,documentId:target.documentId,documentCreatedAt:namespace.host.createdAt,
      namespaceHash:namespace.namespaceHash,heading:matches[0]}
  }))
  // Namespace group material is deduplicated in this outer capture. A future
  // persisted transition should commit this one capture, not copy it per Key.
  const capture={kind:'synced-metadata2-current-target-capture-batch' as const,version:2 as const,workspaceScope:base.workspaceScope,recoveryEpoch:base.recoveryEpoch,
    sources:sourceHeaders,targets,
    namespaces:[...namespaces.values()].map(value=>({...value,host:{...value.host,births:[...value.host.births]}})),groups:[...groups.values()],
    originalCaptureBirthProved:false as const,historicalKeyLineageProved:false as const,writePermit:false as const}
  return{...capture,captureHash:hostHash({domain:'knowbook.synced.metadata2.current-target-capture.v2',capture})}
}
/** Single-source convenience retains the same outer proof material; batch
 * writers use the function above and never persist this material per group. */
export function captureSyncedMetadataCurrentTargets2(base:SyncedMetadataWorkspaceView2,source:SyncedGroupWire){
  const {captureHash:_batchHash,...batch}=captureSyncedMetadataCurrentTargetBatch2(base,[source])
  const capture={...batch,kind:'synced-metadata2-current-target-capture' as const,...batch.sources[0]}
  return{...capture,captureHash:hostHash({domain:'knowbook.synced.metadata2.current-target-capture.v2',capture})}
}
