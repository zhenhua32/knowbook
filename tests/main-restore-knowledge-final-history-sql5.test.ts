import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import Database from 'better-sqlite3'
import { prepareRootRestoreFinalAssetSql5 } from '../src/main/database/restore-knowledge-derived-stage4'
import { readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { prepareRootRestoreFinalHistorySql5 } from '../src/main/database/restore-knowledge-stage3-history-sql'
import { parseRecoveryBoundaryJson, recoveryBoundaryHash, recoveryBoundaryKey,
  validateSyncedRecoveryHistoryBoundary } from '../src/main/database/synced-recovery-boundary-model'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { cutDiskInventory, cutProbe, withStage3RetainedHistoryFixture } from './helpers/stage3-cut-fixture'

test('one cold SQL successor retains localized canonical assets and derived indexes with authenticated recovery history',
  () => withStage3RetainedHistoryFixture(async f => {
    const { profileRoot, operationId } = await readRootKnowledgePlanLocation3(f.saved.knowledgePlan)
    const namespace = f.saved.value.root.namespace
    if (namespace.kind !== 'imported-bundle') throw new Error('Expected genuine imported source originals')
    const combined = await prepareRootRestoreSqlAssetStage5(f.prepared.plan)
    const { aliases, canonical, sql, derived } = await prepareRootRestoreFinalAssetSql5(f.prepared.plan, combined.stage)
    const proof = canonical.value.canonicalAssets
    assert.ok(proof && proof.rewrittenOccurrences === 1 && proof.groups.length === 1)
    const derivedDirectory = join(derived.directory, 'database'), original = await cutDiskInventory(derivedDirectory)
    const history = await prepareRootRestoreFinalHistorySql5(derived.stage)
    assert.deepEqual(history.value.finalSql, { stageId: derived.stageId, manifestHash: derived.manifestHash })
    assert.equal(history.value.installPermit, false)
    const locator = (item: { stageId: string; manifestHash: string }) => ({ stageId: item.stageId, expectedManifestHash: item.manifestHash })
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/stage3-history-sql-process.cjs'),
      JSON.stringify({ original: { profileRoot, operationId, mountId: namespace.mountId, expectedDescriptorHash: f.saved.originalPackage.descriptorHash },
        identity: { planId: f.base.planId, expectedManifestHash: f.base.manifestHash },
        reference: { planId: f.prepared.planId, expectedManifestHash: f.prepared.manifestHash },
        final: { combined: locator(combined), locators: { aliases: locator(aliases), canonical: locator(canonical), sql: locator(sql), derived: locator(derived) } },
        history: { ...locator(history), evidence: history.value.evidence } })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000 })
    const cold = JSON.parse(stdout)
    assert.notEqual(cold.pid, process.pid)
    assert.deepEqual(cold, { pid: cold.pid, manifestHash: history.manifestHash, boundaryHash: history.value.boundaryHash, acceptedCoverage: false })

    const observe = (db: Database.Database) => ({
      canonical: db.prepare('SELECT content FROM synced_group_blocks WHERE group_id=? ORDER BY sort_order').pluck().all(proof.groups[0].groupId),
      summary: db.prepare('SELECT summary FROM documents WHERE title=?').pluck().get('R1 independent incoming host'),
      links: db.prepare('SELECT * FROM links ORDER BY id').all(), routes: db.prepare('SELECT * FROM document_block_routes ORDER BY _rowid_').all(),
      fts: db.prepare('SELECT rowid,content FROM block_search ORDER BY rowid').all()
    })
    const originalRows = await cutProbe(derivedDirectory, profileRoot, observe)
    assert.match(String(originalRows.canonical[0]), /file:.*history-with-canonical\.png/)
    assert.match(String(originalRows.summary), /file:.*history-with-canonical\.png/)
    const successorDirectory = join(history.directory, 'database')
    const actual = await cutProbe(successorDirectory, profileRoot, db => {
      const rawBoundary = db.prepare('SELECT value FROM app_settings WHERE key=?').pluck().get(recoveryBoundaryKey(history.value.operationId)) as string
      const boundary = validateSyncedRecoveryHistoryBoundary(parseRecoveryBoundaryJson(rawBoundary))
      assert.equal(recoveryBoundaryHash(boundary), history.value.boundaryHash)
      assert.equal(boundary.groups.find(row => row.groupId === f.cases.retained.groupId)?.rows.length, 2)
      assert.equal(db.prepare('SELECT COUNT(*) FROM synced_group_history WHERE group_id=?').pluck().get(f.cases.retained.groupId), 0)
      return observe(db)
    })
    assert.deepEqual(actual, originalRows)
    assert.deepEqual(await cutDiskInventory(derivedDirectory), original)
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }, { withIncomingAttachment: true }))
