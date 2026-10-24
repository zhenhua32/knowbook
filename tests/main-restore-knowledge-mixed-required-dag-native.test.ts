import assert from 'node:assert/strict'
import test from 'node:test'
import { withV3Fixture,mixedPair,allTables,readActualFirstRequiredSqlDagMaterial } from './helpers/mixed-required-source-fixture'
import { reopenActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { reopenFirstRequiredSqlDag, readCertifiedRequiredSqlDag } from '../src/main/database/restore-knowledge-required-dag-read'

for(const reader of [1,2] as const)
  test(`actual first required DAG retains both independent reader${reader} originals and reopens their complete material without collapsing equal groups`,()=>withV3Fixture(async f=>{
    const pair=await mixedPair(f,[reader,reader]),before=allTables(f.db),saved=await pair.capture()
    assert.equal(saved.material.inputs.length,2)
    assert.notEqual(saved.material.inputs[0].capsule.capsuleId,saved.material.inputs[1].capsule.capsuleId)
    assert.deepEqual(saved.material.inputs[0].knowledge.projection.groups.map(g=>g.comparisonKey),saved.material.inputs[1].knowledge.projection.groups.map(g=>g.comparisonKey))
    const reopened=await reopenActualFirstRequiredSqlDag(saved.reopen)
    assert.deepEqual(await readActualFirstRequiredSqlDagMaterial(reopened),saved.material)
    if(reader===1){const legacy=await readCertifiedRequiredSqlDag(await reopenFirstRequiredSqlDag(saved.reopen))
      assert.deepEqual(legacy.root,saved.material.root);assert.deepEqual(legacy.node,saved.material.node)}
    assert.deepEqual(allTables(f.db),before)
  }))
