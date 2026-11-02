import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { withV3Fixture, createRequest, freshBlock } from './helpers/synced-backup-v3-fixture'

test('a genuine host session supports the first W-only Main create and only a real inline reopen supplies its new instance write guard',
  {concurrency:false},()=>withV3Fixture(f=>{
    const sender={},documentId=f.store.createDocument(null),bodyId=randomUUID()
    f.store.updateDocument(documentId,{title:'First real inline host',summary:'',blocks:[freshBlock(bodyId,'Existing ordinary text')]})
    const opened=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:documentId})
    assert.equal(opened.status,'ready');if(opened.status!=='ready')return
    assert.equal(opened.instance,undefined);assert.equal(opened.snapshot,undefined)
    const freshId=randomUUID(),input=createRequest(f.db,{documentId,selectedRootIds:[freshId],dirty(working){working.blocks.push(freshBlock(freshId,'Session first canonical text'))}})
    assert.equal(f.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(freshId),undefined)
    const result=f.store.invokeSyncedEditingSession(sender,{sessionId:opened.session.sessionId,method:'applySyncedHostStructure',input})
    assert.equal(result.status,'applied')
    assert.ok(f.db.prepare('SELECT 1 FROM synced_instances WHERE instance_id=? AND group_id=?').get(input.action.instanceId,input.action.groupId))
    const actual=f.store.openSyncedEditingSession(sender,{kind:'instance',hostDocumentId:documentId,instanceId:input.action.instanceId,groupId:input.action.groupId})
    assert.equal(actual.status,'ready');if(actual.status!=='ready')return
    assert.equal(actual.session.sessionId,opened.session.sessionId);assert.ok(actual.instance);assert.ok(actual.snapshot)
    const group=actual.snapshot,instance=actual.instance
    const edit:SyncedUpdateGroupInput={groupId:group.groupId,expectedRevision:group.revision,expectedTopologyRevision:group.topologyRevision,
      expectedInstanceBinding:{instanceId:instance.instanceId,hostDocumentId:documentId,bindingVersion:instance.bindingVersion},clientOperationId:randomUUID(),
      blocks:group.blocks.map(({createdAt:_birth,...block})=>({...block,content:block.content+' edited through the actual session'}))}
    const saved=f.store.invokeSyncedEditingSession(sender,{sessionId:actual.session.sessionId,method:'updateSyncedBlockGroup',input:edit})
    assert.equal(saved.status,'saved')
    assert.equal(f.store.searchWorkspace({query:'edited through the actual session',scope:'blocks',matchMode:'phrase'}).total,1)
    assert.equal(f.db.prepare('SELECT 1 FROM blocks WHERE id=?').get(freshId),undefined,'Canonical content never becomes an ordinary host row')
  }))

test('real session content and source-owner ports preserve committed ACK provenance and reject another private frame or caller namespace',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const sender={},otherSender={},opened=f.store.openSyncedEditingSession(sender,{kind:'instance',hostDocumentId:f.hostId,instanceId:f.firstInstanceId,groupId:f.searchGroupId})
    assert.equal(opened.status,'ready');if(opened.status!=='ready')return
    const sessionId=opened.session.sessionId
    assert.throws(()=>f.store.invokeSyncedEditingSession(otherSender,{sessionId,method:'getSyncedGroupSnapshots',input:{groupIds:[f.searchGroupId]}}),/original IPC frame/)
    assert.throws(()=>f.store.invokeSyncedEditingSession(sender,{sessionId:randomUUID(),method:'getSyncedGroupSnapshots',input:{groupIds:[f.searchGroupId]}}))
    const baseline=f.store.invokeSyncedEditingSession(sender,{sessionId,method:'captureBaseline',input:{groupId:f.searchGroupId}})
    assert.equal(baseline.status,'ready');if(baseline.status!=='ready')return
    const snapshot=baseline.snapshot,instance=snapshot.instances.find(item=>item.instanceId===f.firstInstanceId)!
    const input:SyncedUpdateGroupInput={groupId:snapshot.groupId,expectedRevision:snapshot.revision,expectedTopologyRevision:snapshot.topologyRevision,
      expectedInstanceBinding:instance,clientOperationId:randomUUID(),blocks:snapshot.blocks.map(({createdAt:_birth,...block})=>({...block,content:block.content+' source-owner saved'}))}
    // The closed original mutation codec accepts only the three instance guard
    // fields, not the public position DTO's extra depth/parent fields.
    input.expectedInstanceBinding={instanceId:instance.instanceId,hostDocumentId:instance.hostDocumentId,bindingVersion:instance.bindingVersion}
    const saved=f.store.invokeSyncedEditingSession(sender,{sessionId,method:'updateSyncedBlockGroup',input})
    assert.equal(saved.status,'saved')
    const ack=f.store.invokeSyncedEditingSession(sender,{sessionId,method:'ownedOperation',input:{readOwnerId:baseline.readOwnerId,clientOperationId:input.clientOperationId}})
    assert.equal(ack.status,'committed');if(ack.status==='committed')assert.equal(ack.result.operationId,input.clientOperationId)
    const valid=f.store.invokeSyncedEditingSession(sender,{sessionId,method:'validateOwner',input:{readOwnerId:baseline.readOwnerId}});assert.equal(valid.status,'ready')
    f.store.invokeSyncedEditingSession(sender,{sessionId,method:'releaseOwner',input:{readOwnerId:baseline.readOwnerId}})
    assert.equal(f.store.invokeSyncedEditingSession(sender,{sessionId,method:'validateOwner',input:{readOwnerId:baseline.readOwnerId}}).status,'owner-unavailable')
    f.store.releaseSyncedEditingSessionsForSender(sender)
    assert.throws(()=>f.store.invokeSyncedEditingSession(sender,{sessionId,method:'getSyncedOperation',input:{clientOperationId:input.clientOperationId}}),/original IPC frame/)
  }))
