import { randomUUID } from 'node:crypto'

export const SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION = 1 as const
export const SYSTEM_PLUGIN_SERVICE_RPC_REQUEST = 'knowbook:service:rpc-request' as const
export const SYSTEM_PLUGIN_SERVICE_RPC_RESPONSE = 'knowbook:service:rpc-response' as const
export const SYSTEM_PLUGIN_SERVICE_RPC_EVENT = 'knowbook:service:rpc-event' as const

const DEFAULT_RPC_TIMEOUT_MS = 15_000
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576
const DEFAULT_MAX_PAYLOAD_DEPTH = 32
const DEFAULT_MAX_PAYLOAD_NODES = 20_000
const MAX_METHOD_LENGTH = 128
const MAX_REQUEST_ID_LENGTH = 128
const MAX_ERROR_MESSAGE_LENGTH = 2_000
const METHOD_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export type SystemPluginServiceRpcJson =
  | null
  | boolean
  | number
  | string
  | SystemPluginServiceRpcJson[]
  | { [key: string]: SystemPluginServiceRpcJson }

export interface SystemPluginServiceRpcIdentity {
  pluginId: string
  revisionHash: string
}

export interface SystemPluginServiceRpcRequest extends SystemPluginServiceRpcIdentity {
  type: typeof SYSTEM_PLUGIN_SERVICE_RPC_REQUEST
  protocolVersion: typeof SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION
  requestId: string
  method: string
  params: SystemPluginServiceRpcJson
}

export interface SystemPluginServiceRpcError {
  code:
    | 'invalid-request'
    | 'identity-mismatch'
    | 'method-not-found'
    | 'busy'
    | 'timeout'
    | 'cancelled'
    | 'handler-error'
    | 'invalid-result'
    | 'transport-error'
    | 'disposed'
  message: string
}

export type SystemPluginServiceRpcResponse = SystemPluginServiceRpcIdentity & {
  type: typeof SYSTEM_PLUGIN_SERVICE_RPC_RESPONSE
  protocolVersion: typeof SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION
  requestId: string
} & (
  | { ok: true; result: SystemPluginServiceRpcJson }
  | { ok: false; error: SystemPluginServiceRpcError }
)

export interface SystemPluginServiceRpcEvent extends SystemPluginServiceRpcIdentity {
  type: typeof SYSTEM_PLUGIN_SERVICE_RPC_EVENT
  protocolVersion: typeof SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION
  event: string
  payload: SystemPluginServiceRpcJson
}

export interface SystemPluginServiceRpcMethodContext extends SystemPluginServiceRpcIdentity {
  requestId: string
  signal: AbortSignal
}

export type SystemPluginServiceRpcMethod = (
  params: SystemPluginServiceRpcJson,
  context: Readonly<SystemPluginServiceRpcMethodContext>
) => unknown | Promise<unknown>

export type SystemPluginServiceRpcMethodMap = Readonly<Record<string, SystemPluginServiceRpcMethod>>

export interface SystemPluginServiceRpcAuditEvent extends SystemPluginServiceRpcIdentity {
  requestId: string | null
  method: string | null
  outcome: 'success' | 'failure' | 'rejected'
  errorCode: SystemPluginServiceRpcError['code'] | null
  durationMs: number
}

export interface SystemPluginServiceRpcHostOptions extends SystemPluginServiceRpcIdentity {
  methods: SystemPluginServiceRpcMethodMap
  timeoutMs?: number
  maxConcurrentRequests?: number
  maxPayloadBytes?: number
  onAudit?(event: Readonly<SystemPluginServiceRpcAuditEvent>): void
}

export interface SystemPluginServiceRpcDispatchOptions {
  signal?: AbortSignal
}

/**
 * Versioned, allow-listed RPC dispatcher for a Full Trust service process.
 * Full Trust remains an authority boundary chosen by the user, but this protocol
 * is deliberately closed and bounded so accidental malformed traffic cannot
 * destabilize the Main process.
 */
export class SystemPluginServiceRpcHost {
  readonly identity: Readonly<SystemPluginServiceRpcIdentity>

  private readonly methods: SystemPluginServiceRpcMethodMap
  private readonly timeoutMs: number
  private readonly maxConcurrentRequests: number
  private readonly maxPayloadBytes: number
  private readonly onAudit?: SystemPluginServiceRpcHostOptions['onAudit']
  private activeRequests = 0

  constructor(options: SystemPluginServiceRpcHostOptions) {
    this.identity = Object.freeze({
      pluginId: requireIdentityString(options.pluginId, 'RPC plugin id'),
      revisionHash: requireIdentityString(options.revisionHash, 'RPC revision hash')
    })
    this.methods = normalizeMethodMap(options.methods)
    this.timeoutMs = normalizePositiveInteger(
      options.timeoutMs,
      DEFAULT_RPC_TIMEOUT_MS,
      'RPC timeout'
    )
    this.maxConcurrentRequests = normalizePositiveInteger(
      options.maxConcurrentRequests,
      DEFAULT_MAX_CONCURRENT_REQUESTS,
      'RPC maximum concurrent requests'
    )
    this.maxPayloadBytes = normalizePositiveInteger(
      options.maxPayloadBytes,
      DEFAULT_MAX_PAYLOAD_BYTES,
      'RPC maximum payload bytes'
    )
    this.onAudit = options.onAudit
  }

  async dispatch(
    message: unknown,
    options: SystemPluginServiceRpcDispatchOptions = {}
  ): Promise<SystemPluginServiceRpcResponse | null> {
    if (!isRpcRequestEnvelope(message)) return null
    const startedAt = Date.now()
    let request: SystemPluginServiceRpcRequest
    try {
      request = normalizeRpcRequest(message, this.maxPayloadBytes)
    } catch (error) {
      const identity = readResponseIdentity(message)
      const requestId = readRequestId(message)
      const rpcError = toRpcError(error, 'invalid-request')
      this.audit({
        requestId,
        method: readMethod(message),
        outcome: 'rejected',
        errorCode: rpcError.code,
        durationMs: Date.now() - startedAt
      })
      return identity && requestId
        ? createErrorResponse(identity, requestId, rpcError)
        : null
    }

    if (
      request.pluginId !== this.identity.pluginId
      || request.revisionHash !== this.identity.revisionHash
    ) {
      const error = rpcError(
        'identity-mismatch',
        'RPC request identity does not match the active plugin revision.'
      )
      this.auditFailure(request, error, startedAt, 'rejected')
      return createErrorResponse(this.identity, request.requestId, error)
    }

    const method = this.methods[request.method]
    if (!method) {
      const error = rpcError('method-not-found', `RPC method "${request.method}" is not available.`)
      this.auditFailure(request, error, startedAt, 'rejected')
      return createErrorResponse(this.identity, request.requestId, error)
    }
    if (this.activeRequests >= this.maxConcurrentRequests) {
      const error = rpcError('busy', 'The system plugin RPC host is busy.')
      this.auditFailure(request, error, startedAt, 'rejected')
      return createErrorResponse(this.identity, request.requestId, error)
    }

    this.activeRequests += 1
    const controller = new AbortController()
    const externalSignal = options.signal
    const abortFromExternal = (): void => controller.abort(externalSignal?.reason)
    if (externalSignal?.aborted) abortFromExternal()
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
    let timeout: ReturnType<typeof setTimeout> | null = null
    let cancellationListener: (() => void) | null = null
    try {
      const context: SystemPluginServiceRpcMethodContext = Object.freeze({
        ...this.identity,
        requestId: request.requestId,
        signal: controller.signal
      })
      const operation = Promise.resolve().then(() => method(request.params, context))
      const timeoutOperation = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new SystemPluginServiceRpcFault(
            'timeout',
            `RPC method "${request.method}" timed out after ${this.timeoutMs}ms.`
          )
          controller.abort(error)
          reject(error)
        }, this.timeoutMs)
      })
      const cancellationOperation = new Promise<never>((_resolve, reject) => {
        cancellationListener = () => {
          const reason = controller.signal.reason
          if (reason instanceof SystemPluginServiceRpcFault) reject(reason)
          else reject(new SystemPluginServiceRpcFault('cancelled', 'RPC request was cancelled.'))
        }
        if (controller.signal.aborted) cancellationListener()
        else controller.signal.addEventListener('abort', cancellationListener, { once: true })
      })
      const rawResult = await Promise.race([operation, timeoutOperation, cancellationOperation])
      const result = normalizeRpcPayload(rawResult === undefined ? null : rawResult, this.maxPayloadBytes)
      this.audit({
        requestId: request.requestId,
        method: request.method,
        outcome: 'success',
        errorCode: null,
        durationMs: Date.now() - startedAt
      })
      return {
        type: SYSTEM_PLUGIN_SERVICE_RPC_RESPONSE,
        protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
        ...this.identity,
        requestId: request.requestId,
        ok: true,
        result
      }
    } catch (error) {
      const fallback = controller.signal.aborted && externalSignal?.aborted
        ? 'cancelled'
        : 'handler-error'
      const normalized = toRpcError(error, fallback)
      const resultError = normalized.code === 'invalid-request'
        ? rpcError('invalid-result', normalized.message)
        : normalized
      this.auditFailure(request, resultError, startedAt, 'failure')
      return createErrorResponse(this.identity, request.requestId, resultError)
    } finally {
      if (timeout) clearTimeout(timeout)
      if (cancellationListener) {
        controller.signal.removeEventListener('abort', cancellationListener)
      }
      externalSignal?.removeEventListener('abort', abortFromExternal)
      this.activeRequests -= 1
    }
  }

  private auditFailure(
    request: Pick<SystemPluginServiceRpcRequest, 'requestId' | 'method'>,
    error: SystemPluginServiceRpcError,
    startedAt: number,
    outcome: SystemPluginServiceRpcAuditEvent['outcome']
  ): void {
    this.audit({
      requestId: request.requestId,
      method: request.method,
      outcome,
      errorCode: error.code,
      durationMs: Date.now() - startedAt
    })
  }

  private audit(
    event: Omit<SystemPluginServiceRpcAuditEvent, keyof SystemPluginServiceRpcIdentity>
  ): void {
    if (!this.onAudit) return
    try {
      this.onAudit(Object.freeze({ ...this.identity, ...event }))
    } catch {
      // Audit sinks must not alter RPC behavior.
    }
  }
}

export interface SystemPluginServiceRpcClientTransport {
  connected?: boolean
  send?(message: unknown, callback?: (error: Error | null) => void): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  removeListener(event: 'message', listener: (message: unknown) => void): unknown
  removeListener(event: 'disconnect', listener: () => void): unknown
}

export interface SystemPluginServiceRpcClientOptions extends SystemPluginServiceRpcIdentity {
  transport: SystemPluginServiceRpcClientTransport
  timeoutMs?: number
  createRequestId?: () => string
}

export interface SystemPluginServiceRpcCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** Public shape installed in service entries as globalThis.knowbookService. */
export interface SystemPluginServiceRpcGlobalApi extends SystemPluginServiceRpcIdentity {
  readonly protocolVersion: typeof SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION
  call(
    method: string,
    params?: SystemPluginServiceRpcJson,
    options?: Pick<SystemPluginServiceRpcCallOptions, 'timeoutMs'>
  ): Promise<SystemPluginServiceRpcJson>
  ready(payload?: SystemPluginServiceRpcJson): void
  heartbeat(payload?: SystemPluginServiceRpcJson): void
  on(event: string, listener: (payload: SystemPluginServiceRpcJson) => void): () => void
  dispose(): void
}

export class SystemPluginServiceRpcClientError extends Error {
  constructor(
    readonly code: SystemPluginServiceRpcError['code'],
    message: string
  ) {
    super(message)
    this.name = 'SystemPluginServiceRpcClientError'
  }
}

type PendingClientRequest = {
  resolve(value: SystemPluginServiceRpcJson): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abortListener?: () => void
}

export class SystemPluginServiceRpcClient {
  readonly identity: Readonly<SystemPluginServiceRpcIdentity>

  private readonly transport: SystemPluginServiceRpcClientTransport
  private readonly timeoutMs: number
  private readonly createRequestId: () => string
  private readonly pending = new Map<string, PendingClientRequest>()
  private readonly eventListeners = new Map<string, Set<(payload: SystemPluginServiceRpcJson) => void>>()
  private disposed = false

  constructor(options: SystemPluginServiceRpcClientOptions) {
    this.identity = Object.freeze({
      pluginId: requireIdentityString(options.pluginId, 'RPC plugin id'),
      revisionHash: requireIdentityString(options.revisionHash, 'RPC revision hash')
    })
    this.transport = options.transport
    this.timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_RPC_TIMEOUT_MS, 'RPC timeout')
    this.createRequestId = options.createRequestId ?? randomUUID
    this.transport.on('message', this.handleMessage)
    this.transport.on('disconnect', this.handleDisconnect)
  }

  call(
    method: string,
    params: SystemPluginServiceRpcJson = null,
    options: SystemPluginServiceRpcCallOptions = {}
  ): Promise<SystemPluginServiceRpcJson> {
    if (this.disposed) {
      return Promise.reject(new SystemPluginServiceRpcClientError('disposed', 'RPC client is disposed.'))
    }
    if (this.transport.connected === false || typeof this.transport.send !== 'function') {
      return Promise.reject(new SystemPluginServiceRpcClientError('transport-error', 'RPC transport is unavailable.'))
    }
    const normalizedMethod = normalizeMethod(method)
    const normalizedParams = normalizeRpcPayload(params, DEFAULT_MAX_PAYLOAD_BYTES)
    const requestId = normalizeRequestId(this.createRequestId())
    if (this.pending.has(requestId)) {
      return Promise.reject(new SystemPluginServiceRpcClientError('invalid-request', 'RPC request id is already active.'))
    }
    const timeoutMs = normalizePositiveInteger(options.timeoutMs, this.timeoutMs, 'RPC call timeout')
    if (options.signal?.aborted) {
      return Promise.reject(new SystemPluginServiceRpcClientError('cancelled', 'RPC call was cancelled.'))
    }
    const request: SystemPluginServiceRpcRequest = {
      type: SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      ...this.identity,
      requestId,
      method: normalizedMethod,
      params: normalizedParams
    }
    return new Promise<SystemPluginServiceRpcJson>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.finishPending(requestId)
        reject(new SystemPluginServiceRpcClientError(
          'timeout',
          `RPC call "${normalizedMethod}" timed out after ${timeoutMs}ms.`
        ))
      }, timeoutMs)
      const pending: PendingClientRequest = { resolve, reject, timeout, signal: options.signal }
      if (options.signal) {
        pending.abortListener = () => {
          this.finishPending(requestId)
          reject(new SystemPluginServiceRpcClientError('cancelled', 'RPC call was cancelled.'))
        }
        options.signal.addEventListener('abort', pending.abortListener, { once: true })
      }
      this.pending.set(requestId, pending)
      try {
        this.transport.send!(request, (error) => {
          if (!error || !this.pending.has(requestId)) return
          this.finishPending(requestId)
          reject(new SystemPluginServiceRpcClientError('transport-error', 'Failed to send RPC request.'))
        })
      } catch {
        this.finishPending(requestId)
        reject(new SystemPluginServiceRpcClientError('transport-error', 'Failed to send RPC request.'))
      }
    })
  }

  notifyReady(payload: SystemPluginServiceRpcJson = null): void {
    this.sendControl('knowbook:service:ready', payload)
  }

  notifyHeartbeat(payload: SystemPluginServiceRpcJson = null): void {
    this.sendControl('knowbook:service:heartbeat', payload)
  }

  onEvent(event: string, listener: (payload: SystemPluginServiceRpcJson) => void): () => void {
    const normalizedEvent = normalizeMethod(event)
    const listeners = this.eventListeners.get(normalizedEvent) ?? new Set()
    listeners.add(listener)
    this.eventListeners.set(normalizedEvent, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.eventListeners.delete(normalizedEvent)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.transport.removeListener('message', this.handleMessage)
    this.transport.removeListener('disconnect', this.handleDisconnect)
    this.rejectPending(new SystemPluginServiceRpcClientError('disposed', 'RPC client was disposed.'))
    this.eventListeners.clear()
  }

  private readonly handleMessage = (message: unknown): void => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    const candidate = message as Record<string, unknown>
    if (
      candidate.protocolVersion !== SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION
      || candidate.pluginId !== this.identity.pluginId
      || candidate.revisionHash !== this.identity.revisionHash
    ) return
    if (candidate.type === SYSTEM_PLUGIN_SERVICE_RPC_EVENT) {
      try {
        const event = normalizeMethod(candidate.event)
        const payload = normalizeRpcPayload(candidate.payload, DEFAULT_MAX_PAYLOAD_BYTES)
        for (const listener of this.eventListeners.get(event) ?? []) listener(payload)
      } catch {
        // Invalid or stale host events are ignored.
      }
      return
    }
    if (candidate.type !== SYSTEM_PLUGIN_SERVICE_RPC_RESPONSE) return
    const requestId = readRequestId(candidate)
    if (!requestId) return
    const pending = this.pending.get(requestId)
    if (!pending) return
    try {
      if (candidate.ok === true) {
        const result = normalizeRpcPayload(candidate.result, DEFAULT_MAX_PAYLOAD_BYTES)
        this.finishPending(requestId)
        pending.resolve(result)
        return
      }
      if (candidate.ok === false) {
        const error = normalizeResponseError(candidate.error)
        this.finishPending(requestId)
        pending.reject(new SystemPluginServiceRpcClientError(error.code, error.message))
      }
    } catch {
      this.finishPending(requestId)
      pending.reject(new SystemPluginServiceRpcClientError('transport-error', 'RPC response is invalid.'))
    }
  }

  private readonly handleDisconnect = (): void => {
    this.rejectPending(new SystemPluginServiceRpcClientError('transport-error', 'RPC transport disconnected.'))
  }

  private sendControl(type: 'knowbook:service:ready' | 'knowbook:service:heartbeat', payload: SystemPluginServiceRpcJson): void {
    if (this.disposed || this.transport.connected === false || typeof this.transport.send !== 'function') return
    const message = {
      type,
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      ...this.identity,
      payload: normalizeRpcPayload(payload, DEFAULT_MAX_PAYLOAD_BYTES)
    }
    try {
      this.transport.send(message, () => undefined)
    } catch {
      // Readiness/heartbeat are best-effort lifecycle signals.
    }
  }

  private finishPending(requestId: string): PendingClientRequest | null {
    const pending = this.pending.get(requestId)
    if (!pending) return null
    clearTimeout(pending.timeout)
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
    this.pending.delete(requestId)
    return pending
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.finishPending(requestId)
      pending.reject(error)
    }
  }
}

/** Self-contained preload installed with `node -e` before the service entry. */
function installServiceRpcGlobal(): void {
  const rpcRequestType = 'knowbook:service:rpc-request'
  const rpcResponseType = 'knowbook:service:rpc-response'
  const rpcEventType = 'knowbook:service:rpc-event'
  const rpcConnectType = 'knowbook:service:rpc-connect'
  const rpcConnectedType = 'knowbook:service:rpc-connected'
  const protocolVersion = 1
  const pluginId = process.env.KNOWBOOK_SYSTEM_PLUGIN_ID || ''
  const revisionHash = process.env.KNOWBOOK_SYSTEM_PLUGIN_REVISION || ''
  const socketEndpoint = process.env.KNOWBOOK_SYSTEM_PLUGIN_RPC_ENDPOINT || ''
  const socketToken = process.env.KNOWBOOK_SYSTEM_PLUGIN_RPC_TOKEN || ''
  const socketConfigured = Boolean(socketEndpoint || socketToken)
  const useSocket = Boolean(socketEndpoint && socketToken)
  const maxFrameBytes = 1_048_576
  const maxPendingRequests = 128
  const maxQueuedMessages = 256
  const reconnectInitialDelayMs = 100
  const reconnectMaximumDelayMs = 5_000
  const pending = new Map<string, {
    resolve(value: unknown): void
    reject(error: Error): void
    timeout: ReturnType<typeof setTimeout>
  }>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const outboundQueue: unknown[] = []
  let sequence = 0
  let disposed = false
  let socket: import('node:net').Socket | null = null
  let socketBuffer = ''
  let socketAuthenticated = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let everConnected = false
  const createClientError = (code: string, message: string) => (
    Object.assign(new Error(message), { code })
  )
  const removeQueuedRequest = (requestId: string) => {
    for (let index = outboundQueue.length - 1; index >= 0; index -= 1) {
      const candidate = outboundQueue[index]
      if (
        candidate
        && typeof candidate === 'object'
        && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).requestId === requestId
      ) {
        outboundQueue.splice(index, 1)
      }
    }
  }
  const finish = (requestId: string) => {
    const item = pending.get(requestId)
    if (!item) return null
    clearTimeout(item.timeout)
    pending.delete(requestId)
    removeQueuedRequest(requestId)
    return item
  }
  const encodeFrame = (message: unknown) => {
    let serialized: string
    try {
      serialized = JSON.stringify(message)
    } catch {
      throw createClientError('invalid-request', 'KnowBook service RPC payload is not serializable.')
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxFrameBytes) {
      throw createClientError('invalid-request', 'KnowBook service RPC payload exceeds the maximum size.')
    }
    return `${serialized}\n`
  }
  const writeSocketFrame = (message: unknown) => {
    if (!socket || socket.destroyed || !socket.writable || !socketAuthenticated) return false
    try {
      socket.write(encodeFrame(message))
      return true
    } catch {
      socket.destroy()
      return false
    }
  }
  const enqueue = (message: unknown) => {
    const value = message && typeof message === 'object' && !Array.isArray(message)
      ? message as Record<string, unknown>
      : null
    if (value?.type === 'knowbook:service:heartbeat') {
      const existing = outboundQueue.findIndex((candidate) => (
        candidate
        && typeof candidate === 'object'
        && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).type === 'knowbook:service:heartbeat'
      ))
      if (existing >= 0) {
        outboundQueue[existing] = message
        return
      }
    }
    if (outboundQueue.length >= maxQueuedMessages) {
      throw createClientError('busy', 'KnowBook service RPC reconnect queue is full.')
    }
    encodeFrame(message)
    outboundQueue.push(message)
  }
  const flushQueue = () => {
    if (!socketAuthenticated) return
    const messages = outboundQueue.splice(0)
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const value = message && typeof message === 'object' && !Array.isArray(message)
        ? message as Record<string, unknown>
        : null
      if (
        value?.type === rpcRequestType
        && typeof value.requestId === 'string'
        && !pending.has(value.requestId)
      ) continue
      if (!writeSocketFrame(message)) {
        outboundQueue.unshift(...messages.slice(index))
        break
      }
    }
  }
  const onMessage = (message: unknown) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    const value = message as Record<string, unknown>
    if (value.protocolVersion !== protocolVersion || value.pluginId !== pluginId || value.revisionHash !== revisionHash) return
    if (value.type === rpcEventType && typeof value.event === 'string') {
      for (const listener of listeners.get(value.event) || []) {
        try {
          listener(value.payload)
        } catch {
          // A plugin event listener cannot break the transport parser.
        }
      }
      return
    }
    if (value.type !== rpcResponseType || typeof value.requestId !== 'string') return
    const item = finish(value.requestId)
    if (!item) return
    if (value.ok === true) item.resolve(value.result)
    else {
      const errorValue = value.error && typeof value.error === 'object'
        ? value.error as Record<string, unknown>
        : {}
      item.reject(Object.assign(
        new Error(typeof errorValue.message === 'string' ? errorValue.message : 'KnowBook service RPC failed.'),
        { code: typeof errorValue.code === 'string' ? errorValue.code : 'handler-error' }
      ))
    }
  }
  const rejectPending = (message: string) => {
    for (const [requestId, item] of pending) {
      finish(requestId)
      item.reject(createClientError('transport-error', message))
    }
  }
  const scheduleReconnect = () => {
    if (disposed || !useSocket || reconnectTimer) return
    const delayMs = Math.min(
      reconnectInitialDelayMs * (2 ** Math.min(reconnectAttempt, 8)),
      reconnectMaximumDelayMs
    )
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectSocket()
    }, delayMs)
  }
  const handleSocketFrame = (message: unknown) => {
    if (!socketAuthenticated) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        socket?.destroy()
        return
      }
      const value = message as Record<string, unknown>
      const keys = Object.keys(value).sort()
      const expectedKeys = ['pluginId', 'protocolVersion', 'revisionHash', 'type'].sort()
      if (
        keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])
        || value.type !== rpcConnectedType
        || value.protocolVersion !== protocolVersion
        || value.pluginId !== pluginId
        || value.revisionHash !== revisionHash
      ) {
        socket?.destroy()
        return
      }
      socketAuthenticated = true
      socket?.setTimeout(0)
      reconnectAttempt = 0
      flushQueue()
      writeSocketFrame({
        type: 'knowbook:service:heartbeat',
        protocolVersion,
        pluginId,
        revisionHash,
        payload: { transport: 'local', reconnected: everConnected }
      })
      everConnected = true
      return
    }
    onMessage(message)
  }
  const connectSocket = () => {
    if (disposed || !useSocket || socket) return
    const net = require('node:net') as typeof import('node:net')
    const candidate = net.createConnection(socketEndpoint)
    socket = candidate
    socketBuffer = ''
    socketAuthenticated = false
    candidate.setEncoding('utf8')
    candidate.setNoDelay(true)
    candidate.setTimeout(2_000, () => {
      if (!socketAuthenticated) candidate.destroy()
    })
    candidate.once('connect', () => {
      try {
        candidate.write(encodeFrame({
          type: rpcConnectType,
          protocolVersion,
          pluginId,
          revisionHash,
          token: socketToken
        }))
      } catch {
        candidate.destroy()
      }
    })
    candidate.on('data', (chunk: string) => {
      socketBuffer += chunk
      if (Buffer.byteLength(socketBuffer, 'utf8') > maxFrameBytes && !socketBuffer.includes('\n')) {
        candidate.destroy()
        return
      }
      let lineEnd = socketBuffer.indexOf('\n')
      while (lineEnd >= 0) {
        const line = socketBuffer.slice(0, lineEnd)
        socketBuffer = socketBuffer.slice(lineEnd + 1)
        if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
          candidate.destroy()
          return
        }
        if (line.trim()) {
          try {
            handleSocketFrame(JSON.parse(line))
          } catch {
            candidate.destroy()
            return
          }
        }
        if (candidate.destroyed) return
        lineEnd = socketBuffer.indexOf('\n')
      }
    })
    candidate.on('error', () => {
      // A missing host is expected for detached services; close schedules retry.
    })
    candidate.once('close', () => {
      if (socket !== candidate) return
      const wasAuthenticated = socketAuthenticated
      socket = null
      socketBuffer = ''
      socketAuthenticated = false
      if (wasAuthenticated) {
        rejectPending('KnowBook service RPC transport disconnected.')
      }
      scheduleReconnect()
    })
  }
  const send = (message: unknown) => {
    if (disposed) {
      throw createClientError('disposed', 'KnowBook service RPC client was disposed.')
    }
    if (socketConfigured) {
      if (!useSocket) {
        throw createClientError('transport-error', 'KnowBook service RPC socket configuration is incomplete.')
      }
      if (!writeSocketFrame(message)) enqueue(message)
      connectSocket()
      return
    }
    if (!process.connected || typeof process.send !== 'function') {
      throw createClientError('transport-error', 'KnowBook service RPC transport is unavailable.')
    }
    process.send(message)
  }
  const onIpcDisconnect = () => rejectPending('KnowBook service RPC transport disconnected.')
  if (!socketConfigured) {
    process.on('message', onMessage)
    process.on('disconnect', onIpcDisconnect)
  } else if (useSocket) {
    connectSocket()
  }
  const api = Object.freeze({
    protocolVersion,
    pluginId,
    revisionHash,
    call(method: string, params: unknown = null, options: { timeoutMs?: number } = {}) {
      if (typeof method !== 'string' || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(method)) {
        return Promise.reject(createClientError('invalid-request', 'KnowBook service RPC method is invalid.'))
      }
      if (pending.size >= maxPendingRequests) {
        return Promise.reject(createClientError('busy', 'KnowBook service RPC client has too many pending requests.'))
      }
      const requestId = `${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}`
      const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs as number) > 0
        ? options.timeoutMs as number
        : 15_000
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          finish(requestId)
          reject(createClientError('timeout', `KnowBook service RPC method "${method}" timed out.`))
        }, timeoutMs)
        pending.set(requestId, { resolve, reject, timeout })
        try {
          send({ type: rpcRequestType, protocolVersion, pluginId, revisionHash, requestId, method, params })
        } catch (error) {
          finish(requestId)
          reject(error)
        }
      })
    },
    ready(payload: unknown = null) {
      send({ type: 'knowbook:service:ready', protocolVersion, pluginId, revisionHash, payload })
    },
    heartbeat(payload: unknown = null) {
      send({ type: 'knowbook:service:heartbeat', protocolVersion, pluginId, revisionHash, payload })
    },
    on(event: string, listener: (payload: unknown) => void) {
      if (
        typeof event !== 'string'
        || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(event)
        || typeof listener !== 'function'
      ) throw new TypeError('KnowBook service RPC event listener is invalid.')
      const eventListeners = listeners.get(event) || new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      return () => {
        eventListeners.delete(listener)
        if (eventListeners.size === 0) listeners.delete(event)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      process.removeListener('message', onMessage)
      process.removeListener('disconnect', onIpcDisconnect)
      socket?.destroy()
      socket = null
      rejectPending('KnowBook service RPC client was disposed.')
      outboundQueue.splice(0)
      listeners.clear()
    }
  })
  Object.defineProperty(globalThis, 'knowbookService', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: api
  })
}

export const SYSTEM_PLUGIN_SERVICE_RPC_BOOTSTRAP_SOURCE = [
  `'use strict';const __name=(target)=>target;(${installServiceRpcGlobal.toString()})();`,
  `require('node:module').runMain();`
].join('')

export function isRpcRequestEnvelope(message: unknown): boolean {
  return Boolean(
    message
    && typeof message === 'object'
    && !Array.isArray(message)
    && (message as Record<string, unknown>).type === SYSTEM_PLUGIN_SERVICE_RPC_REQUEST
  )
}

export function normalizeSystemPluginServiceRpcJson(
  value: unknown,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES
): SystemPluginServiceRpcJson {
  return normalizeRpcPayload(value, maxPayloadBytes)
}

class SystemPluginServiceRpcFault extends Error {
  constructor(
    readonly code: SystemPluginServiceRpcError['code'],
    message: string
  ) {
    super(message)
    this.name = 'SystemPluginServiceRpcFault'
  }
}

function normalizeRpcRequest(message: unknown, maxPayloadBytes: number): SystemPluginServiceRpcRequest {
  const value = requirePlainObject(message, 'RPC request')
  requireExactKeys(value, [
    'type',
    'protocolVersion',
    'pluginId',
    'revisionHash',
    'requestId',
    'method',
    'params'
  ], 'RPC request')
  if (value.type !== SYSTEM_PLUGIN_SERVICE_RPC_REQUEST) {
    throw new SystemPluginServiceRpcFault('invalid-request', 'RPC request type is invalid.')
  }
  if (value.protocolVersion !== SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION) {
    throw new SystemPluginServiceRpcFault('invalid-request', 'RPC protocol version is unsupported.')
  }
  return {
    type: SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
    protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
    pluginId: requireIdentityString(value.pluginId, 'RPC plugin id'),
    revisionHash: requireIdentityString(value.revisionHash, 'RPC revision hash'),
    requestId: normalizeRequestId(value.requestId),
    method: normalizeMethod(value.method),
    params: normalizeRpcPayload(value.params, maxPayloadBytes)
  }
}

function normalizeRpcPayload(value: unknown, maxPayloadBytes: number): SystemPluginServiceRpcJson {
  let nodeCount = 0
  const visit = (candidate: unknown, depth: number): SystemPluginServiceRpcJson | undefined => {
    nodeCount += 1
    if (nodeCount > DEFAULT_MAX_PAYLOAD_NODES || depth > DEFAULT_MAX_PAYLOAD_DEPTH) {
      throw new SystemPluginServiceRpcFault('invalid-request', 'RPC payload is too complex.')
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate
    }
    if (candidate === undefined) return undefined
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new SystemPluginServiceRpcFault('invalid-request', 'RPC payload numbers must be finite.')
      }
      return candidate
    }
    if (Array.isArray(candidate)) {
      return candidate.map((item) => visit(item, depth + 1) ?? null)
    }
    const object = requirePlainObject(candidate, 'RPC payload')
    const output: Record<string, SystemPluginServiceRpcJson> = {}
    for (const key of Object.keys(object)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key) || key.includes('\0')) {
        throw new SystemPluginServiceRpcFault('invalid-request', `RPC payload key "${key}" is not allowed.`)
      }
      const item = visit(object[key], depth + 1)
      if (item !== undefined) output[key] = item
    }
    return output
  }
  const normalized = visit(value, 0) ?? null
  let serialized: string
  try {
    serialized = JSON.stringify(normalized)
  } catch {
    throw new SystemPluginServiceRpcFault('invalid-request', 'RPC payload is not serializable.')
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxPayloadBytes) {
    throw new SystemPluginServiceRpcFault('invalid-request', 'RPC payload exceeds the maximum size.')
  }
  return normalized
}

function normalizeMethod(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_METHOD_LENGTH
    || !METHOD_PATTERN.test(value)
  ) {
    throw new SystemPluginServiceRpcFault('invalid-request', 'RPC method is invalid.')
  }
  return value
}

function normalizeRequestId(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_REQUEST_ID_LENGTH
    || !REQUEST_ID_PATTERN.test(value)
  ) {
    throw new SystemPluginServiceRpcFault('invalid-request', 'RPC request id is invalid.')
  }
  return value
}

function normalizeMethodMap(methods: SystemPluginServiceRpcMethodMap): SystemPluginServiceRpcMethodMap {
  const value = requirePlainObject(methods, 'RPC method map')
  const normalized: Record<string, SystemPluginServiceRpcMethod> = Object.create(null)
  for (const [name, method] of Object.entries(value)) {
    const normalizedName = normalizeMethod(name)
    if (typeof method !== 'function') {
      throw new TypeError(`RPC method "${normalizedName}" must be a function.`)
    }
    normalized[normalizedName] = method as SystemPluginServiceRpcMethod
  }
  return Object.freeze(normalized)
}

function normalizeResponseError(value: unknown): SystemPluginServiceRpcError {
  const object = requirePlainObject(value, 'RPC response error')
  const code = object.code
  const message = object.message
  if (!isRpcErrorCode(code) || typeof message !== 'string' || !message.trim()) {
    throw new Error('RPC response error is invalid.')
  }
  return { code, message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) }
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SystemPluginServiceRpcFault('invalid-request', `${label} must be an object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SystemPluginServiceRpcFault('invalid-request', `${label} must be a plain object.`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new SystemPluginServiceRpcFault('invalid-request', `${label} has an unsupported shape.`)
  }
}

function requireIdentityString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) {
    throw new SystemPluginServiceRpcFault('invalid-request', `${label} is invalid.`)
  }
  return value
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`${label} must be a positive integer.`)
  }
  return normalized
}

function readRequestId(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  try {
    return normalizeRequestId((message as Record<string, unknown>).requestId)
  } catch {
    return null
  }
}

function readMethod(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  try {
    return normalizeMethod((message as Record<string, unknown>).method)
  } catch {
    return null
  }
}

function readResponseIdentity(message: unknown): SystemPluginServiceRpcIdentity | null {
  if (!message || typeof message !== 'object') return null
  const value = message as Record<string, unknown>
  try {
    return {
      pluginId: requireIdentityString(value.pluginId, 'RPC plugin id'),
      revisionHash: requireIdentityString(value.revisionHash, 'RPC revision hash')
    }
  } catch {
    return null
  }
}

function createErrorResponse(
  identity: SystemPluginServiceRpcIdentity,
  requestId: string,
  error: SystemPluginServiceRpcError
): SystemPluginServiceRpcResponse {
  return {
    type: SYSTEM_PLUGIN_SERVICE_RPC_RESPONSE,
    protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
    ...identity,
    requestId,
    ok: false,
    error
  }
}

function rpcError(
  code: SystemPluginServiceRpcError['code'],
  message: string
): SystemPluginServiceRpcError {
  return { code, message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) }
}

function toRpcError(
  error: unknown,
  fallbackCode: SystemPluginServiceRpcError['code']
): SystemPluginServiceRpcError {
  if (error instanceof SystemPluginServiceRpcFault) {
    return rpcError(error.code, error.message)
  }
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'System plugin RPC method failed.'
  return rpcError(fallbackCode, message)
}

function isRpcErrorCode(value: unknown): value is SystemPluginServiceRpcError['code'] {
  return value === 'invalid-request'
    || value === 'identity-mismatch'
    || value === 'method-not-found'
    || value === 'busy'
    || value === 'timeout'
    || value === 'cancelled'
    || value === 'handler-error'
    || value === 'invalid-result'
    || value === 'transport-error'
    || value === 'disposed'
}
