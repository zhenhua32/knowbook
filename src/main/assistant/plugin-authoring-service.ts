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
  type PluginRevisionRecord,
  type PluginStaticCheckStatus,
  type SqlitePluginPlatformRepository
} from '../plugin-platform'
import { getPluginPlatformScopeKey } from '../plugin-platform/scope'

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
}

export interface PluginActivationApprovalRequest {
  status: 'awaiting-approval'
  approvalId: AssistantApprovalId
  runId: string
  revisionId: string
  expiresAt: string
  risk: 'low' | 'medium' | 'high'
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
    const toolCall = listAllEvents(this.sessions, context.sessionId).find((event) => (
      event.type === 'tool.call'
      && event.payload.toolCallId === context.toolCallId
      && event.payload.turnId === context.turnId
    ))
    if (!toolCall || toolCall.type !== 'tool.call' || toolCall.payload.tool !== 'plugins.activate_revision') {
      throw new Error('Plugin approval requires the exact persisted activate_revision tool call.')
    }
    const toolArguments = toolCall.payload.arguments
    if (
      !toolArguments
      || typeof toolArguments !== 'object'
      || Array.isArray(toolArguments)
      || toolArguments.pluginId !== input.pluginId
      || toolArguments.revisionId !== input.revisionId
      || !isSameScope(toolArguments.scope, input.scope)
    ) {
      throw new Error('Plugin activation request does not match its persisted tool arguments.')
    }
    const definition = this.plugins.getDefinition(input.pluginId)
    const revision = this.plugins.getRevision(input.revisionId)
    if (!definition || !revision || revision.pluginId !== definition.id) {
      throw new Error('Plugin activation target does not exist.')
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
      definition.persistenceScope === 'session-preview'
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
    this.sessions.append(context.sessionId, {
      type: 'plugin.run.requested',
      payload: {
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        pluginId: definition.id,
        revisionId: revision.id,
        runId
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
        expiresAt
      }
    })
    return {
      status: 'awaiting-approval',
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

    const grantSetId = randomUUID()
    this.plugins.createGrantSet({
      id: grantSetId,
      pluginId: revision.pluginId,
      revisionId: revision.id,
      scope: request.payload.scope,
      grants: revision.manifest.permissions.map((permission) => ({
        capability: permission.capability,
        version: permission.version
      })),
      createdAt: this.now().toISOString(),
      expiresAt: request.payload.expiresAt
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
    try {
      const receipt = await this.coordinator.activate({
        pluginId: revision.pluginId,
        revisionId: revision.id,
        grantSetId,
        scope: request.payload.scope,
        runId: runRequest.payload.runId
      })
      this.sessions.append(sessionId, {
        type: 'plugin.run.succeeded',
        payload: {
          pluginId: revision.pluginId,
          revisionId: revision.id,
          runId: runRequest.payload.runId,
          epoch: receipt.owner.epoch
        }
      })
      return {
        status: 'succeeded',
        approvalId,
        grantSetId,
        runId: runRequest.payload.runId,
        revisionId: revision.id,
        epoch: receipt.owner.epoch
      }
    } catch (error) {
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
  }

  private requireActiveTurn(context: PluginAuthoringContext): void {
    const session = this.sessions.getSession(context.sessionId)
    if (!session || session.status !== 'active' || session.activeTurnId !== context.turnId) {
      throw new Error('Plugin authoring tool requires the matching active assistant turn.')
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
