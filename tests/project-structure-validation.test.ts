import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const projectRoot = process.cwd()

function readJson(pathFromRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectRoot, pathFromRoot), 'utf8')) as Record<string, unknown>
}

test('package.json keeps the expected build and test scripts', () => {
  const packageJson = readJson('package.json')
  const scripts = packageJson.scripts as Record<string, string> | undefined

  assert.equal(packageJson.name, 'knowbook')
  assert.equal(typeof packageJson.version, 'string')
  assert.equal(scripts?.build, 'npm run typecheck && electron-vite build && npm run verify:renderer-bundle')
  assert.equal(scripts?.test, 'cross-env ELECTRON_RUN_AS_NODE=1 electron --import tsx --test --test-timeout=120000 "tests/**/*.test.ts" "tests/**/*.test.tsx"')
  assert.equal(scripts?.['test:e2e'], 'npm run build && playwright test --grep @electron')
  assert.equal(scripts?.['verify:renderer-bundle'], 'node scripts/verify-renderer-bundle.mjs')
  assert.equal(scripts?.typecheck?.includes('tsconfig.test.json'), true)
})

test('tsconfig.json exposes core compiler settings', () => {
  const tsconfig = readJson('tsconfig.json')
  const compilerOptions = tsconfig.compilerOptions as Record<string, unknown> | undefined
  const testTsconfig = readJson('tsconfig.test.json')
  const testCompilerOptions = testTsconfig.compilerOptions as Record<string, unknown> | undefined

  assert.equal(typeof compilerOptions?.target, 'string')
  assert.equal(typeof compilerOptions?.module, 'string')
  assert.equal(testTsconfig.extends, './tsconfig.json')
  assert.equal(testCompilerOptions?.allowImportingTsExtensions, true)
})

test('core workspace modules exist', () => {
  const requiredFiles = [
    'src/main/index.ts',
    'src/renderer/src/App.tsx',
    'src/shared/contracts.ts',
    'src/main/database/store.ts',
    'src/main/database/schema.ts',
    'src/main/plugin-platform/platform-service.ts',
    'src/main/system-plugin/manager.ts',
    'src/shared/system-plugin-sdk.ts',
    'src/renderer/src/i18n.ts',
    'src/shared/board.ts',
    'src/shared/markdown.ts',
    'src/shared/code.ts'
  ]

  for (const file of requiredFiles) {
    assert.equal(existsSync(join(projectRoot, file)), true, `${file} should exist`)
  }
})

test('stable Electron E2E specs exist', () => {
  const e2eSpecs = [
    'e2e-tests/smoke.spec.ts',
    'e2e-tests/document-crud.spec.ts',
    'e2e-tests/database-views.spec.ts',
    'e2e-tests/links.spec.ts',
    'e2e-tests/ai-automation.spec.ts',
    'e2e-tests/plugins.spec.ts',
    'e2e-tests/editor-shortcuts.spec.ts',
    'e2e-tests/editor-multiblock.spec.ts',
    'e2e-tests/editor-common-operations.spec.ts',
    'e2e-tests/editor-workflows.spec.ts'
  ]

  for (const file of e2eSpecs) {
    assert.equal(existsSync(join(projectRoot, file)), true, `${file} should exist`)
  }
})

test('retired v1 plugin runtime and management APIs are absent', () => {
  for (const filename of [
    'plugin-host.ts',
    'plugin-sdk.ts',
    'plugin-market.ts',
    'plugin-manifest-rules.ts',
    'plugin-version.ts',
    'plugin-runtime-client.ts',
    'plugin-runtime-process.ts',
    'plugin-runtime-protocol.ts'
  ]) {
    assert.equal(existsSync(join(projectRoot, 'src/main', filename)), false, filename)
  }

  const main = readFileSync(join(projectRoot, 'src/main/index.ts'), 'utf8')
  const preload = readFileSync(join(projectRoot, 'src/preload/index.ts'), 'utf8')
  const contracts = readFileSync(join(projectRoot, 'src/shared/contracts.ts'), 'utf8')
  const management = readFileSync(join(projectRoot, 'src/renderer/src/hooks/usePluginManagement.ts'), 'utf8')
  for (const method of [
    'setPluginEnabled', 'reloadPlugins', 'reloadPlugin', 'installPluginFromFolder',
    'removePlugin', 'updatePluginSetting'
  ]) {
    const exactMethod = new RegExp(`\\b${method}\\b`)
    for (const source of [main, preload, contracts, management]) {
      assert.doesNotMatch(source, exactMethod, `${method} must not remain callable`)
    }
  }
  assert.doesNotMatch(main, /pluginHost|ElectronPluginRuntime/)
  assert.doesNotMatch(contracts, /\b(?:PluginManifest|PluginDescriptor|PluginHostInfo|PluginSettingValue)\b/)
  assert.equal(existsSync(join(projectRoot, 'plugins/activity-pulse/index.js')), false)
  const manifest = readJson('plugins/activity-pulse/plugin.json')
  assert.equal(manifest.schemaVersion, 3)
  assert.equal(manifest.trust, 'full')
  assert.equal(manifest.fullAccess, true)
})
