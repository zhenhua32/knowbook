import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { withV3Fixture, createRequest, freshBlock, randomUUID, allTables } from './helpers/synced-backup-v3-fixture'
import { request } from './helpers/synced-host-final-fixture'
import { validateHostCreateOperationAck } from '../src/main/database/synced-host-operation-receipt'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readHeadingTitle3OriginalOperationOwned } from '../src/main/database/synced-heading-title3-read'
import { planHeadingTitleSideData3 } from '../src/main/database/synced-heading-title-point3'

type Fixture=Parameters<Parameters<typeof withV3Fixture>[0]>[0]
function actualWikiTitle(f:Fixture,title:string,content:string,parent:string|null=null){
  const targetId=f.store.createDocument(parent),sourceId=f.store.createDocument(null),headingId=randomUUID(),wikiId=randomUUID(),linkId=randomUUID()
  f.store.updateDocument(targetId,{title,summary:'',blocks:[{...freshBlock(headingId,'Native scope heading'),type:'heading-1'},freshBlock(wikiId,content)]})
  const before=f.store.getDocumentDetail(targetId)!,path=before.path.split('/').map(encodeURIComponent).join('/')+'.md'
  f.store.updateDocument(sourceId,{title:'Scope source '+randomUUID(),summary:'',blocks:[freshBlock(linkId,'[heading]('+path+'#native-scope-heading)')]})
  const sender=Object.freeze({frame:'real Wiki namespace original'}),source=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:sourceId})
  assert.equal(source.status,'ready');if(source.status!=='ready')throw Error('Actual source must open')
  const create=createRequest(f.db,{documentId:sourceId,selectedRootIds:[linkId]})
  const born=validateHostCreateOperationAck(f.store.invokeSyncedEditingSession(sender,{sessionId:source.session.sessionId,method:'applySyncedHostStructure',input:create}),create.clientOperationId)
  const initial=f.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(born.operationId) as {result_json:string}
  assert.equal(JSON.parse(initial.result_json).kind,'synced-host-create-heading-birth-operation')
  writeSyncedBackupV3(f.db,{userDataRoot:realpathSync(f.userDataRoot),destination:join(realpathSync(f.root),'wiki-scope-published-'+randomUUID()),snapshotId:randomUUID()})
  const target=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:targetId})
  assert.equal(target.status,'ready');if(target.status!=='ready')throw Error('Actual target must open')
  const input=request(f.db,[targetId],after=>{after[0].title='Scoped renamed '+randomUUID()})
  const saved=f.store.invokeSyncedEditingSession(sender,{sessionId:target.session.sessionId,method:'applySyncedHostStructure',input})
  assert.equal(saved.status,'applied');if(saved.status!=='applied')throw Error('Actual title business action must apply')
  const original=f.db.transaction(()=>readHeadingTitle3OriginalOperationOwned(f.db,input.clientOperationId))()
  assert.ok(original)
  const material=original.materials.find(item=>item.group.groupId===born.createdLifecycle.groupId)
  assert.ok(material)
  const namespace=material.sourcePoint.capture.namespaces.find(item=>item.host.documentId===targetId)
  assert.ok(namespace)
  return{targetId,before,wikiId,original,material,namespace}
}

test('an actual Main before namespace cannot re-sign an unresolved raw Wiki destination into an unrelated affected subtree target',()=>withV3Fixture(f=>{
  const actual=actualWikiTitle(f,'Fresh scope target','[[Unrelated scope name|keep authored alias]]')
  const captured=actual.material.group.ordinaryWiki.find(item=>item.documentId===actual.targetId)
  assert.ok(captured)
  assert.equal(captured.links.length,1)
  assert.equal(captured.links[0].url,'Unrelated scope name|keep authored alias')
  assert.equal(captured.links[0].target,null,'The real Main resolver must first establish that this authored token is unresolved')
  const forged=structuredClone(actual.material.group.ordinaryWiki),source=forged.find(item=>item.documentId===actual.targetId)!
  source.links[0].target={documentId:actual.targetId,documentCreatedAt:actual.namespace.host.createdAt,path:actual.namespace.path,fragment:'',kind:'wiki'}
  const before=allTables(f.db),changes=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const companion=actual.original.companion
  assert.throws(()=>planHeadingTitleSideData3({before:actual.material.sourcePoint,rootId:companion.hostId,persistedTitle:companion.persistedTitle,
    afterTitle:actual.original.envelope.result.hosts[0].after.title,createdAt:companion.createdAt,subtree:companion.subtree,ordinaryWiki:forged,wikiDocuments:companion.wikiDocuments}),
    /raw Wiki does not resolve|Wiki scope required|ordinary Wiki top target differs/,
    'Matching subtree birth/path plus a captured target assertion cannot supply the missing raw Wiki resolution')
  assert.deepEqual(allTables(f.db),before)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes)
}))

test('actual Main Wiki namespace replay preserves relative, case, unique-title and legacy literal hash or pipe path resolution',()=>withV3Fixture(f=>{
  const folder=f.store.createDocument(null)
  f.store.updateDocument(folder,{title:'Scope Folder',summary:'',blocks:[freshBlock(randomUUID(),'Parent body')]})
  const cases=[
    {title:'Scoped Target',body:'[[./Scoped Target|relative]] [[scope folder/scoped target|case]] [[Scoped Target|unique]]'},
    {title:'Scope#literal',body:'[[Scope Folder/Scope#literal#native-scope-heading|alias]]'},
    {title:'Scope|literal',body:'[[Scope Folder/Scope|literal]]'}
  ]
  for(const item of cases){
    const actual=actualWikiTitle(f,item.title,item.body,folder),companion=actual.original.companion
    const expected=planHeadingTitleSideData3({before:actual.material.sourcePoint,rootId:companion.hostId,persistedTitle:companion.persistedTitle,
      afterTitle:actual.original.envelope.result.hosts[0].after.title,createdAt:companion.createdAt,subtree:companion.subtree,ordinaryWiki:actual.material.group.ordinaryWiki,wikiDocuments:companion.wikiDocuments})
    const projected=expected.namespaces.find(namespace=>namespace.host.documentId===actual.targetId)!
    const after=f.store.getDocumentDetail(actual.targetId)!
    assert.equal(projected.host.blocks.find(block=>block.id===actual.wikiId)?.content,after.blocks.find(block=>block.id===actual.wikiId)?.content)
    assert.notEqual(after.blocks.find(block=>block.id===actual.wikiId)?.content,item.body)
  }
}))
