import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { withControlledRestore, restoreKnowbookDatabase, recoverInterruptedDatabaseRestore, noProcesses,
  Database, KnowbookStore, originals, assertOriginals, inspect, workspace } from './helpers/controlled-restore-fixture'

test('controlled restore refuses a malformed external fence instead of treating ordinary current as unfenced legacy', () => withControlledRestore(async f => {
  const original = f.sealCurrent(), fence = join(f.profile, 'database-restore-fence.json'), invalid = '{damaged external fence'
  writeFileSync(fence, invalid)
  let replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses, beforeReplace: async () => { replaced = true } }))
  assert.equal(replaced, false)
  assertOriginals(f.database, original)
  assert.equal(readFileSync(fence, 'utf8'), invalid)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore never downgrades a genuinely fenced but subsequently damaged current to disaster mode', () => withControlledRestore(async f => {
  f.sealCurrent()
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.equal(result.continuity, 'ordinary-verified')
  const fence = Buffer.from(readFileSync(join(f.profile, 'database-restore-fence.json')))
  writeFileSync(f.database, 'current damaged after a true controlled restore fence')
  const damaged = originals(f.database)
  let replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses, beforeReplace: async () => { replaced = true } }))
  assert.equal(replaced, false)
  assertOriginals(f.database, damaged)
  assert.deepEqual(readFileSync(join(f.profile, 'database-restore-fence.json')), fence)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore authenticates the genuine installed receipt and rejects its corruption or deletion without replacing current', async () => {
  for (const fault of ['bad-json', 'missing'] as const) await withControlledRestore(async f => {
    f.sealCurrent()
    const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
    const db = new Database(f.database), key = 'database.restore.receipt.' + result.operationId
    try {
      const receipt = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined
      assert.ok(receipt, 'The successful actual restore committed its fixed operation receipt before this negative corruption')
      if (fault === 'bad-json') db.prepare('UPDATE app_settings SET value=? WHERE key=?').run('{corrupt actual receipt', key)
      else db.prepare('DELETE FROM app_settings WHERE key=?').run(key)
    } finally { db.close() }
    const original = originals(f.database), fence = Buffer.from(readFileSync(join(f.profile, 'database-restore-fence.json')))
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses }))
    assertOriginals(f.database, original)
    assert.deepEqual(readFileSync(join(f.profile, 'database-restore-fence.json')), fence)
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  })
})

test('controlled restore allows legitimate ordinary writes after its installed fence and keeps each new replacement epoch fresh', () => withControlledRestore(async f => {
  f.sealCurrent()
  const first = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  const store = new KnowbookStore(f.database)
  try {
    const detail = store.getDocumentDetail(f.id)
    assert.ok(detail, 'The ordinary restored source opens through the real unchanged Store gate')
    store.updateDocument(f.id, { ...detail, summary: 'Legitimate later ordinary write' })
  } finally { store.destroy() }
  const second = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.equal(second.continuity, 'ordinary-verified')
  assert.notEqual(second.operationId, first.operationId)
  assert.notEqual(second.recoveryEpoch, first.recoveryEpoch)
  assert.notEqual(second.recoveryEpoch, f.sourceWorkspace.recovery_epoch)
  assert.equal(second.workspaceScope, first.workspaceScope)
  assert.deepEqual(inspect(f.database, workspace), { workspace_scope: second.workspaceScope, recovery_epoch: second.recoveryEpoch })
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore treats malformed exchange metadata in a group-free current as protected rather than empty', () => withControlledRestore(async f => {
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM synced_groups').get() as { n: number }).n, 0)
  f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('sync.webdav.protocol5.exchange.v1.' + 'a'.repeat(64), '{malformed pending sync facts', new Date().toISOString())
  const original = f.sealCurrent()
  let replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses, beforeReplace: async () => { replaced = true } }))
  assert.equal(replaced, false)
  assertOriginals(f.database, original)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore rejects a group-free ordinary candidate containing malformed pending exchange metadata instead of migrating it as empty', () => withControlledRestore(async f => {
  const source = new Database(f.backup)
  try {
    assert.equal((source.prepare('SELECT count(*) AS n FROM synced_groups').get() as { n: number }).n, 0)
    source.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('sync.webdav.protocol5.exchange.v1.' + 'b'.repeat(64), '{malformed candidate pending metadata', new Date().toISOString())
  } finally { source.close() }
  const sourceBytes = Buffer.from(readFileSync(f.backup)), original = f.sealCurrent()
  let replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses, beforeReplace: async () => { replaced = true } }))
  assert.equal(replaced, false)
  assertOriginals(f.database, original)
  assert.deepEqual(readFileSync(f.backup), sourceBytes)
}))

test('controlled restore rejects an escaping recovery parent before creating outside-profile capsule files', () => withControlledRestore(async f => {
  const original = f.sealCurrent(), outside = join(f.root, 'outside-recovery'), backups = join(f.profile, 'backups')
  assert.equal(existsSync(backups), false)
  mkdirSync(outside)
  symlinkSync(outside, backups, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses }))
  assertOriginals(f.database, original)
  assert.deepEqual(readdirSync(outside), [])
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore external fence prevents a v1 pending journal from bypassing the new installed authority', () => withControlledRestore(async f => {
  f.sealCurrent()
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  const fence = Buffer.from(readFileSync(join(f.profile, 'database-restore-fence.json'))), original = originals(f.database)
  const journal = join(f.profile, 'database-restore-pending.json')
  const old = JSON.stringify({ version: 1, id: result.operationId, phase: 'moving', originalFiles: ['knowbook.db'] })
  writeFileSync(journal, old)
  await assert.rejects(recoverInterruptedDatabaseRestore(f.profile))
  assert.equal(readFileSync(journal, 'utf8'), old)
  assertOriginals(f.database, original)
  assert.deepEqual(readFileSync(join(f.profile, 'database-restore-fence.json')), fence)
}))
