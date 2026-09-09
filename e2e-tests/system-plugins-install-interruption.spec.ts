import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

const pluginId = 'system.e2e.install-interruption'
type Job = { id: string; kind: string; status: string; pid: number | null; exitCode: number | null; logPath: string; error: unknown }

test('recovers after killing only the isolated host tree during a reviewed build and retries the same artifact @install-interruption', async ({}, testInfo) => {
  test.setTimeout(180_000)
  expect(process.platform).toBe('win32')
  expect(process.env.KNOWBOOK_E2E_EXECUTABLE).toBeTruthy()
  const source = mkdtempSync(join(tmpdir(), 'knowbook-install-interruption-source-'))
  const profile = mkdtempSync(join(tmpdir(), 'knowbook 安装中断 '))
  const attemptsPath = join(profile, 'controlled-build-attempts.json')
  const historyPath = join(profile, 'system-plugins', 'data', pluginId, 'activation-history.json')
  const stages: string[] = []
  const snapshots: unknown[] = []
  let context: ElectronAppContext | null = null
  let stage = 'install-active-v1'
  let failure: unknown
  let buildPid: number | null = null
  let interruptedConfirmation: Promise<unknown> | null = null
  const launch = async () => {
    context = await launchElectronApp({}, { userDataRoot: profile })
    await context.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
    }, source)
  }
  const close = async () => { await closeElectronApp(context, { preserveUserData: true }); context = null }
  const state = () => context!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === id), pluginId)
  const ready = async (version: string) => {
    await expect.poll(async () => ({ status: (await state())?.status, version: (await state())?.currentVersion }), { timeout: 30_000 })
      .toEqual({ status: 'active', version })
  }
  const choose = async () => {
    const request = await context!.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    if (!request) throw new Error('Controlled artifact review is missing.')
    expect(request.status).toBe('awaiting-confirmation')
    return { id: request.id, pluginId: request.pluginId, artifactSha256: request.artifactSha256 }
  }
  const confirm = (input: { id: string; pluginId: string; artifactSha256: string }) => context!.page.evaluate((request) => window.knowbook.resolveSystemPluginInstallRequest({
    requestId: request.id, pluginId: request.pluginId, artifactSha256: request.artifactSha256,
    decision: 'confirm', acknowledgeSystemAccess: true
  }), input)
  try {
    writeFixture(source, '1.0.0')
    await launch()
    expect(await context!.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await confirm(await choose())
    await close(); await launch(); await ready('1.0.0')
    const originalHash = (await state())!.currentArtifactSha256
    expect(JSON.parse(readFileSync(historyPath, 'utf8')).map((entry: { version: string }) => entry.version)).toEqual(['1.0.0'])
    stages.push(stage)

    stage = 'interrupt-reviewed-v2-build'
    writeFixture(source, '2.0.0')
    const reviewed = await choose()
    const sourceBuildHash = hash(join(source, 'build.cjs'))
    // Attach rejection handling immediately: closing this exact Electron child
    // is intentional, and must not produce an unhandled Playwright rejection.
    interruptedConfirmation = confirm(reviewed).catch((error) => ({ interrupted: String(error) }))
    await expect.poll(async () => (await jobs(context!, reviewed.artifactSha256)).find((job) => job.kind === 'build')?.status, { timeout: 30_000 }).toBe('running')
    await expect.poll(async () => (await jobs(context!, reviewed.artifactSha256)).find((job) => job.kind === 'build')?.pid, { timeout: 10_000 }).not.toBeNull()
    await expect.poll(() => existsSync(attemptsPath)).toBe(true)
    const attempt = JSON.parse(readFileSync(attemptsPath, 'utf8')) as { attempt: number; pid: number; cwd: string }
    const before = await jobs(context!, reviewed.artifactSha256)
    const build = before.find((job) => job.kind === 'build')!
    buildPid = build.pid
    expect(buildPid).toBe(attempt.pid)
    expect(attempt.attempt).toBe(1)
    await expect.poll(() => existsSync(build.logPath) ? readFileSync(build.logPath, 'utf8') : '').toContain('CONTROLLED_BUILD_WAITING_FOR_HOST_INTERRUPTION')
    const child = context!.app.process()
    expect(child.exitCode).toBeNull()
    expect(child.pid).toBeGreaterThan(0)
    const closed = context!.app.waitForEvent('close')
    // The PID comes from the live Playwright ChildProcess handle. /T applies
    // only to that isolated profile's host and its dependency command children.
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    await closed
    context = null
    await interruptedConfirmation
    interruptedConfirmation = null
    await expect.poll(() => alive(buildPid!), { timeout: 15_000 }).toBe(false)
    expect(existsSync(attempt.cwd)).toBe(true)
    snapshots.push({ stage, reviewed, hostPid: child.pid, before, attempt })
    stages.push(stage)

    stage = 'restart-and-recover-with-v1-preserved'
    await launch(); await ready('1.0.0')
    expect((await state())!.currentArtifactSha256).toBe(originalHash)
    const recovered = await jobs(context!, reviewed.artifactSha256)
    expect(recovered.find((job) => job.kind === 'install')).toMatchObject({ status: 'succeeded', exitCode: 0 })
    expect(recovered.find((job) => job.kind === 'build')).toMatchObject({ status: 'failed', pid: null, exitCode: null })
    expect(recovered.find((job) => job.kind === 'native-rebuild')).toMatchObject({ status: 'cancelled', pid: null, exitCode: null })
    expect(existsSync(attempt.cwd)).toBe(false)
    expect(JSON.parse(readFileSync(attemptsPath, 'utf8')).attempt).toBe(1)
    expect(readFileSync(build.logPath, 'utf8')).toContain('CONTROLLED_BUILD_WAITING_FOR_HOST_INTERRUPTION')
    expect(hash(join(source, 'build.cjs'))).toBe(sourceBuildHash)
    snapshots.push({ stage, recovered, plugin: await state() })
    stages.push(stage)

    stage = 'reconfirm-identical-artifact-and-complete-build'
    const retry = await choose()
    expect(retry.artifactSha256).toBe(reviewed.artifactSha256)
    expect(retry.id).not.toBe(reviewed.id)
    expect(JSON.parse(readFileSync(attemptsPath, 'utf8')).attempt).toBe(1)
    await confirm(retry)
    expect(JSON.parse(readFileSync(attemptsPath, 'utf8')).attempt).toBe(2)
    expect((await state())!.currentVersion).toBe('1.0.0')
    expect((await state())!.status).toBe('pending-restart')
    const afterRetry = await jobs(context!, retry.artifactSha256)
    expect(afterRetry).toHaveLength(6)
    expect(afterRetry.filter((job) => job.status === 'succeeded')).toHaveLength(4)
    expect(afterRetry.filter((job) => job.status === 'failed')).toHaveLength(1)
    expect(afterRetry.filter((job) => job.status === 'cancelled')).toHaveLength(1)
    await close(); await launch(); await ready('2.0.0')
    expect(JSON.parse(readFileSync(historyPath, 'utf8')).map((entry: { version: string }) => entry.version)).toEqual(['1.0.0', '1.0.0', '2.0.0'])
    expect(hash(join(source, 'build.cjs'))).toBe(sourceBuildHash)
    snapshots.push({ stage, reviewed, retry, afterRetry, plugin: await state() })
    stages.push(stage)

    stage = 'uninstall-and-clean-controlled-revisions'
    await context!.page.evaluate((id) => window.knowbook.uninstallSystemPlugin({ pluginId: id }), pluginId)
    await close(); await launch()
    expect(await state()).toBeUndefined()
    expect(existsSync(join(profile, 'system-plugins', 'artifacts', pluginId, originalHash!))).toBe(false)
    expect(existsSync(join(profile, 'system-plugins', 'artifacts', pluginId, reviewed.artifactSha256))).toBe(false)
    expect(existsSync(join(profile, 'system-plugins', 'data', pluginId))).toBe(false)
    stages.push(stage)
  } catch (error) { failure = error; throw error }
  finally {
    const cleanupErrors: string[] = []
    try { await close() } catch (error) { cleanupErrors.push(String(error)) }
    if (buildPid && alive(buildPid)) cleanupErrors.push(`Controlled build PID ${buildPid} is still alive; fixture retained for inspection.`)
    if (!cleanupErrors.length) {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
      rmSync(source, { recursive: true, force: true, maxRetries: 5 })
    }
    writeFileSync(testInfo.outputPath('install-interruption-evidence.json'), JSON.stringify({
      scenario: 'packaged-host-killed-during-reviewed-build', completedStages: stages, snapshots,
      failedStage: failure ? stage : null, failure: failure ? String(failure) : null, cleanupErrors
    }, null, 2))
    if (!failure && cleanupErrors.length) throw new Error(cleanupErrors.join('\n'))
  }
})

function writeFixture(source: string, version: string) {
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({
    schemaVersion: 3, trust: 'full', id: pluginId, name: 'Installation interruption acceptance', version, publisher: 'KnowBook E2E',
    entries: { main: 'main.cjs' }, fullAccess: true, riskDeclarations: ['node', 'npm', 'filesystem'],
    ...(version === '2.0.0' ? { dependencies: { packageManager: 'npm', install: 'ci', allowScripts: false, buildCommand: ['node', 'build.cjs'], rebuildNativeModules: true } } : {})
  } satisfies SystemPluginV3Manifest))
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'knowbook-controlled-interruption', version, private: true }))
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: 'knowbook-controlled-interruption', version, lockfileVersion: 3, packages: { '': { name: 'knowbook-controlled-interruption', version } } }))
  writeFileSync(join(source, '.npmrc'), 'offline=true\naudit=false\nfund=false\n')
  writeFileSync(join(source, 'generated.cjs'), `module.exports = ${JSON.stringify(version === '1.0.0' ? version : 'unbuilt')}\n`)
  writeFileSync(join(source, 'main.cjs'), `module.exports.activate = context => {
 const fs = context.require('node:fs'), path = context.require('node:path')
 const version = require('./generated.cjs')
 if (version === 'unbuilt') throw new Error('Build output was not prepared')
 const file = path.join(context.plugin.dataRoot, 'activation-history.json')
 const history = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
 history.push({ version, revisionHash: context.plugin.revisionHash })
 fs.writeFileSync(file, JSON.stringify(history))
}`)
  writeFileSync(join(source, 'build.cjs'), `const fs = require('node:fs'), path = require('node:path')
const statePath = path.join(process.env.KNOWBOOK_USER_DATA_DIR, 'controlled-build-attempts.json')
const previous = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')).attempt : 0
const attempt = previous + 1
fs.writeFileSync(statePath, JSON.stringify({ attempt, pid: process.pid, cwd: process.cwd() }))
if (attempt === 1) {
 console.log('CONTROLLED_BUILD_WAITING_FOR_HOST_INTERRUPTION')
 setInterval(() => console.log('CONTROLLED_BUILD_STILL_WAITING'), 200)
 setTimeout(() => process.exit(124), 120000)
} else {
 fs.writeFileSync(path.join(__dirname, 'generated.cjs'), 'module.exports = "2.0.0"\\n')
 console.log('CONTROLLED_BUILD_RETRY_SUCCEEDED')
}`)
}
async function jobs(context: ElectronAppContext, hash: string): Promise<Job[]> {
  return context.app.evaluate(({ app }, input) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const require = createRequire(`${app.getAppPath()}/package.json`)
    const Database = require('better-sqlite3')
    const db = new Database(`${app.getPath('userData')}/storage/knowbook.db`, { readonly: true })
    try { return db.prepare(`SELECT job.id, job.kind, job.status, job.pid, job.exit_code AS exitCode, job.log_path AS logPath, job.error_json AS error
      FROM system_plugin_dependency_jobs AS job JOIN system_plugin_packages AS package ON package.id = job.package_id
      WHERE package.plugin_id = ? AND package.content_hash = ? ORDER BY job.created_at, job.id`).all(input.pluginId, input.hash) }
    finally { db.close() }
  }, { pluginId, hash })
}
function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
