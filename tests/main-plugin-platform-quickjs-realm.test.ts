import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PluginActivationIdentity,
  PluginActiveOwner,
  PluginCapabilityCall,
  PluginJsonValue
} from '../src/shared/plugin-platform.ts'
import {
  buildPluginRevisionPackage,
  QuickJsWasiPluginRealm
} from '../src/main/plugin-platform/index.ts'

test('QuickJS realm has no Node, Electron, network, or host WASM globals', async () => {
  const package_ = buildPluginRevisionPackage({
    manifest: manifest(),
    workerSource: `
      export const handlers = {
        inspect() {
          return {
            process: typeof globalThis.process,
            require: typeof globalThis.require,
            Buffer: typeof globalThis.Buffer,
            fetch: typeof globalThis.fetch,
            WebAssembly: typeof globalThis.WebAssembly,
            electron: typeof globalThis.electron,
            constructorRealm: (() => {}).constructor === Function
          };
        }
      };
    `
  }).package
  const identity = activationIdentity(package_.revisionId)
  const realm = await QuickJsWasiPluginRealm.create({
    identity,
    package: package_,
    callCapability: async () => {
      throw new Error('No capabilities expected.')
    }
  })

  try {
    const owner = activeOwner(identity)
    realm.commit(owner)
    const result = await realm.invokeHandler(owner, 'inspect', null, new AbortController().signal)
    assert.deepEqual({ ...result as Record<string, PluginJsonValue> }, {
      process: 'undefined',
      require: 'undefined',
      Buffer: 'undefined',
      fetch: 'undefined',
      WebAssembly: 'undefined',
      electron: 'undefined',
      constructorRealm: true
    })
  } finally {
    await realm.dispose()
  }
})

test('QuickJS standard module bridges async calls only through the committed owner', async () => {
  const package_ = buildPluginRevisionPackage({
    manifest: manifest({
      permissions: [{ capability: 'documents.read', version: 1 }],
      standardModules: [{ id: '@knowbook/std/plugin', version: '1.0.0' }]
    }),
    workerSource: `
      import { callCapability, definePlugin } from '@knowbook/std/plugin';
      export default definePlugin({
        activate() {
          return { contributions: [{ descriptor: { slot: 'dashboard', id: 'reader' }, value: { ready: true } }] };
        },
        handlers: {
          async read(input) {
            return await callCapability({
              callId: 'read-1',
              capability: 'documents.read',
              version: 1,
              input
            });
          }
        }
      });
    `
  }).package
  const identity = activationIdentity(package_.revisionId)
  const seen: Array<{ owner: PluginActiveOwner; call: PluginCapabilityCall }> = []
  const realm = await QuickJsWasiPluginRealm.create({
    identity,
    package: package_,
    callCapability: async (owner, call) => {
      seen.push({ owner, call })
      return { title: 'Returned through broker', id: call.input }
    }
  })

  try {
    assert.deepEqual(await realm.activate(), {
      contributions: [{ descriptor: { slot: 'dashboard', id: 'reader' }, value: { ready: true } }]
    })
    const owner = activeOwner(identity)
    realm.commit(owner)
    const result = await realm.invokeHandler(owner, 'read', 'doc-1', new AbortController().signal)

    assert.deepEqual({ ...result as Record<string, PluginJsonValue> }, {
      title: 'Returned through broker',
      id: 'doc-1'
    })
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].owner, owner)
    assert.deepEqual({ ...seen[0].call }, {
      callId: 'read-1',
      capability: 'documents.read',
      version: 1,
      input: 'doc-1'
    })
  } finally {
    await realm.dispose()
  }
})

test('QuickJS rejects capability use during staging before atomic commit', async () => {
  const package_ = buildPluginRevisionPackage({
    manifest: manifest({
      permissions: [{ capability: 'documents.read', version: 1 }],
      standardModules: [{ id: '@knowbook/std/plugin', version: '1.0.0' }]
    }),
    workerSource: `
      import { callCapability } from '@knowbook/std/plugin';
      export async function activate() {
        await callCapability({ capability: 'documents.read', version: 1, input: 'secret' });
        return { contributions: [] };
      }
    `
  }).package
  const identity = activationIdentity(package_.revisionId)
  let calls = 0
  const realm = await QuickJsWasiPluginRealm.create({
    identity,
    package: package_,
    callCapability: async () => {
      calls += 1
      return null
    }
  })

  try {
    await assert.rejects(() => realm.activate(), /unavailable before atomic commit/)
    assert.equal(calls, 0)
  } finally {
    await realm.dispose()
  }
})

test('QuickJS interrupts an infinite handler without blocking the host process', async () => {
  const package_ = buildPluginRevisionPackage({
    manifest: manifest(),
    workerSource: `
      export const handlers = {
        spin() { while (true) {} }
      };
    `
  }).package
  const identity = activationIdentity(package_.revisionId)
  const realm = await QuickJsWasiPluginRealm.create({
    identity,
    package: package_,
    callCapability: async () => null,
    options: { executionSliceMs: 25 }
  })

  try {
    const owner = activeOwner(identity)
    realm.commit(owner)
    const startedAt = Date.now()
    await assert.rejects(
      () => realm.invokeHandler(owner, 'spin', null, new AbortController().signal),
      /interrupted/i
    )
    assert.ok(Date.now() - startedAt < 1_000)
  } finally {
    await realm.dispose()
  }
})

test('QuickJS memory limits surface allocation failures inside the isolated realm', async () => {
  const package_ = buildPluginRevisionPackage({
    manifest: manifest(),
    workerSource: `
      export const handlers = {
        allocate() {
          return new Array(2_000_000).fill('x'.repeat(100));
        }
      };
    `
  }).package
  const identity = activationIdentity(package_.revisionId)
  const realm = await QuickJsWasiPluginRealm.create({
    identity,
    package: package_,
    callCapability: async () => null,
    options: { memoryLimitBytes: 8 * 1024 * 1024 }
  })

  try {
    const owner = activeOwner(identity)
    realm.commit(owner)
    await assert.rejects(
      () => realm.invokeHandler(owner, 'allocate', null, new AbortController().signal),
      /out of memory/i
    )
  } finally {
    await realm.dispose()
  }
})

test('QuickJS module loader rejects Node and undeclared standard module imports', async () => {
  const nodeImport = buildPluginRevisionPackage({
    manifest: manifest(),
    workerSource: `import fs from 'node:fs'; export default fs;`
  }).package
  await assert.rejects(() => QuickJsWasiPluginRealm.create({
    identity: activationIdentity(nodeImport.revisionId),
    package: nodeImport,
    callCapability: async () => null
  }), /not declared or installed/)

  const unsupported = buildPluginRevisionPackage({
    manifest: manifest({
      standardModules: [{ id: '@knowbook/std/not-installed', version: '1.0.0' }]
    }),
    workerSource: 'export const handlers = {}'
  }).package
  await assert.rejects(() => QuickJsWasiPluginRealm.create({
    identity: activationIdentity(unsupported.revisionId),
    package: unsupported,
    callCapability: async () => null
  }), /is not installed/)
})

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'quickjs-probe',
    name: 'QuickJS Probe',
    version: '1.0.0',
    apiVersion: '2',
    permissions: [],
    standardModules: [],
    ...overrides
  }
}

function activationIdentity(revisionId: string): PluginActivationIdentity {
  return {
    pluginId: 'quickjs-probe',
    revisionId,
    runId: 'run-quickjs-probe',
    grantSetId: 'grant-quickjs-probe',
    scope: { kind: 'workspace', workspaceId: 'workspace-1' }
  }
}

function activeOwner(identity: PluginActivationIdentity): PluginActiveOwner {
  return { ...identity, epoch: 1 }
}
