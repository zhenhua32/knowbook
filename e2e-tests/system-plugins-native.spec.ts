import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SystemPluginV3Manifest } from '../src/shared/system-plugin'
import { closeElectronApp, hasBuiltElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const nativeSource = join(repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
const pluginId = 'system.e2e.native-acceptance'

interface NativeEvidence {
  version: string
  revisionHash: string
  nativePath: string
  nativeSha256: string
  platform: string
  arch: string
  electron: string
  modules: string
  packaged: boolean
  visits: Array<{ version: string }>
  answer: number
}

interface PackageEvidence {
  artifactPath: string
  contentHash: string
  fingerprint: {
    modules: string
    runtimeRoot: string
    nativeModuleProbe: { status: string; moduleCount: number; modules: string[] }
  }
  audits: string[]
}

test.describe('System Plugin native modules @electron', () => {
  test('probes real native binaries, refreshes stale ABI runtimes, upgrades, rolls back and removes all revisions', async ({}, testInfo) => {
    test.setTimeout(180_000)
    test.skip(!hasBuiltElectronApp(), 'Build KnowBook before running native acceptance.')
    const sourceRoot = mkdtempSync(join(tmpdir(), 'knowbook-native-fixture-'))
    const snapshots: NativeEvidence[] = []
    const revisions: string[] = []
    const completedStages: string[] = []
    let stage = 'native-probe'
    let probe: PackageEvidence['fingerprint']['nativeModuleProbe'] | null = null
    let invalidBinaryRejected = false
    let uninstallRemovedAllRevisions = false
    let failure: string | null = null
    let current: ElectronAppContext | null = null
    let profile: string | null = null
    try {
      expect(existsSync(nativeSource), 'Install/rebuild better-sqlite3 for the current Electron ABI.').toBe(true)
      writeNativeFixture(sourceRoot, '1.0.0')
      const originalBinaryHash = sha256(nativeSource)
      current = await launchElectronApp()
      profile = current.tempRoot
      const dataRoot = join(profile, 'system-plugins', 'data', pluginId)
      const marker = join(dataRoot, 'native-evidence.json')
      const first = await prepareNativePlugin(current, sourceRoot)
      revisions.push(first.artifactSha256)
      expect(existsSync(marker)).toBe(false)
      await confirmNativePlugin(current, first)
      expect(existsSync(marker), 'Installing only probes the addon; the Main entry waits for restart.').toBe(false)
      const prepared = await readPackageEvidence(current, first.artifactSha256)
      probe = prepared.fingerprint.nativeModuleProbe
      expect(prepared.fingerprint.nativeModuleProbe).toMatchObject({
        status: 'passed', moduleCount: 1, modules: ['native/better_sqlite3.node']
      })
      expect(sha256(join(prepared.artifactPath, 'native', 'better_sqlite3.node'))).toBe(originalBinaryHash)
      expect(prepared.artifactPath).not.toBe(prepared.fingerprint.runtimeRoot)
      completedStages.push(stage)

      stage = 'initial-activation'
      await closeElectronApp(current, { preserveUserData: true })
      current = null
      current = await launchElectronApp({}, { userDataRoot: profile })
      snapshots.push(await expectNativeActivation(current, marker, first.artifactSha256, ['1.0.0']))
      completedStages.push(stage)

      // Simulate persisted metadata from an older ABI, without claiming a real Electron upgrade.
      stage = 'abi-refresh'
      writeFileSync(join(prepared.fingerprint.runtimeRoot, 'stale-runtime.txt'), 'must be replaced')
      await readPackageEvidence(current, first.artifactSha256, true)
      await closeElectronApp(current, { preserveUserData: true })
      current = null
      current = await launchElectronApp({}, { userDataRoot: profile })
      snapshots.push(await expectNativeActivation(current, marker, first.artifactSha256, ['1.0.0', '1.0.0']))
      const refreshed = await readPackageEvidence(current, first.artifactSha256)
      expect(refreshed.fingerprint.modules).toBe(snapshots[1].modules)
      expect(refreshed.fingerprint.nativeModuleProbe.status).toBe('passed')
      expect(refreshed.audits).toContain('runtime.compatibility-rebuilt')
      expect(existsSync(join(refreshed.fingerprint.runtimeRoot, 'stale-runtime.txt'))).toBe(false)
      expect(sha256(join(refreshed.artifactPath, 'native', 'better_sqlite3.node'))).toBe(originalBinaryHash)
      completedStages.push(stage)

      stage = 'invalid-binary-rejection'
      writeNativeFixture(sourceRoot, '99.0.0', true)
      const invalid = await prepareNativePlugin(current, sourceRoot)
      revisions.push(invalid.artifactSha256)
      await expect(confirmNativePlugin(current, invalid)).rejects.toThrow(/native module probe/i)
      expect(await pluginState(current)).toMatchObject({ status: 'active', currentVersion: '1.0.0' })
      expect((await pluginState(current))?.availablePackages).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactSha256: invalid.artifactSha256, status: 'failed' })
      ]))
      invalidBinaryRejected = true
      completedStages.push(stage)

      stage = 'upgrade'
      writeNativeFixture(sourceRoot, '2.0.0')
      const second = await prepareNativePlugin(current, sourceRoot)
      revisions.push(second.artifactSha256)
      await confirmNativePlugin(current, second)
      await closeElectronApp(current, { preserveUserData: true })
      current = null
      current = await launchElectronApp({}, { userDataRoot: profile })
      snapshots.push(await expectNativeActivation(current, marker, second.artifactSha256, ['1.0.0', '1.0.0', '2.0.0']))
      completedStages.push(stage)

      stage = 'rollback'
      const firstPackage = (await pluginState(current))!.availablePackages.find(
        (candidate) => candidate.artifactSha256 === first.artifactSha256
      )!
      await current.page.evaluate(async ({ pluginId, packageId }) => {
        await window.knowbook.rollbackSystemPlugin({ pluginId, packageId })
      }, { pluginId, packageId: firstPackage.packageId })
      await closeElectronApp(current, { preserveUserData: true })
      current = null
      current = await launchElectronApp({}, { userDataRoot: profile })
      snapshots.push(await expectNativeActivation(current, marker, first.artifactSha256, ['1.0.0', '1.0.0', '2.0.0', '1.0.0']))
      expect(snapshots.every((snapshot) => snapshot.nativeSha256 === originalBinaryHash)).toBe(true)
      completedStages.push(stage)

      stage = 'uninstall'
      await current.page.evaluate(async (id) => {
        await window.knowbook.uninstallSystemPlugin({ pluginId: id })
      }, pluginId)
      expect(await pluginState(current)).toMatchObject({ status: 'uninstall-pending' })
      await closeElectronApp(current, { preserveUserData: true })
      current = null
      current = await launchElectronApp({}, { userDataRoot: profile })
      await expect.poll(() => pluginState(current!)).toBeNull()
      expect(existsSync(dataRoot)).toBe(false)
      expect(existsSync(join(profile, 'system-plugins', 'logs', pluginId))).toBe(false)
      for (const root of ['artifacts', 'runtime']) {
        for (const revision of revisions) {
          expect(existsSync(join(profile, 'system-plugins', root, pluginId, revision))).toBe(false)
        }
      }
      uninstallRemovedAllRevisions = true
      completedStages.push(stage)
    } catch (error) {
      failure = error instanceof Error ? error.stack ?? error.message : String(error)
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      try {
        if (current) await closeElectronApp(current)
        else if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (error) {
        cleanupErrors.push(error)
      } finally {
        try {
          rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        // The list reporter does not persist body attachments. Keep partial
        // results on disk as well, so CI can upload evidence from failed runs.
        const evidencePath = testInfo.outputPath('native-acceptance-evidence.json')
        writeFileSync(evidencePath, JSON.stringify({
          snapshots, revisions, probe, completedStages,
          failedStage: failure !== null ? stage : null,
          failure,
          cleanupErrors: cleanupErrors.map(String),
          abiRefresh: 'simulated-stale-fingerprint',
          invalidBinaryRejected,
          uninstallRemovedAllRevisions
        }, null, 2))
        await testInfo.attach('native-acceptance-evidence', {
          path: evidencePath, contentType: 'application/json'
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupErrors.length > 0) {
        if (failure !== null) console.error('Native acceptance cleanup/evidence errors:', cleanupErrors)
        else throw new AggregateError(cleanupErrors, 'Native acceptance cleanup or evidence persistence failed.')
      }
    }
  })
})

async function pluginState(context: ElectronAppContext) {
  return context.page.evaluate(async (id) => (
    (await window.knowbook.listSystemPlugins()).find((plugin) => plugin.pluginId === id) ?? null
  ), pluginId)
}

async function expectNativeActivation(
  context: ElectronAppContext,
  marker: string,
  artifactSha256: string,
  versions: string[]
): Promise<NativeEvidence> {
  await expect.poll(async () => {
    const state = await pluginState(context)
    return { status: state?.status, hash: state?.currentArtifactSha256, error: state?.lastError }
  }).toEqual({ status: 'active', hash: artifactSha256, error: null })
  const evidence = JSON.parse(readFileSync(marker, 'utf8')) as NativeEvidence
  expect(evidence.visits.map((visit) => visit.version)).toEqual(versions)
  expect(evidence.answer).toBe(42)
  expect(evidence.revisionHash).toBe(`sha256:${artifactSha256}`)
  expect(evidence.packaged).toBe(Boolean(process.env.KNOWBOOK_E2E_EXECUTABLE))
  expect(evidence.nativePath).toBe(realpathSync(join(context.tempRoot, 'system-plugins', 'runtime', pluginId, artifactSha256, 'native', 'better_sqlite3.node')))
  return evidence
}

async function prepareNativePlugin(context: ElectronAppContext, sourceRoot: string) {
  await context.app.evaluate(({ dialog }, root) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true, value: async () => ({ canceled: false, filePaths: [root] })
    })
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true, value: async () => ({ response: 0, checkboxChecked: false })
    })
  }, sourceRoot)
  const prepared = await context.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
  if (!prepared) throw new Error('Expected a native plugin install request.')
  expect(prepared.status).toBe('awaiting-confirmation')
  return prepared
}

async function confirmNativePlugin(
  context: ElectronAppContext,
  prepared: { id: string; pluginId: string; artifactSha256: string }
) {
  return context.page.evaluate((request) => window.knowbook.resolveSystemPluginInstallRequest({
    requestId: request.id,
    pluginId: request.pluginId,
    artifactSha256: request.artifactSha256,
    acknowledgeSystemAccess: true,
    decision: 'confirm'
  }), prepared)
}

async function readPackageEvidence(context: ElectronAppContext, hash: string, staleAbi = false): Promise<PackageEvidence> {
  return context.app.evaluate(({ app }, { pluginId, hash, staleAbi }) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const require = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = require('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'))
    try {
      const row = db.prepare('SELECT artifact_path, content_hash, runtime_fingerprint_json FROM system_plugin_packages WHERE plugin_id = ? AND content_hash = ?').get(pluginId, hash)
      const fingerprint = JSON.parse(row.runtime_fingerprint_json)
      if (staleAbi) {
        db.prepare('UPDATE system_plugin_packages SET runtime_fingerprint_json = ? WHERE plugin_id = ? AND content_hash = ?')
          .run(JSON.stringify({ ...fingerprint, modules: 'simulated-old-abi' }), pluginId, hash)
      }
      return {
        artifactPath: row.artifact_path,
        contentHash: row.content_hash,
        fingerprint,
        audits: db.prepare('SELECT action FROM system_plugin_audit WHERE plugin_id = ?').all(pluginId).map((item: { action: string }) => item.action)
      }
    } finally { db.close() }
  }, { pluginId, hash, staleAbi })
}

function writeNativeFixture(root: string, version: string, invalid = false) {
  mkdirSync(join(root, 'native'), { recursive: true })
  if (invalid) writeFileSync(join(root, 'native', 'better_sqlite3.node'), 'controlled invalid native binary')
  else copyFileSync(nativeSource, join(root, 'native', 'better_sqlite3.node'))
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 3, trust: 'full', id: pluginId, name: 'Native Acceptance', version,
    description: 'Controlled native binary lifecycle acceptance.',
    publisher: 'KnowBook E2E',
    entries: { main: 'main.cjs' }, fullAccess: true,
    riskDeclarations: ['node', 'filesystem', 'database']
  } satisfies SystemPluginV3Manifest, null, 2))
  writeFileSync(join(root, 'main.cjs'), `'use strict'
module.exports = {
  activate(context) {
    const fs = context.require('node:fs')
    const path = context.require('node:path')
    const nativePath = context.require.resolve('./native/better_sqlite3.node')
    const addon = context.require(nativePath)
    addon.setErrorConstructor(Error)
    const databasePath = path.join(context.plugin.dataRoot, 'native.sqlite')
    const db = new addon.Database(databasePath, databasePath, false, false, false, 5000, null, null)
    context.registerDisposable(() => db.close(), 'native SQLite connection')
    db.exec('CREATE TABLE IF NOT EXISTS visits (version TEXT NOT NULL)')
    db.prepare('INSERT INTO visits (version) VALUES (?)', {}, false).run(context.plugin.version)
    const visits = db.prepare('SELECT version FROM visits ORDER BY rowid', {}, false).all()
    const answer = db.prepare('SELECT 42 AS value', {}, false).get().value
    fs.writeFileSync(path.join(context.plugin.dataRoot, 'native-evidence.json'), JSON.stringify({
      version: context.plugin.version,
      revisionHash: context.plugin.revisionHash,
      nativePath,
      nativeSha256: context.require('node:crypto').createHash('sha256').update(fs.readFileSync(nativePath)).digest('hex'),
      platform: process.platform, arch: process.arch,
      electron: process.versions.electron, modules: process.versions.modules,
      packaged: context.desktop.electron.app.isPackaged, visits, answer
    }))
  }
}
`)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
