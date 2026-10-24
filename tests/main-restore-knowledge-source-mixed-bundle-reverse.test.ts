import assert from 'node:assert/strict'
import test from 'node:test'
import { withMixedBundleFixture,allTables } from './helpers/mixed-origin-bundle-fixture'
import { importPreparedOriginBundle } from '../src/main/database/restore-knowledge-origin-bundle-read'

const readersToCheck:readonly (readonly [1|2,1|2])[]=[[2,1]]
for(const readers of readersToCheck)test(`mixed origin bundle genuinely reopens source${readers[0]} current${readers[1]} in a foreign profile with complete qualified originals`,()=>withMixedBundleFixture(readers,async f=>{
  const value=f.value,original=f.captured.material
  assert.deepEqual(value.originalRoot,original.root);assert.deepEqual(value.originalNode,original.node);assert.equal(value.sourceMaterialHash,original.materialHash)
  assert.equal(value.inputs.length,2);assert.equal(value.fullRootInputSetProven,true);assert.equal(value.emptyKnowledgeProven,false)
  assert.equal(value.acceptedCoverage,false);assert.equal(value.effective,false);assert.equal(value.permit,false)
  assert.equal(value.managedOriginalBytes,original.managedOriginalBytes);assert.ok(value.managedOriginalBytes>0)
  for(const [i,input] of value.inputs.entries()){
    assert.deepEqual(input.originalCapsule,original.inputs[i].capsule);assert.deepEqual(input.binding,original.inputs[i].binding)
    assert.deepEqual(input.origin,original.inputs[i].origin);assert.deepEqual(input.knowledge,original.inputs[i].knowledge)
    assert.equal(input.capsule.namespace.kind,'imported-bundle');assert.deepEqual(input.capsule.namespace,value.root.namespace)
    assert.equal(input.capsule.readerVersion,input.knowledge.readerVersion)
    assert.ok(input.knowledge.projection.groups.some(g=>g.tuple.groupId===f.source.groupId))
  }
  await assert.rejects(importPreparedOriginBundle(f.input),/格式|字段|闭形|无效/)
  assert.deepEqual(allTables(f.source.db),f.beforeSource);assert.deepEqual(allTables(f.receiver.db),f.beforeReceiver)
}))
