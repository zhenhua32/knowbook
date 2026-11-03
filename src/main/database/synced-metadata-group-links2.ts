import type Database from 'better-sqlite3'
import type { SyncedBindingKey, SyncedGroupWire, SyncedLinkBinding } from '../../shared/synced-blocks'
import { validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { projectSyncedGroupBudget } from '../../shared/syncedBlockPortable'
import { collectDocumentMarkdownLinks } from '../../shared/markdownLinkMaintenance'
import { collectSyncedBindingOccurrences } from '../sync/synced-binding-occurrences'
import { assertSyncedStoredBindings } from './synced-stored-binding-read'
import { projectSyncedMetadataCell2, type SyncedMetadataCellEdit2 } from './synced-metadata-cell2'
import { renderNavigation3Destination, type Navigation3FinalTarget } from './restore-knowledge-navigation3-rewrite-cells'

/** Facts belong to one native P -> W/A projection, not to a source ticket.
 * The pure projector below accepts data and cannot authorize an edit. */
export interface SyncedMetadataDocumentDestination2 {
  documentId:string; beforeCreatedAt:string; afterCreatedAt:string; beforePath:string; afterPath:string
  headings:ReadonlyMap<string,string>
}
const key=(value:SyncedBindingKey)=>JSON.stringify([value.blockId,value.from,value.to,value.raw,value.syntax])
const onlyKey=({blockId,from,to,raw,syntax}:SyncedBindingKey):SyncedBindingKey=>({blockId,from,to,raw,syntax})
const fail=(message:string):never=>{throw new Error('Synced metadata2 binding projection: '+message)}
/** Use the original complete parser Keys and captured typed target for every
 * occurrence. No URL/caption matching, Origin rewrite or same-ID birth mint.
 * Historical state/documentId hints retain their literal value. */
export function projectSyncedMetadataGroupLinks2(value:SyncedGroupWire,
  documents:ReadonlyMap<string,SyncedMetadataDocumentDestination2>,
  ordinaryBlockOwners:ReadonlyMap<string,{documentId:string;createdAt:string}>) {
  const before=validateSyncedGroupWire(value),parsed=collectSyncedBindingOccurrences(before.origin,before.blocks)
  const actual=new Map(parsed.map(item=>[key(item),item])),grammar=new Map(collectDocumentMarkdownLinks(before.blocks)
    .map(item=>[JSON.stringify([item.blockId,item.start,item.end]),item]))
  if(actual.size!==parsed.length||parsed.length!==before.bindings.length)return fail('incomplete original whole-forest parser closure')
  const byBlock=new Map<string,SyncedLinkBinding[]>(),edits=new Map<string,SyncedMetadataCellEdit2[]>(),targets=new Map<string,SyncedLinkBinding['target']>()
  for(const binding of before.bindings){
    const item=actual.get(key(binding)),role=grammar.get(JSON.stringify([binding.blockId,binding.from,binding.to]))
    if(!item||!role||role.url!==item.url)return fail('binding does not name its exact original syntax')
    const group=byBlock.get(binding.blockId)??[];group.push(binding);byBlock.set(binding.blockId,group)
    let target=binding.target,desired:Navigation3FinalTarget|undefined
    const documentId=target.kind==='document'?target.id:target.kind==='heading'?target.documentId
      :target.kind==='block'?ordinaryBlockOwners.get(target.id)?.documentId:undefined
    const document=documentId===undefined?undefined:documents.get(documentId)
    if(document&&documentId!==undefined){
      if(document.documentId!==documentId||document.beforeCreatedAt!==document.afterCreatedAt)return fail('native document incarnation changed')
      if(target.kind==='document')desired={kind:'document',documentId,documentPath:document.afterPath}
      else if(target.kind==='heading'){
        const slug=document.headings.get(target.slug)??target.slug
        target={...target,slug};desired={kind:'heading',documentId,documentPath:document.afterPath,slug}
      }else if(target.kind==='block')desired={kind:'block',documentId,documentPath:document.afterPath,blockId:target.id}
    }
    // An unresolved target, absent document, or canonical block with no unique
    // ordinary owner never adopts today's Origin-path occupant/host instance.
    targets.set(key(binding),target)
    const headingChanged=target.kind==='heading'&&binding.target.kind==='heading'&&target.slug!==binding.target.slug
    if(!desired||document?.beforePath===document?.afterPath&&!headingChanged)continue
    const rendered=renderNavigation3Destination({key:binding,url:item.url,grammar:{kind:role.kind,syntax:role.kind==='wiki'?'wiki':role.syntax??null}},
      {documentId:before.origin.documentId,path:before.origin.pathAtCreation},desired)
    if('reason'in rendered)return fail(rendered.reason)
    if(rendered.replacement!==binding.raw){const list=edits.get(binding.blockId)??[];list.push({key:onlyKey(binding),after:rendered.replacement});edits.set(binding.blockId,list)}
  }
  const cells=new Map(before.blocks.map(block=>[block.id,projectSyncedMetadataCell2(block.content,(byBlock.get(block.id)??[]).map(onlyKey),edits.get(block.id)??[])]))
  const blocks=before.blocks.map(block=>{const content=cells.get(block.id)!.text;return content===block.content?block:{...block,content}})
  const bindings=before.bindings.map(binding=>({...cells.get(binding.blockId)!.project(onlyKey(binding)),target:targets.get(key(binding))!}))
  const after=validateSyncedGroupWire({...before,blocks,bindings}),next=collectSyncedBindingOccurrences(after.origin,after.blocks)
  const finalKeys=new Set(next.map(key))
  if(finalKeys.size!==next.length||next.length!==bindings.length||bindings.some(item=>!finalKeys.has(key(item))))return fail('final whole-forest parser Keys differ from the exact range projection')
  projectSyncedGroupBudget(after)
  return{before,after,edits:[...edits].flatMap(([blockId,values])=>values.map(edit=>({blockId,...edit}))),
    changed:JSON.stringify(before)!==JSON.stringify(after)}
}
/** Actual Main stored-side seam. The same original SQL snapshot validates all
 * current targets before any metadata writer may consume the pure result. */
export function projectSyncedMetadataStoredGroupLinksOwned2(db:Database.Database,before:SyncedGroupWire,
  documents:ReadonlyMap<string,SyncedMetadataDocumentDestination2>){
  if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27)return fail('actual owned schema27 transaction required')
  assertSyncedStoredBindings(db,before.origin,before.blocks,before.bindings)
  const owners=new Map<string,{documentId:string;createdAt:string}>()
  const required=[...new Set(before.bindings.flatMap(binding=>binding.target.kind==='block'?[binding.target.id]:[]))]
  for(const row of db.prepare(`SELECT b.id,b.document_id,b.created_at FROM blocks b JOIN block_identities i ON i.id=b.id
    WHERE b.id IN (SELECT value FROM json_each(?)) AND i.last_owner_kind='document' AND i.last_owner_id=b.document_id
      AND i.state='live' AND i.created_at=b.created_at AND NOT EXISTS(SELECT 1 FROM synced_group_blocks c WHERE c.id=b.id)`)
    .all(JSON.stringify(required)) as Array<{id:string;document_id:string;created_at:string}>){
    owners.set(row.id,{documentId:row.document_id,createdAt:row.created_at})
  }
  const result=projectSyncedMetadataGroupLinks2(before,documents,owners)
  assertSyncedStoredBindings(db,result.after.origin,result.after.blocks,result.after.bindings)
  return result
}
