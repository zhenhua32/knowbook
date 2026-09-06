import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import { executeSystemPluginDependencyTasks } from '../src/main/system-plugin/dependency-runner'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const nodeGyp = createRequire(require.resolve('app-builder-lib/package.json')).resolve('node-gyp/bin/node-gyp.js')
const pluginId = 'system.e2e.native-rebuild'
const binaryRelativePath = join('build', 'Release', 'abi_probe.node')

interface CompiledEvidence {
  compiledAbi: number
  answer: number
  version: string
  revisionHash: string
  binaryPath: string
  binaryHash: string
  modules: string
  electron: string
  platform: string
  arch: string
  packaged: boolean
}

// Kept separate from @electron: this acceptance requires a C++ toolchain,
// Python and Node/Electron headers. The packaged CI runs it explicitly.
test('native source rebuild rejects a foreign ABI, compiles for Electron and preserves the active revision on compiler failure @native-build', async ({}, testInfo) => {
  test.setTimeout(300_000)
  const source = mkdtempSync(join(tmpdir(), 'knowbook-native-source-'))
  const completedStages: string[] = []
  const evidence: Record<string, unknown> = { completedStages, scenario: 'node-to-electron-source-rebuild' }
  const compilerLogs: string[] = []
  let current: ElectronAppContext | null = null
  let profile: string | undefined
  let stage = 'compile-for-node'
  let failure: unknown
  try {
    cpSync(join(repoRoot, 'e2e-tests', 'fixtures', 'native-rebuild'), source, { recursive: true })
    await executeSystemPluginDependencyTasks({
      rootDirectory: source,
      timeoutMs: 120_000,
      tasks: [{
        execution: 'process', kind: 'build', packageManager: 'none',
        command: [process.execPath, nodeGyp, 'rebuild', `--target=${process.versions.node}`,
          `--arch=${process.arch}`, '--dist-url=https://nodejs.org/download/release']
      }],
      onLog: (event) => compilerLogs.push(event.text)
    })
    const originalBinary = readFileSync(join(source, binaryRelativePath))
    const originalHash = sha256(originalBinary)
    const nodeAddon = JSON.parse(execFileSync(process.execPath, [
      '-e', 'process.stdout.write(JSON.stringify(require(process.argv[1])))', join(source, binaryRelativePath)
    ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })) as { compiledAbi: number; answer: number }
    expect(nodeAddon).toEqual({ compiledAbi: Number(process.versions.modules), answer: 42 })
    evidence.node = { ...nodeAddon, version: process.versions.node, binaryHash: originalHash }
    // Keep the foreign ABI binary in the confirmed artifact, but omit generated
    // build files containing absolute paths to the source compilation directory.
    rmSync(join(source, 'build'), { recursive: true, force: true })
    mkdirSync(join(source, 'build', 'Release'), { recursive: true })
    writeFileSync(join(source, binaryRelativePath), originalBinary)
    writeFileSync(join(source, '.npmrc'), 'offline=true\naudit=false\nfund=false\nforeground-scripts=true\n')
    completedStages.push(stage)

    stage = 'reject-foreign-abi'
    current = await launchElectronApp()
    profile = current.tempRoot
    const hostAbi = await current.app.evaluate(() => process.versions.modules)
    expect(hostAbi, 'This scenario needs genuinely different Node and Electron ABIs.').not.toBe(String(nodeAddon.compiledAbi))
    writeManifest(source, '1.0.0', false)
    const foreign = await prepare(current, source)
    await expect(confirm(current, foreign)).rejects.toThrow(/native module probe/i)
    expect(await state(current), 'A failed first install must not create an enabled installation.').toBeNull()
    const foreignLog = readFileSync(join(profile, 'system-plugins', 'logs', pluginId, `${foreign.artifactSha256}-dependencies.log`), 'utf8')
    compilerLogs.push(foreignLog)
    expect(foreignLog).toContain('NODE_MODULE_VERSION')
    expect(foreignLog).toContain(String(nodeAddon.compiledAbi))
    expect(foreignLog).toContain(hostAbi!)
    evidence.foreignAbiRejected = true
    completedStages.push(stage)

    stage = 'compile-for-electron'
    writeManifest(source, '1.0.0', true)
    const accepted = await prepare(current, source)
    await confirm(current, accepted)
    const pending = (await state(current))!
    expect(pending.status).toBe('pending-restart')
    expect(pending.availablePackages).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactSha256: foreign.artifactSha256, status: 'failed' })
    ]))
    const acceptedPackage = pending.availablePackages.find((item) => item.artifactSha256 === accepted.artifactSha256)!
    const jobs = pending.dependencyJobs.filter((job) => job.packageId === acceptedPackage.packageId)
    expect(jobs).toHaveLength(2)
    expect(jobs.map((job) => job.kind).sort()).toEqual(['install', 'native-rebuild'])
    expect(jobs.every((job) => job.status === 'succeeded')).toBe(true)
    const rebuild = jobs.find((job) => job.kind === 'native-rebuild')!
    expect(rebuild.command).toContain(`--target=${await current.app.evaluate(() => process.versions.electron)}`)
    const compilerLog = readFileSync(rebuild.logPath!, 'utf8')
    compilerLogs.push(compilerLog)
    evidence.jobs = jobs
    expect(rebuild.command).toContain('--foreground-scripts')
    expect(compilerLog).toMatch(/abi-probe\.(?:cc|o)\b/)
    const artifactPath = join(profile, 'system-plugins', 'artifacts', pluginId, accepted.artifactSha256)
    expect(sha256(readFileSync(join(artifactPath, binaryRelativePath)))).toBe(originalHash)
    const marker = join(profile, 'system-plugins', 'data', pluginId, 'compiled-native.json')
    expect(existsSync(marker)).toBe(false)
    completedStages.push(stage)

    stage = 'activate-compiled-binary'
    await closeElectronApp(current, { preserveUserData: true })
    current = null
    current = await launchElectronApp({}, { userDataRoot: profile })
    await expect.poll(async () => (await state(current!))?.status).toBe('active')
    const compiled = JSON.parse(readFileSync(marker, 'utf8')) as CompiledEvidence
    expect(compiled.compiledAbi).toBe(Number(hostAbi))
    expect(compiled.answer).toBe(42)
    expect(compiled.binaryHash).not.toBe(originalHash)
    expect(compiled.revisionHash).toBe(`sha256:${accepted.artifactSha256}`)
    expect(compiled.packaged).toBe(Boolean(process.env.KNOWBOOK_E2E_EXECUTABLE))
    expect(compiled.binaryPath).toBe(realpathSync(join(profile, 'system-plugins', 'runtime', pluginId, accepted.artifactSha256, binaryRelativePath)))
    evidence.electron = compiled
    completedStages.push(stage)

    stage = 'compiler-failure-preserves-active-version'
    writeManifest(source, '2.0.0', true)
    writeFileSync(join(source, 'abi-probe.cc'), '#error KNOWBOOK_CONTROLLED_COMPILER_FAILURE\n')
    const broken = await prepare(current, source)
    await expect(confirm(current, broken)).rejects.toThrow(/dependency command/i)
    const afterFailure = (await state(current))!
    expect(afterFailure).toMatchObject({ status: 'active', currentVersion: '1.0.0', currentArtifactSha256: accepted.artifactSha256 })
    const failedPackage = afterFailure.availablePackages.find((item) => item.artifactSha256 === broken.artifactSha256)!
    expect(failedPackage.status).toBe('failed')
    // The public summary exposes jobs for the current/pending revision. A
    // rejected upgrade has neither role, so inspect its persisted job directly.
    const failedJobs = await readPersistedJobs(current, failedPackage.packageId)
    evidence.failedJobs = failedJobs
    expect(failedJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'native-rebuild', status: 'failed' })
    ]))
    const failedJob = failedJobs.find((job) => job.kind === 'native-rebuild')!
    expect(failedJob.status).toBe('failed')
    const failedLog = readFileSync(failedJob.logPath!, 'utf8')
    compilerLogs.push(failedLog)
    expect(failedLog).toContain('KNOWBOOK_CONTROLLED_COMPILER_FAILURE')
    expect(sha256(readFileSync(compiled.binaryPath))).toBe(compiled.binaryHash)
    evidence.compilerFailurePreservedActiveVersion = true
    completedStages.push(stage)

    stage = 'uninstall'
    await current.page.evaluate((id) => window.knowbook.uninstallSystemPlugin({ pluginId: id }), pluginId)
    await closeElectronApp(current, { preserveUserData: true })
    current = null
    current = await launchElectronApp({}, { userDataRoot: profile })
    expect(await state(current)).toBeNull()
    for (const root of ['artifacts', 'runtime']) {
      for (const hash of [foreign.artifactSha256, accepted.artifactSha256, broken.artifactSha256]) {
        expect(existsSync(join(profile, 'system-plugins', root, pluginId, hash))).toBe(false)
      }
    }
    completedStages.push(stage)
  } catch (error) {
    failure = error
    evidence.failedStage = stage
    evidence.failure = String(error)
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    try {
      if (current) await closeElectronApp(current)
      else if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) { cleanupErrors.push(error) }
    try { rmSync(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    catch (error) { cleanupErrors.push(error) }
    try {
      const evidencePath = testInfo.outputPath('native-rebuild-evidence.json')
      const logsPath = testInfo.outputPath('native-compiler.log')
      writeFileSync(evidencePath, JSON.stringify({ ...evidence, cleanupErrors: cleanupErrors.map(String) }, null, 2))
      writeFileSync(logsPath, compilerLogs.join('\n'))
      await testInfo.attach('native-rebuild-evidence', { path: evidencePath, contentType: 'application/json' })
      await testInfo.attach('native-compiler-log', { path: logsPath, contentType: 'text/plain' })
    } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length && !failure) throw new AggregateError(cleanupErrors, 'Native rebuild acceptance cleanup failed.')
  }
})

function writeManifest(root: string, version: string, rebuildNativeModules: boolean) {
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 3, trust: 'full', id: pluginId, name: 'Native source rebuild', version,
    publisher: 'KnowBook E2E', entries: { main: 'main.cjs' }, fullAccess: true,
    riskDeclarations: ['node', 'npm', 'filesystem'],
    dependencies: { packageManager: 'npm', install: 'ci', allowScripts: false, rebuildNativeModules }
  } satisfies SystemPluginV3Manifest, null, 2))
}

async function state(context: ElectronAppContext) {
  return context.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === id) ?? null, pluginId)
}

async function prepare(context: ElectronAppContext, source: string) {
  await context.app.evaluate(({ dialog }, root) => {
    Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [root] }) })
    Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
  }, source)
  const prepared = await context.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
  if (!prepared) throw new Error('Expected native rebuild install request.')
  return prepared
}

async function confirm(context: ElectronAppContext, request: { id: string; pluginId: string; artifactSha256: string }) {
  return context.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
    requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256,
    acknowledgeSystemAccess: true, decision: 'confirm'
  }), request)
}

function sha256(buffer: Buffer) { return createHash('sha256').update(buffer).digest('hex') }

async function readPersistedJobs(context: ElectronAppContext, packageId: string): Promise<Array<{
  kind: string; status: string; logPath: string; exitCode: number | null
}>> {
  return context.app.evaluate(({ app }, id) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'))
    try {
      return db.prepare('SELECT kind, status, log_path AS logPath, exit_code AS exitCode FROM system_plugin_dependency_jobs WHERE package_id = ?').all(id)
    } finally { db.close() }
  }, packageId)
}
