import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { removeSchema27ForLegacyFixture } from './helpers/schema27-legacy-fixture'
import { withIncomingFixture, accepted, conflict, rejected, allTables, randomUUID, encode, hash, runtime, Database,
  receiveInitialSyncedSnapshot, incomingRows, readonlyRequests, assetPath, fileInventory, lateFailure, mutateRemote,
  changeGroup, serializeDatabaseViewPayload, createDefaultDatabaseViewConfig, snapshot, missingId, seedLocalDocument, readStrictHostDocument,
  createRestoreInput, restoreSyncedHostOperation } from './helpers/synced-initial-incoming-fixture'

type Fixture=Parameters<Parameters<typeof withIncomingFixture>[0]>[0]
function obstructOwnStageCleanup(f:Fixture,operationId:string) {
  const root=join(f.B.root,'storage','synced-incoming-v1',operationId),entries=readdirSync(root,{withFileTypes:true})
  assert.equal(entries.length,1);assert.ok(entries[0].isDirectory(),'The real gated job owns exactly one actual stage directory')
  assert.match(entries[0].name,/^[0-9a-f-]{36}$/i)
  const stage=join(root,entries[0].name),saved=stage+'.preserved',empty=join(f.folder,'owned-cleanup-target-'+randomUUID())
  mkdirSync(empty);renameSync(stage,saved)
  try{symlinkSync(empty,stage,'junction')}catch(error){renameSync(saved,stage);throw error}
  return {stage,restore:()=>{unlinkSync(stage);renameSync(saved,stage)}}
}
function realMoveHistory(f:Fixture,options:{source?:string;reference?:boolean;erase?:boolean;advance?:boolean}={}) {
  const source=options.source??randomUUID(),peer=randomUUID(),block=randomUUID();seedLocalDocument(f.B.db,source,block);seedLocalDocument(f.B.db,peer);f.B.db.close()
  const store=new KnowbookStore(f.B.file);let operation='',reference:string|null=null
  try {
    const from=store.getDocumentDetail(source)!,to=store.getDocumentDetail(peer)!
    if(options.reference) {reference=store.createDocument(null);const ref=store.getDocumentDetail(reference)!;store.updateDocument(reference,{title:ref.title,summary:ref.summary,blocks:[{id:randomUUID(),type:'paragraph',content:'[moved](<'+encodeURI(from.path)+'.md#^'+encodeURIComponent(block)+'>)',checked:false,depth:0,tags:[]}]})}
    operation=store.moveDocumentBlocks({fromDocumentId:source,toDocumentId:peer,blockIds:[block],expectedFromUpdatedAt:from.updatedAt,expectedToUpdatedAt:to.updatedAt}).operationId
    if(options.advance) {const current=store.getDocumentDetail(peer)!;store.updateDocument(peer,{title:current.title,summary:'A genuinely later local revision',blocks:current.blocks})}
  } finally {store.destroy()}
  f.reopen();const original=f.B.db.prepare('SELECT * FROM document_block_moves WHERE id=?').get(operation) as {expected_versions_json:string;before_json:string;after_json:string}
  assert.ok(original,'Only the real ordinary move writer produces the positive history row')
  if(options.erase!==false) {
    const ids=[source,peer,...(reference?[reference]:[])],placeholders=ids.map(()=>'?').join(',')
    // Negative setup isolates the genuine immutable move row from secondary
    // recovery sources. The receive consumer must never clear these domains.
    f.B.db.prepare('DELETE FROM documents WHERE id IN ('+placeholders+')').run(...ids)
    f.B.db.prepare('DELETE FROM document_history WHERE document_id IN ('+placeholders+')').run(...ids)
    f.B.db.prepare('DELETE FROM document_trash WHERE id IN ('+placeholders+')').run(...ids)
    assert.deepEqual(f.B.db.prepare('SELECT * FROM document_block_moves WHERE id=?').get(operation),original)
  }
  return {source,peer,reference,operation,original}
}

test('a customized default name is a catalog conflict before any incoming knowledge or asset publication',async()=>withIncomingFixture(async f=>{
  f.B.db.prepare('UPDATE databases SET name=? WHERE id=?').run('My default',f.B.defaultId);await f.publish()
  const before=allTables(f.B.db),files=fileInventory(join(f.B.root,'storage','assets'));conflict(await f.receive(),'catalog')
  assert.deepEqual(allTables(f.B.db),before);assert.deepEqual(fileInventory(join(f.B.root,'storage','assets')),files)
},{assets:true}))

test('a customized default description is preserved on catalog conflict without trim or repair',async()=>withIncomingFixture(async f=>{
  f.B.db.prepare('UPDATE databases SET description=? WHERE id=?').run('Default database ',f.B.defaultId);await f.publish();const before=allTables(f.B.db)
  conflict(await f.receive(),'catalog');assert.deepEqual(allTables(f.B.db),before)
}))

test('an additional valid custom catalog definition prevents fresh installation atomically',async()=>withIncomingFixture(async f=>{
  const time=new Date().toISOString();f.B.db.prepare('INSERT INTO databases(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(),'Local user data','Keep',time,time)
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'catalog');assert.deepEqual(allTables(f.B.db),before)
}))

test('a legal local column and entity catalog graph is never cleared to make a target pristine',async()=>withIncomingFixture(async f=>{
  const time=new Date().toISOString(),column=randomUUID(),entity=randomUUID()
  f.B.db.prepare('INSERT INTO document_database_columns(id,database_id,name,type,options_json,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(column,f.B.defaultId,'Local field','text','[]',0,time,time)
  f.B.db.prepare('INSERT INTO database_entities(id,database_id,title,document_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(entity,f.B.defaultId,'Local entity',null,time,time)
  f.B.db.prepare('INSERT INTO database_entity_values(entity_id,column_id,value_text,updated_at) VALUES(?,?,?,?)').run(entity,column,'Keep value',time)
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'catalog');assert.deepEqual(allTables(f.B.db),before)
}))

test('a canonical-only authored missing database source equal to the receiver default ID conflicts before localization',async()=>withIncomingFixture(async f=>{
  changeGroup(f.A.db,f.ack.createdLifecycle.groupId,blocks=>{const view=blocks.find(b=>b.id===f.groupView)!;view.content=serializeDatabaseViewPayload({version:1,databaseId:f.B.defaultId,viewId:null,config:createDefaultDatabaseViewConfig()})})
  await f.publish();const before=allTables(f.B.db),files=fileInventory(join(f.B.root,'storage','assets'))
  conflict(await f.receive(),'catalog');assert.deepEqual(allTables(f.B.db),before);assert.deepEqual(fileInventory(join(f.B.root,'storage','assets')),files)
},{catalog:true,assets:true}))

test('a genuine source custom database definition colliding with the receiver default ID is an early catalog conflict',async()=>withIncomingFixture(async f=>{
  const time=new Date().toISOString();f.A.db.prepare('INSERT INTO databases(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)').run(f.B.defaultId,'Actual source custom','No remapping',time,time)
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'catalog');assert.deepEqual(allTables(f.B.db),before)
},{catalog:true}))

test('an independent local live document is a whole-batch non-initial conflict with no partial install',async()=>withIncomingFixture(async f=>{
  seedLocalDocument(f.B.db,randomUUID());await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'non-initial-target');assert.deepEqual(allTables(f.B.db),before)
}))

test('mostly equal accepted records plus a real changed source group cannot become an unimplemented replacement',async()=>withIncomingFixture(async f=>{
  await f.publish();accepted(await f.receive());changeGroup(f.A.db,f.ack.createdLifecycle.groupId,blocks=>{blocks[0].content+=' real next canonical edit'})
  const target={...f.targetConfig,directory:'Changed-source'};await f.send(f.A,target)
  const beforeGroup=snapshot(f.B.db,f.ack.createdLifecycle.groupId),beforeIncoming=incomingRows(f.B.db)
  conflict(await f.track(receiveInitialSyncedSnapshot(f.B.db,f.input(randomUUID(),f.B,target),runtime)))
  assert.deepEqual(snapshot(f.B.db,f.ack.createdLifecycle.groupId),beforeGroup);assert.deepEqual(incomingRows(f.B.db),beforeIncoming)
}))

test('an incoming canonical ID retained under a foreign document cannot be restored or reowned by matching text',async()=>withIncomingFixture(async f=>{
  f.B.db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'document',?,'retained',?)").run(f.sourceBlock,'Former foreign document','2012-01-01T00:00:00Z')
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive());assert.deepEqual(allTables(f.B.db),before)
}))

test('a retained canonical identity with unknown birth cannot borrow the incoming wire timestamp',async()=>withIncomingFixture(async f=>{
  f.B.db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'group',?,'retained',NULL)").run(f.sourceBlock,f.ack.createdLifecycle.groupId)
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'unknown-birth');assert.deepEqual(allTables(f.B.db),before)
}))

test('a known same-group retained birth mismatch cannot be overwritten on first introduction',async()=>withIncomingFixture(async f=>{
  f.B.db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'group',?,'retained',?)").run(f.sourceBlock,f.ack.createdLifecycle.groupId,'2009-01-01T00:00:00Z')
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'birth-mismatch');assert.deepEqual(allTables(f.B.db),before)
}))

test('a reserved missing identity cannot be promoted to an incoming physical canonical block',async()=>withIncomingFixture(async f=>{
  f.B.db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'reserved',?,'retained',NULL)").run(f.sourceBlock,'independent source reservation')
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'occupied-identity');assert.deepEqual(allTables(f.B.db),before)
}))

test('a remote missing block target cannot steal an unrelated local retained target even if its hint names a source document',async()=>withIncomingFixture(async f=>{
  f.B.db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'document',?,'retained',?)").run(missingId,'Old independent owner','2011-01-01T00:00:00Z')
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'external-target');assert.deepEqual(allTables(f.B.db),before)
},{missing:true}))

test('an existing foreign reservation cannot be accepted by recognizing only a reservation owner string',async()=>withIncomingFixture(async f=>{
  f.B.db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'reserved',?,'retained',NULL)").run(missingId,'sync5:initial-missing-block:v1:forged:foreign')
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'external-target');assert.deepEqual(allTables(f.B.db),before)
},{missing:true}))

test('a real deleted local document recovery side prevents reusing that incoming document ID as a fresh host',async()=>withIncomingFixture(async f=>{
  seedLocalDocument(f.B.db,f.host);f.B.db.close();const store=new KnowbookStore(f.B.file);try{store.deleteDocument(f.host)}finally{store.destroy()};f.reopen()
  assert.equal(f.B.db.prepare('SELECT id FROM documents WHERE id=?').get(f.host),undefined)
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'history');assert.deepEqual(allTables(f.B.db),before)
}))

test('a source metadata edit committed before local capture returns conflict while preserving the independent edit',async()=>withIncomingFixture(async f=>{
  await f.publish();const gate=f.gate(r=>r.method==='GET'&&r.path.includes('/objects/')),job=f.receive()
  try{await gate.wait(job);const other=f.connect();seedLocalDocument(other,randomUUID());const before=allTables(other);gate.release();conflict(await job,'non-initial-target');assert.deepEqual(allTables(other),before)}finally{gate.release();await Promise.allSettled([job])}
}))

test('a local catalog change after the real install capture makes the plan stale instead of overwriting the local edit',async()=>withIncomingFixture(async f=>{
  await f.publish();let gets=0;const gate=f.gate(r=>r.method==='GET'&&r.path==='/Incoming/manifest.json'&&++gets===2),job=f.receive()
  try{await gate.wait(job);const other=f.connect();other.prepare('UPDATE databases SET description=? WHERE id=?').run('Concurrent local description',f.B.defaultId);const before=allTables(other);gate.release();const result=await job;assert.deepEqual(result,{status:'stale',side:'local'});assert.ok(Object.isFrozen(result),'The actual stale DTO is immutable');assert.deepEqual(allTables(other),before)}finally{gate.release();await Promise.allSettled([job])}
},{assets:true}))

test('the final exact manifest version changing after object reads is remote stale with no installed knowledge',async()=>withIncomingFixture(async f=>{
  await f.publish();let gets=0;const gate=f.gate(r=>r.method==='GET'&&r.path==='/Incoming/manifest.json'&&++gets===2),job=f.receive()
  try{await gate.wait(job);const bytes=f.server.files.get('/Incoming/manifest.json')!;f.server.files.set('/Incoming/manifest.json',Buffer.concat([bytes,Buffer.from(' ')]));const before=allTables(f.B.db);gate.release();assert.deepEqual(await job,{status:'stale',side:'remote'});assert.deepEqual(allTables(f.B.db),before)}finally{gate.release();await Promise.allSettled([job])}
}))

test('a successful concurrent receiver keeps shared published aliases after the older captured job becomes locally stale',async()=>withIncomingFixture(async f=>{
  await f.publish();let gets=0;const gate=f.gate(r=>r.method==='GET'&&r.path==='/Incoming/manifest.json'&&++gets===2),first=f.receive()
  try{await gate.wait(first);const second=f.track(receiveInitialSyncedSnapshot(f.connect(),f.input(),runtime));accepted(await second);gate.release();assert.deepEqual(await first,{status:'stale',side:'local'});for(const alias of f.aliases)assert.deepEqual(readFileSync(assetPath(f.B,alias)),alias.bytes)}finally{gate.release();await Promise.allSettled([first])}
},{assets:true}))

test('an alias tampered during the final manifest await fails the final synchronous asset evidence check',async()=>withIncomingFixture(async f=>{
  await f.publish();let gets=0;const gate=f.gate(r=>r.method==='GET'&&r.path==='/Incoming/manifest.json'&&++gets===2),job=f.receive()
  try{await gate.wait(job);writeFileSync(assetPath(f.B,f.aliases[0]),'External corruption after original publish');const before=allTables(f.B.db);gate.release();await rejected(()=>job,'asset');assert.deepEqual(allTables(f.B.db),before)}finally{gate.release();await Promise.allSettled([job])}
},{assets:true}))

test('the original schema27 immutable trigger is required before any receiver HTTP',async()=>withIncomingFixture(async f=>{
  await f.publish();const row=f.B.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_synced_exposure_attempt_delete'").get() as {sql:string}
  f.B.db.exec('DROP TRIGGER trg_synced_exposure_attempt_delete');const before=allTables(f.B.db),count=f.server.requests.length
  try{await rejected(()=>f.receive(),'invalid');assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)}finally{f.B.db.exec(row.sql)}
}))

test('dropping the immutable schema guard while actual object HTTP is pending never permits an install',async()=>withIncomingFixture(async f=>{
  await f.publish();const gate=f.gate(r=>r.method==='GET'&&r.path.includes('/objects/')),job=f.receive(),other=f.connect()
  const row=other.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_synced_exposure_attempt_delete'").get() as {sql:string}
  try{await gate.wait(job);other.exec('DROP TRIGGER trg_synced_exposure_attempt_delete');const before=allTables(other);gate.release();await rejected(()=>job,'invalid');assert.deepEqual(allTables(other),before)}finally{gate.release();await Promise.allSettled([job]);other.exec(row.sql)}
}))

test('a changed recovery epoch during real HTTP cannot grant the old receiver proof new install authority',async()=>withIncomingFixture(async f=>{
  await f.publish();const gate=f.gate(r=>r.method==='GET'&&r.path.includes('/objects/')),job=f.receive()
  try{await gate.wait(job);const other=f.connect();other.prepare('UPDATE synced_workspace_state SET recovery_epoch=?').run(randomUUID());const before=allTables(other);gate.release();await rejected(()=>job,'unavailable');assert.deepEqual(allTables(other),before)}finally{gate.release();await Promise.allSettled([job])}
}))

test('a real late instance SQL failure rolls back metadata canonical identities and all accepted-source records',async()=>withIncomingFixture(async f=>{
  await f.publish();const op=randomUUID(),failure=lateFailure(f.B.db,op,'instance'),before=allTables(f.B.db)
  try{const error=await rejected(()=>f.receive(op),'database');assert.match(String(error.cause),/incoming real late SQL fixture/);assert.ok(failure.seen.some(s=>s.documents>0&&s.groups>0),'The real trigger observed prior host and group writes');assert.deepEqual(allTables(f.B.db),before)}finally{failure.remove()}
}))

test('a real late reservation SQL failure rolls back all physical rows without deleting existing published assets',async()=>withIncomingFixture(async f=>{
  await f.publish();const op=randomUUID(),failure=lateFailure(f.B.db,op,'reservation'),before=allTables(f.B.db)
  try{await rejected(()=>f.receive(op),'database');assert.ok(failure.seen.some(s=>s.instances>0),'The real reservation trigger runs after physical instance installation');assert.deepEqual(allTables(f.B.db),before);assert.deepEqual(incomingRows(f.B.db),{operations:[],baselines:[]})}finally{failure.remove()}
},{missing:true,assets:true}))

test('a real late links SQL failure rolls back FTS statistics and both physical ownership tables',async()=>withIncomingFixture(async f=>{
  await f.publish();const op=randomUUID(),failure=lateFailure(f.B.db,op,'links'),before=allTables(f.B.db)
  try{await rejected(()=>f.receive(op),'database');assert.ok(failure.seen.some(s=>s.instances>0),'The actual link trigger sees complete installed instances');assert.deepEqual(allTables(f.B.db),before)}finally{failure.remove()}
}))

test('a real late receipt SQL failure preserves SQL atomicity and reports safe content addressed asset orphans accurately',async()=>withIncomingFixture(async f=>{
  await f.publish();const op=randomUUID(),failure=lateFailure(f.B.db,op,'receipt'),before=allTables(f.B.db)
  try{await rejected(()=>f.receive(op),'database');assert.ok(failure.seen.some(s=>s.documents>0&&s.instances>0),'The actual final receipt trigger sees complete preceding installation');assert.deepEqual(allTables(f.B.db),before);for(const alias of f.aliases){const files=fileInventory(join(f.B.root,'storage','assets'));if(files.some(x=>x.path.endsWith('/'+alias.name)))assert.deepEqual(readFileSync(assetPath(f.B,alias)),alias.bytes)}}finally{failure.remove()}
},{assets:true}))

test('a real late baseline SQL failure also rolls back the just inserted exact incoming receipt',async()=>withIncomingFixture(async f=>{
  await f.publish();const op=randomUUID(),failure=lateFailure(f.B.db,op,'baseline'),before=allTables(f.B.db)
  try{await rejected(()=>f.receive(op),'database');assert.ok(failure.seen.some(s=>s.instances>0),'The actual baseline trigger is late in the complete install transaction');assert.deepEqual(allTables(f.B.db),before);assert.deepEqual(incomingRows(f.B.db),{operations:[],baselines:[]})}finally{failure.remove()}
}))

test('a committed active observation survives an incoming noop receipt failure and permanently blocks new create Undo',async()=>withIncomingFixture(async f=>{
  const existing=await f.cloneBeforePublication(),restore=createRestoreInput(existing.db,f.ack,'undo');await f.publish();const op=randomUUID(),failure=lateFailure(existing.db,op,'receipt')
  try{await rejected(()=>f.track(receiveInitialSyncedSnapshot(existing.db,f.input(op,existing),runtime)),'database');assert.ok(failure.seen.length>0,'The actual incoming receipt was attempted after observation completed');assert.ok((existing.db.prepare("SELECT count(*) AS n FROM synced_operations WHERE client_operation_id LIKE 'synced:remote-exposure-observation:v1:%'").get() as {n:number}).n>0,'Independent observer evidence remains committed')
    assert.deepEqual(restoreSyncedHostOperation(existing.db,restore.input),{status:'unsupported',reason:'lifecycle'})
  }finally{failure.remove()}
  assert.equal(accepted(await f.track(receiveInitialSyncedSnapshot(existing.db,f.input(op,existing),runtime)),'noop').operationId,op)
}))

test('real create Undo during object HTTP becomes a durable retired observation even when installation then conflicts',async()=>withIncomingFixture(async f=>{
  const existing=await f.cloneBeforePublication(),restore=createRestoreInput(existing.db,f.ack,'undo');await f.publish()
  const gate=f.gate(r=>r.method==='GET'&&r.path.includes('/objects/')),job=f.track(receiveInitialSyncedSnapshot(existing.db,f.input(randomUUID(),existing),runtime))
  try{await gate.wait(job);assert.equal(restoreSyncedHostOperation(existing.db,restore.input).status,'applied');gate.release();conflict(await job)
    assert.ok((existing.db.prepare("SELECT count(*) AS n FROM synced_exposure_attempts WHERE channel='webdav-manifest5-retired-observation-anchor'").get() as {n:number}).n>0,'The original complete read permanently records the actual retired incarnation')
    assert.deepEqual(incomingRows(existing.db),{operations:[],baselines:[]})
  }finally{gate.release();await Promise.allSettled([job])}
}))

test('readonly caller transaction and disabled foreign keys are refused before HTTP without repairing their connection',async()=>withIncomingFixture(async f=>{
  await f.publish();const count=f.server.requests.length,before=allTables(f.B.db),readonly=f.connect(f.B,true)
  await rejected(()=>receiveInitialSyncedSnapshot(readonly,f.input(),runtime),'unavailable')
  f.B.db.exec('BEGIN');try{await rejected(()=>f.receive(),'invalid')}finally{f.B.db.exec('ROLLBACK')}
  f.B.db.pragma('foreign_keys=OFF');try{await rejected(()=>f.receive(),'invalid');assert.equal(f.B.db.pragma('foreign_keys',{simple:true}),0)}finally{f.B.db.pragma('foreign_keys=ON')}
  assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
}))

test('closed input UUID runtime and caller facts cannot authorize any HTTP or install',async()=>withIncomingFixture(async f=>{
  await f.publish();const before=allTables(f.B.db),count=f.server.requests.length
  for(const value of [{...f.input(),operationId:'not-a-uuid'},{...f.input(),records:[]},{...f.input(),facts:{kind:'verified'}},Object.assign(Object.create({authority:true}),f.input())])await rejected(()=>receiveInitialSyncedSnapshot(f.B.db,value as any,runtime),'invalid')
  await rejected(()=>receiveInitialSyncedSnapshot(f.B.db,f.input(),{...runtime,transport:{}} as any),'invalid')
  assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
}))

test('the exact Main root and original open connection are required for a new incoming operation',async()=>withIncomingFixture(async f=>{
  await f.publish();const before=allTables(f.B.db),count=f.server.requests.length
  await rejected(()=>receiveInitialSyncedSnapshot(f.B.db,{...f.input(),userDataRoot:f.A.root},runtime),'unavailable')
  const closed=f.connect();closed.close();await rejected(()=>receiveInitialSyncedSnapshot(closed,f.input(),runtime),'unavailable')
  assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
}))

test('schema26 is explicitly unsupported before network and schema27 is never fabricated or migrated by receive',async()=>withIncomingFixture(async f=>{
  removeSchema27ForLegacyFixture(f.B.db);f.B.db.pragma('user_version=26');const before=allTables(f.B.db),count=f.server.requests.length
  const value=await f.receive();assert.deepEqual(value,{status:'unsupported',reason:'schema-27-required'});assert.ok(Object.isFrozen(value),'The unsupported shell is immutable');assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before);assert.equal(f.B.db.pragma('user_version',{simple:true}),26)
}))

test('an unsupported real remote manifest4 does not clear an existing old protocol state or install any group',async()=>withIncomingFixture(async f=>{
  await f.publish();const old={baseline:{},conflicts:{},resolutions:{},lastSyncAt:null};f.B.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('sync.webdav.state.keep',encode(old),new Date().toISOString())
  const manifest=JSON.parse(f.server.files.get('/Incoming/manifest.json')!.toString());manifest.version=4;f.server.files.set('/Incoming/manifest.json',Buffer.from(encode(manifest)))
  const before=allTables(f.B.db);assert.deepEqual(await f.receive(),{status:'unsupported',reason:'initial-snapshot-only'});assert.deepEqual(allTables(f.B.db),before)
}))

test('a noncanonical actual Manifest5 is invalid and partial objects cannot mint any source baseline',async()=>withIncomingFixture(async f=>{
  await f.publish();const original=f.server.files.get('/Incoming/manifest.json')!;f.server.files.set('/Incoming/manifest.json',Buffer.from(JSON.stringify(JSON.parse(original.toString()),null,2)))
  const before=allTables(f.B.db);await rejected(()=>f.receive(),'invalid');assert.deepEqual(allTables(f.B.db),before)
}))

test('a real object hash mismatch cannot become an ordinary component conflict or partial success',async()=>withIncomingFixture(async f=>{
  await f.publish();const manifest=JSON.parse(f.server.files.get('/Incoming/manifest.json')!.toString()),digest=Object.values(manifest.entries)[0]
  f.server.files.set('/Incoming/objects/'+digest+'.json',Buffer.from('{}'));const before=allTables(f.B.db);await rejected(()=>f.receive(),'invalid');assert.deepEqual(allTables(f.B.db),before)
}))

test('a recomputed remote canonical Key mismatch is rejected at the strict semantic layer before SQL',async()=>withIncomingFixture(async f=>{
  await f.publish();mutateRemote(f.server,'Incoming','group:'+f.ack.createdLifecycle.groupId,record=>{record.bindings[0].from+=1})
  const before=allTables(f.B.db);await rejected(()=>f.receive(),'invalid');assert.deepEqual(allTables(f.B.db),before)
}))

test('a preaborted receive has no HTTP or local proof and cancellation during required asset GET has no install',async()=>withIncomingFixture(async f=>{
  await f.publish();const before=allTables(f.B.db),count=f.server.requests.length,first=new AbortController();first.abort();await rejected(()=>f.receive(randomUUID(),first.signal),'transport');assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
  const signal=new AbortController(),gate=f.gate(r=>r.method==='GET'&&/\/assets\/[a-f0-9]{64}$/.test(r.path)),job=f.receive(randomUUID(),signal.signal)
  try{await gate.wait(job);signal.abort();gate.release();await rejected(()=>job,'transport');assert.deepEqual(allTables(f.B.db),before)}finally{gate.release();await Promise.allSettled([job])}
},{assets:true}))

test('ordinary readonly metadata fallbacks remain actual GET HEAD PROPFIND with no test initialize or content writes',async()=>withIncomingFixture(async f=>{
  await f.publish();f.server.setOptions({omitGetEtag:true,omitHeadEtag:true});const count=f.server.requests.length;accepted(await f.receive())
  const requests=f.server.requests.slice(count);readonlyRequests(requests);assert.ok(requests.some(r=>r.method==='HEAD')&&requests.some(r=>r.method==='PROPFIND'),'The actual client consumes both readonly metadata fallback paths')
}))

test('a symlink or junction Main root never gains incoming authority and emits no HTTP',async()=>withIncomingFixture(async f=>{
  await f.publish();const link=join(f.folder,'linked-root');symlinkSync(f.B.root,link,'junction');const before=allTables(f.B.db),count=f.server.requests.length
  await rejected(()=>receiveInitialSyncedSnapshot(f.B.db,{...f.input(),userDataRoot:link},runtime),'spool');assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
}))

test('a destination alias that is an existing directory is refused rather than replaced by received bytes',async()=>withIncomingFixture(async f=>{
  const path=assetPath(f.B,f.aliases[0]);mkdirSync(path,{recursive:true});await f.publish();const before=allTables(f.B.db)
  await rejected(()=>f.receive(),'asset');assert.deepEqual(allTables(f.B.db),before)
},{assets:true}))

test('a future schema cannot be downgraded migrated or treated as an empty initial destination',async()=>withIncomingFixture(async f=>{
  f.B.db.pragma('user_version=28');const before=allTables(f.B.db),count=f.server.requests.length
  await rejected(()=>f.receive(),'invalid');assert.equal(f.B.db.pragma('user_version',{simple:true}),28);assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
}))

test('percent encoded receiver paths preserve typed aliases and portable record hashes on a second real sender',async()=>withIncomingFixture(async f=>{
  const receiver=f.newPristine('接收 空格');await f.publish();const source=await f.readRemote()
  accepted(await f.track(receiveInitialSyncedSnapshot(receiver.db,f.input(randomUUID(),receiver),runtime)))
  for(const alias of f.aliases)assert.deepEqual(readFileSync(assetPath(receiver,alias)),alias.bytes)
  const target={...f.targetConfig,directory:'Unicode-roundtrip'};await f.send(receiver,target);assert.deepEqual((await f.readRemote(target)).manifest.entries,source.manifest.entries)
},{assets:true}))

test('a real move journal alone keeps deleted source and target document identities outside fresh installation',async()=>withIncomingFixture(async f=>{
  realMoveHistory(f,{source:f.host})
  await f.publish();const before=allTables(f.B.db);conflict(await f.receive(),'history');assert.deepEqual(allTables(f.B.db),before)
}))

test('non JSON expected versions in an actual move journal is bad evidence rather than an ordinary component conflict',async()=>withIncomingFixture(async f=>{
  const move=realMoveHistory(f);f.B.db.prepare('UPDATE document_block_moves SET expected_versions_json=? WHERE id=?').run('{',move.operation)
  await f.publish();const before=allTables(f.B.db);await rejected(()=>f.receive(),'invalid');assert.deepEqual(allTables(f.B.db),before)
}))

test('an actual move expected version map missing its real participant is invalid even when the remaining timestamps are valid',async()=>withIncomingFixture(async f=>{
  const move=realMoveHistory(f),versions=JSON.parse(move.original.expected_versions_json);delete versions[move.source]
  f.B.db.prepare('UPDATE document_block_moves SET expected_versions_json=? WHERE id=?').run(encode(versions),move.operation)
  await f.publish();const before=allTables(f.B.db);await rejected(()=>f.receive(),'invalid');assert.deepEqual(allTables(f.B.db),before)
}))

test('a genuine move with its third rewritten reference document remains valid unrelated retained history for first introduction',async()=>withIncomingFixture(async f=>{
  const move=realMoveHistory(f,{reference:true}),versions=JSON.parse(move.original.expected_versions_json)
  assert.ok(move.reference!==null&&Object.hasOwn(versions,move.reference),'The actual move captured the additional rewritten reference participant')
  const before=move.original;await f.publish();accepted(await f.receive());assert.deepEqual(f.B.db.prepare('SELECT * FROM document_block_moves WHERE id=?').get(move.operation),before)
}))

test('historical move expected times different from current document versions are stale Undo facts not corrupt history',async()=>withIncomingFixture(async f=>{
  realMoveHistory(f,{erase:false,advance:true});await f.publish();const before=allTables(f.B.db)
  conflict(await f.receive(),'non-initial-target');assert.deepEqual(allTables(f.B.db),before)
}))

test('same parent ASCII casefold title collision from genuine sender records is a path conflict with no installation',async()=>withIncomingFixture(async f=>{
  await f.publish();mutateRemote(f.server,'Incoming','doc:'+f.host,r=>{r.content.title='Case'});mutateRemote(f.server,'Incoming','doc:'+f.target,r=>{r.content.title='case'})
  const before=allTables(f.B.db);conflict(await f.receive(),'path');assert.deepEqual(allTables(f.B.db),before);assert.deepEqual(incomingRows(f.B.db),{operations:[],baselines:[]})
}))

test('equal titles under genuinely different source parents install without global name normalization',async()=>withIncomingFixture(async f=>{
  await f.publish();accepted(await f.receive());assert.equal(readStrictHostDocument(f.B.db,f.target)!.detail.path,'Shared');assert.equal(readStrictHostDocument(f.B.db,f.child)!.detail.path,'Source/Shared')
},{caseTitles:'separate-parents'}))

test('SQLite ASCII NOCASE does not invent Unicode lowercase equivalence for distinct source siblings',async()=>withIncomingFixture(async f=>{
  await f.publish();accepted(await f.receive());assert.equal(readStrictHostDocument(f.B.db,f.target)!.detail.title,'Ä');assert.equal(readStrictHostDocument(f.B.db,f.other)!.detail.title,'ä')
},{caseTitles:'unicode'}))

test('a real private stage cleanup failure preserves the primary late SQL classification cause and rollback evidence',async()=>withIncomingFixture(async f=>{
  await f.publish();const operation=randomUUID(),failure=lateFailure(f.B.db,operation,'receipt'),before=allTables(f.B.db)
  let gets=0;const gate=f.gate(r=>r.method==='GET'&&r.path==='/Incoming/manifest.json'&&++gets===2),job=f.receive(operation)
  let obstruction:ReturnType<typeof obstructOwnStageCleanup>|undefined
  try {
    await gate.wait(job);obstruction=obstructOwnStageCleanup(f,operation);gate.release()
    const error=await rejected(()=>job,'database'),detail=error.cause as {cause:unknown;cleanup:unknown;stage:string;receiptOperationId:string|null}
    assert.match(String(detail.cause),/incoming real late SQL fixture/);assert.ok(detail.cleanup instanceof Error,'The independent cleanup failure remains in the real primary error chain')
    assert.equal(detail.stage,obstruction.stage);assert.equal(detail.receiptOperationId,null)
    assert.ok(failure.seen.some(s=>s.instances>0),'The SQL failure really occurred after the physical install and before cleanup')
    assert.deepEqual(allTables(f.B.db),before)
  } finally {gate.release();await Promise.allSettled([job]);obstruction?.restore();failure.remove()}
},{assets:true}))

test('a cleanup failure after actual SQL commit keeps the original incoming receipt available for zero HTTP historical replay',async()=>withIncomingFixture(async f=>{
  await f.publish();const operation=randomUUID();let gets=0
  const gate=f.gate(r=>r.method==='GET'&&r.path==='/Incoming/manifest.json'&&++gets===2),job=f.receive(operation)
  let obstruction:ReturnType<typeof obstructOwnStageCleanup>|undefined
  try {
    await gate.wait(job);obstruction=obstructOwnStageCleanup(f,operation);gate.release()
    const error=await rejected(()=>job,'asset'),detail=error.cause as {cleanup:unknown;stage:string;receiptOperationId:string|null}
    assert.ok(detail.cleanup instanceof Error,'The cleanup error remains observable after a genuinely committed receipt')
    assert.equal(detail.stage,obstruction.stage);assert.equal(detail.receiptOperationId,operation)
    assert.equal(incomingRows(f.B.db).operations.length,1);assert.ok(readStrictHostDocument(f.B.db,f.host),'The committed graph remains physically readable despite its cleanup error')
    const count=f.server.requests.length,before=allTables(f.B.db),replayed=accepted(await f.receive(operation))
    assert.equal(replayed.replayed,true);assert.equal(replayed.operationId,operation);assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
    for(const alias of f.aliases)assert.deepEqual(readFileSync(assetPath(f.B,alias)),alias.bytes)
  } finally {gate.release();await Promise.allSettled([job]);obstruction?.restore()}
},{assets:true}))
