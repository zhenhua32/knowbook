import type { PluginManifest } from '@shared/contracts'

export interface PluginMarketplaceItem {
  manifest: PluginManifest
  readme?: string
  downloads?: number
  rating?: number
  verified?: boolean
}

export interface PluginInstallOptions {
  replaceExisting?: boolean
  sourceUrl?: string
}

export function validatePluginManifest(manifest: unknown): manifest is PluginManifest {
  if (!manifest || typeof manifest !== 'object') {
    return false
  }

  const m = manifest as Partial<PluginManifest>

  if (typeof m.id !== 'string' || !m.id.trim()) {
    return false
  }

  if (typeof m.name !== 'string' || !m.name.trim()) {
    return false
  }

  if (typeof m.version !== 'string' || !m.version.trim()) {
    return false
  }

  // description and author are optional
  if (m.description !== undefined && typeof m.description !== 'string') {
    return false
  }

  if (m.author !== undefined && typeof m.author !== 'string') {
    return false
  }

  // entry is optional
  if (m.entry !== undefined && typeof m.entry !== 'string') {
    return false
  }

  // enabledByDefault is optional
  if (m.enabledByDefault !== undefined && typeof m.enabledByDefault !== 'boolean') {
    return false
  }

  // engines is optional
  if (m.engines !== undefined) {
    if (typeof m.engines !== 'object' || m.engines === null) {
      return false
    }
    const engines = m.engines as Record<string, unknown>
    if (engines.knowbook !== undefined && typeof engines.knowbook !== 'string') {
      return false
    }
  }

  return true
}

export function createManifest(manifest: Partial<PluginManifest> & { id: string; name: string; version: string }): PluginManifest {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    entry: manifest.entry,
    enabledByDefault: manifest.enabledByDefault ?? false,
    engines: manifest.engines
  }
}
