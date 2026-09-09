import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import type { SystemPluginOsPersistenceRecord } from '../src/shared/system-plugin-state'
import { quoteWindowsLoginArgument } from '../src/main/system-plugin/windows-login-command'
import { closeElectronApp, launchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const approvalKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
type ServiceState = { pid: number; ticks: number; successes: number; failures: number; lastRpcAt: number | null; paths: { userData: string } | null }

// Opt-in packaged Windows acceptance: creates a unique real HKCU login item,
// replays its command, and removes it. It never logs out or reboots the machine.
test('restores a detached service through a real Windows login item and cleans up on uninstall @windows-startup', async ({}, testInfo) => {
  test.setTimeout(180_000)
  expect(process.platform).toBe('win32')
  expect(process.env.KNOWBOOK_E2E_EXECUTABLE, 'Run npm run test:packaged-windows-startup.').toBeTruthy()
  const pluginId = `system.e2e.startup-${randomUUID()}`
  const serviceId = `knowbook.${pluginId}`
  const source = mkdtempSync(join(tmpdir(), 'knowbook-startup-source-'))
  const profile = mkdtempSync(join(tmpdir(), 'knowbook 登录 工作区 '))
  const dataRoot = join(profile, 'system-plugins', 'data', pluginId)
  const reportPath = join(dataRoot, 'service-state.json')
  const completedStages: string[] = []
  const snapshots: unknown[] = []
  const ownedPids = new Set<number>()
  let context: ElectronAppContext | null = null
  let registration: SystemPluginOsPersistenceRecord | null = null
  let stage = 'install-controlled-detached-service'
  let failure: unknown
  let mayOwnLoginItem = false
  const service = () => JSON.parse(readFileSync(reportPath, 'utf8')) as ServiceState
  const state = () => context!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === id) ?? null, pluginId)
  const launch = async (startupArgs?: string[]) => {
    context = await launchElectronApp({}, { userDataRoot: profile, startupArgs })
    await context.app.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
    })
    expect(await context.app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
  }
  const close = async () => {
    await closeElectronApp(context, { preserveUserData: true, preserveDetachedChildren: true })
    context = null
  }
  const ready = async () => {
    await expect.poll(async () => {
      const plugin = await state()
      return { status: plugin?.status, error: plugin?.lastError }
    }, { timeout: 30_000 }).toEqual({ status: 'active', error: null })
    await expect.poll(() => existsSync(reportPath) ? service().successes : 0).toBeGreaterThan(0)
    ownedPids.add(service().pid)
    expect(service().paths?.userData).toBe(profile)
  }
  const requestStartup = async () => {
    registration = await context!.page.evaluate((id) => window.knowbook.requestSystemPluginOsPersistence({ pluginId: id }), pluginId)
    expect(registration.status).toBe('awaiting-confirmation')
    expect(registration.serviceId).toBe(serviceId)
    return registration
  }
  const queryLogin = () => context!.app.evaluate(({ app }, command) => app.getLoginItemSettings({ path: command.executable, args: command.args }), {
    executable: registration!.command.executable, args: registration!.command.args.map(quoteWindowsLoginArgument)
  })
  const confirmStartupInUi = async () => {
    await context!.page.locator('button.nav-icon-btn').and(context!.page.getByTitle(uiText('Plugins', '插件中心'))).first().click()
    const card = context!.page.locator('.system-plugin-request').filter({ has: context!.page.locator('.plugin-item-head', { hasText: pluginId }) })
    const confirm = card.getByRole('button', { name: uiText('Confirm login startup', '确认登录启动') })
    await expect(confirm).toBeDisabled()
    await card.locator('.system-plugin-acknowledgement input').check()
    await card.locator('.plugin-field input').fill('wrong-id')
    await expect(confirm).toBeDisabled()
    await card.locator('.plugin-field input').fill(pluginId)
    mayOwnLoginItem = true
    await confirm.click()
    await expect.poll(async () => (await state())?.osPersistence?.status).toBe('registered')
    const login = await queryLogin()
    // Electron 35 also reports openAtLogin=false for these switch arguments;
    // the exact Run value plus enabled per-user item are authoritative here.
    expect(login.executableWillLaunchAtLogin).toBe(true)
    expect(login.launchItems?.filter((item) => item.name === serviceId)).toEqual([
      { name: serviceId, path: registration!.command.executable, args: [], scope: 'user', enabled: true }
    ])
    const rawCommand = readRunCommand(serviceId)
    expect(rawCommand).toContain(profile)
    expect(parseWindowsCommandLine(rawCommand!)).toEqual([registration!.command.executable, ...registration!.command.args])
    snapshots.push({ stage, registration: (await state())?.osPersistence, login, rawCommand })
  }
  try {
    expect(readRunCommand(serviceId)).toBeNull()
    expect(hasStartupApproval(serviceId)).toBe(false)
    cpSync(join(root, 'e2e-tests', 'fixtures', 'windows-startup'), source, { recursive: true })
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({
      schemaVersion: 3, trust: 'full', id: pluginId, name: 'Windows startup acceptance',
      version: '1.0.0', publisher: 'KnowBook E2E', entries: { service: 'service.cjs' },
      background: { mode: 'detached', autoStart: true }, fullAccess: true,
      riskDeclarations: ['node', 'filesystem', 'background-service', 'os-persistence']
    } satisfies SystemPluginV3Manifest, null, 2))
    await launch()
    expect(await context!.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await context!.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
    }, source)
    const request = await context!.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    expect(request?.status).toBe('awaiting-confirmation')
    if (!request) throw new Error('Expected a controlled install request.')
    await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
      requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256,
      acknowledgeSystemAccess: true, decision: 'confirm'
    }), { id: request.id, pluginId: request.pluginId, artifactSha256: request.artifactSha256 })
    expect(existsSync(reportPath)).toBe(false)
    await close()
    await launch()
    await ready()
    completedStages.push(stage)

    stage = 'independent-login-confirmation-and-cancellation'
    const cancelled = await requestStartup()
    expect(readRunCommand(serviceId)).toBeNull()
    const resolveInput = { recordId: cancelled.id, pluginId, revisionHash: cancelled.revisionHash }
    const rejected = await context!.page.evaluate(async (input) => {
      try {
        await window.knowbook.resolveSystemPluginOsPersistence({ ...input, decision: 'confirm', acknowledgeSystemStartup: false })
        return false
      } catch { return true }
    }, resolveInput)
    expect(rejected).toBe(true)
    expect(readRunCommand(serviceId)).toBeNull()
    await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginOsPersistence({ ...input, decision: 'cancel', acknowledgeSystemStartup: false }), resolveInput)
    expect((await state())?.osPersistence?.status).toBe('cancelled')
    expect(readRunCommand(serviceId)).toBeNull()
    await requestStartup()
    await confirmStartupInUi()
    completedStages.push(stage)

    stage = 'host-exit-keeps-detached-process-running'
    const original = service()
    const originalRun = (await state())!.recentRuns.find((run) => run.component === 'detached')!
    await close()
    expect(isAlive(original.pid)).toBe(true)
    await expect.poll(() => service().ticks).toBeGreaterThan(original.ticks + 3)
    await expect.poll(() => service().failures).toBeGreaterThan(original.failures)
    snapshots.push({ stage, service: service() })
    completedStages.push(stage)

    stage = 'replay-registered-command-without-profile-environment'
    const offline = service()
    const relaunchTime = Date.now()
    // Replay argv decoded by the real Windows CommandLineToArgvW parser.
    // The launch helper adds only headless-test Chromium flags; profile env is absent.
    await launch(parseWindowsCommandLine(readRunCommand(serviceId)!).slice(1))
    await ready()
    expect(await context!.app.evaluate(() => process.env.KNOWBOOK_USER_DATA_DIR)).toBeUndefined()
    await expect.poll(() => service().lastRpcAt ?? 0, { timeout: 20_000 }).toBeGreaterThan(relaunchTime)
    expect(service().successes).toBeGreaterThan(offline.successes)
    expect(service().pid).toBe(original.pid)
    const adopted = (await state())!.recentRuns.find((run) => run.component === 'detached')!
    expect(adopted.id).toBe(originalRun.id)
    expect(adopted.health).toMatchObject({ adopted: true, rpcConnected: true })
    expect((await state())?.osPersistence?.status).toBe('registered')
    snapshots.push({ stage, service: service(), adopted })
    completedStages.push(stage)

    stage = 'stop-and-restart-adopted-service'
    await context!.page.evaluate((id) => window.knowbook.stopSystemPluginService({ pluginId: id }), pluginId)
    await expect.poll(() => isAlive(original.pid)).toBe(false)
    await context!.page.evaluate((id) => window.knowbook.startSystemPluginService({ pluginId: id }), pluginId)
    await expect.poll(() => service().pid).not.toBe(original.pid)
    await ready()
    snapshots.push({ stage, service: service() })
    completedStages.push(stage)

    stage = 'remove-and-register-login-item-again'
    await context!.page.evaluate((id) => window.knowbook.removeSystemPluginOsPersistence({ pluginId: id }), pluginId)
    expect(readRunCommand(serviceId)).toBeNull()
    expect((await queryLogin()).launchItems?.some((item) => item.name === serviceId)).toBe(false)
    await requestStartup()
    await confirmStartupInUi()
    // A new review in the same mounted UI must not reuse the previous checkbox
    // or typed plugin id, even though persistence reuses its database record id.
    await context!.page.evaluate((id) => window.knowbook.removeSystemPluginOsPersistence({ pluginId: id }), pluginId)
    await requestStartup()
    await confirmStartupInUi()
    completedStages.push(stage)

    stage = 'uninstall-removes-login-item-service-and-files'
    const finalPid = service().pid
    await context!.page.evaluate((id) => window.knowbook.uninstallSystemPlugin({ pluginId: id }), pluginId)
    expect(readRunCommand(serviceId)).toBeNull()
    expect(hasStartupApproval(serviceId)).toBe(false)
    await expect.poll(() => isAlive(finalPid)).toBe(false)
    await close()
    await launch(registration!.command.args)
    expect(await state()).toBeNull()
    for (const directory of ['artifacts', 'runtime']) {
      const parent = join(profile, 'system-plugins', directory, pluginId)
      // The manager removes owned revisions; their empty grouping folder may remain.
      expect(existsSync(parent) ? readdirSync(parent) : [], directory).toEqual([])
    }
    for (const directory of ['data', 'logs']) {
      expect(existsSync(join(profile, 'system-plugins', directory, pluginId))).toBe(false)
    }
    expect(readRunCommand(serviceId)).toBeNull()
    completedStages.push(stage)
  } catch (error) {
    failure = error
    if (context) snapshots.push({ stage, plugin: await state().catch(String) })
    if (context && registration) snapshots.push({ stage, login: await queryLogin().catch(String), rawCommand: readRunCommand(serviceId) })
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    // Never remove a pre-existing or replaced registration. Only this test's UUID
    // entry containing its unique profile may be removed by the fallback.
    try {
      const command = readRunCommand(serviceId)
      if (command && mayOwnLoginItem) {
        if (!command.includes(profile) || !command.includes(pluginId)) throw new Error('Refusing to clean a replaced test login item.')
        execFileSync('reg.exe', ['delete', runKey, '/v', serviceId, '/f'], { windowsHide: true, stdio: 'pipe' })
      }
      expect(readRunCommand(serviceId)).toBeNull()
      if (mayOwnLoginItem && hasStartupApproval(serviceId)) {
        execFileSync('reg.exe', ['delete', approvalKey, '/v', serviceId, '/f'], { windowsHide: true, stdio: 'pipe' })
      }
    } catch (error) { cleanupErrors.push(error) }
    try { await close() } catch (error) { cleanupErrors.push(error) }
    try {
      if (existsSync(reportPath)) ownedPids.add(service().pid)
      if (existsSync(dataRoot)) writeFileSync(join(dataRoot, 'stop-fixture'), '')
      for (const pid of ownedPids) await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false)
    } catch (error) { cleanupErrors.push(error) }
    try {
      // These directories came directly from mkdtemp; leave a failed service's
      // stop marker intact if process cleanup could not be verified.
      if (!cleanupErrors.length) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      rmSync(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) { cleanupErrors.push(error) }
    const evidencePath = testInfo.outputPath('windows-startup-evidence.json')
    writeFileSync(evidencePath, JSON.stringify({
      scenario: 'packaged-windows-login-item-and-detached-adoption', pluginId, serviceId,
      profile, completedStages, snapshots, realOsLoginOrReboot: false,
      failedStage: failure ? stage : null, failure: failure ? String(failure) : null,
      cleanupErrors: cleanupErrors.map(String)
    }, null, 2))
    await testInfo.attach('windows-startup-evidence', { path: evidencePath, contentType: 'application/json' })
    if (!failure && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Windows startup acceptance cleanup failed.')
  }
})

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function hasStartupApproval(serviceId: string): boolean {
  const result = spawnSync('reg.exe', ['query', approvalKey, '/v', serviceId], { windowsHide: true, stdio: 'pipe' })
  if (result.error) throw result.error
  if (result.status !== 0 && result.status !== 1) throw new Error('Cannot query test startup approval.')
  return result.status === 0
}

function readRunCommand(serviceId: string): string | null {
  if (!/^knowbook\.system\.e2e\.startup-[a-f0-9-]+$/.test(serviceId)) throw new Error('Unexpected test service ID.')
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
try { if ($key) { $value = $key.GetValue('${serviceId}', $null); if ($null -ne $value) { ConvertTo-Json -Compress -InputObject $value } } } finally { if ($key) { $key.Dispose() } }`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Cannot read Windows login item: ${result.stderr}`)
  return result.stdout.trim() ? JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as string : null
}

function parseWindowsCommandLine(command: string): string[] {
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StartupCommandParser {
  [DllImport("shell32.dll", SetLastError = true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Parse(string command) {
    int count; IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new Exception("CommandLineToArgvW failed");
    try {
      var args = new string[count];
      for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return args;
    } finally { LocalFree(memory); }
  }
}
'@
$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command, 'utf8').toString('base64')}'))
ConvertTo-Json -Compress -InputObject ([StartupCommandParser]::Parse($command))`
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: 'pipe' })
  return JSON.parse(result.replace(/^\uFEFF/, '').trim()) as string[]
}
