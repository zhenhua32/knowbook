(async () => {
  const assert = require('node:assert/strict'), fs = require('node:fs/promises')
  const { captureReopenedRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { prepareRootRestoreContentPlan3, readRootRestoreContentPlan3 } = await import('../../src/main/database/restore-knowledge-content3-read.ts')
  const { expectedPath, identity, ...locator } = JSON.parse(process.argv[2])
  const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'))
  const knowledge = await captureReopenedRootKnowledgeConservationPlan3(locator)
  const prepared = await prepareRootRestoreContentPlan3(knowledge.knowledgePlan)
  assert.deepEqual(prepared.value, expected)
  assert.deepEqual(await readRootRestoreContentPlan3(prepared.plan), expected)
  let identityHash
  if (identity) {
    const { reopenRootRestoreIdentityPlan3, readRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
    const { expectedPath: identityExpectedPath, ...identityLocator } = identity
    const identityExpected = JSON.parse(await fs.readFile(identityExpectedPath, 'utf8'))
    const actualIdentity = await reopenRootRestoreIdentityPlan3(knowledge.knowledgePlan, identityLocator)
    assert.deepEqual(actualIdentity.value, identityExpected)
    assert.deepEqual(await readRootRestoreIdentityPlan3(actualIdentity.plan), identityExpected)
    identityHash = actualIdentity.value.allocationHash
  }
  process.stdout.write(JSON.stringify({ pid: process.pid, selectionHash: prepared.value.selectionHash, nodes: knowledge.knowledgeValue.constraints.nodes.length, identityHash }))
})().catch(error => { console.error(error); process.exitCode = 1 })
