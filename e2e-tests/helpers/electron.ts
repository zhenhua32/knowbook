import { expect, type Page } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ElectronAppContext = {
  app: ElectronApplication
  page: Page
  tempRoot: string
}

export type ElectronLaunchOptions = {
  /** Reuse a prior isolated user-data root to exercise restart-only behavior. */
  userDataRoot?: string
  /** Replay a registered startup command, without inheriting its original profile env. */
  startupArgs?: string[]
}

export type ElectronCloseOptions = {
  /** Keep the isolated user-data root for a deliberate relaunch in the same test. */
  preserveUserData?: boolean
  /** A detached-service acceptance must keep intentional children alive across host exit. */
  preserveDetachedChildren?: boolean
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const builtMainEntry = join(repoRoot, 'out', 'main', 'index.cjs')
const electronHostPids = new WeakMap<ElectronApplication, number>()
// Playwright disposes its application channel after exit, so app.process()
// cannot be used later to retrieve the launcher for teardown or diagnostics.
const electronChildProcesses = new WeakMap<ElectronApplication, ChildProcess>()

export function hasBuiltElectronApp(): boolean {
  // An explicitly requested packaged app must fail loudly if missing, rather
  // than letting every acceptance test pass as skipped.
  return Boolean(getElectronLaunchTarget().executablePath) || existsSync(builtMainEntry)
}

export function getElectronLaunchTarget(executable = process.env.KNOWBOOK_E2E_EXECUTABLE): {
  executablePath?: string
  args: string[]
  cwd: string
} {
  const args = ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
  if (executable?.trim()) {
    const executablePath = resolve(repoRoot, executable.trim())
    if (!existsSync(executablePath) || !statSync(executablePath).isFile()) {
      throw new Error(`Packaged KnowBook executable is missing: ${executablePath}`)
    }
    return { executablePath, args, cwd: repoRoot }
  }
  return { args: [...args, '.'], cwd: repoRoot }
}

export function uiText(en: string, zh: string): RegExp {
  return new RegExp(`^(?:${escapeForRegExp(en)}|${escapeForRegExp(zh)})$`, 'i')
}

export async function ensureDocumentMetadataEditor(page: Page): Promise<void> {
  const titleInput = page.locator('.document-summary-card .editor-input').first()
  const summaryInput = page.locator('.document-summary-card .editor-textarea').first()
  if (!await summaryInput.isVisible().catch(() => false)) {
    const editButton = page.locator('.document-summary-edit-button')
    await expect(editButton).toBeVisible()
    await editButton.click()
  }
  await expect(titleInput).toBeVisible()
  await expect(summaryInput).toBeVisible()
}

/** Wait for committed built-in renderers before a fixture can reload their first page. */
export async function waitForBuiltinPluginReadiness(
  { app, page }: Pick<ElectronAppContext, 'app' | 'page'>,
  { freshProfile = false, safeMode = false }: { freshProfile?: boolean; safeMode?: boolean } = {}
) {
  const rendererPid = await app.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
  ))
  const readState = () => page.evaluate(async () => {
    const plugins = (await window.knowbook.listSystemPlugins())
      .filter(plugin => plugin.pluginId === 'theme-switcher' || plugin.pluginId === 'document-translator')
    const registry = window.knowbookFullTrust
    const contributions = [
      { pluginId: 'theme-switcher', slot: 'settings.sections', contributionId: 'theme-switcher-settings' },
      { pluginId: 'document-translator', slot: 'documents.header.menu', contributionId: 'translate-document' }
    ].map(({ pluginId, slot, contributionId }) => ({
      pluginId,
      entries: registry?.getSlotContributions(slot as 'settings.sections' | 'documents.header.menu')
        .filter(contribution => contribution.plugin.id === pluginId)
        .map(contribution => ({ id: contribution.id, plugin: contribution.plugin })),
      contributionId
    }))
    return { plugins, contributions, activating: registry?.currentPlugin ?? null }
  })
  let state: Awaited<ReturnType<typeof readState>> | undefined
  try {
    await expect.poll(async () => {
      state = await readState()
      if (state.plugins.length !== 2 || state.activating) return false
      return state.contributions.every(({ pluginId, entries, contributionId }) => {
        const plugin = state!.plugins.find(plugin => plugin.pluginId === pluginId)
        if (!plugin || plugin.source !== 'builtin' || !entries) return false
        if (freshProfile && (plugin.lastError !== null || !plugin.enabled || plugin.safeModeDisabled || plugin.status === 'failed')) {
          throw new Error(`Fresh built-in plugin failed: ${pluginId}`)
        }
        // Safe boot registers artifacts without executing them. A preserved opt-out
        // remains disabled; neither case should be repaired by this read-only barrier.
        if (safeMode || (!freshProfile && (!plugin.enabled || plugin.safeModeDisabled))) {
          if (plugin.runtimeStatus !== null || entries.length !== 0) return false
          if (!safeMode && plugin.status !== 'disabled' && plugin.status !== 'safe-mode-disabled') return false
          if (!freshProfile) return true
          const hash = plugin.pendingArtifactSha256 ?? plugin.currentArtifactSha256
          return Boolean(hash && plugin.availablePackages.some(record => record.artifactSha256 === hash && record.status === 'ready'))
        }
        if (!plugin.enabled || plugin.safeModeDisabled || plugin.status !== 'active' || plugin.runtimeStatus !== 'active'
          || !plugin.currentArtifactSha256 || plugin.pendingArtifactSha256 !== null) return false
        const record = plugin.availablePackages.find(record => record.artifactSha256 === plugin.currentArtifactSha256 && record.status === 'ready')
        return Boolean(record && plugin.recentRuns.some(run => run.component === 'renderer' && run.packageId === record.packageId
          && run.status === 'ready' && run.readyAt && run.stoppedAt === null && run.error === null && run.pid === rendererPid)
          && entries.some(entry => entry.id === contributionId && entry.plugin.revisionHash === `sha256:${plugin.currentArtifactSha256}`))
      })
    }, { timeout: 30_000, message: 'Both built-in plugins must commit before the fixture can reload' }).toBe(true)
    return { rendererPid, ...state! }
  } catch (error) {
    throw new Error(`Built-in startup readiness failed.\n${JSON.stringify({ rendererPid, freshProfile, safeMode, state }, null, 2)}\n${String(error)}`, { cause: error })
  }
}

export async function launchElectronApp(
  extraEnv: Record<string, string> = {},
  options: ElectronLaunchOptions = {}
): Promise<ElectronAppContext> {
  const target = getElectronLaunchTarget(extraEnv.KNOWBOOK_E2E_EXECUTABLE ?? process.env.KNOWBOOK_E2E_EXECUTABLE)
  const tempRoot = options.userDataRoot ?? mkdtempSync(join(tmpdir(), 'knowbook-e2e-'))
  const freshProfile = !existsSync(join(tempRoot, 'storage', 'knowbook.db'))
  const restoredSafeMode = existsSync(join(tempRoot, 'database-restore-safe-mode.json'))
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...extraEnv,
    APPDATA: tempRoot,
    LOCALAPPDATA: tempRoot,
    KNOWBOOK_ALLOW_PRIVATE_WEB_CLIP: '1',
    KNOWBOOK_DISABLE_HARDWARE_ACCELERATION: '1',
    KNOWBOOK_E2E_EPHEMERAL_CREDENTIAL_STORAGE: '1',
    KNOWBOOK_E2E_BACKGROUND: '1',
    KNOWBOOK_USER_DATA_DIR: tempRoot
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  if (options.startupArgs) {
    target.args.push(...options.startupArgs)
    delete env.KNOWBOOK_USER_DATA_DIR
  }
  let app: ElectronApplication | undefined
  let childProcess: ChildProcess | undefined
  let startupOutput = ''
  const captureStartupOutput = (chunk: Buffer | string) => {
    startupOutput = (startupOutput + String(chunk)).slice(-16_000)
  }
  try {
    // Keep CI and local runs independent of the operating system language.
    // Override explicitly when checking the other supported UI language.
    app = await electron.launch({ ...target, env, locale: process.env.PLAYWRIGHT_ELECTRON_LOCALE ?? 'en-US' })
    childProcess = app.process()
    electronChildProcesses.set(app, childProcess)
    electronHostPids.set(app, await readElectronHostPid(app, childProcess))
    childProcess.stdout?.on('data', captureStartupOutput)
    childProcess.stderr?.on('data', captureStartupOutput)

    const page = await app.firstWindow()
    page.on('console', (message) => console.error(`[renderer:${message.type()}] ${message.text()}`))
    page.on('pageerror', (error) => console.error('[renderer:pageerror]', error))
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="shell"]')).toBeVisible()
    // Emulate renderer focus through CDP while the native window stays hidden.
    const backgroundSession = await page.context().newCDPSession(page)
    await backgroundSession.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const nativeWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
    if (nativeWindows.some(window => window.visible || window.focused || window.focusable)) {
      throw new Error(`Electron tests must remain in the background: ${JSON.stringify(nativeWindows)}`)
    }
    await waitForBuiltinPluginReadiness({ app, page }, {
      freshProfile, safeMode: restoredSafeMode || env.KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE === '1'
    })
    childProcess.stdout?.off('data', captureStartupOutput)
    childProcess.stderr?.off('data', captureStartupOutput)

    return { app, page, tempRoot }
  } catch (error) {
    const processState = childProcess ? {
      pid: childProcess.pid, exitCode: childProcess.exitCode, signalCode: childProcess.signalCode
    } : null
    let appState: unknown = null
    if (app) {
      let timer: NodeJS.Timeout | undefined
      appState = await Promise.race([
        app.evaluate(({ app, BrowserWindow }) => ({
          ready: app.isReady(), pid: process.pid, userData: app.getPath('userData'), argv: process.argv,
          runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
          windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, url: window.webContents.getURL() }))
        })).catch(cause => ({ error: String(cause) })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 2_000) })
      ])
      if (timer) clearTimeout(timer)
    }
    if (app) {
      await closeElectronApp({ app, tempRoot }, { preserveUserData: Boolean(options.userDataRoot) })
    } else if (!options.userDataRoot) {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    if (error instanceof Error && app) {
      throw new Error(`${error.message}\nElectron startup state: ${JSON.stringify(processState)}\nElectron app state: ${JSON.stringify(appState)}\n${startupOutput}`, { cause: error })
    }
    throw error
  }
}

export async function closeElectronApp(
  context: Pick<ElectronAppContext, 'app' | 'tempRoot'> | null,
  options: ElectronCloseOptions = {}
): Promise<void> {
  if (!context) {
    return
  }

  const childProcess = electronChildProcesses.get(context.app) ?? context.app.process()
  // On Windows Playwright launches Electron through a cmd wrapper. In the
  // explicit detached case, killing that wrapper alone leaves the real host.
  const hostPid = electronHostPids.get(context.app)
    ?? await context.app.evaluate(() => process.pid).catch(() => undefined)
  let closeTimer: NodeJS.Timeout | undefined
  const closedGracefully = await Promise.race([
    context.app.close().then(() => true, () => false),
    new Promise<boolean>((resolve) => {
      closeTimer = setTimeout(() => resolve(false), 5_000)
    })
  ])
  if (closeTimer) {
    clearTimeout(closeTimer)
  }

  if (hostPid && closedGracefully) await waitForProcessExit(hostPid, 1_000)
  const hostStillAlive = hostPid ? processIsAlive(hostPid)
    : childProcess.exitCode === null && childProcess.signalCode === null
  if (hostStillAlive) {
    console.warn(`Electron E2E host ${String(hostPid ?? childProcess.pid)} exceeded graceful close; forcing ${options.preserveDetachedChildren ? 'host only' : 'owned process tree'}.`)
    if (process.platform === 'win32') {
      // Limit forced cleanup to this exact launched host and its children. Never
      // select by executable name: other isolated E2Es may use the same build.
      if (!hostPid) {
        throw new Error('Cannot identify the launched Electron host for exact process cleanup; keeping its profile.')
      }
      const killArgs = options.preserveDetachedChildren
        ? ['/pid', String(hostPid), '/F']
        : ['/pid', String(hostPid), '/T', '/F']
      spawnSync('taskkill.exe', killArgs, {
        windowsHide: true, stdio: 'ignore', timeout: 10_000
      })
    } else {
      if (hostPid) process.kill(hostPid, 'SIGKILL')
      else childProcess.kill('SIGKILL')
    }
    if (hostPid) await waitForProcessExit(hostPid, 10_000)
  }

  if (hostPid && processIsAlive(hostPid)) {
    throw new Error(`Electron E2E host ${String(hostPid)} did not exit; keeping its profile for diagnosis.`)
  }
  // A cmd wrapper exit is not evidence of Electron exit. Once the actual host
  // is gone, release a surviving wrapper without selecting any child process.
  if (childProcess.exitCode === null && childProcess.signalCode === null) childProcess.kill('SIGKILL')
  electronHostPids.delete(context.app)

  if (context.tempRoot && !options.preserveUserData) {
    rmSync(context.tempRoot, {
      recursive: true,
      force: true,
      // Chromium can release DIPS/SQLite handles shortly after the host exits.
      maxRetries: 20,
      retryDelay: 100
    })
  }
}

async function readElectronHostPid(app: ElectronApplication, child: ChildProcess): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await app.evaluate(() => process.pid)
    } catch (error) {
      // The inspector can replace its initial execution context during startup.
      // Retry only that exact transient failure, never a closed/crashed host or
      // an unrelated evaluation error. The wrapper PID is still not a host PID.
      if (!(error instanceof Error)
        || error.message !== 'electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.'
        || attempt >= 4 || child.exitCode !== null || child.signalCode !== null) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export async function withElectronApp(
  run: (context: ElectronAppContext) => Promise<void>,
  extraEnv: Record<string, string> = {}
): Promise<void> {
  const context = await launchElectronApp(extraEnv)
  try {
    await run(context)
  } finally {
    await closeElectronApp(context)
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
