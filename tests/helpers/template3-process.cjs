(async () => {
  const assert = require('node:assert/strict'), fs = require('node:fs/promises')
  const { locator, identityLocator, expectedPath } = JSON.parse(process.argv[2])
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { prepareRootRestoreTemplateReferencePlan3, readRootRestoreTemplateReferencePlan3 } = await import('../../src/main/database/restore-knowledge-template3-read.ts')
  const original = await reopenPreparedMixedOriginBundle(locator)
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, identityLocator)
  const captured = await prepareRootRestoreTemplateReferencePlan3(identity.plan)
  // Expected DTOs are comparison data, opened only after all genuine Main
  // owners have authenticated the independent originals and durable kernel.
  const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'))
  assert.deepEqual(captured.value, expected)
  assert.deepEqual(await readRootRestoreTemplateReferencePlan3(captured.plan), expected)
  process.stdout.write(JSON.stringify({ pid: process.pid, templateReferenceHash: captured.value.templateReferenceHash }))
})().catch(error => { console.error(error); process.exitCode = 1 })
