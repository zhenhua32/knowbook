import assert from 'node:assert/strict'
import test from 'node:test'
import {getSyncedOperation} from '../src/main/database/synced-blocks-content'
import {command,insertAck} from './helpers/synced-host-command-insert-fixture'
import {withConflicts,diverge,ready,component,side,mergeDecision,completed,changeGroup,hostEdit,snapshot,randomUUID,allTables,
  stateRow,localPortable,remoteActual,executionRows,applySyncedHostCommand,rejected,lateReceipt,encode,mutateRemote} from './helpers/synced-exchange-conflict-fixture'

test('a changed-back CAS or real new-reference topology invalidates the original explicit component despite an unchanged group portable hash',async()=>{
  for(const drift of ['changed-back','new-reference'] as const)await withConflicts(async f=>{
    const id=await diverge(f),key='group:'+id;hostEdit(f.A.db,f.islands[1],'unrelated incoming after guarded selection');completed(await f.exchange(f.A),'applied')
    const p=ready(await f.preview()),c=component(p,key),digest=localPortable(f.B).entries[key],baseline=stateRow(f.B.db).state.baseline.find(r=>r.key===key)
    if(drift==='changed-back'){const text=snapshot(f.B.db,id).blocks[0].content;changeGroup(f.B.db,id,b=>{b[0].content+=' temporary'});changeGroup(f.B.db,id,b=>{b[0].content=text})}
    else insertAck(applySyncedHostCommand(f.B.db,command(f.B.db,{documentId:f.islands[0],groupId:id})))
    assert.equal(localPortable(f.B).entries[key],digest,'The actual group portable bytes are unchanged while its real authority/dependency guard changed')
    const before=snapshot(f.B.db,id),value=completed(await f.resolve(p,[side(c,'remote')]),'applied')
    assert.ok(value.deferred.some(v=>v.keys.includes(key)),'The original component selector is not authority for a changed-back CAS or expanded real topology')
    assert.equal(value.acceptedKeys.includes(key),false);assert.deepEqual(snapshot(f.B.db,id),before)
    assert.deepEqual(stateRow(f.B.db).state.baseline.find(r=>r.key===key),baseline)
    const {readStrictHostDocument}=await import('./helpers/synced-exchange-fixture')
    assert.equal(readStrictHostDocument(f.B.db,f.islands[1]).detail.blocks[0].content,'unrelated incoming after guarded selection')
  })
})

test('actual local editing during resolve HTTP withdraws only the selected component and keeps independent accepted work',()=>withConflicts(async f=>{
  const id=await diverge(f),key='group:'+id;hostEdit(f.A.db,f.islands[0],'independent incoming across selection await');completed(await f.exchange(f.A),'applied')
  const p=ready(await f.preview()),c=component(p,key),old=stateRow(f.B.db).state.baseline.find(r=>r.key===key),gate=f.gate(r=>r.method==='GET'&&r.path.endsWith('/manifest.json')),job=f.resolve(p,[side(c,'remote')])
  try{await gate.wait(job);const peer=f.connect(f.B);changeGroup(peer,id,b=>{b[0].content+=' real edit during resolve'})
    const before=snapshot(f.B.db,id);gate.release();const value=completed(await job,'applied')
    assert.ok(value.deferred.some(v=>v.keys.includes(key)),'An actual await-time edit revokes the old complete selection')
    assert.equal(value.acceptedKeys.includes(key),false);assert.deepEqual(snapshot(f.B.db,id),before);assert.deepEqual(stateRow(f.B.db).state.baseline.find(r=>r.key===key),old)
    assert.ok(value.appliedKeys.includes('doc:'+f.islands[0]),'An unrelated real incoming island still commits in the same invocation')
  }finally{gate.release();await Promise.allSettled([job])}
}))

test('a recovery epoch change while resolve awaits real metadata revokes new writes but keeps prior observed exposure facts',()=>withConflicts(async f=>{
  const id=await diverge(f),p=ready(await f.preview()),c=component(p,'group:'+id),baseline=stateRow(f.B.db).value,before=snapshot(f.B.db,id)
  const facts=f.B.db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all(),op=randomUUID(),gate=f.gate(r=>r.method==='GET'&&r.path.endsWith('/manifest.json')),job=f.resolve(p,[side(c,'remote')],op)
  try{await gate.wait(job);f.B.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID());gate.release();await rejected(()=>job,'unavailable')
    assert.equal(stateRow(f.B.db).value,baseline);assert.deepEqual(snapshot(f.B.db,id),before)
    const now=f.B.db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all()
    for(const fact of facts)assert.ok(now.some(row=>encode(row)===encode(fact)),'Epoch expiry does not erase an already durable exposure fact')
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(op),undefined)
  }finally{gate.release();await Promise.allSettled([job])}
}))

test('a real manifest 412 keeps the newer remote conflict and invalidates only the old selected component instead of silently applying its choice to a new R',()=>withConflicts(async f=>{
  const id=await diverge(f),key='group:'+id;hostEdit(f.B.db,f.islands[0],'independent outgoing under selected 412')
  const p=ready(await f.preview()),c=component(p,key),original=remoteActual(f),before=snapshot(f.B.db,id),gate=f.gate(r=>r.method==='PUT'&&r.path.endsWith('/manifest.json')&&r.ifMatch===original.etag)
  const job=f.resolve(p,[side(c,'local')])
  try{await gate.wait(job);changeGroup(f.A.db,id,b=>{b[0].content='REMOTE newest while original selected publication is waiting'});completed(await f.exchange(f.A),'applied')
    const winning=remoteActual(f),winningHash=winning.manifest.entries[key];gate.release();const value=completed(await job,'applied')
    assert.ok(value.deferred.some(v=>v.keys.includes(key)),'A stale explicit choice remains tied to its original remote hash through a real CAS replan')
    assert.equal(value.acceptedKeys.includes(key),false);assert.deepEqual(snapshot(f.B.db,id),before)
    assert.equal(remoteActual(f).manifest.entries[key],winningHash);assert.ok(value.publishedKeys.includes('doc:'+f.islands[0]),'An independent outgoing island can still publish against the winning ETag')
  }finally{gate.release();await Promise.allSettled([job])}
}))

test('remote-confirmed selected merge survives a late real receipt failure with unchanged baseline and resumes the original operation after reopening',()=>withConflicts(async f=>{
  const id=await diverge(f),key='group:'+id;hostEdit(f.A.db,f.islands[0],'actual incoming row before merge receipt failure');completed(await f.exchange(f.A),'applied')
  const p=ready(await f.preview()),c=component(p,key),decision=mergeDecision(c,()=>({choice:'custom',text:'new exact merged result published before SQL receipt'})),op=randomUUID()
  const baseline=stateRow(f.B.db).value,kept=snapshot(f.B.db,id),remote=remoteActual(f),failure=lateReceipt(f.B.db,op,{documentId:f.islands[0],content:'actual incoming row before merge receipt failure'})
  try{await rejected(()=>f.resolve(p,[decision],op),'database')
    assert.ok(failure.seen.some(v=>v.incomingMatches>0),'The actual late SQL scalar witness observes a real installed incoming row before receipt failure')
    assert.notEqual(remoteActual(f).hash,remote.hash,'The selected new merge really reached the remote manifest before local SQL rolled back')
    assert.deepEqual(snapshot(f.B.db,id),kept);assert.equal(stateRow(f.B.db).value,baseline)
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(op),undefined)
    assert.ok(executionRows(f.B).settings.some(row=>row.key.includes(op)&&row.key.includes('exchange-job')),'The actual remote-confirmed pending job remains available for recovery')
  }finally{failure.remove()}
  f.reopen();const settled=completed(await f.resolve(p,[decision],op),'applied')
  assert.equal(snapshot(f.B.db,id).blocks[0].content,'new exact merged result published before SQL receipt')
  const requests=f.server.requests.length;assert.deepEqual(completed(await f.resolve(p,[decision],op)),{...settled,replayed:true});assert.equal(f.server.requests.length,requests)
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_operations WHERE client_operation_id=?').get(op) as {n:number}).n,1)
}))

test('committed resolve receipt replays its exact original selectors with zero HTTP after edits epoch change and remote deletion while changed selectors reject',()=>withConflicts(async f=>{
  const id=await diverge(f),p=ready(await f.preview()),c=component(p,'group:'+id),decision=side(c,'remote'),op=randomUUID(),first=completed(await f.resolve(p,[decision],op),'applied')
  changeGroup(f.B.db,id,b=>{b[0].content+=' later real local branch'});f.B.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
  f.server.files.delete('/'+f.targetConfig.directory+'/manifest.json');const before=allTables(f.B.db),requests=f.server.requests.length
  assert.deepEqual(completed(await f.resolve(p,[decision],op)),{...first,replayed:true});assert.deepEqual(allTables(f.B.db),before);assert.equal(f.server.requests.length,requests)
  await rejected(()=>f.resolve(p,[{componentId:c.componentId,choice:'local'}],op),'invalid');assert.equal(f.server.requests.length,requests)
  assert.throws(()=>getSyncedOperation(f.B.db,{clientOperationId:op}),/收据损坏/)
}))

test('a tampered actual preview index fails before any resolve HTTP or new execution rather than recreating current authorization',()=>withConflicts(async f=>{
  const id=await diverge(f),p=ready(await f.preview()),c=component(p,'group:'+id),key='sync.webdav.protocol5.exchange-preview.v1.'+p.previewId
  const row=f.B.db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(key) as {key:string;value:string;updated_at:string}|undefined
  assert.ok(row,'The actual preview writer persisted its own original immutable index')
  const invalid=JSON.parse(row.value) as {previewHash:string};invalid.previewHash=(invalid.previewHash[0]==='0'?'1':'0')+invalid.previewHash.slice(1)
  f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(invalid),key)
  const before=allTables(f.B.db),requests=f.server.requests.length;await rejected(()=>f.resolve(p,[side(c,'remote')]),'invalid')
  assert.equal(f.server.requests.length,requests);assert.deepEqual(allTables(f.B.db),before)
}))

test('a strictly read foreign tombstone offers no local remote merge or both bypass and keeps independent live work available',()=>withConflicts(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop');const id=f.ack.createdLifecycle.groupId,key='group:'+id,remote=remoteActual(f),original=remote.records.find(r=>r.key===key)
  assert.ok(original?.record.kind==='synced-group','The foreign finite deletion is derived from the actual published incarnation')
  if(original.record.kind!=='synced-group')throw new Error('Expected the actual original live group')
  const creationId=original.record.creationId
  for(const {key,record} of remote.records)if(record.kind==='document'&&record.content.blocks.some((b:{type:string;content:string})=>b.type==='synced-block'&&JSON.parse(b.content).groupId===id))
    mutateRemote(f.server,f.targetConfig.directory,key,record=>{record.content.blocks=record.content.blocks.filter((b:{type:string;content:string})=>b.type!=='synced-block'||JSON.parse(b.content).groupId!==id)
      if(!record.content.blocks.length)record.content.blocks=[{id:randomUUID(),type:'paragraph',content:'Explicit foreign surviving paragraph',checked:false,depth:0,parentBlockId:null}]})
  mutateRemote(f.server,f.targetConfig.directory,key,record=>{for(const key of Object.keys(record))delete record[key];Object.assign(record,{kind:'synced-group-deleted',id,creationId,previousHash:remote.manifest.entries[key],deletedAt:'2026-10-18T00:00:00.000Z'})})
  const path='/'+f.targetConfig.directory+'/manifest.json',bytes=f.server.files.get(path);assert.ok(bytes,'The actual strict foreign fixture retains its original full manifest')
  const manifest=JSON.parse(bytes.toString());manifest.syncedInstances=manifest.syncedInstances.filter((v:{groupId:string})=>v.groupId!==id);f.server.files.set(path,Buffer.from(encode(manifest)))
  const kept=snapshot(f.B.db,id),baseline=stateRow(f.B.db).value,p=ready(await f.preview()),c=component(p,key)
  assert.equal(c.reason,'tombstone');assert.deepEqual(c.choices,[])
  for(const choice of ['local','remote','merge','both'])await rejected(()=>f.resolve(p,[{componentId:c.componentId,choice}] as never),'invalid')
  assert.deepEqual(snapshot(f.B.db,id),kept);assert.equal(stateRow(f.B.db).value,baseline)
}))

test('a genuine successful merge cannot launder a jointly changed or wholly removed receipt and job merge proof while immutable inputs head and phases remain original',async()=>{
  for(const corruption of ['joint-base-hash','joint-remove-merges'] as const)await withConflicts(async f=>{
    const id=await (await import('./helpers/synced-exchange-conflict-fixture')).commonGroup(f)
    changeGroup(f.A.db,id,b=>{b[0].content='ALPHA middle omega'});completed(await f.exchange(f.A),'applied')
    changeGroup(f.B.db,id,b=>{b[0].content='alpha middle OMEGA'});const op=randomUUID(),accepted=completed(await f.exchange(f.B,op),'applied')
    assert.equal(snapshot(f.B.db,id).blocks[0].content,'ALPHA middle OMEGA','The positive producer actually completed a new merged result before any stored-proof mutation')
    const row=f.B.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(op) as {result_json:string}|undefined
    assert.ok(row,'The real successful merge owns its original persisted operation receipt')
    const receipt=JSON.parse(row.result_json) as {version:number;provenance:{attemptId:string;merges:Array<{key:string;baseHash:string}>}}
    assert.equal(receipt.version,2);assert.ok(receipt.provenance.merges.some(m=>m.key==='group:'+id),'The real successful operation has a nonempty authenticated group merge provenance')
    const candidates=f.B.db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-job.v1.%' ORDER BY key").all() as Array<{key:string;value:string;updated_at:string}>
    const originalJob=candidates.find(r=>{const value=JSON.parse(r.value) as {kind:string;request:{operationId:string};attemptId:string};return value.kind==='synced-exchange-job'&&value.request.operationId===op&&value.attemptId===receipt.provenance.attemptId})
    assert.ok(originalJob,'The receipt points to its actual immutable attempt from the same real successful producer')
    const job=JSON.parse(originalJob.value) as {version:number;merges:Array<{key:string;baseHash:string}>};assert.equal(job.version,2);assert.deepEqual(job.merges,receipt.provenance.merges)
    const before=allTables(f.B.db),withoutTargets=(value:Record<string,unknown>)=>({...value,
      app_settings:(value.app_settings as Array<{key:string}>).filter(r=>r.key!==originalJob.key),
      synced_operations:(value.synced_operations as Array<{client_operation_id:string}>).filter(r=>r.client_operation_id!==op)})
    if(corruption==='joint-remove-merges'){job.merges=[];receipt.provenance.merges=[]}
    else {const actual=receipt.provenance.merges.find(m=>m.key==='group:'+id);assert.ok(actual,'The targeted real merged group has its own original common-source hash')
      const changed=(actual.baseHash[0]==='0'?'1':'0')+actual.baseHash.slice(1);actual.baseHash=changed
      const other=job.merges.find(m=>m.key==='group:'+id);assert.ok(other,'The same real job has the corresponding original merge entry');other.baseHash=changed}
    f.B.db.transaction(()=>{f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(job),originalJob.key)
      f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(receipt),op)})()
    const corrupted=allTables(f.B.db);assert.deepEqual(withoutTargets(corrupted),withoutTargets(before),'The real original head phase chain state journal and all other SQL rows remain exact; only the two mutually corroborating JSON facts changed')
    const requests=f.server.requests.length;await rejected(()=>f.exchange(f.B,op),'invalid')
    assert.equal(f.server.requests.length,requests,'Corrupt historical merge provenance is refused before any network access instead of entering a new plan')
    assert.deepEqual(allTables(f.B.db),corrupted,'Rejecting a forged historical receipt never repairs the job or alters accepted knowledge')
    assert.equal(accepted.operationId,op)
  })
})
