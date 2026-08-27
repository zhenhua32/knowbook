import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PluginActiveOwner,
  PluginCapabilityCall,
  PluginGrantSet,
  PluginJsonValue,
  PluginPlatformScope
} from '../src/shared/plugin-platform.ts'
import {
  PluginCapabilityBroker,
  PluginCapabilityError,
  type PluginCapabilityAuditRecord,
  PluginPlatformKernel
} from '../src/main/plugin-platform/index.ts'

const workspaceScope: PluginPlatformScope = {
  kind: 'workspace',
  workspaceId: 'workspace-1'
}

test('capability broker validates input, exact grants, constraints, output, and audit', async () => {
  const kernel = new PluginPlatformKernel()
  const audit: PluginCapabilityAuditRecord[] = []
  const broker = new PluginCapabilityBroker(kernel, {
    audit: (record) => {
      audit.push(record)
    }
  })
  broker.register({
    id: 'documents.read',
    version: 1,
    scopes: ['workspace', 'session'],
    parseInput: parseDocumentInput,
    authorize: (context, input) => {
      const constraints = context.grant.constraints as { prefix?: string } | undefined
      if (constraints?.prefix && !input.documentId.startsWith(constraints.prefix)) {
        throw new Error('Document is outside the grant prefix.')
      }
    },
    execute: (_context, input) => ({ documentId: input.documentId, title: 'Allowed' })
  })
  broker.register({
    id: 'documents.update',
    version: 1,
    scopes: ['workspace'],
    parseInput: parseDocumentInput,
    execute: () => ({ updated: true })
  })
  broker.registerGrantSet(grantSet('grant-1', 'rev-1', [
    { capability: 'documents.read', version: 1, constraints: { prefix: 'allowed-' } }
  ]))
  const owner = await activate(kernel, 'rev-1', 'run-1', 'grant-1')

  const result = await broker.invoke(owner, call('documents.read', { documentId: 'allowed-1' }))
  assert.deepEqual(result, { documentId: 'allowed-1', title: 'Allowed' })

  await rejectsWithCode(
    broker.invoke(owner, call('documents.update', { nope: true })),
    'invalid-input'
  )
  await rejectsWithCode(
    broker.invoke(owner, call('documents.update', { documentId: 'allowed-1' })),
    'grant-denied'
  )
  await rejectsWithCode(
    broker.invoke(owner, call('documents.read', { documentId: 'private-1' })),
    'scope-denied'
  )

  assert.deepEqual(audit.map((record) => record.outcome), [
    'succeeded',
    'failed',
    'denied',
    'denied'
  ])
  assert.equal('input' in audit[0], false)
  assert.equal(audit[0].revisionId, 'rev-1')
  await kernel.destroy()
})

test('grant sets are bound to exact revision and scope, and revocation cancels in-flight calls', async () => {
  const kernel = new PluginPlatformKernel()
  const broker = new PluginCapabilityBroker(kernel)
  broker.register({
    id: 'documents.read',
    version: 1,
    scopes: ['workspace'],
    parseInput: parseDocumentInput,
    execute: (context) => new Promise<PluginJsonValue>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
    })
  })
  broker.registerGrantSet(grantSet('grant-wrong-revision', 'rev-other', [
    { capability: 'documents.read', version: 1 }
  ]))
  const wrongOwner = await activate(kernel, 'rev-1', 'run-wrong', 'grant-wrong-revision')
  await rejectsWithCode(
    broker.invoke(wrongOwner, call('documents.read', { documentId: 'doc-1' })),
    'grant-denied'
  )
  await kernel.stop('probe', workspaceScope)

  broker.registerGrantSet(grantSet('grant-live', 'rev-1', [
    { capability: 'documents.read', version: 1 }
  ]))
  const owner = await activate(kernel, 'rev-1', 'run-live', 'grant-live')
  const invocation = broker.invoke(owner, call('documents.read', { documentId: 'doc-1' }))
  await Promise.resolve()

  assert.equal(broker.revokeGrantSet('grant-live'), true)
  await rejectsWithCode(invocation, 'grant-revoked')
  await rejectsWithCode(
    broker.invoke(owner, call('documents.read', { documentId: 'doc-1' })),
    'grant-revoked'
  )
  await kernel.destroy()
})

test('capability timeout returns promptly while kernel keeps uncooperative work in drain tracking', async () => {
  const kernel = new PluginPlatformKernel()
  const broker = new PluginCapabilityBroker(kernel)
  const gate = deferred<PluginJsonValue>()
  broker.register({
    id: 'ai.complete',
    version: 1,
    scopes: ['workspace'],
    timeoutMs: 5,
    parseInput: (input) => input,
    execute: async () => gate.promise
  })
  broker.registerGrantSet(grantSet('grant-ai', 'rev-1', [
    { capability: 'ai.complete', version: 1 }
  ]))
  const firstOwner = await activate(kernel, 'rev-1', 'run-1', 'grant-ai')

  await rejectsWithCode(
    broker.invoke(firstOwner, call('ai.complete', { prompt: 'hello' })),
    'timed-out'
  )

  broker.registerGrantSet(grantSet('grant-ai-2', 'rev-2', [
    { capability: 'ai.complete', version: 1 }
  ]))
  const next = kernel.beginActivation({
    pluginId: 'probe',
    revisionId: 'rev-2',
    runId: 'run-2',
    grantSetId: 'grant-ai-2',
    scope: workspaceScope
  })
  const receipt = await next.commit(0)
  const drain = await receipt.previousDrain
  assert.equal(drain?.timedOut, true)

  gate.resolve({ late: true })
  await Promise.resolve()
  await kernel.destroy()
})

test('capability broker enforces per-run concurrency and rejects non-JSON results', async () => {
  const kernel = new PluginPlatformKernel()
  const broker = new PluginCapabilityBroker(kernel, { maxConcurrentCallsPerRun: 1 })
  const gate = deferred<PluginJsonValue>()
  broker.register({
    id: 'network.fetch',
    version: 1,
    scopes: ['workspace'],
    parseInput: (input) => input,
    execute: () => gate.promise
  })
  broker.register({
    id: 'ui.notify',
    version: 1,
    scopes: ['workspace'],
    parseInput: (input) => input,
    execute: () => undefined
  })
  broker.registerGrantSet(grantSet('grant-many', 'rev-1', [
    { capability: 'network.fetch', version: 1 },
    { capability: 'ui.notify', version: 1 }
  ]))
  const owner = await activate(kernel, 'rev-1', 'run-1', 'grant-many')
  const first = broker.invoke(owner, call('network.fetch', { url: 'https://example.com' }))
  await Promise.resolve()

  await rejectsWithCode(
    broker.invoke(owner, call('network.fetch', { url: 'https://example.com/2' })),
    'quota-exceeded'
  )
  gate.resolve({ ok: true })
  await first
  await rejectsWithCode(
    broker.invoke(owner, call('ui.notify', { message: 'hello' })),
    'invalid-result'
  )
  await kernel.destroy()
})

test('capability broker refuses stale owners after an atomic revision switch', async () => {
  const kernel = new PluginPlatformKernel()
  const broker = new PluginCapabilityBroker(kernel)
  broker.register({
    id: 'documents.read',
    version: 1,
    scopes: ['workspace'],
    parseInput: parseDocumentInput,
    execute: () => ({ ok: true })
  })
  broker.registerGrantSet(grantSet('grant-1', 'rev-1', [
    { capability: 'documents.read', version: 1 }
  ]))
  broker.registerGrantSet(grantSet('grant-2', 'rev-2', [
    { capability: 'documents.read', version: 1 }
  ]))
  const oldOwner = await activate(kernel, 'rev-1', 'run-1', 'grant-1')
  await activate(kernel, 'rev-2', 'run-2', 'grant-2')

  await rejectsWithCode(
    broker.invoke(oldOwner, call('documents.read', { documentId: 'doc-1' })),
    'stale-owner'
  )
  await kernel.destroy()
})

test('capability broker enforces per-run rate and AI token windows', async () => {
  const kernel = new PluginPlatformKernel()
  let now = new Date('2026-08-25T00:00:00.000Z')
  const broker = new PluginCapabilityBroker(kernel, {
    maxCallsPerMinutePerRun: 2,
    maxAiTokensPerMinutePerRun: 100,
    now: () => now
  })
  broker.register({
    id: 'ai.complete',
    version: 1,
    scopes: ['workspace'],
    parseInput: (input) => input as { maxTokens: number },
    quotaCost: (input) => ({ aiTokens: input.maxTokens }),
    execute: () => ({ text: 'ok' })
  })
  broker.registerGrantSet(grantSet('grant-rate', 'rev-1', [
    { capability: 'ai.complete', version: 1 }
  ]))
  const owner = await activate(kernel, 'rev-1', 'run-rate', 'grant-rate')
  await broker.invoke(owner, call('ai.complete', { maxTokens: 60 }))
  await rejectsWithCode(broker.invoke(owner, call('ai.complete', { maxTokens: 60 })), 'quota-exceeded')
  await rejectsWithCode(broker.invoke(owner, call('ai.complete', { maxTokens: 1 })), 'quota-exceeded')

  now = new Date('2026-08-25T00:01:01.000Z')
  assert.deepEqual(await broker.invoke(owner, call('ai.complete', { maxTokens: 100 })), { text: 'ok' })
  await kernel.destroy()
})

function call(capability: string, input: PluginJsonValue): PluginCapabilityCall {
  return { capability, version: 1, input }
}

function grantSet(
  id: string,
  revisionId: string,
  grants: PluginGrantSet['grants']
): PluginGrantSet {
  return {
    id,
    pluginId: 'probe',
    revisionId,
    scope: workspaceScope,
    grants,
    createdAt: '2026-08-25T00:00:00.000Z'
  }
}

async function activate(
  kernel: PluginPlatformKernel,
  revisionId: string,
  runId: string,
  grantSetId: string
): Promise<PluginActiveOwner> {
  const stage = kernel.beginActivation({
    pluginId: 'probe',
    revisionId,
    runId,
    grantSetId,
    scope: workspaceScope
  })
  return (await stage.commit()).owner
}

function parseDocumentInput(input: PluginJsonValue): { documentId: string } {
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || typeof input.documentId !== 'string'
  ) {
    throw new Error('documentId is required')
  }
  return { documentId: input.documentId }
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: PluginCapabilityError['code']
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof PluginCapabilityError, true)
    assert.equal((error as PluginCapabilityError).code, code)
    return true
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, resolve: (value) => release(value) }
}
