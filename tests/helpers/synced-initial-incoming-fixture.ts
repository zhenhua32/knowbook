import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { KnowbookStore } from '../../src/main/database/store'
import type { DocumentBlockDraft } from '../../src/shared/contracts'
import { appSchema } from '../../src/main/database/schema'
import { AttachmentStore } from '../../src/main/attachments'
import { readStrictHostDocument } from '../../src/main/database/synced-host-document-read'
import { assertSyncedLifecycleSchema } from '../../src/main/database/synced-lifecycle-schema'
import { captureSyncedGroupBindings } from '../../src/main/database/synced-block-links'
import { updateSyncedBlockGroup } from '../../src/main/database/synced-blocks-content'
import { getSyncedOperation } from '../../src/main/database/synced-blocks-content'
import { getSyncedGroupSnapshotsWithLinkSources, getSyncedOperationWithLinkSource } from '../../src/main/database/synced-binding-sources'
import { parseDatabaseViewPayload, serializeDatabaseViewPayload } from '../../src/shared/databaseViewBlock'
import { createDefaultDatabaseViewConfig } from '../../src/shared/database-workspace'
import { canonicalSyncedPortableJson } from '../../src/shared/syncedBlockPortable'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../../src/shared/webdav-sync'
import { normalizeWebDavConfig, WebDavClient } from '../../src/main/sync/webdav-client'
import { receiveInitialSyncedSnapshot, prepareInitialSyncedPublication, publishInitialSyncedPublication, disposePreparedSyncedPublication,
  readSyncedPublishedSnapshot, readSyncedPublishedSnapshotFacts, SyncedPublicationError } from '../../src/main/sync/synced-publication'
import { createPublicationHttpServer, publicationGate, type PublicationHttpRequest } from './synced-publication-http-fixture'
import { createRequest, created, applySyncedHostCommand, snapshot, request, freshBlock, applySyncedHostFinal,
  createRestoreInput, restoreSyncedHostOperation, allTables, totalChanges } from './synced-publication-fixture'

// The imports below are relative to tests/helpers in the eventual formal tree.
export { randomUUID, Database, readStrictHostDocument, assertSyncedLifecycleSchema, parseDatabaseViewPayload,
  receiveInitialSyncedSnapshot, SyncedPublicationError, getSyncedOperation, getSyncedGroupSnapshotsWithLinkSources, getSyncedOperationWithLinkSource,
  snapshot, allTables, totalChanges, createRestoreInput, restoreSyncedHostOperation, serializeDatabaseViewPayload,
  createDefaultDatabaseViewConfig, request, freshBlock, applySyncedHostFinal }
export const encode = canonicalSyncedPortableJson
export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const runtime = { password: 'app-secret' }
export const missingId = ' incoming:missing stable block '
const localBirth = '2018-01-02T03:04:05+08:00'
export type Accepted = Extract<Awaited<ReturnType<typeof receiveInitialSyncedSnapshot>>, { status: 'applied' | 'noop' }>
export type Profile = { root: string; file: string; db: Database.Database; defaultId: string; defaultBirth: string }

function bootstrap(root: string): Profile {
  const file = join(root, 'storage', 'knowbook.db'); mkdirSync(dirname(file), { recursive: true })
  const initial = new Database(file), defaultId = randomUUID(), time = new Date().toISOString()
  try {
    initial.exec(appSchema)
    initial.prepare('INSERT INTO databases(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)').run(defaultId, 'Default', 'Default database', localBirth, time)
    initial.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('database.defaultId', defaultId, time)
    initial.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('workspace.initialized', 'true', time)
  } finally { initial.close() }
  const store = new KnowbookStore(file); store.destroy() // Real complete migrations, no starter seed, no lazy admission repair.
  const db = new Database(file); db.pragma('foreign_keys=ON')
  const result = { root, file, db, defaultId, defaultBirth: localBirth }; pristine(result); return result
}
export function catalogCounts(db: Database.Database) {
  const names = ['databases', 'document_database_columns', 'database_saved_views', 'database_entities', 'database_entity_values', 'document_database_values']
  return Object.fromEntries(names.map(name => [name, (db.prepare('SELECT count(*) AS n FROM '+name).get() as { n: number }).n]))
}
export function pristine(profile: Profile) {
  assert.deepEqual(catalogCounts(profile.db), { databases: 1, document_database_columns: 0, database_saved_views: 0, database_entities: 0, database_entity_values: 0, document_database_values: 0 })
  assert.equal((profile.db.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }).n, 0)
  assert.equal((profile.db.prepare('SELECT count(*) AS n FROM synced_groups').get() as { n: number }).n, 0)
  assert.deepEqual(profile.db.prepare('SELECT id,name,description,created_at FROM databases').get(), { id: profile.defaultId, name: 'Default', description: 'Default database', created_at: profile.defaultBirth })
  assertSyncedLifecycleSchema(profile.db)
}
type Options = { assets?: boolean; catalog?: boolean; orphan?: boolean; missing?: boolean; sameUrl?: boolean; notes?: boolean; caseTitles?:'separate-parents'|'unicode' }
type Server = Awaited<ReturnType<typeof createPublicationHttpServer>>
export async function withIncomingFixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: Options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'knowbook-incoming-')), server = await createPublicationHttpServer()
  const connections: Database.Database[] = [], jobs = new Set<Promise<unknown>>(), releases: Array<() => void> = []
  const track = <T>(job: Promise<T>) => { jobs.add(job); void job.catch(() => {}); return job }
  try {
    const f = await setup(folder, server, connections, track, releases, options)
    await run(f); server.assertNoHookErrors()
  } finally {
    server.setHook(undefined); releases.forEach(fn=>fn()); await Promise.allSettled([...jobs]); await server.close()
    for(const db of connections)if(db.open)db.close()
    assert.equal(dirname(resolve(folder)), resolve(tmpdir())); assert.ok(basename(folder).startsWith('knowbook-incoming-'), 'Only the isolated incoming fixture is removed')
    rmSync(folder, { recursive: true, force: true })
  }
}
async function setup(folder: string, server: Server, connections: Database.Database[], track: <T>(job: Promise<T>)=>Promise<T>, releases: Array<()=>void>, options: Options) {
  const A=bootstrap(join(folder,'source-A')), B=bootstrap(join(folder,'receiver-B')); connections.push(A.db,B.db)
  A.db.close()
  const store=new KnowbookStore(A.file), host=store.createDocument(null), target=store.createDocument(null), other=store.createDocument(null), child=store.createDocument(host)
  const sourceBlock=randomUUID(), hostView=randomUUID(), groupView=randomUUID(), customId=randomUUID(), customColumn=randomUUID(), catalogColumn=randomUUID()
  const assets=new AttachmentStore(join(A.root,'storage','assets')), aliases: Array<{name:string;bytes:Buffer;url:string}>=[]
  if(options.assets) {
    const bytes=Buffer.from('incoming actual same hash alias bytes')
    for(const name of ['first incoming.png','second incoming.png']) {const [item]=await assets.import([{name,bytes}]);aliases.push({name:item.name,bytes,url:item.url})}
  }
  const config=createDefaultDatabaseViewConfig();config.query='opaque '+A.defaultId+' file:///not-an-asset'
  const assetText=aliases.map(a=>' ![actual](<'+a.url+'>)').join('')
  const selfText=' [self](#^'+encodeURIComponent(sourceBlock)+')'
  const noteText=options.notes&&aliases.length?' [^outer]\n\n[actual-ref]: <'+aliases[0].url+'>\n\n[^outer]: ![nested][actual-ref] [^inner]\n\n[^inner]: ![deep](<'+aliases[1].url+'>)':''
  const text='Canonical [old](Target.md)'+selfText+(options.missing?' [missing](#^'+encodeURIComponent(missingId)+') [missing document](Absent.md) [missing heading](Target.md#unwritten)':'')+assetText+noteText
  const block=(id:string,content:string,type:DocumentBlockDraft['type']='paragraph'):DocumentBlockDraft=>({id,type,content,checked:false,depth:0,parentBlockId:null,tags:[]})
  try {
    const views=options.catalog?[block(groupView,serializeDatabaseViewPayload({version:1,databaseId:A.defaultId,viewId:null,config}),'database-view')]:[]
    store.updateDocument(host,{title:'Source',summary:'Original source summary',blocks:[block(sourceBlock,text),...views,...(options.missing?[block(missingId,'Real historical missing target')]:[])]})
    store.updateDocument(target,{title:options.caseTitles==='separate-parents'?'Shared':options.caseTitles==='unicode'?'Ä':'Target',summary:'Original target',blocks:[block(randomUUID(),'Target body')]})
    const hostViews=options.catalog?[block(hostView,serializeDatabaseViewPayload({version:1,databaseId:A.defaultId,viewId:null,config}),'database-view')]:[]
    store.updateDocument(other,{title:options.caseTitles==='unicode'?'ä':'Other',summary:'Other target',blocks:[block(randomUUID(),'Other body [back](Source.md)'),...hostViews]})
    store.updateDocument(child,{title:options.caseTitles==='separate-parents'?'Shared':'Nested',summary:'Child stats',blocks:[block(randomUUID(),'A nested child')]})
    if(options.missing) {
      const current=store.getDocumentDetail(host);assert.ok(current,'The real missing-target fixture has its actual source host')
      store.updateDocument(host,{title:current.title,summary:current.summary,blocks:current.blocks.filter(b=>b.id!==missingId)})
    }
  } finally {store.destroy()}
  A.db=new Database(A.file);A.db.pragma('foreign_keys=ON');connections.push(A.db)
  if(options.catalog)seedCatalog(A.db,A.defaultId,customId,customColumn,catalogColumn,host)
  const command=createRequest(A.db,{documentId:host,selectedRootIds:[sourceBlock,...(options.catalog?[groupView]:[])]}), ack=created(applySyncedHostCommand(A.db,command))
  if(options.sameUrl) {
    const before=snapshot(A.db,ack.createdLifecycle.groupId)
    A.db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed','Renamed',target)
    A.db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Target','Target',other)
    const blocks=before.blocks.map(({createdAt:_birth,...b})=>b.id===sourceBlock?{...b,content:'before [old](Target.md) between [new](Target.md)'+selfText+assetText+noteText}:b)
    const destinations=captureSyncedGroupBindings(A.db,before.origin,blocks.map(b=>({...b,createdAt:before.blocks.find(old=>old.id===b.id)!.createdAt})))
    const key=({blockId,from,to,raw,syntax}:typeof destinations[number])=>({blockId,from,to,raw,syntax}), old=before.bindings.find(b=>b.raw==='Target.md')!
    const first=destinations.find(b=>b.raw==='Target.md')!, instance=before.instances[0]
    const claims=destinations.map(d=>d===first?{kind:'continue' as const,source:key(old),destination:key(d)}:{kind:'new' as const,destination:key(d)}).reverse()
    assert.equal(updateSyncedBlockGroup(A.db,{clientOperationId:randomUUID(),groupId:before.groupId,expectedRevision:before.revision,expectedTopologyRevision:before.topologyRevision,
      expectedInstanceBinding:{instanceId:instance.instanceId,hostDocumentId:instance.hostDocumentId,bindingVersion:instance.bindingVersion},blocks,bindingClaims:claims}).status,'saved')
    const pair=snapshot(A.db,before.groupId).bindings.filter(b=>b.raw==='Target.md').sort((a,b)=>a.from-b.from)
    assert.deepEqual(pair.map(b=>b.target),[{kind:'document',id:target,state:'live'},{kind:'document',id:other,state:'live'}])
  }
  let orphanId:string|null=null
  if(options.orphan) {
    const id=(A.db.prepare("SELECT id FROM blocks WHERE document_id=? AND type='paragraph' ORDER BY sort_order LIMIT 1").get(target) as {id:string}).id
    const orphan=created(applySyncedHostCommand(A.db,createRequest(A.db,{documentId:target,selectedRootIds:[id]})));orphanId=orphan.createdLifecycle.groupId
    const removal=request(A.db,[target],after=>{after[0].blocks=[freshBlock(randomUUID(),'Explicit paragraph after orphaning')]})
    assert.equal(applySyncedHostFinal(A.db,removal).status,'applied');assert.equal(snapshot(A.db,orphanId).instances.length,0)
  }
  const targetConfig=normalizeWebDavConfig({...DEFAULT_WEBDAV_SYNC_CONFIG,enabled:true,url:server.url,username:'test',directory:'Incoming',allowInsecureHttp:true})
  const connect=(profile=B,readonly=false)=>{const db=new Database(profile.file,{readonly,fileMustExist:true});db.pragma('foreign_keys=ON');connections.push(db);return db}
  const input=(operationId:string=randomUUID(),profile=B,target=targetConfig)=>({operationId,userDataRoot:profile.root,target})
  const send=async(profile:Profile,target=targetConfig)=>{
    const result=await track(prepareInitialSyncedPublication(profile.db,{attemptId:randomUUID(),userDataRoot:profile.root,target}))
    assert.ok(result.status==='prepared','The actual profile produces a genuine complete publication')
    if(result.status!=='prepared')throw new Error('Actual publication required')
    try{assert.equal((await track(publishInitialSyncedPublication(profile.db,result.prepared,runtime))).status,'confirmed')}finally{disposePreparedSyncedPublication(result.prepared)}
  }
  const readRemote=async(target=targetConfig)=>{
    const value=await track(readSyncedPublishedSnapshot(new WebDavClient(target,runtime.password)))
    assert.ok(value.status==='ready','The real HTTP snapshot passes the actual strict initial reader')
    if(value.status!=='ready')throw new Error('Actual remote snapshot required')
    const facts=readSyncedPublishedSnapshotFacts(value.plan);assert.ok(facts,'The real read plan has readonly diagnostic facts');return facts
  }
  return {folder,A,B,host,target,other,child,sourceBlock,groupView,hostView,customId,customColumn,catalogColumn,config,ack,command,orphanId,aliases,assets,
    server,targetConfig,track,input,connect,send,readRemote,
    receive:(operationId:string=randomUUID(),signal?:AbortSignal)=>track(receiveInitialSyncedSnapshot(B.db,input(operationId),{...runtime,...(signal?{signal}:{})})),
    publish:()=>send(A),
    reopen:()=>{if(B.db.open)B.db.close();B.db=connect();return B.db},
    gate:(matches:(request:PublicationHttpRequest)=>boolean)=>{
      const entered=publicationGate(),release=publicationGate();releases.push(entered.release,release.release);let used=false
      server.setHook(async req=>{if(!used&&matches(req)){used=true;entered.release();await release.promise}})
      return {release:release.release,wait:(job:Promise<unknown>)=>Promise.race([entered.promise,job.then(()=>{throw new Error('Actual HTTP job completed before its required gate')})])}
    },
    cloneBeforePublication:async()=>{const root=join(folder,'existing-observer-'+randomUUID()),file=join(root,'storage','knowbook.db');mkdirSync(dirname(file),{recursive:true});await A.db.backup(file);const db=new Database(file);db.pragma('foreign_keys=ON');connections.push(db);return {root,file,db,defaultId:A.defaultId,defaultBirth:A.defaultBirth}},
    newPristine:(label='extra-'+randomUUID())=>{const profile=bootstrap(join(folder,label));connections.push(profile.db);return profile}
  }
}
function seedCatalog(db:Database.Database,defaultId:string,customId:string,customColumn:string,catalogColumn:string,host:string) {
  const born='2019-01-02T03:04:05+08:00',now=new Date().toISOString()
  db.prepare('UPDATE databases SET name=?,description=? WHERE id=?').run('Source default metadata','Source catalog description',defaultId)
  db.prepare('INSERT INTO databases(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)').run(customId,'Custom data','Opaque '+defaultId,born,now)
  const column=db.prepare('INSERT INTO document_database_columns(id,database_id,name,type,options_json,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  column.run(customColumn,customId,'Custom field','text','[]',0,born,now);column.run(catalogColumn,defaultId,'Catalog field','text','[]',0,born,now)
  const entity=randomUUID();db.prepare('INSERT INTO database_entities(id,database_id,title,document_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(entity,customId,'Orphan custom entity',null,born,now)
  const view=createDefaultDatabaseViewConfig();view.query='Opaque saved-view text '+defaultId+' file:///not-an-asset'
  db.prepare('INSERT INTO database_saved_views(id,database_id,name,filter_query,filter_scope,sort_mode,view_mode,config_json,config_version,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(),defaultId,'Actual source saved view','','','updated-desc','table',JSON.stringify(view),1,0,born,now)
  db.prepare('INSERT INTO database_entity_values(entity_id,column_id,value_text,updated_at) VALUES(?,?,?,?)').run(entity,customColumn,'Value '+defaultId,now)
  db.prepare('INSERT INTO document_database_values(document_id,column_id,value_text,updated_at,entity_id) VALUES(?,?,?,?,?)').run(host,catalogColumn,'Catalog value',now,null)
}
export function accepted(value:Awaited<ReturnType<typeof receiveInitialSyncedSnapshot>>,status:'applied'|'noop'='applied'):Accepted {
  assert.equal(value.status,status);assert.ok(value.status==='applied'||value.status==='noop','A genuine receiver commits its complete result')
  if(value.status!=='applied'&&value.status!=='noop')throw new Error('Actual committed incoming result required')
  assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.counts),'Committed incoming DTO and counts are readonly');return value
}
export function conflict(value:Awaited<ReturnType<typeof receiveInitialSyncedSnapshot>>,reason?:string) {
  assert.ok(value.status==='conflict','An unsupported semantic install returns an explicit component conflict')
  if(value.status!=='conflict')throw new Error('Actual component conflict required')
  assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.components)&&value.components.every(c=>Object.isFrozen(c)&&Object.isFrozen(c.keys)),'Conflict components and keys are readonly')
  assert.ok(value.components.length>0&&value.components.every(c=>c.keys.length>0&&c.keys.every(k=>k==='databases'||k.startsWith('doc:')||k.startsWith('group:'))),'Conflicts contain only original remote record keys')
  if(reason)assert.ok(value.components.some(c=>c.reason===reason),'The expected finite component reason is present');return value
}
export async function rejected(run:()=>unknown|Promise<unknown>,code:string) {
  let error:unknown;try{await run()}catch(cause){error=cause}
  assert.ok(error instanceof SyncedPublicationError,'The real boundary rejects with its finite Main error');assert.equal(error.code,code);return error
}
export function incomingRows(db:Database.Database) {
  return {operations:db.prepare("SELECT * FROM synced_operations WHERE result_json LIKE '%synced-initial-incoming-operation%' ORDER BY client_operation_id").all(),
    baselines:db.prepare("SELECT * FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.initial.v1.%' ORDER BY key").all()}
}
export function knowledge(db:Database.Database) {
  const {synced_operations:_op,synced_exposure_attempts:_attempt,synced_group_exposure_members:_member,synced_group_lifecycle:_life,...rest}=allTables(db)
  return rest
}
export function readonlyRequests(requests:PublicationHttpRequest[]) {
  const metadata=Buffer.from('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>')
  assert.ok(requests.every(r=>r.destination===undefined&&r.overwrite===undefined&&((r.method==='GET'||r.method==='HEAD')?r.bytes.length===0:r.method==='PROPFIND'&&r.path.endsWith('/manifest.json')&&r.bytes.equals(metadata))),'The receiver emits only readonly metadata and exact content reads')
}
export const assetPath=(profile:Profile,alias:{name:string;bytes:Buffer})=>join(profile.root,'storage','assets','attachments',hash(alias.bytes).slice(0,2),hash(alias.bytes),alias.name)
export function fileInventory(folder:string):Array<{path:string;bytes:number;sha256:string}> {
  function walk(root:string,prefix=''):Array<{path:string;bytes:number;sha256:string}> {return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{const path=join(root,entry.name),name=prefix+entry.name;if(entry.isDirectory())return walk(path,name+'/');const bytes=readFileSync(path);return [{path:name,bytes:bytes.length,sha256:hash(bytes)}]})}
  try{return walk(folder).sort((a,b)=>a.path.localeCompare(b.path))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
}
export function mutateRemote(server:Server,directory:string,key:string,change:(record:Record<string,any>)=>void) {
  const manifestPath='/'+directory+'/manifest.json',original=server.files.get(manifestPath);assert.ok(original,'A negative fixture starts from an actual sender manifest')
  const manifest=JSON.parse(original.toString()),bytes=server.files.get('/'+directory+'/objects/'+manifest.entries[key]+'.json');assert.ok(bytes,'The original actual sender object exists')
  const record=JSON.parse(bytes.toString());change(record);const next=Buffer.from(encode(record)),digest=hash(next);server.files.set('/'+directory+'/objects/'+digest+'.json',next);manifest.entries[key]=digest
  for(const instance of manifest.syncedInstances)if(key==='group:'+instance.groupId)instance.groupHash=digest
  server.files.set(manifestPath,Buffer.from(encode(manifest)))
}
export function lateFailure(db:Database.Database,operationId:string,stage:'instance'|'reservation'|'links'|'receipt'|'baseline') {
  const seen:Array<{documents:number;groups:number;instances:number}>=[]
  db.function('incoming_scalar_fixture',(documents:number,groups:number,instances:number)=>{seen.push({documents,groups,instances});return 0})
  const target=stage==='instance'?'BEFORE INSERT ON synced_instances':stage==='reservation'?"BEFORE INSERT ON block_identities WHEN NEW.last_owner_kind='reserved'":stage==='links'?'BEFORE INSERT ON links':stage==='receipt'?"BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id='"+operationId+"'":"BEFORE INSERT ON app_settings WHEN NEW.key LIKE 'sync.webdav.protocol5.initial.v1.%'"
  db.exec('CREATE TRIGGER incoming_late_failure '+target+" BEGIN SELECT incoming_scalar_fixture((SELECT count(*) FROM documents),(SELECT count(*) FROM synced_groups),(SELECT count(*) FROM synced_instances)); SELECT RAISE(ABORT,'incoming real late SQL fixture'); END;")
  return {seen,remove:()=>db.exec('DROP TRIGGER incoming_late_failure')}
}
export function changeGroup(db:Database.Database,groupId:string,change:(blocks:ReturnType<typeof snapshot>['blocks'])=>void) {
  const before=snapshot(db,groupId),blocks=structuredClone(before.blocks);change(blocks);const instance=before.instances[0]
  assert.ok(instance,'A real source edit is authorized by its actual current instance')
  const result=updateSyncedBlockGroup(db,{clientOperationId:randomUUID(),groupId,expectedRevision:before.revision,expectedTopologyRevision:before.topologyRevision,
    expectedInstanceBinding:{instanceId:instance.instanceId,hostDocumentId:instance.hostDocumentId,bindingVersion:instance.bindingVersion},blocks:blocks.map(({createdAt:_born,...b})=>b)})
  assert.equal(result.status,'saved');return result
}
export function seedLocalDocument(db:Database.Database,id:string,blockId=randomUUID()) {
  const time='2016-01-02T00:00:00Z',title='Local '+randomUUID()
  db.prepare('INSERT INTO documents(id,title,slug,path,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,title,'local-'+randomUUID(),title,'Local fixture',time,time)
  db.prepare("INSERT INTO blocks(id,document_id,sort_order,type,content,checked,depth,tags_json,created_at,updated_at) VALUES(?,?,0,'paragraph','Independent local content',0,0,'[]',?,?)").run(blockId,id,time,time)
}
