import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { PluginRevisionPackage, PluginRevisionPackageInput } from '@shared/plugin-platform'
import {
  buildPluginRevisionPackage,
  PLUGIN_REVISION_PACKAGE_LIMITS
} from './revision-package'

const REVISION_ID_PATTERN = /^sha256:([a-f0-9]{64})$/

/**
 * Content-addressed immutable object storage for v2 plugin packages. Publishing
 * happens through a sibling staging directory and one atomic rename.
 */
export class PluginRevisionStore {
  private readonly root: string
  private readonly objectsRoot: string
  private readonly stagingRoot: string

  constructor(root: string) {
    if (typeof root !== 'string' || !root.trim()) {
      throw new Error('Plugin revision store root is required.')
    }
    this.root = resolve(root)
    this.objectsRoot = join(this.root, 'objects')
    this.stagingRoot = join(this.root, 'staging')
    mkdirSync(this.objectsRoot, { recursive: true })
    mkdirSync(this.stagingRoot, { recursive: true })
  }

  publish(input: PluginRevisionPackageInput): PluginRevisionPackage {
    const built = buildPluginRevisionPackage(input)
    const target = this.getObjectPath(built.package.revisionId)
    if (existsSync(target)) {
      return this.load(built.package.revisionId)
    }

    const staging = join(this.stagingRoot, randomUUID())
    assertInside(this.stagingRoot, staging)
    mkdirSync(staging, { recursive: false })
    try {
      for (const file of built.files) {
        const destination = join(staging, ...file.path.split('/'))
        assertInside(staging, destination)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, file.content, { flag: 'wx', mode: 0o600 })
      }

      try {
        renameSync(staging, target)
      } catch (error) {
        if (!existsSync(target)) {
          throw error
        }
      }
      return this.load(built.package.revisionId)
    } finally {
      if (existsSync(staging)) {
        rmSync(staging, { recursive: true, force: true })
      }
    }
  }

  load(revisionId: string): PluginRevisionPackage {
    const objectPath = this.getObjectPath(revisionId)
    if (!existsSync(objectPath) || !lstatSync(objectPath).isDirectory()) {
      throw new Error(`Plugin revision "${revisionId}" does not exist.`)
    }
    this.assertNoSymbolicLinks(objectPath)

    const names = readdirSync(objectPath).sort()
    const unexpected = names.find((name) => !['assets', 'plugin.json', 'views.json', 'worker.js'].includes(name))
    if (unexpected) {
      throw new Error(`Plugin revision contains unexpected file or directory "${unexpected}".`)
    }

    const manifest = parseJsonFile(
      join(objectPath, 'plugin.json'),
      'Plugin manifest',
      PLUGIN_REVISION_PACKAGE_LIMITS.manifestBytes
    )
    const workerSource = readRequiredUtf8File(
      join(objectPath, 'worker.js'),
      'Plugin worker',
      PLUGIN_REVISION_PACKAGE_LIMITS.workerBytes
    )
    const viewsPath = join(objectPath, 'views.json')
    const views = existsSync(viewsPath)
      ? parseJsonFile(viewsPath, 'Plugin views', PLUGIN_REVISION_PACKAGE_LIMITS.viewsBytes)
      : undefined
    const assetsPath = join(objectPath, 'assets')
    const assets = existsSync(assetsPath) ? readAssets(assetsPath) : undefined
    const built = buildPluginRevisionPackage({ manifest, workerSource, views, assets })

    if (built.package.revisionId !== revisionId) {
      throw new Error(
        `Plugin revision content hash mismatch: expected "${revisionId}", received "${built.package.revisionId}".`
      )
    }
    return built.package
  }

  has(revisionId: string): boolean {
    try {
      const target = this.getObjectPath(revisionId)
      return existsSync(target) && lstatSync(target).isDirectory()
    } catch {
      return false
    }
  }

  getObjectPath(revisionId: string): string {
    const match = REVISION_ID_PATTERN.exec(revisionId)
    if (!match) {
      throw new Error('Plugin revision id must use the sha256:<64 lowercase hex> format.')
    }
    const target = join(this.objectsRoot, match[1])
    assertInside(this.objectsRoot, target)
    return target
  }

  private assertNoSymbolicLinks(root: string): void {
    const pending = [root]
    let visited = 0
    while (pending.length > 0) {
      const current = pending.pop() as string
      visited += 1
      if (
        visited
        > PLUGIN_REVISION_PACKAGE_LIMITS.assetCount
          * (PLUGIN_REVISION_PACKAGE_LIMITS.assetPathDepth + 1)
          + 16
      ) {
        throw new Error('Plugin revision object contains too many filesystem entries.')
      }
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) {
        throw new Error('Plugin revision objects cannot contain symbolic links.')
      }
      if (!stat.isDirectory()) {
        continue
      }
      for (const child of readdirSync(current)) {
        const childPath = join(current, child)
        assertInside(root, childPath)
        pending.push(childPath)
      }
    }
  }
}

function readAssets(root: string): Record<string, Uint8Array> {
  if (!lstatSync(root).isDirectory()) {
    throw new Error('Plugin revision assets must be a directory.')
  }

  const result: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>
  const pending = [root]
  let assetCount = 0
  let totalBytes = 0
  while (pending.length > 0) {
    const current = pending.pop() as string
    for (const name of readdirSync(current).sort().reverse()) {
      const child = join(current, name)
      assertInside(root, child)
      const stat = lstatSync(child)
      if (stat.isSymbolicLink()) {
        throw new Error('Plugin revision assets cannot contain symbolic links.')
      }
      if (stat.isDirectory()) {
        pending.push(child)
        continue
      }
      if (!stat.isFile()) {
        throw new Error('Plugin revision assets may only contain regular files.')
      }
      const assetPath = relative(root, child).split(sep).join('/')
      assetCount += 1
      totalBytes += stat.size
      if (assetCount > PLUGIN_REVISION_PACKAGE_LIMITS.assetCount) {
        throw new Error(`Plugin package exceeds ${PLUGIN_REVISION_PACKAGE_LIMITS.assetCount} assets.`)
      }
      if (stat.size > PLUGIN_REVISION_PACKAGE_LIMITS.assetBytes) {
        throw new Error(
          `Plugin asset "${assetPath}" exceeds ${PLUGIN_REVISION_PACKAGE_LIMITS.assetBytes} bytes.`
        )
      }
      if (totalBytes > PLUGIN_REVISION_PACKAGE_LIMITS.assetTotalBytes) {
        throw new Error(
          `Plugin assets exceed ${PLUGIN_REVISION_PACKAGE_LIMITS.assetTotalBytes} bytes in total.`
        )
      }
      result[assetPath] = Uint8Array.from(readFileSync(child))
    }
  }
  return result
}

function parseJsonFile(path: string, label: string, maxBytes: number): unknown {
  const raw = readRequiredUtf8File(path, label, maxBytes)
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`${label} is not valid JSON.`)
  }
}

function readRequiredUtf8File(path: string, label: string, maxBytes: number): string {
  if (!existsSync(path)) {
    throw new Error(`${label} file is missing.`)
  }
  const stat = lstatSync(path)
  if (!stat.isFile()) {
    throw new Error(`${label} file is missing.`)
  }
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return readFileSync(path, 'utf8')
}

function assertInside(root: string, target: string): void {
  const relativePath = relative(resolve(root), resolve(target))
  if (relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !relativePath.startsWith(sep))) {
    return
  }
  throw new Error('Plugin revision path escapes its object root.')
}
