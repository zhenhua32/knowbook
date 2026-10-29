// REVIEW DRAFT. Intended destination tests/. Do not execute before the four
// producer modules are integrated. Every positive owner comes from real SQL
// online backup + Main capture; no DTO is supplied as a capability.
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { cp, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AttachmentStore } from '../src/main/attachments'
import { ATTACHMENT_MAX_FILE_BYTES } from '../src/shared/attachments'
import { buildSyncedPortableAssetUri } from '../src/shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { prepareCapsule2AssetArchive, prepareCapsule2AssetArchiveWithProvenance3,
  readCapsule2AssetArchive, parseCapsule2CompleteAssetArchiveManifest } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { extractCapsule2SourceMaterial, readCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-material'
import { captureSealedCapsule2SourceWithAssetProvenance3, readSealedCapsule2SourceMaterial,
  reopenSealedCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { capsule2AssetReferenceProvenanceHash } from '../src/main/database/restore-knowledge-capsule2-asset-provenance'
import { withV3Fixture, allTables, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { windowsShortPath } from './helpers/windows-short-path'

function summary(f: V3Fixture, text: string) {
  const id = f.store.createDocument(null)
  f.store.updateDocument(id, { title: 'Actual base provenance source', summary: text, blocks: [] })
  assert.equal(f.store.getDocumentDetail(id)!.summary, text)
  return id
}
async function archive2(f: V3Fixture) {
  const original = await captureAssetOriginal(f), before = allTables(f.db)
  const owner = await prepareCapsule2AssetArchiveWithProvenance3(original.original), read = await readCapsule2AssetArchive(owner)
  assert.equal(read.manifest.version, 2)
  if (read.manifest.version !== 2) throw new Error('Expected explicit genuine archive2 producer')
  assert.deepEqual(allTables(f.db), before)
  return { original, owner, read, manifest: read.manifest }
}
function entry(saved: Awaited<ReturnType<typeof archive2>>, uri: string) {
  const index = saved.manifest.referenceUris.indexOf(uri); assert.ok(index >= 0, 'Actual typed observer must retain this original URI')
  const found = saved.manifest.referenceProvenance.entries.find(value => value[0] === index); assert.ok(found)
  return found
}
async function sealed(f: V3Fixture) {
  const original = await captureAssetOriginal(f), before = allTables(f.db)
  const saved = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
  assert.deepEqual(allTables(f.db), before)
  const input = { profileRoot: original.info.profileRoot, operationId: saved.info.manifest.operationId,
    capsuleId: saved.info.manifest.capsuleId, expectedManifestHash: saved.info.manifestHash }
  assert.equal(saved.value.assetArchive.version, 2)
  return { original, saved, input }
}

test('actual base producer classifies managed file and portable aliases and binds strictly partial coverage through material and seal', { concurrency: false }, () => withV3Fixture(async f => {
  const bytes = Buffer.from('actual Main asset alias with native FD identity'), [asset, second] = await f.assets.import([
    { name: '真实 base.png', bytes }, { name: 'same-bytes-different-name.png', bytes }])
  const hash = capsuleBytesHash(bytes), portable = buildSyncedPortableAssetUri({ hash, name: second.name })
  const documentId = summary(f, `😀 ![managed](<${asset.url}>) [portable](<${portable}>)`)
  const snapshot = allTables(f.db), captured = await archive2(f)
  const file = entry(captured, asset.url), portableEntry = entry(captured, portable)
  assert.equal(file[1], 'file'); assert.equal(portableEntry[1], 'portable')
  if (file[1] !== 'file' || portableEntry[1] !== 'portable') throw new Error('Expected actual classified aliases')
  assert.equal(captured.manifest.tree.aliases[file[2]].name, asset.name)
  assert.equal(captured.manifest.tree.aliases[portableEntry[2]].name, second.name)
  assert.notEqual(file[2], portableEntry[2], 'Same bytes never merge two real alias names')
  assert.equal(captured.manifest.tree.files.length, 1)
  assert.deepEqual(await readFile(join(captured.read.directory, 'files', hash)), bytes)
  assert.deepEqual(captured.manifest.coverage, { kind: 'base-asset-observation-capture-only', version: 1, baseObserverVersion: 3,
    assetReferencesObservationHash: captured.manifest.assetReferencesObservationHash, baseTypedScopesCaptured: true,
    supplementalCustomMergeScopesCaptured: false, allAssetScopesCaptured: false, semanticSelectionPermission: false,
    finalAssetClosureComplete: false, acceptedCoverage: false, effective: false, installPermit: false })
  const material = await extractCapsule2SourceMaterial(captured.owner), actual = await readCapsule2SourceMaterial(material)
  assert.deepEqual(actual.assetArchive, captured.manifest)
  assert.equal(actual.assetArchiveHash, captured.read.manifestHash)
  const full = await sealed(f), sealedValue = await readSealedCapsule2SourceMaterial(full.saved.source)
  assert.equal(sealedValue.materialHash, full.saved.info.manifest.sourceMaterialHash)
  assert.equal(sealedValue.assetArchiveHash, full.saved.info.manifest.assetArchiveHash)
  assert.equal(sealedValue.assetArchive.version, 2)
  const pinnedArchivePath = join(full.original.info.recoveryDirectory, 'knowledge-complete-assets-v2', full.input.capsuleId, 'manifest.json')
  const pinnedArchiveBytes = await readFile(pinnedArchivePath), upgraded = JSON.parse(pinnedArchiveBytes.toString('utf8'))
  upgraded.coverage.allAssetScopesCaptured = true
  try { await writeFile(pinnedArchivePath, capsuleJson(upgraded) + '\n'); await assert.rejects(reopenSealedCapsule2Source(full.input)) }
  finally { await writeFile(pinnedArchivePath, pinnedArchiveBytes) }
  assert.equal((await readSealedCapsule2SourceMaterial(full.saved.source)).materialHash, sealedValue.materialHash)
  assert.equal(f.store.getDocumentDetail(documentId)!.summary, `😀 ![managed](<${asset.url}>) [portable](<${portable}>)`)
  assert.deepEqual(allTables(f.db), snapshot)
}))

test('actual base producer keeps foreign equal-suffix bytes and missing aliases unresolved without touching a foreign file', { concurrency: false }, () => withV3Fixture(async f => {
  const bytes = Buffer.from('same owned and foreign bytes'), [asset] = await f.assets.import([{ name: 'suffix.png', bytes }])
  const hash = capsuleBytesHash(bytes), foreign = join(f.root, 'outside', 'storage', 'assets', 'attachments', hash.slice(0, 2), hash, asset.name)
  await mkdir(dirname(foreign), { recursive: true }); await writeFile(foreign, bytes)
  const foreignUri = pathToFileURL(foreign).href, missingUri = pathToFileURL(join(f.assets.root, 'attachments', hash.slice(0, 2), hash, 'never-imported.png')).href
  summary(f, `[owned](<${asset.url}>) [same suffix](<${foreignUri}>) [missing](<${missingUri}>)`)
  const source = await captureAssetOriginal(f), require = createRequire(import.meta.url)
  const native = require('node:fs') as Record<string, unknown>, promises = require('node:fs/promises') as Record<string, unknown>
  const patches: Array<{ object: Record<string, unknown>; name: string; original: unknown }> = [], accesses: string[] = []
  const target = resolve(foreign).toLowerCase()
  let captured: Awaited<ReturnType<typeof readCapsule2AssetArchive>>
  try {
    for (const [object, names] of [[native, ['openSync', 'lstatSync', 'statSync', 'readFileSync', 'realpathSync']],
      [promises, ['open', 'lstat', 'stat', 'readFile', 'realpath', 'opendir', 'readdir']]] as const) for (const name of names) {
      const original = object[name] as (...args: unknown[]) => unknown; patches.push({ object, name, original })
      const wrapped = function(this: unknown, ...args: unknown[]) {
        const value = args[0] instanceof URL && args[0].protocol === 'file:' ? fileURLToPath(args[0]) : args[0]
        if (typeof value === 'string' && resolve(value).toLowerCase() === target) { accesses.push(name); throw new Error('foreign target IO forbidden') }
        return original.apply(this, args)
      }
      Object.assign(wrapped, original); object[name] = wrapped
    }
    syncBuiltinESMExports()
    captured = await readCapsule2AssetArchive(await prepareCapsule2AssetArchiveWithProvenance3(source.original))
  } finally { for (const patch of patches) patch.object[patch.name] = patch.original; syncBuiltinESMExports() }
  assert.deepEqual(accesses, [])
  assert.equal(captured!.manifest.version, 2)
  if (captured!.manifest.version !== 2) throw new Error('Expected archive2')
  const disposition = (uri: string) => captured!.manifest.version === 2 ? captured!.manifest.referenceProvenance.entries[captured!.manifest.referenceUris.indexOf(uri)] : null
  assert.equal(disposition(asset.url)![1], 'file')
  assert.deepEqual(disposition(foreignUri)!.slice(1), ['unresolved', 'foreign-uri'])
  assert.deepEqual(disposition(missingUri)!.slice(1), ['unresolved', 'missing-managed-alias'])
  assert.deepEqual(await readFile(foreign), bytes)
}))

test('actual base producer certifies a real NTFS short URI by opened-file identity and rejects a real foreign short URI',
  { concurrency: false, skip: process.platform !== 'win32' }, t => withV3Fixture(async f => {
    const canonical = await realpath(f.userDataRoot), shortRoot = windowsShortPath(canonical)
    if (shortRoot.toLowerCase() === canonical.toLowerCase()) { t.skip('This actual native volume supplies no distinct 8.3 profile alias'); return }
    const nativeStore = new AttachmentStore(join(shortRoot, 'storage', 'assets'))
    const [asset] = await nativeStore.import([{ name: 'native-short.png', bytes: Buffer.from('actual NTFS short root source bytes') }])
    const foreignStore = new AttachmentStore(join(f.root, 'outside-short-assets'))
    const [foreign] = await foreignStore.import([{ name: asset.name, bytes: Buffer.from('actual NTFS short root source bytes') }])
    const foreignShort = pathToFileURL(windowsShortPath(fileURLToPath(foreign.url))).href
    summary(f, `[short native](<${asset.url}>) [foreign native short](<${foreignShort}>)`)
    assert.equal((await lstat(fileURLToPath(asset.url))).isFile(), true)
    const captured = await archive2(f)
    const own = entry(captured, asset.url), outside = entry(captured, foreignShort)
    assert.equal(own[1], 'file'); assert.equal(outside[1], 'unresolved')
    if (own[1] !== 'file') throw new Error('A real short alias must be supported, not fabricated or waived')
    assert.equal(captured.manifest.tree.aliases[own[2]].name, asset.name)
    assert.ok(captured.manifest.referenceProvenance.rootSpellings.some(root => root.uri.toLowerCase() === pathToFileURL(join(shortRoot, 'storage', 'assets')).href.toLowerCase()))
    t.diagnostic(JSON.stringify({ canonicalProfile: canonical, realShortProfile: shortRoot, originalUri: asset.url }))
  }))

test('actual source readers reject missing archive original bytes and changed coverage or URI proof metadata', { concurrency: false }, () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: 'late-integrity.png', bytes: Buffer.from('actual original bytes') }]); summary(f, `[x](<${asset.url}>)`)
  const captured = await archive2(f), material = await extractCapsule2SourceMaterial(captured.owner)
  const file = join(captured.read.directory, 'files', captured.manifest.tree.files[0].hash), moved = file + '.temporarily-missing'
  await rename(file, moved)
  try { await assert.rejects(readCapsule2SourceMaterial(material)) } finally { await rename(moved, file) }
  const manifestFile = join(captured.read.directory, 'manifest.json'), original = await readFile(manifestFile)
  for (const tamper of [(value: { coverage: { allAssetScopesCaptured: boolean } }) => { value.coverage.allAssetScopesCaptured = true },
    (value: { referenceProvenance: { assetReferencesObservationHash: string } }) => { value.referenceProvenance.assetReferencesObservationHash = '0'.repeat(64) }]) {
    const changed = JSON.parse(original.toString('utf8')); tamper(changed)
    try { await writeFile(manifestFile, capsuleJson(changed) + '\n'); await assert.rejects(readCapsule2SourceMaterial(material)) }
    finally { await writeFile(manifestFile, original) }
  }
  const rehashedUpgrade = JSON.parse(original.toString('utf8')); rehashedUpgrade.coverage.allAssetScopesCaptured = true
  const upgradedText = capsuleJson(rehashedUpgrade) + '\n'
  const recomputedArchiveHash = capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v2\0' + capsuleJson(rehashedUpgrade))
  assert.throws(() => parseCapsule2CompleteAssetArchiveManifest(upgradedText, captured.manifest.capsuleId, captured.read.manifestHash))
  assert.throws(() => parseCapsule2CompleteAssetArchiveManifest(upgradedText, captured.manifest.capsuleId, recomputedArchiveHash), /覆盖|策略|caller/)
  assert.equal((await readCapsule2SourceMaterial(material)).assetArchiveHash, captured.read.manifestHash)
}))

test('legacy archive1 remains byte-exact and never acquires captured URI authority after explicit archive2 production', { concurrency: false }, () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: 'legacy.png', bytes: Buffer.from('actual legacy asset') }]); summary(f, `[x](<${asset.url}>)`)
  const source = await captureAssetOriginal(f), v1 = await prepareCapsule2AssetArchive(source.original), before = await readCapsule2AssetArchive(v1)
  const bytes = await readFile(join(before.directory, 'manifest.json')), material = await extractCapsule2SourceMaterial(v1)
  assert.equal(before.manifest.version, 1)
  assert.equal(Object.hasOwn(before.manifest, 'referenceProvenance'), false)
  assert.equal(Object.hasOwn(before.manifest, 'coverage'), false)
  await archive2(f)
  assert.deepEqual(await readFile(join(before.directory, 'manifest.json')), bytes)
  assert.deepEqual(await readCapsule2AssetArchive(v1), before)
  assert.equal((await readCapsule2SourceMaterial(material)).assetArchive.version, 1)
}))

test('actual producer preserves opaque code YAML and settings while keeping the original AttachmentStore file cap', { concurrency: false }, () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: 'opaque.png', bytes: Buffer.from('actual opaque-only file') }])
  const id = f.store.createDocument(null), literal = `![opaque](<${asset.url}>)`
  f.store.updateDocument(id, { title: 'Opaque fields', summary: '', blocks: [
    { id: 'yaml-' + id, type: 'frontmatter', content: `image: '${literal}'`, checked: false, depth: 0, parentBlockId: null },
    { id: 'code-' + id, type: 'code', language: 'markdown', content: literal, checked: false, depth: 0, parentBlockId: null },
    { id: 'body-' + id, type: 'paragraph', content: 'Ordinary body has no asset destination', checked: false, depth: 0, parentBlockId: null } ] })
  f.store.saveSetting('base-provenance.opaque', literal)
  const before = allTables(f.db), captured = await archive2(f)
  assert.equal(captured.manifest.referenceUris.includes(asset.url), false)
  assert.deepEqual(allTables(f.db), before)
  await assert.rejects(f.assets.import([{ name: 'too-large.bin', bytes: Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES + 1) }]), /25 MB|25/)
  assert.deepEqual(allTables(f.db), before)
  assert.deepEqual((await readCapsule2AssetArchive(captured.owner)).manifest, captured.manifest)
}))

test('sealed base provenance reopens in a new process after real relocation and retirement of all old live paths', { concurrency: false }, () => withV3Fixture(async f => {
  const fixtureRoot = await realpath(f.root)
  const [asset] = await f.assets.import([{ name: 'cold-original.png', bytes: Buffer.from('actual cold asset bytes') }]); summary(f, `😀 [cold](<${asset.url}>)`)
  const full = await sealed(f), value = await readSealedCapsule2SourceMaterial(full.saved.source)
  assert.equal(value.assetArchive.version, 2)
  if (value.assetArchive.version !== 2) throw new Error('Expected captured base archive2')
  await unlink(fileURLToPath(asset.url))
  await assert.rejects(lstat(fileURLToPath(asset.url)), { code: 'ENOENT' })
  // Hot reopen also starts from genuine persisted native originals.
  assert.equal((await readSealedCapsule2SourceMaterial(await reopenSealedCapsule2Source(full.input))).materialHash, value.materialHash)
  const coldRoot = join(fixtureRoot, 'cold-independent-profile'); await mkdir(join(coldRoot, 'backups', 'database-restore'), { recursive: true })
  await cp(full.original.info.recoveryDirectory, join(coldRoot, 'backups', 'database-restore', full.input.operationId), { recursive: true, force: false, errorOnExist: true })
  const canonicalCold = await realpath(coldRoot), profileRoot = await realpath(full.original.info.profileRoot)
  const retired = join(fixtureRoot, 'retired-original-profile')
  // Moving a real profile is authorized only within this exact owned fixture.
  // Canonical absolute source and computed target are checked before closing
  // handles and renaming; neither endpoint can be the fixture root itself.
  assert.notEqual(profileRoot, fixtureRoot); assert.notEqual(retired, fixtureRoot)
  assert.equal(dirname(profileRoot), fixtureRoot)
  assert.equal(dirname(retired), fixtureRoot)
  assert.equal(dirname(canonicalCold), fixtureRoot)
  await assert.rejects(lstat(retired), { code: 'ENOENT' })
  f.close(); await rename(profileRoot, retired)
  await assert.rejects(lstat(full.original.info.profileRoot), { code: 'ENOENT' })
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/capsule2-base-provenance-process.cjs'),
    JSON.stringify({ ...full.input, profileRoot: canonicalCold })],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  const actual = JSON.parse(stdout)
  assert.notEqual(actual.pid, process.pid)
  assert.equal(actual.materialHash, value.materialHash)
  assert.equal(actual.sourceManifestHash, full.saved.info.manifestHash)
  assert.equal(actual.assetArchiveHash, value.assetArchiveHash)
  assert.equal(actual.provenanceHash, capsule2AssetReferenceProvenanceHash(value.assetArchive.referenceProvenance))
  assert.deepEqual(actual.coverage, value.assetArchive.coverage)
  assert.equal(actual.installPermit, false)
}))
