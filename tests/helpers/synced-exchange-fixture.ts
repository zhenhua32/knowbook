import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {relative,sep} from 'node:path'
import type Database from 'better-sqlite3'
import {exchangeSyncedSnapshot} from '../../src/main/sync/synced-exchange'
import {readSyncedPersistentPublicationSnapshot} from '../../src/main/database/synced-publication'
import {mapPublicationCatalog} from '../../src/main/sync/synced-publication-model'
import {rewriteSyncedGroupAssets,rewriteSyncedPortableHostAssets} from '../../src/shared/syncedBlockPortable'
import {withIncomingFixture,accepted,changeGroup,seedLocalDocument,randomUUID,encode,hash,runtime,allTables,
  readStrictHostDocument as readRawStrictHostDocument,request,applySyncedHostFinal,type Profile} from './synced-initial-incoming-fixture'
import {createRequest,created,applySyncedHostCommand} from './synced-publication-fixture'
import {logical,restoreInput} from './synced-host-final-fixture'

export {exchangeSyncedSnapshot,randomUUID,encode,hash,runtime,allTables,changeGroup,
  request,applySyncedHostFinal,createRequest,created,applySyncedHostCommand,logical,restoreInput}
export type Result=Awaited<ReturnType<typeof exchangeSyncedSnapshot>>
export type Completed=Extract<Result,{status:'applied'|'noop'|'deferred'}>
export type Base=Parameters<Parameters<typeof withIncomingFixture>[0]>[0]
type Options=Parameters<typeof withIncomingFixture>[1]
export function readStrictHostDocument(db:Database.Database,documentId:string) {
  const actual=readRawStrictHostDocument(db,documentId)
  assert.ok(actual,'The independent actual Main host oracle reads an existing persisted host')
  return actual
}
export function completed(value:Result,status?:Completed['status']):Completed {
  if(status)assert.equal(value.status,status)
  assert.ok(value.status==='applied'||value.status==='noop'||value.status==='deferred','An actual exchange completes with its finite settled diagnostic result')
  if(value.status!=='applied'&&value.status!=='noop'&&value.status!=='deferred')throw new Error('Expected an actual settled exchange result')
  assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.acceptedKeys)&&Object.isFrozen(value.deferred),'Exchange DTO and nested diagnostic collections are readonly')
  for(const component of value.deferred)assert.ok(Object.isFrozen(component)&&Object.isFrozen(component.keys),'Each deferred component and exact key collection is readonly')
  return value
}
export async function withExchange(run:(f:Base&{islands:string[];exchange:(profile?:Profile,operationId?:string,signal?:AbortSignal)=>Promise<Result>})=>Promise<void>,options:Options={}) {
  return withIncomingFixture(async f=>{
    const islands=[' exchange:independent:'+randomUUID(),' exchange:second:'+randomUUID(),' exchange:third:'+randomUUID()]
    // Initial SQL fixture rows are ordinary actual records; every later change uses the real Main writer.
    for(const id of islands)seedLocalDocument(f.A.db,id)
    await f.publish();accepted(await f.receive())
    const exchange=(profile=f.B,operationId:string=randomUUID(),signal?:AbortSignal)=>f.track(exchangeSyncedSnapshot(profile.db,
      {operationId,userDataRoot:profile.root,target:f.targetConfig},{...runtime,...(signal?{signal}:{})}))
    await run({...f,islands,exchange})
  },options)
}
export function hostEdit(db:Database.Database,id:string,text:string) {
  const value=request(db,[id],sides=>{const ordinary=sides[0].blocks.find(b=>b.type!=='synced-block')
    assert.ok(ordinary,'A host edit starts from a genuine ordinary physical child');ordinary.content=text})
  const ack=applySyncedHostFinal(db,value)
  assert.ok(ack.status==='applied'||ack.status==='noop','The actual Main host writer accepts the supported content edit')
  if(ack.status!=='applied'&&ack.status!=='noop')throw new Error('Expected an actual host edit ACK')
  return {input:value,ack}
}
export function hostRows(db:Database.Database,id:string) {
  return {document:db.prepare('SELECT * FROM documents WHERE id=?').get(id),blocks:db.prepare('SELECT * FROM blocks WHERE document_id=? ORDER BY sort_order').all(id),
    instances:db.prepare('SELECT * FROM synced_instances WHERE host_document_id=? ORDER BY instance_id').all(id)}
}
export function physical(db:Database.Database,id:string) {
  return {ordinary:db.prepare('SELECT id,document_id,created_at FROM blocks WHERE id=?').get(id),canonical:db.prepare('SELECT id,group_id,created_at FROM synced_group_blocks WHERE id=?').get(id),
    identity:db.prepare('SELECT * FROM block_identities WHERE id=?').get(id),routes:db.prepare('SELECT * FROM document_block_routes WHERE block_id=? ORDER BY document_path').all(id)}
}
export function localPortable(profile:Profile) {
  const snapshot=profile.db.transaction(()=>readSyncedPersistentPublicationSnapshot(profile.db))(),assets=new Map<string,Set<string>>()
  const map=(uri:string)=>{
    const local=fileURLToPath(uri),parts=relative(profile.root+'/storage/assets',local).split(sep)
    assert.equal(parts.length,4);assert.equal(parts[0],'attachments');assert.match(parts[2],/^[a-f0-9]{64}$/);assert.equal(parts[1],parts[2].slice(0,2))
    assert.equal(hash(readFileSync(local)),parts[2],'Expected portable hashes come from actual local alias bytes')
    const names=assets.get(parts[2])??new Set<string>();names.add(parts[3]);assets.set(parts[2],names)
    return 'knowbook-asset://'+parts[2]+'/'+encodeURIComponent(parts[3])
  }
  const records=mapPublicationCatalog(snapshot.records,snapshot.catalogId).map(record=>record.kind==='synced-group'?rewriteSyncedGroupAssets(record,map)
    :record.kind==='document'?rewriteSyncedPortableHostAssets(record,map):record)
  const entries=Object.fromEntries(records.map(record=>[record.kind==='databases'?'databases':record.kind==='synced-group'?'group:'+record.id:'doc:'+record.id,hash(encode(record))]).sort(([a],[b])=>a<b?-1:a>b?1:0))
  const dependencies=records.flatMap(record=>record.kind!=='document'?[]:record.content.blocks.flatMap(block=>{
    if(block.type!=='synced-block')return []
    const groupId=(JSON.parse(block.content) as {groupId:string}).groupId
    return [{documentId:record.id,instanceId:block.id,groupId,groupHash:entries['group:'+groupId]}]
  })).sort((a,b)=>a.documentId<b.documentId?-1:a.documentId>b.documentId?1:a.instanceId<b.instanceId?-1:a.instanceId>b.instanceId?1:0)
  return {entries,dependencies,records,assets,workspaceScope:snapshot.workspaceScope,recoveryEpoch:snapshot.recoveryEpoch}
}
export function remoteActual(f:Base) {
  const path='/'+f.targetConfig.directory+'/manifest.json',bytes=f.server.files.get(path)
  assert.ok(bytes,'The real sender has an actual manifest at the original same target')
  const manifest=JSON.parse(bytes.toString()) as {version:number;workspaceId:string;entries:Record<string,string>;syncedInstances:Array<{documentId:string;instanceId:string;groupId:string;groupHash:string}>}
  assert.equal(bytes.toString(),encode(manifest));assert.equal(manifest.version,5)
  const records=Object.entries(manifest.entries).map(([key,digest])=>{const raw=f.server.files.get('/'+f.targetConfig.directory+'/objects/'+digest+'.json')
    assert.ok(raw,'Every expected remote entry has its actual HTTP-published immutable object bytes');assert.equal(hash(raw),digest);const record=JSON.parse(raw.toString());assert.equal(raw.toString(),encode(record));return {key,record}})
  return {manifest,records,bytes:Buffer.from(bytes),hash:hash(bytes),etag:'"'+hash(bytes)+'"'}
}
export function converged(f:Base) {
  const remote=remoteActual(f),a=localPortable(f.A),b=localPortable(f.B)
  assert.deepEqual(a.entries,remote.manifest.entries);assert.deepEqual(b.entries,remote.manifest.entries)
  assert.deepEqual(a.dependencies,remote.manifest.syncedInstances);assert.deepEqual(b.dependencies,remote.manifest.syncedInstances)
  assert.notEqual(a.workspaceScope,b.workspaceScope,'Independent peers retain independent local workspace identities')
  return {remote,a,b}
}
export function exchangeRows(db:Database.Database) {
  const settings=db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange%' ORDER BY key").all() as Array<{key:string;value:string}>
  return {settings,operations:db.prepare("SELECT * FROM synced_operations WHERE result_json LIKE '%synced-exchange-operation%' ORDER BY client_operation_id").all()}
}
export function stateRow(db:Database.Database) {
  const rows=db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange.v1.%' ORDER BY key").all() as Array<{key:string;value:string}>
  assert.equal(rows.length,1,'A settled exchange has one strict per-target state, not an arbitrary latest attempt')
  return {...rows[0],state:JSON.parse(rows[0].value) as {baseline:Array<{key:string;localHash:string|null;remoteHash:string;commonHash:string|null;acceptedOperationId:string}>;deferred:Array<{keys:string[]}>}}
}
export function lateReceipt(db:Database.Database,operationId:string,incoming:{documentId:string;content:string}) {
  const seen:Array<{documents:number;groups:number;members:number;incomingMatches:number}>=[]
  db.function('exchange_scalar_witness',(documents:number,groups:number,members:number,incomingMatches:number)=>{seen.push({documents,groups,members,incomingMatches});return 0})
  const literal=(v:string)=>"'"+v.replaceAll("'","''")+"'"
  db.exec("CREATE TRIGGER exchange_late_receipt BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id="+literal(operationId)+" BEGIN SELECT exchange_scalar_witness((SELECT count(*) FROM documents),(SELECT count(*) FROM synced_groups),(SELECT count(*) FROM synced_group_exposure_members),(SELECT count(*) FROM blocks WHERE document_id="+literal(incoming.documentId)+" AND content="+literal(incoming.content)+")); SELECT RAISE(ABORT,'exchange exact late receipt fixture'); END")
  return {seen,remove:()=>db.exec('DROP TRIGGER exchange_late_receipt')}
}
