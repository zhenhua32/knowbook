import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginId = 'system.e2e.dependency-scripts'
type Job = { kind: string; status: string; exitCode: number | null; command: string[]; logPath: string }
type Activation = { answer: number; label: string; revisionHash: string; events: string[] }

test('executes reviewed install and build scripts and preserves the active plugin on either failure @dependency-scripts', async ({}, testInfo) => {
  test.setTimeout(240_000)
  expect(process.platform).toBe('win32')
  expect(process.env.KNOWBOOK_E2E_EXECUTABLE, 'Run npm run test:packaged-dependency-scripts.').toBeTruthy()
  const source = mkdtempSync(join(tmpdir(), 'knowbook scripts source '))
  const profile = mkdtempSync(join(tmpdir(), 'knowbook scripts 工作区 '))
  const historyPath = join(profile, 'system-plugins', 'data', pluginId, 'scripts-history.json')
  const completedStages: string[] = []
  const snapshots: unknown[] = []
  const logs: string[] = []
  const publishedHashes: string[] = []
  let context: ElectronAppContext | null = null
  let stage = 'cancel-without-executing-scripts'
  let failure: unknown
  const history = () => JSON.parse(readFileSync(historyPath, 'utf8')) as Activation[]
  const state = () => context!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === id) ?? null, pluginId)
  const boot = async () => {
    if (context) await closeElectronApp(context, { preserveUserData: true })
    context = null
    context = await launchElectronApp({}, { userDataRoot: profile })
    await context.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
    }, source)
  }
  const prepare = async (version: string, allowScripts: boolean, failure: 'install' | 'build' | null = null) => {
    writeFileSync(join(source, 'fixture.json'), JSON.stringify({ label: version, allowScripts, failure }))
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({
      schemaVersion: 3, trust: 'full', id: pluginId, name: 'Dependency scripts acceptance', version,
      publisher: 'KnowBook E2E', entries: { main: 'main.cjs' }, fullAccess: true,
      riskDeclarations: ['node', 'npm', 'filesystem', 'subprocess'],
      dependencies: {
        packageManager: 'npm', install: 'ci', allowScripts, rebuildNativeModules: false,
        buildCommand: allowScripts ? ['npm', 'run', 'build'] : ['node', 'build.cjs']
      }
    } satisfies SystemPluginV3Manifest, null, 2))
    const request = await context!.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    if (!request) throw new Error('Expected a dependency-script review.')
    expect(request.status).toBe('awaiting-confirmation')
    expect(existsSync(join(source, 'events.json'))).toBe(false)
    expect(existsSync(join(source, 'generated.cjs'))).toBe(false)
    const staging = join(profile, 'system-plugins', 'staging', request.id)
    expect(existsSync(join(staging, 'events.json'))).toBe(false)
    expect(existsSync(join(staging, 'generated.cjs'))).toBe(false)
    return { id: request.id, pluginId: request.pluginId, artifactSha256: request.artifactSha256 }
  }
  const confirm = (request: { id: string; pluginId: string; artifactSha256: string }) => context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
    requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256,
    decision: 'confirm', acknowledgeSystemAccess: true
  }), request)
  const jobsFor = async (hash: string) => {
    const jobs = await readJobs(context!, hash)
    if (jobs[0]?.logPath) logs.push(readFileSync(jobs[0].logPath, 'utf8'))
    snapshots.push({ stage, hash, jobs })
    return jobs
  }
  try {
    cpSync(join(root, 'e2e-tests', 'fixtures', 'dependency-scripts'), source, { recursive: true })
    writeFileSync(join(source, '.npmrc'), 'offline=true\naudit=false\nfund=false\nforeground-scripts=true\n')
    await boot()
    const host = await context!.app.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron, platform: process.platform, arch: process.arch }))
    expect(host.packaged).toBe(true)
    snapshots.push({ host })
    const cancelled = await prepare('0.0.1', true)
    expect(await state()).toBeNull()
    await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
      requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256,
      decision: 'cancel', acknowledgeSystemAccess: false
    }), cancelled)
    expect(await state()).toBeNull()
    expect(existsSync(historyPath)).toBe(false)
    expect(existsSync(join(profile, 'system-plugins', 'artifacts', pluginId, cancelled.artifactSha256))).toBe(false)
    completedStages.push(stage)

    for (const config of [{ version: '1.0.0', scripts: false }, { version: '2.0.0', scripts: true }]) {
      stage = config.scripts ? 'allow-install-lifecycles-and-npm-build' : 'skip-install-lifecycles-and-run-explicit-build'
      const prepared = await prepare(config.version, config.scripts)
      publishedHashes.push(prepared.artifactSha256)
      await confirm(prepared)
      const jobs = await jobsFor(prepared.artifactSha256)
      expect(jobs.map((job) => ({ kind: job.kind, status: job.status, exitCode: job.exitCode }))).toEqual([
        { kind: 'install', status: 'succeeded', exitCode: 0 }, { kind: 'build', status: 'succeeded', exitCode: 0 }
      ])
      expect(jobs[0].command.includes('--ignore-scripts')).toBe(!config.scripts)
      expect(jobs[1].command).toEqual(config.scripts ? ['npm', 'run', 'build'] : ['node', 'build.cjs'])
      const expectedEvents = config.scripts ? ['preinstall', 'install', 'postinstall', 'prebuild', 'build', 'postbuild'] : ['build']
      const artifact = join(profile, 'system-plugins', 'artifacts', pluginId, prepared.artifactSha256)
      const runtime = join(profile, 'system-plugins', 'runtime', pluginId, prepared.artifactSha256)
      expect(existsSync(join(artifact, 'generated.cjs'))).toBe(false)
      expect(existsSync(join(artifact, 'events.json'))).toBe(false)
      expect(hashFile(join(artifact, 'build.cjs'))).toBe(hashFile(join(source, 'build.cjs')))
      expect(JSON.parse(readFileSync(join(runtime, 'events.json'), 'utf8'))).toEqual(expectedEvents)
      expect(logs.at(-1)).toContain('KNOWBOOK_PHASE_build')
      if (!config.scripts) expect(logs.at(-1)).not.toContain('KNOWBOOK_PHASE_install')
      expect((await state())?.status).toBe('pending-restart')
      await boot()
      await expect.poll(async () => (await state())?.status).toBe('active')
      expect(history().at(-1)).toEqual({ answer: 42, label: config.version, revisionHash: `sha256:${prepared.artifactSha256}`, events: expectedEvents })
      snapshots.push({ stage, history: history() })
      completedStages.push(stage)
    }

    const active = (await state())!
    const stableHistory = history()
    for (const kind of ['install', 'build'] as const) {
      stage = `${kind}-failure-preserves-active-revision`
      const rejected = await prepare(kind === 'install' ? '3.0.0' : '4.0.0', true, kind)
      publishedHashes.push(rejected.artifactSha256)
      await expect(confirm(rejected)).rejects.toThrow(/dependency command/i)
      expect(await state()).toMatchObject({ status: 'active', currentVersion: '2.0.0', currentArtifactSha256: active.currentArtifactSha256 })
      expect(history()).toEqual(stableHistory)
      const jobs = await jobsFor(rejected.artifactSha256)
      expect(jobs.map((job) => ({ kind: job.kind, status: job.status, exitCode: job.exitCode }))).toEqual(kind === 'install' ? [
        { kind: 'install', status: 'failed', exitCode: 17 }, { kind: 'build', status: 'cancelled', exitCode: null }
      ] : [
        { kind: 'install', status: 'succeeded', exitCode: 0 }, { kind: 'build', status: 'failed', exitCode: 23 }
      ])
      expect(logs.at(-1)).toContain(`KNOWBOOK_CONTROLLED_${kind.toUpperCase()}_FAILURE`)
      expect(logs.at(-1)).not.toContain(kind === 'install' ? 'KNOWBOOK_PHASE_build' : 'KNOWBOOK_PHASE_postbuild')
      expect(existsSync(join(profile, 'system-plugins', 'runtime', pluginId, rejected.artifactSha256))).toBe(false)
      expect(readdirSync(join(profile, 'system-plugins', 'runtime', pluginId)).some((entry) => entry.startsWith('.preparing-'))).toBe(false)
      completedStages.push(stage)
    }
    stage = 'restart-after-failures-and-uninstall'
    await boot()
    await expect.poll(state).toMatchObject({ status: 'active', currentVersion: '2.0.0', currentArtifactSha256: active.currentArtifactSha256 })
    expect(history().map((item) => item.label)).toEqual(['1.0.0', '2.0.0', '2.0.0'])
    await context!.page.evaluate((id) => window.knowbook.uninstallSystemPlugin({ pluginId: id }), pluginId)
    await boot()
    await expect.poll(state, { timeout: 30_000 }).toBeNull()
    for (const hash of publishedHashes) for (const directory of ['artifacts', 'runtime']) {
      expect(existsSync(join(profile, 'system-plugins', directory, pluginId, hash))).toBe(false)
    }
    for (const directory of ['data', 'logs']) expect(existsSync(join(profile, 'system-plugins', directory, pluginId))).toBe(false)
    completedStages.push(stage)
  } catch (error) { failure = error; throw error }
  finally {
    const cleanupErrors: unknown[] = []
    try {
      if (context) await closeElectronApp(context)
      else rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) { cleanupErrors.push(error) }
    try { rmSync(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    catch (error) { cleanupErrors.push(error) }
    const evidencePath = testInfo.outputPath('dependency-scripts-evidence.json')
    const logPath = testInfo.outputPath('dependency-scripts.log')
    writeFileSync(evidencePath, JSON.stringify({ completedStages, snapshots, failedStage: failure ? stage : null, failure: failure ? String(failure) : null, cleanupErrors: cleanupErrors.map(String) }, null, 2))
    writeFileSync(logPath, logs.join('\n'))
    await testInfo.attach('dependency-scripts-evidence', { path: evidencePath, contentType: 'application/json' })
    await testInfo.attach('dependency-scripts-log', { path: logPath, contentType: 'text/plain' })
    if (!failure && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Dependency-script acceptance cleanup failed.')
  }
})

function hashFile(file: string) { return createHash('sha256').update(readFileSync(file)).digest('hex') }

async function readJobs(context: ElectronAppContext, hash: string): Promise<Job[]> {
  return context.app.evaluate(({ app }, { pluginId, hash }) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true })
    try {
      const pkg = db.prepare('SELECT id FROM system_plugin_packages WHERE plugin_id = ? AND content_hash = ?').get(pluginId, hash)
      return db.prepare('SELECT kind, status, exit_code AS exitCode, command_json, log_path AS logPath FROM system_plugin_dependency_jobs WHERE package_id = ? ORDER BY created_at, rowid').all(pkg.id)
        .map((job: { kind: string; status: string; exitCode: number | null; command_json: string; logPath: string }) => ({ ...job, command: JSON.parse(job.command_json) }))
    } finally { db.close() }
  }, { pluginId, hash })
}
