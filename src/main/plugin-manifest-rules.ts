import { isAbsolute } from 'node:path'
import semver from 'semver'
import type { PluginManifest } from '@shared/contracts'

export function findPluginManifestIssue(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'Plugin manifest must be a JSON object.'
  }

  const candidate = raw as Record<string, unknown>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
  const version = typeof candidate.version === 'string' ? candidate.version.trim() : ''

  if (!id || !name || !version) {
    return 'Plugin manifest requires id, name, and version.'
  }

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id === '.' || id === '..') {
    return 'Plugin id may only contain letters, numbers, dots, underscores, and hyphens.'
  }

  if (!semver.valid(version)) {
    return 'Plugin version must be a valid semantic version.'
  }

  const rawEngines = candidate.engines
  if (rawEngines !== undefined && (rawEngines === null || typeof rawEngines !== 'object' || Array.isArray(rawEngines))) {
    return 'Plugin engines must be an object.'
  }
  const engines = (rawEngines ?? {}) as Record<string, unknown>
  const rawKnowbookRange = engines.knowbook
  const knowbookVersionRange = typeof rawKnowbookRange === 'string' ? rawKnowbookRange.trim() : ''
  if (rawKnowbookRange !== undefined && !knowbookVersionRange) {
    return 'Plugin engines.knowbook must be a valid semantic version range.'
  }
  if (knowbookVersionRange && !semver.validRange(knowbookVersionRange)) {
    return 'Plugin engines.knowbook must be a valid semantic version range.'
  }

  if (candidate.description !== undefined && typeof candidate.description !== 'string') {
    return 'Plugin description must be a string.'
  }

  if (candidate.author !== undefined && typeof candidate.author !== 'string') {
    return 'Plugin author must be a string.'
  }

  const rawEntry = candidate.entry
  if (rawEntry !== undefined && typeof rawEntry !== 'string') {
    return 'Plugin entry must be a relative path inside the plugin directory.'
  }
  const entry = rawEntry?.trim() || 'index.js'
  const entrySegments = entry.replace(/\\/g, '/').split('/')
  if (
    isAbsolute(entry)
    || entrySegments.some((segment) => segment === '..')
    || entrySegments.every((segment) => !segment || segment === '.')
  ) {
    return 'Plugin entry must be a relative path inside the plugin directory.'
  }

  if (candidate.enabledByDefault !== undefined && typeof candidate.enabledByDefault !== 'boolean') {
    return 'Plugin enabledByDefault must be a boolean.'
  }

  return null
}

export function normalizePluginManifest(raw: unknown): PluginManifest | null {
  if (findPluginManifestIssue(raw) !== null) {
    return null
  }

  const candidate = raw as Record<string, unknown>
  const engines = (candidate.engines ?? {}) as Record<string, unknown>
  const knowbookVersionRange = typeof engines.knowbook === 'string' ? engines.knowbook.trim() : ''

  return {
    id: (candidate.id as string).trim(),
    name: (candidate.name as string).trim(),
    version: (candidate.version as string).trim(),
    description: (candidate.description as string | undefined)?.trim() || undefined,
    author: (candidate.author as string | undefined)?.trim() || undefined,
    entry: (candidate.entry as string | undefined)?.trim() || 'index.js',
    enabledByDefault: candidate.enabledByDefault === undefined
      ? true
      : Boolean(candidate.enabledByDefault),
    engines: knowbookVersionRange
      ? { knowbook: knowbookVersionRange }
      : undefined
  }
}
