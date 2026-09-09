import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { SystemPluginOutputLog } from '../src/main/system-plugin/output-log'
import { SystemPluginHost } from '../src/main/system-plugin/host'
import { KnowbookStore } from '../src/main/database/store'
import { WorkspaceEventBus } from '../src/main/event-bus'
import { createKnowbookFullTrustServices, type KnowbookFullTrustServiceOptions, type KnowbookFullTrustServices } from '../src/main/system-plugin/knowbook-services'

test('Main output scopes keep concurrent revisions separate, redact split lines and restore stream writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-main-output-'))
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdout.resume(); stderr.resume()
  const originalWrite = stdout.write
  const streams = { stdout, stderr } as unknown as Pick<NodeJS.Process, 'stdout' | 'stderr'>
  const first = new SystemPluginOutputLog(join(root, 'first.log'), streams)
  const second = new SystemPluginOutputLog(join(root, 'second.log'), streams)
  try {
    stdout.write('unscoped host output\n')
    await Promise.all([
      first.run(async () => {
        stdout.write('Authorization: Bear')
        await new Promise(resolve => setTimeout(resolve, 5))
        stdout.write('er fixture-secret-value\n')
        stderr.write('first-error\n')
      }),
      second.run(async () => {
        await new Promise(resolve => setTimeout(resolve, 1))
        stdout.write('second-output\n')
      })
    ])
    await first.close()
    assert.notEqual(stdout.write, originalWrite)
    first.run(() => stdout.write('closed scope output\n'))
    second.run(() => stderr.write('second-partial'))
    await second.close()
    assert.equal(stdout.write, originalWrite)
    const a = await readFile(join(root, 'first.log'), 'utf8')
    const b = await readFile(join(root, 'second.log'), 'utf8')
    assert.match(a, /Bearer \[REDACTED\]/)
    assert.match(a, /\[stderr\] first-error/)
    assert.doesNotMatch(a, /fixture-secret-value|second-output|unscoped|closed scope/)
    assert.match(b, /second-output/)
    assert.match(b, /\[stderr\] second-partial/)
    assert.doesNotMatch(b, /first-error|Authorization|unscoped/)
  } finally {
    await first.close(); await second.close()
    stdout.destroy(); stderr.destroy()
    await rm(root, { recursive: true, force: true })
  }
})

test('Main lifecycle logs include module loading, asynchronous work and disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-host-output-'))
  const path = join(root, 'revision-main.log')
  const host = new SystemPluginHost({
    plugin: { id: 'test.output', version: '1.0.0', revisionHash: 'sha256:test' },
    pluginRoot: root, dataRoot: root, mainEntry: 'main.cjs', logPath: path
  })
  try {
    await writeFile(join(root, 'main.cjs'), `
console.log('fixture-module-load')
exports.activate = async context => {
  await new Promise(resolve => setTimeout(() => { console.log('fixture-async-work'); resolve() }, 1))
  context.registerDisposable(() => process.stderr.write('fixture-dispose\\n'))
}
exports.deactivate = () => console.log('fixture-deactivate')
`)
    await host.activate()
    await host.deactivate()
    const text = await readFile(path, 'utf8')
    for (const marker of ['fixture-module-load', 'fixture-async-work', 'fixture-deactivate', 'fixture-dispose']) assert.ok(text.includes(marker), marker)
  } finally {
    await host.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})

test('Main log I/O failure does not fail disposal or leave stream hooks installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-output-io-failure-'))
  const logPath = join(root, 'not-a-file')
  await mkdir(logPath)
  await writeFile(join(root, 'main.cjs'), `exports.activate=ctx=>{console.log('io-failure-fixture');ctx.registerDisposable(()=>{globalThis.__outputFixtureDisposed=true})}`)
  const originalWrite = process.stdout.write
  const host = new SystemPluginHost({ plugin: { id: 'test.log-error', version: '1.0.0', revisionHash: 'sha256:test' }, pluginRoot: root, dataRoot: root, mainEntry: 'main.cjs', logPath })
  try {
    await host.activate()
    await host.deactivate()
    assert.equal(host.status, 'stopped')
    assert.equal((globalThis as Record<string, unknown>).__outputFixtureDisposed, true)
    assert.equal(process.stdout.write, originalWrite)
  } finally {
    await host.deactivate()
    delete (globalThis as Record<string, unknown>).__outputFixtureDisposed
    await rm(root, { recursive: true, force: true })
  }
})

test('a hung Main log flush is bounded and only reports a diagnostic', async () => {
  const stdout = new PassThrough(), stderr = new PassThrough()
  stdout.resume(); stderr.resume()
  const original = stdout.write
  const errors: Error[] = []
  const output = new SystemPluginOutputLog('unused.log', { stdout, stderr } as unknown as Pick<NodeJS.Process, 'stdout' | 'stderr'>,
    { flushTimeoutMs: 30, onError: error => errors.push(error), writer: { append: async () => {}, flush: () => new Promise(() => {}) } })
  const started = Date.now()
  await output.close()
  assert.ok(Date.now() - started < 1_000)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /timed out/)
  assert.equal(stdout.write, original)
  await output.close()
  assert.equal(errors.length, 1)
  stdout.destroy(); stderr.destroy()
})

test('SDK event subscriber logs stay with plugin B when plugin A or ordinary host work emits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-output-events-'))
  const store = new KnowbookStore(join(root, 'knowbook.db'))
  const bus = new WorkspaceEventBus()
  const hosts: SystemPluginHost<KnowbookFullTrustServices>[] = []
  const create = (id: string) => {
    const host = new SystemPluginHost({
      plugin: { id, version: '1.0.0', revisionHash: `sha256:${id}` }, pluginRoot: root, dataRoot: root,
      mainEntry: `${id}.cjs`, logPath: join(root, `${id}.log`),
      createServices: (bindings) => createKnowbookFullTrustServices({
        store, sqlite: store.getUnsafeDatabaseHandle(), workspaceEventBus: bus,
        workspaceEventContext: { originPluginId: id, correlationId: id },
        electron: {} as KnowbookFullTrustServiceOptions['electron'], getMainWindow: () => null,
        getAiCredentials: () => ({ enabled: false, apiKey: null, baseUrl: '', model: '' }),
        notifyWorkspaceMutation: () => {}, registerDisposable: bindings.registerDisposable,
        paths: { userData: root, appData: root, documents: root, downloads: root, temp: root }
      })
    })
    hosts.push(host)
    return host
  }
  try {
    await writeFile(join(root, 'plugin-b.cjs'), `exports.activate=ctx=>ctx.registerDisposable(ctx.events.subscribe(async event=>{
      console.log('b-received:'+event.model+':'+(event.originPluginId||'host'));
      await new Promise(resolve=>setTimeout(resolve,1)); console.error('b-async:'+event.model)
    }))`)
    await writeFile(join(root, 'plugin-a.cjs'), `exports.activate=async ctx=>{
      console.log('a-before-emit');await ctx.events.emit({type:'ai.config.updated',createdAt:new Date().toISOString(),model:'from-a',aiEnabled:false});console.log('a-after-emit')
    }`)
    const b = create('plugin-b'), a = create('plugin-a')
    await b.activate(); await a.activate()
    await bus.emit({ type: 'ai.config.updated', createdAt: new Date().toISOString(), model: 'from-host', aiEnabled: false })
    await a.deactivate(); await b.deactivate()
    const logA = await readFile(join(root, 'plugin-a.log'), 'utf8')
    const logB = await readFile(join(root, 'plugin-b.log'), 'utf8')
    assert.match(logA, /a-before-emit/); assert.match(logA, /a-after-emit/)
    assert.doesNotMatch(logA, /b-received|b-async/)
    assert.match(logB, /b-received:from-a:plugin-a/)
    assert.match(logB, /b-received:from-host:host/)
    assert.match(logB, /b-async:from-a/); assert.match(logB, /b-async:from-host/)
    await bus.emit({ type: 'ai.config.updated', createdAt: new Date().toISOString(), model: 'after-disposal', aiEnabled: false })
    assert.equal(await readFile(join(root, 'plugin-b.log'), 'utf8'), logB)
  } finally {
    await Promise.all(hosts.map(host => host.deactivate()))
    store.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
