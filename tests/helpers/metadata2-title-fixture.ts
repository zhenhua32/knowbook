import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { KnowbookStore } from '../../src/main/database/store'
import { writeSyncedBackupV3 } from '../../src/main/backup/v3-export'
import type { SyncedStructureApplied } from '../../src/shared/synced-blocks'
import { createV3Fixture, createRequest, created, applySyncedHostCommand, freshBlock, request,
  snapshot, randomUUID, type V3Fixture } from './synced-backup-v3-fixture'
import { restoreInput } from './synced-host-final-fixture'

export async function withTitle2Fixture(run:(fixture:Awaited<ReturnType<typeof create>>)=>void|Promise<void>,published=true){
  // The positive backup domain starts at the real native root BEFORE any Main
  // document/asset URI is created. Existing short-root source URI support is a
  // separate producer capability; this fixture never rewrites a captured W.
  const temp=realpathSync(tmpdir()),root=mkdtempSync(join(temp,'knowbook-metadata2-title-'))
  let f:V3Fixture|undefined,value:Awaited<ReturnType<typeof create>>|undefined
  try{f=createV3Fixture(root);value=await create(f,published);await run(value)}
  finally{if(value?.store.getUnsafeDatabaseHandle().open)value.store.destroy();f?.close();assert.equal(dirname(resolve(root)),resolve(temp));assert.ok(basename(root).startsWith('knowbook-metadata2-title-'))
    assert.equal(lstatSync(root).isSymbolicLink(),false);rmSync(root,{recursive:true,force:true})}
}
async function create(f:V3Fixture,published:boolean){
  const childId=f.store.createDocument(f.hostId),observerId=f.store.createDocument(null)
  f.store.updateDocument(childId,{title:'Child',summary:'',blocks:[freshBlock(randomUUID(),'Unchanged real descendant')]})
  const canonicalChild=randomUUID(),ordinaryLink=randomUUID()
  f.store.updateDocument(observerId,{title:'Metadata Observer',summary:'',blocks:[freshBlock(canonicalChild,'[canonical owner](V3%20Host.md)'),freshBlock(ordinaryLink,'[ordinary owner](V3%20Host.md)')]})
  const createInput=createRequest(f.db,{documentId:observerId,selectedRootIds:[canonicalChild]})
  const createdGroup=created(applySyncedHostCommand(f.db,createInput)),groupId=createdGroup.createdLifecycle.groupId
  const hostOrdinaryLink=randomUUID()
  // Save a complete dirty W=A through the real host writer to retain one
  // ordinary child route beside the existing structural reference.
  const add=request(f.db,[f.hostId],(after,before)=>{
    before[0].workingBefore.blocks.push(freshBlock(hostOrdinaryLink,'[child](V3%20Host/Child.md)'))
    after[0].blocks=structuredClone(before[0].workingBefore.blocks)
  })
  const {applySyncedHostFinal}=await import('../../src/main/database/synced-host-final')
  const saved=applySyncedHostFinal(f.db,add)
  assert.equal(saved.status,'applied')
  assert.equal(snapshot(f.db,groupId).bindings.some(binding=>binding.target.kind==='document'&&binding.target.id===f.hostId),true)
  if(published)writeSyncedBackupV3(f.db,{userDataRoot:realpathSync(f.userDataRoot),destination:join(realpathSync(f.root),'published-before-title'),snapshotId:randomUUID()})
  const store=KnowbookStore.openCanonicalRuntime(f.file),sender=Object.freeze({frame:'real title2 fixture'})
  const opened=store.openSyncedEditingSession(sender,{kind:'instance',hostDocumentId:f.hostId,instanceId:f.instanceId,groupId:f.groupId})
  assert.equal(opened.status,'ready');if(opened.status!=='ready')throw new Error('Actual host instance must open')
  const sessionId=opened.session.sessionId
  const titleInput=(working:string,after:string)=>request(store.getUnsafeDatabaseHandle(),[f.hostId],(next,before)=>{
    before[0].workingBefore.title=working;next[0].title=after
  })
  const apply=(input:ReturnType<typeof titleInput>)=>{
    const result=store.invokeSyncedEditingSession(sender,{sessionId,method:'applySyncedHostStructure',input})
    assert.ok(result.status==='applied'||result.status==='noop');if(result.status!=='applied'&&result.status!=='noop')throw new Error('Actual title2 business ACK required')
    return result
  }
  const restore=(ack:SyncedStructureApplied,direction:'undo'|'redo')=>{
    const input=restoreInput(store.getUnsafeDatabaseHandle(),ack,direction)
    const result=store.invokeSyncedEditingSession(sender,{sessionId,method:'restoreSyncedHostOperation',input})
    assert.ok(result.status==='applied'||result.status==='noop');if(result.status!=='applied'&&result.status!=='noop')throw new Error('Actual title2 inverse ACK required')
    return{input,result}
  }
  return{f,store,sender,sessionId,childId,observerId,canonicalChild,ordinaryLink,hostOrdinaryLink,groupId,titleInput,apply,restore}
}
