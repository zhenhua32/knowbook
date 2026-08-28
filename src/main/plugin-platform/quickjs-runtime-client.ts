import { utilityProcess } from 'electron'
import type {
  PluginActivationIdentity,
  PluginActiveOwner,
  PluginJsonValue
} from '@shared/plugin-platform'
import runtimeModulePath from '../quickjs-runtime-module-path'
import type {
  NoNodePluginRuntimeFactory,
  NoNodePluginRuntimeHostContext,
  NoNodePluginRuntimeInstance,
  PluginRuntimeStateMigrationInput,
  PluginRuntimeActivationSnapshot,
  PluginRuntimeHealth
} from './activation-coordinator'
import {
  toQuickJsRuntimePackagePayload,
  type QuickJsRuntimeCapabilityRequest,
  type QuickJsRuntimeHostMessage,
  type QuickJsRuntimeProcessMessage,
  type QuickJsRuntimeRequest
} from './quickjs-runtime-protocol'
import { clonePluginRuntimeJson } from './runtime-json'
import { waitForUtilityProcessExit } from './utility-process-lifecycle'

const INITIALIZE_TIMEOUT_MS = 30_000
const ACTIVATE_TIMEOUT_MS = 5_000
const MIGRATE_STATE_TIMEOUT_MS = 10_000
const VALIDATE_HANDLERS_TIMEOUT_MS = 5_000
const HEALTH_TIMEOUT_MS = 2_000
const HANDLER_TIMEOUT_MS = 15_000
const DISPOSE_TIMEOUT_MS = 2_000
const PROCESS_EXIT_TIMEOUT_MS = 5_000
const UTILITY_PROCESS_MAX_HEAP_MB = 96
const MAX_ERROR_CHARS = 2_000
const MAX_PENDING_RUNTIME_REQUESTS = 32

type PendingRequest = {
  identity: PluginActivationIdentity | PluginActiveOwner
  resolve: (value: PluginJsonValue) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  unlinkAbort: () => void
}

interface QuickJsUtilityTransport {
  postMessage(message: QuickJsRuntimeHostMessage): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  on(event: 'error', listener: (type: string, location: string) => void): this
}

export interface QuickJsWasiPluginRuntimeFactoryOptions {
  spawn?: (identity: PluginActivationIdentity) => QuickJsUtilityTransport
}

export class QuickJsWasiPluginRuntimeFactory implements NoNodePluginRuntimeFactory {
  readonly isolation = 'no-node-isolate' as const

  constructor(private readonly options: QuickJsWasiPluginRuntimeFactoryOptions = {}) {}

  async create(context: NoNodePluginRuntimeHostContext): Promise<NoNodePluginRuntimeInstance> {
    const runtime = new ElectronQuickJsPluginRuntime(
      context,
      this.options.spawn?.(context.identity) ?? spawnQuickJsUtilityProcess(context.identity)
    )
    try {
      await runtime.initialize()
      return runtime
    } catch (error) {
      await runtime.dispose()
      throw error
    }
  }
}

class ElectronQuickJsPluginRuntime implements NoNodePluginRuntimeInstance {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly processExit: Promise<void>
  private requestSequence = 0
  private owner: PluginActiveOwner | null = null
  private stopped = false
  private failure: Error | null = null
  private disposal: Promise<void> | null = null

  constructor(
    private readonly context: NoNodePluginRuntimeHostContext,
    private readonly process: QuickJsUtilityTransport
  ) {
    this.processExit = new Promise<void>((resolve) => {
      this.process.on('exit', (code) => {
        resolve()
        if (!this.stopped) {
          this.fail(new Error(`QuickJS utility process exited unexpectedly (code ${code}).`))
        }
      })
    })
    this.process.on('message', (message) => {
      this.handleMessage(message)
    })
    this.process.on('error', (type, location) => {
      this.fail(new Error(`QuickJS utility process fatal error (${type}) at ${location || 'unknown'}.`))
    })
  }

  async initialize(): Promise<void> {
    await this.request(
      this.context.identity,
      {
        type: 'initialize',
        package: toQuickJsRuntimePackagePayload(this.context.package)
      },
      INITIALIZE_TIMEOUT_MS
    )
  }

  async activate(): Promise<PluginRuntimeActivationSnapshot> {
    const output = await this.request(
      this.context.identity,
      { type: 'activate' },
      ACTIVATE_TIMEOUT_MS
    )
    return clonePluginRuntimeJson(output, 'QuickJS activation output') as unknown as PluginRuntimeActivationSnapshot
  }

  async migrateState(input: PluginRuntimeStateMigrationInput): Promise<PluginJsonValue> {
    return this.request(
      this.context.identity,
      {
        type: 'migrate-state',
        input: clonePluginRuntimeJson(input, 'QuickJS state migration input') as unknown as PluginRuntimeStateMigrationInput
      },
      MIGRATE_STATE_TIMEOUT_MS
    )
  }

  async validateHandlers(handlerIds: readonly string[]): Promise<void> {
    await this.request(
      this.context.identity,
      { type: 'validate-handlers', handlerIds: [...handlerIds] },
      VALIDATE_HANDLERS_TIMEOUT_MS
    )
  }

  async health(): Promise<PluginRuntimeHealth> {
    return await this.request(
      this.owner ?? this.context.identity,
      { type: 'health' },
      HEALTH_TIMEOUT_MS
    ) as unknown as PluginRuntimeHealth
  }

  commit(owner: PluginActiveOwner): void {
    this.assertActivationIdentity(owner)
    if (!Number.isSafeInteger(owner.epoch) || owner.epoch < 1) {
      throw new Error('QuickJS runtime owner epoch is invalid.')
    }
    this.owner = structuredClone(owner)
    this.post({ kind: 'commit', identity: owner })
  }

  invokeHandler(
    owner: PluginActiveOwner,
    handlerId: string,
    input: PluginJsonValue,
    signal: AbortSignal
  ): Promise<PluginJsonValue> {
    this.assertCurrentOwner(owner)
    return this.request(
      owner,
      {
        type: 'invoke-handler',
        handlerId,
        input: clonePluginRuntimeJson(input, 'QuickJS handler input')
      },
      HANDLER_TIMEOUT_MS,
      signal
    )
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    try {
      if (!this.failure) {
        await this.request(
          this.owner ?? this.context.identity,
          { type: 'dispose' },
          DISPOSE_TIMEOUT_MS
        ).catch(() => undefined)
      }
    } finally {
      this.stopped = true
      this.owner = null
      this.rejectPending(new Error('QuickJS plugin runtime was disposed.'))
      this.process.kill()
      await waitForUtilityProcessExit(this.processExit, PROCESS_EXIT_TIMEOUT_MS)
    }
  }

  private request(
    identity: PluginActivationIdentity | PluginActiveOwner,
    command: QuickJsRuntimeRequest['command'],
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<PluginJsonValue> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (this.stopped) {
      return Promise.reject(new Error('QuickJS plugin runtime is stopped.'))
    }
    if (signal?.aborted) {
      return Promise.reject(normalizeAbortReason(signal.reason))
    }
    if (this.pending.size >= MAX_PENDING_RUNTIME_REQUESTS) {
      return Promise.reject(new Error(
        `QuickJS runtime protocol queue exceeds ${MAX_PENDING_RUNTIME_REQUESTS} pending requests.`
      ))
    }

    const requestId = ++this.requestSequence
    return new Promise<PluginJsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(requestId)
        if (!pending) {
          return
        }
        this.pending.delete(requestId)
        pending.unlinkAbort()
        const error = new Error(`QuickJS runtime command "${command.type}" timed out after ${timeoutMs}ms.`)
        reject(error)
        this.fail(error)
        this.process.kill()
      }, timeoutMs)

      const abort = () => {
        const pending = this.pending.get(requestId)
        if (!pending) {
          return
        }
        clearTimeout(pending.timeout)
        this.pending.delete(requestId)
        pending.unlinkAbort()
        this.post({ kind: 'cancel', requestId, identity })
        reject(normalizeAbortReason(signal?.reason))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(requestId, {
        identity,
        resolve,
        reject,
        timeout,
        unlinkAbort: () => signal?.removeEventListener('abort', abort)
      })

      this.post({ kind: 'request', requestId, identity, command })
    })
  }

  private handleMessage(raw: unknown): void {
    let message: QuickJsRuntimeProcessMessage
    try {
      message = parseProcessMessage(raw)
    } catch (error) {
      const failure = new Error('QuickJS utility process violated the host protocol.', {
        cause: error
      })
      this.fail(failure)
      this.process.kill()
      return
    }
    if (message.kind === 'capability-call') {
      void this.handleCapabilityCall(message)
      return
    }
    if (message.kind !== 'response' || !Number.isSafeInteger(message.requestId)) {
      return
    }
    const pending = this.pending.get(message.requestId)
    if (!pending || !sameWireIdentity(pending.identity, message.identity)) {
      return
    }
    clearTimeout(pending.timeout)
    pending.unlinkAbort()
    this.pending.delete(message.requestId)
    if (message.ok && message.output !== undefined) {
      try {
        pending.resolve(clonePluginRuntimeJson(message.output, 'QuickJS runtime response'))
      } catch (error) {
        pending.reject(normalizeError(error))
      }
      return
    }
    pending.reject(new Error(safeError(message.error, 'QuickJS runtime command failed.')))
  }

  private async handleCapabilityCall(message: QuickJsRuntimeCapabilityRequest): Promise<void> {
    if (!this.owner || !sameActiveOwner(this.owner, message.identity) || this.stopped || this.failure) {
      this.postCapabilityResult(message, false, undefined, 'Plugin capability owner is stale.')
      return
    }
    try {
      const call = clonePluginRuntimeJson(
        message.call,
        'QuickJS capability request'
      ) as unknown as QuickJsRuntimeCapabilityRequest['call']
      const output = await this.context.callCapability(call)
      if (!this.owner || !sameActiveOwner(this.owner, message.identity) || this.stopped) {
        this.postCapabilityResult(message, false, undefined, 'Plugin capability result is stale.')
        return
      }
      this.postCapabilityResult(
        message,
        true,
        clonePluginRuntimeJson(output, 'QuickJS capability response')
      )
    } catch (error) {
      this.postCapabilityResult(message, false, undefined, safeError(
        error instanceof Error ? error.message : error,
        'Plugin capability call failed.'
      ))
    }
  }

  private postCapabilityResult(
    request: QuickJsRuntimeCapabilityRequest,
    ok: boolean,
    output?: PluginJsonValue,
    error?: string
  ): void {
    if (this.stopped) {
      return
    }
    this.post({
      kind: 'capability-result',
      capabilityRequestId: request.capabilityRequestId,
      identity: request.identity,
      ok,
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error })
    })
  }

  private post(message: QuickJsRuntimeHostMessage): void {
    if (this.failure) {
      throw this.failure
    }
    if (this.stopped) {
      throw new Error('QuickJS plugin runtime is stopped.')
    }
    try {
      this.process.postMessage(message)
    } catch (error) {
      const normalized = normalizeError(error)
      this.fail(normalized)
      throw normalized
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.stopped) {
      return
    }
    this.failure = error
    this.owner = null
    this.rejectPending(error)
    this.context.reportFatal(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.unlinkAbort()
      pending.reject(error)
    }
    this.pending.clear()
  }

  private assertActivationIdentity(identity: PluginActivationIdentity): void {
    if (!sameActivationIdentity(this.context.identity, identity)) {
      throw new Error('QuickJS runtime identity is stale.')
    }
  }

  private assertCurrentOwner(owner: PluginActiveOwner): void {
    if (!this.owner || !sameActiveOwner(this.owner, owner)) {
      throw new Error('QuickJS runtime owner is stale.')
    }
  }
}

function spawnQuickJsUtilityProcess(identity: PluginActivationIdentity): QuickJsUtilityTransport {
  return utilityProcess.fork(runtimeModulePath, [], {
    serviceName: `KnowBook QuickJS Plugin: ${identity.pluginId}`,
    stdio: 'ignore',
    execArgv: [`--max-old-space-size=${UTILITY_PROCESS_MAX_HEAP_MB}`],
    env: restrictedUtilityEnvironment()
  }) as QuickJsUtilityTransport
}

function restrictedUtilityEnvironment(): Record<string, string> {
  const safeKeys = ['LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'] as const
  return Object.fromEntries(safeKeys.flatMap((key) => {
    const value = process.env[key]
    return value === undefined ? [] : [[key, value]]
  }))
}

function sameActivationIdentity(
  left: PluginActivationIdentity,
  right: PluginActivationIdentity
): boolean {
  return left.pluginId === right.pluginId
    && left.revisionId === right.revisionId
    && left.runId === right.runId
    && left.grantSetId === right.grantSetId
    && JSON.stringify(left.scope) === JSON.stringify(right.scope)
}

function sameActiveOwner(left: PluginActiveOwner, right: PluginActiveOwner): boolean {
  return sameActivationIdentity(left, right) && left.epoch === right.epoch
}

function sameWireIdentity(
  left: PluginActivationIdentity | PluginActiveOwner,
  right: PluginActivationIdentity | PluginActiveOwner
): boolean {
  return sameActivationIdentity(left, right)
    && (('epoch' in left || 'epoch' in right)
      ? 'epoch' in left && 'epoch' in right && left.epoch === right.epoch
      : true)
}

function safeError(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim().slice(0, MAX_ERROR_CHARS)
  }
  return fallback
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(safeError(error, 'QuickJS utility process failed.'))
}

function normalizeAbortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Plugin invocation was cancelled.')
}


function parseProcessMessage(raw: unknown): QuickJsRuntimeProcessMessage {
  const message = plainObject(raw, 'Runtime process message')
  if (message.kind === 'response') {
    exactKeys(message, ['kind', 'requestId', 'identity', 'ok', 'output', 'error'], 'Runtime response')
    if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) < 1) {
      throw new Error('Runtime response requestId is invalid.')
    }
    validateWireIdentity(message.identity, 'Runtime response identity')
    if (typeof message.ok !== 'boolean') throw new Error('Runtime response ok is invalid.')
    if (message.error !== undefined && (typeof message.error !== 'string' || message.error.length > MAX_ERROR_CHARS)) {
      throw new Error('Runtime response error is invalid.')
    }
    if (message.output !== undefined) clonePluginRuntimeJson(message.output, 'Runtime response output')
    return message as unknown as QuickJsRuntimeProcessMessage
  }
  if (message.kind === 'capability-call') {
    exactKeys(message, ['kind', 'capabilityRequestId', 'identity', 'call'], 'Runtime capability request')
    if (!Number.isSafeInteger(message.capabilityRequestId) || (message.capabilityRequestId as number) < 1) {
      throw new Error('Runtime capability request id is invalid.')
    }
    validateWireIdentity(message.identity, 'Runtime capability identity', true)
    const call = plainObject(message.call, 'Runtime capability call')
    exactKeys(call, ['callId', 'capability', 'version', 'input'], 'Runtime capability call')
    if (!Object.hasOwn(call, 'input')) throw new Error('Runtime capability input is required.')
    if (call.callId !== undefined && (typeof call.callId !== 'string' || call.callId.length > 200)) {
      throw new Error('Runtime capability callId is invalid.')
    }
    if (typeof call.capability !== 'string' || call.capability.length > 120) {
      throw new Error('Runtime capability id is invalid.')
    }
    if (!Number.isSafeInteger(call.version) || (call.version as number) < 1) {
      throw new Error('Runtime capability version is invalid.')
    }
    clonePluginRuntimeJson(call.input, 'Runtime capability input')
    return message as unknown as QuickJsRuntimeProcessMessage
  }
  throw new Error('Runtime process message kind is invalid.')
}

function validateWireIdentity(raw: unknown, label: string, requireEpoch = false): void {
  const identity = plainObject(raw, label)
  exactKeys(identity, ['pluginId', 'revisionId', 'runId', 'grantSetId', 'scope', 'epoch'], label)
  for (const key of ['pluginId', 'revisionId', 'runId', 'grantSetId'] as const) {
    if (typeof identity[key] !== 'string' || !identity[key] || identity[key].length > 500) {
      throw new Error(`${label} ${key} is invalid.`)
    }
  }
  const scope = plainObject(identity.scope, `${label} scope`)
  if (scope.kind === 'app') exactKeys(scope, ['kind'], `${label} scope`)
  else if (scope.kind === 'workspace') exactKeys(scope, ['kind', 'workspaceId'], `${label} scope`)
  else if (scope.kind === 'session') exactKeys(scope, ['kind', 'workspaceId', 'sessionId'], `${label} scope`)
  else throw new Error(`${label} scope kind is invalid.`)
  for (const key of ['workspaceId', 'sessionId'] as const) {
    if (scope[key] !== undefined && (typeof scope[key] !== 'string' || !scope[key] || scope[key].length > 500)) {
      throw new Error(`${label} scope ${key} is invalid.`)
    }
  }
  if (requireEpoch && (!Number.isSafeInteger(identity.epoch) || (identity.epoch as number) < 1)) {
    throw new Error(`${label} epoch is invalid.`)
  }
  if (!requireEpoch && identity.epoch !== undefined && (!Number.isSafeInteger(identity.epoch) || (identity.epoch as number) < 1)) {
    throw new Error(`${label} epoch is invalid.`)
  }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object.`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !keys.has(key))
  if (unknown) throw new Error(`${label} contains unknown field "${unknown}".`)
}
