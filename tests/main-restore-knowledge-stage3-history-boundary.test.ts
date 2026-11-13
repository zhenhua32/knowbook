import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreHistoryBoundaryCandidate3, reopenRootRestoreHistoryBoundaryCandidate3 }
  from '../src/main/database/restore-knowledge-stage3-history-boundary'
import { prepareRootRestorePhysicalStage3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { restoreSqliteFilename } from '../src/main/database/restore-safety-sqlite-path'
import { recoveryOperationRowHash, type SyncedRecoveryOperationRow } from '../src/main/database/synced-recovery-boundary-model'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { cutDiskInventory, withStage3CutFixture } from './helpers/stage3-cut-fixture'

test('sealed current history evidence cold reopens from the real retained cut and rejects rehashed or changed original evidence',
  { timeout: 120_000 }, () => withStage3CutFixture(async f => {
    const physical = await prepareRootRestorePhysicalStage3(f.prepared.plan)
    const databaseDirectory = join(physical.directory, 'database')
    const stageBefore = await cutDiskInventory(databaseDirectory)
    const evidence = await prepareRootRestoreHistoryBoundaryCandidate3(physical.stage)
    const { value } = evidence, history = value.unresolvedCurrentHistory
    assert.ok(history)
    assert.equal(value.stageManifestHash, physical.manifestHash)
    assert.equal(value.physicalObservationHash, physical.value.physicalObservationHash)
    assert.equal(value.historyCutComplete, false)
    assert.equal(value.acceptedCoverage, false)
    assert.equal(value.installPermit, false)
    assert.equal(value.noCurrentSyncHistory, false)
    assert.ok(value.uncovered.some(row => row.family === 'groups' && row.added.length > 0))
    assert.ok(value.uncovered.some(row => row.family === 'instances' && row.removed.includes(f.source.instanceId)))
    assert.equal(value.proposedBoundary, null)
    assert.equal(value.proposedReceipt, null)
    assert.equal(value.proposedEpochRequestHash, null)
    const archive = history.groups.find(row => row.groupId === f.cases.retained.groupId)
    assert.ok(archive)
    assert.equal(archive.rows.length, 2)
    assert.notEqual(archive.after.historyCursor, archive.before.historyCursor)
    assert.equal(archive.after.historyPosition, 0)
    const token = f.cases.sharedSecond.ack.historyToken!
    assert.deepEqual(history.hostCuts.find(row => row.historyToken === token)?.documentIds,
      [f.source.hostId, f.cases.retained.hostId].sort())
    const operation = f.source.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
      .get(f.cases.sharedSecond.input.clientOperationId) as SyncedRecoveryOperationRow
    assert.ok(operation)
    assert.deepEqual(history.retainedOperations.find(row => row.operationId === operation.client_operation_id),
      { operationId: operation.client_operation_id, rowHash: recoveryOperationRowHash(operation) })
    assert.equal(history.retainedPins.length, f.cases.pins.length)
    await assert.rejects(prepareRootRestoreHistoryBoundaryCandidate3({ kind: physical.stage.kind }), /不是实际Main物理stage句柄/)

    const location = await readRootKnowledgePlanLocation3(f.saved.knowledgePlan), namespace = f.saved.value.root.namespace
    assert.equal(namespace.kind, 'imported-bundle')
    if (namespace.kind !== 'imported-bundle') throw new Error('Expected the genuine mounted bundle')
    const locator = { evidenceId: evidence.evidenceId, expectedManifestHash: evidence.manifestHash }
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/stage3-history-evidence-process.cjs'),
      JSON.stringify({
        original: { profileRoot: location.profileRoot, operationId: location.operationId, mountId: namespace.mountId,
          expectedDescriptorHash: f.saved.originalPackage.descriptorHash },
        identity: { planId: f.base.planId, expectedManifestHash: f.base.manifestHash },
        reference: { planId: f.prepared.planId, expectedManifestHash: f.prepared.manifestHash },
        stage: { stageId: physical.stageId, expectedManifestHash: physical.manifestHash }, evidence: locator
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000 })
    const cold = JSON.parse(stdout)
    assert.notEqual(cold.pid, process.pid)
    assert.deepEqual(cold, { pid: cold.pid, manifestHash: evidence.manifestHash,
      stageManifestHash: physical.manifestHash, acceptedCoverage: false, rejectedRehash: true })

    const intent = JSON.parse(await readFile(join(physical.directory, 'intent.json'), 'utf8'))
    const copyFile = join(dirname(dirname(physical.directory)), 'restore-current-copies-v3', intent.copyId, 'database', 'knowbook.db')
    const db = new Database(restoreSqliteFilename(copyFile), { fileMustExist: true })
    try {
      assert.equal(db.prepare('UPDATE documents SET title=title||? WHERE id=?')
        .run(' copied original tamper', f.cases.retained.hostId).changes, 1)
    } finally { db.close() }
    await assert.rejects(reopenRootRestoreHistoryBoundaryCandidate3(physical.stage, locator))
    assert.deepEqual(await cutDiskInventory(databaseDirectory), stageBefore)
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }))
