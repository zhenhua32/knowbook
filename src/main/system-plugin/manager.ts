import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readlink, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  ResolveSystemPluginInstallRequestInput,
  SystemPluginInstallRequest
} from '@shared/plugin-trust'
import type {
  SystemPluginInstallationRecord,
  ResolveSystemPluginOsPersistenceInput,
  SystemPluginOsPersistenceRecord,
  SystemPluginPackageRecord,
  SystemPluginRunRecord
} from '@shared/system-plugin-state'
import type {
  SystemPluginArtifactDescriptor,
  SystemPluginV3Manifest
} from '@shared/system-plugin'
import {
  inspectSystemPluginArtifact,
  normalizeSystemPluginV3Manifest,
  publishSystemPluginArtifact,
  stageSystemPluginArtifact,
  type PublishedSystemPluginArtifact
} from '../system-plugin-artifact'
import type { SqlitePluginPlatformRepository } from '../plugin-platform/repository'
import { SystemPluginHost } from './host'
import {
  SystemPluginServiceSupervisor,
  type SystemPluginServiceEvent,
  type SystemPluginServiceSnapshot,
  type SystemPluginServiceSupervisorOptions
} from './service-supervisor'
import {
  SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
  SystemPluginServiceRpcHost,
  type SystemPluginServiceRpcAuditEvent,
  type SystemPluginServiceRpcMethodMap
} from './service-rpc'
import {
  createSystemPluginServiceRpcEndpoint,
  SystemPluginServiceRpcSocketServer,
  type SystemPluginServiceRpcLifecycleMessage,
  type SystemPluginServiceRpcSocketServerOptions
} from './service-rpc-transport'
import type {
  FullTrustOsPersistenceAdapter,
  FullTrustOsPersistenceDescriptor,
  FullTrustOsPersistenceRegistrationInput
} from './os-persistence'
import type {
  FullTrustPluginContextFactoryBindings,
  SystemPluginActivationResult,
  SystemPluginHealthCheckResult,
  SystemPluginHostOptions,
  SystemPluginRuntimeStatus
} from './types'

const CONFIRMATION_VERSION = 1
const FULL_TRUST_DISCLOSURE = 'full-trust'
const DEFAULT_ADOPTED_STOP_TIMEOUT_MS = 5_000
const DEFAULT_ADOPTED_FORCE_KILL_TIMEOUT_MS = 1_000
const DETACHED_PROCESS_IDENTITY_VERSION = 1

export interface PrepareSystemPluginInstallInput {
  sourceDirectory: string
  reason: string
  requestedBy: 'user' | 'assistant'
}

export interface ResolveManagedSystemPluginInstallInput
  extends ResolveSystemPluginInstallRequestInput {
  /** Full Trust confirmation is intentionally unavailable to assistant callers. */
  actor: 'user'
}

export interface PreparedPublishedSystemPluginPackage {
  runtimeFingerprint?: unknown
}

export interface PreparePublishedSystemPluginPackageInput {
  artifact: PublishedSystemPluginArtifact
  packageRecord: SystemPluginPackageRecord
  request: SystemPluginInstallRequest
}

export type PreparePublishedSystemPluginPackage = (
  input: PreparePublishedSystemPluginPackageInput
) => Promise<PreparedPublishedSystemPluginPackage | void>

export interface SystemPluginHostController {
  readonly status: SystemPluginRuntimeStatus
  activate(): Promise<SystemPluginActivationResult>
  healthCheck(): Promise<SystemPluginHealthCheckResult>
  beforeQuit(): Promise<void>
  deactivate(): Promise<void>
}

export type SystemPluginHostFactory<TServices extends object> = (
  options: SystemPluginHostOptions<TServices>
) => SystemPluginHostController

export interface SystemPluginServiceController {
  readonly snapshot: Readonly<SystemPluginServiceSnapshot>
  start(): Readonly<SystemPluginServiceSnapshot>
  startIfConfigured(): Readonly<SystemPluginServiceSnapshot>
  stop(): Promise<Readonly<SystemPluginServiceSnapshot>>
}

export type SystemPluginServiceFactory = (
  options: SystemPluginServiceSupervisorOptions
) => SystemPluginServiceController

export interface CreateSystemPluginServiceRpcMethodsInput {
  plugin: {
    id: string
    version: string
    revisionHash: string
    root: string
    dataRoot: string
  }
  serviceEntry: string
}

export type CreateSystemPluginServiceRpcMethods = (
  input: Readonly<CreateSystemPluginServiceRpcMethodsInput>
) => SystemPluginServiceRpcMethodMap

export interface SystemPluginServiceRpcServerController {
  start(): Promise<void>
  close(): Promise<void>
}

export type SystemPluginServiceRpcServerFactory = (
  options: SystemPluginServiceRpcSocketServerOptions
) => SystemPluginServiceRpcServerController

export interface SystemPluginDetachedProcessIdentity {
  pid: number
  executable: string
  /** OS process creation/start token; unlike a PID, this must not survive PID reuse. */
  startToken: string
}

export type SystemPluginDetachedProcessInspector = (
  pid: number
) => Promise<SystemPluginDetachedProcessIdentity | null>

export interface SystemPluginManagerOptions<TServices extends object = Record<never, never>> {
  repository: SqlitePluginPlatformRepository
  stagingRoot: string
  artifactRoot: string
  dataRoot: string
  backupRoot: string
  runtimeRoot?: string
  logRoot?: string
  backupDatabase(destinationPath: string): Promise<void>
  services?: TServices
  createServices?(bindings: FullTrustPluginContextFactoryBindings): TServices
  createHost?: SystemPluginHostFactory<TServices>
  createServiceSupervisor?: SystemPluginServiceFactory
  createServiceRpcMethods?: CreateSystemPluginServiceRpcMethods
  createServiceRpcServer?: SystemPluginServiceRpcServerFactory
  serviceRpcTimeoutMs?: number
  serviceEnvironment?: NodeJS.ProcessEnv | ((pluginId: string) => NodeJS.ProcessEnv)
  osPersistenceAdapter?: FullTrustOsPersistenceAdapter
  osPersistenceCommand?: (pluginId: string) => {
    executable: string
    args: string[]
  }
  preparePublishedPackage?: PreparePublishedSystemPluginPackage
  inspectDetachedProcess?: SystemPluginDetachedProcessInspector
  adoptedServiceStopTimeoutMs?: number
  adoptedServiceForceKillTimeoutMs?: number
  process?: NodeJS.Process
  now?: () => Date
}

export interface SystemPluginInstallResolution {
  request: SystemPluginInstallRequest
  packageRecord: SystemPluginPackageRecord | null
  installation: SystemPluginInstallationRecord | null
}

export interface SystemPluginManagerSummary {
  pluginId: string
  installation: SystemPluginInstallationRecord
  currentPackage: SystemPluginPackageRecord | null
  pendingPackage: SystemPluginPackageRecord | null
  lastRun: SystemPluginRunRecord | null
  recentRuns: SystemPluginRunRecord[]
  osPersistence: SystemPluginOsPersistenceRecord | null
  runtime: {
    packageId: string
    runId: string
    status: SystemPluginRuntimeStatus
  } | null
}

export interface SystemPluginStartupOptions {
  /** One-boot safe mode: recover stale markers but do not load any Full Trust code. */
  safeMode?: boolean
}

type ActiveSystemPluginRuntime = {
  installationId: string
  packageId: string
  runId: string
  hostRunId: string | null
  host: SystemPluginHostController
  service: {
    runId: string
    mode: 'app-lifetime' | 'detached'
    controller: SystemPluginServiceController
    rpcServer: SystemPluginServiceRpcServerController | null
    launchNonce: string | null
    runtimeRoot: string
    serviceEntry: string
  } | null
}

type PersistedDetachedProcessIdentity = SystemPluginDetachedProcessIdentity & {
  schemaVersion: typeof DETACHED_PROCESS_IDENTITY_VERSION
  launchNonce: string
  revisionHash: string
  serviceEntry: string
}

type AdoptableDetachedRun = {
  run: SystemPluginRunRecord
  identity: PersistedDetachedProcessIdentity
}

/**
 * Coordinates the trusted v3 install and main-entry lifecycle.
 *
 * This class is intentionally not an authorization boundary. Its confirmation,
 * audit, backup, and crash-marker checks make Full Trust explicit and recoverable,
 * but successfully loaded plugin code can bypass every host API.
 */
export class SystemPluginManager<TServices extends object = Record<never, never>> {
  private readonly repository: SqlitePluginPlatformRepository
  private readonly stagingRoot: string
  private readonly artifactRoot: string
  private readonly dataRoot: string
  private readonly backupRoot: string
  private readonly runtimeRoot: string | null
  private readonly logRoot: string | null
  private readonly now: () => Date
  private readonly hostProcess: NodeJS.Process
  private readonly createHost: SystemPluginHostFactory<TServices>
  private readonly createServiceSupervisor: SystemPluginServiceFactory
  private readonly createServiceRpcServer: SystemPluginServiceRpcServerFactory
  private readonly preparePublishedPackage: PreparePublishedSystemPluginPackage
  private readonly osPersistenceAdapter: FullTrustOsPersistenceAdapter | null
  private readonly osPersistenceCommand: (pluginId: string) => {
    executable: string
    args: string[]
  }
  private readonly inspectDetachedProcess: SystemPluginDetachedProcessInspector
  private readonly adoptedServiceStopTimeoutMs: number
  private readonly adoptedServiceForceKillTimeoutMs: number
  private readonly active = new Map<string, ActiveSystemPluginRuntime>()
  private startupOperation: Promise<SystemPluginManagerSummary[]> | null = null
  private macMainAppRegistrationClaim: string | null = null
  private destroyOperation: Promise<void> | null = null
  private destroyed = false

  constructor(private readonly options: SystemPluginManagerOptions<TServices>) {
    if (options.services && options.createServices) {
      throw new Error('SystemPluginManager accepts either services or createServices, not both.')
    }
    this.repository = options.repository
    this.stagingRoot = resolveRequiredPath(options.stagingRoot, 'stagingRoot')
    this.artifactRoot = resolveRequiredPath(options.artifactRoot, 'artifactRoot')
    this.dataRoot = resolveRequiredPath(options.dataRoot, 'dataRoot')
    this.backupRoot = resolveRequiredPath(options.backupRoot, 'backupRoot')
    this.runtimeRoot = options.runtimeRoot
      ? resolveRequiredPath(options.runtimeRoot, 'runtimeRoot')
      : null
    this.logRoot = options.logRoot
      ? resolveRequiredPath(options.logRoot, 'logRoot')
      : null
    this.now = options.now ?? (() => new Date())
    this.hostProcess = options.process ?? process
    this.createHost = options.createHost ?? ((hostOptions) => new SystemPluginHost(hostOptions))
    this.createServiceSupervisor = options.createServiceSupervisor
      ?? ((supervisorOptions) => new SystemPluginServiceSupervisor(supervisorOptions))
    this.createServiceRpcServer = options.createServiceRpcServer
      ?? ((serverOptions) => new SystemPluginServiceRpcSocketServer(serverOptions))
    this.preparePublishedPackage = options.preparePublishedPackage
      ?? defaultPreparePublishedPackage
    this.osPersistenceAdapter = options.osPersistenceAdapter ?? null
    this.osPersistenceCommand = options.osPersistenceCommand
      ?? ((pluginId) => ({
          executable: this.hostProcess.execPath,
          args: [`--knowbook-system-plugin-os-startup=${pluginId}`]
        }))
    this.inspectDetachedProcess = options.inspectDetachedProcess
      ?? ((pid) => inspectDetachedProcess(pid, this.hostProcess.platform))
    this.adoptedServiceStopTimeoutMs = normalizeNonNegativeDuration(
      options.adoptedServiceStopTimeoutMs,
      DEFAULT_ADOPTED_STOP_TIMEOUT_MS,
      'Adopted Full Trust service stop timeout'
    )
    this.adoptedServiceForceKillTimeoutMs = normalizeNonNegativeDuration(
      options.adoptedServiceForceKillTimeoutMs,
      DEFAULT_ADOPTED_FORCE_KILL_TIMEOUT_MS,
      'Adopted Full Trust service force-kill timeout'
    )
  }

  async prepareInstallFromDirectory(
    input: PrepareSystemPluginInstallInput
  ): Promise<SystemPluginInstallRequest> {
    this.assertUsable()
    const inspected = await inspectSystemPluginArtifact(input.sourceDirectory)
    const request = this.repository.createSystemPluginInstallRequest({
      pluginId: inspected.manifest.id,
      name: inspected.manifest.name,
      version: inspected.manifest.version,
      publisher: inspected.manifest.publisher,
      artifactSha256: inspected.artifactSha256,
      systemPermissions: disclosureFor(inspected.manifest),
      reason: input.reason,
      requestedBy: input.requestedBy
    })

    try {
      const staged = await stageSystemPluginArtifact({
        sourceDirectory: input.sourceDirectory,
        stagingRoot: this.stagingRoot,
        requestId: request.id
      })
      assertDescriptorIdentity(staged, inspected)
      const prepared = this.repository.updateSystemPluginInstallRequestState(request.id, {
        stagedArtifactPath: staged.stagingDirectory,
        computedArtifactSha256: staged.artifactSha256,
        manifestSnapshot: staged.manifest,
        dependencyPlan: staged.manifest.dependencies ?? null,
        confirmationVersion: CONFIRMATION_VERSION,
        error: null
      })
      this.repository.appendSystemPluginAudit({
        pluginId: prepared.pluginId,
        requestId: prepared.id,
        actor: input.requestedBy,
        action: 'install.prepared',
        outcome: 'success',
        details: {
          artifactSha256: staged.artifactSha256,
          fileCount: staged.fileCount,
          sizeBytes: staged.sizeBytes,
          confirmationVersion: CONFIRMATION_VERSION
        }
      })
      return prepared
    } catch (error) {
      const details = serializeError(error)
      this.repository.updateSystemPluginInstallRequestState(request.id, { error: details })
      const current = this.repository.getSystemPluginInstallRequest(request.id)
      if (current?.status === 'awaiting-confirmation') {
        this.repository.resolveSystemPluginInstallRequest({
          requestId: current.id,
          pluginId: current.pluginId,
          acknowledgeSystemAccess: false,
          decision: 'cancel'
        })
      }
      this.repository.appendSystemPluginAudit({
        pluginId: request.pluginId,
        requestId: request.id,
        actor: input.requestedBy,
        action: 'install.prepare',
        outcome: 'failure',
        details
      })
      throw normalizeError(error)
    }
  }

  async resolveInstallRequest(
    input: ResolveManagedSystemPluginInstallInput
  ): Promise<SystemPluginInstallResolution> {
    this.assertUsable()
    if (input.actor !== 'user') {
      throw new Error('Only an explicit user action can resolve a Full Trust install request.')
    }
    const request = this.requireInstallRequest(input.requestId)

    if (input.decision === 'cancel') {
      const cancelled = this.repository.resolveSystemPluginInstallRequest(input)
      try {
        await this.removeStagedArtifact(cancelled)
        this.repository.appendSystemPluginAudit({
          pluginId: cancelled.pluginId,
          requestId: cancelled.id,
          actor: 'user',
          action: 'install.cancelled',
          outcome: 'success'
        })
        return { request: cancelled, packageRecord: null, installation: null }
      } catch (error) {
        const details = serializeError(error)
        const updated = this.repository.updateSystemPluginInstallRequestState(cancelled.id, {
          error: details
        })
        this.repository.appendSystemPluginAudit({
          pluginId: cancelled.pluginId,
          requestId: cancelled.id,
          actor: 'user',
          action: 'install.cancelled.cleanup',
          outcome: 'failure',
          details
        })
        throw new SystemPluginInstallCleanupError(updated, normalizeError(error))
      }
    }

    let packageRecord: SystemPluginPackageRecord | null = null
    let resolved = request
    try {
      if (input.artifactSha256 !== request.artifactSha256) {
        throw new Error('Full Trust confirmation does not match the exact reviewed artifact SHA-256.')
      }
      if (input.acknowledgeSystemAccess !== true) {
        throw new Error('Full Trust confirmation requires explicit acknowledgement of system access.')
      }
      const staged = await this.reinspectRequest(request)
      const existing = this.repository.findSystemPluginPackage(
        request.pluginId,
        staged.artifactSha256
      )
      if (existing && existing.status !== 'ready') {
        throw new Error(
          `System plugin package ${existing.id} already exists in ${existing.status} status; `
          + 'change the artifact before retrying.'
        )
      }
      if (existing) await verifyPublishedPackage(existing, staged)

      // Confirmation is committed before any injectable package preparation can execute code.
      resolved = this.repository.resolveSystemPluginInstallRequest(input)

      if (existing) {
        await this.removeStagedArtifact(resolved)
        packageRecord = existing
      } else {
        const published = await publishSystemPluginArtifact({
          stagingDirectory: staged.stagingDirectory,
          artifactRoot: this.artifactRoot,
          pluginId: staged.manifest.id,
          artifactSha256: staged.artifactSha256
        })
        packageRecord = this.repository.createSystemPluginPackage({
          pluginId: published.manifest.id,
          version: published.manifest.version,
          publisher: published.manifest.publisher,
          contentHash: published.artifactSha256,
          artifactPath: published.artifactDirectory,
          manifestSnapshot: published.manifest,
          fileManifest: published.files,
          sourceRequestId: resolved.id,
          status: 'installing'
        })
        try {
          const preparation = await this.preparePublishedPackage({
            artifact: published,
            packageRecord,
            request: resolved
          })
          packageRecord = this.repository.updateSystemPluginPackage(packageRecord.id, {
            status: 'ready',
            runtimeFingerprint: preparation?.runtimeFingerprint
              ?? defaultRuntimeFingerprint(published.artifactSha256),
            error: null
          })
        } catch (error) {
          packageRecord = this.repository.updateSystemPluginPackage(packageRecord.id, {
            status: 'failed',
            error: serializeError(error)
          })
          throw error
        }
      }

      const backupPath = await this.createSafetyBackup(packageRecord)
      let installation = this.repository.ensureSystemPluginInstallation({
        pluginId: packageRecord.pluginId,
        enabled: false,
        autoStart: false,
        status: 'disabled'
      })
      installation = this.repository.updateSystemPluginInstallation(installation.id, {
        enabled: true,
        autoStart: staged.manifest.background?.autoStart ?? true,
        safeModeDisabled: false,
        status: 'pending-restart',
        pendingPackageId: packageRecord.id,
        lastError: null,
        backupPath
      })
      resolved = this.repository.updateSystemPluginInstallRequestState(resolved.id, {
        installationId: installation.id,
        error: null
      })
      this.repository.appendSystemPluginAudit({
        pluginId: resolved.pluginId,
        installationId: installation.id,
        packageId: packageRecord.id,
        requestId: resolved.id,
        actor: 'user',
        action: 'install.confirmed',
        outcome: 'success',
        details: {
          artifactSha256: packageRecord.contentHash,
          restartRequired: true,
          backupPath
        }
      })
      return { request: resolved, packageRecord, installation }
    } catch (error) {
      const details = serializeError(error)
      const current = this.repository.getSystemPluginInstallRequest(request.id)
      if (current) {
        resolved = this.repository.updateSystemPluginInstallRequestState(current.id, { error: details })
      }
      this.repository.appendSystemPluginAudit({
        pluginId: request.pluginId,
        ...(packageRecord ? { packageId: packageRecord.id } : {}),
        requestId: request.id,
        actor: 'user',
        action: 'install.confirm',
        outcome: 'failure',
        details
      })
      throw normalizeError(error)
    }
  }

  startup(options: SystemPluginStartupOptions = {}): Promise<SystemPluginManagerSummary[]> {
    this.assertUsable()
    if (this.startupOperation) return this.startupOperation
    const operation = this.runStartup(Boolean(options.safeMode))
    this.startupOperation = operation
    void operation.then(undefined, () => {
      if (this.startupOperation === operation) this.startupOperation = null
    })
    return operation
  }

  async enable(pluginId: string): Promise<SystemPluginManagerSummary> {
    this.assertUsable()
    const installation = this.requireInstallation(pluginId)
    if (!installation.currentPackageId && !installation.pendingPackageId) {
      throw new Error(`System plugin "${pluginId}" has no installed package to enable.`)
    }
    this.repository.updateSystemPluginInstallation(installation.id, {
      enabled: true,
      safeModeDisabled: false,
      status: 'pending-restart',
      lastError: null
    })
    this.repository.appendSystemPluginAudit({
      pluginId: installation.pluginId,
      installationId: installation.id,
      actor: 'user',
      action: 'installation.enabled',
      outcome: 'success',
      details: { restartRequired: true }
    })
    return this.requireSummary(pluginId)
  }

  async disable(pluginId: string): Promise<SystemPluginManagerSummary> {
    this.assertUsable()
    const installation = this.requireInstallation(pluginId)
    this.repository.updateSystemPluginInstallation(installation.id, {
      enabled: false,
      status: 'disabled'
    })
    const stopFailures: Error[] = []
    try {
      await this.stopRuntime(pluginId, false, 'disabled')
    } catch (error) {
      stopFailures.push(normalizeError(error))
    }
    try {
      await this.stopPersistedDetachedRuns(installation, null, 'disabled')
    } catch (error) {
      stopFailures.push(normalizeError(error))
    }
    const stopError = stopFailures.length === 0
      ? null
      : new AggregateError(stopFailures, 'Full Trust disable cleanup failed.')
    this.repository.updateSystemPluginInstallation(installation.id, {
      enabled: false,
      status: 'disabled',
      ...(stopError ? { lastError: serializeError(stopError) } : {})
    })
    this.repository.appendSystemPluginAudit({
      pluginId: installation.pluginId,
      installationId: installation.id,
      actor: 'user',
      action: 'installation.disabled',
      outcome: stopError ? 'failure' : 'success',
      ...(stopError ? { details: serializeError(stopError) } : {})
    })
    if (stopError) throw stopError
    return this.requireSummary(pluginId)
  }

  async recover(pluginId: string): Promise<SystemPluginManagerSummary> {
    this.assertUsable()
    const installation = this.requireInstallation(pluginId)
    if (!installation.currentPackageId && !installation.pendingPackageId) {
      throw new Error(`System plugin "${pluginId}" has no package to recover.`)
    }
    this.repository.updateSystemPluginInstallation(installation.id, {
      enabled: true,
      safeModeDisabled: false,
      status: 'pending-restart',
      lastError: null
    })
    this.repository.appendSystemPluginAudit({
      pluginId,
      installationId: installation.id,
      actor: 'user',
      action: 'installation.recovered',
      outcome: 'success',
      details: { restartRequired: true }
    })
    return this.requireSummary(pluginId)
  }

  async requestUninstall(pluginId: string): Promise<SystemPluginManagerSummary> {
    this.assertUsable()
    const installation = this.requireInstallation(pluginId)
    const cleanupFailures: Error[] = []
    try {
      await this.stopRuntime(pluginId, false, 'disabled')
    } catch (error) {
      cleanupFailures.push(normalizeError(error))
    }
    try {
      await this.stopPersistedDetachedRuns(installation, null, 'uninstall')
    } catch (error) {
      cleanupFailures.push(normalizeError(error))
    }
    try {
      await this.removeOsPersistence(pluginId, 'system')
    } catch (error) {
      cleanupFailures.push(normalizeError(error))
    }
    const stopError = cleanupFailures.length === 0
      ? null
      : new AggregateError(cleanupFailures, 'Full Trust uninstall pre-cleanup failed.')
    this.repository.updateSystemPluginInstallation(installation.id, {
      enabled: false,
      safeModeDisabled: false,
      status: 'uninstall-pending',
      ...(stopError ? { lastError: serializeError(stopError) } : {})
    })
    this.repository.appendSystemPluginAudit({
      pluginId,
      installationId: installation.id,
      actor: 'user',
      action: 'installation.uninstall-requested',
      outcome: stopError ? 'failure' : 'success',
      details: {
        restartRequired: true,
        ...(stopError ? { stopError: serializeError(stopError) } : {})
      }
    })
    return this.requireSummary(pluginId)
  }

  async rollback(pluginId: string, packageId?: string): Promise<SystemPluginManagerSummary> {
    this.assertUsable()
    const installation = this.requireInstallation(pluginId)
    const candidates = this.repository.listSystemPluginPackages(pluginId, 1_000)
      .filter((candidate) => (
        candidate.status === 'ready'
        && candidate.id !== installation.currentPackageId
        && candidate.id !== installation.pendingPackageId
      ))
    const target = packageId
      ? candidates.find((candidate) => candidate.id === packageId)
      : candidates[0]
    if (!target) throw new Error(`System plugin "${pluginId}" has no ready package to roll back to.`)
    const backupPath = await this.createSafetyBackup(target)
    this.repository.updateSystemPluginInstallation(installation.id, {
      enabled: true,
      safeModeDisabled: false,
      status: 'pending-restart',
      pendingPackageId: target.id,
      lastError: null,
      backupPath
    })
    this.repository.appendSystemPluginAudit({
      pluginId,
      installationId: installation.id,
      packageId: target.id,
      actor: 'user',
      action: 'installation.rollback-requested',
      outcome: 'success',
      details: {
        fromPackageId: installation.currentPackageId,
        toPackageId: target.id,
        restartRequired: true,
        backupPath
      }
    })
    return this.requireSummary(pluginId)
  }

  async stop(pluginId: string): Promise<SystemPluginManagerSummary> {
    this.assertUsable()
    const installation = this.requireInstallation(pluginId)
    await this.stopRuntime(pluginId, true, installation.enabled ? 'pending-restart' : 'disabled')
    return this.requireSummary(pluginId)
  }

  async startService(pluginId: string): Promise<SystemPluginManagerSummary> {
    this.assertUsable()
    const runtime = this.requireActiveService(pluginId)
    const service = runtime.service!
    const snapshot = service.controller.start()
    this.persistServiceSnapshot(service.runId, snapshot)
    try {
      if (service.mode === 'detached') {
        if (!service.launchNonce || snapshot.pid === null) {
          throw new Error('Detached Full Trust service did not expose a verifiable process identity.')
        }
        const packageRecord = this.repository.getSystemPluginPackage(runtime.packageId)
        if (!packageRecord) throw new Error('Active Full Trust service package no longer exists.')
        await this.captureDetachedProcessIdentity(
          service.runId,
          snapshot.pid,
          packageRecord,
          service.runtimeRoot,
          service.serviceEntry,
          service.launchNonce
        )
      }
    } catch (error) {
      await service.controller.stop().catch(() => undefined)
      const failure = normalizeError(error)
      this.repository.updateSystemPluginRun(service.runId, {
        status: 'failed',
        pid: null,
        error: serializeError(failure)
      })
      this.repository.appendSystemPluginAudit({
        pluginId,
        installationId: runtime.installationId,
        packageId: runtime.packageId,
        runId: service.runId,
        actor: 'user',
        action: 'service.started',
        outcome: 'failure',
        details: serializeError(failure)
      })
      throw failure
    }
    this.repository.appendSystemPluginAudit({
      pluginId,
      installationId: runtime.installationId,
      packageId: runtime.packageId,
      runId: service.runId,
      actor: 'user',
      action: 'service.started',
      outcome: 'success',
      details: { mode: service.mode }
    })
    return this.requireSummary(pluginId)
  }

  async stopService(pluginId: string): Promise<SystemPluginManagerSummary> {
    this.assertUsable()
    const runtime = this.requireActiveService(pluginId)
    let failure: Error | null = null
    try {
      const snapshot = await runtime.service!.controller.stop()
      this.persistServiceSnapshot(runtime.service!.runId, snapshot)
    } catch (error) {
      failure = normalizeError(error)
      this.repository.updateSystemPluginRun(runtime.service!.runId, {
        status: 'failed',
        error: serializeError(failure)
      })
    }
    this.repository.appendSystemPluginAudit({
      pluginId,
      installationId: runtime.installationId,
      packageId: runtime.packageId,
      runId: runtime.service!.runId,
      actor: 'user',
      action: 'service.stopped',
      outcome: failure ? 'failure' : 'success',
      ...(failure ? { details: serializeError(failure) } : {})
    })
    if (failure) throw failure
    return this.requireSummary(pluginId)
  }

  requestOsPersistence(
    pluginId: string,
    actor: 'user' | 'plugin' = 'user'
  ): SystemPluginOsPersistenceRecord {
    this.assertUsable()
    const adapter = this.requireOsPersistenceAdapter()
    const installation = this.requireInstallation(pluginId)
    if (!installation.enabled || !installation.currentPackageId) {
      throw new Error('Full Trust OS persistence requires an enabled, active package.')
    }
    const packageRecord = this.repository.getSystemPluginPackage(installation.currentPackageId)
    if (!packageRecord || packageRecord.status !== 'ready') {
      throw new Error('Full Trust OS persistence requires a ready current package.')
    }
    const manifest = manifestFromPackage(packageRecord)
    if (
      !manifest.entries.service
      || manifest.background?.mode !== 'detached'
      || manifest.background.autoStart !== true
    ) {
      throw new Error(
        'OS persistence requires a detached, auto-start Full Trust service entry.'
      )
    }
    if (!manifest.riskDeclarations.includes('os-persistence')) {
      throw new Error('The confirmed Full Trust manifest did not disclose os-persistence.')
    }
    const revisionHash = `sha256:${packageRecord.contentHash}`
    const existing = this.repository.getSystemPluginOsPersistenceByPlugin(pluginId)
    this.assertMacMainAppPersistenceAvailable(existing?.id ?? null)
    if (
      existing
      && (existing.status === 'registered'
        || existing.status === 'requires-approval'
        || existing.status === 'disabled')
    ) {
      if (existing.packageId === packageRecord.id && existing.revisionHash === revisionHash) {
        return existing
      }
      throw new Error('Remove the existing OS startup registration before reviewing a new revision.')
    }
    if (
      existing?.status === 'awaiting-confirmation'
      && existing.packageId === packageRecord.id
      && existing.revisionHash === revisionHash
    ) {
      return existing
    }

    const registration = this.createOsPersistenceRegistration(
      installation,
      packageRecord,
      manifest
    )
    const descriptor = adapter.describe(registration)
    const record = this.repository.upsertSystemPluginOsPersistence({
      installationId: installation.id,
      packageId: packageRecord.id,
      revisionHash,
      serviceId: registration.serviceId,
      method: adapter.method,
      command: {
        executable: registration.command.executable,
        args: [...registration.command.args]
      },
      descriptor,
      status: 'awaiting-confirmation'
    })
    this.repository.appendSystemPluginAudit({
      pluginId,
      installationId: installation.id,
      packageId: packageRecord.id,
      actor,
      action: 'os-persistence.requested',
      outcome: 'success',
      details: {
        recordId: record.id,
        revisionHash,
        serviceId: record.serviceId,
        method: record.method,
        command: record.command
      }
    })
    return record
  }

  async resolveOsPersistence(
    input: ResolveSystemPluginOsPersistenceInput & { actor: 'user' }
  ): Promise<SystemPluginOsPersistenceRecord> {
    this.assertUsable()
    if (input.actor !== 'user') {
      throw new Error('Only an explicit user action can resolve Full Trust OS persistence.')
    }
    const adapter = this.requireOsPersistenceAdapter()
    const record = this.repository.getSystemPluginOsPersistence(input.recordId)
    if (!record || record.pluginId !== input.pluginId) {
      throw new Error('Full Trust OS persistence request does not match the selected plugin.')
    }
    if (record.status !== 'awaiting-confirmation') {
      throw new Error('Full Trust OS persistence request was already resolved.')
    }
    if (record.revisionHash !== input.revisionHash) {
      throw new Error('Full Trust OS persistence confirmation does not match the reviewed revision.')
    }

    if (input.decision === 'cancel') {
      const cancelled = this.repository.updateSystemPluginOsPersistence(record.id, {
        status: 'cancelled',
        error: null,
        resolvedAt: this.isoNow()
      })
      this.repository.appendSystemPluginAudit({
        pluginId: record.pluginId,
        installationId: record.installationId,
        packageId: record.packageId,
        actor: 'user',
        action: 'os-persistence.cancelled',
        outcome: 'success',
        details: { recordId: record.id }
      })
      return cancelled
    }
    if (input.acknowledgeSystemStartup !== true) {
      throw new Error('OS persistence requires explicit acknowledgement of login startup.')
    }

    const installation = this.requireInstallation(record.pluginId)
    if (
      !installation.enabled
      || installation.currentPackageId !== record.packageId
    ) {
      throw new Error('The active Full Trust package changed after OS persistence review.')
    }
    const packageRecord = this.repository.getSystemPluginPackage(record.packageId)
    if (!packageRecord || `sha256:${packageRecord.contentHash}` !== record.revisionHash) {
      throw new Error('The reviewed Full Trust OS persistence revision is no longer current.')
    }
    const manifest = manifestFromPackage(packageRecord)
    const registration = this.createOsPersistenceRegistration(
      installation,
      packageRecord,
      manifest
    )
    assertOsPersistenceReviewIdentity(record, registration, adapter.method)

    const claimsMacMainApp = adapter.platform === 'darwin'
    if (claimsMacMainApp) {
      this.assertMacMainAppPersistenceAvailable(record.id)
      if (
        this.macMainAppRegistrationClaim
        && this.macMainAppRegistrationClaim !== record.id
      ) {
        throw new Error('Another Full Trust plugin is already registering the macOS main login item.')
      }
      this.macMainAppRegistrationClaim = record.id
    }

    try {
      const descriptor = await adapter.register(registration)
      const query = await adapter.query(descriptor)
      const status = normalizeManagedOsPersistenceStatus(query.status)
      const resolved = this.repository.updateSystemPluginOsPersistence(record.id, {
        descriptor,
        status,
        error: null,
        resolvedAt: this.isoNow()
      })
      this.repository.appendSystemPluginAudit({
        pluginId: record.pluginId,
        installationId: record.installationId,
        packageId: record.packageId,
        actor: 'user',
        action: 'os-persistence.registered',
        outcome: 'success',
        details: {
          recordId: record.id,
          status,
          serviceId: record.serviceId,
          command: record.command
        }
      })
      return resolved
    } catch (error) {
      const details = serializeError(error)
      this.repository.updateSystemPluginOsPersistence(record.id, {
        status: 'failed',
        error: details,
        resolvedAt: this.isoNow()
      })
      this.repository.appendSystemPluginAudit({
        pluginId: record.pluginId,
        installationId: record.installationId,
        packageId: record.packageId,
        actor: 'user',
        action: 'os-persistence.register',
        outcome: 'failure',
        details
      })
      throw normalizeError(error)
    } finally {
      if (this.macMainAppRegistrationClaim === record.id) {
        this.macMainAppRegistrationClaim = null
      }
    }
  }

  async removeOsPersistence(
    pluginId: string,
    actor: 'user' | 'system' = 'user'
  ): Promise<SystemPluginOsPersistenceRecord | null> {
    this.assertUsable()
    const record = this.repository.getSystemPluginOsPersistenceByPlugin(pluginId)
    if (!record) return null
    if (record.status === 'removed' || record.status === 'cancelled') return record
    if (record.status === 'awaiting-confirmation') {
      return this.repository.updateSystemPluginOsPersistence(record.id, {
        status: 'cancelled',
        error: null,
        resolvedAt: this.isoNow()
      })
    }
    const adapter = this.requireOsPersistenceAdapter()
    const descriptor = record.descriptor as unknown as FullTrustOsPersistenceDescriptor
    try {
      const macMainAppOwner = this.findMacMainAppPersistenceOwner()
      const ownedByAnother = isMacMainAppPersistenceRecord(record)
        && macMainAppOwner !== null
        && macMainAppOwner.id !== record.id
      if (!ownedByAnother) {
        const result = await adapter.remove(descriptor)
        if (!result.removed && result.before.status !== 'absent') {
          const mismatch = this.repository.updateSystemPluginOsPersistence(record.id, {
            status: 'mismatch',
            error: {
              name: 'OsPersistenceOwnershipMismatch',
              message: 'The host-managed startup target no longer matches its reviewed descriptor.'
            },
            resolvedAt: this.isoNow()
          })
          throw new Error(
            `Refusing to remove mismatched OS persistence target for "${mismatch.pluginId}".`
          )
        }
      }
      const removed = this.repository.updateSystemPluginOsPersistence(record.id, {
        status: 'removed',
        error: null,
        resolvedAt: this.isoNow()
      })
      this.repository.appendSystemPluginAudit({
        pluginId: record.pluginId,
        installationId: record.installationId,
        packageId: record.packageId,
        actor,
        action: 'os-persistence.removed',
        outcome: 'success',
        details: { recordId: record.id, ownedByAnother }
      })
      return removed
    } catch (error) {
      const current = this.repository.getSystemPluginOsPersistence(record.id)
      const details = serializeError(error)
      if (current?.status !== 'mismatch') {
        this.repository.updateSystemPluginOsPersistence(record.id, {
          status: 'failed',
          error: details,
          resolvedAt: this.isoNow()
        })
      }
      this.repository.appendSystemPluginAudit({
        pluginId: record.pluginId,
        installationId: record.installationId,
        packageId: record.packageId,
        actor,
        action: 'os-persistence.remove',
        outcome: 'failure',
        details
      })
      throw normalizeError(error)
    }
  }

  list(): SystemPluginManagerSummary[] {
    return this.repository.listSystemPluginInstallations().map((installation) => (
      this.buildSummary(installation)
    ))
  }

  get(pluginId: string): SystemPluginManagerSummary | null {
    const installation = this.repository.getSystemPluginInstallationByPlugin(pluginId)
    return installation ? this.buildSummary(installation) : null
  }

  listSummaries(): SystemPluginManagerSummary[] {
    return this.list()
  }

  getSummary(pluginId: string): SystemPluginManagerSummary | null {
    return this.get(pluginId)
  }

  destroy(): Promise<void> {
    if (this.destroyOperation) return this.destroyOperation
    this.destroyed = true
    this.destroyOperation = this.runDestroy()
    return this.destroyOperation
  }

  private async runStartup(safeMode: boolean): Promise<SystemPluginManagerSummary[]> {
    await this.cleanupResolvedInstallStaging()
    await this.reconcileOsPersistence()
    await this.finalizePendingUninstalls()
    await this.recoverInterruptedActivations()
    const lifecycleInstallations = this.repository.listSystemPluginInstallations()
    for (const installation of lifecycleInstallations) {
      if (!safeMode && installation.enabled && !installation.safeModeDisabled) continue
      try {
        await this.stopPersistedDetachedRuns(
          installation,
          null,
          safeMode ? 'safe-mode' : 'disabled'
        )
      } catch (error) {
        this.repository.updateSystemPluginInstallation(installation.id, {
          lastError: serializeError(error)
        })
      }
    }
    if (safeMode) return this.list()

    const installations = this.repository.listSystemPluginInstallations()
    for (const installation of installations) {
      if (!installation.enabled || installation.safeModeDisabled || this.active.has(installation.pluginId)) {
        continue
      }
      await this.startInstallation(installation)
    }
    return this.list()
  }

  private async cleanupResolvedInstallStaging(): Promise<void> {
    const resolvedRequests = this.repository.listSystemPluginInstallRequests()
      .filter((request) => request.status !== 'awaiting-confirmation')
    for (const request of resolvedRequests) {
      const stagingPath = request.stagedArtifactPath ?? join(this.stagingRoot, request.id)
      try {
        this.assertManagedStagingPath(stagingPath, request.id)
        const existed = await pathExists(stagingPath)
        await rm(stagingPath, { recursive: true, force: true })
        if (request.stagedArtifactPath !== null) {
          this.repository.updateSystemPluginInstallRequestState(request.id, {
            stagedArtifactPath: null
          })
        }
        if (existed) {
          this.repository.appendSystemPluginAudit({
            pluginId: request.pluginId,
            requestId: request.id,
            actor: 'system',
            action: 'install.staging-recovered',
            outcome: 'success',
            details: { status: request.status }
          })
        }
      } catch (error) {
        this.repository.appendSystemPluginAudit({
          pluginId: request.pluginId,
          requestId: request.id,
          actor: 'system',
          action: 'install.staging-recovered',
          outcome: 'failure',
          details: serializeError(error)
        })
      }
    }
  }

  private requireOsPersistenceAdapter(): FullTrustOsPersistenceAdapter {
    if (!this.osPersistenceAdapter) {
      throw new Error('Full Trust OS persistence is unavailable on this host.')
    }
    return this.osPersistenceAdapter
  }

  private createOsPersistenceRegistration(
    installation: SystemPluginInstallationRecord,
    packageRecord: SystemPluginPackageRecord,
    manifest: SystemPluginV3Manifest
  ): FullTrustOsPersistenceRegistrationInput {
    if (installation.pluginId !== packageRecord.pluginId || manifest.id !== installation.pluginId) {
      throw new Error('Full Trust OS persistence identity does not match its installation.')
    }
    const command = this.osPersistenceCommand(installation.pluginId)
    return {
      trust: 'full',
      pluginId: installation.pluginId,
      revisionHash: `sha256:${packageRecord.contentHash}`,
      serviceId: `knowbook.${installation.pluginId}`,
      command: {
        executable: command.executable,
        args: [...command.args]
      },
      displayName: `KnowBook: ${manifest.name}`,
      ...(this.osPersistenceAdapter?.platform === 'darwin'
        ? { macLoginItemType: 'mainAppService' as const }
        : {})
    }
  }

  private async reconcileOsPersistence(): Promise<void> {
    if (!this.osPersistenceAdapter) return
    const records = this.repository.listSystemPluginOsPersistence()
    const macMainAppRecords = records.filter((record) => (
      isLiveOsPersistenceRecord(record) && isMacMainAppPersistenceRecord(record)
    ))
    const macOwner = this.selectMacMainAppPersistenceOwner(macMainAppRecords)
    const conflictingMacRecords = macMainAppRecords.filter((record) => (
      macOwner === null || record.id !== macOwner.id
    ))
    for (const record of conflictingMacRecords) {
      const details = {
        name: 'MacMainAppPersistenceConflict',
        message: 'macOS mainAppService is a host-global singleton owned by another Full Trust plugin.',
        ownerPluginId: macOwner?.pluginId ?? null,
        ownerRecordId: macOwner?.id ?? null
      }
      this.repository.updateSystemPluginOsPersistence(record.id, {
        status: 'mismatch',
        error: details,
        resolvedAt: record.resolvedAt ?? this.isoNow()
      })
      this.repository.appendSystemPluginAudit({
        pluginId: record.pluginId,
        installationId: record.installationId,
        packageId: record.packageId,
        actor: 'system',
        action: 'os-persistence.singleton-conflict',
        outcome: 'failure',
        details
      })
    }
    for (const record of records) {
      if (
        record.status === 'awaiting-confirmation'
        || record.status === 'cancelled'
        || record.status === 'removed'
        || conflictingMacRecords.some((candidate) => candidate.id === record.id)
      ) {
        continue
      }
      try {
        const query = await this.osPersistenceAdapter.query(
          record.descriptor as unknown as FullTrustOsPersistenceDescriptor
        )
        const status = query.status === 'absent'
          ? 'removed'
          : normalizeManagedOsPersistenceStatus(query.status)
        if (status !== record.status || record.error !== null) {
          this.repository.updateSystemPluginOsPersistence(record.id, {
            status,
            error: null,
            resolvedAt: record.resolvedAt ?? this.isoNow()
          })
        }
      } catch (error) {
        const details = serializeError(error)
        this.repository.updateSystemPluginOsPersistence(record.id, {
          status: 'failed',
          error: details,
          resolvedAt: record.resolvedAt ?? this.isoNow()
        })
        this.repository.appendSystemPluginAudit({
          pluginId: record.pluginId,
          installationId: record.installationId,
          packageId: record.packageId,
          actor: 'system',
          action: 'os-persistence.reconcile',
          outcome: 'failure',
          details
        })
      }
    }
  }

  private assertMacMainAppPersistenceAvailable(recordId: string | null): void {
    if (this.osPersistenceAdapter?.platform !== 'darwin') return
    const conflict = this.repository.listSystemPluginOsPersistence().find((candidate) => (
      candidate.id !== recordId
      && isLiveOsPersistenceRecord(candidate)
      && isMacMainAppPersistenceRecord(candidate)
    ))
    if (conflict) {
      throw new Error(
        `macOS mainAppService is already owned by Full Trust plugin "${conflict.pluginId}".`
      )
    }
  }

  private findMacMainAppPersistenceOwner(): SystemPluginOsPersistenceRecord | null {
    return this.selectMacMainAppPersistenceOwner(
      this.repository.listSystemPluginOsPersistence().filter((candidate) => (
        isLiveOsPersistenceRecord(candidate) && isMacMainAppPersistenceRecord(candidate)
      ))
    )
  }

  private selectMacMainAppPersistenceOwner(
    records: SystemPluginOsPersistenceRecord[]
  ): SystemPluginOsPersistenceRecord | null {
    if (records.length === 0) return null
    const declaredOwners = records.filter((record) => isRegisteredOsPersistenceRecord(record))
    const candidates = declaredOwners.length > 0 ? declaredOwners : records
    return [...candidates].sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt, 'en') || left.id.localeCompare(right.id, 'en')
    ))[0] ?? null
  }

  private requireActiveService(pluginId: string): ActiveSystemPluginRuntime {
    const runtime = this.active.get(pluginId)
    if (!runtime?.service) {
      throw new Error(`System plugin "${pluginId}" does not have an active service runtime.`)
    }
    return runtime
  }

  private async finalizePendingUninstalls(): Promise<void> {
    const pending = this.repository.listSystemPluginInstallations()
      .filter((installation) => installation.status === 'uninstall-pending')
    for (const installation of pending) {
      const packages = this.repository.listSystemPluginPackages(installation.pluginId, 1_000)
      try {
        await this.stopPersistedDetachedRuns(installation, null, 'uninstall')
        const persistence = this.repository.getSystemPluginOsPersistenceByPlugin(
          installation.pluginId
        )
        if (
          persistence
          && persistence.status !== 'removed'
          && persistence.status !== 'cancelled'
        ) {
          const removed = await this.removeOsPersistence(installation.pluginId, 'system')
          if (removed && removed.status !== 'removed' && removed.status !== 'cancelled') {
            throw new Error('Host-managed OS persistence could not be removed safely.')
          }
        }
        for (const packageRecord of packages) {
          this.assertManagedRemovalPath(packageRecord.artifactPath, this.artifactRoot, 'artifact')
          await rm(packageRecord.artifactPath, { recursive: true, force: true })
          const runtimePath = getSystemPluginRuntimeRoot(packageRecord)
          if (runtimePath !== packageRecord.artifactPath && this.runtimeRoot) {
            this.assertManagedRemovalPath(runtimePath, this.runtimeRoot, 'runtime')
            await rm(runtimePath, { recursive: true, force: true })
          }
        }
        const dataPath = resolve(this.dataRoot, installation.pluginId)
        this.assertManagedRemovalPath(dataPath, this.dataRoot, 'data')
        await rm(dataPath, { recursive: true, force: true })
        if (this.logRoot) {
          const logPath = resolve(this.logRoot, installation.pluginId)
          this.assertManagedRemovalPath(logPath, this.logRoot, 'log')
          await rm(logPath, { recursive: true, force: true })
        }
        this.repository.appendSystemPluginAudit({
          pluginId: installation.pluginId,
          installationId: installation.id,
          actor: 'system',
          action: 'installation.uninstalled',
          outcome: 'success',
          details: { backupRetainedAt: installation.backupPath }
        })
        this.repository.deleteSystemPluginInstallationData(installation.pluginId)
      } catch (error) {
        const details = serializeError(error)
        this.repository.updateSystemPluginInstallation(installation.id, {
          enabled: false,
          status: 'uninstall-pending',
          lastError: details
        })
        this.repository.appendSystemPluginAudit({
          pluginId: installation.pluginId,
          installationId: installation.id,
          actor: 'system',
          action: 'installation.uninstall',
          outcome: 'failure',
          details
        })
      }
    }
  }

  private assertManagedRemovalPath(candidate: string, root: string, label: string): void {
    const resolvedCandidate = resolve(candidate)
    if (resolvedCandidate === root || !isPathInside(resolvedCandidate, root)) {
      throw new Error(`Refusing to remove an unmanaged Full Trust ${label} path.`)
    }
  }

  private async recoverInterruptedActivations(): Promise<void> {
    const markers = this.repository.listActiveSystemPluginCrashMarkers()
      .filter((marker) => marker.state === 'armed')
    for (const marker of markers) {
      const details = {
        name: 'InterruptedSystemPluginActivation',
        message: 'KnowBook exited before the Full Trust plugin reached ready state.',
        markerId: marker.id,
        phase: marker.phase
      }
      if (marker.runId) {
        const run = this.repository.getSystemPluginRun(marker.runId)
        if (run && run.status !== 'failed' && run.status !== 'stopped') {
          this.repository.updateSystemPluginRun(run.id, {
            status: 'failed',
            error: details
          })
        }
      }
      const packageRecord = this.repository.getSystemPluginPackage(marker.packageId)
      if (packageRecord && packageRecord.status !== 'failed') {
        this.repository.updateSystemPluginPackage(packageRecord.id, {
          status: 'failed',
          error: details
        })
      }
      const installation = this.repository.getSystemPluginInstallation(marker.installationId)
      if (installation) {
        this.repository.updateSystemPluginInstallation(installation.id, {
          enabled: false,
          safeModeDisabled: true,
          status: 'safe-mode-disabled',
          pendingPackageId: installation.pendingPackageId === marker.packageId
            ? null
            : installation.pendingPackageId,
          lastError: details
        })
      }
      this.repository.updateSystemPluginCrashMarker(marker.id, {
        state: 'recovered',
        recovery: { action: 'safe-mode-disabled', recoveredAt: this.isoNow() }
      })
      this.repository.appendSystemPluginAudit({
        pluginId: marker.pluginId,
        installationId: marker.installationId,
        packageId: marker.packageId,
        ...(marker.runId ? { runId: marker.runId } : {}),
        actor: 'system',
        action: 'activation.interrupted-recovered',
        outcome: 'success',
        details
      })
    }
  }

  private async startInstallation(installation: SystemPluginInstallationRecord): Promise<void> {
    const pending = installation.pendingPackageId
      ? this.repository.getSystemPluginPackage(installation.pendingPackageId)
      : null
    const current = installation.currentPackageId
      ? this.repository.getSystemPluginPackage(installation.currentPackageId)
      : null
    const target = pending ?? current
    if (!target) {
      await this.safeDisable(installation, new Error('System plugin installation has no package.'))
      return
    }

    try {
      await this.activatePackage(installation, target, Boolean(pending))
      return
    } catch (pendingError) {
      if (!pending || !current || pending.id === current.id || current.status !== 'ready') {
        await this.safeDisable(installation, normalizeError(pendingError))
        return
      }
      this.repository.updateSystemPluginInstallation(installation.id, {
        status: 'starting',
        pendingPackageId: null,
        lastError: serializeError(pendingError)
      })
      this.repository.appendSystemPluginAudit({
        pluginId: installation.pluginId,
        installationId: installation.id,
        packageId: pending.id,
        actor: 'system',
        action: 'activation.rollback',
        outcome: 'success',
        details: { fallbackPackageId: current.id, cause: serializeError(pendingError) }
      })
      try {
        await this.activatePackage(
          this.repository.getSystemPluginInstallation(installation.id) ?? installation,
          current,
          false
        )
      } catch (fallbackError) {
        await this.safeDisable(
          this.repository.getSystemPluginInstallation(installation.id) ?? installation,
          new AggregateError(
            [normalizeError(pendingError), normalizeError(fallbackError)],
            'Both pending and last-known-good Full Trust packages failed to activate.'
          )
        )
      }
    }
  }

  private async activatePackage(
    installation: SystemPluginInstallationRecord,
    packageRecord: SystemPluginPackageRecord,
    commitPending: boolean
  ): Promise<void> {
    if (packageRecord.status !== 'ready') {
      throw new Error(
        `System plugin package ${packageRecord.id} cannot activate from ${packageRecord.status} status.`
      )
    }
    const manifest = manifestFromPackage(packageRecord)
    if (manifest.id !== installation.pluginId || manifest.id !== packageRecord.pluginId) {
      throw new Error('System plugin package manifest identity does not match its installation.')
    }
    if (manifest.version !== packageRecord.version) {
      throw new Error('System plugin package manifest version does not match its package record.')
    }
    const verified = await inspectSystemPluginArtifact(packageRecord.artifactPath)
    if (verified.artifactSha256 !== packageRecord.contentHash || verified.manifest.id !== manifest.id) {
      throw new Error('Published Full Trust artifact no longer matches its immutable package record.')
    }
    const compatiblePackage = await this.ensureRuntimeCompatibility(
      packageRecord,
      manifest,
      verified
    )
    if (compatiblePackage !== packageRecord) {
      return this.activatePackage(installation, compatiblePackage, commitPending)
    }

    await this.stopPersistedDetachedRuns(installation, packageRecord.id, 'superseded')

    this.repository.updateSystemPluginInstallation(installation.id, {
      status: 'starting',
      lastError: null
    })
    const runtimeRoot = getSystemPluginRuntimeRoot(packageRecord)
    const pluginDataRoot = join(this.dataRoot, installation.pluginId)
    await mkdir(pluginDataRoot, { recursive: true })
    const hostComponent = manifest.entries.main
      ? 'main' as const
      : manifest.entries.renderer
        ? 'renderer' as const
        : null
    const hostRun = hostComponent
      ? this.repository.createSystemPluginRun({
          installationId: installation.id,
          packageId: packageRecord.id,
          component: hostComponent,
          pid: this.hostProcess.pid
        })
      : null
    const serviceLogPath = manifest.entries.service && this.logRoot
      ? join(this.logRoot, installation.pluginId, `${packageRecord.contentHash}-service.log`)
      : null
    if (serviceLogPath) await mkdir(join(this.logRoot!, installation.pluginId), { recursive: true })
    const adoptedService = manifest.entries.service && manifest.background?.mode === 'detached'
      ? await this.findAdoptableDetachedRun(
          installation.id,
          packageRecord,
          manifest.entries.service
        )
      : null
    const serviceRun = manifest.entries.service
      ? adoptedService?.run ?? this.repository.createSystemPluginRun({
          installationId: installation.id,
          packageId: packageRecord.id,
          component: manifest.background?.mode === 'detached' ? 'detached' : 'service',
          logPath: serviceLogPath
        })
      : null
    const run = hostRun ?? serviceRun
    if (!run) throw new Error('System plugin package does not have an activatable entry.')
    const marker = this.repository.createSystemPluginCrashMarker({
      installationId: installation.id,
      packageId: packageRecord.id,
      runId: run.id,
      phase: manifest.entries.main
        ? 'activation.main'
        : manifest.entries.service
          ? 'activation.service'
          : 'activation.renderer'
    })
    let host: SystemPluginHostController | null = null
    let serviceController: SystemPluginServiceController | null = null
    let serviceRpcServer: SystemPluginServiceRpcServerController | null = null
    let serviceLaunchNonce: string | null = null
    let activeServiceEntry: string | null = null
    try {
      host = manifest.entries.main
        ? this.createHost({
            plugin: {
              id: manifest.id,
              version: manifest.version,
              revisionHash: `sha256:${packageRecord.contentHash}`
            },
            pluginRoot: runtimeRoot,
            dataRoot: pluginDataRoot,
            mainEntry: manifest.entries.main,
            ...(this.options.services ? { services: this.options.services } : {}),
            ...(this.options.createServices ? { createServices: this.options.createServices } : {}),
            process: this.hostProcess
          })
        : createRendererLifecyclePlaceholder()
      const activation = await host.activate()
      const readyAt = this.isoNow()
      if (hostRun) {
        this.repository.updateSystemPluginRun(hostRun.id, {
          status: 'ready',
          health: activation.health,
          lastHeartbeatAt: readyAt
        })
      }
      if (serviceRun && manifest.entries.service && manifest.background) {
        const revisionHash = `sha256:${packageRecord.contentHash}`
        const launchNonce = adoptedService?.identity.launchNonce
          ?? (manifest.background.mode === 'detached' ? randomUUID() : null)
        serviceLaunchNonce = launchNonce
        activeServiceEntry = manifest.entries.service
        const rpcToken = launchNonce ?? randomUUID()
        const rpcHost = this.options.createServiceRpcMethods
          ? new SystemPluginServiceRpcHost({
              pluginId: installation.pluginId,
              revisionHash,
              methods: this.options.createServiceRpcMethods({
                plugin: {
                  id: installation.pluginId,
                  version: packageRecord.version,
                  revisionHash,
                  root: runtimeRoot,
                  dataRoot: pluginDataRoot
                },
                serviceEntry: resolve(runtimeRoot, manifest.entries.service)
              }),
              ...(this.options.serviceRpcTimeoutMs === undefined
                ? {}
                : { timeoutMs: this.options.serviceRpcTimeoutMs }),
              onAudit: (event) => this.auditServiceRpc(
                installation,
                packageRecord,
                serviceRun.id,
                event
              )
            })
          : null
        const rpcEndpoint = rpcHost
          ? createSystemPluginServiceRpcEndpoint({
              namespaceRoot: this.dataRoot,
              pluginId: installation.pluginId,
              platform: this.hostProcess.platform
            })
          : null
        if (rpcHost && rpcEndpoint) {
          serviceRpcServer = this.createServiceRpcServer({
            pluginId: installation.pluginId,
            revisionHash,
            endpoint: rpcEndpoint,
            token: rpcToken,
            rpcHost,
            platform: this.hostProcess.platform,
            onLifecycle: (event) => this.handleServiceRpcLifecycle(serviceRun.id, event),
            onTransportError: (error) => this.handleServiceRpcTransportError(
              installation,
              packageRecord,
              serviceRun.id,
              serviceLogPath,
              error
            )
          })
          await serviceRpcServer.start()
        }
        const spawnedServiceController = this.createServiceSupervisor({
          package: {
            rootDirectory: runtimeRoot,
            revisionHash,
            manifest
          },
          ...(rpcHost ? { rpcHost } : {}),
          environment: {
            ...resolveServiceEnvironment(
              this.options.serviceEnvironment,
              installation.pluginId
            ),
            KNOWBOOK_SYSTEM_PLUGIN_DATA_ROOT: pluginDataRoot,
            ...(launchNonce
              ? { KNOWBOOK_SYSTEM_PLUGIN_STARTUP_NONCE: launchNonce }
              : {}),
            ...(rpcEndpoint
              ? {
                  KNOWBOOK_SYSTEM_PLUGIN_RPC_ENDPOINT: rpcEndpoint,
                  KNOWBOOK_SYSTEM_PLUGIN_RPC_TOKEN: rpcToken
                }
              : {}),
            ...(serviceLogPath ? { KNOWBOOK_SYSTEM_PLUGIN_LOG_PATH: serviceLogPath } : {})
          },
          onEvent: (event) => this.handleServiceEvent(
            installation,
            packageRecord,
            serviceRun.id,
            serviceLogPath,
            event
          )
        })
        if (adoptedService) {
          serviceController = createRestartableAdoptedServiceController(
            createAdoptedDetachedServiceController(
              manifest,
              packageRecord,
              adoptedService.run,
              adoptedService.identity,
              this.hostProcess,
              this.inspectDetachedProcess,
              this.adoptedServiceStopTimeoutMs,
              this.adoptedServiceForceKillTimeoutMs
            ),
            spawnedServiceController
          )
          this.repository.updateSystemPluginRun(serviceRun.id, {
            status: 'ready',
            health: this.mergeServiceRunHealth(serviceRun.id, {
              adopted: true,
              ready: true,
              detachedProcessIdentity: adoptedService.identity
            }),
            lastHeartbeatAt: readyAt
          })
        } else {
          serviceController = spawnedServiceController
          const snapshot = serviceController.startIfConfigured()
          this.persistServiceSnapshot(serviceRun.id, snapshot)
          if (manifest.background.autoStart && snapshot.status !== 'running') {
            throw new Error(
              `System plugin auto-start service failed synchronously (${snapshot.status}).`
            )
          }
          if (manifest.background.mode === 'detached' && manifest.background.autoStart) {
            if (!launchNonce || snapshot.pid === null) {
              throw new Error('Detached Full Trust service did not expose a verifiable process identity.')
            }
            await this.captureDetachedProcessIdentity(
              serviceRun.id,
              snapshot.pid,
              packageRecord,
              runtimeRoot,
              manifest.entries.service,
              launchNonce
            )
          }
        }
      }
      this.repository.updateSystemPluginCrashMarker(marker.id, {
        state: 'ready',
        recovery: { action: 'activation-ready', readyAt }
      })
      this.repository.updateSystemPluginInstallation(installation.id, {
        status: 'active',
        currentPackageId: commitPending ? packageRecord.id : installation.currentPackageId,
        pendingPackageId: commitPending ? null : installation.pendingPackageId,
        safeModeDisabled: false,
        lastError: null
      })
      this.active.set(installation.pluginId, {
        installationId: installation.id,
        packageId: packageRecord.id,
        runId: run.id,
        hostRunId: hostRun?.id ?? null,
        host,
        service: serviceRun && serviceController && manifest.background
          ? {
              runId: serviceRun.id,
              mode: manifest.background.mode,
              controller: serviceController,
              rpcServer: serviceRpcServer,
              launchNonce: serviceLaunchNonce,
              runtimeRoot,
              serviceEntry: activeServiceEntry!
            }
          : null
      })
      this.repository.appendSystemPluginAudit({
        pluginId: installation.pluginId,
        installationId: installation.id,
        packageId: packageRecord.id,
        runId: run.id,
        actor: 'system',
        action: 'activation.ready',
        outcome: 'success',
        details: { health: activation.health, committedPending: commitPending }
      })
    } catch (error) {
      const details = serializeError(error)
      if (serviceController) await serviceController.stop().catch(() => undefined)
      if (serviceRpcServer) await serviceRpcServer.close().catch(() => undefined)
      if (host) await host.deactivate().catch(() => undefined)
      this.active.delete(installation.pluginId)
      for (const failedRun of [hostRun, serviceRun]) {
        if (!failedRun) continue
        this.repository.updateSystemPluginRun(failedRun.id, {
          status: 'failed',
          error: details
        })
      }
      this.repository.updateSystemPluginCrashMarker(marker.id, {
        state: 'failed',
        error: details,
        clearedAt: this.isoNow()
      })
      this.repository.updateSystemPluginPackage(packageRecord.id, {
        status: 'failed',
        error: details
      })
      this.repository.appendSystemPluginAudit({
        pluginId: installation.pluginId,
        installationId: installation.id,
        packageId: packageRecord.id,
        runId: run.id,
        actor: 'system',
        action: 'activation.failed',
        outcome: 'failure',
        details
      })
      throw normalizeError(error)
    }
  }

  private async findAdoptableDetachedRun(
    installationId: string,
    packageRecord: SystemPluginPackageRecord,
    serviceEntry: string
  ): Promise<AdoptableDetachedRun | null> {
    const candidates = this.repository.listSystemPluginRuns(installationId, 1_000)
      .filter((run) => (
        run.packageId === packageRecord.id
        && run.component === 'detached'
        && (
          run.status === 'starting'
          || run.status === 'ready'
          || (run.status === 'failed' && run.pid !== null)
        )
      ))
    for (const run of candidates) {
      const identity = parsePersistedDetachedProcessIdentity(run.health)
      const expectedRevision = `sha256:${packageRecord.contentHash}`
      const expectedEntry = resolve(getSystemPluginRuntimeRoot(packageRecord), serviceEntry)
      if (
        run.pid !== null
        && identity
        && identity.pid === run.pid
        && identity.revisionHash === expectedRevision
        && pathsEqual(identity.serviceEntry, expectedEntry, this.hostProcess.platform)
      ) {
        const observed = await this.inspectDetachedProcess(run.pid)
        if (observed && detachedProcessIdentitiesEqual(
          identity,
          observed,
          this.hostProcess.platform
        )) {
          return { run, identity }
        }
      }
      this.repository.updateSystemPluginRun(run.id, {
        status: 'failed',
        pid: null,
        error: {
          name: 'DetachedServiceIdentityMismatchError',
          message: 'Previously detached Full Trust service identity could not be verified.'
        }
      })
    }
    return null
  }

  private async stopPersistedDetachedRuns(
    installation: SystemPluginInstallationRecord,
    keepPackageId: string | null,
    reason: 'disabled' | 'safe-mode' | 'superseded' | 'uninstall'
  ): Promise<void> {
    const candidates = this.repository.listSystemPluginRuns(installation.id, 1_000)
      .filter((run) => (
        run.component === 'detached'
        && run.packageId !== keepPackageId
        && (
          run.status === 'starting'
          || run.status === 'ready'
          || run.status === 'stopping'
          || (run.status === 'failed' && run.pid !== null)
        )
      ))
    const failures: Error[] = []
    for (const run of candidates) {
      try {
        if (run.pid === null) {
          this.repository.updateSystemPluginRun(run.id, { status: 'stopped', pid: null })
          continue
        }
        const observed = await this.inspectDetachedProcess(run.pid)
        if (!observed) {
          this.repository.updateSystemPluginRun(run.id, {
            status: 'stopped',
            pid: null,
            health: this.mergeServiceRunHealth(run.id, {
              rpcConnected: false,
              cleanupReason: reason
            })
          })
          continue
        }
        const identity = parsePersistedDetachedProcessIdentity(run.health)
        if (
          !identity
          || identity.pid !== run.pid
          || !detachedProcessIdentitiesEqual(identity, observed, this.hostProcess.platform)
        ) {
          throw new Error(
            `Refusing to stop detached Full Trust service "${installation.pluginId}" because its process identity cannot be verified.`
          )
        }
        this.repository.updateSystemPluginRun(run.id, { status: 'stopping' })
        await terminateDetachedProcess(
          installation.pluginId,
          identity,
          this.hostProcess,
          this.inspectDetachedProcess,
          this.adoptedServiceStopTimeoutMs,
          this.adoptedServiceForceKillTimeoutMs
        )
        this.repository.updateSystemPluginRun(run.id, {
          status: 'stopped',
          pid: null,
          health: this.mergeServiceRunHealth(run.id, {
            rpcConnected: false,
            cleanupReason: reason
          })
        })
        this.repository.appendSystemPluginAudit({
          pluginId: installation.pluginId,
          installationId: installation.id,
          packageId: run.packageId,
          runId: run.id,
          actor: 'system',
          action: 'service.detached-cleanup',
          outcome: 'success',
          details: { reason }
        })
      } catch (error) {
        const failure = normalizeError(error)
        failures.push(failure)
        this.repository.updateSystemPluginRun(run.id, {
          status: 'failed',
          error: serializeError(failure)
        })
        this.repository.appendSystemPluginAudit({
          pluginId: installation.pluginId,
          installationId: installation.id,
          packageId: run.packageId,
          runId: run.id,
          actor: 'system',
          action: 'service.detached-cleanup',
          outcome: 'failure',
          details: { reason, error: serializeError(failure) }
        })
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `One or more detached Full Trust services for "${installation.pluginId}" could not be stopped safely.`
      )
    }
  }

  private async captureDetachedProcessIdentity(
    runId: string,
    pid: number,
    packageRecord: SystemPluginPackageRecord,
    runtimeRoot: string,
    serviceEntry: string,
    launchNonce: string
  ): Promise<void> {
    const observed = await this.inspectDetachedProcess(pid)
    if (!observed || observed.pid !== pid) {
      throw new Error('Detached Full Trust service process exited before its identity was captured.')
    }
    if (!pathsEqual(observed.executable, this.hostProcess.execPath, this.hostProcess.platform)) {
      throw new Error('Detached Full Trust service executable does not match the host executable.')
    }
    const identity: PersistedDetachedProcessIdentity = {
      schemaVersion: DETACHED_PROCESS_IDENTITY_VERSION,
      pid,
      executable: observed.executable,
      startToken: observed.startToken,
      launchNonce,
      revisionHash: `sha256:${packageRecord.contentHash}`,
      serviceEntry: resolve(runtimeRoot, serviceEntry)
    }
    this.repository.updateSystemPluginRun(runId, {
      health: this.mergeServiceRunHealth(runId, {
        processStarted: true,
        mode: 'detached',
        detachedProcessIdentity: identity
      })
    })
  }

  private async ensureRuntimeCompatibility(
    packageRecord: SystemPluginPackageRecord,
    manifest: SystemPluginV3Manifest,
    artifact: SystemPluginArtifactDescriptor
  ): Promise<SystemPluginPackageRecord> {
    const requiresAbiValidation = manifest.dependencies?.rebuildNativeModules === true
      || runtimeFingerprintContainsNativeModules(packageRecord.runtimeFingerprint)
    if (
      !requiresAbiValidation
      || isSystemPluginRuntimeCompatible(packageRecord.runtimeFingerprint, this.hostProcess)
    ) {
      return packageRecord
    }
    if (!packageRecord.sourceRequestId) {
      throw new Error('Native Full Trust runtime requires rebuild, but its confirmed install request is missing.')
    }
    const request = this.repository.getSystemPluginInstallRequest(packageRecord.sourceRequestId)
    if (!request || request.status !== 'confirmed-restart-required') {
      throw new Error('Native Full Trust runtime requires rebuild, but its confirmed install request is unavailable.')
    }
    this.repository.updateSystemPluginPackage(packageRecord.id, {
      status: 'installing',
      error: null
    })
    this.repository.appendSystemPluginAudit({
      pluginId: packageRecord.pluginId,
      packageId: packageRecord.id,
      requestId: request.id,
      actor: 'system',
      action: 'runtime.compatibility-rebuild-started',
      outcome: 'success',
      details: {
        previousFingerprint: packageRecord.runtimeFingerprint,
        target: currentRuntimeFingerprint(this.hostProcess, packageRecord.contentHash)
      }
    })
    try {
      const preparation = await this.preparePublishedPackage({
        artifact: { ...artifact, artifactDirectory: packageRecord.artifactPath },
        packageRecord,
        request
      })
      const updated = this.repository.updateSystemPluginPackage(packageRecord.id, {
        status: 'ready',
        runtimeFingerprint: preparation?.runtimeFingerprint
          ?? currentRuntimeFingerprint(this.hostProcess, packageRecord.contentHash),
        error: null,
        publishedAt: packageRecord.publishedAt ?? this.isoNow()
      })
      this.repository.appendSystemPluginAudit({
        pluginId: packageRecord.pluginId,
        packageId: packageRecord.id,
        requestId: request.id,
        actor: 'system',
        action: 'runtime.compatibility-rebuilt',
        outcome: 'success',
        details: { runtimeFingerprint: updated.runtimeFingerprint }
      })
      return updated
    } catch (error) {
      const details = serializeError(error)
      this.repository.updateSystemPluginPackage(packageRecord.id, {
        status: 'failed',
        error: details
      })
      this.repository.appendSystemPluginAudit({
        pluginId: packageRecord.pluginId,
        packageId: packageRecord.id,
        requestId: request.id,
        actor: 'system',
        action: 'runtime.compatibility-rebuild-failed',
        outcome: 'failure',
        details
      })
      throw normalizeError(error)
    }
  }

  private persistServiceSnapshot(
    runId: string,
    snapshot: Readonly<SystemPluginServiceSnapshot>
  ): void {
    const status = snapshot.status === 'running'
      ? 'ready'
      : snapshot.status === 'stopping'
        ? 'stopping'
        : snapshot.status === 'stopped' || snapshot.status === 'idle'
          ? 'stopped'
          : snapshot.status === 'failed'
            ? 'failed'
            : 'starting'
    this.repository.updateSystemPluginRun(runId, {
      status,
      pid: snapshot.pid,
      restartCount: snapshot.restartCount,
      exitCode: snapshot.lastExit?.exitCode ?? null,
      exitSignal: snapshot.lastExit?.signal ?? null,
      readyAt: status === 'ready' ? snapshot.readyAt ?? snapshot.startedAt ?? this.isoNow() : undefined,
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      health: this.mergeServiceRunHealth(runId, {
        processStarted: snapshot.startedAt !== null,
        ready: snapshot.ready,
        mode: snapshot.mode
      })
    })
  }

  private mergeServiceRunHealth(
    runId: string,
    patch: Record<string, unknown>
  ): Record<string, unknown> {
    const current = this.repository.getSystemPluginRun(runId)?.health
    const base = current && typeof current === 'object' && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {}
    return { ...base, ...patch }
  }

  private handleServiceEvent(
    installation: SystemPluginInstallationRecord,
    packageRecord: SystemPluginPackageRecord,
    runId: string,
    logPath: string | null,
    event: SystemPluginServiceEvent
  ): void {
    try {
      switch (event.type) {
        case 'started':
          this.repository.updateSystemPluginRun(runId, {
            status: 'ready',
            pid: event.pid,
            restartCount: event.restartCount,
            exitCode: null,
            exitSignal: null,
            readyAt: event.timestamp,
            lastHeartbeatAt: event.timestamp,
            health: this.mergeServiceRunHealth(runId, {
              processStarted: true,
              ready: false,
              mode: event.mode,
              executable: event.executable,
              args: [...event.args]
            })
          })
          break
        case 'ready':
          this.repository.updateSystemPluginRun(runId, {
            status: 'ready',
            pid: event.pid,
            readyAt: event.timestamp,
            lastHeartbeatAt: event.timestamp,
            health: this.mergeServiceRunHealth(runId, {
              processStarted: true,
              ready: true,
              mode: event.mode
            })
          })
          break
        case 'heartbeat':
          this.repository.updateSystemPluginRun(runId, {
            status: 'ready',
            pid: event.pid,
            lastHeartbeatAt: event.timestamp
          })
          break
        case 'exit':
          this.repository.updateSystemPluginRun(runId, {
            status: event.expected ? 'stopped' : 'starting',
            pid: null,
            exitCode: event.exitCode,
            exitSignal: event.signal
          })
          break
        case 'restart-scheduled':
          this.repository.updateSystemPluginRun(runId, {
            status: 'starting',
            pid: null,
            restartCount: event.restartCount
          })
          break
        case 'stop-requested':
        case 'kill-requested':
          this.repository.updateSystemPluginRun(runId, { status: 'stopping' })
          break
        case 'fatal':
          this.repository.updateSystemPluginRun(runId, {
            status: 'failed',
            pid: null,
            restartCount: event.restartCount,
            error: serializeError(event.error)
          })
          setTimeout(() => {
            void this.handleServiceFatal(installation, packageRecord, runId, event.error)
          }, 0)
          break
        case 'log':
          if (logPath) {
            const line = `[${event.timestamp}] [${event.stream}] ${redactSystemPluginLog(event.text)}`
            void appendFile(logPath, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
              .catch(() => undefined)
          }
          break
        case 'message':
          break
      }
    } catch {
      // A telemetry write must never change the child process lifecycle.
    }
  }

  private auditServiceRpc(
    installation: SystemPluginInstallationRecord,
    packageRecord: SystemPluginPackageRecord,
    runId: string,
    event: Readonly<SystemPluginServiceRpcAuditEvent>
  ): void {
    this.repository.appendSystemPluginAudit({
      pluginId: installation.pluginId,
      installationId: installation.id,
      packageId: packageRecord.id,
      runId,
      actor: 'system',
      action: 'service.rpc',
      outcome: event.outcome === 'success' ? 'success' : 'failure',
      details: {
        protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
        requestId: event.requestId,
        method: event.method,
        outcome: event.outcome,
        errorCode: event.errorCode,
        durationMs: event.durationMs
      }
    })
  }

  private handleServiceRpcLifecycle(
    runId: string,
    event: Readonly<SystemPluginServiceRpcLifecycleMessage>
  ): void {
    try {
      const timestamp = this.isoNow()
      const health = this.mergeServiceRunHealth(runId, {
        rpcConnected: true,
        rpcProtocolVersion: event.protocolVersion,
        rpcLastSignal: event.type === 'knowbook:service:ready' ? 'ready' : 'heartbeat'
      })
      this.repository.updateSystemPluginRun(runId, event.type === 'knowbook:service:ready'
        ? {
            status: 'ready',
            readyAt: timestamp,
            lastHeartbeatAt: timestamp,
            health
          }
        : {
            status: 'ready',
            lastHeartbeatAt: timestamp,
            health
          })
    } catch {
      // Reconnect telemetry cannot change the service transport lifecycle.
    }
  }

  private handleServiceRpcTransportError(
    installation: SystemPluginInstallationRecord,
    packageRecord: SystemPluginPackageRecord,
    runId: string,
    logPath: string | null,
    error: Error
  ): void {
    const details = {
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      name: String(error.name || 'Error').slice(0, 128),
      message: redactSystemPluginLog(error.message || 'Service RPC transport failed.')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 2_000)
    }
    try {
      this.repository.appendSystemPluginAudit({
        pluginId: installation.pluginId,
        installationId: installation.id,
        packageId: packageRecord.id,
        runId,
        actor: 'system',
        action: 'service.rpc-transport',
        outcome: 'failure',
        details
      })
    } catch {
      // Diagnostics cannot affect the transport.
    }
    if (logPath) {
      const line = `[${this.isoNow()}] [rpc] ${details.name}: ${details.message}`
      void appendFile(logPath, `${line}\n`, 'utf8').catch(() => undefined)
    }
  }

  private async handleServiceFatal(
    installation: SystemPluginInstallationRecord,
    packageRecord: SystemPluginPackageRecord,
    runId: string,
    error: Error
  ): Promise<void> {
    const current = this.repository.getSystemPluginInstallation(installation.id)
    if (!current || current.safeModeDisabled) return
    const runtime = this.active.get(installation.pluginId)
    let stopError: Error | null = null
    if (runtime?.service?.runId === runId) {
      try {
        await this.stopRuntime(installation.pluginId, false, 'disabled')
      } catch (cause) {
        stopError = normalizeError(cause)
      }
    }
    const details = stopError
      ? serializeErrors([error, stopError])
      : serializeError(error)
    this.repository.updateSystemPluginInstallation(installation.id, {
      enabled: false,
      safeModeDisabled: true,
      status: 'safe-mode-disabled',
      lastError: details
    })
    this.repository.appendSystemPluginAudit({
      pluginId: installation.pluginId,
      installationId: installation.id,
      packageId: packageRecord.id,
      runId,
      actor: 'system',
      action: 'service.restart-limit-reached',
      outcome: 'failure',
      details
    })
  }

  private async safeDisable(
    installation: SystemPluginInstallationRecord,
    error: Error
  ): Promise<void> {
    const details = serializeError(error)
    this.repository.updateSystemPluginInstallation(installation.id, {
      enabled: false,
      safeModeDisabled: true,
      status: 'safe-mode-disabled',
      pendingPackageId: null,
      lastError: details
    })
    this.repository.appendSystemPluginAudit({
      pluginId: installation.pluginId,
      installationId: installation.id,
      actor: 'system',
      action: 'activation.safe-mode-disabled',
      outcome: 'failure',
      details
    })
  }

  private async stopRuntime(
    pluginId: string,
    runBeforeQuit: boolean,
    finalStatus: 'disabled' | 'pending-restart',
    preserveDetached = false
  ): Promise<void> {
    const runtime = this.active.get(pluginId)
    if (!runtime) return
    const failures: Error[] = []
    if (runtime.hostRunId) {
      this.repository.updateSystemPluginRun(runtime.hostRunId, { status: 'stopping' })
    }
    if (runBeforeQuit) {
      try {
        await runtime.host.beforeQuit()
      } catch (error) {
        failures.push(normalizeError(error))
      }
    }
    try {
      await runtime.host.deactivate()
    } catch (error) {
      failures.push(normalizeError(error))
    }
    const preserveService = preserveDetached && runtime.service?.mode === 'detached'
    if (runtime.service && !preserveService) {
      try {
        this.repository.updateSystemPluginRun(runtime.service.runId, { status: 'stopping' })
        const snapshot = await runtime.service.controller.stop()
        this.persistServiceSnapshot(runtime.service.runId, snapshot)
      } catch (error) {
        failures.push(normalizeError(error))
      }
    }
    if (runtime.service?.rpcServer) {
      try {
        await runtime.service.rpcServer.close()
        if (preserveService) {
          this.repository.updateSystemPluginRun(runtime.service.runId, {
            health: this.mergeServiceRunHealth(runtime.service.runId, {
              rpcConnected: false,
              rpcDisconnectedAt: this.isoNow()
            })
          })
        }
      } catch (error) {
        failures.push(normalizeError(error))
      }
    }
    this.active.delete(pluginId)
    if (runtime.hostRunId) {
      this.repository.updateSystemPluginRun(runtime.hostRunId, failures.length > 0
        ? { status: 'failed', error: serializeErrors(failures) }
        : { status: 'stopped' })
    }
    const installation = this.repository.getSystemPluginInstallation(runtime.installationId)
    if (installation) {
      this.repository.updateSystemPluginInstallation(installation.id, {
        status: preserveService ? 'active' : finalStatus,
        ...(failures.length > 0 ? { lastError: serializeErrors(failures) } : {})
      })
    }
    this.repository.appendSystemPluginAudit({
      pluginId,
      installationId: runtime.installationId,
      packageId: runtime.packageId,
      runId: runtime.runId,
      actor: 'system',
      action: preserveService ? 'runtime.detached-preserved' : 'runtime.stopped',
      outcome: failures.length > 0 ? 'failure' : 'success',
      details: failures.length > 0
        ? serializeErrors(failures)
        : preserveService
          ? { serviceRunId: runtime.service?.runId ?? null }
          : null
    })
    if (failures.length > 0) {
      throw new AggregateError(failures, `System plugin "${pluginId}" did not stop cleanly.`)
    }
  }

  private async runDestroy(): Promise<void> {
    const failures: Error[] = []
    for (const pluginId of [...this.active.keys()]) {
      const installation = this.repository.getSystemPluginInstallationByPlugin(pluginId)
      try {
        await this.stopRuntime(
          pluginId,
          true,
          installation?.enabled ? 'pending-restart' : 'disabled',
          true
        )
      } catch (error) {
        failures.push(normalizeError(error))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Full Trust plugins failed to stop.')
    }
  }

  private async reinspectRequest(
    request: SystemPluginInstallRequest
  ): Promise<ReturnType<typeof asStagedDescriptor> extends infer T ? T : never> {
    if (request.status !== 'awaiting-confirmation') {
      throw new Error('System plugin install request was already resolved.')
    }
    if (request.confirmationVersion !== CONFIRMATION_VERSION) {
      throw new Error('System plugin install request confirmation contract is missing or outdated.')
    }
    if (!request.stagedArtifactPath || !request.computedArtifactSha256 || !request.manifestSnapshot) {
      throw new Error('System plugin install request does not have a complete staged artifact.')
    }
    this.assertManagedStagingPath(request.stagedArtifactPath, request.id)
    const descriptor = await inspectSystemPluginArtifact(request.stagedArtifactPath)
    if (
      descriptor.artifactSha256 !== request.artifactSha256
      || descriptor.artifactSha256 !== request.computedArtifactSha256
    ) {
      throw new Error('Staged Full Trust artifact hash changed after the confirmation request was created.')
    }
    if (
      descriptor.manifest.id !== request.pluginId
      || descriptor.manifest.version !== request.version
      || descriptor.manifest.publisher !== request.publisher
    ) {
      throw new Error('Staged Full Trust artifact identity changed after inspection.')
    }
    const storedManifest = normalizeSystemPluginV3Manifest(request.manifestSnapshot)
    if (!jsonEqual(storedManifest, descriptor.manifest)) {
      throw new Error('Staged Full Trust manifest changed after the confirmation request was created.')
    }
    if (!jsonEqual(request.dependencyPlan, descriptor.manifest.dependencies ?? null)) {
      throw new Error('Staged Full Trust dependency plan changed after inspection.')
    }
    if (!jsonEqual(request.systemPermissions, disclosureFor(descriptor.manifest))) {
      throw new Error('Staged Full Trust risk disclosure changed after inspection.')
    }
    return asStagedDescriptor(descriptor, request.stagedArtifactPath)
  }

  private async createSafetyBackup(packageRecord: SystemPluginPackageRecord): Promise<string> {
    await mkdir(this.backupRoot, { recursive: true })
    const timestamp = this.isoNow().replace(/[:.]/g, '-')
    const destination = join(
      this.backupRoot,
      `${timestamp}-${packageRecord.pluginId}-${packageRecord.contentHash.slice(0, 12)}.db`
    )
    await this.options.backupDatabase(destination)
    return destination
  }

  private async removeStagedArtifact(request: SystemPluginInstallRequest): Promise<void> {
    if (!request.stagedArtifactPath) return
    this.assertManagedStagingPath(request.stagedArtifactPath, request.id)
    await rm(request.stagedArtifactPath, { recursive: true, force: true })
  }

  private assertManagedStagingPath(path: string, requestId: string): void {
    const candidate = resolve(path)
    const expected = resolve(this.stagingRoot, requestId)
    if (candidate !== expected || !isPathInside(candidate, this.stagingRoot)) {
      throw new Error('Refusing to access an unmanaged Full Trust staging path.')
    }
  }

  private requireInstallRequest(requestId: string): SystemPluginInstallRequest {
    const request = this.repository.getSystemPluginInstallRequest(requestId)
    if (!request) throw new Error(`System plugin install request "${requestId}" does not exist.`)
    return request
  }

  private requireInstallation(pluginId: string): SystemPluginInstallationRecord {
    const installation = this.repository.getSystemPluginInstallationByPlugin(pluginId)
    if (!installation) throw new Error(`System plugin "${pluginId}" is not installed.`)
    return installation
  }

  private buildSummary(installation: SystemPluginInstallationRecord): SystemPluginManagerSummary {
    const runtime = this.active.get(installation.pluginId) ?? null
    const recentRuns = this.repository.listSystemPluginRuns(installation.id, 20)
    return {
      pluginId: installation.pluginId,
      installation,
      currentPackage: installation.currentPackageId
        ? this.repository.getSystemPluginPackage(installation.currentPackageId)
        : null,
      pendingPackage: installation.pendingPackageId
        ? this.repository.getSystemPluginPackage(installation.pendingPackageId)
        : null,
      lastRun: recentRuns[0] ?? null,
      recentRuns,
      osPersistence: this.repository.getSystemPluginOsPersistenceByPlugin(
        installation.pluginId
      ),
      runtime: runtime
        ? {
            packageId: runtime.packageId,
            runId: runtime.runId,
            status: runtime.host.status
          }
        : null
    }
  }

  private requireSummary(pluginId: string): SystemPluginManagerSummary {
    const summary = this.get(pluginId)
    if (!summary) throw new Error(`System plugin "${pluginId}" is not installed.`)
    return summary
  }

  private isoNow(): string {
    const value = this.now()
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error('SystemPluginManager clock returned an invalid Date.')
    }
    return value.toISOString()
  }

  private assertUsable(): void {
    if (this.destroyed) throw new Error('SystemPluginManager has been destroyed.')
  }
}

export class SystemPluginInstallCleanupError extends Error {
  constructor(
    readonly request: SystemPluginInstallRequest,
    cause: Error
  ) {
    super('System plugin request was cancelled, but its staging directory could not be cleaned.', {
      cause
    })
    this.name = 'SystemPluginInstallCleanupError'
  }
}

function createRestartableAdoptedServiceController(
  adopted: SystemPluginServiceController,
  spawned: SystemPluginServiceController
): SystemPluginServiceController {
  let current = adopted
  const selectForStart = (): SystemPluginServiceController => {
    if (
      current === adopted
      && current.snapshot.status !== 'running'
      && current.snapshot.status !== 'starting'
    ) {
      current = spawned
    }
    return current
  }
  return {
    get snapshot() {
      return current.snapshot
    },
    start() {
      return selectForStart().start()
    },
    startIfConfigured() {
      return selectForStart().startIfConfigured()
    },
    async stop() {
      return current.stop()
    }
  }
}

function createAdoptedDetachedServiceController(
  manifest: SystemPluginV3Manifest,
  packageRecord: SystemPluginPackageRecord,
  run: SystemPluginRunRecord,
  identity: PersistedDetachedProcessIdentity,
  hostProcess: NodeJS.Process,
  inspector: SystemPluginDetachedProcessInspector,
  stopTimeoutMs: number,
  forceKillTimeoutMs: number
): SystemPluginServiceController {
  if (manifest.background?.mode !== 'detached' || run.pid === null) {
    throw new Error('Only a live detached service run can be adopted.')
  }
  let snapshot: Readonly<SystemPluginServiceSnapshot> = Object.freeze({
    pluginId: manifest.id,
    version: manifest.version,
    revisionHash: `sha256:${packageRecord.contentHash}`,
    mode: 'detached',
    status: 'running',
    pid: run.pid,
    ready: true,
    restartCount: run.restartCount,
    startedAt: run.startedAt,
    readyAt: run.readyAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    lastExit: null
  })
  return {
    get snapshot() {
      return snapshot
    },
    start() {
      return snapshot
    },
    startIfConfigured() {
      return snapshot
    },
    async stop() {
      const pid = snapshot.pid
      await terminateDetachedProcess(
        manifest.id,
        identity,
        hostProcess,
        inspector,
        stopTimeoutMs,
        forceKillTimeoutMs
      )
      const stoppedAt = new Date().toISOString()
      snapshot = Object.freeze({
        ...snapshot,
        status: 'stopped',
        pid: null,
        lastExit: {
          pid,
          exitCode: null,
          signal: 'SIGTERM' as NodeJS.Signals,
          expected: true,
          timestamp: stoppedAt
        }
      })
      return snapshot
    }
  }
}

async function terminateDetachedProcess(
  pluginId: string,
  identity: PersistedDetachedProcessIdentity,
  hostProcess: NodeJS.Process,
  inspector: SystemPluginDetachedProcessInspector,
  stopTimeoutMs: number,
  forceKillTimeoutMs: number
): Promise<void> {
  const before = await inspector(identity.pid)
  if (before && !detachedProcessIdentitiesEqual(identity, before, hostProcess.platform)) {
    throw new Error(
      `Refusing to stop detached Full Trust service "${pluginId}" after PID identity changed.`
    )
  }
  if (!before) return
  try {
    hostProcess.kill(identity.pid, 'SIGTERM')
  } catch (error) {
    if (!isMissingProcessError(error)) throw error
  }
  if (await waitForDetachedProcessExit(inspector, identity, stopTimeoutMs, hostProcess.platform)) {
    return
  }
  const beforeForceKill = await inspector(identity.pid)
  if (beforeForceKill && detachedProcessIdentitiesEqual(
    identity,
    beforeForceKill,
    hostProcess.platform
  )) {
    try {
      hostProcess.kill(identity.pid, 'SIGKILL')
    } catch (error) {
      if (!isMissingProcessError(error)) throw error
    }
  }
  if (!await waitForDetachedProcessExit(
    inspector,
    identity,
    forceKillTimeoutMs,
    hostProcess.platform
  )) {
    throw new Error(
      `Detached Full Trust service "${pluginId}" did not exit after forced termination.`
    )
  }
}

async function waitForDetachedProcessExit(
  inspector: SystemPluginDetachedProcessInspector,
  identity: PersistedDetachedProcessIdentity,
  timeoutMs: number,
  platform: NodeJS.Platform
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const observed = await inspector(identity.pid)
    if (!observed || !detachedProcessIdentitiesEqual(identity, observed, platform)) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await delay(Math.min(25, remaining))
  }
}

async function inspectDetachedProcess(
  pid: number,
  platform: NodeJS.Platform
): Promise<SystemPluginDetachedProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Detached Full Trust service PID is invalid.')
  }
  if (platform === 'linux') {
    try {
      const [linkedExecutable, processStat] = await Promise.all([
        readlink(`/proc/${pid}/exe`),
        readFile(`/proc/${pid}/stat`, 'utf8')
      ])
      const executable = await realpath(linkedExecutable).catch(() => linkedExecutable)
      const commandEnd = processStat.lastIndexOf(')')
      const fields = commandEnd >= 0
        ? processStat.slice(commandEnd + 2).trim().split(/\s+/)
        : []
      const startToken = fields[19]
      if (!startToken) throw new Error('Linux process start token is unavailable.')
      return { pid, executable, startToken: `linux:${startToken}` }
    } catch (error) {
      if (isMissingProcessError(error) || isNodeErrorWithCode(error, 'ENOENT')) return null
      throw error
    }
  }
  if (platform === 'win32') {
    const script = [
      `$item = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
      'if ($null -eq $item) { exit 3 }',
      "$value = [pscustomobject]@{ executable = $item.ExecutablePath; startToken = $item.CreationDate.ToUniversalTime().Ticks.ToString() }",
      '$value | ConvertTo-Json -Compress'
    ].join('; ')
    try {
      const stdout = await execFileText('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script
      ])
      const parsed = JSON.parse(stdout) as { executable?: unknown; startToken?: unknown }
      if (typeof parsed.executable !== 'string' || typeof parsed.startToken !== 'string') {
        throw new Error('Windows process identity response is incomplete.')
      }
      return {
        pid,
        executable: parsed.executable,
        startToken: `windows:${parsed.startToken}`
      }
    } catch (error) {
      if (isExecFileExitCode(error, 3)) return null
      throw error
    }
  }
  if (platform === 'darwin') {
    try {
      const [executable, startedAt] = await Promise.all([
        execFileText('/bin/ps', ['-p', String(pid), '-o', 'comm=']),
        execFileText('/bin/ps', ['-p', String(pid), '-o', 'lstart='])
      ])
      const normalizedExecutable = executable.trim()
      const startToken = startedAt.trim()
      if (!normalizedExecutable || !startToken) return null
      return {
        pid,
        executable: normalizedExecutable,
        startToken: `darwin:${startToken}`
      }
    } catch (error) {
      if (isExecFileExitCode(error, 1)) return null
      throw error
    }
  }
  return null
}

function execFileText(executable: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(executable, args, { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolvePromise(stdout)
    })
  })
}

function parsePersistedDetachedProcessIdentity(
  health: SystemPluginRunRecord['health']
): PersistedDetachedProcessIdentity | null {
  if (!health || typeof health !== 'object' || Array.isArray(health)) return null
  const candidate = (health as Record<string, unknown>).detachedProcessIdentity
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const value = candidate as Record<string, unknown>
  if (
    value.schemaVersion !== DETACHED_PROCESS_IDENTITY_VERSION
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.executable !== 'string'
    || !value.executable.trim()
    || typeof value.startToken !== 'string'
    || !value.startToken.trim()
    || typeof value.launchNonce !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(value.launchNonce)
    || typeof value.revisionHash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(value.revisionHash)
    || typeof value.serviceEntry !== 'string'
    || !value.serviceEntry.trim()
  ) {
    return null
  }
  return {
    schemaVersion: DETACHED_PROCESS_IDENTITY_VERSION,
    pid: value.pid as number,
    executable: value.executable,
    startToken: value.startToken,
    launchNonce: value.launchNonce,
    revisionHash: value.revisionHash,
    serviceEntry: value.serviceEntry
  }
}

function detachedProcessIdentitiesEqual(
  expected: Pick<SystemPluginDetachedProcessIdentity, 'pid' | 'executable' | 'startToken'>,
  observed: SystemPluginDetachedProcessIdentity,
  platform: NodeJS.Platform
): boolean {
  return expected.pid === observed.pid
    && pathsEqual(expected.executable, observed.executable, platform)
    && expected.startToken === observed.startToken
}

function pathsEqual(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

function isLiveOsPersistenceRecord(record: SystemPluginOsPersistenceRecord): boolean {
  return record.status !== 'removed' && record.status !== 'cancelled'
}

function isRegisteredOsPersistenceRecord(record: SystemPluginOsPersistenceRecord): boolean {
  return record.status === 'registered'
    || record.status === 'requires-approval'
    || record.status === 'disabled'
}

function isMacMainAppPersistenceRecord(record: SystemPluginOsPersistenceRecord): boolean {
  if (record.method !== 'electron-login-item') return false
  const descriptor = record.descriptor
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return false
  const value = descriptor as Record<string, unknown>
  if (value.platform !== 'darwin') return false
  const registration = value.registration
  if (!registration || typeof registration !== 'object' || Array.isArray(registration)) return false
  const query = (registration as Record<string, unknown>).query
  return Boolean(
    query
    && typeof query === 'object'
    && !Array.isArray(query)
    && (query as Record<string, unknown>).type === 'mainAppService'
  )
}

function normalizeNonNegativeDuration(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const duration = value ?? fallback
  if (!Number.isSafeInteger(duration) || duration < 0 || duration > 60_000) {
    throw new Error(`${label} must be an integer between 0 and 60000 milliseconds.`)
  }
  return duration
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return false
    throw error
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}

function isExecFileExitCode(error: unknown, code: number): boolean {
  return error instanceof Error
    && 'code' in error
    && Number((error as NodeJS.ErrnoException).code) === code
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ESRCH'
}

function redactSystemPluginLog(value: string): string {
  return value
    .slice(0, 65_536)
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}

async function defaultPreparePublishedPackage(
  input: PreparePublishedSystemPluginPackageInput
): Promise<PreparedPublishedSystemPluginPackage> {
  if (input.artifact.manifest.dependencies) {
    throw new Error(
      'System plugin declares dependencies, but no preparePublishedPackage dependency installer was configured.'
    )
  }
  return { runtimeFingerprint: defaultRuntimeFingerprint(input.artifact.artifactSha256) }
}

function defaultRuntimeFingerprint(artifactSha256: string): Record<string, unknown> {
  return currentRuntimeFingerprint(process, artifactSha256)
}

function currentRuntimeFingerprint(
  hostProcess: NodeJS.Process,
  artifactSha256: string
): Record<string, unknown> {
  return {
    artifactSha256,
    platform: hostProcess.platform,
    arch: hostProcess.arch,
    node: hostProcess.versions.node,
    electron: hostProcess.versions.electron ?? null,
    modules: hostProcess.versions.modules ?? null
  }
}

function assertOsPersistenceReviewIdentity(
  record: SystemPluginOsPersistenceRecord,
  registration: FullTrustOsPersistenceRegistrationInput,
  method: FullTrustOsPersistenceAdapter['method']
): void {
  if (
    record.pluginId !== registration.pluginId
    || record.revisionHash !== registration.revisionHash
    || record.serviceId !== registration.serviceId
    || record.method !== method
    || record.command.executable !== registration.command.executable
    || record.command.args.length !== registration.command.args.length
    || record.command.args.some((argument, index) => (
      argument !== registration.command.args[index]
    ))
  ) {
    throw new Error('Full Trust OS persistence command changed after user review.')
  }
}

function normalizeManagedOsPersistenceStatus(
  status: string
): SystemPluginOsPersistenceRecord['status'] {
  if (
    status === 'registered'
    || status === 'requires-approval'
    || status === 'disabled'
    || status === 'mismatch'
  ) {
    return status
  }
  throw new Error(`Full Trust OS persistence could not be verified (${status}).`)
}

function runtimeFingerprintContainsNativeModules(fingerprint: unknown): boolean {
  if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) return false
  const probe = (fingerprint as Record<string, unknown>).nativeModuleProbe
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return false
  const moduleCount = (probe as Record<string, unknown>).moduleCount
  return Number.isSafeInteger(moduleCount) && (moduleCount as number) > 0
}

export function isSystemPluginRuntimeCompatible(
  fingerprint: unknown,
  hostProcess: NodeJS.Process = process
): boolean {
  if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) return false
  const record = fingerprint as Record<string, unknown>
  return record.platform === hostProcess.platform
    && record.arch === hostProcess.arch
    && record.electron === (hostProcess.versions.electron ?? null)
    && record.modules === (hostProcess.versions.modules ?? null)
}

function disclosureFor(manifest: SystemPluginV3Manifest): string[] {
  return [FULL_TRUST_DISCLOSURE, ...manifest.riskDeclarations]
    .sort((left, right) => left.localeCompare(right, 'en'))
}

function manifestFromPackage(packageRecord: SystemPluginPackageRecord): SystemPluginV3Manifest {
  const manifest = normalizeSystemPluginV3Manifest(packageRecord.manifestSnapshot)
  if (manifest.publisher !== packageRecord.publisher) {
    throw new Error('System plugin package manifest publisher does not match its package record.')
  }
  return manifest
}

/**
 * Dependency installation happens in a mutable runtime copy so the exact
 * artifact confirmed by the user remains content-addressed and immutable.
 */
export function getSystemPluginRuntimeRoot(packageRecord: SystemPluginPackageRecord): string {
  const fingerprint = packageRecord.runtimeFingerprint
  if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) {
    return packageRecord.artifactPath
  }
  const runtimeRoot = (fingerprint as Record<string, unknown>).runtimeRoot
  if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim() || runtimeRoot.includes('\0')) {
    return packageRecord.artifactPath
  }
  return resolve(runtimeRoot)
}

async function verifyPublishedPackage(
  packageRecord: SystemPluginPackageRecord,
  staged: SystemPluginArtifactDescriptor
): Promise<void> {
  const published = await inspectSystemPluginArtifact(packageRecord.artifactPath)
  if (
    published.artifactSha256 !== staged.artifactSha256
    || published.artifactSha256 !== packageRecord.contentHash
    || published.manifest.id !== packageRecord.pluginId
  ) {
    throw new Error('Existing published Full Trust package failed immutable artifact verification.')
  }
}

function assertDescriptorIdentity(
  staged: SystemPluginArtifactDescriptor,
  inspected: SystemPluginArtifactDescriptor
): void {
  if (
    staged.artifactSha256 !== inspected.artifactSha256
    || !jsonEqual(staged.manifest, inspected.manifest)
    || !jsonEqual(staged.files, inspected.files)
  ) {
    throw new Error('System plugin source changed while it was being copied to staging.')
  }
}

function asStagedDescriptor(
  descriptor: SystemPluginArtifactDescriptor,
  stagingDirectory: string
): SystemPluginArtifactDescriptor & { stagingDirectory: string } {
  return { ...descriptor, stagingDirectory }
}

function resolveRequiredPath(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`SystemPluginManager ${label} must be a non-empty path.`)
  }
  return resolve(value)
}

function resolveServiceEnvironment(
  input: SystemPluginManagerOptions['serviceEnvironment'],
  pluginId: string
): NodeJS.ProcessEnv {
  const environment = typeof input === 'function' ? input(pluginId) : input
  if (environment === undefined) return {}
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('System plugin service environment provider returned an invalid value.')
  }
  return { ...environment }
}

function isPathInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function serializeError(error: unknown): Record<string, unknown> {
  const normalized = normalizeError(error)
  return {
    name: normalized.name.slice(0, 200),
    message: normalized.message.slice(0, 4_000),
    ...(normalized.stack ? { stack: normalized.stack.slice(0, 16_000) } : {})
  }
}

function serializeErrors(errors: Error[]): Record<string, unknown> {
  return {
    name: 'AggregateError',
    message: errors.map((error) => error.message).join('; ').slice(0, 4_000),
    errors: errors.map(serializeError)
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function createRendererLifecyclePlaceholder(): SystemPluginHostController {
  let status: SystemPluginRuntimeStatus = 'idle'
  return {
    get status() {
      return status
    },
    async activate() {
      status = 'active'
      return {
        entryPath: '<renderer>',
        format: 'esm' as const,
        health: { ok: true, message: 'Renderer activation is coordinated by the host window.' }
      }
    },
    async healthCheck() {
      return { ok: status === 'active' }
    },
    async beforeQuit() {},
    async deactivate() {
      status = 'stopped'
    }
  }
}

function createCompositeLifecycleHost(
  hosts: SystemPluginHostController[]
): SystemPluginHostController {
  let status: SystemPluginRuntimeStatus = 'idle'
  let activeCount = 0
  return {
    get status() {
      return status
    },
    async activate() {
      status = 'activating'
      const results: SystemPluginActivationResult[] = []
      try {
        for (const host of hosts) {
          results.push(await host.activate())
          activeCount += 1
        }
        status = 'active'
        return {
          entryPath: results.map((result) => result.entryPath).join(';'),
          format: results.some((result) => result.format === 'esm') ? 'esm' : 'cjs',
          health: {
            ok: results.every((result) => result.health.ok),
            message: results.map((result) => result.health.message).filter(Boolean).join('; ') || undefined
          }
        }
      } catch (error) {
        status = 'failed'
        for (const host of hosts.slice(0, activeCount).reverse()) {
          await host.deactivate().catch(() => undefined)
        }
        activeCount = 0
        throw error
      }
    },
    async healthCheck() {
      const checks = await Promise.all(hosts.slice(0, activeCount).map((host) => host.healthCheck()))
      return {
        ok: checks.every((check) => check.ok),
        message: checks.map((check) => check.message).filter(Boolean).join('; ') || undefined
      }
    },
    async beforeQuit() {
      const failures: Error[] = []
      for (const host of hosts.slice(0, activeCount).reverse()) {
        await host.beforeQuit().catch((error) => {
          failures.push(normalizeError(error))
        })
      }
      if (failures.length > 0) throw new AggregateError(failures, 'System plugin component beforeQuit failed.')
    },
    async deactivate() {
      status = 'deactivating'
      const failures: Error[] = []
      for (const host of hosts.slice(0, activeCount).reverse()) {
        await host.deactivate().catch((error) => {
          failures.push(normalizeError(error))
        })
      }
      activeCount = 0
      status = failures.length > 0 ? 'failed' : 'stopped'
      if (failures.length > 0) throw new AggregateError(failures, 'System plugin component cleanup failed.')
    }
  }
}
