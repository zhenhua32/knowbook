import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
type Job = { kind: string; status: string; exitCode: number | null; command: string[]; logPath: string }
type Activation = { value: number; label: string; dependencyScriptRan: boolean; revisionHash: string; resolvedDependency: string; events: string[] }

for (const manager of ['pnpm', 'yarn'] as const) {
  test(`${manager} installs and builds a locked local dependency in packaged Electron @package-managers`, async ({}, testInfo) => {
    test.setTimeout(240_000)
    expect(process.platform).toBe('win32')
    expect(process.env.KNOWBOOK_E2E_EXECUTABLE, 'Run npm run test:packaged-package-managers.').toBeTruthy()
    const pluginId = `system.e2e.manager-${manager}`
    const source = mkdtempSync(join(tmpdir(), `knowbook ${manager} source `))
    const profile = mkdtempSync(join(tmpdir(), `knowbook ${manager} 工作区 `))
    const historyPath = join(profile, 'system-plugins', 'data', pluginId, 'manager-history.json')
    const lockName = manager === 'pnpm' ? 'pnpm-lock.yaml' : 'yarn.lock'
    const stages: string[] = []
    const snapshots: unknown[] = []
    const logs: string[] = []
    const hashes: string[] = []
    let context: ElectronAppContext | null = null
    let stage = 'toolchain-and-review'
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
    const prepare = async (version: string, allowScripts: boolean) => {
      writeFileSync(join(source, 'fixture.json'), JSON.stringify({ label: version, allowScripts }))
      writeFileSync(join(source, 'plugin.json'), JSON.stringify({
        schemaVersion: 3, trust: 'full', id: pluginId, name: `${manager} acceptance`, version,
        publisher: 'KnowBook E2E', entries: { main: 'main.cjs' }, fullAccess: true,
        riskDeclarations: ['node', 'npm', 'filesystem', 'subprocess'],
        dependencies: { packageManager: manager, install: 'ci', allowScripts, rebuildNativeModules: false, buildCommand: [manager, 'run', 'build'] }
      } satisfies SystemPluginV3Manifest, null, 2))
      const request = await context!.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
      if (!request) throw new Error('Expected package-manager install review.')
      expect(request.status).toBe('awaiting-confirmation')
      for (const directory of [source, join(profile, 'system-plugins', 'staging', request.id)]) {
        for (const entry of ['events.json', 'generated.cjs', 'node_modules']) expect(existsSync(join(directory, entry))).toBe(false)
      }
      return { id: request.id, pluginId: request.pluginId, artifactSha256: request.artifactSha256 }
    }
    const confirm = (request: { id: string; pluginId: string; artifactSha256: string }) => context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
      requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256, decision: 'confirm', acknowledgeSystemAccess: true
    }), request)
    const jobsFor = async (hash: string) => {
      const jobs = await readJobs(context!, pluginId, hash)
      if (jobs[0]?.logPath) logs.push(readFileSync(jobs[0].logPath, 'utf8'))
      snapshots.push({ stage, hash, jobs })
      return jobs
    }
    try {
      cpSync(join(root, 'e2e-tests/fixtures/package-managers'), source, { recursive: true })
      cpSync(join(root, 'e2e-tests/fixtures/package-manager-locks', lockName), join(source, lockName))
      const cli = join(root, 'release/package-manager-toolchain/node_modules', manager, manager === 'pnpm' ? 'bin/pnpm.mjs' : 'bin/yarn.js')
      const version = execFileSync(process.execPath, [cli, '--version'], { cwd: source, encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim()
      const expectedVersions = JSON.parse(readFileSync(join(root, 'e2e-tests/fixtures/package-manager-toolchain/package.json'), 'utf8')).dependencies
      expect(version).toBe(expectedVersions[manager])
      const lockHash = hashFile(join(source, lockName))
      await boot()
      const host = await context!.app.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron, platform: process.platform, arch: process.arch }))
      expect(host.packaged).toBe(true)
      snapshots.push({ host, manager, version, lockHash })
      const cancelled = await prepare('0.0.1', true)
      await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
        requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256, decision: 'cancel', acknowledgeSystemAccess: false
      }), cancelled)
      expect(await state()).toBeNull()
      expect(existsSync(historyPath)).toBe(false)
      expect(existsSync(join(profile, 'system-plugins', 'artifacts', pluginId, cancelled.artifactSha256))).toBe(false)
      stages.push(stage)

      for (const config of [{ version: '1.0.0', scripts: false }, { version: '2.0.0', scripts: true }]) {
        stage = config.scripts ? 'allow-root-and-dependency-lifecycles' : 'skip-lifecycles-and-run-explicit-build'
        const request = await prepare(config.version, config.scripts)
        hashes.push(request.artifactSha256)
        await confirm(request)
        const jobs = await jobsFor(request.artifactSha256)
        expect(jobs.map(({ kind, status, exitCode }) => ({ kind, status, exitCode }))).toEqual([
          { kind: 'install', status: 'succeeded', exitCode: 0 }, { kind: 'build', status: 'succeeded', exitCode: 0 }
        ])
        expect(jobs[0].command).toEqual([manager, 'install', '--frozen-lockfile', ...(!config.scripts ? ['--ignore-scripts'] : [])])
        expect(jobs[1].command).toEqual([manager, ...(manager === 'pnpm' ? ['--config.verify-deps-before-run=false'] : []), 'run', 'build'])
        const runtime = join(profile, 'system-plugins', 'runtime', pluginId, request.artifactSha256)
        const artifact = join(profile, 'system-plugins', 'artifacts', pluginId, request.artifactSha256)
        for (const directory of [source, artifact]) {
          for (const entry of ['events.json', 'generated.cjs', 'node_modules', 'vendor/value/installed.json']) expect(existsSync(join(directory, entry))).toBe(false)
          expect(hashFile(join(directory, lockName))).toBe(lockHash)
        }
        expect(hashFile(join(runtime, lockName))).toBe(lockHash)
        const dependency = join(runtime, 'node_modules', 'knowbook-manager-value')
        const resolved = realpathSync(dependency)
        expect(relative(runtime, resolved).split(sep)).not.toContain('..')
        expect(lstatSync(dependency).isSymbolicLink()).toBe(manager === 'pnpm')
        snapshots.push({ stage, dependency, resolved, isLink: lstatSync(dependency).isSymbolicLink() })
        expect((await state())?.status).toBe('pending-restart')
        await boot()
        await expect.poll(async () => (await state())?.status).toBe('active')
        expect(history().at(-1)).toMatchObject({ value: 42, label: config.version, dependencyScriptRan: config.scripts, revisionHash: `sha256:${request.artifactSha256}` })
        expect(history().at(-1)!.events).toEqual(config.scripts ? ['preinstall', 'install', 'postinstall', 'build'] : ['build'])
        expect(history().at(-1)!.resolvedDependency.startsWith(runtime + sep)).toBe(true)
        snapshots.push({ stage, history: history() })
        stages.push(stage)
      }

      stage = 'frozen-lock-failure-preserves-active-revision'
      const stable = (await state())!
      const stableHistory = history()
      const packagePath = join(source, 'package.json')
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
      pkg.dependencies['knowbook-manager-extra'] = 'file:vendor/extra'
      writeFileSync(packagePath, JSON.stringify(pkg, null, 2))
      const rejected = await prepare('3.0.0', true)
      hashes.push(rejected.artifactSha256)
      await expect(confirm(rejected)).rejects.toThrow(/dependency command/i)
      const jobs = await jobsFor(rejected.artifactSha256)
      expect(jobs.map(({ kind, status }) => ({ kind, status }))).toEqual([
        { kind: 'install', status: 'failed' }, { kind: 'build', status: 'cancelled' }
      ])
      expect(jobs[0].exitCode).not.toBe(0)
      expect(jobs[0].exitCode).not.toBeNull()
      expect(logs.at(-1)).toMatch(manager === 'pnpm' ? /OUTDATED_LOCKFILE/ : /lockfile needs to be updated/i)
      expect(logs.at(-1)).not.toContain('KNOWBOOK_MANAGER_PHASE_build')
      expect(await state()).toMatchObject({ status: 'active', currentVersion: '2.0.0', currentArtifactSha256: stable.currentArtifactSha256 })
      expect(history()).toEqual(stableHistory)
      expect(existsSync(join(profile, 'system-plugins', 'runtime', pluginId, rejected.artifactSha256))).toBe(false)
      expect(readdirSync(join(profile, 'system-plugins', 'runtime', pluginId)).some((entry) => entry.startsWith('.preparing-'))).toBe(false)
      stages.push(stage)

      stage = 'restart-and-uninstall'
      await boot()
      expect(await state()).toMatchObject({ status: 'active', currentVersion: '2.0.0' })
      expect(history().map((item) => item.label)).toEqual(['1.0.0', '2.0.0', '2.0.0'])
      await context!.page.evaluate((id) => window.knowbook.uninstallSystemPlugin({ pluginId: id }), pluginId)
      await boot()
      expect(await state()).toBeNull()
      for (const hash of hashes) for (const directory of ['artifacts', 'runtime']) expect(existsSync(join(profile, 'system-plugins', directory, pluginId, hash))).toBe(false)
      for (const directory of ['data', 'logs']) expect(existsSync(join(profile, 'system-plugins', directory, pluginId))).toBe(false)
      stages.push(stage)
    } catch (error) { failure = error; throw error }
    finally {
      const cleanupErrors: unknown[] = []
      const dependencyLogs = join(profile, 'system-plugins', 'logs', pluginId)
      if (existsSync(dependencyLogs)) for (const name of readdirSync(dependencyLogs)) {
        if (name.endsWith('-dependencies.log')) logs.push(readFileSync(join(dependencyLogs, name), 'utf8'))
      }
      try {
        if (context) await closeElectronApp(context)
        else rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (error) { cleanupErrors.push(error) }
      try { rmSync(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
      catch (error) { cleanupErrors.push(error) }
      const evidencePath = testInfo.outputPath('package-manager-evidence.json')
      const logPath = testInfo.outputPath('package-manager.log')
      writeFileSync(evidencePath, JSON.stringify({ manager, stages, snapshots, failedStage: failure ? stage : null, failure: failure ? String(failure) : null, cleanupErrors: cleanupErrors.map(String) }, null, 2))
      writeFileSync(logPath, logs.join('\n'))
      await testInfo.attach('package-manager-evidence', { path: evidencePath, contentType: 'application/json' })
      await testInfo.attach('package-manager-log', { path: logPath, contentType: 'text/plain' })
      if (!failure && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Package-manager cleanup failed.')
    }
  })
}

function hashFile(file: string) { return createHash('sha256').update(readFileSync(file)).digest('hex') }

async function readJobs(context: ElectronAppContext, pluginId: string, hash: string): Promise<Job[]> {
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
