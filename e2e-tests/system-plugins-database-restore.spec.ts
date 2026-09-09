import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

test('SQLite maintenance stops verified detached service, restores damaged DB, and boots safely @database-restore', async ({}, testInfo) => {
  test.setTimeout(240_000)
  expect(process.platform).toBe('win32')
  const executable = process.env.KNOWBOOK_E2E_EXECUTABLE!
  expect(executable, 'Run npm run test:packaged-database-restore.').toBeTruthy()
  const root = mkdtempSync(join(tmpdir(), 'knowbook database recovery '))
  const source = join(root, 'source')
  const profile = join(root, '工作区 空格')
  const backup = join(root, 'safe backup.db')
  const pluginId = 'system.e2e.database-restore'
  const data = join(profile, 'system-plugins', 'data', pluginId)
  const callsPath = join(data, 'calls.json')
  const servicePath = join(data, 'service-state.json')
  let context: ElectronAppContext | null = null
  let pid: number | null = null
  let failure: unknown
  let stage = 'install-detached-plugin'
  const stages: string[] = []
  const snapshots: unknown[] = []
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const boot = async () => { context = await launchElectronApp({}, { userDataRoot: profile }) }
  const close = async () => { await closeElectronApp(context, { preserveUserData: true }); context = null }
  const state = () => context!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((plugin) => plugin.pluginId === id), pluginId)
  const sentinel = () => context!.app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true })
    try { return db.prepare('SELECT value FROM app_settings WHERE key=?').get('restore.e2e.sentinel')?.value } finally { db.close() }
  })
  try {
    cpSync(resolve('e2e-tests/fixtures/windows-startup'), source, { recursive: true })
    writeFileSync(join(source, 'main.cjs'), `const fs=require('node:fs'),path=require('node:path'); module.exports.activate=ctx=>{const file=path.join(ctx.plugin.dataRoot,'calls.json');const calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];calls.push('activate');fs.writeFileSync(file,JSON.stringify(calls))}`)
    writeFileSync(join(source, 'renderer.cjs'), `module.exports=()=>{document.documentElement.setAttribute('data-restore-renderer','loaded');return ()=>document.documentElement.removeAttribute('data-restore-renderer')}`)
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ schemaVersion: 3, trust: 'full', id: pluginId,
      name: 'Database restore acceptance', version: '1.0.0', publisher: 'KnowBook E2E', entries: { main: 'main.cjs', renderer: 'renderer.cjs', service: 'service.cjs' },
      fullAccess: true, riskDeclarations: ['node', 'filesystem', 'renderer', 'background-service'], background: { mode: 'detached', autoStart: true } }))
    await boot()
    expect(await context!.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await context!.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0 }) })
    }, source)
    const request = await context!.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    if (!request) throw new Error('Missing plugin request.')
    await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
      requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256, decision: 'confirm', acknowledgeSystemAccess: true
    }), { id: request.id, pluginId, artifactSha256: request.artifactSha256 })
    await close(); await boot()
    await expect.poll(async () => (await state())?.status).toBe('active')
    expect(await context!.page.evaluate(() => document.documentElement.getAttribute('data-restore-renderer'))).toBe('loaded')
    await expect.poll(() => existsSync(servicePath) ? JSON.parse(readFileSync(servicePath, 'utf8')).successes : 0).toBeGreaterThan(0)
    pid = JSON.parse(readFileSync(servicePath, 'utf8')).pid
    const backupRuns = await context!.app.evaluate(async ({ app }, destination) => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const { join } = process.getBuiltinModule('node:path')
      const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
      const db = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'))
      try {
        const main = db.prepare("SELECT * FROM system_plugin_runs WHERE component='main' AND status='ready' LIMIT 1").get()
        if (!main) throw new Error('Main ready run was not recorded.')
        db.prepare(`INSERT INTO system_plugin_runs (
          id, plugin_id, installation_id, package_id, component, status, pid, restart_count,
          error_json, log_path, started_at, stopped_at, updated_at
        ) VALUES (?, ?, ?, ?, 'main', 'failed', ?, 0, ?, ?, ?, ?, ?)`).run(
          'restore.e2e.old-failure', main.plugin_id, main.installation_id, main.package_id, main.pid,
          JSON.stringify({ stage: 'activate', message: '旧候选失败诊断（已脱敏）' }), main.log_path,
          main.started_at, main.started_at, main.started_at
        )
        const runs = db.prepare("SELECT id, package_id AS packageId, component, status, pid, error_json AS errorJson, log_path AS logPath FROM system_plugin_runs WHERE component IN ('main','renderer')").all()
        db.prepare('INSERT OR REPLACE INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('restore.e2e.sentinel', 'healthy backup', new Date().toISOString())
        await db.backup(destination)
        db.prepare('UPDATE app_settings SET value=? WHERE key=?').run('changed after backup', 'restore.e2e.sentinel')
        return runs as Array<{ id: string; packageId: string; component: string; status: string; pid: number | null; errorJson: string | null; logPath: string | null }>
      } finally { db.close() }
    }, backup)
    expect(backupRuns.filter((run) => run.status === 'ready').map((run) => run.component).sort()).toEqual(['main', 'renderer'])
    const assertRetiredHostRuns = async () => {
      const plugin = await state()
      expect(plugin?.runtimeStatus).toBeNull()
      for (const before of backupRuns) {
        const after = plugin?.recentRuns.find((run) => run.id === before.id)
        expect(after).toBeTruthy()
        expect(after?.status).toBe(before.status === 'failed' ? 'failed' : 'stopped')
        expect(after?.pid).toBeNull()
        expect(after?.packageId).toBe(before.packageId)
        expect(after?.logPath).toBe(before.logPath)
        expect(after?.error).toEqual(before.errorJson ? JSON.parse(before.errorJson) : null)
      }
      expect(await context!.page.evaluate(() => document.documentElement.getAttribute('data-restore-renderer'))).toBeNull()
      return plugin
    }
    expect(await sentinel()).toBe('changed after backup')
    const sourceHash = hash(backup)
    const calls = readFileSync(callsPath, 'utf8')
    stages.push(stage)

    stage = 'restore-stops-verified-live-detached'
    await close()
    expect(alive(pid!)).toBe(true)
    await maintenance(executable, profile, backup)
    expect(alive(pid!)).toBe(false)
    const restored = JSON.parse(readFileSync(join(profile, 'database-restore-result.json'), 'utf8'))
    expect(restored).toMatchObject({ status: 'restored', sourceSha256: sourceHash, stoppedPids: [pid] })
    expect(existsSync(join(restored.recoveryDirectory, 'original', 'knowbook.db'))).toBe(true)
    expect(hash(backup)).toBe(sourceHash)
    expect(readFileSync(callsPath, 'utf8')).toBe(calls)
    snapshots.push({ stage, restored })
    stages.push(stage)

    stage = 'restored-database-safe-startup'
    await boot()
    expect(await sentinel()).toBe('healthy backup')
    expect((await state())?.safeModeDisabled).toBe(true)
    expect((await state())?.enabled).toBe(false)
    await expect.poll(() => existsSync(join(profile, 'database-restore-safe-mode.json'))).toBe(false)
    expect(readFileSync(callsPath, 'utf8')).toBe(calls)
    expect(alive(pid!)).toBe(false)
    snapshots.push({ stage, backupRuns, plugin: await assertRetiredHostRuns() })
    stages.push(stage)

    stage = 'corrupt-current-database-still-recovers'
    await close()
    const database = join(profile, 'storage', 'knowbook.db')
    const corrupted = Buffer.from('controlled corrupt KnowBook database')
    writeFileSync(database, corrupted)
    await maintenance(executable, profile, backup)
    const recovered = JSON.parse(readFileSync(join(profile, 'database-restore-result.json'), 'utf8'))
    expect(recovered).toMatchObject({ status: 'restored', stoppedPids: [] })
    expect(readFileSync(join(recovered.recoveryDirectory, 'original', 'knowbook.db'))).toEqual(corrupted)
    expect(hash(backup)).toBe(sourceHash)
    await boot()
    expect(await sentinel()).toBe('healthy backup')
    await expect.poll(() => existsSync(join(profile, 'database-restore-safe-mode.json'))).toBe(false)
    expect(readFileSync(callsPath, 'utf8')).toBe(calls)
    expect((await state())?.enabled).toBe(false)
    snapshots.push({ stage, recovered, plugin: await assertRetiredHostRuns() })
    stages.push(stage)
  } catch (error) { failure = error; throw error }
  finally {
    const cleanupErrors: string[] = []
    try { await close() } catch (error) { cleanupErrors.push(String(error)) }
    if (pid && alive(pid)) {
      try { writeFileSync(join(data, 'stop-fixture'), 'stop'); await expect.poll(() => alive(pid!)).toBe(false) } catch (error) { cleanupErrors.push(String(error)) }
    }
    if (!cleanupErrors.length) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    const evidence = testInfo.outputPath('database-restore-evidence.json')
    writeFileSync(evidence, JSON.stringify({ stages, snapshots, failedStage: failure ? stage : null, failure: failure ? String(failure) : null, cleanupErrors }, null, 2))
    await testInfo.attach('database-restore-evidence', { path: evidence, contentType: 'application/json' })
    if (!failure && cleanupErrors.length) throw new Error(cleanupErrors.join('\n'))
  }
})

function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }
async function maintenance(executable: string, profile: string, backup: string): Promise<void> {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.KNOWBOOK_USER_DATA_DIR
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, [`--knowbook-user-data-dir=${profile}`, `--knowbook-restore-database=${backup}`, '--no-sandbox', '--disable-gpu'],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      const report = join(profile, 'database-restore-result.json')
      reject(new Error(`Database restore maintenance timed out. ${existsSync(report) ? readFileSync(report, 'utf8') : output}`))
    }, 60_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolvePromise() : reject(new Error(`Restore exited ${code}: ${output}`)) })
  })
}
