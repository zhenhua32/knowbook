import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowbookStore } from '../src/main/database/store.ts'
import { WebClipBridgeService } from '../src/main/web-clip-bridge.ts'
import { WebClipperService } from '../src/main/web-clipper.ts'

const runRoot = resolve(process.argv[2] || 'test-results/web-clip-live-matrix')
const bridgePort = Number.parseInt(process.env.KNOWBOOK_MATRIX_BRIDGE_PORT || '43210', 10)
const inspectorPort = Number.parseInt(process.env.KNOWBOOK_MATRIX_INSPECTOR_PORT || '43211', 10)
const token = process.env.KNOWBOOK_MATRIX_TOKEN || 'knowbook-live-matrix-local-token'

mkdirSync(runRoot, { recursive: true })

const store = new KnowbookStore(resolve(runRoot, 'knowbook.db'))
const clipper = new WebClipperService(store, resolve(runRoot, 'assets'))
const bridge = new WebClipBridgeService({
  onImport: (payload) => clipper.importWebClipPayload(payload)
})

const bridgeStatus = await bridge.applyConfig({
  enabled: true,
  port: bridgePort,
  token
})

if (!bridgeStatus.running || !bridgeStatus.endpoint) {
  store.destroy()
  throw new Error(bridgeStatus.lastError || 'The live web clip bridge did not start.')
}

const inspector = createServer((request, response) => {
  try {
    handleInspectorRequest(request, response)
  } catch (error) {
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : String(error)
    })
  }
})

await new Promise<void>((resolveListen, reject) => {
  inspector.once('error', reject)
  inspector.listen(inspectorPort, '127.0.0.1', () => {
    inspector.off('error', reject)
    resolveListen()
  })
})

console.log(`READY ${JSON.stringify({
  bridgeEndpoint: bridgeStatus.endpoint,
  inspectorEndpoint: `http://127.0.0.1:${inspectorPort}`,
  runRoot,
  token
})}`)

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown()
  })
}

function handleInspectorRequest(request: IncomingMessage, response: ServerResponse): void {
  const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${inspectorPort}`)

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    writeJson(response, 200, {
      ok: true,
      bridge: bridge.getStatus(),
      documentCount: store.getDocumentCount()
    })
    return
  }

  if (request.method === 'GET' && requestUrl.pathname === '/document') {
    const documentId = requestUrl.searchParams.get('id')?.trim() || ''
    const detail = documentId ? store.getDocumentDetail(documentId) : null
    if (!detail) {
      writeJson(response, 404, { error: 'Document not found.' })
      return
    }

    const home = store.getHomeData(resolve(runRoot, 'backup'))
    const catalogEntry = home.documentCatalog.find((entry) => entry.id === documentId)
    const fields = Object.fromEntries(home.databaseColumns.map((column) => [
      column.name,
      catalogEntry?.fieldValues[column.id] ?? null
    ]))
    const markdown = detail.blocks.map((block) => block.content).join('\n\n')
    const markdownImages = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1] || '')
    const httpLinks = [...markdown.matchAll(/(?<!!)\[[^\]]+\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1] || '')
    const localizedImages = markdownImages.filter((url) => url.startsWith('file:'))
    const localizedFiles = localizedImages.map((url) => {
      try {
        const path = fileURLToPath(url)
        return { url, path, exists: existsSync(path) }
      } catch {
        return { url, path: null, exists: false }
      }
    })

    writeJson(response, 200, {
      id: detail.id,
      title: detail.title,
      path: detail.path,
      summary: detail.summary,
      fields,
      blockCount: detail.blocks.length,
      blockTypes: [...new Set(detail.blocks.map((block) => block.type))],
      bodyChars: markdown.length,
      markdownImages,
      localizedImages,
      localizedFiles,
      httpLinks,
      hasSourceAttribution: markdown.includes('来源：'),
      hasExtensionNotes: markdown.includes('Extension notes:'),
      markdown
    })
    return
  }

  if (request.method === 'POST' && requestUrl.pathname === '/shutdown') {
    writeJson(response, 200, { ok: true })
    void shutdown()
    return
  }

  writeJson(response, 404, { error: 'Not found.' })
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return
  }
  shuttingDown = true

  await bridge.destroy()
  await new Promise<void>((resolveClose) => inspector.close(() => resolveClose()))
  store.destroy()
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  response.end(body)
}
