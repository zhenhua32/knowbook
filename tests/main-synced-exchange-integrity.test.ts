import assert from 'node:assert/strict'
import test from 'node:test'
import {writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {AttachmentStore} from '../src/main/attachments'
import {getSyncedOperation,restoreSyncedGroupOperation} from '../src/main/database/synced-blocks-content'
import {getSyncedOperationWithLinkSource} from '../src/main/database/synced-binding-sources'
import {snapshot,assetPath,rejected,mutateRemote} from './helpers/synced-initial-incoming-fixture'
import {command as insertCommand,insertAck} from './helpers/synced-host-command-insert-fixture'
import {withExchange,completed,randomUUID,encode,hash,runtime,allTables,changeGroup,readStrictHostDocument,
  hostEdit,hostRows,physical,localPortable,remoteActual,converged,exchangeRows,stateRow,lateReceipt,
  createRequest,created,applySyncedHostCommand,request,applySyncedHostFinal,restoreInput,exchangeSyncedSnapshot} from './helpers/synced-exchange-fixture'

test('remote group replacement invalidates old executable Undo while original content ACK stays immutable and a fresh local history works',()=>withExchange(async f=>{
  const groupId=f.ack.createdLifecycle.groupId,old=changeGroup(f.B.db,groupId,blocks=>{blocks[0].content+=' before shared boundary'})
  assert.ok(old.status==='saved','The old executable history is made by the actual content writer')
  if(old.status!=='saved')throw new Error('Expected a real saved old content ACK')
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied')
  const oldBytes=f.B.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(old.operationId),oldSnapshot=snapshot(f.B.db,groupId),instance=oldSnapshot.instances[0]
  assert.ok(oldSnapshot.history.undoToken,'The old side initially has an executable local Undo token')
  const stale={clientOperationId:randomUUID(),groupId,historyToken:oldSnapshot.history.undoToken,expectedHistoryCursor:oldSnapshot.history.cursor,direction:'undo' as const,
    expectedRevision:oldSnapshot.revision,expectedTopologyRevision:oldSnapshot.topologyRevision,expectedInstanceBinding:{instanceId:instance.instanceId,hostDocumentId:instance.hostDocumentId,bindingVersion:instance.bindingVersion}}
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' external replacement'});completed(await f.exchange(f.A),'applied');completed(await f.exchange(f.B),'applied')
  const boundary=snapshot(f.B.db,groupId),boundaryLease=boundary.instances[0]
  assert.equal(restoreSyncedGroupOperation(f.B.db,{...stale,expectedRevision:boundary.revision,expectedTopologyRevision:boundary.topologyRevision,
    expectedHistoryCursor:boundary.history.cursor,expectedInstanceBinding:{instanceId:boundaryLease.instanceId,hostDocumentId:boundaryLease.hostDocumentId,bindingVersion:boundaryLease.bindingVersion}}).status,'conflict')
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(old.operationId),oldBytes)
  assert.deepEqual(getSyncedOperation(f.B.db,{clientOperationId:old.operationId}),{status:'committed',result:{...old,replayed:true}})
  const fresh=changeGroup(f.B.db,groupId,blocks=>{blocks[0].content+=' new local Undo branch'})
  assert.ok(fresh.status==='saved','A new local content edit works after the external branch boundary')
  const current=snapshot(f.B.db,groupId),lease=current.instances[0]
  const undo=restoreSyncedGroupOperation(f.B.db,{...stale,clientOperationId:randomUUID(),historyToken:current.history.undoToken,
    expectedHistoryCursor:current.history.cursor,expectedRevision:current.revision,expectedTopologyRevision:current.topologyRevision,
    expectedInstanceBinding:{instanceId:lease.instanceId,hostDocumentId:lease.hostDocumentId,bindingVersion:lease.bindingVersion}})
  assert.equal(undo.status,'saved');assert.deepEqual(snapshot(f.B.db,groupId).blocks,snapshot(f.A.db,groupId).blocks)
  const undone=snapshot(f.B.db,groupId),redoLease=undone.instances[0]
  assert.ok(undone.history.redoToken,'A fresh post-boundary local group branch retains its actual redo token after Undo')
  const redo=restoreSyncedGroupOperation(f.B.db,{...stale,clientOperationId:randomUUID(),direction:'redo',historyToken:undone.history.redoToken,
    expectedHistoryCursor:undone.history.cursor,expectedRevision:undone.revision,expectedTopologyRevision:undone.topologyRevision,
    expectedInstanceBinding:{instanceId:redoLease.instanceId,hostDocumentId:redoLease.hostDocumentId,bindingVersion:redoLease.bindingVersion}})
  assert.equal(redo.status,'saved');assert.deepEqual(snapshot(f.B.db,groupId).blocks,fresh.snapshot.blocks)
}))

test('real host history boundary cannot Undo across remote replacement and old immutable host ACK still replays',()=>withExchange(async f=>{
  const local=hostEdit(f.B.db,f.islands[0],'B original host history')
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied')
  const stored=f.B.db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(local.ack.historyToken)
  hostEdit(f.A.db,f.islands[0],'A external host replacement');completed(await f.exchange(f.A),'applied');completed(await f.exchange(f.B),'applied')
  const {restoreSyncedHostOperation}=await import('../src/main/database/synced-host-final')
  const result=restoreSyncedHostOperation(f.B.db,restoreInput(f.B.db,local.ack,'undo'));assert.notEqual(result.status,'applied')
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(local.ack.historyToken),stored)
  assert.deepEqual(applySyncedHostFinal(f.B.db,local.input),{...local.ack,replayed:true})
  const fresh=hostEdit(f.B.db,f.islands[0],'B fresh host branch')
  assert.equal(restoreSyncedHostOperation(f.B.db,restoreInput(f.B.db,fresh.ack,'undo')).status,'applied')
  assert.equal(readStrictHostDocument(f.B.db,f.islands[0]).detail.blocks[0].content,'A external host replacement')
  assert.equal(restoreSyncedHostOperation(f.B.db,restoreInput(f.B.db,fresh.ack,'redo')).status,'applied')
  assert.equal(readStrictHostDocument(f.B.db,f.islands[0]).detail.blocks[0].content,'B fresh host branch')
}))

test('canonical new-ID collision with an independently authored B ordinary owner defers both ownership sides and preserves an unrelated component',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop')
  const id=randomUUID(),groupId=f.ack.createdLifecycle.groupId,local=request(f.B.db,[f.islands[0]],sides=>{sides[0].blocks.push({id,type:'paragraph',content:'B local newly owned child',checked:false,depth:0,parentBlockId:null})})
  assert.equal(applySyncedHostFinal(f.B.db,local).status,'applied')
  changeGroup(f.A.db,groupId,blocks=>{blocks.push({id,type:'paragraph',content:'A independently chosen canonical child',checked:false,depth:0,parentBlockId:null,createdAt:'2026-10-18T00:00:00.000Z'})})
  hostEdit(f.A.db,f.islands[1],'independent still progresses');completed(await f.exchange(f.A),'applied')
  const owned=physical(f.B.db,id),value=completed(await f.exchange(f.B),'applied')
  assert.ok(value.deferred.some(c=>c.keys.includes('group:'+groupId)&&c.keys.includes('doc:'+f.islands[0])),'The exact identity collision connects release and claim components instead of stealing an owner')
  assert.deepEqual(physical(f.B.db,id),owned);assert.equal(value.acceptedKeys.includes('group:'+groupId),false)
  assert.equal(readStrictHostDocument(f.B.db,f.islands[1]).detail.blocks[0].content,'independent still progresses')
}))

test('real managed assets from both peers roundtrip names bytes and typed catalog without mutating opaque configuration',()=>withExchange(async f=>{
  const groupId=f.ack.createdLifecycle.groupId,store=new AttachmentStore(join(f.B.root,'storage','assets'))
  const [added]=await store.import([{name:'B 中文 +,@;$[]^~.png',bytes:Buffer.from('B independently added asset')}])
  changeGroup(f.B.db,groupId,blocks=>{blocks[0].content+=' ![B asset](<'+added.url+'>)'})
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied');const graph=converged(f)
  assert.ok(graph.remote.records.some(v=>v.key==='group:'+groupId&&encode(v.record).includes('knowbook-asset://'+hash(Buffer.from('B independently added asset')))),
    'The actual same-target object contains the real new asset portable identity')
  for(const alias of f.aliases)assert.deepEqual(readFileSync(assetPath(f.B,alias)),alias.bytes)
  const aNames=[...graph.a.assets].map(([digest,names])=>[digest,[...names].sort()]),bNames=[...graph.b.assets].map(([digest,names])=>[digest,[...names].sort()])
  assert.deepEqual(aNames,bNames)
  assert.equal(graph.b.records.some(record=>record.kind==='synced-group'&&record.blocks.some(block=>block.type==='database-view'&&block.content.includes(f.A.defaultId))),true,
    'Opaque authored query text containing the source catalog id is preserved rather than recursively remapped')
},{assets:true,catalog:true}))

test('tampered existing B asset alias prevents accepting an otherwise valid new group and never overwrites the conflicting file',()=>withExchange(async f=>{
  completed(await f.exchange(f.B),'noop')
  const groupId=f.ack.createdLifecycle.groupId;changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' remote content with same asset'})
  completed(await f.exchange(f.A),'applied');const path=assetPath(f.B,f.aliases[0]),bad=Buffer.from('wrong bytes already at B managed alias'),before=localPortable(f.B).entries,baseline=stateRow(f.B.db).value
  writeFileSync(path,bad);await rejected(()=>f.exchange(f.B),'asset')
  assert.deepEqual(readFileSync(path),bad);assert.equal(stateRow(f.B.db).value,baseline)
  writeFileSync(path,f.aliases[0].bytes);assert.deepEqual(localPortable(f.B).entries,before)
  completed(await f.exchange(f.B),'applied');converged(f)
},{assets:true}))

test('both real commit orders of a foreign tombstone and offline inserted reference defer their component while unrelated work proceeds',async()=>{
for(const order of ['reference-first','tombstone-first'] as const)await withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop');const groupId=f.ack.createdLifecycle.groupId
  hostEdit(f.A.db,f.islands[1],'real unrelated sender update');completed(await f.exchange(f.A),'applied')
  const insert=()=>insertAck(applySyncedHostCommand(f.B.db,insertCommand(f.B.db,{documentId:f.islands[0],groupId})))
  if(order==='reference-first')insert()
  // A foreign deletion wire is a read/defer fixture, never an out-of-scope successful local delete writer.
  const remote=remoteActual(f),groupEntry=remote.records.find(v=>v.key==='group:'+groupId)
  assert.ok(groupEntry,'The finite deletion derives its incarnation and previous hash from an actual published live group')
  for(const item of remote.records)if(item.record.kind==='document'&&item.record.content.blocks.some((b:{type:string;content:string})=>b.type==='synced-block'&&JSON.parse(b.content).groupId===groupId))
    mutateRemote(f.server,f.targetConfig.directory,item.key,r=>{r.content.blocks=r.content.blocks.filter((b:{type:string;content:string})=>b.type!=='synced-block'||JSON.parse(b.content).groupId!==groupId)
      if(!r.content.blocks.length)r.content.blocks=[{id:randomUUID(),type:'paragraph',content:'Explicit surviving remote paragraph',checked:false,depth:0,parentBlockId:null}]})
  mutateRemote(f.server,f.targetConfig.directory,'group:'+groupId,r=>{for(const key of Object.keys(r))delete r[key];Object.assign(r,{kind:'synced-group-deleted',id:groupId,
    creationId:groupEntry.record.creationId,previousHash:remote.manifest.entries['group:'+groupId],deletedAt:'2026-10-18T00:00:00.000Z'})})
  const path='/'+f.targetConfig.directory+'/manifest.json',bytes=f.server.files.get(path)
  assert.ok(bytes,'The negative foreign tombstone fixture still has its actual full manifest')
  const manifest=JSON.parse(bytes.toString());manifest.syncedInstances=manifest.syncedInstances.filter((v:{groupId:string})=>v.groupId!==groupId);f.server.files.set(path,Buffer.from(encode(manifest)))
  if(order==='tombstone-first')insert()
  const before=snapshot(f.B.db,groupId),value=completed(await f.exchange(f.B),'applied')
  assert.ok(value.deferred.some(c=>c.keys.includes('group:'+groupId)&&c.keys.includes('doc:'+f.islands[0])),'The offline new reference and legal tombstone are one unresolved dependency component')
  assert.deepEqual(snapshot(f.B.db,groupId),before);assert.equal(value.acceptedKeys.includes('group:'+groupId),false)
  assert.equal(readStrictHostDocument(f.B.db,f.islands[1]).detail.blocks[0].content,'real unrelated sender update')
})})

test('an external replacement invalidates the entire shared AB BC host history chain while preserving immutable old journals',()=>withExchange(async f=>{
  const [a,b,c]=f.islands
  const edit=(ids:string[],text:string)=>{const input=request(f.B.db,ids,sides=>sides.forEach(side=>{side.summary=text})),ack=applySyncedHostFinal(f.B.db,input)
    assert.ok(ack.status==='applied','A real multi-host edit commits the actual shared host journal')
    if(ack.status!=='applied')throw new Error('Expected a real shared host history ACK');return {input,ack}}
  const ab=edit([a,b],'shared AB'),bc=edit([b,c],'shared BC')
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied')
  const journals=f.B.db.prepare('SELECT * FROM synced_host_history WHERE id IN (?,?) ORDER BY id').all(ab.ack.historyToken,bc.ack.historyToken),pins=f.B.db.prepare('SELECT * FROM synced_group_pins ORDER BY group_id,kind,pin_id').all()
  hostEdit(f.A.db,a,'actual external A side');completed(await f.exchange(f.A),'applied');completed(await f.exchange(f.B),'applied')
  const {restoreSyncedHostOperation}=await import('../src/main/database/synced-host-final')
  for(const {ack} of [ab,bc])assert.notEqual(restoreSyncedHostOperation(f.B.db,restoreInput(f.B.db,ack,'undo')).status,'applied',
    'Fresh current guards cannot make either old shared journal executable across the remote boundary')
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_host_history WHERE id IN (?,?) ORDER BY id').all(ab.ack.historyToken,bc.ack.historyToken),journals)
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_group_pins ORDER BY group_id,kind,pin_id').all(),pins)
  const fresh=hostEdit(f.B.db,c,'new C branch after shared boundary')
  assert.equal(restoreSyncedHostOperation(f.B.db,restoreInput(f.B.db,fresh.ack,'undo')).status,'applied')
}))

test('a corrupt actual remote object is invalid rather than missing or a new baseline and never changes accepted local knowledge',()=>withExchange(async f=>{
  completed(await f.exchange(f.B),'noop');const remote=remoteActual(f),groupId=f.ack.createdLifecycle.groupId,key='group:'+groupId
  f.server.files.set('/'+f.targetConfig.directory+'/objects/'+remote.manifest.entries[key]+'.json',Buffer.from('{"kind":"broken"}'))
  const before=localPortable(f.B),state=stateRow(f.B.db).value
  await rejected(()=>f.exchange(f.B),'invalid')
  assert.deepEqual(localPortable(f.B).entries,before.entries);assert.equal(stateRow(f.B.db).value,state)
}))

test('preaborted exchange and cancellation during an actual object download preserve the previously accepted baseline',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop')
  const before=localPortable(f.B).entries,state=stateRow(f.B.db).value,controller=new AbortController();controller.abort()
  await rejected(()=>f.exchange(f.B,randomUUID(),controller.signal),'transport')
  assert.deepEqual(localPortable(f.B).entries,before);assert.equal(stateRow(f.B.db).value,state)
  const groupId=f.ack.createdLifecycle.groupId;changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' remote for cancellation'});completed(await f.exchange(f.A),'applied')
  const digest=remoteActual(f).manifest.entries['group:'+groupId],gate=f.gate(r=>r.method==='GET'&&r.path.endsWith('/objects/'+digest+'.json')),abort=new AbortController(),job=f.exchange(f.B,randomUUID(),abort.signal)
  try {await gate.wait(job);abort.abort();gate.release();await rejected(()=>job,'transport');assert.deepEqual(localPortable(f.B).entries,before);assert.equal(stateRow(f.B.db).value,state)}
  finally {gate.release();await Promise.allSettled([job])}
}))

test('invalid entry caller transaction readonly connection and FK off never mint an exchange job or perform HTTP',()=>withExchange(async f=>{
  const start=f.server.requests.length,before=allTables(f.B.db),input=f.input(randomUUID())
  await rejected(()=>f.track(exchangeSyncedSnapshot(f.B.db,{...input,callerFacts:{}} as unknown as Parameters<typeof exchangeSyncedSnapshot>[1],runtime)),'invalid')
  await rejected(()=>f.track(exchangeSyncedSnapshot(f.B.db,{...input,operationId:'not-uuid'},runtime)),'invalid')
  const readonly=f.connect(f.B,true)
  await rejected(()=>f.track(exchangeSyncedSnapshot(readonly,input,runtime)),'unavailable')
  f.B.db.pragma('foreign_keys=OFF');try{await rejected(()=>f.exchange(f.B),'invalid')}finally{f.B.db.pragma('foreign_keys=ON')}
  f.B.db.exec('BEGIN');try{await rejected(()=>f.exchange(f.B),'invalid')}finally{f.B.db.exec('ROLLBACK')}
  assert.equal(f.server.requests.length,start);assert.deepEqual(allTables(f.B.db),before)
}))

test('rejected overlapping calls cannot clear the first same-root target lock and admit a third request while real HTTP is pending',()=>withExchange(async f=>{
  const firstOperation=randomUUID(),secondOperation=randomUUID(),thirdOperation=randomUUID()
  const gate=f.gate(request=>request.method==='GET'&&request.path.endsWith('/manifest.json')),first=f.exchange(f.B,firstOperation)
  try {
    await gate.wait(first)
    const requestCount=f.server.requests.length,rows=exchangeRows(f.B.db)
    await rejected(()=>f.exchange(f.B,secondOperation),'unavailable')
    assert.equal(f.server.requests.length,requestCount,'The rejected second invocation emits no extra HTTP')
    assert.deepEqual(exchangeRows(f.B.db),rows,'The rejected second invocation persists no additional exchange job or receipt')
    await rejected(()=>f.exchange(f.B,thirdOperation),'unavailable')
    assert.equal(f.server.requests.length,requestCount,'The third invocation is still blocked by the original in-flight owner and emits no HTTP')
    assert.deepEqual(exchangeRows(f.B.db),rows,'The second invocation cannot release another job lock or let the third persist state')
    for(const operation of [secondOperation,thirdOperation]) {
      assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operation),undefined)
      assert.equal(exchangeRows(f.B.db).settings.some(row=>row.key.includes(operation)),false)
    }
    gate.release();completed(await first,'noop')
    const after=completed(await f.exchange(f.B),'noop')
    assert.notEqual(after.operationId,firstOperation,'The original owner releases its own lock after completion so a new operation can run')
    assert.ok(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(firstOperation),'The original in-flight operation settles its actual receipt')
    assert.ok(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(after.operationId),'The subsequent newly admitted operation also settles its own receipt')
  } finally {gate.release();await Promise.allSettled([first])}
}))

test('whole-state receipt binding detects a removed baseline row or changed common hash before any HTTP job or resurrection',async()=>{
  for(const corruption of ['remove-baseline-row','change-common-hash'] as const)await withExchange(async f=>{
    const settled=completed(await f.exchange(f.B),'noop'),saved=stateRow(f.B.db),key='doc:'+f.islands[0]
    const original=saved.state.baseline.find(entry=>entry.key===key)
    assert.ok(original,'A real settled per-target state has the independent U baseline before corruption')
    assert.ok(original.commonHash,'The real equal-side seed records an actual common hash for U')
    const tampered=JSON.parse(saved.value) as {baseline:Array<{key:string;commonHash:string|null}>}
    if(corruption==='remove-baseline-row')tampered.baseline=tampered.baseline.filter(entry=>entry.key!==key)
    else {
      const entry=tampered.baseline.find(entry=>entry.key===key)
      assert.ok(entry&&entry.commonHash,'The standalone common-hash mutation targets the actual saved U entry')
      entry.commonHash=(entry.commonHash[0]==='0'?'1':'0')+entry.commonHash.slice(1)
    }
    f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(tampered),saved.key)
    if(corruption==='remove-baseline-row') {
      // This is deliberately invalid remote disappearance, not a successful deletion writer.
      const remote=remoteActual(f),manifest={...remote.manifest,entries:{...remote.manifest.entries}}
      assert.ok(Object.hasOwn(manifest.entries,key),'The negative remote mutation starts with an actual published U entry')
      delete manifest.entries[key]
      f.server.files.set('/'+f.targetConfig.directory+'/manifest.json',Buffer.from(encode(manifest)))
    }
    const requests=f.server.requests.length,rows=exchangeRows(f.B.db),tables=allTables(f.B.db),u=hostRows(f.B.db,f.islands[0]),operation=randomUUID()
    await rejected(()=>f.exchange(f.B,operation),'invalid')
    assert.equal(f.server.requests.length,requests,'A bad whole-state hash is rejected locally before remote reads or any resurrection upload')
    assert.deepEqual(exchangeRows(f.B.db),rows,'A missing baseline row or altered common hash cannot mint a new job or receipt')
    assert.deepEqual(allTables(f.B.db),tables)
    assert.deepEqual(hostRows(f.B.db,f.islands[0]),u,'The original local U content and stable physical identities remain intact')
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operation),undefined)
    assert.ok(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(settled.operationId),'The real original settling receipt remains historical evidence rather than being replaced to repair bad state')
  })
})
