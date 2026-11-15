import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureRootKnowledgeConservationPlanFromCertifiedSources3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { prepareRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { prepareRootRestoreFinalAssetSql5 } from '../src/main/database/restore-knowledge-derived-stage4'
import { prepareRootRestoreAssetTransfer4, publishRestoreAssetTransfer4, reopenRestoreAssetTransfer4, rollbackRestoreAssetTransfer4 }
  from '../src/main/database/restore-asset-transfer4'
import { restoreExists } from '../src/main/database/restore-safety-files'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { cutProbe } from './helpers/stage3-cut-fixture'
import { allTables, oldChildId, randomUUID, withV3Fixture } from './helpers/synced-backup-v3-fixture'

async function certify(original: Awaited<ReturnType<typeof captureAssetOriginal>>) {
  const sealed = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
  const certified = await certifyCapsule2Source(sealed.source)
  if (certified.status !== 'certified-without-prior-coverage') throw new Error('Expected a genuine base certificate')
  return certified.source
}

test('real synchronized originals with no attachments still produce final SQL and an empty durable transfer', () => withV3Fixture(async f => {
  const profile = join(f.root, 'empty-receiver')
  await mkdir(profile)
  const store = KnowbookStore.createEmptySyncedReceiver(join(profile, 'storage', 'knowbook.db'))
  try {
    const db = store.getUnsafeDatabaseHandle()
    const before = allTables(db), sourceBefore = allTables(f.db), operationId = randomUUID()
    const currentOriginal = await captureAssetOriginal({ userDataRoot: profile, db }, operationId)
    const source = await certify(await captureAssetOriginal({ userDataRoot: profile, db: f.db }))
    const current = await certify(currentOriginal)
    const profileRoot = currentOriginal.info.profileRoot
    const root = await captureRootKnowledgeConservationPlanFromCertifiedSources3({ profileRoot, operationId, dagId: randomUUID(), source, current })
    const identity = await prepareRootRestoreIdentityPlan3(root.knowledgePlan)
    const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
    assert.deepEqual(reference.value.candidate.conflicts, [])
    const combined = await prepareRootRestoreSqlAssetStage5(reference.plan)
    assert.deepEqual(combined.assets.value.selected, [])
    const { aliases, canonical, sql, derived } = await prepareRootRestoreFinalAssetSql5(reference.plan, combined.stage)
    assert.deepEqual(aliases.value.aliases, [])
    assert.equal(canonical.value.canonicalAssets?.remainingCanonicalOccurrences, 0)
    assert.equal(sql.value.rewrittenCells, 0)
    assert.equal(sql.value.remaining.blockedOccurrences, 0)
    assert.equal(sql.value.remaining.finalSqlOccurrences, 0)
    assert.deepEqual(sql.value.remaining.aliasPathConflicts, [])
    assert.ok(sql.value.remaining.scopes.every(item => item.domain === 'retained-policy'
      && item.reason === 'remaining-policy-held-payload-asset-scopes'))
    const assigned = (kind: 'block' | 'group', sourceId: string) => {
      const assignment = reference.value.allocation.assignments.find(item => item.kind === kind && item.sourceId === sourceId && item.physical)
      assert.ok(assignment)
      return assignment.targetId
    }
    await cutProbe(join(derived.directory, 'database'), profileRoot, copy => {
      assert.match(String(copy.prepare('SELECT content FROM synced_group_blocks WHERE id=?').pluck().get(assigned('block', oldChildId))),
        /^\[target\]\([^\n]+#target-heading\)$/)
      assert.equal(copy.prepare('SELECT group_id FROM synced_instances WHERE instance_id=?').pluck().get(assigned('block', f.instanceId)),
        assigned('group', f.groupId))
    })
    const location = await prepareRootRestoreAssetTransfer4(aliases.owner)
    const { transfer } = await reopenRestoreAssetTransfer4(profileRoot, operationId, location.transferId, location.manifestHash)
    await publishRestoreAssetTransfer4(transfer)
    await rollbackRestoreAssetTransfer4(transfer)
    assert.equal(await restoreExists(join(profileRoot, 'storage', 'assets')), false)
    assert.deepEqual(allTables(db), before)
    assert.deepEqual(allTables(f.db), sourceBefore)
  } finally { store.destroy() }
}))
