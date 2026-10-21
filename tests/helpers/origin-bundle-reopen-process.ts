import assert from 'node:assert/strict'
import { readPreparedOriginBundle, reopenPreparedOriginBundle,
  type ReopenPreparedOriginBundleInput } from '../../src/main/database/restore-knowledge-origin-bundle-read'
import type { CoverageCapsuleReference, CoverageRootReference } from '../../src/main/database/restore-knowledge-coverage-model'

export interface OriginBundleChildResult {
  kind: 'origin-bundle-real-process-reopen-result'; pid: number; descriptorHash: string
  root: CoverageRootReference; originalRoot: CoverageRootReference; capsules: readonly CoverageCapsuleReference[]
  preparedEvidence: true; acceptedCoverage: false; effectivePermit: false; fullNonemptyAncestorSupport: false
  groups: number; badHashRejected: true
}
try {
  const input = JSON.parse(process.argv[2]) as ReopenPreparedOriginBundleInput
  // No parent process handle, cached payload or caller file map enters here.
  const value = await readPreparedOriginBundle(await reopenPreparedOriginBundle(input))
  assert.equal(value.preparedEvidence, true); assert.equal(value.acceptedCoverage, false)
  assert.equal(value.effectivePermit, false); assert.equal(value.fullNonemptyAncestorSupport, false)
  const badHash = input.expectedDescriptorHash === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64)
  await assert.rejects(reopenPreparedOriginBundle({ ...input, expectedDescriptorHash: badHash }), /hash/)
  const result: OriginBundleChildResult = { kind: 'origin-bundle-real-process-reopen-result', pid: process.pid,
    descriptorHash: value.descriptorHash, root: value.root, originalRoot: value.originalRoot, capsules: value.capsules,
    preparedEvidence: true, acceptedCoverage: false, effectivePermit: false, fullNonemptyAncestorSupport: false,
    groups: value.groups, badHashRejected: true }
  console.log(JSON.stringify(result))
} catch (error) { console.error(String(error)); process.exitCode = 1 }
