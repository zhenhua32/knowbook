export type SystemPluginAwaitable<T> = T | Promise<T>

export type SystemPluginDisposable = () => SystemPluginAwaitable<void>

export interface FullTrustPluginIdentity {
  id: string
  version: string
  revisionHash: string
  root: string
  dataRoot: string
}

export interface FullTrustPluginRuntimeBindings {
  plugin: Readonly<FullTrustPluginIdentity>
  require: NodeRequire
  process: NodeJS.Process
  registerDisposable(disposable: SystemPluginDisposable, label?: string): void
}

/**
 * Runtime-owned Full Trust fields combined with host-provided stable APIs and
 * unsafe escape hatches. TServices is deliberately injectable so this runtime
 * foundation does not depend on the database, Electron bootstrap, or renderer.
 */
export type FullTrustPluginContext<TServices extends object = Record<never, never>> =
  TServices & FullTrustPluginRuntimeBindings

export interface SystemPluginHealthCheckResult {
  ok: boolean
  message?: string
}

export interface SystemPluginLifecycle<TContext extends object = FullTrustPluginContext> {
  activate(context: TContext): SystemPluginAwaitable<void>
  deactivate?(): SystemPluginAwaitable<void>
  healthCheck?(): SystemPluginAwaitable<SystemPluginHealthCheckResult>
  beforeQuit?(): SystemPluginAwaitable<void>
  migrate?(context: TContext, fromVersion: string): SystemPluginAwaitable<void>
}

export type SystemPluginModuleFormat = 'cjs' | 'esm'

export interface LoadedSystemPluginLifecycle<TContext extends object = FullTrustPluginContext> {
  entryPath: string
  format: SystemPluginModuleFormat
  lifecycle: SystemPluginLifecycle<TContext>
  rootRequire: NodeRequire
}

export type SystemPluginRuntimeStatus =
  | 'idle'
  | 'loading'
  | 'activating'
  | 'health-checking'
  | 'active'
  | 'before-quit'
  | 'deactivating'
  | 'stopped'
  | 'failed'

export type SystemPluginErrorStage =
  | 'load'
  | 'context'
  | 'activate'
  | 'health-check'
  | 'before-quit'
  | 'deactivate'
  | 'dispose'

export interface SystemPluginStatusEvent {
  pluginId: string
  revisionHash: string
  previousStatus: SystemPluginRuntimeStatus
  status: SystemPluginRuntimeStatus
  timestamp: string
}

export interface SystemPluginErrorEvent {
  pluginId: string
  revisionHash: string
  stage: SystemPluginErrorStage
  error: Error
  fatal: boolean
  label?: string
  timestamp: string
}

export interface SystemPluginRuntimeTimeouts {
  activateMs: number
  healthCheckMs: number
  beforeQuitMs: number
  deactivateMs: number
  disposeMs: number
}

export interface SystemPluginDescriptor {
  id: string
  version: string
  revisionHash: string
}

export interface FullTrustPluginContextFactoryBindings extends FullTrustPluginRuntimeBindings {
  entryPath: string
  format: SystemPluginModuleFormat
}

export interface SystemPluginHostOptions<TServices extends object = Record<never, never>> {
  plugin: SystemPluginDescriptor
  pluginRoot: string
  dataRoot: string
  mainEntry: string
  services?: TServices
  createServices?(bindings: FullTrustPluginContextFactoryBindings): TServices
  process?: NodeJS.Process
  timeouts?: Partial<SystemPluginRuntimeTimeouts>
  onStatus?(event: SystemPluginStatusEvent): void
  onError?(event: SystemPluginErrorEvent): void
}

export interface SystemPluginActivationResult {
  entryPath: string
  format: SystemPluginModuleFormat
  health: SystemPluginHealthCheckResult
}

export class SystemPluginRuntimeError extends Error {
  constructor(
    message: string,
    readonly stage: SystemPluginErrorStage,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SystemPluginRuntimeError'
  }
}

export class SystemPluginLifecycleTimeoutError extends SystemPluginRuntimeError {
  constructor(
    stage: SystemPluginErrorStage,
    readonly timeoutMs: number,
    label?: string
  ) {
    super(
      `${label ?? `System plugin ${stage}`} timed out after ${timeoutMs}ms.`,
      stage
    )
    this.name = 'SystemPluginLifecycleTimeoutError'
  }
}

export class SystemPluginUnhealthyError extends SystemPluginRuntimeError {
  constructor(message = 'System plugin health check reported an unhealthy result.') {
    super(message, 'health-check')
    this.name = 'SystemPluginUnhealthyError'
  }
}
