import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  inspectSystemPluginArtifact,
  normalizeSystemPluginV3Manifest,
  publishSystemPluginArtifact,
  stageSystemPluginArtifact
} from '../src/main/system-plugin-artifact.ts'
import { SYSTEM_PLUGIN_RISK_DECLARATIONS } from '../src/shared/system-plugin.ts'

test('v3 manifest normalization accepts the closed Full Trust contract', () => {
  const normalized = normalizeSystemPluginV3Manifest(validManifest())

  assert.equal(normalized.schemaVersion, 3)
  assert.equal(normalized.trust, 'full')
  assert.equal(normalized.fullAccess, true)
  assert.deepEqual(normalized.entries, {
    main: 'dist/main.cjs',
    renderer: 'dist/renderer.iife.js',
    service: 'dist/service.cjs'
  })
  assert.deepEqual(normalized.riskDeclarations, [...SYSTEM_PLUGIN_RISK_DECLARATIONS])
  assert.deepEqual(normalized.dependencies, {
    packageManager: 'npm',
    install: 'ci',
    allowScripts: true,
    buildCommand: ['npm', 'run', 'build'],
    rebuildNativeModules: true
  })
  assert.deepEqual(normalized.background, { mode: 'app-lifetime', autoStart: true })
})

test('v3 manifest normalization rejects privilege ambiguity and unsafe entry paths', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['wrong schema', { ...validManifest(), schemaVersion: 2 }, /schemaVersion must be 3/],
    ['wrong trust', { ...validManifest(), trust: 'sandboxed' }, /trust must be/],
    ['implicit access', { ...validManifest(), fullAccess: false }, /fullAccess/],
    ['missing entry', { ...validManifest(), entries: {} }, /at least one/],
    ['parent entry', { ...validManifest(), entries: { main: '../main.cjs' } }, /relative path/],
    ['absolute entry', { ...validManifest(), entries: { main: 'C:\\outside.cjs' } }, /relative path/],
    ['unknown risk', { ...validManifest(), riskDeclarations: ['root-everything'] }, /not recognized/],
    ['duplicate risk', { ...validManifest(), riskDeclarations: ['node', 'node'] }, /duplicated/],
    ['unknown field', { ...validManifest(), permissions: ['filesystem'] }, /unknown field/],
    [
      'background without service',
      { ...validManifest(), entries: { main: 'dist/main.cjs' } },
      /requires a service entry/
    ],
    [
      'shell build command string',
      { ...validManifest(), dependencies: { ...dependencyPlan(), buildCommand: 'npm run build' } },
      /buildCommand/
    ]
  ]

  for (const [label, manifest, pattern] of cases) {
    assert.throws(() => normalizeSystemPluginV3Manifest(manifest), pattern, label)
  }
})

test('artifact inspection produces deterministic path-framed SHA-256 and sorted file manifests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-artifact-'))
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    writeArtifact(first, false)
    writeArtifact(second, true)
    const oldDate = new Date('2020-01-01T00:00:00.000Z')
    const newDate = new Date('2026-01-01T00:00:00.000Z')
    utimesSync(join(first, 'dist', 'main.cjs'), oldDate, oldDate)
    utimesSync(join(second, 'dist', 'main.cjs'), newDate, newDate)

    const firstInspection = await inspectSystemPluginArtifact(first)
    const secondInspection = await inspectSystemPluginArtifact(second)

    assert.match(firstInspection.artifactSha256, /^[a-f0-9]{64}$/)
    assert.equal(firstInspection.artifactId, `sha256:${firstInspection.artifactSha256}`)
    assert.equal(firstInspection.artifactSha256, secondInspection.artifactSha256)
    assert.deepEqual(
      firstInspection.files.map((file) => file.path),
      [...firstInspection.files.map((file) => file.path)].sort((left, right) => Buffer.compare(
        Buffer.from(left, 'utf8'),
        Buffer.from(right, 'utf8')
      ))
    )
    assert.equal(firstInspection.fileCount, firstInspection.files.length)
    assert.equal(firstInspection.dependencyLockPath, 'package-lock.json')
    assert.equal(
      firstInspection.sizeBytes,
      firstInspection.files.reduce((total, file) => total + file.size, 0)
    )

    writeFileSync(join(second, 'dist', 'main.cjs'), 'module.exports = { changed: true }\n')
    const changed = await inspectSystemPluginArtifact(second)
    assert.notEqual(changed.artifactSha256, firstInspection.artifactSha256)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('staging copies an artifact into a fresh request directory and verifies the staged bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-stage-'))
  try {
    const source = join(root, 'source')
    const stagingRoot = join(root, 'staging')
    writeArtifact(source)
    const sourceInspection = await inspectSystemPluginArtifact(source)

    const staged = await stageSystemPluginArtifact({
      sourceDirectory: source,
      stagingRoot,
      requestId: 'request-123'
    })

    assert.equal(staged.artifactSha256, sourceInspection.artifactSha256)
    assert.equal(staged.stagingDirectory, join(stagingRoot, 'request-123'))
    assert.equal(existsSync(join(staged.stagingDirectory, 'plugin.json')), true)
    assert.equal(existsSync(join(staged.stagingDirectory, 'dist', 'service.cjs')), true)
    await assert.rejects(
      stageSystemPluginArtifact({ sourceDirectory: source, stagingRoot, requestId: 'request-123' }),
      /exist/i
    )
    await assert.rejects(
      stageSystemPluginArtifact({ sourceDirectory: source, stagingRoot, requestId: '../escape' }),
      /request id/
    )
    assert.equal(existsSync(join(root, 'escape')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('publishing exclusively claims a verified immutable content-addressed target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-publish-'))
  try {
    const firstSource = join(root, 'source-1')
    const secondSource = join(root, 'source-2')
    const stagingRoot = join(root, 'staging')
    const artifactRoot = join(root, 'artifacts')
    writeArtifact(firstSource)
    writeArtifact(secondSource)
    const firstStage = await stageSystemPluginArtifact({
      sourceDirectory: firstSource,
      stagingRoot,
      requestId: 'publish-1'
    })

    const published = await publishSystemPluginArtifact({
      stagingDirectory: firstStage.stagingDirectory,
      artifactRoot,
      pluginId: firstStage.manifest.id,
      artifactSha256: firstStage.artifactSha256
    })
    assert.equal(
      published.artifactDirectory,
      join(artifactRoot, firstStage.manifest.id, firstStage.artifactSha256)
    )
    assert.equal(existsSync(firstStage.stagingDirectory), false)
    assert.equal(existsSync(join(published.artifactDirectory, 'plugin.json')), true)

    const secondStage = await stageSystemPluginArtifact({
      sourceDirectory: secondSource,
      stagingRoot,
      requestId: 'publish-2'
    })
    await assert.rejects(
      publishSystemPluginArtifact({
        stagingDirectory: secondStage.stagingDirectory,
        artifactRoot,
        pluginId: secondStage.manifest.id,
        artifactSha256: secondStage.artifactSha256
      }),
      /already exists/
    )
    assert.equal(existsSync(secondStage.stagingDirectory), true)
    await assert.rejects(
      publishSystemPluginArtifact({
        stagingDirectory: secondStage.stagingDirectory,
        artifactRoot,
        pluginId: 'different.plugin',
        artifactSha256: secondStage.artifactSha256
      }),
      /does not match requested plugin id/
    )
    await assert.rejects(
      publishSystemPluginArtifact({
        stagingDirectory: secondStage.stagingDirectory,
        artifactRoot,
        pluginId: secondStage.manifest.id,
        artifactSha256: '0'.repeat(64)
      }),
      /does not match the verified staging artifact/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent publishes atomically claim one immutable revision without replacing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-publish-race-'))
  try {
    const firstSource = join(root, 'source-1')
    const secondSource = join(root, 'source-2')
    const stagingRoot = join(root, 'staging')
    const artifactRoot = join(root, 'artifacts')
    writeArtifact(firstSource)
    writeArtifact(secondSource)
    const [firstStage, secondStage] = await Promise.all([
      stageSystemPluginArtifact({
        sourceDirectory: firstSource,
        stagingRoot,
        requestId: 'race-1'
      }),
      stageSystemPluginArtifact({
        sourceDirectory: secondSource,
        stagingRoot,
        requestId: 'race-2'
      })
    ])

    const results = await Promise.allSettled([
      publishSystemPluginArtifact({
        stagingDirectory: firstStage.stagingDirectory,
        artifactRoot,
        pluginId: firstStage.manifest.id,
        artifactSha256: firstStage.artifactSha256
      }),
      publishSystemPluginArtifact({
        stagingDirectory: secondStage.stagingDirectory,
        artifactRoot,
        pluginId: secondStage.manifest.id,
        artifactSha256: secondStage.artifactSha256
      })
    ])

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof publishSystemPluginArtifact>>> => (
        result.status === 'fulfilled'
      )
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.match(String(rejected[0].reason), /target already exists/)

    const target = fulfilled[0].value.artifactDirectory
    const published = await inspectSystemPluginArtifact(target)
    assert.equal(published.artifactSha256, firstStage.artifactSha256)
    assert.equal(existsSync(join(target, 'plugin.json')), true)
    assert.equal(
      [firstStage.stagingDirectory, secondStage.stagingDirectory].filter((path) => existsSync(path)).length,
      1
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('publishing never replaces a target claimed by a competing creator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-publish-target-race-'))
  try {
    const source = join(root, 'source')
    const stagingRoot = join(root, 'staging')
    const artifactRoot = join(root, 'artifacts')
    writeArtifact(source)
    const staged = await stageSystemPluginArtifact({
      sourceDirectory: source,
      stagingRoot,
      requestId: 'target-race'
    })
    const target = join(artifactRoot, staged.manifest.id, staged.artifactSha256)
    mkdirSync(target, { recursive: true })
    const competingFile = join(target, 'competing-owner.txt')
    writeFileSync(competingFile, 'must survive\n')

    await assert.rejects(
      publishSystemPluginArtifact({
        stagingDirectory: staged.stagingDirectory,
        artifactRoot,
        pluginId: staged.manifest.id,
        artifactSha256: staged.artifactSha256
      }),
      /target already exists/
    )
    assert.equal(existsSync(staged.stagingDirectory), true)
    assert.equal(existsSync(join(target, 'plugin.json')), false)
    assert.equal(existsSync(competingFile), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('artifact validation rejects symlinks and removes a failed staging directory', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-symlink-'))
  try {
    const source = join(root, 'source')
    const outside = join(root, 'outside')
    const stagingRoot = join(root, 'staging')
    writeArtifact(source)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    try {
      symlinkSync(outside, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      context.skip(`symbolic links are unavailable in this environment: ${String(error)}`)
      return
    }

    await assert.rejects(inspectSystemPluginArtifact(source), /symbolic links/)
    await assert.rejects(
      stageSystemPluginArtifact({ sourceDirectory: source, stagingRoot, requestId: 'unsafe-request' }),
      /symbolic links/
    )
    assert.equal(existsSync(join(stagingRoot, 'unsafe-request')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('artifact validation requires declared entries and locked ci dependency inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-invalid-artifact-'))
  try {
    writeArtifact(root)
    rmSync(join(root, 'dist', 'renderer.iife.js'))
    await assert.rejects(inspectSystemPluginArtifact(root), /renderer entry does not exist/)

    writeFileSync(join(root, 'dist', 'renderer.iife.js'), 'globalThis.fullTrustRenderer = true\n')
    rmSync(join(root, 'package-lock.json'))
    await assert.rejects(inspectSystemPluginArtifact(root), /ci install requires a matching lock file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 3,
    trust: 'full',
    id: 'example.system-plugin',
    name: 'Example System Plugin',
    version: '1.0.0',
    description: 'Full Trust integration example',
    publisher: 'Example Publisher',
    engines: { knowbook: '>=0.2.0' },
    entries: {
      main: 'dist\\main.cjs',
      renderer: 'dist/renderer.iife.js',
      service: 'dist/service.cjs'
    },
    fullAccess: true,
    riskDeclarations: [...SYSTEM_PLUGIN_RISK_DECLARATIONS].reverse(),
    dependencies: dependencyPlan(),
    background: {
      mode: 'app-lifetime',
      autoStart: true
    }
  }
}

function dependencyPlan(): Record<string, unknown> {
  return {
    packageManager: 'npm',
    install: 'ci',
    allowScripts: true,
    buildCommand: ['npm', 'run', 'build'],
    rebuildNativeModules: true
  }
}

function writeArtifact(root: string, reverseOrder = false): void {
  mkdirSync(join(root, 'dist'), { recursive: true })
  const entries: Array<[string, string]> = [
    ['plugin.json', `${JSON.stringify(validManifest(), null, 2)}\n`],
    ['package.json', '{"name":"example-system-plugin","version":"1.0.0"}\n'],
    ['package-lock.json', '{"name":"example-system-plugin","lockfileVersion":3,"packages":{}}\n'],
    [join('dist', 'main.cjs'), 'module.exports = { activate() {} }\n'],
    [join('dist', 'renderer.iife.js'), 'globalThis.fullTrustRenderer = true\n'],
    [join('dist', 'service.cjs'), 'setInterval(() => {}, 1000)\n']
  ]
  for (const [path, content] of reverseOrder ? entries.reverse() : entries) {
    writeFileSync(join(root, path), content)
  }
}
