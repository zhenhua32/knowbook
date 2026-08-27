import { createHash, sign, verify, type KeyObject } from 'node:crypto'
import semver from 'semver'
import type { PluginJsonValue, PluginRevisionPackage, PluginRevisionPackageInput } from '@shared/plugin-platform'
import type {
  MarketplaceArtifactDigest,
  MarketplaceCycloneDxSbom,
  MarketplaceDependencyLock,
  MarketplacePluginPackage,
  MarketplacePublisherIdentity,
  TrustedMarketplacePublisher,
  UnsignedMarketplacePluginPackage
} from '@shared/plugin-trust'
import { buildPluginRevisionPackage, canonicalJson } from './revision-package'
import { clonePluginRuntimeJson } from './runtime-json'

const MARKETPLACE_FORMAT = 'knowbook-marketplace-v1'
const MAX_DEPENDENCIES = 512
const MAX_PUBLISHER_LENGTH = 200
const NATIVE_ARTIFACT_PATTERN = /(?:^|\/)[^/]+\.(?:node|dll|dylib|so(?:\.\d+)*|exe|msi|app|dmg|pkg|deb|rpm)$/i

export type {
  MarketplaceArtifactDigest,
  MarketplaceCycloneDxSbom,
  MarketplaceDependencyLock,
  MarketplacePluginPackage,
  MarketplacePublisherIdentity,
  TrustedMarketplacePublisher,
  UnsignedMarketplacePluginPackage
} from '@shared/plugin-trust'

export interface MarketplaceScanDiagnostic {
  severity: 'warning' | 'error'
  code: string
  message: string
}

export interface VerifiedMarketplacePluginPackage {
  publisher: MarketplacePublisherIdentity
  revision: PluginRevisionPackage
  dependencyLock: MarketplaceDependencyLock
  sbom: MarketplaceCycloneDxSbom
  artifacts: MarketplaceArtifactDigest[]
  diagnostics: MarketplaceScanDiagnostic[]
}

export function createUnsignedMarketplacePluginPackage(input: {
  publisher: MarketplacePublisherIdentity
  revision: PluginRevisionPackageInput
  dependencyLock: MarketplaceDependencyLock
  sbom: MarketplaceCycloneDxSbom
}): UnsignedMarketplacePluginPackage {
  const built = buildPluginRevisionPackage(input.revision)
  const dependencyLock = normalizeDependencyLock(input.dependencyLock)
  const sbom = normalizeSbom(input.sbom, built.package)
  assertSbomMatchesLock(sbom, dependencyLock)
  return {
    format: MARKETPLACE_FORMAT,
    publisher: normalizePublisher(input.publisher),
    revision: input.revision,
    dependencyLock,
    sbom,
    artifacts: describeRevisionArtifacts(built.files)
  }
}

export function signMarketplacePluginPackage(
  input: UnsignedMarketplacePluginPackage,
  privateKey: string | KeyObject
): MarketplacePluginPackage {
  const normalized = normalizeUnsignedPackage(input)
  return {
    ...input,
    signature: {
      algorithm: 'Ed25519',
      value: sign(null, Buffer.from(canonicalJson(normalized), 'utf8'), privateKey).toString('base64')
    }
  }
}

export function verifyMarketplacePluginPackage(
  input: MarketplacePluginPackage,
  trustedPublishers: readonly TrustedMarketplacePublisher[]
): VerifiedMarketplacePluginPackage {
  if (!input || typeof input !== 'object') throw new Error('Marketplace package is required.')
  assertOnlyKeys(input, ['format', 'publisher', 'revision', 'dependencyLock', 'sbom', 'artifacts', 'signature'], 'Marketplace package')
  const unsigned = createUnsignedMarketplacePluginPackage({
    publisher: input.publisher,
    revision: input.revision,
    dependencyLock: input.dependencyLock,
    sbom: input.sbom
  })
  if (input.format !== MARKETPLACE_FORMAT) throw new Error('Marketplace package format is unsupported.')
  assertArtifactList(input.artifacts, unsigned.artifacts)
  if (input.signature?.algorithm !== 'Ed25519' || typeof input.signature.value !== 'string') {
    throw new Error('Marketplace package must carry an Ed25519 signature.')
  }
  assertOnlyKeys(input.signature, ['algorithm', 'value'], 'Marketplace package signature')
  const signature = decodeCanonicalBase64(input.signature.value, 'Marketplace package signature')
  const trusted = trustedPublishers.find((entry) => (
    entry.publisherId === unsigned.publisher.publisherId && entry.keyId === unsigned.publisher.keyId
  ))
  if (!trusted || trusted.revoked) {
    throw new Error(`Marketplace publisher key "${unsigned.publisher.keyId}" is not trusted.`)
  }
  const payload = normalizeUnsignedPackage(unsigned)
  let valid = false
  try {
    valid = verify(null, Buffer.from(canonicalJson(payload), 'utf8'), trusted.publicKeyPem, signature)
  } catch (error) {
    throw new Error('Marketplace publisher public key is invalid.', { cause: error })
  }
  if (!valid) throw new Error('Marketplace package signature verification failed.')
  const diagnostics = scanMarketplaceRevision(unsigned.revision, unsigned.dependencyLock)
  const fatal = diagnostics.find((entry) => entry.severity === 'error')
  if (fatal) throw new Error(`Marketplace security scan failed (${fatal.code}): ${fatal.message}`)
  return {
    publisher: unsigned.publisher,
    revision: buildPluginRevisionPackage(unsigned.revision).package,
    dependencyLock: unsigned.dependencyLock,
    sbom: unsigned.sbom,
    artifacts: unsigned.artifacts,
    diagnostics
  }
}

export function scanMarketplaceRevision(
  revision: PluginRevisionPackageInput,
  dependencyLock: MarketplaceDependencyLock
): MarketplaceScanDiagnostic[] {
  const built = buildPluginRevisionPackage(revision).package
  const diagnostics: MarketplaceScanDiagnostic[] = []
  for (const path of Object.keys(built.assets)) {
    if (NATIVE_ARTIFACT_PATTERN.test(path)) {
      diagnostics.push({
        severity: 'error',
        code: 'native-artifact',
        message: `Native or executable artifact "${path}" requires the system-plugin channel.`
      })
    }
  }
  const forbidden = [
    [/(?:^|\W)(?:process|require|module\.exports|child_process)(?:\W|$)/, 'node-runtime-reference'],
    [/\b(?:eval|Function)\s*\(/, 'dynamic-code-evaluation'],
    [/\b(?:npm|pnpm|yarn)\s+(?:install|add)\b/i, 'runtime-package-install'],
    [/\bWebAssembly\b/, 'webassembly-runtime']
  ] as const
  for (const [pattern, code] of forbidden) {
    if (pattern.test(built.workerSource)) {
      diagnostics.push({ severity: 'error', code, message: `worker.js contains forbidden pattern ${pattern.source}.` })
    }
  }
  const declaredModules = new Set(built.manifest.standardModules.map((entry) => entry.id))
  for (const specifier of findModuleSpecifiers(built.workerSource)) {
    if (!declaredModules.has(specifier)) {
      diagnostics.push({
        severity: 'error',
        code: 'unbundled-import',
        message: `Module "${specifier}" is not a declared host standard module; marketplace dependencies must be bundled.`
      })
    }
  }
  if (dependencyLock.dependencies.length === 0 && built.workerSource.length > 250_000) {
    diagnostics.push({
      severity: 'warning',
      code: 'large-bundle-without-dependencies',
      message: 'Large worker bundle declares no third-party dependencies in the lock and SBOM.'
    })
  }
  return diagnostics
}

function normalizeUnsignedPackage(input: UnsignedMarketplacePluginPackage): PluginJsonValue {
  assertOnlyKeys(input, ['format', 'publisher', 'revision', 'dependencyLock', 'sbom', 'artifacts'], 'Unsigned marketplace package')
  const built = buildPluginRevisionPackage(input.revision)
  const dependencyLock = normalizeDependencyLock(input.dependencyLock)
  const sbom = normalizeSbom(input.sbom, built.package)
  assertSbomMatchesLock(sbom, dependencyLock)
  const normalized = {
    format: MARKETPLACE_FORMAT,
    publisher: normalizePublisher(input.publisher),
    revision: {
      revisionId: built.package.revisionId,
      contentHash: built.package.contentHash,
      pluginId: built.package.manifest.id,
      version: built.package.manifest.version
    },
    dependencyLock,
    sbom,
    artifacts: describeRevisionArtifacts(built.files)
  }
  return clonePluginRuntimeJson(normalized, 'Marketplace signature payload')
}

function normalizePublisher(value: MarketplacePublisherIdentity): MarketplacePublisherIdentity {
  assertOnlyKeys(value, ['publisherId', 'keyId'], 'Marketplace publisher')
  const publisherId = normalizedId(value?.publisherId, 'Marketplace publisher id')
  const keyId = normalizedId(value?.keyId, 'Marketplace publisher key id')
  return { publisherId, keyId }
}

function normalizeDependencyLock(value: MarketplaceDependencyLock): MarketplaceDependencyLock {
  if (!value || value.lockFormat !== 'knowbook-dependency-lock-v1' || value.packageManager !== 'bundled') {
    throw new Error('Marketplace dependency lock format is invalid.')
  }
  if (!Array.isArray(value.dependencies) || value.dependencies.length > MAX_DEPENDENCIES) {
    throw new Error(`Marketplace dependency lock supports at most ${MAX_DEPENDENCIES} dependencies.`)
  }
  assertOnlyKeys(value, ['lockFormat', 'packageManager', 'dependencies'], 'Marketplace dependency lock')
  const seen = new Set<string>()
  const dependencies = value.dependencies.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Marketplace dependency ${index} is invalid.`)
    assertOnlyKeys(entry, ['name', 'version', 'integrity'], `Marketplace dependency ${index}`)
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`Marketplace dependency ${index} name is invalid.`)
    const version = typeof entry.version === 'string' ? entry.version.trim() : ''
    if (!semver.valid(version)) throw new Error(`Marketplace dependency "${name}" must use an exact semantic version.`)
    const integrity = typeof entry.integrity === 'string' ? entry.integrity.trim() : ''
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error(`Marketplace dependency "${name}" integrity is invalid.`)
    const key = `${name}@${version}`
    if (seen.has(key)) throw new Error(`Marketplace dependency "${key}" is duplicated.`)
    seen.add(key)
    return { name, version, integrity }
  }).sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'))
  return { lockFormat: 'knowbook-dependency-lock-v1', packageManager: 'bundled', dependencies }
}

function normalizeSbom(value: MarketplaceCycloneDxSbom, revision: PluginRevisionPackage): MarketplaceCycloneDxSbom {
  if (!value || value.bomFormat !== 'CycloneDX' || value.specVersion !== '1.5' || value.version !== 1) {
    throw new Error('Marketplace SBOM must be CycloneDX 1.5 version 1.')
  }
  assertOnlyKeys(value, ['bomFormat', 'specVersion', 'version', 'metadata', 'components'], 'Marketplace SBOM')
  assertOnlyKeys(value.metadata, ['component'], 'Marketplace SBOM metadata')
  const root = value.metadata?.component
  if (root?.type !== 'application' || root.name !== revision.manifest.id || root.version !== revision.manifest.version) {
    throw new Error('Marketplace SBOM root component does not match the plugin manifest.')
  }
  assertOnlyKeys(root, ['type', 'name', 'version'], 'Marketplace SBOM root component')
  if (!Array.isArray(value.components) || value.components.length > MAX_DEPENDENCIES) {
    throw new Error('Marketplace SBOM component list is invalid.')
  }
  const seen = new Set<string>()
  const components = value.components.map((component, index) => {
    if (component?.type !== 'library') throw new Error(`Marketplace SBOM component ${index} type is invalid.`)
    assertOnlyKeys(component, ['type', 'name', 'version', 'hashes'], `Marketplace SBOM component ${index}`)
    const name = typeof component.name === 'string' ? component.name.trim() : ''
    const version = typeof component.version === 'string' ? component.version.trim() : ''
    if (!name || !semver.valid(version)) throw new Error(`Marketplace SBOM component ${index} identity is invalid.`)
    const key = `${name}@${version}`
    if (seen.has(key)) throw new Error(`Marketplace SBOM component "${key}" is duplicated.`)
    seen.add(key)
    if (!Array.isArray(component.hashes) || component.hashes.length === 0 || component.hashes.length > 8) {
      throw new Error(`Marketplace SBOM component "${name}" hashes are invalid.`)
    }
    const hashes = component.hashes.map((hash) => {
      if (!hash || (hash.alg !== 'SHA-256' && hash.alg !== 'SHA-512')) throw new Error(`Marketplace SBOM component "${name}" hash algorithm is invalid.`)
      assertOnlyKeys(hash, ['alg', 'content'], `Marketplace SBOM component "${name}" hash`)
      const expectedLength = hash.alg === 'SHA-256' ? 64 : 128
      const content = typeof hash.content === 'string' ? hash.content.toLowerCase() : ''
      if (!new RegExp(`^[a-f0-9]{${expectedLength}}$`).test(content)) throw new Error(`Marketplace SBOM component "${name}" hash is invalid.`)
      return { alg: hash.alg, content }
    })
    return { type: 'library' as const, name, version, hashes }
  }).sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'))
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { component: { type: 'application', name: root.name, version: root.version } },
    components
  }
}

function assertSbomMatchesLock(
  sbom: MarketplaceCycloneDxSbom,
  lock: MarketplaceDependencyLock
): void {
  const expected = lock.dependencies.map((dependency) => {
    const sha512Hex = Buffer.from(dependency.integrity.slice('sha512-'.length), 'base64').toString('hex')
    return `${dependency.name}@${dependency.version}\0${sha512Hex}`
  }).sort()
  const actual = sbom.components.map((component) => {
    const sha512 = component.hashes.find((hash) => hash.alg === 'SHA-512')
    if (!sha512) throw new Error(`Marketplace SBOM component "${component.name}" is missing its locked SHA-512 hash.`)
    return `${component.name}@${component.version}\0${sha512.content}`
  }).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Marketplace SBOM components do not exactly match the dependency lock.')
  }
}

function assertArtifactList(actual: MarketplaceArtifactDigest[], expected: MarketplaceArtifactDigest[]): void {
  if (!Array.isArray(actual)) throw new Error('Marketplace artifact digest list is missing.')
  const normalized = actual.map((entry, index) => {
    assertOnlyKeys(entry, ['path', 'size', 'sha256'], `Marketplace artifact ${index}`)
    return { path: entry?.path, size: entry?.size, sha256: entry?.sha256 }
  })
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error('Marketplace artifact hashes do not match the deterministic revision contents.')
  }
}

function describeRevisionArtifacts(files: readonly { path: string; content: Uint8Array }[]): MarketplaceArtifactDigest[] {
  return files.map((file) => ({
    path: file.path,
    size: file.content.byteLength,
    sha256: createHash('sha256').update(file.content).digest('hex')
  })).sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function findModuleSpecifiers(source: string): string[] {
  const result = new Set<string>()
  const pattern = /(?:\bimport\s*(?:\([^)]*?\)|[^'";]*?\bfrom\s*)|\bexport\s+[^'";]*?\bfrom\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) if (match[1]) result.add(match[1])
  return [...result].sort()
}

function normalizedId(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > MAX_PUBLISHER_LENGTH || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(normalized)) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${label} is invalid.`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 64 || decoded.toString('base64') !== value) throw new Error(`${label} is invalid.`)
  return decoded
}

function assertOnlyKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new Error(`${label} contains unknown field "${unknown}".`)
}
