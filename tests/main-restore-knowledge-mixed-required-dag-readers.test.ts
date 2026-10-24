import assert from 'node:assert/strict'
import test from 'node:test'
import { readCertifiedRequiredSqlDag } from '../src/main/database/restore-knowledge-required-dag-read'
import { withV3Fixture, mixedPair, allTables, diagnoseActualFirstRequiredSqlDag } from './helpers/mixed-required-source-fixture'
import { restoreInventory } from '../src/main/database/restore-safety-files'

for(const readers of [[1,2],[2,1]] as const)
  test(`actual first required DAG consumes genuine source${readers[0]} current${readers[1]} with complete reader-qualified K and unchanged SQL`,()=>withV3Fixture(async f=>{
    const pair=await mixedPair(f,readers),before=allTables(f.db),saved=await pair.capture(),value=saved.material
    assert.equal(value.version,3);assert.equal(value.inputs.length,2);assert.equal(value.fullRootInputSetProven,true)
    assert.equal(value.emptyKnowledgeProven,false);assert.equal(value.acceptedCoverage,false);assert.equal(value.effective,false);assert.equal(value.permit,false)
    assert.deepEqual([value.node.source.capsule.readerVersion,value.node.current.capsule.readerVersion],readers.map(r=>r===1?'knowbook-durable-sql-v1':'knowbook-durable-sql-coverage-v2'))
    assert.equal(value.node.parents.length,0)
    for(const input of value.inputs){assert.ok(input.knowledge.projection.groups.some(g=>g.tuple.groupId===f.groupId))
      assert.equal(input.knowledge.projection.kind,input.knowledge.readerVersion==='knowbook-durable-sql-v1'?'durable-sql-knowledge-payload':'capsule2-source-knowledge-projection')
      assert.equal(input.binding.requiredRoots.length,0)}
    assert.equal(value.originalSqlBytes,pair.sides.reduce((n,s)=>n+s.original.inventory.reduce((n,f)=>n+f.bytes,0),0))
    assert.equal(value.managedOriginalBytes,pair.sides.reduce((n,s)=>n+s.managedBytes,0));assert.ok(value.managedOriginalBytes>0)
    const diagnostic=await diagnoseActualFirstRequiredSqlDag(saved.handle)
    assert.equal(diagnostic.materialHash,value.materialHash);assert.equal(JSON.stringify(diagnostic).includes('projection'),false)
    await assert.rejects(readCertifiedRequiredSqlDag(saved.handle as never),/不是Main/)
    assert.deepEqual(allTables(f.db),before)
    for(const side of pair.sides)assert.deepEqual(await restoreInventory(side.original.info.originalDirectory),side.original.inventory)
  }))
