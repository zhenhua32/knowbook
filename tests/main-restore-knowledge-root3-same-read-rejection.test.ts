import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readRootKnowledgeConservationContentAndOriginals5 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityInputsAndOriginals5 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3, readRootRestoreReferenceGraphInputs3,
  readRootRestoreReferenceInputsAndOriginals5, readRootRestoreStageInputs5, withRootRestoreStageInputs5,
  type RootRestoreStageInputs5 } from '../src/main/database/restore-knowledge-reference3-read'
import { withContent3Fixture, tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { observeCompleteSqlReads } from './helpers/content3-joint-read-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

test('same-read runtime originals reject copied DTO accessor owners changed durable kernels and later real SQL despite an earlier intact returned pair', { concurrency: false }, t => {
  const probe = observeCompleteSqlReads(t)
  return withContent3Fixture(async f => {
    const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const reference = await prepareRootRestoreReferencePlan3(identity.plan)
    const genuine = await readRootRestoreReferenceInputsAndOriginals5(reference.plan)
    let getters = 0
    const fake = Object.defineProperty({}, 'kind', { get() { getters++; throw new Error('caller getter must not execute') } })
    const before = probe.observations.length
    await assert.rejects(readRootKnowledgeConservationContentAndOriginals5(fake as never))
    await assert.rejects(readRootRestoreIdentityInputsAndOriginals5(fake as never))
    await assert.rejects(readRootRestoreReferenceInputsAndOriginals5(fake as never))
    await assert.rejects(readRootKnowledgeConservationContentAndOriginals5({ ...f.saved.knowledgePlan }))
    await assert.rejects(readRootRestoreIdentityInputsAndOriginals5({ ...identity.plan }))
    await assert.rejects(readRootRestoreReferenceInputsAndOriginals5({ ...reference.plan }))
    await assert.rejects(readRootKnowledgeConservationContentAndOriginals5(genuine.actual.data.inputs as never))
    await assert.rejects(readRootRestoreIdentityInputsAndOriginals5(genuine.actual.data as never))
    await assert.rejects(readRootRestoreReferenceInputsAndOriginals5(genuine.pair as never))
    assert.equal(getters, 0); assert.equal(probe.observations.length, before)

    const identityPath = join(identity.directory, 'manifest.json'), identityBytes = await readFile(identityPath)
    await writeFile(identityPath, Buffer.concat([identityBytes, Buffer.from(' ')]))
    try { await assert.rejects(readRootRestoreIdentityInputsAndOriginals5(identity.plan)) }
    finally { await writeFile(identityPath, identityBytes) }
    assert.equal(probe.observations.length, before, 'The actual changed identity manifest must fail before another SQL read')
    const referencePath = join(reference.directory, 'manifest.json'), referenceBytes = await readFile(referencePath)
    await writeFile(referencePath, Buffer.concat([referenceBytes, Buffer.from(' ')]))
    try { await assert.rejects(readRootRestoreReferenceInputsAndOriginals5(reference.plan)) }
    finally { await writeFile(referencePath, referenceBytes) }
    assert.equal(probe.observations.length, before, 'The actual changed reference manifest must fail before another SQL read')

    let expired: RootRestoreStageInputs5 | undefined
    await withRootRestoreStageInputs5(reference.plan, undefined, async scope => {
      expired = scope
      assert.deepEqual((await readRootRestoreStageInputs5(reference.plan, scope)).actual, genuine.actual)
      await assert.rejects(readRootRestoreStageInputs5({ ...reference.plan }, scope), /不是本次同一genuine reference/)
      assert.ok(await tamperContent3VerificationOriginals(f.receiver.userDataRoot) >= 2)
      await assert.rejects(readRootRestoreStageInputs5(reference.plan, scope), /原件|capsule|hash/)
    })
    assert.ok(expired)
    await assert.rejects(readRootRestoreStageInputs5(reference.plan, expired), /不是本次同一genuine reference/)
    await assert.rejects(readRootRestoreReferenceInputsAndOriginals5(reference.plan))
    await assert.rejects(readRootRestoreReferenceGraphInputs3(reference.plan), 'The released reader rejects the same changed actual originals')
    assert.equal(Object.isFrozen(genuine.pair), true, 'An earlier complete returned DTO remains intact but cannot authorize a later read')
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  })
})
