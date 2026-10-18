import assert from 'node:assert/strict'
import test from 'node:test'
import type {SyncedPortableHostRecord} from '../src/shared/syncedBlockPortable'
import type {SyncDatabases} from '../src/main/sync/model'
import {publicationHash,publicationJson} from '../src/main/sync/synced-publication-model'
import {validateSyncedProtocol5Snapshot,type SyncedProtocol5Record} from '../src/main/sync/synced-protocol5-model'
import type {ExchangeState} from '../src/main/sync/synced-exchange-model'
import {planSyncedExchange,type ExchangePlanInput} from '../src/main/sync/synced-exchange-plan'
const uuid=(n:number)=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0'),born='2020-01-01T00:00:00.000Z'
const hash=(value:unknown)=>publicationHash(publicationJson(value))
function document(id:string):SyncedPortableHostRecord{return {kind:'document',id,createdAt:born,parentId:null,sortOrder:0,content:{title:id,summary:'',blocks:[{id:id+'-body',type:'paragraph',content:'base '+id,checked:false,depth:0,parentBlockId:null}]}}}
const catalog:SyncDatabases={kind:'databases',id:'databases',tables:{databases:[{id:'catalog',name:'Default',description:'Default database',created_at:born}],document_database_columns:[],database_saved_views:[],database_entities:[],database_entity_values:[],document_database_values:[]}}
function snapshot(records:SyncedProtocol5Record[],scope:string){const values=records.map(record=>({key:record.kind==='databases'?'databases':'doc:'+record.id,record}));return validateSyncedProtocol5Snapshot({version:5,workspaceId:scope,entries:Object.fromEntries(values.map(row=>[row.key,hash(row.record)])),syncedInstances:[]},values)}

test('a preview candidate must pass the whole retained graph before offering a merge that mixes individually legal parent sides into a cycle',()=>{
  const alpha=document('Alpha'),beta=document('Beta'),base=snapshot([alpha,beta,catalog],uuid(2)),a=structuredClone(alpha),rA=structuredClone(alpha),rB=structuredClone(beta)
  a.parentId=beta.id;a.content.blocks[0].content='LOCAL conflict';rA.content.blocks[0].content='REMOTE conflict';rB.parentId=alpha.id
  const local=snapshot([a,beta,catalog],uuid(1)),remote=snapshot([rA,rB,catalog],uuid(2))
  const state:ExchangeState={kind:'synced-exchange-state',version:1,databasePath:'/isolated/storage/knowbook.db',targetFingerprint:hash('target'),workspaceScope:uuid(1),recoveryEpoch:uuid(3),remoteWorkspaceId:uuid(2),generation:uuid(4),currentOperationId:null,
    source:{kind:'current-equality',operationId:null,manifestHash:hash(base.manifest),portableDigest:hash(base.manifest.entries)},baseline:base.records.map(row=>({key:row.key,localHash:row.hash,remoteHash:row.hash,commonHash:row.hash,dependencyKeys:[],dependencySignature:hash([]),acceptedOperationId:uuid(5)})),deferred:[],lastSyncAt:born}
  const input:ExchangePlanInput={operationId:uuid(6),local,remote,baseRecords:base.records,state,localFingerprint:hash('actual-pure-fixture-guard'),authority:{catalogId:'catalog',identities:[alpha,beta].flatMap(doc=>doc.content.blocks.map(block=>({id:block.id,last_owner_kind:'document' as const,last_owner_id:doc.id,state:'live' as const,created_at:born}))),occupiedDocumentIds:[alpha.id,beta.id],historyComponents:[],pinnedGroupIds:[],knownGroupIds:[]}}
  const plan=planSyncedExchange(input),c=plan.conflictPreviews?.find(row=>row.keys.includes('doc:'+alpha.id));assert.ok(c,'The actual original plan exposes this real same-component overlapping body conflict')
  assert.deepEqual(c.keys,['doc:Alpha','doc:Beta']);assert.equal(c.choices.includes('merge'),false,'The automatic parent fields of a text merge would produce Alpha→Beta→Alpha')
  for(const choice of ['local','remote'] as const){assert.ok(c.choices.includes(choice),'The complete original side is still a legal whole-forest candidate')
    const selected=planSyncedExchange({...input,conflictSelections:[{preview:c,decision:{componentId:c.componentId,choice}}]})
    assert.deepEqual(selected.deferred,[]);const records=new Map(selected.localFinal.records.map(row=>[row.key,row.record]))
    const first=records.get('doc:Alpha'),second=records.get('doc:Beta');assert.ok(first?.kind==='document'&&second?.kind==='document','Both exact selected host records remain in the complete final graph')
    assert.equal(first.parentId,choice==='local'?'Beta':null);assert.equal(second.parentId,choice==='local'?null:'Alpha')
  }
})
