import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { link, lstat, readFile, readdir, truncate, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { reopenPreparedRawCapsuleOriginal, readOwnedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { reopenCapsule2KnownAssetOriginals, readPreparedCapsule2KnownAssetOriginals } from '../src/main/database/restore-knowledge-capsule2-assets-files'
import {
  prepareCapsule2ManagedAssetOriginals, readPreparedCapsule2ManagedAssetOriginals, reopenCapsule2ManagedAssetOriginals,
  type PreparedCapsule2ManagedAssetOriginals
} from '../src/main/database/restore-knowledge-capsule2-managed-assets-files'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { addV3Assets, allTables, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'

const runFile = promisify(execFile)
type Source = Awaited<ReturnType<typeof captureAssetOriginal>>
const locator = (source: Source) => ({  
profileRoot: source.info.profileRoot, operationId: basename(source.info.recoveryDirectory),
  capsuleId: basename(source.info.capsuleDirectory), expectedInventory: source.inventory
})
const reopenRaw = (source: Source) => reopenPreparedRawCapsuleOriginal(locator(source))
const manifestHash = (kind: 'known' | 'managed', value: unknown) => capsuleBytesHash(`knowbook.capsule2.${kind === 'known' ? 'known-managed' : 'managed'}-asset-originals.v1\0` + capsuleJson(value))
async function saved(f: Parameters<Parameters<typeof withV3Fixture>[0]>[0], assets = true) {
  if (assets) await addV3Assets(f)
  const source = await captureAssetOriginal(f), handle = await prepareCapsule2ManagedAssetOriginals(source.original)
  return { source, handle, value: await readPreparedCapsule2ManagedAssetOriginals(handle) }
}

test('capsule2 prepared restart rereads complete original SQL and both saved file artifacts without legacy v1 sealing', () => withV3Fixture(async f => {
  const { source, value } = await saved(f), before = allTables(f.db)
  assert.deepEqual((await readdir(source.info.capsuleDirectory)).sort(), ['original', 'scratch'])
  const original = await reopenRaw(source), known = await reopenCapsule2KnownAssetOriginals(original, value.manifest.knownAssetManifestHash)
  assert.deepEqual((await readPreparedCapsule2KnownAssetOriginals(known)).manifest.aliases, value.manifest.knownAliases)
  const original2 = await reopenRaw(source), handle = await reopenCapsule2ManagedAssetOriginals(original2, value.manifestHash)
  assert.deepEqual(await readPreparedCapsule2ManagedAssetOriginals(handle), value)
  assert.notEqual(readOwnedRawCapsuleOriginal(original2).scratchDirectory, source.info.scratchDirectory)
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals({ ...handle }), /不是实际Main准备的管理文件句柄/)
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 actual independent Electron Node restart survives vanished live assets and poisoned old scratch', () => withV3Fixture(async f => {
  const { source, value } = await saved(f)
  for (const alias of value.manifest.aliases) await unlink(join(f.assets.root, alias.relativePath))
  await writeFile(source.info.databasePath, 'old scratch must never be reopened')
  const { stdout } = await runFile(process.execPath, ['--import', 'tsx', resolve('tests/helpers/capsule2-assets-reopen-process.cjs'),
    JSON.stringify({ original: locator(source), manifestHash: value.manifestHash })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })
  const result = JSON.parse(stdout)
  assert.notEqual(result.pid, process.pid); assert.notEqual(result.info.scratchDirectory, source.info.scratchDirectory)
  assert.deepEqual(result.value, value); assert.equal(result.value.manifest.certified, false); assert.equal(result.value.manifest.semanticValidationComplete, false); assert.equal(result.value.manifest.permit, false)
  for (const alias of value.manifest.aliases) await assert.rejects(lstat(join(f.assets.root, alias.relativePath)), { code: 'ENOENT' })
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 prepared restart preserves a missing managed root without manufacturing files or empty knowledge', () => withV3Fixture(async f => {
  const { source, value } = await saved(f, false), before = allTables(f.db)
  assert.equal(value.manifest.rootPresent, false)
  const reopened = await readPreparedCapsule2ManagedAssetOriginals(await reopenCapsule2ManagedAssetOriginals(await reopenRaw(source), value.manifestHash))
  assert.deepEqual(reopened, value); assert.deepEqual(allTables(f.db), before)
  await assert.rejects(lstat(f.assets.root), { code: 'ENOENT' })
}))

test('capsule2 prepared restart rejects a wrong owning commitment and cannot retry the same failed original', () => withV3Fixture(async f => {
  const { source, value } = await saved(f), original = await reopenRaw(source)
  await assert.rejects(reopenCapsule2ManagedAssetOriginals(original, '0'.repeat(64)), /owning root给出的hash不符/)
  await assert.rejects(reopenCapsule2ManagedAssetOriginals(original, value.manifestHash), /重入|已准备|失败/)
  assert.deepEqual(await readPreparedCapsule2ManagedAssetOriginals(await reopenCapsule2ManagedAssetOriginals(await reopenRaw(source), value.manifestHash)), value)
}))

test('capsule2 prepared restart authenticates original DB bytes before creating a fresh scratch', () => withV3Fixture(async f => {
  const { source } = await saved(f)
  await writeFile(join(source.info.originalDirectory, 'knowbook.db'), 'replaced original')
  await assert.rejects(reopenRaw(source), /改变|清单|bytes|不符/)
  await assert.rejects(lstat(join(source.info.recoveryDirectory, 'knowledge-capsule-reads')), { code: 'ENOENT' })
}))

test('capsule2 prepared restart does not accept a rehashed false known source even when the outer manifest agrees', () => withV3Fixture(async f => {
  const { source, value } = await saved(f), knownPath = join(source.knownOutput, 'manifest.json'), managedPath = join(source.output, 'manifest.json')
  const known = JSON.parse(await readFile(knownPath, 'utf8')); known.sourceContentHash = '0'.repeat(64)
  await writeFile(knownPath, capsuleJson(known) + '\n')
  const managed = { ...value.manifest, sourceContentHash: known.sourceContentHash, knownAssetManifestHash: manifestHash('known', known) }
  await writeFile(managedPath, capsuleJson(managed) + '\n')
  await assert.rejects(reopenCapsule2ManagedAssetOriginals(await reopenRaw(source), manifestHash('managed', managed)), /实际原SQL|完整实际|来源/)
}))

test('capsule2 prepared restart binds the complete managed manifest back to the actual known source', () => withV3Fixture(async f => {
  const { source, value } = await saved(f), managed = { ...value.manifest, sourceContentHash: '0'.repeat(64) }
  await writeFile(join(source.output, 'manifest.json'), capsuleJson(managed) + '\n')
  await assert.rejects(reopenCapsule2ManagedAssetOriginals(await reopenRaw(source), manifestHash('managed', managed)), /实际来源/)
}))

for (const variant of ['extra-field', 'authority-flag', 'duplicate-alias', 'missing-parent', 'missing-blob', 'entry-budget'] as const) {
  test(`capsule2 prepared restart rejects rehashed ${variant} in the saved managed artifact`, () => withV3Fixture(async f => {
    const { source, value } = await saved(f), managed = JSON.parse(capsuleJson(value.manifest))
    if (variant === 'extra-field') managed.callerPermit = true
    if (variant === 'authority-flag') managed.certified = true
    if (variant === 'duplicate-alias') managed.aliases.push(managed.aliases[0])
    if (variant === 'missing-parent') managed.directories = managed.directories.filter((value: string) => value !== 'attachments')
    if (variant === 'missing-blob') managed.files = []
    if (variant === 'entry-budget') {
      const directories = new Set<string>([...managed.directories, 'attachments/00'])
      for (let index = 0; directories.size < 20_000; index++)directories.add('attachments/00/' + index.toString(16).padStart(64, '0'))
      managed.directories = [...directories].sort()
    }
    await writeFile(join(source.output, 'manifest.json'), capsuleJson(managed) + '\n')
    await assert.rejects(reopenCapsule2ManagedAssetOriginals(await reopenRaw(source), manifestHash('managed', managed)))
  }))
}

test('capsule2 prepared restart rejects oversized and malformed UTF8 manifests through bounded file reads', () => withV3Fixture(async f => {
  const { source, value } = await saved(f), path = join(source.output, 'manifest.json'), bytes = await readFile(path)
  await truncate(path, CAPSULE2_RAW_MAX_JSON_BYTES + 1)
  await assert.rejects(reopenCapsule2ManagedAssetOriginals(await reopenRaw(source), value.manifestHash), /预算|文件/)
  await writeFile(path, Buffer.from([0xff, 0xfe, 0x80]))
  await assert.rejects(reopenCapsule2ManagedAssetOriginals(await reopenRaw(source), value.manifestHash), /encoded|encoding|UTF|无效|invalid/i)
  await writeFile(path, bytes)
}))

test('capsule2 prepared restart rejects hardlinked archived manifests and every later consume rereads blob bytes', () => withV3Fixture(async f => {
  const { source, value } = await saved(f), path = join(source.output, 'manifest.json'), alias = join(source.info.profileRoot, 'hardlinked-managed-manifest.json')
  await link(path, alias)
  await assert.rejects(reopenCapsule2ManagedAssetOriginals(await reopenRaw(source), value.manifestHash), /独立|文件/)
  await unlink(alias)
  const handle = await reopenCapsule2ManagedAssetOriginals(await reopenRaw(source), value.manifestHash)
  await writeFile(join(value.directory, 'files', value.manifest.files[0].hash), 'changed archived content')
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals(handle), /hash|准确|文件|长度|字节/)
}))

test('capsule2 prepared restart rejects unknown original namespace entries and a cloned prepared identity', () => withV3Fixture(async f => {
  const { source, handle } = await saved(f)
  await assert.rejects(readPreparedCapsule2ManagedAssetOriginals(JSON.parse(JSON.stringify(handle)) as PreparedCapsule2ManagedAssetOriginals), /实际Main|句柄|不是/)
  await writeFile(join(source.info.capsuleDirectory, 'caller-root.json'), '{}')
  await assert.rejects(reopenRaw(source), /未知|pending/)
}))
