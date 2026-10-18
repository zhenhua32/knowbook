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

test('same-target real protocol5 exchange converges A edits B edits and reopened independent peers without an initial-only resend',()=>withExchange(async f=>{
  const groupId=f.ack.createdLifecycle.groupId,original=remoteActual(f),scopeA=localPortable(f.A).workspaceScope,scopeB=localPortable(f.B).workspaceScope
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' A actual canonical edit'})
  hostEdit(f.A.db,f.islands[0],'A actual ordinary edit')
  const sent=completed(await f.exchange(f.A),'applied')
  assert.ok(sent.publishedKeys.includes('group:'+groupId)&&sent.publishedKeys.includes('doc:'+f.islands[0]),'A sends actual changed group and host keys to its original target')
  const received=completed(await f.exchange(f.B),'applied');assert.ok(received.appliedKeys.includes('group:'+groupId),'B actually installs the changed existing group')
  changeGroup(f.B.db,groupId,blocks=>{blocks[0].content+=' B actual canonical edit'})
  hostEdit(f.B.db,f.islands[1],'B actual ordinary edit')
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied')
  const now=converged(f);assert.equal(now.remote.manifest.workspaceId,original.manifest.workspaceId)
  assert.equal(now.a.workspaceScope,scopeA);assert.equal(now.b.workspaceScope,scopeB)
  f.A.db.close();f.A.db=f.connect(f.A);f.reopen()
  const beforeA=allTables(f.A.db),beforeB=allTables(f.B.db),snapshotA=snapshot(f.A.db,groupId),snapshotB=snapshot(f.B.db,groupId)
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop');converged(f)
  assert.deepEqual(snapshot(f.A.db,groupId),snapshotA);assert.deepEqual(snapshot(f.B.db,groupId),snapshotB)
  assert.deepEqual(f.A.db.prepare('SELECT * FROM blocks ORDER BY id').all(),beforeA.blocks)
  assert.deepEqual(f.B.db.prepare('SELECT * FROM blocks ORDER BY id').all(),beforeB.blocks)
},{assets:true,catalog:true,sameUrl:true,orphan:true}))

test('same-target paired ordinary to canonical transfer adopts actual remote wire birth despite a different first-accepted B ordinary birth',()=>withExchange(async f=>{
  const id=(f.A.db.prepare('SELECT id FROM blocks WHERE document_id=? ORDER BY sort_order LIMIT 1').get(f.islands[0]) as {id:string}).id
  const originalA=physical(f.A.db,id),originalB=physical(f.B.db,id)
  assert.ok(originalA.ordinary&&originalB.ordinary,'The transfer starts with the same actual ordinary id owned in both independent peers')
  assert.notEqual((originalA.ordinary as {created_at:string}).created_at,(originalB.ordinary as {created_at:string}).created_at,
    'B really has its independently accepted physical ordinary birth, not a clone of A')
  const input=createRequest(f.A.db,{documentId:f.islands[0],selectedRootIds:[id]}),ack=created(applySyncedHostCommand(f.A.db,input)),newGroup=ack.createdLifecycle.groupId
  const sent=completed(await f.exchange(f.A),'applied');assert.ok(sent.publishedKeys.includes('group:'+newGroup)&&sent.publishedKeys.includes('doc:'+f.islands[0]),'Release and claim publish in the same actual full manifest')
  completed(await f.exchange(f.B),'applied');const afterA=physical(f.A.db,id),afterB=physical(f.B.db,id)
  assert.equal(afterB.ordinary,undefined);assert.deepEqual(afterB.canonical,afterA.canonical)
  assert.equal((afterB.identity as {last_owner_kind:string}).last_owner_kind,'group')
  assert.equal((afterB.identity as {last_owner_id:string}).last_owner_id,newGroup)
  assert.equal((afterB.identity as {created_at:string}).created_at,(afterA.canonical as {created_at:string}).created_at)
  for(const route of originalB.routes)assert.ok(afterB.routes.some(now=>encode(now)===encode(route)),'Accepted conversion preserves every previously observed route')
  assert.deepEqual(getSyncedOperation(f.A.db,{clientOperationId:input.clientOperationId}),{status:'committed',result:{...ack,replayed:true}})
  converged(f)
}))

test('a group-only incremental update leaves actual host rows placements and orphan groups untouched',()=>withExchange(async f=>{
  const groupId=f.ack.createdLifecycle.groupId,hostA=hostRows(f.A.db,f.host),hostB=hostRows(f.B.db,f.host),orphan=snapshot(f.B.db,f.orphanId!)
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' group-only edit'})
  const sent=completed(await f.exchange(f.A),'applied'),received=completed(await f.exchange(f.B),'applied')
  assert.deepEqual(sent.publishedKeys,['group:'+groupId]);assert.deepEqual(received.appliedKeys,['group:'+groupId])
  assert.deepEqual(hostRows(f.A.db,f.host),hostA);assert.deepEqual(hostRows(f.B.db,f.host),hostB)
  assert.deepEqual(snapshot(f.B.db,f.orphanId!),orphan);assert.equal(orphan.instances.length,0)
  assert.ok(Object.hasOwn(remoteActual(f).manifest.entries,'group:'+f.orphanId),'A live orphan is retained in every complete manifest')
  converged(f)
},{orphan:true}))

test('incremental existing group bindings preserve complete Key target pairs with reversed same-URL historical sources',()=>withExchange(async f=>{
  const groupId=f.ack.createdLifecycle.groupId,before=snapshot(f.A.db,groupId),pairs=before.bindings.filter(b=>b.raw==='Target.md').sort((a,b)=>a.from-b.from)
  assert.deepEqual(pairs.map(b=>b.target),[{kind:'document',id:f.target,state:'live'},{kind:'document',id:f.other,state:'live'}])
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' no URL-based rebinding'})
  completed(await f.exchange(f.A),'applied');completed(await f.exchange(f.B),'applied')
  assert.deepEqual(snapshot(f.B.db,groupId).bindings,snapshot(f.A.db,groupId).bindings)
  assert.deepEqual(snapshot(f.B.db,groupId).bindings.filter(b=>b.raw==='Target.md').sort((a,b)=>a.from-b.from).map(b=>b.target),pairs.map(b=>b.target))
  converged(f)
},{sameUrl:true}))

test('same-target true equal-side noop does not mint group CAS binding birth or executable history',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop')
  const groupId=f.ack.createdLifecycle.groupId,a=snapshot(f.A.db,groupId),b=snapshot(f.B.db,groupId),rowsA=allTables(f.A.db),rowsB=allTables(f.B.db),remote=remoteActual(f)
  const start=f.server.requests.length
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop')
  assert.deepEqual(snapshot(f.A.db,groupId),a);assert.deepEqual(snapshot(f.B.db,groupId),b)
  for(const table of ['blocks','synced_group_blocks','block_identities','synced_instances','synced_group_history','synced_host_history']) {
    assert.deepEqual(allTables(f.A.db)[table],rowsA[table]);assert.deepEqual(allTables(f.B.db)[table],rowsB[table])
  }
  assert.equal(f.server.requests.slice(start).some(r=>r.path.endsWith('/manifest.json')&&(r.method==='PUT'||r.method==='MOVE')),false)
  assert.deepEqual(remoteActual(f).bytes,remote.bytes)
}))

test('diverged group component stays deferred while an unrelated real host publishes and only accepted per-key baseline advances',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop')
  const groupId=f.ack.createdLifecycle.groupId,baseline=stateRow(f.B.db),beforeGroup=baseline.state.baseline.find(b=>b.key==='group:'+groupId)
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' remote choice'})
  hostEdit(f.A.db,f.islands[0],'unrelated remote ordinary change');completed(await f.exchange(f.A),'applied')
  changeGroup(f.B.db,groupId,blocks=>{blocks[0].content+=' offline local choice'})
  const kept=snapshot(f.B.db,groupId),value=completed(await f.exchange(f.B),'applied')
  assert.ok(value.deferred.some(c=>c.keys.includes('group:'+groupId)&&c.keys.includes('doc:'+f.host)),'The conflicted group and its actual ref host remain one deferred component')
  assert.equal(value.acceptedKeys.includes('group:'+groupId),false);assert.equal(value.acceptedKeys.includes('doc:'+f.host),false)
  assert.ok(value.appliedKeys.includes('doc:'+f.islands[0]),'An unrelated component actually proceeds in the same real invocation')
  assert.deepEqual(snapshot(f.B.db,groupId),kept)
  assert.equal(readStrictHostDocument(f.B.db,f.islands[0]).detail.blocks[0].content,'unrelated remote ordinary change')
  const after=stateRow(f.B.db);assert.deepEqual(after.state.baseline.find(b=>b.key==='group:'+groupId),beforeGroup)
  assert.notEqual(after.state.baseline.find(b=>b.key==='doc:'+f.islands[0])?.remoteHash,baseline.state.baseline.find(b=>b.key==='doc:'+f.islands[0])?.remoteHash)
  f.reopen();const repeated=completed(await f.exchange(f.B),'deferred');assert.ok(repeated.deferred.some(c=>c.keys.includes('group:'+groupId)),'Reopening preserves the unresolved original component and its source baseline')
}))

test('real two-peer manifest CAS 412 rereads and replans so two independent ordinary edits both survive',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop')
  hostEdit(f.A.db,f.islands[0],'A first independent write');hostEdit(f.B.db,f.islands[1],'B concurrent independent write')
  const original=remoteActual(f),start=f.server.requests.length,gate=f.gate(r=>r.method==='PUT'&&r.path.endsWith('/manifest.json')&&r.ifMatch===original.etag)
  const a=f.exchange(f.A)
  try {
    await gate.wait(a);completed(await f.exchange(f.B),'applied');const bCommitted=remoteActual(f)
    assert.notEqual(bCommitted.hash,original.hash);gate.release();completed(await a,'applied')
    const writes=f.server.requests.slice(start).filter(r=>r.method==='PUT'&&r.path.endsWith('/manifest.json')&&r.ifMatch)
    assert.ok(writes.length>=3,'One blocked stale manifest CAS and a replanned CAS surround the other peer actual successful write')
    assert.ok(writes.some(r=>r.ifMatch===bCommitted.etag),'A stale writer actually uses the newly reread winning ETag for its replan')
    completed(await f.exchange(f.B),'applied');converged(f)
    assert.equal(readStrictHostDocument(f.A.db,f.islands[0]).detail.blocks[0].content,'A first independent write')
    assert.equal(readStrictHostDocument(f.A.db,f.islands[1]).detail.blocks[0].content,'B concurrent independent write')
  } finally {gate.release();await Promise.allSettled([a])}
}))

test('network-time local edits withdraw the whole affected group component while unrelated incoming work still commits',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop')
  const groupId=f.ack.createdLifecycle.groupId
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' remote before network gate'});hostEdit(f.A.db,f.islands[0],'unrelated accepted across network gate')
  completed(await f.exchange(f.A),'applied');const oldBaseline=stateRow(f.B.db).state.baseline.find(b=>b.key==='group:'+groupId),digest=remoteActual(f).manifest.entries['group:'+groupId]
  const gate=f.gate(r=>r.method==='GET'&&r.path.endsWith('/objects/'+digest+'.json')),job=f.exchange(f.B)
  try {await gate.wait(job);const second=f.connect(f.B);changeGroup(second,groupId,blocks=>{blocks[0].content+=' local second-connection edit'})
    const kept=snapshot(f.B.db,groupId);gate.release();const value=completed(await job,'applied')
    assert.ok(value.deferred.some(c=>c.keys.includes('group:'+groupId)),'A participating source changed during HTTP so its whole component is deferred')
    assert.equal(value.acceptedKeys.includes('group:'+groupId),false);assert.deepEqual(snapshot(f.B.db,groupId),kept)
    assert.equal(readStrictHostDocument(f.B.db,f.islands[0]).detail.blocks[0].content,'unrelated accepted across network gate')
    assert.deepEqual(stateRow(f.B.db).state.baseline.find(b=>b.key==='group:'+groupId),oldBaseline)
  } finally {gate.release();await Promise.allSettled([job])}
}))

test('actual remote manifest success followed by late SQLite failure preserves pending convergence and reopens without remote rollback',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop')
  hostEdit(f.B.db,f.islands[1],'B real incoming row must roll back at A late SQL failure');completed(await f.exchange(f.B),'applied')
  const groupId=f.ack.createdLifecycle.groupId,baseline=stateRow(f.A.db).value
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' A published before local receipt fail'})
  const source=localPortable(f.A),before=remoteActual(f),incomingBefore=hostRows(f.A.db,f.islands[1]),op=randomUUID(),failure=lateReceipt(f.A.db,op,
    {documentId:f.islands[1],content:'B real incoming row must roll back at A late SQL failure'})
  try {
    const error=await rejected(()=>f.exchange(f.A,op),'database'),chain:string[]=[];const seen=new Set<Error>()
    for(let cause:unknown=error;cause instanceof Error&&!seen.has(cause);cause=cause.cause){seen.add(cause);chain.push(cause.message)}
    assert.match(chain.join('\n'),/exchange exact late receipt fixture/)
    assert.ok(failure.seen.length>0&&failure.seen[0].groups>0,'A late real SQL trigger runs after actual graph work rather than failing fixture construction')
    assert.ok(failure.seen.some(witness=>witness.incomingMatches>0),'The trigger observes the actual incoming B physical row inside SQL before deliberately aborting the receipt')
    const published=remoteActual(f);assert.notEqual(published.hash,before.hash)
    assert.deepEqual(published.manifest.entries,{...source.entries,['doc:'+f.islands[1]]:before.manifest.entries['doc:'+f.islands[1]]})
    assert.deepEqual(hostRows(f.A.db,f.islands[1]),incomingBefore,'The genuinely incoming B host SQL is rolled back even though the combined remote manifest already committed')
    assert.equal(stateRow(f.A.db).value,baseline,'Failed local SQL does not advance the accepted per-target baseline')
    assert.equal(f.A.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(op),undefined)
    assert.ok(exchangeRows(f.A.db).settings.some(row=>row.key.includes('exchange-job')),'The real operation retains its prepared or published pending job after SQLite rollback')
  } finally {failure.remove()}
  f.A.db.close();f.A.db=f.connect(f.A);completed(await f.exchange(f.A,op))
  completed(await f.exchange(f.B),'applied');converged(f)
}))

test('real manifest persist-then-disconnect confirms only original bytes and does not create a second semantic publication',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');hostEdit(f.A.db,f.islands[0],'actual lost-ACK content')
  const op=randomUUID(),start=f.server.requests.length;let dropped=false
  f.server.setHook(req=>{if(!dropped&&req.method==='PUT'&&req.path.endsWith('/manifest.json')&&req.ifMatch){dropped=true;return {kind:'persist-then-disconnect'}}})
  const value=completed(await f.exchange(f.A,op),'applied');assert.equal(dropped,true)
  const original=remoteActual(f),before=f.server.requests.length;assert.deepEqual(completed(await f.exchange(f.A,op)),{...value,replayed:true})
  assert.equal(f.server.requests.length,before);assert.deepEqual(remoteActual(f).bytes,original.bytes)
  const puts=f.server.requests.slice(start,before).filter(req=>req.method==='PUT'&&req.path.endsWith('/manifest.json')&&req.ifMatch)
  assert.equal(puts.length,1,'Lost ACK is queried as the original publication fact rather than uploaded again as a new plan')
  completed(await f.exchange(f.B),'applied');converged(f)
}))

test('committed exchange receipt replays zero HTTP after later local edits epoch changes and remote deletion but grants no group source ticket',()=>withExchange(async f=>{
  const op=randomUUID(),first=completed(await f.exchange(f.B,op),'noop')
  hostEdit(f.B.db,f.islands[0],'later actual local state')
  f.B.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
  f.server.files.delete('/'+f.targetConfig.directory+'/manifest.json')
  const start=f.server.requests.length,before=allTables(f.B.db),replayed=completed(await f.exchange(f.B,op))
  assert.deepEqual(replayed,{...first,replayed:true});assert.equal(f.server.requests.length,start);assert.deepEqual(allTables(f.B.db),before)
  assert.throws(()=>getSyncedOperation(f.B.db,{clientOperationId:op}),/收据损坏/)
  assert.throws(()=>getSyncedOperationWithLinkSource(f.B.db,{clientOperationId:op}),Error)
  await rejected(()=>f.track(exchangeSyncedSnapshot(f.B.db,{...f.input(op),target:{...f.targetConfig,directory:'Another target'}},runtime)),'invalid')
  assert.equal(f.server.requests.length,start)
}))

test('bad saved exchange state and corrupt closed receipts fail before HTTP instead of reseeding from today equal content',()=>withExchange(async f=>{
  const op=randomUUID();completed(await f.exchange(f.B,op),'noop');const state=stateRow(f.B.db),before=f.server.requests.length
  f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run('{"kind":"synced-exchange-state","kind":"same"}',state.key)
  await rejected(()=>f.exchange(f.B),'invalid');assert.equal(f.server.requests.length,before)
  f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(state.value,state.key)
  f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run('{"kind":"broken","kind":"duplicate"}',op)
  await rejected(()=>f.exchange(f.B,op),'invalid');assert.equal(f.server.requests.length,before)
}))

test('remote workspace replacement same target is refused rather than laundering the old per-key ancestor into a new authority',()=>withExchange(async f=>{
  completed(await f.exchange(f.B),'noop');const before=localPortable(f.B),state=stateRow(f.B.db).value,path='/'+f.targetConfig.directory+'/manifest.json',remote=remoteActual(f)
  f.server.files.set(path,Buffer.from(encode({...remote.manifest,workspaceId:randomUUID()})))
  await rejected(()=>f.exchange(f.B),'invalid');assert.deepEqual(localPortable(f.B).entries,before.entries);assert.equal(stateRow(f.B.db).value,state)
}))

test('a changed recovery epoch during an actual object read revokes new apply and publish rights without erasing prior observed facts',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop');const groupId=f.ack.createdLifecycle.groupId
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' remote for epoch gate'});completed(await f.exchange(f.A),'applied')
  const facts=f.B.db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all() as Array<{id:string}>
  const digest=remoteActual(f).manifest.entries['group:'+groupId],before=localPortable(f.B),baseline=stateRow(f.B.db).value,gate=f.gate(r=>r.method==='GET'&&r.path.endsWith('/objects/'+digest+'.json')),job=f.exchange(f.B)
  try {await gate.wait(job);f.connect(f.B).prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID());gate.release()
    await rejected(()=>job,'unavailable');assert.deepEqual(localPortable(f.B).entries,before.entries);assert.equal(stateRow(f.B.db).value,baseline)
    for(const fact of facts)assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(fact.id),fact,'A recovery epoch change does not erase an already durable exposure fact')
  } finally {gate.release();await Promise.allSettled([job])}
}))
