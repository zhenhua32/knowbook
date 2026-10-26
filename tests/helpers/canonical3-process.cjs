(async () => {
  const assert = require('node:assert/strict'), fs = require('node:fs/promises')
  const { locator, identityLocator, referenceLocator, expectedPath } = JSON.parse(process.argv[2])
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { reopenRootRestoreReferencePlan3, readRootRestoreReferencePlan3 }
    = await import('../../src/main/database/restore-knowledge-reference3-read.ts')
  const original = await reopenPreparedMixedOriginBundle(locator)
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, identityLocator)
  const actual = await reopenRootRestoreReferencePlan3(identity.plan, referenceLocator)
  assert.equal(identity.planId, identityLocator.planId)
  assert.equal(identity.manifestHash, identityLocator.expectedManifestHash)
  assert.equal(actual.planId, referenceLocator.planId)
  assert.equal(actual.manifestHash, referenceLocator.expectedManifestHash)
  // No expected cells, allocation or choices enter a factory. Read the oracle
  // only after genuine original SQL/K and both copied kernels mint new owners.
  const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'))
  assert.deepEqual(actual.value, expected)
  assert.equal(identity.value.allocationHash, expected.allocation.baseIdentityAllocationHash)
  assert.equal(actual.value.allocation.derivedReferenceAllocationHash, expected.allocation.derivedReferenceAllocationHash)
  assert.equal(actual.value.candidate.canonicalCandidateHash, expected.candidate.canonicalCandidateHash)
  assert.equal(actual.value.candidate.checkedCanonicalCandidateHash, expected.candidate.checkedCanonicalCandidateHash)
  assert.deepEqual(await readRootRestoreReferencePlan3(actual.plan), expected)
  process.stdout.write(JSON.stringify({ pid: process.pid, baseIdentityAllocationHash: identity.value.allocationHash,
    derivedReferenceAllocationHash: actual.value.allocation.derivedReferenceAllocationHash,
    canonicalCandidateHash: actual.value.candidate.canonicalCandidateHash,
    checkedCanonicalCandidateHash: actual.value.candidate.checkedCanonicalCandidateHash,
    tables: actual.value.candidate.tables.length, canonicalEdits: actual.value.candidate.canonicalEdits.length,
    activeGroupWires: actual.value.candidate.activeGroupWires.length }))
})().catch(error => { console.error(error); process.exitCode = 1 })
