import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { SyncedCanonicalWire, SyncedGroupWire, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { SyncedValidationError } from '../src/shared/syncedBlockValidation'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { localizeSyncedPortableGroupAssets, localizeSyncedPortableHostAssets, rewriteSyncedGroupAssets,
  rewriteSyncedPortableHostAssets, type SyncedPortableHostRecord } from '../src/shared/syncedBlockPortable'

const time='2026-10-17T00:00:00.000Z',digest='a'.repeat(64),otherDigest='b'.repeat(64),name="图 !'().png"
const portable='knowbook-asset://'+digest+'/'+encodeURIComponent(name)
// Independent expected URI; no actual directory, asset, DB or Main authority is created.
const managedUri=(filename:string)=>pathToFileURL(join(tmpdir(),'knowbook-pure-localizer','storage','assets','attachments','aa',digest,filename)).href
  .replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())
const local=managedUri(name)
const block=(content:string,id='ordinary'):SyncedCanonicalWire=>({id,type:'paragraph',content,checked:false,depth:0,parentBlockId:null,createdAt:time})
function group(content:string):SyncedGroupWire {
  return {kind:'synced-group',id:'11111111-1111-4111-8111-111111111111',creationId:'22222222-2222-4222-8222-222222222222',createdAt:time,
    origin:{version:1,documentId:'opaque-origin',pathAtCreation:'Origin',firstInstanceId:'33333333-3333-4333-8333-333333333333'},bindings:[],blocks:[block(content)]}
}
const stable=({createdAt:_born,...value}:SyncedCanonicalWire):SyncedStableBlockDraft=>value
function host(content:string,summary=''):SyncedPortableHostRecord {
  return {kind:'document',id:'opaque-host',parentId:null,sortOrder:0,createdAt:time,content:{title:'Host',summary,blocks:[stable(block(content))]}}
}

test('portable localizers preserve complete group Keys and host summary through an independent managed URI roundtrip while legacy outputs remain strict',()=>{
  for(const filename of ['comma,.png','plus+.png','at@.png','dollar$.png','semicolon;.png','hash#.png','percent%.png',"图 !'().png","[brackets]{braces}^`~.png"]) {
  const portable='knowbook-asset://'+digest+'/'+encodeURIComponent(filename),local=managedUri(filename)
  const text='😀 ![asset](<'+portable+'>) and [target](Target.md)',input=group(text),from=text.indexOf('[target]')
  input.bindings=[{blockId:'ordinary',from,to:text.length,raw:text.slice(from),syntax:'markdown',target:{kind:'document',id:'original-target',state:'live'}}]
  const config=createDefaultDatabaseViewConfig();config.query='[opaque](<'+portable+'>)'
  input.origin.pathAtCreation=portable
  input.blocks.push({...block('[opaque](<'+portable+'>)','literal-code'),type:'code',markdownFormat:{codeInfo:portable}},
    {...block(serializeDatabaseViewPayload({version:1,databaseId:'opaque-database',viewId:null,config}),'literal-config'),type:'database-view'})
  const before=structuredClone(input),calls:string[]=[]
  const localized=localizeSyncedPortableGroupAssets(input,uri=>{calls.push(uri);return local})
  assert.deepEqual(calls,[portable]);assert.equal(localized.blocks[0].content,text.replace(portable,local))
  const targetFrom=localized.blocks[0].content.indexOf('[target]')
  assert.deepEqual(localized.bindings,[{...input.bindings[0],from:targetFrom,to:localized.blocks[0].content.length}])
  assert.deepEqual(localized.blocks.slice(1),input.blocks.slice(1));assert.deepEqual(localized.origin,input.origin);assert.deepEqual(input,before)
  assert.deepEqual(rewriteSyncedGroupAssets(localized,uri=>{assert.equal(uri,local);return portable}),input)
  assert.throws(()=>rewriteSyncedGroupAssets(input,()=>local),SyncedValidationError)

  const source=host(text,'Summary ![actual](<'+portable+'>) tail');source.content.title=portable
  source.content.blocks.push(...input.blocks.slice(1).map(stable));const hostBefore=structuredClone(source)
  const localizedHost=localizeSyncedPortableHostAssets(source,uri=>{assert.equal(uri,portable);return local})
  assert.equal(localizedHost.content.summary,source.content.summary.replace(portable,local))
  assert.equal(localizedHost.content.blocks[0].content,text.replace(portable,local));assert.equal(localizedHost.content.title,portable)
  assert.deepEqual(localizedHost.content.blocks.slice(1),source.content.blocks.slice(1));assert.deepEqual(source,hostBefore)
  assert.deepEqual(rewriteSyncedPortableHostAssets(localizedHost,uri=>{assert.equal(uri,local);return portable}),source)
  assert.throws(()=>rewriteSyncedPortableHostAssets(source,()=>local),SyncedValidationError)
  }
})

test('portable localizers reject real file and malformed portable source destinations before calling a caller mapper',()=>{
  const invalid=[local,portable.replace('knowbook-','KNOWBOOK-'),portable.replace(digest,'user@'+digest),portable+'?query=1',portable+'#fragment',
    portable.replace('%E5','%e5'),'knowbook-asset://'+digest+'/%61sset.png','knowbook-asset://'+digest+'/forbidden*.png']
  for(const source of invalid) {
    let groupCalls=0,hostCalls=0
    assert.throws(()=>localizeSyncedPortableGroupAssets(group('![asset](<'+source+'>)'),()=>{groupCalls++;return local}),SyncedValidationError,source)
    assert.equal(groupCalls,0,source)
    assert.throws(()=>localizeSyncedPortableHostAssets(host('Literal ordinary body','![summary](<'+source+'>)'),()=>{hostCalls++;return local}),SyncedValidationError,source)
    assert.equal(hostCalls,0,source)
  }
})

test('portable localizers refuse nonfile credentials query fragments noncanonical spellings and every changed managed hash name or suffix',()=>{
  const invalid=[portable,'https://example.test/asset.png',local+'?download=1',local+'#fragment',
    local.replace('file:///','file://user:pass@'),local.replace('file:///','file://remote/'),local.replace('file:','FILE:'),
    local.replace('/attachments/','/files/'),local.replace('/aa/','/bb/'),
    local.replace('/aa/'+digest+'/','/bb/'+otherDigest+'/'),local.slice(0,local.lastIndexOf('/')+1)+'different.png',
    local.replace('%E5','%e5'),local.replace('%21','!'),local.replace('%20',' '),local.replace('/storage/','/other/../storage/')]
  assert.equal(new Set(invalid).size,invalid.length)
  for(const output of invalid) {
    let groupCalls=0,hostCalls=0
    assert.throws(()=>localizeSyncedPortableGroupAssets(group('![asset](<'+portable+'>)'),()=>{groupCalls++;return output}),SyncedValidationError,output)
    assert.equal(groupCalls,1,output)
    assert.throws(()=>localizeSyncedPortableHostAssets(host('Literal ordinary body','![summary](<'+portable+'>)'),()=>{hostCalls++;return output}),SyncedValidationError,output)
    assert.equal(hostCalls,1,output)
  }
})
