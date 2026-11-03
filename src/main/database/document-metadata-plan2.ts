// Data-only native planning shared with the genuine metadata2 transaction.
// It performs no DML and accepts no caller rows, path mapper or SQL connection
// locator. A returned plan/hash is never an editing session or commit permit.
import type Database from 'better-sqlite3'

function owned(db:Database.Database):void {
  if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27)throw new Error('Metadata2 planning requires the actual schema27 SQL snapshot.')
}
/** Exact current Store title policy, including ASCII NOCASE sibling lookup.
 * An unchanged published title is preserved without re-colliding a legitimate
 * pre-existing Case/case pair. The user W literal remains in the request. */
export function planStoredDocumentTitle2(db:Database.Database,documentId:string,requested:string){
  owned(db)
  const original=db.prepare('SELECT id,title,parent_id,path,created_at,updated_at FROM documents WHERE id=?').get(documentId) as
    {id:string;title:string;parent_id:string|null;path:string;created_at:string;updated_at:string}|undefined
  if(!original)throw new Error('Document not found')
  if(requested===original.title)return{original,title:original.title}
  const base=requested.trim()||'Untitled'
  if(/[/\\\x00-\x1F]/.test(base)||base==='.'||base==='..')throw new Error('Document title cannot contain path separators, control characters, or dot segments')
  const exists=db.prepare(`SELECT 1 FROM documents WHERE parent_id IS ? AND title=? COLLATE NOCASE AND id<>? LIMIT 1`)
  let title=base,index=1
  while(exists.get(original.parent_id,title,documentId))title=base+' '+index++
  return{original,title}
}
/** Parent identities define the subtree. No LIKE, path substrings, UTF16/code
 * point slicing or current-path homonym chooses a descendant. */
export function planStoredDocumentPaths2(db:Database.Database,documentId:string,rootPath:string){
  owned(db)
  const rows=db.prepare(`WITH RECURSIVE subtree(id) AS (
    SELECT id FROM documents WHERE id=? UNION SELECT child.id FROM documents child JOIN subtree parent ON child.parent_id=parent.id)
    SELECT document.id,document.path,document.title,document.parent_id,document.created_at,document.updated_at
    FROM documents document JOIN subtree ON subtree.id=document.id ORDER BY document.path,document.id`)
    .all(documentId) as Array<{id:string;path:string;title:string;parent_id:string|null;created_at:string;updated_at:string}>
  const children=new Map<string,typeof rows>()
  for(const row of rows)if(row.parent_id!==null){const siblings=children.get(row.parent_id)??[];siblings.push(row);children.set(row.parent_id,siblings)}
  const original=rows.find(row=>row.id===documentId);if(!original)throw new Error('Document not found')
  const paths=[{id:original.id,birth:original.created_at,updatedAt:original.updated_at,path:original.path,nextPath:rootPath}],seen=new Set([documentId])
  for(let index=0;index<paths.length;index++)for(const child of children.get(paths[index].id)??[]){
    if(seen.has(child.id))throw new Error('Document subtree contains a parent cycle')
    seen.add(child.id);paths.push({id:child.id,birth:child.created_at,updatedAt:child.updated_at,path:child.path,
      nextPath:paths[index].nextPath?paths[index].nextPath+'/'+child.title:child.title})
  }
  return paths
}
export function planStoredDocumentRename2(db:Database.Database,documentId:string,requested:string){
  const named=planStoredDocumentTitle2(db,documentId,requested)
  const parent=named.original.parent_id===null?null:db.prepare('SELECT path FROM documents WHERE id=?').get(named.original.parent_id) as {path:string}|undefined
  if(named.original.parent_id!==null&&!parent)throw new Error('Actual document parent is missing')
  const path=parent?parent.path+'/'+named.title:named.title
  return{...named,path,paths:path===named.original.path?[]:planStoredDocumentPaths2(db,documentId,path)}
}
