import { createHash } from 'node:crypto'
import semver from 'semver'
import type {
  PluginCapabilityRequest,
  PluginJsonValue,
  PluginRevisionPackage,
  PluginRevisionPackageInput,
  PluginStandardModuleRequest,
  PluginV2Manifest
} from '@shared/plugin-platform'

const REVISION_HASH_DOMAIN = 'knowbook-plugin-revision-v2\0'
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_WORKER_BYTES = 2 * 1024 * 1024
const MAX_VIEWS_BYTES = 1024 * 1024
const MAX_ASSET_BYTES = 5 * 1024 * 1024
const MAX_ASSET_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_ASSET_COUNT = 128
const MAX_ASSET_PATH_LENGTH = 240
const MAX_ASSET_PATH_DEPTH = 8
const MAX_JSON_DEPTH = 32
const MAX_JSON_ITEMS = 20_000

export const PLUGIN_REVISION_PACKAGE_LIMITS = Object.freeze({
  manifestBytes: MAX_MANIFEST_BYTES,
  workerBytes: MAX_WORKER_BYTES,
  viewsBytes: MAX_VIEWS_BYTES,
  assetBytes: MAX_ASSET_BYTES,
  assetTotalBytes: MAX_ASSET_TOTAL_BYTES,
  assetCount: MAX_ASSET_COUNT,
  assetPathLength: MAX_ASSET_PATH_LENGTH,
  assetPathDepth: MAX_ASSET_PATH_DEPTH
})

type RevisionFile = {
  path: string
  content: Uint8Array
}

type BuiltPluginRevisionPackage = {
  package: PluginRevisionPackage
  files: RevisionFile[]
}

export function buildPluginRevisionPackage(
  input: PluginRevisionPackageInput
): BuiltPluginRevisionPackage {
  if (!input || typeof input !== 'object') {
    throw new Error('Plugin revision package input is required.')
  }

  const manifest = normalizePluginV2Manifest(input.manifest)
  const workerSource = normalizeTextFile(input.workerSource, 'Plugin worker source')
  const workerBytes = encodeUtf8(workerSource)
  if (workerBytes.byteLength > MAX_WORKER_BYTES) {
    throw new Error(`Plugin worker exceeds ${MAX_WORKER_BYTES} bytes.`)
  }

  const canonicalManifest = `${canonicalJson(normalizePluginJson(manifest, 'Plugin manifest'))}\n`
  const manifestBytes = encodeUtf8(canonicalManifest)
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(`Plugin manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`)
  }

  const files: RevisionFile[] = [
    { path: 'plugin.json', content: manifestBytes },
    { path: 'worker.js', content: workerBytes }
  ]

  const views = input.views === undefined
    ? null
    : normalizePluginJson(input.views, 'Plugin views')
  if (views !== null) {
    const viewsBytes = encodeUtf8(`${canonicalJson(views)}\n`)
    if (viewsBytes.byteLength > MAX_VIEWS_BYTES) {
      throw new Error(`Plugin views exceed ${MAX_VIEWS_BYTES} bytes.`)
    }
    files.push({ path: 'views.json', content: viewsBytes })
  }

  const assets = normalizeAssets(input.assets)
  for (const [assetPath, content] of Object.entries(assets)) {
    files.push({ path: `assets/${assetPath}`, content })
  }

  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const contentHash = hashRevisionFiles(files)
  const sizeBytes = files.reduce((total, file) => total + file.content.byteLength, 0)

  return {
    package: {
      revisionId: `sha256:${contentHash}`,
      contentHash,
      manifest,
      workerSource,
      views,
      assets,
      sizeBytes
    },
    files
  }
}

export function normalizePluginV2Manifest(raw: unknown): PluginV2Manifest {
  const candidate = requirePlainObject(raw, 'Plugin manifest')
  assertOnlyKeys(candidate, new Set([
    'schemaVersion',
    'id',
    'name',
    'version',
    'apiVersion',
    'worker',
    'description',
    'author',
    'stateSchemaVersion',
    'permissions',
    'standardModules'
  ]), 'Plugin manifest')

  if (candidate.schemaVersion !== 2) {
    throw new Error('Plugin manifest schemaVersion must be 2.')
  }
  if (candidate.apiVersion !== '2') {
    throw new Error('Plugin manifest apiVersion must be "2".')
  }

  const id = normalizeString(candidate.id, 'Plugin id', 100)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id === '.' || id === '..') {
    throw new Error('Plugin id may only contain letters, numbers, dots, underscores, and hyphens.')
  }

  const name = normalizeString(candidate.name, 'Plugin name', 200)
  const version = normalizeString(candidate.version, 'Plugin version', 100)
  if (!semver.valid(version)) {
    throw new Error('Plugin version must be a valid semantic version.')
  }

  const worker = candidate.worker === undefined ? 'worker.js' : candidate.worker
  if (worker !== 'worker.js') {
    throw new Error('Dynamic plugin worker must be the bundled "worker.js" entry.')
  }

  const description = normalizeOptionalString(candidate.description, 'Plugin description', 2_000)
  const author = normalizeOptionalString(candidate.author, 'Plugin author', 200)
  const stateSchemaVersion = normalizeStateSchemaVersion(candidate.stateSchemaVersion)
  const permissions = normalizePermissions(candidate.permissions)
  const standardModules = normalizeStandardModules(candidate.standardModules)

  return {
    schemaVersion: 2,
    id,
    name,
    version,
    apiVersion: '2',
    worker: 'worker.js',
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(stateSchemaVersion === undefined ? {} : { stateSchemaVersion }),
    permissions,
    standardModules
  }
}

export function canonicalJson(value: PluginJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Plugin JSON numbers must be finite.')
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  const entries = Object.keys(value)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
  return `{${entries.join(',')}}`
}

function normalizePermissions(raw: unknown): PluginCapabilityRequest[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw) || raw.length > 64) {
    throw new Error('Plugin permissions must be an array with at most 64 entries.')
  }

  const seen = new Set<string>()
  const permissions = raw.map((entry, index): PluginCapabilityRequest => {
    const candidate = requirePlainObject(entry, `Plugin permission ${index}`)
    assertOnlyKeys(candidate, new Set(['capability', 'version', 'reason']), `Plugin permission ${index}`)
    const capability = normalizeString(candidate.capability, `Plugin permission ${index} capability`, 120)
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(capability)) {
      throw new Error(`Plugin permission ${index} capability is invalid.`)
    }
    if (!Number.isSafeInteger(candidate.version) || (candidate.version as number) < 1) {
      throw new Error(`Plugin permission ${index} version must be a positive integer.`)
    }
    const version = candidate.version as number
    const key = `${capability}@${version}`
    if (seen.has(key)) {
      throw new Error(`Plugin permission "${key}" is duplicated.`)
    }
    seen.add(key)
    const reason = normalizeOptionalString(candidate.reason, `Plugin permission ${index} reason`, 500)
    return { capability, version, ...(reason ? { reason } : {}) }
  })

  return permissions.sort(compareVersionedRequests)
}

function normalizeStandardModules(raw: unknown): PluginStandardModuleRequest[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw) || raw.length > 32) {
    throw new Error('Plugin standardModules must be an array with at most 32 entries.')
  }

  const seen = new Set<string>()
  const modules = raw.map((entry, index): PluginStandardModuleRequest => {
    const candidate = requirePlainObject(entry, `Plugin standard module ${index}`)
    assertOnlyKeys(candidate, new Set(['id', 'version']), `Plugin standard module ${index}`)
    const id = normalizeString(candidate.id, `Plugin standard module ${index} id`, 120)
    if (!/^@knowbook\/std\/[a-z0-9][a-z0-9._-]*$/.test(id)) {
      throw new Error(`Plugin standard module ${index} must use an @knowbook/std/* id.`)
    }
    const version = normalizeString(candidate.version, `Plugin standard module ${index} version`, 100)
    if (!semver.valid(version)) {
      throw new Error(`Plugin standard module ${index} version must be an exact semantic version.`)
    }
    const key = `${id}@${version}`
    if (seen.has(key)) {
      throw new Error(`Plugin standard module "${key}" is duplicated.`)
    }
    seen.add(key)
    return { id, version }
  })

  return modules.sort(compareVersionedRequests)
}

function compareVersionedRequests(
  left: PluginCapabilityRequest | PluginStandardModuleRequest,
  right: PluginCapabilityRequest | PluginStandardModuleRequest
): number {
  const leftId = 'capability' in left ? left.capability : left.id
  const rightId = 'capability' in right ? right.capability : right.id
  const byId = leftId.localeCompare(rightId, 'en')
  if (byId !== 0) {
    return byId
  }
  return String(left.version).localeCompare(String(right.version), 'en')
}

function normalizeAssets(
  raw: Readonly<Record<string, Uint8Array>> | undefined
): Readonly<Record<string, Uint8Array>> {
  if (raw === undefined) {
    return Object.freeze({})
  }
  if (!isPlainObject(raw)) {
    throw new Error('Plugin assets must be a plain path-to-bytes object.')
  }

  const entries = Object.entries(raw)
  if (entries.length > MAX_ASSET_COUNT) {
    throw new Error(`Plugin package exceeds ${MAX_ASSET_COUNT} assets.`)
  }

  let totalBytes = 0
  const normalized: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>
  for (const [rawPath, rawContent] of entries) {
    const path = normalizeAssetPath(rawPath)
    if (Object.hasOwn(normalized, path)) {
      throw new Error(`Plugin asset path "${path}" is duplicated after normalization.`)
    }
    if (!(rawContent instanceof Uint8Array)) {
      throw new Error(`Plugin asset "${path}" must contain bytes.`)
    }
    if (rawContent.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`Plugin asset "${path}" exceeds ${MAX_ASSET_BYTES} bytes.`)
    }
    totalBytes += rawContent.byteLength
    if (totalBytes > MAX_ASSET_TOTAL_BYTES) {
      throw new Error(`Plugin assets exceed ${MAX_ASSET_TOTAL_BYTES} bytes in total.`)
    }
    normalized[path] = Uint8Array.from(rawContent)
  }

  const sorted: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>
  for (const path of Object.keys(normalized).sort((left, right) => left.localeCompare(right, 'en'))) {
    sorted[path] = normalized[path]
  }
  return Object.freeze(sorted)
}

function normalizeAssetPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) {
    throw new Error('Plugin asset path is invalid.')
  }
  const path = rawPath.replace(/\\/g, '/')
  const segments = path.split('/')
  if (
    path.startsWith('/')
    || /^[a-z]:/i.test(path)
    || path.length > MAX_ASSET_PATH_LENGTH
    || segments.length > MAX_ASSET_PATH_DEPTH
    || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.length > 100)
  ) {
    throw new Error(`Plugin asset path "${rawPath}" must stay inside the assets directory.`)
  }
  return segments.join('/')
}

function normalizePluginJson(raw: unknown, label: string): PluginJsonValue {
  let itemCount = 0
  const visit = (value: unknown, depth: number): PluginJsonValue => {
    itemCount += 1
    if (itemCount > MAX_JSON_ITEMS) {
      throw new Error(`${label} exceeds ${MAX_JSON_ITEMS} JSON items.`)
    }
    if (depth > MAX_JSON_DEPTH) {
      throw new Error(`${label} exceeds JSON depth ${MAX_JSON_DEPTH}.`)
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      return value
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`${label} contains a non-finite number.`)
      }
      return Object.is(value, -0) ? 0 : value
    }
    if (Array.isArray(value)) {
      return value.map((entry) => visit(entry, depth + 1))
    }
    if (!isPlainObject(value)) {
      throw new Error(`${label} must contain plain JSON values only.`)
    }
    const result: Record<string, PluginJsonValue> = Object.create(null) as Record<string, PluginJsonValue>
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label} contains a reserved object key.`)
      }
      result[key] = visit(value[key], depth + 1)
    }
    return result
  }

  return visit(raw, 0)
}

function hashRevisionFiles(files: RevisionFile[]): string {
  const hash = createHash('sha256')
  hash.update(REVISION_HASH_DOMAIN, 'utf8')
  for (const file of files) {
    const pathBytes = encodeUtf8(file.path)
    hash.update(frameLength(pathBytes.byteLength))
    hash.update(pathBytes)
    hash.update(frameLength(file.content.byteLength))
    hash.update(file.content)
  }
  return hash.digest('hex')
}

function frameLength(length: number): Uint8Array {
  const frame = Buffer.allocUnsafe(8)
  frame.writeBigUInt64BE(BigInt(length))
  return frame
}

function normalizeTextFile(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`)
  }
  const normalized = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (normalized.includes('\0')) {
    throw new Error(`${label} cannot contain NUL bytes.`)
  }
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`
}

function normalizeStateSchemaVersion(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    throw new Error('Plugin stateSchemaVersion must be a positive integer at most 1000000.')
  }
  return value as number
}

function normalizeString(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new Error(`${label} is required.`)
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters.`)
  }
  return normalized
}

function normalizeOptionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`)
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters.`)
  }
  return normalized || undefined
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a plain JSON object.`)
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertOnlyKeys(
  candidate: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unknownKey = Object.keys(candidate).find((key) => !allowed.has(key))
  if (unknownKey) {
    throw new Error(`${label} contains unknown field "${unknownKey}".`)
  }
}

function encodeUtf8(value: string): Uint8Array {
  return Buffer.from(value, 'utf8')
}
