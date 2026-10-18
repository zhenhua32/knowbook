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

test('a raw history cursor change at the new outgoing group object HEAD defers G before publication while unrelated U is received',()=>withExchange(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop')
  const groupId=f.ack.createdLifecycle.groupId,originalRemote=remoteActual(f),originalGroupHash=originalRemote.manifest.entries['group:'+groupId]
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' actual outgoing G guarded by raw history cursor'})
  hostEdit(f.B.db,f.islands[0],'B real U update across raw cursor-only race');completed(await f.exchange(f.B),'applied')
  const localGroup=snapshot(f.A.db,groupId),outgoingHash=localPortable(f.A).entries['group:'+groupId]
  assert.notEqual(outgoingHash,originalGroupHash,'The gate targets a genuinely new outgoing G object, not the first remote GET')
  assert.equal(remoteActual(f).manifest.entries['group:'+groupId],originalGroupHash)
  const previousAttempts=new Set((f.A.db.prepare("SELECT id FROM synced_exposure_attempts WHERE channel='webdav-manifest5-exchange'").all() as Array<{id:string}>).map(row=>row.id))
  const gate=f.gate(request=>request.method==='HEAD'&&request.path.endsWith('/objects/'+outgoingHash+'.json')),job=f.exchange(f.A)
  try {
    await gate.wait(job)
    const possible=(f.A.db.prepare("SELECT * FROM synced_exposure_attempts WHERE channel='webdav-manifest5-exchange' AND state='possible' ORDER BY id").all() as Array<{id:string;state:string}>)
      .filter(row=>!previousAttempts.has(row.id))
    assert.ok(possible.length>0,'A genuine durable possible publication precedes the new knowledge-object HEAD')
    const rawBefore=f.A.db.prepare('SELECT * FROM synced_groups WHERE id=?').get(groupId) as Record<string,unknown>
    assert.ok(rawBefore,'The late race starts from the actual persisted outgoing group row')
    const cursor=randomUUID(),second=f.connect(f.A)
    second.prepare('UPDATE synced_groups SET history_cursor=? WHERE id=?').run(cursor,groupId)
    assert.deepEqual(f.A.db.prepare('SELECT * FROM synced_groups WHERE id=?').get(groupId),{...rawBefore,history_cursor:cursor},
      'The concurrent fault changes only raw history_cursor rather than portable semantics or revision')
    gate.release();const value=completed(await job,'applied')
    assert.ok(value.deferred.some(component=>component.keys.includes('group:'+groupId)),'The consumed raw key guard withdraws the entire affected G component before remote CAS')
    assert.equal(value.publishedKeys.includes('group:'+groupId),false);assert.equal(value.acceptedKeys.includes('group:'+groupId),false)
    assert.equal(remoteActual(f).manifest.entries['group:'+groupId],originalGroupHash,'The old plan never publishes the new G hash before discovering the raw cursor race')
    assert.equal(readStrictHostDocument(f.A.db,f.islands[0]).detail.blocks[0].content,'B real U update across raw cursor-only race')
    assert.ok(value.appliedKeys.includes('doc:'+f.islands[0]),'The unrelated real incoming U still settles in the same invocation')
    assert.deepEqual(snapshot(f.A.db,groupId).blocks,localGroup.blocks)
    for(const attempt of possible)assert.deepEqual(f.A.db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(attempt.id),attempt,
      'Withdrawing an outgoing component never deletes or launders its already durable possible evidence')
  } finally {gate.release();await Promise.allSettled([job])}
}))

test('a genuine replacement receipt detects deletion of its whole archived group history index and rows before any next HTTP',()=>withExchange(async f=>{
  const groupId=f.ack.createdLifecycle.groupId
  changeGroup(f.B.db,groupId,blocks=>{blocks[0].content+=' B real local history before archive'})
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied')
  changeGroup(f.A.db,groupId,blocks=>{blocks[0].content+=' A real replacement that archives B branch'})
  completed(await f.exchange(f.A),'applied');const accepted=completed(await f.exchange(f.B),'applied')
  type SavedSetting={key:string;value:string;updated_at:string}
  const allIndexes=f.B.db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-history-index.v1.%' ORDER BY key").all() as SavedSetting[]
  const indexes=allIndexes.filter(row=>(JSON.parse(row.value) as {groupId:string}).groupId===groupId)
  assert.ok(indexes.length>0,'The positive actual remote replacement has already produced a real nonempty archive index')
  const own=indexes.find(row=>(JSON.parse(row.value) as {operationId:string}).operationId===accepted.operationId)
  assert.ok(own,'The exact real receiving operation owns its actual group history archive index')
  const archive=JSON.parse(own.value) as {operationId:string;groupId:string;rows:Array<{id:string;hash:string}>}
  assert.ok(archive.rows.length>0,'The archive contains actual prior local group journal rows, not an empty fabricated index')
  const rowPrefix='sync.webdav.protocol5.exchange-history-row.v1.'+accepted.operationId+'.'+groupId+'.'
  const ownRows=f.B.db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=? ORDER BY key').all(rowPrefix.length,rowPrefix) as SavedSetting[]
  assert.equal(ownRows.length,archive.rows.length)
  for(const entry of archive.rows) {
    const row=ownRows.find(value=>value.key===rowPrefix+entry.id)
    assert.ok(row,'Each real immutable index entry has its actual persisted source row before corruption')
    assert.equal(hash(row.value),entry.hash)
  }
  const receipt=f.B.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(accepted.operationId)
  assert.ok(receipt,'The exact original receiving receipt is present before deleting its entire archive set')
  const knowledge=snapshot(f.B.db,groupId)
  const allRows=f.B.db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-history-row.v1.%' ORDER BY key").all() as SavedSetting[]
  const groupRows=allRows.filter(row=>(JSON.parse(row.value) as {groupId:string}).groupId===groupId)
  assert.ok(groupRows.length>0,'The targeted group owns real archived rows before the whole-set deletion fault')
  f.B.db.transaction(()=>{for(const row of [...indexes,...groupRows])f.B.db.prepare('DELETE FROM app_settings WHERE key=?').run(row.key)})()
  const requests=f.server.requests.length,before=allTables(f.B.db),rows=exchangeRows(f.B.db),operation=randomUUID()
  await rejected(()=>f.exchange(f.B,operation),'invalid')
  assert.equal(f.server.requests.length,requests,'Receipt-to-archive reverse closure is checked before any next remote read')
  assert.deepEqual(exchangeRows(f.B.db),rows,'An erased archive set cannot be treated as absent history and cannot mint another job or receipt')
  assert.deepEqual(allTables(f.B.db),before);assert.deepEqual(snapshot(f.B.db,groupId),knowledge)
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(accepted.operationId),receipt,
    'The original receipt is neither removed nor rewritten to launder missing archive evidence')
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operation),undefined)
}))

test('a real parent rename updates unchanged descendant paths and preserves old routes while registering new accepted routes without changing content ownership or birth',async()=>{
  const {withIncomingFixture,accepted,receiveInitialSyncedSnapshot}=await import('./helpers/synced-initial-incoming-fixture')
  const {KnowbookStore}=await import('../src/main/database/store')
  await withIncomingFixture(async f=>{
    const A=f.newPristine('parent-rename-A'),B=f.newPristine('parent-rename-B')
    // Store is legitimately opened before this isolated source has any group.
    // Holding that real instance for an ordinary-page edit does not open the production any-group gate.
    const store=new KnowbookStore(A.file)
    try {
      const parent=store.createDocument(null),parentBlock=randomUUID()
      store.updateDocument(parent,{title:'Route Parent',summary:'Parent summary remains',blocks:[{id:parentBlock,type:'paragraph',content:'Unchanged parent body',checked:false,depth:0,parentBlockId:null}]})
      const child=store.createDocument(parent),childBlock=randomUUID()
      store.updateDocument(child,{title:'Route Child',summary:'Child summary remains',blocks:[{id:childBlock,type:'paragraph',content:'Unchanged child body',checked:false,depth:0,parentBlockId:null}]})
      const grandchild=store.createDocument(child),grandchildBlock=randomUUID()
      store.updateDocument(grandchild,{title:'Route Grandchild',summary:'Grandchild summary remains',blocks:[{id:grandchildBlock,type:'paragraph',content:'Unchanged grandchild body',checked:false,depth:0,parentBlockId:null}]})
      const groupHost=store.createDocument(null),groupBlock=randomUUID()
      store.updateDocument(groupHost,{title:'Independent Group Host',summary:'Independent canonical source',blocks:[{id:groupBlock,type:'paragraph',content:'Real untouched canonical body',checked:false,depth:0,parentBlockId:null}]})
      const creation=created(applySyncedHostCommand(A.db,createRequest(A.db,{documentId:groupHost,selectedRootIds:[groupBlock]})))
      await f.send(A);accepted(await f.track(receiveInitialSyncedSnapshot(B.db,f.input(randomUUID(),B),runtime)))
      const exchange=(peer:typeof A)=>f.track(exchangeSyncedSnapshot(peer.db,f.input(randomUUID(),peer),runtime))
      completed(await exchange(A),'noop');completed(await exchange(B),'noop')
      const ids=[parent,child,grandchild],blocks=[parentBlock,childBlock,grandchildBlock]
      const unchanged=(db:typeof A.db)=>({
        blocks:db.prepare('SELECT id,document_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,list_start,markdown_format_json,highlight,created_at FROM blocks WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(blocks)),
        identities:db.prepare('SELECT * FROM block_identities WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(blocks)),
        documentBirths:db.prepare('SELECT id,created_at FROM documents WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(ids))
      })
      const beforeA=unchanged(A.db),beforeB=unchanged(B.db),beforeRemote=remoteActual(f),groupBeforeA=snapshot(A.db,creation.createdLifecycle.groupId),groupBeforeB=snapshot(B.db,creation.createdLifecycle.groupId)
      const oldPaths=new Map(ids.map(id=>[id,readStrictHostDocument(B.db,id).detail.path]))
      assert.equal(oldPaths.get(child),'Route Parent/Route Child')
      assert.equal(oldPaths.get(grandchild),'Route Parent/Route Child/Route Grandchild')
      const oldRoutes=B.db.prepare('SELECT * FROM document_block_routes WHERE block_id IN (SELECT value FROM json_each(?)) ORDER BY document_path,block_id').all(JSON.stringify(blocks))
      for(const [id,blockId] of [[parent,parentBlock],[child,childBlock],[grandchild,grandchildBlock]])
        assert.ok(B.db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?').get(oldPaths.get(id),blockId),'The real first receiver already retained each original parent or descendant route')
      const current=store.getDocumentDetail(parent)
      assert.ok(current,'The already-open real Store reads the existing ordinary parent before its actual rename')
      store.updateDocument(parent,{title:'Renamed Route Parent',summary:current.summary,blocks:current.blocks})
      const expected=new Map([[parent,'Renamed Route Parent'],[child,'Renamed Route Parent/Route Child'],[grandchild,'Renamed Route Parent/Route Child/Route Grandchild']])
      for(const id of ids)assert.equal(readStrictHostDocument(A.db,id).detail.path,expected.get(id),'The real ordinary Main rename itself changes the complete descendant path subtree')
      const sent=completed(await exchange(A),'applied'),received=completed(await exchange(B),'applied')
      assert.ok(sent.publishedKeys.includes('doc:'+parent)&&received.appliedKeys.includes('doc:'+parent),'The renamed real parent is actually published and accepted at the same original target')
      for(const id of [child,grandchild]) {
        assert.equal(sent.publishedKeys.includes('doc:'+id),false,'A derived descendant path is not fabricated into changed portable child content')
        assert.equal(received.appliedKeys.includes('doc:'+id),false,'The incoming writer must register a real path change even when the descendant record hash is unchanged')
      }
      for(const [id,blockId] of [[parent,parentBlock],[child,childBlock],[grandchild,grandchildBlock]]) {
        assert.equal(readStrictHostDocument(B.db,id).detail.path,expected.get(id))
        assert.ok(B.db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?').get(expected.get(id),blockId),'The actual accepted parent or derived descendant path registers its new real block route')
        assert.ok(B.db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?').get(oldPaths.get(id),blockId),'A new accepted route does not erase the original historical route')
        assert.ok(A.db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?').get(oldPaths.get(id),blockId),'The actual ordinary Main rename preserves its source-side historical subtree route')
      }
      const afterRoutes=B.db.prepare('SELECT * FROM document_block_routes WHERE block_id IN (SELECT value FROM json_each(?)) ORDER BY document_path,block_id').all(JSON.stringify(blocks))
      for(const row of oldRoutes)assert.ok(afterRoutes.some(value=>encode(value)===encode(row)),'Every previously observed route remains present, including older observations')
      assert.deepEqual(unchanged(A.db),beforeA);assert.deepEqual(unchanged(B.db),beforeB)
      assert.deepEqual(snapshot(A.db,creation.createdLifecycle.groupId),groupBeforeA);assert.deepEqual(snapshot(B.db,creation.createdLifecycle.groupId),groupBeforeB)
      const afterRemote=remoteActual(f)
      for(const id of [child,grandchild])assert.equal(afterRemote.manifest.entries['doc:'+id],beforeRemote.manifest.entries['doc:'+id])
      converged({...f,A,B})
    } finally {store.destroy()}
  })
})

test('actual shared host cuts reject a changed hash a wholly deleted proof or one restored partial mapping before HTTP or old Undo writes',async()=>{
  const {restoreSyncedHostOperation}=await import('../src/main/database/synced-host-final')
  for(const corruption of ['bad-cut-hash','delete-entire-cut','restore-one-partial-mapping'] as const)await withExchange(async f=>{
    const participants=f.islands.slice(0,2),input=request(f.B.db,participants,sides=>{
      for(const side of sides){const body=side.blocks.find(block=>block.type!=='synced-block');assert.ok(body,'The shared journal starts from each actual ordinary host body');body.content='B real shared host journal '+side.documentId}
    }),old=applySyncedHostFinal(f.B.db,input)
    assert.ok(old.status==='applied'&&old.historyToken,'A genuine two-host Main edit produces its own nonidentity shared journal token')
    if(old.status!=='applied'||!old.historyToken)throw new Error('Expected a real shared journal ACK')
    const token=old.historyToken,mapping=f.B.db.prepare('SELECT history_id,document_id,position FROM synced_host_history_documents WHERE history_id=? ORDER BY document_id').all(token) as Array<{history_id:string;document_id:string;position:number}>
    assert.equal(mapping.length,2,'The original writer really registered both shared participants before any cut')
    const journal=f.B.db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?').get(token)
    assert.ok(journal,'The original immutable seven-field host journal exists before real remote replacement')
    completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied')
    hostEdit(f.A.db,participants[0],'A real replacement of one shared participant');completed(await f.exchange(f.A),'applied')
    const received=completed(await f.exchange(f.B),'applied'),key='sync.webdav.protocol5.exchange-host-cut.v1.'+token
    const saved=f.B.db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(key) as {key:string;value:string;updated_at:string}|undefined
    assert.ok(saved,'The real external replacement persists its actual nonempty shared host cut')
    const cut=JSON.parse(saved.value) as {kind:string;version:number;operationId:string;historyToken:string;journalHash:string;participants:Array<{documentId:string;position:number}>;cutAt:string}
    assert.equal(cut.kind,'synced-exchange-host-cut');assert.equal(cut.version,1);assert.equal(cut.operationId,received.operationId);assert.equal(cut.historyToken,token)
    assert.equal(cut.journalHash,hash(encode(journal)),'The cut authenticates all seven exact raw journal SQL fields without reencoding inner JSON')
    assert.deepEqual(cut.participants,mapping.map(row=>({documentId:row.document_id,position:row.position})))
    assert.equal(cut.cutAt,received.acceptedAt);assert.equal(saved.updated_at,cut.cutAt);assert.equal(saved.value,encode(cut))
    assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_host_history_documents WHERE history_id=?').get(token) as {n:number}).n,0)
    assert.deepEqual(f.B.db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?').get(token),journal)
    const receipt=f.B.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(received.operationId) as {result_json:string}|undefined
    assert.ok(receipt,'The original accepting operation retains the actual immutable cut-owning receipt')
    const receiptValue=JSON.parse(receipt.result_json) as {provenance:{hostHistoryCuts:Array<{historyToken:string;cutHash:string}>}}
    assert.deepEqual(receiptValue.provenance.hostHistoryCuts.find(proof=>proof.historyToken===token),{historyToken:token,cutHash:hash(saved.value)})
    const valid=restoreSyncedHostOperation(f.B.db,restoreInput(f.B.db,old,'undo'))
    assert.ok(valid.status==='conflict'&&valid.kind==='history','Only the authentic complete cut turns an intentionally removed execution tail into history conflict')
    if(corruption==='delete-entire-cut')f.B.db.prepare('DELETE FROM app_settings WHERE key=?').run(key)
    else if(corruption==='bad-cut-hash') {
      const changed={...cut,journalHash:(cut.journalHash[0]==='0'?'1':'0')+cut.journalHash.slice(1)}
      f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(changed),key)
    } else {
      const original=mapping[0]
      f.B.db.prepare('INSERT INTO synced_host_history_documents(history_id,document_id,position) VALUES(?,?,?)').run(original.history_id,original.document_id,original.position)
    }
    const requests=f.server.requests.length,before=allTables(f.B.db),rows=exchangeRows(f.B.db),operation=randomUUID()
    await rejected(()=>f.exchange(f.B,operation),'invalid')
    assert.equal(f.server.requests.length,requests,'Broken receipt cut journal or all-participants closure is refused before any network call')
    assert.deepEqual(exchangeRows(f.B.db),rows,'A cut proof cannot disappear or change into authority to mint another job or receipt')
    assert.throws(()=>restoreSyncedHostOperation(f.B.db,restoreInput(f.B.db,old,'undo')),Error,
      'Missing or corrupt cut evidence and a partial original mapping remain corruption instead of an executable Undo or benign cut conflict')
    assert.deepEqual(allTables(f.B.db),before)
    assert.deepEqual(f.B.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(received.operationId),receipt)
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operation),undefined)
  })
})

test('a real combined exchange late SQL failure rolls back the host cut mappings and cursor then reopens the same operation to one cut and receipt',()=>withExchange(async f=>{
  const original=hostEdit(f.B.db,f.islands[0],'B original executable host journal before cut rollback'),token=original.ack.historyToken
  assert.ok(token,'The rollback test starts from a genuine nonidentity original host journal')
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied')
  hostEdit(f.A.db,f.islands[0],'A real incoming body observed before cut receipt abort');completed(await f.exchange(f.A),'applied')
  hostEdit(f.B.db,f.islands[1],'B real outgoing body published before cut receipt abort')
  const key='sync.webdav.protocol5.exchange-host-cut.v1.'+token,operation=randomUUID(),baseline=stateRow(f.B.db).value
  const mappings=f.B.db.prepare('SELECT * FROM synced_host_history_documents ORDER BY history_id,document_id').all(),cursors=f.B.db.prepare('SELECT * FROM synced_host_history_state ORDER BY document_id').all()
  const journals=f.B.db.prepare('SELECT * FROM synced_host_history ORDER BY id').all(),incoming=hostRows(f.B.db,f.islands[0]),remoteBefore=remoteActual(f),localBefore=localPortable(f.B)
  assert.equal(f.B.db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(key),undefined,'There is no fabricated preexisting cut before the actual external replacement')
  type Witness={cuts:number;incomingMatches:number;remainingMappings:number}
  const witnesses:Witness[]=[],literal=(value:string)=>"'"+value.replaceAll("'","''")+"'"
  f.B.db.function('exchange_cut_rollback_scalar',(cuts:number,incomingMatches:number,remainingMappings:number)=>{witnesses.push({cuts,incomingMatches,remainingMappings});return 0})
  f.B.db.exec('CREATE TRIGGER exchange_cut_receipt_abort BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id='+literal(operation)+
    ' BEGIN SELECT exchange_cut_rollback_scalar((SELECT count(*) FROM app_settings WHERE key='+literal(key)+'),(SELECT count(*) FROM blocks WHERE document_id='+literal(f.islands[0])+
    ' AND content='+literal('A real incoming body observed before cut receipt abort')+'),(SELECT count(*) FROM synced_host_history_documents WHERE history_id='+literal(token)+
    ")); SELECT RAISE(ABORT,'exchange exact late receipt fixture: host cut rollback'); END")
  try {
    await rejected(()=>f.exchange(f.B,operation),'database')
    assert.ok(witnesses.some(row=>row.cuts===1&&row.incomingMatches>0&&row.remainingMappings===0),
      'The actual SQL receipt trigger sees both the genuinely installed incoming row and minted cut after removal of the original mappings')
    const remoteAfter=remoteActual(f)
    assert.notEqual(remoteAfter.hash,remoteBefore.hash,'The combined remote manifest actually committed before local cut SQL rolled back')
    assert.deepEqual(remoteAfter.manifest.entries,{...remoteBefore.manifest.entries,['doc:'+f.islands[1]]:localBefore.entries['doc:'+f.islands[1]]})
    assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_host_history_documents ORDER BY history_id,document_id').all(),mappings)
    assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_host_history_state ORDER BY document_id').all(),cursors)
    assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_host_history ORDER BY id').all(),journals)
    assert.deepEqual(hostRows(f.B.db,f.islands[0]),incoming);assert.equal(stateRow(f.B.db).value,baseline)
    assert.equal(f.B.db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(key),undefined,'The cut is in the same failed SQL transaction rather than an irreversible precommit marker')
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operation),undefined)
    assert.ok(exchangeRows(f.B.db).settings.some(row=>row.key.includes(operation)&&row.key.includes('exchange-job')),'The remote-confirmed pending job survives the failed local receipt for real recovery')
  } finally {f.B.db.exec('DROP TRIGGER exchange_cut_receipt_abort')}
  f.reopen();const settled=completed(await f.exchange(f.B,operation),'applied')
  assert.equal(settled.operationId,operation)
  const cuts=f.B.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-host-cut.v1.%' ORDER BY key").all() as Array<{key:string;value:string}>
  const exact=cuts.filter(row=>(JSON.parse(row.value) as {historyToken:string}).historyToken===token)
  assert.equal(exact.length,1);assert.equal(exact[0].key,key)
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_operations WHERE client_operation_id=?').get(operation) as {n:number}).n,1)
  assert.equal(readStrictHostDocument(f.B.db,f.islands[0]).detail.blocks[0].content,'A real incoming body observed before cut receipt abort')
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_host_history ORDER BY id').all(),journals)
  const requests=f.server.requests.length;assert.deepEqual(completed(await f.exchange(f.B,operation)),{...settled,replayed:true})
  assert.equal(f.server.requests.length,requests);assert.deepEqual(f.B.db.prepare('SELECT key,value FROM app_settings WHERE key=?').get(key),exact[0])
}))
