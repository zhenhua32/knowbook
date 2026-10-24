import assert from 'node:assert/strict'
import test from 'node:test'
import { link, lstat, mkdir, readFile, readdir, realpath, rename, symlink, truncate, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ATTACHMENT_MAX_FILE_BYTES } from '../src/shared/attachments'
import { AttachmentStore } from '../src/main/attachments'
import { prepareCapsule2ManagedAssetOriginals, readPreparedCapsule2ManagedAssetOriginals,
  type PreparedCapsule2ManagedAssetOriginals } from '../src/main/database/restore-knowledge-capsule2-managed-assets-files'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { addV3Assets, allTables, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { accepted, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'
import { seedPluginPolicy } from './helpers/capsule2-plugin-policy-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { windowsShortPath } from './helpers/windows-short-path'

test('capsule2 complete managed files preserve real plugin-held and unreferenced imports in addition to known Markdown without executing or changing policy', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), policy = seedPluginPolicy(f)
  const extras = await f.assets.import([{ name: 'policy-only.png', bytes: Buffer.from('actual opaque plugin image') },
    { name: 'unreferenced.bin', bytes: Buffer.from('actual unreferenced import') }])
  policy.repository.writePluginState(policy.pluginId, policy.scope, 'managed-image', { nested: { image: extras[0].url } }, 2)
  const source = await captureAssetOriginal(f), before = allTables(f.db)
  const handle = await prepareCapsule2ManagedAssetOriginals(source.original), value = await readPreparedCapsule2ManagedAssetOriginals(handle)
  assert.equal(value.manifest.knownAliases.length, 2); assert.equal(value.manifest.aliases.length, 4); assert.equal(value.manifest.files.length, 3)
  assert.deepEqual(value.manifest.knownAliases.map(alias => alias.uri).sort(), added.attachments.map(asset => asset.url).sort())
  for (const asset of [...added.attachments, ...extras]) {
    const path = relative(f.assets.root, f.assets.resolve(asset.url)).split(sep).join('/'), alias = value.manifest.aliases.find(alias => alias.relativePath === path)
    assert.ok(alias); assert.equal(alias.name, asset.name)
    assert.deepEqual(await readFile(join(value.directory, 'files', alias.hash)), await readFile(f.assets.resolve(asset.url)))
  }
  assert.equal(policy.repository.getSystemPluginRun(policy.run.id)?.status, 'starting')
  assert.equal(policy.repository.getSystemPluginInstallRequest(policy.request.id)?.status, 'awaiting-confirmation')
  assert.equal(value.manifest.state, 'all-managed-files-only'); assert.equal(value.manifest.certified, false)
  assert.equal(value.manifest.semanticValidationComplete, false); assert.equal(value.manifest.permit, false)
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
  assert.deepEqual((await readdir(source.info.capsuleDirectory)).sort(), ['original', 'scratch'])
}))

test('capsule2 complete managed files capture an actual settings-only import even when the known Markdown set is empty', () => withV3Fixture(async f => {
  const bytes = Buffer.from('actual setting-only asset'), [asset] = await f.assets.import([{ name: 'settings-only.png', bytes }])
  const literal = JSON.stringify({ opaque: { file: asset.url } }); f.store.saveSetting('actual.opaque.asset', literal)
  const source = await captureAssetOriginal(f), value = await readPreparedCapsule2ManagedAssetOriginals(await prepareCapsule2ManagedAssetOriginals(source.original))
  assert.deepEqual(value.manifest.knownAliases, []); assert.equal(value.manifest.aliases.length, 1)
  assert.deepEqual(await readFile(join(value.directory, 'files', value.manifest.files[0].hash)), bytes)
  assert.equal(f.store.getSettingPublic('actual.opaque.asset'), literal)
}))

test('capsule2 complete managed copies survive disappearance of all known and unreferenced live names', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), [extra] = await f.assets.import([{ name: 'orphan.bin', bytes: Buffer.from('saved orphan') }])
  const source = await captureAssetOriginal(f), handle = await prepareCapsule2ManagedAssetOriginals(source.original), value = await readPreparedCapsule2ManagedAssetOriginals(handle)
  for (const asset of [...added.attachments, extra]) await unlink(f.assets.resolve(asset.url))
  assert.deepEqual(await readPreparedCapsule2ManagedAssetOriginals(handle), value)
  assert.equal(value.manifest.files.length, 2)
  for (const file of value.manifest.files) assert.equal((await readFile(join(value.directory, 'files', file.hash))).length, file.bytes)
}))

test('capsule2 missing managed root is an explicit saved file observation and is never created or called empty knowledge', () => withV3Fixture(async f => {
  await assert.rejects(lstat(f.assets.root), { code: 'ENOENT' })
  const source = await captureAssetOriginal(f), value = await readPreparedCapsule2ManagedAssetOriginals(await prepareCapsule2ManagedAssetOriginals(source.original))
  assert.equal(value.manifest.rootPresent, false); assert.deepEqual(value.manifest.directories, [])
  assert.deepEqual(value.manifest.aliases, []); assert.deepEqual(value.manifest.files, [])
  assert.equal(value.manifest.certified, false); assert.equal(value.manifest.semanticValidationComplete, false); assert.equal(value.manifest.permit, false)
  await assert.rejects(lstat(f.assets.root), { code: 'ENOENT' })
}))

test('capsule2 managed file closure retains genuine empty source directories after a zero-byte import name disappears', () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: 'actual-empty.bin', bytes: Buffer.alloc(0) }])
  const path = f.assets.resolve(asset.url), directory = relative(f.assets.root, path).split(sep).slice(0, -1).join('/')
  await unlink(path)
  const source = await captureAssetOriginal(f), value = await readPreparedCapsule2ManagedAssetOriginals(await prepareCapsule2ManagedAssetOriginals(source.original))
  assert.equal(value.manifest.rootPresent, true); assert.deepEqual(value.manifest.aliases, []); assert.deepEqual(value.manifest.files, [])
  assert.ok(value.manifest.directories.includes('')); assert.ok(value.manifest.directories.includes(directory))
}))

test('capsule2 managed file closure preserves genuine zero-byte unreferenced imports as files', () => withV3Fixture(async f => {
  await f.assets.import([{ name: 'present-zero.bin', bytes: Buffer.alloc(0) }])
  const source = await captureAssetOriginal(f), value = await readPreparedCapsule2ManagedAssetOriginals(await prepareCapsule2ManagedAssetOriginals(source.original))
  assert.equal(value.manifest.aliases.length, 1); assert.equal(value.manifest.files.length, 1)
  assert.equal(value.manifest.files[0].bytes, 0); assert.equal((await readFile(join(value.directory, 'files', value.manifest.files[0].hash))).length, 0)
}))

test('capsule2 complete managed files copy real incoming hardlink aliases into one independent saved blob', () => withIncomingFixture(async f => {
  await f.publish(); accepted(await f.receive())
  const source = await captureAssetOriginal({ userDataRoot: f.B.root, db: f.B.db })
  const value = await readPreparedCapsule2ManagedAssetOriginals(await prepareCapsule2ManagedAssetOriginals(source.original))
  assert.equal(value.manifest.aliases.length, 2); assert.equal(value.manifest.files.length, 1)
  const path = join(value.directory, 'files', value.manifest.files[0].hash)
  assert.equal((await lstat(path)).nlink, 1); assert.deepEqual(await readFile(path), f.aliases[0].bytes)
}, { assets: true }))

test('capsule2 complete managed handles refuse public kind clones, copied DTOs and reentry over existing originals', () => withV3Fixture(async f => {
  const source = await captureAssetOriginal(f), handle = await prepareCapsule2ManagedAssetOriginals(source.original), value = await readPreparedCapsule2ManagedAssetOriginals(handle)
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals({ ...handle }))
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals(value as unknown as PreparedCapsule2ManagedAssetOriginals))
  await assert.rejects(prepareCapsule2ManagedAssetOriginals(source.original), /重入|覆盖/)
  assert.equal(Object.isFrozen(value.manifest.directories), true); assert.equal(Object.isFrozen(value.manifest.knownAliases), true)
}))

test('capsule2 complete managed data freshly rejects same-length blob tampering and extra saved files', () => withV3Fixture(async f => {
  const bytes = Buffer.from('saved managed data'); await f.assets.import([{ name: 'tamper.bin', bytes }])
  const source = await captureAssetOriginal(f), handle = await prepareCapsule2ManagedAssetOriginals(source.original), value = await readPreparedCapsule2ManagedAssetOriginals(handle)
  const path = join(value.directory, 'files', value.manifest.files[0].hash), changed = Buffer.from(bytes); changed[0] ^= 1
  await writeFile(path, changed); await assert.rejects(readPreparedCapsule2ManagedAssetOriginals(handle))
  await writeFile(path, bytes); await writeFile(join(value.directory, 'files', 'unexpected'), 'extra')
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals(handle))
}))

test('capsule2 complete managed data refuses changed valid JSON manifest bytes', () => withV3Fixture(async f => {
  const source = await captureAssetOriginal(f), handle = await prepareCapsule2ManagedAssetOriginals(source.original), value = await readPreparedCapsule2ManagedAssetOriginals(handle)
  const path = join(value.directory, 'manifest.json'), original = await readFile(path, 'utf8')
  await writeFile(path, original.replace('all-managed-files-only', 'ALL-managed-files-only'))
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals(handle))
}))

test('capsule2 complete managed data refuses a later hardlink on its saved independent copy', () => withV3Fixture(async f => {
  await f.assets.import([{ name: 'later-link.bin', bytes: Buffer.from('actual independent copy') }])
  const source = await captureAssetOriginal(f), handle = await prepareCapsule2ManagedAssetOriginals(source.original), value = await readPreparedCapsule2ManagedAssetOriginals(handle)
  await link(join(value.directory, 'files', value.manifest.files[0].hash), join(f.userDataRoot, 'unexpected-saved-hardlink'))
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals(handle))
}))

test('capsule2 complete managed data remains bound to the actual known-original artifact rather than only a copied hash', () => withV3Fixture(async f => {
  const source = await captureAssetOriginal(f), handle = await prepareCapsule2ManagedAssetOriginals(source.original)
  const path = join(source.knownOutput, 'manifest.json'), original = await readFile(path, 'utf8')
  await writeFile(path, original.replace('known-markdown-files-only', 'KNOWN-markdown-files-only'))
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals(handle))
}))

test('capsule2 complete managed data freshly rechecks immutable original SQL inventory', () => withV3Fixture(async f => {
  const source = await captureAssetOriginal(f), handle = await prepareCapsule2ManagedAssetOriginals(source.original)
  await writeFile(join(source.info.originalDirectory, 'knowbook.db'), 'changed actual source SQL')
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals(handle))
}))

test('capsule2 complete managed preparation refuses unknown live layout and preserves partial output without retry or overwrite', () => withV3Fixture(async f => {
  await mkdir(f.assets.root, { recursive: true }); const unknown = join(f.assets.root, 'unknown-file')
  await writeFile(unknown, 'unknown actual bytes')
  const source = await captureAssetOriginal(f), before = allTables(f.db)
  await assert.rejects(prepareCapsule2ManagedAssetOriginals(source.original), /未知布局/)
  await assert.rejects(readFile(join(source.output, 'manifest.json')))
  assert.deepEqual(await readdir(join(source.output, 'files')), [])
  await unlink(unknown); await assert.rejects(prepareCapsule2ManagedAssetOriginals(source.original), /重入|覆盖/)
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 complete managed preparation rejects actual storage ancestor junctions even with zero known Markdown references', () => withV3Fixture(async f => {
  await f.assets.import([{ name: 'opaque-only.bin', bytes: Buffer.from('must not follow storage junction') }])
  const source = await captureAssetOriginal(f); f.close()
  const owned = await realpath(f.root), storage = await realpath(join(f.userDataRoot, 'storage')), foreign = join(owned, 'outside-profile-storage')
  for (const path of [storage, foreign]) { const child = relative(owned, path); assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)) }
  await rename(storage, foreign); await symlink(foreign, storage, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareCapsule2ManagedAssetOriginals(source.original), /symlink|junction/)
  await assert.rejects(readFile(join(source.output, 'manifest.json')))
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 complete managed preparation detects damaged unreferenced source bytes instead of omitting the file', () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: 'damaged-orphan.bin', bytes: Buffer.from('actual unreferenced source') }])
  await writeFile(f.assets.resolve(asset.url), 'damaged source')
  const source = await captureAssetOriginal(f), before = allTables(f.db)
  await assert.rejects(prepareCapsule2ManagedAssetOriginals(source.original), /managed hash|附件原路径/)
  await assert.rejects(readFile(join(source.output, 'manifest.json')))
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 complete managed preparation bounds oversized unreferenced files before reading or copying them', () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: 'oversized-orphan.bin', bytes: Buffer.alloc(0) }])
  await truncate(f.assets.resolve(asset.url), ATTACHMENT_MAX_FILE_BYTES + 1)
  const source = await captureAssetOriginal(f)
  await assert.rejects(prepareCapsule2ManagedAssetOriginals(source.original), /25MiB/)
  assert.deepEqual(await readdir(join(source.output, 'files')), [])
  await assert.rejects(readFile(join(source.output, 'manifest.json')))
}))

test('capsule2 managed capture does not follow opaque foreign policy paths or turn them into managed file authority', () => withV3Fixture(async f => {
  const foreign = join(f.root, 'foreign-policy-file'), bytes = Buffer.from('actual foreign policy data')
  await writeFile(foreign, bytes); const literal = JSON.stringify({ file: pathToFileURL(foreign).href })
  f.store.saveSetting('actual.foreign.opaque', literal)
  const source = await captureAssetOriginal(f), before = allTables(f.db)
  const value = await readPreparedCapsule2ManagedAssetOriginals(await prepareCapsule2ManagedAssetOriginals(source.original))
  assert.deepEqual(value.manifest.aliases, []); assert.equal(value.manifest.certified, false); assert.equal(value.manifest.semanticValidationComplete, false)
  assert.deepEqual(await readFile(foreign), bytes); assert.deepEqual(allTables(f.db), before)
}))

test('capsule2 complete managed capture preserves actual native Windows short URIs held only in opaque settings', { skip: process.platform !== 'win32' }, t => withV3Fixture(async f => {
  const profile = await realpath(f.userDataRoot), shortRoot = windowsShortPath(profile)
  if (shortRoot.toLowerCase() === profile.toLowerCase()) { t.skip('No distinct native 8.3 profile alias on this volume'); return }
  const store = new AttachmentStore(join(shortRoot, 'storage', 'assets')), bytes = Buffer.from('actual opaque short-root import')
  const [asset] = await store.import([{ name: 'short-setting.png', bytes }])
  assert.notEqual(fileURLToPath(asset.url).toLowerCase(), (await realpath(fileURLToPath(asset.url))).toLowerCase())
  const literal = JSON.stringify({ image: asset.url }); f.store.saveSetting('actual.short.opaque', literal)
  const source = await captureAssetOriginal(f), value = await readPreparedCapsule2ManagedAssetOriginals(await prepareCapsule2ManagedAssetOriginals(source.original))
  assert.deepEqual(value.manifest.knownAliases, []); assert.equal(value.manifest.aliases.length, 1)
  assert.deepEqual(await readFile(join(value.directory, 'files', value.manifest.files[0].hash)), bytes)
  assert.equal(f.store.getSettingPublic('actual.short.opaque'), literal)
}))
