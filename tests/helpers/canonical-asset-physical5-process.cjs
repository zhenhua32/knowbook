(async () => {
  const assert = require('node:assert/strict'), { join } = require('node:path'), { randomUUID } = require('node:crypto')
  const { appendFileSync } = require('node:fs'), tracePath = process.env.KNOWBOOK_CANONICAL_ASSET_TEST_TRACE
  function phase(name) {
    if (tracePath) appendFileSync(tracePath, JSON.stringify({ actor: 'child', pid: process.pid, time: new Date().toISOString(),
      elapsedMs: Math.round(performance.now()), phase: name }) + '\n')
  }
  phase('process-started')
  const Database = require('better-sqlite3'), input = JSON.parse(process.argv[2]), { profileRoot } = input.original
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { reopenRootRestoreReferencePlan3 } = await import('../../src/main/database/restore-knowledge-reference3-read.ts')
  const { reopenRootRestoreSqlAssetStage5 } = await import('../../src/main/database/restore-knowledge-sql-asset-stage5.ts')
  const { reopenRootRestoreCanonicalAssetPhysicalFromCombined5, copyRootRestoreStage3Database3, readRootRestorePhysicalStageCopySource3 }
    = await import('../../src/main/database/restore-knowledge-stage3-physical.ts')
  const { readRawSyncedGroupSnapshotsOwned } = await import('../../src/main/database/synced-blocks-raw-read.ts')
  const { syncedLifecycleSemanticHash } = await import('../../src/main/database/synced-lifecycle-state.ts')
  const { inspectOrdinaryRestoreDatabase } = await import('../../src/main/database/restore-safety-read.ts')
  const { restoreSqliteFilename } = await import('../../src/main/database/restore-safety-sqlite-path.ts')
  phase('imports-completed')
  const original = await reopenPreparedMixedOriginBundle(input.original)
  phase('original-reopened')
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  phase('knowledge-prepared')
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, input.identity)
  phase('identity-reopened')
  const reference = await reopenRootRestoreReferencePlan3(identity.plan, input.reference)
  phase('reference-reopened')
  const combined = await reopenRootRestoreSqlAssetStage5(reference.plan, input.combined)
  phase('combined-reopened')
  phase('canonical-compose-started')
  const { stage } = await reopenRootRestoreCanonicalAssetPhysicalFromCombined5(reference.plan, combined.stage, input.aliases, input.stage)
  phase('canonical-physical-reopened')
  assert.equal(stage.value.installPermit, false)
  const { groupId } = stage.value.canonicalAssets.groups[0], copy = readRootRestorePhysicalStageCopySource3(stage.stage)
  const probe = join(profileRoot, 'canonical-alias-cold-' + randomUUID())
  await copyRootRestoreStage3Database3(copy.databaseDirectory, probe, profileRoot, copy.inventory)
  phase('sql-probe-copied')
  const file = restoreSqliteFilename(join(probe, 'knowbook.db')), db = new Database(file, { fileMustExist: true })
  let value
  try {
    db.pragma('foreign_keys=ON')
    value = db.transaction(() => {
      const snapshot = readRawSyncedGroupSnapshotsOwned(db, [groupId]).get(groupId)
      const { creationId, createdAt, origin, bindings, blocks } = snapshot
      const wire = { kind: 'synced-group', id: groupId, creationId, createdAt, origin, bindings, blocks }
      const life = db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(groupId)
      assert.equal(life.state_version, 1)
      assert.equal(life.create_history_id, null)
      assert.equal(life.activation_hash, syncedLifecycleSemanticHash(wire))
      assert.throws(() => db.prepare('UPDATE synced_group_lifecycle SET state_version=2,activation_hash=? WHERE group_id=?')
        .run('0'.repeat(64), groupId), /successful reactivation/)
      return { wire, activationHash: life.activation_hash,
        rowid: db.prepare('SELECT _rowid_ FROM synced_group_blocks WHERE id=?').safeIntegers(true).pluck().get(blocks[0].id).toString(),
        retained: db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(input.retainedGroupId),
        operations: db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all() }
    })()
  } finally { db.close() }
  assert.throws(() => inspectOrdinaryRestoreDatabase(file), /恢复边界|stage|同步/)
  phase('sql-assertions-completed')
  process.stdout.write(JSON.stringify({ pid: process.pid, manifestHash: stage.manifestHash, ...value }))
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
