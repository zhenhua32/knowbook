import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import type { SyncedCanonicalWire, SyncedGroupWire, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { SYNCED_GROUP_MAX_BYTES, SYNCED_MAX_BLOCKS } from '../src/shared/syncedBlockValidation'
import type { SyncedPortableHostRecord } from '../src/shared/syncedBlockPortable'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { parseManifest, type SyncDatabases } from '../src/main/sync/model'
import { decodePublicationJson, PUBLICATION_RECORD_MAX_BYTES, validateInitialRecord, validateInitialSnapshot } from '../src/main/sync/synced-publication-model'
import { syncedProtocol5RecordKey, validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot,
  type SyncedProtocol5Manifest, type SyncedProtocol5Record } from '../src/main/sync/synced-protocol5-model'

const time='2026-10-18T08:00:00+08:00', workspace='00000000-0000-0000-0000-000000000001'
const groupId='00000000-0000-0000-0000-000000000002', creationId='00000000-0000-0000-0000-000000000003'
const instanceA='00000000-0000-0000-0000-000000000004', instanceB='00000000-0000-0000-0000-000000000005'
const deletedGroup='00000000-0000-0000-0000-000000000006', hostId=' 宿主:旧稳定身份 ', assetHash='a'.repeat(64)
type Entry={key:string;record:SyncedProtocol5Record}
type Input={manifest:SyncedProtocol5Manifest;values:Entry[]}
type Raw=Record<string,any> // Only intentionally untrusted negative fixtures.
function canonical(value:unknown):string {
  const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v!==null&&typeof v==='object'
    ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort((v as Record<string,unknown>)[k])])):v
  return JSON.stringify(sort(value))
}
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex')
const block=(id:string,content=''):SyncedStableBlockDraft=>({id,type:'paragraph',content,checked:false,depth:0,parentBlockId:null})
const child=(id:string,content=''):SyncedCanonicalWire=>({...block(id,content),createdAt:time})
const ref=(id:string):SyncedStableBlockDraft=>({...block(id),type:'synced-block',content:JSON.stringify({version:1,groupId})})
function group(blocks=[child(' canonical:正文 ')]):SyncedGroupWire {
  return {kind:'synced-group',id:groupId,creationId,createdAt:time,
    origin:{version:1,documentId:hostId,pathAtCreation:'Home/Host',firstInstanceId:instanceA},bindings:[],blocks}
}
function host(id=hostId,blocks=[block(' ordinary:正文 ')]):SyncedPortableHostRecord {
  return {kind:'document',id,parentId:null,sortOrder:0,createdAt:time,content:{title:id===hostId?'Host':'Other',summary:'',blocks}}
}
function catalog():SyncDatabases {
  return {kind:'databases',id:'databases',tables:{databases:[{id:'catalog',name:'Default',description:'Default database',created_at:time}],
    document_database_columns:[],database_saved_views:[],database_entities:[],database_entity_values:[],document_database_values:[]}}
}
const docDeleted=():Extract<SyncedProtocol5Record,{kind:'deleted'}>=>({kind:'deleted',id:' 已删:文档 '})
const groupDeleted=():Extract<SyncedProtocol5Record,{kind:'synced-group-deleted'}>=>({kind:'synced-group-deleted',id:deletedGroup,creationId,previousHash:'b'.repeat(64),deletedAt:time})
function input(records:SyncedProtocol5Record[],syncedInstances:SyncedProtocol5Manifest['syncedInstances']=[]):Input {
  const values=records.map(record=>({key:record.kind==='databases'?'databases':record.kind==='synced-group'||record.kind==='synced-group-deleted'?'group:'+record.id:'doc:'+record.id,record}))
  return {manifest:{version:5,workspaceId:workspace,entries:Object.fromEntries(values.map(v=>[v.key,digest(v.record)])),syncedInstances},values}
}
function live() {
  const source=group(),document=host(hostId,[block(' ordinary:正文 '),ref(instanceA),ref(instanceB)]),databases=catalog()
  return {...input([document,source,databases],[instanceA,instanceB].map(instanceId=>({documentId:hostId,instanceId,groupId,groupHash:digest(source)}))),source,document,databases}
}
const validate=(v:Input)=>validateSyncedProtocol5Snapshot(v.manifest,v.values)
function reject(run:()=>unknown,message:string) {assert.throws(run,(error:unknown)=>error instanceof Error,message)}
function changed(value:Input,key:string,change:(raw:Raw)=>void):Input {
  const copy=structuredClone(value),entry=copy.values.find(v=>v.key===key)
  assert.ok(entry,'A negative wire mutation starts from an existing complete original record')
  change(entry.record);copy.manifest.entries[key]=digest(entry.record)
  for(const dependency of copy.manifest.syncedInstances)if('group:'+dependency.groupId===key)dependency.groupHash=copy.manifest.entries[key]
  return copy
}

test('protocol5 keys preserve opaque IDs and distinguish all five record kinds without guessing deletion domains',()=>{
  const records=[host(),group(),catalog(),docDeleted(),groupDeleted()],keys=['doc:'+hostId,'group:'+groupId,'databases','doc: 已删:文档 ','group:'+deletedGroup]
  records.forEach((record,index)=>{assert.equal(syncedProtocol5RecordKey(record),keys[index]);assert.deepEqual(validateSyncedProtocol5Record(record,keys[index]),record)
    reject(()=>validateSyncedProtocol5Record(record,keys[(index+1)%keys.length]),'Each record is bound to its own exact namespace and identity')})
})

test('protocol5 tombstones have closed finite shapes and preserve raw valid dates and incarnation hashes',()=>{
  const d=docDeleted(),g=groupDeleted()
  for(const bad of [{...d,deletedAt:time},{...d,id:''},{...d,id:' \t '},{...d,groupId},{kind:'deletion',id:d.id}])
    reject(()=>validateSyncedProtocol5Record(bad,'doc:'+d.id),'A document deletion is exactly kind and a nonempty opaque id')
  for(const patch of [{id:'not-uuid'},{creationId:'not-uuid'},{previousHash:'B'.repeat(64)},{previousHash:'b'.repeat(63)},
    {deletedAt:'not-a-date'},{deletedAt:0},{blocks:[]},{revision:instanceA},{origin:group().origin},{reason:'caller-authority'}])
    reject(()=>validateSyncedProtocol5Record({...g,...patch},'group:'+g.id),'A group deletion has strict UUID hash date and no local or caller fields')
  assert.deepEqual(validateSyncedProtocol5Record(g,'group:'+g.id),g)
  assert.notEqual(digest(g),digest({...g,deletedAt:'2026-10-18T00:00:00.000Z'}),'Dates are validated but their original spelling is not normalized')
})

test('protocol5 mixed closure retains orphan live groups and tombstones with independent object hashes and sorted records',()=>{
  const value=input([docDeleted(),groupDeleted(),group(),catalog()]),before=structuredClone(value),actual=validate(value)
  assert.deepEqual(actual.manifest,value.manifest);assert.deepEqual(actual.records.map(v=>v.key),Object.keys(value.manifest.entries).sort())
  for(const entry of actual.records)assert.equal(entry.hash,digest(entry.record))
  assert.deepEqual([...actual.assetNames],[]);assert.deepEqual(value,before)
})

test('protocol5 accepts null-prototype JSON records and literal prototype-looking opaque keys without normalizing identities',()=>{
  const plain=input([group(),docDeleted(),catalog()]),nullRecords=(v:unknown):unknown=>Array.isArray(v)?v.map(nullRecords):v!==null&&typeof v==='object'
    ?Object.assign(Object.create(null) as Record<string,unknown>,Object.fromEntries(Object.entries(v).map(([k,x])=>[k,nullRecords(x)]))):v
  const value=nullRecords(plain) as Input
  assert.deepEqual(JSON.parse(canonical(validate(value).manifest)),plain.manifest)
  const deleted={kind:'deleted' as const,id:'__proto__'},prototypeKey=input([deleted,catalog()])
  assert.equal(Object.hasOwn(validate(prototypeKey).manifest.entries,'doc:__proto__'),true)
  assert.equal(validateSyncedProtocol5Record(deleted,'doc:__proto__').id,'__proto__')
})

test('protocol5 object collections reject duplicates holes extras missing keys and stale object hashes',()=>{
  const original=live()
  for(const mutate of [(v:Input)=>{v.values.pop()},(v:Input)=>{v.values.push(structuredClone(v.values[0]))},
    (v:Input)=>{v.values.push({key:'doc:extra',record:host('extra',[block('extra')])})},(v:Input)=>{v.values[0].key='doc:wrong'},
    (v:Input)=>{v.values=new Array<Entry>(v.values.length)},(v:Input)=>{(v.values[0] as Raw).extra=true},
    (v:Input)=>{v.manifest.entries.databases='c'.repeat(64)},(v:Input)=>{(v.values[0].record as SyncedPortableHostRecord).content.summary='changed bytes'}]) {
    const value=structuredClone(original);mutate(value);reject(()=>validate(value),'Every provided slot and exact original hash belongs to the complete manifest collection')
  }
})

test('protocol5 rejects custom prototypes symbol keys nonenumerable extras and array decorations throughout the wire',()=>{
  const paths:Array<(v:Raw)=>object>=[v=>v.manifest,v=>v.manifest.entries,v=>v.manifest.syncedInstances,v=>v.values,v=>v.values[0],
    v=>v.values[0].record,v=>v.values[0].record.content,v=>v.values[0].record.content.blocks,v=>v.values[0].record.content.blocks[0],
    v=>v.values[1].record.origin,v=>v.values[1].record.bindings,v=>v.values[1].record.blocks]
  for(const locate of paths)for(const mode of ['prototype','symbol','hidden','extra'] as const) {
    const value=live(),target=locate(value)
    if(mode==='prototype')Object.setPrototypeOf(target,Array.isArray(target)?Object.create(Array.prototype):{inherited:true})
    else if(mode==='symbol')Object.defineProperty(target,Symbol('hidden-authority'),{value:true,enumerable:true})
    else Object.defineProperty(target,mode==='extra'?'callerExtra':'hiddenExtra',{value:true,enumerable:mode==='extra'})
    reject(()=>validate(value),'A pure JSON wire rejects prototype aliases and every own extra key before trusted interpretation')
  }
})

test('protocol5 rejects accessors without invoking getters at manifest collection record block and binding leaves',()=>{
  const targets:Array<(v:Raw)=>[object,string]>=[v=>[v.manifest,'version'],v=>[v.manifest.entries,'databases'],v=>[v.manifest.syncedInstances,'0'],
    v=>[v.manifest.syncedInstances[0],'groupHash'],v=>[v.values,'0'],v=>[v.values[0],'record'],v=>[v.values[0].record,'kind'],
    v=>[v.values[0].record.content,'blocks'],v=>[v.values[1].record.blocks,'0'],v=>[v.values[1].record.blocks[0],'content'],v=>[v.values[1].record.origin,'documentId']]
  for(const locate of targets){const value=live(),[target,key]=locate(value),original=Object.getOwnPropertyDescriptor(target,key)?.value;let calls=0
    Object.defineProperty(target,key,{configurable:true,enumerable:true,get(){calls++;return original}})
    reject(()=>validate(value),'No accessor is executed while admitting untrusted wire data');assert.equal(calls,0)
  }
})

test('protocol5 rejects cyclic and non-JSON scalar data and callable toJSON without executing conversion hooks',()=>{
  for(const invalid of [NaN,Infinity,-Infinity,1n,Symbol('wire'),()=>true]) {
    const value=live();(value.values[1].record as Raw).caller=invalid
    reject(()=>validate(value),'Non-JSON wire values are rejected instead of being silently omitted or converted')
  }
  const cycle=live();(cycle.values[1].record as Raw).caller=cycle.values[1].record
  reject(()=>validate(cycle),'Ancestor cycles are rejected before canonical serialization')
  const value=live();let calls=0
  Object.defineProperty(value.values[1].record,'toJSON',{enumerable:true,value:()=>{calls++;return group()}})
  reject(()=>validate(value),'A wire never invokes caller supplied serialization hooks');assert.equal(calls,0)
  const direct=groupDeleted(),old=direct.deletedAt
  Object.defineProperty(direct,'deletedAt',{enumerable:true,get(){calls++;return old}})
  reject(()=>validateSyncedProtocol5Record(direct,'group:'+direct.id),'The standalone record API has the same descriptor-first boundary');assert.equal(calls,0)
})

test('protocol5 manifest remains closed version5 with sorted unique exact instance dependencies',()=>{
  for(const mutate of [(v:Raw)=>{v.version=4},(v:Raw)=>{v.workspaceId='legacy_workspace'},(v:Raw)=>{v.recoveryEpoch=creationId},
    (v:Raw)=>{v.entries['group:bad']=assetHash},(v:Raw)=>{v.entries['unknown:kind']=assetHash},(v:Raw)=>{v.syncedInstances.reverse()},
    (v:Raw)=>{v.syncedInstances.push(structuredClone(v.syncedInstances[0]))},(v:Raw)=>{v.syncedInstances[0].bindingVersion=creationId}]) {
    const value=live();mutate(value.manifest);reject(()=>validate(value),'Manifest fields namespaces and dependencies are exact rather than normalized')
  }
})

test('protocol5 live references cannot consume tombstones and dependencies cover every actual instance leaf',()=>{
  for(const mutate of [(v:Input)=>{v.manifest.syncedInstances.pop()},(v:Input)=>{v.manifest.syncedInstances[0].groupHash=assetHash},
    (v:Input)=>{v.manifest.syncedInstances[0].documentId='absent'},(v:Input)=>{v.manifest.syncedInstances[0].instanceId=deletedGroup}]) {
    const value=live();mutate(value);reject(()=>validate(value),'A declared dependency must match the actual leaf and live canonical object hash')
  }
  const value=live(),deleted={...groupDeleted(),id:groupId}
  reject(()=>validate(input([value.document,deleted,catalog()],value.manifest.syncedInstances.map(v=>({...v,groupHash:digest(deleted)})))),
    'A tombstone with a correct own hash still cannot satisfy a live group reference')
})

test('protocol5 tombstone filtering does not hide missing parents cycles or duplicate ordinary canonical and instance owners',()=>{
  const base=live(),d=docDeleted(),dependent=host('dependent',[block('dependent-block')]);dependent.parentId=d.id
  reject(()=>validate(input([d,dependent,catalog()])),'A deleted document cannot be a live parent')
  reject(()=>validate(changed(base,'doc:'+hostId,r=>{r.parentId=r.id})),'The full live parent graph remains acyclic')
  reject(()=>validate(changed(base,'doc:'+hostId,r=>{const {createdAt:_born,...ordinary}=base.source.blocks[0];r.content.blocks.unshift(ordinary)})),
    'A canonical child cannot also have an ordinary physical owner')
  reject(()=>validate(input([base.document,host('other',[ref(instanceA)]),base.source,catalog()],base.manifest.syncedInstances)),
    'A globally unique instance id cannot belong to two hosts')
})

test('protocol5 preserves reversed full binding Keys with distinct historical targets at the same URL',()=>{
  const source=group([child('link-body','😀 [one](Same.md) and [two](Same.md)')]),text=source.blocks[0].content
  source.bindings=['Same.md','Same.md'].map((raw,index)=>{const from=index?text.lastIndexOf(raw):text.indexOf(raw);return {blockId:'link-body',from,to:from+raw.length,raw,syntax:'markdown' as const,
    target:{kind:'document' as const,id:index?'other':hostId,state:'live' as const}}}).reverse()
  const value=input([source,host(),host('other',[block('other-block')]),catalog()]),actual=validate(value).records.find(v=>v.key==='group:'+groupId)?.record
  assert.ok(actual?.kind==='synced-group','The exact binding oracle reads its actual live group');assert.deepEqual(actual.bindings,source.bindings)
  for(const mutate of [(r:Raw)=>{r.bindings.pop()},(r:Raw)=>{r.bindings.push(structuredClone(r.bindings[0]))},(r:Raw)=>{r.bindings[0].from++},
    (r:Raw)=>{r.bindings[0].syntax='wiki'},(r:Raw)=>{r.bindings[0].raw='another URL'}])
    reject(()=>validate(changed(value,'group:'+groupId,mutate)),'Full physical Keys cannot be substituted by URL or array position')
})

test('protocol5 asset-name closure includes summary and same-hash aliases while code and Origin remain opaque',()=>{
  const uri=(name:string)=>'knowbook-asset://'+assetHash+'/'+encodeURIComponent(name),source=group([child('image',`![x](<${uri('one.png')}>)`),
    {...child('code','![literal](<file:///outside.png>)'),type:'code'}]),document=host()
  document.content.summary=`![other](<${uri('中文 alias.png')}>)`;source.origin.pathAtCreation='file:///literal-origin'
  const actual=validate(input([source,document,docDeleted(),groupDeleted(),catalog()]))
  assert.deepEqual([...actual.assetNames.keys()],[assetHash]);assert.deepEqual([...(actual.assetNames.get(assetHash)??[])].sort(),['one.png','中文 alias.png'].sort())
  for(const bad of ['file:///outside.png',uri('one.png')+'?x=1',uri('one.png')+'#part',uri('one.png').replace(assetHash,'user@'+assetHash),
    uri('one.png').replace('one','%6Fne')])reject(()=>validate(changed(input([group(),catalog()]),'group:'+groupId,r=>{r.blocks[0].content=`![x](<${bad}>)`})),
      'An accurate enclosing hash does not legalize an actual nonportable destination')
})

test('protocol5 catalogs remain exact six-table atoms with valid cross-table sources after tombstone filtering',()=>{
  for(const mutate of [(r:Raw)=>{delete r.tables.database_entities},(r:Raw)=>{r.tables.extra=[]},(r:Raw)=>{r.tables.databases[0].updated_at=time},
    (r:Raw)=>{r.tables.databases.push(structuredClone(r.tables.databases[0]))},(r:Raw)=>{r.tables.databases[0].id='not-catalog'},
    (r:Raw)=>{r.tables.database_entities.push({id:'entity',database_id:'absent',title:'Entity',document_id:null,created_at:time})},
    (r:Raw)=>{r.tables.database_entities.push({id:'entity',database_id:'catalog',title:'Entity',document_id:docDeleted().id,created_at:time})}])
    reject(()=>validate(changed(input([host(),docDeleted(),catalog()]),'databases',mutate)),'Catalog rows stay exact and tombstoned documents are not live entity sources')
  reject(()=>validate(input([group(),docDeleted()])),'A complete protocol5 closure cannot omit the atomic catalog')
  const config=createDefaultDatabaseViewConfig(),db=catalog(),document=host();db.tables.databases.push({id:'other-db',name:'Other',description:'',created_at:time})
  db.tables.database_saved_views.push({id:'view',database_id:'other-db',name:'View',filter_query:'',filter_scope:'',sort_mode:'updated-desc',view_mode:'table',config_json:JSON.stringify(config),config_version:1,sort_order:0,created_at:time})
  document.content.blocks.push({...block('view-block',serializeDatabaseViewPayload({version:1,databaseId:'catalog',viewId:'view',config})),type:'database-view'})
  reject(()=>validate(input([document,db])),'A known saved view cannot silently move into another database source')
})

test('protocol5 combined depth and parent role remain strict even when each individual forest is locally valid',()=>{
  const source=group([{...child('parent'),type:'toggle'},{...child('nested'),depth:1,parentBlockId:'parent'}]),parents=Array.from({length:6},(_,depth)=>
    ({...block('p'+depth),type:'toggle',depth,parentBlockId:depth?'p'+(depth-1):null})),document=host(hostId,[...parents,{...ref(instanceA),depth:6,parentBlockId:'p5'}])
  reject(()=>validate(input([source,document,catalog()],[{documentId:hostId,instanceId:instanceA,groupId,groupHash:digest(source)}])),
    'A transparent projection cannot exceed the original depth-six bound')
  const list=block('task');list.type='todo';const listHost=host(hostId,[list,{...ref(instanceA),depth:1,parentBlockId:list.id}])
  reject(()=>validate(input([group(),listHost,catalog()],[{documentId:hostId,instanceId:instanceA,groupId,groupHash:digest(group())}])),
    'A paragraph canonical root cannot be inserted under a list parent merely because depths fit')
})

test('protocol5 retains inclusive group bytes and original object and repeated-host budgets',()=>{
  const source=group(),base=Buffer.byteLength(canonical(source));source.blocks[0].content='x'.repeat(SYNCED_GROUP_MAX_BYTES-base)
  assert.equal(Buffer.byteLength(canonical(source)),SYNCED_GROUP_MAX_BYTES);assert.doesNotThrow(()=>validate(input([source,groupDeleted(),catalog()])))
  source.blocks[0].content+='x';reject(()=>validate(input([source,catalog()])),'One additional UTF8 byte exceeds the group budget')
  const huge=host();huge.content.summary='x'.repeat(PUBLICATION_RECORD_MAX_BYTES)
  reject(()=>validate(input([huge,catalog()])),'Complete document envelopes retain the original sixteen MiB limit')
  const repeated=group([child('big','x'.repeat(1024*1024))]),refs=Array.from({length:17},(_,i)=>ref(`10000000-0000-0000-0000-${String(i).padStart(12,'0')}`))
  reject(()=>validate(input([repeated,host(hostId,refs),catalog()],refs.map(v=>({documentId:hostId,instanceId:v.id,groupId,groupHash:digest(repeated)})))),
    'Repeated group occurrences each count against the original projected-host byte limit')
})

test('protocol5 expanded nodes count occurrences rather than unique canonical IDs at the original hundred-thousand boundary',()=>{
  const source=group(Array.from({length:20_000},(_,i)=>child('budget-'+i))),refs=Array.from({length:6},(_,i)=>ref(`20000000-0000-0000-0000-${String(i).padStart(12,'0')}`))
  const value=(count:number)=>input([source,host(hostId,refs.slice(0,count)),catalog()],refs.slice(0,count).map(v=>({documentId:hostId,instanceId:v.id,groupId,groupHash:digest(source)})))
  assert.equal(source.blocks.length*5,SYNCED_MAX_BLOCKS);assert.doesNotThrow(()=>validate(value(5)))
  reject(()=>validate(value(6)),'Sharing one canonical object does not exempt expanded repeated nodes')
  const collection=input([catalog()]),entry=collection.values[0];collection.values=Array.from({length:SYNCED_MAX_BLOCKS+1},()=>entry)
  reject(()=>validate(collection),'The complete object list also retains its original entry limit')
})

test('protocol5 raw JSON duplicate keys and canonical bytes remain a separate strict provenance layer',()=>{
  const record=groupDeleted(),bytes=canonical(record);assert.deepEqual(decodePublicationJson(Buffer.from(bytes)),record)
  for(const bad of ['{"kind":"synced-group-deleted",'+bytes.slice(1),bytes+'\n',' '+bytes])
    reject(()=>decodePublicationJson(Buffer.from(bad)),'Raw duplicate or alternate bytes are rejected before decoded-object validation erases their provenance')
})

test('protocol5 codec does not widen initial tombstone acceptance or legacy protocol1 through4 manifest readers',()=>{
  for(const record of [docDeleted(),groupDeleted()]){const key=record.kind==='deleted'?'doc:'+record.id:'group:'+record.id,value=input([record,catalog()])
    reject(()=>validateInitialRecord(record,key),'The existing initial record API remains live-only');reject(()=>validateInitialSnapshot(value.manifest,value.values),'The existing initial closure API remains live-only');assert.doesNotThrow(()=>validate(value))}
  reject(()=>parseManifest(Buffer.from(canonical(live().manifest))),'The actual old manifest decoder still refuses protocol5')
  for(const version of [1,2,3,4] as const){const old={version,workspaceId:'legacy_workspace',entries:{'doc:legacy':assetHash}}
    assert.deepEqual(parseManifest(Buffer.from(canonical(old))),old);reject(()=>validateSyncedProtocol5Snapshot({...live().manifest,version},live().values),'Protocol5 is not inferred from a legacy manifest')
    reject(()=>parseManifest(Buffer.from(canonical({...old,entries:{['group:'+groupId]:assetHash}}))),'Legacy namespaces are not widened to group records')}
})
