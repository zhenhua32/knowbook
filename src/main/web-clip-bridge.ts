import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { ClipWebPageResult, ImportWebClipPayloadInput, WebClipBridgeStatus } from '@shared/contracts'

const MAX_BRIDGE_PAYLOAD_BYTES = 4 * 1024 * 1024

class BridgeRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

type WebClipBridgeConfig = {
  enabled: boolean
  port: number
  token: string
}

type WebClipBridgeOptions = {
  onImport: (payload: ImportWebClipPayloadInput) => Promise<ClipWebPageResult>
  onStateChange?: (status: WebClipBridgeStatus) => void
}

export class WebClipBridgeService {
  private server: Server | null = null
  private config: WebClipBridgeConfig = {
    enabled: false,
    port: 3210,
    token: ''
  }
  private status: WebClipBridgeStatus = {
    enabled: false,
    running: false,
    port: null,
    token: '',
    endpoint: null,
    lastError: null
  }

  constructor(private readonly options: WebClipBridgeOptions) {}

  getStatus(): WebClipBridgeStatus {
    return { ...this.status }
  }

  async applyConfig(config: WebClipBridgeConfig): Promise<WebClipBridgeStatus> {
    this.config = { ...config }

    if (!config.enabled) {
      await this.stop()
      this.updateStatus({
        enabled: false,
        running: false,
        port: null,
        token: config.token,
        endpoint: null,
        lastError: null
      })
      return this.getStatus()
    }

    const restartNeeded = !this.server || this.status.port !== config.port || this.status.token !== config.token
    if (!restartNeeded) {
      this.updateStatus({
        ...this.status,
        enabled: true,
        token: config.token,
        endpoint: this.status.port ? buildEndpoint(this.status.port) : null
      })
      return this.getStatus()
    }

    await this.stop()

    try {
      await this.start(config)
      this.updateStatus({
        enabled: true,
        running: true,
        port: this.status.port,
        token: config.token,
        endpoint: this.status.port ? buildEndpoint(this.status.port) : null,
        lastError: null
      })
    } catch (error) {
      this.updateStatus({
        enabled: true,
        running: false,
        port: null,
        token: config.token,
        endpoint: null,
        lastError: error instanceof Error ? error.message : 'Failed to start bridge server.'
      })
    }

    return this.getStatus()
  }

  async destroy(): Promise<void> {
    await this.stop()
  }

  private async start(config: WebClipBridgeConfig): Promise<void> {
    const server = createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response)
      } catch (error) {
        writeJson(response, error instanceof BridgeRequestError ? error.statusCode : 500, {
          error: error instanceof Error ? error.message : 'Bridge server failed unexpectedly.'
        })
      }
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    this.server = server
    const address = server.address() as AddressInfo | null
    this.status = {
      enabled: true,
      running: true,
      port: address?.port ?? config.port,
      token: config.token,
      endpoint: buildEndpoint(address?.port ?? config.port),
      lastError: null
    }
  }

  private async stop(): Promise<void> {
    const currentServer = this.server
    if (!currentServer) {
      return
    }

    this.server = null
    currentServer.closeIdleConnections()
    let forceCloseTimer: ReturnType<typeof setTimeout> | null = null
    try {
      await new Promise<void>((resolve, reject) => {
        forceCloseTimer = setTimeout(() => {
          currentServer.closeAllConnections()
        }, 2_000)
        currentServer.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    } finally {
      if (forceCloseTimer) {
        clearTimeout(forceCloseTimer)
      }
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const corsHeaders = buildCorsHeaders(request)
    if (request.method === 'OPTIONS') {
      writeEmpty(response, 204, corsHeaders)
      return
    }

    if (request.method === 'GET' && request.url === '/health') {
      writeJson(response, 200, {
        ok: true,
        running: this.status.running
      }, corsHeaders)
      return
    }

    if (request.method !== 'POST' || request.url !== '/clip') {
      writeJson(response, 404, { error: 'Not found.' }, corsHeaders)
      return
    }

    const authHeader = request.headers.authorization?.trim() ?? ''
    if (!this.isAuthorizedBearerToken(authHeader)) {
      writeJson(response, 401, { error: 'Unauthorized.' }, corsHeaders)
      return
    }

    const payload = await readJsonBody<ImportWebClipPayloadInput>(request)
    const result = await this.options.onImport(payload)
    writeJson(response, 200, result, corsHeaders)
  }

  private isAuthorizedBearerToken(authHeader: string): boolean {
    const expected = Buffer.from(`Bearer ${this.config.token}`, 'utf8')
    const provided = Buffer.from(authHeader, 'utf8')
    if (expected.length !== provided.length) {
      return false
    }
    return timingSafeEqual(expected, provided)
  }

  private updateStatus(nextStatus: WebClipBridgeStatus): void {
    this.status = { ...nextStatus }
    this.options.onStateChange?.(this.getStatus())
  }
}

function buildEndpoint(port: number): string {
  return `http://127.0.0.1:${port}/clip`
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > MAX_BRIDGE_PAYLOAD_BYTES) {
      throw new BridgeRequestError('Bridge payload is too large.', 413)
    }
    chunks.push(buffer)
  }

  const body = Buffer.concat(chunks).toString('utf8').trim()
  if (!body) {
    throw new BridgeRequestError('Bridge payload is empty.', 400)
  }

  try {
    return JSON.parse(body) as T
  } catch {
    throw new BridgeRequestError('Bridge payload must be valid JSON.', 400)
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  corsHeaders: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  response.end(body)
}

function writeEmpty(response: ServerResponse, statusCode: number, corsHeaders: Record<string, string> = {}): void {
  response.writeHead(statusCode, corsHeaders)
  response.end()
}

const BRIDGE_ALLOWED_ORIGIN_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://'
]

function buildCorsHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  }

  // The bridge only serves local browser extensions. Web origins (and requests without an
  // Origin header, e.g. curl) must not receive any CORS grant.
  const origin = request.headers.origin?.trim() ?? ''
  if (origin && BRIDGE_ALLOWED_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix))) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}
