import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { withIncomingFixture, accepted, conflict, rejected, pristine, catalogCounts, readonlyRequests, incomingRows,
  snapshot, readStrictHostDocument, assertSyncedLifecycleSchema, allTables, randomUUID, encode, hash,
  assetPath, fileInventory, missingId, getSyncedOperation, getSyncedOperationWithLinkSource } from './helpers/synced-initial-incoming-fixture'

function installRows(db:Parameters<typeof allTables>[0]) {
  const {synced_operations:_op,synced_exposure_attempts:_attempt,synced_group_exposure_members:_members,synced_group_lifecycle:_life,...rows}=allTables(db)
  rows.app_settings=(rows.app_settings as Array<{key:string}>).filter(r=>!r.key.startsWith('sync.webdav.protocol5.initial.v1.'));return rows
}

test('actual A create and sender install the complete graph in independent empty B and B republishes the original portable records', async()=>withIncomingFixture(async f=>{
  pristine(f.B);await f.publish();const source=await f.readRemote(), start=f.server.requests.length, result=accepted(await f.receive())
  readonlyRequests(f.server.requests.slice(start));assert.equal(result.replayed,false);assert.equal(result.remoteWorkspaceId,source.manifest.workspaceId)
  const docs=source.records.filter(r=>r.record.kind==='document'), groups=source.records.filter(r=>r.record.kind==='synced-group')
  assert.ok(Object.values(catalogCounts(f.A.db)).every(count=>count>0),'The actual source exercises nonempty rows in all six typed catalog tables')
  const physical=source.records.reduce((n,r)=>n+(r.record.kind==='document'?r.record.content.blocks.length:r.record.kind==='synced-group'?r.record.blocks.length:0),0)
  assert.deepEqual(result.counts,{documents:docs.length,groups:groups.length,instances:source.manifest.syncedInstances.length,physicalBlocks:physical,reservations:0,assets:2})
  assert.notEqual(f.B.defaultId,f.A.defaultId)
  assert.deepEqual(f.B.db.prepare('SELECT id,name,description,created_at FROM databases WHERE id=?').get(f.B.defaultId),{id:f.B.defaultId,name:'Source default metadata',description:'Source catalog description',created_at:f.B.defaultBirth})
  for(const item of source.records) {
    if(item.record.kind==='document') {const actual=readStrictHostDocument(f.B.db,item.record.id);assert.ok(actual,'Each actual installed host is strict readable before Store repair');assert.equal(actual.createdAt,item.record.createdAt);assert.equal(actual.detail.id,item.record.id)}
    if(item.record.kind==='synced-group') {
      const actual=snapshot(f.B.db,item.record.id);assert.equal(actual.creationId,item.record.creationId);assert.equal(actual.createdAt,item.record.createdAt);assert.deepEqual(actual.origin,item.record.origin)
      assert.deepEqual(actual.blocks.map(b=>({id:b.id,createdAt:b.createdAt})),item.record.blocks.map(b=>({id:b.id,createdAt:b.createdAt})))
      const stable=(bindings:typeof actual.bindings)=>bindings.filter(b=>b.raw==='Target.md'||b.raw.startsWith('#^'))
      assert.deepEqual(stable(actual.bindings),stable(item.record.bindings)) // Full localized Keys are also checked by B's actual portable re-publication below.
      const life=f.B.db.prepare('SELECT state,exposure_state AS exposure,create_history_id FROM synced_group_lifecycle WHERE group_id=?').get(item.record.id)
      assert.deepEqual(life,{state:'active',exposure:'unknown',create_history_id:null})
    }
  }
  for(const row of f.B.db.prepare('SELECT b.id,b.created_at,i.created_at AS born,i.last_owner_kind,i.last_owner_id,b.document_id FROM blocks b JOIN block_identities i ON i.id=b.id').all() as any[]) {
    assert.equal(row.created_at,result.acceptedAt);assert.equal(row.born,result.acceptedAt);assert.equal(row.last_owner_kind,'document');assert.equal(row.last_owner_id,row.document_id)
  }
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_host_history').get() as {n:number}).n,0)
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_group_pins').get() as {n:number}).n,0)
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_operations').get() as {n:number}).n,1)
  assert.ok((f.B.db.prepare('SELECT position FROM synced_host_history_state').all() as {position:number}[]).every(r=>r.position===0),'Every imported host begins at a fresh zero history position')
  assert.ok((f.B.db.prepare('SELECT history_position FROM synced_groups').all() as {history_position:number}[]).every(r=>r.history_position===0),'Every imported group begins at a fresh zero history position')
  for(const alias of f.aliases)assert.deepEqual(readFileSync(assetPath(f.B,alias)),alias.bytes)
  const pair=snapshot(f.B.db,f.ack.createdLifecycle.groupId).bindings.filter(b=>b.raw==='Target.md').sort((a,b)=>a.from-b.from)
  assert.deepEqual(pair.map(b=>b.target),[{kind:'document',id:f.target,state:'live'},{kind:'document',id:f.other,state:'live'}])
  f.reopen();assertSyncedLifecycleSchema(f.B.db);assert.ok(readStrictHostDocument(f.B.db,f.host),'A genuinely new connection reads the installed host')
  const next={...f.targetConfig,directory:'Independent-roundtrip'};await f.send(f.B,next);const roundtrip=await f.readRemote(next)
  assert.deepEqual(roundtrip.manifest.entries,source.manifest.entries);assert.deepEqual(roundtrip.manifest.syncedInstances,source.manifest.syncedInstances)
  assert.notEqual(roundtrip.manifest.workspaceId,source.manifest.workspaceId)
  assert.deepEqual(roundtrip.records,source.records)
  assert.throws(()=>new KnowbookStore(f.B.file),/同步块/)
},{assets:true,catalog:true,orphan:true,sameUrl:true,notes:true}))

test('pristine B is independently migrated with zero live content and exactly the original six catalog table counts', async()=>withIncomingFixture(async f=>{
  pristine(f.B);assert.deepEqual(catalogCounts(f.B.db),{databases:1,document_database_columns:0,database_saved_views:0,database_entities:0,database_entity_values:0,document_database_values:0})
  const before=allTables(f.B.db), start=f.server.requests.length;const result=await f.receive()
  assert.deepEqual(result,{status:'missing'});assert.ok(Object.isFrozen(result),'The missing DTO is immutable');readonlyRequests(f.server.requests.slice(start));assert.deepEqual(allTables(f.B.db),before)
}))

test('first introduction keeps the local default birth but accepts remote default metadata then full exact noop ignores pristine labels', async()=>withIncomingFixture(async f=>{
  await f.publish();accepted(await f.receive());const before=installRows(f.B.db), operation=randomUUID(), next=accepted(await f.receive(operation),'noop')
  assert.equal(next.replayed,false);assert.equal(next.operationId,operation);assert.deepEqual(installRows(f.B.db),before)
  assert.equal((f.B.db.prepare('SELECT created_at FROM databases WHERE id=?').get(f.B.defaultId) as {created_at:string}).created_at,f.B.defaultBirth)
  assert.equal(incomingRows(f.B.db).operations.length,2)
},{catalog:true}))

test('the original incoming operation replays zero HTTP after remote deletion and returns the original immutable result', async()=>withIncomingFixture(async f=>{
  await f.publish();const operation=randomUUID(), first=accepted(await f.receive(operation)), before=allTables(f.B.db)
  f.server.files.clear();const count=f.server.requests.length, again=accepted(await f.receive(operation))
  assert.deepEqual(again,{...first,replayed:true});assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
}))

test('an original accepted receipt remains a historical fact after recovery epoch changes and does not mint another install', async()=>withIncomingFixture(async f=>{
  await f.publish();const operation=randomUUID(), first=accepted(await f.receive(operation))
  f.B.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=?').run(randomUUID());f.reopen()
  const before=allTables(f.B.db), count=f.server.requests.length;assert.deepEqual(accepted(await f.receive(operation)),{...first,replayed:true})
  assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
}))

test('the same incoming UUID with a different normalized target is an idempotency error before HTTP', async()=>withIncomingFixture(async f=>{
  await f.publish();const operation=randomUUID();accepted(await f.receive(operation));const before=allTables(f.B.db), count=f.server.requests.length
  const {receiveInitialSyncedSnapshot,runtime}=await import('./helpers/synced-initial-incoming-fixture')
  await rejected(()=>receiveInitialSyncedSnapshot(f.B.db,f.input(operation,f.B,{...f.targetConfig,directory:'Different'}),runtime),'invalid')
  assert.deepEqual(allTables(f.B.db),before);assert.equal(f.server.requests.length,count)
}))

test('an older exact operation still replays when a later valid noop receipt owns the current source baseline', async()=>withIncomingFixture(async f=>{
  await f.publish();const firstId=randomUUID(), first=accepted(await f.receive(firstId));accepted(await f.receive(),'noop')
  const count=f.server.requests.length,before=allTables(f.B.db);assert.deepEqual(accepted(await f.receive(firstId)),{...first,replayed:true});assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
}))

test('closed incoming receipt corruption cannot fall through to a fresh HTTP request or reinstall', async()=>withIncomingFixture(async f=>{
  await f.publish();const operation=randomUUID();accepted(await f.receive(operation))
  const row=f.B.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(operation) as {result_json:string}
  const value=JSON.parse(row.result_json);value.extraAuthority=true;f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(value),operation)
  const before=allTables(f.B.db),count=f.server.requests.length;await rejected(()=>f.receive(operation),'invalid');assert.equal(f.server.requests.length,count);assert.deepEqual(allTables(f.B.db),before)
}))

test('an incoming receipt never decodes as a legacy content or structure ACK and cannot sign a group source ticket', async()=>withIncomingFixture(async f=>{
  await f.publish();const operation=randomUUID();accepted(await f.receive(operation));const before=allTables(f.B.db)
  assert.throws(()=>getSyncedOperation(f.B.db,{clientOperationId:operation}));assert.throws(()=>getSyncedOperationWithLinkSource(f.B.db,{clientOperationId:operation}));assert.deepEqual(allTables(f.B.db),before)
}))

test('corrupt existing initial baseline is rejected without healing or replacing the old protocol state', async()=>withIncomingFixture(async f=>{
  await f.publish();accepted(await f.receive())
  f.B.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('sync.webdav.state.keep-old','{"old":true}',new Date().toISOString())
  const row=f.B.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.initial.v1.%'").get() as {key:string;value:string}
  const body=JSON.parse(row.value);body.extraAuthority=true;f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(body),row.key)
  const before=installRows(f.B.db),priorIncoming=incomingRows(f.B.db);await rejected(()=>f.receive(),'invalid');assert.deepEqual(installRows(f.B.db),before);assert.deepEqual(incomingRows(f.B.db),priorIncoming)
}))

test('only genuinely absent block targets reserve one original source identity while real physical targets never reserve', async()=>withIncomingFixture(async f=>{
  await f.publish();const result=accepted(await f.receive());assert.equal(result.counts.reservations,1)
  const reserved=f.B.db.prepare("SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE last_owner_kind='reserved'").all() as any[]
  assert.equal(reserved.length,1);assert.equal(reserved[0].id,missingId);assert.equal(reserved[0].state,'retained');assert.equal(reserved[0].created_at,null);assert.match(reserved[0].last_owner_id,/^sync5:initial-missing-block:v1:/)
  assert.equal(f.B.db.prepare('SELECT id FROM blocks WHERE id=?').get(missingId),undefined);assert.equal(f.B.db.prepare('SELECT id FROM synced_group_blocks WHERE id=?').get(missingId),undefined)
  assert.equal(f.B.db.prepare('SELECT block_id FROM document_block_routes WHERE block_id=?').get(missingId),undefined)
  assert.equal((f.B.db.prepare('SELECT last_owner_kind FROM block_identities WHERE id=?').get(f.sourceBlock) as {last_owner_kind:string}).last_owner_kind,'group')
  assert.equal(f.B.db.prepare("SELECT id FROM documents WHERE title='Absent'").get(),undefined)
  const before=installRows(f.B.db);assert.equal(accepted(await f.receive(),'noop').counts.reservations,1);assert.deepEqual(installRows(f.B.db),before)
},{missing:true}))

test('an unrelated retained local identity is preserved while a complete first introduction installs all fresh source IDs', async()=>withIncomingFixture(async f=>{
  const id='unrelated retained '+randomUUID();f.B.db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'document',?,'retained',?)").run(id,'old independent owner','2010-01-01T00:00:00Z')
  const before=f.B.db.prepare('SELECT * FROM block_identities WHERE id=?').get(id);await f.publish();accepted(await f.receive());assert.deepEqual(f.B.db.prepare('SELECT * FROM block_identities WHERE id=?').get(id),before)
}))

test('a destination alias already containing its exact immutable bytes is reused without overwriting that file', async()=>withIncomingFixture(async f=>{
  const path=assetPath(f.B,f.aliases[0]);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,f.aliases[0].bytes,{flag:'wx'})
  await f.publish();accepted(await f.receive());assert.deepEqual(readFileSync(path),f.aliases[0].bytes)
},{assets:true}))

test('a destination alias containing different bytes is an asset failure and preserves pristine SQL and the existing file', async()=>withIncomingFixture(async f=>{
  const path=assetPath(f.B,f.aliases[0]),wrong=Buffer.from('existing wrong bytes');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,wrong,{flag:'wx'})
  await f.publish();const before=allTables(f.B.db);await rejected(()=>f.receive(),'asset');assert.deepEqual(allTables(f.B.db),before);assert.deepEqual(readFileSync(path),wrong);assert.deepEqual(incomingRows(f.B.db),{operations:[],baselines:[]})
},{assets:true}))

test('the first committed SQL already exposes links source indices FTS and all three host statistics without Store repair', async()=>withIncomingFixture(async f=>{
  await f.publish();accepted(await f.receive());const db=f.connect()
  for(const host of db.prepare('SELECT id,block_count,link_count,child_count FROM documents').all() as any[]) {
    assert.equal(host.block_count,(db.prepare('SELECT count(*) AS n FROM blocks WHERE document_id=?').get(host.id) as {n:number}).n)
    assert.equal(host.child_count,(db.prepare('SELECT count(*) AS n FROM documents WHERE parent_id=?').get(host.id) as {n:number}).n)
    assert.equal(host.link_count,(db.prepare('SELECT count(*) AS n FROM links WHERE source_document_id=?').get(host.id) as {n:number}).n)
  }
  assert.ok((db.prepare('SELECT count(*) AS n FROM markdown_link_sources').get() as {n:number}).n>0,'Actual source indices exist at the first commit')
  assert.ok((db.prepare('SELECT count(*) AS n FROM block_search').get() as {n:number}).n>0,'Actual host FTS rows exist before repair')
  const canonical=f.ack.createdLifecycle.groupId
  for(const row of db.prepare('SELECT id FROM synced_group_blocks WHERE group_id=?').all(canonical) as {id:string}[])assert.equal(db.prepare('SELECT block_id FROM block_search WHERE block_id=?').get(row.id),undefined)
}))
