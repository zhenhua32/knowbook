import { expect, test } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('installer maintenance stops owned detached service without activating plugin code @uninstall-cleanup', async ({}, testInfo) => {
  test.setTimeout(180_000)
  expect(process.platform).toBe('win32')
  const executable = process.env.KNOWBOOK_E2E_EXECUTABLE!
  expect(executable, 'Provide the newly packaged KnowBook executable.').toBeTruthy()
  const source = mkdtempSync(join(tmpdir(), 'knowbook-uninstall-source-'))
  const profile = mkdtempSync(join(tmpdir(), 'knowbook 卸载 清理 '))
  const pluginId = `system.e2e.uninstall-${randomUUID()}`
  const serviceId = `knowbook.${pluginId}`
  const unrelatedServiceId = `knowbook.system.e2e.unrelated-${randomUUID()}`
  const data = join(profile, 'system-plugins', 'data', pluginId)
  const marker = join(data, 'main-calls.json')
  const servicePath = join(data, 'service-state.json')
  let context: ElectronAppContext | null = null
  let stage = 'install-controlled-plugin'
  let failure: unknown
  let pid: number | null = null
  const stages: string[] = []
  const snapshots: unknown[] = []
  const launch = async () => { context = await launchElectronApp({ KNOWBOOK_E2E_EXECUTABLE: executable }, { userDataRoot: profile }) }
  const close = async () => { await closeElectronApp(context, { preserveUserData: true }); context = null }
  const state = () => context!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === id), pluginId)
  try {
    cpSync(join(root, 'e2e-tests', 'fixtures', 'windows-startup'), source, { recursive: true })
    writeFileSync(join(source, 'main.cjs'), `
let save
module.exports.activate = context => {
 const fs = context.require('node:fs'), path = context.require('node:path')
 const file = path.join(context.plugin.dataRoot, 'main-calls.json')
 save = method => { const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; calls.push(method); fs.writeFileSync(file, JSON.stringify(calls)) }
 save('activate')
}
module.exports.deactivate = () => save('deactivate')
`)
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({
      schemaVersion: 3, trust: 'full', id: pluginId, name: 'Uninstall maintenance acceptance', version: '1.0.0', publisher: 'KnowBook E2E',
      entries: { main: 'main.cjs', service: 'service.cjs' }, background: { mode: 'detached', autoStart: true }, fullAccess: true,
      riskDeclarations: ['node', 'filesystem', 'background-service', 'os-persistence']
    } satisfies SystemPluginV3Manifest))
    await launch()
    expect(await context!.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    expect(registryHas('Run', unrelatedServiceId)).toBe(false)
    // A disabled, controlled registration for the same executable must not be
    // inspected by an explicitly scoped maintenance call. Its invalid profile
    // would make global discovery fail, making this a behavioral scope check.
    await context!.app.evaluate(({ app }, item) => app.setLoginItemSettings({
      name: item.name, path: process.execPath, openAtLogin: true, enabled: false,
      args: ['--knowbook-user-data-dir=relative-fixture-profile', '--knowbook-system-plugin-os-startup=system.e2e.unrelated']
    }), { name: unrelatedServiceId })
    await context!.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
    }, source)
    const review = await context!.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    if (!review) throw new Error('Review missing.')
    await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
      requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256,
      decision: 'confirm', acknowledgeSystemAccess: true
    }), { id: review.id, pluginId, artifactSha256: review.artifactSha256 })
    await close(); await launch()
    await expect.poll(async () => (await state())?.status, { timeout: 30_000 }).toBe('active')
    await expect.poll(() => existsSync(servicePath) ? JSON.parse(readFileSync(servicePath, 'utf8')).successes : 0, { timeout: 15_000 }).toBeGreaterThan(0)
    pid = JSON.parse(readFileSync(servicePath, 'utf8')).pid
    const request = await context!.page.evaluate((id) => window.knowbook.requestSystemPluginOsPersistence({ pluginId: id }), pluginId)
    await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginOsPersistence({
      recordId: input.id, pluginId: input.pluginId, revisionHash: input.revisionHash,
      decision: 'confirm', acknowledgeSystemStartup: true
    }), { id: request.id, pluginId, revisionHash: request.revisionHash })
    expect(registryHas('Run', serviceId)).toBe(true)
    snapshots.push({ stage, plugin: await state(), pid })
    stages.push(stage)

    stage = 'maintenance-cleanup-without-plugin-code'
    await close()
    expect(alive(pid!)).toBe(true)
    const calls = readFileSync(marker, 'utf8')
    expect(JSON.parse(calls)).toContain('activate')
    await maintenance(executable, profile)
    expect(readFileSync(marker, 'utf8')).toBe(calls)
    expect(alive(pid!)).toBe(false)
    expect(registryHas('Run', serviceId)).toBe(false)
    expect(registryHas('Explorer\\StartupApproved\\Run', serviceId)).toBe(false)
    expect(registryHas('Run', unrelatedServiceId)).toBe(true)
    expect(existsSync(join(profile, 'system-plugins', 'artifacts', pluginId, review.artifactSha256))).toBe(true)
    expect(existsSync(join(profile, 'storage', 'knowbook.db'))).toBe(true)
    const cleanup = JSON.parse(readFileSync(join(profile, 'system-plugin-uninstall-cleanup.json'), 'utf8'))
    expect(cleanup).toMatchObject({ status: 'passed', retainsUserData: true })
    snapshots.push({ stage, cleanup, mainCalls: JSON.parse(calls) })
    stages.push(stage)

    stage = 'repeat-maintenance-and-open-retained-data'
    await maintenance(executable, profile)
    expect(readFileSync(marker, 'utf8')).toBe(calls)
    await launch()
    expect((await state())?.status).toBe('disabled')
    expect((await state())?.osPersistence?.status).toBe('removed')
    expect(readFileSync(marker, 'utf8')).toBe(calls)
    snapshots.push({ stage, plugin: await state() })
    stages.push(stage)
  } catch (error) { failure = error; throw error }
  finally {
    const cleanupErrors: string[] = []
    try { await close() } catch (error) { cleanupErrors.push(String(error)) }
    for (const key of ['Run', 'Explorer\\StartupApproved\\Run']) {
      try {
        if (registryHas(key, unrelatedServiceId)) execFileSync('reg.exe', [
          'delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\${key}`, '/v', unrelatedServiceId, '/f'
        ], { windowsHide: true, stdio: 'ignore' })
      } catch (error) { cleanupErrors.push(String(error)) }
    }
    if (registryHas('Run', serviceId) || (pid && alive(pid))) {
      try { await maintenance(executable, profile) } catch (error) { cleanupErrors.push(String(error)) }
    }
    if (!cleanupErrors.length) {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
      rmSync(source, { recursive: true, force: true, maxRetries: 5 })
    }
    writeFileSync(testInfo.outputPath('uninstall-cleanup-evidence.json'), JSON.stringify({
      scenario: 'packaged-installer-maintenance-cli', completedStages: stages, snapshots,
      failedStage: failure ? stage : null, failure: failure ? String(failure) : null, cleanupErrors
    }, null, 2))
    if (!failure && cleanupErrors.length) throw new Error(cleanupErrors.join('\n'))
  }
})

async function maintenance(executable: string, profile: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, KNOWBOOK_DISABLE_HARDWARE_ACCELERATION: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.KNOWBOOK_USER_DATA_DIR
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['--knowbook-uninstall-cleanup', `--knowbook-user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu'], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 45_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`Maintenance timed out and PID ${child.pid} has now closed: ${output}`))
      else code === 0 ? resolve() : reject(new Error(`Maintenance exit ${code}: ${output}`))
    })
  })
}
function registryHas(key: string, name: string): boolean {
  try { execFileSync('reg.exe', ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\${key}`, '/v', name], { windowsHide: true, stdio: 'ignore' }); return true }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw error }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
