import {
  spawn as spawnProcess,
  type ChildProcess,
  type SpawnOptions
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type {
  SystemPluginDependencyPlan,
  SystemPluginPackageManager
} from '@shared/system-plugin'
import type {
  SystemPluginDependencyJobKind,
  SystemPluginDependencyJobStatus
} from '@shared/system-plugin-state'

const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_NATIVE_MODULE_PROBE_TIMEOUT_MS = 30_000
const DEFAULT_NATIVE_MODULE_PROBE_TOTAL_TIMEOUT_MS = 5 * 60 * 1_000
const DEFAULT_TERMINATION_GRACE_MS = 2_000
const DEFAULT_FORCE_KILL_SIGNAL: NodeJS.Signals = 'SIGKILL'
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000
const MAX_NATIVE_MODULE_SCAN_ENTRIES = 100_000
const MAX_NATIVE_MODULE_SCAN_DEPTH = 128
const MAX_NATIVE_MODULES = 2_048
const MAX_NATIVE_MODULE_PROBE_OUTPUT_BYTES = 1024 * 1024
const NATIVE_MODULE_PROBE_SUCCESS_PREFIX = 'KNOWBOOK_NATIVE_MODULE_PROBE_OK:'
const WINDOWS_PACKAGE_MANAGER_SHIM = /^(?:npm|pnpm|yarn)(?:\.cmd)?$/i
const WINDOWS_SAFE_PACKAGE_MANAGER_ARGUMENT = /^[A-Za-z0-9@._/:=+,\\~-]+$/
const NATIVE_MODULE_PROBE_SOURCE = [
  "'use strict';",
  "const fs = require('node:fs');",
  'const modulePath = process.argv[1];',
  'const nonce = process.argv[2];',
  "if (!modulePath || !nonce) { fs.writeSync(2, 'Native module probe arguments are missing.\\n'); process.exit(2); }",
  'try {',
  '  require(modulePath);',
  `  fs.writeSync(1, ${JSON.stringify(NATIVE_MODULE_PROBE_SUCCESS_PREFIX)} + nonce + '\\n');`,
  '  process.exit(0);',
  '} catch (error) {',
  "  const detail = error && typeof error === 'object' && 'stack' in error ? error.stack : String(error);",
  "  fs.writeSync(2, String(detail).slice(0, 16384) + '\\n');",
  '  process.exit(1);',
  '}'
].join('\n')

export interface SystemPluginDependencyProcessTask {
  execution: 'process'
  kind: SystemPluginDependencyJobKind
  packageManager: SystemPluginPackageManager | 'none'
  /** Exact executable followed by its argument vector. */
  command: readonly string[]
}

export interface SystemPluginDependencyNativeRunnerContext {
  cwd: string
  signal: AbortSignal
  writeLog(stream: SystemPluginDependencyLogStream, text: string): void
}

export interface SystemPluginDependencyNativeRunnerTask {
  execution: 'native-runner'
  kind: 'native-rebuild'
  packageManager: SystemPluginPackageManager
  /** Explicit audit/display command supplied together with the runner. */
  command: readonly string[]
  run(context: SystemPluginDependencyNativeRunnerContext): void | Promise<void>
}

export type SystemPluginDependencyTask =
  | SystemPluginDependencyProcessTask
  | SystemPluginDependencyNativeRunnerTask

export type SystemPluginNativeRebuildStrategy =
  | {
    type: 'command'
    command: readonly string[]
  }
  | {
    type: 'runner'
    command: readonly string[]
    run(context: SystemPluginDependencyNativeRunnerContext): void | Promise<void>
  }

export interface CreateSystemPluginDependencyTasksOptions {
  /**
   * Required when the manifest requests native rebuild. The host must choose
   * the concrete Electron-ABI-aware command or runner after user confirmation.
   */
  nativeRebuild?: SystemPluginNativeRebuildStrategy
}

export type SystemPluginDependencyLogStream = 'stdout' | 'stderr'

export interface SystemPluginDependencyLogEvent {
  taskIndex: number
  task: SystemPluginDependencyTask
  stream: SystemPluginDependencyLogStream
  text: string
  timestamp: string
}

export interface SystemPluginDependencyStatusEvent {
  taskIndex: number
  task: SystemPluginDependencyTask
  previousStatus: SystemPluginDependencyJobStatus
  status: SystemPluginDependencyJobStatus
  error: Error | null
  timestamp: string
}

export type SystemPluginDependencyProcessPhase =
  | 'started'
  | 'exited'
  | 'termination-requested'
  | 'force-termination-requested'
  | 'spawn-error'

export interface SystemPluginDependencyProcessEvent {
  taskIndex: number
  task: SystemPluginDependencyProcessTask
  phase: SystemPluginDependencyProcessPhase
  pid: number | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  timestamp: string
}

export type SystemPluginDependencySpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export interface SystemPluginDependencyTerminationRequest {
  child: ChildProcess
  pid: number | null
  signal: NodeJS.Signals
  force: boolean
  /** True only when the host created a dedicated process group for the child. */
  processTree: boolean
}

/** Injectable so process-tree termination can be tested without signaling host processes. */
export type SystemPluginDependencyTerminate = (
  request: SystemPluginDependencyTerminationRequest
) => void | Promise<void>

export interface ExecuteSystemPluginDependencyTasksOptions {
  /** Exact staging or published artifact root used as cwd for every task. */
  rootDirectory: string
  tasks: readonly SystemPluginDependencyTask[]
  signal?: AbortSignal
  /** Per-task timeout. */
  timeoutMs?: number
  /** Time between graceful and forced termination. */
  terminationGraceMs?: number
  killSignal?: NodeJS.Signals
  forceKillSignal?: NodeJS.Signals
  spawn?: SystemPluginDependencySpawn
  terminate?: SystemPluginDependencyTerminate
  onLog?(event: SystemPluginDependencyLogEvent): void
  onStatus?(event: SystemPluginDependencyStatusEvent): void
  onProcess?(event: SystemPluginDependencyProcessEvent): void
}

export interface SystemPluginDependencyTaskResult {
  taskIndex: number
  task: SystemPluginDependencyTask
  exitCode: number | null
}

export interface SystemPluginDependencyExecutionResult {
  cwd: string
  tasks: readonly SystemPluginDependencyTaskResult[]
}

export interface SystemPluginNativeModuleProbeLogEvent {
  modulePath: string
  stream: SystemPluginDependencyLogStream
  text: string
  timestamp: string
}

export interface ProbeSystemPluginNativeModulesOptions {
  /** Runtime copy containing the node_modules tree to inspect. */
  rootDirectory: string
  /** Electron executable. It is launched with ELECTRON_RUN_AS_NODE=1. */
  executable: string
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Per-native-module timeout. */
  timeoutMs?: number
  /** Total budget for discovery plus all native-module probes. */
  totalTimeoutMs?: number
  /** Time between graceful and forced termination. */
  terminationGraceMs?: number
  killSignal?: NodeJS.Signals
  forceKillSignal?: NodeJS.Signals
  spawn?: SystemPluginDependencySpawn
  terminate?: SystemPluginDependencyTerminate
  onLog?(event: SystemPluginNativeModuleProbeLogEvent): void
}

export interface SystemPluginNativeModuleProbeResult {
  rootDirectory: string
  strategy: 'electron-node-require'
  nativeModules: readonly string[]
}

export class SystemPluginNativeModuleProbeError extends Error {
  constructor(
    message: string,
    readonly modulePath: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SystemPluginNativeModuleProbeError'
  }
}

export class SystemPluginDependencyExecutionError extends Error {
  constructor(
    message: string,
    readonly task: SystemPluginDependencyTask,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SystemPluginDependencyExecutionError'
  }
}

export class SystemPluginDependencyTimeoutError extends SystemPluginDependencyExecutionError {
  constructor(
    task: SystemPluginDependencyTask,
    readonly timeoutMs: number
  ) {
    super(
      `System plugin dependency task "${formatCommand(task.command)}" timed out after ${timeoutMs}ms (exit code unavailable).`,
      task,
      null,
      null
    )
    this.name = 'SystemPluginDependencyTimeoutError'
  }
}

export class SystemPluginDependencyCancelledError extends SystemPluginDependencyExecutionError {
  constructor(task: SystemPluginDependencyTask, options?: ErrorOptions) {
    super(
      `System plugin dependency task "${formatCommand(task.command)}" was cancelled (exit code unavailable).`,
      task,
      null,
      null,
      options
    )
    this.name = 'SystemPluginDependencyCancelledError'
  }
}

/**
 * Produce the complete, reviewable command list without starting any process.
 */
export function createSystemPluginDependencyTasks(
  plan: SystemPluginDependencyPlan,
  options: CreateSystemPluginDependencyTasksOptions = {}
): readonly SystemPluginDependencyTask[] {
  validateDependencyPlan(plan)
  if (!plan.rebuildNativeModules && options.nativeRebuild) {
    throw new Error('A native rebuild strategy cannot be supplied when rebuildNativeModules is false.')
  }
  if (plan.rebuildNativeModules && !options.nativeRebuild) {
    throw new Error('System plugin native rebuild requires an explicit host-provided command or runner.')
  }

  const tasks: SystemPluginDependencyTask[] = [freezeProcessTask({
    execution: 'process',
    kind: 'install',
    packageManager: plan.packageManager,
    command: createInstallCommand(plan)
  })]

  if (plan.buildCommand) {
    tasks.push(freezeProcessTask({
      execution: 'process',
      kind: 'build',
      packageManager: plan.packageManager,
      command: normalizeCommand(plan.buildCommand, 'System plugin build command')
    }))
  }

  if (options.nativeRebuild) {
    const command = normalizeCommand(
      options.nativeRebuild.command,
      'System plugin native rebuild command'
    )
    tasks.push(options.nativeRebuild.type === 'command'
      ? freezeProcessTask({
        execution: 'process',
        kind: 'native-rebuild',
        packageManager: plan.packageManager,
        command
      })
      : Object.freeze({
        execution: 'native-runner' as const,
        kind: 'native-rebuild' as const,
        packageManager: plan.packageManager,
        command,
        run: options.nativeRebuild.run
      }))
  }

  return Object.freeze(tasks)
}

/**
 * Execute an already reviewed task list sequentially. Process tasks always use
 * an argument vector with shell disabled.
 */
export async function executeSystemPluginDependencyTasks(
  options: ExecuteSystemPluginDependencyTasksOptions
): Promise<SystemPluginDependencyExecutionResult> {
  const cwd = normalizeRootDirectory(options.rootDirectory)
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const terminationGraceMs = normalizeTerminationGrace(options.terminationGraceMs)
  const killSignal = options.killSignal ?? 'SIGTERM'
  const forceKillSignal = options.forceKillSignal ?? DEFAULT_FORCE_KILL_SIGNAL
  const spawn = options.spawn ?? defaultSpawn
  const processTree = options.spawn === undefined && options.terminate === undefined
  const terminate = options.terminate
    ?? (processTree ? terminateDefaultProcessTree : terminateChildOnly)
  const results: SystemPluginDependencyTaskResult[] = []

  for (let taskIndex = 0; taskIndex < options.tasks.length; taskIndex += 1) {
    const task = options.tasks[taskIndex]
    validateTask(task)
    if (options.signal?.aborted) {
      const error = cancellationError(task, options.signal.reason)
      emitStatus(options, taskIndex, task, 'pending', 'cancelled', error)
      throw error
    }

    emitStatus(options, taskIndex, task, 'pending', 'running', null)
    try {
      const exitCode = task.execution === 'process'
        ? await executeProcessTask({
          cwd,
          task,
          taskIndex,
          timeoutMs,
          terminationGraceMs,
          killSignal,
          forceKillSignal,
          spawn,
          terminate,
          processTree,
          signal: options.signal,
          onLog: options.onLog,
          onProcess: options.onProcess
        })
        : await executeNativeRunnerTask({
          cwd,
          task,
          taskIndex,
          timeoutMs,
          signal: options.signal,
          onLog: options.onLog
        })
      emitStatus(options, taskIndex, task, 'running', 'succeeded', null)
      results.push(Object.freeze({ taskIndex, task, exitCode }))
    } catch (rawError) {
      const error = normalizeExecutionError(rawError, task)
      const status = error instanceof SystemPluginDependencyCancelledError
        ? 'cancelled'
        : 'failed'
      emitStatus(options, taskIndex, task, 'running', status, error)
      throw error
    }
  }

  return Object.freeze({ cwd, tasks: Object.freeze(results) })
}

/**
 * Finds native addons in the prepared runtime and loads each one in a fresh
 * Electron process running in Node mode. Requiring addons in the main process
 * would let an ABI mismatch crash KnowBook before the package can be rejected.
 */
export async function probeSystemPluginNativeModules(
  options: ProbeSystemPluginNativeModulesOptions
): Promise<SystemPluginNativeModuleProbeResult> {
  const rootDirectory = normalizeRootDirectory(options.rootDirectory)
  const executable = normalizeExecutable(options.executable)
  const timeoutMs = normalizeProbeTimeout(options.timeoutMs)
  const totalTimeoutMs = normalizeProbeTotalTimeout(options.totalTimeoutMs)
  const deadline = Date.now() + totalTimeoutMs
  const terminationGraceMs = normalizeTerminationGrace(options.terminationGraceMs)
  const killSignal = options.killSignal ?? 'SIGTERM'
  const forceKillSignal = options.forceKillSignal ?? DEFAULT_FORCE_KILL_SIGNAL
  const spawn = options.spawn ?? defaultSpawn
  const processTree = options.spawn === undefined && options.terminate === undefined
  const terminate = options.terminate
    ?? (processTree ? terminateDefaultProcessTree : terminateChildOnly)
  assertNativeProbeCanContinue(options.signal, deadline, '<scan>', totalTimeoutMs)
  const nativeModules = await discoverNativeModules(
    rootDirectory,
    options.signal,
    deadline,
    totalTimeoutMs
  )

  for (const nativeModule of nativeModules) {
    assertNativeProbeCanContinue(
      options.signal,
      deadline,
      nativeModule.relativePath,
      totalTimeoutMs
    )
    const remainingMs = Math.max(1, deadline - Date.now())
    await executeNativeModuleProbe({
      rootDirectory,
      executable,
      nativeModule,
      environment: createProbeEnvironment(options.environment),
      signal: options.signal,
      timeoutMs: Math.min(timeoutMs, remainingMs),
      terminationGraceMs,
      killSignal,
      forceKillSignal,
      spawn,
      terminate,
      processTree,
      onLog: options.onLog
    })
  }

  return Object.freeze({
    rootDirectory,
    strategy: 'electron-node-require' as const,
    nativeModules: Object.freeze(nativeModules.map((entry) => entry.relativePath))
  })
}

function createInstallCommand(plan: SystemPluginDependencyPlan): readonly string[] {
  const command = plan.packageManager === 'npm'
    ? ['npm', plan.install]
    : plan.packageManager === 'pnpm'
      ? ['pnpm', 'install', ...(plan.install === 'ci' ? ['--frozen-lockfile'] : [])]
      : ['yarn', 'install', ...(plan.install === 'ci' ? ['--frozen-lockfile'] : [])]
  if (!plan.allowScripts) command.push('--ignore-scripts')
  return Object.freeze(command)
}

type DiscoveredNativeModule = {
  absolutePath: string
  relativePath: string
}

type PendingNativeModuleDirectory = {
  physicalPath: string
  displayPath: string
  depth: number
}

async function discoverNativeModules(
  rootDirectory: string,
  signal: AbortSignal | undefined,
  deadline: number,
  totalTimeoutMs: number
): Promise<readonly DiscoveredNativeModule[]> {
  assertNativeProbeCanContinue(signal, deadline, '<scan>', totalTimeoutMs)
  const realRoot = await realpath(rootDirectory)
  const pending: PendingNativeModuleDirectory[] = [{
    physicalPath: realRoot,
    displayPath: rootDirectory,
    depth: 0
  }]
  const visitedDirectories = new Set<string>()
  const modulesByRealPath = new Map<string, DiscoveredNativeModule>()
  let scannedEntries = 0

  while (pending.length > 0) {
    assertNativeProbeCanContinue(signal, deadline, '<scan>', totalTimeoutMs)
    const current = pending.pop()!
    if (current.depth > MAX_NATIVE_MODULE_SCAN_DEPTH) {
      throw new Error(
        `System plugin native module scan exceeds ${MAX_NATIVE_MODULE_SCAN_DEPTH} directory levels.`
      )
    }
    const realDirectory = await realpath(current.physicalPath)
    assertProbePathInsideRoot(realDirectory, realRoot)
    const directoryStat = await stat(realDirectory)
    if (!directoryStat.isDirectory()) {
      throw new Error('System plugin native module scan encountered a non-directory path.')
    }
    if (visitedDirectories.has(realDirectory)) continue
    visitedDirectories.add(realDirectory)

    const entries = await readdir(realDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    scannedEntries += entries.length
    if (scannedEntries > MAX_NATIVE_MODULE_SCAN_ENTRIES) {
      throw new Error(
        `System plugin native module scan exceeds ${MAX_NATIVE_MODULE_SCAN_ENTRIES} entries.`
      )
    }

    // Push in reverse so traversal remains lexical even though pending is a stack.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      assertNativeProbeCanContinue(signal, deadline, '<scan>', totalTimeoutMs)
      const entry = entries[index]
      const physicalPath = join(realDirectory, entry.name)
      const displayPath = join(current.displayPath, entry.name)
      const entryStat = await lstat(physicalPath)
      const resolvedPath = entryStat.isSymbolicLink()
        ? await realpath(physicalPath)
        : physicalPath
      if (entryStat.isSymbolicLink()) assertProbePathInsideRoot(resolvedPath, realRoot)
      const resolvedStat = entryStat.isSymbolicLink()
        ? await stat(resolvedPath)
        : entryStat

      if (resolvedStat.isDirectory()) {
        pending.push({
          physicalPath: resolvedPath,
          displayPath,
          depth: current.depth + 1
        })
        continue
      }
      if (!resolvedStat.isFile() || !entry.name.endsWith('.node')) continue

      const realFile = await realpath(resolvedPath)
      assertProbePathInsideRoot(realFile, realRoot)
      if (!modulesByRealPath.has(realFile)) {
        const relativePath = toPortableRuntimePath(rootDirectory, displayPath)
        modulesByRealPath.set(realFile, { absolutePath: realFile, relativePath })
        if (modulesByRealPath.size > MAX_NATIVE_MODULES) {
          throw new Error(`System plugin runtime contains more than ${MAX_NATIVE_MODULES} native modules.`)
        }
      }
    }
  }

  return Object.freeze([...modulesByRealPath.values()]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))
    .map((entry) => Object.freeze(entry)))
}

type NativeModuleProbeExecutionInput = {
  rootDirectory: string
  executable: string
  nativeModule: DiscoveredNativeModule
  environment: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs: number
  terminationGraceMs: number
  killSignal: NodeJS.Signals
  forceKillSignal: NodeJS.Signals
  spawn: SystemPluginDependencySpawn
  terminate: SystemPluginDependencyTerminate
  processTree: boolean
  onLog?: ProbeSystemPluginNativeModulesOptions['onLog']
}

function executeNativeModuleProbe(input: NativeModuleProbeExecutionInput): Promise<void> {
  if (input.signal?.aborted) {
    return Promise.reject(new SystemPluginNativeModuleProbeError(
      `System plugin native module probe was cancelled before loading "${input.nativeModule.relativePath}".`,
      input.nativeModule.relativePath,
      null,
      null,
      input.signal.reason === undefined ? undefined : { cause: input.signal.reason }
    ))
  }

  const nonce = randomUUID()
  const successMarker = `${NATIVE_MODULE_PROBE_SUCCESS_PREFIX}${nonce}\n`
  const args = ['--eval', NATIVE_MODULE_PROBE_SOURCE, '--', input.nativeModule.absolutePath, nonce]
  let child: ChildProcess
  try {
    child = input.spawn(input.executable, args, {
      cwd: input.rootDirectory,
      env: input.environment,
      shell: false,
      windowsHide: true,
      detached: input.processTree,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return Promise.reject(new SystemPluginNativeModuleProbeError(
      `Failed to start the system plugin native module probe for "${input.nativeModule.relativePath}".`,
      input.nativeModule.relativePath,
      null,
      null,
      { cause: error }
    ))
  }

  const stdoutStream = child.stdout
  const stderrStream = child.stderr
  if (!stdoutStream || !stderrStream) {
    const error = new SystemPluginNativeModuleProbeError(
      `System plugin native module probe for "${input.nativeModule.relativePath}" did not expose stdout/stderr pipes.`,
      input.nativeModule.relativePath,
      null,
      null
    )
    return rejectAfterTerminatingChild(child, input, error)
  }

  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    let pendingFailure: SystemPluginNativeModuleProbeError | null = null
    let successWindow = ''
    let outputBytes = 0
    let outputFlushed = false
    let timeout: NodeJS.Timeout | undefined
    let forceTimeout: NodeJS.Timeout | undefined

    const emitDecoded = (
      stream: SystemPluginDependencyLogStream,
      decoder: StringDecoder,
      chunk: Buffer | string
    ) => {
      if (settled || pendingFailure) return
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (!text) return
      outputBytes += Buffer.byteLength(text, 'utf8')
      if (outputBytes > MAX_NATIVE_MODULE_PROBE_OUTPUT_BYTES) {
        beginFailure(new SystemPluginNativeModuleProbeError(
          `System plugin native module probe for "${input.nativeModule.relativePath}" exceeded `
            + `${MAX_NATIVE_MODULE_PROBE_OUTPUT_BYTES} output bytes.`,
          input.nativeModule.relativePath,
          null,
          null
        ))
        return
      }
      if (stream === 'stdout') {
        successWindow = `${successWindow}${text}`.slice(-successMarker.length * 2)
      }
      emitProbeLog(input, stream, text)
    }
    const onStdout = (chunk: Buffer | string) => emitDecoded('stdout', stdoutDecoder, chunk)
    const onStderr = (chunk: Buffer | string) => emitDecoded('stderr', stderrDecoder, chunk)
    const flushOutput = () => {
      if (outputFlushed) return
      outputFlushed = true
      const stdout = stdoutDecoder.end()
      const stderr = stderrDecoder.end()
      if (stdout) {
        successWindow = `${successWindow}${stdout}`.slice(-successMarker.length * 2)
        emitProbeLog(input, 'stdout', stdout)
      }
      if (stderr) emitProbeLog(input, 'stderr', stderr)
    }
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      if (forceTimeout) clearTimeout(forceTimeout)
      input.signal?.removeEventListener('abort', onAbort)
      stdoutStream.removeListener('data', onStdout)
      stderrStream.removeListener('data', onStderr)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
    }
    const requestTermination = (force: boolean) => {
      const signal = force ? input.forceKillSignal : input.killSignal
      void invokeTermination(input.terminate, {
        child,
        pid: normalizePid(child.pid),
        signal,
        force,
        processTree: input.processTree
      })
    }
    const beginFailure = (error: SystemPluginNativeModuleProbeError) => {
      if (settled || pendingFailure) return
      pendingFailure = error
      if (timeout) clearTimeout(timeout)
      requestTermination(false)
      forceTimeout = setTimeout(() => {
        if (!settled) requestTermination(true)
      }, input.terminationGraceMs)
    }
    const onAbort = () => beginFailure(new SystemPluginNativeModuleProbeError(
      `System plugin native module probe for "${input.nativeModule.relativePath}" was cancelled.`,
      input.nativeModule.relativePath,
      null,
      null,
      input.signal?.reason === undefined ? undefined : { cause: input.signal.reason }
    ))
    const onError = (error: Error) => {
      if (settled || pendingFailure) return
      pendingFailure = new SystemPluginNativeModuleProbeError(
        `System plugin native module probe for "${input.nativeModule.relativePath}" failed to start.`,
        input.nativeModule.relativePath,
        null,
        null,
        { cause: error }
      )
      if (timeout) clearTimeout(timeout)
    }
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      flushOutput()
      cleanup()
      if (pendingFailure) {
        rejectPromise(pendingFailure)
        return
      }
      if (
        exitCode !== 0
        || signal !== null
        || !successWindow.includes(successMarker)
      ) {
        rejectPromise(new SystemPluginNativeModuleProbeError(
          `System plugin native module probe for "${input.nativeModule.relativePath}" failed `
            + `(exit code ${String(exitCode)}${signal ? `, signal ${signal}` : ''}; `
            + `${successWindow.includes(successMarker) ? 'completion confirmed' : 'completion not confirmed'}).`,
          input.nativeModule.relativePath,
          exitCode,
          signal
        ))
        return
      }
      resolvePromise()
    }
    timeout = setTimeout(() => beginFailure(new SystemPluginNativeModuleProbeError(
      `System plugin native module probe for "${input.nativeModule.relativePath}" timed out after ${input.timeoutMs}ms.`,
      input.nativeModule.relativePath,
      null,
      null
    )), input.timeoutMs)

    stdoutStream.on('data', onStdout)
    stderrStream.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
  })
}

type ProcessExecutionInput = {
  cwd: string
  task: SystemPluginDependencyProcessTask
  taskIndex: number
  timeoutMs: number
  terminationGraceMs: number
  killSignal: NodeJS.Signals
  forceKillSignal: NodeJS.Signals
  spawn: SystemPluginDependencySpawn
  terminate: SystemPluginDependencyTerminate
  processTree: boolean
  signal?: AbortSignal
  onLog?: ExecuteSystemPluginDependencyTasksOptions['onLog']
  onProcess?: ExecuteSystemPluginDependencyTasksOptions['onProcess']
}

function executeProcessTask(input: ProcessExecutionInput): Promise<number> {
  if (input.signal?.aborted) {
    return Promise.reject(cancellationError(input.task, input.signal.reason))
  }

  const [executable, ...args] = input.task.command
  let child: ChildProcess
  try {
    child = input.spawn(executable, args, {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      detached: input.processTree,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return Promise.reject(new SystemPluginDependencyExecutionError(
      `Failed to spawn system plugin dependency command "${formatCommand(input.task.command)}" (exit code unavailable).`,
      input.task,
      null,
      null,
      { cause: error }
    ))
  }

  const stdoutStream = child.stdout
  const stderrStream = child.stderr
  if (!stdoutStream || !stderrStream) {
    const error = new SystemPluginDependencyExecutionError(
      `System plugin dependency command "${formatCommand(input.task.command)}" did not expose stdout/stderr pipes (exit code unavailable).`,
      input.task,
      null,
      null
    )
    return rejectAfterTerminatingChild(child, input, error)
  }

  const pid = normalizePid(child.pid)
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')

  return new Promise<number>((resolvePromise, rejectPromise) => {
    let settled = false
    let pendingFailure: Error | null = null
    let timeout: NodeJS.Timeout | undefined
    let forceTimeout: NodeJS.Timeout | undefined

    const emitDecoded = (
      stream: SystemPluginDependencyLogStream,
      decoder: StringDecoder,
      chunk: Buffer | string
    ) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (text) emitLog(input, stream, text)
    }
    const onStdout = (chunk: Buffer | string) => emitDecoded('stdout', stdoutDecoder, chunk)
    const onStderr = (chunk: Buffer | string) => emitDecoded('stderr', stderrDecoder, chunk)
    const flushOutput = () => {
      const stdout = stdoutDecoder.end()
      const stderr = stderrDecoder.end()
      if (stdout) emitLog(input, 'stdout', stdout)
      if (stderr) emitLog(input, 'stderr', stderr)
    }
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      if (forceTimeout) clearTimeout(forceTimeout)
      input.signal?.removeEventListener('abort', onAbort)
      stdoutStream.removeListener('data', onStdout)
      stderrStream.removeListener('data', onStderr)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
    }
    const requestTermination = (force: boolean) => {
      const signal = force ? input.forceKillSignal : input.killSignal
      emitProcess(
        input,
        force ? 'force-termination-requested' : 'termination-requested',
        pid,
        null,
        signal
      )
      void invokeTermination(input.terminate, {
        child,
        pid,
        signal,
        force,
        processTree: input.processTree
      })
    }
    const beginFailure = (error: Error) => {
      if (settled || pendingFailure) return
      pendingFailure = error
      if (timeout) clearTimeout(timeout)
      requestTermination(false)
      forceTimeout = setTimeout(() => {
        if (!settled) requestTermination(true)
      }, input.terminationGraceMs)
    }
    const onAbort = () => {
      beginFailure(cancellationError(input.task, input.signal?.reason))
    }
    const onError = (error: Error) => {
      if (settled || pendingFailure) return
      emitProcess(input, 'spawn-error', pid, null, null)
      pendingFailure = new SystemPluginDependencyExecutionError(
        `System plugin dependency command "${formatCommand(input.task.command)}" failed to start (exit code unavailable).`,
        input.task,
        null,
        null,
        { cause: error }
      )
      if (timeout) clearTimeout(timeout)
    }
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      flushOutput()
      cleanup()
      emitProcess(input, 'exited', pid, exitCode, signal)
      if (pendingFailure) {
        rejectPromise(pendingFailure)
        return
      }
      if (exitCode === 0) {
        resolvePromise(0)
        return
      }
      rejectPromise(new SystemPluginDependencyExecutionError(
        `System plugin dependency command "${formatCommand(input.task.command)}" exited with code ${String(exitCode)}${signal ? ` (signal ${signal})` : ''}.`,
        input.task,
        exitCode,
        signal
      ))
    }

    stdoutStream.on('data', onStdout)
    stderrStream.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      beginFailure(new SystemPluginDependencyTimeoutError(input.task, input.timeoutMs))
    }, input.timeoutMs)
    emitProcess(input, 'started', pid, null, null)
    if (input.signal?.aborted) onAbort()
  })
}

type NativeRunnerExecutionInput = {
  cwd: string
  task: SystemPluginDependencyNativeRunnerTask
  taskIndex: number
  timeoutMs: number
  signal?: AbortSignal
  onLog?: ExecuteSystemPluginDependencyTasksOptions['onLog']
}

async function executeNativeRunnerTask(input: NativeRunnerExecutionInput): Promise<null> {
  if (input.signal?.aborted) {
    throw cancellationError(input.task, input.signal.reason)
  }

  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = () => controller.abort(cancellationError(input.task, input.signal?.reason))
  input.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new SystemPluginDependencyTimeoutError(input.task, input.timeoutMs))
  }, input.timeoutMs)

  const operation = Promise.resolve().then(() => input.task.run({
    cwd: input.cwd,
    signal: controller.signal,
    writeLog: (stream, text) => {
      if (stream !== 'stdout' && stream !== 'stderr') {
        throw new TypeError('System plugin native rebuild log stream must be stdout or stderr.')
      }
      if (typeof text !== 'string') {
        throw new TypeError('System plugin native rebuild log text must be a string.')
      }
      if (text) emitLog(input, stream, text)
    }
  }))
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      const reason = controller.signal.reason
      reject(reason instanceof Error
        ? reason
        : timedOut
          ? new SystemPluginDependencyTimeoutError(input.task, input.timeoutMs)
          : cancellationError(input.task, reason))
    }, { once: true })
  })
  if (input.signal?.aborted) onExternalAbort()

  try {
    await Promise.race([operation, aborted])
    return null
  } catch (error) {
    if (!controller.signal.aborted) throw error

    // A runner owns arbitrary mutable staging state. Do not report timeout or
    // cancellation until it has observed abort and finished its cleanup, or it
    // could keep modifying the runtime after the caller rolls it back.
    await operation.catch(() => undefined)
    const reason = controller.signal.reason
    throw reason instanceof Error
      ? reason
      : timedOut
        ? new SystemPluginDependencyTimeoutError(input.task, input.timeoutMs)
        : cancellationError(input.task, reason)
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', onExternalAbort)
  }
}

function validateDependencyPlan(plan: SystemPluginDependencyPlan): void {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('System plugin dependency plan must be an object.')
  }
  if (plan.packageManager !== 'npm' && plan.packageManager !== 'pnpm' && plan.packageManager !== 'yarn') {
    throw new Error('System plugin dependency packageManager must be npm, pnpm, or yarn.')
  }
  if (plan.install !== 'ci' && plan.install !== 'install') {
    throw new Error('System plugin dependency install mode must be ci or install.')
  }
  if (typeof plan.allowScripts !== 'boolean' || typeof plan.rebuildNativeModules !== 'boolean') {
    throw new Error('System plugin dependency script and native rebuild flags must be booleans.')
  }
  if (plan.buildCommand !== undefined) {
    normalizeCommand(plan.buildCommand, 'System plugin build command')
  }
}

function validateTask(task: SystemPluginDependencyTask): void {
  if (!task || typeof task !== 'object') {
    throw new TypeError('System plugin dependency task must be an object.')
  }
  normalizeCommand(task.command, 'System plugin dependency task command')
  if (task.execution !== 'process' && task.execution !== 'native-runner') {
    throw new Error('System plugin dependency task execution type is invalid.')
  }
  if (task.execution === 'native-runner' && typeof task.run !== 'function') {
    throw new Error('System plugin native rebuild runner must be a function.')
  }
}

function normalizeCommand(command: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(command) || command.length < 1 || command.length > 64) {
    throw new Error(`${label} must contain between 1 and 64 arguments.`)
  }
  const normalized = command.map((value, index) => {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      throw new Error(`${label} argument ${index} is invalid.`)
    }
    if (value.length > 32_768) {
      throw new Error(`${label} argument ${index} is too long.`)
    }
    return value
  })
  return Object.freeze(normalized)
}

function freezeProcessTask(
  task: Omit<SystemPluginDependencyProcessTask, 'command'> & { command: readonly string[] }
): SystemPluginDependencyProcessTask {
  return Object.freeze({ ...task, command: Object.freeze([...task.command]) })
}

function normalizeRootDirectory(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('System plugin dependency root directory must be a non-empty path.')
  }
  return resolve(value)
}

function normalizeTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TASK_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('System plugin dependency task timeout must be a positive integer.')
  }
  return timeoutMs
}

function normalizeProbeTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_NATIVE_MODULE_PROBE_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('System plugin native module probe timeout must be a positive integer.')
  }
  return timeoutMs
}

function normalizeProbeTotalTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_NATIVE_MODULE_PROBE_TOTAL_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('System plugin native module probe total timeout must be a positive integer.')
  }
  return timeoutMs
}

function assertNativeProbeCanContinue(
  signal: AbortSignal | undefined,
  deadline: number,
  modulePath: string,
  totalTimeoutMs: number
): void {
  if (signal?.aborted) {
    throw new SystemPluginNativeModuleProbeError(
      modulePath === '<scan>'
        ? 'System plugin native module probe was cancelled during runtime discovery.'
        : `System plugin native module probe was cancelled before loading "${modulePath}".`,
      modulePath,
      null,
      null,
      signal.reason === undefined ? undefined : { cause: signal.reason }
    )
  }
  if (Date.now() >= deadline) {
    throw new SystemPluginNativeModuleProbeError(
      `System plugin native module probe exceeded its ${totalTimeoutMs}ms total budget.`,
      modulePath,
      null,
      null
    )
  }
}

function normalizeTerminationGrace(value: number | undefined): number {
  const graceMs = value ?? DEFAULT_TERMINATION_GRACE_MS
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error('System plugin child termination grace must be a non-negative integer.')
  }
  return graceMs
}

function normalizeExecutable(value: string): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.includes('\0')
    || !isAbsolute(value)
  ) {
    throw new Error('System plugin native module probe executable must be an absolute path.')
  }
  return resolve(value)
}

function createProbeEnvironment(environment: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  const blocked = new Set(['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'])
  for (const [key, value] of Object.entries({ ...process.env, ...environment })) {
    if (blocked.has(key.toUpperCase()) || typeof value !== 'string') continue
    sanitized[key] = value
  }
  sanitized.ELECTRON_RUN_AS_NODE = '1'
  return sanitized
}

function assertProbePathInsideRoot(candidate: string, root: string): void {
  const path = relative(root, candidate)
  if (path === '') return
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('System plugin node_modules path resolves outside its runtime root.')
  }
}

function toPortableRuntimePath(root: string, candidate: string): string {
  const path = relative(root, candidate)
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('System plugin native module path is outside its runtime root.')
  }
  return path.split(sep).join('/')
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess {
  if (process.platform === 'win32' && WINDOWS_PACKAGE_MANAGER_SHIM.test(executable)) {
    if (args.some((argument) => !WINDOWS_SAFE_PACKAGE_MANAGER_ARGUMENT.test(argument))) {
      throw new Error(
        'Windows package-manager shim arguments cannot contain whitespace or command-shell metacharacters.'
      )
    }
    const commandShell = process.env.ComSpec
      || (process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'cmd.exe') : 'cmd.exe')
    // npm/pnpm/yarn are .cmd shims on Windows and cannot be passed directly to
    // CreateProcess. Invoke the exact, validated argv through cmd.exe while
    // keeping child_process shell expansion disabled and the shim process in
    // the managed process tree.
    return spawnProcess(commandShell, [
      '/d',
      '/s',
      '/c',
      [executable, ...args].join(' ')
    ], {
      ...options,
      shell: false
    })
  }
  return spawnProcess(executable, [...args], options)
}

type ChildTerminationLifecycleInput = {
  terminationGraceMs: number
  killSignal: NodeJS.Signals
  forceKillSignal: NodeJS.Signals
  terminate: SystemPluginDependencyTerminate
  processTree: boolean
}

function rejectAfterTerminatingChild<T>(
  child: ChildProcess,
  input: ChildTerminationLifecycleInput,
  error: Error
): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    let settled = false
    let forceTimeout: NodeJS.Timeout | undefined
    const pid = normalizePid(child.pid)
    const finish = () => {
      if (settled) return
      settled = true
      if (forceTimeout) clearTimeout(forceTimeout)
      child.removeListener('close', finish)
      child.removeListener('error', ignoreChildError)
      reject(error)
    }
    const ignoreChildError = () => {
      // Node emits close after a failed spawn; close is the lifecycle boundary.
    }
    child.once('close', finish)
    child.on('error', ignoreChildError)
    void invokeTermination(input.terminate, {
      child,
      pid,
      signal: input.killSignal,
      force: false,
      processTree: input.processTree
    })
    forceTimeout = setTimeout(() => {
      if (settled) return
      void invokeTermination(input.terminate, {
        child,
        pid,
        signal: input.forceKillSignal,
        force: true,
        processTree: input.processTree
      })
    }, input.terminationGraceMs)
    if (child.exitCode != null || child.signalCode != null) queueMicrotask(finish)
  })
}

async function invokeTermination(
  terminate: SystemPluginDependencyTerminate,
  request: SystemPluginDependencyTerminationRequest
): Promise<void> {
  try {
    await terminate(request)
  } catch {
    // A custom or tree terminator can fail independently. Direct termination is
    // the final fallback; the caller still waits for the child's close event.
    terminateChildOnly(request)
  }
}

function terminateChildOnly(request: SystemPluginDependencyTerminationRequest): void {
  try {
    request.child.kill(request.signal)
  } catch {
    // The close event, not kill()'s return value, confirms termination.
  }
}

async function terminateDefaultProcessTree(
  request: SystemPluginDependencyTerminationRequest
): Promise<void> {
  if (!request.processTree || request.pid === null) {
    terminateChildOnly(request)
    return
  }

  if (process.platform === 'win32') {
    const terminated = await terminateWindowsProcessTree(request.pid, request.force)
    if (!terminated) terminateChildOnly(request)
    return
  }

  try {
    process.kill(-request.pid, request.signal)
  } catch (error) {
    if (!isNoSuchProcessError(error)) terminateChildOnly(request)
  }
}

function terminateWindowsProcessTree(pid: number, force: boolean): Promise<boolean> {
  const systemRoot = process.env.SystemRoot
  const executable = systemRoot && isAbsolute(systemRoot)
    ? join(systemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe'
  const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]

  return new Promise<boolean>((resolvePromise) => {
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    let taskkill: ChildProcess
    const settle = (result: boolean) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      taskkill.removeListener('error', onError)
      taskkill.removeListener('close', onClose)
      resolvePromise(result)
    }
    const onError = () => settle(false)
    const onClose = (exitCode: number | null) => settle(exitCode === 0 || exitCode === 128)

    try {
      taskkill = spawnProcess(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      resolvePromise(false)
      return
    }
    timeout = setTimeout(() => {
      try {
        taskkill.kill('SIGKILL')
      } catch {
        // A timed-out helper is treated as a failed tree termination attempt.
      }
      settle(false)
    }, WINDOWS_TASKKILL_TIMEOUT_MS)
    taskkill.once('error', onError)
    taskkill.once('close', onClose)
  })
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}

function normalizeExecutionError(
  error: unknown,
  task: SystemPluginDependencyTask
): SystemPluginDependencyExecutionError {
  if (error instanceof SystemPluginDependencyExecutionError) return error
  return new SystemPluginDependencyExecutionError(
    `System plugin dependency task "${formatCommand(task.command)}" failed (exit code unavailable).`,
    task,
    null,
    null,
    { cause: error }
  )
}

function cancellationError(
  task: SystemPluginDependencyTask,
  reason: unknown
): SystemPluginDependencyCancelledError {
  return new SystemPluginDependencyCancelledError(
    task,
    reason === undefined ? undefined : { cause: reason }
  )
}

function emitLog(
  input: Pick<ProcessExecutionInput | NativeRunnerExecutionInput, 'taskIndex' | 'task' | 'onLog'>,
  stream: SystemPluginDependencyLogStream,
  text: string
): void {
  safeCallback(input.onLog, Object.freeze({
    taskIndex: input.taskIndex,
    task: input.task,
    stream,
    text,
    timestamp: new Date().toISOString()
  }))
}

function emitProbeLog(
  input: Pick<NativeModuleProbeExecutionInput, 'nativeModule' | 'onLog'>,
  stream: SystemPluginDependencyLogStream,
  text: string
): void {
  safeCallback(input.onLog, Object.freeze({
    modulePath: input.nativeModule.relativePath,
    stream,
    text,
    timestamp: new Date().toISOString()
  }))
}

function emitStatus(
  options: ExecuteSystemPluginDependencyTasksOptions,
  taskIndex: number,
  task: SystemPluginDependencyTask,
  previousStatus: SystemPluginDependencyJobStatus,
  status: SystemPluginDependencyJobStatus,
  error: Error | null
): void {
  safeCallback(options.onStatus, Object.freeze({
    taskIndex,
    task,
    previousStatus,
    status,
    error,
    timestamp: new Date().toISOString()
  }))
}

function emitProcess(
  input: ProcessExecutionInput,
  phase: SystemPluginDependencyProcessPhase,
  pid: number | null,
  exitCode: number | null,
  signal: NodeJS.Signals | null
): void {
  safeCallback(input.onProcess, Object.freeze({
    taskIndex: input.taskIndex,
    task: input.task,
    phase,
    pid,
    exitCode,
    signal,
    timestamp: new Date().toISOString()
  }))
}

function normalizePid(pid: number | undefined): number | null {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function formatCommand(command: readonly string[]): string {
  return command.map((argument) => /\s|["']/.test(argument)
    ? JSON.stringify(argument)
    : argument).join(' ')
}

function safeCallback<T>(callback: ((event: T) => void) | undefined, event: T): void {
  if (!callback) return
  try {
    callback(event)
  } catch {
    // Persistence/logging callbacks must not change command state.
  }
}
