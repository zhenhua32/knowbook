(async () => {
  const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
  const { locator, identityLocator, referenceLocator, copyLocator, stageLocator, expectedPath } = JSON.parse(process.argv[2])
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { reopenRootRestoreReferencePlan3 } = await import('../../src/main/database/restore-knowledge-reference3-read.ts')
  const { reopenRootRestoreCurrentCopy3, readRootRestoreCurrentCopy3 } = await import('../../src/main/database/restore-knowledge-stage3-current-copy.ts')
  const { reopenRootRestorePhysicalStage3, readRootRestorePhysicalStage3 } = await import('../../src/main/database/restore-knowledge-stage3-physical.ts')
  const { readCompleteOriginalRootCurrentFiles3 } = await import('../../src/main/database/restore-knowledge-qualified-originals.ts')
  const { restoreFileDigest } = await import('../../src/main/database/restore-safety-files.ts')
  const original = await reopenPreparedMixedOriginBundle(locator)
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, identityLocator)
  const reference = await reopenRootRestoreReferencePlan3(identity.plan, referenceLocator)
  const copied = await reopenRootRestoreCurrentCopy3(reference.plan, copyLocator)
  await assert.rejects(reopenRootRestorePhysicalStage3(reference.plan, { ...stageLocator, expectedManifestHash: '0'.repeat(64) }))
  const physical = await reopenRootRestorePhysicalStage3(reference.plan, stageLocator)
  assert.equal(identity.planId, identityLocator.planId)
  assert.equal(reference.manifestHash, referenceLocator.expectedManifestHash)
  assert.equal(copied.manifestHash, copyLocator.expectedManifestHash)
  assert.equal(physical.manifestHash, stageLocator.expectedManifestHash)
  // Expected data is an oracle only. All genuine owners, original SQL/K, both
  // copied kernels and both native physical probes already exist before this IO.
  const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'))
  assert.deepEqual(identity.value, expected.identity)
  assert.deepEqual(reference.value, expected.reference)
  assert.deepEqual(copied.value, expected.copy)
  assert.deepEqual(physical.value, expected.stage)
  assert.equal(physical.value.currentStageComplete, false)
  assert.equal(physical.value.historyCutComplete, false)
  assert.equal(physical.value.installPermit, false)
  await assert.rejects(readRootRestoreCurrentCopy3(Object.freeze({ kind: 'main-root-restore-current-original-copy' })))
  await assert.rejects(readRootRestorePhysicalStage3(Object.freeze({ kind: 'main-root-restore-non-executable-physical-stage' })))
  const tamperRejected = []
  async function corruptTail(label, file, reject) {
    const before = await restoreFileDigest(file)
    await fs.appendFile(file, '\n')
    try { await reject(); tamperRejected.push(label) }
    finally { await fs.truncate(file, before.bytes) }
    assert.deepEqual(await restoreFileDigest(file), before)
  }
  await corruptTail('identity-kernel', path.join(identity.directory, 'manifest.json'),
    () => assert.rejects(readRootRestorePhysicalStage3(physical.stage)))
  await corruptTail('reference-kernel', path.join(reference.directory, 'manifest.json'),
    () => assert.rejects(readRootRestorePhysicalStage3(physical.stage)))
  await corruptTail('copy-db', path.join(copied.directory, 'database', 'knowbook.db'),
    () => assert.rejects(readRootRestoreCurrentCopy3(copied.copy)))
  await corruptTail('stage-db', path.join(physical.directory, 'database', 'knowbook.db'),
    () => assert.rejects(readRootRestorePhysicalStage3(physical.stage)))
  const current = await readCompleteOriginalRootCurrentFiles3(original)
  const currentDb = current.files.find(file => file.path.endsWith('/original/knowbook.db'))
  assert.ok(currentDb)
  await corruptTail('mounted-current-db', currentDb.sourcePath,
    () => assert.rejects(readRootRestorePhysicalStage3(physical.stage)))
  assert.deepEqual(await readRootRestorePhysicalStage3(physical.stage), expected.stage)
  process.stdout.write(JSON.stringify({ pid: process.pid, tables: physical.value.tables.length,
    lifecycleAdded: physical.value.lifecycleAdded.length, stageManifestHash: physical.manifestHash,
    physicalObservationHash: physical.value.physicalObservationHash, copyManifestHash: copied.manifestHash,
    baseIdentityAllocationHash: identity.value.allocationHash,
    derivedReferenceAllocationHash: reference.value.allocation.derivedReferenceAllocationHash, tamperRejected }))
})().catch(error => { console.error(error); process.exitCode = 1 })
