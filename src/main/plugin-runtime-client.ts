import { utilityProcess, type UtilityProcess } from 'electron'
import runtimeModulePath from './plugin-runtime-process?modulePath'
import type {
  DocumentDetail,
  PluginSettingValue,
  RunPluginDocumentActionResult
} from '@shared/contracts'
import type { WorkspaceEvent } from './event-bus'
import type {
  IsolatedPluginRuntime,
  PluginRuntimeCommand,
  PluginRuntimeInitializeInput,
  PluginRuntimeMessage,
  PluginRuntimeOutput,
  PluginRuntimeRequest
} from './plugin-runtime-protocol'

type PendingRequest = {
  resolve: (output: PluginRuntimeOutput<any>) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const PLUGIN_RUNTIME_COMMAND_TIMEOUT_MS = 5_000
const PLUGIN_RUNTIME_INITIALIZE_TIMEOUT_MS = 30_000
const PLUGIN_RUNTIME_MAX_HEAP_MB = 128
const PLUGIN_RUNTIME_ERROR_MAX_CHARS = 10_000

export class ElectronPluginRuntime implements IsolatedPluginRuntime {
  private readonly process: UtilityProcess
  private readonly pending = new Map<number, PendingRequest>()
  private readonly stateListeners = new Set<(output: PluginRuntimeOutput) => void>()
  private readonly failureListeners = new Set<(error: Error) => void>()
  private requestSequence = 0
  private stopped = false
  private failure: Error | null = null

  constructor(private readonly pluginId: string) {
    this.process = utilityProcess.fork(runtimeModulePath, [], {
      serviceName: `KnowBook Plugin: ${pluginId}`,
      stdio: 'inherit',
      execArgv: [`--max-old-space-size=${PLUGIN_RUNTIME_MAX_HEAP_MB}`],
      env: getRestrictedPluginEnvironment()
    })
    this.process.on('message', (message) => this.handleMessage(message as PluginRuntimeMessage))
    this.process.on('error', (type, location) => {
      this.fail(new Error(`Plugin utility process fatal error (${type}) at ${location || 'unknown location'}.`))
    })
    this.process.on('exit', (code) => {
      if (!this.stopped) {
        this.fail(new Error(`Plugin utility process exited unexpectedly (code ${code}).`))
      }
    })
  }

  initialize(input: PluginRuntimeInitializeInput): Promise<PluginRuntimeOutput> {
    return this.request({ type: 'initialize', input }, PLUGIN_RUNTIME_INITIALIZE_TIMEOUT_MS)
  }

  handleWorkspaceEvent(
    event: WorkspaceEvent,
    documents: DocumentDetail[],
    removedDocumentIds: string[]
  ): Promise<PluginRuntimeOutput> {
    return this.request({
      type: 'workspace-event',
      event,
      documents,
      removedDocumentIds
    })
  }

  runDocumentAction(
    actionId: string,
    document: DocumentDetail
  ): Promise<PluginRuntimeOutput<RunPluginDocumentActionResult>> {
    return this.request({
      type: 'document-action',
      actionId,
      document
    })
  }

  updateSetting(settingId: string, value: PluginSettingValue): Promise<PluginRuntimeOutput> {
    return this.request({
      type: 'setting-update',
      settingId,
      value
    })
  }

  async dispose(): Promise<void> {
    if (this.stopped) {
      return
    }

    try {
      if (!this.failure) {
        await this.request({ type: 'dispose' })
      }
    } finally {
      this.stopped = true
      this.rejectPending(new Error(`Plugin runtime "${this.pluginId}" was disposed.`))
      this.process.kill()
    }
  }

  onStateChanged(listener: (output: PluginRuntimeOutput) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener)
    if (this.failure) {
      queueMicrotask(() => listener(this.failure as Error))
    }
    return () => {
      this.failureListeners.delete(listener)
    }
  }

  private request<TResult = undefined>(
    command: PluginRuntimeCommand,
    timeoutMs: number = PLUGIN_RUNTIME_COMMAND_TIMEOUT_MS
  ): Promise<PluginRuntimeOutput<TResult>> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (this.stopped) {
      return Promise.reject(new Error(`Plugin runtime "${this.pluginId}" is stopped.`))
    }

    const requestId = ++this.requestSequence
    return new Promise<PluginRuntimeOutput<TResult>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        const error = new Error(
          `Plugin runtime command "${command.type}" timed out after ${timeoutMs}ms.`
        )
        reject(error)
        this.fail(error)
        this.process.kill()
      }, timeoutMs)

      this.pending.set(requestId, {
        resolve: resolve as PendingRequest['resolve'],
        reject,
        timeout
      })

      try {
        const request: PluginRuntimeRequest = {
          kind: 'request',
          requestId,
          command
        }
        this.process.postMessage(request)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(requestId)
        const normalizedError = normalizeError(error, 'Failed to send a command to the plugin runtime.')
        reject(normalizedError)
        this.fail(normalizedError)
      }
    })
  }

  private handleMessage(message: PluginRuntimeMessage): void {
    if (!message || typeof message !== 'object') {
      return
    }

    if (message.kind === 'state-changed') {
      for (const listener of this.stateListeners) {
        listener(message.output)
      }
      return
    }

    if (message.kind !== 'response') {
      return
    }

    const pending = this.pending.get(message.requestId)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pending.delete(message.requestId)
    if (message.ok && message.output) {
      pending.resolve(message.output)
      return
    }
    pending.reject(new Error(
      (message.error || 'Plugin runtime command failed.').slice(0, PLUGIN_RUNTIME_ERROR_MAX_CHARS)
    ))
  }

  private fail(error: Error): void {
    if (this.failure || this.stopped) {
      return
    }

    this.failure = error
    this.rejectPending(error)
    for (const listener of this.failureListeners) {
      listener(error)
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function normalizeError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error
  }
  if (typeof error === 'string' && error.trim()) {
    return new Error(error.trim())
  }
  return new Error(fallback)
}

function getRestrictedPluginEnvironment(): Record<string, string> {
  const safeKeys = ['LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'] as const
  return Object.fromEntries(
    safeKeys.flatMap((key) => {
      const value = process.env[key]
      return value === undefined ? [] : [[key, value]]
    })
  )
}
