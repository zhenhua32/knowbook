(async () => {
  const assert = require('node:assert/strict'), fs = require('node:fs/promises')
  const { locator, identityLocator, expectedPath, choices } = JSON.parse(process.argv[2])
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { prepareRootRestoreMergedContentPlan3, readRootRestoreMergedContentPlan3 } = await import('../../src/main/database/restore-knowledge-merge3-read.ts')
  const original = await reopenPreparedMixedOriginBundle(locator)
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, identityLocator)
  const actual = await prepareRootRestoreMergedContentPlan3(identity.plan, choices)
  // The expected DTO is opened only after all real owners, source SQL and the
  // same durable kernel have independently reconstructed the complete result.
  const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'))
  assert.deepEqual(actual.value, expected)
  assert.deepEqual(await readRootRestoreMergedContentPlan3(actual.plan), expected)
  process.stdout.write(JSON.stringify({ pid: process.pid, checkedMergeHash: actual.value.checkedMergeHash,
    mergedContentHash: actual.value.mergedContentHash, tables: actual.value.tables.length }))
})().catch(error => { console.error(error); process.exitCode = 1 })
