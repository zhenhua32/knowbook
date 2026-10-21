import assert from 'node:assert/strict'
import { reopenPreparedOriginBundle, type ReopenPreparedOriginBundleInput } from '../../src/main/database/restore-knowledge-origin-bundle-read'
import { prepareFirstImportedQualifiedKnowledge, readPreparedFirstImportedQualifiedKnowledge } from '../../src/main/database/restore-knowledge-qualified-first-bundle-read'
import type { CoverageRootReference } from '../../src/main/database/restore-knowledge-coverage-model'

export interface QualifiedOwnerChildResult {
  kind: 'qualified-owner-real-process-reopen-result'; pid: number; materialHash: string; unionHash: string; descriptorHash: string
  root: CoverageRootReference; originalRoot: CoverageRootReference; originalNodeText: string
  projectionHashes: readonly string[]; payloadHashes: readonly string[]; groups: number
  preparedEvidence: true; certified: false; acceptedCoverage: false; effective: false; permit: false; fullRootInputSetProven: false
}
try {
  const input = JSON.parse(process.argv[2]) as ReopenPreparedOriginBundleInput
  // Only the persisted fixed mount is supplied. Fresh genuine bundle reopen
  // and both qualified SQL captures precede any new private material mint.
  const bundle = await reopenPreparedOriginBundle(input), value = await readPreparedFirstImportedQualifiedKnowledge(await prepareFirstImportedQualifiedKnowledge(bundle))
  assert.equal(value.preparedEvidence, true); assert.equal(value.certified, false); assert.equal(value.acceptedCoverage, false)
  const result: QualifiedOwnerChildResult = { kind: 'qualified-owner-real-process-reopen-result', pid: process.pid,
    materialHash: value.materialHash, unionHash: value.unionHash, descriptorHash: value.descriptorHash,
    root: value.root, originalRoot: value.originalRoot, originalNodeText: value.originalNodeText,
    projectionHashes: value.inputBindings.map(input => input.projectionHash), payloadHashes: value.inputBindings.map(input => input.payloadHash), groups: value.union.groups.length,
    preparedEvidence: true, certified: false, acceptedCoverage: false, effective: false, permit: false, fullRootInputSetProven: false }
  console.log(JSON.stringify(result))
} catch (error) { console.error(String(error)); process.exitCode = 1 }
