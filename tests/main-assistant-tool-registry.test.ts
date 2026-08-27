import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantToolRegistry, type AssistantToolDescriptor } from '../src/main/assistant/tool-registry.ts'

const SESSION_SCOPE = { kind: 'session' as const, workspaceId: 'workspace-1', sessionId: 'session-1' }

test('assistant tool registry validates closed typed argument and output schemas', async () => {
  const registry = new AssistantToolRegistry()
  registry.register(descriptor({
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['limit'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false
    }
  }))
  assert.throws(() => registry.validateArguments('test.tool', { limit: 0 }), /minimum/)
  assert.throws(() => registry.validateArguments('test.tool', { limit: 2, extra: true }), /unknown field/)
  assert.deepEqual(registry.validateArguments('test.tool', { limit: 2 }), { limit: 2 })
  await assert.rejects(
    registry.execute('test.tool', { limit: 2 }, context(), async () => ({ ok: 'yes' })),
    /must match type boolean/
  )
})

test('assistant tool registry applies scope, capability, and monotonic guards before execution', async () => {
  const registry = new AssistantToolRegistry()
  registry.register(descriptor({ visibleScopes: ['workspace'], requiredCapabilities: ['documents.read'] }))
  let executed = false
  await assert.rejects(
    registry.execute('test.tool', {}, context(), async () => { executed = true; return null }),
    /not visible/
  )
  await assert.rejects(
    registry.execute('test.tool', {}, {
      scope: { kind: 'workspace', workspaceId: 'workspace-1' },
      signal: new AbortController().signal,
      grantedCapabilities: []
    }, async () => { executed = true; return null }),
    /requires capability/
  )
  registry.addMonotonicGuard(() => true)
  registry.addMonotonicGuard(() => false)
  await assert.rejects(
    registry.execute('test.tool', {}, {
      scope: { kind: 'workspace', workspaceId: 'workspace-1' },
      signal: new AbortController().signal,
      grantedCapabilities: ['documents.read']
    }, async () => { executed = true; return null }),
    /monotonic guard/
  )
  assert.equal(executed, false)
})

test('assistant tool registry enforces cancellation, timeout, concurrency, and result limits', async () => {
  const registry = new AssistantToolRegistry()
  registry.register(descriptor({ timeoutMs: 10, maxResultBytes: 16, concurrentSafe: false }))
  await assert.rejects(
    registry.execute('test.tool', {}, context(), async (signal) => await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })),
    /timed out/
  )
  await assert.rejects(
    registry.execute('test.tool', {}, context(), async () => ({ text: 'a'.repeat(64) })),
    /exceeds 16 bytes/
  )

  let release!: () => void
  const first = registry.execute('test.tool', {}, context(), async () => await new Promise((resolve) => {
    release = () => resolve(null)
  }))
  await Promise.resolve()
  await assert.rejects(
    registry.execute('test.tool', {}, context(), async () => null),
    /does not allow concurrent/
  )
  release()
  await first

  const controller = new AbortController()
  controller.abort(new Error('explicit cancellation'))
  await assert.rejects(
    registry.execute('test.tool', {}, { scope: SESSION_SCOPE, signal: controller.signal }, async () => null),
    /explicit cancellation/
  )
})

function context() {
  return { scope: SESSION_SCOPE, signal: new AbortController().signal }
}

function descriptor(overrides: Partial<AssistantToolDescriptor> = {}): AssistantToolDescriptor {
  return {
    name: 'test_tool',
    eventName: 'test.tool',
    description: 'Test tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    version: 1,
    outputSchema: {},
    display: { title: 'Test', category: 'inspect' },
    visibleScopes: ['session'],
    concurrentSafe: true,
    requiredCapabilities: [],
    approvalPolicy: 'none',
    timeoutMs: 1_000,
    maxResultBytes: 1_024,
    ...overrides
  }
}
