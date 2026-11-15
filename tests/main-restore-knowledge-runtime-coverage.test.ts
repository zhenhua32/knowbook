import assert from 'node:assert/strict'
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { openBackupV3RestoreSource } from '../src/main/backup/v3-reader'
import { prepareBackupV3RestorePlan } from '../src/main/backup/v3-restore-prepare'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { COVERAGE_ANCHOR_CHANNEL } from '../src/main/database/restore-knowledge-coverage-model'
import { prepareRootRestoreFinalAssetSql5 } from '../src/main/database/restore-knowledge-derived-stage4'
import { prepareRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { prepareRootRestoreCoverageSql } from '../src/main/database/restore-knowledge-stage3-history-sql'
import { readRootRestoreStage3HistoryPreimage3, withPreparedRestoreHistoryScope3,
  type PreparedRestoreHistoryScope3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { KnowbookStore } from '../src/main/database/store'
import { assertSyncedLifecycleSchema, readSyncedLifecycleSchemaWithCoverageOwned } from '../src/main/database/synced-lifecycle-schema-read'
import { assertRawSyncedHistoricalEvidenceOwned, readRawSyncedHistoricalEvidenceWithCoverageOwned } from '../src/main/database/synced-operation-history-read'
import { assertSyncedRemoteObservationRecords, readSyncedRemoteObservationWithCoverageOwned } from '../src/main/database/synced-remote-observation-read'
import { cutProbe } from './helpers/stage3-cut-fixture'
import { randomUUID, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('actual V3 recovery coverage is recognized as unresolved SQL evidence by explicit readers', () => withV3Fixture(async f => {
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const source = openBackupV3RestoreSource(await realpath(f.destination))
  const profile = join(f.root, 'coverage-evidence-receiver')
  await mkdir(profile)
  const profileRoot = await realpath(profile), operationId = randomUUID()
  const safety = join(profileRoot, 'backups', 'database-restore', operationId, 'safety')
  await mkdir(safety, { recursive: true })
  const store = KnowbookStore.createEmptySyncedReceiver(join(profileRoot, 'storage', 'knowbook.db'))
  try {
    await store.getUnsafeDatabaseHandle().backup(join(safety, 'knowbook.db'))
    const { reference } = await prepareBackupV3RestorePlan({ profileRoot, operationId, source,
      choices: { originPolicy: 'isolate-incoming', anonymousValues: 'source' } })
    const combined = await prepareRootRestoreSqlAssetStage5(reference.plan)
    const { covered, canonical, expired } = await withPreparedRestoreHistoryScope3(async scope => {
      const { canonical, derived } = await prepareRootRestoreFinalAssetSql5(reference.plan, combined.stage, scope)
      await assert.rejects(readRootRestoreStage3HistoryPreimage3(combined.sql.stage, scope), /不属于本次/)
      const file = join(canonical.directory, 'manifest.json'), bytes = await readFile(file)
      await writeFile(file, Buffer.concat([bytes, Buffer.from(' ')]))
      try { await assert.rejects(readRootRestoreStage3HistoryPreimage3(canonical.stage, scope), /待保持文件不是准确独立普通原件/) }
      finally { await writeFile(file, bytes) }
      const covered = await prepareRootRestoreCoverageSql(reference.plan, derived.stage, undefined, scope)
      return { canonical, covered, expired: scope }
    })
    await assert.rejects(readRootRestoreStage3HistoryPreimage3(canonical.stage, expired), /不属于本次/)
    const forged: PreparedRestoreHistoryScope3 = { kind: expired.kind }
    await assert.rejects(readRootRestoreStage3HistoryPreimage3(canonical.stage, forged), /不属于本次/)
    const coveredDirectory = join(covered.directory, 'database')
    assert.equal(covered.value.installPermit, false)
    await cutProbe(coveredDirectory, profileRoot, copy => {
      assert.throws(() => assertSyncedRemoteObservationRecords(copy), /准确参与组/)
      assert.throws(() => assertSyncedLifecycleSchema(copy), /准确参与组/)
      assert.throws(() => assertRawSyncedHistoricalEvidenceOwned(copy), /准确参与组/)
      const coverage = readSyncedRemoteObservationWithCoverageOwned(copy)
      assert.equal(coverage.kind, 'restore-knowledge-unresolved-required-roots')
      assert.deepEqual(coverage.entries, [covered.value.coverage])
      assert.deepEqual(readSyncedLifecycleSchemaWithCoverageOwned(copy), coverage)
      const history = readRawSyncedHistoricalEvidenceWithCoverageOwned(copy)
      assert.deepEqual(history.coverage, coverage)
      const capsule = readRawCapsule2HistoricalEvidenceOwned(copy)
      assert.equal(capsule.acceptedCoverage, false)
      assert.deepEqual(history.legacyHistory.facts, capsule.legacyFacts)
      assert.equal(capsule.coverageSyntaxFacts.length, 4)
      assert.equal(coverage.entries[0].cut.kind, 'ordinary-empty-epoch-cut')
    })
    await cutProbe(coveredDirectory, profileRoot, copy => {
      assert.throws(() => readSyncedRemoteObservationWithCoverageOwned(copy), /真实自有事务/)
      assert.throws(() => readRawSyncedHistoricalEvidenceWithCoverageOwned(copy), /真实自有事务/)
      assert.throws(() => copy.transaction(() => {
        copy.prepare("INSERT INTO synced_exposure_attempts VALUES(?,?,?,?,?,'possible',?,NULL)")
          .run(randomUUID(), '1'.repeat(64), COVERAGE_ANCHOR_CHANNEL, '2'.repeat(64), '3'.repeat(64), '2051-02-02T03:04:05.006Z')
        readSyncedRemoteObservationWithCoverageOwned(copy)
      })(), /reserved channel|零成员/)
    }, true)
  } finally { store.destroy() }
}))
