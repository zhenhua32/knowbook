import assert from 'node:assert/strict'
import test from 'node:test'
import { COVERAGE_MAX_REQUIRED_ROOTS, COVERAGE_MAX_REQUIREMENT_ROWS, parseRawPriorCoverageRequirements,
  rawPriorCoverageRequirementsHash, serializeRawPriorCoverageRequirements,
  validateRawPriorCoverageRequirements, validateSyncedKnowledgeCoverageV1, type CoverageRootReference } from '../src/main/database/restore-knowledge-coverage-model'
import { clone, hash, historyCut, id, rawRequirement, requirements, root, structureFixture } from './helpers/coverage-structure-fixture'

// These are unresolved structure DTOs with digest-shaped locators. No SQL rows
// or accepted history are constructed; the future fixed SQL owner is unimplemented.
test('coverage structure retains every root at the exact whole-input budget and rejects one over budget before getters', () => {
  const input = clone(structureFixture().coverage)
  input.source.requiredRoots = Array.from({ length: COVERAGE_MAX_REQUIRED_ROOTS }, (_, index) => root(1000 + index))
  const complete = validateSyncedKnowledgeCoverageV1(input)
  assert.equal(complete.source.requiredRoots.length, COVERAGE_MAX_REQUIRED_ROOTS)
  assert.deepEqual(complete.source.requiredRoots.map(item => item.dagId), input.source.requiredRoots.map(item => item.dagId))
  let called = false
  const tooMany = new Array<CoverageRootReference>(COVERAGE_MAX_REQUIRED_ROOTS + 1).fill(root(40))
  Object.defineProperty(tooMany, '0', { enumerable: true, get() { called = true; return root(40) } })
  Object.assign(input.source, { requiredRoots: tooMany })
  assert.throws(() => validateSyncedKnowledgeCoverageV1(input), /超预算/)
  assert.equal(called, false, 'Length admission precedes all entry descriptors; nothing is truncated or read as a root')
})

test('coverage root collections reject holes, getters, hidden indices, extras, symbols and custom array prototypes', () => {
  let called = 0
  const hole = [root(40), root(41)]; delete hole[0]
  const getter = [root(40)]; Object.defineProperty(getter, '0', { enumerable: true, get() { called++; return root(40) } })
  const hidden = [root(40)]; Object.defineProperty(hidden, '0', { enumerable: false })
  const extra = [root(40)]; Object.defineProperty(extra, 'accepted', { value: true, enumerable: true })
  const extraHidden = [root(40)]; Object.defineProperty(extraHidden, 'allow', { value: true })
  const symbol = [root(40)]; Object.defineProperty(symbol, Symbol('caller-roots'), { value: true })
  const otherPrototype = [root(40)]; Object.setPrototypeOf(otherPrototype, null)
  for (const roots of [hole, getter, hidden, extra, extraHidden, symbol, otherPrototype]) {
    const input = clone(structureFixture().coverage); Object.assign(input.source, { requiredRoots: roots })
    assert.throws(() => validateSyncedKnowledgeCoverageV1(input), /集合/)
  }
  assert.equal(called, 0)
  const unsorted = clone(structureFixture().coverage); unsorted.source.requiredRoots = [root(41), root(40)]
  assert.throws(() => validateSyncedKnowledgeCoverageV1(unsorted), /排序/)
})

test('unresolved raw requirements roundtrip all support locators for both cut shapes and hash every retained row', () => {
  const input = clone(requirements())
  input.entries = [clone(rawRequirement(50)), clone(rawRequirement(51, historyCut(id(51))))]
  const value = validateRawPriorCoverageRequirements(input), text = serializeRawPriorCoverageRequirements(input)
  assert.deepEqual(parseRawPriorCoverageRequirements(text), input)
  assert.equal(value.entries.length, 2); assert.equal(value.entries[0].supports.boundary, null)
  assert.ok(value.entries[1].supports.boundary && value.entries[1].supports.epoch)
  assert.equal(value.entries[1].supports.epoch.key[0], 'synced:recovery-epoch:v1:' + id(51))
  const before = rawPriorCoverageRequirementsHash(input)
  input.entries[1].supports.anchor.rowHash = hash(999)
  assert.notEqual(rawPriorCoverageRequirementsHash(input), before, 'The pure commitment includes each original support digest')
  assert.equal(value.entries[1].supports.anchor.rowHash, hash(51), 'Validation copied input rows before freezing')
  assert.equal(Reflect.set(value.entries[1].supports.anchor.key, '0', 'caller-key'), false)
  assert.ok(Object.isFrozen(value.entries) && Object.isFrozen(value.entries[1].supports))
  assert.equal(Object.hasOwn(value, 'accepted'), false, 'A locator DTO is not evidence that SQL or any source namespace was read')
})

test('unresolved requirements refuse missing B/R, fabricated extra B/R, wrong SQL PK/table and malformed descriptor support', () => {
  for (const missing of ['boundary', 'epoch'] as const) {
    const input = clone(requirements()); input.entries = [clone(rawRequirement(50, historyCut(id(50))))]
    input.entries[0].supports[missing] = null
    assert.throws(() => validateRawPriorCoverageRequirements(input), /B\/R支持/)
  }
  const invented = clone(requirements()); invented.entries = [clone(rawRequirement(50))]
  invented.entries[0].supports.boundary = { table: 'app_settings', key: ['synced.recovery.history.v1.' + id(50)], rowHash: hash(50) }
  assert.throws(() => validateRawPriorCoverageRequirements(invented), /B\/R支持/)
  for (const incorrect of ['key', 'table'] as const) {
    const input = clone(requirements()); input.entries = [clone(rawRequirement(50))]
    if (incorrect === 'key') input.entries[0].supports.coverage.key[0] = 'synced.restore.coverage.v2.' + id(50)
    else Object.assign(input.entries[0].supports.coverage, { table: 'synced_operations' })
    assert.throws(() => validateRawPriorCoverageRequirements(input), /locator不闭合/)
  }
  let called = 0
  const getter = clone(requirements()); getter.entries = [clone(rawRequirement(50))]
  Object.defineProperty(getter.entries[0].supports.anchor, 'rowHash', { enumerable: true, get() { called++; return hash(50) } })
  assert.throws(() => validateRawPriorCoverageRequirements(getter), /getter/); assert.equal(called, 0)
  const extra = clone(requirements()); extra.entries = [clone(rawRequirement(50))]
  Object.defineProperty(extra.entries[0].supports, Symbol('raw-mode'), { value: true })
  assert.throws(() => validateRawPriorCoverageRequirements(extra), /未知\/缺失字段/)
  for (const key of ['coverage', 'link', 'receipt', 'anchor', 'boundary', 'epoch']) {
    const missing = clone(requirements()); missing.entries = [clone(rawRequirement(50))]
    assert.equal(Reflect.deleteProperty(missing.entries[0].supports, key), true)
    assert.throws(() => validateRawPriorCoverageRequirements(missing), /未知\/缺失字段/)
  }
})

test('schema26 requirements can have only syntactic empty entries and never admit a schema27 coverage row or unknown version', () => {
  const empty = clone(requirements()); empty.schemaVersion = 26
  assert.deepEqual(validateRawPriorCoverageRequirements(empty), empty)
  assert.equal(parseRawPriorCoverageRequirements(serializeRawPriorCoverageRequirements(empty)).schemaVersion, 26)
  empty.entries = [clone(rawRequirement(50))]
  assert.throws(() => validateRawPriorCoverageRequirements(empty), /schema26/)
  assert.throws(() => validateRawPriorCoverageRequirements(Object.assign(clone(requirements()), { schemaVersion: 25 })), /未知raw requirements版本/)
  assert.throws(() => validateRawPriorCoverageRequirements(Object.assign(clone(requirements()), { version: 2 })), /未知raw requirements版本/)
})

test('unresolved requirement rows remain a finite closed sorted set with no duplicate, sparse or accessor fallback', () => {
  const repeated = clone(requirements()); repeated.entries = [clone(rawRequirement(50)), clone(rawRequirement(50))]
  assert.throws(() => validateRawPriorCoverageRequirements(repeated), /排序或重复/)
  const reverse = clone(requirements()); reverse.entries = [clone(rawRequirement(51)), clone(rawRequirement(50))]
  assert.throws(() => validateRawPriorCoverageRequirements(reverse), /排序或重复/)
  const hole = clone(requirements()); hole.entries = [clone(rawRequirement(50)), clone(rawRequirement(51))]; delete hole.entries[0]
  assert.throws(() => validateRawPriorCoverageRequirements(hole), /集合/)
  let called = false
  const oversized = new Array(COVERAGE_MAX_REQUIREMENT_ROWS + 1)
  Object.defineProperty(oversized, '0', { enumerable: true, get() { called = true; return rawRequirement(50) } })
  const input = clone(requirements()); Object.assign(input, { entries: oversized })
  assert.throws(() => validateRawPriorCoverageRequirements(input), /超预算/)
  assert.equal(called, false)
  const duplicateText = '{"version":1,' + serializeRawPriorCoverageRequirements(requirements()).slice(1)
  assert.throws(() => parseRawPriorCoverageRequirements(duplicateText), /JSON/)
})
