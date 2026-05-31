import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ClipWebPageResult, ImportWebClipPayloadInput, WebClipBridgeStatus } from '@shared/contracts'

const MAX_BRIDGE_PAYLOAD_BYTES = 4 * 1024 * 1024

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
        writeJson(response, 500, {
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
    await new Promise<void>((resolve, reject) => {
      currentServer.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'OPTIONS') {
      writeEmpty(response, 204)
      return
    }

    if (request.method === 'GET' && request.url === '/health') {
      writeJson(response, 200, {
        ok: true,
        running: this.status.running
      })
      return
    }

    if (request.method !== 'POST' || request.url !== '/clip') {
      writeJson(response, 404, { error: 'Not found.' })
      return
    }

    const authHeader = request.headers.authorization?.trim() ?? ''
    if (!authHeader || authHeader !== `Bearer ${this.config.token}`) {
      writeJson(response, 401, { error: 'Unauthorized.' })
      return
    }

    const payload = await readJsonBody<ImportWebClipPayloadInput>(request)
    const result = await this.options.onImport(payload)
    writeJson(response, 200, result)
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
      throw new Error('Bridge payload is too large.')
    }
    chunks.push(buffer)
  }

  const body = Buffer.concat(chunks).toString('utf8').trim()
  if (!body) {
    throw new Error('Bridge payload is empty.')
  }

  return JSON.parse(body) as T
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  response.end(body)
}

function writeEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  })
  response.end()
}