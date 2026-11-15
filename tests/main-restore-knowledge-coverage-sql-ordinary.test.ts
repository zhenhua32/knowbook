import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { readRawPriorKnowledgeCoverageOwned } from '../src/main/database/restore-knowledge-coverage-raw-read'
import { prepareRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { stage3MarkerKey } from '../src/main/database/restore-knowledge-stage3-marker-model'
import { prepareRootRestoreFinalAssetSql5 } from '../src/main/database/restore-knowledge-derived-stage4'
import { prepareRootRestoreCoverageSql } from '../src/main/database/restore-knowledge-stage3-history-sql'
import { cutProbe } from './helpers/stage3-cut-fixture'
import { withNativeCoverageFixture } from './helpers/native-coverage-fixture'

test('native Root3 verifies an ordinary current before writing C with a genuine incoming synced group',
  { timeout: 120_000 }, () => withNativeCoverageFixture(true, async f => {
    const location = await readRootKnowledgePlanLocation3(f.root.knowledgePlan), root = f.root.originalPackage.original.root
    assert.equal(root.namespace.kind, 'native')
    const trace = (event: string) => { if (process.env.KNOWBOOK_TRACE_COVERAGE_DRAFT) process.stderr.write(`[coverage] ${event}\n`) }
    const locate = (item: { stageId: string; manifestHash: string }) => ({ stageId: item.stageId, expectedManifestHash: item.manifestHash })
    const combined = await prepareRootRestoreSqlAssetStage5(f.reference.plan)
    trace('combined')
    const final = await prepareRootRestoreFinalAssetSql5(f.reference.plan, combined.stage)
    trace('final')
    trace(JSON.stringify({ remaining: final.sql.value.remaining, canonical: final.canonical.value.canonicalAssets }))
    const coverage = await prepareRootRestoreCoverageSql(f.reference.plan, final.derived.stage)
    trace('coverage')
    assert.equal(coverage.value.installPermit, false)
    const actual = await cutProbe(join(coverage.directory, 'database'), location.profileRoot, db => {
      assert.equal(db.prepare('SELECT key FROM app_settings WHERE key=?').get(stage3MarkerKey(final.canonical.stageId)), undefined)
      assert.ok(db.prepare('SELECT 1 FROM synced_groups LIMIT 1').get())
      return readRawPriorKnowledgeCoverageOwned(db)
    })
    assert.equal(actual.entries.length, 1)
    assert.equal(actual.entries[0].operationId, location.operationId)
    assert.equal(actual.entries[0].cut.kind, 'ordinary-empty-epoch-cut')
    assert.equal(actual.entries[0].supports.boundary, null)
    assert.equal(actual.entries[0].supports.epoch, null)
    assert.equal(coverage.value.history, null)
    assert.deepEqual(actual.entries[0], coverage.value.coverage)
    const worker = fileURLToPath(new URL('./coverage-sql-process.cjs', import.meta.url))
    const cold = promisify(execFile)(process.execPath, ['--import', 'tsx', worker, JSON.stringify({
      original: { profileRoot: location.profileRoot, operationId: location.operationId,
        mountId: f.root.mountId, expectedDescriptorHash: f.root.originalPackage.descriptorHash },
      identity: { planId: f.identity.planId, expectedManifestHash: f.identity.manifestHash },
      reference: { planId: f.reference.planId, expectedManifestHash: f.reference.manifestHash },
      combined: locate(combined), final: { aliases: locate(final.aliases), canonical: locate(final.canonical), sql: locate(final.sql), derived: locate(final.derived) },
      coverage: { ...locate(coverage), history: coverage.value.history, evidence: coverage.value.evidence } })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000 })
    if (process.env.KNOWBOOK_TRACE_COVERAGE_DRAFT) cold.child.stderr?.on('data', chunk => process.stderr.write(chunk))
    const { stdout } = await cold, reopened = JSON.parse(stdout)
    assert.notEqual(reopened.pid, process.pid)
    assert.deepEqual(reopened.value, coverage.value)
    assert.equal(reopened.manifestHash, coverage.manifestHash)
  }))
