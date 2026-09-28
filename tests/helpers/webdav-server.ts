import { createServer, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'

/** An HTTP fixture, deliberately independent of the sync implementation. */
export async function createWebDavServer() {
  const files = new Map<string, Buffer>()
  const requests: Array<{ method: string; path: string; bytes: number }> = []
  const directories = new Set(['/'])
  let ignoreConditions = false
  let weakEtags = false
  let hook: ((req: IncomingMessage, bytes: Buffer) => Promise<number | void> | number | void) | undefined
  const etag = (bytes: Buffer) => (weakEtags ? 'W/' : '') + '"' + createHash('sha256').update(bytes).digest('hex') + '"'
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
        if (!ignoreConditions && (req.headers['if-none-match'] === '*' && existing
          || req.headers['if-match'] && (!existing || req.headers['if-match'] !== etag(existing)))) {
          res.writeHead(412).end(); return
        }
        files.set(path, bytes); res.writeHead(existing ? 204 : 201).end(); return
      }
      if (method === 'DELETE') { files.delete(path); res.writeHead(204).end(); return }
      if (!existing) { res.writeHead(404).end(); return }
      res.writeHead(200, { ETag: etag(existing), 'Content-Length': existing.length })
      res.end(method === 'HEAD' ? undefined : existing)
    } catch { res.writeHead(500).end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/`, files, requests,
    setHook: (next: typeof hook) => { hook = next },
    ignoreConditions: () => { ignoreConditions = true },
    weakEtags: () => { weakEtags = true },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
