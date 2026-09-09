import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { KnowbookStore } from '../src/main/database/store'
import { parseDatabaseRestoreArgument, recoverInterruptedDatabaseRestore, restoreKnowbookDatabase } from '../src/main/database/restore-maintenance'
import { listWindowsRestoreProcesses, stopDatabaseRestoreProcesses, type RestoreProcessIdentity, type RestoreObservedProcess } from '../src/main/database/restore-process-guard'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const noProcesses = async () => []
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
async function fixture(run: (root: string, backup: string, database: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook restore 测试 '))
  try {
    const backup = join(root, 'source.db')
    const store = new KnowbookStore(backup)
    try {
      const documentId = store.createDocument(null)
      store.updateDocument(documentId, { title: '恢复前安全文档', summary: '', blocks: [] })
      store.pluginPlatform.createSystemPluginInstallation({ pluginId: 'system.restore', status: 'disabled', enabled: true, autoStart: true })
    } finally { store.destroy() }
    mkdirSync(join(root, 'profile', 'storage'), { recursive: true })
    await run(root, backup, join(root, 'profile', 'storage', 'knowbook.db'))
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('database restore arguments reject relative, duplicate, malformed and conflicting maintenance commands', () => {
  const path = resolve('备份 空格.db')
  assert.equal(parseDatabaseRestoreArgument([]), null)
  assert.equal(parseDatabaseRestoreArgument([`--knowbook-restore-database=${path}`]), path)
  for (const args of [ ['--knowbook-restore-database=relative.db'], ['--knowbook-restore-database'],
    [`--knowbook-restore-database=${path}`, `--knowbook-restore-database=${path}`],
    [`--knowbook-restore-database=${path}`, '--knowbook-uninstall-cleanup'] ]) assert.throws(() => parseDatabaseRestoreArgument(args))
})

test('restore accepts a damaged current database, preserves DB/WAL/SHM, and disables restored Full Trust without changing source', async () => {
  await fixture(async (root, backup, database) => {
    const original = { 'knowbook.db': 'damaged SQLite', 'knowbook.db-wal': 'original WAL', 'knowbook.db-shm': 'original SHM' }
    for (const [file, content] of Object.entries(original)) writeFileSync(join(root, 'profile', 'storage', file), content)
    const sourceHash = hash(backup)
    let inspected = false
    const result = await restoreKnowbookDatabase({ userDataRoot: join(root, 'profile'), backupPath: backup,
      stopProcesses: async (input) => { inspected = true; assert.deepEqual(input.identities, []); return [] } })
    assert.equal(inspected, true)
    assert.equal(hash(backup), sourceHash)
    assert.equal(result.sourceSha256, sourceHash)
    for (const [file, content] of Object.entries(original)) assert.equal(readFileSync(join(result.recoveryDirectory, 'original', file), 'utf8'), content)
    assert.equal(existsSync(`${database}-wal`), false)
    assert.equal(existsSync(`${database}-shm`), false)
    assert.equal(await recoverInterruptedDatabaseRestore(join(root, 'profile')), true)
    const db = new Database(database, { readonly: true })
    try {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
      assert.deepEqual(db.prepare('SELECT enabled,auto_start,safe_mode_disabled,status FROM system_plugin_installations').get(),
        { enabled: 0, auto_start: 0, safe_mode_disabled: 1, status: 'safe-mode-disabled' })
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM documents WHERE title=?').get('恢复前安全文档') as { count: number }).count, 1)
    } finally { db.close() }
  })
})

test('invalid backup content, future schema, missing KnowBook tables, and active WAL never replace current DB', async () => {
  for (const mode of ['corrupt', 'future', 'wrong-schema', 'wal']) await fixture(async (root, backup, database) => {
    writeFileSync(database, 'keep original')
    if (mode === 'corrupt') writeFileSync(backup, 'not a database')
    else if (mode === 'wal') writeFileSync(`${backup}-wal`, 'active WAL')
    else {
      const db = new Database(backup)
      if (mode === 'future') db.pragma('user_version=999')
      else db.exec('DROP TABLE app_settings')
      db.close()
    }
    const originalHash = hash(backup)
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: join(root, 'profile'), backupPath: backup, stopProcesses: noProcesses }))
    assert.equal(readFileSync(database, 'utf8'), 'keep original')
    assert.equal(hash(backup), originalHash)
  })
})

test('replacement error rolls back the exact original DB/WAL/SHM bytes', async () => {
  await fixture(async (root, backup, database) => {
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(`${database}${suffix}`, `original${suffix}`)
    let reachedReplacement = false
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: join(root, 'profile'), backupPath: backup, stopProcesses: noProcesses,
      beforeReplace: async () => { reachedReplacement = true; throw new Error('controlled filesystem replacement failure') } }), /controlled filesystem replacement failure/)
    assert.equal(reachedReplacement, true)
    for (const suffix of ['', '-wal', '-shm']) assert.equal(readFileSync(`${database}${suffix}`, 'utf8'), `original${suffix}`)
    assert.equal(existsSync(join(root, 'profile', 'database-restore-pending.json')), false)
    assert.equal(await recoverInterruptedDatabaseRestore(join(root, 'profile')), false)
  })
})

test('startup rolls back a durable interrupted move before opening SQLite and rejects tampered journal paths', async () => {
  await fixture(async (root, _backup, database) => {
    const profile = join(root, 'profile')
    const id = randomUUID()
    const original = join(profile, 'backups', 'database-restore', id, 'original')
    mkdirSync(original, { recursive: true })
    writeFileSync(database, 'original damaged DB')
    renameSync(database, join(original, 'knowbook.db'))
    writeFileSync(database, 'partially installed candidate')
    writeFileSync(join(profile, 'database-restore-pending.json'), JSON.stringify({ version: 1, id, phase: 'moving', originalFiles: ['knowbook.db'] }))
    assert.equal(await recoverInterruptedDatabaseRestore(profile), false)
    assert.equal(readFileSync(database, 'utf8'), 'original damaged DB')
    writeFileSync(join(profile, 'database-restore-pending.json'), JSON.stringify({ version: 1, id: '../escape', phase: 'moving', originalFiles: ['knowbook.db'] }))
    await assert.rejects(recoverInterruptedDatabaseRestore(profile), /日志无效/)
    assert.equal(readFileSync(database, 'utf8'), 'original damaged DB')
  })
})

test('missing original and target leaves the recovery journal intact instead of creating an empty database', async () => {
  await fixture(async (root) => {
    const profile = join(root, 'profile')
    const journal = join(profile, 'database-restore-pending.json')
    writeFileSync(journal, JSON.stringify({ version: 1, id: randomUUID(), phase: 'moving', originalFiles: ['knowbook.db'] }))
    await assert.rejects(recoverInterruptedDatabaseRestore(profile), /均不存在/)
    assert.equal(existsSync(journal), true)
    assert.equal(existsSync(join(profile, 'storage', 'knowbook.db')), false)
  })
})

test('an invalid committed candidate rolls back the original, quarantines new WAL and permits a fresh restore', async () => {
  for (const missing of [false, true]) await fixture(async (root, backup, database) => {
    const profile = join(root, 'profile')
    const id = randomUUID()
    const recovery = join(profile, 'backups', 'database-restore', id)
    const original = join(recovery, 'original')
    mkdirSync(original, { recursive: true })
    copyFileSync(backup, join(original, 'knowbook.db'))
    if (!missing) writeFileSync(database, 'corrupt committed candidate')
    writeFileSync(`${database}-wal`, 'rejected candidate WAL')
    writeFileSync(`${database}-shm`, 'rejected candidate SHM')
    writeFileSync(join(profile, 'database-restore-pending.json'), JSON.stringify({ version: 1, id, phase: 'installed', originalFiles: ['knowbook.db'] }))
    assert.equal(await recoverInterruptedDatabaseRestore(profile), true)
    assert.equal(hash(database), hash(backup))
    assert.equal(existsSync(`${database}-wal`), false)
    assert.equal(existsSync(`${database}-shm`), false)
    assert.ok(readdirSync(recovery).some(name => name.startsWith('rejected-knowbook.db-wal-')))
    assert.equal(JSON.parse(readFileSync(join(recovery, 'result.json'), 'utf8')).status, 'rolled-back')
    assert.equal(existsSync(join(profile, 'database-restore-pending.json')), false)
    const result = await restoreKnowbookDatabase({ userDataRoot: profile, backupPath: backup, stopProcesses: noProcesses })
    assert.equal(result.sourceSha256, hash(backup))
  })
})

test('invalid committed candidate with an incomplete original archive preserves both candidate and journal', async () => {
  await fixture(async (root, _backup, database) => {
    const profile = join(root, 'profile')
    const journal = join(profile, 'database-restore-pending.json')
    writeFileSync(database, 'preserve candidate for manual recovery')
    writeFileSync(journal, JSON.stringify({ version: 1, id: randomUUID(), phase: 'installed', originalFiles: ['knowbook.db'] }))
    await assert.rejects(recoverInterruptedDatabaseRestore(profile), /原始文件不完整/)
    assert.equal(existsSync(journal), true)
    assert.equal(readFileSync(database, 'utf8'), 'preserve candidate for manual recovery')
  })
})

test('restore rejects an escaping parent junction before creating a directory outside the profile', async () => {
  await fixture(async (root, backup) => {
    const profile = join(root, 'profile')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(profile, 'backups'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: profile, backupPath: backup, stopProcesses: noProcesses }), /目录指向/)
    assert.equal(existsSync(join(outside, 'database-restore')), false)
  })
})

test('process guard stops only exact live persisted identity and refuses unknown profile services', async () => {
  const profile = resolve('fixture', 'restore-profile')
  const expected: RestoreProcessIdentity = { pid: 8123, executable: resolve('KnowBook.exe'), startToken: 'windows:123', serviceEntry: join(profile, 'system-plugins', 'runtime', 'plugin', 'hash', 'service.cjs') }
  const observed: RestoreObservedProcess = { ...expected, argv: [expected.executable, '-e', 'bootstrap', expected.serviceEntry] }
  let running = true
  assert.deepEqual(await stopDatabaseRestoreProcesses({ userDataRoot: profile, identities: [expected],
    list: async () => running ? [observed] : [], terminate: (pid) => { assert.equal(pid, expected.pid); running = false } }), [8123])
  await assert.rejects(stopDatabaseRestoreProcesses({ userDataRoot: profile, identities: [], list: async () => [observed], terminate: () => assert.fail('unverified process must not be killed') }), /身份无法核验/)
  await assert.rejects(stopDatabaseRestoreProcesses({ userDataRoot: profile, identities: [{ ...expected, startToken: 'windows:old' }], list: async () => [observed] }), /身份无法核验/)
  assert.deepEqual(await stopDatabaseRestoreProcesses({ userDataRoot: profile, identities: [expected],
    list: async () => [{ ...observed, startToken: 'windows:reused', argv: [expected.executable, resolve('other-script.cjs')] }], terminate: () => assert.fail('reused PID must not be killed') }), [])
})

test('Windows process guard observes real creation token and waits for an owned Electron Node process to exit', { skip: process.platform !== 'win32' }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'knowbook restore process '))
  const serviceEntry = join(profile, 'system-plugins', 'runtime', 'fixture', 'revision', 'service.cjs')
  mkdirSync(join(serviceEntry, '..'), { recursive: true })
  writeFileSync(serviceEntry, 'setInterval(() => {}, 1000)')
  const child = spawn(process.execPath, [serviceEntry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore' })
  const ended = new Promise<void>((resolvePromise, reject) => { child.once('exit', () => resolvePromise()); child.once('error', reject) })
  try {
    const observed = (await listWindowsRestoreProcesses()).find((item) => item.pid === child.pid)
    assert.ok(observed?.executable)
    assert.ok(observed.argv?.includes(serviceEntry))
    const result = await stopDatabaseRestoreProcesses({ userDataRoot: profile, identities: [{
      pid: child.pid!, executable: observed.executable, startToken: observed.startToken, serviceEntry
    }] })
    assert.deepEqual(result, [child.pid])
    await ended
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
    rmSync(profile, { recursive: true, force: true })
  }
})

test('unreadable Windows exit snapshots are rechecked while a live unknown host still blocks restore', async () => {
  const userDataRoot = resolve('fixture', 'restore-snapshot-profile')
  const unknown: RestoreObservedProcess = { pid: 41076, name: 'electron.exe', executable: null, argv: null, startToken: 'windows:exiting' }
  let queries = 0
  const stopped = await stopDatabaseRestoreProcesses({ userDataRoot, identities: [],
    list: async () => ++queries === 1 ? [unknown] : [],
    terminate: () => assert.fail('unverified process must not be killed') })
  assert.deepEqual(stopped, [])
  assert.ok(queries >= 2, 'a fresh process query must confirm absence')
  queries = 0
  await assert.rejects(stopDatabaseRestoreProcesses({ userDataRoot, identities: [],
    list: async () => { queries++; return [unknown] },
    terminate: () => assert.fail('unverified process must not be killed') }), /无法读取后台进程/)
  assert.equal(queries, 2)
  queries = 0
  assert.deepEqual(await stopDatabaseRestoreProcesses({ userDataRoot, identities: [],
    list: async () => ++queries === 1 ? [unknown] : [{ ...unknown, executable: resolve('electron.exe'), argv: [resolve('electron.exe'), resolve('unrelated.cjs')] }],
    terminate: () => assert.fail('unrelated process must not be killed') }), [])
})
