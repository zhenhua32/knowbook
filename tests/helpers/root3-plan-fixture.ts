import { randomUUID } from 'node:crypto'
import type { CertifiedDurableSqlCapsule } from '../../src/main/database/restore-knowledge-capsule-read'
import { captureActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import type { CapturedKnowledgeOriginal } from './restore-knowledge-payload-fixture'
import { withV3Fixture } from './synced-backup-v3-fixture'
import { mixedPair, allTables } from './mixed-required-source-fixture'
export { allTables }

/** Both arguments must be real private SQL certificates. The Root3 owner is
 * reached through actual DAG export, independent copying and original rereads. */
export async function root3PlanFromActualCapsules(profileRoot: string, source: Pick<CapturedKnowledgeOriginal, 'capsule' | 'operationId'>, current: CertifiedDurableSqlCapsule) {
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot, operationId: source.operationId, dagId: randomUUID(), source: source.capsule, current })
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  const actual = await captureMixedRootKnowledgeConservationPlan3({ profileRoot, operationId: randomUUID(), sourceDirectory: exported.directory })
  return { plan: actual.knowledgePlan, value: actual.knowledgeValue }
}

async function mixedSetup(source: Parameters<typeof mixedPair>[0], receiver: Parameters<typeof mixedPair>[0], readers: readonly [1|2, 1|2]) {
  const pair = await mixedPair(source, readers), captured = await pair.capture()
  const beforeSource = allTables(source.db), beforeReceiver = allTables(receiver.db)
  const exported = await exportPreparedMixedOriginBundle(captured.handle, { operationId: randomUUID(), bundleId: randomUUID() })
  const saved = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory })
  return { source, receiver, beforeSource, beforeReceiver, expectedInputs: captured.material.inputs, saved }
}
export async function withRoot3MixedFixture(readers: readonly [1|2, 1|2], run: (f: Awaited<ReturnType<typeof mixedSetup>>) => Promise<void>) {
  await withV3Fixture(source => withV3Fixture(async receiver => { await run(await mixedSetup(source, receiver, readers)) }))
}
