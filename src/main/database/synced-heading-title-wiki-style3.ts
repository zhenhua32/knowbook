// Actual complete naming scope DATA, stored once in the reverse-bound business
// original. Resolver equality includes the native fragment input; therefore the
// same current namespace performs the same block-route/heading lookup.
import { resolveWikiDocument, parseWikiReference } from '../../shared/markdownWiki'
import type { HeadingTitleOrdinaryDocument3 } from './synced-heading-title-ordinary3'
import { hostEncode } from './synced-host-journal'

export class HeadingTitle3WikiStyleRequired extends Error {
  constructor(message:string){super('Heading title3 exact Wiki style requires proof: '+message);this.name='HeadingTitle3WikiStyleRequired'}
}
const bad=(message:string):never=>{throw new HeadingTitle3WikiStyleRequired(message)}
const fold=(value:string)=>value.replace(/[A-Z]/g,letter=>String.fromCharCode(letter.charCodeAt(0)+32))
export type HeadingTitleWikiDocuments3=readonly HeadingTitleOrdinaryDocument3[]
export interface HeadingTitleWikiStyleContext3 {before:HeadingTitleWikiDocuments3;after:HeadingTitleWikiDocuments3;sourcePath:string}
export function resolveHeadingTitleWikiStyle3(raw:string,sourcePath:string,documents:HeadingTitleWikiDocuments3){
  const resolved=resolveWikiDocument(raw,sourcePath,{
    byPath:(path:string)=>{
      const exact=documents.find(item=>item.path===path);if(exact)return exact
      if(path.includes('\0'))return bad('NUL-sensitive native path needs its original query adapter')
      const matches=documents.filter(item=>!item.path.includes('\0')&&fold(item.path)===fold(path))
      if(matches.length>1)return bad('ambiguous native NOCASE path needs its original query order')
      return matches[0]
    },
    byTitle:(title:string)=>{
      if(title.includes('\0'))return bad('NUL-sensitive native title needs its original query adapter')
      return documents.filter(item=>!item.title.includes('\0')&&fold(item.title)===fold(title))
    }
  })
  return resolved??bad('raw Wiki lacks its actual document naming resolution')
}
export function headingTitleWikiFingerprint3(raw:string,sourcePath:string,documents:HeadingTitleWikiDocuments3){
  const {document,reference}=resolveHeadingTitleWikiStyle3(raw,sourcePath,documents)
  return hostEncode([document.documentId,document.documentCreatedAt,reference.fragment])
}
export function projectHeadingTitleWikiDocuments3(documents:HeadingTitleWikiDocuments3,
  destinations:ReadonlyMap<string,{beforePath:string;afterPath:string;beforeCreatedAt:string;afterCreatedAt:string}>,rootId:string,title:string){
  const projected=documents.map(document=>{const change=destinations.get(document.documentId);if(!change)return document
    if(document.documentCreatedAt!==change.beforeCreatedAt||change.beforeCreatedAt!==change.afterCreatedAt||document.path!==change.beforePath)return bad('native naming scope differs from actual subtree birth/path')
    return{...document,path:change.afterPath,title:document.documentId===rootId?title:document.title}
  })
  if(new Set(projected.map(document=>document.path)).size!==projected.length)return bad('projected native naming paths overlap')
  return projected
}
/** Preserve only component trivia proven by both native resolutions. Legacy
 * #/pipe paths keep native rendering here; their exact historical spelling is
 * admitted only by the separate current-namespace inverse check. */
export function styleHeadingTitleWikiDestination3(oldRaw:string,oldUrl:string,canonical:string,canonicalUrl:string,sourcePath:string,context:HeadingTitleWikiStyleContext3){
  const old=resolveHeadingTitleWikiStyle3(oldUrl,context.sourcePath,context.before),next=resolveHeadingTitleWikiStyle3(canonicalUrl,sourcePath,context.after)
  if(old.document.documentId!==next.document.documentId||old.document.documentCreatedAt!==next.document.documentCreatedAt)
    return bad('native Wiki rewrite changes the actual document birth')
  if(oldRaw!==oldUrl||canonical!==canonicalUrl)return canonical
  const parsed=parseWikiReference(oldRaw)
  if(hostEncode(parsed)!==hostEncode(old.reference))return canonical
  const pipe=oldRaw.indexOf('|'),rawTarget=pipe<0?oldRaw:oldRaw.slice(0,pipe),hash=rawTarget.indexOf('#')
  const rawPath=hash<0?rawTarget:rawTarget.slice(0,hash),rawFragment=hash<0?'':rawTarget.slice(hash+1)
  const trivia=(raw:string,value:string)=>{
    const prefix=raw.length-raw.trimStart().length
    return raw.slice(0,prefix)+value+raw.slice(Math.max(prefix,raw.trimEnd().length))
  }
  const path=old.reference.path===next.reference.path?rawPath:trivia(rawPath,next.reference.path)
  const fragment=next.reference.hasFragment?'#'+(old.reference.hasFragment&&old.reference.fragment===next.reference.fragment?rawFragment:trivia(rawFragment,next.reference.fragment)):''
  const alias=old.reference.alias===next.reference.alias&&pipe>=0?oldRaw.slice(pipe):next.reference.alias===null?'':'|'+next.reference.alias
  const styled=path+fragment+alias
  if(headingTitleWikiFingerprint3(styled,sourcePath,context.after)!==headingTitleWikiFingerprint3(canonical,sourcePath,context.after))return bad('retained Wiki trivia changes native document/fragment resolution')
  return styled
}

export function headingTitleWikiFactScopes3(documents:HeadingTitleWikiDocuments3,subtree:readonly {id:string;path:string;title:string;createdAt:string}[],rootId:string,workingPath:string,afterPath:string){
  const root=subtree.find(item=>item.id===rootId)??bad('original root missing from Wiki scope')
  const side=(path:string)=>{const destinations=new Map(subtree.map(item=>[item.id,{beforePath:item.path,afterPath:path+item.path.slice(root.path.length),beforeCreatedAt:item.createdAt,afterCreatedAt:item.createdAt}]))
    return projectHeadingTitleWikiDocuments3(documents,destinations,rootId,path.slice(root.path.length-root.title.length))}
  return{persisted:documents,working:side(workingPath),after:side(afterPath)}
}
