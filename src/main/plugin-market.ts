import type { PluginManifest } from '@shared/contracts'
import { normalizePluginManifest } from './plugin-manifest-rules'

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
  return normalizePluginManifest(manifest) !== null
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
