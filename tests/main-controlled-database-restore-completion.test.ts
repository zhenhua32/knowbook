import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { withControlledRestore, digest, inspect, workspace } from './helpers/controlled-restore-fixture'
import { faultChild } from './helpers/controlled-restore-fault-fixture'

async function installedCompletionFailure(mode: string, marker: string) {
  await withControlledRestore(async f => {
    const original = f.sealCurrent(), failed = await faultChild(f.profile, f.backup, mode, join(f.root, mode + '.json'))
    assert.equal(failed.code, 0); assert.equal(failed.evidence.injected, true); assert.equal(failed.evidence.caught, true)
    assert.equal(JSON.stringify(failed.evidence.error).includes(marker), true)
    assert.equal(JSON.stringify(failed.evidence.error).includes('EIO'), true)
    const witness = failed.evidence.witness as { pointer: { operationId: string; phase: string }; fence: { phase: string }; databaseSHA256: string;
      actual: { workspace: { workspace_scope: string; recovery_epoch: string }; receipts: Array<{ key: string; value: string; updated_at: string }> } }
    assert.equal(witness.pointer.phase, 'installed'); assert.equal(witness.fence.phase, 'installed')
    const recovery = join(f.profile, 'backups', 'database-restore', witness.pointer.operationId)
    for (const file of original) assert.deepEqual(readFileSync(join(recovery, 'original', file.name)), file.bytes)
    const receipt = witness.actual.receipts.find(row => row.key === 'database.restore.receipt.' + witness.pointer.operationId)
    assert.ok(receipt, 'The failed completion follows a genuine installed SQL receipt, not a synthesized commit marker')
    assert.equal(digest(readFileSync(f.database)), witness.databaseSHA256)
    assert.deepEqual(inspect(f.database, workspace), witness.actual.workspace)
    assert.equal(inspect(f.database, db => db.pragma('integrity_check', { simple: true })), 'ok')
    assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), true)
    const fence = Buffer.from(readFileSync(join(f.profile, 'database-restore-fence.json')))
    assert.equal((await faultChild(f.profile, f.backup, 'recover', join(f.root, mode + '-recover.json'))).code, 0)
    assert.equal((await faultChild(f.profile, f.backup, 'recover', join(f.root, mode + '-again.json'))).code, 0)
    assert.equal(digest(readFileSync(f.database)), witness.databaseSHA256)
    assert.deepEqual(inspect(f.database, workspace), witness.actual.workspace)
    assert.equal(inspect(f.database, db => (db.prepare('SELECT value FROM app_settings WHERE key=?').get(receipt.key) as { value: string }).value), receipt.value)
    assert.deepEqual(readFileSync(join(f.profile, 'database-restore-fence.json')), fence)
    assert.equal(JSON.parse(readFileSync(join(recovery, 'result.json'), 'utf8')).recoveryEpoch, witness.actual.workspace.recovery_epoch)
    assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
    for (const file of original) assert.deepEqual(readFileSync(join(recovery, 'original', file.name)), file.bytes)
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  })
}

test('controlled restore preserves its installed epoch and completes in a fresh process after exact result publication rename fails', () => installedCompletionFailure('result-error', 'controlled-installed-result-EIO'))

test('controlled restore preserves its installed epoch and completes in a fresh process after exact pending journal cleanup fails', () => installedCompletionFailure('cleanup-error', 'controlled-installed-cleanup-EIO'))
