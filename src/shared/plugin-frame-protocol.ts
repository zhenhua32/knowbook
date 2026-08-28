import type {
  PluginActivationIdentity,
  PluginActiveOwner,
  PluginJsonValue,
  PluginPlatformScope
} from './plugin-platform'
import type { PluginUiSlot, RunPluginUiActionInput } from './plugin-ui'

const MAX_FRAME_MESSAGE_BYTES = 256 * 1024
const MAX_FRAME_MESSAGE_DEPTH = 16
const MAX_FRAME_MESSAGE_NODES = 4_096
const MAX_FRAME_COLLECTION_ITEMS = 1_000
const MAX_FRAME_KEY_CHARS = 500
const MAX_FRAME_ID_CHARS = 200
const MAX_FRAME_ERROR_CHARS = 2_000
const utf8 = new TextEncoder()

export type PluginFrameIdentity = PluginActivationIdentity | PluginActiveOwner

export interface PluginFrameAddress<Identity extends PluginFrameIdentity = PluginFrameIdentity> {
  owner: Identity
  contributionId: string
  slot: PluginUiSlot
}

export type PluginFrameReadiness =
  | { status: 'ready' }
  | { status: 'failed'; error: string }

export interface PluginFrameAction {
  requestId: string
  handler: string
  arguments?: PluginJsonValue
  control?: RunPluginUiActionInput['control']
}

/** Parses an untrusted sandbox-frame readiness message without throwing. */
export function readPluginFrameReadiness(
  value: unknown,
  expected: PluginFrameAddress
): PluginFrameReadiness | null {
  if (!isBoundedPluginFrameJson(value) || !isRecord(value)) return null
  const candidate = value as Record<string, unknown>
  if (candidate.type === 'knowbook:ready') {
    if (!hasExactKeys(candidate, ['type', 'owner', 'contributionId', 'slot'])) return null
  } else if (candidate.type === 'knowbook:error') {
    if (!hasExactKeys(candidate, ['type', 'owner', 'contributionId', 'slot', 'error'])) return null
  } else {
    return null
  }
  if (
    candidate.contributionId !== expected.contributionId
    || candidate.slot !== expected.slot
    || !samePluginFrameIdentity(candidate.owner, expected.owner)
  ) return null
  if (candidate.type === 'knowbook:ready') return { status: 'ready' }
  if (typeof candidate.error !== 'string' || candidate.error.length > MAX_FRAME_ERROR_CHARS) return null
  return {
    status: 'failed',
    error: candidate.error.trim() || 'Plugin iframe reported a runtime failure.'
  }
}

/** Parses an untrusted sandbox-frame action with closed shape and bounded JSON. */
export function readPluginFrameAction(
  value: unknown,
  expected: PluginFrameAddress<PluginActiveOwner>
): PluginFrameAction | null {
  if (!isBoundedPluginFrameJson(value) || !isRecord(value)) return null
  const candidate = value as Record<string, unknown>
  if (!hasExactKeys(candidate, [
    'type', 'owner', 'contributionId', 'slot', 'requestId', 'handler', 'arguments', 'control'
  ])) return null
  if (
    candidate.type !== 'knowbook:action'
    || candidate.contributionId !== expected.contributionId
    || candidate.slot !== expected.slot
    || !samePluginFrameIdentity(candidate.owner, expected.owner)
    || !isBoundedId(candidate.requestId)
    || !isBoundedId(candidate.handler)
    || !isOptionalPluginJson(candidate.arguments)
    || !isPluginFrameControl(candidate.control)
  ) return null
  return {
    requestId: candidate.requestId,
    handler: candidate.handler,
    ...(candidate.arguments === undefined ? {} : { arguments: candidate.arguments }),
    ...(candidate.control === undefined ? {} : { control: candidate.control })
  }
}

export function samePluginFrameIdentity(value: unknown, expected: PluginFrameIdentity): boolean {
  if (!isRecord(value)) return false
  const candidate = value as Record<string, unknown>
  const active = 'epoch' in expected
  if (!hasExactKeys(candidate, active
    ? ['pluginId', 'revisionId', 'runId', 'grantSetId', 'scope', 'epoch']
    : ['pluginId', 'revisionId', 'runId', 'grantSetId', 'scope'])) return false
  return candidate.pluginId === expected.pluginId
    && candidate.revisionId === expected.revisionId
    && candidate.runId === expected.runId
    && candidate.grantSetId === expected.grantSetId
    && (!active || candidate.epoch === expected.epoch)
    && samePluginFrameScope(candidate.scope, expected.scope)
}

/** Iterative validation avoids recursive stack exhaustion and rejects cycles. */
export function isBoundedPluginFrameJson(value: unknown): value is PluginJsonValue {
  if (value === undefined) return false
  const seen = new Set<object>()
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  let bytes = 0

  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number }
    nodes += 1
    if (nodes > MAX_FRAME_MESSAGE_NODES || current.depth > MAX_FRAME_MESSAGE_DEPTH) return false
    if (current.value === null || typeof current.value === 'boolean') continue
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) return false
      bytes += 16
      if (bytes > MAX_FRAME_MESSAGE_BYTES) return false
      continue
    }
    if (typeof current.value === 'string') {
      const length = boundedUtf8Length(current.value)
      if (length === null) return false
      bytes += length
      if (bytes > MAX_FRAME_MESSAGE_BYTES) return false
      continue
    }
    if (typeof current.value !== 'object' || current.value === undefined) return false
    if (seen.has(current.value)) return false
    seen.add(current.value)

    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_FRAME_COLLECTION_ITEMS) return false
      for (const child of current.value) {
        if (child === undefined) return false
        stack.push({ value: child, depth: current.depth + 1 })
      }
      continue
    }

    if (!isRecord(current.value)) return false
    const entries = Object.entries(current.value)
    if (entries.length > MAX_FRAME_COLLECTION_ITEMS) return false
    for (const [key, child] of entries) {
      if (key.length > MAX_FRAME_KEY_CHARS || child === undefined) return false
      const length = boundedUtf8Length(key)
      if (length === null) return false
      bytes += length
      if (bytes > MAX_FRAME_MESSAGE_BYTES) return false
      stack.push({ value: child, depth: current.depth + 1 })
    }
  }
  return true
}

function samePluginFrameScope(value: unknown, expected: PluginPlatformScope): boolean {
  if (!isRecord(value)) return false
  const candidate = value as Record<string, unknown>
  if (expected.kind === 'app') {
    return hasExactKeys(candidate, ['kind']) && candidate.kind === 'app'
  }
  if (expected.kind === 'workspace') {
    return hasExactKeys(candidate, ['kind', 'workspaceId'])
      && candidate.kind === 'workspace'
      && candidate.workspaceId === expected.workspaceId
  }
  return hasExactKeys(candidate, ['kind', 'workspaceId', 'sessionId'])
    && candidate.kind === 'session'
    && candidate.workspaceId === expected.workspaceId
    && candidate.sessionId === expected.sessionId
}

function isPluginFrameControl(value: unknown): value is RunPluginUiActionInput['control'] | undefined {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  const candidate = value as Record<string, unknown>
  return hasExactKeys(candidate, ['id', 'value'])
    && isBoundedId(candidate.id)
    && isBoundedPluginFrameJson(candidate.value)
}

function isOptionalPluginJson(value: unknown): value is PluginJsonValue | undefined {
  return value === undefined || isBoundedPluginFrameJson(value)
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FRAME_ID_CHARS
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
    && allowed.filter((key) => !['arguments', 'control'].includes(key)).every((key) => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedUtf8Length(value: string): number | null {
  if (value.length > MAX_FRAME_MESSAGE_BYTES) return null
  return utf8.encode(value).byteLength
}
