import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import semver from 'semver'
import type {
  PluginGrantSet,
  PluginJsonValue,
  PluginPlatformScope,
  PluginRevisionPackage,
  PluginV2Manifest
} from '@shared/plugin-platform'
import type {
  ResolveSystemPluginInstallRequestInput,
  SystemPluginInstallRequest,
  SystemPluginInstallRequestInput
} from '@shared/plugin-trust'
import type {
  AppendSystemPluginAuditInput,
  CreateSystemPluginCrashMarkerInput,
  CreateSystemPluginDependencyJobInput,
  CreateSystemPluginInstallationInput,
  CreateSystemPluginPackageInput,
  CreateSystemPluginRunInput,
  SystemPluginAuditRecord,
  SystemPluginCrashMarkerRecord,
  SystemPluginDependencyJobRecord,
  SystemPluginInstallationRecord,
  SystemPluginOsPersistenceRecord,
  SystemPluginPackageRecord,
  SystemPluginRunRecord,
  UpsertSystemPluginOsPersistenceInput,
  UpdateSystemPluginCrashMarkerInput,
  UpdateSystemPluginDependencyJobInput,
  UpdateSystemPluginInstallationInput,
  UpdateSystemPluginInstallRequestStateInput,
  UpdateSystemPluginOsPersistenceInput,
  UpdateSystemPluginPackageInput,
  UpdateSystemPluginRunInput
} from '@shared/system-plugin-state'
import { getPluginPlatformScopeKey, validatePluginPlatformScope } from './scope'

export type PluginDefinitionSource =
  | 'builtin'
  | 'dynamic'
  | 'marketplace'
  | 'system'
  | 'legacy'

export type PluginPersistenceScope = 'session-preview' | 'workspace'
export type PluginStaticCheckStatus = 'passed' | 'warning' | 'failed'
export type PluginRunStatus =
  | 'staging'
  | 'active'
  | 'draining'
  | 'stopped'
  | 'failed'

export interface PluginDefinitionRecord {
  id: string
  name: string
  source: PluginDefinitionSource
  persistenceScope: PluginPersistenceScope
  createdSessionId: string | null
  currentRevisionId: string | null
  pendingRevisionId: string | null
  activeRunId: string | null
  createdAt: string
  updatedAt: string
}

export interface CreatePluginDefinitionInput {
  id: string
  name: string
  source: PluginDefinitionSource
  persistenceScope: PluginPersistenceScope
  createdSessionId?: string | null
}

export interface PluginRevisionRecord {
  id: string
  pluginId: string
  contentHash: string
  previousRevisionId: string | null
  manifest: PluginV2Manifest
  requestedPermissions: PluginV2Manifest['permissions']
  apiVersion: string
  stateSchemaVersion: number | null
  sizeBytes: number
  staticCheckStatus: PluginStaticCheckStatus
  staticCheckDiagnostics: PluginJsonValue
  generatedBySessionId: string | null
  createdAt: string
}

export interface CreatePluginRevisionInput {
  package: PluginRevisionPackage
  previousRevisionId?: string | null
  staticCheckStatus: PluginStaticCheckStatus
  staticCheckDiagnostics?: PluginJsonValue
  generatedBySessionId?: string | null
}

export interface PluginInstallationRecord {
  id: string
  pluginId: string
  scope: PluginPlatformScope
  enabled: boolean
  currentRevisionId: string | null
  pendingRevisionId: string | null
  activeRunId: string | null
  currentGrantSetId: string | null
  pendingGrantSetId: string | null
  lastError: PluginJsonValue | null
  quarantined: boolean
  violationCount: number
  quarantineReason: PluginJsonValue | null
  quarantinedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreatePluginInstallationInput {
  id: string
  pluginId: string
  scope: PluginPlatformScope
  enabled?: boolean
}

export interface PluginRunRecord {
  id: string
  pluginId: string
  revisionId: string
  installationId: string | null
  grantSetId: string
  scope: PluginPlatformScope
  epoch: number | null
  status: PluginRunStatus
  error: PluginJsonValue | null
  startedAt: string
  readyAt: string | null
  stoppedAt: string | null
  updatedAt: string
}

export interface CreatePluginRunInput {
  id: string
  pluginId: string
  revisionId: string
  installationId?: string | null
  grantSetId: string
  scope: PluginPlatformScope
}

export interface PluginRunCommitResult {
  run: PluginRunRecord
  previousRunId: string | null
}

export interface PluginStateMigrationInput {
  fromRevisionId: string
  fromSchemaVersion: number
  toSchemaVersion: number
  values: Readonly<Record<string, PluginJsonValue>>
}

export interface PluginStateSnapshotRecord {
  fromRevisionId: string
  toRevisionId: string
  schemaVersion: number
  values: Record<string, PluginJsonValue>
  createdAt: string
}

export interface PluginRunRecoveryResult {
  failedRunIds: string[]
  stoppedRunIds: string[]
}

export interface AppendPluginLogInput {
  id: string
  pluginId: string
  revisionId?: string | null
  runId?: string | null
  level: 'debug' | 'info' | 'warning' | 'error'
  event: string
  message: string
  data?: PluginJsonValue | null
}

export interface PluginLogRecord {
  id: string
  pluginId: string
  revisionId: string | null
  runId: string | null
  level: 'debug' | 'info' | 'warning' | 'error'
  event: string
  message: string
  data: PluginJsonValue | null
  createdAt: string
}

type DefinitionRow = {
  id: string
  name: string
  source: PluginDefinitionSource
  persistence_scope: PluginPersistenceScope
  created_session_id: string | null
  current_revision_id: string | null
  pending_revision_id: string | null
  active_run_id: string | null
  created_at: string
  updated_at: string
}

type RevisionRow = {
  id: string
  plugin_id: string
  content_hash: string
  previous_revision_id: string | null
  manifest_json: string
  requested_permissions_json: string
  api_version: string
  state_schema_version: number | null
  size_bytes: number
  static_check_status: PluginStaticCheckStatus
  static_check_json: string
  generated_by_session_id: string | null
  created_at: string
}

type GrantRow = {
  id: string
  plugin_id: string
  revision_id: string
  installation_id: string | null
  scope_kind: PluginPlatformScope['kind']
  workspace_id: string | null
  session_id: string | null
  grants_json: string
  status: 'active' | 'revoked'
  created_at: string
  expires_at: string | null
}

type InstallationRow = {
  id: string
  plugin_id: string
  scope_kind: PluginPlatformScope['kind']
  workspace_id: string | null
  session_id: string | null
  enabled: number
  current_revision_id: string | null
  pending_revision_id: string | null
  active_run_id: string | null
  current_grant_set_id: string | null
  pending_grant_set_id: string | null
  last_error_json: string | null
  quarantined: number
  violation_count: number
  quarantine_reason_json: string | null
  quarantined_at: string | null
  created_at: string
  updated_at: string
}

type RunRow = {
  id: string
  plugin_id: string
  revision_id: string
  installation_id: string | null
  grant_set_id: string
  scope_kind: PluginPlatformScope['kind']
  workspace_id: string | null
  session_id: string | null
  epoch: number | null
  status: PluginRunStatus
  error_json: string | null
  started_at: string
  ready_at: string | null
  stopped_at: string | null
  updated_at: string
}

type LogRow = {
  id: string
  plugin_id: string
  revision_id: string | null
  run_id: string | null
  level: PluginLogRecord['level']
  event: string
  message: string
  data_json: string | null
  created_at: string
}

type SystemPluginInstallRequestRow = {
  id: string
  plugin_id: string
  name: string
  version: string
  publisher: string
  artifact_sha256: string
  system_permissions_json: string
  reason: string
  requested_by: 'user' | 'assistant'
  status: SystemPluginInstallRequest['status']
  restart_required: number
  staged_artifact_path: string | null
  computed_artifact_sha256: string | null
  manifest_snapshot_json: string | null
  dependency_plan_json: string | null
  confirmation_version: number | null
  installation_id: string | null
  error_json: string | null
  created_at: string
  resolved_at: string | null
}

type SystemPluginPackageRow = {
  id: string
  plugin_id: string
  version: string
  publisher: string
  content_hash: string
  artifact_path: string
  manifest_snapshot_json: string
  file_manifest_json: string
  runtime_fingerprint_json: string | null
  status: SystemPluginPackageRecord['status']
  source_request_id: string | null
  error_json: string | null
  created_at: string
  updated_at: string
  published_at: string | null
}

type SystemPluginInstallationRow = {
  id: string
  plugin_id: string
  enabled: number
  auto_start: number
  safe_mode_disabled: number
  status: SystemPluginInstallationRecord['status']
  current_package_id: string | null
  pending_package_id: string | null
  last_error_json: string | null
  backup_path: string | null
  created_at: string
  updated_at: string
}

type SystemPluginRunRow = {
  id: string
  plugin_id: string
  installation_id: string
  package_id: string
  component: SystemPluginRunRecord['component']
  status: SystemPluginRunRecord['status']
  pid: number | null
  exit_code: number | null
  exit_signal: string | null
  restart_count: number
  health_json: string | null
  error_json: string | null
  log_path: string | null
  started_at: string
  ready_at: string | null
  last_heartbeat_at: string | null
  stopped_at: string | null
  updated_at: string
}

type SystemPluginAuditRow = {
  id: string
  plugin_id: string
  installation_id: string | null
  package_id: string | null
  request_id: string | null
  run_id: string | null
  actor: SystemPluginAuditRecord['actor']
  action: string
  outcome: SystemPluginAuditRecord['outcome']
  details_json: string | null
  created_at: string
}

type SystemPluginDependencyJobRow = {
  id: string
  plugin_id: string
  package_id: string
  installation_id: string | null
  request_id: string | null
  kind: SystemPluginDependencyJobRecord['kind']
  package_manager: SystemPluginDependencyJobRecord['packageManager']
  command_json: string
  status: SystemPluginDependencyJobRecord['status']
  pid: number | null
  exit_code: number | null
  log_path: string | null
  error_json: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

type SystemPluginCrashMarkerRow = {
  id: string
  plugin_id: string
  installation_id: string
  package_id: string
  run_id: string | null
  phase: string
  state: SystemPluginCrashMarkerRecord['state']
  error_json: string | null
  recovery_json: string | null
  created_at: string
  updated_at: string
  cleared_at: string | null
}

type SystemPluginOsPersistenceRow = {
  id: string
  plugin_id: string
  installation_id: string
  package_id: string
  revision_hash: string
  service_id: string
  method: SystemPluginOsPersistenceRecord['method']
  command_json: string
  descriptor_json: string
  status: SystemPluginOsPersistenceRecord['status']
  error_json: string | null
  created_at: string
  resolved_at: string | null
  updated_at: string
}

export interface SqlitePluginPlatformRepositoryOptions {
  now?: () => Date
}

/** Transactional metadata repository; source objects stay in PluginRevisionStore. */
export class SqlitePluginPlatformRepository {
  private readonly now: () => Date

  constructor(
    private readonly db: Database.Database,
    options: SqlitePluginPlatformRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  createDefinition(input: CreatePluginDefinitionInput): PluginDefinitionRecord {
    const id = normalizeId(input.id, 'Plugin id')
    const name = normalizeName(input.name)
    const source = normalizeDefinitionSource(input.source)
    const persistenceScope = normalizePersistenceScope(input.persistenceScope)
    const createdSessionId = normalizeNullableId(input.createdSessionId, 'Plugin creation session id')
    if (persistenceScope === 'session-preview' && !createdSessionId) {
      throw new Error('Session-preview plugins require a creation session id.')
    }
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO plugin_definitions (
        id, name, source, persistence_scope, created_session_id,
        current_revision_id, pending_revision_id, active_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(id, name, source, persistenceScope, createdSessionId, now, now)
    return this.requireDefinition(id)
  }

  getDefinition(pluginId: string): PluginDefinitionRecord | null {
    const id = normalizeId(pluginId, 'Plugin id')
    const row = this.db.prepare('SELECT * FROM plugin_definitions WHERE id = ?').get(id) as DefinitionRow | undefined
    return row ? mapDefinition(row) : null
  }

  listDefinitions(): PluginDefinitionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM plugin_definitions ORDER BY created_at ASC, id ASC
    `).all() as DefinitionRow[]
    return rows.map(mapDefinition)
  }

  deleteDefinition(pluginId: string): string[] {
    const definition = this.requireDefinition(pluginId)
    const revisionIds = this.listRevisions(definition.id).map((revision) => revision.id)
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare('DELETE FROM plugin_definitions WHERE id = ?').run(definition.id)
      if (result.changes !== 1) {
        throw new Error(`Plugin definition "${definition.id}" could not be removed.`)
      }
    })
    transaction()
    return revisionIds
  }

  /**
   * Legacy assistant builds created dynamic plugins as session-only previews.
   * The current workspace-first model keeps the original session id as
   * provenance, but removes the ownership boundary so any conversation in the
   * workspace can inspect, revise, and activate the plugin.
   */
  promoteDefinitionToWorkspace(pluginId: string): PluginDefinitionRecord {
    const definition = this.requireDefinition(pluginId)
    if (definition.persistenceScope === 'workspace') return definition
    const now = this.now().toISOString()
    this.db.prepare(`
      UPDATE plugin_definitions
      SET persistence_scope = 'workspace', updated_at = ?
      WHERE id = ?
    `).run(now, definition.id)
    return this.requireDefinition(definition.id)
  }

  createRevision(input: CreatePluginRevisionInput): PluginRevisionRecord {
    const revisionPackage = input.package
    validateRevisionPackageMetadata(revisionPackage)
    const pluginId = revisionPackage.manifest.id
    const previousRevisionId = input.previousRevisionId
      ? normalizeRevisionId(input.previousRevisionId)
      : null
    const staticCheckStatus = normalizeStaticCheckStatus(input.staticCheckStatus)
    const diagnostics = input.staticCheckDiagnostics ?? []
    const generatedBySessionId = normalizeNullableId(
      input.generatedBySessionId,
      'Plugin generation session id'
    )
    const manifestJson = JSON.stringify(revisionPackage.manifest)
    const permissionsJson = JSON.stringify(revisionPackage.manifest.permissions)
    const staticCheckJson = stringifyJson(diagnostics, 'Plugin static check diagnostics')
    const now = this.now().toISOString()

    const transaction = this.db.transaction(() => {
      const definition = this.requireDefinition(pluginId)
      if (previousRevisionId) {
        const previous = this.getRevision(previousRevisionId)
        if (!previous || previous.pluginId !== pluginId) {
          throw new Error('Previous plugin revision must belong to the same plugin.')
        }
      }

      const existing = this.getRevision(revisionPackage.revisionId)
      if (existing) {
        if (
          existing.pluginId !== pluginId
          || existing.contentHash !== revisionPackage.contentHash
          || JSON.stringify(existing.manifest) !== manifestJson
        ) {
          throw new Error(`Immutable plugin revision "${revisionPackage.revisionId}" conflicts with stored metadata.`)
        }
      } else {
        this.db.prepare(`
          INSERT INTO plugin_revisions (
            id, plugin_id, content_hash, previous_revision_id, manifest_json,
            requested_permissions_json, api_version, state_schema_version,
            size_bytes, static_check_status, static_check_json,
            generated_by_session_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          revisionPackage.revisionId,
          pluginId,
          revisionPackage.contentHash,
          previousRevisionId,
          manifestJson,
          permissionsJson,
          revisionPackage.manifest.apiVersion,
          revisionPackage.manifest.stateSchemaVersion ?? null,
          revisionPackage.sizeBytes,
          staticCheckStatus,
          staticCheckJson,
          generatedBySessionId,
          now
        )
      }

      this.db.prepare(`
        UPDATE plugin_definitions
        SET pending_revision_id = ?, updated_at = ?
        WHERE id = ?
      `).run(revisionPackage.revisionId, now, definition.id)
      return this.requireRevision(revisionPackage.revisionId)
    })

    return transaction()
  }

  getRevision(revisionId: string): PluginRevisionRecord | null {
    const id = normalizeRevisionId(revisionId)
    const row = this.db.prepare('SELECT * FROM plugin_revisions WHERE id = ?').get(id) as RevisionRow | undefined
    return row ? mapRevision(row) : null
  }

  listRevisions(pluginId: string): PluginRevisionRecord[] {
    const id = normalizeId(pluginId, 'Plugin id')
    const rows = this.db.prepare(`
      SELECT * FROM plugin_revisions
      WHERE plugin_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(id) as RevisionRow[]
    return rows.map(mapRevision)
  }

  listRevisionIds(): string[] {
    const rows = this.db.prepare(`
      SELECT id FROM plugin_revisions ORDER BY id ASC
    `).all() as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  listRevisionGarbageCandidates(options: {
    retainPerPlugin?: number
    olderThanMs?: number
  } = {}): string[] {
    const retainPerPlugin = options.retainPerPlugin ?? 50
    const olderThanMs = options.olderThanMs ?? 30 * 24 * 60 * 60 * 1_000
    if (!Number.isSafeInteger(retainPerPlugin) || retainPerPlugin < 1 || retainPerPlugin > 10_000) {
      throw new Error('Plugin revision retention count is invalid.')
    }
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
      throw new Error('Plugin revision retention age is invalid.')
    }
    const cutoff = this.now().getTime() - olderThanMs
    const candidates: string[] = []
    for (const definition of this.listDefinitions()) {
      const revisions = this.listRevisions(definition.id)
      for (const revision of revisions.slice(retainPerPlugin)) {
        if (Date.parse(revision.createdAt) <= cutoff && !this.isRevisionReferenced(revision.id)) {
          candidates.push(revision.id)
        }
      }
    }
    return candidates.sort()
  }

  deleteRevisionIfUnreferenced(revisionId: string): boolean {
    const id = normalizeRevisionId(revisionId)
    const transaction = this.db.transaction(() => {
      if (this.isRevisionReferenced(id)) {
        return false
      }
      const result = this.db.prepare('DELETE FROM plugin_revisions WHERE id = ?').run(id)
      return result.changes > 0
    })
    return transaction()
  }

  ensureInstallation(input: CreatePluginInstallationInput): PluginInstallationRecord {
    const id = normalizeId(input.id, 'Plugin installation id', 500)
    const pluginId = normalizeId(input.pluginId, 'Plugin id')
    validatePluginPlatformScope(input.scope)
    const definition = this.requireDefinition(pluginId)
    assertInstallationScope(definition, input.scope)
    const existing = this.getInstallationForScope(pluginId, input.scope)
    if (existing) {
      return existing
    }
    const scope = scopeColumns(input.scope)
    const enabled = input.enabled === undefined ? true : Boolean(input.enabled)
    const now = this.now().toISOString()
    try {
      this.db.prepare(`
        INSERT INTO plugin_installations (
          id, plugin_id, scope_kind, workspace_id, session_id, enabled,
          current_revision_id, pending_revision_id, active_run_id,
          current_grant_set_id, pending_grant_set_id, last_error_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        id,
        pluginId,
        scope.kind,
        scope.workspaceId,
        scope.sessionId,
        enabled ? 1 : 0,
        now,
        now
      )
    } catch (error) {
      const concurrent = this.getInstallationForScope(pluginId, input.scope)
      if (concurrent) {
        return concurrent
      }
      throw error
    }
    return this.requireInstallation(id)
  }

  prepareWorkspacePromotionInstallation(input: {
    id: string
    pluginId: string
    workspaceId: string
    sessionId: string
  }): PluginInstallationRecord {
    const id = normalizeId(input.id, 'Plugin installation id', 500)
    const pluginId = normalizeId(input.pluginId, 'Plugin id')
    const workspaceId = normalizeId(input.workspaceId, 'Workspace id', 500)
    const sessionId = normalizeId(input.sessionId, 'Assistant session id', 500)
    const definition = this.requireDefinition(pluginId)
    if (
      definition.persistenceScope !== 'session-preview'
      || definition.createdSessionId !== sessionId
    ) {
      throw new Error('Only the owning session can prepare a preview plugin for workspace installation.')
    }
    const scope: PluginPlatformScope = { kind: 'workspace', workspaceId }
    const existing = this.getInstallationForScope(pluginId, scope)
    if (existing) {
      return existing
    }
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO plugin_installations (
        id, plugin_id, scope_kind, workspace_id, session_id, enabled,
        current_revision_id, pending_revision_id, active_run_id,
        current_grant_set_id, pending_grant_set_id, last_error_json,
        created_at, updated_at
      ) VALUES (?, ?, 'workspace', ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(id, pluginId, workspaceId, now, now)
    return this.requireInstallation(id)
  }

  finalizeWorkspacePromotion(
    installationId: string,
    sessionId: string
  ): PluginInstallationRecord {
    const installation = this.requireInstallation(installationId)
    const normalizedSessionId = normalizeId(sessionId, 'Assistant session id', 500)
    const now = this.now().toISOString()
    const transaction = this.db.transaction(() => {
      const definition = this.requireDefinition(installation.pluginId)
      const current = this.requireInstallation(installation.id)
      if (
        current.scope.kind !== 'workspace'
        || !current.currentRevisionId
        || !current.activeRunId
        || definition.persistenceScope !== 'session-preview'
        || definition.createdSessionId !== normalizedSessionId
      ) {
        throw new Error('Workspace plugin promotion is not ready to commit.')
      }
      this.db.prepare(`
        UPDATE plugin_definitions
        SET persistence_scope = 'workspace', updated_at = ?
        WHERE id = ?
      `).run(now, definition.id)
      this.db.prepare(`
        UPDATE plugin_installations SET enabled = 1, updated_at = ? WHERE id = ?
      `).run(now, current.id)
      return this.requireInstallation(current.id)
    })
    return transaction()
  }

  getInstallation(installationId: string): PluginInstallationRecord | null {
    const id = normalizeId(installationId, 'Plugin installation id', 500)
    const row = this.db.prepare('SELECT * FROM plugin_installations WHERE id = ?').get(id) as
      | InstallationRow
      | undefined
    return row ? mapInstallation(row) : null
  }

  getInstallationForScope(
    pluginId: string,
    scope: PluginPlatformScope
  ): PluginInstallationRecord | null {
    const id = normalizeId(pluginId, 'Plugin id')
    validatePluginPlatformScope(scope)
    const columns = scopeColumns(scope)
    const row = this.db.prepare(`
      SELECT * FROM plugin_installations
      WHERE plugin_id = ? AND scope_kind = ?
        AND ifnull(workspace_id, '') = ifnull(?, '')
        AND ifnull(session_id, '') = ifnull(?, '')
      LIMIT 1
    `).get(id, columns.kind, columns.workspaceId, columns.sessionId) as InstallationRow | undefined
    return row ? mapInstallation(row) : null
  }

  listWorkspaceInstallations(
    workspaceId: string,
    options: { enabledOnly?: boolean } = {}
  ): PluginInstallationRecord[] {
    const normalizedWorkspaceId = normalizeId(workspaceId, 'Workspace id', 500)
    const rows = this.db.prepare(`
      SELECT * FROM plugin_installations
      WHERE scope_kind = 'workspace' AND workspace_id = ?
        ${options.enabledOnly ? 'AND enabled = 1' : ''}
      ORDER BY created_at ASC, id ASC
    `).all(normalizedWorkspaceId) as InstallationRow[]
    return rows.map(mapInstallation)
  }

  setInstallationEnabled(installationId: string, enabled: boolean): PluginInstallationRecord {
    const installation = this.requireInstallation(installationId)
    if (enabled && installation.quarantined) {
      throw new Error('Quarantined plugin installation must be explicitly recovered before enabling.')
    }
    const now = this.now().toISOString()
    this.db.prepare(`
      UPDATE plugin_installations
      SET enabled = ?, active_run_id = CASE WHEN ? = 0 THEN NULL ELSE active_run_id END,
          updated_at = ?
      WHERE id = ?
    `).run(enabled ? 1 : 0, enabled ? 1 : 0, now, installation.id)
    return this.requireInstallation(installation.id)
  }

  recordInstallationViolation(
    installationId: string,
    reason: PluginJsonValue,
    threshold = 3
  ): PluginInstallationRecord {
    const installation = this.requireInstallation(installationId)
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 100) {
      throw new Error('Plugin quarantine threshold is invalid.')
    }
    const reasonJson = stringifyJson(reason, 'Plugin quarantine reason')
    const now = this.now().toISOString()
    this.db.prepare(`
      UPDATE plugin_installations
      SET violation_count = violation_count + 1,
          quarantined = CASE WHEN violation_count + 1 >= ? THEN 1 ELSE quarantined END,
          enabled = CASE WHEN violation_count + 1 >= ? THEN 0 ELSE enabled END,
          active_run_id = CASE WHEN violation_count + 1 >= ? THEN NULL ELSE active_run_id END,
          quarantine_reason_json = CASE WHEN violation_count + 1 >= ? THEN ? ELSE quarantine_reason_json END,
          quarantined_at = CASE WHEN violation_count + 1 >= ? THEN ? ELSE quarantined_at END,
          last_error_json = ?, updated_at = ?
      WHERE id = ?
    `).run(threshold, threshold, threshold, threshold, reasonJson, threshold, now, reasonJson, now, installation.id)
    return this.requireInstallation(installation.id)
  }

  clearInstallationQuarantine(installationId: string): PluginInstallationRecord {
    const installation = this.requireInstallation(installationId)
    const now = this.now().toISOString()
    this.db.prepare(`
      UPDATE plugin_installations
      SET quarantined = 0, violation_count = 0, quarantine_reason_json = NULL,
          quarantined_at = NULL, last_error_json = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, installation.id)
    return this.requireInstallation(installation.id)
  }

  recordInstallationError(
    installationId: string,
    error: PluginJsonValue
  ): PluginInstallationRecord {
    const installation = this.requireInstallation(installationId)
    const errorJson = stringifyJson(error, 'Plugin installation error')
    const now = this.now().toISOString()
    this.db.prepare(`
      UPDATE plugin_installations
      SET active_run_id = NULL, last_error_json = ?, updated_at = ?
      WHERE id = ?
    `).run(errorJson, now, installation.id)
    return this.requireInstallation(installation.id)
  }

  createGrantSet(input: PluginGrantSet): PluginGrantSet {
    const id = normalizeId(input.id, 'Plugin grant set id')
    const pluginId = normalizeId(input.pluginId, 'Plugin id')
    const revisionId = normalizeRevisionId(input.revisionId)
    const installationId = normalizeNullableId(input.installationId, 'Plugin installation id')
    validatePluginPlatformScope(input.scope)
    const createdAt = normalizeDate(input.createdAt, 'Plugin grant creation time')
    const expiresAt = input.expiresAt
      ? normalizeDate(input.expiresAt, 'Plugin grant expiration time')
      : null
    if (expiresAt && Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new Error('Plugin grant expiration must be after its creation time.')
    }
    const grantsJson = stringifyJson(input.grants as unknown as PluginJsonValue, 'Plugin grants')
    const scope = scopeColumns(input.scope)

    const transaction = this.db.transaction(() => {
      const revision = this.requireRevision(revisionId)
      if (revision.pluginId !== pluginId) {
        throw new Error('Plugin grant revision does not belong to the plugin.')
      }
      if (installationId) {
        const installation = this.requireInstallation(installationId)
        if (
          installation.pluginId !== pluginId
          || getPluginPlatformScopeKey(installation.scope) !== getPluginPlatformScopeKey(input.scope)
        ) {
          throw new Error('Plugin grant installation does not match its plugin and scope.')
        }
      }
      this.db.prepare(`
        INSERT INTO plugin_grants (
          id, plugin_id, revision_id, installation_id,
          scope_kind, workspace_id, session_id,
          grants_json, status, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
      `).run(
        id,
        pluginId,
        revisionId,
        installationId,
        scope.kind,
        scope.workspaceId,
        scope.sessionId,
        grantsJson,
        createdAt,
        expiresAt
      )
      return this.requireGrantSet(id)
    })
    return transaction()
  }

  getGrantSet(grantSetId: string): PluginGrantSet | null {
    const id = normalizeId(grantSetId, 'Plugin grant set id')
    const row = this.db.prepare(`
      SELECT * FROM plugin_grants WHERE id = ? AND status = 'active'
    `).get(id) as GrantRow | undefined
    return row ? mapGrantSet(row) : null
  }

  revokeGrantSet(grantSetId: string): boolean {
    const id = normalizeId(grantSetId, 'Plugin grant set id')
    const result = this.db.prepare(`
      UPDATE plugin_grants
      SET status = 'revoked', revoked_at = ?
      WHERE id = ? AND status = 'active'
    `).run(this.now().toISOString(), id)
    return result.changes > 0
  }

  createRun(input: CreatePluginRunInput): PluginRunRecord {
    const id = normalizeId(input.id, 'Plugin run id', 500)
    const pluginId = normalizeId(input.pluginId, 'Plugin id')
    const revisionId = normalizeRevisionId(input.revisionId)
    const grantSetId = normalizeId(input.grantSetId, 'Plugin grant set id')
    const installationId = normalizeNullableId(input.installationId, 'Plugin installation id')
    validatePluginPlatformScope(input.scope)
    const scope = scopeColumns(input.scope)
    const now = this.now().toISOString()

    const transaction = this.db.transaction(() => {
      const revision = this.requireRevision(revisionId)
      if (revision.pluginId !== pluginId) {
        throw new Error('Plugin run revision does not belong to the plugin.')
      }
      if (revision.staticCheckStatus === 'failed') {
        throw new Error('Plugin revisions with failed static checks cannot run.')
      }
      const grant = this.requireGrantSet(grantSetId)
      if (
        grant.pluginId !== pluginId
        || grant.revisionId !== revisionId
        || getPluginPlatformScopeKey(grant.scope) !== getPluginPlatformScopeKey(input.scope)
      ) {
        throw new Error('Plugin run grant does not match its plugin revision and scope.')
      }
      const installation = installationId ? this.requireInstallation(installationId) : null
      if (installation?.quarantined) {
        throw new Error('Quarantined plugin installation must be explicitly recovered before activation.')
      }
      if (
        installation
        && (
          installation.pluginId !== pluginId
          || getPluginPlatformScopeKey(installation.scope) !== getPluginPlatformScopeKey(input.scope)
          || (grant.installationId !== undefined && grant.installationId !== installation.id)
        )
      ) {
        throw new Error('Plugin run installation does not match its plugin, grant, and scope.')
      }
      if (!installation && grant.installationId !== undefined) {
        throw new Error('Plugin run must retain the installation bound to its grant.')
      }
      if (grant.expiresAt && Date.parse(grant.expiresAt) <= this.now().getTime()) {
        throw new Error('Plugin run grant has expired.')
      }

      this.db.prepare(`
        INSERT INTO plugin_runs (
          id, plugin_id, revision_id, installation_id, grant_set_id,
          scope_kind, workspace_id, session_id, epoch, status, error_json,
          started_at, ready_at, stopped_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'staging', NULL, ?, NULL, NULL, ?)
      `).run(
        id,
        pluginId,
        revisionId,
        installationId,
        grantSetId,
        scope.kind,
        scope.workspaceId,
        scope.sessionId,
        now,
        now
      )
      this.db.prepare(`
        UPDATE plugin_definitions SET pending_revision_id = ?, updated_at = ? WHERE id = ?
      `).run(revisionId, now, pluginId)
      if (installation) {
        this.db.prepare(`
          UPDATE plugin_installations
          SET pending_revision_id = ?, pending_grant_set_id = ?,
              last_error_json = NULL, updated_at = ?
          WHERE id = ?
        `).run(revisionId, grantSetId, now, installation.id)
      }
      return this.requireRun(id)
    })
    return transaction()
  }

  markRunActive(
    runId: string,
    epoch: number,
    expectedPreviousRunId?: string | null,
    stateMigration?: PluginStateMigrationInput
  ): PluginRunCommitResult {
    const id = normalizeId(runId, 'Plugin run id', 500)
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new Error('Plugin run epoch must be a positive integer.')
    }
    const now = this.now().toISOString()

    const transaction = this.db.transaction((): PluginRunCommitResult => {
      const run = this.requireRun(id)
      if (run.status !== 'staging') {
        throw new Error(`Plugin run "${id}" cannot activate from ${run.status} status.`)
      }
      const definition = this.requireDefinition(run.pluginId)
      const installation = run.installationId
        ? this.requireInstallation(run.installationId)
        : null
      const previousRunId = installation ? installation.activeRunId : definition.activeRunId
      if (expectedPreviousRunId !== undefined && previousRunId !== expectedPreviousRunId) {
        throw new Error('Persisted active run pointer diverged from the kernel namespace.')
      }
      if (stateMigration) {
        if (!installation) {
          throw new Error('Plugin state migration requires an installation.')
        }
        this.applyStateMigration(installation, run, stateMigration, now)
      }
      if (previousRunId && previousRunId !== id) {
        this.db.prepare(`
          UPDATE plugin_runs SET status = 'draining', updated_at = ?
          WHERE id = ? AND status = 'active'
        `).run(now, previousRunId)
      }
      this.db.prepare(`
        UPDATE plugin_runs
        SET epoch = ?, status = 'active', ready_at = ?, updated_at = ?
        WHERE id = ?
      `).run(epoch, now, now, id)
      this.db.prepare(`
        UPDATE plugin_definitions
        SET current_revision_id = ?, pending_revision_id = NULL,
            active_run_id = ?, updated_at = ?
        WHERE id = ?
      `).run(run.revisionId, id, now, run.pluginId)
      if (installation) {
        this.db.prepare(`
          UPDATE plugin_installations
          SET current_revision_id = ?, pending_revision_id = NULL,
              active_run_id = ?, current_grant_set_id = ?,
              pending_grant_set_id = NULL, last_error_json = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(run.revisionId, id, run.grantSetId, now, installation.id)
      }
      return { run: this.requireRun(id), previousRunId }
    })
    return transaction()
  }

  markRunFailed(runId: string, error: PluginJsonValue): PluginRunRecord {
    const id = normalizeId(runId, 'Plugin run id', 500)
    const errorJson = stringifyJson(error, 'Plugin run error')
    const now = this.now().toISOString()
    const transaction = this.db.transaction(() => {
      const run = this.requireRun(id)
      if (run.status === 'stopped' || run.status === 'failed') {
        throw new Error(`Plugin run "${id}" is already terminal.`)
      }
      this.db.prepare(`
        UPDATE plugin_runs
        SET status = 'failed', error_json = ?, stopped_at = ?, updated_at = ?
        WHERE id = ?
      `).run(errorJson, now, now, id)
      this.db.prepare(`
        UPDATE plugin_definitions
        SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
            pending_revision_id = ?, updated_at = ?
        WHERE id = ?
      `).run(id, run.revisionId, now, run.pluginId)
      if (run.installationId) {
        this.db.prepare(`
          UPDATE plugin_installations
          SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
              pending_revision_id = ?, pending_grant_set_id = ?,
              last_error_json = ?, updated_at = ?
          WHERE id = ?
        `).run(id, run.revisionId, run.grantSetId, errorJson, now, run.installationId)
      }
      return this.requireRun(id)
    })
    return transaction()
  }

  markRunStopped(runId: string): PluginRunRecord {
    const id = normalizeId(runId, 'Plugin run id', 500)
    const now = this.now().toISOString()
    const transaction = this.db.transaction(() => {
      const run = this.requireRun(id)
      if (run.status !== 'stopped') {
        this.db.prepare(`
          UPDATE plugin_runs SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, id)
        this.db.prepare(`
          UPDATE plugin_definitions
          SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
              updated_at = ?
          WHERE id = ?
        `).run(id, now, run.pluginId)
        if (run.installationId) {
          this.db.prepare(`
            UPDATE plugin_installations
            SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
                updated_at = ?
            WHERE id = ?
          `).run(id, now, run.installationId)
        }
      }
      return this.requireRun(id)
    })
    return transaction()
  }

  getRun(runId: string): PluginRunRecord | null {
    const id = normalizeId(runId, 'Plugin run id', 500)
    const row = this.db.prepare('SELECT * FROM plugin_runs WHERE id = ?').get(id) as RunRow | undefined
    return row ? mapRun(row) : null
  }

  listRunsByStatus(statuses: readonly PluginRunStatus[]): PluginRunRecord[] {
    if (statuses.length === 0) {
      return []
    }
    const normalized = statuses.map(normalizeRunStatus)
    const placeholders = normalized.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT * FROM plugin_runs
      WHERE status IN (${placeholders})
      ORDER BY started_at ASC, id ASC
    `).all(...normalized) as RunRow[]
    return rows.map(mapRun)
  }

  listPluginRuns(pluginId: string, limit = 100): PluginRunRecord[] {
    const id = normalizeId(pluginId, 'Plugin id')
    const normalizedLimit = normalizeListLimit(limit, 'Plugin run list limit')
    const rows = this.db.prepare(`
      SELECT * FROM plugin_runs
      WHERE plugin_id = ?
      ORDER BY started_at DESC, id ASC
      LIMIT ?
    `).all(id, normalizedLimit) as RunRow[]
    return rows.map(mapRun)
  }

  wasRevisionActivated(pluginId: string, revisionId: string): boolean {
    const id = normalizeId(pluginId, 'Plugin id')
    const revision = normalizeRevisionId(revisionId)
    const row = this.db.prepare(`
      SELECT 1
      FROM plugin_runs
      WHERE plugin_id = ? AND revision_id = ? AND ready_at IS NOT NULL
      LIMIT 1
    `).get(id, revision) as { 1: number } | undefined
    return Boolean(row)
  }

  /** Marks process-owned runs terminal before a new host instance starts. */
  recoverInterruptedRuns(): PluginRunRecoveryResult {
    const interrupted = this.listRunsByStatus(['staging', 'active', 'draining'])
    if (interrupted.length === 0) {
      return { failedRunIds: [], stoppedRunIds: [] }
    }
    const now = this.now().toISOString()
    const failedRunIds = interrupted
      .filter((run) => run.status === 'staging')
      .map((run) => run.id)
    const stoppedRunIds = interrupted
      .filter((run) => run.status !== 'staging')
      .map((run) => run.id)
    const failure = JSON.stringify({
      name: 'PluginHostRestarted',
      message: 'Plugin activation was interrupted by a KnowBook restart.'
    })

    const transaction = this.db.transaction(() => {
      const updateFailed = this.db.prepare(`
        UPDATE plugin_runs
        SET status = 'failed', error_json = ?, stopped_at = ?, updated_at = ?
        WHERE id = ? AND status = 'staging'
      `)
      for (const runId of failedRunIds) {
        updateFailed.run(failure, now, now, runId)
      }

      const updateStopped = this.db.prepare(`
        UPDATE plugin_runs
        SET status = 'stopped', stopped_at = COALESCE(stopped_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('active', 'draining')
      `)
      for (const runId of stoppedRunIds) {
        updateStopped.run(now, now, runId)
      }
      this.db.prepare(`
        UPDATE plugin_definitions
        SET active_run_id = NULL, updated_at = ?
        WHERE active_run_id IS NOT NULL
      `).run(now)
      const updateFailedInstallation = this.db.prepare(`
        UPDATE plugin_installations
        SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
            pending_revision_id = ?, pending_grant_set_id = ?,
            last_error_json = ?, updated_at = ?
        WHERE id = ?
      `)
      const clearStoppedInstallation = this.db.prepare(`
        UPDATE plugin_installations
        SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
            updated_at = ?
        WHERE id = ?
      `)
      for (const run of interrupted) {
        if (!run.installationId) {
          continue
        }
        if (run.status === 'staging') {
          updateFailedInstallation.run(
            run.id,
            run.revisionId,
            run.grantSetId,
            failure,
            now,
            run.installationId
          )
        } else {
          clearStoppedInstallation.run(run.id, now, run.installationId)
        }
      }
    })
    transaction()
    return { failedRunIds, stoppedRunIds }
  }

  readPluginState(
    pluginId: string,
    scope: PluginPlatformScope,
    key: string
  ): { value: PluginJsonValue; schemaVersion: number; updatedAt: string } | null {
    const id = normalizeId(pluginId, 'Plugin id')
    validatePluginPlatformScope(scope)
    const stateKey = normalizeStateKey(key)
    const scopedStateKey = `${getPluginPlatformScopeKey(scope)}::${encodeURIComponent(stateKey)}`
    const row = this.db.prepare(`
      SELECT value_json, schema_version, updated_at
      FROM plugin_state
      WHERE plugin_id = ? AND scope_key = ?
    `).get(id, scopedStateKey) as {
      value_json: string
      schema_version: number
      updated_at: string
    } | undefined
    return row
      ? {
          value: parseJson(row.value_json, 'Plugin state'),
          schemaVersion: row.schema_version,
          updatedAt: row.updated_at
        }
      : null
  }

  writePluginState(
    pluginId: string,
    scope: PluginPlatformScope,
    key: string,
    value: PluginJsonValue,
    schemaVersion = 1
  ): { value: PluginJsonValue; schemaVersion: number; updatedAt: string } {
    const id = normalizeId(pluginId, 'Plugin id')
    this.requireDefinition(id)
    validatePluginPlatformScope(scope)
    const stateKey = normalizeStateKey(key)
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 1_000_000) {
      throw new Error('Plugin state schema version is invalid.')
    }
    const valueJson = stringifyJson(value, 'Plugin state')
    const scopedStateKey = `${getPluginPlatformScopeKey(scope)}::${encodeURIComponent(stateKey)}`
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO plugin_state (
        plugin_id, scope_key, value_json, schema_version, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, scope_key)
      DO UPDATE SET
        value_json = excluded.value_json,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at
    `).run(
      id,
      scopedStateKey,
      valueJson,
      schemaVersion,
      now
    )
    return { value: parseJson(valueJson, 'Plugin state'), schemaVersion, updatedAt: now }
  }

  readPluginStateValues(
    pluginId: string,
    scope: PluginPlatformScope
  ): Record<string, PluginJsonValue> {
    const id = normalizeId(pluginId, 'Plugin id')
    this.requireDefinition(id)
    validatePluginPlatformScope(scope)
    const prefix = `${getPluginPlatformScopeKey(scope)}::`
    const rows = this.db.prepare(`
      SELECT scope_key, value_json
      FROM plugin_state
      WHERE plugin_id = ? AND substr(scope_key, 1, ?) = ?
      ORDER BY scope_key ASC
    `).all(id, prefix.length, prefix) as Array<{ scope_key: string; value_json: string }>
    const values: Record<string, PluginJsonValue> = {}
    for (const row of rows) {
      const encodedKey = row.scope_key.slice(prefix.length)
      let key: string
      try {
        key = decodeURIComponent(encodedKey)
      } catch (error) {
        throw new Error('Stored plugin state key is corrupt.', { cause: error })
      }
      normalizeStateKey(key)
      values[key] = parseJson(row.value_json, 'Plugin state')
    }
    return values
  }

  findStateSnapshotForRevision(
    installationId: string,
    revisionId: string
  ): PluginStateSnapshotRecord | null {
    const installation = this.requireInstallation(installationId)
    const targetRevisionId = normalizeRevisionId(revisionId)
    const row = this.db.prepare(`
      SELECT from_revision_id, to_revision_id, schema_version, state_json, created_at
      FROM plugin_state_snapshots
      WHERE installation_id = ? AND from_revision_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(installation.id, targetRevisionId) as {
      from_revision_id: string
      to_revision_id: string
      schema_version: number
      state_json: string
      created_at: string
    } | undefined
    if (!row) {
      return null
    }
    return {
      fromRevisionId: row.from_revision_id,
      toRevisionId: row.to_revision_id,
      schemaVersion: normalizeStateSchemaVersion(row.schema_version),
      values: normalizeStateValues(parseJson(row.state_json, 'Plugin state snapshot')),
      createdAt: row.created_at
    }
  }

  appendPluginLog(input: AppendPluginLogInput): void {
    const id = normalizeId(input.id, 'Plugin log id', 500)
    const pluginId = normalizeId(input.pluginId, 'Plugin id')
    this.requireDefinition(pluginId)
    const revisionId = input.revisionId === undefined || input.revisionId === null
      ? null
      : normalizeRevisionId(input.revisionId)
    const runId = normalizeNullableId(input.runId, 'Plugin run id')
    if (!['debug', 'info', 'warning', 'error'].includes(input.level)) {
      throw new Error('Plugin log level is invalid.')
    }
    const event = normalizeId(input.event, 'Plugin log event', 200)
    const message = typeof input.message === 'string' ? input.message.trim() : ''
    if (!message || message.length > 2_000) {
      throw new Error('Plugin log message is invalid.')
    }
    const dataJson = input.data === undefined || input.data === null
      ? null
      : stringifyJson(input.data, 'Plugin log data')
    if (dataJson && Buffer.byteLength(dataJson, 'utf8') > 64 * 1024) {
      throw new Error('Plugin log data exceeds 65536 bytes.')
    }
    this.db.prepare(`
      INSERT INTO plugin_logs (
        id, plugin_id, revision_id, run_id, level, event, message, data_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      pluginId,
      revisionId,
      runId,
      input.level,
      event,
      message,
      dataJson,
      this.now().toISOString()
    )
  }

  listPluginLogs(pluginId: string, limit = 100): PluginLogRecord[] {
    const id = normalizeId(pluginId, 'Plugin id')
    const normalizedLimit = normalizeListLimit(limit, 'Plugin log list limit')
    this.requireDefinition(id)
    const rows = this.db.prepare(`
      SELECT * FROM plugin_logs
      WHERE plugin_id = ?
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `).all(id, normalizedLimit) as LogRow[]
    return rows.map(mapPluginLog)
  }

  private requireDefinition(pluginId: string): PluginDefinitionRecord {
    const definition = this.getDefinition(pluginId)
    if (!definition) {
      throw new Error(`Plugin definition "${pluginId}" does not exist.`)
    }
    return definition
  }

  createSystemPluginInstallRequest(
    input: SystemPluginInstallRequestInput
  ): SystemPluginInstallRequest {
    const id = randomUUID()
    const pluginId = normalizeId(input.pluginId, 'System plugin id')
    const name = normalizeName(input.name)
    const version = typeof input.version === 'string' ? input.version.trim() : ''
    if (!semver.valid(version)) throw new Error('System plugin version must be an exact semantic version.')
    const publisher = normalizeBoundedText(input.publisher, 'System plugin publisher', 500)
    const artifactSha256 = typeof input.artifactSha256 === 'string'
      ? input.artifactSha256.trim().toLowerCase()
      : ''
    if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new Error('System plugin artifact SHA-256 is invalid.')
    const systemPermissions = normalizeSystemPermissions(input.systemPermissions)
    const reason = normalizeBoundedText(input.reason, 'System plugin install reason', 4_000)
    if (input.requestedBy !== 'user' && input.requestedBy !== 'assistant') {
      throw new Error('System plugin request origin is invalid.')
    }
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO system_plugin_install_requests (
        id, plugin_id, name, version, publisher, artifact_sha256,
        system_permissions_json, reason, requested_by, status,
        restart_required, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-confirmation', 1, ?, NULL)
    `).run(
      id,
      pluginId,
      name,
      version,
      publisher,
      artifactSha256,
      JSON.stringify(systemPermissions),
      reason,
      input.requestedBy,
      now
    )
    return this.requireSystemPluginInstallRequest(id)
  }

  listSystemPluginInstallRequests(): SystemPluginInstallRequest[] {
    return (this.db.prepare(`
      SELECT * FROM system_plugin_install_requests ORDER BY created_at DESC, id ASC
    `).all() as SystemPluginInstallRequestRow[]).map(mapSystemPluginInstallRequest)
  }

  getSystemPluginInstallRequest(requestId: string): SystemPluginInstallRequest | null {
    const id = normalizeId(requestId, 'System plugin install request id', 500)
    const row = this.db.prepare(`
      SELECT * FROM system_plugin_install_requests WHERE id = ?
    `).get(id) as SystemPluginInstallRequestRow | undefined
    return row ? mapSystemPluginInstallRequest(row) : null
  }

  updateSystemPluginInstallRequestState(
    requestId: string,
    input: UpdateSystemPluginInstallRequestStateInput
  ): SystemPluginInstallRequest {
    const request = this.requireSystemPluginInstallRequest(requestId)
    const stagedArtifactPath = input.stagedArtifactPath === undefined
      ? request.stagedArtifactPath
      : normalizeNullablePath(input.stagedArtifactPath, 'System plugin staged artifact path')
    const computedArtifactSha256 = input.computedArtifactSha256 === undefined
      ? request.computedArtifactSha256
      : normalizeNullableSha256(input.computedArtifactSha256, 'System plugin computed artifact SHA-256')
    const manifestSnapshot = input.manifestSnapshot === undefined
      ? request.manifestSnapshot
      : normalizeNullableJson(input.manifestSnapshot, 'System plugin manifest snapshot')
    const dependencyPlan = input.dependencyPlan === undefined
      ? request.dependencyPlan
      : normalizeNullableJson(input.dependencyPlan, 'System plugin dependency plan')
    const confirmationVersion = input.confirmationVersion === undefined
      ? request.confirmationVersion
      : normalizeNullablePositiveInteger(
          input.confirmationVersion,
          'System plugin confirmation version'
        )
    const installationId = input.installationId === undefined
      ? request.installationId
      : normalizeNullableId(input.installationId, 'System plugin installation id')
    const error = input.error === undefined
      ? request.error
      : normalizeNullableJson(input.error, 'System plugin install request error')

    this.db.prepare(`
      UPDATE system_plugin_install_requests
      SET staged_artifact_path = ?, computed_artifact_sha256 = ?,
          manifest_snapshot_json = ?, dependency_plan_json = ?,
          confirmation_version = ?, installation_id = ?, error_json = ?
      WHERE id = ?
    `).run(
      stagedArtifactPath,
      computedArtifactSha256,
      manifestSnapshot === null
        ? null
        : stringifyJson(manifestSnapshot, 'System plugin manifest snapshot'),
      dependencyPlan === null
        ? null
        : stringifyJson(dependencyPlan, 'System plugin dependency plan'),
      confirmationVersion,
      installationId,
      error === null ? null : stringifyJson(error, 'System plugin install request error'),
      request.id
    )
    return this.requireSystemPluginInstallRequest(request.id)
  }

  resolveSystemPluginInstallRequest(
    input: ResolveSystemPluginInstallRequestInput
  ): SystemPluginInstallRequest {
    const requestId = normalizeId(input.requestId, 'System plugin install request id', 500)
    const request = this.requireSystemPluginInstallRequest(requestId)
    if (request.status !== 'awaiting-confirmation') {
      throw new Error('System plugin install request was already resolved.')
    }
    if (normalizeId(input.pluginId, 'System plugin confirmation id') !== request.pluginId) {
      throw new Error('System plugin confirmation does not match the exact plugin id.')
    }
    if (input.decision !== 'confirm' && input.decision !== 'cancel') {
      throw new Error('System plugin install decision is invalid.')
    }
    if (input.decision === 'confirm' && input.acknowledgeSystemAccess !== true) {
      throw new Error('System plugin confirmation requires explicit acknowledgement of system access.')
    }
    const now = this.now().toISOString()
    this.db.prepare(`
      UPDATE system_plugin_install_requests
      SET status = ?, resolved_at = ?
      WHERE id = ? AND status = 'awaiting-confirmation'
    `).run(
      input.decision === 'confirm' ? 'confirmed-restart-required' : 'cancelled',
      now,
      request.id
    )
    return this.requireSystemPluginInstallRequest(request.id)
  }

  createSystemPluginPackage(input: CreateSystemPluginPackageInput): SystemPluginPackageRecord {
    const id = input.id === undefined
      ? randomUUID()
      : normalizeId(input.id, 'System plugin package id', 500)
    const pluginId = normalizeId(input.pluginId, 'System plugin id')
    const version = normalizeExactSemver(input.version, 'System plugin package version')
    const publisher = normalizeBoundedText(input.publisher, 'System plugin package publisher', 500)
    const contentHash = normalizeSha256(input.contentHash, 'System plugin package content hash')
    const artifactPath = normalizePath(input.artifactPath, 'System plugin artifact path')
    const manifestSnapshot = normalizeRequiredJson(
      input.manifestSnapshot,
      'System plugin manifest snapshot'
    )
    const fileManifest = normalizeRequiredJson(
      input.fileManifest,
      'System plugin file manifest'
    )
    const sourceRequestId = normalizeNullableId(
      input.sourceRequestId,
      'System plugin source request id'
    )
    if (sourceRequestId) this.requireSystemPluginInstallRequest(sourceRequestId)
    const status = normalizeSystemPluginPackageStatus(input.status ?? 'staged')
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO system_plugin_packages (
        id, plugin_id, version, publisher, content_hash, artifact_path,
        manifest_snapshot_json, file_manifest_json, runtime_fingerprint_json,
        status, source_request_id, error_json, created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)
    `).run(
      id,
      pluginId,
      version,
      publisher,
      contentHash,
      artifactPath,
      stringifyJson(manifestSnapshot, 'System plugin manifest snapshot'),
      stringifyJson(fileManifest, 'System plugin file manifest'),
      status,
      sourceRequestId,
      now,
      now,
      status === 'ready' ? now : null
    )
    return this.requireSystemPluginPackage(id)
  }

  getSystemPluginPackage(packageId: string): SystemPluginPackageRecord | null {
    const id = normalizeId(packageId, 'System plugin package id', 500)
    const row = this.db.prepare('SELECT * FROM system_plugin_packages WHERE id = ?')
      .get(id) as SystemPluginPackageRow | undefined
    return row ? mapSystemPluginPackage(row) : null
  }

  findSystemPluginPackage(pluginId: string, contentHash: string): SystemPluginPackageRecord | null {
    const id = normalizeId(pluginId, 'System plugin id')
    const hash = normalizeSha256(contentHash, 'System plugin package content hash')
    const row = this.db.prepare(`
      SELECT * FROM system_plugin_packages WHERE plugin_id = ? AND content_hash = ?
    `).get(id, hash) as SystemPluginPackageRow | undefined
    return row ? mapSystemPluginPackage(row) : null
  }

  listSystemPluginPackages(pluginId: string | null = null, limit = 100): SystemPluginPackageRecord[] {
    const normalizedLimit = normalizeListLimit(limit, 'System plugin package list limit')
    const rows = pluginId === null
      ? this.db.prepare(`
          SELECT * FROM system_plugin_packages
          ORDER BY created_at DESC, id ASC LIMIT ?
        `).all(normalizedLimit)
      : this.db.prepare(`
          SELECT * FROM system_plugin_packages
          WHERE plugin_id = ?
          ORDER BY created_at DESC, id ASC LIMIT ?
        `).all(normalizeId(pluginId, 'System plugin id'), normalizedLimit)
    return (rows as SystemPluginPackageRow[]).map(mapSystemPluginPackage)
  }

  updateSystemPluginPackage(
    packageId: string,
    input: UpdateSystemPluginPackageInput
  ): SystemPluginPackageRecord {
    const record = this.requireSystemPluginPackage(packageId)
    const artifactPath = input.artifactPath === undefined
      ? record.artifactPath
      : normalizePath(input.artifactPath, 'System plugin artifact path')
    const runtimeFingerprint = input.runtimeFingerprint === undefined
      ? record.runtimeFingerprint
      : normalizeNullableJson(input.runtimeFingerprint, 'System plugin runtime fingerprint')
    const status = input.status === undefined
      ? record.status
      : normalizeSystemPluginPackageStatus(input.status)
    const error = input.error === undefined
      ? record.error
      : normalizeNullableJson(input.error, 'System plugin package error')
    const now = this.now().toISOString()
    const publishedAt = input.publishedAt === undefined
      ? (status === 'ready' && record.publishedAt === null ? now : record.publishedAt)
      : normalizeNullableDate(input.publishedAt, 'System plugin package publication time')
    this.db.prepare(`
      UPDATE system_plugin_packages
      SET artifact_path = ?, runtime_fingerprint_json = ?, status = ?,
          error_json = ?, updated_at = ?, published_at = ?
      WHERE id = ?
    `).run(
      artifactPath,
      runtimeFingerprint === null
        ? null
        : stringifyJson(runtimeFingerprint, 'System plugin runtime fingerprint'),
      status,
      error === null ? null : stringifyJson(error, 'System plugin package error'),
      now,
      publishedAt,
      record.id
    )
    return this.requireSystemPluginPackage(record.id)
  }

  createSystemPluginInstallation(
    input: CreateSystemPluginInstallationInput
  ): SystemPluginInstallationRecord {
    const id = input.id === undefined
      ? randomUUID()
      : normalizeId(input.id, 'System plugin installation id', 500)
    const pluginId = normalizeId(input.pluginId, 'System plugin id')
    const enabled = normalizeBoolean(input.enabled ?? false, 'System plugin enabled flag')
    const autoStart = normalizeBoolean(input.autoStart ?? false, 'System plugin auto-start flag')
    const safeModeDisabled = normalizeBoolean(
      input.safeModeDisabled ?? false,
      'System plugin safe-mode flag'
    )
    const status = normalizeSystemPluginInstallationStatus(input.status ?? 'disabled')
    const currentPackageId = normalizeNullableId(
      input.currentPackageId,
      'System plugin current package id'
    )
    const pendingPackageId = normalizeNullableId(
      input.pendingPackageId,
      'System plugin pending package id'
    )
    const backupPath = normalizeNullablePath(input.backupPath, 'System plugin backup path')
    this.assertSystemPackageOwnership(pluginId, currentPackageId)
    this.assertSystemPackageOwnership(pluginId, pendingPackageId)
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO system_plugin_installations (
        id, plugin_id, enabled, auto_start, safe_mode_disabled, status,
        current_package_id, pending_package_id, last_error_json, backup_path,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      id,
      pluginId,
      enabled ? 1 : 0,
      autoStart ? 1 : 0,
      safeModeDisabled ? 1 : 0,
      status,
      currentPackageId,
      pendingPackageId,
      backupPath,
      now,
      now
    )
    return this.requireSystemPluginInstallation(id)
  }

  ensureSystemPluginInstallation(
    input: CreateSystemPluginInstallationInput
  ): SystemPluginInstallationRecord {
    const pluginId = normalizeId(input.pluginId, 'System plugin id')
    const existing = this.getSystemPluginInstallationByPlugin(pluginId)
    if (!existing) return this.createSystemPluginInstallation(input)
    if (input.id !== undefined && normalizeId(
      input.id,
      'System plugin installation id',
      500
    ) !== existing.id) {
      throw new Error(`System plugin "${pluginId}" already has another installation.`)
    }
    return existing
  }

  getSystemPluginInstallation(installationId: string): SystemPluginInstallationRecord | null {
    const id = normalizeId(installationId, 'System plugin installation id', 500)
    const row = this.db.prepare('SELECT * FROM system_plugin_installations WHERE id = ?')
      .get(id) as SystemPluginInstallationRow | undefined
    return row ? mapSystemPluginInstallation(row) : null
  }

  getSystemPluginInstallationByPlugin(pluginId: string): SystemPluginInstallationRecord | null {
    const id = normalizeId(pluginId, 'System plugin id')
    const row = this.db.prepare('SELECT * FROM system_plugin_installations WHERE plugin_id = ?')
      .get(id) as SystemPluginInstallationRow | undefined
    return row ? mapSystemPluginInstallation(row) : null
  }

  listSystemPluginInstallations(): SystemPluginInstallationRecord[] {
    return (this.db.prepare(`
      SELECT * FROM system_plugin_installations ORDER BY created_at ASC, id ASC
    `).all() as SystemPluginInstallationRow[]).map(mapSystemPluginInstallation)
  }

  updateSystemPluginInstallation(
    installationId: string,
    input: UpdateSystemPluginInstallationInput
  ): SystemPluginInstallationRecord {
    const record = this.requireSystemPluginInstallation(installationId)
    const enabled = input.enabled === undefined
      ? record.enabled
      : normalizeBoolean(input.enabled, 'System plugin enabled flag')
    const autoStart = input.autoStart === undefined
      ? record.autoStart
      : normalizeBoolean(input.autoStart, 'System plugin auto-start flag')
    const safeModeDisabled = input.safeModeDisabled === undefined
      ? record.safeModeDisabled
      : normalizeBoolean(input.safeModeDisabled, 'System plugin safe-mode flag')
    const status = input.status === undefined
      ? record.status
      : normalizeSystemPluginInstallationStatus(input.status)
    const currentPackageId = input.currentPackageId === undefined
      ? record.currentPackageId
      : normalizeNullableId(input.currentPackageId, 'System plugin current package id')
    const pendingPackageId = input.pendingPackageId === undefined
      ? record.pendingPackageId
      : normalizeNullableId(input.pendingPackageId, 'System plugin pending package id')
    const lastError = input.lastError === undefined
      ? record.lastError
      : normalizeNullableJson(input.lastError, 'System plugin installation error')
    const backupPath = input.backupPath === undefined
      ? record.backupPath
      : normalizeNullablePath(input.backupPath, 'System plugin backup path')
    this.assertSystemPackageOwnership(record.pluginId, currentPackageId)
    this.assertSystemPackageOwnership(record.pluginId, pendingPackageId)
    this.db.prepare(`
      UPDATE system_plugin_installations
      SET enabled = ?, auto_start = ?, safe_mode_disabled = ?, status = ?,
          current_package_id = ?, pending_package_id = ?, last_error_json = ?,
          backup_path = ?, updated_at = ?
      WHERE id = ?
    `).run(
      enabled ? 1 : 0,
      autoStart ? 1 : 0,
      safeModeDisabled ? 1 : 0,
      status,
      currentPackageId,
      pendingPackageId,
      lastError === null ? null : stringifyJson(lastError, 'System plugin installation error'),
      backupPath,
      this.now().toISOString(),
      record.id
    )
    return this.requireSystemPluginInstallation(record.id)
  }

  deleteSystemPluginInstallationData(pluginId: string): void {
    const id = normalizeId(pluginId, 'System plugin id')
    const installation = this.getSystemPluginInstallationByPlugin(id)
    if (!installation) return
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE system_plugin_install_requests
        SET installation_id = NULL
        WHERE installation_id = ?
      `).run(installation.id)
      this.db.prepare('DELETE FROM system_plugin_installations WHERE id = ?')
        .run(installation.id)
      this.db.prepare('DELETE FROM system_plugin_packages WHERE plugin_id = ?')
        .run(id)
    })()
  }

  createSystemPluginRun(input: CreateSystemPluginRunInput): SystemPluginRunRecord {
    const id = input.id === undefined
      ? randomUUID()
      : normalizeId(input.id, 'System plugin run id', 500)
    const installation = this.requireSystemPluginInstallation(input.installationId)
    const packageRecord = this.requireSystemPluginPackage(input.packageId)
    if (packageRecord.pluginId !== installation.pluginId) {
      throw new Error('System plugin run package does not belong to its installation.')
    }
    const component = normalizeSystemPluginRunComponent(input.component)
    const pid = normalizeNullablePid(input.pid, 'System plugin run pid')
    const restartCount = normalizeNonNegativeInteger(
      input.restartCount ?? 0,
      'System plugin restart count'
    )
    const logPath = normalizeNullablePath(input.logPath, 'System plugin run log path')
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO system_plugin_runs (
        id, plugin_id, installation_id, package_id, component, status,
        pid, exit_code, exit_signal, restart_count, health_json, error_json,
        log_path, started_at, ready_at, last_heartbeat_at, stopped_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'starting', ?, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?)
    `).run(
      id,
      installation.pluginId,
      installation.id,
      packageRecord.id,
      component,
      pid,
      restartCount,
      logPath,
      now,
      now
    )
    return this.requireSystemPluginRun(id)
  }

  getSystemPluginRun(runId: string): SystemPluginRunRecord | null {
    const id = normalizeId(runId, 'System plugin run id', 500)
    const row = this.db.prepare('SELECT * FROM system_plugin_runs WHERE id = ?')
      .get(id) as SystemPluginRunRow | undefined
    return row ? mapSystemPluginRun(row) : null
  }

  listSystemPluginRuns(installationId: string, limit = 100): SystemPluginRunRecord[] {
    const id = normalizeId(installationId, 'System plugin installation id', 500)
    const normalizedLimit = normalizeListLimit(limit, 'System plugin run list limit')
    this.requireSystemPluginInstallation(id)
    return (this.db.prepare(`
      SELECT * FROM system_plugin_runs
      WHERE installation_id = ?
      ORDER BY started_at DESC, id ASC LIMIT ?
    `).all(id, normalizedLimit) as SystemPluginRunRow[]).map(mapSystemPluginRun)
  }

  updateSystemPluginRun(runId: string, input: UpdateSystemPluginRunInput): SystemPluginRunRecord {
    const record = this.requireSystemPluginRun(runId)
    const status = input.status === undefined
      ? record.status
      : normalizeSystemPluginRunStatus(input.status)
    const pid = input.pid === undefined
      ? record.pid
      : normalizeNullablePid(input.pid, 'System plugin run pid')
    const exitCode = input.exitCode === undefined
      ? record.exitCode
      : normalizeNullableInteger(input.exitCode, 'System plugin run exit code')
    const exitSignal = input.exitSignal === undefined
      ? record.exitSignal
      : normalizeNullableBoundedText(input.exitSignal, 'System plugin run exit signal', 100)
    const restartCount = input.restartCount === undefined
      ? record.restartCount
      : normalizeNonNegativeInteger(input.restartCount, 'System plugin restart count')
    const health = input.health === undefined
      ? record.health
      : normalizeNullableJson(input.health, 'System plugin run health')
    const error = input.error === undefined
      ? record.error
      : normalizeNullableJson(input.error, 'System plugin run error')
    const now = this.now().toISOString()
    const readyAt = input.readyAt === undefined
      ? (status === 'ready' && record.readyAt === null ? now : record.readyAt)
      : normalizeNullableDate(input.readyAt, 'System plugin ready time')
    const lastHeartbeatAt = input.lastHeartbeatAt === undefined
      ? record.lastHeartbeatAt
      : normalizeNullableDate(input.lastHeartbeatAt, 'System plugin heartbeat time')
    const stoppedAt = input.stoppedAt === undefined
      ? (
          (status === 'stopped' || status === 'failed') && record.stoppedAt === null
            ? now
            : record.stoppedAt
        )
      : normalizeNullableDate(input.stoppedAt, 'System plugin stop time')
    this.db.prepare(`
      UPDATE system_plugin_runs
      SET status = ?, pid = ?, exit_code = ?, exit_signal = ?, restart_count = ?,
          health_json = ?, error_json = ?, ready_at = ?, last_heartbeat_at = ?,
          stopped_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      pid,
      exitCode,
      exitSignal,
      restartCount,
      health === null ? null : stringifyJson(health, 'System plugin run health'),
      error === null ? null : stringifyJson(error, 'System plugin run error'),
      readyAt,
      lastHeartbeatAt,
      stoppedAt,
      now,
      record.id
    )
    return this.requireSystemPluginRun(record.id)
  }

  appendSystemPluginAudit(input: AppendSystemPluginAuditInput): SystemPluginAuditRecord {
    const id = input.id === undefined
      ? randomUUID()
      : normalizeId(input.id, 'System plugin audit id', 500)
    const pluginId = normalizeId(input.pluginId, 'System plugin id')
    const installationId = normalizeNullableId(
      input.installationId,
      'System plugin audit installation id'
    )
    const packageId = normalizeNullableId(input.packageId, 'System plugin audit package id')
    const requestId = normalizeNullableId(input.requestId, 'System plugin audit request id')
    const runId = normalizeNullableId(input.runId, 'System plugin audit run id')
    this.assertSystemAuditReferences(pluginId, installationId, packageId, requestId, runId)
    const actor = normalizeSystemPluginAuditActor(input.actor)
    const action = normalizeSystemPluginAction(input.action)
    const outcome = normalizeSystemPluginAuditOutcome(input.outcome)
    const details = normalizeNullableJson(input.details, 'System plugin audit details')
    this.db.prepare(`
      INSERT INTO system_plugin_audit (
        id, plugin_id, installation_id, package_id, request_id, run_id,
        actor, action, outcome, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      pluginId,
      installationId,
      packageId,
      requestId,
      runId,
      actor,
      action,
      outcome,
      details === null ? null : stringifyJson(details, 'System plugin audit details'),
      this.now().toISOString()
    )
    return this.requireSystemPluginAudit(id)
  }

  listSystemPluginAudit(pluginId: string, limit = 100): SystemPluginAuditRecord[] {
    const id = normalizeId(pluginId, 'System plugin id')
    const normalizedLimit = normalizeListLimit(limit, 'System plugin audit list limit')
    return (this.db.prepare(`
      SELECT * FROM system_plugin_audit
      WHERE plugin_id = ?
      ORDER BY created_at DESC, id ASC LIMIT ?
    `).all(id, normalizedLimit) as SystemPluginAuditRow[]).map(mapSystemPluginAudit)
  }

  createSystemPluginDependencyJob(
    input: CreateSystemPluginDependencyJobInput
  ): SystemPluginDependencyJobRecord {
    const id = input.id === undefined
      ? randomUUID()
      : normalizeId(input.id, 'System plugin dependency job id', 500)
    const packageRecord = this.requireSystemPluginPackage(input.packageId)
    const installationId = normalizeNullableId(
      input.installationId,
      'System plugin dependency installation id'
    )
    const requestId = normalizeNullableId(
      input.requestId,
      'System plugin dependency request id'
    )
    if (installationId) {
      const installation = this.requireSystemPluginInstallation(installationId)
      if (installation.pluginId !== packageRecord.pluginId) {
        throw new Error('System plugin dependency job installation belongs to another plugin.')
      }
    }
    if (requestId) {
      const request = this.requireSystemPluginInstallRequest(requestId)
      if (request.pluginId !== packageRecord.pluginId) {
        throw new Error('System plugin dependency job request belongs to another plugin.')
      }
    }
    const kind = normalizeSystemPluginDependencyJobKind(input.kind)
    const packageManager = normalizeSystemPluginPackageManager(input.packageManager)
    const command = normalizeSystemPluginCommand(input.command)
    const logPath = normalizeNullablePath(input.logPath, 'System plugin dependency log path')
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO system_plugin_dependency_jobs (
        id, plugin_id, package_id, installation_id, request_id, kind,
        package_manager, command_json, status, pid, exit_code, log_path,
        error_json, created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, ?, NULL, NULL, ?)
    `).run(
      id,
      packageRecord.pluginId,
      packageRecord.id,
      installationId,
      requestId,
      kind,
      packageManager,
      JSON.stringify(command),
      logPath,
      now,
      now
    )
    return this.requireSystemPluginDependencyJob(id)
  }

  getSystemPluginDependencyJob(jobId: string): SystemPluginDependencyJobRecord | null {
    const id = normalizeId(jobId, 'System plugin dependency job id', 500)
    const row = this.db.prepare('SELECT * FROM system_plugin_dependency_jobs WHERE id = ?')
      .get(id) as SystemPluginDependencyJobRow | undefined
    return row ? mapSystemPluginDependencyJob(row) : null
  }

  listSystemPluginDependencyJobs(
    packageId: string,
    limit = 100
  ): SystemPluginDependencyJobRecord[] {
    const id = normalizeId(packageId, 'System plugin package id', 500)
    const normalizedLimit = normalizeListLimit(limit, 'System plugin dependency job list limit')
    this.requireSystemPluginPackage(id)
    return (this.db.prepare(`
      SELECT * FROM system_plugin_dependency_jobs
      WHERE package_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ?
    `).all(id, normalizedLimit) as SystemPluginDependencyJobRow[])
      .map(mapSystemPluginDependencyJob)
  }

  updateSystemPluginDependencyJob(
    jobId: string,
    input: UpdateSystemPluginDependencyJobInput
  ): SystemPluginDependencyJobRecord {
    const record = this.requireSystemPluginDependencyJob(jobId)
    const status = input.status === undefined
      ? record.status
      : normalizeSystemPluginDependencyJobStatus(input.status)
    const pid = input.pid === undefined
      ? record.pid
      : normalizeNullablePid(input.pid, 'System plugin dependency job pid')
    const exitCode = input.exitCode === undefined
      ? record.exitCode
      : normalizeNullableInteger(input.exitCode, 'System plugin dependency job exit code')
    const logPath = input.logPath === undefined
      ? record.logPath
      : normalizeNullablePath(input.logPath, 'System plugin dependency log path')
    const error = input.error === undefined
      ? record.error
      : normalizeNullableJson(input.error, 'System plugin dependency job error')
    const now = this.now().toISOString()
    const startedAt = input.startedAt === undefined
      ? (status === 'running' && record.startedAt === null ? now : record.startedAt)
      : normalizeNullableDate(input.startedAt, 'System plugin dependency start time')
    const finishedAt = input.finishedAt === undefined
      ? (
          ['succeeded', 'failed', 'cancelled'].includes(status) && record.finishedAt === null
            ? now
            : record.finishedAt
        )
      : normalizeNullableDate(input.finishedAt, 'System plugin dependency finish time')
    this.db.prepare(`
      UPDATE system_plugin_dependency_jobs
      SET status = ?, pid = ?, exit_code = ?, log_path = ?, error_json = ?,
          started_at = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      pid,
      exitCode,
      logPath,
      error === null ? null : stringifyJson(error, 'System plugin dependency job error'),
      startedAt,
      finishedAt,
      now,
      record.id
    )
    return this.requireSystemPluginDependencyJob(record.id)
  }

  createSystemPluginCrashMarker(
    input: CreateSystemPluginCrashMarkerInput
  ): SystemPluginCrashMarkerRecord {
    const id = input.id === undefined
      ? randomUUID()
      : normalizeId(input.id, 'System plugin crash marker id', 500)
    const installation = this.requireSystemPluginInstallation(input.installationId)
    const packageRecord = this.requireSystemPluginPackage(input.packageId)
    if (installation.pluginId !== packageRecord.pluginId) {
      throw new Error('System plugin crash marker package belongs to another plugin.')
    }
    const runId = normalizeNullableId(input.runId, 'System plugin crash marker run id')
    if (runId) {
      const run = this.requireSystemPluginRun(runId)
      if (run.installationId !== installation.id || run.packageId !== packageRecord.id) {
        throw new Error('System plugin crash marker run does not match its installation and package.')
      }
    }
    const phase = normalizeSystemPluginPhase(input.phase)
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO system_plugin_crash_markers (
        id, plugin_id, installation_id, package_id, run_id, phase, state,
        error_json, recovery_json, created_at, updated_at, cleared_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'armed', NULL, NULL, ?, ?, NULL)
    `).run(
      id,
      installation.pluginId,
      installation.id,
      packageRecord.id,
      runId,
      phase,
      now,
      now
    )
    return this.requireSystemPluginCrashMarker(id)
  }

  getSystemPluginCrashMarker(markerId: string): SystemPluginCrashMarkerRecord | null {
    const id = normalizeId(markerId, 'System plugin crash marker id', 500)
    const row = this.db.prepare('SELECT * FROM system_plugin_crash_markers WHERE id = ?')
      .get(id) as SystemPluginCrashMarkerRow | undefined
    return row ? mapSystemPluginCrashMarker(row) : null
  }

  listActiveSystemPluginCrashMarkers(): SystemPluginCrashMarkerRecord[] {
    return (this.db.prepare(`
      SELECT * FROM system_plugin_crash_markers
      WHERE cleared_at IS NULL
      ORDER BY created_at ASC, id ASC
    `).all() as SystemPluginCrashMarkerRow[]).map(mapSystemPluginCrashMarker)
  }

  listSystemPluginCrashMarkers(
    installationId: string,
    limit = 100
  ): SystemPluginCrashMarkerRecord[] {
    const id = normalizeId(installationId, 'System plugin installation id', 500)
    const normalizedLimit = normalizeListLimit(limit, 'System plugin crash marker list limit')
    this.requireSystemPluginInstallation(id)
    return (this.db.prepare(`
      SELECT * FROM system_plugin_crash_markers
      WHERE installation_id = ?
      ORDER BY created_at DESC, id ASC LIMIT ?
    `).all(id, normalizedLimit) as SystemPluginCrashMarkerRow[]).map(mapSystemPluginCrashMarker)
  }

  updateSystemPluginCrashMarker(
    markerId: string,
    input: UpdateSystemPluginCrashMarkerInput
  ): SystemPluginCrashMarkerRecord {
    const record = this.requireSystemPluginCrashMarker(markerId)
    const state = input.state === undefined
      ? record.state
      : normalizeSystemPluginCrashMarkerState(input.state)
    const error = input.error === undefined
      ? record.error
      : normalizeNullableJson(input.error, 'System plugin crash marker error')
    const recovery = input.recovery === undefined
      ? record.recovery
      : normalizeNullableJson(input.recovery, 'System plugin crash marker recovery')
    const now = this.now().toISOString()
    const clearedAt = input.clearedAt === undefined
      ? (
          (state === 'ready' || state === 'recovered') && record.clearedAt === null
            ? now
            : record.clearedAt
        )
      : normalizeNullableDate(input.clearedAt, 'System plugin crash marker clear time')
    this.db.prepare(`
      UPDATE system_plugin_crash_markers
      SET state = ?, error_json = ?, recovery_json = ?, updated_at = ?, cleared_at = ?
      WHERE id = ?
    `).run(
      state,
      error === null ? null : stringifyJson(error, 'System plugin crash marker error'),
      recovery === null ? null : stringifyJson(recovery, 'System plugin crash marker recovery'),
      now,
      clearedAt,
      record.id
    )
    return this.requireSystemPluginCrashMarker(record.id)
  }

  upsertSystemPluginOsPersistence(
    input: UpsertSystemPluginOsPersistenceInput
  ): SystemPluginOsPersistenceRecord {
    const installation = this.requireSystemPluginInstallation(input.installationId)
    const packageRecord = this.requireSystemPluginPackage(input.packageId)
    if (installation.pluginId !== packageRecord.pluginId) {
      throw new Error('System plugin OS persistence package belongs to another plugin.')
    }
    const existing = this.getSystemPluginOsPersistenceByPlugin(installation.pluginId)
    const id = existing?.id ?? (
      input.id === undefined
        ? randomUUID()
        : normalizeId(input.id, 'System plugin OS persistence id', 500)
    )
    const revisionHash = normalizeRevisionId(input.revisionHash)
    const serviceId = normalizeId(input.serviceId, 'System plugin OS persistence service id', 128)
    const method = normalizeSystemPluginOsPersistenceMethod(input.method)
    const command = normalizeSystemPluginOsPersistenceCommand(input.command)
    const descriptor = normalizeRequiredJson(
      input.descriptor,
      'System plugin OS persistence descriptor'
    )
    const status = normalizeSystemPluginOsPersistenceStatus(
      input.status ?? 'awaiting-confirmation'
    )
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT INTO system_plugin_os_persistence (
        id, plugin_id, installation_id, package_id, revision_hash,
        service_id, method, command_json, descriptor_json, status,
        error_json, created_at, resolved_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        package_id = excluded.package_id,
        revision_hash = excluded.revision_hash,
        service_id = excluded.service_id,
        method = excluded.method,
        command_json = excluded.command_json,
        descriptor_json = excluded.descriptor_json,
        status = excluded.status,
        error_json = NULL,
        resolved_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      id,
      installation.pluginId,
      installation.id,
      packageRecord.id,
      revisionHash,
      serviceId,
      method,
      stringifyJson(
        { executable: command.executable, args: command.args },
        'System plugin OS persistence command'
      ),
      stringifyJson(descriptor, 'System plugin OS persistence descriptor'),
      status,
      now,
      now
    )
    return this.requireSystemPluginOsPersistence(id)
  }

  getSystemPluginOsPersistence(
    recordId: string
  ): SystemPluginOsPersistenceRecord | null {
    const id = normalizeId(recordId, 'System plugin OS persistence id', 500)
    const row = this.db.prepare('SELECT * FROM system_plugin_os_persistence WHERE id = ?')
      .get(id) as SystemPluginOsPersistenceRow | undefined
    return row ? mapSystemPluginOsPersistence(row) : null
  }

  getSystemPluginOsPersistenceByPlugin(
    pluginId: string
  ): SystemPluginOsPersistenceRecord | null {
    const id = normalizeId(pluginId, 'System plugin id')
    const row = this.db.prepare('SELECT * FROM system_plugin_os_persistence WHERE plugin_id = ?')
      .get(id) as SystemPluginOsPersistenceRow | undefined
    return row ? mapSystemPluginOsPersistence(row) : null
  }

  listSystemPluginOsPersistence(): SystemPluginOsPersistenceRecord[] {
    return (this.db.prepare(`
      SELECT * FROM system_plugin_os_persistence
      ORDER BY created_at DESC, id ASC
    `).all() as SystemPluginOsPersistenceRow[]).map(mapSystemPluginOsPersistence)
  }

  updateSystemPluginOsPersistence(
    recordId: string,
    input: UpdateSystemPluginOsPersistenceInput
  ): SystemPluginOsPersistenceRecord {
    const record = this.requireSystemPluginOsPersistence(recordId)
    const packageId = input.packageId === undefined
      ? record.packageId
      : normalizeId(input.packageId, 'System plugin package id', 500)
    const packageRecord = this.requireSystemPluginPackage(packageId)
    if (packageRecord.pluginId !== record.pluginId) {
      throw new Error('System plugin OS persistence package belongs to another plugin.')
    }
    const revisionHash = input.revisionHash === undefined
      ? record.revisionHash
      : normalizeRevisionId(input.revisionHash)
    const serviceId = input.serviceId === undefined
      ? record.serviceId
      : normalizeId(input.serviceId, 'System plugin OS persistence service id', 128)
    const method = input.method === undefined
      ? record.method
      : normalizeSystemPluginOsPersistenceMethod(input.method)
    const command = input.command === undefined
      ? record.command
      : normalizeSystemPluginOsPersistenceCommand(input.command)
    const descriptor = input.descriptor === undefined
      ? record.descriptor
      : normalizeRequiredJson(input.descriptor, 'System plugin OS persistence descriptor')
    const status = input.status === undefined
      ? record.status
      : normalizeSystemPluginOsPersistenceStatus(input.status)
    const error = input.error === undefined
      ? record.error
      : normalizeNullableJson(input.error, 'System plugin OS persistence error')
    const now = this.now().toISOString()
    const resolvedAt = input.resolvedAt === undefined
      ? (
          status === 'awaiting-confirmation'
            ? null
            : record.resolvedAt ?? now
        )
      : normalizeNullableDate(input.resolvedAt, 'System plugin OS persistence resolution time')
    this.db.prepare(`
      UPDATE system_plugin_os_persistence
      SET package_id = ?, revision_hash = ?, service_id = ?, method = ?,
          command_json = ?, descriptor_json = ?, status = ?, error_json = ?,
          resolved_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      packageRecord.id,
      revisionHash,
      serviceId,
      method,
      stringifyJson(
        { executable: command.executable, args: command.args },
        'System plugin OS persistence command'
      ),
      stringifyJson(descriptor, 'System plugin OS persistence descriptor'),
      status,
      error === null ? null : stringifyJson(error, 'System plugin OS persistence error'),
      resolvedAt,
      now,
      record.id
    )
    return this.requireSystemPluginOsPersistence(record.id)
  }

  private isRevisionReferenced(revisionId: string): boolean {
    const id = normalizeRevisionId(revisionId)
    const row = this.db.prepare(`
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM plugin_definitions
        WHERE current_revision_id = ? OR pending_revision_id = ?
      ) OR EXISTS (
        SELECT 1 FROM plugin_installations
        WHERE current_revision_id = ? OR pending_revision_id = ?
      ) OR EXISTS (
        SELECT 1 FROM plugin_grants WHERE revision_id = ?
      ) OR EXISTS (
        SELECT 1 FROM plugin_runs WHERE revision_id = ?
      ) OR EXISTS (
        SELECT 1 FROM plugin_logs WHERE revision_id = ?
      ) OR EXISTS (
        SELECT 1 FROM plugin_state_snapshots
        WHERE from_revision_id = ? OR to_revision_id = ?
      )
      LIMIT 1
    `).get(id, id, id, id, id, id, id, id, id) as { 1: number } | undefined
    return Boolean(row)
  }

  private applyStateMigration(
    installation: PluginInstallationRecord,
    run: PluginRunRecord,
    migration: PluginStateMigrationInput,
    now: string
  ): void {
    const fromRevisionId = normalizeRevisionId(migration.fromRevisionId)
    if (
      installation.currentRevisionId !== fromRevisionId
      || run.revisionId === fromRevisionId
    ) {
      throw new Error('Plugin state migration revision boundary is stale or invalid.')
    }
    const fromSchemaVersion = normalizeStateSchemaVersion(migration.fromSchemaVersion)
    const toSchemaVersion = normalizeStateSchemaVersion(migration.toSchemaVersion)
    if (fromSchemaVersion === toSchemaVersion) {
      throw new Error('Plugin state migration requires different schema versions.')
    }
    const nextValues = normalizeStateValues(migration.values)
    const previousValues = this.readPluginStateValues(run.pluginId, run.scope)
    const prefix = `${getPluginPlatformScopeKey(run.scope)}::`
    this.db.prepare(`
      INSERT INTO plugin_state_snapshots (
        id, installation_id, from_revision_id, to_revision_id,
        schema_version, state_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      installation.id,
      fromRevisionId,
      run.revisionId,
      fromSchemaVersion,
      stringifyJson(previousValues, 'Plugin state migration snapshot'),
      now
    )
    this.db.prepare(`
      DELETE FROM plugin_state
      WHERE plugin_id = ? AND substr(scope_key, 1, ?) = ?
    `).run(run.pluginId, prefix.length, prefix)
    const insert = this.db.prepare(`
      INSERT INTO plugin_state (
        plugin_id, scope_key, schema_version, value_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    for (const [key, value] of Object.entries(nextValues)) {
      insert.run(
        run.pluginId,
        `${prefix}${encodeURIComponent(key)}`,
        toSchemaVersion,
        stringifyJson(value, 'Migrated plugin state value'),
        now
      )
    }
  }

  private requireRevision(revisionId: string): PluginRevisionRecord {
    const revision = this.getRevision(revisionId)
    if (!revision) {
      throw new Error(`Plugin revision "${revisionId}" does not exist.`)
    }
    return revision
  }

  private requireGrantSet(grantSetId: string): PluginGrantSet {
    const grant = this.getGrantSet(grantSetId)
    if (!grant) {
      throw new Error(`Active plugin grant set "${grantSetId}" does not exist.`)
    }
    return grant
  }

  private requireInstallation(installationId: string): PluginInstallationRecord {
    const installation = this.getInstallation(installationId)
    if (!installation) {
      throw new Error(`Plugin installation "${installationId}" does not exist.`)
    }
    return installation
  }

  private requireRun(runId: string): PluginRunRecord {
    const run = this.getRun(runId)
    if (!run) {
      throw new Error(`Plugin run "${runId}" does not exist.`)
    }
    return run
  }

  private requireSystemPluginInstallRequest(requestId: string): SystemPluginInstallRequest {
    const request = this.getSystemPluginInstallRequest(requestId)
    if (!request) throw new Error(`System plugin install request "${requestId}" does not exist.`)
    return request
  }

  private requireSystemPluginPackage(packageId: string): SystemPluginPackageRecord {
    const record = this.getSystemPluginPackage(packageId)
    if (!record) throw new Error(`System plugin package "${packageId}" does not exist.`)
    return record
  }

  private requireSystemPluginInstallation(installationId: string): SystemPluginInstallationRecord {
    const record = this.getSystemPluginInstallation(installationId)
    if (!record) throw new Error(`System plugin installation "${installationId}" does not exist.`)
    return record
  }

  private requireSystemPluginRun(runId: string): SystemPluginRunRecord {
    const record = this.getSystemPluginRun(runId)
    if (!record) throw new Error(`System plugin run "${runId}" does not exist.`)
    return record
  }

  private requireSystemPluginAudit(auditId: string): SystemPluginAuditRecord {
    const id = normalizeId(auditId, 'System plugin audit id', 500)
    const row = this.db.prepare('SELECT * FROM system_plugin_audit WHERE id = ?')
      .get(id) as SystemPluginAuditRow | undefined
    if (!row) throw new Error(`System plugin audit record "${id}" does not exist.`)
    return mapSystemPluginAudit(row)
  }

  private requireSystemPluginDependencyJob(jobId: string): SystemPluginDependencyJobRecord {
    const record = this.getSystemPluginDependencyJob(jobId)
    if (!record) throw new Error(`System plugin dependency job "${jobId}" does not exist.`)
    return record
  }

  private requireSystemPluginCrashMarker(markerId: string): SystemPluginCrashMarkerRecord {
    const record = this.getSystemPluginCrashMarker(markerId)
    if (!record) throw new Error(`System plugin crash marker "${markerId}" does not exist.`)
    return record
  }

  private requireSystemPluginOsPersistence(
    recordId: string
  ): SystemPluginOsPersistenceRecord {
    const record = this.getSystemPluginOsPersistence(recordId)
    if (!record) throw new Error(`System plugin OS persistence record "${recordId}" does not exist.`)
    return record
  }

  private assertSystemPackageOwnership(pluginId: string, packageId: string | null): void {
    if (!packageId) return
    const packageRecord = this.requireSystemPluginPackage(packageId)
    if (packageRecord.pluginId !== pluginId) {
      throw new Error('System plugin package belongs to another plugin.')
    }
  }

  private assertSystemAuditReferences(
    pluginId: string,
    installationId: string | null,
    packageId: string | null,
    requestId: string | null,
    runId: string | null
  ): void {
    if (installationId) {
      const installation = this.requireSystemPluginInstallation(installationId)
      if (installation.pluginId !== pluginId) {
        throw new Error('System plugin audit installation belongs to another plugin.')
      }
    }
    if (packageId) this.assertSystemPackageOwnership(pluginId, packageId)
    if (requestId) {
      const request = this.requireSystemPluginInstallRequest(requestId)
      if (request.pluginId !== pluginId) {
        throw new Error('System plugin audit request belongs to another plugin.')
      }
    }
    if (runId) {
      const run = this.requireSystemPluginRun(runId)
      if (run.pluginId !== pluginId) {
        throw new Error('System plugin audit run belongs to another plugin.')
      }
      if (installationId && run.installationId !== installationId) {
        throw new Error('System plugin audit run does not belong to its installation.')
      }
      if (packageId && run.packageId !== packageId) {
        throw new Error('System plugin audit run does not belong to its package.')
      }
    }
  }
}

function mapDefinition(row: DefinitionRow): PluginDefinitionRecord {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    persistenceScope: row.persistence_scope,
    createdSessionId: row.created_session_id,
    currentRevisionId: row.current_revision_id,
    pendingRevisionId: row.pending_revision_id,
    activeRunId: row.active_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapRevision(row: RevisionRow): PluginRevisionRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    contentHash: row.content_hash,
    previousRevisionId: row.previous_revision_id,
    manifest: parseJson(row.manifest_json, 'Plugin revision manifest') as unknown as PluginV2Manifest,
    requestedPermissions: parseJson(
      row.requested_permissions_json,
      'Plugin revision permissions'
    ) as unknown as PluginV2Manifest['permissions'],
    apiVersion: row.api_version,
    stateSchemaVersion: row.state_schema_version,
    sizeBytes: row.size_bytes,
    staticCheckStatus: row.static_check_status,
    staticCheckDiagnostics: parseJson(row.static_check_json, 'Plugin static check diagnostics'),
    generatedBySessionId: row.generated_by_session_id,
    createdAt: row.created_at
  }
}

function mapGrantSet(row: GrantRow): PluginGrantSet {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    revisionId: row.revision_id,
    ...(row.installation_id ? { installationId: row.installation_id } : {}),
    scope: scopeFromRow(row.scope_kind, row.workspace_id, row.session_id),
    grants: parseJson(row.grants_json, 'Plugin grants') as unknown as PluginGrantSet['grants'],
    createdAt: row.created_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {})
  }
}

function mapInstallation(row: InstallationRow): PluginInstallationRecord {
  if ((row.enabled !== 0 && row.enabled !== 1) || (row.quarantined !== 0 && row.quarantined !== 1)) {
    throw new Error('Stored plugin installation enabled flag is corrupt.')
  }
  return {
    id: row.id,
    pluginId: row.plugin_id,
    scope: scopeFromRow(row.scope_kind, row.workspace_id, row.session_id),
    enabled: row.enabled === 1,
    currentRevisionId: row.current_revision_id,
    pendingRevisionId: row.pending_revision_id,
    activeRunId: row.active_run_id,
    currentGrantSetId: row.current_grant_set_id,
    pendingGrantSetId: row.pending_grant_set_id,
    lastError: row.last_error_json
      ? parseJson(row.last_error_json, 'Plugin installation error')
      : null,
    quarantined: row.quarantined === 1,
    violationCount: row.violation_count,
    quarantineReason: row.quarantine_reason_json
      ? parseJson(row.quarantine_reason_json, 'Plugin quarantine reason')
      : null,
    quarantinedAt: row.quarantined_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapRun(row: RunRow): PluginRunRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    revisionId: row.revision_id,
    installationId: row.installation_id,
    grantSetId: row.grant_set_id,
    scope: scopeFromRow(row.scope_kind, row.workspace_id, row.session_id),
    epoch: row.epoch,
    status: row.status,
    error: row.error_json ? parseJson(row.error_json, 'Plugin run error') : null,
    startedAt: row.started_at,
    readyAt: row.ready_at,
    stoppedAt: row.stopped_at,
    updatedAt: row.updated_at
  }
}

function mapPluginLog(row: LogRow): PluginLogRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    revisionId: row.revision_id,
    runId: row.run_id,
    level: row.level,
    event: row.event,
    message: row.message,
    data: row.data_json === null ? null : parseJson(row.data_json, 'Plugin log data'),
    createdAt: row.created_at
  }
}

function mapSystemPluginInstallRequest(row: SystemPluginInstallRequestRow): SystemPluginInstallRequest {
  if (
    row.restart_required !== 1
    || !['awaiting-confirmation', 'confirmed-restart-required', 'cancelled'].includes(row.status)
  ) {
    throw new Error('Stored system plugin install request is corrupt.')
  }
  const permissions = parseJson(row.system_permissions_json, 'System plugin permissions')
  if (!Array.isArray(permissions) || permissions.some((permission) => typeof permission !== 'string')) {
    throw new Error('Stored system plugin permissions are corrupt.')
  }
  return {
    id: row.id,
    pluginId: row.plugin_id,
    name: row.name,
    version: row.version,
    publisher: row.publisher,
    artifactSha256: row.artifact_sha256,
    systemPermissions: permissions as string[],
    reason: row.reason,
    requestedBy: row.requested_by,
    status: row.status,
    restartRequired: true,
    stagedArtifactPath: row.staged_artifact_path,
    computedArtifactSha256: row.computed_artifact_sha256,
    manifestSnapshot: row.manifest_snapshot_json === null
      ? null
      : parseJson(row.manifest_snapshot_json, 'System plugin manifest snapshot'),
    dependencyPlan: row.dependency_plan_json === null
      ? null
      : parseJson(row.dependency_plan_json, 'System plugin dependency plan'),
    confirmationVersion: row.confirmation_version,
    installationId: row.installation_id,
    error: row.error_json === null
      ? null
      : parseJson(row.error_json, 'System plugin install request error'),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}

function mapSystemPluginPackage(row: SystemPluginPackageRow): SystemPluginPackageRecord {
  normalizeSystemPluginPackageStatus(row.status)
  return {
    id: row.id,
    pluginId: row.plugin_id,
    version: row.version,
    publisher: row.publisher,
    contentHash: row.content_hash,
    artifactPath: row.artifact_path,
    manifestSnapshot: parseJson(row.manifest_snapshot_json, 'System plugin manifest snapshot'),
    fileManifest: parseJson(row.file_manifest_json, 'System plugin file manifest'),
    runtimeFingerprint: row.runtime_fingerprint_json === null
      ? null
      : parseJson(row.runtime_fingerprint_json, 'System plugin runtime fingerprint'),
    status: row.status,
    sourceRequestId: row.source_request_id,
    error: row.error_json === null
      ? null
      : parseJson(row.error_json, 'System plugin package error'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at
  }
}

function mapSystemPluginInstallation(
  row: SystemPluginInstallationRow
): SystemPluginInstallationRecord {
  if (
    (row.enabled !== 0 && row.enabled !== 1)
    || (row.auto_start !== 0 && row.auto_start !== 1)
    || (row.safe_mode_disabled !== 0 && row.safe_mode_disabled !== 1)
  ) {
    throw new Error('Stored system plugin installation flags are corrupt.')
  }
  normalizeSystemPluginInstallationStatus(row.status)
  return {
    id: row.id,
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    autoStart: row.auto_start === 1,
    safeModeDisabled: row.safe_mode_disabled === 1,
    status: row.status,
    currentPackageId: row.current_package_id,
    pendingPackageId: row.pending_package_id,
    lastError: row.last_error_json === null
      ? null
      : parseJson(row.last_error_json, 'System plugin installation error'),
    backupPath: row.backup_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapSystemPluginRun(row: SystemPluginRunRow): SystemPluginRunRecord {
  normalizeSystemPluginRunComponent(row.component)
  normalizeSystemPluginRunStatus(row.status)
  normalizeNonNegativeInteger(row.restart_count, 'Stored system plugin restart count')
  return {
    id: row.id,
    pluginId: row.plugin_id,
    installationId: row.installation_id,
    packageId: row.package_id,
    component: row.component,
    status: row.status,
    pid: row.pid,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    restartCount: row.restart_count,
    health: row.health_json === null
      ? null
      : parseJson(row.health_json, 'System plugin run health'),
    error: row.error_json === null
      ? null
      : parseJson(row.error_json, 'System plugin run error'),
    logPath: row.log_path,
    startedAt: row.started_at,
    readyAt: row.ready_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    stoppedAt: row.stopped_at,
    updatedAt: row.updated_at
  }
}

function mapSystemPluginAudit(row: SystemPluginAuditRow): SystemPluginAuditRecord {
  normalizeSystemPluginAuditActor(row.actor)
  normalizeSystemPluginAuditOutcome(row.outcome)
  return {
    id: row.id,
    pluginId: row.plugin_id,
    installationId: row.installation_id,
    packageId: row.package_id,
    requestId: row.request_id,
    runId: row.run_id,
    actor: row.actor,
    action: row.action,
    outcome: row.outcome,
    details: row.details_json === null
      ? null
      : parseJson(row.details_json, 'System plugin audit details'),
    createdAt: row.created_at
  }
}

function mapSystemPluginDependencyJob(
  row: SystemPluginDependencyJobRow
): SystemPluginDependencyJobRecord {
  normalizeSystemPluginDependencyJobKind(row.kind)
  normalizeSystemPluginPackageManager(row.package_manager)
  normalizeSystemPluginDependencyJobStatus(row.status)
  const command = parseJson(row.command_json, 'System plugin dependency command')
  return {
    id: row.id,
    pluginId: row.plugin_id,
    packageId: row.package_id,
    installationId: row.installation_id,
    requestId: row.request_id,
    kind: row.kind,
    packageManager: row.package_manager,
    command: normalizeSystemPluginCommand(command),
    status: row.status,
    pid: row.pid,
    exitCode: row.exit_code,
    logPath: row.log_path,
    error: row.error_json === null
      ? null
      : parseJson(row.error_json, 'System plugin dependency job error'),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  }
}

function mapSystemPluginCrashMarker(
  row: SystemPluginCrashMarkerRow
): SystemPluginCrashMarkerRecord {
  normalizeSystemPluginCrashMarkerState(row.state)
  return {
    id: row.id,
    pluginId: row.plugin_id,
    installationId: row.installation_id,
    packageId: row.package_id,
    runId: row.run_id,
    phase: row.phase,
    state: row.state,
    error: row.error_json === null
      ? null
      : parseJson(row.error_json, 'System plugin crash marker error'),
    recovery: row.recovery_json === null
      ? null
      : parseJson(row.recovery_json, 'System plugin crash marker recovery'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    clearedAt: row.cleared_at
  }
}

function mapSystemPluginOsPersistence(
  row: SystemPluginOsPersistenceRow
): SystemPluginOsPersistenceRecord {
  const command = normalizeSystemPluginOsPersistenceCommand(
    parseJson(row.command_json, 'System plugin OS persistence command')
  )
  normalizeSystemPluginOsPersistenceMethod(row.method)
  normalizeSystemPluginOsPersistenceStatus(row.status)
  return {
    id: row.id,
    pluginId: row.plugin_id,
    installationId: row.installation_id,
    packageId: row.package_id,
    revisionHash: normalizeRevisionId(row.revision_hash),
    serviceId: row.service_id,
    method: row.method,
    command,
    descriptor: parseJson(
      row.descriptor_json,
      'System plugin OS persistence descriptor'
    ),
    status: row.status,
    error: row.error_json === null
      ? null
      : parseJson(row.error_json, 'System plugin OS persistence error'),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at
  }
}

function validateRevisionPackageMetadata(revisionPackage: PluginRevisionPackage): void {
  if (!revisionPackage || typeof revisionPackage !== 'object') {
    throw new Error('Plugin revision package is required.')
  }
  const id = normalizeRevisionId(revisionPackage.revisionId)
  if (id !== `sha256:${revisionPackage.contentHash}`) {
    throw new Error('Plugin revision id must match its content hash.')
  }
  if (!Number.isSafeInteger(revisionPackage.sizeBytes) || revisionPackage.sizeBytes < 0) {
    throw new Error('Plugin revision size must be a non-negative integer.')
  }
  normalizeId(revisionPackage.manifest?.id, 'Plugin manifest id')
}

function normalizeRevisionId(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('Plugin revision id must use sha256:<64 lowercase hex>.')
  }
  return value
}

function normalizeId(value: unknown, label: string, maxLength = 200): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    !normalized
    || normalized.length > maxLength
    || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(normalized)
  ) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function normalizeNullableId(
  value: unknown,
  label: string
): string | null {
  return value === undefined || value === null ? null : normalizeId(value, label, 500)
}

function normalizeStateKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!key || key.length > 200 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(key)) {
    throw new Error('Plugin state key is invalid.')
  }
  return key
}

function normalizeStateSchemaVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    throw new Error('Plugin state schema version is invalid.')
  }
  return value as number
}

function normalizeStateValues(value: unknown): Record<string, PluginJsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Plugin state migration values must be an object.')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 10_000) {
    throw new Error('Plugin state migration contains too many keys.')
  }
  const result: Record<string, PluginJsonValue> = {}
  for (const [key, entry] of entries) {
    normalizeStateKey(key)
    result[key] = parseJson(
      stringifyJson(entry as PluginJsonValue, 'Plugin state migration value'),
      'Plugin state migration value'
    )
  }
  return result
}

function normalizeName(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 200) {
    throw new Error('Plugin name is required and must not exceed 200 characters.')
  }
  return normalized
}

function normalizeBoundedText(value: unknown, label: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid.`)
  return normalized
}

function normalizeSystemPermissions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error('System plugin permissions must contain from 1 to 64 entries.')
  }
  const permissions = value.map((permission, index) => {
    const normalized = typeof permission === 'string' ? permission.trim() : ''
    if (!normalized || normalized.length > 200 || !/^[a-z][a-z0-9._:-]*$/i.test(normalized)) {
      throw new Error(`System plugin permission ${index} is invalid.`)
    }
    return normalized
  })
  if (new Set(permissions).size !== permissions.length) {
    throw new Error('System plugin permissions cannot contain duplicates.')
  }
  return permissions.sort((left, right) => left.localeCompare(right, 'en'))
}

function normalizeSystemPluginPackageStatus(
  value: unknown
): SystemPluginPackageRecord['status'] {
  if (value === 'staged' || value === 'installing' || value === 'ready' || value === 'failed') {
    return value
  }
  throw new Error('System plugin package status is invalid.')
}

function normalizeSystemPluginInstallationStatus(
  value: unknown
): SystemPluginInstallationRecord['status'] {
  if (
    value === 'disabled'
    || value === 'pending-restart'
    || value === 'starting'
    || value === 'active'
    || value === 'failed'
    || value === 'safe-mode-disabled'
    || value === 'uninstall-pending'
  ) {
    return value
  }
  throw new Error('System plugin installation status is invalid.')
}

function normalizeSystemPluginRunComponent(value: unknown): SystemPluginRunRecord['component'] {
  if (value === 'main' || value === 'renderer' || value === 'service' || value === 'detached') {
    return value
  }
  throw new Error('System plugin run component is invalid.')
}

function normalizeSystemPluginRunStatus(value: unknown): SystemPluginRunRecord['status'] {
  if (
    value === 'starting'
    || value === 'ready'
    || value === 'stopping'
    || value === 'stopped'
    || value === 'failed'
  ) {
    return value
  }
  throw new Error('System plugin run status is invalid.')
}

function normalizeSystemPluginAuditActor(value: unknown): SystemPluginAuditRecord['actor'] {
  if (value === 'user' || value === 'assistant' || value === 'system' || value === 'plugin') {
    return value
  }
  throw new Error('System plugin audit actor is invalid.')
}

function normalizeSystemPluginAuditOutcome(value: unknown): SystemPluginAuditRecord['outcome'] {
  if (value === 'success' || value === 'failure' || value === 'denied') return value
  throw new Error('System plugin audit outcome is invalid.')
}

function normalizeSystemPluginDependencyJobKind(
  value: unknown
): SystemPluginDependencyJobRecord['kind'] {
  if (value === 'install' || value === 'build' || value === 'native-rebuild') return value
  throw new Error('System plugin dependency job kind is invalid.')
}

function normalizeSystemPluginPackageManager(
  value: unknown
): SystemPluginDependencyJobRecord['packageManager'] {
  if (value === 'npm' || value === 'pnpm' || value === 'yarn') return value
  throw new Error('System plugin package manager is invalid.')
}

function normalizeSystemPluginDependencyJobStatus(
  value: unknown
): SystemPluginDependencyJobRecord['status'] {
  if (
    value === 'pending'
    || value === 'running'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'cancelled'
  ) {
    return value
  }
  throw new Error('System plugin dependency job status is invalid.')
}

function normalizeSystemPluginCrashMarkerState(
  value: unknown
): SystemPluginCrashMarkerRecord['state'] {
  if (value === 'armed' || value === 'ready' || value === 'failed' || value === 'recovered') {
    return value
  }
  throw new Error('System plugin crash marker state is invalid.')
}

function normalizeSystemPluginOsPersistenceMethod(
  value: unknown
): SystemPluginOsPersistenceRecord['method'] {
  if (value === 'electron-login-item' || value === 'linux-autostart-desktop') {
    return value
  }
  throw new Error('System plugin OS persistence method is invalid.')
}

function normalizeSystemPluginOsPersistenceStatus(
  value: unknown
): SystemPluginOsPersistenceRecord['status'] {
  if (
    value === 'awaiting-confirmation'
    || value === 'registered'
    || value === 'requires-approval'
    || value === 'disabled'
    || value === 'cancelled'
    || value === 'removed'
    || value === 'mismatch'
    || value === 'failed'
  ) {
    return value
  }
  throw new Error('System plugin OS persistence status is invalid.')
}

function normalizeSystemPluginOsPersistenceCommand(
  value: unknown
): SystemPluginOsPersistenceRecord['command'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('System plugin OS persistence command is invalid.')
  }
  const command = value as Record<string, unknown>
  const executable = normalizePath(
    command.executable,
    'System plugin OS persistence executable'
  )
  if (!Array.isArray(command.args) || command.args.length > 128) {
    throw new Error('System plugin OS persistence arguments are invalid.')
  }
  let totalLength = executable.length
  const args = command.args.map((argument, index) => {
    if (
      typeof argument !== 'string'
      || argument.length > 32_768
      || argument.includes('\0')
    ) {
      throw new Error(`System plugin OS persistence argument ${index} is invalid.`)
    }
    totalLength += argument.length
    return argument
  })
  if (totalLength > 64 * 1024) {
    throw new Error('System plugin OS persistence command is too large.')
  }
  return { executable, args }
}

function normalizeSystemPluginAction(value: unknown): string {
  return normalizeId(value, 'System plugin audit action', 200)
}

function normalizeSystemPluginPhase(value: unknown): string {
  return normalizeId(value, 'System plugin crash marker phase', 200)
}

function normalizeSystemPluginCommand(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error('System plugin dependency command must contain from 1 to 64 arguments.')
  }
  let totalLength = 0
  const result = value.map((part, index) => {
    const normalized = typeof part === 'string' ? part.trim() : ''
    if (!normalized || normalized.length > 8_192) {
      throw new Error(`System plugin dependency command argument ${index} is invalid.`)
    }
    totalLength += normalized.length
    return normalized
  })
  if (totalLength > 32_768) {
    throw new Error('System plugin dependency command is too large.')
  }
  return result
}

function normalizeExactSemver(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!semver.valid(normalized)) throw new Error(`${label} must be an exact semantic version.`)
  return normalized
}

function normalizeSha256(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} is invalid.`)
  return normalized
}

function normalizeNullableSha256(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : normalizeSha256(value, label)
}

function normalizePath(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 32_768 || normalized.includes('\0')) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function normalizeNullablePath(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : normalizePath(value, label)
}

function normalizeRequiredJson(value: unknown, label: string): PluginJsonValue {
  return parseJson(stringifyJsonWithLimit(value as PluginJsonValue, label), label)
}

function normalizeNullableJson(value: unknown, label: string): PluginJsonValue | null {
  if (value === undefined || value === null) return null
  return normalizeRequiredJson(value as PluginJsonValue, label)
}

function stringifyJsonWithLimit(value: PluginJsonValue, label: string): string {
  const json = stringifyJson(value, label)
  if (Buffer.byteLength(json, 'utf8') > 4 * 1024 * 1024) {
    throw new Error(`${label} exceeds 4194304 bytes.`)
  }
  return json
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`)
  return value
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
  return value as number
}

function normalizeNullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value as number
}

function normalizeNullableInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer.`)
  return value as number
}

function normalizeNullablePid(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value as number
}

function normalizeNullableBoundedText(
  value: unknown,
  label: string,
  maximum: number
): string | null {
  if (value === undefined || value === null) return null
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid.`)
  return normalized
}

function normalizeNullableDate(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : normalizeDate(value, label)
}

function normalizeDefinitionSource(value: unknown): PluginDefinitionSource {
  if (value === 'builtin' || value === 'dynamic' || value === 'marketplace' || value === 'system' || value === 'legacy') {
    return value
  }
  throw new Error('Plugin definition source is invalid.')
}

function normalizePersistenceScope(value: unknown): PluginPersistenceScope {
  if (value === 'session-preview' || value === 'workspace') {
    return value
  }
  throw new Error('Plugin persistence scope is invalid.')
}

function assertInstallationScope(
  definition: PluginDefinitionRecord,
  scope: PluginPlatformScope
): void {
  if (
    definition.persistenceScope === 'session-preview'
    && (
      scope.kind !== 'session'
      || !definition.createdSessionId
      || scope.sessionId !== definition.createdSessionId
    )
  ) {
    throw new Error('Session-preview plugins require an installation in their owning session.')
  }
}

function normalizeStaticCheckStatus(value: unknown): PluginStaticCheckStatus {
  if (value === 'passed' || value === 'warning' || value === 'failed') {
    return value
  }
  throw new Error('Plugin static check status is invalid.')
}

function normalizeRunStatus(value: unknown): PluginRunStatus {
  if (value === 'staging' || value === 'active' || value === 'draining' || value === 'stopped' || value === 'failed') {
    return value
  }
  throw new Error('Plugin run status is invalid.')
}

function normalizeDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid date.`)
  }
  return new Date(value).toISOString()
}

function normalizeListLimit(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000) {
    throw new Error(`${label} must be an integer from 1 to 1000.`)
  }
  return value as number
}

function stringifyJson(value: PluginJsonValue, label: string): string {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) {
      throw new Error('undefined is not JSON')
    }
    return json
  } catch (error) {
    throw new Error(`${label} must be valid JSON.`, { cause: error })
  }
}

function parseJson(value: string, label: string): PluginJsonValue {
  try {
    return JSON.parse(value) as PluginJsonValue
  } catch (error) {
    throw new Error(`${label} is corrupt.`, { cause: error })
  }
}

function scopeColumns(scope: PluginPlatformScope): {
  kind: PluginPlatformScope['kind']
  workspaceId: string | null
  sessionId: string | null
} {
  switch (scope.kind) {
    case 'app':
      return { kind: 'app', workspaceId: null, sessionId: null }
    case 'workspace':
      return { kind: 'workspace', workspaceId: scope.workspaceId, sessionId: null }
    case 'session':
      return { kind: 'session', workspaceId: scope.workspaceId, sessionId: scope.sessionId }
  }
}

function scopeFromRow(
  kind: PluginPlatformScope['kind'],
  workspaceId: string | null,
  sessionId: string | null
): PluginPlatformScope {
  if (kind === 'app' && !workspaceId && !sessionId) {
    return { kind: 'app' }
  }
  if (kind === 'workspace' && workspaceId && !sessionId) {
    return { kind: 'workspace', workspaceId }
  }
  if (kind === 'session' && workspaceId && sessionId) {
    return { kind: 'session', workspaceId, sessionId }
  }
  throw new Error('Stored plugin scope is corrupt.')
}
