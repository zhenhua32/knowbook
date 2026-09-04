import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import test from 'node:test'
import {
  SYSTEM_PLUGIN_SERVICE_RPC_BOOTSTRAP_SOURCE,
  SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
  SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
  SystemPluginServiceRpcHost
} from '../src/main/system-plugin/service-rpc.ts'
import {
  createSystemPluginServiceRpcEndpoint,
  SYSTEM_PLUGIN_SERVICE_RPC_CONNECT,
  SYSTEM_PLUGIN_SERVICE_RPC_CONNECTED,
  SystemPluginServiceRpcSocketServer,
  type SystemPluginServiceRpcLifecycleMessage
} from '../src/main/system-plugin/service-rpc-transport.ts'

const identity = {
  pluginId: 'system.rpc.transport.fixture',
  revisionHash: `sha256:${'c'.repeat(64)}`
}

test('service RPC endpoint derivation is stable, scoped and platform-specific', () => {
  const first = createSystemPluginServiceRpcEndpoint({
    namespaceRoot: 'C:\\Users\\fixture\\KnowBook',
    pluginId: identity.pluginId,
    platform: 'win32'
  })
  const repeated = createSystemPluginServiceRpcEndpoint({
    namespaceRoot: 'C:\\Users\\fixture\\KnowBook',
    pluginId: identity.pluginId,
    platform: 'win32'
  })
  const other = createSystemPluginServiceRpcEndpoint({
    namespaceRoot: 'C:\\Users\\fixture\\KnowBook',
    pluginId: `${identity.pluginId}.other`,
    platform: 'win32'
  })
  assert.equal(first, repeated)
  assert.notEqual(first, other)
  assert.match(first, /^\\\\\.\\pipe\\knowbook-system-plugin-[0-9a-f]{40}$/)

  const unix = createSystemPluginServiceRpcEndpoint({
    namespaceRoot: '/home/fixture/.config/knowbook',
    pluginId: identity.pluginId,
    platform: 'linux',
    temporaryDirectory: '/tmp'
  })
  assert.match(unix, /^[/\\]tmp[/\\]knowbook-system-plugin-[0-9a-f]{40}\.sock$/)
})

test('service RPC socket rejects the wrong launch token and accepts exact revision-bound traffic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-service-rpc-socket-'))
  const endpoint = createSystemPluginServiceRpcEndpoint({
    namespaceRoot: root,
    pluginId: identity.pluginId
  })
  const lifecycle: SystemPluginServiceRpcLifecycleMessage[] = []
  const host = new SystemPluginServiceRpcHost({
    ...identity,
    methods: {
      'test.echo': (params) => params
    }
  })
  const server = new SystemPluginServiceRpcSocketServer({
    ...identity,
    endpoint,
    token: 'exact-launch-token',
    rpcHost: host,
    onLifecycle: (event) => lifecycle.push(event)
  })
  try {
    await server.start()

    const rejected = await JsonLinePeer.connect(endpoint)
    rejected.send(connectMessage('wrong-launch-token'))
    await rejected.waitForClose()

    const peer = await JsonLinePeer.connect(endpoint)
    peer.send(connectMessage('exact-launch-token'))
    assert.deepEqual(await peer.nextMessage(), {
      type: SYSTEM_PLUGIN_SERVICE_RPC_CONNECTED,
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      ...identity
    })
    peer.send({
      type: SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      ...identity,
      requestId: 'socket-echo',
      method: 'test.echo',
      params: { via: 'socket' }
    })
    assert.deepEqual(await peer.nextMessage(), {
      type: 'knowbook:service:rpc-response',
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      ...identity,
      requestId: 'socket-echo',
      ok: true,
      result: { via: 'socket' }
    })
    peer.send({
      type: 'knowbook:service:heartbeat',
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      ...identity,
      payload: { alive: true }
    })
    await waitFor(() => lifecycle.length === 1)
    assert.deepEqual(lifecycle[0], {
      type: 'knowbook:service:heartbeat',
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      ...identity,
      payload: { alive: true }
    })
    peer.close()
  } finally {
    await server.close()
    if (process.platform !== 'win32') assert.equal(existsSync(endpoint), false)
    rmSync(root, { recursive: true, force: true })
  }
})

test('closing the service RPC transport aborts in-flight method work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-service-rpc-abort-'))
  const endpoint = createSystemPluginServiceRpcEndpoint({
    namespaceRoot: root,
    pluginId: identity.pluginId
  })
  let resolveStarted!: () => void
  let resolveAborted!: (reason: unknown) => void
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })
  const aborted = new Promise<unknown>((resolve) => { resolveAborted = resolve })
  const server = new SystemPluginServiceRpcSocketServer({
    ...identity,
    endpoint,
    token: 'abort-launch-token',
    rpcHost: new SystemPluginServiceRpcHost({
      ...identity,
      methods: {
        'test.wait': (_params, context) => new Promise((_resolve, reject) => {
          resolveStarted()
          context.signal.addEventListener('abort', () => {
            resolveAborted(context.signal.reason)
            reject(context.signal.reason)
          }, { once: true })
        })
      }
    })
  })
  try {
    await server.start()
    const peer = await JsonLinePeer.connect(endpoint)
    peer.send(connectMessage('abort-launch-token'))
    await peer.nextMessage()
    peer.send({
      type: SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      ...identity,
      requestId: 'socket-wait',
      method: 'test.wait',
      params: null
    })
    await started
    await server.close()
    const reason = await aborted
    assert.match(String(reason), /transport closed/i)
    await peer.waitForClose()
  } finally {
    await server.close()
    if (process.platform !== 'win32') assert.equal(existsSync(endpoint), false)
    rmSync(root, { recursive: true, force: true })
  }
})

test('detached service bootstrap reconnects to a restarted host without restarting its process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-service-rpc-reconnect-'))
  const entryPath = join(root, 'service.cjs')
  const resultPath = join(root, 'rpc-results.jsonl')
  const endpoint = createSystemPluginServiceRpcEndpoint({
    namespaceRoot: root,
    pluginId: identity.pluginId
  })
  const token = 'persisted-detached-launch-token'
  writeFileSync(entryPath, `
const { appendFileSync } = require('node:fs')
const api = globalThis.knowbookService
if (!api || api.protocolVersion !== 1) throw new Error('RPC global was not installed')
let running = false
const poll = async () => {
  if (running) return
  running = true
  try {
    const result = await api.call('test.generation', { pid: process.pid }, { timeoutMs: 300 })
    appendFileSync(process.env.RPC_RESULT_PATH, JSON.stringify({ pid: process.pid, result }) + '\\n')
  } catch {}
  running = false
}
const interval = setInterval(poll, 50)
void poll()
const stop = () => {
  clearInterval(interval)
  api.dispose()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`, 'utf8')

  let generation = 1
  const createServer = (onLifecycle?: (event: SystemPluginServiceRpcLifecycleMessage) => void) => (
    new SystemPluginServiceRpcSocketServer({
      ...identity,
      endpoint,
      token,
      rpcHost: new SystemPluginServiceRpcHost({
        ...identity,
        methods: {
          'test.generation': (params) => ({ generation, request: params })
        }
      }),
      ...(onLifecycle ? { onLifecycle } : {})
    })
  )
  const firstServer = createServer()
  let secondServer: SystemPluginServiceRpcSocketServer | null = null
  let child: ChildProcess | null = null
  let stderr = ''
  try {
    await firstServer.start()
    child = spawn(process.execPath, ['-e', SYSTEM_PLUGIN_SERVICE_RPC_BOOTSTRAP_SOURCE, entryPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        KNOWBOOK_SYSTEM_PLUGIN_ID: identity.pluginId,
        KNOWBOOK_SYSTEM_PLUGIN_REVISION: identity.revisionHash,
        KNOWBOOK_SYSTEM_PLUGIN_RPC_ENDPOINT: endpoint,
        KNOWBOOK_SYSTEM_PLUGIN_RPC_TOKEN: token,
        RPC_RESULT_PATH: resultPath
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    await waitFor(() => readResults(resultPath).some((item) => item.result.generation === 1), 8_000)
    const originalPid = child.pid

    await firstServer.close()
    assert.equal(child.exitCode, null)
    generation = 2
    let resolveReconnected!: () => void
    const reconnected = new Promise<void>((resolve) => {
      resolveReconnected = resolve
    })
    secondServer = createServer((event) => {
      if (
        event.type === 'knowbook:service:heartbeat'
        && (event.payload as { reconnected?: unknown }).reconnected === true
      ) resolveReconnected()
    })
    await secondServer!.start()
    await Promise.all([
      reconnected,
      waitFor(() => readResults(resultPath).some((item) => item.result.generation === 2), 8_000)
    ])
    assert.equal(child.pid, originalPid)
    assert.equal(child.exitCode, null)
    assert.deepEqual(
      [...new Set(readResults(resultPath).map((item) => item.result.generation))],
      [1, 2]
    )
  } catch (error) {
    throw new Error(`Detached RPC reconnect fixture failed: ${String(error)}\n${stderr}`)
  } finally {
    await firstServer.close().catch(() => undefined)
    await secondServer?.close().catch(() => undefined)
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await waitForChildExit(child, 2_000)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    rmSync(root, { recursive: true, force: true })
  }
})

function connectMessage(token: string): Record<string, unknown> {
  return {
    type: SYSTEM_PLUGIN_SERVICE_RPC_CONNECT,
    protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
    ...identity,
    token
  }
}

function readResults(path: string): Array<{
  pid: number
  result: { generation: number; request: { pid: number } }
}> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms.`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ])
}

class JsonLinePeer {
  private buffer = ''
  private readonly messages: unknown[] = []
  private readonly waiters: Array<(message: unknown) => void> = []
  private closed = false
  private readonly closeWaiters: Array<() => void> = []

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.handleData(chunk))
    socket.on('error', () => undefined)
    socket.once('close', () => {
      this.closed = true
      for (const resolve of this.closeWaiters.splice(0)) resolve()
    })
  }

  static async connect(endpoint: string): Promise<JsonLinePeer> {
    const socket = createConnection(endpoint)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return new JsonLinePeer(socket)
  }

  send(message: unknown): void {
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  nextMessage(): Promise<unknown> {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift())
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  waitForClose(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise((resolve) => this.closeWaiters.push(resolve))
  }

  close(): void {
    this.socket.destroy()
  }

  private handleData(chunk: string): void {
    this.buffer += chunk
    let lineEnd = this.buffer.indexOf('\n')
    while (lineEnd >= 0) {
      const line = this.buffer.slice(0, lineEnd)
      this.buffer = this.buffer.slice(lineEnd + 1)
      if (line.trim()) {
        const message = JSON.parse(line)
        const waiter = this.waiters.shift()
        if (waiter) waiter(message)
        else this.messages.push(message)
      }
      lineEnd = this.buffer.indexOf('\n')
    }
  }
}
