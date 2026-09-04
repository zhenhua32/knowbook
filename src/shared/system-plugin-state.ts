import type { PluginJsonValue } from './plugin-platform'
import type { SystemPluginPackageManager } from './system-plugin'

export type { SystemPluginPackageManager } from './system-plugin'

export type SystemPluginPackageStatus = 'staged' | 'installing' | 'ready' | 'failed'

export interface SystemPluginPackageRecord {
  id: string
  pluginId: string
  version: string
  publisher: string
  contentHash: string
  artifactPath: string
  manifestSnapshot: PluginJsonValue
  fileManifest: PluginJsonValue
  runtimeFingerprint: PluginJsonValue | null
  status: SystemPluginPackageStatus
  sourceRequestId: string | null
  error: PluginJsonValue | null
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

export interface CreateSystemPluginPackageInput {
  id?: string
  pluginId: string
  version: string
  publisher: string
  contentHash: string
  artifactPath: string
  manifestSnapshot: unknown
  fileManifest: unknown
  sourceRequestId?: string | null
  status?: SystemPluginPackageStatus
}

export interface UpdateSystemPluginPackageInput {
  artifactPath?: string
  runtimeFingerprint?: unknown | null
  status?: SystemPluginPackageStatus
  error?: unknown | null
  publishedAt?: string | null
}

export type SystemPluginInstallationStatus =
  | 'disabled'
  | 'pending-restart'
  | 'starting'
  | 'active'
  | 'failed'
  | 'safe-mode-disabled'
  | 'uninstall-pending'

export interface SystemPluginInstallationRecord {
  id: string
  pluginId: string
  enabled: boolean
  autoStart: boolean
  safeModeDisabled: boolean
  status: SystemPluginInstallationStatus
  currentPackageId: string | null
  pendingPackageId: string | null
  lastError: PluginJsonValue | null
  backupPath: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateSystemPluginInstallationInput {
  id?: string
  pluginId: string
  enabled?: boolean
  autoStart?: boolean
  safeModeDisabled?: boolean
  status?: SystemPluginInstallationStatus
  currentPackageId?: string | null
  pendingPackageId?: string | null
  backupPath?: string | null
}

export interface UpdateSystemPluginInstallationInput {
  enabled?: boolean
  autoStart?: boolean
  safeModeDisabled?: boolean
  status?: SystemPluginInstallationStatus
  currentPackageId?: string | null
  pendingPackageId?: string | null
  lastError?: unknown | null
  backupPath?: string | null
}

export type SystemPluginRunComponent = 'main' | 'renderer' | 'service' | 'detached'
export type SystemPluginRunStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

export interface SystemPluginRunRecord {
  id: string
  pluginId: string
  installationId: string
  packageId: string
  component: SystemPluginRunComponent
  status: SystemPluginRunStatus
  pid: number | null
  exitCode: number | null
  exitSignal: string | null
  restartCount: number
  health: PluginJsonValue | null
  error: PluginJsonValue | null
  logPath: string | null
  startedAt: string
  readyAt: string | null
  lastHeartbeatAt: string | null
  stoppedAt: string | null
  updatedAt: string
}

export interface CreateSystemPluginRunInput {
  id?: string
  installationId: string
  packageId: string
  component: SystemPluginRunComponent
  pid?: number | null
  restartCount?: number
  logPath?: string | null
}

export interface UpdateSystemPluginRunInput {
  status?: SystemPluginRunStatus
  pid?: number | null
  exitCode?: number | null
  exitSignal?: string | null
  restartCount?: number
  health?: unknown | null
  error?: unknown | null
  readyAt?: string | null
  lastHeartbeatAt?: string | null
  stoppedAt?: string | null
}

export type SystemPluginAuditActor = 'user' | 'assistant' | 'system' | 'plugin'
export type SystemPluginAuditOutcome = 'success' | 'failure' | 'denied'

export interface SystemPluginAuditRecord {
  id: string
  pluginId: string
  installationId: string | null
  packageId: string | null
  requestId: string | null
  runId: string | null
  actor: SystemPluginAuditActor
  action: string
  outcome: SystemPluginAuditOutcome
  details: PluginJsonValue | null
  createdAt: string
}

export interface AppendSystemPluginAuditInput {
  id?: string
  pluginId: string
  installationId?: string | null
  packageId?: string | null
  requestId?: string | null
  runId?: string | null
  actor: SystemPluginAuditActor
  action: string
  outcome: SystemPluginAuditOutcome
  details?: unknown | null
}

export type SystemPluginDependencyJobKind = 'install' | 'build' | 'native-rebuild'
export type SystemPluginDependencyJobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface SystemPluginDependencyJobRecord {
  id: string
  pluginId: string
  packageId: string
  installationId: string | null
  requestId: string | null
  kind: SystemPluginDependencyJobKind
  packageManager: SystemPluginPackageManager
  command: string[]
  status: SystemPluginDependencyJobStatus
  pid: number | null
  exitCode: number | null
  logPath: string | null
  error: PluginJsonValue | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export interface CreateSystemPluginDependencyJobInput {
  id?: string
  packageId: string
  installationId?: string | null
  requestId?: string | null
  kind: SystemPluginDependencyJobKind
  packageManager: SystemPluginPackageManager
  command: string[]
  logPath?: string | null
}

export interface UpdateSystemPluginDependencyJobInput {
  status?: SystemPluginDependencyJobStatus
  pid?: number | null
  exitCode?: number | null
  logPath?: string | null
  error?: unknown | null
  startedAt?: string | null
  finishedAt?: string | null
}

export type SystemPluginCrashMarkerState = 'armed' | 'ready' | 'failed' | 'recovered'

export interface SystemPluginCrashMarkerRecord {
  id: string
  pluginId: string
  installationId: string
  packageId: string
  runId: string | null
  phase: string
  state: SystemPluginCrashMarkerState
  error: PluginJsonValue | null
  recovery: PluginJsonValue | null
  createdAt: string
  updatedAt: string
  clearedAt: string | null
}

export interface CreateSystemPluginCrashMarkerInput {
  id?: string
  installationId: string
  packageId: string
  runId?: string | null
  phase: string
}

export interface UpdateSystemPluginCrashMarkerInput {
  state?: SystemPluginCrashMarkerState
  error?: unknown | null
  recovery?: unknown | null
  clearedAt?: string | null
}

export type SystemPluginOsPersistenceStatus =
  | 'awaiting-confirmation'
  | 'registered'
  | 'requires-approval'
  | 'disabled'
  | 'cancelled'
  | 'removed'
  | 'mismatch'
  | 'failed'

export interface SystemPluginOsPersistenceCommand {
  executable: string
  args: string[]
}

export interface SystemPluginOsPersistenceRecord {
  id: string
  pluginId: string
  installationId: string
  packageId: string
  revisionHash: string
  serviceId: string
  method: 'electron-login-item' | 'linux-autostart-desktop'
  command: SystemPluginOsPersistenceCommand
  descriptor: PluginJsonValue
  status: SystemPluginOsPersistenceStatus
  error: PluginJsonValue | null
  createdAt: string
  resolvedAt: string | null
  updatedAt: string
}

export interface UpsertSystemPluginOsPersistenceInput {
  id?: string
  installationId: string
  packageId: string
  revisionHash: string
  serviceId: string
  method: SystemPluginOsPersistenceRecord['method']
  command: SystemPluginOsPersistenceCommand
  descriptor: unknown
  status?: SystemPluginOsPersistenceStatus
}

export interface UpdateSystemPluginOsPersistenceInput {
  packageId?: string
  revisionHash?: string
  serviceId?: string
  method?: SystemPluginOsPersistenceRecord['method']
  command?: SystemPluginOsPersistenceCommand
  descriptor?: unknown
  status?: SystemPluginOsPersistenceStatus
  error?: unknown | null
  resolvedAt?: string | null
}

export interface UpdateSystemPluginInstallRequestStateInput {
  stagedArtifactPath?: string | null
  computedArtifactSha256?: string | null
  manifestSnapshot?: unknown | null
  dependencyPlan?: unknown | null
  confirmationVersion?: number | null
  installationId?: string | null
  error?: unknown | null
}

export interface SystemPluginSummary {
  pluginId: string
  name: string
  description: string
  publisher: string
  enabled: boolean
  safeModeDisabled: boolean
  status: SystemPluginInstallationStatus
  currentVersion: string | null
  currentArtifactSha256: string | null
  pendingVersion: string | null
  pendingArtifactSha256: string | null
  riskDeclarations: string[]
  lastError: PluginJsonValue | null
  restartRequired: boolean
  updatedAt: string
  runtimeStatus: string | null
  backupPath: string | null
  availablePackages: Array<{
    packageId: string
    version: string
    artifactSha256: string
    status: SystemPluginPackageStatus
    createdAt: string
  }>
  dependencyJobs: SystemPluginDependencyJobRecord[]
  lastRun: SystemPluginRunRecord | null
  recentRuns: SystemPluginRunRecord[]
  osPersistence: SystemPluginOsPersistenceRecord | null
  dataPath: string
  logPath: string
}

export interface SetSystemPluginEnabledInput {
  pluginId: string
  enabled: boolean
}

export interface SystemPluginMutationInput {
  pluginId: string
}

export interface RollbackSystemPluginInput {
  pluginId: string
  packageId?: string
}

export interface ResolveSystemPluginOsPersistenceInput {
  recordId: string
  pluginId: string
  revisionHash: string
  decision: 'confirm' | 'cancel'
  acknowledgeSystemStartup: boolean
}
