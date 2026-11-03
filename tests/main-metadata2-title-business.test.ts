import assert from 'node:assert/strict'
import test from 'node:test'
import { readStrictHostDocument } from '../src/main/database/synced-host-document-read'
import { hostHash, decodeHostJournal } from '../src/main/database/synced-host-journal'
import { readTitle2OriginalOperationOwned } from '../src/main/database/synced-host-title2-read'
import { TITLE2_OPERATION_KIND } from '../src/main/database/synced-host-title2-codec'
import { getSyncedHostHistory } from '../src/main/database/synced-blocks-read'
import { snapshot, allTables } from './helpers/synced-backup-v3-fixture'
import { withTitle2Fixture } from './helpers/metadata2-title-fixture'

test('real fenced title action saves host/descendant paths and independent canonical/ordinary links, then Undo and Redo restore them atomically without replaying an old group snapshot', () => withTitle2Fixture(t=>{
  const {f,store,sessionId,sender}=t,db=store.getUnsafeDatabaseHandle(),old=snapshot(db,t.groupId)
  const originalAck=db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId)
  const input=t.titleInput('V3 Host','Renamed Host'),rawW=structuredClone(input.hostsWorkingBefore[0].workingBefore)
  const saved=t.apply(input)
  assert.equal(saved.status,'applied');assert.ok(saved.historyToken)
  assert.deepEqual(saved.hosts[0].logicalBefore,rawW,'The public ACK retains the exact raw submitted W')
  assert.equal(saved.hosts[0].after.title,'Renamed Host')
  assert.equal(store.getDocumentDetail(t.childId)!.path,'Renamed Host/Child')
  assert.ok(store.getDocumentDetail(f.hostId)!.blocks.find(block=>block.id===t.hostOrdinaryLink)!.content.includes('Renamed%20Host/Child.md'))
  assert.ok(store.getDocumentDetail(t.observerId)!.blocks.find(block=>block.id===t.ordinaryLink)!.content.includes('Renamed%20Host.md'))
  const renamed=snapshot(db,t.groupId)
  assert.notEqual(renamed.revision,old.revision);assert.equal(renamed.topologyRevision,old.topologyRevision)
  assert.equal(renamed.history.undoToken,null)
  assert.ok(renamed.blocks[0].content.includes('Renamed%20Host.md'))
  assert.deepEqual(renamed.blocks.map(block=>[block.id,block.createdAt]),old.blocks.map(block=>[block.id,block.createdAt]))
  assert.deepEqual(renamed.origin,old.origin,'Origin is not rewritten to the current host name')
  assert.ok(db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?').get('V3 Host',f.instanceId))
  for(const row of db.prepare('SELECT id,link_count FROM documents').all() as Array<{id:string;link_count:number}>)
    assert.equal(row.link_count,(db.prepare('SELECT count(*) AS n FROM links WHERE source_document_id=?').get(row.id) as {n:number}).n)
  const original=db.transaction(()=>readTitle2OriginalOperationOwned(db,input.clientOperationId))()
  assert.ok(original?.journal)
  assert.equal(original.envelope.kind,TITLE2_OPERATION_KIND)
  assert.equal(original.companion.rawLogicalChange,true)
  const journal=decodeHostJournal(original.journal)
  assert.equal(journal.before[0].content.title,'V3 Host');assert.equal(journal.after[0].content.title,'Renamed Host')
  assert.ok(journal.after[0].content.blocks.find(block=>block.id===t.hostOrdinaryLink)!.content.includes('V3%20Host/Child.md'),
    'The old journal bytes preserve raw W/A; the independent v2 companion authenticates the actual Main navigation projection')
  const committed=allTables(db),replayed=t.apply(input)
  assert.equal(replayed.replayed,true);assert.deepEqual(allTables(db),committed)
  const lookup=store.invokeSyncedEditingSession(sender,{sessionId,method:'getSyncedOperation',input:{clientOperationId:input.clientOperationId}})
  assert.equal(lookup.status,'committed')
  const {result:undone}=t.restore(saved,'undo')
  assert.equal(undone.hosts[0].after.title,'V3 Host')
  assert.equal(store.getDocumentDetail(t.childId)!.path,'V3 Host/Child')
  assert.deepEqual(snapshot(db,t.groupId).blocks,old.blocks,'Canonical URL maintenance is reversed with the host title')
  assert.ok(store.getDocumentDetail(t.observerId)!.blocks.find(block=>block.id===t.ordinaryLink)!.content.includes('V3%20Host.md'))
  assert.ok(store.getDocumentDetail(f.hostId)!.blocks.find(block=>block.id===t.hostOrdinaryLink)!.content.includes('V3%20Host/Child.md'))
  const {result:redone}=t.restore(saved,'redo')
  assert.equal(redone.hosts[0].after.title,'Renamed Host');assert.ok(snapshot(db,t.groupId).blocks[0].content.includes('Renamed%20Host.md'))
  assert.deepEqual(db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId),originalAck)
}))

test('real dirty W=A title flush keeps a null logical token while actual Main rewrites both the host child link and canonical field', () => withTitle2Fixture(t=>{
  const db=t.store.getUnsafeDatabaseHandle(),before=getSyncedHostHistory(db,{documentId:t.f.hostId}),initialGroup=snapshot(db,t.groupId),input=t.titleInput('Flushed Host','Flushed Host')
  // Use the actual public renderer-facing DTO. Empty SQL tags are absent in
  // this API; do not manufacture [] to match the private strict SQL reader.
  const publicHost=t.store.getDocumentDetail(t.f.hostId)!
  const publicBlocks=publicHost.blocks.map(({sortOrder:_sortOrder,...block})=>({...block,parentBlockId:block.parentBlockId??null}))
  assert.ok(publicBlocks.some(block=>block.tags===undefined),'The genuine public DTO has the original empty-tag representation')
  input.hostsWorkingBefore[0].workingBefore.blocks=structuredClone(publicBlocks)
  input.finalAfter[0].blocks=structuredClone(publicBlocks)
  const raw=structuredClone(input.hostsWorkingBefore[0].workingBefore),saved=t.apply(input)
  assert.equal(saved.historyToken,null)
  assert.deepEqual(getSyncedHostHistory(db,{documentId:t.f.hostId}),before,'P!=W=A does not append or move an Undo action')
  assert.equal(saved.hosts[0].logicalBeforeHash,hostHash(raw))
  assert.notEqual(hostHash(raw),hostHash(readStrictHostDocument(db,t.f.hostId)!.content),'Actual A has rewritten navigation hints; this must not manufacture W→A history')
  assert.ok(saved.hosts[0].after.blocks.find(block=>block.id===t.hostOrdinaryLink)!.content.includes('Flushed%20Host/Child.md'))
  assert.ok(snapshot(db,t.groupId).blocks[0].content.includes('Flushed%20Host.md'))
  const original=db.transaction(()=>readTitle2OriginalOperationOwned(db,input.clientOperationId))()
  assert.ok(original)
  assert.equal(original.companion.rawLogicalChange,false)
  assert.equal(original.companion.historyToken,null)
  assert.equal(original.companion.workingContentHash,original.companion.afterContentHash)
  assert.deepEqual(original.companion.workingEffects,original.companion.afterEffects)
  const localUndo=t.titleInput('V3 Host','V3 Host')
  localUndo.hostsWorkingBefore[0].workingBefore.blocks=structuredClone(raw.blocks)
  localUndo.finalAfter[0].blocks=structuredClone(raw.blocks)
  const restored=t.apply(localUndo)
  assert.equal(restored.historyToken,null,'A real local working-state Undo flush still does not invent a second Main action')
  assert.equal(restored.hosts[0].after.title,'V3 Host')
  assert.deepEqual(snapshot(db,t.groupId).blocks,initialGroup.blocks)
  assert.deepEqual(getSyncedHostHistory(db,{documentId:t.f.hostId}),before)
}))
