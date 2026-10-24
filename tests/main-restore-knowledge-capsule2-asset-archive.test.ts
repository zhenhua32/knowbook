import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { link, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { reopenPreparedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { prepareCapsule2AssetArchive, reopenCapsule2AssetArchive, readCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { prepareCapsule2KnownAssetOriginals } from '../src/main/database/restore-knowledge-capsule2-assets-files'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { addV3Assets, allTables, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { seedPluginPolicy } from './helpers/capsule2-plugin-policy-fixture'

const hash = (value: unknown) => capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v1\0' + capsuleJson(value))
function summary(f: V3Fixture, value: string) {
  const id = f.store.createDocument(null)
  f.store.updateDocument(id, { title: 'Ordinary literal asset references', summary: value, blocks: [] })
  assert.equal(f.store.getDocumentDetail(id)!.summary, value)
  return id
}
async function prepare(f: V3Fixture) {
  const source = await captureAssetOriginal(f), before = allTables(f.db), handle = await prepareCapsule2AssetArchive(source.original)
  const value = await readCapsule2AssetArchive(handle)
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
  return { source, handle, value }
}
async function raw(source: Awaited<ReturnType<typeof captureAssetOriginal>>) {
  return reopenPreparedRawCapsuleOriginal({ profileRoot: source.info.profileRoot, operationId: basename(source.info.recoveryDirectory),
    capsuleId: basename(source.info.capsuleDirectory), expectedInventory: source.inventory })
}

test('capsule2 complete archive preserves missing and foreign reference literals with all actual managed files', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), [unreferenced] = await f.assets.import([{ name: 'unreferenced.txt', bytes: Buffer.from('actual unreferenced') }])
  const missing = pathToFileURL(join(f.assets.root, 'attachments', '00', '0'.repeat(64), 'missing.png')).href
  const foreign = pathToFileURL(join(f.root, 'foreign-not-read.png')).href, future = 'knowbook-asset://future-broken/reference.png'
  const text = `![missing](<${missing}>) [foreign](<${foreign}>) [portable](<${future}>) ![remote](https://invalid.example/image.png)`
  const documentId = summary(f, text)
  const { source, handle, value } = await prepare(f)
  assert.equal(value.manifest.referencePolicy, 'retain-literals-without-reference-file-access')
  for (const uri of [missing, foreign, future, ...added.attachments.map(asset => asset.url)]) assert.ok(value.manifest.referenceUris.includes(uri))
  assert.equal(value.manifest.tree.aliases.length, 3); assert.equal(value.manifest.tree.files.length, 2)
  const extra = value.manifest.tree.aliases.find(alias => alias.name === unreferenced.name)!
  assert.deepEqual(await readFile(join(value.directory, 'files', extra.hash)), Buffer.from('actual unreferenced'))
  assert.equal(f.store.getDocumentDetail(documentId)!.summary, text)
  assert.equal(value.manifest.certified, false); assert.equal(value.manifest.semanticValidationComplete, false); assert.equal(value.manifest.permit, false)
  assert.deepEqual((await readdir(source.info.capsuleDirectory)).sort(), ['original', 'scratch'])
  await assert.rejects(readCapsule2AssetArchive({ ...handle }), /私有句柄/)
}))

test('capsule2 complete archive never invokes filesystem operations for an external reference target', () => withV3Fixture(async f => {
  await addV3Assets(f)
  const foreign = join(f.root, 'private-external-target.png'), uri = pathToFileURL(foreign).href
  summary(f, `[outside](<${uri}>)`)
  const source = await captureAssetOriginal(f), require = createRequire(import.meta.url)
  const native = require('node:fs') as Record<string, unknown>, promises = require('node:fs/promises') as Record<string, unknown>
  const patched: Array<{ object: Record<string, unknown>; name: string; original: unknown }> = [], accesses: string[] = []
  const target = resolve(foreign).toLowerCase()
  try {
    for (const [object, names] of [[native, ['openSync','lstatSync','statSync','readFileSync','realpathSync']],
      [promises, ['open','lstat','stat','readFile','realpath','opendir','readdir']]] as const) for (const name of names) {
      const original = object[name] as (...input: unknown[]) => unknown
      patched.push({ object, name, original })
      const wrapper = function(this: unknown, ...input: unknown[]) {
        let path = input[0]
        if (path instanceof URL && path.protocol === 'file:') path = fileURLToPath(path)
        if (typeof path === 'string' && resolve(path).toLowerCase() === target) { accesses.push(name); throw new Error('external reference filesystem access forbidden') }
        return original.apply(this, input)
      }
      Object.assign(wrapper, original); object[name] = wrapper
    }
    syncBuiltinESMExports()
    const value = await readCapsule2AssetArchive(await prepareCapsule2AssetArchive(source.original))
    assert.ok(value.manifest.referenceUris.includes(uri)); assert.deepEqual(accesses, [])
  } finally { for (const patch of patched) patch.object[patch.name] = patch.original; syncBuiltinESMExports() }
}))

test('capsule2 complete archive keeps reference sets above the old file-alias limit without fabricating file availability', () => withV3Fixture(async f => {
  const uris = Array.from({ length: 5001 }, (_, index) => 'file:///missing-original/' + index + '.png')
  summary(f, uris.map(uri => `[file](<${uri}>)`).join('\n'))
  const { value } = await prepare(f)
  assert.equal(value.manifest.referenceUris.length, 5001); assert.ok(value.manifest.referenceCount >= 5001)
  assert.deepEqual(value.manifest.referenceUris, [...uris].sort()); assert.equal(value.manifest.tree.rootPresent, false)
  assert.deepEqual(value.manifest.tree.files, []); await assert.rejects(lstat(f.assets.root), { code: 'ENOENT' })
}))

test('capsule2 complete archive retains opaque plugin-held files and pending states without interpreting external policy paths', () => withV3Fixture(async f => {
  const policy = seedPluginPolicy(f), [asset] = await f.assets.import([{ name: 'opaque-only.bin', bytes: Buffer.from('opaque file') }])
  policy.repository.writePluginState(policy.pluginId, policy.scope, 'opaque-paths', { managed: asset.url, external: 'file:///private/never-follow.txt' }, 3)
  const { value } = await prepare(f)
  assert.deepEqual(value.manifest.referenceUris, []); assert.equal(value.manifest.tree.files.length, 1)
  assert.equal(policy.repository.getSystemPluginRun(policy.run.id)?.status, 'starting')
  assert.equal(policy.repository.getSystemPluginInstallRequest(policy.request.id)?.status, 'awaiting-confirmation')
}))

test('capsule2 complete archive reopens from original SQL after all live managed names disappear', () => withV3Fixture(async f => {
  await addV3Assets(f); summary(f, '[broken](<file:///missing-original/file.png>)')
  const { source, value } = await prepare(f)
  for (const alias of value.manifest.tree.aliases) await unlink(join(f.assets.root, alias.relativePath))
  await writeFile(source.info.databasePath, 'poisoned old scratch')
  const reopened = await reopenCapsule2AssetArchive(await raw(source), value.manifestHash)
  assert.deepEqual(await readCapsule2AssetArchive(reopened), value)
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

for (const variant of ['source-hash','reference-set','reference-count','reference-policy','permission','missing-file','extra-field'] as const)
  test(`capsule2 complete archive rejects rehashed ${variant} without accepting a caller attestation`, () => withV3Fixture(async f => {
    await addV3Assets(f); const { source, value } = await prepare(f), manifest = JSON.parse(capsuleJson(value.manifest))
    if (variant === 'source-hash') manifest.sourceContentHash = '0'.repeat(64)
    if (variant === 'reference-set') manifest.referenceUris = ['file:///caller-selected/subset.png']
    if (variant === 'reference-count') manifest.referenceCount++
    if (variant === 'reference-policy') manifest.referencePolicy = 'follow-references'
    if (variant === 'permission') manifest.permit = true
    if (variant === 'missing-file') manifest.tree.files = []
    if (variant === 'extra-field') manifest.callerCertificate = true
    await writeFile(join(value.directory, 'manifest.json'), capsuleJson(manifest) + '\n')
    await assert.rejects(reopenCapsule2AssetArchive(await raw(source), hash(manifest)))
  }))

test('capsule2 complete archive fails closed for tampered blobs and hardlinked saved manifests', () => withV3Fixture(async f => {
  await addV3Assets(f); const { source, value, handle } = await prepare(f)
  const alias = join(source.info.profileRoot, 'archive-manifest-alias'), manifest = join(value.directory, 'manifest.json')
  await link(manifest, alias)
  await assert.rejects(reopenCapsule2AssetArchive(await raw(source), value.manifestHash), /独立|文件/)
  await unlink(alias); await writeFile(join(value.directory, 'files', value.manifest.tree.files[0].hash), 'changed saved bytes')
  await assert.rejects(readCapsule2AssetArchive(handle), /文件|hash|字节/)
}))

test('capsule2 strict known-only predecessor still rejects broken references and cannot silently become a complete archive', () => withV3Fixture(async f => {
  summary(f, '[broken](<file:///missing-original/absent.png>)')
  const source = await captureAssetOriginal(f)
  await assert.rejects(prepareCapsule2KnownAssetOriginals(source.original))
  const independent = await captureAssetOriginal(f), complete = await prepareCapsule2AssetArchive(independent.original)
  assert.ok((await readCapsule2AssetArchive(complete)).manifest.referenceUris.includes('file:///missing-original/absent.png'))
}))

test('capsule2 literal reference policy never downgrades a redirected managed root into an external or missing reference', () => withV3Fixture(async f => {
  const outside = join(f.root, 'actual-other-tree'); await mkdir(outside)
  await symlink(outside, f.assets.root, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const source = await captureAssetOriginal(f)
    await assert.rejects(prepareCapsule2AssetArchive(source.original), /符号|重定向|目录|symlink|junction/)
    await assert.rejects(prepareCapsule2AssetArchive(source.original), /已开始|重入|失败/)
    assert.deepEqual(await readdir(outside), [])
    assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
  } finally { assert.equal((await lstat(f.assets.root)).isSymbolicLink(), true); await unlink(f.assets.root) }
}))

test('capsule2 literal reference policy refuses corrupted managed bytes even when every reference is retained only as text', () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: 'actual-corrupted-source.png', bytes: Buffer.from('original managed bytes') }])
  summary(f, '[external](<file:///outside/not-read.png>)')
  await writeFile(f.assets.resolve(asset.url), 'changed managed bytes')
  const source = await captureAssetOriginal(f)
  await assert.rejects(prepareCapsule2AssetArchive(source.original), /附件|hash|字节|文件/)
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))
