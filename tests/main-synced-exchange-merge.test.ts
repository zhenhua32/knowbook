import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {AttachmentStore} from '../src/main/attachments'
import {join} from 'node:path'
import {withConflicts,commonGroup,completed,changeGroup,snapshot,hostEdit,request,applySyncedHostFinal,localPortable,remoteActual,converged,
  ready,component,editKeepingKeys,stateRow,physical,assetPath,randomUUID} from './helpers/synced-exchange-conflict-fixture'

test('real common group merges disjoint stable blocks and nested metadata then reopened peers converge without another publication',()=>withConflicts(async f=>{
  const id=await commonGroup(f,'alpha middle omega',true),before=snapshot(f.B.db,id),births=before.blocks.map(b=>physical(f.B.db,b.id))
  changeGroup(f.A.db,id,blocks=>{blocks[0].content='ALPHA middle omega';blocks[1].highlight='blue'});completed(await f.exchange(f.A),'applied')
  changeGroup(f.B.db,id,blocks=>{blocks[1].content='second stable LOCAL';blocks[0].tags=['local-tag']})
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied');const merged=snapshot(f.B.db,id)
  assert.equal(merged.blocks[0].content,'ALPHA middle omega');assert.deepEqual(merged.blocks[0].tags,['local-tag'])
  assert.equal(merged.blocks[1].content,'second stable LOCAL');assert.equal(merged.blocks[1].highlight,'blue')
  assert.deepEqual(merged.blocks.map(b=>b.createdAt),before.blocks.map(b=>b.createdAt))
  for(const [index,block] of merged.blocks.entries())assert.deepEqual(physical(f.B.db,block.id).identity,births[index].identity)
  f.reopen();const start=f.server.requests.length;completed(await f.exchange(f.B),'noop');converged(f)
  assert.equal(f.server.requests.slice(start).some(r=>r.path.endsWith('/manifest.json')&&(r.method==='PUT'||r.method==='MOVE')),false)
}))

test('real group same-block edits merge at grapheme boundaries and both accepted hashes become the new common source',()=>withConflicts(async f=>{
  const id=await commonGroup(f,'甲👩🏽‍💻乙🙂丙')
  changeGroup(f.A.db,id,b=>{b[0].content='新👩🏽‍💻乙🙂丙'});completed(await f.exchange(f.A),'applied')
  changeGroup(f.B.db,id,b=>{b[0].content='甲👩🏽‍💻乙🚀丙'});const value=completed(await f.exchange(f.B),'applied')
  assert.equal(snapshot(f.B.db,id).blocks[0].content,'新👩🏽‍💻乙🚀丙');assert.equal(value.deferred.length,0)
  const key='group:'+id,digest=remoteActual(f).manifest.entries[key],base=stateRow(f.B.db).state.baseline.find(v=>v.key===key)
  assert.equal(base?.commonHash,digest);assert.equal(base?.localHash,digest);assert.equal(base?.remoteHash,digest)
  completed(await f.exchange(f.A),'applied');converged(f)
}))

test('real opaque ordinary host merges remote summary and local body without manufacturing a group or changing physical birth',()=>withConflicts(async f=>{
  const id=f.islands[0],base=localPortable(f.B).entries['doc:'+id],birth=f.B.db.prepare('SELECT id,created_at FROM blocks WHERE document_id=? ORDER BY id').all(id)
  const input=request(f.A.db,[id],sides=>{sides[0].summary='A real independently changed summary'});assert.equal(applySyncedHostFinal(f.A.db,input).status,'applied')
  completed(await f.exchange(f.A),'applied');hostEdit(f.B.db,id,'B actual separate body')
  const value=completed(await f.exchange(f.B),'applied');assert.ok(value.acceptedKeys.includes('doc:'+id),'The genuine opaque host is accepted as its original identity')
  const {readStrictHostDocument}=await import('./helpers/synced-exchange-fixture'),actual=readStrictHostDocument(f.B.db,id).detail
  assert.equal(actual.summary,'A real independently changed summary');assert.equal(actual.blocks[0].content,'B actual separate body')
  assert.deepEqual(f.B.db.prepare('SELECT id,created_at FROM blocks WHERE document_id=? ORDER BY id').all(id),birth)
  assert.notEqual(localPortable(f.B).entries['doc:'+id],base);completed(await f.exchange(f.A),'applied');converged(f)
}))

test('real automatic merging projects reversed equal-URL historical bindings by full physical Key instead of URL or array position',()=>withConflicts(async f=>{
  completed(await f.exchange(f.A),'noop');completed(await f.exchange(f.B),'noop');const id=f.ack.createdLifecycle.groupId,base=snapshot(f.B.db,id)
  const original=base.bindings.filter(b=>b.raw==='Target.md').sort((a,b)=>a.from-b.from)
  assert.deepEqual(original.map(b=>b.target),[{kind:'document',id:f.target,state:'live'},{kind:'document',id:f.other,state:'live'}])
  editKeepingKeys(f.A,id,blocks=>{blocks[0].content='REMOTE prefix '+blocks[0].content});completed(await f.exchange(f.A),'applied')
  editKeepingKeys(f.B,id,blocks=>{blocks[0].content+=' LOCAL suffix'});completed(await f.exchange(f.B),'applied')
  const actual=snapshot(f.B.db,id),text=actual.blocks[0].content,pairs=actual.bindings.filter(b=>b.raw==='Target.md').sort((a,b)=>a.from-b.from)
  assert.ok(text.startsWith('REMOTE prefix ')&&text.endsWith(' LOCAL suffix'),'Both real nonoverlapping edits survive')
  assert.deepEqual(pairs.map(b=>b.target),original.map(b=>b.target))
  assert.deepEqual(pairs.map(b=>[b.blockId,b.from,b.to,b.raw,b.syntax]),[text.indexOf('Target.md'),text.lastIndexOf('Target.md')].map(from=>[base.blocks[0].id,from,from+'Target.md'.length,'Target.md','markdown']))
  completed(await f.exchange(f.A),'applied');converged(f)
},{sameUrl:true}))

test('real merged asset edits retain both managed byte sets alias names and opaque catalog strings',()=>withConflicts(async f=>{
  const id=f.ack.createdLifecycle.groupId,base=snapshot(f.B.db,id).blocks[0].content
  const store=new AttachmentStore(join(f.B.root,'storage','assets')),[fresh]=await store.import([{name:'B merge asset + 中文.png',bytes:Buffer.from('new B merged asset bytes')}])
  editKeepingKeys(f.A,id,blocks=>{blocks[0].content='A independent prefix '+blocks[0].content});completed(await f.exchange(f.A),'applied')
  changeGroup(f.B.db,id,blocks=>{blocks[0].content=base+' ![new](<'+fresh.url+'>)'})
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied');const graph=converged(f)
  assert.ok(snapshot(f.B.db,id).blocks[0].content.startsWith('A independent prefix '),'The merged canonical text contains the independently accepted remote edit')
  for(const alias of f.aliases)assert.deepEqual(readFileSync(assetPath(f.B,alias)),alias.bytes)
  for(const profile of [f.A,f.B])assert.deepEqual(readFileSync(assetPath(profile,{name:fresh.name,bytes:Buffer.from('new B merged asset bytes')})),Buffer.from('new B merged asset bytes'))
  assert.deepEqual([...graph.a.assets].map(([h,n])=>[h,[...n].sort()]),[...graph.b.assets].map(([h,n])=>[h,[...n].sort()]))
  assert.ok(graph.b.records.some(r=>r.kind==='synced-group'&&r.blocks.some(b=>b.type==='database-view'&&b.content.includes(f.A.defaultId))),'The opaque authored catalog text was not recursively rewritten by merge')
},{assets:true,catalog:true}))

test('missing genuine common bytes keep overlapping knowledge deferred and offer no invented merge while an unrelated island continues',()=>withConflicts(async f=>{
  const id=await commonGroup(f),key='group:'+id,old=stateRow(f.B.db).state.baseline.find(v=>v.key===key)
  assert.ok(old?.commonHash,'The negative fixture begins from a real authenticated common object')
  changeGroup(f.A.db,id,b=>{b[0].content='REMOTE without downloadable common bytes'});hostEdit(f.A.db,f.islands[0],'unrelated real incoming');completed(await f.exchange(f.A),'applied')
  changeGroup(f.B.db,id,b=>{b[0].content='LOCAL without downloadable common bytes'})
  f.server.files.delete('/'+f.targetConfig.directory+'/objects/'+old.commonHash+'.json')
  const before=snapshot(f.B.db,id),value=completed(await f.exchange(f.B),'applied');assert.ok(value.deferred.some(c=>c.keys.includes(key)&&c.reason==='baseline-missing'),'Missing B is not substituted with a current remote object')
  assert.deepEqual(snapshot(f.B.db,id),before);assert.deepEqual(stateRow(f.B.db).state.baseline.find(v=>v.key===key),old)
  const p=ready(await f.preview()),c=component(p,key);assert.equal(c.choices.includes('merge'),false)
  assert.ok(c.records.filter(r=>r.key===key).every(r=>r.merge===null),'No pure merge preview can claim a nonexistent authenticated ancestor')
}))
