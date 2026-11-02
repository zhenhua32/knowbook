import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React,{act} from 'react'
import { JSDOM } from 'jsdom'
import type { ElectronApi } from '../src/shared/contracts'
import type { WorkspaceSearchOccurrence } from '../src/shared/workspace-search-occurrence'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url,context,next){if(url.endsWith('.css'))return{format:'module',source:'',shortCircuit:true};return next(url,context)}`)}`,import.meta.url)
const {default:SearchPage}=await import('../src/renderer/src/pages/SearchPage')

test('the real Main canonical page renders repeated instances independently and sends the exact address to inline navigation',
  {concurrency:false},async t=>{
    t.mock.timers.enable({apis:['setTimeout']})
    await withCanonicalSearchFixture(async f=>{
      const dom=new JSDOM('<div id="mount"></div>',{url:'http://localhost'}),previous=new Map<string,PropertyDescriptor|undefined>()
      const bridge:Partial<ElectronApi>={searchWorkspace:async input=>f.store.searchWorkspace(input),getSearchFacets:async()=>f.store.getSearchFacets(),
        listSavedSearches:async()=>[],onWorkspaceMutated:()=>()=>{},onSyncedBlocksChanged:()=>()=>{},writeClipboardText:async()=>{}}
      Object.defineProperty(dom.window,'knowbook',{value:bridge})
      for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,
        HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,IS_REACT_ACT_ENVIRONMENT:true})){
        previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value})
      }
      const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('mount')!)
      const opened:WorkspaceSearchOccurrence[]=[],ordinary:string[]=[]
      try{
        await act(async()=>root.render(<SearchPage isActive isZh={false} documentTree={[]} request={{query:'Quasar',sequence:1}}
          onOpenDocument={id=>{ordinary.push(id);return true}} onOpenBlock={(_id,blockId)=>{ordinary.push(blockId);return true}}
          onOpenCanonical={async(address,shouldContinue)=>{
            const result=f.store.resolveWorkspaceSearchOccurrence(address)
            if(result.status!=='ready')throw new Error('Exact canonical occurrence changed')
            if(shouldContinue?.()===false)return false
            opened.push(result.occurrence);return true
          }}/>))
        await act(async()=>t.mock.timers.tick(200))
        const rows=dom.window.document.querySelectorAll<HTMLElement>('[data-testid="workspace-search-result"]')
        assert.equal(rows.length,3)
        assert.equal(new Set(Array.from(rows,row=>row.dataset.instanceId)).size,3)
        const row=Array.from(rows).find(row=>row.dataset.instanceId===f.secondInstanceId)!
        assert.ok(row);assert.equal(row.dataset.blockId,f.childId,'Opaque canonical child identity is retained within the explicit occurrence')
        await act(async()=>{row.querySelector<HTMLButtonElement>('button.primary-button')!.click()})
        assert.equal(opened.length,1);assert.equal(opened[0].instanceId,f.secondInstanceId);assert.equal(opened[0].hostDocumentId,f.hostId)
        assert.equal(opened[0].canonicalBlockId,f.childId);assert.deepEqual(ordinary,[],'Canonical navigation never falls back to a naked ordinary block ID')
        f.edit()
        await act(async()=>{row.querySelector<HTMLButtonElement>('button.primary-button')!.click()})
        assert.equal(opened.length,1);assert.match(dom.window.document.body.textContent??'',/Exact canonical occurrence changed/)
      }finally{
        await act(async()=>root.unmount())
        for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
        dom.window.close()
      }
    })
  })
