import assert from 'node:assert/strict'
import test from 'node:test'
import { withV3Fixture, request, snapshot, randomUUID, applySyncedHostCommand } from './helpers/synced-backup-v3-fixture'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { command, insertAck } from './helpers/synced-host-command-insert-fixture'
import { prepareSyncedMetadataTransitionOwned2, readSyncedMetadataGroupTransitionOwned2, readSyncedMetadataTransitionBatchOwned2 } from '../src/main/database/synced-metadata-transition2'

test('metadata2 captures this genuine P heading occurrence/birth/Key and CAS without inventing the legacy original capture or history lineage',
  {concurrency:false},()=>withV3Fixture(f=>{
    const intent=request(f.db,[f.targetId],(after,before)=>{before[0].workingBefore.title='Planned target';after[0]={documentId:f.targetId,...structuredClone(before[0].workingBefore)}})
    const owner=f.db.transaction(()=>prepareSyncedMetadataTransitionOwned2(f.db,intent))()
    const value=f.db.transaction(()=>readSyncedMetadataGroupTransitionOwned2(f.db,owner,f.groupId,'final'))(),capture=value.currentCapture
    const group=snapshot(f.db,f.groupId),document=f.db.prepare('SELECT created_at FROM documents WHERE id=?').get(f.targetId) as {created_at:string}
    const child=f.db.prepare('SELECT created_at FROM blocks WHERE id=? AND document_id=?').get(f.targetBodyId,f.targetId) as {created_at:string}
    assert.equal(capture.sourceRevision,group.revision);assert.equal(capture.sourceTopologyRevision,group.topologyRevision)
    assert.equal(capture.workspaceScope,value.workspaceScope);assert.equal(capture.recoveryEpoch,value.recoveryEpoch)
    assert.equal(capture.originalCaptureBirthProved,false);assert.equal(capture.historicalKeyLineageProved,false);assert.equal(capture.writePermit,false)
    const target=capture.targets[0];assert.equal(target.status,'current-heading')
    if(target.status==='current-heading'){
      assert.equal(target.documentId,f.targetId);assert.equal(target.documentCreatedAt,document.created_at)
      assert.equal(target.heading.location.kind,'ordinary')
      if(target.heading.location.kind==='ordinary'){assert.equal(target.heading.location.blockId,f.targetBodyId);assert.equal(target.heading.location.blockCreatedAt,child.created_at)}
      assert.equal(target.key.raw,group.bindings[0].raw);assert.deepEqual(target.storedTarget,group.bindings[0].target)
      assert.equal(target.captureDomain,'metadata2-current-P');assert.equal(target.originalCaptureBirthProved,false)
    }
    const current=f.store.getDocumentDetail(f.targetId)!
    f.store.updateDocument(f.targetId,{title:current.title,summary:current.summary,blocks:[{id:randomUUID(),type:'heading-1',content:'Target heading',checked:false,parentBlockId:null,depth:0}]})
    assert.throws(()=>f.db.transaction(()=>readSyncedMetadataGroupTransitionOwned2(f.db,owner,f.groupId,'final'))(),/actual original SQL/)
    const freshIntent=request(f.db,[f.targetId]),fresh=f.db.transaction(()=>prepareSyncedMetadataTransitionOwned2(f.db,freshIntent))()
    const freshValue=f.db.transaction(()=>readSyncedMetadataGroupTransitionOwned2(f.db,fresh,f.groupId,'final'))()
    assert.equal(freshValue.currentCapture.originalCaptureBirthProved,false,'A new current P witness never backfills the old captured birth after same-slug replacement')
  }))

test('genuine metadata2 batch shares one capture and references source group material already present in its exact transitions',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const intent=request(f.db,[f.targetId],(after,before)=>{before[0].workingBefore.title='Batch target';after[0]={documentId:f.targetId,...structuredClone(before[0].workingBefore)}})
    const count=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
    const batch=f.db.transaction(()=>{const owner=prepareSyncedMetadataTransitionOwned2(f.db,intent)
      return readSyncedMetadataTransitionBatchOwned2(f.db,owner,[f.groupId,f.searchGroupId],'final')})()
    assert.equal(batch.transitions.length,2);assert.equal(batch.currentCapture.sources.length,2);assert.equal(batch.currentCapture.namespaces.length,1)
    assert.ok(batch.transitions.every(transition=>transition.currentCaptureHash===batch.currentCapture.captureHash))
    assert.ok(batch.transitions.every(transition=>!Object.hasOwn(transition,'currentCapture')))
    const namespaceGroup=batch.currentCapture.groups[0];assert.equal(namespaceGroup.kind,'transition-source')
    if(namespaceGroup.kind==='transition-source'){
      assert.equal(namespaceGroup.groupId,f.searchGroupId)
      assert.equal(namespaceGroup.sourceWireHash,batch.transitions.find(transition=>transition.groupId===f.searchGroupId)!.beforeHash)
      assert.equal(Object.hasOwn(namespaceGroup,'wire'),false,'The fixed source wire is not duplicated in the shared namespace material')
    }
    assert.equal(batch.rawLogicalChange,false);assert.equal(batch.writePermit,false)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,count)
  }))

test('current metadata2 capture retains all real repeated instances in the full target heading namespace and stores each referenced group once',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const before=snapshot(f.db,f.searchGroupId)
    editCreatedGroup(f.db,f.searchGroupId,before.blocks.map(({createdAt:_birth,...block})=>({...block,type:'heading-1',content:'Shared section'})))
    const inserted=command(f.db,{documentId:f.targetId,groupId:f.searchGroupId});insertAck(applySyncedHostCommand(f.db,inserted))
    const intent=request(f.db,[f.targetId]),count=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
    const value=f.db.transaction(()=>{const owner=prepareSyncedMetadataTransitionOwned2(f.db,intent);return readSyncedMetadataGroupTransitionOwned2(f.db,owner,f.groupId,'final')})()
    const capture=value.currentCapture,namespace=capture.namespaces.find(item=>item.host.documentId===f.targetId)!
    assert.ok(namespace);assert.equal(namespace.instances.length,2);assert.equal(capture.groups.length,1)
    const material=capture.groups[0];assert.equal(material.kind,'namespace-material')
    if(material.kind==='namespace-material')assert.equal(material.wire.id,f.searchGroupId)
    const headings=namespace.headings.filter(heading=>heading.location.kind==='canonical')
    assert.equal(headings.length,4);assert.equal(new Set(headings.map(heading=>heading.key)).size,4);assert.equal(new Set(headings.map(heading=>heading.slug)).size,4)
    assert.deepEqual(new Set(headings.flatMap(heading=>heading.location.kind==='canonical'?[heading.location.instance.instanceId]:[])),new Set([f.thirdInstanceId,inserted.action.instanceId]))
    assert.equal(namespace.host.blocks.filter(block=>block.type==='synced-block').length,2,'Stored host facts contain reference leaves, not copied canonical body rows')
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM blocks WHERE id IN (?,?)').get(f.childId,f.secondChildId) as {n:number}).n,0)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,count)
    assert.equal(value.groupHistoryComplete,false);assert.equal(value.hostHistoryComplete,false);assert.equal(value.writePermit,false)
  }))
