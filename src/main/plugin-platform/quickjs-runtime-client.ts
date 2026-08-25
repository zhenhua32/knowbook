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
  PluginRuntimeActivationSnapshot
} from './activation-coordinator'
import {
  toQuickJsRuntimePackagePayload,
  type QuickJsRuntimeCapabilityRequest,
  type QuickJsRuntimeHostMessage,
  type QuickJsRuntimeProcessMessage,
  type QuickJsRuntimeRequest
} from './quickjs-runtime-protocol'
import { clonePluginRuntimeJson } from './runtime-json'

const INITIALIZE_TIMEOUT_MS = 30_000
const ACTIVATE_TIMEOUT_MS = 5_000
const HANDLER_TIMEOUT_MS = 15_000
const DISPOSE_TIMEOUT_MS = 2_000
const UTILITY_PROCESS_MAX_HEAP_MB = 96
const MAX_ERROR_CHARS = 2_000

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
  private requestSequence = 0
  private owner: PluginActiveOwner | null = null
  private stopped = false
  private failure: Error | null = null

  constructor(
    private readonly context: NoNodePluginRuntimeHostContext,
    private readonly process: QuickJsUtilityTransport
  ) {
    this.process.on('message', (message) => {
      this.handleMessage(message as QuickJsRuntimeProcessMessage)
    })
    this.process.on('error', (type, location) => {
      this.fail(new Error(`QuickJS utility process fatal error (${type}) at ${location || 'unknown'}.`))
    })
    this.process.on('exit', (code) => {
      if (!this.stopped) {
        this.fail(new Error(`QuickJS utility process exited unexpectedly (code ${code}).`))
      }
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

  async dispose(): Promise<void> {
    if (this.stopped) {
      return
    }
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

  private handleMessage(message: QuickJsRuntimeProcessMessage): void {
    if (!message || typeof message !== 'object') {
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
