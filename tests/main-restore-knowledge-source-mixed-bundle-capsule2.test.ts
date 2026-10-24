import assert from 'node:assert/strict'
import test from 'node:test'
import { importPreparedMixedOriginBundle,readPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { withMixedBundleFixture,allTables } from './helpers/mixed-origin-bundle-fixture'

const readersToCheck:readonly (readonly [1|2,1|2])[]=[[2,2]]
for(const readers of readersToCheck)test(`mixed origin bundle preserves both original source${readers[0]} current${readers[1]} readers without collapsing independent mounts`,()=>withMixedBundleFixture(readers,async f=>{
  assert.equal(f.value.inputs.length,2);assert.equal(f.value.sourceMaterialHash,f.captured.material.materialHash)
  const second=await readPreparedMixedOriginBundle(await importPreparedMixedOriginBundle(f.input))
  assert.equal(second.descriptorHash,f.value.descriptorHash);assert.deepEqual(second.originalRoot,f.value.originalRoot)
  assert.notDeepEqual(second.root.namespace,f.value.root.namespace)
  assert.deepEqual(second.inputs.map(i=>i.knowledge),f.value.inputs.map(i=>i.knowledge))
  assert.notDeepEqual(second.inputs.map(i=>i.capsule.namespace),f.value.inputs.map(i=>i.capsule.namespace))
  assert.equal(f.value.managedOriginalBytes>0,readers[0]===2)
  assert.deepEqual(allTables(f.source.db),f.beforeSource);assert.deepEqual(allTables(f.receiver.db),f.beforeReceiver)
}))
