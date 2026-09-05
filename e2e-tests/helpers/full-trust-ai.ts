import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FullTrustAiProbe {
  openedStreams: Set<string>
  closedStreams: Set<string>
}

export function handleFullTrustAiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  probe: FullTrustAiProbe
): boolean {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/v1/raw-text') {
    response.writeHead(418, {
      'content-type': 'text/plain; charset=utf-8',
      'x-full-trust-probe': 'raw-response'
    })
    response.end('原始响应：teapot')
    return true
  }
  if (url.pathname !== '/v1/chat/completions') return false

  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk: string) => { body += chunk })
  request.on('end', () => {
    let received: Record<string, unknown>
    try {
      received = JSON.parse(body) as Record<string, unknown>
    } catch {
      response.writeHead(400)
      response.end('Invalid JSON request')
      return
    }
    if (received.model === 'full-trust-http-error') {
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'controlled-rate-limit' } }))
      return
    }
    if (received.model === 'full-trust-invalid-json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{invalid-json')
      return
    }
    const authorized = request.headers.authorization === 'Bearer full-trust-e2e-key'
    if (received.stream === true) {
      const model = String(received.model)
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      })
      response.on('close', () => probe.closedStreams.add(model))
      probe.openedStreams.add(model)
      if (model === 'full-trust-cancel-stream' || model === 'full-trust-dispose-stream') {
        response.write(`data: ${JSON.stringify({ ready: true, authorized })}\n\n`)
        return
      }
      const firstEvent = Buffer.from(`data: ${JSON.stringify({ delta: '你好', authorized })}\n\n`)
      // Split inside a UTF-8 character to exercise native Response decoding.
      const split = firstEvent.indexOf(Buffer.from('你')) + 1
      response.write(firstEvent.subarray(0, split))
      setImmediate(() => {
        if (response.destroyed) return
        response.end(Buffer.concat([
          firstEvent.subarray(split),
          Buffer.from('data: {"delta":"，世界"}\n\ndata: [DONE]\n\n')
        ]))
      })
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'full-trust-ai-ok', authorized, received }))
  })
  return true
}
