import { randomUUID } from 'node:crypto'
import type {
  PluginActivationIdentity,
  PluginActiveOwner,
  PluginCapabilityCall,
  PluginCommitReceipt,
  PluginContributionDescriptor,
  PluginJsonValue,
  PluginPlatformScope,
  PluginRevisionPackage
} from '@shared/plugin-platform'
import { PluginCapabilityBroker } from './capability-broker'
import { PluginPlatformKernel } from './kernel'
import type {
  PluginRunRecord,
  SqlitePluginPlatformRepository
} from './repository'
import { PluginRevisionStore } from './revision-store'
import { clonePluginRuntimeJson } from './runtime-json'

const MAX_ACTIVATION_CONTRIBUTIONS = 256

export interface PluginRuntimeContribution {
  descriptor: PluginContributionDescriptor
  value: PluginJsonValue
}

export interface PluginRuntimeActivationSnapshot {
  contributions: readonly PluginRuntimeContribution[]
}

export interface NoNodePluginRuntimeHostContext {
  identity: PluginActivationIdentity
  package: PluginRevisionPackage
  callCapability: (call: PluginCapabilityCall) => Promise<PluginJsonValue>
}

export interface NoNodePluginRuntimeInstance {
  activate: () => Promise<PluginRuntimeActivationSnapshot>
  commit: (owner: PluginActiveOwner) => void
  invokeHandler: (
    owner: PluginActiveOwner,
    handlerId: string,
    input: PluginJsonValue,
    signal: AbortSignal
  ) => Promise<PluginJsonValue>
  dispose: () => void | Promise<void>
}

/**
 * This SPI intentionally has no Node fallback. Production adapters must embed
 * a separately terminable realm that has no process/require/Electron globals.
 */
export interface NoNodePluginRuntimeFactory {
  readonly isolation: 'no-node-isolate'
  create: (context: NoNodePluginRuntimeHostContext) => Promise<NoNodePluginRuntimeInstance>
}

export interface ActivatePluginRevisionInput {
  pluginId: string
  revisionId: string
  grantSetId: string
  scope: PluginPlatformScope
  runId?: string
  drainTimeoutMs?: number
}

type ActiveRuntime = {
  owner: PluginActiveOwner
  runtime: NoNodePluginRuntimeInstance
}

type PluginPlatformLifecycleRepository = Pick<
  SqlitePluginPlatformRepository,
  | 'getDefinition'
  | 'getRevision'
  | 'getGrantSet'
  | 'createRun'
  | 'markRunActive'
  | 'markRunFailed'
  | 'markRunStopped'
  | 'getRun'
>

/** Coordinates verified objects, runtime readiness, kernel commit, and SQLite pointers. */
export class PluginActivationCoordinator {
  private readonly activeRuntimes = new Map<string, ActiveRuntime>()

  constructor(
    private readonly kernel: PluginPlatformKernel,
    private readonly broker: PluginCapabilityBroker,
    private readonly repository: PluginPlatformLifecycleRepository,
    private readonly revisions: PluginRevisionStore,
    private readonly runtimeFactory: NoNodePluginRuntimeFactory
  ) {
    if (runtimeFactory.isolation !== 'no-node-isolate') {
      throw new Error('Dynamic plugins require a no-node-isolate runtime factory.')
    }
  }

  async activate(input: ActivatePluginRevisionInput): Promise<PluginCommitReceipt> {
    const definition = this.repository.getDefinition(input.pluginId)
    if (!definition) {
      throw new Error(`Plugin definition "${input.pluginId}" does not exist.`)
    }
    const revision = this.repository.getRevision(input.revisionId)
    if (!revision || revision.pluginId !== definition.id) {
      throw new Error(`Plugin revision "${input.revisionId}" does not belong to "${definition.id}".`)
    }
    const revisionPackage = this.revisions.load(input.revisionId)
    if (
      revisionPackage.manifest.id !== definition.id
      || revisionPackage.contentHash !== revision.contentHash
    ) {
      throw new Error('Plugin revision object does not match its persisted metadata.')
    }
    const grantSet = this.repository.getGrantSet(input.grantSetId)
    if (!grantSet) {
      throw new Error(`Active plugin grant set "${input.grantSetId}" does not exist.`)
    }
    this.broker.registerGrantSet(grantSet)

    const identity: PluginActivationIdentity = {
      pluginId: definition.id,
      revisionId: revision.id,
      runId: input.runId ?? randomUUID(),
      grantSetId: grantSet.id,
      scope: input.scope
    }
    const run = this.repository.createRun({
      id: identity.runId,
      pluginId: identity.pluginId,
      revisionId: identity.revisionId,
      grantSetId: identity.grantSetId,
      scope: identity.scope
    })
    const stage = this.kernel.beginActivation(identity)
    let committedOwner: PluginActiveOwner | null = null

    try {
      const runtime = await this.runtimeFactory.create({
        identity,
        package: revisionPackage,
        callCapability: (call) => {
          if (!committedOwner) {
            return Promise.reject(new Error('Plugin capabilities are unavailable before atomic commit.'))
          }
          return this.broker.invoke(committedOwner, call)
        }
      })
      stage.own(async () => {
        const active = this.activeRuntimes.get(identity.runId)
        if (active?.runtime === runtime) {
          this.activeRuntimes.delete(identity.runId)
        }
        await runtime.dispose()
      }, 'isolated-runtime')

      const snapshot = normalizeActivationSnapshot(await runtime.activate())
      for (const contribution of snapshot.contributions) {
        stage.contribute(contribution.descriptor, contribution.value)
      }

      const receipt = await stage.commit(input.drainTimeoutMs, (owner, previousOwner) => {
        runtime.commit(owner)
        committedOwner = owner
        this.activeRuntimes.set(owner.runId, { owner, runtime })
        this.repository.markRunActive(run.id, owner.epoch, previousOwner?.runId ?? null)
      })

      void receipt.previousDrain
        .then((result) => {
          if (result) {
            this.repository.markRunStopped(result.owner.runId)
          }
        })
        .catch(() => undefined)
      return receipt
    } catch (error) {
      if (stage.state !== 'disposed' && stage.state !== 'active') {
        try {
          await stage.abort()
        } catch {
          // The primary activation error is persisted below.
        }
      }
      const persistedRun = this.repository.getRun(run.id)
      if (persistedRun && persistedRun.status !== 'failed' && persistedRun.status !== 'stopped') {
        try {
          this.repository.markRunFailed(run.id, serializeRuntimeError(error))
        } catch (persistenceError) {
          throw new AggregateError(
            [normalizeError(error), normalizeError(persistenceError)],
            `Plugin run "${run.id}" failed and its diagnostic could not be persisted.`
          )
        }
      }
      throw error
    }
  }

  async invokeHandler(
    owner: PluginActiveOwner,
    handlerId: string,
    input: PluginJsonValue
  ): Promise<PluginJsonValue> {
    const active = this.activeRuntimes.get(owner.runId)
    if (!active || active.owner.epoch !== owner.epoch || active.owner.revisionId !== owner.revisionId) {
      throw new Error(`Plugin runtime "${owner.runId}" is stale or unavailable.`)
    }
    const id = normalizeHandlerId(handlerId)
    const normalizedInput = clonePluginRuntimeJson(input, 'Plugin handler input')
    return this.kernel.runWithActiveOwner(owner, async (signal) => {
      const result = await active.runtime.invokeHandler(owner, id, normalizedInput, signal)
      return clonePluginRuntimeJson(result, 'Plugin handler result')
    })
  }

  getActiveOwner(runId: string): PluginActiveOwner | null {
    return this.activeRuntimes.get(runId)?.owner ?? null
  }

  async stop(
    pluginId: string,
    scope: PluginPlatformScope,
    drainTimeoutMs?: number
  ): Promise<PluginRunRecord | null> {
    const owner = this.kernel.getActiveOwner(pluginId, scope)
    if (!owner) {
      return null
    }
    await this.kernel.stop(pluginId, scope, drainTimeoutMs)
    return this.repository.markRunStopped(owner.runId)
  }
}

function normalizeActivationSnapshot(raw: unknown): PluginRuntimeActivationSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Plugin activation snapshot must be an object.')
  }
  const candidate = raw as Record<string, unknown>
  const unknownKey = Object.keys(candidate).find((key) => key !== 'contributions')
  if (unknownKey) {
    throw new Error(`Plugin activation snapshot contains unknown field "${unknownKey}".`)
  }
  if (!Array.isArray(candidate.contributions) || candidate.contributions.length > MAX_ACTIVATION_CONTRIBUTIONS) {
    throw new Error(
      `Plugin activation snapshot must contain at most ${MAX_ACTIVATION_CONTRIBUTIONS} contributions.`
    )
  }

  const seen = new Set<string>()
  const contributions = candidate.contributions.map((rawContribution, index): PluginRuntimeContribution => {
    if (!rawContribution || typeof rawContribution !== 'object' || Array.isArray(rawContribution)) {
      throw new Error(`Plugin contribution ${index} must be an object.`)
    }
    const contribution = rawContribution as Record<string, unknown>
    const descriptor = contribution.descriptor
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      throw new Error(`Plugin contribution ${index} descriptor must be an object.`)
    }
    const descriptorCandidate = descriptor as Record<string, unknown>
    const slot = normalizeContributionPart(descriptorCandidate.slot, 'slot')
    const id = normalizeContributionPart(descriptorCandidate.id, 'id')
    const order = descriptorCandidate.order
    if (order !== undefined && (!Number.isFinite(order) || Math.abs(order as number) > 100_000)) {
      throw new Error(`Plugin contribution ${index} order is invalid.`)
    }
    const key = `${slot}\0${id}`
    if (seen.has(key)) {
      throw new Error(`Plugin contribution "${slot}/${id}" is duplicated.`)
    }
    seen.add(key)
    return {
      descriptor: { slot, id, ...(order === undefined ? {} : { order: order as number }) },
      value: clonePluginRuntimeJson(contribution.value, `Plugin contribution ${slot}/${id}`)
    }
  })
  return { contributions }
}

function normalizeContributionPart(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 200 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(normalized)) {
    throw new Error(`Plugin contribution ${label} is invalid.`)
  }
  return normalized
}

function normalizeHandlerId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id || id.length > 200 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(id)) {
    throw new Error('Plugin handler id is invalid.')
  }
  return id
}

function serializeRuntimeError(error: unknown): PluginJsonValue {
  const normalized = normalizeError(error)
  return {
    name: normalized.name,
    message: normalized.message.slice(0, 2_000)
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(typeof error === 'string' && error.trim() ? error.trim() : 'Unknown plugin activation failure.')
}
