// Pure replay of the EXISTING ordinary Main link-maintenance cells. Captured
// Wiki facts are immutable business DATA, never a caller resolver or permit.
import type { SyncedBindingKey } from '../../shared/synced-blocks'
import { assertSyncedShape } from '../../shared/syncedBlockValidation'
import { validateSyncedBindingKey } from '../../shared/syncedBlockInputs'
import { collectDocumentMarkdownLinks, rewriteDocumentMarkdownLinks, rewriteLocalMarkdownLink, type MarkdownPathChange } from '../../shared/markdownLinkMaintenance'
import { findWikiHeading, parseWikiReference, resolveWikiDocument, rewriteWikiReference, wikiDocumentPaths } from '../../shared/markdownWiki'
import type { decodeSyncedMetadataCaptureRecord2 } from './synced-metadata-capture-record2'
import { hostEncode, hostEqual } from './synced-host-journal'
import type { HeadingTitleWikiStyleContext3 } from './synced-heading-title-wiki-style3'
import { restyleHeadingTitleOrdinaryBlocks3 } from './synced-heading-title-style3'

type Namespace = ReturnType<typeof decodeSyncedMetadataCaptureRecord2>['capture']['namespaces'][number]
export interface HeadingTitleOrdinaryDocument3 {documentId:string;documentCreatedAt:string;title:string;path:string}
export interface HeadingTitleOrdinaryWiki3 {
  documentId: string
  documentCreatedAt: string
  /** Complete actual Main naming scope of this event, not a caller target map.
   * It is empty only when this source contains no Wiki destinations. */
  documents: HeadingTitleOrdinaryDocument3[]
  links: Array<{key:SyncedBindingKey;url:string;target:null|{documentId:string;documentCreatedAt:string;path:string;fragment:string;kind:'wiki'|'wiki-heading'}}>
}
export class HeadingTitle3WikiScopeRequired extends Error{constructor(message:string){super('Heading title3 Wiki scope required: '+message);this.name='HeadingTitle3WikiScopeRequired'}}
const bad=(message:string):never=>{throw Error('Heading title ordinary3 DATA invalid: '+message)}
const key=(value:SyncedBindingKey)=>hostEncode([value.blockId,value.from,value.to,value.raw,value.syntax])
const fold=(value:string)=>value.replace(/[A-Z]/g,letter=>String.fromCharCode(letter.charCodeAt(0)+32))
const legacyBlock=(fragment:string)=>/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(fragment)||fragment.startsWith('^')

export function validateHeadingTitleOrdinaryDocuments3(value:unknown):HeadingTitleOrdinaryDocument3[]{
  if(!Array.isArray(value))return bad('complete native naming scope required')
  const documents=value.map(item=>{
    assertSyncedShape(item,['documentId','documentCreatedAt','title','path'])
    if(typeof item.documentId!=='string'||!item.documentId.trim()||typeof item.documentCreatedAt!=='string'||!Number.isFinite(Date.parse(item.documentCreatedAt))
      ||typeof item.title!=='string'||typeof item.path!=='string'||!item.path)return bad('native naming row differs')
    return item as unknown as HeadingTitleOrdinaryDocument3
  })
  if(new Set(documents.map(item=>item.documentId)).size!==documents.length||new Set(documents.map(item=>item.path)).size!==documents.length)return bad('duplicate native naming identity/path')
  return documents
}

/** Exact parser closure for the native BEFORE namespace. Resolved target data
 * comes only from the private Main capture in the business producer. Every
 * affected native target is additionally tied to its immutable subtree birth
 * by the point kernel; unresolved Wiki values keep the old fallback rules. */
export function validateHeadingTitleOrdinaryWiki3(namespace:Namespace,value:HeadingTitleOrdinaryWiki3,namespaces:readonly Namespace[]=[namespace]){
  assertSyncedShape(value,['documentId','documentCreatedAt','documents','links'])
  if(value.documentId!==namespace.host.documentId||value.documentCreatedAt!==namespace.host.createdAt||!Array.isArray(value.links))return bad('ordinary source birth differs')
  const documents=validateHeadingTitleOrdinaryDocuments3(value.documents),byId=new Map(documents.map(item=>[item.documentId,item]))
  const known=new Map(namespaces.map(item=>[item.host.documentId,item]))
  if(value.links.length){
    if(!documents.length)return bad('Wiki source lacks its actual complete naming scope')
    for(const original of namespaces){const item=byId.get(original.host.documentId)
      if(!item||item.documentCreatedAt!==original.host.createdAt||item.title!==original.host.title||item.path!==original.path)return bad('naming scope differs from the original complete namespace')}
  }else if(documents.length)return bad('empty Wiki source carries an unrelated naming scope')
  const lookup={
    byPath:(name:string)=>{
      const exact=documents.find(item=>item.path===name);if(exact)return{...exact}
      if(name.includes('\0'))throw new HeadingTitle3WikiScopeRequired('NUL-sensitive NOCASE path lookup needs its original native adapter')
      const matches=documents.filter(item=>!item.path.includes('\0')&&fold(item.path)===fold(name))
      if(matches.length>1)throw new HeadingTitle3WikiScopeRequired('ambiguous NOCASE path needs its original native query order')
      return matches[0]
    },
    byTitle:(name:string)=>{
      if(name.includes('\0'))throw new HeadingTitle3WikiScopeRequired('NUL-sensitive NOCASE title lookup needs its original native adapter')
      return documents.filter(item=>!item.title.includes('\0')&&fold(item.title)===fold(name))
    }
  }
  const parsed=collectDocumentMarkdownLinks(namespace.host.blocks).filter(link=>link.kind==='wiki')
  const actual=new Map(parsed.map(link=>{
    const block=namespace.host.blocks[link.blockIndex]
    if(!block||link.blockId!==block.id)return bad('native wiki physical block differs')
    const item:SyncedBindingKey={blockId:block.id,from:link.start,to:link.end,raw:block.content.slice(link.start,link.end),syntax:'wiki'}
    return[key(item),{key:item,url:link.url}]
  }))
  const seen=new Set<string>(),byRaw=new Map<string,unknown>()
  if(actual.size!==parsed.length||value.links.length!==actual.size)return bad('complete ordinary wiki parser closure differs')
  for(const item of value.links){
    assertSyncedShape(item,['key','url','target']);const checked=validateSyncedBindingKey(item.key),found=actual.get(key(checked))
    if(!found||seen.has(key(checked))||checked.syntax!=='wiki'||!hostEqual(found.key,checked)||found.url!==item.url)return bad('ordinary wiki exact Key/url differs')
    seen.add(key(checked))
    if(item.target!==null){
      assertSyncedShape(item.target,['documentId','documentCreatedAt','path','fragment','kind'])
      if(typeof item.target.documentId!=='string'||!item.target.documentId.trim()||typeof item.target.path!=='string'||!item.target.path
        ||typeof item.target.documentCreatedAt!=='string'||!Number.isFinite(Date.parse(item.target.documentCreatedAt))
        ||typeof item.target.fragment!=='string'||item.target.kind!=='wiki'&&item.target.kind!=='wiki-heading')return bad('captured native wiki target differs')
    }
    // Re-run the original shared resolver against the captured complete naming
    // scope. A target assertion cannot make [[Unrelated]] resolve to a renamed
    // document; exact/relative/case/legacy #| and unique-title rules stay native.
    const resolved=resolveWikiDocument(item.url,namespace.path,lookup)
    if(!resolved){
      if(item.target!==null)throw new HeadingTitle3WikiScopeRequired('route-only Wiki target lacks its original block-route scope')
    }else{
      const target=item.target,document=resolved.document
      if(!target||target.documentId!==document.documentId||target.documentCreatedAt!==document.documentCreatedAt||target.path!==document.path)return bad('raw Wiki does not resolve to its captured native target')
      const original=known.get(document.documentId),fragment=resolved.reference.fragment
      if(!fragment){if(target.kind!=='wiki'||target.fragment!=='')return bad('ordinary Wiki top target differs')}
      else if(original&&!original.instances.length&&!original.host.blocks.some(block=>block.type==='synced-block')){
        const block=original.host.blocks.find(block=>block.id===(fragment.startsWith('^')?fragment.slice(1):fragment))
        const expected=block?block.id:legacyBlock(fragment)?fragment:findWikiHeading(fragment,original.headings)?.slug??fragment
        const kind=block||legacyBlock(fragment)?'wiki':'wiki-heading'
        if(target.kind!==kind||target.fragment!==expected)return bad('raw Wiki fragment differs from its original native namespace')
      }
      // A foreign fragment without a captured namespace is only the original
      // Main hint. The point planner cannot create heading rewrites for that
      // document, so it never promotes this hint into a fragment rewrite.
    }
    const address=hostEncode([checked.blockId,item.url]),previous=byRaw.get(address)
    if(byRaw.has(address)&&!hostEqual(previous,item.target))return bad('one native wiki address has contradictory captured resolution')
    byRaw.set(address,item.target)
  }
  return new Map(value.links.map(item=>[key(item.key),item]))
}

export function projectHeadingTitleOrdinaryWikiDestination3(url:string,sourcePath:string,changes:ReadonlyMap<string,MarkdownPathChange>,sourceMoved:boolean,
  binding:Pick<NonNullable<HeadingTitleOrdinaryWiki3['links'][number]['target']>,'path'|'fragment'|'kind'>|null|undefined){
  let reference=parseWikiReference(url)
  if(binding?.path===url)reference={target:url,path:url,fragment:'',hasFragment:false,alias:null}
  else if(binding?.path&&/[#|]/.test(binding.path)&&url.startsWith(binding.path+'#')){
    const tail=parseWikiReference(url.slice(binding.path.length+1))
    reference={target:url,path:binding.path,fragment:tail.target,hasFragment:true,alias:tail.alias}
  }
  const oldTarget=binding?.path??wikiDocumentPaths(reference.path,sourcePath).find(path=>changes.has(path))
  const target=oldTarget?changes.get(oldTarget):undefined
  const fragment=binding?.kind==='wiki-heading'?target?.headings?.get(binding.fragment):undefined
  const movedSource=/^\.\.?\//.test(reference.path)&&sourceMoved
  if((!target||target.before===target.after&&fragment===undefined)&&!movedSource)return null
  if(!oldTarget)return null
  const path=!reference.path?'':target?.before!==target?.after||movedSource?target?.after??oldTarget:reference.path
  return rewriteWikiReference(reference,path,fragment??reference.fragment)
}

export function projectHeadingTitleOrdinaryCells3(namespace:Namespace,newPath:string,
  changes:ReadonlyMap<string,MarkdownPathChange>,sourceMoved:boolean,captured:HeadingTitleOrdinaryWiki3,namespaces:readonly Namespace[]=[namespace],wiki?:HeadingTitleWikiStyleContext3){
  const bindings=validateHeadingTitleOrdinaryWiki3(namespace,captured,namespaces)
  const blocks=rewriteDocumentMarkdownLinks(namespace.host.blocks,link=>{
    if(link.kind==='image')return null
    if(link.kind==='wiki'){
      const block=namespace.host.blocks[link.blockIndex],physical:SyncedBindingKey={blockId:block.id,from:link.start,to:link.end,
        raw:block.content.slice(link.start,link.end),syntax:'wiki'}
      const binding=bindings.get(key(physical))?.target
      return projectHeadingTitleOrdinaryWikiDestination3(link.url,namespace.path,changes,sourceMoved,binding)
    }
    return rewriteLocalMarkdownLink(link.url,namespace.path,newPath,changes)
  })
  const styled=restyleHeadingTitleOrdinaryBlocks3(namespace.host.blocks,blocks,newPath,undefined,undefined,undefined,wiki)
  return{blocks:styled.blocks,changed:styled.blocks.some((block,index)=>block.content!==namespace.host.blocks[index].content)}
}
