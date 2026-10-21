import assert from 'node:assert/strict'
import test from 'node:test'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { knowledgeGroupComparisonKey, type KnowledgeHistoricalMaterial } from '../src/main/database/restore-knowledge-payload-model'
import { qualifiedKnowledgePayload2Hash, validateQualifiedKnowledgePayload2 } from '../src/main/database/restore-knowledge-qualified-payload-model'
import { summarizeQualifiedKnowledgeUnion2, unionQualifiedKnowledgeDiagnostics2, qualifiedKnowledgeUnion2Hash } from '../src/main/database/restore-knowledge-qualified-union-model'
import { qualifiedStructureFixture, changeProjection, uid } from './helpers/qualified-knowledge-structure-fixture'

// PREPARED-ONLY structural assertions. Synthetic DTOs are not genuine capsules,
// mounts, old proof/observation events, SQL readers or certified input handles.
test('qualified model binds two outer mounts to unchanged complete K1 projections without promoting the actual v1 reader', () => {
  const a = qualifiedStructureFixture(1), b = qualifiedStructureFixture(2)
  assert.equal(a.projectionHash, b.projectionHash)
  assert.notEqual(qualifiedKnowledgePayload2Hash(a), qualifiedKnowledgePayload2Hash(b))
  const raw = validateQualifiedKnowledgePayload2(a)
  assert.equal(capsuleJson(raw.projection), capsuleJson(a.projection))
  assert.equal(capsuleJson(raw.originalBinding), capsuleJson(a.originalBinding))
  assert.equal(raw.capsule.readerVersion, 'knowbook-durable-sql-v1'); assert.equal(raw.certified, false)
})

test('qualified union keeps identical input occurrences without manufacturing ambiguities or physical owner claims', () => {
  const a = qualifiedStructureFixture(), value = unionQualifiedKnowledgeDiagnostics2([a, a])
  assert.equal(value.payloads.length, 2); assert.equal(value.groups[0].variants.length, 2)
  assert.deepEqual(value.mappingAmbiguities, []); assert.deepEqual(value.localLocatorConflictCandidates, [])
  assert.deepEqual(value.groups[0].variants.map(item => item.origin.inputIndex), [0, 1])
  assert.equal(value.fullRootInputSetProven, false); assert.equal(value.acceptedCoverage, false); assert.equal(value.effective, false)
})

test('qualified known-value sets compare complete per-input history while unknowns and exact clones add no ambiguity', () => {
  const base = qualifiedStructureFixture(), both = changeProjection(base, p => ({ ...p, occupancy: [...p.occupancy, { ...p.occupancy[0], ownerId: 'B' }] }))
  const clone = { ...both, capsule: qualifiedStructureFixture(2).capsule }
  const unknown = changeProjection(qualifiedStructureFixture(3), p => ({ ...p, occupancy: p.occupancy.map(item => ({ ...item, ownerKind: null, ownerId: null })) }))
  assert.deepEqual(unionQualifiedKnowledgeDiagnostics2([both, clone, unknown]).mappingAmbiguities, [])
  const value = unionQualifiedKnowledgeDiagnostics2([base, both]), field = value.mappingAmbiguities[0].fields.find(item => item.field === 'owner-id')
  assert.ok(field); assert.deepEqual(field.alternatives.map(item => item.knownValues), [['A', 'B'], ['A']])
  for (const alternative of field.alternatives) { assert.ok(alternative.capsules.every(item => item.namespace.kind === 'imported-bundle')); assert.ok(alternative.witnesses.length) }
})

test('qualified provenance reaches every group denial exposure observation occupancy nested alternative and primary-row variant', () => {
  const a = qualifiedStructureFixture(1), b = changeProjection(qualifiedStructureFixture(2), p => ({ ...p,
    occupancy: p.occupancy.map(item => ({ ...item, ownerId: 'B' })), historicalMaterial: p.historicalMaterial.map(item => ({ ...item,
      fact: { ...item.fact, locator: { ...item.fact.locator, rowHash: 'd'.repeat(64) } } })) }))
  const value = unionQualifiedKnowledgeDiagnostics2([a, b])
  const variants = [...value.groups[0].variants, ...value.permanentDenials, ...value.exposures, ...value.observations, ...value.occupancy,
    ...value.historicalPrimaryRowDifferences.flatMap(item => item.variants), ...value.mappingAmbiguities.flatMap(item => item.variants)]
  assert.ok(variants.every(item => item.origin.capsule.namespace.kind === 'imported-bundle'))
  assert.ok(value.exposureKnowledge.every(item => item.origin.capsule.namespace.kind === 'imported-bundle'))
  assert.equal(value.permanentDenials.length, 2); assert.equal(value.historicalPrimaryRowDifferences.length, 1)
})

test('stable tuple comparison ignores mount mutable guards scope and epoch while retaining old denial and exposure witnesses', () => {
  const a = qualifiedStructureFixture(1), b = changeProjection(qualifiedStructureFixture(2), p => ({ ...p, workspaceScope: uid(50), recoveryEpoch: uid(51),
    groups: p.groups.map(item => ({ ...item, guards: { ...item.guards, revision: uid(52) } })), denials: [], exposures: [], observations: [] }))
  const value = unionQualifiedKnowledgeDiagnostics2([a, b])
  assert.equal(value.groups.length, 1); assert.equal(value.groups[0].comparisonKey, knowledgeGroupComparisonKey(a.projection.groups[0].tuple))
  assert.equal(value.permanentDenials.length, 1); assert.equal(value.exposures.length, 1); assert.equal(value.observations.length, 1)
  assert.equal(value.exposureKnowledge[0].attemptLowerBound, 'confirmed'); assert.equal(value.exposureKnowledge[1].attemptLowerBound, 'none-recorded')
})

test('same public native locator with different hashes is only an envelope-local structural conflict candidate', () => {
  const a = qualifiedStructureFixture(), b = qualifiedStructureFixture()
  const nativeA = { ...a, capsule: a.originalBinding.capsule }
  const hash = 'f'.repeat(64), projection = { ...b.projection, capsule: { ...b.projection.capsule, manifestHash: hash } }
  const nativeB = changeProjection({ ...b, capsule: { ...b.originalBinding.capsule, manifestHash: hash },
    originalBinding: { ...b.originalBinding, capsule: { ...b.originalBinding.capsule, manifestHash: hash } } }, () => projection)
  const value = unionQualifiedKnowledgeDiagnostics2([nativeA, nativeB])
  assert.equal(value.localLocatorConflictCandidates.length, 1)
  assert.equal(value.localLocatorConflictCandidates[0].classification, 'given-envelope-structural-only')
  assert.equal(value.payloads.length, 2); assert.equal(value.certified, false)
})

test('typed supports must resolve inside each complete envelope and cannot borrow equal rows from another input', () => {
  const a = qualifiedStructureFixture(1), missing = changeProjection(qualifiedStructureFixture(2), p => ({ ...p, originals: [] }))
  assert.throws(() => unionQualifiedKnowledgeDiagnostics2([a, missing]), /同一envelope/)
  const bad = changeProjection(a, p => ({ ...p, denials: p.denials.map(item => ({ ...item,
    mandatoryMaterial: [{ ...item.source, occurrence: item.source.occurrence + 1 }] })) }))
  assert.throws(() => validateQualifiedKnowledgePayload2(bad), /同一envelope/)
})

test('primary differences retain the four-family K1 filter and stay neutral evidence-only diagnostics', () => {
  const base = qualifiedStructureFixture(), families = ['initial-baseline', 'exchange-state', 'exchange-job-head', 'member-exposure'] as const
  const make = (hash: string) => changeProjection(base, p => ({ ...p, historicalMaterial: families.map(family => ({ ...p.historicalMaterial[0], fact: {
    ...p.historicalMaterial[0].fact, family, version: family === 'member-exposure' ? null : 1, locator: { ...p.historicalMaterial[0].fact.locator, rowHash: hash } } } as KnowledgeHistoricalMaterial)) }))
  const value = unionQualifiedKnowledgeDiagnostics2([make('a'.repeat(64)), make('b'.repeat(64))])
  assert.deepEqual(value.historicalPrimaryRowDifferences, []); assert.equal(value.status, 'evidence-only'); assert.equal(value.permit, false)
})

test('qualified envelope rejects mismatched outer binding inner references hashes and pretend capsule2 projections', () => {
  const a = qualifiedStructureFixture()
  assert.throws(() => validateQualifiedKnowledgePayload2({ ...a, capsule: { ...a.capsule, capsuleId: uid(99) } }), /op\/capsule\/hash/)
  assert.throws(() => validateQualifiedKnowledgePayload2({ ...a, projectionHash: 'f'.repeat(64) }), /projectionHash/)
  assert.throws(() => validateQualifiedKnowledgePayload2({ ...a, capsule: { ...a.capsule, readerVersion: 'knowbook-durable-sql-coverage-v2' } }), /实际K1\/v1/)
  assert.throws(() => validateQualifiedKnowledgePayload2({ ...a, certified: true }), /未认证/)
})

test('qualified input closure rejects accessors holes extra fields cycles without running caller code', () => {
  const a = qualifiedStructureFixture(); let calls = 0
  const accessor = { ...a }; Object.defineProperty(accessor, 'projection', { enumerable: true, get() { calls++; return a.projection } })
  assert.throws(() => validateQualifiedKnowledgePayload2(accessor), /accessor/); assert.equal(calls, 0)
  const hole = [a, a]; delete hole[0]; assert.throws(() => unionQualifiedKnowledgeDiagnostics2(hole), /hole/)
  assert.throws(() => validateQualifiedKnowledgePayload2({ ...a, ownerDomainId: 'caller invented' }), /闭集/)
  const cyclic: Record<string, unknown> = { ...a }; cyclic.projection = cyclic
  assert.throws(() => validateQualifiedKnowledgePayload2(cyclic), /循环/)
})

test('qualified projection preserves opaque historical spelling and raw INT64 REAL-bits NULL while summary exposes only refs hashes counts', () => {
  const a = qualifiedStructureFixture(), copy = validateQualifiedKnowledgePayload2(a)
  assert.equal(copy.projection.groups[0].tuple.origin.documentId, ' old:源\0 ')
  assert.deepEqual(copy.projection.originals[0].rows[0].cells, a.projection.originals[0].rows[0].cells)
  const summary = summarizeQualifiedKnowledgeUnion2([a]), text = JSON.stringify(summary)
  assert.equal(summary.inputOccurrences, 1); assert.equal(text.includes(' old:源'), false)
  assert.equal(summary.certified, false); assert.match(qualifiedKnowledgeUnion2Hash([a]), /^[0-9a-f]{64}$/)
})

test('opaque historical objects shaped like row references remain opaque data rather than invented SQL edges', () => {
  const a = changeProjection(qualifiedStructureFixture(), p => ({ ...p, denials: p.denials.map(item => ({ ...item,
    job: { ...item.job, syntheticOpaqueBusinessValue: { table: 'ordinary_business_data', key: [], occurrence: 0, rowHash: 'f'.repeat(64) } }
  })) }))
  const value = validateQualifiedKnowledgePayload2(a)
  assert.equal(capsuleJson(value.projection.denials[0].job), capsuleJson(a.projection.denials[0].job))
  assert.equal(value.projectionSemanticsAuthenticated, false)
})
