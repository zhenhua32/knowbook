import {
  spawn as spawnProcess,
  type ChildProcess,
  type SpawnOptions
} from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SystemPluginV3Manifest } from '@shared/system-plugin'
import {
  isRpcRequestEnvelope,
  SYSTEM_PLUGIN_SERVICE_RPC_BOOTSTRAP_SOURCE,
  SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
  type SystemPluginServiceRpcHost,
  type SystemPluginServiceRpcResponse
} from './service-rpc'

const DEFAULT_RESTART_INITIAL_DELAY_MS = 500
const DEFAULT_RESTART_MAX_DELAY_MS = 30_000
const DEFAULT_MAX_RESTARTS = 5
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 1_000

export const SYSTEM_PLUGIN_SERVICE_READY_MESSAGE = 'knowbook:service:ready'
export const SYSTEM_PLUGIN_SERVICE_HEARTBEAT_MESSAGE = 'knowbook:service:heartbeat'

export type SystemPluginServiceMode = 'app-lifetime' | 'detached'

export type SystemPluginServiceStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'restart-wait'
  | 'stopping'
  | 'stopped'
  | 'failed'

export interface SystemPluginServicePackage {
  /** Immutable, already-confirmed artifact root. */
  rootDirectory: string
  revisionHash: string
  manifest: Pick<
    SystemPluginV3Manifest,
    'id' | 'version' | 'entries' | 'background'
  >
}

export interface SystemPluginServiceExit {
  pid: number | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  expected: boolean
  timestamp: string
}

export interface SystemPluginServiceSnapshot {
  pluginId: string
  version: string
  revisionHash: string
  mode: SystemPluginServiceMode
  status: SystemPluginServiceStatus
  pid: number | null
  ready: boolean
  restartCount: number
  startedAt: string | null
  readyAt: string | null
  lastHeartbeatAt: string | null
  lastExit: SystemPluginServiceExit | null
}

interface SystemPluginServiceEventBase {
  pluginId: string
  version: string
  revisionHash: string
  mode: SystemPluginServiceMode
  timestamp: string
}

export type SystemPluginServiceEvent =
  | (SystemPluginServiceEventBase & {
    type: 'started'
    pid: number | null
    executable: string
    args: readonly string[]
    restartCount: number
  })
  | (SystemPluginServiceEventBase & {
    type: 'log'
    pid: number | null
    stream: 'stdout' | 'stderr'
    text: string
  })
  | (SystemPluginServiceEventBase & {
    type: 'ready'
    pid: number | null
    message: unknown
  })
  | (SystemPluginServiceEventBase & {
    type: 'heartbeat'
    pid: number | null
    message: unknown
  })
  | (SystemPluginServiceEventBase & {
    type: 'message'
    pid: number | null
    message: unknown
  })
  | (SystemPluginServiceEventBase & {
    type: 'exit'
    pid: number | null
    exitCode: number | null
    signal: NodeJS.Signals | null
    expected: boolean
    error: Error | null
  })
  | (SystemPluginServiceEventBase & {
    type: 'restart-scheduled'
    restartCount: number
    delayMs: number
  })
  | (SystemPluginServiceEventBase & {
    type: 'stop-requested' | 'kill-requested'
    pid: number | null
    signal: NodeJS.Signals
  })
  | (SystemPluginServiceEventBase & {
    type: 'fatal'
    error: Error
    restartCount: number
  })

type SystemPluginServiceEventInput = SystemPluginServiceEvent extends infer TEvent
  ? TEvent extends SystemPluginServiceEventBase
    ? Omit<TEvent, keyof SystemPluginServiceEventBase>
    : never
  : never

export type SystemPluginServiceSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export interface SystemPluginServiceRestartPolicy {
  maxRestarts: number
  initialDelayMs: number
  maxDelayMs: number
}

export interface SystemPluginServiceSupervisorOptions {
  package: SystemPluginServicePackage
  /** Arguments appended after the exact entries.service path. */
  args?: readonly string[]
  /** Defaults to process.execPath. Electron hosts are launched in Node mode. */
  executable?: string
  /** Environment additions/overrides. Full Trust services inherit process.env. */
  environment?: NodeJS.ProcessEnv
  restart?: Partial<SystemPluginServiceRestartPolicy>
  stopTimeoutMs?: number
  forceKillTimeoutMs?: number
  stopSignal?: NodeJS.Signals
  killSignal?: NodeJS.Signals
  spawn?: SystemPluginServiceSpawn
  /** Optional versioned Main-process RPC host exposed as globalThis.knowbookService. */
  rpcHost?: SystemPluginServiceRpcHost
  onEvent?(event: SystemPluginServiceEvent): void
  onSnapshot?(snapshot: Readonly<SystemPluginServiceSnapshot>): void
}

export class SystemPluginServiceFatalError extends Error {
  constructor(
    message: string,
    readonly restartCount: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SystemPluginServiceFatalError'
  }
}

export class SystemPluginServiceStopTimeoutError extends Error {
  constructor(
    readonly pluginId: string,
    readonly timeoutMs: number
  ) {
    super(`System plugin service "${pluginId}" did not exit within ${timeoutMs}ms after forced termination.`)
    this.name = 'SystemPluginServiceStopTimeoutError'
  }
}

interface ActiveServiceRun {
  generation: number
  child: ChildProcess
  pid: number | null
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  stdoutDecoder: StringDecoder
  stderrDecoder: StringDecoder
  rpcAbortController: AbortController
  closed: Promise<void>
  resolveClosed(): void
  terminal: boolean
}

/**
 * Supervises a Full Trust service entry. This is lifecycle infrastructure, not
 * a security boundary: the child inherits the user's authority and environment.
 */
export class SystemPluginServiceSupervisor {
  readonly pluginId: string
  readonly version: string
  readonly revisionHash: string
  readonly mode: SystemPluginServiceMode
  readonly autoStart: boolean
  readonly rootDirectory: string
  readonly entryPath: string

  private readonly executable: string
  private readonly args: readonly string[]
  private readonly launchArgs: readonly string[]
  private readonly environment: NodeJS.ProcessEnv
  private readonly restartPolicy: SystemPluginServiceRestartPolicy
  private readonly stopTimeoutMs: number
  private readonly forceKillTimeoutMs: number
  private readonly stopSignal: NodeJS.Signals
  private readonly killSignal: NodeJS.Signals
  private readonly spawn: SystemPluginServiceSpawn
  private readonly rpcHost: SystemPluginServiceRpcHost | null
  private readonly onEvent?: SystemPluginServiceSupervisorOptions['onEvent']
  private readonly onSnapshot?: SystemPluginServiceSupervisorOptions['onSnapshot']

  private currentStatus: SystemPluginServiceStatus = 'idle'
  private activeRun: ActiveServiceRun | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private stopRequested = false
  private restartCount = 0
  private startedAt: string | null = null
  private readyAt: string | null = null
  private lastHeartbeatAt: string | null = null
  private lastExit: SystemPluginServiceExit | null = null
  private stopOperation: Promise<Readonly<SystemPluginServiceSnapshot>> | null = null

  constructor(options: SystemPluginServiceSupervisorOptions) {
    const servicePackage = normalizePackage(options.package)
    this.pluginId = servicePackage.manifest.id
    this.version = servicePackage.manifest.version
    this.revisionHash = servicePackage.revisionHash
    this.mode = servicePackage.manifest.background.mode
    this.autoStart = servicePackage.manifest.background.autoStart
    this.rootDirectory = servicePackage.rootDirectory
    this.entryPath = resolveServiceEntry(
      this.rootDirectory,
      servicePackage.manifest.entries.service
    )
    this.executable = normalizeExecutable(options.executable ?? process.execPath)
    this.args = Object.freeze([
      this.entryPath,
      ...normalizeArguments(options.args ?? [], 'System plugin service arguments')
    ])
    this.rpcHost = options.rpcHost ?? null
    if (
      this.rpcHost
      && (
        this.rpcHost.identity.pluginId !== this.pluginId
        || this.rpcHost.identity.revisionHash !== this.revisionHash
      )
    ) {
      throw new Error('System plugin service RPC identity does not match its package.')
    }
    this.launchArgs = this.rpcHost
      ? Object.freeze([
          '-e',
          SYSTEM_PLUGIN_SERVICE_RPC_BOOTSTRAP_SOURCE,
          ...this.args
        ])
      : this.args
    this.environment = {
      ...process.env,
      ...options.environment,
      ELECTRON_RUN_AS_NODE: '1',
      KNOWBOOK_SYSTEM_PLUGIN_ID: this.pluginId,
      KNOWBOOK_SYSTEM_PLUGIN_VERSION: this.version,
      KNOWBOOK_SYSTEM_PLUGIN_REVISION: this.revisionHash,
      KNOWBOOK_SYSTEM_PLUGIN_ROOT: this.rootDirectory,
      ...(this.rpcHost
        ? { KNOWBOOK_SYSTEM_PLUGIN_RPC_PROTOCOL: String(SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION) }
        : {})
    }
    this.restartPolicy = normalizeRestartPolicy(options.restart)
    this.stopTimeoutMs = normalizeDuration(
      options.stopTimeoutMs,
      DEFAULT_STOP_TIMEOUT_MS,
      'System plugin service stop timeout'
    )
    this.forceKillTimeoutMs = normalizeDuration(
      options.forceKillTimeoutMs,
      DEFAULT_FORCE_KILL_TIMEOUT_MS,
      'System plugin service force-kill timeout'
    )
    this.stopSignal = options.stopSignal ?? 'SIGTERM'
    this.killSignal = options.killSignal ?? 'SIGKILL'
    this.spawn = options.spawn ?? defaultSpawn
    this.onEvent = options.onEvent
    this.onSnapshot = options.onSnapshot
  }

  get status(): SystemPluginServiceStatus {
    return this.currentStatus
  }

  get snapshot(): Readonly<SystemPluginServiceSnapshot> {
    return this.createSnapshot()
  }

  startIfConfigured(): Readonly<SystemPluginServiceSnapshot> {
    return this.autoStart ? this.start() : this.snapshot
  }

  start(): Readonly<SystemPluginServiceSnapshot> {
    if (
      this.currentStatus === 'starting' ||
      this.currentStatus === 'running' ||
      this.currentStatus === 'restart-wait'
    ) {
      return this.snapshot
    }
    if (this.currentStatus === 'stopping') {
      throw new Error(`System plugin service "${this.pluginId}" is stopping.`)
    }

    this.stopRequested = false
    this.restartCount = 0
    this.lastExit = null
    this.spawnService()
    return this.snapshot
  }

  stop(): Promise<Readonly<SystemPluginServiceSnapshot>> {
    if (this.stopOperation) return this.stopOperation
    this.stopOperation = this.stopInternal().finally(() => {
      this.stopOperation = null
    })
    return this.stopOperation
  }

  private async stopInternal(): Promise<Readonly<SystemPluginServiceSnapshot>> {
    this.stopRequested = true
    this.cancelRestart()
    const run = this.activeRun
    if (!run) {
      this.setStatus('stopped')
      return this.snapshot
    }

    this.setStatus('stopping')
    this.emit({
      type: 'stop-requested',
      pid: run.pid,
      signal: this.stopSignal
    })
    tryKill(run.child, this.stopSignal)

    if (await waitFor(run.closed, this.stopTimeoutMs)) {
      this.setStatus('stopped')
      return this.snapshot
    }

    this.emit({
      type: 'kill-requested',
      pid: run.pid,
      signal: this.killSignal
    })
    tryKill(run.child, this.killSignal)
    if (await waitFor(run.closed, this.forceKillTimeoutMs)) {
      this.setStatus('stopped')
      return this.snapshot
    }

    this.detachRun(run)
    this.setStatus('stopped')
    throw new SystemPluginServiceStopTimeoutError(
      this.pluginId,
      this.stopTimeoutMs + this.forceKillTimeoutMs
    )
  }

  private spawnService(): void {
    this.cancelRestart()
    this.setStatus('starting')
    const generation = ++this.generation
    let child: ChildProcess
    try {
      child = this.spawn(this.executable, this.launchArgs, {
        cwd: this.rootDirectory,
        env: this.environment,
        shell: false,
        windowsHide: true,
        detached: this.mode === 'detached',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
    } catch (cause) {
      this.handleSpawnFailure(generation, cause)
      return
    }

    let resolveClosed!: () => void
    const closed = new Promise<void>((resolvePromise) => {
      resolveClosed = resolvePromise
    })
    const run: ActiveServiceRun = {
      generation,
      child,
      pid: normalizePid(child.pid),
      stdout: child.stdout,
      stderr: child.stderr,
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      rpcAbortController: new AbortController(),
      closed,
      resolveClosed,
      terminal: false
    }
    this.activeRun = run
    this.startedAt = timestamp()
    this.readyAt = null
    this.lastHeartbeatAt = null
    this.attachRun(run)
    if (this.mode === 'detached') child.unref()
    this.setStatus('running')
    this.emit({
      type: 'started',
      pid: run.pid,
      executable: this.executable,
      args: this.args,
      restartCount: this.restartCount
    })
  }

  private attachRun(run: ActiveServiceRun): void {
    run.stdout?.on('data', this.handleStdout)
    run.stderr?.on('data', this.handleStderr)
    run.child.on('message', this.handleMessage)
    run.child.once('error', this.handleChildError)
    run.child.once('close', this.handleChildClose)
  }

  private readonly handleStdout = (chunk: Buffer | string): void => {
    const run = this.activeRun
    if (!run) return
    const text = typeof chunk === 'string' ? chunk : run.stdoutDecoder.write(chunk)
    if (text) this.emit({ type: 'log', pid: run.pid, stream: 'stdout', text })
  }

  private readonly handleStderr = (chunk: Buffer | string): void => {
    const run = this.activeRun
    if (!run) return
    const text = typeof chunk === 'string' ? chunk : run.stderrDecoder.write(chunk)
    if (text) this.emit({ type: 'log', pid: run.pid, stream: 'stderr', text })
  }

  private readonly handleMessage = (message: unknown): void => {
    const run = this.activeRun
    if (!run) return
    if (this.rpcHost && isRpcRequestEnvelope(message)) {
      void this.dispatchRpcRequest(run, message)
      return
    }
    const kind = classifyServiceMessage(message)
    if (kind === 'ready') {
      this.readyAt = timestamp()
      this.emit({ type: 'ready', pid: run.pid, message })
      this.notifySnapshot()
      return
    }
    if (kind === 'heartbeat') {
      this.lastHeartbeatAt = timestamp()
      this.emit({ type: 'heartbeat', pid: run.pid, message })
      this.notifySnapshot()
      return
    }
    this.emit({ type: 'message', pid: run.pid, message })
  }

  private readonly handleChildError = (error: Error): void => {
    const run = this.activeRun
    if (!run) return
    this.finishRun(run, null, null, error)
  }

  private readonly handleChildClose = (
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    const run = this.activeRun
    if (!run) return
    this.finishRun(run, exitCode, signal, null)
  }

  private finishRun(
    run: ActiveServiceRun,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    error: Error | null
  ): void {
    if (run.terminal) return
    run.terminal = true
    run.rpcAbortController.abort(new Error('System plugin service process exited.'))
    const expected = this.stopRequested
    this.flushOutput(run)
    this.removeRunListeners(run)
    if (this.activeRun === run) this.activeRun = null
    const exit: SystemPluginServiceExit = Object.freeze({
      pid: run.pid,
      exitCode,
      signal,
      expected,
      timestamp: timestamp()
    })
    this.lastExit = exit
    this.emit({
      type: 'exit',
      pid: run.pid,
      exitCode,
      signal,
      expected,
      error
    })
    run.resolveClosed()

    if (expected) return
    this.handleUnexpectedExit(error, exitCode, signal)
  }

  private handleSpawnFailure(generation: number, cause: unknown): void {
    if (generation !== this.generation || this.stopRequested) return
    const error = cause instanceof Error ? cause : new Error(String(cause))
    const exit: SystemPluginServiceExit = Object.freeze({
      pid: null,
      exitCode: null,
      signal: null,
      expected: false,
      timestamp: timestamp()
    })
    this.lastExit = exit
    this.emit({
      type: 'exit',
      pid: null,
      exitCode: null,
      signal: null,
      expected: false,
      error
    })
    this.handleUnexpectedExit(error, null, null)
  }

  private handleUnexpectedExit(
    cause: Error | null,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (
      this.mode === 'app-lifetime' &&
      this.restartCount < this.restartPolicy.maxRestarts
    ) {
      this.restartCount += 1
      const delayMs = Math.min(
        this.restartPolicy.initialDelayMs * (2 ** Math.min(this.restartCount - 1, 30)),
        this.restartPolicy.maxDelayMs
      )
      this.setStatus('restart-wait')
      this.emit({
        type: 'restart-scheduled',
        restartCount: this.restartCount,
        delayMs
      })
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (!this.stopRequested) this.spawnService()
      }, delayMs)
      return
    }

    const detail = cause
      ? cause.message
      : `exit code ${String(exitCode)}${signal ? `, signal ${signal}` : ''}`
    const recoveryDetail = this.mode === 'app-lifetime'
      ? `restart limit ${this.restartPolicy.maxRestarts} reached`
      : 'detached services are not automatically restarted'
    const fatal = new SystemPluginServiceFatalError(
      `System plugin service "${this.pluginId}" exited unexpectedly (${detail}); ${recoveryDetail}.`,
      this.restartCount,
      cause ? { cause } : undefined
    )
    this.setStatus('failed')
    this.emit({ type: 'fatal', error: fatal, restartCount: this.restartCount })
  }

  private flushOutput(run: ActiveServiceRun): void {
    const stdout = run.stdoutDecoder.end()
    const stderr = run.stderrDecoder.end()
    if (stdout) this.emit({ type: 'log', pid: run.pid, stream: 'stdout', text: stdout })
    if (stderr) this.emit({ type: 'log', pid: run.pid, stream: 'stderr', text: stderr })
  }

  private removeRunListeners(run: ActiveServiceRun): void {
    run.stdout?.removeListener('data', this.handleStdout)
    run.stderr?.removeListener('data', this.handleStderr)
    run.child.removeListener('message', this.handleMessage)
    run.child.removeListener('error', this.handleChildError)
    run.child.removeListener('close', this.handleChildClose)
  }

  private detachRun(run: ActiveServiceRun): void {
    if (!run.terminal) {
      run.terminal = true
      run.rpcAbortController.abort(new Error('System plugin service process detached from its supervisor.'))
      this.flushOutput(run)
      this.removeRunListeners(run)
      if (this.activeRun === run) this.activeRun = null
      run.resolveClosed()
    }
  }

  private cancelRestart(): void {
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private setStatus(status: SystemPluginServiceStatus): void {
    if (this.currentStatus === status) return
    this.currentStatus = status
    this.notifySnapshot()
  }

  private notifySnapshot(): void {
    safeCallback(this.onSnapshot, this.createSnapshot())
  }

  private createSnapshot(): Readonly<SystemPluginServiceSnapshot> {
    return Object.freeze({
      pluginId: this.pluginId,
      version: this.version,
      revisionHash: this.revisionHash,
      mode: this.mode,
      status: this.currentStatus,
      pid: this.activeRun?.pid ?? null,
      ready: this.readyAt !== null,
      restartCount: this.restartCount,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastExit: this.lastExit
    })
  }

  private emit(
    event: SystemPluginServiceEventInput
  ): void {
    safeCallback(this.onEvent, Object.freeze({
      ...event,
      pluginId: this.pluginId,
      version: this.version,
      revisionHash: this.revisionHash,
      mode: this.mode,
      timestamp: timestamp()
    }) as SystemPluginServiceEvent)
  }

  private async dispatchRpcRequest(run: ActiveServiceRun, message: unknown): Promise<void> {
    const response = await this.rpcHost?.dispatch(message, {
      signal: run.rpcAbortController.signal
    })
    if (!response || run.terminal || this.activeRun !== run) return
    await sendChildMessage(run.child, response).catch(() => undefined)
  }
}

function normalizePackage(input: SystemPluginServicePackage): {
  rootDirectory: string
  revisionHash: string
  manifest: {
    id: string
    version: string
    entries: { service: string }
    background: { mode: SystemPluginServiceMode; autoStart: boolean }
  }
} {
  if (!input || typeof input !== 'object') {
    throw new TypeError('System plugin service package must be an object.')
  }
  const rootDirectory = normalizePath(input.rootDirectory, 'System plugin service root')
  const revisionHash = normalizeString(input.revisionHash, 'System plugin service revision hash')
  const manifest = input.manifest
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('System plugin service manifest must be an object.')
  }
  const id = normalizeString(manifest.id, 'System plugin service id')
  const version = normalizeString(manifest.version, 'System plugin service version')
  const service = manifest.entries?.service
  if (typeof service !== 'string' || !service.trim()) {
    throw new Error('System plugin service requires manifest entries.service.')
  }
  const background = manifest.background
  if (!background || (background.mode !== 'app-lifetime' && background.mode !== 'detached')) {
    throw new Error('System plugin service requires a valid manifest background mode.')
  }
  if (typeof background.autoStart !== 'boolean') {
    throw new Error('System plugin service background.autoStart must be a boolean.')
  }
  return {
    rootDirectory,
    revisionHash,
    manifest: {
      id,
      version,
      entries: { service },
      background: { mode: background.mode, autoStart: background.autoStart }
    }
  }
}

function resolveServiceEntry(rootDirectory: string, entry: string): string {
  if (entry.includes('\0') || isAbsolute(entry)) {
    throw new Error('System plugin service entry must be a relative path without null bytes.')
  }
  const entryPath = resolve(rootDirectory, entry)
  const relativePath = relative(rootDirectory, entryPath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new Error('System plugin service entry escapes or resolves to the plugin root.')
  }
  return entryPath
}

function normalizeRestartPolicy(
  input: Partial<SystemPluginServiceRestartPolicy> | undefined
): SystemPluginServiceRestartPolicy {
  const maxRestarts = normalizeNonNegativeInteger(
    input?.maxRestarts,
    DEFAULT_MAX_RESTARTS,
    'System plugin service maximum restart count'
  )
  const initialDelayMs = normalizeDuration(
    input?.initialDelayMs,
    DEFAULT_RESTART_INITIAL_DELAY_MS,
    'System plugin service initial restart delay'
  )
  const maxDelayMs = normalizeDuration(
    input?.maxDelayMs,
    DEFAULT_RESTART_MAX_DELAY_MS,
    'System plugin service maximum restart delay'
  )
  if (maxDelayMs < initialDelayMs) {
    throw new Error('System plugin service maximum restart delay must not be shorter than its initial delay.')
  }
  return Object.freeze({ maxRestarts, initialDelayMs, maxDelayMs })
}

function normalizeArguments(input: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(input) || input.length > 128) {
    throw new Error(`${label} must be an array with at most 128 entries.`)
  }
  return input.map((argument, index) => {
    if (typeof argument !== 'string' || argument.includes('\0') || argument.length > 32_768) {
      throw new Error(`${label} entry ${index} is invalid.`)
    }
    return argument
  })
}

function normalizeExecutable(input: string): string {
  return normalizeString(input, 'System plugin service executable')
}

function normalizePath(input: string, label: string): string {
  return resolve(normalizeString(input, label))
}

function normalizeString(input: string, label: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
    throw new Error(`${label} must be a non-empty string without null bytes.`)
  }
  return input
}

function normalizeDuration(
  input: number | undefined,
  fallback: number,
  label: string
): number {
  const value = input ?? fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

function normalizeNonNegativeInteger(
  input: number | undefined,
  fallback: number,
  label: string
): number {
  const value = input ?? fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
  return value
}

function normalizePid(pid: number | undefined): number | null {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function classifyServiceMessage(message: unknown): 'ready' | 'heartbeat' | 'message' {
  const type = typeof message === 'string'
    ? message
    : message && typeof message === 'object' && 'type' in message
      ? (message as { type?: unknown }).type
      : undefined
  if (type === 'ready' || type === SYSTEM_PLUGIN_SERVICE_READY_MESSAGE) return 'ready'
  if (type === 'heartbeat' || type === SYSTEM_PLUGIN_SERVICE_HEARTBEAT_MESSAGE) return 'heartbeat'
  return 'message'
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess {
  return spawnProcess(executable, [...args], options)
}

function tryKill(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal)
  } catch {
    return false
  }
}

function sendChildMessage(
  child: ChildProcess,
  message: SystemPluginServiceRpcResponse
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    if (!child.connected || typeof child.send !== 'function') {
      reject(new Error('System plugin service IPC channel is unavailable.'))
      return
    }
    try {
      child.send(message, (error) => {
        if (error) reject(error)
        else resolvePromise()
      })
    } catch (error) {
      reject(error)
    }
  })
}

function waitFor(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      resolvePromise(false)
    }, timeoutMs)
    void operation.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise(true)
    })
  })
}

function timestamp(): string {
  return new Date().toISOString()
}

function safeCallback<T>(callback: ((event: T) => void) | undefined, event: T): void {
  if (!callback) return
  try {
    callback(event)
  } catch {
    // Persistence and telemetry callbacks must not change service lifecycle.
  }
}
