import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceSearchRepository as OriginalWorkspaceSearchRepository } from './helpers/workspace-search-ordinary-256'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'

test('the exact published ordinary search reader and new occurrence reader return the same full ordinary DTO on the same actual SQL input',
  {concurrency:false},()=>withCanonicalSearchFixture(f=>{
    const original=new OriginalWorkspaceSearchRepository(f.db)
    for(const input of [
      {query:'ordinary native',scope:'blocks' as const,matchMode:'all' as const},
      {query:'ordinary native block',scope:'blocks' as const,matchMode:'phrase' as const},
      {query:'Ordinary parity',scope:'documents' as const,sort:'updated-asc' as const},
      {query:'ordinary unchanged metadata',scope:'all' as const,page:40,pageSize:1},
      {query:'ordinary missing',scope:'blocks' as const,matchMode:'any' as const,pageSize:100}
    ])assert.deepEqual(f.store.searchWorkspace(input),original.search(input))
  }))
