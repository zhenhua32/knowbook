(async () => {
  const assert = require('node:assert/strict'), fs = require('node:fs/promises')
  const { locator, identityLocator, expectedPath, choices } = JSON.parse(process.argv[2])
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { prepareRootRestoreNavigationRewritePlan3, readRootRestoreNavigationRewritePlan3 }
    = await import('../../src/main/database/restore-knowledge-navigation3-rewrite-read.ts')
  const original = await reopenPreparedMixedOriginBundle(locator)
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, identityLocator)
  const actual = await prepareRootRestoreNavigationRewritePlan3(identity.plan, choices)
  // No expected rows, targets or edits enter a factory. Open the oracle only
  // after fresh original SQL/K and the copied durable kernel mint all owners.
  const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'))
  assert.deepEqual(actual.value, expected)
  assert.deepEqual(await readRootRestoreNavigationRewritePlan3(actual.plan), expected)
  process.stdout.write(JSON.stringify({ pid: process.pid, checkedNavigationRewriteHash: actual.value.checkedNavigationRewriteHash,
    navigationRewriteHash: actual.value.navigationRewriteHash, tables: actual.value.tables.length,
    edits: actual.value.edits.length, unresolved: actual.value.unresolved.length }))
})().catch(error => { console.error(error); process.exitCode = 1 })
