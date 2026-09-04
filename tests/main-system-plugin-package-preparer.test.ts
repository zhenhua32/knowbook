import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import {
  createSystemPluginElectronRebuildCommand,
  createSystemPluginPackagePreparer
} from '../src/main/system-plugin/package-preparer'
import type { PublishedSystemPluginArtifact } from '../src/main/system-plugin-artifact'

test('package preparation installs into a runtime copy and persists dependency jobs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-package-preparer-'))
  const store = new KnowbookStore(join(root, 'knowbook.db'))
  try {
    const artifactRoot = join(root, 'artifact')
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(join(artifactRoot, 'plugin.json'), '{}')
    const contentHash = 'a'.repeat(64)
    const manifest: PublishedSystemPluginArtifact['manifest'] = {
      schemaVersion: 3,
      trust: 'full',
      id: 'system.package.fixture',
      name: 'Package fixture',
      version: '1.0.0',
      publisher: 'KnowBook tests',
      entries: { main: 'main.cjs' },
      fullAccess: true,
      riskDeclarations: ['node', 'npm'],
      dependencies: {
        packageManager: 'npm',
        install: 'install',
        allowScripts: true,
        rebuildNativeModules: false
      }
    }
    const request = store.pluginPlatform.createSystemPluginInstallRequest({
      pluginId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      publisher: manifest.publisher,
      artifactSha256: contentHash,
      systemPermissions: ['full-trust', 'node', 'npm'],
      reason: 'Package preparer fixture.',
      requestedBy: 'user'
    })
    const packageRecord = store.pluginPlatform.createSystemPluginPackage({
      pluginId: manifest.id,
      version: manifest.version,
      publisher: manifest.publisher,
      contentHash,
      artifactPath: artifactRoot,
      manifestSnapshot: manifest,
      fileManifest: [{ path: 'plugin.json', size: 2, sha256: 'b'.repeat(64) }],
      sourceRequestId: request.id,
      status: 'installing'
    })
    const artifact: PublishedSystemPluginArtifact = {
      artifactId: `sha256:${contentHash}`,
      artifactSha256: contentHash,
      artifactDirectory: artifactRoot,
      manifest,
      files: [{ path: 'plugin.json', size: 2, sha256: 'b'.repeat(64) }],
      fileCount: 1,
      sizeBytes: 2,
      dependencyLockPath: null
    }
    let probeShouldFail = false
    const probeRoots: string[] = []
    const prepare = createSystemPluginPackagePreparer({
      repository: store.pluginPlatform,
      runtimeRoot: join(root, 'runtime'),
      logRoot: join(root, 'logs'),
      executeTasks: async (options) => {
        assert.notEqual(options.rootDirectory, artifactRoot)
        mkdirSync(join(options.rootDirectory, 'node_modules', 'fixture'), { recursive: true })
        writeFileSync(join(options.rootDirectory, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1')
        writeFileSync(join(options.rootDirectory, 'node_modules', 'fixture', 'binding.node'), 'fake native binary')
        options.tasks.forEach((task, taskIndex) => {
          options.onStatus?.({
            taskIndex,
            task,
            previousStatus: 'pending',
            status: 'running',
            error: null,
            timestamp: new Date().toISOString()
          })
          options.onStatus?.({
            taskIndex,
            task,
            previousStatus: 'running',
            status: 'succeeded',
            error: null,
            timestamp: new Date().toISOString()
          })
        })
        return {
          cwd: options.rootDirectory,
          tasks: options.tasks.map((task, taskIndex) => ({ taskIndex, task, exitCode: 0 }))
        }
      },
      probeNativeModules: async (options) => {
        probeRoots.push(options.rootDirectory)
        assert.equal(
          existsSync(join(options.rootDirectory, 'node_modules', 'fixture', 'binding.node')),
          true
        )
        if (probeShouldFail) throw new Error('native ABI probe rejected fixture')
        return {
          rootDirectory: resolve(options.rootDirectory),
          strategy: 'electron-node-require',
          nativeModules: ['node_modules/fixture/binding.node']
        }
      }
    })

    const prepared = await prepare({ artifact, packageRecord, request })
    const fingerprint = prepared?.runtimeFingerprint as Record<string, unknown>
    const runtimePath = fingerprint.runtimeRoot as string
    assert.equal(existsSync(join(runtimePath, 'node_modules', 'fixture', 'index.js')), true)
    assert.equal(existsSync(join(artifactRoot, 'node_modules')), false)
    assert.equal(fingerprint.modules, process.versions.modules ?? null)
    assert.equal(fingerprint.napi, process.versions.napi ?? null)
    assert.equal(fingerprint.v8, process.versions.v8 ?? null)
    assert.equal(
      (fingerprint.runtimeVersions as Record<string, unknown>).electron,
      process.versions.electron
    )
    assert.deepEqual(fingerprint.nativeModuleProbe, {
      strategy: 'electron-node-require',
      status: 'passed',
      moduleCount: 1,
      modules: ['node_modules/fixture/binding.node']
    })
    writeFileSync(join(runtimePath, 'obsolete-runtime-file'), 'old ABI')
    const rebuilt = await prepare({ artifact, packageRecord, request })
    assert.equal(
      (rebuilt?.runtimeFingerprint as Record<string, unknown>).runtimeRoot,
      runtimePath
    )
    assert.equal(existsSync(join(runtimePath, 'obsolete-runtime-file')), false)
    assert.equal(existsSync(join(runtimePath, 'node_modules', 'fixture', 'index.js')), true)
    writeFileSync(join(runtimePath, 'preserved-after-probe-failure'), 'last known good runtime')
    probeShouldFail = true
    await assert.rejects(prepare({ artifact, packageRecord, request }), /native ABI probe rejected fixture/)
    assert.equal(existsSync(join(runtimePath, 'preserved-after-probe-failure')), true)
    assert.equal(
      readdirSync(join(root, 'runtime', manifest.id)).some((name) => name.startsWith('.preparing-')),
      false
    )
    assert.equal(probeRoots.length, 3)

    const jobs = store.pluginPlatform.listSystemPluginDependencyJobs(packageRecord.id)
    assert.equal(jobs.length, 3)
    assert.deepEqual(jobs.map((job) => job.status), ['succeeded', 'succeeded', 'failed'])
    assert.ok(jobs.every((job) => JSON.stringify(job.command) === JSON.stringify(['npm', 'install'])))
    assert.match(String((jobs.at(-1)?.error as Record<string, unknown>)?.message), /ABI probe/i)
  } finally {
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

test('dependency-free packages are probed and activated from a mutable runtime copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-package-no-deps-'))
  const store = new KnowbookStore(join(root, 'knowbook.db'))
  try {
    const artifactRoot = join(root, 'artifact')
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(join(artifactRoot, 'plugin.json'), '{}')
    writeFileSync(join(artifactRoot, 'main.cjs'), 'module.exports.activate = () => undefined')
    const contentHash = 'c'.repeat(64)
    const manifest: PublishedSystemPluginArtifact['manifest'] = {
      schemaVersion: 3,
      trust: 'full',
      id: 'system.package.no-dependencies',
      name: 'No dependencies fixture',
      version: '1.0.0',
      publisher: 'KnowBook tests',
      entries: { main: 'main.cjs' },
      fullAccess: true,
      riskDeclarations: ['node']
    }
    const request = store.pluginPlatform.createSystemPluginInstallRequest({
      pluginId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      publisher: manifest.publisher,
      artifactSha256: contentHash,
      systemPermissions: ['full-trust', 'node'],
      reason: 'Dependency-free package preparer fixture.',
      requestedBy: 'user'
    })
    const packageRecord = store.pluginPlatform.createSystemPluginPackage({
      pluginId: manifest.id,
      version: manifest.version,
      publisher: manifest.publisher,
      contentHash,
      artifactPath: artifactRoot,
      manifestSnapshot: manifest,
      fileManifest: [{ path: 'plugin.json', size: 2, sha256: 'd'.repeat(64) }],
      sourceRequestId: request.id,
      status: 'installing'
    })
    const artifact: PublishedSystemPluginArtifact = {
      artifactId: `sha256:${contentHash}`,
      artifactSha256: contentHash,
      artifactDirectory: artifactRoot,
      manifest,
      files: [{ path: 'plugin.json', size: 2, sha256: 'd'.repeat(64) }],
      fileCount: 2,
      sizeBytes: 50,
      dependencyLockPath: null
    }
    const prepare = createSystemPluginPackagePreparer({
      repository: store.pluginPlatform,
      runtimeRoot: join(root, 'runtime'),
      logRoot: join(root, 'logs'),
      executeTasks: async () => {
        throw new Error('Dependency runner must not be called without a dependency plan.')
      },
      probeNativeModules: async (options) => {
        assert.notEqual(resolve(options.rootDirectory), resolve(artifactRoot))
        writeFileSync(join(options.rootDirectory, 'probe-side-effect'), 'runtime only')
        return {
          rootDirectory: resolve(options.rootDirectory),
          strategy: 'electron-node-require',
          nativeModules: []
        }
      }
    })

    const prepared = await prepare({ artifact, packageRecord, request })
    const fingerprint = prepared?.runtimeFingerprint as Record<string, unknown>
    const runtimePath = fingerprint.runtimeRoot as string
    assert.notEqual(resolve(runtimePath), resolve(artifactRoot))
    assert.equal(existsSync(join(runtimePath, 'main.cjs')), true)
    assert.equal(existsSync(join(runtimePath, 'probe-side-effect')), true)
    assert.equal(existsSync(join(artifactRoot, 'probe-side-effect')), false)
    assert.equal(fingerprint.dependencyPlan, null)
    assert.deepEqual(fingerprint.dependencyTasks, [])
    assert.equal(store.pluginPlatform.listSystemPluginDependencyJobs(packageRecord.id).length, 0)
  } finally {
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

test('native rebuild command uses the manifest package manager and pins the Electron target tuple', () => {
  const suffix = [
    'rebuild',
    '--runtime=electron',
    '--target=35.1.5',
    '--arch=arm64',
    '--platform=darwin',
    '--dist-url=https://electronjs.org/headers'
  ]
  for (const packageManager of ['npm', 'pnpm', 'yarn'] as const) {
    const command = createSystemPluginElectronRebuildCommand(packageManager, {
      electron: '35.1.5',
      arch: 'arm64',
      platform: 'darwin'
    })
    assert.deepEqual(command, [packageManager, ...suffix])
    assert.equal(Object.isFrozen(command), true)
  }

  assert.throws(() => createSystemPluginElectronRebuildCommand('npm', {
    electron: '',
    arch: 'x64',
    platform: 'win32'
  }), /Electron target is invalid/)
})
