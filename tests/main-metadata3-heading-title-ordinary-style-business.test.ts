import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { withV3Fixture, createRequest, freshBlock, randomUUID, snapshot, allTables } from './helpers/synced-backup-v3-fixture'
import { request, restoreInput } from './helpers/synced-host-final-fixture'
import { validateHostCreateOperationAck } from '../src/main/database/synced-host-operation-receipt'
import { readHeadingTitle3OriginalOperationOwned } from '../src/main/database/synced-heading-title3-read'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'

type Fixture=Parameters<Parameters<typeof withV3Fixture>[0]>[0]
function actualOrdinaryStyleAction(f:Fixture){
  const targetId=f.store.createDocument(null),sourceId=f.store.createDocument(null),ordinaryId=f.store.createDocument(null)
  const headingId=randomUUID(),sourceBlock=randomUUID(),ordinaryBlock=randomUUID()
  const oldTitle='旧 Heading Name',newTitle='新 Heading Rename'
  const oldPath='旧%20Heading%20%4eame.MD',newPath='新%20Heading%20Rename.MD'
  const body=(path:string)=>'[ordinary]('+path+'?x=%2f#%73table) [block]('+path+'?q=%2a#^'+headingId+') <a href="'+path+'?x=1&amp;y=%2f#%73table">html</a>'
  const canonical=(path:string)=>'[canonical]('+path+'?x=%2f#%73table)'
  f.store.updateDocument(targetId,{title:oldTitle,summary:'',blocks:[{...freshBlock(headingId,'Stable'),type:'heading-1'}]})
  f.store.updateDocument(ordinaryId,{title:'Outside every captured heading namespace',summary:'',blocks:[freshBlock(ordinaryBlock,body(oldPath))]})
  f.store.updateDocument(sourceId,{title:'Real canonical style source',summary:'',blocks:[freshBlock(sourceBlock,canonical(oldPath))]})
  const sender=Object.freeze({frame:'real ordinary range style action'}),source=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:sourceId})
  assert.equal(source.status,'ready');if(source.status!=='ready')throw Error('Actual canonical source session required')
  const create=createRequest(f.db,{documentId:sourceId,selectedRootIds:[sourceBlock]})
  const born=validateHostCreateOperationAck(f.store.invokeSyncedEditingSession(sender,{sessionId:source.session.sessionId,method:'applySyncedHostStructure',input:create}),create.clientOperationId)
  const birthRow=f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(born.operationId)
  assert.equal(JSON.parse((birthRow as {result_json:string}).result_json).kind,'synced-host-create-heading-birth-operation')
  writeSyncedBackupV3(f.db,{userDataRoot:realpathSync(f.userDataRoot),destination:join(realpathSync(f.root),'ordinary-style-original-publication'),snapshotId:randomUUID()})
  const target=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:targetId})
  assert.equal(target.status,'ready');if(target.status!=='ready')throw Error('Actual target session required')
  const input=request(f.db,[targetId],after=>{after[0].title=newTitle})
  const saved=f.store.invokeSyncedEditingSession(sender,{sessionId:target.session.sessionId,method:'applySyncedHostStructure',input})
  assert.equal(saved.status,'applied','The first genuine heading-title rename must apply before checking ordinary style inverse: '+JSON.stringify(saved))
  if(saved.status!=='applied')throw Error('Actual title action required')
  assert.ok(saved.historyToken)
  const original=f.db.transaction(()=>readHeadingTitle3OriginalOperationOwned(f.db,input.clientOperationId))()
  assert.ok(original)
  assert.ok(original.materials.every(material=>material.sourcePoint.capture.namespaces.every(namespace=>namespace.host.documentId!==ordinaryId)),
    'The ordinary source must not accidentally borrow an actor or heading-target point body snapshot')
  const ordinary=()=>f.store.getDocumentDetail(ordinaryId)!.blocks.find(block=>block.id===ordinaryBlock)!.content
  const group=()=>snapshot(f.db,born.createdLifecycle.groupId).blocks.find(block=>block.id===sourceBlock)!.content
  assert.equal(ordinary(),body(newPath),'Forward maintenance keeps authored Unicode/query/percentcase/caret and HTML entity spelling')
  assert.equal(group(),canonical(newPath),'Canonical style composes its exact raw Key projection')
  const restore=(direction:'undo'|'redo')=>f.store.invokeSyncedEditingSession(sender,{sessionId:target.session.sessionId,
    method:'restoreSyncedHostOperation',input:restoreInput(f.db,saved,direction)})
  return{targetId,ordinaryId,ordinaryBlock,sourceBlock,headingId,born,birthRow,saved,oldTitle,newTitle,oldPath,newPath,body,canonical,ordinary,group,restore}
}

test('real Main inverse restores arbitrary ordinary-source URI spelling outside all point namespaces while retaining later non-URI body',()=>withV3Fixture(f=>{
  const actual=actualOrdinaryStyleAction(f),later=' Later ordinary prose stays.'
  const detail=f.store.getDocumentDetail(actual.ordinaryId)!
  const born=f.db.prepare('SELECT created_at FROM blocks WHERE id=?').get(actual.ordinaryBlock)
  f.store.updateDocument(actual.ordinaryId,{expectedUpdatedAt:detail.updatedAt,title:detail.title,summary:detail.summary,
    blocks:[freshBlock(actual.ordinaryBlock,actual.body(actual.newPath)+later)]})
  assert.equal(actual.restore('undo').status,'applied')
  assert.equal(f.store.getDocumentDetail(actual.targetId)!.title,actual.oldTitle)
  assert.equal(actual.ordinary(),actual.body(actual.oldPath)+later,'The old percent-encoded filename spelling must come from finite original URI facts')
  assert.equal(actual.group(),actual.canonical(actual.oldPath))
  assert.equal(actual.restore('redo').status,'applied')
  assert.equal(f.store.getDocumentDetail(actual.targetId)!.title,actual.newTitle)
  assert.equal(actual.ordinary(),actual.body(actual.newPath)+later)
  assert.equal(actual.group(),actual.canonical(actual.newPath))
  assert.deepEqual(f.db.prepare('SELECT created_at FROM blocks WHERE id=?').get(actual.ordinaryBlock),born)
  assert.deepEqual(f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(actual.born.operationId),actual.birthRow)
}))

test('a later actual ordinary backlink without the initial finite style facts refuses the complete inverse with zero SQL writes',()=>withV3Fixture(f=>{
  const actual=actualOrdinaryStyleAction(f),lateId=f.store.createDocument(null)
  f.store.updateDocument(lateId,{title:'Later unproved ordinary source',summary:'',blocks:[freshBlock(randomUUID(),'[late]('+actual.newPath+'#stable)')]})
  const before=allTables(f.db),changes=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const result=actual.restore('undo')
  assert.equal(result.status,'unsupported','An added source cannot invent the original filename spelling from an effect hash')
  assert.deepEqual(allTables(f.db),before)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes)
  assert.equal(f.store.getDocumentDetail(actual.targetId)!.title,actual.newTitle)
}))
