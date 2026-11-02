import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { readCompleteOriginalContentPair3 } from '../src/main/database/restore-knowledge-qualified-originals'
import { readRootKnowledgeConservationContentAndOriginals5 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityInputsAndOriginals5 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3, readRootRestoreReferenceCopySource3, readRootRestoreReferenceGraphInputs3,
  readRootRestoreReferenceInputsAndOriginals5 } from '../src/main/database/restore-knowledge-reference3-read'
import { withContent3Fixture } from './helpers/content3-fixture'
import { observeCompleteSqlReads, type CompleteSqlReadObservation } from './helpers/content3-joint-read-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

function completePackets(observations: CompleteSqlReadObservation[], count: number) {
  assert.equal(observations.length, count, 'Count the actual full native SQL/K transaction callbacks, not wrapper calls')
  assert.equal(new Set(observations.map(value => value.databasePath)).size, count)
  for (const value of observations) {
    assert.equal(value.completed, true); assert.equal(value.readonly, true)
    assert.equal(value.queryOnly, 1); assert.equal(value.foreignKeys, 1); assert.equal(value.inTransaction, true)
    assert.equal(value.totalChangesBefore, 0); assert.equal(value.totalChangesAfter, 0)
  }
}

test('genuine Root3 identity and reference joint reads return the same fresh complete originals without a second SQL pair or changing released hashes', { concurrency: false }, t => {
  const probe = observeCompleteSqlReads(t)
  return withContent3Fixture(async f => {
    const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
    const identityBytes = await readFile(join(identity.directory, 'manifest.json'))
    const referenceBytes = await readFile(join(reference.directory, 'manifest.json'))
    const source = await readRootRestoreReferenceCopySource3(reference.plan)
    assert.equal(source.original, f.saved.bundle)
    const baseline = await probe.measure(async () => ({ actual: await readRootRestoreReferenceGraphInputs3(reference.plan),
      pair: await readCompleteOriginalContentPair3(source.original) }))
    completePackets(baseline.observations, 4)

    const root = await probe.measure(() => readRootKnowledgeConservationContentAndOriginals5(f.saved.knowledgePlan))
    completePackets(root.observations, 2)
    assert.equal(root.value.original, f.saved.bundle)
    assert.deepEqual(root.value.value, baseline.value.actual.data.inputs)
    assert.deepEqual(root.value.pair, baseline.value.pair)
    assert.equal(root.value.value.source, root.value.pair.source)
    assert.equal(root.value.value.current, root.value.pair.current)

    const base = await probe.measure(() => readRootRestoreIdentityInputsAndOriginals5(identity.plan))
    completePackets(base.observations, 2)
    assert.equal(base.value.original, f.saved.bundle)
    assert.deepEqual(base.value.actual, baseline.value.actual.data)
    assert.deepEqual(base.value.pair, baseline.value.pair)
    assert.equal(base.value.actual.inputs.source, base.value.pair.source)
    assert.equal(base.value.actual.inputs.current, base.value.pair.current)

    const first = await probe.measure(() => readRootRestoreReferenceInputsAndOriginals5(reference.plan))
    completePackets(first.observations, 2)
    assert.equal(first.value.original, source.original)
    assert.deepEqual(first.value.actual, baseline.value.actual)
    assert.deepEqual(first.value.pair, baseline.value.pair)
    assert.equal(first.value.actual.data.inputs.source, first.value.pair.source)
    assert.equal(first.value.actual.data.inputs.current, first.value.pair.current)
    assert.equal(capsuleBytesHash(capsuleJson(first.value.actual)), capsuleBytesHash(capsuleJson(baseline.value.actual)))
    assert.equal(capsuleBytesHash(capsuleJson(first.value.pair)), capsuleBytesHash(capsuleJson(baseline.value.pair)))
    assert.equal('pair' in first.value.actual, false); assert.equal('original' in first.value.actual, false)
    assert.equal(first.value.actual.value.candidate.permit, false)
    assert.equal(first.value.actual.value.candidate.acceptedCoverage, false)
    assert.equal(Object.isFrozen(first.value), true); assert.equal(Object.isFrozen(first.value.actual), true)
    assert.equal(Object.isFrozen(first.value.pair), true); assert.equal(Object.isFrozen(first.value.pair.originalPackage), true)

    const second = await probe.measure(() => readRootRestoreReferenceInputsAndOriginals5(reference.plan))
    completePackets(second.observations, 2)
    assert.deepEqual(second.value, first.value)
    const oldPaths = new Set(first.observations.map(value => value.databasePath))
    for (const value of second.observations) assert.equal(oldPaths.has(value.databasePath), false, 'A later public read must reopen fresh real SQL scratch')
    assert.equal(second.value.original, first.value.original)
    assert.notEqual(second.value.pair, first.value.pair, 'The runtime pair is not cached across reads')
    assert.deepEqual(await readFile(join(identity.directory, 'manifest.json')), identityBytes)
    assert.deepEqual(await readFile(join(reference.directory, 'manifest.json')), referenceBytes)
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  })
})
