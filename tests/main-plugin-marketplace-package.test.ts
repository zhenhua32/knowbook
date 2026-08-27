import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { installMarketplacePluginPackage } from '../src/main/plugin-platform/marketplace-installer.ts'
import {
  createUnsignedMarketplacePluginPackage,
  signMarketplacePluginPackage,
  verifyMarketplacePluginPackage,
  type MarketplaceCycloneDxSbom,
  type MarketplaceDependencyLock
} from '../src/main/plugin-platform/marketplace-package.ts'
import { PluginRevisionStore } from '../src/main/plugin-platform/revision-store.ts'

test('marketplace packages require trusted Ed25519 signatures and deterministic artifact hashes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const unsigned = createUnsignedMarketplacePluginPackage({
    publisher: { publisherId: 'example.publisher', keyId: 'release-2026' },
    revision: revision(),
    dependencyLock: emptyLock(),
    sbom: emptySbom()
  })
  const signed = signMarketplacePluginPackage(unsigned, privateKey)
  const trust = [{
    publisherId: 'example.publisher',
    keyId: 'release-2026',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }]
  const verified = verifyMarketplacePluginPackage(signed, trust)
  assert.equal(verified.revision.manifest.id, 'market-card')
  assert.deepEqual(verified.artifacts.map((artifact) => artifact.path), ['plugin.json', 'worker.js'])
  assert.throws(() => verifyMarketplacePluginPackage(signed, []), /not trusted/)
  assert.throws(() => verifyMarketplacePluginPackage({
    ...signed,
    revision: { ...signed.revision, workerSource: 'export default { activate() { return { contributions: [{ descriptor: { slot: "x", id: "y" }, value: null }] } } }' }
  }, trust), /artifact hashes|signature verification/)
  assert.throws(() => verifyMarketplacePluginPackage({
    ...signed,
    artifacts: signed.artifacts.map((artifact) => artifact.path === 'worker.js'
      ? { ...artifact, sha256: '0'.repeat(64) }
      : artifact)
  }, trust), /artifact hashes/)
})

test('marketplace scan rejects native artifacts, runtime package installation, and unbundled imports', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const trust = [{
    publisherId: 'example.publisher',
    keyId: 'release-2026',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }]
  for (const unsafe of [
    revision({ assets: { 'native/addon.node': Uint8Array.from([1, 2, 3]) } }),
    revision({ workerSource: 'const note = "npm install bad"; export default {}' }),
    revision({ workerSource: 'import value from "left-pad"; export default value' })
  ]) {
    const signed = signMarketplacePluginPackage(createUnsignedMarketplacePluginPackage({
      publisher: { publisherId: 'example.publisher', keyId: 'release-2026' },
      revision: unsafe,
      dependencyLock: emptyLock(),
      sbom: emptySbom()
    }), privateKey)
    assert.throws(() => verifyMarketplacePluginPackage(signed, trust), /security scan failed/)
  }
})

test('marketplace CycloneDX SBOM must exactly match the locked bundled dependencies', () => {
  const digest = Buffer.alloc(64, 7)
  const lock: MarketplaceDependencyLock = {
    lockFormat: 'knowbook-dependency-lock-v1',
    packageManager: 'bundled',
    dependencies: [{ name: 'marked', version: '15.0.0', integrity: `sha512-${digest.toString('base64')}` }]
  }
  const sbom: MarketplaceCycloneDxSbom = {
    ...emptySbom(),
    components: [{
      type: 'library',
      name: 'marked',
      version: '15.0.0',
      hashes: [{ alg: 'SHA-512', content: digest.toString('hex') }]
    }]
  }
  assert.doesNotThrow(() => createUnsignedMarketplacePluginPackage({
    publisher: { publisherId: 'example.publisher', keyId: 'release-2026' },
    revision: revision(),
    dependencyLock: lock,
    sbom
  }))
  assert.throws(() => createUnsignedMarketplacePluginPackage({
    publisher: { publisherId: 'example.publisher', keyId: 'release-2026' },
    revision: revision(),
    dependencyLock: lock,
    sbom: emptySbom()
  }), /do not exactly match/)
})

test('verified marketplace install persists an immutable disabled revision without executing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-marketplace-install-'))
  const store = new KnowbookStore(join(root, 'knowbook.db'))
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const signed = signMarketplacePluginPackage(createUnsignedMarketplacePluginPackage({
      publisher: { publisherId: 'example.publisher', keyId: 'release-2026' },
      revision: revision(),
      dependencyLock: emptyLock(),
      sbom: emptySbom()
    }), privateKey)
    let validationCalls = 0
    const result = await installMarketplacePluginPackage({
      repository: store.pluginPlatform,
      revisions: new PluginRevisionStore(join(root, 'objects')),
      validator: {
        validate: (package_) => {
          validationCalls += 1
          assert.equal(package_.manifest.id, 'market-card')
          return { status: 'passed', diagnostics: [{ code: 'compiled' }] }
        }
      },
      workspaceScope: { kind: 'workspace', workspaceId: 'workspace-1' },
      trustedPublishers: [{
        publisherId: 'example.publisher',
        keyId: 'release-2026',
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
      }]
    }, signed)

    assert.equal(validationCalls, 1)
    assert.equal(result.signatureVerified, true)
    assert.equal(result.enabled, false)
    assert.equal(result.activationRequiresApproval, true)
    const definition = store.pluginPlatform.getDefinition('market-card')
    const installation = store.pluginPlatform.getInstallation(result.installationId)
    assert.equal(definition?.source, 'marketplace')
    assert.equal(definition?.currentRevisionId, null)
    assert.equal(definition?.activeRunId, null)
    assert.equal(definition?.pendingRevisionId, result.revisionId)
    assert.equal(installation?.enabled, false)
    assert.equal(installation?.activeRunId, null)
    assert.equal(store.pluginPlatform.listPluginRuns('market-card').length, 0)
  } finally {
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

function revision(overrides: Record<string, unknown> = {}) {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'market-card',
      name: 'Market Card',
      version: '1.0.0',
      apiVersion: '2',
      permissions: [],
      standardModules: []
    },
    workerSource: 'export default { activate() { return { contributions: [] } } }',
    ...overrides
  }
}

function emptyLock(): MarketplaceDependencyLock {
  return { lockFormat: 'knowbook-dependency-lock-v1', packageManager: 'bundled', dependencies: [] }
}

function emptySbom(): MarketplaceCycloneDxSbom {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { component: { type: 'application', name: 'market-card', version: '1.0.0' } },
    components: []
  }
}
