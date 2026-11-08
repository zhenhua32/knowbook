import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedEditingHostResult } from '../src/shared/synced-editing-session'
import { applySyncedHostTitleMetadata2 } from '../src/main/database/synced-host-title2'
import { TITLE2_OPERATION_KIND } from '../src/main/database/synced-host-title2-codec'
import { allTables, request } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { withTitle2Fixture } from './helpers/metadata2-title-fixture'

function assertUnsupported(result:SyncedEditingHostResult,pattern:RegExp){
  assert.equal(result.status,'unsupported');if(result.status!=='unsupported')throw new Error('A complete rolled-back domain refusal is required')
  assert.match(result.reason,pattern)
}

test('actual unpublished activation, existing canonical user history, and a removed heading preserve every SQL row and the original title draft', async()=>{
  await withTitle2Fixture(t=>{
    const db=t.store.getUnsafeDatabaseHandle(),input=t.titleInput('V3 Host','Retained Draft'),before=allTables(db)
    assertUnsupported(t.store.invokeSyncedEditingSession(t.sender,{sessionId:t.sessionId,method:'applySyncedHostStructure',input}),/requires-lineage.*activation/)
    assert.equal(db.inTransaction,false,'The definitive refusal follows a complete owned rollback')
    assert.deepEqual(allTables(db),before)
    assert.equal(input.finalAfter[0].title,'Retained Draft')
  },false)
  await withTitle2Fixture(t=>{
    const db=t.store.getUnsafeDatabaseHandle();editCreatedGroup(db,t.groupId)
    const input=t.titleInput('V3 Host','Retained Draft'),before=allTables(db)
    assertUnsupported(t.store.invokeSyncedEditingSession(t.sender,{sessionId:t.sessionId,method:'applySyncedHostStructure',input}),/requires-lineage.*history/)
    assert.equal(db.inTransaction,false)
    assert.deepEqual(allTables(db),before)
  })
  await withTitle2Fixture(t=>{
    const db=t.store.getUnsafeDatabaseHandle(),target=t.store.getDocumentDetail(t.f.targetId)!
    t.store.updateDocument(target.id,{title:target.title,summary:target.summary,
      blocks:target.blocks.map(({sortOrder:_sortOrder,...block})=>({...block,type:'paragraph'}))})
    const opened=t.store.openSyncedEditingSession(t.sender,{kind:'host',hostDocumentId:t.f.targetId})
    assert.equal(opened.status,'ready');if(opened.status!=='ready')throw new Error('Actual heading target host must open')
    const input=request(db,[t.f.targetId],after=>{after[0].title='Target Title Draft'}),before=allTables(db)
    assertUnsupported(t.store.invokeSyncedEditingSession(t.sender,{sessionId:opened.session.sessionId,method:'applySyncedHostStructure',input}),/requires-lineage.*heading/)
    assert.equal(db.inTransaction,false)
    assert.deepEqual(allTables(db),before)
    assert.equal(input.finalAfter[0].title,'Target Title Draft')
  })
})

test('a real late metadata2 receipt failure rolls back paths, canonical rows, source captures, journal, indexes and checkpoints; the original nonce can then commit once',()=>withTitle2Fixture(t=>{
  const db=t.store.getUnsafeDatabaseHandle(),input=t.titleInput('V3 Host','Retry Host'),before=allTables(db)
  assert.throws(()=>applySyncedHostTitleMetadata2(db,input),/genuine active Main editing session/)
  assert.deepEqual(allTables(db),before)
  db.exec(`CREATE TRIGGER metadata2_test_receipt_failure BEFORE INSERT ON synced_operations
    WHEN json_extract(NEW.result_json,'$.kind')='${TITLE2_OPERATION_KIND}' BEGIN SELECT RAISE(ABORT,'real late metadata2 receipt failure'); END`)
  assert.throws(()=>t.apply(input),/real late metadata2 receipt failure/)
  assert.deepEqual(allTables(db),before,'The entire actual outer IMMEDIATE operation rolls back despite earlier physical writes')
  db.exec('DROP TRIGGER metadata2_test_receipt_failure')
  const result=t.apply(input)
  assert.equal(result.status,'applied')
  const committed=allTables(db),changed=structuredClone(input);changed.finalAfter[0].title='A different original body'
  assert.throws(()=>t.apply(changed),/idempotency-mismatch/)
  assert.deepEqual(allTables(db),committed)
  assert.equal(t.apply(input).replayed,true)
}))
