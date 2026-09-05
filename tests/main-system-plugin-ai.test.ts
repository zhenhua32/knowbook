import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { WorkspaceEventBus } from '../src/main/event-bus'
import {
  createKnowbookFullTrustServices,
  type KnowbookFullTrustServiceOptions
} from '../src/main/system-plugin/knowbook-services'

test('Full Trust AI preserves native streaming and raw responses with explicit completion modes', { timeout: 15_000 }, async () => {
  const requests: Array<{ path: string; headers: IncomingMessage['headers']; body: string }> = []
  await withAiServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({ path: request.url ?? '', headers: request.headers, body })
    if (request.url === '/v1/plain-text') {
      response.writeHead(202, 'Accepted', { 'content-type': 'text/plain', 'x-ai-result': 'raw' })
      response.end('raw result')
    } else if (JSON.parse(body).stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"delta":"你"}\n\n')
      response.end('data: {"delta":"好"}\n\ndata: [DONE]\n\n')
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"id":"completion-1"}')
    }
  }, async (baseUrl) => {
    const { ai, dispose } = createAiHarness(baseUrl)
    const completion = await ai.complete({ messages: [], extra: { stream: true, seed: 7 } })
    assert.deepEqual(completion, { id: 'completion-1' })
    const stream = await ai.stream({
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.5,
      tools: [{ type: 'function', function: { name: 'demo' } }],
      toolChoice: 'auto',
      responseFormat: { type: 'json_object' },
      extra: { stream: false, seed: 9 }
    })
    assert.ok(stream instanceof Response)
    assert.equal(stream.url, `${baseUrl}/chat/completions`)
    assert.equal(stream.headers.get('content-type'), 'text/event-stream')
    assert.match(await stream.text(), /你.*\n\ndata: .*好.*\n\ndata: \[DONE\]/)
    assert.equal(stream.bodyUsed, true)
    const raw = await ai.rawRequest({
      pathOrUrl: 'plain-text',
      method: 'POST',
      headers: { Authorization: 'custom-token', 'Content-Type': 'text/plain' },
      body: 'plain input'
    })
    assert.equal(raw.status, 202)
    assert.equal(raw.statusText, 'Accepted')
    assert.equal(raw.headers.get('x-ai-result'), 'raw')
    assert.equal(raw.url, `${baseUrl}/plain-text`)
    assert.equal(await raw.text(), 'raw result')
    assert.equal(requests[0]?.headers.authorization, 'Bearer test-key')
    assert.equal(JSON.parse(requests[0]!.body).stream, false)
    assert.equal(JSON.parse(requests[0]!.body).seed, 7)
    assert.deepEqual(JSON.parse(requests[1]!.body), {
      stream: true, seed: 9, model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.5,
      tools: [{ type: 'function', function: { name: 'demo' } }],
      tool_choice: 'auto', response_format: { type: 'json_object' }
    })
    assert.equal(requests[2]?.body, 'plain input')
    assert.equal(requests[2]?.headers.authorization, 'custom-token')
    await dispose()
  })
})

test('Full Trust AI rejects malformed messages, pre-aborted calls and calls after disposal without fetching', async () => {
  let fetchCount = 0
  const { ai, dispose } = createAiHarness('http://localhost/v1', async () => {
    fetchCount += 1
    return new Response('{}')
  })
  for (const operation of [ai.complete, ai.stream]) {
    await assert.rejects(operation({ messages: null as unknown as unknown[] }), /messages must be an array/)
  }
  const reason = new Error('Caller cancelled before sending')
  await assert.rejects(ai.rawRequest({ signal: AbortSignal.abort(reason) }), (error) => error === reason)
  await dispose()
  await dispose()
  await assert.rejects(ai.rawRequest(), { name: 'AbortError' })
  await assert.rejects(ai.complete({ messages: [] }), { name: 'AbortError' })
  await assert.rejects(ai.stream({ messages: [] }), { name: 'AbortError' })
  assert.equal(fetchCount, 0)
})

test('Full Trust AI cancels every request still waiting for headers when its plugin stops', { timeout: 15_000 }, async () => {
  const entered = createDeferred<void>()
  const closed: Promise<unknown>[] = []
  await withAiServer((_request, response) => {
    closed.push(once(response, 'close'))
    if (closed.length === 3) entered.resolve()
  }, async (baseUrl) => {
    const { ai, dispose } = createAiHarness(baseUrl)
    const pending = [
      assert.rejects(ai.complete({ messages: [] }), { name: 'AbortError' }),
      assert.rejects(ai.stream({ messages: [] }), { name: 'AbortError' }),
      assert.rejects(ai.rawRequest(), { name: 'AbortError' })
    ]
    await entered.promise
    await dispose()
    await Promise.all(pending)
    await Promise.all(closed)
  })
})

test('Full Trust AI cancellation remains attached while complete, stream and raw response bodies are read', { timeout: 15_000 }, async () => {
  const entered = createDeferred<void>()
  const closed: Promise<unknown>[] = []
  await withAiServer((_request, response) => {
    closed.push(once(response, 'close'))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"partial":')
    if (closed.length === 3) entered.resolve()
  }, async (baseUrl) => {
    const { ai, dispose } = createAiHarness(baseUrl)
    const completion = assert.rejects(ai.complete({ messages: [] }), { name: 'AbortError' })
    const [stream, raw] = await Promise.all([ai.stream({ messages: [] }), ai.rawRequest()])
    const reader = stream.body!.getReader()
    assert.equal((await reader.read()).done, false)
    const pendingRead = assert.rejects(reader.read(), { name: 'AbortError' })
    const pendingText = assert.rejects(raw.text(), { name: 'AbortError' })
    await entered.promise
    await dispose()
    await Promise.all([completion, pendingRead, pendingText])
    reader.releaseLock()
    await Promise.all(closed)
  })
})

test('Full Trust AI caller abort interrupts an HTTP error body without becoming an HTTP-status error', { timeout: 15_000 }, async () => {
  const received = createDeferred<Response>()
  await withAiServer((_request, response) => {
    response.writeHead(429, { 'content-type': 'text/plain' })
    response.write('partial error')
  }, async (baseUrl) => {
    const { ai, dispose } = createAiHarness(baseUrl, async (input, init) => {
      const response = await fetch(input, init)
      received.resolve(response)
      return response
    })
    const controller = new AbortController()
    const pending = assert.rejects(ai.stream({ messages: [], signal: controller.signal }), { name: 'AbortError' })
    const response = await received.promise
    await nextTurn()
    assert.equal(response.body?.locked, true, 'the HTTP error body must be reading before cancellation')
    controller.abort()
    await pending
    await dispose()
  })
})

test('Full Trust AI streaming consumers can cancel the native reader and close the upstream connection', { timeout: 15_000 }, async () => {
  const closed = createDeferred<void>()
  await withAiServer((_request, response) => {
    response.once('close', () => closed.resolve())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: first chunk\n\n')
  }, async (baseUrl) => {
    const { ai, dispose } = createAiHarness(baseUrl)
    const response = await ai.stream({ messages: [] })
    const reader = response.body!.getReader()
    assert.equal((await reader.read()).done, false)
    await reader.cancel('consumer finished')
    reader.releaseLock()
    await closed.promise
    assert.equal(response.body?.locked, false)
    assert.equal(response.bodyUsed, true)
    await dispose()
  })
})

test('Full Trust AI reports HTTP and invalid-JSON errors while raw requests retain non-OK responses', async () => {
  const responses = [
    new Response('rate limited', { status: 429 }),
    new Response('upstream unavailable', { status: 503 }),
    new Response('invalid json'),
    new Response('raw not found', { status: 404 })
  ]
  const { ai, dispose } = createAiHarness('http://localhost/v1', async () => responses.shift()!)
  await assert.rejects(ai.complete({ messages: [] }), /AI request failed \(429\): rate limited/)
  await assert.rejects(ai.stream({ messages: [] }), /AI request failed \(503\): upstream unavailable/)
  await assert.rejects(ai.complete({ messages: [] }), SyntaxError)
  const raw = await ai.rawRequest()
  assert.equal(raw.status, 404)
  assert.equal(await raw.text(), 'raw not found')
  await dispose()
})

test('Full Trust AI bounds and cancels an oversized HTTP error stream and releases its reader', async () => {
  let cancelled = false
  let pulls = 0
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      controller.enqueue(new TextEncoder().encode('错'.repeat(5_000)))
    },
    cancel() { cancelled = true }
  }), { status: 500 })
  const { ai, dispose } = createAiHarness('http://localhost/v1', async () => response)
  await assert.rejects(ai.complete({ messages: [] }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, `AI request failed (500): ${'错'.repeat(4_000)}`)
    return true
  })
  assert.equal(cancelled, true)
  assert.equal(response.body?.locked, false)
  assert.ok(pulls <= 2)
  await dispose()
})

test('Full Trust AI preserves body transport errors and releases the failed reader', async () => {
  const transportError = new Error('connection reset while reading body')
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(transportError) }
  }), { status: 500 })
  const { ai, dispose } = createAiHarness('http://localhost/v1', async () => response)
  await assert.rejects(ai.complete({ messages: [] }), (error) => error === transportError)
  assert.equal(response.body?.locked, false)
  await dispose()
})

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((fulfill) => { resolve = fulfill })
  return { promise, resolve }
}

function createAiHarness(baseUrl: string, fetchImplementation: typeof fetch = fetch) {
  const disposables: Array<() => void | Promise<void>> = []
  const path = tmpdir()
  const { ai } = createKnowbookFullTrustServices({
    store: {} as KnowbookFullTrustServiceOptions['store'],
    sqlite: {} as KnowbookFullTrustServiceOptions['sqlite'],
    workspaceEventBus: new WorkspaceEventBus(),
    electron: {} as KnowbookFullTrustServiceOptions['electron'],
    getMainWindow: () => null,
    getAiCredentials: () => ({ enabled: true, apiKey: 'test-key', baseUrl, model: 'test-model' }),
    fetchImplementation,
    notifyWorkspaceMutation: () => undefined,
    registerDisposable: (dispose) => { disposables.push(dispose) },
    paths: { userData: path, appData: path, documents: path, downloads: path, temp: path }
  })
  return {
    ai,
    async dispose() {
      for (const disposable of disposables) await disposable()
    }
  }
}

async function withAiServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => response.destroy(error as Error))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}/v1`)
  } finally {
    const closed = once(server, 'close')
    server.closeAllConnections()
    server.close()
    await closed
  }
}
