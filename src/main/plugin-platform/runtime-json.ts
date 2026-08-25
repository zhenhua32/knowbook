import type { PluginJsonValue } from '@shared/plugin-platform'

export const PLUGIN_RUNTIME_JSON_MAX_BYTES = 1024 * 1024
export const PLUGIN_RUNTIME_JSON_MAX_DEPTH = 32
export const PLUGIN_RUNTIME_JSON_MAX_ITEMS = 20_000

export function clonePluginRuntimeJson(raw: unknown, label: string): PluginJsonValue {
  let count = 0

  const visit = (value: unknown, depth: number): PluginJsonValue => {
    count += 1
    if (count > PLUGIN_RUNTIME_JSON_MAX_ITEMS || depth > PLUGIN_RUNTIME_JSON_MAX_DEPTH) {
      throw new Error(`${label} exceeds the runtime JSON complexity limit.`)
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
      throw new Error(`${label} must contain plain JSON only.`)
    }

    const result: Record<string, PluginJsonValue> = {}
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error(`${label} contains a reserved key.`)
      }
      result[key] = visit(value[key], depth + 1)
    }
    return result
  }

  const result = visit(raw, 0)
  const serialized = JSON.stringify(result)
  if (Buffer.byteLength(serialized, 'utf8') > PLUGIN_RUNTIME_JSON_MAX_BYTES) {
    throw new Error(`${label} exceeds ${PLUGIN_RUNTIME_JSON_MAX_BYTES} bytes.`)
  }
  return result
}

export function parsePluginRuntimeJson(serialized: string, label: string): PluginJsonValue {
  if (typeof serialized !== 'string') {
    throw new Error(`${label} must be serialized JSON.`)
  }
  if (Buffer.byteLength(serialized, 'utf8') > PLUGIN_RUNTIME_JSON_MAX_BYTES) {
    throw new Error(`${label} exceeds ${PLUGIN_RUNTIME_JSON_MAX_BYTES} bytes.`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error })
  }
  return clonePluginRuntimeJson(parsed, label)
}

export function stringifyPluginRuntimeJson(value: unknown, label: string): string {
  return JSON.stringify(clonePluginRuntimeJson(value, label))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
