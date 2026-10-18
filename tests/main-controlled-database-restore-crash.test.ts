import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withControlledRestore, assertOriginals, inspect, workspace, digest } from './helpers/controlled-restore-fixture'

const worker = fileURLToPath(new URL('./helpers/controlled-restore-crash-worker.mjs', import.meta.url))
async function child(profile: string, backup: string, mode: string, transcript: string) {
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', worker, resolve('.'), profile, backup, mode, transcript], {
    env: { ...globalThis.process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '', stderr = '', failed: Error | undefined
  process.stdout?.on('data', bytes => { stdout += bytes.toString() }); process.stderr?.on('data', bytes => { stderr += bytes.toString() })
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(settle => {
    process.once('error', error => { failed = error; settle({ code: null, signal: null }) })
    process.once('close', (code, signal) => settle({ code, signal }))
  })
  const timer = setTimeout(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL') }, 20000)
  try {
    const result = await ended
    writeFileSync(transcript + '.stdio.json', JSON.stringify({ ...result, error: failed?.message ?? null, stdout, stderr }, null, 2) + '\n')
    assert.equal(failed, undefined, 'The hidden genuine Electron Node child started successfully')
    assert.equal(result.signal, null, 'The real controlled restore child completes before its bounded cleanup deadline: ' + stderr.slice(-1500))
    return result.code
  } finally {
    clearTimeout(timer)
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
    await ended
  }
}

test('controlled restore fresh process completes a genuine prepared-fence interruption without forgetting its original raw current authority', () => withControlledRestore(async f => {
  const original = f.sealCurrent(), interrupted = join(f.root, 'prepared.json')
  assert.equal(await child(f.profile, f.backup, 'prepared', interrupted), 75)
  const evidence = JSON.parse(readFileSync(interrupted, 'utf8')) as { interrupted: boolean; actual: { phase: string } }
  assert.equal(evidence.interrupted, true); assert.equal(evidence.actual.phase, 'prepared')
  assertOriginals(f.database, original)
  assert.equal(await child(f.profile, f.backup, 'recover', join(f.root, 'recover-prepared.json')), 0)
  assertOriginals(f.database, original)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  assert.equal(existsSync(join(f.profile, 'database-restore-fence.json')), true)
}))

test('controlled restore fresh process rolls back the real beforeReplace crash with exact original DB WAL SHM and no source mutation', () => withControlledRestore(async f => {
  const original = f.sealCurrent(), interrupted = join(f.root, 'moving.json')
  assert.equal(await child(f.profile, f.backup, 'moving', interrupted), 73)
  const evidence = JSON.parse(readFileSync(interrupted, 'utf8')) as { actual: { version: number; operationId: string; phase: string } }
  assert.equal(evidence.actual.version, 2); assert.equal(evidence.actual.phase, 'moving')
  const originalDirectory = join(f.profile, 'backups/database-restore', evidence.actual.operationId, 'original')
  for (const file of original) assert.deepEqual(readFileSync(join(originalDirectory, file.name)), file.bytes)
  assert.equal(await child(f.profile, f.backup, 'recover', join(f.root, 'recover-moving.json')), 0)
  assertOriginals(f.database, original)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
}))

test('controlled restore fresh process finishes the exact installed epoch receipt after a real installed-journal crash instead of rolling back or reminting', () => withControlledRestore(async f => {
  f.sealCurrent()
  assert.equal(await child(f.profile, f.backup, 'installed', join(f.root, 'installed.json')), 74)
  const journal = JSON.parse(readFileSync(join(f.profile, 'database-restore-pending.json'), 'utf8')) as { operationId: string; phase: string }
  assert.equal(journal.phase, 'installed')
  const receipt = inspect(f.database, db => db.prepare('SELECT value FROM app_settings WHERE key=?').get('database.restore.receipt.' + journal.operationId) as { value: string } | undefined)
  assert.ok(receipt, 'The interrupted real installed candidate already owns its original operation receipt')
  const epoch = inspect(f.database, workspace), installed = digest(readFileSync(f.database))
  assert.notEqual(epoch.recovery_epoch, f.sourceWorkspace.recovery_epoch)
  assert.equal(await child(f.profile, f.backup, 'recover', join(f.root, 'recover-installed.json')), 0)
  assert.equal(await child(f.profile, f.backup, 'recover', join(f.root, 'recover-installed-again.json')), 0)
  assert.deepEqual(inspect(f.database, workspace), epoch)
  assert.equal(inspect(f.database, db => (db.prepare('SELECT value FROM app_settings WHERE key=?').get('database.restore.receipt.' + journal.operationId) as { value: string }).value), receipt.value)
  assert.equal(digest(readFileSync(f.database)), installed)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
}))
