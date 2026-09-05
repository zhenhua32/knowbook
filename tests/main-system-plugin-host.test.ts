import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  createFullTrustPluginContext,
  SystemPluginHost,
  SystemPluginLifecycleTimeoutError,
  type FullTrustPluginContextFactoryBindings,
  type SystemPluginErrorEvent,
  type SystemPluginStatusEvent
} from '../src/main/system-plugin/index.ts'

test('SystemPluginHost loads CJS from an immutable root and runs the complete lifecycle', async () => {
  await withPluginRoot(async ({ root, dataRoot }) => {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }))
    writeFileSync(join(root, 'helper.cjs'), 'module.exports = { value: "required-from-root" }\n')
    writeFileSync(join(root, 'dist', 'main.cjs'), `
      module.exports.activate = async function activate(context) {
        context.trace.push(context.require('./helper.cjs').value)
        context.trace.push('activate:' + context.plugin.id)
        context.registerDisposable(() => context.trace.push('dispose:first'), 'first')
        context.registerDisposable(async () => {
          await Promise.resolve()
          context.trace.push('dispose:second')
        }, 'second')
      }
      module.exports.healthCheck = function healthCheck() {
        return { ok: true, message: 'ready' }
      }
      module.exports.beforeQuit = function beforeQuit() {
        module.exports.trace.push('beforeQuit')
      }
      module.exports.deactivate = function deactivate() {
        module.exports.trace.push('deactivate')
      }
    `)

    const trace: string[] = []
    const statuses: SystemPluginStatusEvent[] = []
    const factoryBindings: FullTrustPluginContextFactoryBindings[] = []
    const host = new SystemPluginHost({
      plugin: { id: 'test.cjs', version: '1.0.0', revisionHash: 'sha256:cjs' },
      pluginRoot: root,
      dataRoot,
      mainEntry: 'dist/main.cjs',
      createServices(bindings) {
        factoryBindings.push(bindings)
        const entryModule = bindings.require('./dist/main.cjs') as { trace?: string[] }
        entryModule.trace = trace
        return { trace }
      },
      onStatus: (event) => statuses.push(event)
    })

    const activation = await host.activate()
    assert.equal(activation.format, 'cjs')
    assert.equal(activation.entryPath, resolve(root, 'dist/main.cjs'))
    assert.deepEqual(activation.health, { ok: true, message: 'ready' })
    assert.equal(host.status, 'active')
    assert.deepEqual(trace, ['required-from-root', 'activate:test.cjs'])
    assert.equal(host.context?.plugin.root, resolve(root))
    assert.equal(host.context?.plugin.dataRoot, resolve(dataRoot))
    assert.equal(factoryBindings[0]?.format, 'cjs')
    assert.equal(factoryBindings[0]?.entryPath, resolve(root, 'dist/main.cjs'))

    await host.beforeQuit()
    await host.deactivate()
    await host.deactivate()

    assert.equal(host.status, 'stopped')
    assert.deepEqual(trace, [
      'required-from-root',
      'activate:test.cjs',
      'beforeQuit',
      'deactivate',
      'dispose:second',
      'dispose:first'
    ])
    assert.deepEqual(statuses.map((event) => event.status), [
      'loading',
      'activating',
      'health-checking',
      'active',
      'before-quit',
      'active',
      'deactivating',
      'stopped'
    ])
  })
})

test('SystemPluginHost loads ESM default lifecycle and supports explicit health checks', async () => {
  await withPluginRoot(async ({ root, dataRoot }) => {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(root, 'dist', 'main.js'), `
      export default {
        activate(context) {
          context.trace.push('esm:activate')
          context.registerDisposable(() => context.trace.push('esm:dispose'))
        },
        healthCheck() {
          return { ok: true }
        }
      }
    `)

    const trace: string[] = []
    const host = new SystemPluginHost({
      plugin: { id: 'test.esm', version: '2.0.0', revisionHash: 'sha256:esm' },
      pluginRoot: root,
      dataRoot,
      mainEntry: 'dist/main.js',
      services: { trace }
    })

    assert.equal((await host.activate()).format, 'esm')
    assert.deepEqual(await host.healthCheck(), { ok: true })
    assert.equal(host.status, 'active')
    await host.deactivate()
    assert.deepEqual(trace, ['esm:activate', 'esm:dispose'])
  })
})

test('SystemPluginHost runs migration before activation only when fromVersion is provided', async () => {
  await withPluginRoot(async ({ root, dataRoot }) => {
    writeFileSync(join(root, 'main.cjs'), `
      module.exports.migrate = function migrate(context, fromVersion) {
        context.trace.push('migrate:' + fromVersion + '->' + context.plugin.version)
      }
      module.exports.activate = function activate(context) {
        context.trace.push('activate:' + context.plugin.version)
      }
    `)

    const initialTrace: string[] = []
    const initial = new SystemPluginHost({
      plugin: { id: 'test.migrate', version: '1.0.0', revisionHash: 'sha256:migrate-initial' },
      pluginRoot: root,
      dataRoot,
      mainEntry: 'main.cjs',
      services: { trace: initialTrace }
    })
    await initial.activate()
    assert.deepEqual(initialTrace, ['activate:1.0.0'])
    await initial.deactivate()

    const upgradeTrace: string[] = []
    const statuses: SystemPluginStatusEvent[] = []
    const upgrade = new SystemPluginHost({
      plugin: { id: 'test.migrate', version: '2.0.0', revisionHash: 'sha256:migrate-upgrade' },
      pluginRoot: root,
      dataRoot,
      mainEntry: 'main.cjs',
      fromVersion: '1.0.0',
      services: { trace: upgradeTrace },
      onStatus: (event) => statuses.push(event)
    })
    await upgrade.activate()
    assert.deepEqual(upgradeTrace, ['migrate:1.0.0->2.0.0', 'activate:2.0.0'])
    assert.deepEqual(statuses.map((event) => event.status), [
      'loading',
      'migrating',
      'activating',
      'active'
    ])
    await upgrade.deactivate()
  })
})

test('SystemPluginHost treats migration failure as fatal and cleans registered effects', async () => {
  await withPluginRoot(async ({ root, dataRoot }) => {
    writeFileSync(join(root, 'main.cjs'), `
      module.exports.migrate = function migrate(context) {
        context.trace.push('migrate')
        context.registerDisposable(() => context.trace.push('dispose:migrate'), 'migration effect')
        throw new Error('migration rejected old state')
      }
      module.exports.activate = function activate(context) {
        context.trace.push('activate')
      }
    `)

    const trace: string[] = []
    const errors: SystemPluginErrorEvent[] = []
    const host = new SystemPluginHost({
      plugin: { id: 'test.migrate-failure', version: '2.0.0', revisionHash: 'sha256:migrate-failure' },
      pluginRoot: root,
      dataRoot,
      mainEntry: 'main.cjs',
      fromVersion: '1.0.0',
      services: { trace },
      onError: (event) => errors.push(event)
    })

    await assert.rejects(host.activate(), /migration rejected old state/)
    assert.equal(host.status, 'failed')
    assert.deepEqual(trace, ['migrate', 'dispose:migrate'])
    assert.deepEqual(errors.map((event) => event.stage), ['migrate'])
    assert.equal(errors[0]?.fatal, true)
  })
})

test('SystemPluginHost bounds migration independently from activation', async () => {
  await withPluginRoot(async ({ root, dataRoot }) => {
    writeFileSync(join(root, 'main.cjs'), `
      module.exports.migrate = function migrate() {
        return new Promise(() => {})
      }
      module.exports.activate = function activate() {
        throw new Error('activate must not run after migration timeout')
      }
    `)

    const errors: SystemPluginErrorEvent[] = []
    const host = new SystemPluginHost({
      plugin: { id: 'test.migrate-timeout', version: '2.0.0', revisionHash: 'sha256:migrate-timeout' },
      pluginRoot: root,
      dataRoot,
      mainEntry: 'main.cjs',
      fromVersion: '1.0.0',
      timeouts: { migrateMs: 20 },
      onError: (event) => errors.push(event)
    })

    await assert.rejects(host.activate(), (error: unknown) => {
      assert.ok(error instanceof SystemPluginLifecycleTimeoutError)
      assert.equal(error.stage, 'migrate')
      assert.equal(error.timeoutMs, 20)
      return true
    })
    assert.equal(host.status, 'failed')
    assert.deepEqual(errors.map((event) => event.stage), ['migrate'])
  })
})

test('SystemPluginHost bounds activation and performs LIFO rollback cleanup', async () => {
  await withPluginRoot(async ({ root, dataRoot }) => {
    writeFileSync(join(root, 'main.cjs'), `
      module.exports.activate = async function activate(context) {
        context.registerDisposable(() => context.trace.push('dispose:first'), 'first')
        context.registerDisposable(() => {
          context.trace.push('dispose:hung')
          return new Promise(() => {})
        }, 'hung')
        context.registerDisposable(() => context.trace.push('dispose:last'), 'last')
        return new Promise(() => {})
      }
    `)

    const trace: string[] = []
    const errors: SystemPluginErrorEvent[] = []
    const host = new SystemPluginHost({
      plugin: { id: 'test.timeout', version: '1.0.0', revisionHash: 'sha256:timeout' },
      pluginRoot: root,
      dataRoot,
      mainEntry: 'main.cjs',
      services: { trace },
      timeouts: { activateMs: 20, disposeMs: 20 },
      onError: (event) => errors.push(event)
    })

    const startedAt = Date.now()
    await assert.rejects(host.activate(), (error: unknown) => {
      assert.ok(error instanceof SystemPluginLifecycleTimeoutError)
      assert.equal(error.stage, 'activate')
      return true
    })
    assert.ok(Date.now() - startedAt < 1_000)
    assert.equal(host.status, 'failed')
    assert.deepEqual(trace, ['dispose:last', 'dispose:hung', 'dispose:first'])
    assert.deepEqual(errors.map((event) => event.stage), ['activate', 'dispose'])
    assert.equal(errors[0].fatal, true)
    assert.equal(errors[1].label, 'hung')

    await host.deactivate()
    assert.equal(host.status, 'stopped')
  })
})

test('SystemPluginHost reports bounded stop failures but still attempts every disposable', async () => {
  await withPluginRoot(async ({ root, dataRoot }) => {
    writeFileSync(join(root, 'main.cjs'), `
      module.exports.activate = function activate(context) {
        module.exports.trace = context.trace
        context.registerDisposable(() => context.trace.push('dispose:first'), 'first')
        context.registerDisposable(() => {
          context.trace.push('dispose:hung')
          return new Promise(() => {})
        }, 'hung')
        context.registerDisposable(() => context.trace.push('dispose:last'), 'last')
      }
      module.exports.deactivate = function deactivate() {
        module.exports.trace.push('deactivate:hung')
        return new Promise(() => {})
      }
    `)

    const trace: string[] = []
    const errors: SystemPluginErrorEvent[] = []
    const host = new SystemPluginHost({
      plugin: { id: 'test.stop-timeout', version: '1.0.0', revisionHash: 'sha256:stop' },
      pluginRoot: root,
      dataRoot,
      mainEntry: 'main.cjs',
      services: { trace },
      timeouts: { deactivateMs: 15, disposeMs: 15 },
      onError: (event) => errors.push(event)
    })

    await host.activate()
    await assert.rejects(host.deactivate(), AggregateError)
    assert.equal(host.status, 'stopped')
    assert.deepEqual(trace, [
      'deactivate:hung',
      'dispose:last',
      'dispose:hung',
      'dispose:first'
    ])
    assert.deepEqual(errors.map((event) => event.stage), ['deactivate', 'dispose'])
  })
})

test('SystemPluginHost rejects entry traversal and reserved context overrides', async () => {
  await withPluginRoot(async ({ root, dataRoot }) => {
    const errors: SystemPluginErrorEvent[] = []
    const host = new SystemPluginHost({
      plugin: { id: 'test.escape', version: '1.0.0', revisionHash: 'sha256:escape' },
      pluginRoot: root,
      dataRoot,
      mainEntry: '../outside.cjs',
      onError: (event) => errors.push(event)
    })
    await assert.rejects(host.activate(), /escapes the plugin root/)
    assert.equal(host.status, 'failed')
    assert.equal(errors[0]?.stage, 'load')

    assert.throws(() => createFullTrustPluginContext({
      identity: {
        id: 'test.context',
        version: '1.0.0',
        revisionHash: 'sha256:context',
        root,
        dataRoot
      },
      services: { process: 'not-allowed' },
      registerDisposable: () => undefined
    }), /cannot override runtime field "process"/)
  })
})

async function withPluginRoot(
  operation: (paths: { root: string; dataRoot: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-plugin-'))
  const dataRoot = join(root, '.data')
  mkdirSync(dataRoot, { recursive: true })
  try {
    await operation({ root, dataRoot })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
