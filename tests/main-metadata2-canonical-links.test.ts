import assert from 'node:assert/strict'
import test from 'node:test'
import { withV3Fixture, snapshot, randomUUID } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { collectSyncedBindingOccurrences } from '../src/main/sync/synced-binding-occurrences'
import { readSyncedHostHeadingsOwned2, planSyncedHeadingRewrites2 } from '../src/main/database/synced-heading-projection2'
import { projectSyncedMetadataStoredGroupLinksOwned2 } from '../src/main/database/synced-metadata-group-links2'

test('metadata2 stored canonical projection keeps exact original Keys/Origin/birth and derives the new heading URL from actual native before/after',
  {concurrency:false},()=>withV3Fixture(f=>{
    const before=f.db.transaction(()=>readSyncedHostHeadingsOwned2(f.db,f.targetId))()!,group=snapshot(f.db,f.groupId)
    const wire={kind:'synced-group' as const,id:group.groupId,creationId:group.creationId,createdAt:group.createdAt,origin:group.origin,blocks:group.blocks,bindings:group.bindings}
    const target=f.store.getDocumentDetail(f.targetId)!
    f.store.updateDocument(f.targetId,{title:'Renamed target',summary:target.summary,blocks:target.blocks.map(block=>({...block,content:block.id===f.targetBodyId?'Renamed section':block.content}))})
    const after=f.db.transaction(()=>readSyncedHostHeadingsOwned2(f.db,f.targetId))()!
    const changes=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
    const projected=f.db.transaction(()=>projectSyncedMetadataStoredGroupLinksOwned2(f.db,wire,new Map([[f.targetId,{documentId:f.targetId,
      beforeCreatedAt:before.documentCreatedAt,afterCreatedAt:after.documentCreatedAt,beforePath:before.path,afterPath:after.path,
      headings:planSyncedHeadingRewrites2(before.headings,after.headings)}]])))()
    assert.equal(projected.changed,true)
    assert.deepEqual(projected.after.origin,wire.origin);assert.equal(projected.after.blocks[0].id,wire.blocks[0].id)
    assert.equal(projected.after.blocks[0].createdAt,wire.blocks[0].createdAt)
    assert.equal(collectSyncedBindingOccurrences(projected.after.origin,projected.after.blocks)[0].url,'Renamed%20target.md#renamed-section')
    const binding=projected.after.bindings[0];assert.equal(binding.target.kind,'heading')
    if(binding.target.kind==='heading'){assert.equal(binding.target.documentId,f.targetId);assert.equal(binding.target.slug,'renamed-section')}
    assert.equal(binding.raw,projected.after.blocks[0].content.slice(binding.from,binding.to))
    assert.deepEqual(snapshot(f.db,f.groupId).bindings,wire.bindings,'This readonly seam does not silently publish a partial metadata operation')
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes)
  }))

test('metadata2 never upgrades a genuinely captured unresolved canonical target from a later same-path native document',
  {concurrency:false},()=>withV3Fixture(f=>{
    const group=snapshot(f.db,f.groupId),id=randomUUID()
    editCreatedGroup(f.db,f.groupId,[...group.blocks.map(({createdAt:_birth,...block})=>block),{id,type:'paragraph',content:'[lost](Missing.md#ghost)',checked:false,parentBlockId:null,depth:0}])
    const captured=snapshot(f.db,f.groupId),binding=captured.bindings.find(item=>item.blockId===id)!
    assert.equal(binding.target.kind,'unresolved-url')
    const occupant=f.store.createDocument(null)
    f.store.updateDocument(occupant,{title:'Missing',summary:'',blocks:[{id:randomUUID(),type:'heading-1',content:'ghost',checked:false,parentBlockId:null,depth:0}]})
    const birth=(f.db.prepare('SELECT created_at FROM documents WHERE id=?').get(occupant) as {created_at:string}).created_at
    const result=f.db.transaction(()=>projectSyncedMetadataStoredGroupLinksOwned2(f.db,{kind:'synced-group',id:captured.groupId,creationId:captured.creationId,
      createdAt:captured.createdAt,origin:captured.origin,blocks:captured.blocks,bindings:captured.bindings},new Map([[occupant,{documentId:occupant,
      beforeCreatedAt:birth,afterCreatedAt:birth,beforePath:'Missing',afterPath:'Changed occupant',headings:new Map([['ghost','other']])}]])))()
    assert.deepEqual(result.after.bindings.find(item=>item.blockId===id)!.target,binding.target)
    assert.equal(collectSyncedBindingOccurrences(result.after.origin,result.after.blocks).find(item=>item.blockId===id)!.url,'Missing.md#ghost')
  }))
