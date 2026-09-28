import { createServer, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'

interface WebDavServerOptions {
  etagStyle: 'quoted' | 'bare' | 'weak'
  etagHeaders: 'all' | 'head' | 'none'
  ignoreIfNoneMatch: boolean
  ignoreConditionalGet: boolean
  ignoreMoveOverwrite: boolean
  requireQuotedIfMatch: boolean
  moveConflictStatus: 409 | 412
}

/** An HTTP fixture, deliberately independent of the sync implementation. */
export async function createWebDavServer() {
  const files = new Map<string, Buffer>()
  const requests: Array<{ method: string; path: string; bytes: number }> = []
  const directories = new Set(['/'])
  let ignoreConditions = false
  const options: WebDavServerOptions = { etagStyle: 'quoted', etagHeaders: 'all', ignoreIfNoneMatch: false, ignoreConditionalGet: false, ignoreMoveOverwrite: false, requireQuotedIfMatch: false, moveConflictStatus: 412 }
  let hook: ((req: IncomingMessage, bytes: Buffer) => Promise<number | void> | number | void) | undefined
  const etag = (bytes: Buffer) => {
    const hash = createHash('sha256').update(bytes).digest('hex')
    return options.etagStyle === 'bare' ? hash : (options.etagStyle === 'weak' ? 'W/' : '') + '"' + hash + '"'
  }
  const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const matchTag = (bytes: Buffer) => options.etagStyle === 'bare' && options.requireQuotedIfMatch ? `"${etag(bytes)}"` : etag(bytes)
  const server = createServer(async (req, res) => {
    try {
      const path = req.url!, method = req.method!
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      requests.push({ method, path, bytes: bytes.length })
      if (req.headers.authorization !== `Basic ${Buffer.from('test:app-secret').toString('base64')}`) { res.writeHead(401).end(); return }
      const status = await hook?.(req, bytes)
      if (status) { res.writeHead(status).end(); return }
      if (method === 'MKCOL') {
        const exists = directories.has(path)
        directories.add(path)
        res.writeHead(exists ? 405 : 201).end(); return
      }
      const existing = files.get(path)
      if (method === 'PUT') {
        if (!ignoreConditions && (!options.ignoreIfNoneMatch && req.headers['if-none-match'] === '*' && existing
          || req.headers['if-match'] && (!existing || req.headers['if-match'] !== matchTag(existing)))) {
          res.writeHead(412).end(); return
        }
        files.set(path, bytes); res.writeHead(existing ? 204 : 201).end(); return
      }
      if (method === 'DELETE') { files.delete(path); res.writeHead(204).end(); return }
      if (!existing) { res.writeHead(404).end(); return }
      if (method === 'MOVE') {
        const destination = new URL(String(req.headers.destination)).pathname
        if (files.has(destination) && req.headers.overwrite === 'F' && !options.ignoreMoveOverwrite) { res.writeHead(options.moveConflictStatus).end(); return }
        files.set(destination, existing); files.delete(path); res.writeHead(201).end(); return
      }
      if (method === 'PROPFIND') {
        if (req.headers.depth !== '0') { res.writeHead(400).end(); return }
        res.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${xml(path)}</D:href><D:propstat><D:prop><D:getetag>${xml(etag(existing))}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`)
        return
      }
      if (!options.ignoreConditionalGet && req.headers['if-match'] && req.headers['if-match'] !== matchTag(existing)) { res.writeHead(412).end(); return }
      const includeEtag = options.etagHeaders === 'all' || method === 'HEAD' && options.etagHeaders === 'head'
      res.writeHead(200, { ...(includeEtag ? { ETag: etag(existing) } : {}), 'Content-Length': existing.length })
      res.end(method === 'HEAD' ? undefined : existing)
    } catch { res.writeHead(500).end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/`, files, requests,
    setHook: (next: typeof hook) => { hook = next },
    ignoreConditions: () => { ignoreConditions = true },
    weakEtags: () => { options.etagStyle = 'weak' },
    setOptions: (next: Partial<WebDavServerOptions>) => { Object.assign(options, next) },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
