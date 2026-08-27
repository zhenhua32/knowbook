import { randomUUID } from 'node:crypto'
import type {
  PluginActiveOwner,
  PluginCapabilityCall,
  PluginCapabilityGrant,
  PluginGrantSet,
  PluginJsonValue,
  PluginPlatformScope
} from '@shared/plugin-platform'
import { PluginPlatformKernel } from './kernel'
import {
  getPluginPlatformScopeKey,
  validatePluginPlatformScope
} from './scope'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000
const DEFAULT_MAX_CONCURRENT_CALLS = 8
const DEFAULT_MAX_CALLS_PER_MINUTE = 120
const DEFAULT_MAX_AI_TOKENS_PER_MINUTE = 32_000
const MAX_INPUT_BYTES = 256 * 1024
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024
const ABSOLUTE_MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_JSON_DEPTH = 32
const MAX_JSON_ITEMS = 20_000
const MAX_ID_LENGTH = 200

export type PluginCapabilityErrorCode =
  | 'stale-owner'
  | 'invalid-call'
  | 'invalid-input'
  | 'scope-denied'
  | 'grant-denied'
  | 'grant-revoked'
  | 'quota-exceeded'
  | 'timed-out'
  | 'cancelled'
  | 'execution-failed'
  | 'invalid-result'

export class PluginCapabilityError extends Error {
  constructor(
    readonly code: PluginCapabilityErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'PluginCapabilityError'
  }
}

export interface PluginCapabilityContext {
  owner: PluginActiveOwner
  grant: PluginCapabilityGrant
  signal: AbortSignal
  callId: string
}

export interface PluginCapabilityDefinition<I = PluginJsonValue, O = PluginJsonValue> {
  id: string
  version: number
  scopes: readonly PluginPlatformScope['kind'][]
  parseInput: (input: PluginJsonValue) => I
  authorize?: (context: PluginCapabilityContext, input: I) => void
  execute: (context: PluginCapabilityContext, input: I) => O | Promise<O>
  timeoutMs?: number
  maxResultBytes?: number
  quotaCost?: (input: I) => { aiTokens?: number }
}

export type PluginCapabilityAuditOutcome =
  | 'succeeded'
  | 'denied'
  | 'failed'
  | 'timed-out'
  | 'cancelled'

export interface PluginCapabilityAuditRecord {
  id: string
  callId: string
  pluginId: string
  revisionId: string
  runId: string
  grantSetId: string
  epoch: number
  scope: PluginPlatformScope
  capability: string
  version: number
  outcome: PluginCapabilityAuditOutcome
  errorCode?: PluginCapabilityErrorCode
  durationMs: number
  createdAt: string
}

export interface PluginCapabilityBrokerOptions {
  maxConcurrentCallsPerRun?: number
  maxCallsPerMinutePerRun?: number
  maxAiTokensPerMinutePerRun?: number
  audit?: (record: PluginCapabilityAuditRecord) => void | Promise<void>
  now?: () => Date
}

export interface PluginCapabilityCatalogEntry {
  id: string
  version: number
  scopes: PluginPlatformScope['kind'][]
  timeoutMs: number
  maxResultBytes: number
}

type NormalizedCapabilityDefinition = Omit<
  PluginCapabilityDefinition<unknown, unknown>,
  'scopes'
> & {
  key: string
  timeoutMs: number
  maxResultBytes: number
  scopes: ReadonlySet<PluginPlatformScope['kind']>
}

type GrantSetRecord = {
  grantSet: PluginGrantSet
  grants: ReadonlyMap<string, PluginCapabilityGrant>
}

/** Host-owned gate for every untrusted runtime operation. */
export class PluginCapabilityBroker {
  private readonly definitions = new Map<string, NormalizedCapabilityDefinition>()
  private readonly grantSets = new Map<string, GrantSetRecord>()
  private readonly revokedGrantSets = new Set<string>()
  private readonly activeCallsByRun = new Map<string, number>()
  private readonly controllersByGrantSet = new Map<string, Set<AbortController>>()
  private readonly maxConcurrentCallsPerRun: number
  private readonly maxCallsPerMinutePerRun: number
  private readonly maxAiTokensPerMinutePerRun: number
  private readonly callWindowsByRun = new Map<string, number[]>()
  private readonly aiTokenWindowsByRun = new Map<string, Array<{ at: number; tokens: number }>>()
  private readonly audit: ((record: PluginCapabilityAuditRecord) => void | Promise<void>) | null
  private readonly now: () => Date

  constructor(
    private readonly kernel: PluginPlatformKernel,
    options: PluginCapabilityBrokerOptions = {}
  ) {
    this.maxConcurrentCallsPerRun = normalizePositiveInteger(
      options.maxConcurrentCallsPerRun ?? DEFAULT_MAX_CONCURRENT_CALLS,
      'Capability concurrent call limit',
      1_000
    )
    this.maxCallsPerMinutePerRun = normalizePositiveInteger(
      options.maxCallsPerMinutePerRun ?? DEFAULT_MAX_CALLS_PER_MINUTE,
      'Capability per-minute call limit',
      100_000
    )
    this.maxAiTokensPerMinutePerRun = normalizePositiveInteger(
      options.maxAiTokensPerMinutePerRun ?? DEFAULT_MAX_AI_TOKENS_PER_MINUTE,
      'Capability AI token limit',
      10_000_000
    )
    this.audit = options.audit ?? null
    this.now = options.now ?? (() => new Date())
  }

  register<I, O>(definition: PluginCapabilityDefinition<I, O>): () => void {
    const normalized = normalizeDefinition(definition)
    if (this.definitions.has(normalized.key)) {
      throw new Error(`Capability "${normalized.key}" is already registered.`)
    }
    this.definitions.set(normalized.key, normalized)
    let active = true
    return () => {
      if (active && this.definitions.get(normalized.key) === normalized) {
        this.definitions.delete(normalized.key)
      }
      active = false
    }
  }

  listCapabilities(): PluginCapabilityCatalogEntry[] {
    return [...this.definitions.values()]
      .map((definition) => ({
        id: definition.id,
        version: definition.version,
        scopes: [...definition.scopes].sort(),
        timeoutMs: definition.timeoutMs,
        maxResultBytes: definition.maxResultBytes
      }))
      .sort((left, right) => {
        const byId = left.id.localeCompare(right.id, 'en')
        return byId !== 0 ? byId : left.version - right.version
      })
  }

  registerGrantSet(input: PluginGrantSet): PluginGrantSet {
    const record = normalizeGrantSet(input)
    const existing = this.grantSets.get(record.grantSet.id)
    if (existing) {
      if (JSON.stringify(existing.grantSet) === JSON.stringify(record.grantSet)) {
        return existing.grantSet
      }
      throw new Error(`Plugin grant set "${record.grantSet.id}" already exists.`)
    }
    if (this.revokedGrantSets.has(record.grantSet.id)) {
      throw new Error(`Plugin grant set "${record.grantSet.id}" was revoked and cannot be reused.`)
    }
    this.grantSets.set(record.grantSet.id, record)
    return record.grantSet
  }

  revokeGrantSet(grantSetId: string): boolean {
    const id = normalizeId(grantSetId, 'Plugin grant set id')
    const existed = this.grantSets.delete(id)
    this.revokedGrantSets.add(id)
    const controllers = this.controllersByGrantSet.get(id)
    if (controllers) {
      const reason = new PluginCapabilityError('grant-revoked', `Plugin grant set "${id}" was revoked.`)
      for (const controller of controllers) {
        controller.abort(reason)
      }
    }
    return existed
  }

  async invoke(owner: PluginActiveOwner, call: PluginCapabilityCall): Promise<PluginJsonValue> {
    const startedAt = Date.now()
    const createdAt = this.now().toISOString()
    let callId: string = randomUUID()
    let capability = 'invalid.call'
    let version = -1
    let outcome: PluginCapabilityAuditOutcome = 'failed'
    let failure: PluginCapabilityError | null = null

    try {
      try {
        if (!call || typeof call !== 'object') {
          throw new Error('Capability call is required.')
        }
        callId = normalizeOptionalId(call.callId, 'Capability call id') ?? callId
        capability = normalizeCapabilityId(call.capability)
        version = normalizePositiveInteger(call.version, 'Capability version', 1_000_000)
      } catch (error) {
        if (error instanceof PluginCapabilityError) {
          throw error
        }
        throw new PluginCapabilityError('invalid-call', 'Capability call envelope is invalid.', {
          cause: error
        })
      }

      try {
        this.kernel.assertCurrent(owner)
      } catch (error) {
        throw new PluginCapabilityError('stale-owner', 'Plugin run is stale or no longer active.', {
          cause: error
        })
      }

      const definition = this.definitions.get(capabilityKey(capability, version))
      if (!definition) {
        throw new PluginCapabilityError(
          'invalid-call',
          `Capability "${capability}@${version}" is not available.`
        )
      }

      const jsonInput = cloneAndMeasureJson(
        call.input,
        'Capability input',
        MAX_INPUT_BYTES,
        'invalid-input'
      ).value
      let parsedInput: unknown
      try {
        parsedInput = definition.parseInput(jsonInput)
      } catch (error) {
        throw new PluginCapabilityError('invalid-input', 'Capability input failed schema validation.', {
          cause: error
        })
      }

      if (!definition.scopes.has(owner.scope.kind)) {
        throw new PluginCapabilityError(
          'scope-denied',
          `Capability "${capability}@${version}" is unavailable in ${owner.scope.kind} scope.`
        )
      }

      const grant = this.requireGrant(owner, capability, version)
      const operationController = new AbortController()
      const context: PluginCapabilityContext = {
        owner,
        grant,
        signal: operationController.signal,
        callId
      }
      try {
        definition.authorize?.(context, parsedInput)
      } catch (error) {
        throw new PluginCapabilityError('scope-denied', 'Capability constraints denied this operation.', {
          cause: error
        })
      }

      this.consumeRateQuota(owner.runId, definition, parsedInput)

      if (this.getActiveCallCount(owner.runId) >= this.maxConcurrentCallsPerRun) {
        throw new PluginCapabilityError(
          'quota-exceeded',
          `Plugin run exceeds ${this.maxConcurrentCallsPerRun} concurrent capability calls.`
        )
      }

      this.trackController(owner.grantSetId, operationController)
      this.activeCallsByRun.set(owner.runId, this.getActiveCallCount(owner.runId) + 1)

      const execution = this.kernel.runWithActiveOwner(owner, async (lifecycleSignal) => {
        const unlinkLifecycle = forwardAbort(
          lifecycleSignal,
          operationController,
          () => new PluginCapabilityError('cancelled', 'Plugin run stopped during capability execution.')
        )
        try {
          const result = await definition.execute(context, parsedInput)
          return cloneAndMeasureJson(
            result,
            'Capability result',
            definition.maxResultBytes,
            'invalid-result'
          ).value
        } catch (error) {
          if (operationController.signal.aborted) {
            throw normalizeAbortReason(operationController.signal.reason)
          }
          if (error instanceof PluginCapabilityError) {
            throw error
          }
          throw new PluginCapabilityError('execution-failed', 'Capability execution failed.', {
            cause: error
          })
        } finally {
          unlinkLifecycle()
        }
      }).finally(() => {
        this.untrackController(owner.grantSetId, operationController)
        this.decrementActiveCall(owner.runId)
      })

      const timeout = setTimeout(() => {
        operationController.abort(new PluginCapabilityError(
          'timed-out',
          `Capability execution exceeded ${definition.timeoutMs} ms.`
        ))
      }, definition.timeoutMs)
      const aborted = rejectWhenAborted(operationController.signal)

      try {
        const result = await Promise.race([execution, aborted])
        outcome = 'succeeded'
        return result
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      failure = normalizeCapabilityFailure(error)
      outcome = auditOutcomeForFailure(failure)
      throw failure
    } finally {
      this.writeAudit({
        id: randomUUID(),
        callId,
        pluginId: safeIdentityPart(owner?.pluginId),
        revisionId: safeIdentityPart(owner?.revisionId),
        runId: safeIdentityPart(owner?.runId),
        grantSetId: safeIdentityPart(owner?.grantSetId),
        epoch: Number.isSafeInteger(owner?.epoch) ? owner.epoch : -1,
        scope: cloneAuditScope(owner?.scope),
        capability,
        version,
        outcome,
        ...(failure ? { errorCode: failure.code } : {}),
        durationMs: Math.max(0, Date.now() - startedAt),
        createdAt
      })
    }
  }

  private requireGrant(
    owner: PluginActiveOwner,
    capability: string,
    version: number
  ): PluginCapabilityGrant {
    if (this.revokedGrantSets.has(owner.grantSetId)) {
      throw new PluginCapabilityError(
        'grant-revoked',
        `Plugin grant set "${owner.grantSetId}" was revoked.`
      )
    }
    const record = this.grantSets.get(owner.grantSetId)
    if (
      !record
      || record.grantSet.pluginId !== owner.pluginId
      || record.grantSet.revisionId !== owner.revisionId
      || getPluginPlatformScopeKey(record.grantSet.scope) !== getPluginPlatformScopeKey(owner.scope)
    ) {
      throw new PluginCapabilityError(
        'grant-denied',
        'Plugin grant set does not match the active plugin revision and scope.'
      )
    }
    if (record.grantSet.expiresAt && Date.parse(record.grantSet.expiresAt) <= this.now().getTime()) {
      throw new PluginCapabilityError('grant-denied', 'Plugin grant set has expired.')
    }
    const grant = record.grants.get(capabilityKey(capability, version))
    if (!grant) {
      throw new PluginCapabilityError(
        'grant-denied',
        `Capability "${capability}@${version}" was not granted.`
      )
    }
    return grant
  }

  private trackController(grantSetId: string, controller: AbortController): void {
    const controllers = this.controllersByGrantSet.get(grantSetId) ?? new Set<AbortController>()
    controllers.add(controller)
    this.controllersByGrantSet.set(grantSetId, controllers)
  }

  private untrackController(grantSetId: string, controller: AbortController): void {
    const controllers = this.controllersByGrantSet.get(grantSetId)
    if (!controllers) {
      return
    }
    controllers.delete(controller)
    if (controllers.size === 0) {
      this.controllersByGrantSet.delete(grantSetId)
    }
  }

  private getActiveCallCount(runId: string): number {
    return this.activeCallsByRun.get(runId) ?? 0
  }

  private consumeRateQuota(
    runId: string,
    definition: NormalizedCapabilityDefinition,
    input: unknown
  ): void {
    const now = this.now().getTime()
    const cutoff = now - 60_000
    const calls = (this.callWindowsByRun.get(runId) ?? []).filter((at) => at > cutoff)
    if (calls.length >= this.maxCallsPerMinutePerRun) {
      this.callWindowsByRun.set(runId, calls)
      throw new PluginCapabilityError(
        'quota-exceeded',
        `Plugin run exceeds ${this.maxCallsPerMinutePerRun} capability calls per minute.`
      )
    }
    calls.push(now)
    this.callWindowsByRun.set(runId, calls)

    const cost = definition.quotaCost?.(input)
    const aiTokens = cost?.aiTokens ?? 0
    if (!Number.isSafeInteger(aiTokens) || aiTokens < 0) {
      throw new PluginCapabilityError('invalid-input', 'Capability quota cost is invalid.')
    }
    if (aiTokens === 0) return
    const tokenWindow = (this.aiTokenWindowsByRun.get(runId) ?? []).filter((entry) => entry.at > cutoff)
    const used = tokenWindow.reduce((total, entry) => total + entry.tokens, 0)
    if (used + aiTokens > this.maxAiTokensPerMinutePerRun) {
      this.aiTokenWindowsByRun.set(runId, tokenWindow)
      throw new PluginCapabilityError(
        'quota-exceeded',
        `Plugin run exceeds ${this.maxAiTokensPerMinutePerRun} AI tokens per minute.`
      )
    }
    tokenWindow.push({ at: now, tokens: aiTokens })
    this.aiTokenWindowsByRun.set(runId, tokenWindow)
  }

  private decrementActiveCall(runId: string): void {
    const next = this.getActiveCallCount(runId) - 1
    if (next > 0) {
      this.activeCallsByRun.set(runId, next)
    } else {
      this.activeCallsByRun.delete(runId)
    }
  }

  private writeAudit(record: PluginCapabilityAuditRecord): void {
    if (!this.audit) {
      return
    }
    try {
      void Promise.resolve(this.audit(record)).catch(() => undefined)
    } catch {
      // Audit transport failures must not change the capability result.
    }
  }
}

function normalizeDefinition<I, O>(
  definition: PluginCapabilityDefinition<I, O>
): NormalizedCapabilityDefinition {
  if (!definition || typeof definition !== 'object') {
    throw new Error('Capability definition is required.')
  }
  const id = normalizeCapabilityId(definition.id)
  const version = normalizePositiveInteger(definition.version, 'Capability version', 1_000_000)
  if (typeof definition.parseInput !== 'function' || typeof definition.execute !== 'function') {
    throw new Error(`Capability "${id}@${version}" requires parseInput and execute functions.`)
  }
  if (definition.quotaCost !== undefined && typeof definition.quotaCost !== 'function') {
    throw new Error(`Capability "${id}@${version}" quotaCost must be a function.`)
  }
  if (!Array.isArray(definition.scopes) || definition.scopes.length === 0) {
    throw new Error(`Capability "${id}@${version}" requires at least one allowed scope.`)
  }
  const scopes = new Set<PluginPlatformScope['kind']>()
  for (const scope of definition.scopes) {
    if (scope !== 'app' && scope !== 'workspace' && scope !== 'session') {
      throw new Error(`Capability "${id}@${version}" contains an invalid scope.`)
    }
    scopes.add(scope)
  }

  return {
    id,
    version,
    key: capabilityKey(id, version),
    scopes,
    timeoutMs: normalizePositiveInteger(
      definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'Capability timeout',
      MAX_TIMEOUT_MS
    ),
    maxResultBytes: normalizePositiveInteger(
      definition.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
      'Capability result limit',
      ABSOLUTE_MAX_JSON_BYTES
    ),
    parseInput: definition.parseInput as (input: PluginJsonValue) => unknown,
    authorize: definition.authorize as ((context: PluginCapabilityContext, input: unknown) => void) | undefined,
    quotaCost: definition.quotaCost as ((input: unknown) => { aiTokens?: number }) | undefined,
    execute: definition.execute as (context: PluginCapabilityContext, input: unknown) => unknown
  }
}

function normalizeGrantSet(input: PluginGrantSet): GrantSetRecord {
  if (!input || typeof input !== 'object') {
    throw new Error('Plugin grant set is required.')
  }
  const id = normalizeId(input.id, 'Plugin grant set id')
  const pluginId = normalizeId(input.pluginId, 'Plugin id')
  const revisionId = normalizeId(input.revisionId, 'Plugin revision id', 500)
  validatePluginPlatformScope(input.scope)
  const createdAt = normalizeDate(input.createdAt, 'Plugin grant creation time')
  const expiresAt = input.expiresAt === undefined
    ? undefined
    : normalizeDate(input.expiresAt, 'Plugin grant expiration time')
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error('Plugin grant expiration must be after its creation time.')
  }
  if (!Array.isArray(input.grants) || input.grants.length > 64) {
    throw new Error('Plugin grant set grants must be an array with at most 64 entries.')
  }

  const grants = new Map<string, PluginCapabilityGrant>()
  for (const rawGrant of input.grants) {
    if (!rawGrant || typeof rawGrant !== 'object') {
      throw new Error('Plugin capability grant must be an object.')
    }
    const capability = normalizeCapabilityId(rawGrant.capability)
    const version = normalizePositiveInteger(rawGrant.version, 'Plugin grant version', 1_000_000)
    const constraints = rawGrant.constraints === undefined
      ? undefined
      : cloneAndMeasureJson(
        rawGrant.constraints,
        'Plugin grant constraints',
        MAX_INPUT_BYTES,
        'invalid-input'
      ).value
    const key = capabilityKey(capability, version)
    if (grants.has(key)) {
      throw new Error(`Plugin capability grant "${key}" is duplicated.`)
    }
    grants.set(key, Object.freeze({
      capability,
      version,
      ...(constraints === undefined ? {} : { constraints })
    }))
  }

  const sortedGrants = [...grants.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([, grant]) => grant)
  const sortedGrantMap = new Map(sortedGrants.map((grant) => [
    capabilityKey(grant.capability, grant.version),
    grant
  ]))
  const grantSet: PluginGrantSet = Object.freeze({
    id,
    pluginId,
    revisionId,
    scope: cloneScope(input.scope),
    grants: Object.freeze(sortedGrants),
    createdAt,
    ...(expiresAt ? { expiresAt } : {})
  })
  return { grantSet, grants: sortedGrantMap }
}

function cloneAndMeasureJson(
  raw: unknown,
  label: string,
  maxBytes: number,
  failureCode: 'invalid-input' | 'invalid-result'
): { value: PluginJsonValue; bytes: number } {
  let items = 0
  const visit = (value: unknown, depth: number): PluginJsonValue => {
    items += 1
    if (items > MAX_JSON_ITEMS) {
      throw new PluginCapabilityError(failureCode, `${label} exceeds ${MAX_JSON_ITEMS} items.`)
    }
    if (depth > MAX_JSON_DEPTH) {
      throw new PluginCapabilityError(failureCode, `${label} exceeds depth ${MAX_JSON_DEPTH}.`)
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Object.is(value, -0) ? 0 : value
    }
    if (Array.isArray(value)) {
      return value.map((entry) => visit(entry, depth + 1))
    }
    if (!isPlainObject(value)) {
      throw new PluginCapabilityError(failureCode, `${label} must contain plain JSON only.`)
    }
    const result: Record<string, PluginJsonValue> = {}
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new PluginCapabilityError(failureCode, `${label} contains a reserved key.`)
      }
      result[key] = visit(value[key], depth + 1)
    }
    return result
  }

  const value = visit(raw, 0)
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes > maxBytes) {
    throw new PluginCapabilityError(failureCode, `${label} exceeds ${maxBytes} bytes.`)
  }
  return { value, bytes }
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(normalizeAbortReason(signal.reason))
      return
    }
    signal.addEventListener('abort', () => reject(normalizeAbortReason(signal.reason)), { once: true })
  })
}

function forwardAbort(
  source: AbortSignal,
  target: AbortController,
  getReason: () => PluginCapabilityError
): () => void {
  const abort = () => target.abort(getReason())
  if (source.aborted) {
    abort()
    return () => undefined
  }
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

function normalizeAbortReason(reason: unknown): PluginCapabilityError {
  if (reason instanceof PluginCapabilityError) {
    return reason
  }
  return new PluginCapabilityError('cancelled', 'Capability execution was cancelled.', { cause: reason })
}

function normalizeCapabilityFailure(error: unknown): PluginCapabilityError {
  if (error instanceof PluginCapabilityError) {
    return error
  }
  return new PluginCapabilityError('execution-failed', 'Capability invocation failed.', { cause: error })
}

function auditOutcomeForFailure(error: PluginCapabilityError): PluginCapabilityAuditOutcome {
  if (error.code === 'timed-out') {
    return 'timed-out'
  }
  if (error.code === 'cancelled') {
    return 'cancelled'
  }
  if (
    error.code === 'grant-denied'
    || error.code === 'grant-revoked'
    || error.code === 'scope-denied'
    || error.code === 'stale-owner'
    || error.code === 'quota-exceeded'
  ) {
    return 'denied'
  }
  return 'failed'
}

function capabilityKey(capability: string, version: number): string {
  return `${capability}@${version}`
}

function normalizeCapabilityId(value: unknown): string {
  const id = normalizeId(value, 'Capability id', 120)
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id)) {
    throw new PluginCapabilityError('invalid-call', 'Capability id is invalid.')
  }
  return id
}

function normalizeId(value: unknown, label: string, maxLength = MAX_ID_LENGTH): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new Error(`${label} is required.`)
  }
  if (normalized.length > maxLength || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(normalized)) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function normalizeOptionalId(value: unknown, label: string): string | null {
  return value === undefined ? null : normalizeId(value, label)
}

function normalizePositiveInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${label} must be a positive integer at most ${max}.`)
  }
  return value as number
}

function normalizeDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid ISO date.`)
  }
  return new Date(value).toISOString()
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

function cloneAuditScope(scope: PluginPlatformScope | undefined): PluginPlatformScope {
  if (!scope || (scope.kind !== 'app' && scope.kind !== 'workspace' && scope.kind !== 'session')) {
    return { kind: 'app' }
  }
  try {
    validatePluginPlatformScope(scope)
    return cloneScope(scope)
  } catch {
    return { kind: 'app' }
  }
}

function safeIdentityPart(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : 'unknown'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
