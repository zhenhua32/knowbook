import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import semver from 'semver'
import {
  SYSTEM_PLUGIN_RISK_DECLARATIONS,
  SYSTEM_PLUGIN_V3_SCHEMA_VERSION,
  type SystemPluginArtifactDescriptor,
  type SystemPluginArtifactFileDigest,
  type SystemPluginBackgroundConfig,
  type SystemPluginDependencyPlan,
  type SystemPluginPackageManager,
  type SystemPluginRiskDeclaration,
  type SystemPluginV3Entries,
  type SystemPluginV3Manifest
} from '@shared/system-plugin'

const ARTIFACT_HASH_DOMAIN = 'knowbook-system-plugin-artifact-v3\0'
const MANIFEST_FILE = 'plugin.json'
const MAX_MANIFEST_BYTES = 64 * 1024
const HASH_BUFFER_BYTES = 64 * 1024

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'trust',
  'id',
  'name',
  'version',
  'description',
  'publisher',
  'engines',
  'entries',
  'fullAccess',
  'riskDeclarations',
  'dependencies',
  'background'
])

const RISK_DECLARATION_SET = new Set<string>(SYSTEM_PLUGIN_RISK_DECLARATIONS)

const LOCK_FILES: Record<SystemPluginPackageManager, readonly string[]> = {
  npm: ['npm-shrinkwrap.json', 'package-lock.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock']
}

export interface SystemPluginArtifactLimits {
  maxEntries: number
  maxDepth: number
  maxPathBytes: number
  maxFileBytes: number
  maxTotalBytes: number
}

export const DEFAULT_SYSTEM_PLUGIN_ARTIFACT_LIMITS: Readonly<SystemPluginArtifactLimits> = Object.freeze({
  maxEntries: 20_000,
  maxDepth: 64,
  maxPathBytes: 1_024,
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024
})

export interface InspectSystemPluginArtifactOptions {
  limits?: Partial<SystemPluginArtifactLimits>
}

export interface StageSystemPluginArtifactOptions extends InspectSystemPluginArtifactOptions {
  sourceDirectory: string
  stagingRoot: string
  requestId: string
}

export interface StagedSystemPluginArtifact extends SystemPluginArtifactDescriptor {
  sourceDirectory: string
  stagingDirectory: string
}

export interface PublishSystemPluginArtifactOptions {
  stagingDirectory: string
  artifactRoot: string
  pluginId: string
  artifactSha256: string
  limits?: Partial<SystemPluginArtifactLimits>
}

export interface PublishedSystemPluginArtifact extends SystemPluginArtifactDescriptor {
  artifactDirectory: string
}

type CollectedArtifactFile = {
  path: string
  absolutePath: string
  stat: Stats
}

type CollectedArtifact = {
  realRoot: string
  files: CollectedArtifactFile[]
}

export function normalizeSystemPluginV3Manifest(raw: unknown): SystemPluginV3Manifest {
  const candidate = requirePlainObject(raw, 'System plugin manifest')
  assertOnlyKeys(candidate, TOP_LEVEL_FIELDS, 'System plugin manifest')

  if (candidate.schemaVersion !== SYSTEM_PLUGIN_V3_SCHEMA_VERSION) {
    throw new Error('System plugin manifest schemaVersion must be 3.')
  }
  if (candidate.trust !== 'full') {
    throw new Error('System plugin manifest trust must be "full".')
  }
  if (candidate.fullAccess !== true) {
    throw new Error('System plugin manifest fullAccess must explicitly be true.')
  }

  const id = normalizeRequiredString(candidate.id, 'System plugin id', 100)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id === '.' || id === '..') {
    throw new Error('System plugin id may only contain letters, numbers, dots, underscores, and hyphens.')
  }

  const name = normalizeRequiredString(candidate.name, 'System plugin name', 200)
  const version = normalizeRequiredString(candidate.version, 'System plugin version', 100)
  if (!semver.valid(version)) {
    throw new Error('System plugin version must be a valid semantic version.')
  }

  const description = normalizeOptionalString(candidate.description, 'System plugin description', 2_000)
  const publisher = normalizeRequiredString(candidate.publisher, 'System plugin publisher', 200)
  const engines = normalizeEngines(candidate.engines)
  const entries = normalizeEntries(candidate.entries)
  const riskDeclarations = normalizeRiskDeclarations(candidate.riskDeclarations)
  const dependencies = normalizeDependencies(candidate.dependencies)
  const background = normalizeBackground(candidate.background)

  if (background && !entries.service) {
    throw new Error('System plugin background configuration requires a service entry.')
  }

  return {
    schemaVersion: SYSTEM_PLUGIN_V3_SCHEMA_VERSION,
    trust: 'full',
    id,
    name,
    version,
    ...(description ? { description } : {}),
    publisher,
    ...(engines ? { engines } : {}),
    entries,
    fullAccess: true,
    riskDeclarations,
    ...(dependencies ? { dependencies } : {}),
    ...(background ? { background } : {})
  }
}

/**
 * Inspect a directory without executing any package code. The returned digest
 * covers every regular file using a domain-separated, length-framed hash.
 */
export async function inspectSystemPluginArtifact(
  directory: string,
  options: InspectSystemPluginArtifactOptions = {}
): Promise<SystemPluginArtifactDescriptor> {
  const limits = normalizeLimits(options.limits)
  const collected = await collectArtifactFiles(directory, limits)
  const fileByPath = new Map(collected.files.map((file) => [file.path, file]))
  const manifestFile = fileByPath.get(MANIFEST_FILE)
  if (!manifestFile) {
    throw new Error(`System plugin artifact must contain ${MANIFEST_FILE} at its root.`)
  }
  if (manifestFile.stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`System plugin manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`)
  }

  const rawManifest = await readJsonFile(manifestFile.absolutePath, 'System plugin manifest')
  const manifest = normalizeSystemPluginV3Manifest(rawManifest)
  validateManifestFiles(manifest, fileByPath)
  const dependencyLockPath = validateDependencyFiles(manifest, fileByPath)
  const { artifactSha256, files, sizeBytes } = await hashCollectedFiles(collected)

  return {
    artifactId: `sha256:${artifactSha256}`,
    artifactSha256,
    manifest,
    files,
    fileCount: files.length,
    sizeBytes,
    dependencyLockPath
  }
}

/**
 * Copy a selected local directory into a new managed staging directory, then
 * inspect and hash the staged copy. Existing staging entries are never reused
 * or overwritten.
 */
export async function stageSystemPluginArtifact(
  options: StageSystemPluginArtifactOptions
): Promise<StagedSystemPluginArtifact> {
  const requestId = normalizeRequestId(options.requestId)
  const sourceDirectory = resolve(options.sourceDirectory)
  const stagingRoot = resolve(options.stagingRoot)

  if (pathsOverlap(sourceDirectory, stagingRoot)) {
    throw new Error('System plugin source and staging root must not overlap.')
  }

  const limits = normalizeLimits(options.limits)
  const collected = await collectArtifactFiles(sourceDirectory, limits)
  await mkdir(stagingRoot, { recursive: true })
  const stagingRootStat = await lstat(stagingRoot)
  if (!stagingRootStat.isDirectory() || stagingRootStat.isSymbolicLink()) {
    throw new Error('System plugin staging root must be a regular directory.')
  }
  const realStagingRoot = await realpath(stagingRoot)
  if (pathsOverlap(collected.realRoot, realStagingRoot)) {
    throw new Error('System plugin source and staging root must not overlap.')
  }

  const stagingDirectory = resolve(realStagingRoot, requestId)
  if (!isPathInsideRoot(stagingDirectory, realStagingRoot) || stagingDirectory === realStagingRoot) {
    throw new Error('System plugin staging request id resolves outside the staging root.')
  }

  let created = false
  try {
    await mkdir(stagingDirectory)
    created = true
    for (const file of collected.files) {
      await copyCollectedFile(file, collected.realRoot, stagingDirectory)
    }
    const descriptor = await inspectSystemPluginArtifact(stagingDirectory, { limits })
    return {
      ...descriptor,
      sourceDirectory: collected.realRoot,
      stagingDirectory
    }
  } catch (error) {
    if (created && isPathInsideRoot(stagingDirectory, realStagingRoot)) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }
}

/**
 * Atomically claim the immutable artifactRoot/pluginId/contentHash location,
 * copy the verified staging files into that exclusively-owned directory, and
 * verify the published bytes before returning them to the caller.
 *
 * Node does not expose a portable no-replace directory rename. In particular,
 * POSIX rename may replace an empty directory created after an existence check.
 * A non-recursive mkdir of the exact target is the cross-platform no-replace
 * operation: only the process that creates it may populate it, and an existing
 * revision is never opened for writes or replaced.
 */
export async function publishSystemPluginArtifact(
  options: PublishSystemPluginArtifactOptions
): Promise<PublishedSystemPluginArtifact> {
  const pluginId = normalizePluginId(options.pluginId)
  const artifactSha256 = normalizeArtifactSha256(options.artifactSha256)
  const stagingDirectory = resolve(options.stagingDirectory)
  const descriptor = await inspectSystemPluginArtifact(stagingDirectory, { limits: options.limits })
  if (descriptor.manifest.id !== pluginId) {
    throw new Error(
      `System plugin artifact id "${descriptor.manifest.id}" does not match requested plugin id "${pluginId}".`
    )
  }
  if (descriptor.artifactSha256 !== artifactSha256) {
    throw new Error('System plugin artifact SHA-256 does not match the verified staging artifact.')
  }

  const stagingStat = await lstat(stagingDirectory)
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
    throw new Error('System plugin staging directory must be a regular directory.')
  }
  const realStagingDirectory = await realpath(stagingDirectory)
  const artifactRoot = resolve(options.artifactRoot)
  await mkdir(artifactRoot, { recursive: true })
  const artifactRootStat = await lstat(artifactRoot)
  if (!artifactRootStat.isDirectory() || artifactRootStat.isSymbolicLink()) {
    throw new Error('System plugin artifact root must be a regular directory.')
  }
  const realArtifactRoot = await realpath(artifactRoot)
  if (pathsOverlap(realStagingDirectory, realArtifactRoot)) {
    throw new Error('System plugin staging directory and artifact root must not overlap.')
  }

  const pluginRoot = resolve(realArtifactRoot, pluginId)
  if (!isPathInsideRoot(pluginRoot, realArtifactRoot)) {
    throw new Error('System plugin id resolves outside the artifact root.')
  }
  await mkdir(pluginRoot, { recursive: true })
  const pluginRootStat = await lstat(pluginRoot)
  if (!pluginRootStat.isDirectory() || pluginRootStat.isSymbolicLink()) {
    throw new Error('System plugin artifact plugin root must be a regular directory.')
  }
  const realPluginRoot = await realpath(pluginRoot)
  if (!isPathInsideRoot(realPluginRoot, realArtifactRoot)) {
    throw new Error('System plugin artifact directory resolves outside the artifact root.')
  }

  const artifactDirectory = resolve(realPluginRoot, artifactSha256)
  if (!isPathInsideRoot(artifactDirectory, realPluginRoot)) {
    throw new Error('System plugin artifact SHA-256 resolves outside the plugin artifact root.')
  }

  try {
    await mkdir(artifactDirectory)
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`System plugin artifact target already exists: ${artifactDirectory}`, {
        cause: error
      })
    }
    throw error
  }

  let published: SystemPluginArtifactDescriptor
  try {
    const limits = normalizeLimits(options.limits)
    const collected = await collectArtifactFiles(realStagingDirectory, limits)
    for (const file of collected.files) {
      await copyCollectedFile(file, collected.realRoot, artifactDirectory)
    }

    published = await inspectSystemPluginArtifact(artifactDirectory, { limits })
    if (published.manifest.id !== pluginId || published.artifactSha256 !== artifactSha256) {
      throw new Error('Published system plugin artifact does not match the verified staging artifact.')
    }
  } catch (error) {
    // This invocation created the exact directory, so it is safe to remove its
    // incomplete claim. The staging directory remains available for diagnosis
    // or a retry.
    await rm(artifactDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  // The verified target is now authoritative. Staging cleanup is best-effort:
  // a cleanup failure must not turn a valid immutable artifact into an orphan
  // that cannot be recorded by the caller.
  await rm(realStagingDirectory, { recursive: true, force: true }).catch(() => undefined)
  return { ...published, artifactDirectory }
}

function normalizeEngines(raw: unknown): SystemPluginV3Manifest['engines'] | undefined {
  if (raw === undefined) {
    return undefined
  }
  const candidate = requirePlainObject(raw, 'System plugin engines')
  assertOnlyKeys(candidate, new Set(['knowbook']), 'System plugin engines')
  const knowbook = normalizeRequiredString(candidate.knowbook, 'System plugin engines.knowbook', 200)
  if (!semver.validRange(knowbook)) {
    throw new Error('System plugin engines.knowbook must be a valid semantic version range.')
  }
  return { knowbook }
}

function normalizeEntries(raw: unknown): SystemPluginV3Entries {
  const candidate = requirePlainObject(raw, 'System plugin entries')
  assertOnlyKeys(candidate, new Set(['main', 'renderer', 'service']), 'System plugin entries')
  const entries: SystemPluginV3Entries = {}
  for (const key of ['main', 'renderer', 'service'] as const) {
    if (candidate[key] !== undefined) {
      entries[key] = normalizeArtifactPath(candidate[key], `System plugin ${key} entry`)
    }
  }
  if (!entries.main && !entries.renderer && !entries.service) {
    throw new Error('System plugin manifest must declare at least one main, renderer, or service entry.')
  }
  return entries
}

function normalizeRiskDeclarations(raw: unknown): SystemPluginRiskDeclaration[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SYSTEM_PLUGIN_RISK_DECLARATIONS.length) {
    throw new Error(
      `System plugin riskDeclarations must contain between 1 and ${SYSTEM_PLUGIN_RISK_DECLARATIONS.length} entries.`
    )
  }
  const seen = new Set<SystemPluginRiskDeclaration>()
  for (const value of raw) {
    if (typeof value !== 'string' || !RISK_DECLARATION_SET.has(value)) {
      throw new Error(`System plugin risk declaration "${String(value)}" is not recognized.`)
    }
    const risk = value as SystemPluginRiskDeclaration
    if (seen.has(risk)) {
      throw new Error(`System plugin risk declaration "${risk}" is duplicated.`)
    }
    seen.add(risk)
  }
  return SYSTEM_PLUGIN_RISK_DECLARATIONS.filter((risk) => seen.has(risk))
}

function normalizeDependencies(raw: unknown): SystemPluginDependencyPlan | undefined {
  if (raw === undefined) {
    return undefined
  }
  const candidate = requirePlainObject(raw, 'System plugin dependencies')
  assertOnlyKeys(
    candidate,
    new Set(['packageManager', 'install', 'allowScripts', 'buildCommand', 'rebuildNativeModules']),
    'System plugin dependencies'
  )

  if (candidate.packageManager !== 'npm' && candidate.packageManager !== 'pnpm' && candidate.packageManager !== 'yarn') {
    throw new Error('System plugin dependency packageManager must be npm, pnpm, or yarn.')
  }
  if (candidate.install !== 'ci' && candidate.install !== 'install') {
    throw new Error('System plugin dependency install mode must be ci or install.')
  }
  if (typeof candidate.allowScripts !== 'boolean') {
    throw new Error('System plugin dependencies allowScripts must be a boolean.')
  }
  if (typeof candidate.rebuildNativeModules !== 'boolean') {
    throw new Error('System plugin dependencies rebuildNativeModules must be a boolean.')
  }

  let buildCommand: string[] | undefined
  if (candidate.buildCommand !== undefined) {
    if (!Array.isArray(candidate.buildCommand) || candidate.buildCommand.length < 1 || candidate.buildCommand.length > 32) {
      throw new Error('System plugin dependencies buildCommand must contain between 1 and 32 arguments.')
    }
    buildCommand = candidate.buildCommand.map((value, index) => {
      if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 2_000) {
        throw new Error(`System plugin dependencies buildCommand argument ${index} is invalid.`)
      }
      return value
    })
  }

  return {
    packageManager: candidate.packageManager,
    install: candidate.install,
    allowScripts: candidate.allowScripts,
    ...(buildCommand ? { buildCommand } : {}),
    rebuildNativeModules: candidate.rebuildNativeModules
  }
}

function normalizeBackground(raw: unknown): SystemPluginBackgroundConfig | undefined {
  if (raw === undefined) {
    return undefined
  }
  const candidate = requirePlainObject(raw, 'System plugin background')
  assertOnlyKeys(candidate, new Set(['mode', 'autoStart']), 'System plugin background')
  if (candidate.mode !== 'app-lifetime' && candidate.mode !== 'detached') {
    throw new Error('System plugin background mode must be app-lifetime or detached.')
  }
  if (typeof candidate.autoStart !== 'boolean') {
    throw new Error('System plugin background autoStart must be a boolean.')
  }
  return { mode: candidate.mode, autoStart: candidate.autoStart }
}

function validateManifestFiles(
  manifest: SystemPluginV3Manifest,
  files: ReadonlyMap<string, CollectedArtifactFile>
): void {
  for (const [kind, path] of Object.entries(manifest.entries)) {
    if (!files.has(path)) {
      throw new Error(`System plugin ${kind} entry does not exist as a regular artifact file: ${path}`)
    }
  }
}

function validateDependencyFiles(
  manifest: SystemPluginV3Manifest,
  files: ReadonlyMap<string, CollectedArtifactFile>
): string | null {
  const plan = manifest.dependencies
  if (!plan) {
    return null
  }
  if (!files.has('package.json')) {
    throw new Error('System plugin dependency plan requires package.json at the artifact root.')
  }

  const lockFile = LOCK_FILES[plan.packageManager].find((path) => files.has(path)) ?? null
  if (plan.install === 'ci' && !lockFile) {
    throw new Error(`System plugin ${plan.packageManager} ci install requires a matching lock file.`)
  }
  return lockFile
}

async function collectArtifactFiles(
  directory: string,
  limits: SystemPluginArtifactLimits
): Promise<CollectedArtifact> {
  const root = resolve(directory)
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('System plugin artifact root must be a regular directory.')
  }
  const realRoot = await realpath(root)
  const files: CollectedArtifactFile[] = []
  const caseFoldedPaths = new Map<string, string>()
  let entryCount = 0
  let totalBytes = 0

  const visit = async (absoluteDirectory: string, relativeSegments: string[], depth: number): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new Error(`System plugin artifact exceeds the maximum directory depth of ${limits.maxDepth}.`)
    }
    const entries = await readdir(absoluteDirectory, { withFileTypes: true })
    for (const entry of entries) {
      entryCount += 1
      if (entryCount > limits.maxEntries) {
        throw new Error(`System plugin artifact exceeds the ${limits.maxEntries}-entry limit.`)
      }

      const absolutePath = resolve(absoluteDirectory, entry.name)
      const artifactPath = [...relativeSegments, entry.name].join('/')
      validateCollectedPath(artifactPath, limits.maxPathBytes)
      const folded = artifactPath.toLowerCase()
      const collision = caseFoldedPaths.get(folded)
      if (collision && collision !== artifactPath) {
        throw new Error(`System plugin artifact paths differ only by case: ${collision} and ${artifactPath}`)
      }
      caseFoldedPaths.set(folded, artifactPath)
      const entryStat = await lstat(absolutePath)
      if (entryStat.isSymbolicLink()) {
        throw new Error(`System plugin artifact cannot contain symbolic links: ${artifactPath}`)
      }

      if (entryStat.isDirectory()) {
        const realDirectory = await realpath(absolutePath)
        if (!isPathInsideRoot(realDirectory, realRoot)) {
          throw new Error(`System plugin artifact directory resolves outside its root: ${artifactPath}`)
        }
        await visit(realDirectory, [...relativeSegments, entry.name], depth + 1)
        continue
      }
      if (!entryStat.isFile()) {
        throw new Error(`System plugin artifact contains an unsupported file type: ${artifactPath}`)
      }
      if (!Number.isSafeInteger(entryStat.size) || entryStat.size < 0 || entryStat.size > limits.maxFileBytes) {
        throw new Error(`System plugin artifact file exceeds the ${limits.maxFileBytes}-byte limit: ${artifactPath}`)
      }

      totalBytes += entryStat.size
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
        throw new Error(`System plugin artifact exceeds the ${limits.maxTotalBytes}-byte total limit.`)
      }
      const realFile = await realpath(absolutePath)
      if (!isPathInsideRoot(realFile, realRoot)) {
        throw new Error(`System plugin artifact file resolves outside its root: ${artifactPath}`)
      }

      files.push({ path: artifactPath, absolutePath: realFile, stat: entryStat })
    }
  }

  await visit(realRoot, [], 0)
  files.sort((left, right) => compareArtifactPaths(left.path, right.path))
  return { realRoot, files }
}

async function hashCollectedFiles(collected: CollectedArtifact): Promise<{
  artifactSha256: string
  files: SystemPluginArtifactFileDigest[]
  sizeBytes: number
}> {
  const artifactHash = createHash('sha256')
  artifactHash.update(ARTIFACT_HASH_DOMAIN, 'utf8')
  const files: SystemPluginArtifactFileDigest[] = []
  let sizeBytes = 0

  for (const file of collected.files) {
    const pathBytes = Buffer.from(file.path, 'utf8')
    artifactHash.update(frameLength(pathBytes.byteLength))
    artifactHash.update(pathBytes)
    artifactHash.update(frameLength(file.stat.size))

    const fileHash = createHash('sha256')
    const handle = await open(file.absolutePath, 'r')
    let bytesReadTotal = 0
    try {
      const openedStat = await handle.stat()
      assertUnchangedRegularFile(file, openedStat)
      const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES)
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
        if (bytesRead === 0) {
          break
        }
        const chunk = buffer.subarray(0, bytesRead)
        fileHash.update(chunk)
        artifactHash.update(chunk)
        bytesReadTotal += bytesRead
      }
    } finally {
      await handle.close()
    }

    if (bytesReadTotal !== file.stat.size) {
      throw new Error(`System plugin artifact changed while hashing: ${file.path}`)
    }
    const afterStat = await lstat(file.absolutePath)
    assertUnchangedRegularFile(file, afterStat)
    const currentRealPath = await realpath(file.absolutePath)
    if (!isPathInsideRoot(currentRealPath, collected.realRoot)) {
      throw new Error(`System plugin artifact file resolves outside its root: ${file.path}`)
    }

    files.push({ path: file.path, size: file.stat.size, sha256: fileHash.digest('hex') })
    sizeBytes += file.stat.size
  }

  return { artifactSha256: artifactHash.digest('hex'), files, sizeBytes }
}

async function copyCollectedFile(
  file: CollectedArtifactFile,
  sourceRoot: string,
  destinationRoot: string
): Promise<void> {
  const sourceStat = await lstat(file.absolutePath)
  assertUnchangedRegularFile(file, sourceStat)
  const realSource = await realpath(file.absolutePath)
  if (!isPathInsideRoot(realSource, sourceRoot)) {
    throw new Error(`System plugin artifact file resolves outside its root: ${file.path}`)
  }

  const destination = resolve(destinationRoot, ...file.path.split('/'))
  if (!isPathInsideRoot(destination, destinationRoot)) {
    throw new Error(`System plugin artifact path escapes the staging root: ${file.path}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(realSource, destination, constants.COPYFILE_EXCL)

  const sourceAfter = await lstat(file.absolutePath)
  assertUnchangedRegularFile(file, sourceAfter)
  const destinationStat = await lstat(destination)
  if (!destinationStat.isFile() || destinationStat.isSymbolicLink() || destinationStat.size !== file.stat.size) {
    throw new Error(`System plugin artifact changed while staging: ${file.path}`)
  }
}

function assertUnchangedRegularFile(file: CollectedArtifactFile, current: Stats): void {
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || (current.dev !== 0 && file.stat.dev !== 0 && current.dev !== file.stat.dev)
    || (current.ino !== 0 && file.stat.ino !== 0 && current.ino !== file.stat.ino)
    || current.size !== file.stat.size
    || current.mtimeMs !== file.stat.mtimeMs
    || current.ctimeMs !== file.stat.ctimeMs
  ) {
    throw new Error(`System plugin artifact changed while it was being processed: ${file.path}`)
  }
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  const bytes = await readFile(path)
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON.`)
  }
  source = source.replace(/^\uFEFF/, '')
  if (source.includes('\0')) {
    throw new Error(`${label} cannot contain NUL bytes.`)
  }
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new Error(`${label} must be valid JSON.`)
  }
}

function normalizeArtifactPath(value: unknown, label: string): string {
  const raw = normalizeRequiredString(value, label, 1_024)
  if (raw.includes('\0') || isAbsolute(raw) || /^[a-z]:/i.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw new Error(`${label} must be a relative path inside the artifact.`)
  }
  const normalized = raw.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a relative path inside the artifact.`)
  }
  if (Buffer.byteLength(normalized, 'utf8') > 1_024) {
    throw new Error(`${label} exceeds 1024 UTF-8 bytes.`)
  }
  return normalized
}

function validateCollectedPath(path: string, maxPathBytes: number): void {
  if (!path || path.includes('\0') || Buffer.byteLength(path, 'utf8') > maxPathBytes) {
    throw new Error(`System plugin artifact path is invalid or exceeds ${maxPathBytes} UTF-8 bytes.`)
  }
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`System plugin artifact path is invalid: ${path}`)
  }
}

function normalizeLimits(raw: Partial<SystemPluginArtifactLimits> | undefined): SystemPluginArtifactLimits {
  const normalize = (value: number | undefined, fallback: number): number => (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
  )
  return {
    maxEntries: normalize(raw?.maxEntries, DEFAULT_SYSTEM_PLUGIN_ARTIFACT_LIMITS.maxEntries),
    maxDepth: normalize(raw?.maxDepth, DEFAULT_SYSTEM_PLUGIN_ARTIFACT_LIMITS.maxDepth),
    maxPathBytes: normalize(raw?.maxPathBytes, DEFAULT_SYSTEM_PLUGIN_ARTIFACT_LIMITS.maxPathBytes),
    maxFileBytes: normalize(raw?.maxFileBytes, DEFAULT_SYSTEM_PLUGIN_ARTIFACT_LIMITS.maxFileBytes),
    maxTotalBytes: normalize(raw?.maxTotalBytes, DEFAULT_SYSTEM_PLUGIN_ARTIFACT_LIMITS.maxTotalBytes)
  }
}

function normalizeRequestId(value: unknown): string {
  const requestId = typeof value === 'string' ? value.trim() : ''
  if (
    !requestId
    || requestId === '.'
    || requestId === '..'
    || requestId.length > 128
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(requestId)
  ) {
    throw new Error('System plugin staging request id is invalid.')
  }
  return requestId
}

function normalizePluginId(value: unknown): string {
  const pluginId = normalizeRequiredString(value, 'System plugin id', 100)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId) || pluginId === '.' || pluginId === '..') {
    throw new Error('System plugin id may only contain letters, numbers, dots, underscores, and hyphens.')
  }
  return pluginId
}

function normalizeArtifactSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('System plugin artifact SHA-256 must be 64 lowercase hexadecimal characters.')
  }
  return value
}

function normalizeRequiredString(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new Error(`${label} is required.`)
  }
  if (normalized.includes('\0')) {
    throw new Error(`${label} cannot contain NUL bytes.`)
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
  if (normalized.includes('\0')) {
    throw new Error(`${label} cannot contain NUL bytes.`)
  }
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

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string'
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

function pathsOverlap(left: string, right: string): boolean {
  return isPathInsideRoot(left, right) || isPathInsideRoot(right, left)
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

function compareArtifactPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function frameLength(length: number): Uint8Array {
  const frame = Buffer.allocUnsafe(8)
  frame.writeBigUInt64BE(BigInt(length))
  return frame
}
