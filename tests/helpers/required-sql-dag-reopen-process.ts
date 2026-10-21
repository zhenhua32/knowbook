import assert from 'node:assert/strict'
import { readCertifiedRequiredSqlDag, reopenFirstRequiredSqlDag,
  type ReopenFirstRequiredSqlDagInput } from '../../src/main/database/restore-knowledge-required-dag-read'
export interface RequiredSqlDagChildResult { pid: number; prepared: true; accepted: false; capsules: number; nodes: number }
try {
  const input = JSON.parse(process.argv[2]) as ReopenFirstRequiredSqlDagInput
  const value = await readCertifiedRequiredSqlDag(await reopenFirstRequiredSqlDag(input))
  assert.equal(value.acceptedCoverage, false)
  const result: RequiredSqlDagChildResult = { pid: process.pid, prepared: true, accepted: false, capsules: value.capsules.length, nodes: value.nodes }
  console.log(JSON.stringify(result))
} catch (error) { console.error(String(error)); process.exitCode = 1 }
