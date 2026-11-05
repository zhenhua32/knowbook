import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { withV3Fixture, createRequest, freshBlock, randomUUID, snapshot, allTables } from './helpers/synced-backup-v3-fixture'
import { request, restoreInput } from './helpers/synced-host-final-fixture'
import { validateHostCreateOperationAck } from '../src/main/database/synced-host-operation-receipt'
import { readHeadingTitle3OriginalOperationOwned } from '../src/main/database/synced-heading-title3-read'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { MarkdownLinkIndex } from '../src/main/database/markdown-link-index'
import type { SyncedGroupSnapshot, SyncedGroupWire } from '../src/shared/synced-blocks'

type Fixture=Parameters<Parameters<typeof withV3Fixture>[0]>[0]
const wire=(value:SyncedGroupSnapshot):SyncedGroupWire=>({kind:'synced-group',id:value.groupId,creationId:value.creationId,createdAt:value.createdAt,
  origin:value.origin,blocks:value.blocks,bindings:value.bindings})
function actualWikiStyleAction(f:Fixture,ordinary:boolean,nested=false){
  const parent=nested?f.store.createDocument(null):null
  if(parent)f.store.updateDocument(parent,{title:'Wiki Spelling Folder',summary:'',blocks:[freshBlock(randomUUID(),'Folder')]})
  const targetId=f.store.createDocument(parent),sourceId=f.store.createDocument(null),headingId=randomUUID(),linkId=randomUUID(),selfId=randomUUID()
  const oldTitle='Wiki Spelling Target',newTitle='Renamed Wiki Spelling Target',authored='[['+oldTitle+'#stable |authored alias]]'
  f.store.updateDocument(targetId,{title:oldTitle,summary:'Stable summary',blocks:[{...freshBlock(headingId,'Stable'),type:'heading-1'},
    ...(ordinary?[freshBlock(selfId,authored)]:[])]})
  // Neither raw spelling may silently bind to a whole-literal path. The real
  // native Wiki resolver establishes the actual simple explicit-fragment target.
  for(const title of [oldTitle+'#stable |authored alias',oldTitle+'#stable|authored alias']){
    const id=f.store.createDocument(null);f.store.updateDocument(id,{title,summary:'',blocks:[freshBlock(randomUUID(),'Independent literal-name occupant')]})
  }
  f.store.updateDocument(sourceId,{title:'Genuine Wiki style source '+randomUUID(),summary:'',blocks:[freshBlock(linkId,
    ordinary?'[heading](Wiki%20Spelling%20Target.md#stable)':authored)]})
  const sender=Object.freeze({frame:'current title3 exact Wiki inverse'}),source=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:sourceId})
  assert.equal(source.status,'ready');if(source.status!=='ready')throw Error('Actual source session required')
  const create=createRequest(f.db,{documentId:sourceId,selectedRootIds:[linkId]})
  const born=validateHostCreateOperationAck(f.store.invokeSyncedEditingSession(sender,{sessionId:source.session.sessionId,method:'applySyncedHostStructure',input:create}),create.clientOperationId)
  const groupId=born.createdLifecycle.groupId,original=wire(snapshot(f.db,groupId))
  assert.equal(JSON.parse((f.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(create.clientOperationId) as {result_json:string}).result_json).kind,'synced-host-create-heading-birth-operation')
  assert.ok(original.bindings.every(binding=>binding.target.kind==='heading'&&binding.target.documentId===targetId&&binding.target.slug==='stable'))
  if(!ordinary)assert.equal(original.blocks[0].content,authored,'The real create must retain the original authored Wiki bytes before this title operation')
  const originalTarget=f.store.getDocumentDetail(targetId)!
  writeSyncedBackupV3(f.db,{userDataRoot:realpathSync(f.userDataRoot),destination:join(realpathSync(f.root),'current3-wiki-style-publication'),snapshotId:randomUUID()})
  const target=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:targetId})
  assert.equal(target.status,'ready');if(target.status!=='ready')throw Error('Actual target session required')
  const input=request(f.db,[targetId],after=>{after[0].title=newTitle})
  const saved=f.store.invokeSyncedEditingSession(sender,{sessionId:target.session.sessionId,method:'applySyncedHostStructure',input})
  assert.equal(saved.status,'applied','The current real title operation must reach its existing committed Wiki-maintenance branch: '+JSON.stringify(saved))
  if(saved.status!=='applied')throw Error('Actual committed title ACK required')
  assert.ok(saved.historyToken)
  const acknowledged=saved.groups.find(value=>value.groupId===groupId)
  assert.ok(acknowledged)
  const exactA=wire(acknowledged)
  assert.deepEqual(wire(snapshot(f.db,groupId)),exactA)
  const afterTarget=f.store.getDocumentDetail(targetId)!,actorA=afterTarget.blocks.map(({sortOrder:_sortOrder,...block})=>block)
  if(ordinary)assert.notEqual(afterTarget.blocks.find(block=>block.id===selfId)!.content,authored)
  else assert.ok(exactA.blocks[0].content.includes(newTitle+'#stable'),'The actual canonical field must follow the new target path')
  const originalBusiness=f.db.transaction(()=>readHeadingTitle3OriginalOperationOwned(f.db,input.clientOperationId))()
  assert.ok(originalBusiness)
  const material=originalBusiness.materials.find(value=>value.group.groupId===groupId)
  assert.ok(material)
  assert.deepEqual(material.working,original,'The original operation must independently retain the exact complete effective W canonical side')
  assert.deepEqual(material.after,exactA)
  const originalRow=f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId)
  const restore=(direction:'undo'|'redo')=>f.store.invokeSyncedEditingSession(sender,{sessionId:target.session.sessionId,method:'restoreSyncedHostOperation',input:restoreInput(f.db,saved,direction)})
  return{targetId,groupId,selfId,authored,oldTitle,newTitle,original,originalTarget,exactA,actorA,input,saved,restore,originalRow,sender,sessionId:target.session.sessionId}
}

test('current Main title3 canonical Wiki inverse restores the complete authored W including the fragment space before its alias',()=>withV3Fixture(f=>{
  const actual=actualWikiStyleAction(f,false)
  const undone=actual.restore('undo')
  assert.equal(undone.status,'applied','A committed title action must retain its genuine executable Undo: '+JSON.stringify(undone))
  assert.deepEqual(wire(snapshot(f.db,actual.groupId)),actual.original,'Canonical W is exact; the original pre-alias space must not normalize away')
  assert.equal(f.store.getDocumentDetail(actual.targetId)!.title,actual.oldTitle)
  assert.equal(actual.restore('redo').status,'applied')
  assert.deepEqual(wire(snapshot(f.db,actual.groupId)),actual.exactA,'Redo must restore the exact originally acknowledged A')
  assert.deepEqual(f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(actual.input.clientOperationId),actual.originalRow)
  const before=allTables(f.db),changes=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const replay=f.store.invokeSyncedEditingSession(actual.sender,{sessionId:actual.sessionId,method:'applySyncedHostStructure',input:actual.input})
  assert.equal(replay.status,'applied');if(replay.status!=='applied')throw Error('The original nonce must remain readable')
  assert.equal(replay.replayed,true)
  assert.deepEqual(allTables(f.db),before)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes)
}))

test('current Main title3 ordinary self Wiki keeps its complete original W executable and retains its authored alias boundary through forward maintenance',()=>withV3Fixture(f=>{
  const actual=actualWikiStyleAction(f,true),undone=actual.restore('undo')
  assert.equal(undone.status,'applied','The actual full original ordinary W hash must be restored, rather than refusing after a successful forward commit: '+JSON.stringify(undone))
  const after=f.store.getDocumentDetail(actual.targetId)!
  assert.equal(after.title,actual.originalTarget.title)
  assert.deepEqual(after.blocks.map(({sortOrder:_sortOrder,...block})=>block),actual.originalTarget.blocks.map(({sortOrder:_sortOrder,...block})=>block))
  assert.equal(after.blocks.find(block=>block.id===actual.selfId)!.content,actual.authored)
  assert.deepEqual(wire(snapshot(f.db,actual.groupId)),actual.original)
  assert.equal(actual.restore('redo').status,'applied')
  assert.deepEqual(f.store.getDocumentDetail(actual.targetId)!.blocks.map(({sortOrder:_sortOrder,...block})=>block),actual.actorA)
  assert.deepEqual(wire(snapshot(f.db,actual.groupId)),actual.exactA)
}))

test('title3 Wiki inverse refuses an original short spelling that now resolves to another real document without writing',()=>withV3Fixture(f=>{
  const actual=actualWikiStyleAction(f,false,true),occupant=f.store.createDocument(null)
  f.store.updateDocument(occupant,{title:actual.oldTitle,summary:'',blocks:[{...freshBlock(randomUUID(),'Stable'),type:'heading-1'}]})
  const native=new MarkdownLinkIndex(f.db).resolveWiki(actual.authored.slice(2,-2),actual.original.origin.pathAtCreation)
  assert.equal(native?.id,occupant,'The current real resolver must prefer the newly created exact root path')
  assert.equal(native?.fragment,'stable')
  const before=allTables(f.db),changes=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const undone=actual.restore('undo')
  assert.equal(undone.status,'unsupported',JSON.stringify(undone))
  if(undone.status==='unsupported')assert.match(undone.reason,/original-side URI spelling no longer names the exact projected target/)
  assert.deepEqual(allTables(f.db),before)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes)
  assert.deepEqual(wire(snapshot(f.db,actual.groupId)),actual.exactA)
}))
