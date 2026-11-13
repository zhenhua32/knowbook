(async () => {
  const assert = require('node:assert/strict')
  const { readFile, writeFile } = require('node:fs/promises')
  const { join } = require('node:path')
  const input = JSON.parse(process.argv[2])
  const { capsuleBytesHash, capsuleJson } = await import('../../src/main/database/restore-knowledge-capsule-model.ts')
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { reopenRootRestoreReferencePlan3 } = await import('../../src/main/database/restore-knowledge-reference3-read.ts')
  const { reopenRootRestorePhysicalStage3 } = await import('../../src/main/database/restore-knowledge-stage3-physical.ts')
  const { reopenRootRestoreHistoryBoundaryCandidate3 } = await import('../../src/main/database/restore-knowledge-stage3-history-boundary.ts')
  const original = await reopenPreparedMixedOriginBundle(input.original)
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, input.identity)
  const reference = await reopenRootRestoreReferencePlan3(identity.plan, input.reference)
  const stage = await reopenRootRestorePhysicalStage3(reference.plan, input.stage)
  const evidence = await reopenRootRestoreHistoryBoundaryCandidate3(stage.stage, input.evidence)
  const path = join(evidence.directory, 'manifest.json'), originalBytes = await readFile(path)
  const forged = capsuleJson({ ...evidence.value, retainedCutHash: '0'.repeat(64) }) + '\n'
  assert.notEqual(capsuleBytesHash(forged), evidence.manifestHash)
  try {
    await writeFile(path, forged)
    await assert.rejects(reopenRootRestoreHistoryBoundaryCandidate3(stage.stage, {
      evidenceId: evidence.evidenceId, expectedManifestHash: capsuleBytesHash(forged)
    }), /冷证据不等于实际原 current 与 Stage3 切点/)
  } finally { await writeFile(path, originalBytes) }
  assert.deepEqual(await readFile(path), originalBytes)
  process.stdout.write(JSON.stringify({ pid: process.pid, manifestHash: evidence.manifestHash,
    stageManifestHash: evidence.value.stageManifestHash, acceptedCoverage: evidence.value.acceptedCoverage, rejectedRehash: true }))
})().catch(error => { console.error(error); process.exitCode = 1 })
