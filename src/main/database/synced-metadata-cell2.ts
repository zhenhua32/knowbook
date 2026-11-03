import type { SyncedBindingKey } from '../../shared/synced-blocks'

export interface SyncedMetadataCellEdit2 {key:SyncedBindingKey;after:string}
const key=(value:SyncedBindingKey)=>JSON.stringify([value.blockId,value.from,value.to,value.raw,value.syntax])
const fail=():never=>{throw new Error('Metadata2 cell edit lacks its exact whole-forest parser range.')}
const split=(text:string,offset:number)=>offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset])
/** New live-editor range primitive. Bounds belong to the existing group/host
 * projection budget, not to the private restore3 JSON/string format limits.
 * Whitelists are data only; the owned producer proves the complete parser. */
export function projectSyncedMetadataCell2(original:string,parsed:readonly SyncedBindingKey[],input:readonly SyncedMetadataCellEdit2[]){
  const whitelist=new Set<string>(),orderedKeys=[...parsed].sort((a,b)=>a.from-b.from||a.to-b.to)
  for(let index=0;index<orderedKeys.length;index++){
    const item=orderedKeys[index],previous=orderedKeys[index-1],id=key(item)
    if(!Number.isSafeInteger(item.from)||!Number.isSafeInteger(item.to)||item.from<0||item.to<item.from||item.to>original.length
      ||original.slice(item.from,item.to)!==item.raw||item.from===item.to&&(item.syntax!=='markdown'||item.raw!=='')
      ||split(original,item.from)||split(original,item.to)||whitelist.has(id)
      ||previous&&(item.from<previous.to||item.from===previous.from))return fail()
    whitelist.add(id)
  }
  const edits=[...input].sort((a,b)=>a.key.from-b.key.from||a.key.to-b.key.to),seen=new Set<string>(),prefix=[0]
  const exact=new Map<string,{from:number;to:number;raw:string}>();let length=original.length,bytes=Buffer.byteLength(original)
  for(let index=0;index<edits.length;index++){
    const edit=edits[index],id=key(edit.key),previous=edits[index-1]
    if(!whitelist.has(id)||seen.has(id)||typeof edit.after!=='string'||previous&&(edit.key.from<previous.key.to||edit.key.from===previous.key.from))return fail()
    seen.add(id);exact.set(id,{from:edit.key.from+prefix[index],to:edit.key.from+prefix[index]+edit.after.length,raw:edit.after})
    const delta=edit.after.length-edit.key.raw.length;prefix.push(prefix[index]+delta);length+=delta
    bytes+=Buffer.byteLength(edit.after)-Buffer.byteLength(edit.key.raw)
    if(!Number.isSafeInteger(length)||!Number.isSafeInteger(bytes)||length<0||bytes<0)return fail()
  }
  const pieces:string[]=[];let offset=0
  for(const edit of edits){pieces.push(original.slice(offset,edit.key.from),edit.after);offset=edit.key.to}
  pieces.push(original.slice(offset));const text=pieces.join('')
  if(text.length!==length||Buffer.byteLength(text)!==bytes)return fail()
  const endingAt=(position:number)=>{let low=0,high=edits.length;while(low<high){const middle=(low+high)>>>1;if(edits[middle].key.to<=position)low=middle+1;else high=middle}return low}
  const project=(item:SyncedBindingKey):SyncedBindingKey=>{
    const id=key(item);if(!whitelist.has(id))return fail();const own=exact.get(id);if(own)return{...item,...own}
    const before=endingAt(item.from),through=endingAt(item.to),point=through>0?edits[through-1]:undefined
    const end=point&&point.key.from===item.to&&point.key.to===item.to?prefix[through-1]:prefix[through]
    const from=item.from+prefix[before],to=item.to+end;return{...item,from,to,raw:text.slice(from,to)}
  }
  return{text,edits,project}
}
