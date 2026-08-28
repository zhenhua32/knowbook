import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { requestAiChatCompletion } from '../src/main/ai-service.ts'
import { WebClipExtractionWorkerPool } from '../src/main/web-clip-extract-worker-pool.ts'
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

  postMessage(message: { id: number; input: unknown }): void {
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
    /setWindowOpenHandler\(\(\) => \{[\s\S]*?return \{ action: 'deny' \}/,
    'window.open must always be denied; trusted external links use validated IPC'
  )

  assert.match(
    rendererIndexSource,
    /frame-src knowbook-plugin-ui:/,
    'renderer CSP must allow only the opaque plugin UI document scheme in frames'
  )
  assert.doesNotMatch(rendererIndexSource, /frame-src[^;]*(?:https?:|data:|blob:)/)

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
  assert.equal(workers[0]?.terminated, true)
})
