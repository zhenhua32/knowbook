import assert from 'node:assert/strict'
import test from 'node:test'
import type {SyncedGroupWire,SyncedCanonicalWire,SyncedLinkTarget} from '../src/shared/synced-blocks'
import type {SyncedPortableHostRecord} from '../src/shared/syncedBlockPortable'
import {COLUMN_WEIGHT_TOTAL} from '../src/shared/columns'
import {createDefaultDatabaseViewConfig} from '../src/shared/database-workspace'
import {serializeDatabaseViewPayload} from '../src/shared/databaseViewBlock'
import {mergeSyncedProtocol5Record} from '../src/main/sync/synced-merge'

const id='00000000-0000-0000-0000-000000000011',creation='00000000-0000-0000-0000-000000000012',instance='00000000-0000-0000-0000-000000000013',born='2020-01-02T03:04:05+08:00'
const child=(id:string,content='alpha middle omega'):SyncedCanonicalWire=>({id,type:'paragraph',content,checked:false,depth:0,parentBlockId:null,createdAt:born})
function group(blocks=[child(' canonical:旧稳定 / 身份 ')]):SyncedGroupWire{return {kind:'synced-group',id,creationId:creation,createdAt:born,
  origin:{version:1,documentId:' host:旧身份 ',pathAtCreation:'Home/Host',firstInstanceId:instance},blocks,bindings:[]}}
function host():SyncedPortableHostRecord{return {kind:'document',id:' ordinary:旧稳定 身份 ',createdAt:born,parentId:null,sortOrder:0,
  content:{title:'Host',summary:'left middle right',blocks:[{id:' ordinary:正文 ',type:'paragraph',content:'alpha middle omega',checked:false,depth:0,parentBlockId:null}]}}}
function mergedGroup(base:SyncedGroupWire,local=base,remote=base,choices:Parameters<typeof mergeSyncedProtocol5Record>[3]={}){
  const result=mergeSyncedProtocol5Record(base,local,remote,choices);assert.ok(result?.record.kind==='synced-group','The pure merge returns the exact original group domain')
  if(!result||result.record.kind!=='synced-group')throw new Error('Expected a group merge result');return {...result,record:result.record}
}
function mergedHost(base:SyncedPortableHostRecord,local=base,remote=base,choices:Parameters<typeof mergeSyncedProtocol5Record>[3]={}){
  const result=mergeSyncedProtocol5Record(base,local,remote,choices);assert.ok(result?.record.kind==='document','The pure merge returns the exact original host domain')
  if(!result||result.record.kind!=='document')throw new Error('Expected a host merge result');return {...result,record:result.record}
}
function linked(text='before [one](Same.md) between [two](Same.md) after'):SyncedGroupWire{
  const record=group([child(' link:物理正文 ',text)]),positions=[text.indexOf('Same.md'),text.lastIndexOf('Same.md')]
  record.bindings=positions.map((from,index)=>({blockId:record.blocks[0].id,from,to:from+7,raw:'Same.md',syntax:'markdown' as const,
    target:{kind:'document' as const,id:index?'historical-two':'historical-one',state:'live' as const}})).reverse();return record
}

test('synced pure merge preserves opaque canonical identities birth and independent stable-block metadata without changing or aliasing inputs',()=>{
  const base=group([child(' first:opaque '),child(' second:opaque ','second base')]),local=structuredClone(base),remote=structuredClone(base)
  local.blocks[0].content='ALPHA middle omega';local.blocks[1].tags=['local'];remote.blocks[1].content='second REMOTE';remote.blocks[0].highlight='blue'
  const before=structuredClone([base,local,remote]),result=mergedGroup(base,local,remote)
  assert.deepEqual(result.unresolved,[]);assert.equal(result.record.blocks[0].content,'ALPHA middle omega');assert.equal(result.record.blocks[1].content,'second REMOTE')
  assert.equal(result.record.blocks[0].highlight,'blue');assert.deepEqual(result.record.blocks[1].tags,['local']);assert.deepEqual(result.record.blocks.map(b=>b.createdAt),[born,born])
  assert.deepEqual([base,local,remote],before);result.record.blocks[0].content='mutated diagnostic result';assert.deepEqual([base,local,remote],before)
})

test('synced pure host merge accepts original opaque IDs and combines metadata fields without trimming custom text',()=>{
  const base=host(),local=structuredClone(base),remote=structuredClone(base)
  local.parentId=' parent:opaque identity ';local.sortOrder=2;remote.content.summary='LEFT middle right';local.content.summary='left middle RIGHT'
  local.content.blocks[0].content='LOCAL conflict';remote.content.blocks[0].content='REMOTE conflict'
  const part='block:'+base.content.blocks[0].id+':content',text='  exact custom 😀\n  ',result=mergedHost(base,local,remote,{[part]:{choice:'custom',text}})
  assert.deepEqual(result.unresolved,[]);assert.equal(result.record.parentId,local.parentId);assert.equal(result.record.sortOrder,2)
  assert.equal(result.record.content.summary,'LEFT middle RIGHT');assert.equal(result.record.content.blocks[0].content,text)
  assert.equal(result.record.id,base.id);assert.equal(result.record.createdAt,born)
})

test('synced pure Unicode merge combines nonoverlapping graphemes but never splits a composed emoji or guesses repeated insertion locations',()=>{
  const base=group([child('unicode','甲👩🏽‍💻乙🙂丙')]),local=structuredClone(base),remote=structuredClone(base)
  local.blocks[0].content='新👩🏽‍💻乙🙂丙';remote.blocks[0].content='甲👩🏽‍💻乙🚀丙'
  const result=mergedGroup(base,local,remote);assert.deepEqual(result.unresolved,[]);assert.equal(result.record.blocks[0].content,'新👩🏽‍💻乙🚀丙')
  for(const [before,a,b] of [['👩🏽‍💻','👩🏻‍💻','👩🏽‍🔬'],['aaaa','aaaaa','aaaab'],['middle','LOCALmiddle','REMOTEmiddle']]){
    const base=group([child('ambiguous',before)]),local=structuredClone(base),remote=structuredClone(base);local.blocks[0].content=a;remote.blocks[0].content=b
    assert.ok(mergedGroup(base,local,remote).unresolved.some(p=>p.field==='block-content'),'Ambiguous anchors or overlapping grapheme edits remain an explicit text conflict')
  }
})

test('synced pure bindings project complete reversed equal-URL physical Keys while preserving two distinct historical targets',()=>{
  const base=linked(),local=linked('LOCAL prefix '+base.blocks[0].content),remote=linked(base.blocks[0].content+' REMOTE suffix'),result=mergedGroup(base,local,remote)
  assert.deepEqual(result.unresolved,[]);const text=result.record.blocks[0].content,links=[...result.record.bindings].sort((a,b)=>a.from-b.from)
  assert.equal(text,'LOCAL prefix '+base.blocks[0].content+' REMOTE suffix')
  assert.deepEqual(links.map(b=>[b.blockId,b.from,b.to,b.raw,b.syntax]),[text.indexOf('Same.md'),text.lastIndexOf('Same.md')].map(from=>[base.blocks[0].id,from,from+7,'Same.md','markdown']))
  assert.deepEqual(links.map(b=>b.target),[{kind:'document',id:'historical-one',state:'live'},{kind:'document',id:'historical-two',state:'live'}])
})

test('synced pure atomic target conflicts require a whole forest and binding choice instead of exchanging equal-URL sources',()=>{
  const base=linked(),local=structuredClone(base),remote=structuredClone(base),target:SyncedLinkTarget={kind:'document',id:'third-original-target',state:'live'}
  local.bindings[0].target=target;remote.bindings[0].target={kind:'document',id:'fourth-original-target',state:'live'}
  const preview=mergedGroup(base,local,remote);assert.deepEqual(preview.unresolved.map(p=>p.id),['blocks']);assert.equal(preview.unresolved[0].canEditText,false)
  const selected=mergedGroup(base,local,remote,{blocks:{choice:'remote'}})
  assert.deepEqual(selected.unresolved,[]);assert.deepEqual(selected.record.blocks,remote.blocks);assert.deepEqual(selected.record.bindings,remote.bindings)
  assert.throws(()=>mergedGroup(base,local,remote,{blocks:{choice:'custom',text:'caller forest'}}),Error)
})

test('synced pure structural insertion type order parent and canonical birth changes always expose one atomic forest choice',()=>{
  const base=group([child('first'),child('second','second')])
  const scenarios:Array<(local:SyncedGroupWire,remote:SyncedGroupWire)=>void>=[
    local=>{local.blocks.push(child('fresh','new child'))},local=>{local.blocks.reverse()},local=>{local.blocks[0].type='quote'},
    local=>{local.blocks[0].type='toggle';local.blocks[1].depth=1;local.blocks[1].parentBlockId=local.blocks[0].id},
    local=>{local.blocks[0].createdAt='2025-01-01T00:00:00.000Z'}]
  for(const change of scenarios){const local=structuredClone(base),remote=structuredClone(base);change(local,remote);remote.blocks[0].content='remote independent existing body'
    const preview=mergedGroup(base,local,remote);assert.deepEqual(preview.unresolved.map(p=>p.id),['blocks'])
    const result=mergedGroup(base,local,remote,{blocks:{choice:'local'}});assert.deepEqual(result.unresolved,[]);assert.deepEqual(result.record.blocks,local.blocks)
  }
})

test('synced pure columns choose the complete finite weight vector while retaining independent ordinary body edits',()=>{
  const half=COLUMN_WEIGHT_TOTAL/2,base=group([
    {...child('columns',''),type:'columns'},
    {...child('left',''),type:'column',depth:1,parentBlockId:'columns',markdownFormat:{columnWeight:half}},
    {...child('left-body'),depth:2,parentBlockId:'left'},
    {...child('right',''),type:'column',depth:1,parentBlockId:'columns',markdownFormat:{columnWeight:half}},
    {...child('right-body','second'),depth:2,parentBlockId:'right'}]),local=structuredClone(base),remote=structuredClone(base)
  local.blocks[1].markdownFormat={columnWeight:COLUMN_WEIGHT_TOTAL*0.6};local.blocks[3].markdownFormat={columnWeight:COLUMN_WEIGHT_TOTAL*0.4}
  remote.blocks[1].markdownFormat={columnWeight:COLUMN_WEIGHT_TOTAL*0.7};remote.blocks[3].markdownFormat={columnWeight:COLUMN_WEIGHT_TOTAL*0.3};remote.blocks[4].content='remote right body'
  const part='block:columns:column-layout',preview=mergedGroup(base,local,remote);assert.ok(preview.unresolved.some(p=>p.id===part&&!p.canEditText),'Competing proportions are one atomic layout conflict')
  const result=mergedGroup(base,local,remote,{[part]:{choice:'local'}});assert.deepEqual(result.unresolved,[])
  assert.deepEqual([result.record.blocks[1].markdownFormat?.columnWeight,result.record.blocks[3].markdownFormat?.columnWeight],[COLUMN_WEIGHT_TOTAL*0.6,COLUMN_WEIGHT_TOTAL*0.4]);assert.equal(result.record.blocks[4].content,'remote right body')
})

test('synced pure database views and host reference payloads remain atomic noncustom content even when their JSON fields differ',()=>{
  const config=createDefaultDatabaseViewConfig(),base=group([{...child('view'),type:'database-view',content:serializeDatabaseViewPayload({version:1,databaseId:'catalog',viewId:null,config})}]),local=structuredClone(base),remote=structuredClone(base)
  local.blocks[0].content=serializeDatabaseViewPayload({version:1,databaseId:'catalog',viewId:null,config:{...config,query:'local opaque query'}})
  remote.blocks[0].content=serializeDatabaseViewPayload({version:1,databaseId:'catalog',viewId:null,config:{...config,query:'remote opaque query'}})
  const part='block:view:content',preview=mergedGroup(base,local,remote);assert.ok(preview.unresolved.some(p=>p.id===part&&!p.canEditText),'Database payloads never receive a synthesized JSON merge')
  assert.deepEqual(mergedGroup(base,local,remote,{[part]:{choice:'remote'}}).record.blocks,remote.blocks)
  assert.throws(()=>mergedGroup(base,local,remote,{[part]:{choice:'custom',text:remote.blocks[0].content}}),Error)
  const h=host();h.content.blocks[0].type='synced-block';h.content.blocks[0].id=instance;h.content.blocks[0].content=JSON.stringify({version:1,groupId:id})
  const a=structuredClone(h),b=structuredClone(h);a.content.blocks[0].content=JSON.stringify({version:1,groupId:creation});b.content.blocks[0].content=JSON.stringify({version:1,groupId:instance})
  const result=mergedHost(h,a,b);assert.ok(result.unresolved.some(p=>p.id==='block:'+instance+':content'&&!p.canEditText),'Host group payload identities are indivisible choices')
})

test('synced pure protected destinations and portable asset identities never become a third composite target',()=>{
  for(const before of ['[link](https://example.test/abcd)',`![asset](knowbook-asset://${'a'.repeat(64)}/image.png)`]){
    const base=group([child('protected',before)]),local=structuredClone(base),remote=structuredClone(base)
    local.blocks[0].content=before.includes('knowbook-asset')?before.replace('a'.repeat(64),'b'+'a'.repeat(63)):before.replace('/abcd','/Abcd')
    remote.blocks[0].content=before.includes('knowbook-asset')?before.replace('a'.repeat(64),'a'.repeat(63)+'c'):before.replace('/abcd','/abcD')
    const preview=mergedGroup(base,local,remote);assert.ok(preview.unresolved.length>0,'Two edits inside one protected identity do not synthesize an unauthorized new target')
  }
})

test('synced pure empty-code syntax remains structural and original text computation limits fall back to an explicit resolvable conflict',()=>{
  const base=group([{...child('code','base code'),type:'code',language:'js'}]),local=structuredClone(base),remote=structuredClone(base)
  local.blocks[0].content='';local.blocks[0].markdownFormat={emptyCode:true};remote.blocks[0].content='remote code'
  assert.deepEqual(mergedGroup(base,local,remote).unresolved.map(p=>p.id),['blocks'])
  for(const text of ['a'.repeat(32001),'a'.repeat(1200)+'z'.repeat(1200)]){
    const base=group([child('bounded',text)]),local=structuredClone(base),remote=structuredClone(base)
    local.blocks[0].content='b'.repeat(text.length);remote.blocks[0].content='c'.repeat(text.length)
    const preview=mergedGroup(base,local,remote);assert.ok(preview.unresolved.length>0,'The original finite text-work budget is not expanded for protocol5')
    const part=preview.unresolved[0].id;assert.deepEqual(mergedGroup(base,local,remote,{[part]:{choice:'remote'}}).unresolved,[])
  }
})

test('synced pure incompatible kinds creation origin document birth or logical identities do not manufacture an ancestor',()=>{
  const base=group()
  for(const change of [(r:SyncedGroupWire)=>{r.id=creation},(r:SyncedGroupWire)=>{r.creationId=instance},(r:SyncedGroupWire)=>{r.createdAt='2025-01-01T00:00:00Z'},(r:SyncedGroupWire)=>{r.origin.pathAtCreation='Elsewhere'}]){
    const remote=structuredClone(base);change(remote);assert.equal(mergeSyncedProtocol5Record(base,base,remote),null)
  }
  assert.equal(mergeSyncedProtocol5Record(base,base,{kind:'synced-group-deleted',id,creationId:creation,previousHash:'a'.repeat(64),deletedAt:born}),null)
  const h=host(),other=structuredClone(h);other.createdAt='2025-01-01T00:00:00Z';assert.equal(mergeSyncedProtocol5Record(h,h,other),null)
})

test('synced pure closed choices reject unknown extra custom-structure accessor prototype and symbol inputs without executing accessors',()=>{
  const base=group(),local=structuredClone(base),remote=structuredClone(base);local.blocks[0].content='LOCAL';remote.blocks[0].content='REMOTE'
  const part='block:'+base.blocks[0].id+':content';let getters=0
  const invalid:unknown[]=[{unknown:{choice:'local'}},{[part]:{choice:'both'}},{[part]:{choice:'remote',extra:1}},Object.create({[part]:{choice:'local'}}),
    {[Symbol('unknown')]:{choice:'local'}},Object.defineProperty({},part,{enumerable:true,get(){getters++;return {choice:'local'}}}),
    {[part]:Object.defineProperty({},'choice',{enumerable:true,get(){getters++;return 'local'}})}]
  for(const choices of invalid)assert.throws(()=>mergedGroup(base,local,remote,choices as never),Error)
  assert.equal(getters,0)
  const invalidRecord=structuredClone(base);Object.defineProperty(invalidRecord.blocks[0],'content',{enumerable:true,get(){getters++;return 'unsafe'}})
  assert.throws(()=>mergeSyncedProtocol5Record(base,local,invalidRecord),Error);assert.equal(getters,0)
  assert.throws(()=>mergedGroup(base,base,base,{[part]:{choice:'remote'}}),Error,'An automatically resolved field cannot carry a redundant selector')
})
