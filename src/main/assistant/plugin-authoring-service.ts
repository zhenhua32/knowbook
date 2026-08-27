import { createHash, randomUUID } from 'node:crypto'
import type {
  AssistantApprovalId,
  AssistantEvent,
  AssistantSessionId,
  AssistantToolCallId,
  AssistantTurnId
} from '@shared/assistant-session'
import {
  assistantApprovalId
} from '@shared/assistant-session'
import type {
  PluginJsonValue,
  PluginPlatformScope,
  PluginRevisionPackage,
  PluginRevisionPackageInput
} from '@shared/plugin-platform'
import type { SqliteAssistantSessionRepository } from './session-repository'
import {
  PluginActivationCoordinator,
  PluginCapabilityBroker,
  PluginRevisionStore,
  type PluginCapabilityCatalogEntry,
  type PluginDefinitionRecord,
  type PluginLogRecord,
  type PluginRevisionRecord,
  type PluginRunRecord,
  type PluginStaticCheckStatus,
  type SqlitePluginPlatformRepository
} from '../plugin-platform'
import { getPluginPlatformScopeKey } from '../plugin-platform/scope'
import { clonePluginRuntimeJson } from '../plugin-platform/runtime-json'

const DEFAULT_APPROVAL_LIFETIME_MS = 10 * 60 * 1000
const MAX_APPROVAL_LIFETIME_MS = 60 * 60 * 1000

export interface PluginRevisionValidationResult {
  status: PluginStaticCheckStatus
  diagnostics: PluginJsonValue
}

export interface PluginRevisionValidator {
  /** Must inspect/compile only. It must not activate or execute plugin logic. */
  validate: (revision: PluginRevisionPackage) => PluginRevisionValidationResult | Promise<PluginRevisionValidationResult>
}

export interface PluginAuthoringContext {
  sessionId: AssistantSessionId
  turnId: AssistantTurnId
}

export interface PluginApprovalContext extends PluginAuthoringContext {
  toolCallId: AssistantToolCallId
}

export interface DefinePluginRevisionInput extends PluginRevisionPackageInput {
  previousRevisionId?: string | null
}

export interface PluginRevisionDiff {
  previousRevisionId: string | null
  workerChanged: boolean
  viewsChanged: boolean
  permissionsAdded: string[]
  permissionsRemoved: string[]
  standardModulesAdded: string[]
  standardModulesRemoved: string[]
  assetsAdded: string[]
  assetsRemoved: string[]
  assetsChanged: string[]
}

export interface DefinePluginRevisionResult {
  revision: PluginRevisionRecord
  diff: PluginRevisionDiff
}

export interface RequestPluginActivationInput {
  pluginId: string
  revisionId: string
  scope: PluginPlatformScope
  summary: string
  approvalLifetimeMs?: number
  runId?: string
  operation?: 'activate' | 'rollback' | 'install-workspace'
  fromRevisionId?: string
}

export interface PluginActivationApprovalRequest {
  status: 'awaiting-approval'
  operation: 'activate' | 'rollback' | 'install-workspace'
  approvalId: AssistantApprovalId
  runId: string
  revisionId: string
  expiresAt: string
  risk: 'low' | 'medium' | 'high'
}

export interface PluginListItem {
  definition: PluginDefinitionRecord
  revisionCount: number
  activeRun: PluginRunRecord | null
}

export interface PluginInspection {
  definition: PluginDefinitionRecord
  revisions: PluginRevisionRecord[]
  runs: PluginRunRecord[]
}

export interface PluginDiagnostics {
  pluginId: string
  runs: PluginRunRecord[]
  logs: PluginLogRecord[]
}

export interface StopPluginInput {
  pluginId: string
  scope: PluginPlatformScope
}

export interface RollbackPluginInput {
  pluginId: string
  targetRevisionId: string
  scope: PluginPlatformScope
  summary: string
  approvalLifetimeMs?: number
  runId?: string
}

export interface InstallPluginWorkspaceInput {
  pluginId: string
  revisionId: string
  scope: Extract<PluginPlatformScope, { kind: 'workspace' }>
  summary: string
  approvalLifetimeMs?: number
  runId?: string
}

export type PluginApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export type ResolvePluginApprovalResult =
  | { status: 'rejected' | 'cancelled' | 'unavailable'; approvalId: AssistantApprovalId }
  | {
      status: 'succeeded'
      approvalId: AssistantApprovalId
      grantSetId: string
      runId: string
      revisionId: string
      epoch: number
    }
  | {
      status: 'failed'
      approvalId: AssistantApprovalId
      grantSetId: string
      runId: string
      revisionId: string
      error: PluginJsonValue
    }

/** Built-in assistant tools for the immutable define/approve/activate loop. */
export class AssistantPluginAuthoringService {
  private readonly now: () => Date

  constructor(
    private readonly sessions: SqliteAssistantSessionRepository,
    private readonly plugins: SqlitePluginPlatformRepository,
    private readonly revisions: PluginRevisionStore,
    private readonly broker: PluginCapabilityBroker,
    private readonly coordinator: PluginActivationCoordinator,
    private readonly validator: PluginRevisionValidator,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  inspectCapabilities(): PluginCapabilityCatalogEntry[] {
    return this.broker.listCapabilities()
  }

  listPlugins(context: PluginAuthoringContext): PluginListItem[] {
    this.requireActiveTurn(context)
    const session = this.sessions.getSession(context.sessionId)!
    return this.plugins.listDefinitions()
      .filter((definition) => isDefinitionVisible(definition, context.sessionId))
      .map((definition) => {
        const sessionInstallation = this.plugins.getInstallationForScope(definition.id, {
          kind: 'session', workspaceId: session.workspaceId, sessionId: context.sessionId
        })
        const workspaceInstallation = this.plugins.getInstallationForScope(definition.id, {
          kind: 'workspace', workspaceId: session.workspaceId
        })
        const activeRunId = sessionInstallation?.activeRunId ?? workspaceInstallation?.activeRunId ?? null
        return {
          definition,
          revisionCount: this.plugins.listRevisions(definition.id).length,
          activeRun: activeRunId ? this.plugins.getRun(activeRunId) : null
        }
      })
  }

  inspectPlugin(context: PluginAuthoringContext, pluginId: string): PluginInspection {
    this.requireActiveTurn(context)
    const definition = this.requireVisibleDefinition(context.sessionId, pluginId)
    return {
      definition,
      revisions: this.plugins.listRevisions(definition.id),
      runs: this.plugins.listPluginRuns(definition.id)
    }
  }

  inspectRevision(
    context: PluginAuthoringContext,
    pluginId: string,
    revisionId: string
  ): PluginRevisionRecord {
    const inspection = this.inspectPlugin(context, pluginId)
    const revision = inspection.revisions.find((candidate) => candidate.id === revisionId)
    if (!revision) {
      throw new Error(`Plugin revision "${revisionId}" does not belong to "${inspection.definition.id}".`)
    }
    return revision
  }

  previewRevision(
    context: PluginAuthoringContext,
    pluginId: string,
    revisionId: string
  ): PluginJsonValue {
    const revision = this.inspectRevision(context, pluginId, revisionId)
    const currentPackage = this.revisions.load(revision.id)
    const previousPackage = revision.previousRevisionId
      ? this.revisions.load(revision.previousRevisionId)
      : null
    return buildRevisionPreview(previousPackage, currentPackage, revision)
  }

  readDiagnostics(
    context: PluginAuthoringContext,
    pluginId: string,
    limit = 100
  ): PluginDiagnostics {
    this.requireActiveTurn(context)
    const definition = this.requireVisibleDefinition(context.sessionId, pluginId)
    return {
      pluginId: definition.id,
      runs: this.plugins.listPluginRuns(definition.id, limit),
      logs: this.plugins.listPluginLogs(definition.id, limit)
    }
  }

  async stopPlugin(
    context: PluginAuthoringContext,
    input: StopPluginInput
  ): Promise<PluginRunRecord> {
    this.requireActiveTurn(context)
    const definition = this.requireVisibleDefinition(context.sessionId, input.pluginId)
    this.assertScopeAccess(context.sessionId, definition, input.scope)
    const installation = this.plugins.getInstallationForScope(definition.id, input.scope)
    const activeRun = installation?.activeRunId ? this.plugins.getRun(installation.activeRunId) : null
    if (!activeRun) {
      throw new Error(`Plugin "${definition.id}" has no active run in the requested scope.`)
    }
    const stopped = await this.coordinator.stop(definition.id, input.scope)
    if (!stopped) {
      throw new Error(`Plugin "${definition.id}" stopped before the request could be committed.`)
    }
    this.plugins.revokeGrantSet(stopped.grantSetId)
    this.broker.revokeGrantSet(stopped.grantSetId)
    this.sessions.append(context.sessionId, {
      type: 'plugin.run.stopped',
      payload: {
        pluginId: stopped.pluginId,
        revisionId: stopped.revisionId,
        runId: stopped.id
      }
    })
    return stopped
  }

  requestRollback(
    context: PluginApprovalContext,
    input: RollbackPluginInput
  ): PluginActivationApprovalRequest {
    this.requireActiveTurn(context)
    const definition = this.requireVisibleDefinition(context.sessionId, input.pluginId)
    this.assertScopeAccess(context.sessionId, definition, input.scope)
    const installation = this.plugins.getInstallationForScope(definition.id, input.scope)
    const fromRevisionId = installation?.currentRevisionId ?? null
    if (!fromRevisionId) {
      throw new Error(`Plugin "${definition.id}" has no successful revision to roll back from.`)
    }
    if (fromRevisionId === input.targetRevisionId) {
      throw new Error('Plugin rollback target is already the current revision.')
    }
    if (!this.plugins.wasRevisionActivated(definition.id, input.targetRevisionId)) {
      throw new Error('Plugin rollback target must be a retained revision that activated successfully.')
    }
    return this.requestActivation(context, {
      pluginId: definition.id,
      revisionId: input.targetRevisionId,
      scope: input.scope,
      summary: input.summary,
      approvalLifetimeMs: input.approvalLifetimeMs,
      runId: input.runId,
      operation: 'rollback',
      fromRevisionId
    })
  }

  requestWorkspaceInstallation(
    context: PluginApprovalContext,
    input: InstallPluginWorkspaceInput
  ): PluginActivationApprovalRequest {
    this.requireActiveTurn(context)
    const definition = this.requireVisibleDefinition(context.sessionId, input.pluginId)
    if (
      definition.persistenceScope !== 'session-preview'
      || definition.createdSessionId !== context.sessionId
    ) {
      throw new Error('Only an owning session-preview plugin can be saved to the workspace.')
    }
    return this.requestActivation(context, {
      pluginId: definition.id,
      revisionId: input.revisionId,
      scope: input.scope,
      summary: input.summary,
      approvalLifetimeMs: input.approvalLifetimeMs,
      runId: input.runId,
      operation: 'install-workspace'
    })
  }

  async defineRevision(
    context: PluginAuthoringContext,
    input: DefinePluginRevisionInput
  ): Promise<DefinePluginRevisionResult> {
    this.requireActiveTurn(context)
    const revisionPackage = this.revisions.publish(input)
    let definition = this.plugins.getDefinition(revisionPackage.manifest.id)
    if (!definition) {
      definition = this.plugins.createDefinition({
        id: revisionPackage.manifest.id,
        name: revisionPackage.manifest.name,
        source: 'dynamic',
        persistenceScope: 'session-preview',
        createdSessionId: context.sessionId
      })
    } else if (definition.source !== 'dynamic') {
      throw new Error(`Assistant cannot replace ${definition.source} plugin "${definition.id}".`)
    }

    const previousRevisionId = input.previousRevisionId === undefined
      ? definition.pendingRevisionId ?? definition.currentRevisionId
      : input.previousRevisionId
    const previousPackage = previousRevisionId
      ? this.revisions.load(previousRevisionId)
      : null
    const validation = await this.validator.validate(revisionPackage)
    const revision = this.plugins.createRevision({
      package: revisionPackage,
      previousRevisionId,
      staticCheckStatus: validation.status,
      staticCheckDiagnostics: validation.diagnostics,
      generatedBySessionId: context.sessionId
    })

    this.sessions.append(context.sessionId, {
      type: 'plugin.revision.defined',
      payload: {
        turnId: context.turnId,
        pluginId: definition.id,
        revisionId: revision.id,
        previousRevisionId: revision.previousRevisionId
      }
    })
    this.sessions.append(context.sessionId, {
      type: 'plugin.validation.completed',
      payload: {
        turnId: context.turnId,
        pluginId: definition.id,
        revisionId: revision.id,
        status: validation.status,
        diagnostics: validation.diagnostics
      }
    })
    return {
      revision,
      diff: diffRevisionPackages(previousPackage, revisionPackage)
    }
  }

  requestActivation(
    context: PluginApprovalContext,
    input: RequestPluginActivationInput
  ): PluginActivationApprovalRequest {
    this.requireActiveTurn(context)
    const operation = input.operation ?? 'activate'
    const expectedTool = operation === 'rollback'
      ? 'plugins.rollback'
      : operation === 'install-workspace'
        ? 'plugins.install_workspace'
        : 'plugins.activate_revision'
    const toolCall = listAllEvents(this.sessions, context.sessionId).find((event) => (
      event.type === 'tool.call'
      && event.payload.toolCallId === context.toolCallId
      && event.payload.turnId === context.turnId
    ))
    if (!toolCall || toolCall.type !== 'tool.call' || toolCall.payload.tool !== expectedTool) {
      throw new Error(`Plugin approval requires the exact persisted ${expectedTool} tool call.`)
    }
    const toolArguments = toolCall.payload.arguments
    const persistedRevisionId = operation === 'rollback'
      && toolArguments
      && typeof toolArguments === 'object'
      && !Array.isArray(toolArguments)
      ? toolArguments.targetRevisionId
      : toolArguments && typeof toolArguments === 'object' && !Array.isArray(toolArguments)
        ? toolArguments.revisionId
        : undefined
    if (
      !toolArguments
      || typeof toolArguments !== 'object'
      || Array.isArray(toolArguments)
      || toolArguments.pluginId !== input.pluginId
      || persistedRevisionId !== input.revisionId
      || toolArguments.summary !== input.summary
      || !isSameScope(toolArguments.scope, input.scope)
    ) {
      throw new Error('Plugin activation request does not match its persisted tool arguments.')
    }
    const definition = this.plugins.getDefinition(input.pluginId)
    const revision = this.plugins.getRevision(input.revisionId)
    if (!definition || !revision || revision.pluginId !== definition.id) {
      throw new Error('Plugin activation target does not exist.')
    }
    if (operation === 'install-workspace') {
      if (
        definition.persistenceScope !== 'session-preview'
        || definition.createdSessionId !== context.sessionId
        || input.scope.kind !== 'workspace'
      ) {
        throw new Error('Workspace installation requires the owning preview plugin and workspace scope.')
      }
    } else {
      this.assertScopeAccess(context.sessionId, definition, input.scope)
    }
    if (operation === 'rollback') {
      if (
        !input.fromRevisionId
        || this.plugins.getInstallationForScope(definition.id, input.scope)?.currentRevisionId !== input.fromRevisionId
        || revision.id === input.fromRevisionId
      ) {
        throw new Error('Plugin rollback source no longer matches the current successful revision.')
      }
      if (!this.plugins.wasRevisionActivated(definition.id, revision.id)) {
        throw new Error('Plugin rollback target must be a retained revision that activated successfully.')
      }
    }
    if (revision.staticCheckStatus === 'failed') {
      throw new Error('Plugin revision failed validation and cannot request activation.')
    }
    const availableCapabilities = new Set(
      this.broker.listCapabilities().map((capability) => `${capability.id}@${capability.version}`)
    )
    const missingCapability = revision.manifest.permissions.find((permission) => (
      !availableCapabilities.has(`${permission.capability}@${permission.version}`)
    ))
    if (missingCapability) {
      throw new Error(
        `Plugin capability "${missingCapability.capability}@${missingCapability.version}" is unavailable.`
      )
    }
    if (
      operation !== 'install-workspace'
      && definition.persistenceScope === 'session-preview'
      && (
        input.scope.kind !== 'session'
        || input.scope.sessionId !== context.sessionId
      )
    ) {
      throw new Error('Session-preview plugins can only activate inside their owning assistant session.')
    }

    const lifetime = normalizeApprovalLifetime(input.approvalLifetimeMs)
    const expiresAt = new Date(this.now().getTime() + lifetime).toISOString()
    const approvalId = assistantApprovalId(randomUUID())
    const runId = input.runId ?? randomUUID()
    const risk = classifyPermissionRisk(revision.manifest.permissions.map((permission) => permission.capability))
    const permissions = JSON.parse(JSON.stringify(revision.manifest.permissions)) as PluginJsonValue
    const revisionPreview = buildRevisionPreview(
      revision.previousRevisionId ? this.revisions.load(revision.previousRevisionId) : null,
      this.revisions.load(revision.id),
      revision
    )
    this.sessions.append(context.sessionId, {
      type: 'plugin.run.requested',
      payload: {
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        pluginId: definition.id,
        revisionId: revision.id,
        runId,
        operation,
        ...(operation === 'rollback' ? { fromRevisionId: input.fromRevisionId as string } : {})
      }
    })
    this.sessions.append(context.sessionId, {
      type: 'approval.requested',
      payload: {
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        approvalId,
        pluginId: definition.id,
        revisionId: revision.id,
        scope: input.scope,
        permissions,
        summary: normalizeSummary(input.summary),
        risk,
        expiresAt,
        revisionPreview
      }
    })
    return {
      status: 'awaiting-approval',
      operation,
      approvalId,
      runId,
      revisionId: revision.id,
      expiresAt,
      risk
    }
  }

  async resolveActivationApproval(
    sessionId: AssistantSessionId,
    approvalId: AssistantApprovalId,
    decision: PluginApprovalDecision
  ): Promise<ResolvePluginApprovalResult> {
    const events = listAllEvents(this.sessions, sessionId)
    const request = findApprovalRequest(events, approvalId)
    if (!request) {
      throw new Error(`Plugin approval "${approvalId}" does not exist.`)
    }
    if (events.some((event) => (
      event.type === 'approval.resolved' && event.payload.approvalId === approvalId
    ))) {
      throw new Error(`Plugin approval "${approvalId}" was already resolved.`)
    }
    const runRequest = [...events].reverse().find((event) => (
      event.type === 'plugin.run.requested'
      && event.payload.toolCallId === request.payload.toolCallId
      && event.payload.revisionId === request.payload.revisionId
    ))
    if (!runRequest || runRequest.type !== 'plugin.run.requested') {
      throw new Error('Plugin approval is missing its exact run request.')
    }

    const finalDecision = decision === 'allowed-once'
      && Date.parse(request.payload.expiresAt) <= this.now().getTime()
      ? 'unavailable'
      : decision
    if (finalDecision !== 'allowed-once') {
      this.sessions.append(sessionId, {
        type: 'approval.resolved',
        payload: { approvalId, decision: finalDecision }
      })
      return { status: finalDecision, approvalId }
    }

    const revision = this.plugins.getRevision(request.payload.revisionId)
    if (!revision || revision.pluginId !== request.payload.pluginId) {
      throw new Error('Approved plugin revision no longer exists.')
    }
    const requestedPermissions = JSON.stringify(request.payload.permissions)
    if (requestedPermissions !== JSON.stringify(revision.manifest.permissions)) {
      throw new Error('Approved permission snapshot no longer matches the immutable revision.')
    }

    const operation = runRequest.payload.operation ?? 'activate'
    const installation = operation === 'install-workspace'
      ? request.payload.scope.kind === 'workspace'
        ? this.plugins.prepareWorkspacePromotionInstallation({
            id: randomUUID(),
            pluginId: revision.pluginId,
            workspaceId: request.payload.scope.workspaceId,
            sessionId
          })
        : (() => { throw new Error('Workspace installation approval scope is invalid.') })()
      : this.plugins.ensureInstallation({
          id: randomUUID(),
          pluginId: revision.pluginId,
          scope: request.payload.scope
        })
    const grantSetId = randomUUID()
    this.plugins.createGrantSet({
      id: grantSetId,
      pluginId: revision.pluginId,
      revisionId: revision.id,
      installationId: installation.id,
      scope: request.payload.scope,
      grants: revision.manifest.permissions.map((permission) => ({
        capability: permission.capability,
        version: permission.version
      })),
      createdAt: this.now().toISOString()
    })
    try {
      this.sessions.append(sessionId, {
        type: 'approval.resolved',
        payload: { approvalId, decision: 'allowed-once', grantSetId }
      })
    } catch (error) {
      this.plugins.revokeGrantSet(grantSetId)
      throw error
    }

    this.sessions.append(sessionId, {
      type: 'plugin.run.started',
      payload: {
        pluginId: revision.pluginId,
        revisionId: revision.id,
        runId: runRequest.payload.runId
      }
    })
    const rollbackFromRevisionId = operation === 'rollback'
      ? runRequest.payload.fromRevisionId
      : undefined
    if (operation === 'rollback' && !rollbackFromRevisionId) {
      this.plugins.revokeGrantSet(grantSetId)
      this.broker.revokeGrantSet(grantSetId)
      throw new Error('Plugin rollback run is missing its source revision identity.')
    }
    let stoppedPreview: Awaited<ReturnType<PluginActivationCoordinator['stop']>> = null
    let receipt: Awaited<ReturnType<PluginActivationCoordinator['activate']>>
    try {
      receipt = await this.coordinator.activate({
        pluginId: revision.pluginId,
        revisionId: revision.id,
        grantSetId,
        installationId: installation.id,
        scope: request.payload.scope,
        runId: runRequest.payload.runId
      })
      if (operation === 'install-workspace') {
        if (request.payload.scope.kind !== 'workspace') {
          throw new Error('Workspace installation approval scope changed before commit.')
        }
        stoppedPreview = await this.coordinator.stop(revision.pluginId, {
          kind: 'session',
          workspaceId: request.payload.scope.workspaceId,
          sessionId
        })
        if (stoppedPreview) {
          this.plugins.revokeGrantSet(stoppedPreview.grantSetId)
          this.broker.revokeGrantSet(stoppedPreview.grantSetId)
        }
        this.plugins.finalizeWorkspacePromotion(installation.id, sessionId)
      }
    } catch (error) {
      if (operation === 'install-workspace') {
        await this.coordinator.stop(revision.pluginId, request.payload.scope).catch(() => null)
      }
      this.plugins.revokeGrantSet(grantSetId)
      this.broker.revokeGrantSet(grantSetId)
      const serialized = serializeError(error)
      this.sessions.append(sessionId, {
        type: 'plugin.run.failed',
        payload: {
          pluginId: revision.pluginId,
          revisionId: revision.id,
          runId: runRequest.payload.runId,
          error: serialized
        }
      })
      return {
        status: 'failed',
        approvalId,
        grantSetId,
        runId: runRequest.payload.runId,
        revisionId: revision.id,
        error: serialized
      }
    }

    // The kernel commit is authoritative. Audit projection failures after this point
    // must never revoke a successfully activated run or its grant.
    try {
      if (stoppedPreview) {
        this.sessions.append(sessionId, {
          type: 'plugin.run.stopped',
          payload: {
            pluginId: stoppedPreview.pluginId,
            revisionId: stoppedPreview.revisionId,
            runId: stoppedPreview.id
          }
        })
      }
      this.sessions.append(sessionId, {
        type: 'plugin.run.succeeded',
        payload: {
          pluginId: revision.pluginId,
          revisionId: revision.id,
          runId: runRequest.payload.runId,
          epoch: receipt.owner.epoch
        }
      })
      if (operation === 'rollback') {
        this.sessions.append(sessionId, {
          type: 'plugin.rollback.completed',
          payload: {
            pluginId: revision.pluginId,
            fromRevisionId: rollbackFromRevisionId as string,
            toRevisionId: revision.id,
            runId: runRequest.payload.runId
          }
        })
      }
    } catch {
      // A later session read can reconcile this committed kernel run.
    }
    return {
      status: 'succeeded',
      approvalId,
      grantSetId,
      runId: runRequest.payload.runId,
      revisionId: revision.id,
      epoch: receipt.owner.epoch
    }
  }

  private requireActiveTurn(context: PluginAuthoringContext): void {
    const session = this.sessions.getSession(context.sessionId)
    if (!session || session.status !== 'active' || session.activeTurnId !== context.turnId) {
      throw new Error('Plugin authoring tool requires the matching active assistant turn.')
    }
  }

  private requireVisibleDefinition(
    sessionId: AssistantSessionId,
    pluginId: string
  ): PluginDefinitionRecord {
    const definition = this.plugins.getDefinition(pluginId)
    if (!definition || !isDefinitionVisible(definition, sessionId)) {
      throw new Error(`Plugin definition "${pluginId}" is not visible in this assistant session.`)
    }
    return definition
  }

  private assertScopeAccess(
    sessionId: AssistantSessionId,
    definition: PluginDefinitionRecord,
    scope: PluginPlatformScope
  ): void {
    if (
      definition.persistenceScope === 'session-preview'
      && (
        definition.createdSessionId !== sessionId
        || scope.kind !== 'session'
        || scope.sessionId !== sessionId
      )
    ) {
      throw new Error('Session-preview plugins can only activate inside their owning assistant session or be stopped there.')
    }
  }
}

function diffRevisionPackages(
  previous: PluginRevisionPackage | null,
  next: PluginRevisionPackage
): PluginRevisionDiff {
  const previousPermissions = new Set(
    previous?.manifest.permissions.map((entry) => `${entry.capability}@${entry.version}`) ?? []
  )
  const nextPermissions = new Set(
    next.manifest.permissions.map((entry) => `${entry.capability}@${entry.version}`)
  )
  const previousModules = new Set(
    previous?.manifest.standardModules.map((entry) => `${entry.id}@${entry.version}`) ?? []
  )
  const nextModules = new Set(
    next.manifest.standardModules.map((entry) => `${entry.id}@${entry.version}`)
  )
  const previousAssets = previous?.assets ?? {}
  const nextAssets = next.assets
  const previousPaths = new Set(Object.keys(previousAssets))
  const nextPaths = new Set(Object.keys(nextAssets))

  return {
    previousRevisionId: previous?.revisionId ?? null,
    workerChanged: previous?.workerSource !== next.workerSource,
    viewsChanged: JSON.stringify(previous?.views ?? null) !== JSON.stringify(next.views),
    permissionsAdded: difference(nextPermissions, previousPermissions),
    permissionsRemoved: difference(previousPermissions, nextPermissions),
    standardModulesAdded: difference(nextModules, previousModules),
    standardModulesRemoved: difference(previousModules, nextModules),
    assetsAdded: difference(nextPaths, previousPaths),
    assetsRemoved: difference(previousPaths, nextPaths),
    assetsChanged: [...nextPaths]
      .filter((path) => previousPaths.has(path) && hashBytes(nextAssets[path]) !== hashBytes(previousAssets[path]))
      .sort()
  }
}

function buildRevisionPreview(
  previous: PluginRevisionPackage | null,
  next: PluginRevisionPackage,
  revision: PluginRevisionRecord
): PluginJsonValue {
  return clonePluginRuntimeJson({
    pluginId: revision.pluginId,
    revisionId: revision.id,
    validation: {
      status: revision.staticCheckStatus,
      diagnostics: revision.staticCheckDiagnostics
    },
    manifest: next.manifest,
    diff: diffRevisionPackages(previous, next),
    code: {
      previous: sourcePreview(previous?.workerSource ?? ''),
      next: sourcePreview(next.workerSource)
    },
    views: {
      previous: previous?.views ?? null,
      next: next.views
    }
  }, 'Plugin revision preview')
}

function sourcePreview(source: string): PluginJsonValue {
  const maximum = 20_000
  return {
    sha256: createHash('sha256').update(source).digest('hex'),
    characters: source.length,
    excerpt: source.length <= maximum ? source : `${source.slice(0, maximum)}\n/* [TRUNCATED] */`
  }
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort()
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function classifyPermissionRisk(capabilities: readonly string[]): 'low' | 'medium' | 'high' {
  if (capabilities.some((capability) => (
    capability.startsWith('network.')
    || capability.startsWith('external.')
    || capability.startsWith('ai.')
    || capability.endsWith('.delete')
  ))) {
    return 'high'
  }
  if (capabilities.some((capability) => (
    capability.endsWith('.create')
    || capability.endsWith('.update')
    || capability.endsWith('.write')
  ))) {
    return 'medium'
  }
  return 'low'
}

function normalizeApprovalLifetime(value: number | undefined): number {
  const normalized = value ?? DEFAULT_APPROVAL_LIFETIME_MS
  if (!Number.isSafeInteger(normalized) || normalized < 1_000 || normalized > MAX_APPROVAL_LIFETIME_MS) {
    throw new Error(`Plugin approval lifetime must be from 1000 to ${MAX_APPROVAL_LIFETIME_MS} ms.`)
  }
  return normalized
}

function normalizeSummary(value: unknown): string {
  const summary = typeof value === 'string' ? value.trim() : ''
  if (!summary || summary.length > 2_000) {
    throw new Error('Plugin approval summary is required and must not exceed 2000 characters.')
  }
  return summary
}

function findApprovalRequest(
  events: readonly AssistantEvent[],
  approvalId: AssistantApprovalId
): Extract<AssistantEvent, { type: 'approval.requested' }> | null {
  const event = [...events].reverse().find((candidate) => (
    candidate.type === 'approval.requested' && candidate.payload.approvalId === approvalId
  ))
  return event?.type === 'approval.requested' ? event : null
}

function listAllEvents(
  sessions: SqliteAssistantSessionRepository,
  sessionId: AssistantSessionId
): AssistantEvent[] {
  const events: AssistantEvent[] = []
  let cursor = 0
  while (true) {
    const page = sessions.listEvents(sessionId, cursor, 1_000)
    events.push(...page)
    if (page.length < 1_000) {
      return events
    }
    cursor = page.at(-1)?.seq ?? cursor
  }
}

function serializeError(error: unknown): PluginJsonValue {
  const normalized = error instanceof Error
    ? error
    : new Error(typeof error === 'string' ? error : 'Unknown plugin activation failure.')
  return {
    name: normalized.name,
    message: normalized.message.slice(0, 2_000)
  }
}

function isSameScope(value: PluginJsonValue | undefined, scope: PluginPlatformScope): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  try {
    return getPluginPlatformScopeKey(value as unknown as PluginPlatformScope)
      === getPluginPlatformScopeKey(scope)
  } catch {
    return false
  }
}

function isDefinitionVisible(
  definition: PluginDefinitionRecord,
  sessionId: AssistantSessionId
): boolean {
  return definition.persistenceScope !== 'session-preview'
    || definition.createdSessionId === sessionId
}
