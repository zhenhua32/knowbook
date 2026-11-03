import assert from 'node:assert/strict'
import test from 'node:test'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { snapshot } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { readSyncedHostHeadingsOwned2, planSyncedHeadingRewrites2 } from '../src/main/database/synced-heading-projection2'

test('native metadata2 heading space distinguishes every real host/instance/birth and keeps identity across canonical CAS edits',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const initial=snapshot(f.db,f.searchGroupId)
    editCreatedGroup(f.db,f.searchGroupId,initial.blocks.map(({createdAt:_birth,...block})=>({...block,type:'heading-1',content:'Shared section'})))
    const read=(documentId:string)=>f.db.transaction(()=>readSyncedHostHeadingsOwned2(f.db,documentId))()!
    const count=()=> (f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
    const beforeChanges=count(),host=read(f.hostId),other=read(f.targetId)
    assert.equal(count(),beforeChanges,'Projection performs no DML, healing or temporary host rows')
    const actual=host.headings.filter(heading=>heading.location.kind==='canonical'&&heading.location.instance.groupId===f.searchGroupId)
    const secondary=other.headings.filter(heading=>heading.location.kind==='canonical'&&heading.location.instance.groupId===f.searchGroupId)
    assert.equal(actual.length,4);assert.equal(secondary.length,2)
    assert.equal(new Set([...actual,...secondary].map(heading=>heading.key)).size,6)
    assert.equal(new Set(actual.map(heading=>heading.slug)).size,4)
    assert.deepEqual(new Set(actual.flatMap(heading=>heading.location.kind==='canonical'?[heading.location.instance.instanceId]:[])),new Set([f.firstInstanceId,f.secondInstanceId]))
    const changed=snapshot(f.db,f.searchGroupId)
    editCreatedGroup(f.db,f.searchGroupId,changed.blocks.map(({createdAt:_birth,...block})=>({...block,content:'Changed section'})))
    const after=read(f.hostId),next=after.headings.filter(heading=>heading.location.kind==='canonical'&&heading.location.instance.groupId===f.searchGroupId)
    assert.deepEqual(next.map(heading=>heading.key),actual.map(heading=>heading.key),'CAS/revision changes are not a new heading birth')
    const rewrites=planSyncedHeadingRewrites2(host.headings,after.headings)
    for(let index=0;index<actual.length;index++)assert.equal(rewrites.get(actual[index].slug),next[index].slug)
    f.orphan()
    assert.equal(read(f.hostId).headings.filter(heading=>heading.location.kind==='canonical'&&heading.location.instance.groupId===f.searchGroupId).length,0)
    assert.equal(read(f.targetId).headings.filter(heading=>heading.location.kind==='canonical'&&heading.location.instance.groupId===f.searchGroupId).length,0)
  }))
