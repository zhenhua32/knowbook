import assert from 'node:assert/strict'
import test from 'node:test'
import { SystemPluginRendererBridge } from '../src/main/system-plugin/renderer-bridge'
import type { InvokeSystemPluginMainInput } from '../src/shared/contracts'
import type { SystemPluginServiceRpcJson } from '../src/main/system-plugin/service-rpc'

const identity = { pluginId: 'activity-pulse', revisionHash: 'sha256:current' }
const request = (method: string, input?: SystemPluginServiceRpcJson): InvokeSystemPluginMainInput => ({
  ...identity, method, ...(input === undefined ? {} : { input })
})

test('renderer bridge isolates plugin revisions, clones payloads, and supports disposer replacement', async () => {
  const bridge = new SystemPluginRendererBridge({ isRevisionActive: (candidate) => candidate.revisionHash === identity.revisionHash })
  const owner = bridge.forPlugin(identity)
  const result = { items: ['original'] }
  const dispose = owner.handle('snapshot', (input) => {
    const receivedInput = input as { items: string[] }
    receivedInput.items.push('main')
    return result
  })
  const input = { items: ['renderer'] }
  const received = await bridge.invoke(request('snapshot', input))
  assert.deepEqual(input.items, ['renderer'])
  assert.deepEqual(received, result)
  assert.notEqual(received, result)
  await assert.rejects(bridge.invoke({ ...request('snapshot'), revisionHash: 'sha256:old' }), /exact staging or active/)
  await assert.rejects(bridge.invoke({ ...request('snapshot'), pluginId: 'another-plugin' }), /not registered/)
  assert.throws(() => owner.handle('snapshot', () => null), /already registered/)
  dispose()
  owner.handle('snapshot', () => ({ replaced: true }))
  dispose()
  assert.deepEqual(await bridge.invoke(request('snapshot')), { replaced: true })
})

test('renderer bridge rejects malformed methods and non-JSON or oversized request and result payloads', async () => {
  const bridge = new SystemPluginRendererBridge({ isRevisionActive: () => true, maxPayloadBytes: 256 })
  const owner = bridge.forPlugin(identity)
  owner.handle('echo', (input) => input)
  owner.handle('invalid', () => ({ value: Infinity }))
  owner.handle('oversized', () => 'x'.repeat(257))
  for (const method of ['', 'constructor()', '../snapshot', 'a'.repeat(129)]) {
    assert.throws(() => owner.handle(method, () => null), /method is invalid/)
    await assert.rejects(bridge.invoke(request(method)), /method is invalid/)
  }
  const cyclic: Record<string, unknown> = {}
  cyclic.loop = cyclic
  for (const input of [Infinity, new Date(), { callback: () => null }, cyclic, { data: 'x'.repeat(257) }]) {
    await assert.rejects(bridge.invoke(request('echo', input as SystemPluginServiceRpcJson)))
  }
  await assert.rejects(bridge.invoke({ ...request('echo'), extra: true } as InvokeSystemPluginMainInput), /unsupported shape/)
  await assert.rejects(bridge.invoke(request('invalid')), /finite/)
  await assert.rejects(bridge.invoke(request('oversized')), /maximum size/)
})

test('renderer bridge rejects results after a revision ceases to be active', async () => {
  let active = true
  let complete!: (value: SystemPluginServiceRpcJson) => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const bridge = new SystemPluginRendererBridge({ isRevisionActive: () => active })
  bridge.forPlugin(identity).handle('wait', () => {
    started()
    return new Promise((resolve) => { complete = resolve })
  })
  const pending = bridge.invoke(request('wait'))
  await entered
  active = false
  complete({ stale: true })
  await assert.rejects(pending, /exact staging or active/)
})

test('renderer bridge disposal promptly rejects pending calls and prevents subsequent invocations', async () => {
  const bridge = new SystemPluginRendererBridge({ isRevisionActive: () => true })
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const dispose = bridge.forPlugin(identity).handle('wait', () => {
    started()
    return new Promise(() => undefined)
  })
  const pending = bridge.invoke(request('wait'))
  await entered
  dispose()
  await assert.rejects(pending, /disposed/)
  await assert.rejects(bridge.invoke(request('wait')), /not registered/)
})

test('renderer bridge bounds concurrent requests and timeouts and releases capacity after failures', async () => {
  const bridge = new SystemPluginRendererBridge({ isRevisionActive: () => true, timeoutMs: 20, maxConcurrentRequests: 1 })
  const owner = bridge.forPlugin(identity)
  owner.handle('wait', () => new Promise(() => undefined))
  owner.handle('ready', () => 'ready')
  owner.handle('fail', () => { throw new Error('handler failure') })
  const pending = bridge.invoke(request('wait'))
  await assert.rejects(bridge.invoke(request('ready')), /busy/)
  await assert.rejects(pending, /timed out/)
  await assert.rejects(bridge.invoke(request('fail')), /handler failure/)
  assert.equal(await bridge.invoke(request('ready')), 'ready')
})
