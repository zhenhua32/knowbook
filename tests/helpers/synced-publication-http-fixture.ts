import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { listenOnFetchSafePort } from './http-server'

export interface PublicationHttpRequest {
  method: string
  path: string
  bytes: Buffer
  ifMatch: string | undefined
  ifNoneMatch: string | undefined
  overwrite: string | undefined
  destination: string | undefined
}
export type PublicationHttpDecision = { kind: 'status'; status: number } | { kind: 'disconnect' } | { kind: 'persist-then-disconnect' } | void
export type PublicationHttpHook = (request: PublicationHttpRequest, raw: IncomingMessage) => PublicationHttpDecision | Promise<PublicationHttpDecision>
export function publicationContentRequest(request: Pick<PublicationHttpRequest, 'method' | 'path'>): boolean {
  return request.method !== 'MKCOL' && /\/(?:assets\/[a-f0-9]{64}|objects\/(?:[a-f0-9]{64}\.json|\.pending-[^/]+\.json))$/.test(request.path)
    || (request.method === 'PUT' || request.method === 'MOVE') && request.path.endsWith('/manifest.json')
}
export function publicationGate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

/** Independent actual HTTP fixture. It never invokes publication code. Hooks
 * record observations; any unexpected hook exception also fails the outer test. */
export async function createPublicationHttpServer() {
  const files = new Map<string, Buffer>(), requests: PublicationHttpRequest[] = [], hookErrors: unknown[] = []
  const directories = new Set(['/'])
  let hook: PublicationHttpHook | undefined
  const options = { ignoreIfNoneMatch: false, ignoreMoveOverwrite: false, moveConflictStatus: 412 as 409 | 412, omitGetEtag: false, omitHeadEtag: false }
  const etag = (bytes: Uint8Array) => '"' + createHash('sha256').update(bytes).digest('hex') + '"'
  const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks), method = req.method ?? 'GET', path = req.url ?? '/'
      const header = (name: string) => typeof req.headers[name] === 'string' ? req.headers[name] : undefined
      const request: PublicationHttpRequest = { method, path, bytes: Buffer.from(bytes), ifMatch: header('if-match'), ifNoneMatch: header('if-none-match'), overwrite: header('overwrite'), destination: header('destination') }
      requests.push(request)
      if (req.headers.authorization !== 'Basic ' + Buffer.from('test:app-secret').toString('base64')) { res.writeHead(401).end(); return }
      let decision: PublicationHttpDecision
      try { decision = await hook?.(request, req) } catch (error) { hookErrors.push(error); res.writeHead(500).end(); return }
      if (decision?.kind === 'status') { res.writeHead(decision.status).end(); return }
      if (decision?.kind === 'disconnect') { req.socket.destroy(); return }
      if (method === 'MKCOL') { const exists = directories.has(path); directories.add(path); res.writeHead(exists ? 405 : 201).end(); return }
      const existing = files.get(path)
      if (method === 'PUT') {
        if (!options.ignoreIfNoneMatch && request.ifNoneMatch === '*' && existing || request.ifMatch && (!existing || request.ifMatch !== etag(existing))) { res.writeHead(412).end(); return }
        files.set(path, Buffer.from(bytes))
        if (decision?.kind === 'persist-then-disconnect') { req.socket.destroy(); return }
        res.writeHead(existing ? 204 : 201).end(); return
      }
      if (method === 'DELETE') { files.delete(path); res.writeHead(204).end(); return }
      if (!existing) { res.writeHead(404).end(); return }
      if (method === 'MOVE') {
        const destination = new URL(request.destination ?? '').pathname
        if (files.has(destination) && request.overwrite === 'F' && !options.ignoreMoveOverwrite) { res.writeHead(options.moveConflictStatus).end(); return }
        files.set(destination, Buffer.from(existing)); files.delete(path)
        if (decision?.kind === 'persist-then-disconnect') { req.socket.destroy(); return }
        res.writeHead(201).end(); return
      }
      if (method === 'PROPFIND') {
        res.writeHead(207, { 'Content-Type': 'application/xml' }).end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>' + xml(path) + '</D:href><D:propstat><D:prop><D:getetag>' + xml(etag(existing)) + '</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>')
        return
      }
      if (request.ifMatch && request.ifMatch !== etag(existing)) { res.writeHead(412).end(); return }
      const omit = method === 'GET' && options.omitGetEtag || method === 'HEAD' && options.omitHeadEtag
      res.writeHead(200, { ...(omit ? {} : { ETag: etag(existing) }), 'Content-Length': existing.length }); res.end(method === 'HEAD' ? undefined : existing)
    } catch (error) { hookErrors.push(error); if (!res.headersSent && !res.destroyed) res.writeHead(500).end(); else res.destroy() }
  })
  const port = await listenOnFetchSafePort(server)
  return { url: 'http://127.0.0.1:' + port + '/', files, requests, hookErrors,
    setHook: (next: PublicationHttpHook | undefined) => { hook = next },
    setOptions: (next: Partial<typeof options>) => { Object.assign(options, next) },
    assertNoHookErrors: () => assert.deepEqual(hookErrors, [], 'HTTP fixture hook errors must not disappear inside a synthetic 500 response'),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
