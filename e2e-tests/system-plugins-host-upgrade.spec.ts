import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginId = 'system.e2e.host-upgrade'
type NativeActivation = {
  electron: string; modules: string; compiledAbi: number; answer: number
  binaryHash: string; binaryPath: string; revisionHash: string; packaged: boolean
}

// Deliberately separate from @electron: two genuinely different packaged
// Electron ABIs and a C++ compiler are required; missing inputs must fail.
test('rebuilds the same confirmed native plugin across a real host upgrade and rollback @host-upgrade', async ({}, testInfo) => {
  test.setTimeout(300_000)
  const baseline = process.env.KNOWBOOK_E2E_EXECUTABLE
  const target = process.env.KNOWBOOK_E2E_UPGRADE_EXECUTABLE
  expect(baseline, 'Provide the baseline packaged executable.').toBeTruthy()
  expect(target, 'Run npm run prepare:host-upgrade, then npm run test:packaged-host-upgrade.').toBeTruthy()
  const source = mkdtempSync(join(tmpdir(), 'knowbook-host-upgrade-source-'))
  const completedStages: string[] = []
  const snapshots: unknown[] = []
  const compilerLogs: string[] = []
  let context: ElectronAppContext | null = null
  let profile: string | undefined
  let stage = 'verify-distinct-hosts'
  let failure: unknown
  try {
    context = await launchElectronApp({ KNOWBOOK_E2E_EXECUTABLE: target! })
    const targetHost = await host(context)
    expect(targetHost.packaged).toBe(true)
    await closeElectronApp(context)
    context = null
    context = await launchElectronApp({ KNOWBOOK_E2E_EXECUTABLE: baseline! })
    profile = context.tempRoot
    const originalHost = await host(context)
    expect(originalHost.packaged).toBe(true)
    expect(targetHost.electron).not.toBe(originalHost.electron)
    expect(Number(targetHost.electron.split('.')[0])).toBeGreaterThan(Number(originalHost.electron.split('.')[0]))
    expect(targetHost.modules, 'Different version labels alone do not prove an ABI migration.').not.toBe(originalHost.modules)
    snapshots.push({ originalHost, targetHost })
    completedStages.push(stage)

    stage = 'install-and-activate-on-original-host'
    cpSync(join(root, 'e2e-tests', 'fixtures', 'native-rebuild'), source, { recursive: true })
    cpSync(join(source, 'main.cjs'), join(source, 'native-main.cjs'))
    writeFileSync(join(source, 'main.cjs'), `
const native = require('./native-main.cjs')
module.exports.activate = (context) => {
  native.activate(context)
  const fs = context.require('node:fs')
  const path = context.require('node:path')
  const historyPath = path.join(context.plugin.dataRoot, 'host-history.json')
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : []
  history.push(JSON.parse(fs.readFileSync(path.join(context.plugin.dataRoot, 'compiled-native.json'), 'utf8')))
  fs.writeFileSync(historyPath, JSON.stringify(history))
}
`)
    writeFileSync(join(source, '.npmrc'), 'offline=true\naudit=false\nfund=false\n')
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({
      schemaVersion: 3, trust: 'full', id: pluginId, name: 'Host ABI upgrade acceptance',
      version: '1.0.0', publisher: 'KnowBook E2E', entries: { main: 'main.cjs' }, fullAccess: true,
      riskDeclarations: ['node', 'npm', 'filesystem'],
      dependencies: { packageManager: 'npm', install: 'ci', allowScripts: false, rebuildNativeModules: true }
    } satisfies SystemPluginV3Manifest, null, 2))
    await context.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
    }, source)
    const request = await context.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    expect(request?.status).toBe('awaiting-confirmation')
    if (!request) throw new Error('Expected a native plugin install request.')
    await context.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
      requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256,
      acknowledgeSystemAccess: true, decision: 'confirm'
    }), { id: request.id, pluginId: request.pluginId, artifactSha256: request.artifactSha256 })
    expect((await state(context))?.status).toBe('pending-restart')
    const artifact = join(profile, 'system-plugins', 'artifacts', pluginId, request.artifactSha256)
    const immutableSourceHash = hash(join(artifact, 'abi-probe.cc'))
    const historyPath = join(profile, 'system-plugins', 'data', pluginId, 'host-history.json')
    expect(existsSync(historyPath)).toBe(false)
    await closeElectronApp(context, { preserveUserData: true })
    context = null
    context = await launchElectronApp({ KNOWBOOK_E2E_EXECUTABLE: baseline! }, { userDataRoot: profile })
    const original = await expectActivation(context, historyPath, request.artifactSha256, [originalHost.modules])
    const installed = await persisted(context, request.artifactSha256)
    expect(installed.requests).toHaveLength(1)
    expect(installed.requests[0]).toMatchObject({ id: request.id, status: 'confirmed-restart-required' })
    expect(installed.jobs).toHaveLength(2)
    expect(installed.fingerprint.modules).toBe(originalHost.modules)
    snapshots.push({ stage, activation: original, persisted: installed })
    completedStages.push(stage)

    for (const transition of [
      { stage: 'upgrade-host', executable: target!, host: targetHost, modules: [originalHost.modules, targetHost.modules], jobs: 4, rebuilds: 1 },
      { stage: 'rollback-host', executable: baseline!, host: originalHost, modules: [originalHost.modules, targetHost.modules, originalHost.modules], jobs: 6, rebuilds: 2 }
    ]) {
      stage = transition.stage
      const prior = JSON.parse(readFileSync(historyPath, 'utf8')) as NativeActivation[]
      await closeElectronApp(context, { preserveUserData: true })
      context = null
      context = await launchElectronApp({ KNOWBOOK_E2E_EXECUTABLE: transition.executable }, { userDataRoot: profile })
      const activation = await expectActivation(context, historyPath, request.artifactSha256, transition.modules)
      expect(activation.electron).toBe(transition.host.electron)
      expect(activation.binaryHash).not.toBe(prior.at(-1)!.binaryHash)
      const record = await persisted(context, request.artifactSha256)
      expect(record.fingerprint.modules).toBe(transition.host.modules)
      expect(record.fingerprint.electron).toBe(transition.host.electron)
      expect(record.requests, 'Host ABI rebuild reuses the exact prior confirmation.').toEqual(installed.requests)
      expect(record.jobs).toHaveLength(transition.jobs)
      expect(record.jobs.every((job) => job.status === 'succeeded' && job.exitCode === 0)).toBe(true)
      expect(record.jobs.filter((job) => job.command.includes(`--target=${transition.host.electron}`))).not.toHaveLength(0)
      expect(record.audits.filter((action) => action === 'runtime.compatibility-rebuilt')).toHaveLength(transition.rebuilds)
      expect(hash(join(artifact, 'abi-probe.cc'))).toBe(immutableSourceHash)
      expect(existsSync(join(artifact, 'build'))).toBe(false)
      compilerLogs.push(readFileSync(record.jobs.at(-1)!.logPath, 'utf8'))
      snapshots.push({ stage, activation, persisted: record })
      completedStages.push(stage)
    }

    stage = 'restart-compatible-host-without-rebuild'
    await closeElectronApp(context, { preserveUserData: true })
    context = null
    context = await launchElectronApp({ KNOWBOOK_E2E_EXECUTABLE: baseline! }, { userDataRoot: profile })
    await expectActivation(context, historyPath, request.artifactSha256, [originalHost.modules, targetHost.modules, originalHost.modules, originalHost.modules])
    expect((await persisted(context, request.artifactSha256)).jobs).toHaveLength(6)
    completedStages.push(stage)

    stage = 'uninstall-after-host-rollback'
    await context.page.evaluate((id) => window.knowbook.uninstallSystemPlugin({ pluginId: id }), pluginId)
    await closeElectronApp(context, { preserveUserData: true })
    context = null
    context = await launchElectronApp({ KNOWBOOK_E2E_EXECUTABLE: baseline! }, { userDataRoot: profile })
    await expect.poll(() => state(context!), { timeout: 30_000 }).toBeNull()
    expect(existsSync(artifact)).toBe(false)
    expect(existsSync(join(profile, 'system-plugins', 'runtime', pluginId, request.artifactSha256))).toBe(false)
    expect(existsSync(join(profile, 'system-plugins', 'data', pluginId))).toBe(false)
    completedStages.push(stage)
  } catch (error) {
    failure = error
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    try {
      if (context) await closeElectronApp(context)
      else if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) { cleanupErrors.push(error) }
    try { rmSync(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    catch (error) { cleanupErrors.push(error) }
    const evidencePath = testInfo.outputPath('host-upgrade-evidence.json')
    const logPath = testInfo.outputPath('host-upgrade-compiler.log')
    writeFileSync(evidencePath, JSON.stringify({
      scenario: 'packaged-electron-host-upgrade-and-rollback', completedStages, snapshots,
      failedStage: failure ? stage : null, failure: failure ? String(failure) : null,
      cleanupErrors: cleanupErrors.map(String)
    }, null, 2))
    writeFileSync(logPath, compilerLogs.join('\n'))
    await testInfo.attach('host-upgrade-evidence', { path: evidencePath, contentType: 'application/json' })
    await testInfo.attach('host-upgrade-compiler-log', { path: logPath, contentType: 'text/plain' })
    if (!failure && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Host upgrade acceptance cleanup failed.')
  }
})

async function host(context: ElectronAppContext) {
  return context.app.evaluate(({ app }) => ({
    electron: process.versions.electron!, modules: process.versions.modules!,
    packaged: app.isPackaged, executable: process.execPath
  }))
}

async function state(context: ElectronAppContext) {
  return context.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === id) ?? null, pluginId)
}

async function expectActivation(context: ElectronAppContext, historyPath: string, hash: string, modules: string[]) {
  await expect.poll(async () => {
    const plugin = await state(context)
    return { status: plugin?.status, hash: plugin?.currentArtifactSha256, error: plugin?.lastError }
  }, { timeout: 120_000 }).toEqual({ status: 'active', hash, error: null })
  const history = JSON.parse(readFileSync(historyPath, 'utf8')) as NativeActivation[]
  expect(history.map((entry) => entry.modules)).toEqual(modules)
  const latest = history.at(-1)!
  expect(latest.compiledAbi).toBe(Number(modules.at(-1)))
  expect(latest.answer).toBe(42)
  expect(latest.packaged).toBe(true)
  expect(latest.revisionHash).toBe(`sha256:${hash}`)
  return latest
}

async function persisted(context: ElectronAppContext, artifactHash: string): Promise<{
  fingerprint: { modules: string; electron: string }
  requests: Array<{ id: string; status: string }>
  jobs: Array<{ status: string; exitCode: number; command: string[]; logPath: string }>
  audits: string[]
}> {
  return context.app.evaluate(({ app }, { id, hash }) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true })
    try {
      const record = db.prepare('SELECT id, runtime_fingerprint_json FROM system_plugin_packages WHERE plugin_id = ? AND content_hash = ?').get(id, hash)
      return {
        fingerprint: JSON.parse(record.runtime_fingerprint_json),
        requests: db.prepare('SELECT id, status FROM system_plugin_install_requests WHERE plugin_id = ? ORDER BY id').all(id),
        jobs: db.prepare('SELECT status, exit_code AS exitCode, command_json, log_path AS logPath FROM system_plugin_dependency_jobs WHERE package_id = ? ORDER BY created_at, rowid').all(record.id)
          .map((job: { status: string; exitCode: number; command_json: string; logPath: string }) => ({ ...job, command: JSON.parse(job.command_json) })),
        audits: db.prepare('SELECT action FROM system_plugin_audit WHERE plugin_id = ?').all(id).map((item: { action: string }) => item.action)
      }
    } finally { db.close() }
  }, { id: pluginId, hash: artifactHash })
}

function hash(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
