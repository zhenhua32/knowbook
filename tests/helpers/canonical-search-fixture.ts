import assert from 'node:assert/strict'
import { withV3Fixture, applySyncedHostCommand, applySyncedHostFinal, createRequest, created, freshBlock, request, applied, randomUUID } from './synced-backup-v3-fixture'
import { command, insertAck } from './synced-host-command-insert-fixture'
import { editCreatedGroup } from './synced-host-command-create-fixture'

export function withCanonicalSearchFixture(run:(f:Parameters<Parameters<typeof withV3Fixture>[0]>[0]&{
  query:string;childId:string;secondChildId:string;searchGroupId:string;firstInstanceId:string;secondInstanceId:string;thirdInstanceId:string;
  ordinaryDocumentId:string;searchCreate:ReturnType<typeof created>;edit:()=>ReturnType<typeof editCreatedGroup>;
  orphan:()=>ReturnType<typeof applied>
})=>void|Promise<void>){
  return withV3Fixture(async f=>{
    const query='CanonicalOrbit',childId=' original canonical child\0 '+randomUUID(),secondChildId=randomUUID()
    const input=createRequest(f.db,{documentId:f.hostId,selectedRootIds:[childId,secondChildId],dirty(working){
      working.blocks.push({...freshBlock(childId,query+' Quasar nebula 数'),tags:['canonical-only']},freshBlock(secondChildId,query+' second occurrence'))
    }})
    const searchCreate=created(applySyncedHostCommand(f.db,input)),searchGroupId=input.action.groupId,firstInstanceId=input.action.instanceId
    const second=command(f.db,{documentId:f.hostId,groupId:searchGroupId});insertAck(applySyncedHostCommand(f.db,second))
    const third=command(f.db,{documentId:f.targetId,groupId:searchGroupId});insertAck(applySyncedHostCommand(f.db,third))
    const ordinaryDocumentId=f.store.createDocument(null)
    f.store.updateDocument(ordinaryDocumentId,{title:'Ordinary parity',summary:'ordinary unchanged metadata',blocks:[{
      id:randomUUID(),type:'paragraph',content:query+' ordinary native block',checked:false,depth:0,parentBlockId:null
    }]})
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM synced_instances WHERE group_id=?').get(searchGroupId) as {n:number}).n,3)
    const edit=()=>editCreatedGroup(f.db,searchGroupId)
    const orphan=()=>applied(applySyncedHostFinal(f.db,request(f.db,[f.hostId,f.targetId],(after,before)=>{
      for(const side of before){side.workingBefore.blocks=side.workingBefore.blocks.filter(block=>![firstInstanceId,second.action.instanceId,third.action.instanceId].includes(block.id))}
      for(const side of after)side.blocks=structuredClone(before.find(old=>old.documentId===side.documentId)!.workingBefore.blocks)
    })))
    await run({...f,query,childId,secondChildId,searchGroupId,firstInstanceId,secondInstanceId:second.action.instanceId,
      thirdInstanceId:third.action.instanceId,ordinaryDocumentId,searchCreate,edit,orphan})
  })
}
