import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  inspectSystemPluginArtifact,
  normalizeSystemPluginV3Manifest,
  publishSystemPluginArtifact,
  type PublishedSystemPluginArtifact
} from '../system-plugin-artifact'

/** Host-compiled sources only. Never populate this catalog from IPC or plugin manifests. */
export interface BuiltinSystemPlugin {
  readonly id: string
  readonly files: Readonly<Record<string, string>>
}

export function snapshotBuiltinSystemPlugins(plugins: readonly BuiltinSystemPlugin[]): ReadonlyMap<string, BuiltinSystemPlugin> {
  const catalog = new Map<string, BuiltinSystemPlugin>()
  for (const plugin of plugins) {
    const manifest = normalizeSystemPluginV3Manifest(JSON.parse(plugin.files['plugin.json']))
    if (manifest.id !== plugin.id || catalog.has(plugin.id)) throw new Error('Invalid built-in plugin identity.')
    if (manifest.dependencies || manifest.background || manifest.entries.service) {
      throw new Error('Built-in plugins must be self-contained Main/Renderer packages.')
    }
    for (const path of Object.keys(plugin.files)) {
      if (!path || path.includes('\\') || path.includes(':') || path.startsWith('/')
        || path.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Invalid built-in plugin file path.')
      }
    }
    catalog.set(plugin.id, Object.freeze({ id: plugin.id, files: Object.freeze({ ...plugin.files }) }))
  }
  return catalog
}

export async function publishBuiltinSystemPlugin(
  plugin: BuiltinSystemPlugin,
  stagingRoot: string,
  artifactRoot: string
): Promise<PublishedSystemPluginArtifact> {
  await mkdir(stagingRoot, { recursive: true })
  const root = await realpath(stagingRoot)
  const stagingDirectory = await mkdtemp(join(root, `builtin-${plugin.id}-`))
  try {
    for (const [path, content] of Object.entries(plugin.files)) {
      const target = join(stagingDirectory, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
    }
    const descriptor = await inspectSystemPluginArtifact(stagingDirectory)
    if (descriptor.manifest.id !== plugin.id || descriptor.fileCount !== Object.keys(plugin.files).length
      || descriptor.files.some(file => typeof plugin.files[file.path] !== 'string'
        || file.sha256 !== createHash('sha256').update(plugin.files[file.path], 'utf8').digest('hex'))) {
      throw new Error('Built-in plugin bytes no longer match the application catalog.')
    }
    const artifactDirectory = resolve(artifactRoot, plugin.id, descriptor.artifactSha256)
    let exists = false
    try { await lstat(artifactDirectory); exists = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (exists) {
      const published = await inspectSystemPluginArtifact(artifactDirectory)
      if (published.artifactSha256 !== descriptor.artifactSha256) {
        throw new Error('Published built-in plugin was modified; refusing to load it.')
      }
      return { ...published, artifactDirectory }
    }
    return await publishSystemPluginArtifact({
      stagingDirectory, artifactRoot, pluginId: plugin.id, artifactSha256: descriptor.artifactSha256
    })
  } finally {
    const path = relative(root, stagingDirectory)
    if (path && !path.startsWith(`..${sep}`) && !path.includes(sep)) {
      await rm(stagingDirectory, { recursive: true, force: true })
    }
  }
}
