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
  created_at: string
  resolved_at: string | null
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
    const row = this.db.prepare(`
      SELECT * FROM system_plugin_install_requests WHERE id = ?
    `).get(requestId) as SystemPluginInstallRequestRow | undefined
    if (!row) throw new Error(`System plugin install request "${requestId}" does not exist.`)
    return mapSystemPluginInstallRequest(row)
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
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
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
