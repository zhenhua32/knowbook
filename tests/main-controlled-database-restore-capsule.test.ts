import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { withControlledRestore, restoreKnowbookDatabase, recoverInterruptedDatabaseRestore, noProcesses, inspect,
  originals, assertOriginals, files, digest, workspace } from './helpers/controlled-restore-fixture'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'

test('controlled restore authenticates the actual installed receipt through immutable intent and external fence without a receipt intent hash cycle', () => withControlledRestore(async f => {
  const original = f.sealCurrent(), result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  const fenceBytes = readFileSync(join(f.profile, 'database-restore-fence.json'))
  const fence = JSON.parse(fenceBytes.toString()) as { kind: string; version: number; operationId: string; intentHash: string; phase: string; parentFenceHash: string | null }
  assert.deepEqual(Object.keys(fence).sort(), ['kind', 'version', 'operationId', 'intentHash', 'phase', 'parentFenceHash'].sort())
  assert.equal(fence.kind, 'controlled-database-restore-fence'); assert.equal(fence.version, 1)
  assert.equal(fence.phase, 'installed'); assert.equal(fence.operationId, result.operationId); assert.equal(fence.parentFenceHash, null)
  const intentBytes = readFileSync(join(result.recoveryDirectory, 'intent.json'))
  const intent = JSON.parse(intentBytes.toString()) as { kind: string; version: number; operationId: string; source: { path: string; sha256: string; schemaVersion: number };
    current: { classification: string; inventory: Array<{ name: string; present: boolean; bytes: number; sha256: string | null }> };
    receipt: { operationId: string; workspaceScope: string; recoveryEpoch: string; acceptedAt: string; documentBoundary: string }; receiptHash: string; stagedSha256: string }
  assert.equal(digest(intentBytes), fence.intentHash)
  assert.equal(intent.kind, 'controlled-database-restore-intent'); assert.equal(intent.version, 2); assert.equal(intent.operationId, result.operationId)
  assert.deepEqual(intent.source, { path: f.backup, sha256: digest(f.sourceBytes), schemaVersion: 27 })
  assert.equal(intent.current.classification, 'ordinary-verified')
  assert.deepEqual(intent.current.inventory, files.map(name => {
    const file = original.find(file => file.name === name)
    return { name, present: !!file, bytes: file?.bytes.length ?? 0, sha256: file ? digest(file.bytes) : null }
  }))
  for (const file of original) assert.deepEqual(readFileSync(join(result.recoveryDirectory, 'safety', file.name)), file.bytes)
  assert.equal(digest(readFileSync(f.database)), intent.stagedSha256)
  inspect(f.database, db => {
    const row = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get('database.restore.receipt.' + result.operationId) as { value: string; updated_at: string } | undefined
    assert.ok(row, 'The actual installed SQLite transaction persisted the operation-bound restore receipt')
    assert.equal(row.value, canonicalSyncedPortableJson(intent.receipt))
    assert.equal(digest(row.value), intent.receiptHash)
    const receipt = JSON.parse(row.value) as Record<string, unknown>
    assert.deepEqual(Object.keys(receipt).sort(), ['kind','version','operationId','profileRoot','sourceSha256','sourceSchemaVersion','cloneSha256','currentInventoryHash','workspaceScope','recoveryEpoch','documentBoundary','continuity','acceptedAt'].sort())
    assert.equal(receipt.kind, 'controlled-database-restore-receipt'); assert.equal(receipt.version, 1)
    assert.equal(receipt.operationId, result.operationId); assert.equal(receipt.continuity, result.continuity)
    assert.equal(receipt.sourceSha256, digest(f.sourceBytes)); assert.equal(receipt.sourceSchemaVersion, 27)
    assert.equal(row.updated_at, receipt.acceptedAt)
    assert.deepEqual(workspace(db), { workspace_scope: result.workspaceScope, recovery_epoch: result.recoveryEpoch })
    assert.ok((db.prepare('SELECT updated_at FROM documents').all() as Array<{ updated_at: string }>).every(row => row.updated_at === receipt.documentBoundary), 'Every installed ordinary document uses the one fixed receipt boundary')
  })
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore retains the exact prior external fence bytes and hash in its next genuine ordinary restore lineage', () => withControlledRestore(async f => {
  f.sealCurrent()
  const first = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  const previous = Buffer.from(readFileSync(join(f.profile, 'database-restore-fence.json')))
  const second = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.notEqual(second.operationId, first.operationId)
  assert.deepEqual(readFileSync(join(second.recoveryDirectory, 'parent-fence.json')), previous)
  const intent = JSON.parse(readFileSync(join(second.recoveryDirectory, 'intent.json'), 'utf8')) as { parentFenceHash: string }
  const fence = JSON.parse(readFileSync(join(f.profile, 'database-restore-fence.json'), 'utf8')) as { parentFenceHash: string }
  assert.equal(intent.parentFenceHash, digest(previous)); assert.equal(fence.parentFenceHash, digest(previous))
  assert.notEqual(second.recoveryEpoch, first.recoveryEpoch)
}))

test('controlled restore refuses a changed immutable intent or safety capsule after real success and preserves the unverified current', async () => {
  for (const fault of ['intent', 'safety'] as const) await withControlledRestore(async f => {
    f.sealCurrent()
    const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
    const file = fault === 'intent' ? join(result.recoveryDirectory, 'intent.json') : join(result.recoveryDirectory, 'safety', 'knowbook.db')
    const changed = Buffer.concat([readFileSync(file), Buffer.from('\nchanged immutable authority input')])
    writeFileSync(file, changed)
    const before = originals(f.database), fence = Buffer.from(readFileSync(join(f.profile, 'database-restore-fence.json')))
    await assert.rejects(recoverInterruptedDatabaseRestore(f.profile))
    assertOriginals(f.database, before)
    assert.deepEqual(readFileSync(file), changed)
    assert.deepEqual(readFileSync(join(f.profile, 'database-restore-fence.json')), fence)
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  })
})
