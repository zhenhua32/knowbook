import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electron from 'electron'

const { app, utilityProcess } = electron
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
const revisionId = `sha256:${'a'.repeat(64)}`
const identity = {
  pluginId: 'runtime-smoke',
  revisionId,
  runId: 'runtime-smoke-run',
  grantSetId: 'runtime-smoke-grant',
  scope: { kind: 'workspace', workspaceId: 'runtime-smoke-workspace' }
}
const owner = { ...identity, epoch: 1 }

void app.whenReady().then(run).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})

async function run() {
const mainOutput = resolve('out/main')
const runtimeEntry = readdirSync(mainOutput)
  .find((name) => /^quickjs-runtime-process-[A-Za-z0-9_-]+\.js$/.test(name))
if (!runtimeEntry) {
  throw new Error('Build the app before running the QuickJS runtime smoke probe.')
}

const child = utilityProcess.fork(join(mainOutput, runtimeEntry), [], {
  stdio: 'pipe',
  serviceName: 'KnowBook QuickJS Runtime Smoke'
})
const pending = new Map()
let sequence = 0
let capabilityCalls = 0

const exitFailure = new Promise((_, reject) => {
  child.once('exit', (code) => reject(new Error(`QuickJS utility process exited early (${code}).`)))
})

child.on('message', (message) => {
  if (message?.kind === 'capability-call') {
    capabilityCalls += 1
    child.postMessage({
      kind: 'capability-result',
      capabilityRequestId: message.capabilityRequestId,
      identity: message.identity,
      ok: true,
      output: { documentId: message.call.input.documentId, title: 'Broker result' }
    })
    return
  }
  if (message?.kind !== 'response') {
    return
  }
  const request = pending.get(message.requestId)
  if (!request) {
    return
  }
  pending.delete(message.requestId)
  if (message.ok) {
    request.resolve(message.output)
  } else {
    request.reject(new Error(message.error || 'Runtime request failed.'))
  }
})

function request(identity_, command, timeoutMs = 10_000) {
  const requestId = ++sequence
  const operation = new Promise((resolve_, reject_) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId)
      reject_(new Error(`Runtime smoke request ${command.type} timed out.`))
    }, timeoutMs)
    pending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeout)
        resolve_(value)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject_(error)
      }
    })
    child.postMessage({ kind: 'request', requestId, identity: identity_, command })
  })
  return Promise.race([operation, exitFailure])
}

try {
  await request(identity, {
    type: 'initialize',
    package: {
      revisionId,
      contentHash: 'a'.repeat(64),
      manifest: {
        schemaVersion: 2,
        id: 'runtime-smoke',
        name: 'Runtime Smoke',
        version: '1.0.0',
        apiVersion: '2',
        worker: 'worker.js',
        permissions: [{ capability: 'documents.read', version: 1 }],
        standardModules: [{ id: '@knowbook/std/plugin', version: '1.0.0' }]
      },
      workerSource: `
        import { callCapability, definePlugin } from '@knowbook/std/plugin';
        export default definePlugin({
          activate: () => ({ contributions: [] }),
          handlers: {
            inspect: () => ({
              process: typeof process,
              require: typeof require,
              fetch: typeof fetch,
              WebAssembly: typeof WebAssembly
            }),
            read: (input) => callCapability({
              capability: 'documents.read',
              version: 1,
              input
            }),
            spin: () => { while (true) {} }
          }
        });
      `,
      views: null,
      sizeBytes: 1
    }
  }, 30_000)
  assert.deepEqual(await request(identity, { type: 'activate' }), { contributions: [] })
  child.postMessage({ kind: 'commit', identity: owner })

  assert.deepEqual(await request(owner, {
    type: 'invoke-handler',
    handlerId: 'inspect',
    input: null
  }), {
    process: 'undefined',
    require: 'undefined',
    fetch: 'undefined',
    WebAssembly: 'undefined'
  })
  assert.deepEqual(await request(owner, {
    type: 'invoke-handler',
    handlerId: 'read',
    input: { documentId: 'doc-1' }
  }), { documentId: 'doc-1', title: 'Broker result' })
  assert.equal(capabilityCalls, 1)
  await assert.rejects(() => request(owner, {
    type: 'invoke-handler',
    handlerId: 'spin',
    input: null
  }), /interrupted/i)
  await request(owner, { type: 'dispose' })
  process.stdout.write('QuickJS Electron utility-process smoke probe passed.\n')
} finally {
  child.kill()
  app.quit()
}
}
