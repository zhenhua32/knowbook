import type {
  PluginActivationIdentity,
  PluginActiveOwner,
  PluginCommitReceipt,
  PluginContributionDescriptor,
  PluginDrainResult,
  PluginPlatformScope,
  PluginServiceDescriptor
} from '@shared/plugin-platform'
import {
  PluginContributionRegistry,
  type RegisteredPluginContribution,
  type StagedPluginContribution
} from './contribution-registry'
import { EffectScope, type EffectDisposer } from './effect-scope'
import {
  PluginServiceRegistry,
  type RegisteredPluginService,
  type StagedPluginService
} from './service-registry'
import {
  getPluginNamespaceKey,
  validatePluginPlatformScope
} from './scope'
import { normalizeRegistryId } from './registry-validation'

type StagingState = 'staging' | 'committing' | 'active' | 'disposed'
type ActiveState = 'active' | 'draining' | 'disposed'

type StagingData = {
  identity: PluginActivationIdentity
  namespaceKey: string
  effects: EffectScope
  services: StagedPluginService[]
  contributions: StagedPluginContribution[]
  state: StagingState
}

type ActiveNamespace = {
  owner: PluginActiveOwner
  namespaceKey: string
  effects: EffectScope
  services: StagedPluginService[]
  contributions: StagedPluginContribution[]
  controller: AbortController
  state: ActiveState
  inFlight: number
  drainWaiters: Set<() => void>
  drainPromise: Promise<PluginDrainResult> | null
}

export type PluginActivationOperation<T> = (signal: AbortSignal) => T | Promise<T>
export type PluginCommitHook = (
  owner: PluginActiveOwner,
  previousOwner: PluginActiveOwner | null
) => void

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000
const MAX_DRAIN_TIMEOUT_MS = 60_000
const MAX_IDENTITY_LENGTH = 500

/**
 * Coordinates staged plugin registrations and atomically swaps one scoped
 * plugin namespace after validation. No staged service or contribution is
 * visible before commit.
 */
export class PluginPlatformKernel {
  private readonly serviceRegistry = new PluginServiceRegistry()
  private readonly contributionRegistry = new PluginContributionRegistry()
  private readonly activeNamespaces = new Map<string, ActiveNamespace>()
  private readonly runs = new Map<string, ActiveNamespace>()
  private epochSequence = 0

  beginActivation(identity: PluginActivationIdentity): PluginActivationStage {
    const normalizedIdentity = normalizeActivationIdentity(identity)
    const namespaceKey = getPluginNamespaceKey(normalizedIdentity.pluginId, normalizedIdentity.scope)
    const data: StagingData = {
      identity: normalizedIdentity,
      namespaceKey,
      effects: new EffectScope(`plugin-stage:${normalizedIdentity.pluginId}:${normalizedIdentity.runId}`),
      services: [],
      contributions: [],
      state: 'staging'
    }

    return new PluginActivationStage(
      data,
      (drainTimeoutMs, hook) => this.commitStage(data, drainTimeoutMs, hook),
      () => this.abortStage(data)
    )
  }

  getActiveOwner(pluginId: string, scope: PluginPlatformScope): PluginActiveOwner | null {
    const normalizedPluginId = normalizeRegistryId(pluginId, 'id')
    const namespace = this.activeNamespaces.get(getPluginNamespaceKey(normalizedPluginId, scope))
    return namespace?.owner ?? null
  }

  isCurrent(owner: PluginActiveOwner): boolean {
    const namespace = this.activeNamespaces.get(getPluginNamespaceKey(owner.pluginId, owner.scope))
    return Boolean(
      namespace
      && namespace.state === 'active'
      && namespace.owner.epoch === owner.epoch
      && namespace.owner.revisionId === owner.revisionId
      && namespace.owner.runId === owner.runId
      && namespace.owner.grantSetId === owner.grantSetId
    )
  }

  assertCurrent(owner: PluginActiveOwner): void {
    if (!this.isCurrent(owner)) {
      throw new Error(
        `Plugin run "${owner.runId}" is stale or no longer active for revision "${owner.revisionId}".`
      )
    }
  }

  async runWithActiveOwner<T>(
    owner: PluginActiveOwner,
    operation: PluginActivationOperation<T>
  ): Promise<T> {
    const namespace = this.requireCurrentNamespace(owner)
    namespace.inFlight += 1
    try {
      return await operation(namespace.controller.signal)
    } finally {
      namespace.inFlight -= 1
      if (namespace.inFlight === 0) {
        for (const resolve of namespace.drainWaiters) {
          resolve()
        }
        namespace.drainWaiters.clear()
      }
    }
  }

  resolveService<T>(
    serviceId: string,
    consumerScope: PluginPlatformScope
  ): RegisteredPluginService<T> | null {
    validatePluginPlatformScope(consumerScope)
    return this.serviceRegistry.resolve<T>(serviceId, consumerScope)
  }

  listVisibleServices(consumerScope: PluginPlatformScope): RegisteredPluginService[] {
    validatePluginPlatformScope(consumerScope)
    return this.serviceRegistry.listVisible(consumerScope)
  }

  listContributions<T>(
    slot: string,
    consumerScope: PluginPlatformScope
  ): RegisteredPluginContribution<T>[] {
    validatePluginPlatformScope(consumerScope)
    return this.contributionRegistry.list<T>(slot, consumerScope)
  }

  async stop(
    pluginId: string,
    scope: PluginPlatformScope,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS
  ): Promise<PluginDrainResult | null> {
    const normalizedPluginId = normalizeRegistryId(pluginId, 'id')
    const namespaceKey = getPluginNamespaceKey(normalizedPluginId, scope)
    const namespace = this.activeNamespaces.get(namespaceKey)
    if (!namespace) {
      return null
    }

    this.activeNamespaces.delete(namespaceKey)
    this.serviceRegistry.removeNamespace(namespaceKey)
    this.contributionRegistry.removeNamespace(namespaceKey)
    return this.startDrain(namespace, normalizeDrainTimeout(drainTimeoutMs))
  }

  async destroy(drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<PluginDrainResult[]> {
    const timeout = normalizeDrainTimeout(drainTimeoutMs)
    const namespaces = [...new Set([
      ...this.activeNamespaces.values(),
      ...this.runs.values()
    ])]
    this.activeNamespaces.clear()
    for (const namespace of namespaces) {
      this.serviceRegistry.removeNamespace(namespace.namespaceKey)
      this.contributionRegistry.removeNamespace(namespace.namespaceKey)
    }
    return Promise.all(namespaces.map((namespace) => this.startDrain(namespace, timeout)))
  }

  private commitStage(
    data: StagingData,
    drainTimeoutMs: number,
    hook?: PluginCommitHook
  ): PluginCommitReceipt {
    if (data.state !== 'committing') {
      throw new Error('Plugin activation stage is not ready to commit.')
    }
    if (this.runs.has(data.identity.runId)) {
      throw new Error(`Plugin run id "${data.identity.runId}" is already in use.`)
    }

    const owner = freezeOwner({
      ...data.identity,
      epoch: ++this.epochSequence
    })
    this.serviceRegistry.validateNamespace(data.namespaceKey, owner, data.services)
    this.contributionRegistry.validateNamespace(data.contributions)

    const previous = this.activeNamespaces.get(data.namespaceKey) ?? null

    // Validation above is side-effect free. These synchronous replacements are
    // one JavaScript critical section, so readers see either complete namespace.
    this.serviceRegistry.replaceNamespace(data.namespaceKey, owner, data.services)
    this.contributionRegistry.replaceNamespace(data.namespaceKey, owner, data.contributions)

    const active: ActiveNamespace = {
      owner,
      namespaceKey: data.namespaceKey,
      effects: data.effects,
      services: [...data.services],
      contributions: [...data.contributions],
      controller: new AbortController(),
      state: 'active',
      inFlight: 0,
      drainWaiters: new Set(),
      drainPromise: null
    }
    this.activeNamespaces.set(data.namespaceKey, active)
    this.runs.set(owner.runId, active)

    try {
      hook?.(owner, previous?.owner ?? null)
    } catch (error) {
      this.runs.delete(owner.runId)
      active.controller.abort()
      active.state = 'disposed'
      if (previous) {
        this.serviceRegistry.replaceNamespace(
          previous.namespaceKey,
          previous.owner,
          previous.services
        )
        this.contributionRegistry.replaceNamespace(
          previous.namespaceKey,
          previous.owner,
          previous.contributions
        )
        this.activeNamespaces.set(previous.namespaceKey, previous)
      } else {
        this.serviceRegistry.removeNamespace(data.namespaceKey)
        this.contributionRegistry.removeNamespace(data.namespaceKey)
        this.activeNamespaces.delete(data.namespaceKey)
      }
      throw error
    }

    const previousDrain = previous
      ? this.startDrain(previous, drainTimeoutMs).then((result) => result as PluginDrainResult | null)
      : Promise.resolve(null)

    return {
      owner,
      previousOwner: previous?.owner ?? null,
      previousDrain
    }
  }

  private async abortStage(data: StagingData): Promise<void> {
    if (data.state === 'disposed') {
      return
    }
    if (data.state === 'active') {
      throw new Error('Committed plugin effects are owned by the active namespace.')
    }
    data.state = 'disposed'
    await data.effects.dispose()
  }

  private requireCurrentNamespace(owner: PluginActiveOwner): ActiveNamespace {
    const namespace = this.activeNamespaces.get(getPluginNamespaceKey(owner.pluginId, owner.scope))
    if (
      !namespace
      || namespace.state !== 'active'
      || namespace.owner.epoch !== owner.epoch
      || namespace.owner.revisionId !== owner.revisionId
      || namespace.owner.runId !== owner.runId
      || namespace.owner.grantSetId !== owner.grantSetId
    ) {
      throw new Error(
        `Plugin run "${owner.runId}" is stale or no longer active for revision "${owner.revisionId}".`
      )
    }
    return namespace
  }

  private startDrain(namespace: ActiveNamespace, timeoutMs: number): Promise<PluginDrainResult> {
    if (namespace.drainPromise) {
      return namespace.drainPromise
    }

    namespace.state = 'draining'
    namespace.controller.abort()
    namespace.drainPromise = this.drainNamespace(namespace, timeoutMs)
    return namespace.drainPromise
  }

  private async drainNamespace(
    namespace: ActiveNamespace,
    timeoutMs: number
  ): Promise<PluginDrainResult> {
    const completedInTime = namespace.inFlight === 0
      ? true
      : await waitForDrain(namespace, timeoutMs)
    const errors: string[] = []

    try {
      await namespace.effects.dispose()
    } catch (error) {
      errors.push(...getErrorMessages(error))
    }

    namespace.state = 'disposed'
    if (this.runs.get(namespace.owner.runId) === namespace) {
      this.runs.delete(namespace.owner.runId)
    }

    return {
      owner: namespace.owner,
      timedOut: !completedInTime,
      errors
    }
  }
}

export class PluginActivationStage {
  constructor(
    private readonly data: StagingData,
    private readonly commitStage: (
      drainTimeoutMs: number,
      hook?: PluginCommitHook
    ) => PluginCommitReceipt,
    private readonly abortStage: () => Promise<void>
  ) {}

  get identity(): PluginActivationIdentity {
    return this.data.identity
  }

  get state(): StagingState {
    return this.data.state
  }

  registerService<T>(descriptor: PluginServiceDescriptor, value: T): void {
    this.assertStaging()
    this.data.services.push({ descriptor, value })
  }

  contribute<T>(descriptor: PluginContributionDescriptor, value: T): void {
    this.assertStaging()
    this.data.contributions.push({ descriptor, value })
  }

  own(dispose: EffectDisposer, label?: string): EffectDisposer {
    this.assertStaging()
    return this.data.effects.own(dispose, label)
  }

  childEffects(label: string): EffectScope {
    this.assertStaging()
    return this.data.effects.child(label)
  }

  async commit(
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    hook?: PluginCommitHook
  ): Promise<PluginCommitReceipt> {
    this.assertStaging()
    this.data.state = 'committing'
    try {
      const receipt = this.commitStage(normalizeDrainTimeout(drainTimeoutMs), hook)
      this.data.state = 'active'
      return receipt
    } catch (error) {
      try {
        await this.abortStage()
      } catch (cleanupError) {
        throw new AggregateError(
          [normalizeError(error), normalizeError(cleanupError)],
          `Plugin activation "${this.data.identity.runId}" failed and staging cleanup also failed.`
        )
      }
      throw error
    }
  }

  abort(): Promise<void> {
    if (this.data.state === 'active') {
      return Promise.reject(new Error('Committed plugin activation cannot be aborted through its staging handle.'))
    }
    return this.abortStage()
  }

  private assertStaging(): void {
    if (this.data.state !== 'staging') {
      throw new Error(`Plugin activation stage is ${this.data.state}.`)
    }
  }
}

function normalizeActivationIdentity(identity: PluginActivationIdentity): PluginActivationIdentity {
  const pluginId = normalizeRegistryId(identity.pluginId, 'id')
  const revisionId = normalizeIdentityPart(identity.revisionId, 'revision id')
  const runId = normalizeIdentityPart(identity.runId, 'run id')
  const grantSetId = normalizeIdentityPart(identity.grantSetId, 'grant set id')
  validatePluginPlatformScope(identity.scope)
  return Object.freeze({
    pluginId,
    revisionId,
    runId,
    grantSetId,
    scope: cloneScope(identity.scope)
  })
}

function normalizeIdentityPart(value: string, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new Error(`Plugin ${label} is required.`)
  }
  if (normalized.length > MAX_IDENTITY_LENGTH) {
    throw new Error(`Plugin ${label} exceeds ${MAX_IDENTITY_LENGTH} characters.`)
  }
  return normalized
}

function cloneScope(scope: PluginPlatformScope): PluginPlatformScope {
  switch (scope.kind) {
    case 'app':
      return Object.freeze({ kind: 'app' })
    case 'workspace':
      return Object.freeze({ kind: 'workspace', workspaceId: scope.workspaceId })
    case 'session':
      return Object.freeze({
        kind: 'session',
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId
      })
  }
}

function freezeOwner(owner: PluginActiveOwner): PluginActiveOwner {
  return Object.freeze({
    ...owner,
    scope: cloneScope(owner.scope)
  })
}

function normalizeDrainTimeout(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Plugin drain timeout must be a finite number.')
  }
  return Math.min(Math.max(Math.floor(value), 0), MAX_DRAIN_TIMEOUT_MS)
}

async function waitForDrain(namespace: ActiveNamespace, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  let resolveDrain: (() => void) | null = null
  const drained = new Promise<boolean>((resolve) => {
    resolveDrain = () => resolve(true)
    namespace.drainWaiters.add(resolveDrain)
  })
  const expired = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs)
  })

  try {
    return await Promise.race([drained, expired])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
    if (resolveDrain) {
      namespace.drainWaiters.delete(resolveDrain)
    }
  }
}

function getErrorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return error.errors.map((entry) => normalizeError(entry).message)
  }
  return [normalizeError(error).message]
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  if (typeof error === 'string' && error.trim()) {
    return new Error(error.trim())
  }
  return new Error('Unknown plugin lifecycle failure.')
}
