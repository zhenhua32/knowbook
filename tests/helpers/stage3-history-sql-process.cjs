(async () => {
  const assert = require('node:assert/strict')
  const { join } = require('node:path')
  const Database = require('better-sqlite3')
  const input = JSON.parse(process.argv[2])
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { reopenRootRestoreReferencePlan3 } = await import('../../src/main/database/restore-knowledge-reference3-read.ts')
  const { reopenRootRestorePhysicalStage3 } = await import('../../src/main/database/restore-knowledge-stage3-physical.ts')
  const { reopenRootRestoreHistorySql3 } = await import('../../src/main/database/restore-knowledge-stage3-history-sql.ts')
  const { restoreSqliteFilename } = await import('../../src/main/database/restore-safety-sqlite-path.ts')
  const { assertSyncedRecoveryBoundaryRecords } = await import('../../src/main/database/synced-recovery-boundary-read.ts')
  const { inspectOrdinaryRestoreConnection } = await import('../../src/main/database/restore-safety-read.ts')
  const { stage3MarkerKey } = await import('../../src/main/database/restore-knowledge-stage3-marker-model.ts')
  const original = await reopenPreparedMixedOriginBundle(input.original)
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, input.identity)
  const reference = await reopenRootRestoreReferencePlan3(identity.plan, input.reference)
  const stage = await reopenRootRestorePhysicalStage3(reference.plan, input.stage)
  const history = await reopenRootRestoreHistorySql3(stage.stage, input.history)
  // The durable predecessor and successor were independently copied and opened
  // by the owner. Keep this extra gate probe off the sealed successor bytes.
  const db = new Database(restoreSqliteFilename(input.gateProbe), { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=ON')
    db.transaction(() => {
      assert.ok(db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(stage3MarkerKey(stage.stageId)))
      assert.throws(() => assertSyncedRecoveryBoundaryRecords(db), /未知恢复边界metadata版本/)
      assert.throws(() => inspectOrdinaryRestoreConnection(db))
    })()
  } finally { db.close() }
  process.stdout.write(JSON.stringify({ pid: process.pid, manifestHash: history.manifestHash,
    boundaryHash: history.value.boundaryHash, acceptedCoverage: history.value.acceptedCoverage }))
})().catch(error => { console.error(error); process.exitCode = 1 })
