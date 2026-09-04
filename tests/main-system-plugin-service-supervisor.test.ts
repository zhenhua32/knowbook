import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  SYSTEM_PLUGIN_SERVICE_HEARTBEAT_MESSAGE,
  SYSTEM_PLUGIN_SERVICE_READY_MESSAGE,
  SystemPluginServiceSupervisor,
  type SystemPluginServiceEvent,
  type SystemPluginServiceMode,
  type SystemPluginServicePackage,
  type SystemPluginServiceSpawn
} from '../src/main/system-plugin/service-supervisor.ts'
import {
  SYSTEM_PLUGIN_SERVICE_RPC_BOOTSTRAP_SOURCE,
  SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
  SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
  SystemPluginServiceRpcHost,
  type SystemPluginServiceRpcResponse
} from '../src/main/system-plugin/service-rpc.ts'

test('service supervisor reports pid, logs, ready and heartbeat over IPC', async () => {
  await withPackageRoot(async (rootDirectory) => {
    const child = new FakeChildProcess(4101)
    child.closeOnSignal = 'SIGTERM'
    const calls: SpawnCall[] = []
    const events: SystemPluginServiceEvent[] = []
    const supervisor = new SystemPluginServiceSupervisor({
      package: servicePackage(rootDirectory, 'app-lifetime'),
      executable: 'node-test',
      args: ['--flag', 'exact value'],
      spawn: captureSpawn([child], calls),
      onEvent: (event) => events.push(event)
    })

    supervisor.start()
    child.stdout.write(Buffer.from('hello '))
    child.stdout.write(Buffer.from('world'))
    child.stderr.write('warning')
    child.emit('message', { type: SYSTEM_PLUGIN_SERVICE_READY_MESSAGE, port: 9000 })
    child.emit('message', { type: SYSTEM_PLUGIN_SERVICE_HEARTBEAT_MESSAGE, sequence: 1 })
    child.emit('message', { type: 'plugin-event', value: 3 })

    assert.equal(supervisor.snapshot.pid, 4101)
    assert.equal(supervisor.snapshot.ready, true)
    assert.ok(supervisor.snapshot.readyAt)
    assert.ok(supervisor.snapshot.lastHeartbeatAt)
    assert.equal(calls[0]?.executable, 'node-test')
    assert.deepEqual(calls[0]?.args, [
      resolve(rootDirectory, 'dist/service.js'),
      '--flag',
      'exact value'
    ])
    assert.equal(calls[0]?.options.cwd, resolve(rootDirectory))
    assert.equal(calls[0]?.options.shell, false)
    assert.equal(calls[0]?.options.detached, false)
    assert.deepEqual(calls[0]?.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc'])
    assert.equal((calls[0]?.options.env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE, '1')
    assert.deepEqual(
      events.filter((event) => event.type === 'log').map((event) => [event.stream, event.text]),
      [['stdout', 'hello '], ['stdout', 'world'], ['stderr', 'warning']]
    )
    assert.deepEqual(
      events.map((event) => event.type).filter((type) => (
        type === 'ready' || type === 'heartbeat' || type === 'message'
      )),
      ['ready', 'heartbeat', 'message']
    )

    await supervisor.stop()
    assert.equal(supervisor.status, 'stopped')
  })
})

test('app-lifetime service uses bounded exponential restart and reports fatal at the limit', async () => {
  await withPackageRoot(async (rootDirectory) => {
    const children = [
      new FakeChildProcess(4201),
      new FakeChildProcess(4202),
      new FakeChildProcess(4203)
    ]
    const events: SystemPluginServiceEvent[] = []
    const supervisor = new SystemPluginServiceSupervisor({
      package: servicePackage(rootDirectory, 'app-lifetime'),
      spawn: captureSpawn(children),
      restart: { maxRestarts: 2, initialDelayMs: 2, maxDelayMs: 4 },
      onEvent: (event) => events.push(event)
    })

    supervisor.start()
    children[0].emit('close', 12, null)
    await waitUntil(() => events.filter((event) => event.type === 'started').length === 2)
    children[1].emit('close', null, 'SIGABRT')
    await waitUntil(() => events.filter((event) => event.type === 'started').length === 3)
    children[2].emit('close', 9, null)

    assert.equal(supervisor.status, 'failed')
    assert.equal(supervisor.snapshot.restartCount, 2)
    assert.deepEqual(
      events
        .filter((event) => event.type === 'restart-scheduled')
        .map((event) => [event.restartCount, event.delayMs]),
      [[1, 2], [2, 4]]
    )
    const exits = events.filter((event) => event.type === 'exit')
    assert.deepEqual(exits.map((event) => [event.pid, event.exitCode, event.signal]), [
      [4201, 12, null],
      [4202, null, 'SIGABRT'],
      [4203, 9, null]
    ])
    const fatal = events.find((event) => event.type === 'fatal')
    assert.ok(fatal && fatal.error.message.includes('restart limit 2 reached'))
  })
})

test('stop escalates from graceful termination to a bounded force kill', async () => {
  await withPackageRoot(async (rootDirectory) => {
    const child = new FakeChildProcess(4301)
    child.closeOnSignal = 'SIGKILL'
    const events: SystemPluginServiceEvent[] = []
    const supervisor = new SystemPluginServiceSupervisor({
      package: servicePackage(rootDirectory, 'app-lifetime'),
      spawn: captureSpawn([child]),
      stopTimeoutMs: 5,
      forceKillTimeoutMs: 25,
      onEvent: (event) => events.push(event)
    })

    supervisor.start()
    const snapshot = await supervisor.stop()

    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL'])
    assert.equal(snapshot.status, 'stopped')
    assert.equal(snapshot.pid, null)
    assert.equal(snapshot.lastExit?.expected, true)
    assert.equal(snapshot.lastExit?.signal, 'SIGKILL')
    const terminationEvents = events.filter((event): event is Extract<
      SystemPluginServiceEvent,
      { type: 'stop-requested' | 'kill-requested' }
    > => event.type === 'stop-requested' || event.type === 'kill-requested')
    assert.deepEqual(
      terminationEvents.map((event) => [event.type, event.signal]),
      [['stop-requested', 'SIGTERM'], ['kill-requested', 'SIGKILL']]
    )
  })
})

test('detached service is unrefed but remains explicitly stoppable while its handle is retained', async () => {
  await withPackageRoot(async (rootDirectory) => {
    const child = new FakeChildProcess(4401)
    child.closeOnSignal = 'SIGTERM'
    const calls: SpawnCall[] = []
    const supervisor = new SystemPluginServiceSupervisor({
      package: servicePackage(rootDirectory, 'detached'),
      spawn: captureSpawn([child], calls)
    })

    supervisor.startIfConfigured()
    assert.equal(child.unrefCount, 1)
    assert.equal(calls[0]?.options.detached, true)
    assert.equal(supervisor.snapshot.pid, 4401)

    await supervisor.stop()
    assert.deepEqual(child.killSignals, ['SIGTERM'])
    assert.equal(supervisor.status, 'stopped')
  })
})

test('service package requires an in-root entries.service and background declaration', () => {
  const rootDirectory = resolve('plugin-root')
  assert.throws(() => new SystemPluginServiceSupervisor({
    package: {
      ...servicePackage(rootDirectory, 'app-lifetime'),
      manifest: {
        ...servicePackage(rootDirectory, 'app-lifetime').manifest,
        entries: { service: '../escape.js' }
      }
    }
  }), /escapes/)
  assert.throws(() => new SystemPluginServiceSupervisor({
    package: {
      ...servicePackage(rootDirectory, 'app-lifetime'),
      manifest: {
        ...servicePackage(rootDirectory, 'app-lifetime').manifest,
        background: undefined
      }
    }
  }), /background mode/)
})

test('service supervisor preloads the stable RPC client and returns revision-bound responses', async () => {
  await withPackageRoot(async (rootDirectory) => {
    const child = new FakeChildProcess(4501)
    child.closeOnSignal = 'SIGTERM'
    const calls: SpawnCall[] = []
    const service = servicePackage(rootDirectory, 'app-lifetime')
    const rpcHost = new SystemPluginServiceRpcHost({
      pluginId: service.manifest.id,
      revisionHash: service.revisionHash,
      methods: {
        'test.echo': (params) => params
      }
    })
    const supervisor = new SystemPluginServiceSupervisor({
      package: service,
      executable: 'node-test',
      spawn: captureSpawn([child], calls),
      rpcHost
    })

    supervisor.start()
    assert.deepEqual(calls[0]?.args.slice(0, 2), ['-e', SYSTEM_PLUGIN_SERVICE_RPC_BOOTSTRAP_SOURCE])
    assert.equal(calls[0]?.args[2], resolve(rootDirectory, 'dist/service.js'))
    assert.equal(
      (calls[0]?.options.env as NodeJS.ProcessEnv).KNOWBOOK_SYSTEM_PLUGIN_RPC_PROTOCOL,
      String(SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION)
    )

    child.emit('message', {
      type: SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      pluginId: service.manifest.id,
      revisionHash: service.revisionHash,
      requestId: 'supervisor-rpc',
      method: 'test.echo',
      params: { value: 7 }
    })
    await waitUntil(() => child.sentMessages.length === 1)
    const response = child.sentMessages[0] as SystemPluginServiceRpcResponse
    assert.equal(response.ok, true)
    if (response.ok) assert.deepEqual(response.result, { value: 7 })

    await supervisor.stop()
  })
})

interface SpawnCall {
  executable: string
  args: readonly string[]
  options: SpawnOptions
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly killSignals: NodeJS.Signals[] = []
  unrefCount = 0
  closeOnSignal: NodeJS.Signals | null = null
  connected = true
  readonly sentMessages: unknown[] = []

  constructor(readonly pid: number) {
    super()
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal)
    if (signal === this.closeOnSignal) {
      queueMicrotask(() => this.emit('close', null, signal))
    }
    return true
  }

  unref(): this {
    this.unrefCount += 1
    return this
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sentMessages.push(message)
    queueMicrotask(() => callback?.(null))
    return true
  }
}

function captureSpawn(
  children: FakeChildProcess[],
  calls: SpawnCall[] = []
): SystemPluginServiceSpawn {
  let index = 0
  return (executable, args, options) => {
    calls.push({ executable, args: [...args], options })
    const child = children[index]
    index += 1
    if (!child) throw new Error('No fake service process remains.')
    return child as unknown as ChildProcess
  }
}

function servicePackage(
  rootDirectory: string,
  mode: SystemPluginServiceMode
): SystemPluginServicePackage {
  return {
    rootDirectory,
    revisionHash: 'sha256:test-service',
    manifest: {
      id: 'test.service',
      version: '1.2.3',
      entries: { service: 'dist/service.js' },
      background: { mode, autoStart: true }
    }
  }
}

async function withPackageRoot(
  operation: (rootDirectory: string) => Promise<void>
): Promise<void> {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'knowbook-system-service-'))
  try {
    await operation(rootDirectory)
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true })
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for service event.')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
  }
}
