import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { withControlledRestore, assertOriginals, inspect, workspace } from './helpers/controlled-restore-fixture'
import { faultChild } from './helpers/controlled-restore-fault-fixture'

test('controlled restore quarantines the physically corrupted installed candidate and its sidecars before exact three file rollback with complete originals', () => withControlledRestore(async f => {
  const before = f.sealCurrent(), crashed = await faultChild(f.profile, f.backup, 'installed', join(f.root, 'installed-before-corrupt.json'))
  assert.equal(crashed.code, 74); assert.equal(crashed.evidence.injected, true); assert.equal(crashed.evidence.interrupted, true)
  const { pointer } = crashed.evidence.witness as { pointer: { operationId: string; phase: string } }
  assert.equal(pointer.phase, 'installed')
  const recovery = join(f.profile, 'backups', 'database-restore', pointer.operationId)
  for (const file of before) assert.deepEqual(readFileSync(join(recovery, 'original', file.name)), file.bytes)
  const rejected = [Buffer.from('physical-not-a-sqlite-database\0'), Buffer.from('candidate-only-not-original-wal\0'), Buffer.from('candidate-only-not-original-shm\0')]
  for (const [index, suffix] of ['', '-wal', '-shm'].entries()) writeFileSync(f.database + suffix, rejected[index])
  const recovered = await faultChild(f.profile, f.backup, 'recover', join(f.root, 'recover-bad-installed.json'))
  assert.equal(recovered.code, 0); assert.equal(recovered.evidence.recovered, true)
  assertOriginals(f.database, before)
  const names = readdirSync(recovery)
  for (const [index, name] of ['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm'].entries()) {
    const prefix = 'rejected-' + name + '-'
    const quarantined = names.filter(candidate => candidate.startsWith(prefix) && /^[0-9a-f-]{36}$/i.test(candidate.slice(prefix.length)))
    assert.equal(quarantined.length, 1, 'Each rejected candidate file has one independently preserved quarantine object')
    assert.deepEqual(readFileSync(join(recovery, quarantined[0])), rejected[index])
  }
  assert.equal(JSON.parse(readFileSync(join(f.profile, 'database-restore-fence.json'), 'utf8')).phase, 'rolledback')
  assert.equal(JSON.parse(readFileSync(join(f.profile, 'database-restore-safe-mode.json'), 'utf8')).id, pointer.operationId)
  assert.equal(JSON.parse(readFileSync(join(recovery, 'result.json'), 'utf8')).status, 'rolled-back')
  assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore leaves a corrupt installed target and its pending authority untouched when one exact archived original is missing', () => withControlledRestore(async f => {
  const before = f.sealCurrent(), crashed = await faultChild(f.profile, f.backup, 'installed', join(f.root, 'installed-before-missing.json'))
  assert.equal(crashed.code, 74)
  const { pointer } = crashed.evidence.witness as { pointer: { operationId: string; phase: string } }
  assert.equal(pointer.phase, 'installed')
  const recovery = join(f.profile, 'backups', 'database-restore', pointer.operationId), removed = before[0]
  for (const file of before) assert.deepEqual(readFileSync(join(recovery, 'original', file.name)), file.bytes)
  const isolated = join(f.root, 'isolated-missing-original.db')
  renameSync(join(recovery, 'original', removed.name), isolated)
  const broken = Buffer.from('physical-bad-candidate-with-missing-original\0')
  writeFileSync(f.database, broken)
  const pending = Buffer.from(readFileSync(join(f.profile, 'database-restore-pending.json')))
  const fence = Buffer.from(readFileSync(join(f.profile, 'database-restore-fence.json')))
  const intent = Buffer.from(readFileSync(join(recovery, 'intent.json')))
  const recovered = await faultChild(f.profile, f.backup, 'recover', join(f.root, 'recover-missing-original.json'))
  assert.equal(recovered.code, 1); assert.equal(recovered.evidence.caught, true)
  assert.deepEqual(readFileSync(f.database), broken)
  assert.deepEqual(readFileSync(join(f.profile, 'database-restore-pending.json')), pending)
  assert.deepEqual(readFileSync(join(f.profile, 'database-restore-fence.json')), fence)
  assert.deepEqual(readFileSync(join(recovery, 'intent.json')), intent)
  assert.deepEqual(readFileSync(isolated), removed.bytes)
  assert.equal(existsSync(join(recovery, 'original', removed.name)), false)
  for (const file of before.slice(1)) assert.deepEqual(readFileSync(join(recovery, 'original', file.name)), file.bytes)
  assert.equal(readdirSync(recovery).some(name => name.startsWith('rejected-')), false)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore cannot finish even a valid installed target when its exact original archive has been removed or replaced', async () => {
  for (const fault of ['missing', 'replaced']) await withControlledRestore(async f => {
    const before = f.sealCurrent(), crashed = await faultChild(f.profile, f.backup, 'installed', join(f.root, 'valid-before-' + fault + '.json'))
    assert.equal(crashed.code, 74)
    const { pointer } = crashed.evidence.witness as { pointer: { operationId: string; phase: string } }
    assert.equal(pointer.phase, 'installed')
    const recovery = join(f.profile, 'backups', 'database-restore', pointer.operationId), original = join(recovery, 'original', before[0].name)
    assert.deepEqual(readFileSync(original), before[0].bytes)
    const installed = Buffer.from(readFileSync(f.database)), epoch = inspect(f.database, workspace)
    assert.equal(inspect(f.database, db => db.pragma('integrity_check', { simple: true })), 'ok')
    const receipts = inspect(f.database, db => db.prepare("SELECT * FROM app_settings WHERE key LIKE 'database.restore.receipt.%' ORDER BY key").all())
    assert.equal(receipts.length, 1, 'The candidate is genuinely valid and owns its actual committed restore receipt before archive corruption')
    const isolated = join(f.root, 'valid-target-isolated-original.db')
    if (fault === 'missing') renameSync(original, isolated)
    else writeFileSync(original, Buffer.from('wrong-archived-original-not-a-valid-rollback-source'))
    const pending = Buffer.from(readFileSync(join(f.profile, 'database-restore-pending.json')))
    const fence = Buffer.from(readFileSync(join(f.profile, 'database-restore-fence.json')))
    const intent = Buffer.from(readFileSync(join(recovery, 'intent.json')))
    const recovered = await faultChild(f.profile, f.backup, 'recover', join(f.root, 'valid-' + fault + '-recover.json'))
    assert.equal(recovered.code, 1); assert.equal(recovered.evidence.caught, true)
    assert.deepEqual(readFileSync(f.database), installed)
    assert.deepEqual(inspect(f.database, workspace), epoch)
    assert.deepEqual(inspect(f.database, db => db.prepare("SELECT * FROM app_settings WHERE key LIKE 'database.restore.receipt.%' ORDER BY key").all()), receipts)
    assert.deepEqual(readFileSync(join(f.profile, 'database-restore-pending.json')), pending)
    assert.deepEqual(readFileSync(join(f.profile, 'database-restore-fence.json')), fence)
    assert.deepEqual(readFileSync(join(recovery, 'intent.json')), intent)
    if (fault === 'missing') { assert.equal(existsSync(original), false); assert.deepEqual(readFileSync(isolated), before[0].bytes) }
    else assert.deepEqual(readFileSync(original), Buffer.from('wrong-archived-original-not-a-valid-rollback-source'))
    assert.equal(readdirSync(recovery).some(name => name.startsWith('rejected-')), false)
    assert.equal(existsSync(join(recovery, 'result.json')), false)
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  })
})
