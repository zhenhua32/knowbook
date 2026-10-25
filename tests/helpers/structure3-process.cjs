(async () => {
  const assert = require('node:assert/strict'), fs = require('node:fs/promises')
  const { locator, identityLocator, expectedPath, expectedIdentityPath } = JSON.parse(process.argv[2])
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { prepareRootRestoreStructureReferencePlan3, readRootRestoreStructureReferencePlan3 } = await import('../../src/main/database/restore-knowledge-structure3-read.ts')

  // The only factory inputs are the independent original locator and durable
  // kernel locator. Expected DTOs are opened only after every owner is minted.
  const bundle = await reopenPreparedMixedOriginBundle(locator)
  const knowledge = await prepareRootKnowledgeConservationPlan3(bundle)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, identityLocator)
  const structure = await prepareRootRestoreStructureReferencePlan3(identity.plan)
  const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'))
  const expectedIdentity = JSON.parse(await fs.readFile(expectedIdentityPath, 'utf8'))
  assert.deepEqual(identity.value, expectedIdentity)
  assert.deepEqual(structure.value, expected)
  assert.deepEqual(await readRootRestoreStructureReferencePlan3(structure.plan), expected)
  process.stdout.write(JSON.stringify({ pid: process.pid, identityHash: identity.value.allocationHash,
    structureHash: structure.value.structureReferenceHash, nodes: knowledge.value.constraints.nodes.length }))
})().catch(error => { console.error(error); process.exitCode = 1 })
