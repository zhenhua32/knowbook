import assert from 'node:assert/strict'
import test from 'node:test'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { validateCapsule2ReferenceContext, capsule2ReferenceContextHash, parseCapsule2ReferenceContext, requiredReferenceRoots,
  referenceContextMountedRoots } from '../src/main/database/restore-knowledge-reference-context-model'
import { rawPriorCoverageRequirementsHash } from '../src/main/database/restore-knowledge-coverage-model'
import { validateCapsule2BoundSourceManifest, capsule2BoundSourceHash, parseCapsule2BoundSourceManifest } from '../src/main/database/restore-knowledge-bound-source-model'
import { CAPSULE2_READER } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { id, hash, rawRequirement, requirements, clone } from './helpers/coverage-structure-fixture'

function data() {
  const raw = { ...requirements(), entries: [rawRequirement(1)] }
  return validateCapsule2ReferenceContext({ kind: 'capsule2-original-reference-context', version: 1, scope: 'complete-referenced-original-inputs',
    contextId: id(50), source: { operationId: id(51), capsuleId: id(52), sourceManifestHash: hash(1), sourceMaterialHash: hash(2), rawRequirementsHash: rawPriorCoverageRequirementsHash(raw) },
    requirements: raw, parents: [{ reference: raw.entries[0].root, mountId: id(53), reader: 'prepared-mixed-v2', descriptorHash: hash(3), originalRoot: raw.entries[0].root,
      materialHash: hash(4), originalSqlBytes: 1, managedOriginalBytes: 0, files: [{ frame: [], path: 'descriptor.json', bytes: 1, sha256: hash(5) }], directories: [] }],
    acceptedCoverage: false, effective: false, permit: false })
}
test('reference context data preserves raw reference domains while allocating separate explicit mounted roots without authority', () => {
  const value = data(), digest = capsule2ReferenceContextHash(value)
  assert.deepEqual(parseCapsule2ReferenceContext(capsuleJson(value) + '\n', digest), value)
  const [mounted] = referenceContextMountedRoots(value)
  assert.equal(mounted.namespace.kind, 'imported-bundle'); assert.equal(value.requirements.entries[0].root.namespace.kind, 'native')
  assert.equal(mounted.rootHash, value.parents[0].originalRoot.rootHash)
  assert.equal(value.acceptedCoverage, false); assert.equal(value.effective, false); assert.equal(value.permit, false)
  assert.throws(() => parseCapsule2ReferenceContext(capsuleJson(value), digest))
  assert.throws(() => parseCapsule2ReferenceContext(capsuleJson(value) + '\n', hash(0)))
})
test('reference context codecs refuse incomplete, conflicting, unbounded and accessor inventories without invoking getters', () => {
  for (const attack of ['missing-root','different-root','missing-header','orphan-directory','duplicate-file','traversal','depth','authority'] as const) {
    const changed = clone(data())
    if (attack === 'missing-root') changed.parents = []
    if (attack === 'different-root') changed.parents[0].originalRoot.rootHash = hash(0)
    if (attack === 'missing-header') changed.parents[0].files = []
    if (attack === 'orphan-directory') changed.parents[0].directories = [{ frame: [id(99)], path: 'orphan' }]
    if (attack === 'duplicate-file') changed.parents[0].files.push(changed.parents[0].files[0])
    if (attack === 'traversal') changed.parents[0].files[0].path = '../outside'
    if (attack === 'depth') changed.parents[0].files[0].frame = Array(129).fill(id(99))
    if (attack === 'authority') Object.assign(changed, { acceptedCoverage: true })
    assert.throws(() => validateCapsule2ReferenceContext(changed), attack)
  }
  let observed = 0
  const changed = clone(data())
  Object.defineProperty(changed.parents[0].files[0], 'sha256', { enumerable: true, get() { observed++; return hash(3) } })
  assert.throws(() => validateCapsule2ReferenceContext(changed)); assert.equal(observed, 0)
  assert.throws(() => requiredReferenceRoots({ ...requirements(), entries: Array.from({ length: 129 }, (_, i) => rawRequirement(i + 1)) }), /预算/)
})
test('bound input data remains distinct from no-prior semantic certification and binds exact source/context locators', () => {
  const context = data()
  const value = validateCapsule2BoundSourceManifest({ kind: 'capsule2-bound-reference-inputs', version: 1, readerVersion: CAPSULE2_READER,
    scope: 'complete-source-and-referenced-original-inputs', operationId: context.source.operationId, capsuleId: context.source.capsuleId,
    sourceManifestHash: context.source.sourceManifestHash, sourceMaterialHash: context.source.sourceMaterialHash, sourceKnowledgeHash: hash(8),
    rawRequirementsHash: context.source.rawRequirementsHash, contextId: context.contextId, contextHash: capsule2ReferenceContextHash(context),
    requiredCoverageEntries: 1, referencedRoots: 1, resolvedRootsHash: hash(9), originalReferenceDomain: 'explicit-complete-original-context', originalInputsComplete: true,
    certified: false, semanticValidationComplete: false, acceptedCoverage: false, effective: false, permit: false, policyReplayAllowed: false })
  assert.deepEqual(parseCapsule2BoundSourceManifest(capsuleJson(value) + '\n', value.operationId, value.capsuleId, capsule2BoundSourceHash(value)), value)
  for (const key of ['certified','semanticValidationComplete','acceptedCoverage','effective','permit','policyReplayAllowed'])
    assert.throws(() => validateCapsule2BoundSourceManifest({ ...value, [key]: true }))
  assert.throws(() => validateCapsule2BoundSourceManifest({ ...value, requiredCoverageEntries: 0 }))
  assert.throws(() => parseCapsule2BoundSourceManifest(capsuleJson(value) + '\n', id(200), value.capsuleId, capsule2BoundSourceHash(value)))
})
