import assert from 'node:assert/strict'
import { reopenFirstRequiredSqlDag, extractRequiredRootKnowledgeMaterial, readRequiredRootKnowledgeMaterial,
  assertRequiredRootKnowledgeArtifactsFreshNow, type ReopenFirstRequiredSqlDagInput } from '../../src/main/database/restore-knowledge-required-dag-read'
export interface RequiredRootMaterialChildResult { pid: number; witnessReturnedVoid: true; capsules: number; groups: number; acceptedCoverage: false }
try {
  const input = JSON.parse(process.argv[2]) as ReopenFirstRequiredSqlDagInput
  const material = await extractRequiredRootKnowledgeMaterial(await reopenFirstRequiredSqlDag(input)), value = await readRequiredRootKnowledgeMaterial(material)
  assert.equal(assertRequiredRootKnowledgeArtifactsFreshNow(material), undefined)
  const result: RequiredRootMaterialChildResult = { pid: process.pid, witnessReturnedVoid: true,
    capsules: value.capsuleBindings.length, groups: value.union.groups.length, acceptedCoverage: false }
  console.log(JSON.stringify(result))
} catch (error) { console.error(String(error)); process.exitCode = 1 }
