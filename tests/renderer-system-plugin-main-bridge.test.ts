import assert from 'node:assert/strict'
import test from 'node:test'
import { FullTrustPluginRegistry } from '../src/renderer/src/full-trust-plugin-registry'
import type { InvokeSystemPluginMainInput } from '../src/shared/contracts'
import type { SystemPluginServiceRpcJson } from '../src/main/system-plugin/service-rpc'

test('Full Trust renderer Main calls bind the owning identity and reject a deactivated API and stale results', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const registry = new FullTrustPluginRegistry()
  const calls: InvokeSystemPluginMainInput[] = []
  let complete!: (value: SystemPluginServiceRpcJson) => void
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      knowbook: {
        invokeSystemPluginMain: async (input: InvokeSystemPluginMainInput) => {
          calls.push(input)
          if (input.method === 'wait') return new Promise<SystemPluginServiceRpcJson>((resolve) => { complete = resolve })
          return { received: input.input ?? null }
        }
      }
    }
  })
  try {
    const api = await registry.activatePlugin({ id: 'activity-pulse', version: '3.0.0', revisionHash: 'sha256:current' }, () => undefined)
    assert.deepEqual(await api.invokeMain('snapshot', { count: 2 }), { received: { count: 2 } })
    assert.deepEqual(calls[0], {
      pluginId: 'activity-pulse', revisionHash: 'sha256:current', method: 'snapshot', input: { count: 2 }
    })
    const pending = api.invokeMain('wait')
    await registry.deactivatePlugin(api.plugin.id)
    complete({ stale: true })
    await assert.rejects(pending, /not active/)
    await assert.rejects(api.invokeMain('snapshot'), /not active/)
    assert.equal(calls.length, 2)
  } finally {
    await registry.deactivateAll()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
