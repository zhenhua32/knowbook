import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkspaceSearchMatchMode } from '../src/shared/workspace-search'
import { WorkspaceSearchRepository as OriginalWorkspaceSearchRepository } from './helpers/workspace-search-ordinary-256'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'

test('canonical matching equals the published native trigram and short LIKE semantics for Unicode folds, accents, literals, NUL and mixed terms',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const original=new OriginalWorkspaceSearchRepository(f.db),ordinary=f.store.getDocumentDetail(f.ordinaryDocumentId)!
    const cases:ReadonlyArray<readonly[string,string,WorkspaceSearchMatchMode?]>=[
      ['prefix ΣΟΣ tail','σοσ'],['prefix ΣΟΣ tail','σος'],['ſoo phrase','soo'],['MicroµAbc','ΜABC'],
      ['ÄBC café','äbc'],['École','ecole'],['École','école'],['É','é'],['É','É'],['İxx','i\u0307xx'],['İxx','İxx'],
      ['𐐀bc','𐐨bc'],['𐒰bc','𐓘bc'],['foo%bar','%b'],['foo%bar','%_'],['foo_bar','_b'],['xa_by','a_b'],['xa_by','a%b'],
      ['prefix ab\0cd suffix','abcd'],['prefix ab\0cd suffix','cd'],['\ud800ab','\ud800ab'],
      ['abc.def','abc.def','phrase'],['Καφές café x','καφές CAFÉ'],['Καφές café x','καφές missing','any'],['Καφές café x','καφές missing','all'],
      ['astral 🌟🌟🌟 quoted "word"','🌟🌟🌟'],['astral 🌟🌟🌟 quoted "word"','quoted "word"','phrase'],
      ['😀'.repeat(100)+'ſoo after','soo']
    ]
    for(const[content,query,matchMode='all']of cases){
      f.store.updateDocument(f.ordinaryDocumentId,{title:ordinary.title,summary:ordinary.summary,blocks:[{...ordinary.blocks[0],content}]})
      const nativeOrdinary=(f.db.prepare('SELECT content FROM blocks WHERE id=?').get(ordinary.blocks[0].id) as {content:string}).content
      const current=f.store.resolveSyncedInlineInstance({hostDocumentId:f.hostId,instanceId:f.firstInstanceId,groupId:f.searchGroupId})
      assert.equal(current.status,'ready');if(current.status!=='ready')return
      // SQLite's UTF-8 binding normalizes malformed authored UTF16. Match both
      // readers on the same actual persisted TEXT, including that native rule.
      editCreatedGroup(f.db,f.searchGroupId,current.snapshot.blocks.map(({createdAt:_birth,...block})=>block.id===f.childId?{...block,content:nativeOrdinary}:block))
      const nativeCanonical=(f.db.prepare('SELECT content FROM synced_group_blocks WHERE id=?').get(f.childId) as {content:string}).content
      assert.equal(nativeCanonical,nativeOrdinary,'The two readers must receive the same actual persisted SQL TEXT')
      const input={query,scope:'blocks' as const,matchMode,pageSize:100}
      const expected=original.search(input).items.some(item=>item.blockId===ordinary.blocks[0].id)
      const actual=f.store.searchWorkspace(input).items.filter(item=>item.canonicalOccurrence?.canonicalBlockId===f.childId)
      assert.equal(actual.length,expected?3:0,JSON.stringify({content,query,matchMode,expected}))
      for(const item of actual){assert.equal(f.store.resolveWorkspaceSearchOccurrence(item.canonicalOccurrence!).status,'ready')
        assert.ok(item.snippet.length<=182);assert.equal(/\p{Surrogate}/u.test(item.snippet),false,'A display snippet does not split an astral codepoint')}
      if(query==='soo'&&content.startsWith('😀'))assert.ok(actual.every(item=>item.snippet.includes('ſoo')),'The display locates the actual native-fold match without using the snippet as an address')
    }
  }))
