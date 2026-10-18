import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { withControlledRestore, restoreKnowbookDatabase, recoverInterruptedDatabaseRestore, noProcesses,
  assertOriginals, inspect, workspace, digest } from './helpers/controlled-restore-fixture'

test('controlled restore replaces a readable ordinary current from a real ordinary backup with a fresh installed epoch and exact original DB WAL SHM archive', () => withControlledRestore(async f => {
  const original = f.sealCurrent()
  assert.ok(original.some(file => file.name === 'knowbook.db-wal') && original.some(file => file.name === 'knowbook.db-shm'), 'The ordinary preservation oracle contains actual SQLite-produced WAL and SHM')
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.equal(result.continuity, 'ordinary-verified')
  assert.equal(result.installedSchemaVersion, 27)
  assert.equal(result.schemaVersion, 27)
  assert.equal(result.workspaceScope, f.currentWorkspace.workspace_scope)
  assert.match(result.operationId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i)
  assert.equal(result.sourceSha256, digest(f.sourceBytes))
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  for (const file of original) assert.deepEqual(readFileSync(join(result.recoveryDirectory, 'original', file.name)), file.bytes)
  inspect(f.database, db => {
    assert.equal(db.pragma('user_version', { simple: true }), 27)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assert.equal((db.prepare('SELECT title FROM documents WHERE id=?').get(f.id) as { title: string }).title, 'Ordinary source backup')
    const installed = workspace(db)
    assert.equal(installed.workspace_scope, f.currentWorkspace.workspace_scope)
    assert.equal(result.recoveryEpoch, installed.recovery_epoch)
    assert.notEqual(installed.recovery_epoch, f.sourceWorkspace.recovery_epoch)
    assert.notEqual(installed.recovery_epoch, f.currentWorkspace.recovery_epoch)
  })
  assert.equal(await recoverInterruptedDatabaseRestore(f.profile), true)
}))

test('controlled restore startup reinspection does not mint a second epoch after the ordinary candidate was committed', () => withControlledRestore(async f => {
  f.sealCurrent()
  await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  const first = inspect(f.database, workspace)
  assert.notEqual(first.recovery_epoch, f.sourceWorkspace.recovery_epoch)
  const before = Buffer.from(readFileSync(f.database))
  assert.equal(await recoverInterruptedDatabaseRestore(f.profile), true)
  assert.equal(await recoverInterruptedDatabaseRestore(f.profile), true)
  assert.deepEqual(inspect(f.database, workspace), first)
  assert.deepEqual(readFileSync(f.database), before)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore rechecks a source modified after stopping processes and never installs its earlier staged bytes', () => withControlledRestore(async f => {
  const original = f.sealCurrent(), changed = Buffer.concat([f.sourceBytes, Buffer.from('\nexternal source changed after stage\n')])
  let stopped = 0, replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup,
    stopProcesses: async () => { stopped++; writeFileSync(f.backup, changed); return [] },
    beforeReplace: async () => { replaced = true } }))
  assert.equal(stopped, 1)
  assert.equal(replaced, false)
  assertOriginals(f.database, original)
  assert.deepEqual(readFileSync(f.backup), changed)
}))

test('controlled restore beforeReplace failure rolls back readable ordinary original raw files without altering the source', () => withControlledRestore(async f => {
  const original = f.sealCurrent()
  let entered = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
    beforeReplace: async () => { entered = true; throw new Error('controlled exact replacement failure') } }), /controlled exact replacement failure/)
  assert.equal(entered, true)
  assertOriginals(f.database, original)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
}))

test('controlled restore retains the explicit unfenced damaged-current disaster compatibility path without claiming sync continuity', () => withControlledRestore(async f => {
  f.close()
  for (const suffix of ['', '-wal', '-shm']) writeFileSync(f.database + suffix, 'unfenced original damaged bytes' + suffix)
  const expected = ['', '-wal', '-shm'].map(suffix => Buffer.from('unfenced original damaged bytes' + suffix))
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.equal(result.continuity, 'legacy-disaster-unverified')
  for (const [index, suffix] of ['', '-wal', '-shm'].entries()) assert.deepEqual(readFileSync(join(result.recoveryDirectory, 'original', 'knowbook.db' + suffix)), expected[index])
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  assert.equal(inspect(f.database, db => (db.prepare('SELECT title FROM documents WHERE id=?').get(f.id) as { title: string }).title), 'Ordinary source backup')
}))
