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
import {
  PLUGIN_UI_SLOT_CATALOG,
  isPluginUiSlot,
  validatePluginUiContribution
} from '@shared/plugin-ui'
import { PluginCapabilityBroker } from './capability-broker'
import { PluginPlatformKernel } from './kernel'
import type {
  PluginRunRecord,
  PluginStateMigrationInput,
  SqlitePluginPlatformRepository
} from './repository'
import { PluginRevisionStore } from './revision-store'
import { clonePluginRuntimeJson } from './runtime-json'
import { validatePluginUiAssets } from './ui-materializer'

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
  reportFatal: (error: Error) => void
}

export interface NoNodePluginRuntimeInstance {
  activate: () => Promise<PluginRuntimeActivationSnapshot>
  migrateState?: (input: PluginRuntimeStateMigrationInput) => Promise<PluginJsonValue>
  validateHandlers?: (handlerIds: readonly string[]) => void | Promise<void>
  health?: () => PluginRuntimeHealth | Promise<PluginRuntimeHealth>
  commit: (owner: PluginActiveOwner) => void
  invokeHandler: (
    owner: PluginActiveOwner,
    handlerId: string,
    input: PluginJsonValue,
    signal: AbortSignal
  ) => Promise<PluginJsonValue>
  dispose: () => void | Promise<void>
}

export interface PluginRuntimeHealth {
  status: 'ready' | 'active'
  handlerCount: number
  pendingCapabilityCalls: number
}

export interface PluginRuntimeStateMigrationInput {
  previousVersion: number
  nextVersion: number
  state: Readonly<Record<string, PluginJsonValue>>
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
  installationId?: string
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
  | 'getInstallation'
  | 'ensureInstallation'
  | 'readPluginStateValues'
  | 'findStateSnapshotForRevision'
  | 'createRun'
  | 'markRunActive'
  | 'markRunFailed'
  | 'markRunStopped'
  | 'getRun'
  | 'recordInstallationViolation'
  | 'revokeGrantSet'
>

/** Coordinates verified objects, runtime readiness, kernel commit, and SQLite pointers. */
export class PluginActivationCoordinator {
  private readonly activeRuntimes = new Map<string, ActiveRuntime>()
  private readonly fatalRuns = new Set<string>()

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
    const installation = input.installationId
      ? this.repository.getInstallation(input.installationId)
      : this.repository.ensureInstallation({
          id: randomUUID(),
          pluginId: definition.id,
          scope: input.scope
        })
    if (
      !installation
      || installation.pluginId !== definition.id
      || JSON.stringify(installation.scope) !== JSON.stringify(input.scope)
    ) {
      throw new Error('Plugin installation does not match the activation plugin and scope.')
    }
    if (grantSet.installationId && grantSet.installationId !== installation.id) {
      throw new Error('Plugin grant set is bound to a different installation.')
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
      installationId: installation.id,
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
        },
        reportFatal: (error) => {
          if (committedOwner) void this.handleRuntimeFatal(committedOwner, error)
        }
      })
      stage.own(async () => {
        const active = this.activeRuntimes.get(identity.runId)
        if (active?.runtime === runtime) {
          this.activeRuntimes.delete(identity.runId)
        }
        await runtime.dispose()
      }, 'isolated-runtime')

      const stateMigration = await this.prepareStateMigration(
        installation,
        revision,
        runtime
      )

      const snapshot = await prepareActivationSnapshot(
        normalizeActivationSnapshot(await runtime.activate()),
        runtime,
        revisionPackage
      )
      for (const contribution of snapshot.contributions) {
        stage.contribute(contribution.descriptor, contribution.value)
      }

      const receipt = await stage.commit(input.drainTimeoutMs, (owner, previousOwner) => {
        runtime.commit(owner)
        committedOwner = owner
        this.activeRuntimes.set(owner.runId, { owner, runtime })
        this.repository.markRunActive(
          run.id,
          owner.epoch,
          previousOwner?.runId ?? null,
          stateMigration ?? undefined
        )
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
    try {
      return await this.kernel.runWithActiveOwner(owner, async (signal) => {
        const result = await active.runtime.invokeHandler(owner, id, normalizedInput, signal)
        return clonePluginRuntimeJson(result, 'Plugin handler result')
      })
    } catch (error) {
      if (isRuntimeViolation(error) && !this.fatalRuns.has(owner.runId)) {
        const run = this.repository.getRun(owner.runId)
        if (run?.installationId) {
          const installation = this.repository.recordInstallationViolation(
            run.installationId,
            serializeRuntimeError(error)
          )
          if (installation.quarantined && this.kernel.isCurrent(owner)) {
            this.repository.revokeGrantSet(owner.grantSetId)
            this.broker.revokeGrantSet(owner.grantSetId)
            await this.kernel.stop(owner.pluginId, owner.scope)
            const persisted = this.repository.getRun(owner.runId)
            if (persisted && persisted.status !== 'failed' && persisted.status !== 'stopped') {
              this.repository.markRunStopped(owner.runId)
            }
          }
        }
      }
      throw error
    }
  }

  private async handleRuntimeFatal(owner: PluginActiveOwner, error: Error): Promise<void> {
    if (this.fatalRuns.has(owner.runId)) return
    this.fatalRuns.add(owner.runId)
    const run = this.repository.getRun(owner.runId)
    if (run?.installationId) {
      this.repository.recordInstallationViolation(run.installationId, serializeRuntimeError(error))
    }
    this.repository.revokeGrantSet(owner.grantSetId)
    this.broker.revokeGrantSet(owner.grantSetId)
    if (this.kernel.isCurrent(owner)) await this.kernel.stop(owner.pluginId, owner.scope)
    const persisted = this.repository.getRun(owner.runId)
    if (persisted && persisted.status !== 'failed' && persisted.status !== 'stopped') {
      this.repository.markRunFailed(owner.runId, serializeRuntimeError(error))
    }
  }

  private async prepareStateMigration(
    installation: NonNullable<ReturnType<PluginPlatformLifecycleRepository['getInstallation']>>,
    targetRevision: NonNullable<ReturnType<PluginPlatformLifecycleRepository['getRevision']>>,
    runtime: NoNodePluginRuntimeInstance
  ): Promise<PluginStateMigrationInput | null> {
    if (!installation.currentRevisionId || installation.currentRevisionId === targetRevision.id) {
      return null
    }
    const previousRevision = this.repository.getRevision(installation.currentRevisionId)
    if (!previousRevision || previousRevision.pluginId !== targetRevision.pluginId) {
      throw new Error('Plugin installation points to a missing current revision.')
    }
    const fromSchemaVersion = previousRevision.stateSchemaVersion ?? 1
    const toSchemaVersion = targetRevision.stateSchemaVersion ?? 1
    if (fromSchemaVersion === toSchemaVersion) {
      return null
    }
    const rollbackSnapshot = this.repository.findStateSnapshotForRevision(
      installation.id,
      targetRevision.id
    )
    if (rollbackSnapshot && rollbackSnapshot.schemaVersion === toSchemaVersion) {
      return {
        fromRevisionId: previousRevision.id,
        fromSchemaVersion,
        toSchemaVersion,
        values: rollbackSnapshot.values
      }
    }
    if (!runtime.migrateState) {
      throw new Error(
        `Plugin state schema changes from ${fromSchemaVersion} to ${toSchemaVersion}, but migrateState is not implemented.`
      )
    }
    const output = await runtime.migrateState({
      previousVersion: fromSchemaVersion,
      nextVersion: toSchemaVersion,
      state: this.repository.readPluginStateValues(targetRevision.pluginId, installation.scope)
    })
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      throw new Error('Plugin migrateState must return a JSON object keyed by storage key.')
    }
    return {
      fromRevisionId: previousRevision.id,
      fromSchemaVersion,
      toSchemaVersion,
      values: clonePluginRuntimeJson(output, 'Plugin migrated state') as Record<string, PluginJsonValue>
    }
  }

  getActiveOwner(runId: string): PluginActiveOwner | null {
    return this.activeRuntimes.get(runId)?.owner ?? null
  }

  async getRuntimeHealth(runId: string): Promise<PluginRuntimeHealth | null> {
    const active = this.activeRuntimes.get(runId)
    if (!active || !this.kernel.isCurrent(active.owner) || !active.runtime.health) return null
    return active.runtime.health()
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

function isRuntimeViolation(error: unknown): boolean {
  const message = normalizeError(error).message.toLowerCase()
  return /timed out|timeout|memory|out of bounds|interrupted|protocol|complexity limit|exceeds \d+ bytes|must contain plain json/.test(message)
}

async function prepareActivationSnapshot(
  snapshot: PluginRuntimeActivationSnapshot,
  runtime: NoNodePluginRuntimeInstance,
  revisionPackage: PluginRevisionPackage
): Promise<PluginRuntimeActivationSnapshot> {
  const counts = new Map<string, number>()
  const handlerIds = new Set<string>()
  const contributions = snapshot.contributions.map((contribution): PluginRuntimeContribution => {
    const slot = contribution.descriptor.slot
    if (!isPluginUiSlot(slot)) {
      return contribution
    }
    const catalog = PLUGIN_UI_SLOT_CATALOG[slot]
    const count = (counts.get(slot) ?? 0) + 1
    if (count > catalog.maxContributions) {
      throw new Error(`Plugin UI slot "${slot}" exceeds its contribution limit.`)
    }
    counts.set(slot, count)
    const validated = validatePluginUiContribution(slot, contribution.value)
    validatePluginUiAssets(validated.value, revisionPackage.assets)
    if (validated.nodeCount > catalog.renderBudget) {
      throw new Error(`Plugin UI contribution exceeds the "${slot}" render budget.`)
    }
    for (const action of validated.actions) {
      handlerIds.add(action.handler)
    }
    return { descriptor: contribution.descriptor, value: validated.value as unknown as PluginJsonValue }
  })
  if (handlerIds.size > 0) {
    if (!runtime.validateHandlers) {
      throw new Error('Plugin runtime cannot prove ViewSpec handler readiness.')
    }
    await runtime.validateHandlers([...handlerIds].sort())
  }
  return { contributions }
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
