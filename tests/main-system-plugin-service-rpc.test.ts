import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SYSTEM_PLUGIN_SERVICE_RPC_BOOTSTRAP_SOURCE,
  SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
  SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
  SYSTEM_PLUGIN_SERVICE_RPC_RESPONSE,
  SystemPluginServiceRpcClient,
  SystemPluginServiceRpcClientError,
  SystemPluginServiceRpcHost,
  type SystemPluginServiceRpcAuditEvent,
  type SystemPluginServiceRpcRequest,
  type SystemPluginServiceRpcResponse
} from '../src/main/system-plugin/service-rpc.ts'

const identity = {
  pluginId: 'system.rpc.fixture',
  revisionHash: `sha256:${'a'.repeat(64)}`
}

test('service RPC host dispatches only exact revision-bound allowlisted methods and audits metadata', async () => {
  const audits: SystemPluginServiceRpcAuditEvent[] = []
  const host = new SystemPluginServiceRpcHost({
    ...identity,
    methods: {
      'documents.get': (params, context) => ({ params, requestId: context.requestId })
    },
    onAudit: (event) => audits.push(event)
  })

  const success = await host.dispatch(request('one', 'documents.get', { documentId: 'doc-1' }))
  assert.deepEqual(success, {
    type: SYSTEM_PLUGIN_SERVICE_RPC_RESPONSE,
    protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
    ...identity,
    requestId: 'one',
    ok: true,
    result: {
      params: { documentId: 'doc-1' },
      requestId: 'one'
    }
  })

  const missing = await host.dispatch(request('two', 'documents.delete', { documentId: 'doc-1' }))
  assert.equal(missing?.ok, false)
  if (missing?.ok === false) assert.equal(missing.error.code, 'method-not-found')

  const wrongRevision = await host.dispatch({
    ...request('three', 'documents.get', null),
    revisionHash: `sha256:${'b'.repeat(64)}`
  })
  assert.equal(wrongRevision?.ok, false)
  if (wrongRevision?.ok === false) assert.equal(wrongRevision.error.code, 'identity-mismatch')

  assert.deepEqual(audits.map(({ requestId, method, outcome, errorCode }) => ({
    requestId,
    method,
    outcome,
    errorCode
  })), [
    { requestId: 'one', method: 'documents.get', outcome: 'success', errorCode: null },
    { requestId: 'two', method: 'documents.delete', outcome: 'rejected', errorCode: 'method-not-found' },
    { requestId: 'three', method: 'documents.get', outcome: 'rejected', errorCode: 'identity-mismatch' }
  ])
  assert.equal(JSON.stringify(audits).includes('doc-1'), false)
})

test('service RPC host rejects open message shapes, dangerous keys, excessive payloads and invalid results', async () => {
  const host = new SystemPluginServiceRpcHost({
    ...identity,
    maxPayloadBytes: 128,
    methods: {
      'test.echo': (params) => params,
      'test.invalid-result': () => new Date()
    }
  })

  const openShape = await host.dispatch({
    ...request('open', 'test.echo', null),
    unexpected: true
  })
  assert.equal(openShape?.ok, false)
  if (openShape?.ok === false) assert.equal(openShape.error.code, 'invalid-request')

  const polluted = Object.create(null) as Record<string, unknown>
  polluted.safe = true
  Object.defineProperty(polluted, '__proto__', { enumerable: true, value: { polluted: true } })
  const dangerous = await host.dispatch(request(
    'dangerous',
    'test.echo',
    polluted as SystemPluginServiceRpcRequest['params']
  ))
  assert.equal(dangerous?.ok, false)
  if (dangerous?.ok === false) assert.equal(dangerous.error.code, 'invalid-request')
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)

  const oversized = await host.dispatch(request('large', 'test.echo', { value: 'x'.repeat(256) }))
  assert.equal(oversized?.ok, false)
  if (oversized?.ok === false) assert.equal(oversized.error.code, 'invalid-request')

  const invalidResult = await host.dispatch(request('result', 'test.invalid-result', null))
  assert.equal(invalidResult?.ok, false)
  if (invalidResult?.ok === false) assert.equal(invalidResult.error.code, 'invalid-result')
})

test('service RPC host bounds concurrency, times out handlers and propagates lifecycle cancellation', async () => {
  let release!: () => void
  const blocker = new Promise<void>((resolve) => { release = resolve })
  const host = new SystemPluginServiceRpcHost({
    ...identity,
    timeoutMs: 20,
    maxConcurrentRequests: 1,
    methods: {
      'test.wait': async (_params, context) => {
        await blocker
        if (context.signal.aborted) throw context.signal.reason
        return 'done'
      },
      'test.never': () => new Promise(() => undefined)
    }
  })

  const first = host.dispatch(request('first', 'test.wait', null))
  const busy = await host.dispatch(request('busy', 'test.wait', null))
  assert.equal(busy?.ok, false)
  if (busy?.ok === false) assert.equal(busy.error.code, 'busy')
  release()
  assert.equal((await first)?.ok, true)

  const timedOut = await host.dispatch(request('timeout', 'test.never', null))
  assert.equal(timedOut?.ok, false)
  if (timedOut?.ok === false) assert.equal(timedOut.error.code, 'timeout')

  const controller = new AbortController()
  const cancelled = host.dispatch(request('cancel', 'test.never', null), {
    signal: controller.signal
  })
  controller.abort(new Error('service exited'))
  const cancelledResponse = await cancelled
  assert.equal(cancelledResponse?.ok, false)
  if (cancelledResponse?.ok === false) assert.equal(cancelledResponse.error.code, 'cancelled')
})

test('service RPC client supports concurrent calls and ignores responses for another revision', async () => {
  const host = new SystemPluginServiceRpcHost({
    ...identity,
    methods: {
      'math.double': async (params) => {
        const value = (params as { value: number }).value
        await new Promise((resolve) => setTimeout(resolve, value === 1 ? 5 : 1))
        return value * 2
      }
    }
  })
  const transport = new LoopbackTransport(host)
  let sequence = 0
  const client = new SystemPluginServiceRpcClient({
    ...identity,
    transport,
    createRequestId: () => `request-${++sequence}`
  })

  const first = client.call('math.double', { value: 1 })
  const second = client.call('math.double', { value: 2 })
  transport.emit('message', {
    type: SYSTEM_PLUGIN_SERVICE_RPC_RESPONSE,
    protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
    pluginId: identity.pluginId,
    revisionHash: `sha256:${'f'.repeat(64)}`,
    requestId: 'request-1',
    ok: true,
    result: 999
  })
  assert.deepEqual(await Promise.all([first, second]), [2, 4])

  await assert.rejects(
    client.call('missing.method'),
    (error: unknown) => error instanceof SystemPluginServiceRpcClientError
      && error.code === 'method-not-found'
  )
  client.dispose()
  await assert.rejects(
    client.call('math.double', { value: 3 }),
    (error: unknown) => error instanceof SystemPluginServiceRpcClientError
      && error.code === 'disposed'
  )
})

test('service RPC client rejects pending work on disconnect and supports caller cancellation', async () => {
  const transport = new SilentTransport()
  const client = new SystemPluginServiceRpcClient({
    ...identity,
    transport,
    timeoutMs: 1_000,
    createRequestId: () => 'pending'
  })
  const pending = client.call('test.pending')
  transport.connected = false
  transport.emit('disconnect')
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof SystemPluginServiceRpcClientError
      && error.code === 'transport-error'
  )

  transport.connected = true
  const controller = new AbortController()
  const cancelled = client.call('test.cancelled', null, { signal: controller.signal })
  controller.abort()
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof SystemPluginServiceRpcClientError
      && error.code === 'cancelled'
  )
  client.dispose()
})

test('service RPC bootstrap exposes globalThis.knowbookService before running the real entry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-service-rpc-bootstrap-'))
  const entryPath = join(directory, 'service.cjs')
  const resultPath = join(directory, 'result.json')
  writeFileSync(entryPath, `
const { writeFileSync } = require('node:fs')
const api = globalThis.knowbookService
if (!api || api.protocolVersion !== 1) throw new Error('RPC global was not installed')
void api.call('test.echo', { source: 'real-child' }).then((result) => {
  writeFileSync(process.env.RPC_RESULT_PATH, JSON.stringify({
    result,
    pluginId: api.pluginId,
    revisionHash: api.revisionHash
  }))
  api.ready({ rpc: true })
  setTimeout(() => {
    api.dispose()
    if (process.connected) process.disconnect()
  }, 10)
})
`, 'utf8')
  const host = new SystemPluginServiceRpcHost({
    ...identity,
    methods: {
      'test.echo': (params) => ({ received: params })
    }
  })
  const child = spawn(process.execPath, [
    '-e',
    SYSTEM_PLUGIN_SERVICE_RPC_BOOTSTRAP_SOURCE,
    entryPath
  ], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      KNOWBOOK_SYSTEM_PLUGIN_ID: identity.pluginId,
      KNOWBOOK_SYSTEM_PLUGIN_REVISION: identity.revisionHash,
      RPC_RESULT_PATH: resultPath
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`RPC bootstrap timed out: ${stderr}`)), 5_000)
    child.on('message', (message: unknown) => {
      const candidate = message as { type?: unknown }
      if (candidate?.type === 'knowbook:service:ready') {
        clearTimeout(timeout)
        resolve()
        return
      }
      void host.dispatch(message).then((response) => {
        if (response && child.connected) child.send(response)
      })
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      if (!existsSync(resultPath)) {
        clearTimeout(timeout)
        reject(new Error(`RPC bootstrap exited early with code ${String(code)}: ${stderr}`))
      }
    })
  })
  try {
    await ready
    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), {
      result: { received: { source: 'real-child' } },
      ...identity
    })
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    rmSync(directory, { recursive: true, force: true })
  }
})

function request(
  requestId: string,
  method: string,
  params: SystemPluginServiceRpcRequest['params']
): SystemPluginServiceRpcRequest {
  return {
    type: SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
    protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
    ...identity,
    requestId,
    method,
    params
  }
}

class SilentTransport extends EventEmitter {
  connected = true
  readonly sent: unknown[] = []

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    queueMicrotask(() => callback?.(null))
    return true
  }
}

class LoopbackTransport extends SilentTransport {
  constructor(private readonly host: SystemPluginServiceRpcHost) {
    super()
  }

  override send(message: unknown, callback?: (error: Error | null) => void): boolean {
    super.send(message, callback)
    queueMicrotask(() => {
      void this.host.dispatch(message).then((response: SystemPluginServiceRpcResponse | null) => {
        if (response) this.emit('message', response)
      })
    })
    return true
  }
}
