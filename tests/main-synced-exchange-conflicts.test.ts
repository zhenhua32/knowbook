import assert from 'node:assert/strict'
import test from 'node:test'
import {withConflicts,diverge,commonGroup,ready,component,side,mergeDecision,completed,changeGroup,hostEdit,snapshot,randomUUID,
  stateRow,localPortable,remoteActual,converged,readonlyRequests,executionRows,request,applySyncedHostFinal,rejected} from './helpers/synced-exchange-conflict-fixture'

test('actual preview is deeply readonly and captures original conflict facts without publishing content advancing baseline or creating an exchange execution',()=>withConflicts(async f=>{
  const id=await diverge(f),before=executionRows(f.B),baseline=stateRow(f.B.db).value,local=localPortable(f.B),remote=remoteActual(f),start=f.server.requests.length
  const p=ready(await f.preview()),c=component(p,'group:'+id)
  assert.equal(p.kind,'synced-exchange-conflict-preview');assert.equal(p.version,1);assert.match(p.previewHash,/^[a-f0-9]{64}$/)
  assert.ok(c.keys.includes('doc:'+f.host)&&c.choices.includes('local')&&c.choices.includes('remote'),'The real preview binds the complete host/group component and actual selectable sides')
  const record=c.records.find(r=>r.key==='group:'+id);assert.ok(record?.baseHash&&record.localHash&&record.remoteHash,'The displayed hashes come from the actual three captured sides')
  assert.equal(record.localHash,local.entries['group:'+id]);assert.equal(record.remoteHash,remote.manifest.entries['group:'+id])
  assert.deepEqual(executionRows(f.B),before);assert.equal(stateRow(f.B.db).value,baseline);assert.deepEqual(remoteActual(f).bytes,remote.bytes)
  readonlyRequests(f.server.requests.slice(start))
  changeGroup(f.B.db,id,b=>{b[0].content+=' later local edit'})
  assert.deepEqual(ready(await f.preview(f.B,p.previewId)),p,'The same preview id reads the original immutable fact instead of laundering a new snapshot into it')
}))

test('actual whole-component local and remote decisions settle original conflicts and retain unrelated accepted work',async()=>{
  for(const choice of ['local','remote'] as const)await withConflicts(async f=>{
    const id=await diverge(f),key='group:'+id,kept=snapshot(f.B.db,id)
    hostEdit(f.A.db,f.islands[0],'unrelated incoming beside '+choice);completed(await f.exchange(f.A),'applied')
    const remote=snapshot(f.A.db,id),p=ready(await f.preview()),c=component(p,key),value=completed(await f.resolve(p,[side(c,choice)]),'applied')
    assert.ok(c.keys.every(k=>value.acceptedKeys.includes(k)),'Selecting one component cannot accept only its group while silently omitting a dependency')
    assert.deepEqual(snapshot(f.B.db,id).blocks,(choice==='local'?kept:remote).blocks)
    assert.deepEqual(snapshot(f.B.db,id).bindings,(choice==='local'?kept:remote).bindings)
    const {readStrictHostDocument}=await import('./helpers/synced-exchange-fixture')
    assert.equal(readStrictHostDocument(f.B.db,f.islands[0]).detail.blocks[0].content,'unrelated incoming beside '+choice)
    assert.equal(stateRow(f.B.db).state.baseline.find(r=>r.key===key)?.commonHash,remoteActual(f).manifest.entries[key])
    completed(await f.exchange(f.A));converged(f)
  })
})

test('actual custom merge resolves only the original text overlap and keeps automatic summary changes including exact custom whitespace',()=>withConflicts(async f=>{
  const id=f.islands[0],input=request(f.A.db,[id],sides=>{sides[0].summary='Remote independent summary';sides[0].blocks[0].content='REMOTE overlap'})
  assert.equal(applySyncedHostFinal(f.A.db,input).status,'applied');completed(await f.exchange(f.A),'applied');hostEdit(f.B.db,id,'LOCAL overlap')
  const p=ready(await f.preview()),c=component(p,'doc:'+id),wanted='  chosen 😀 exact text\nwith trailing spaces  '
  const decision=mergeDecision(c,part=>{assert.equal(part.field,'block-content');assert.equal(part.canEditText,true);return {choice:'custom',text:wanted}})
  completed(await f.resolve(p,[decision]),'applied')
  const {readStrictHostDocument}=await import('./helpers/synced-exchange-fixture'),actual=readStrictHostDocument(f.B.db,id).detail
  assert.equal(actual.blocks[0].content,wanted);assert.equal(actual.summary,'Remote independent summary')
  completed(await f.exchange(f.A),'applied');converged(f)
}))

test('actual resolve rejects unknown both duplicate unsorted and caller-forest decisions without creating an execution or changing either side',()=>withConflicts(async f=>{
  const id=await diverge(f);hostEdit(f.A.db,f.islands[0],'REMOTE other overlap');completed(await f.exchange(f.A),'applied');hostEdit(f.B.db,f.islands[0],'LOCAL other overlap')
  const p=ready(await f.preview()),c=component(p,'group:'+id),other=component(p,'doc:'+f.islands[0]),valid=side(c,'local'),sorted=[valid,side(other,'remote')].sort((a,b)=>a.componentId<b.componentId?-1:a.componentId>b.componentId?1:0),before=executionRows(f.B),remote=remoteActual(f).bytes,local=localPortable(f.B).entries
  const invalid:unknown[]=[
    [{...valid,choice:'both'}],[{...valid,choice:'clear'}],[{...valid,forest:[]}],[{...valid,componentId:'f'.repeat(64)}],
    [valid,valid],[...sorted].reverse(),[{componentId:c.componentId,choice:'merge',records:[]}],
    [{componentId:c.componentId,choice:'merge',records:[{key:'group:'+id,parts:[{id:'not-an-original-part',value:{choice:'remote'}}]}]}]
  ]
  for(const decisions of invalid){await rejected(()=>f.resolve(p,decisions as never),'invalid');assert.deepEqual(executionRows(f.B),before);assert.deepEqual(localPortable(f.B).entries,local);assert.deepEqual(remoteActual(f).bytes,remote)}
  const getter={componentId:c.componentId,get choice(){throw new Error('Caller decision getter must never execute')}}
  await rejected(()=>f.resolve(p,[getter] as never),'invalid');assert.deepEqual(executionRows(f.B),before)
  completed(await f.resolve(p,[valid]),'applied')
}))

test('merge selectors cover exactly unresolved records and reject selectors for an automatically resolved host in the same real group component',()=>withConflicts(async f=>{
  const ordinary=randomUUID(),add=request(f.A.db,[f.host],sides=>sides[0].blocks.push({id:ordinary,type:'paragraph',content:'host base',checked:false,depth:0,parentBlockId:null}))
  assert.equal(applySyncedHostFinal(f.A.db,add).status,'applied');completed(await f.exchange(f.A),'applied');completed(await f.exchange(f.B),'applied')
  const id=await diverge(f),remoteHost=request(f.A.db,[f.host],sides=>{sides[0].summary='remote automatic host summary'})
  assert.equal(applySyncedHostFinal(f.A.db,remoteHost).status,'applied');completed(await f.exchange(f.A),'applied');hostEdit(f.B.db,f.host,'local automatic host body')
  const p=ready(await f.preview()),c=component(p,'group:'+id),decision=mergeDecision(c,()=>({choice:'remote'}))
  assert.equal(decision.choice,'merge');if(decision.choice!=='merge')throw new Error('Expected exact merge selectors')
  assert.deepEqual(decision.records.map(r=>r.key),['group:'+id],'Only the still-unresolved group requires explicit selectors')
  const automatic=c.records.find(r=>r.key==='doc:'+f.host);assert.ok(automatic?.merge&&automatic.merge.unresolved.length===0,'The host was genuinely auto-merged inside this captured conflict component')
  const redundant={...decision,records:[...decision.records,{key:'doc:'+f.host,parts:[]}].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)},before=executionRows(f.B)
  await rejected(()=>f.resolve(p,[redundant]),'invalid');assert.deepEqual(executionRows(f.B),before)
  const incomplete=structuredClone(decision);incomplete.records[0].parts=[];await rejected(()=>f.resolve(p,[incomplete]),'invalid')
  const duplicate=structuredClone(decision);duplicate.records[0].parts.push(duplicate.records[0].parts[0]);await rejected(()=>f.resolve(p,[duplicate]),'invalid')
  completed(await f.resolve(p,[decision]),'applied');completed(await f.exchange(f.A),'applied');converged(f)
}))

test('actual structural merge part selects an entire original forest and binding side rather than splicing new and old children',async()=>{
  for(const choice of ['local','remote'] as const)await withConflicts(async f=>{
    completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop');const id=f.ack.createdLifecycle.groupId
    changeGroup(f.A.db,id,blocks=>{blocks.push({id:randomUUID(),type:'paragraph',content:'real remote extra child',checked:false,depth:0,parentBlockId:null,createdAt:blocks[0].createdAt})});completed(await f.exchange(f.A),'applied')
    changeGroup(f.B.db,id,blocks=>{blocks[0].content+=' local conflicting existing child'})
    const expected=snapshot((choice==='local'?f.B:f.A).db,id),p=ready(await f.preview()),c=component(p,'group:'+id),record=c.records.find(r=>r.key==='group:'+id)
    assert.ok(record?.merge?.unresolved.some(part=>part.field==='blocks'&&!part.canEditText),'The actual incompatible skeleton exposes an atomic forest conflict')
    const decision=mergeDecision(c,part=>{assert.equal(part.field,'blocks');return {choice}})
    completed(await f.resolve(p,[decision]),'applied');const result=snapshot(f.B.db,id)
    assert.deepEqual(result.blocks,expected.blocks);assert.deepEqual(result.bindings,expected.bindings)
    completed(await f.exchange(f.A));converged(f)
  },{sameUrl:true})
})

test('real individually valid parent sides never advertise a cyclic mixed merge while either offered whole side resolves to a legal tree',async()=>{
  const {withIncomingFixture,accepted,receiveInitialSyncedSnapshot}=await import('./helpers/synced-initial-incoming-fixture')
  const {KnowbookStore}=await import('../src/main/database/store')
  const {previewSyncedExchangeConflicts,resolveSyncedExchangeConflicts}=await import('../src/main/sync/synced-exchange')
  const {exchangeSyncedSnapshot,createRequest,created,applySyncedHostCommand,runtime,readStrictHostDocument}=await import('./helpers/synced-exchange-fixture')
  for(const choice of ['local','remote'] as const)await withIncomingFixture(async f=>{
    const A=f.newPristine('cycle-remote-'+choice),B=f.newPristine('cycle-local-'+choice)
    // Both real Store instances are opened while these independent profiles have no groups.
    // Holding them for ordinary Main moves does not remove the production group admission gate.
    const remoteStore=new KnowbookStore(A.file),localStore=new KnowbookStore(B.file)
    try {
      const alpha=remoteStore.createDocument(null),beta=remoteStore.createDocument(null),groupHost=remoteStore.createDocument(null)
      const alphaBlock=randomUUID(),betaBlock=randomUUID(),groupBlock=randomUUID()
      for(const [documentId,blockId,title] of [[alpha,alphaBlock,'Alpha'],[beta,betaBlock,'Beta'],[groupHost,groupBlock,'Unrelated group host']])
        remoteStore.updateDocument(documentId,{title,summary:'Unchanged ordinary metadata',blocks:[{id:blockId,type:'paragraph',content:'base '+title,checked:false,depth:0,parentBlockId:null}]})
      created(applySyncedHostCommand(A.db,createRequest(A.db,{documentId:groupHost,selectedRootIds:[groupBlock]})))
      await f.send(A);accepted(await f.track(receiveInitialSyncedSnapshot(B.db,f.input(randomUUID(),B),runtime)))
      const exchange=(profile:typeof A)=>f.track(exchangeSyncedSnapshot(profile.db,f.input(randomUUID(),profile),runtime))
      completed(await exchange(A),'noop');completed(await exchange(B),'noop')
      const common=localPortable(B).entries,remoteCommon=localPortable(A).entries;assert.deepEqual(common,remoteCommon,'Both independent peers really settled the same complete common graph')
      remoteStore.moveDocument(beta,alpha)
      const remoteAlpha=remoteStore.getDocumentDetail(alpha);assert.ok(remoteAlpha,'The genuine remote ordinary parent exists before its supported content edit')
      remoteStore.updateDocument(alpha,{title:remoteAlpha.title,summary:remoteAlpha.summary,blocks:remoteAlpha.blocks.map(b=>b.id===alphaBlock?{...b,content:'REMOTE conflicting alpha'}:b)})
      completed(await exchange(A),'applied')
      localStore.moveDocument(alpha,beta)
      const localAlpha=localStore.getDocumentDetail(alpha);assert.ok(localAlpha,'The genuine local ordinary child exists before its supported content edit')
      localStore.updateDocument(alpha,{title:localAlpha.title,summary:localAlpha.summary,blocks:localAlpha.blocks.map(b=>b.id===alphaBlock?{...b,content:'LOCAL conflicting alpha'}:b)})
      assert.equal(readStrictHostDocument(A.db,beta).parentId,alpha);assert.equal(readStrictHostDocument(A.db,alpha).parentId,null)
      assert.equal(readStrictHostDocument(B.db,alpha).parentId,beta);assert.equal(readStrictHostDocument(B.db,beta).parentId,null)
      const previewId=randomUUID(),p=ready(await f.track(previewSyncedExchangeConflicts(B.db,{previewId,userDataRoot:B.root,target:f.targetConfig},runtime))),c=component(p,'doc:'+alpha)
      assert.ok(c.keys.includes('doc:'+beta),'Real parent dependencies close the two host records into the same exact component')
      assert.equal(c.choices.includes('merge'),false,'Choosing the automatic local A.parentId and remote B.parentId would make a cycle and cannot be advertised as an executable merge')
      assert.ok(c.choices.includes('local')&&c.choices.includes('remote'),'Both original complete sides remain legal selectable forests')
      completed(await f.track(resolveSyncedExchangeConflicts(B.db,{...f.input(randomUUID(),B),previewId,decisions:[side(c,choice)]},runtime)),'applied')
      assert.equal(readStrictHostDocument(B.db,alpha).parentId,choice==='local'?beta:null)
      assert.equal(readStrictHostDocument(B.db,beta).parentId,choice==='local'?null:alpha)
      assert.equal(readStrictHostDocument(B.db,alpha).detail.blocks[0].content,choice==='local'?'LOCAL conflicting alpha':'REMOTE conflicting alpha')
      completed(await exchange(A));converged({...f,A,B})
    }finally{localStore.destroy();remoteStore.destroy()}
  })
})
