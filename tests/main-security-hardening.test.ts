import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { requestAiChatCompletion } from '../src/main/ai-service.ts'
import { WebClipExtractionWorkerPool, type WebClipExtractionWorkerRequest } from '../src/main/web-clip-extract-worker-pool.ts'
import { isSameOriginNavigation } from '../src/main/window-navigation.ts'

const mainIndexSource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const rendererIndexSource = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')

type FakeWorkerEvent =
  | 'message'
  | 'error'
  | 'exit'

class FakeWorker extends EventEmitter {
  sent: Array<{ id: number; input: unknown }> = []
  terminated = false
  shutdowns = 0
  autoExit = true

  postMessage(message: WebClipExtractionWorkerRequest): void {
    if ('type' in message) {
      this.shutdowns += 1
      if (this.autoExit) queueMicrotask(() => this.emit('exit', 0))
      return
    }
    this.sent.push(message)
  }

  async terminate(): Promise<number> {
    this.terminated = true
    return 0
  }

  emitMessage(response: unknown): void {
    this.emit('message' satisfies FakeWorkerEvent, response)
  }
}

function createFactory(): { workers: FakeWorker[]; factory: () => FakeWorker } {
  const workers: FakeWorker[] = []
  return {
    workers,
    factory: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    }
  }
}

const clipInput = { html: '<p>hello</p>', sourceUrl: 'https://example.test/page' }
const clipResult = {
  title: 'Page',
  sourceUrl: 'https://example.test/page',
  bodyMarkdown: 'hello',
  warnings: []
}

test('same-origin navigation helper allows reloads and same-origin navigations', () => {
  assert.equal(
    isSameOriginNavigation('file:///C:/app/out/renderer/index.html', 'file:///C:/app/out/renderer/index.html'),
    true
  )
  assert.equal(
    isSameOriginNavigation('http://127.0.0.1:5173/index.html', 'http://127.0.0.1:5173/other'),
    true
  )
})

test('same-origin navigation helper rejects cross-origin and malformed targets', () => {
  assert.equal(
    isSameOriginNavigation('http://127.0.0.1:5173/index.html', 'https://evil.example.test/phish'),
    false
  )
  assert.equal(
    isSameOriginNavigation('file:///C:/app/out/renderer/index.html', 'file:///C:/Windows/system32/config'),
    false
  )
  assert.equal(isSameOriginNavigation(undefined, 'file:///C:/app/out/renderer/index.html'), false)
  assert.equal(isSameOriginNavigation('not a url', 'also bad'), false)
})

test('main window guards reloads via same-origin check and hardens asset responses', () => {
  const handlerIndex = mainIndexSource.indexOf("mainWindow.webContents.on('will-navigate'")
  assert.ok(handlerIndex !== -1, 'expected a will-navigate guard')

  const handlerBodyStart = mainIndexSource.indexOf('isSameOriginNavigation')
  assert.ok(handlerBodyStart !== -1, 'will-navigate guard must consult isSameOriginNavigation')

  assert.match(
    mainIndexSource,
    /if\s*\(\s*isSameOriginNavigation\(/,
    'same-origin navigations must bypass the external-url handling'
  )

  assert.match(
    mainIndexSource,
    /webContents\.on\('will-frame-navigate',[\s\S]*?!event\.isMainFrame[\s\S]*?getPluginUiDocumentRegistration\(event\.url\)[\s\S]*?event\.preventDefault\(\)/,
    'sandbox subframes must only navigate to live main-process-issued plugin UI documents'
  )

  assert.match(
    mainIndexSource,
    /setWindowOpenHandler\(\(details\) => \{[\s\S]*?candidate\.popupName === details\.frameName[\s\S]*?isActiveSystemPluginRevision\(policy\.pluginId, policy\.revisionHash\)[\s\S]*?new BrowserWindow\([\s\S]*?nodeIntegration: true[\s\S]*?return \{ action: 'deny' \}/,
    'window.open must default to deny while exact active Full Trust tokens create an isolated privileged window'
  )

  assert.match(
    rendererIndexSource,
    /frame-src \* data: blob: file: knowbook-plugin-ui:/,
    'renderer CSP may host Full Trust frames while main-process frame policies remain authoritative'
  )
  assert.match(mainIndexSource, /fullTrustFramePolicies\.get\(event\.frame\.name\)/)
  assert.match(mainIndexSource, /getPluginUiDocumentRegistration\(event\.url\)/)
  assert.match(
    mainIndexSource,
    /setPermissionRequestHandler\([\s\S]*?findFullTrustPermissionPolicy\([\s\S]*?details\.requestingUrl[\s\S]*?details\.isMainFrame/,
    'permission requests must use the exact active Full Trust revision/origin policy'
  )
  assert.match(
    mainIndexSource,
    /setPermissionCheckHandler\([\s\S]*?findFullTrustPermissionPolicy\(/,
    'permission checks must share the Full Trust policy gate'
  )
  assert.match(
    mainIndexSource,
    /setDevicePermissionHandler\([\s\S]*?policy\.allowPermissions[\s\S]*?isActiveSystemPluginRevision[\s\S]*?isAllowedFullTrustFrameUrl/,
    'device permissions must remain bound to an active Full Trust origin'
  )
  assert.match(
    mainIndexSource,
    /removeSystemPluginFramePolicies\([\s\S]*?fullTrustPopupWindows[\s\S]*?popup\.window\.close\(\)/,
    'deactivation must close popups owned by removed Full Trust frame policies'
  )
  assert.match(
    mainIndexSource,
    /function canRegisterSystemPluginRevision[\s\S]*?isActivatingRevision[\s\S]*?function normalizeSystemPluginFramePolicy[\s\S]*?canRegisterSystemPluginRevision/,
    'a verified staging revision may register a policy before Renderer commit'
  )
  const activeRevisionGate = mainIndexSource.match(
    /function isActiveSystemPluginRevision[\s\S]*?\n}\n/
  )?.[0] ?? ''
  assert.ok(activeRevisionGate.length > 0, 'expected an exact active revision gate')
  assert.equal(
    activeRevisionGate.includes('isActivatingRevision'),
    false,
    'staging revisions must not consume popup, navigation, download, or permission policies'
  )

  assert.match(
    mainIndexSource,
    /'x-content-type-options':\s*'nosniff'/i,
    'asset protocol responses must include nosniff hardening'
  )
})

test('web clip bridge token is stored encrypted instead of plaintext', () => {
  assert.match(mainIndexSource, /protectWebClipBridgeToken/, 'a protect helper must exist for the bridge token')
  const plaintextSaves = [
    ...mainIndexSource.matchAll(/saveSetting\(WEB_CLIP_BRIDGE_TOKEN_KEY,\s*(?<value>[^)]+)\)/g)
  ]
  assert.ok(plaintextSaves.length > 0, 'the single token persistence funnel must exist')
  for (const match of plaintextSaves) {
    assert.equal(
      match.groups?.value,
      'storedValue',
      'every bridge-token write must go through persistWebClipBridgeToken(storedValue), which receives an already-protected value'
    )
  }
})

test('AI completion aborts body reads that stall after response headers', async () => {
  const outcome = await Promise.race([
    requestAiChatCompletion(
      {
        apiKey: 'secret',
        baseUrl: 'https://ai.example.test/v1',
        emptyResponseMessage: 'The AI response was empty.',
        failureLabel: 'AI test request',
        model: 'test-model',
        systemPrompt: 'System prompt',
        temperature: 0.2,
        userPrompt: 'User prompt'
      },
      {
        timeoutMilliseconds: 25,
        fetchImplementation: async () => (
          {
            ok: true,
            json: () => new Promise<unknown>(() => {})
          } as unknown as Response
        )
      }
    ).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
    ),
    new Promise<'stalled'>((resolve) => {
      setTimeout(() => resolve('stalled'), 500).unref?.()
    })
  ])

  assert.notEqual(outcome, 'stalled', 'body read hung past the request timeout')
  assert.ok(outcome instanceof Error)
  assert.match(outcome.message, /AI test request timed out after 25 ms/)
})

test('extraction pool respawns a fresh worker after an unexpected crash', async () => {
  const { workers, factory } = createFactory()
  const pool = new WebClipExtractionWorkerPool(factory, { timeoutMilliseconds: 500 })

  workers[0]?.emit('exit', 1)

  const pending = pool.run(clipInput)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(workers.length, 2, 'a fresh worker must be created after the crash')

  workers[1]?.emitMessage({ id: workers[1]?.sent[0]?.id, ok: true, clip: clipResult })
  assert.deepEqual(await pending, clipResult)

  await pool.destroy()
})

test('extraction pool fails pending work and respawns after a timeout wedge', async () => {
  const { workers, factory } = createFactory()
  const pool = new WebClipExtractionWorkerPool(factory, { timeoutMilliseconds: 15 })

  await assert.rejects(pool.run(clipInput), /timed out after 15ms/)
  assert.equal(workers[0]?.terminated, true, 'the wedged worker must be terminated')

  const pending = pool.run(clipInput)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(workers.length, 2, 'the next run must use a freshly spawned worker')
  workers[0]?.emit('exit', 1)
  assert.equal(workers[1]?.terminated, false, 'an old worker exit must not kill its replacement')
  workers[1]?.emitMessage({ id: workers[1]?.sent[0]?.id, ok: true, clip: clipResult })
  assert.deepEqual(await pending, clipResult)

  await pool.destroy()
})

test('extraction pool destroy rejects later runs exactly once', async () => {
  const { workers, factory } = createFactory()
  const pool = new WebClipExtractionWorkerPool(factory, { timeoutMilliseconds: 500 })

  await pool.destroy()
  await pool.destroy()

  await assert.rejects(pool.run(clipInput), /unavailable/)
  assert.equal(workers.length, 1)
  assert.equal(workers[0]?.terminated, false)
  assert.equal(workers[0]?.shutdowns, 1)
})

test('extraction pool shares shutdown and waits for the worker exit acknowledgement', async () => {
  const { workers, factory } = createFactory()
  const pool = new WebClipExtractionWorkerPool(factory)
  workers[0].autoExit = false
  const pending = pool.run(clipInput)
  const rejected = assert.rejects(pending, /shut down/)
  const first = pool.destroy()
  assert.equal(pool.destroy(), first)
  let finished = false
  void first.then(() => { finished = true })
  await rejected
  assert.equal(finished, false)
  assert.equal(workers[0].terminated, false)
  workers[0].emit('exit', 0)
  await first
  assert.equal(finished, true)
  assert.equal(workers[0].shutdowns, 1)
})

test('extraction pool force-terminates a worker that does not acknowledge shutdown', async () => {
  const { workers, factory } = createFactory()
  const pool = new WebClipExtractionWorkerPool(factory, { shutdownTimeoutMilliseconds: 5 })
  workers[0].autoExit = false
  await pool.destroy()
  assert.equal(workers[0].terminated, true)
  assert.equal(workers[0].shutdowns, 1)
})
