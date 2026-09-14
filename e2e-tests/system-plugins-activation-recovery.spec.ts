import { expect, test } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import { closeElectronApp, getElectronLaunchTarget, launchElectronApp, type ElectronAppContext } from './helpers/electron'

type Mode = 'throw' | 'exit' | 'loop' | 'crash'
type Attempt = { mode: string; version: string; revisionHash: string; pid: number }
const pluginId = 'system.e2e.activation-recovery'
const runFile = promisify(execFile)

for (const scenario of [
  { mode: 'throw', baseline: true }, { mode: 'exit', baseline: true },
  { mode: 'loop', baseline: true }, { mode: 'crash', baseline: true },
  { mode: 'throw', baseline: false }
] as const) {
  test(`${scenario.mode} recovers ${scenario.baseline ? 'with a known good revision' : 'on first activation'} @activation-recovery`, async ({}, testInfo) => {
    test.setTimeout(180_000)
    expect(process.platform).toBe('win32')
    expect(process.env.KNOWBOOK_E2E_EXECUTABLE, 'Run npm run test:packaged-activation-recovery.').toBeTruthy()
    const source = mkdtempSync(join(tmpdir(), 'knowbook recovery source '))
    const profile = mkdtempSync(join(tmpdir(), 'knowbook recovery 工作区 '))
    const restoreProfile = mkdtempSync(join(tmpdir(), 'knowbook recovery restored '))
    const marker = join(profile, 'system-plugins/data', pluginId, 'attempts.json')
    const snapshots: unknown[] = []
    const stages: string[] = []
    let stage = 'install'
    let failure: unknown
    let context: ElectronAppContext | null = null
    let restoreContext: ElectronAppContext | null = null
    const attempts = (): Attempt[] => existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : []
    const state = () => context!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((entry) => entry.pluginId === id) ?? null, pluginId)
    const close = async () => {
      if (context) await closeElectronApp(context, { preserveUserData: true })
      context = null
    }
    const boot = async (safeMode = false) => {
      await close()
      context = await launchElectronApp({ KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE: safeMode ? '1' : '0' }, { userDataRoot: profile })
    }
    const install = async (mode: 'good' | Mode, version: string) => {
      copyFileSync(resolve('e2e-tests/fixtures/activation-recovery/main.cjs'), join(source, 'main.cjs'))
      writeFileSync(join(source, 'fixture.json'), JSON.stringify({ mode }))
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'knowbook-activation-recovery', version, private: true }))
      writeFileSync(join(source, 'plugin.json'), JSON.stringify({
        schemaVersion: 3, trust: 'full', id: pluginId, name: 'Controlled activation recovery', version,
        publisher: 'KnowBook E2E', fullAccess: true, entries: { main: 'main.cjs' },
        riskDeclarations: ['node', 'filesystem', 'settings']
      } satisfies SystemPluginV3Manifest))
      await context!.app.evaluate(({ dialog }, directory) => {
        Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
        Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
      }, source)
      const request = await context!.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
      if (!request) throw new Error('Expected controlled plugin request.')
      const reviewed = { id: request.id, pluginId: request.pluginId, artifactSha256: request.artifactSha256 }
      await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
        requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256,
        decision: 'confirm', acknowledgeSystemAccess: true
      }), reviewed)
      return reviewed
    }
    try {
      await boot()
      snapshots.push(await context!.app.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron, arch: process.arch })))
      expect(await context!.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
      if (scenario.baseline) {
        await install('good', '1.0.0')
        expect(attempts()).toEqual([])
        await boot()
        await expect.poll(state, { timeout: 30_000 }).toMatchObject({ status: 'active', currentVersion: '1.0.0' })
        expect(await readDatabaseEvidence(context!)).toMatchObject({ sentinel: 'before-failure' })
      }
      const beforeInstall = attempts()
      const candidate = await install(scenario.mode, '2.0.0')
      const backupPath = (await state())!.backupPath!
      expect(existsSync(backupPath)).toBe(true)
      expect(attempts()).toEqual(beforeInstall)
      stages.push(stage)

      stage = 'real-failure'
      if (scenario.mode === 'throw') await boot()
      else {
        await close()
        snapshots.push(await runCrashingHost(profile, marker, scenario.mode))
        await boot()
      }
      // The window is ready before background activation and recovery finish.
      await expect.poll(state, { timeout: 30_000 }).toMatchObject({
        ...(scenario.mode === 'throw' && scenario.baseline
          ? { status: 'active', currentVersion: '1.0.0' }
          : { status: 'safe-mode-disabled', enabled: false, safeModeDisabled: true }),
        availablePackages: expect.arrayContaining([
          expect.objectContaining({ artifactSha256: candidate.artifactSha256, status: 'failed' })
        ])
      })
      const recovered = (await state())!
      expect(attempts().filter((entry) => entry.mode === scenario.mode)).toHaveLength(1)
      const recovery = await readDatabaseEvidence(context!)
      expect(recovery.sentinel).toBe(`mutated-by-${scenario.mode}`)
      expect(recovery.armedMarkers).toBe(0)
      if (scenario.mode !== 'throw') expect(recovery.audits).toContain('activation.interrupted-recovered')
      else if (scenario.baseline) expect(recovery.audits).toContain('activation.rollback')
      snapshots.push({ stage, state: recovered, recovery, attempts: attempts() })
      stages.push(stage)

      stage = 'safe-mode-zero-execution'
      const beforeSafeMode = attempts()
      await boot(true)
      expect(attempts()).toEqual(beforeSafeMode)
      expect((await state())!.runtimeStatus).toBeNull()
      snapshots.push({ stage, state: await state() })
      stages.push(stage)

      if (scenario.baseline) {
        stage = 'resume-known-good'
        if (scenario.mode !== 'throw') await context!.page.evaluate((id) => window.knowbook.setSystemPluginEnabled({ pluginId: id, enabled: true }), pluginId)
        await boot()
        await expect.poll(state, { timeout: 30_000 }).toMatchObject({ status: 'active', currentVersion: '1.0.0' })
        expect(attempts().filter((entry) => entry.mode === scenario.mode)).toHaveLength(1)
        expect(await readDatabaseEvidence(context!)).toMatchObject({ sentinel: `mutated-by-${scenario.mode}` })
        stages.push(stage)
      }

      stage = 'restore-safety-backup-to-isolated-profile'
      await close()
      mkdirSync(join(restoreProfile, 'storage'))
      copyFileSync(backupPath, join(restoreProfile, 'storage/knowbook.db'))
      restoreContext = await launchElectronApp({ KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE: '1' }, { userDataRoot: restoreProfile })
      const restored = await readDatabaseEvidence(restoreContext)
      expect(restored.integrity).toBe('ok')
      expect(restored.sentinel).toBe(scenario.baseline ? 'before-failure' : null)
      snapshots.push({ stage, backupPath, restored })
      stages.push(stage)
    } catch (error) { failure = error; throw error }
    finally {
      const cleanupErrors: string[] = []
      for (const app of [context, restoreContext]) try { if (app) await closeElectronApp(app, { preserveUserData: true }) } catch (error) { cleanupErrors.push(String(error)) }
      for (const directory of [source, profile, restoreProfile]) try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (error) { cleanupErrors.push(String(error)) }
      const evidencePath = testInfo.outputPath('activation-recovery-evidence.json')
      writeFileSync(evidencePath, JSON.stringify({ scenario, stages, snapshots, failedStage: failure ? stage : null, failure: failure ? String(failure) : null, cleanupErrors }, null, 2))
      await testInfo.attach('activation-recovery-evidence', { path: evidencePath, contentType: 'application/json' })
      if (!failure && cleanupErrors.length) throw new Error(cleanupErrors.join('\n'))
    }
  })
}

async function runCrashingHost(profile: string, marker: string, mode: Exclude<Mode, 'throw'>) {
  const target = getElectronLaunchTarget()
  const env: NodeJS.ProcessEnv = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile,
    KNOWBOOK_USER_DATA_DIR: profile, KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE: '0',
    KNOWBOOK_E2E_EPHEMERAL_CREDENTIAL_STORAGE: '1', KNOWBOOK_DISABLE_HARDWARE_ACCELERATION: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(target.executablePath!, [...target.args, '--disable-breakpad'], { cwd: target.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let closed = false
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }) })
  })
  // Attach rejection immediately so spawn failures cannot become unhandled while waiting for a marker.
  void exit.catch(() => undefined)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + String(chunk)).slice(-16_384) })
  const terminate = async () => {
    if (!closed && child.pid) await runFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }).catch(() => undefined)
  }
  try {
    await expect.poll(() => {
      if (!existsSync(marker)) return false
      return (JSON.parse(readFileSync(marker, 'utf8')) as Attempt[]).some((entry) => entry.mode === mode && entry.pid === child.pid)
    }, { timeout: 20_000 }).toBe(true)
    if (mode === 'loop') {
      expect(closed).toBe(false)
      await terminate()
    }
    await expect.poll(() => closed, { timeout: 20_000 }).toBe(true)
    const result = await exit
    // The fixture proves it reached process.exit(41) through its PID marker.
    // Electron may abort V8 while tearing down in-flight module work, yielding
    // a different nonzero code. Both must exercise the same startup recovery.
    if (mode === 'exit') {
      expect(result.code, output).not.toBeNull()
      expect(result.code, output).not.toBe(0)
    }
    if (mode === 'crash') expect(result.code).not.toBe(0)
    return { mode, pid: child.pid, ...result, requestedExitCode: mode === 'exit' ? 41 : null,
      externallyTerminated: mode === 'loop', output }
  } finally {
    await terminate()
    await expect.poll(() => closed, { timeout: 15_000 }).toBe(true)
  }
}

async function readDatabaseEvidence(context: ElectronAppContext) {
  return context.app.evaluate(({ app }, pluginId) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'storage/knowbook.db'), { readonly: true })
    try {
      return {
        integrity: db.pragma('integrity_check', { simple: true }) as string,
        sentinel: (db.prepare('SELECT value FROM app_settings WHERE key = ?').get('system.e2e.recovery.sentinel') as { value: string } | undefined)?.value ?? null,
        audits: (db.prepare('SELECT action FROM system_plugin_audit WHERE plugin_id = ? ORDER BY created_at, rowid').all(pluginId) as { action: string }[]).map((entry) => entry.action),
        armedMarkers: (db.prepare("SELECT count(*) AS count FROM system_plugin_crash_markers WHERE plugin_id = ? AND state = 'armed'").get(pluginId) as { count: number }).count
      }
    } finally { db.close() }
  }, pluginId)
}
