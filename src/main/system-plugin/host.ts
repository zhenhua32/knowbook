import { resolve } from 'node:path'
import { createFullTrustPluginContext } from './context'
import {
  loadSystemPluginLifecycle,
  normalizeError,
  runWithTimeout,
  SystemPluginDisposableStack
} from './runtime'
import type {
  FullTrustPluginContext,
  FullTrustPluginContextFactoryBindings,
  FullTrustPluginIdentity,
  LoadedSystemPluginLifecycle,
  SystemPluginActivationResult,
  SystemPluginErrorEvent,
  SystemPluginErrorStage,
  SystemPluginHealthCheckResult,
  SystemPluginHostOptions,
  SystemPluginRuntimeStatus,
  SystemPluginRuntimeTimeouts,
  SystemPluginStatusEvent
} from './types'
import { SystemPluginUnhealthyError } from './types'

const DEFAULT_TIMEOUTS: SystemPluginRuntimeTimeouts = Object.freeze({
  migrateMs: 30_000,
  activateMs: 30_000,
  healthCheckMs: 10_000,
  beforeQuitMs: 5_000,
  deactivateMs: 5_000,
  disposeMs: 5_000
})

export class SystemPluginHost<TServices extends object = Record<never, never>> {
  private currentStatus: SystemPluginRuntimeStatus = 'idle'
  private loaded: LoadedSystemPluginLifecycle<FullTrustPluginContext<TServices>> | null = null
  private pluginContext: FullTrustPluginContext<TServices> | null = null
  private readonly disposables = new SystemPluginDisposableStack()
  private readonly timeouts: SystemPluginRuntimeTimeouts
  private activation: Promise<SystemPluginActivationResult> | null = null
  private activationResult: SystemPluginActivationResult | null = null
  private healthOperation: Promise<SystemPluginHealthCheckResult> | null = null
  private beforeQuitOperation: Promise<void> | null = null
  private deactivation: Promise<void> | null = null

  constructor(private readonly options: SystemPluginHostOptions<TServices>) {
    validateOptions(options)
    this.timeouts = normalizeTimeouts(options.timeouts)
  }

  get status(): SystemPluginRuntimeStatus {
    return this.currentStatus
  }

  get context(): FullTrustPluginContext<TServices> | null {
    return this.pluginContext
  }

  activate(): Promise<SystemPluginActivationResult> {
    if (this.activationResult) return Promise.resolve(this.activationResult)
    if (this.activation) return this.activation
    if (this.currentStatus !== 'idle') {
      return Promise.reject(new Error(
        `System plugin "${this.options.plugin.id}" cannot activate from ${this.currentStatus} status.`
      ))
    }
    this.activation = this.runActivation()
    return this.activation
  }

  healthCheck(): Promise<SystemPluginHealthCheckResult> {
    if (this.healthOperation) return this.healthOperation
    if (this.currentStatus !== 'active') {
      return Promise.reject(new Error(
        `System plugin "${this.options.plugin.id}" health check requires active status.`
      ))
    }
    this.healthOperation = this.runHealthCheck(false).finally(() => {
      this.healthOperation = null
    })
    return this.healthOperation
  }

  beforeQuit(): Promise<void> {
    if (this.beforeQuitOperation) return this.beforeQuitOperation
    if (this.currentStatus === 'stopped' || this.currentStatus === 'failed') {
      return Promise.resolve()
    }
    if (this.currentStatus !== 'active') {
      return Promise.reject(new Error(
        `System plugin "${this.options.plugin.id}" cannot run beforeQuit from ${this.currentStatus} status.`
      ))
    }
    this.beforeQuitOperation = this.runBeforeQuit()
    return this.beforeQuitOperation
  }

  deactivate(): Promise<void> {
    if (this.deactivation) return this.deactivation
    if (this.currentStatus === 'stopped') return Promise.resolve()
    this.deactivation = this.runDeactivation()
    return this.deactivation
  }

  private async runActivation(): Promise<SystemPluginActivationResult> {
    let activationCompleted = false
    try {
      this.transition('loading')
      try {
        this.loaded = await loadSystemPluginLifecycle({
          pluginRoot: this.options.pluginRoot,
          mainEntry: this.options.mainEntry
        })
      } catch (error) {
        throw this.recordError('load', error, true)
      }

      try {
        this.pluginContext = this.buildContext(this.loaded)
      } catch (error) {
        throw this.recordError('context', error, true)
      }

      if (this.options.fromVersion && this.loaded.lifecycle.migrate) {
        this.transition('migrating')
        try {
          await runWithTimeout(
            invoke(() => this.loaded!.lifecycle.migrate!(
              this.pluginContext!,
              this.options.fromVersion!
            )),
            this.timeouts.migrateMs,
            'migrate',
            `System plugin "${this.options.plugin.id}" migrate`
          )
        } catch (error) {
          throw this.recordError('migrate', error, true)
        }
      }

      this.transition('activating')
      try {
        await runWithTimeout(
          invoke(() => this.loaded!.lifecycle.activate(this.pluginContext!)),
          this.timeouts.activateMs,
          'activate',
          `System plugin "${this.options.plugin.id}" activate`
        )
        activationCompleted = true
      } catch (error) {
        throw this.recordError('activate', error, true)
      }

      let health: SystemPluginHealthCheckResult
      try {
        health = await this.runHealthCheck(true)
      } catch (error) {
        throw this.recordError('health-check', error, true)
      }
      if (!health.ok) {
        const error = new SystemPluginUnhealthyError(
          health.message || `System plugin "${this.options.plugin.id}" failed its initial health check.`
        )
        throw this.recordError('health-check', error, true)
      }

      this.transition('active')
      this.activationResult = Object.freeze({
        entryPath: this.loaded.entryPath,
        format: this.loaded.format,
        health: Object.freeze({ ...health })
      })
      return this.activationResult
    } catch (error) {
      await this.cleanupFailedActivation(activationCompleted)
      this.transition('failed')
      throw normalizeError(error)
    }
  }

  private buildContext(
    loaded: LoadedSystemPluginLifecycle<FullTrustPluginContext<TServices>>
  ): FullTrustPluginContext<TServices> {
    const identity: FullTrustPluginIdentity = {
      ...this.options.plugin,
      root: resolve(this.options.pluginRoot),
      dataRoot: resolve(this.options.dataRoot)
    }
    const bindings: FullTrustPluginContextFactoryBindings = {
      plugin: Object.freeze({ ...identity }),
      require: loaded.rootRequire,
      process: this.options.process ?? process,
      registerDisposable: (disposable, label) => this.disposables.register(disposable, label),
      entryPath: loaded.entryPath,
      format: loaded.format
    }
    const services = this.options.createServices
      ? this.options.createServices(bindings)
      : this.options.services ?? {} as TServices

    return createFullTrustPluginContext({
      identity,
      services,
      rootRequire: bindings.require,
      process: bindings.process,
      registerDisposable: bindings.registerDisposable
    })
  }

  private async runHealthCheck(initial: boolean): Promise<SystemPluginHealthCheckResult> {
    if (!this.loaded?.lifecycle.healthCheck) return { ok: true }
    this.transition('health-checking')
    try {
      const result = await runWithTimeout(
        invoke(() => this.loaded!.lifecycle.healthCheck!()),
        this.timeouts.healthCheckMs,
        'health-check',
        `System plugin "${this.options.plugin.id}" healthCheck`
      )
      return normalizeHealthResult(result)
    } catch (error) {
      if (!initial) this.recordError('health-check', error, false)
      throw error
    } finally {
      if (!initial && this.currentStatus === 'health-checking') this.transition('active')
    }
  }

  private async runBeforeQuit(): Promise<void> {
    if (!this.loaded?.lifecycle.beforeQuit) return
    this.transition('before-quit')
    try {
      await runWithTimeout(
        invoke(() => this.loaded!.lifecycle.beforeQuit!()),
        this.timeouts.beforeQuitMs,
        'before-quit',
        `System plugin "${this.options.plugin.id}" beforeQuit`
      )
    } catch (error) {
      throw this.recordError('before-quit', error, false)
    } finally {
      if (this.currentStatus === 'before-quit') this.transition('active')
    }
  }

  private async runDeactivation(): Promise<void> {
    if (this.activation && !this.activationResult && (
      this.currentStatus === 'loading' ||
      this.currentStatus === 'migrating' ||
      this.currentStatus === 'activating' ||
      this.currentStatus === 'health-checking'
    )) {
      await this.activation.catch(() => undefined)
    }
    if (this.healthOperation) await this.healthOperation.catch(() => undefined)
    if (this.beforeQuitOperation) await this.beforeQuitOperation.catch(() => undefined)
    if (this.currentStatus === 'stopped') return
    if (this.currentStatus === 'failed') {
      // Failed activation already performed and reported best-effort rollback.
      this.transition('stopped')
      return
    }

    this.transition('deactivating')
    this.disposables.close()
    const failures: Error[] = []

    if (this.loaded?.lifecycle.deactivate && this.activationResult) {
      try {
        await runWithTimeout(
          invoke(() => this.loaded!.lifecycle.deactivate!()),
          this.timeouts.deactivateMs,
          'deactivate',
          `System plugin "${this.options.plugin.id}" deactivate`
        )
      } catch (error) {
        failures.push(this.recordError('deactivate', error, false))
      }
    }

    const disposalFailures = await this.disposables.disposeAll(this.timeouts.disposeMs)
    for (const failure of disposalFailures) {
      failures.push(this.recordError('dispose', failure.error, false, failure.label))
    }
    this.transition('stopped')

    if (failures.length > 0) {
      throw new AggregateError(failures, `System plugin "${this.options.plugin.id}" did not stop cleanly.`)
    }
  }

  private async cleanupFailedActivation(activationCompleted: boolean): Promise<void> {
    this.disposables.close()
    if (activationCompleted && this.loaded?.lifecycle.deactivate) {
      try {
        await runWithTimeout(
          invoke(() => this.loaded!.lifecycle.deactivate!()),
          this.timeouts.deactivateMs,
          'deactivate',
          `System plugin "${this.options.plugin.id}" rollback deactivate`
        )
      } catch (error) {
        this.recordError('deactivate', error, false)
      }
    }
    for (const failure of await this.disposables.disposeAll(this.timeouts.disposeMs)) {
      this.recordError('dispose', failure.error, false, failure.label)
    }
  }

  private transition(status: SystemPluginRuntimeStatus): void {
    if (status === this.currentStatus) return
    const event: SystemPluginStatusEvent = Object.freeze({
      pluginId: this.options.plugin.id,
      revisionHash: this.options.plugin.revisionHash,
      previousStatus: this.currentStatus,
      status,
      timestamp: new Date().toISOString()
    })
    this.currentStatus = status
    safeCallback(this.options.onStatus, event)
  }

  private recordError(
    stage: SystemPluginErrorStage,
    rawError: unknown,
    fatal: boolean,
    label?: string
  ): Error {
    const error = normalizeError(rawError)
    const event: SystemPluginErrorEvent = Object.freeze({
      pluginId: this.options.plugin.id,
      revisionHash: this.options.plugin.revisionHash,
      stage,
      error,
      fatal,
      label,
      timestamp: new Date().toISOString()
    })
    safeCallback(this.options.onError, event)
    return error
  }
}

function normalizeTimeouts(
  overrides: Partial<SystemPluginRuntimeTimeouts> | undefined
): SystemPluginRuntimeTimeouts {
  const result = { ...DEFAULT_TIMEOUTS, ...overrides }
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`System plugin timeout "${name}" must be a positive integer.`)
    }
  }
  return Object.freeze(result)
}

function normalizeHealthResult(result: SystemPluginHealthCheckResult): SystemPluginHealthCheckResult {
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    throw new Error('System plugin healthCheck() must return { ok: boolean, message?: string }.')
  }
  if (result.message !== undefined && typeof result.message !== 'string') {
    throw new Error('System plugin healthCheck() message must be a string when provided.')
  }
  return { ok: result.ok, ...(result.message === undefined ? {} : { message: result.message }) }
}

function validateOptions<TServices extends object>(options: SystemPluginHostOptions<TServices>): void {
  for (const [name, value] of Object.entries({
    'plugin.id': options.plugin.id,
    'plugin.version': options.plugin.version,
    'plugin.revisionHash': options.plugin.revisionHash,
    pluginRoot: options.pluginRoot,
    dataRoot: options.dataRoot,
    mainEntry: options.mainEntry
  })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`System plugin host option "${name}" must be a non-empty string.`)
    }
  }
  if (options.services && options.createServices) {
    throw new Error('System plugin host accepts either services or createServices, not both.')
  }
  if (
    options.fromVersion !== undefined
    && (typeof options.fromVersion !== 'string' || !options.fromVersion.trim())
  ) {
    throw new Error('System plugin host option "fromVersion" must be a non-empty string when provided.')
  }
}

function invoke<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(operation())
  } catch (error) {
    return Promise.reject(error)
  }
}

function safeCallback<T>(callback: ((event: T) => void) | undefined, event: T): void {
  if (!callback) return
  try {
    callback(event)
  } catch {
    // Persistence/telemetry callbacks cannot be allowed to change plugin state.
  }
}
