import { expect, test } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
type Release = { label: 'baseline' | 'upgrade'; version: string; installer: string; sha256: string; sha512: string; size: number }
type Fixture = { kind: string; id: string; appId: string; packageName: string; executableName: string; productName: string; releases: Release[] }

// Deliberately independent from @electron. Its installers have a random appId,
// package name, NSIS GUID and executable, so installed KnowBook is never touched.
test('updater upgrade, NSIS rollback and application uninstall clean managed plugin persistence @windows-installer', async ({}, testInfo) => {
  test.setTimeout(600_000)
  expect(process.platform).toBe('win32')
  const fixture = JSON.parse(readFileSync(process.env.KNOWBOOK_E2E_INSTALLER_FIXTURE!, 'utf8')) as Fixture
  expect(fixture.kind).toBe('isolated-windows-installer-acceptance')
  const token = fixture.id.replaceAll('-', '')
  expect(token).toMatch(/^[a-f0-9]{32}$/)
  expect(fixture.appId).toBe(`com.zhenhua32.knowbook.acceptance.${token}`)
  expect(fixture.packageName).toBe(`knowbook-v3-acceptance-${token}`)
  expect(fixture.executableName).toBe(`KnowBookV3Acceptance-${token}`)
  expect(fixture.productName).toBe(`KnowBook V3 Acceptance ${token}`)
  const baseline = fixture.releases.find((item) => item.label === 'baseline')!
  const upgrade = fixture.releases.find((item) => item.label === 'upgrade')!
  for (const release of [baseline, upgrade]) {
    const bytes = readFileSync(release.installer)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(release.sha256)
    expect(createHash('sha512').update(bytes).digest('base64')).toBe(release.sha512)
  }
  const folder = mkdtempSync(join(tmpdir(), 'knowbook NSIS 验收 '))
  const installDirectory = join(folder, 'Application')
  const executable = join(installDirectory, `${fixture.executableName}.exe`)
  // This is the unique fixture package's standard Roaming data path. NSIS's
  // --delete-app-data must remove it; production KnowBook paths are unrelated.
  const profile = join(process.env.APPDATA!, fixture.packageName)
  expect(existsSync(profile), 'Never reuse an existing fixture profile.').toBe(false)
  expect(installerRegistration(fixture.id), 'Uninstall the previous fixture registration before rerunning.').toBe(false)
  const source = join(folder, 'plugin')
  const pluginId = `system.e2e.installer-${randomUUID()}`
  const serviceId = `knowbook.${pluginId}`
  const reportPath = join(profile, 'system-plugins', 'data', pluginId, 'service-state.json')
  const retainedDataPath = join(dirname(reportPath), 'installer-retained-data.txt')
  const retainedData = `reviewed-plugin-data:${randomUUID()}`
  const stages: string[] = []
  const snapshots: unknown[] = []
  let stage = 'install-baseline'
  let failure: unknown
  let context: ElectronAppContext | null = null
  let didInstall = false
  let servicePid: number | undefined
  let launchStartedAt = 0
  const service = () => JSON.parse(readFileSync(reportPath, 'utf8')) as { pid: number; successes: number; lastRpcAt: number }
  const launch = async () => {
    launchStartedAt = Date.now()
    context = await launchElectronApp({ KNOWBOOK_E2E_EXECUTABLE: executable }, { userDataRoot: profile })
  }
  const close = async () => { await closeElectronApp(context, { preserveUserData: true, preserveDetachedChildren: true }); context = null }
  const state = () => context!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === id), pluginId)
  const ready = async (version: string) => {
    expect(await context!.app.evaluate(({ app }) => app.getVersion())).toBe(version)
    await expect.poll(async () => (await state())?.status, { timeout: 30_000 }).toBe('active')
    await expect.poll(() => existsSync(reportPath) ? service().successes : 0).toBeGreaterThan(0)
    await expect.poll(() => service().lastRpcAt, { timeout: 15_000 }).toBeGreaterThan(launchStartedAt)
    servicePid = service().pid
    expect(processAlive(servicePid)).toBe(true)
    expect((await state())?.recentRuns.find((run) => run.component === 'detached' && run.status === 'ready')?.pid).toBe(servicePid)
    snapshots.push({ stage, applicationVersion: version, plugin: await state(), service: service() })
  }
  const server = createServer((request, response) => {
    if (request.url?.split('?')[0] === '/latest.yml') {
      response.end(`version: ${upgrade.version}\nfiles:\n  - url: upgrade.exe\n    sha512: ${upgrade.sha512}\n    size: ${upgrade.size}\npath: upgrade.exe\nsha512: ${upgrade.sha512}\nreleaseDate: ${new Date().toISOString()}\n`)
    } else if (request.url?.split('?')[0] === '/upgrade.exe') response.end(readFileSync(upgrade.installer))
    else { response.statusCode = 404; response.end() }
  })
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', settle))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local updater feed did not start.')
  try {
    didInstall = true
    await runInstaller(baseline.installer, ['/S', `/D=${installDirectory}`], true)
    expect(existsSync(executable)).toBe(true)
    await launch()
    expect(await context!.app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: baseline.version })
    stages.push(stage)

    stage = 'install-and-register-controlled-plugin'
    cpSync(join(root, 'e2e-tests', 'fixtures', 'windows-startup'), source, { recursive: true })
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({
      schemaVersion: 3, trust: 'full', id: pluginId, name: 'Installer acceptance', version: '1.0.0', publisher: 'KnowBook E2E',
      entries: { service: 'service.cjs' }, background: { mode: 'detached', autoStart: true }, fullAccess: true,
      riskDeclarations: ['node', 'filesystem', 'background-service', 'os-persistence']
    } satisfies SystemPluginV3Manifest))
    await context!.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
    }, source)
    const review = await context!.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    if (!review) throw new Error('Controlled plugin review missing.')
    await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
      requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256, decision: 'confirm', acknowledgeSystemAccess: true
    }), { id: review.id, pluginId, artifactSha256: review.artifactSha256 })
    await close(); await launch(); await ready(baseline.version)
    const startup = await context!.page.evaluate((id) => window.knowbook.requestSystemPluginOsPersistence({ pluginId: id }), pluginId)
    await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginOsPersistence({
      recordId: input.id, pluginId: input.pluginId, revisionHash: input.revisionHash, decision: 'confirm', acknowledgeSystemStartup: true
    }), { id: startup.id, pluginId, revisionHash: startup.revisionHash })
    const registeredRunValue = registryValue('Run', serviceId)
    expect(registeredRunValue).toContain(executable)
    writeFileSync(retainedDataPath, retainedData)
    stages.push(stage)

    stage = 'upgrade-through-real-electron-updater'
    const preUpgradeServicePid = servicePid!
    const preUpgradeHostPid = await context!.app.evaluate(() => process.pid)
    expect(processAlive(preUpgradeServicePid)).toBe(true)
    await context!.app.evaluate(async ({ app }, url) => {
      const { createRequire } = process.getBuiltinModule('node:module')!
      const require = createRequire(`${app.getAppPath()}/package.json`)
      const { autoUpdater } = require('electron-updater')
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.disableDifferentialDownload = true
      autoUpdater.setFeedURL({ provider: 'generic', url })
      const result = await autoUpdater.checkForUpdates()
      await result.downloadPromise
    }, `http://127.0.0.1:${address.port}/`)
    await context!.app.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('node:module')!
      createRequire(`${app.getAppPath()}/package.json`)('electron-updater').autoUpdater.quitAndInstall(true, false)
    }).catch(() => undefined)
    // The Windows cmd launcher can outlive Electron, so Playwright's close
    // event does not establish whether the real updater has released the exe.
    await expect.poll(() => processAlive(preUpgradeHostPid), { timeout: 60_000 }).toBe(false)
    await expect.poll(() => installedVersion(installDirectory), { timeout: 60_000 }).toBe(upgrade.version)
    await expect.poll(() => processAlive(preUpgradeServicePid), { timeout: 15_000 }).toBe(false)
    expect(registryValue('Run', serviceId)).toBe(registeredRunValue)
    expect(readFileSync(retainedDataPath, 'utf8')).toBe(retainedData)
    snapshots.push({ stage, preUpgradeHostPid, preUpgradeServicePid, oldHostStoppedDuringUpgrade: true, oldServiceStoppedDuringUpgrade: true, preservedRunValue: registeredRunValue, retainedData })
    // Release only the stale Playwright connection/launcher after both owned
    // executable processes have independently been observed as stopped.
    await close()
    await launch(); await ready(upgrade.version)
    expect(servicePid).not.toBe(preUpgradeServicePid)
    expect(`sha256:${(await state())?.currentArtifactSha256}`).toBe(startup.revisionHash)
    expect(registryValue('Run', serviceId)).toContain(executable)
    stages.push(stage)

    stage = 'rollback-through-baseline-installer'
    const preRollbackServicePid = servicePid!
    await close()
    expect(processAlive(preRollbackServicePid), 'Closing the host must leave the detached process for the actual installer.').toBe(true)
    await runInstaller(baseline.installer, ['/S', `/D=${installDirectory}`], true)
    await expect.poll(() => processAlive(preRollbackServicePid), { timeout: 15_000 }).toBe(false)
    expect(registryValue('Run', serviceId)).toBe(registeredRunValue)
    expect(readFileSync(retainedDataPath, 'utf8')).toBe(retainedData)
    snapshots.push({ stage, preRollbackServicePid, serviceSurvivedHelperClose: true, oldServiceStoppedByInstaller: true, retainedData })
    await launch(); await ready(baseline.version)
    expect(servicePid).not.toBe(preRollbackServicePid)
    expect(registryValue('Run', serviceId)).toContain(executable)
    stages.push(stage)

    stage = 'uninstall-application-retain-user-data'
    await close()
    expect(processAlive(servicePid!), 'The actual uninstaller must clean the detached process left by the host.').toBe(true)
    await uninstall(installDirectory)
    await expect.poll(() => existsSync(executable), { timeout: 60_000 }).toBe(false)
    await expect.poll(() => registryValue('Run', serviceId)).toBeNull()
    expect(registryValue('Explorer\\StartupApproved\\Run', serviceId)).toBeNull()
    expect(servicePid ? processAlive(servicePid) : false).toBe(false)
    const report = JSON.parse(readFileSync(join(profile, 'system-plugin-uninstall-cleanup.json'), 'utf8'))
    expect(report.status).toBe('passed')
    expect(existsSync(join(profile, 'storage', 'knowbook.db'))).toBe(true)
    expect(readFileSync(retainedDataPath, 'utf8')).toBe(retainedData)
    snapshots.push({ stage, report })
    stages.push(stage)

    stage = 'reinstall-preserved-data-then-delete-data-uninstall'
    await runInstaller(baseline.installer, ['/S', `/D=${installDirectory}`], true)
    await launch()
    expect((await state())?.status).toBe('disabled')
    expect(registryValue('Run', serviceId)).toBeNull()
    expect(readFileSync(retainedDataPath, 'utf8')).toBe(retainedData)
    await close()
    await uninstall(installDirectory, true)
    await expect.poll(() => existsSync(profile), { timeout: 60_000 }).toBe(false)
    await expect.poll(() => existsSync(executable), { timeout: 60_000 }).toBe(false)
    expect(installerRegistration(fixture.id)).toBe(false)
    didInstall = false
    stages.push(stage)
  } catch (error) {
    failure = error
    if (context) {
      snapshots.push({ stage, failureState: await state().catch((inspectionError) => ({ inspectionError: String(inspectionError) })) })
    }
    throw error
  }
  finally {
    const cleanupErrors: string[] = []
    try { await close() } catch (error) { cleanupErrors.push(String(error)) }
    if (didInstall) cleanupErrors.push('Fixture installation retained for inspection; no installer is restarted after an unverified failure.')
    await new Promise<void>((settle) => server.close(() => settle()))
    // Keep all paths and registration evidence on failure; never hide a failed
    // uninstaller by manually deleting the fixture's registry or program files.
    if (!failure && !cleanupErrors.length) rmSync(folder, { recursive: true, force: true })
    writeFileSync(testInfo.outputPath('windows-installer-evidence.json'), JSON.stringify({
      scenario: 'isolated-nsis-updater-upgrade-rollback-uninstall', fixture, installDirectory, profile,
      completedStages: stages, snapshots, failedStage: failure ? stage : null,
      failure: failure ? String(failure) : null, cleanupErrors
    }, null, 2))
    if (!failure && cleanupErrors.length) throw new Error(cleanupErrors.join('\n'))
  }
})

function runInstaller(executable: string, args: string[], verbatim = false): Promise<void> {
  return new Promise((resolve, reject) => {
    // NSIS /D is the last, unquoted remainder of the command line by design.
    const child = spawn(executable, args, { windowsHide: true, windowsVerbatimArguments: verbatim, stdio: 'ignore' })
    const timer = setTimeout(() => reject(new Error(`Installer timeout; inspect live PID ${child.pid}.`)), 90_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Installer exit ${code}`)) })
  })
}
async function uninstall(directory: string, deleteData = false) {
  const name = readdirSync(directory).find((item) => /^Uninstall .+\.exe$/.test(item))
  if (!name) throw new Error('Fixture NSIS uninstaller is missing.')
  await runInstaller(join(directory, name), ['/S', ...(deleteData ? ['--delete-app-data'] : [])])
}
function registryValue(suffix: string, name: string): string | null {
  const request = Buffer.from(JSON.stringify({ key: `Software\\Microsoft\\Windows\\CurrentVersion\\${suffix}`, name }), 'utf8').toString('base64')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}')) | ConvertFrom-Json`,
    '$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($request.key)',
    'if ($null -eq $key) { exit 3 }',
    'try { $value = $key.GetValue($request.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if ($null -eq $value) { exit 3 }; ConvertTo-Json -InputObject $value -Compress } finally { $key.Dispose() }'
  ].join('; ')
  try {
    const result: unknown = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe']
    }))
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) { if ((error as { status?: number }).status === 3) return null; throw error }
}
function installerRegistration(id: string): boolean { return registryValue(`Uninstall\\${id}`, 'DisplayName') !== null }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
function installedVersion(directory: string): string | null {
  try {
    const archive = join(directory, 'resources', 'app.asar')
    if (!existsSync(archive)) return null
    // A fresh read-only process avoids ASAR's cache across installer replacements.
    // The archive can briefly disappear during atomic replacement; retry quietly.
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {extractFile} from '@electron/asar'; process.stdout.write(extractFile(process.argv[1], 'package.json'))`, archive], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe']
    })).version
  } catch { return null }
}
