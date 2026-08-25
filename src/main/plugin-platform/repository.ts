import type Database from 'better-sqlite3'
import type {
  PluginGrantSet,
  PluginJsonValue,
  PluginPlatformScope,
  PluginRevisionPackage,
  PluginV2Manifest
} from '@shared/plugin-platform'
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
  scope_kind: PluginPlatformScope['kind']
  workspace_id: string | null
  session_id: string | null
  grants_json: string
  status: 'active' | 'revoked'
  created_at: string
  expires_at: string | null
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
      ORDER BY created_at DESC, id ASC
    `).all(id) as RevisionRow[]
    return rows.map(mapRevision)
  }

  createGrantSet(input: PluginGrantSet): PluginGrantSet {
    const id = normalizeId(input.id, 'Plugin grant set id')
    const pluginId = normalizeId(input.pluginId, 'Plugin id')
    const revisionId = normalizeRevisionId(input.revisionId)
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
      this.db.prepare(`
        INSERT INTO plugin_grants (
          id, plugin_id, revision_id, scope_kind, workspace_id, session_id,
          grants_json, status, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
      `).run(
        id,
        pluginId,
        revisionId,
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
      return this.requireRun(id)
    })
    return transaction()
  }

  markRunActive(
    runId: string,
    epoch: number,
    expectedPreviousRunId?: string | null
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
      const previousRunId = definition.activeRunId
      if (expectedPreviousRunId !== undefined && previousRunId !== expectedPreviousRunId) {
        throw new Error('Persisted active run pointer diverged from the kernel namespace.')
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

  private requireDefinition(pluginId: string): PluginDefinitionRecord {
    const definition = this.getDefinition(pluginId)
    if (!definition) {
      throw new Error(`Plugin definition "${pluginId}" does not exist.`)
    }
    return definition
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

  private requireRun(runId: string): PluginRunRecord {
    const run = this.getRun(runId)
    if (!run) {
      throw new Error(`Plugin run "${runId}" does not exist.`)
    }
    return run
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
    scope: scopeFromRow(row.scope_kind, row.workspace_id, row.session_id),
    grants: parseJson(row.grants_json, 'Plugin grants') as unknown as PluginGrantSet['grants'],
    createdAt: row.created_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {})
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

function normalizeName(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 200) {
    throw new Error('Plugin name is required and must not exceed 200 characters.')
  }
  return normalized
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
