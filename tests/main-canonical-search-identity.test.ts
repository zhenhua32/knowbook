import assert from 'node:assert/strict'
import test from 'node:test'
import { withV3Fixture, createRequest, created, applySyncedHostCommand, freshBlock, randomUUID } from './helpers/synced-backup-v3-fixture'
import { restoreCreated, editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'

test('genuine create Undo/Redo leaves retired search missing and requires the new live occurrence guards after reactivation',
  {concurrency:false},()=>withV3Fixture(f=>{
    const childId=randomUUID(),input=createRequest(f.db,{documentId:f.hostId,selectedRootIds:[childId],dirty(working){working.blocks.push(freshBlock(childId,'RetiredCanonicalSearchNeedle'))}})
    const ack=created(applySyncedHostCommand(f.db,input)),result=f.store.searchWorkspace({query:'RetiredCanonicalSearchNeedle',scope:'blocks'})
    assert.equal(result.total,1);const address=result.items[0].canonicalOccurrence!
    const undone=restoreCreated(f.db,ack,'undo')
    const restoredOrdinary=f.store.searchWorkspace({query:'RetiredCanonicalSearchNeedle',scope:'blocks'})
    assert.equal(restoredOrdinary.total,1,'Create Undo restores the genuine ordinary W block, which must remain searchable')
    assert.equal(restoredOrdinary.items[0].documentId,f.hostId)
    assert.equal(restoredOrdinary.items.some(item=>item.canonicalOccurrence),false,'The retired canonical group contributes no occurrence')
    assert.equal((f.db.prepare('SELECT content FROM blocks WHERE id=? AND document_id=?').get(childId,f.hostId) as {content:string}).content,'RetiredCanonicalSearchNeedle')
    assert.equal(f.store.resolveWorkspaceSearchOccurrence(address).status,'missing')
    restoreCreated(f.db,undone.ack,'redo')
    const reopened=f.store.searchWorkspace({query:'RetiredCanonicalSearchNeedle',scope:'blocks'})
    assert.equal(reopened.total,1);assert.equal(f.store.resolveWorkspaceSearchOccurrence(address).status,'stale')
    assert.equal(f.store.resolveWorkspaceSearchOccurrence(reopened.items[0].canonicalOccurrence!).status,'ready')
  }))

test('exact occurrence resolution rejects another side birth, host homonym, binding, child and caller extras without altering native state',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const items=f.store.searchWorkspace({query:'Quasar',scope:'blocks'}).items
    const firstItem=items.find(item=>item.canonicalOccurrence?.hostDocumentId===f.hostId);assert.ok(firstItem)
    const first=firstItem.canonicalOccurrence!
    assert.equal(items.length,3)
    const sameHost=items.map(item=>item.canonicalOccurrence!).find(item=>item.hostDocumentId===first.hostDocumentId&&item.instanceId!==first.instanceId)
    assert.ok(sameHost)
    assert.equal(f.store.resolveWorkspaceSearchOccurrence({...first,instanceId:sameHost.instanceId}).status,'stale')
    assert.equal(f.store.resolveWorkspaceSearchOccurrence({...first,hostCreatedAt:'2000-01-01T00:00:00.000Z'}).status,'stale')
    assert.equal(f.store.resolveWorkspaceSearchOccurrence({...first,bindingVersion:randomUUID()}).status,'stale')
    assert.equal(f.store.resolveWorkspaceSearchOccurrence({...first,canonicalCreatedAt:'2000-01-01T00:00:00.000Z'}).status,'stale')
    assert.equal(f.store.resolveWorkspaceSearchOccurrence({...first,hostDocumentId:f.ordinaryDocumentId}).status,'missing')
    const folder=f.store.createDocument(null),homonym=f.store.createDocument(folder)
    f.store.updateDocument(folder,{title:'Distinct search folder',summary:'',blocks:[]})
    f.store.updateDocument(homonym,{title:firstItem.documentTitle,summary:'A real same-title different-host document',blocks:[freshBlock(randomUUID(),'unrelated body')]})
    assert.equal(f.store.getDocumentDetail(homonym)!.title,firstItem.documentTitle)
    assert.notEqual(f.store.getDocumentDetail(homonym)!.path,firstItem.documentPath)
    assert.equal(f.store.resolveWorkspaceSearchOccurrence({...first,hostDocumentId:homonym}).status,'missing')
    assert.throws(()=>f.store.resolveWorkspaceSearchOccurrence({...first,mapper:()=>items[1]} as typeof first))
    assert.throws(()=>f.store.resolveWorkspaceSearchOccurrence({canonicalBlockId:f.childId} as typeof first))
  }))

test('normal inline admission derives the actual host birth and epoch and admits the genuine fresh empty paragraph required by the canonical forest contract',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const input={hostDocumentId:f.hostId,instanceId:f.firstInstanceId,groupId:f.searchGroupId}
    const before=f.store.resolveSyncedInlineInstance(input);assert.equal(before.status,'ready')
    if(before.status!=='ready')return
    assert.ok(before.instance.hostCreatedAt);assert.ok(before.instance.recoveryEpoch);assert.equal(before.snapshot.blocks.length,2)
    assert.equal(f.store.resolveSyncedInlineInstance({...input,hostDocumentId:f.ordinaryDocumentId}).status,'missing')
    assert.throws(()=>f.store.resolveSyncedInlineInstance({...input,rows:before.snapshot.blocks} as typeof input))
    const instance=before.snapshot.instances[0]
    const rejected=updateSyncedBlockGroup(f.db,{groupId:f.searchGroupId,expectedRevision:before.snapshot.revision,
      expectedTopologyRevision:before.snapshot.topologyRevision,clientOperationId:randomUUID(),blocks:[],
      expectedInstanceBinding:{instanceId:instance.instanceId,hostDocumentId:instance.hostDocumentId,bindingVersion:instance.bindingVersion}})
    assert.equal(rejected.status,'invalid','The existing contract rejects an empty canonical forest instead of inventing a filler')
    assert.deepEqual(f.store.resolveSyncedInlineInstance(input),before)
    const emptyId=randomUUID();editCreatedGroup(f.db,f.searchGroupId,[freshBlock(emptyId,'')])
    const empty=f.store.resolveSyncedInlineInstance(input);assert.equal(empty.status,'ready')
    if(empty.status==='ready'){
      assert.equal(empty.snapshot.blocks.length,1);assert.equal(empty.snapshot.blocks[0].id,emptyId)
      assert.equal(empty.snapshot.blocks[0].content,'');assert.equal(empty.snapshot.blocks[0].type,'paragraph')
    }
    assert.equal(f.store.searchWorkspace({query:'Quasar',scope:'blocks'}).total,0)
  }))
