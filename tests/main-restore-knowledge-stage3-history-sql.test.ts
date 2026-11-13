import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreHistorySql3 } from '../src/main/database/restore-knowledge-stage3-history-sql'
import { copyRootRestoreStage3Database3, prepareRootRestorePhysicalStage3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { restoreSqliteFilename } from '../src/main/database/restore-safety-sqlite-path'
import { RECOVERY_BOUNDARY_CHANNEL, parseRecoveryBoundaryJson, recoveryBoundaryHash, recoveryBoundaryKey, recoveryEpochMarkerId,
  validateSyncedRecoveryEpochReceipt, validateSyncedRecoveryHistoryBoundary } from '../src/main/database/synced-recovery-boundary-model'
import { cutDiskInventory, withStage3RetainedHistoryFixture } from './helpers/stage3-cut-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

test('actual Stage3 successor authors private B/R and a zero-member anchor without replacing retained SQLite history or the gate',
  { timeout: 120_000 }, () => withStage3RetainedHistoryFixture(async f => {
    const stage = await prepareRootRestorePhysicalStage3(f.prepared.plan)
    const originalDirectory = join(stage.directory, 'database'), before = await cutDiskInventory(originalDirectory)
    const successor = await prepareRootRestoreHistorySql3(stage.stage)
    assert.equal(successor.value.historyCutComplete, false)
    assert.equal(successor.value.acceptedCoverage, false)
    assert.equal(successor.value.installPermit, false)
    assert.ok(successor.value.uncovered.some(row => row.family === 'groups' && row.added.length))
    assert.ok(successor.value.uncovered.every(row => row.removed.length === 0))
    const location = await readRootKnowledgePlanLocation3(f.saved.knowledgePlan), namespace = f.saved.value.root.namespace
    assert.equal(namespace.kind, 'imported-bundle')
    if (namespace.kind !== 'imported-bundle') throw new Error('Expected genuine mounted bundle')
    const gate = join(dirname(successor.directory), 'gate-probe-' + successor.stageId)
    await copyRootRestoreStage3Database3(join(successor.directory, 'database'), gate, location.profileRoot, successor.value.inventory)
    const gateProbe = join(gate, 'knowbook.db')
    const db = new Database(restoreSqliteFilename(gateProbe), { readonly: true, fileMustExist: true })
    try {
      const { operationId } = successor.value, markerId = recoveryEpochMarkerId(operationId)
      const b = db.prepare('SELECT value FROM app_settings WHERE key=?').pluck().get(recoveryBoundaryKey(operationId)) as string
      const r = db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').pluck().get(markerId) as string
      const boundary = validateSyncedRecoveryHistoryBoundary(parseRecoveryBoundaryJson(b))
      const receipt = validateSyncedRecoveryEpochReceipt(parseRecoveryBoundaryJson(r))
      assert.equal(recoveryBoundaryHash(boundary), receipt.boundaryHash)
      assert.equal(receipt.boundaryHash, successor.value.boundaryHash)
      assert.ok(boundary.instances.some(row => row.instanceId === f.source.instanceId && row.hostDocumentId === f.source.hostId))
      assert.equal(boundary.groups.find(row => row.groupId === f.cases.retained.groupId)?.rows.length, 2)
      assert.equal(boundary.retainedPins.length, f.cases.pins.length)
      assert.deepEqual(db.prepare('SELECT channel,state,confirmed_at FROM synced_exposure_attempts WHERE id=?').get(markerId),
        { channel: RECOVERY_BOUNDARY_CHANNEL, state: 'possible', confirmed_at: null })
      assert.equal(db.prepare('SELECT 1 FROM synced_group_exposure_members WHERE attempt_id=?').get(markerId), undefined)
    } finally { db.close() }

    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/stage3-history-sql-process.cjs'),
      JSON.stringify({ original: { profileRoot: location.profileRoot, operationId: location.operationId, mountId: namespace.mountId,
        expectedDescriptorHash: f.saved.originalPackage.descriptorHash }, identity: { planId: f.base.planId, expectedManifestHash: f.base.manifestHash },
      reference: { planId: f.prepared.planId, expectedManifestHash: f.prepared.manifestHash },
      stage: { stageId: stage.stageId, expectedManifestHash: stage.manifestHash }, history: { stageId: successor.stageId,
        expectedManifestHash: successor.manifestHash, evidence: successor.value.evidence }, gateProbe })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000 })
    const cold = JSON.parse(stdout)
    assert.notEqual(cold.pid, process.pid)
    assert.deepEqual(cold, { pid: cold.pid, manifestHash: successor.manifestHash, boundaryHash: successor.value.boundaryHash, acceptedCoverage: false })
    assert.deepEqual(await cutDiskInventory(originalDirectory), before)
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }))
