import { randomUUID } from 'node:crypto'
import type { AssistantSessionId } from '@shared/assistant-session'
import type {
  PluginActiveOwner,
  PluginJsonValue,
  PluginPlatformScope
} from '@shared/plugin-platform'
import type { WorkspaceEvent } from '../event-bus'
import type { KnowbookStore } from '../database/store'
import { AssistantPluginAuthoringService } from '../assistant/plugin-authoring-service'
import { PluginActivationCoordinator } from './activation-coordinator'
import {
  PluginCapabilityBroker,
  type PluginCapabilityAuditRecord
} from './capability-broker'
import {
  registerCorePluginCapabilities,
  type CorePluginCapabilityHooks
} from './core-capabilities'
import { PluginPlatformKernel } from './kernel'
import { QuickJsWasiPluginRuntimeFactory } from './quickjs-runtime-client'
import { QuickJsPluginRevisionValidator } from './quickjs-validator'
import { PluginRevisionStore } from './revision-store'
import { clonePluginRuntimeJson } from './runtime-json'
import { ACTIVITY_PULSE_V2_PACKAGE } from './builtin-activity-pulse'

const EVENT_CONTRIBUTION_SLOT = 'workspace.event'

export interface PluginPlatformV2ServiceOptions extends CorePluginCapabilityHooks {
  workspaceId: string
}

export interface PluginEventSubscriptionValue {
  types: string[]
  handlerId: string
  includeSelf?: boolean
}

/** Composition root for the v2 kernel, broker, immutable objects, AI tools, and runtime. */
export class PluginPlatformV2Service {
  readonly kernel = new PluginPlatformKernel()
  readonly revisions: PluginRevisionStore
  readonly broker: PluginCapabilityBroker
  readonly coordinator: PluginActivationCoordinator
  readonly authoring: AssistantPluginAuthoringService
  private readonly validator = new QuickJsPluginRevisionValidator()
  private readonly disposeCapabilities: () => void
  private destroyed = false

  constructor(
    private readonly store: KnowbookStore,
    revisionRoot: string,
    private readonly options: PluginPlatformV2ServiceOptions
  ) {
    this.store.pluginPlatform.recoverInterruptedRuns()
    this.revisions = new PluginRevisionStore(revisionRoot)
    this.broker = new PluginCapabilityBroker(this.kernel, {
      audit: (record) => this.auditCapability(record)
    })
    this.disposeCapabilities = registerCorePluginCapabilities(this.broker, this.store, options)
    this.coordinator = new PluginActivationCoordinator(
      this.kernel,
      this.broker,
      this.store.pluginPlatform,
      this.revisions,
      new QuickJsWasiPluginRuntimeFactory()
    )
    this.authoring = new AssistantPluginAuthoringService(
      this.store.assistantSessions,
      this.store.pluginPlatform,
      this.revisions,
      this.broker,
      this.coordinator,
      this.validator
    )
  }

  /** Activates host-shipped, reviewed revisions without a conversational approval prompt. */
  async activateBuiltinPlugins(): Promise<void> {
    this.assertUsable()
    await this.activateBuiltin(ACTIVITY_PULSE_V2_PACKAGE)
  }

  listContributions<T extends PluginJsonValue>(
    slot: string,
    scope: PluginPlatformScope
  ): Array<{
    owner: PluginActiveOwner
    id: string
    order: number
    value: T
  }> {
    return this.kernel.listContributions<T>(slot, scope).map((contribution) => ({
      owner: contribution.owner,
      id: contribution.descriptor.id,
      order: contribution.descriptor.order,
      value: clonePluginRuntimeJson(contribution.value, `Plugin contribution ${slot}`) as T
    }))
  }

  /** Workspace UI includes durable workspace plugins and live session-preview plugins. */
  listExperienceContributions<T extends PluginJsonValue>(slot: string): Array<{
    owner: PluginActiveOwner
    id: string
    order: number
    value: T
  }> {
    const result = new Map<string, {
      owner: PluginActiveOwner
      id: string
      order: number
      value: T
    }>()
    for (const scope of this.eventConsumerScopes()) {
      for (const contribution of this.listContributions<T>(slot, scope)) {
        result.set(`${contribution.owner.runId}\0${contribution.id}`, contribution)
      }
    }
    return [...result.values()].sort((left, right) => left.order - right.order)
  }

  invokeHandler(
    owner: PluginActiveOwner,
    handlerId: string,
    input: PluginJsonValue
  ): Promise<PluginJsonValue> {
    return this.coordinator.invokeHandler(owner, handlerId, input)
  }

  async handleWorkspaceEvent(event: WorkspaceEvent): Promise<void> {
    if (this.destroyed) {
      return
    }
    const scopes = this.eventConsumerScopes()
    const subscriptions = new Map<string, ReturnType<typeof this.kernel.listContributions<PluginEventSubscriptionValue>>[number]>()
    for (const scope of scopes) {
      for (const contribution of this.kernel.listContributions<PluginEventSubscriptionValue>(
        EVENT_CONTRIBUTION_SLOT,
        scope
      )) {
        subscriptions.set(`${contribution.owner.runId}\0${contribution.descriptor.id}`, contribution)
      }
    }

    await Promise.all([...subscriptions.values()].map(async (contribution) => {
      let subscription: PluginEventSubscriptionValue
      try {
        subscription = parseEventSubscription(contribution.value)
      } catch (error) {
        this.logRuntimeFailure(contribution.owner, 'event.subscription.invalid', error)
        return
      }
      if (!subscription.types.includes(event.type)) {
        return
      }
      const originPluginId = readOptionalEventOrigin(event)
      if (!subscription.includeSelf && originPluginId === contribution.owner.pluginId) {
        return
      }
      try {
        await this.coordinator.invokeHandler(
          contribution.owner,
          subscription.handlerId,
          clonePluginRuntimeJson({ event }, 'Plugin workspace event')
        )
      } catch (error) {
        this.logRuntimeFailure(contribution.owner, 'event.handler.failed', error)
      }
    }))
  }

  getSessionScope(sessionId: AssistantSessionId): PluginPlatformScope {
    return {
      kind: 'session',
      workspaceId: this.options.workspaceId,
      sessionId
    }
  }

  getWorkspaceScope(): PluginPlatformScope {
    return { kind: 'workspace', workspaceId: this.options.workspaceId }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    const activeRuns = this.store.pluginPlatform.listRunsByStatus(['active'])
    await Promise.allSettled(activeRuns.map((run) => (
      this.coordinator.stop(run.pluginId, run.scope)
    )))
    await this.kernel.destroy()
    this.disposeCapabilities()
  }

  private async activateBuiltin(input: typeof ACTIVITY_PULSE_V2_PACKAGE): Promise<void> {
    const revisionPackage = this.revisions.publish(input)
    let definition = this.store.pluginPlatform.getDefinition(revisionPackage.manifest.id)
    if (!definition) {
      definition = this.store.pluginPlatform.createDefinition({
        id: revisionPackage.manifest.id,
        name: revisionPackage.manifest.name,
        source: 'builtin',
        persistenceScope: 'workspace'
      })
    } else if (definition.source !== 'builtin') {
      throw new Error(`Built-in plugin id "${definition.id}" conflicts with ${definition.source} plugin metadata.`)
    }
    const validation = await this.validator.validate(revisionPackage)
    if (validation.status === 'failed') {
      throw new Error(`Built-in plugin "${definition.id}" failed validation: ${JSON.stringify(validation.diagnostics)}`)
    }
    const existingRevision = this.store.pluginPlatform.getRevision(revisionPackage.revisionId)
    const previousRevisionId = existingRevision?.previousRevisionId ?? definition.currentRevisionId
    const revision = this.store.pluginPlatform.createRevision({
      package: revisionPackage,
      previousRevisionId,
      staticCheckStatus: validation.status,
      staticCheckDiagnostics: validation.diagnostics
    })
    const scope = this.getWorkspaceScope()
    const grantSetId = `builtin:${revision.contentHash.slice(0, 32)}:${this.options.workspaceId}`
    let grant = this.store.pluginPlatform.getGrantSet(grantSetId)
    if (!grant) {
      grant = this.store.pluginPlatform.createGrantSet({
        id: grantSetId,
        pluginId: revision.pluginId,
        revisionId: revision.id,
        scope,
        grants: revision.manifest.permissions.map((permission) => ({
          capability: permission.capability,
          version: permission.version
        })),
        createdAt: new Date().toISOString()
      })
    }
    await this.coordinator.activate({
      pluginId: revision.pluginId,
      revisionId: revision.id,
      grantSetId: grant.id,
      scope
    })
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw new Error('Plugin Platform v2 is shutting down.')
    }
  }

  private eventConsumerScopes(): PluginPlatformScope[] {
    const scopes: PluginPlatformScope[] = [this.getWorkspaceScope()]
    const seen = new Set(scopes.map(scopeKey))
    for (const run of this.store.pluginPlatform.listRunsByStatus(['active'])) {
      if (run.scope.kind !== 'session' || run.scope.workspaceId !== this.options.workspaceId) {
        continue
      }
      const key = scopeKey(run.scope)
      if (!seen.has(key)) {
        seen.add(key)
        scopes.push(run.scope)
      }
    }
    return scopes
  }

  private auditCapability(record: PluginCapabilityAuditRecord): void {
    try {
      this.store.pluginPlatform.appendPluginLog({
        id: randomUUID(),
        pluginId: record.pluginId,
        revisionId: record.revisionId,
        runId: record.runId,
        level: record.outcome === 'succeeded' ? 'info' : 'warning',
        event: 'capability.audit',
        message: `${record.capability}@${record.version}: ${record.outcome}`,
        data: clonePluginRuntimeJson(record, 'Plugin capability audit')
      })
    } catch {
      // Broker contract intentionally keeps audit transport failures non-fatal.
    }
  }

  private logRuntimeFailure(owner: PluginActiveOwner, event: string, error: unknown): void {
    try {
      this.store.pluginPlatform.appendPluginLog({
        id: randomUUID(),
        pluginId: owner.pluginId,
        revisionId: owner.revisionId,
        runId: owner.runId,
        level: 'error',
        event,
        message: normalizeError(error).message.slice(0, 2_000)
      })
    } catch {
      // Runtime logging must not take down workspace event dispatch.
    }
  }
}

function parseEventSubscription(value: unknown): PluginEventSubscriptionValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Plugin event subscription must be an object.')
  }
  const candidate = value as Record<string, unknown>
  const unknown = Object.keys(candidate).find(
    (key) => !['types', 'handlerId', 'includeSelf'].includes(key)
  )
  if (unknown) {
    throw new Error(`Plugin event subscription contains unknown field "${unknown}".`)
  }
  if (
    !Array.isArray(candidate.types)
    || candidate.types.length === 0
    || candidate.types.length > 64
    || candidate.types.some((type) => typeof type !== 'string' || type.length > 100)
  ) {
    throw new Error('Plugin event subscription types are invalid.')
  }
  const handlerId = typeof candidate.handlerId === 'string' ? candidate.handlerId.trim() : ''
  if (!handlerId || handlerId.length > 200 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(handlerId)) {
    throw new Error('Plugin event subscription handlerId is invalid.')
  }
  if (candidate.includeSelf !== undefined && typeof candidate.includeSelf !== 'boolean') {
    throw new Error('Plugin event subscription includeSelf must be a boolean.')
  }
  return {
    types: [...new Set(candidate.types as string[])],
    handlerId,
    ...(candidate.includeSelf === undefined ? {} : { includeSelf: candidate.includeSelf as boolean })
  }
}

function scopeKey(scope: PluginPlatformScope): string {
  switch (scope.kind) {
    case 'app':
      return 'app'
    case 'workspace':
      return `workspace:${scope.workspaceId}`
    case 'session':
      return `session:${scope.workspaceId}:${scope.sessionId}`
  }
}

function readOptionalEventOrigin(event: WorkspaceEvent): string | null {
  const origin = (event as WorkspaceEvent & { originPluginId?: unknown }).originPluginId
  return typeof origin === 'string' ? origin : null
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(typeof error === 'string' ? error : 'Plugin runtime failed.')
}
