import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createConnection,
  createServer,
  type Server,
  type Socket
} from 'node:net'
import {
  isRpcRequestEnvelope,
  normalizeSystemPluginServiceRpcJson,
  SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
  type SystemPluginServiceRpcHost,
  type SystemPluginServiceRpcIdentity,
  type SystemPluginServiceRpcJson
} from './service-rpc'

export const SYSTEM_PLUGIN_SERVICE_RPC_CONNECT = 'knowbook:service:rpc-connect' as const
export const SYSTEM_PLUGIN_SERVICE_RPC_CONNECTED = 'knowbook:service:rpc-connected' as const

const DEFAULT_MAX_FRAME_BYTES = 1_048_576
const DEFAULT_MAX_CONNECTIONS = 4
const ENDPOINT_PROBE_TIMEOUT_MS = 250

export interface SystemPluginServiceRpcLifecycleMessage
  extends SystemPluginServiceRpcIdentity {
  type: 'knowbook:service:ready' | 'knowbook:service:heartbeat'
  protocolVersion: typeof SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION
  payload: SystemPluginServiceRpcJson
}

export interface SystemPluginServiceRpcSocketServerOptions
  extends SystemPluginServiceRpcIdentity {
  endpoint: string
  token: string
  rpcHost: SystemPluginServiceRpcHost
  platform?: NodeJS.Platform
  maxFrameBytes?: number
  maxConnections?: number
  onLifecycle?(message: Readonly<SystemPluginServiceRpcLifecycleMessage>): void
  onTransportError?(error: Error): void
}

type ConnectionState = {
  socket: Socket
  abortController: AbortController
  authenticated: boolean
  buffer: string
  bufferedBytes: number
}

/**
 * Local reconnectable transport for service RPC. Authentication binds a
 * connection to the persisted launch nonce plus exact plugin revision. It is
 * an integrity and routing check, not a sandbox against Full Trust code.
 */
export class SystemPluginServiceRpcSocketServer {
  readonly endpoint: string

  private readonly identity: Readonly<SystemPluginServiceRpcIdentity>
  private readonly token: string
  private readonly rpcHost: SystemPluginServiceRpcHost
  private readonly platform: NodeJS.Platform
  private readonly maxFrameBytes: number
  private readonly maxConnections: number
  private readonly onLifecycle?: SystemPluginServiceRpcSocketServerOptions['onLifecycle']
  private readonly onTransportError?: SystemPluginServiceRpcSocketServerOptions['onTransportError']
  private readonly connections = new Set<ConnectionState>()
  private server: Server | null = null
  private ownsEndpoint = false
  private startOperation: Promise<void> | null = null
  private closeOperation: Promise<void> | null = null

  constructor(options: SystemPluginServiceRpcSocketServerOptions) {
    this.endpoint = requireNonEmpty(options.endpoint, 'Service RPC endpoint')
    this.identity = Object.freeze({
      pluginId: requireNonEmpty(options.pluginId, 'Service RPC plugin id'),
      revisionHash: requireNonEmpty(options.revisionHash, 'Service RPC revision hash')
    })
    this.token = requireNonEmpty(options.token, 'Service RPC token')
    this.rpcHost = options.rpcHost
    if (
      this.rpcHost.identity.pluginId !== this.identity.pluginId
      || this.rpcHost.identity.revisionHash !== this.identity.revisionHash
    ) {
      throw new Error('Service RPC socket identity does not match its dispatcher.')
    }
    this.platform = options.platform ?? process.platform
    this.maxFrameBytes = normalizePositiveInteger(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      'Service RPC maximum frame bytes'
    )
    this.maxConnections = normalizePositiveInteger(
      options.maxConnections,
      DEFAULT_MAX_CONNECTIONS,
      'Service RPC maximum connections'
    )
    this.onLifecycle = options.onLifecycle
    this.onTransportError = options.onTransportError
  }

  start(): Promise<void> {
    if (this.startOperation) return this.startOperation
    if (this.server?.listening) return Promise.resolve()
    this.startOperation = this.startInternal().finally(() => {
      this.startOperation = null
    })
    return this.startOperation
  }

  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation
    this.closeOperation = this.closeInternal().finally(() => {
      this.closeOperation = null
    })
    return this.closeOperation
  }

  private async startInternal(): Promise<void> {
    if (this.platform !== 'win32') await prepareUnixEndpoint(this.endpoint)
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          resolvePromise()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.endpoint)
      })
      this.ownsEndpoint = true
      server.on('error', this.reportTransportError)
      server.unref()
      if (this.platform !== 'win32') {
        await chmod(this.endpoint, 0o600).catch((error) => this.reportTransportError(normalizeError(error)))
      }
    } catch (error) {
      this.server = null
      if (server.listening) server.close()
      throw error
    }
  }

  private async closeInternal(): Promise<void> {
    const server = this.server
    this.server = null
    for (const connection of this.connections) {
      connection.abortController.abort(new Error('Service RPC transport closed.'))
      connection.socket.destroy()
    }
    this.connections.clear()
    if (server) {
      server.removeListener('error', this.reportTransportError)
      await new Promise<void>((resolvePromise) => {
        if (!server.listening) {
          resolvePromise()
          return
        }
        server.close(() => resolvePromise())
      })
    }
    if (this.platform !== 'win32' && this.ownsEndpoint) {
      this.ownsEndpoint = false
      await rm(this.endpoint, { force: true }).catch(() => undefined)
    }
  }

  private accept(socket: Socket): void {
    if (this.connections.size >= this.maxConnections) {
      socket.destroy()
      return
    }
    const state: ConnectionState = {
      socket,
      abortController: new AbortController(),
      authenticated: false,
      buffer: '',
      bufferedBytes: 0
    }
    this.connections.add(state)
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.on('data', (chunk: string) => this.handleData(state, chunk))
    socket.on('error', (error) => this.reportTransportError(normalizeError(error)))
    socket.once('close', () => {
      state.abortController.abort(new Error('Service RPC connection closed.'))
      this.connections.delete(state)
    })
  }

  private handleData(state: ConnectionState, chunk: string): void {
    state.buffer += chunk
    state.bufferedBytes += Buffer.byteLength(chunk, 'utf8')
    if (state.bufferedBytes > this.maxFrameBytes && !state.buffer.includes('\n')) {
      state.socket.destroy(new Error('Service RPC frame exceeds the maximum size.'))
      return
    }
    let lineEnd = state.buffer.indexOf('\n')
    while (lineEnd >= 0) {
      const line = state.buffer.slice(0, lineEnd)
      state.buffer = state.buffer.slice(lineEnd + 1)
      state.bufferedBytes = Buffer.byteLength(state.buffer, 'utf8')
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
        state.socket.destroy(new Error('Service RPC frame exceeds the maximum size.'))
        return
      }
      if (line.trim()) this.handleFrame(state, line)
      if (state.socket.destroyed) return
      lineEnd = state.buffer.indexOf('\n')
    }
  }

  private handleFrame(state: ConnectionState, line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      state.socket.destroy(new Error('Service RPC frame is not valid JSON.'))
      return
    }
    if (!state.authenticated) {
      if (!this.authenticate(message)) {
        state.socket.destroy(new Error('Service RPC connection authentication failed.'))
        return
      }
      state.authenticated = true
      writeFrame(state.socket, {
        type: SYSTEM_PLUGIN_SERVICE_RPC_CONNECTED,
        protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
        ...this.identity
      })
      return
    }
    if (isRpcRequestEnvelope(message)) {
      void this.rpcHost.dispatch(message, {
        signal: state.abortController.signal
      }).then((response) => {
        if (response && !state.socket.destroyed) writeFrame(state.socket, response)
      }).catch((error) => this.reportTransportError(normalizeError(error)))
      return
    }
    const lifecycle = normalizeLifecycleMessage(message, this.identity, this.maxFrameBytes)
    if (!lifecycle || !this.onLifecycle) return
    try {
      this.onLifecycle(lifecycle)
    } catch {
      // Lifecycle observers must not close an authenticated service transport.
    }
  }

  private authenticate(message: unknown): boolean {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false
    const value = message as Record<string, unknown>
    const keys = Object.keys(value).sort()
    const expectedKeys = [
      'pluginId',
      'protocolVersion',
      'revisionHash',
      'token',
      'type'
    ].sort()
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
      ||
      value.type !== SYSTEM_PLUGIN_SERVICE_RPC_CONNECT
      || value.protocolVersion !== SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION
      || value.pluginId !== this.identity.pluginId
      || value.revisionHash !== this.identity.revisionHash
      || typeof value.token !== 'string'
    ) return false
    const supplied = Buffer.from(value.token)
    const expected = Buffer.from(this.token)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  private readonly reportTransportError = (error: Error): void => {
    if (!this.onTransportError) return
    try {
      this.onTransportError(error)
    } catch {
      // Diagnostics cannot affect the transport lifecycle.
    }
  }
}

export function createSystemPluginServiceRpcEndpoint(input: {
  namespaceRoot: string
  pluginId: string
  platform?: NodeJS.Platform
  temporaryDirectory?: string
}): string {
  const namespaceRoot = resolve(requireNonEmpty(input.namespaceRoot, 'Service RPC namespace root'))
  const pluginId = requireNonEmpty(input.pluginId, 'Service RPC plugin id')
  const digest = createHash('sha256')
    .update(namespaceRoot)
    .update('\0')
    .update(pluginId)
    .digest('hex')
    .slice(0, 40)
  if ((input.platform ?? process.platform) === 'win32') {
    return `\\\\.\\pipe\\knowbook-system-plugin-${digest}`
  }
  return join(input.temporaryDirectory ?? tmpdir(), `knowbook-system-plugin-${digest}.sock`)
}

async function prepareUnixEndpoint(endpoint: string): Promise<void> {
  const exists = await stat(endpoint).then(() => true, () => false)
  if (!exists) return
  if (await canConnect(endpoint)) {
    throw new Error(`Service RPC endpoint is already in use: ${endpoint}`)
  }
  await rm(endpoint, { force: true })
}

function canConnect(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection(endpoint)
    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(result)
    }
    socket.unref()
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(ENDPOINT_PROBE_TIMEOUT_MS, () => finish(false))
  })
}

function normalizeLifecycleMessage(
  message: unknown,
  identity: SystemPluginServiceRpcIdentity,
  maxFrameBytes: number
): SystemPluginServiceRpcLifecycleMessage | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  const value = message as Record<string, unknown>
  const keys = Object.keys(value).sort()
  const expectedKeys = [
    'payload',
    'pluginId',
    'protocolVersion',
    'revisionHash',
    'type'
  ].sort()
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    ||
    (value.type !== 'knowbook:service:ready' && value.type !== 'knowbook:service:heartbeat')
    || value.protocolVersion !== SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION
    || value.pluginId !== identity.pluginId
    || value.revisionHash !== identity.revisionHash
  ) return null
  try {
    return {
      type: value.type,
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      ...identity,
      payload: normalizeSystemPluginServiceRpcJson(value.payload, maxFrameBytes)
    }
  } catch {
    return null
  }
}

function writeFrame(socket: Socket, message: unknown): void {
  try {
    socket.write(`${JSON.stringify(message)}\n`)
  } catch {
    socket.destroy()
  }
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string without null bytes.`)
  }
  return value
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return normalized
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
