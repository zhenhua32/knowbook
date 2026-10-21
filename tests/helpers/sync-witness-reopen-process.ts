import assert from 'node:assert/strict'
import { reopenCertifiedDurableSqlDag, readCertifiedDurableSqlDag, extractRootKnowledgeMaterial, assertRootKnowledgeArtifactsFreshNow,
  type ReopenCertifiedDurableSqlDagInput } from '../../src/main/database/restore-knowledge-dag-read'

export interface SyncWitnessReopenResult { pid: number; witnessReturnedVoid: true; nodes: number; capsules: number }
try {
  const input = JSON.parse(process.argv[2]) as ReopenCertifiedDurableSqlDagInput
  const dag = await reopenCertifiedDurableSqlDag(input), diagnostic = await readCertifiedDurableSqlDag(dag), material = await extractRootKnowledgeMaterial(dag)
  assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined)
  const result: SyncWitnessReopenResult = { pid: process.pid, witnessReturnedVoid: true, nodes: diagnostic.nodes, capsules: diagnostic.capsules }
  console.log(JSON.stringify(result))
} catch (error) { console.error(String(error)); process.exitCode = 1 }
