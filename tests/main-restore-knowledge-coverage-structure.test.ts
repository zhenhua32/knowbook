import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { coverageAnchorExpectation, coverageOperationId, knowledgeRestoreReceiptHash,
  parseKnowledgeRestoreReceipt, parseSyncedKnowledgeCoverage, parseSyncedKnowledgeCoverageLink,
  serializeKnowledgeRestoreReceipt, serializeSyncedKnowledgeCoverage, serializeSyncedKnowledgeCoverageLink,
  syncedKnowledgeCoverageCutHash, syncedKnowledgeCoverageHash, syncedKnowledgeCoverageLinkHash,
  validateCoverageCapsuleReference, validateCoverageRootReference, validateCoverageStructureTuple,
  validateKnowledgeRestoreReceiptV2, validateSyncedKnowledgeCoverageLinkV1, validateSyncedKnowledgeCoverageV1 } from '../src/main/database/restore-knowledge-coverage-model'
import { at, bundle, capsule, clone, hash, historyCut, id, native, ordinaryCut, root, structureFixture, tupleFor } from './helpers/coverage-structure-fixture'

// Pure DTO execution tests only. There is no actual accepted producer/SQL/DAG,
// certified artifact or installed profile behind these fixture references.
test('coverage structure-only DTO roundtrips non-equal cross-namespace inputs and freezes a copy without accepting either input', () => {
  const input = structureFixture(), result = validateCoverageStructureTuple(input)
  assert.equal(result.kind, 'coverage-structure-only')
  assert.equal(Object.hasOwn(result, 'accepted'), false); assert.equal(Object.hasOwn(result, 'permit'), false)
  assert.notEqual(result.coverage.source.capsule.namespace.kind, result.coverage.current.capsule.namespace.kind)
  assert.notEqual(result.coverage.source.capsule.manifestHash, result.coverage.current.capsule.manifestHash)
  assert.equal(result.coverage.stageBase, 'current')
  assert.deepEqual(parseSyncedKnowledgeCoverage(serializeSyncedKnowledgeCoverage(input.coverage)), input.coverage)
  assert.deepEqual(parseSyncedKnowledgeCoverageLink(serializeSyncedKnowledgeCoverageLink(input.link)), input.link)
  assert.deepEqual(parseKnowledgeRestoreReceipt(serializeKnowledgeRestoreReceipt(input.receipt)), input.receipt)
  const oldHash = result.coverage.source.capsule.manifestHash
  Object.assign(input.coverage.source.capsule, { manifestHash: hash(700) })
  assert.equal(result.coverage.source.capsule.manifestHash, oldHash, 'Returned structures do not alias caller objects')
  assert.equal(Reflect.set(result.coverage.current.capsule, 'manifestHash', hash(701)), false)
  assert.equal(Reflect.set(result.coverage.source.requiredRoots, 'length', 100), false)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.coverage.cut) && Object.isFrozen(result.receipt.target))
})

test('coverage structure keeps equal hash at distinct locators and identical raw IDs across independent namespaces', () => {
  const value = clone(structureFixture().coverage)
  value.source.capsule.manifestHash = value.current.capsule.manifestHash
  value.source.capsule.capsuleId = value.current.capsule.capsuleId
  value.source.requiredRoots = [root(40, bundle)]
  value.current.requiredRoots = [root(40, native)]
  const validated = validateSyncedKnowledgeCoverageV1(value)
  assert.equal(validated.source.capsule.manifestHash, validated.current.capsule.manifestHash)
  assert.equal(validated.source.capsule.capsuleId, validated.current.capsule.capsuleId)
  assert.deepEqual(validated.source.capsule.namespace, bundle); assert.deepEqual(validated.current.capsule.namespace, native)
  assert.equal(validated.source.requiredRoots.length + validated.current.requiredRoots.length, 2)
  assert.equal(validated.source.requiredRoots[0].rootHash, validated.current.requiredRoots[0].rootHash)
  assert.notEqual(syncedKnowledgeCoverageHash(validated), syncedKnowledgeCoverageHash(structureFixture().coverage))
  const sameDomainDifferentLocators = clone(structureFixture().coverage)
  sameDomainDifferentLocators.source.capsule = clone(capsule(30))
  sameDomainDifferentLocators.source.capsule.manifestHash = sameDomainDifferentLocators.current.capsule.manifestHash
  sameDomainDifferentLocators.source.requiredRoots = [root(40), { ...root(41), rootHash: root(40).rootHash }]
  assert.equal(validateSyncedKnowledgeCoverageV1(sameDomainDifferentLocators).source.requiredRoots.length, 2)
})

test('coverage structure rejects collapsed source/current roles, duplicate root locators, conflicting locators and direct self roots', () => {
  const collapsed = clone(structureFixture().coverage)
  collapsed.source.capsule = clone(collapsed.current.capsule); collapsed.source.capsule.manifestHash = hash(999)
  assert.throws(() => validateSyncedKnowledgeCoverageV1(collapsed), /独立真实原件/)
  for (const changedHash of [false, true]) {
    const value = clone(structureFixture().coverage), repeated = clone(root(40))
    if (changedHash) repeated.rootHash = hash(999)
    value.source.requiredRoots = [root(40), repeated]
    assert.throws(() => validateSyncedKnowledgeCoverageV1(value), /排序或重复矛盾/)
  }
  const shared = clone(structureFixture().coverage)
  shared.source.requiredRoots = [root(40)]; shared.current.requiredRoots = [root(40)]
  assert.equal(validateSyncedKnowledgeCoverageV1(shared).current.requiredRoots.length, 1, 'The same exact ancestor can be required by both sides')
  shared.current.requiredRoots[0].rootHash = hash(999)
  assert.throws(() => validateSyncedKnowledgeCoverageV1(shared), /同locator异hash/)
  const self = clone(structureFixture().coverage); self.source.requiredRoots = [clone(self.root)]
  assert.throws(() => validateSyncedKnowledgeCoverageV1(self), /自环/)
})

test('coverage structure rejects all unknown format/version and origin discriminants instead of upgrading prepared V1', () => {
  const fixture = structureFixture()
  for (const [validate, value] of [
    [validateSyncedKnowledgeCoverageV1, fixture.coverage], [validateSyncedKnowledgeCoverageLinkV1, fixture.link],
    [validateKnowledgeRestoreReceiptV2, fixture.receipt], [validateCoverageRootReference, fixture.coverage.root],
    [validateCoverageCapsuleReference, fixture.coverage.source.capsule]
  ] as const) {
    assert.throws(() => validate(Object.assign(clone(value), { version: 99 })), /未知/)
    assert.throws(() => validate(Object.assign(clone(value), { kind: 'caller-accepted' })), /未知/)
  }
  assert.throws(() => validateCoverageRootReference(Object.assign(clone(fixture.coverage.root), { readerVersion: 'knowbook-durable-sql-dag-v1' })), /prepared DAG v1/)
  assert.throws(() => validateSyncedKnowledgeCoverageV1(Object.assign(clone(fixture.coverage), { stageBase: 'source' })), /current stagebase/)
  const unknownNamespace = clone(fixture.coverage); Object.assign(unknownNamespace.source.capsule.namespace, { kind: 'caller-path', path: 'C:\\caller' })
  assert.throws(() => validateSyncedKnowledgeCoverageV1(unknownNamespace), /namespace/)
})

test('coverage closed records reject self, receipt, intent and final stage hash fields without introducing hash cycles', () => {
  const fixture = structureFixture()
  for (const key of ['selfHash', 'coverageHash', 'receiptHash', 'intentHash', 'stagedSha256', 'fenceHash'])
    assert.throws(() => validateSyncedKnowledgeCoverageV1(Object.assign(clone(fixture.coverage), { [key]: hash(999) })), /未知\/缺失字段/)
  for (const [validate, value] of [[validateSyncedKnowledgeCoverageLinkV1, fixture.link], [validateKnowledgeRestoreReceiptV2, fixture.receipt]] as const)
    for (const key of ['selfHash', 'receiptHash', 'intentHash', 'stagedSha256'])
      assert.throws(() => validate(Object.assign(clone(value), { [key]: hash(999) })), /未知\/缺失字段/)
  const symbol = clone(fixture.coverage); Object.defineProperty(symbol, Symbol('accepted'), { value: true })
  assert.throws(() => validateSyncedKnowledgeCoverageV1(symbol), /未知\/缺失字段/)
  const hidden = clone(fixture.coverage); Object.defineProperty(hidden, 'allow', { value: true })
  assert.throws(() => validateSyncedKnowledgeCoverageV1(hidden), /未知\/缺失字段/)
  const nested = clone(fixture.coverage); Object.assign(nested.target, { profileRoot: 'C:\\caller' })
  assert.throws(() => validateSyncedKnowledgeCoverageV1(nested), /未知\/缺失字段/)
})

test('coverage complete closed shapes reject each missing field and nonordinary prototypes at every public record level', () => {
  const fixture = structureFixture()
  for (const [validate, value] of [
    [validateSyncedKnowledgeCoverageV1, fixture.coverage], [validateSyncedKnowledgeCoverageLinkV1, fixture.link],
    [validateKnowledgeRestoreReceiptV2, fixture.receipt], [validateCoverageRootReference, fixture.coverage.root],
    [validateCoverageCapsuleReference, fixture.coverage.source.capsule]
  ] as const) {
    for (const key of Object.keys(value)) {
      const missing = clone(value); assert.equal(Reflect.deleteProperty(missing, key), true)
      assert.throws(() => validate(missing), /未知\/缺失字段/)
    }
    const foreignPrototype = clone(value); Object.setPrototypeOf(foreignPrototype, { permit: true })
    assert.throws(() => validate(foreignPrototype), /普通闭形/)
  }
  const nested = clone(fixture.coverage); Reflect.deleteProperty(nested.target, 'workspaceScope')
  assert.throws(() => validateSyncedKnowledgeCoverageV1(nested), /未知\/缺失字段/)
})

test('coverage scalar codecs reject noncanonical UUID, digest spelling and time coercion', () => {
  const reference = structureFixture().coverage.source.capsule
  assert.throws(() => validateCoverageCapsuleReference(Object.assign(clone(reference), { operationId: id(10).toUpperCase() })), /canonical小写/)
  for (const manifestHash of ['A'.repeat(64), '0'.repeat(63), ' ' + hash(30), 30, null])
    assert.throws(() => validateCoverageCapsuleReference(Object.assign(clone(reference), { manifestHash })), /SHA256/)
  const objectTime = clone(structureFixture().coverage); Object.assign(objectTime.target, { documentBoundary: new Date(at) })
  assert.throws(() => validateSyncedKnowledgeCoverageV1(objectTime), /时点不是TEXT/)
})

test('coverage descriptors reject required and extra getters without evaluating caller code', () => {
  let called = 0
  const top = clone(structureFixture().coverage); Object.defineProperty(top, 'root', { enumerable: true, get() { called++; return root(999) } })
  const nested = clone(structureFixture().coverage); Object.defineProperty(nested.source.capsule, 'manifestHash', { enumerable: true, get() { called++; return hash(999) } })
  const namespace = clone(structureFixture().coverage); Object.defineProperty(namespace.source.capsule.namespace, 'kind', { enumerable: true, get() { called++; return 'native' } })
  const extra = clone(structureFixture().coverage); Object.defineProperty(extra, 'accepted', { enumerable: true, get() { called++; return true } })
  for (const value of [top, nested, namespace, extra]) assert.throws(() => validateSyncedKnowledgeCoverageV1(value), /getter|data字段|未知\/缺失字段/)
  assert.equal(called, 0)
})

test('coverage canonical JSON rejects duplicates, unsafe keys, noncanonical text and oversized JSON before any acceptance exists', () => {
  const fixture = structureFixture(), source = serializeSyncedKnowledgeCoverage(fixture.coverage)
  assert.throws(() => parseSyncedKnowledgeCoverage('{"version":1,' + source.slice(1)), /JSON/)
  assert.throws(() => parseSyncedKnowledgeCoverage('{"__proto__":{},' + source.slice(1)), /JSON/)
  assert.throws(() => parseSyncedKnowledgeCoverage(' ' + source), /canonical/)
  assert.throws(() => parseSyncedKnowledgeCoverage(JSON.stringify(fixture.coverage, null, 2)), /canonical/)
  assert.throws(() => parseSyncedKnowledgeCoverage(' '.repeat(2 * 1024 * 1024 + 1)), /JSON/)
  assert.notEqual(syncedKnowledgeCoverageHash(fixture.coverage), syncedKnowledgeCoverageLinkHash(fixture.link))
  assert.notEqual(knowledgeRestoreReceiptHash(fixture.receipt), syncedKnowledgeCoverageHash(fixture.coverage))
})

test('coverage C/link/Receipt2 backward hashes and zero-member anchor expectations use their independent structural domains', () => {
  const fixture = structureFixture(), ordinary = ordinaryCut()
  assert.ok(ordinary.kind === 'ordinary-empty-epoch-cut')
  const literal = JSON.stringify({ acceptedAt: at, afterEpoch: id(103), afterWorkspaceScope: id(101), beforeEpoch: id(102),
    beforeWorkspaceScope: id(100), documentBoundary: at, kind: 'ordinary-empty-epoch-cut', operationId: id(10), version: 1 })
  assert.equal(syncedKnowledgeCoverageCutHash(ordinary), createHash('sha256').update('knowbook.restore-knowledge.cut.v1\0' + literal).digest('hex'))
  assert.equal(syncedKnowledgeCoverageHash(fixture.coverage), createHash('sha256').update('knowbook.restore-knowledge.coverage.v1\0' + serializeSyncedKnowledgeCoverage(fixture.coverage)).digest('hex'))
  const anchor = coverageAnchorExpectation(fixture.link)
  assert.equal(anchor.id, coverageOperationId(fixture.coverage.operationId)); assert.equal(anchor.publication_hash, fixture.link.coverageHash)
  assert.equal(anchor.request_hash, syncedKnowledgeCoverageLinkHash(fixture.link))
  assert.equal(anchor.channel, 'recovery-knowledge-coverage-v1'); assert.equal(anchor.state, 'possible'); assert.equal(anchor.confirmed_at, null)
  assert.equal(Object.hasOwn(anchor, 'members'), false, 'Expected fields are not proof that a zero-member SQL row exists')
  assert.ok(Object.isFrozen(anchor))
})

test('coverage tuple detects independently valid wrong hashes, echo fields, target times and receipt inputs', () => {
  const base = structureFixture()
  for (const side of ['link', 'receipt'] as const) for (const field of ['coverageHash', 'rootMaterialHash', 'planHash', 'cutHash'] as const) {
    const input = clone(base); input[side][field] = hash(999)
    assert.throws(() => validateCoverageStructureTuple(input), /互证失败/)
  }
  for (const side of ['link', 'receipt'] as const) for (const field of ['workspaceScope', 'recoveryEpoch', 'documentBoundary'] as const) {
    const input = clone(base); input[side].target[field] = field === 'documentBoundary' ? '2043-01-01T00:00:00.000Z' : id(999)
    assert.throws(() => validateCoverageStructureTuple(input), /互证失败/)
  }
  const changedRoot = clone(base); changedRoot.link.root.rootHash = hash(999)
  assert.throws(() => validateCoverageStructureTuple(changedRoot), /互证失败/)
  const changedTime = clone(base); changedTime.receipt.acceptedAt = '2043-01-01T00:00:00.000Z'
  assert.throws(() => validateCoverageStructureTuple(changedTime), /互证失败/)
  const wrongInput = clone(base); wrongInput.receipt.source.manifestHash = hash(999)
  assert.throws(() => validateCoverageStructureTuple(wrongInput), /原件不属于C/)
  const missing = { coverage: base.coverage, link: base.link }
  assert.throws(() => validateCoverageStructureTuple(missing), /未知\/缺失字段/)
})

test('coverage fixed cut allocations reject wrong operation, scope, epoch and dates while both cut variants remain structure-only', () => {
  const base = structureFixture().coverage
  for (const field of ['operationId', 'afterEpoch', 'acceptedAt', 'documentBoundary'] as const) {
    const value = clone(base)
    value.cut[field] = field === 'acceptedAt' || field === 'documentBoundary' ? '2043-01-01T00:00:00.000Z' : id(999)
    assert.throws(() => validateSyncedKnowledgeCoverageV1(value), /cut\/target/)
  }
  const wrongScope = clone(base); assert.ok(wrongScope.cut.kind === 'ordinary-empty-epoch-cut'); wrongScope.cut.afterWorkspaceScope = id(999)
  assert.throws(() => validateSyncedKnowledgeCoverageV1(wrongScope), /cut\/target/)
  const noAdvance = clone(base); noAdvance.cut.beforeEpoch = noAdvance.cut.afterEpoch
  assert.throws(() => validateSyncedKnowledgeCoverageV1(noAdvance), /epoch未推进/)
  const notCanonical = clone(base); notCanonical.acceptedAt = '2042-03-04T05:06:07.008+00:00'
  assert.throws(() => validateSyncedKnowledgeCoverageV1(notCanonical), /准确UTC ISO/)
  const historical = clone(base); historical.cut = clone(historyCut())
  const result = validateCoverageStructureTuple(tupleFor(historical))
  assert.equal(result.coverage.cut.kind, 'synced-recovery-epoch-cut')
  assert.equal(result.kind, 'coverage-structure-only', 'Digest-shaped B/R references are not a real Main B/R producer proof')
})
