import assert from 'node:assert/strict'
import test from 'node:test'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'

test('actual workspace search pages every repeated canonical occurrence across hosts and preserves ordinary matching without host JSON copies',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const before=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
    const occurrences:string[]=[],pages=[]
    for(let page=1;page<=4;page++){
      const result=f.store.searchWorkspace({query:f.query,scope:'blocks',page,pageSize:2});pages.push(result)
      assert.equal(result.total,7)
      for(const item of result.items){if(item.canonicalOccurrence){
        const address=item.canonicalOccurrence
        assert.equal(item.blockId,address.canonicalBlockId);assert.equal(item.documentId,address.hostDocumentId)
        assert.equal(address.groupId,f.searchGroupId);assert.ok(address.canonicalCreatedAt);assert.ok(address.instanceCreatedAt)
        occurrences.push(JSON.stringify([address.hostDocumentId,address.instanceId,address.canonicalBlockId]))
        assert.equal(f.store.resolveWorkspaceSearchOccurrence(address).status,'ready')
      }else assert.equal(item.documentId,f.ordinaryDocumentId)}
    }
    assert.equal(new Set(occurrences).size,6);assert.equal(occurrences.length,6);assert.equal(pages[3].items.length,1)
    assert.equal(f.store.searchWorkspace({query:'Quasar nebula',scope:'blocks',matchMode:'phrase'}).total,3)
    assert.equal(f.store.searchWorkspace({query:'Quasar missingterm',scope:'blocks',matchMode:'all'}).total,0)
    assert.equal(f.store.searchWorkspace({query:'Quasar missingterm',scope:'blocks',matchMode:'any'}).total,3)
    assert.equal(f.store.searchWorkspace({query:'数',scope:'blocks'}).total,3)
    const filtered=f.store.searchWorkspace({query:f.query,scope:'blocks',tag:'canonical-only',blockType:'paragraph'})
    assert.equal(filtered.total,3);assert.ok(filtered.items.every(row=>row.canonicalOccurrence?.canonicalBlockId===f.childId))
    assert.equal(f.store.searchWorkspace({query:'',scope:'documents',tag:'canonical-only'}).total,2)
    assert.ok(f.store.getSearchFacets().tags.includes('canonical-only'))
    assert.equal(f.store.searchWorkspace({query:f.searchGroupId,scope:'blocks'}).total,0,'Opaque host ref JSON is never searchable business text')
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM blocks WHERE id IN (?,?)').get(f.childId,f.secondChildId) as {n:number}).n,0)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,before,'Search, facets and fresh resolution are actual readonly SQL')
  }))

test('canonical edits invalidate exact old occurrence addresses and orphaned groups never select a guessed host',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const old=f.store.searchWorkspace({query:'Quasar',scope:'blocks'}).items.map(item=>item.canonicalOccurrence!)
    assert.equal(old.length,3)
    f.edit()
    for(const address of old)assert.equal(f.store.resolveWorkspaceSearchOccurrence(address).status,'stale')
    const fresh=f.store.searchWorkspace({query:'changed',scope:'blocks'}).items.filter(item=>item.canonicalOccurrence?.groupId===f.searchGroupId)
    assert.equal(fresh.length,6)
    for(const item of fresh)assert.equal(f.store.resolveWorkspaceSearchOccurrence(item.canonicalOccurrence!).status,'ready')
    f.orphan()
    assert.equal(f.store.searchWorkspace({query:'Quasar',scope:'blocks'}).total,0)
    for(const item of fresh)assert.equal(f.store.resolveWorkspaceSearchOccurrence(item.canonicalOccurrence!).status,'missing')
  }))
