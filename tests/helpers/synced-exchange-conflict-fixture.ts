import assert from 'node:assert/strict'
import {previewSyncedExchangeConflicts,resolveSyncedExchangeConflicts} from '../../src/main/sync/synced-exchange'
import {updateSyncedBlockGroup} from '../../src/main/database/synced-blocks-content'
import {captureSyncedGroupBindings} from '../../src/main/database/synced-block-links'
import type {SyncedBindingKey} from '../../src/shared/synced-blocks'
import {withExchange,completed,randomUUID,runtime,changeGroup,localPortable,remoteActual,stateRow} from './synced-exchange-fixture'
import {snapshot,type Profile} from './synced-initial-incoming-fixture'
export * from './synced-exchange-fixture'
export {snapshot,assetPath,rejected,mutateRemote,readonlyRequests,fileInventory} from './synced-initial-incoming-fixture'
export {previewSyncedExchangeConflicts,resolveSyncedExchangeConflicts}
export type Preview=Extract<Awaited<ReturnType<typeof previewSyncedExchangeConflicts>>,{status:'ready'}>['preview']
export type Component=Preview['components'][number]
export type Decision=Parameters<typeof resolveSyncedExchangeConflicts>[1]['decisions'][number]
type Original=Parameters<Parameters<typeof withExchange>[0]>[0]
type Options=Parameters<typeof withExchange>[1]
export type Fixture=Original&{
  preview:(profile?:Profile,previewId?:string,signal?:AbortSignal)=>ReturnType<typeof previewSyncedExchangeConflicts>
  resolve:(preview:Preview,decisions:Decision[],operationId?:string,profile?:Profile,signal?:AbortSignal)=>ReturnType<typeof resolveSyncedExchangeConflicts>
}
export async function withConflicts(run:(f:Fixture)=>Promise<void>,options:Options={}) {
  return withExchange(async f=>{
    const preview=(profile=f.B,previewId:string=randomUUID(),signal?:AbortSignal)=>f.track(previewSyncedExchangeConflicts(profile.db,
      {previewId,userDataRoot:profile.root,target:f.targetConfig},{...runtime,...(signal?{signal}:{})}))
    const resolve=(p:Preview,decisions:Decision[],operationId:string=randomUUID(),profile=f.B,signal?:AbortSignal)=>f.track(resolveSyncedExchangeConflicts(profile.db,
      {...f.input(operationId,profile),previewId:p.previewId,decisions},{...runtime,...(signal?{signal}:{})}))
    await run({...f,preview,resolve})
  },options)
}
export function ready(value:Awaited<ReturnType<typeof previewSyncedExchangeConflicts>>):Preview {
  assert.equal(value.status,'ready');assert.ok(value.status==='ready','A real full5 conflict preview is ready')
  if(value.status!=='ready')throw new Error('Expected an actual conflict preview')
  assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.preview)&&Object.isFrozen(value.preview.components),'The public preview shells are readonly')
  for(const c of value.preview.components){assert.ok(Object.isFrozen(c)&&Object.isFrozen(c.keys)&&Object.isFrozen(c.choices)&&Object.isFrozen(c.records),'Each real component owns readonly exact facts')
    for(const r of c.records)if(r.merge)assert.ok(Object.isFrozen(r.merge)&&Object.isFrozen(r.merge.conflicts)&&Object.isFrozen(r.merge.unresolved),'Merge preview collections are readonly')}
  return value.preview
}
export function component(preview:Preview,key:string):Component {
  const actual=preview.components.find(c=>c.keys.includes(key));assert.ok(actual,'The actual original preview includes the targeted dependency component');return actual
}
export function side(c:Component,choice:'local'|'remote'):Decision {
  assert.ok(c.choices.includes(choice),'The actual complete graph guards offer the requested whole-component side');return {componentId:c.componentId,choice}
}
export function mergeDecision(c:Component,value:(part:NonNullable<Component['records'][number]['merge']>['unresolved'][number])=>{choice:'local'|'remote'}|{choice:'custom';text:string}):Decision {
  assert.ok(c.choices.includes('merge'),'The actual preview offers a guarded merge choice')
  return {componentId:c.componentId,choice:'merge',records:c.records.filter(r=>r.merge&&r.merge.unresolved.length>0).map(r=>({key:r.key,
    parts:r.merge!.unresolved.map(part=>({id:part.id,value:value(part)})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)}
}
export async function commonGroup(f:Fixture,text='alpha middle omega',second=false) {
  const groupId=f.ack.createdLifecycle.groupId
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content=text;if(second)blocks.push({id:randomUUID(),type:'paragraph',content:'second stable base',checked:false,depth:0,parentBlockId:null,createdAt:blocks[0].createdAt})})
  completed(await f.exchange(f.A),'applied');completed(await f.exchange(f.B),'applied')
  const a=localPortable(f.A),b=localPortable(f.B),remote=remoteActual(f),key='group:'+groupId
  assert.equal(a.entries[key],b.entries[key]);assert.equal(a.entries[key],remote.manifest.entries[key])
  assert.equal(stateRow(f.B.db).state.baseline.find(row=>row.key===key)?.commonHash,a.entries[key],'The common ancestor is a real previously settled exact object')
  return groupId
}
export async function diverge(f:Fixture) {
  const groupId=await commonGroup(f)
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content='REMOTE overlapping original'});completed(await f.exchange(f.A),'applied')
  changeGroup(f.B.db,groupId,blocks=>{blocks[0].content='LOCAL overlapping original'})
  return groupId
}
export function editKeepingKeys(profile:Profile,groupId:string,change:(blocks:ReturnType<typeof snapshot>['blocks'])=>void) {
  const before=snapshot(profile.db,groupId),blocks=structuredClone(before.blocks);change(blocks)
  const destination=captureSyncedGroupBindings(profile.db,before.origin,blocks),key=({blockId,from,to,raw,syntax}:SyncedBindingKey)=>({blockId,from,to,raw,syntax})
  const sort=(a:SyncedBindingKey,b:SyncedBindingKey)=>a.blockId<b.blockId?-1:a.blockId>b.blockId?1:a.from-b.from
  const original=[...before.bindings].sort(sort),next=[...destination].sort(sort)
  assert.equal(next.length,original.length,'This positive edit preserves every original link occurrence')
  const claims=next.map((dest,index)=>{const source=original[index];assert.equal(dest.blockId,source.blockId);assert.equal(dest.raw,source.raw);assert.equal(dest.syntax,source.syntax)
    return {kind:'continue' as const,source:key(source),destination:key(dest)}}).reverse()
  const instance=before.instances[0];assert.ok(instance,'The genuine group edit retains its actual authorizing instance')
  const result=updateSyncedBlockGroup(profile.db,{clientOperationId:randomUUID(),groupId,expectedRevision:before.revision,expectedTopologyRevision:before.topologyRevision,
    expectedInstanceBinding:{instanceId:instance.instanceId,hostDocumentId:instance.hostDocumentId,bindingVersion:instance.bindingVersion},blocks:blocks.map(({createdAt:_birth,...block})=>block),bindingClaims:claims})
  assert.equal(result.status,'saved');return result
}
export function executionRows(profile:Profile) {
  return {operations:profile.db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all(),settings:profile.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange%' AND key NOT LIKE 'sync.webdav.protocol5.exchange-preview.%' ORDER BY key").all() as Array<{key:string;value:string}>}
}
