import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs, writeFileSync, lstatSync, existsSync, unlinkSync, renameSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, sep } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { ATTACHMENT_MAX_FILE_BYTES } from '../src/shared/attachments'
import { buildSyncedPortableAssetUri } from '../src/shared/syncedBlockPortable'
import { readManagedAssetSource, readManagedAssetSourceSync } from '../src/main/managed-asset-source'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { withIncomingFixture, accepted } from './helpers/synced-initial-incoming-fixture'
import { withPublicationFixture, a, bodyId, created, applySyncedHostCommand, createRequest,
  prepareInitialSyncedPublication, rejectedCode, allTables } from './helpers/synced-publication-fixture'

test('actual publication refuses a source that grows after preflight without reading beyond the original checked size', t => withPublicationFixture(async f => {
  const [asset] = await f.assets.import([{ name: 'actual-growing-source.png', bytes: Buffer.from('original source') }])
  f.db.prepare('UPDATE blocks SET content=? WHERE id=?').run('![actual](<' + asset.url + '>)', bodyId(a))
  created(applySyncedHostCommand(f.db, createRequest(f.db)))
  const path = f.assets.resolve(asset.url), checkedSize = lstatSync(path).size, before = allTables(f.db), input = f.input()
  const readFile = fs.readFile, open = fs.open
  let grew = false, observedReadBytes = 0
  const grow = (value: unknown) => {
    if (String(value) === path && !grew) { grew = true; writeFileSync(path, Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES + 1024)) }
  }
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    grow(args[0]); const value = await readFile(...args)
    if (String(args[0]) === path) observedReadBytes += value.length
    return value
  })
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    grow(args[0]); const handle = await open(...args)
    if (String(args[0]) === path) {
      const read = handle.read
      t.mock.method(handle, 'read', async (...input: unknown[]) => {
        const result = await Reflect.apply(read, handle, input)
        observedReadBytes += result.bytesRead; return result
      })
    }
    return handle
  })
  syncBuiltinESMExports()
  try {
    await rejectedCode(() => f.track(prepareInitialSyncedPublication(f.db, input)), 'asset')
    assert.equal(grew, true, 'The real file grows at the native I/O boundary after the actual Main preflight')
    assert.deepEqual(allTables(f.db), before); assert.equal(existsSync(f.spool(input.attemptId)), false)
    assert.equal(f.server.requests.length, 0)
    assert.ok(observedReadBytes <= checkedSize + 1, `Native source read ${observedReadBytes} bytes after checking only ${checkedSize}`)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function both(root: string, uri: string, bytes: Buffer) {
  const sync = readManagedAssetSourceSync(root, uri), async = await readManagedAssetSource(root, uri)
  assert.deepEqual(async, sync); assert.deepEqual(sync.bytes, bytes); assert.equal(sync.hash, hash(bytes)); assert.equal(sync.uri, uri)
}
async function rejected(root: string, uri: string) {
  assert.throws(() => readManagedAssetSourceSync(root, uri))
  await assert.rejects(readManagedAssetSource(root, uri))
}

test('managed source sync and async readers preserve genuine imported Unicode and punctuation aliases in local and portable spellings', () => withV3Fixture(async f => {
  const bytes = Buffer.from('actual imported image 😀'), [asset] = await f.assets.import([{ name: "图片 !'() 😀.png", bytes }])
  await both(f.assets.root, asset.url, bytes)
  await both(f.assets.root, buildSyncedPortableAssetUri({ hash: hash(bytes), name: asset.name }), bytes)
}))

test('managed source readers preserve a real zero byte import instead of treating it as missing', () => withV3Fixture(async f => {
  const bytes = Buffer.alloc(0), [asset] = await f.assets.import([{ name: 'actual-empty.txt', bytes }])
  await both(f.assets.root, asset.url, bytes)
}))

test('managed source readers retain the original exact25MiB Main import boundary and reject an actual oversized source before allocation', () => withV3Fixture(async f => {
  const bytes = Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES), [asset] = await f.assets.import([{ name: 'actual-boundary.bin', bytes }])
  await both(f.assets.root, asset.url, bytes)
  writeFileSync(f.assets.resolve(asset.url), Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES + 1))
  await rejected(f.assets.root, asset.url)
}))

test('managed source readers hash every actual same-content alias without trusting another name cache', () => withV3Fixture(async f => {
  const bytes = Buffer.from('same actual content'), [a,b] = await f.assets.import([{ name: 'actual-first.png', bytes }, { name: 'actual-second.png', bytes }])
  await both(f.assets.root, a.url, bytes); await both(f.assets.root, b.url, bytes)
  writeFileSync(f.assets.resolve(b.url), 'damaged actual second alias')
  await rejected(f.assets.root, b.url); await both(f.assets.root, a.url, bytes)
}))

test('managed source readers preserve actual Main incoming hardlink aliases and retained stage semantics', () => withIncomingFixture(async f => {
  await f.publish(); accepted(await f.receive())
  const root = join(f.B.root, 'storage', 'assets')
  for (const alias of f.aliases) {
    const uri = buildSyncedPortableAssetUri({ hash: hash(alias.bytes), name: alias.name })
    const actual = readManagedAssetSourceSync(root, uri)
    assert.ok(lstatSync(actual.path).nlink >= 2, 'The real incoming Main writer publishes multiple names from the same actual staged inode')
    await both(root, uri, alias.bytes)
  }
}, { assets: true }))

test('managed source readers reject actual outside-root and noncanonical portable locations without granting a path interpretation', () => withV3Fixture(async f => {
  for (const uri of ['file:///outside/attachments/' + 'a'.repeat(64) + '/file.png', 'knowbook-asset://' + 'A'.repeat(64) + '/a.png',
    'knowbook-asset://' + 'a'.repeat(64) + '/%61.png', 'knowbook-asset://' + 'a'.repeat(64) + '/a.png?outside=1']) await rejected(f.assets.root, uri)
}))

test('managed source readers reject a genuine managed directory replaced by an outside-root junction', () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: 'actual-junction.png', bytes: Buffer.from('actual junction bytes') }])
  const path = f.assets.resolve(asset.url), outside = join(f.userDataRoot, 'outside-assets')
  assert.ok(path.startsWith(f.userDataRoot + sep)); assert.equal(dirname(outside), f.userDataRoot)
  renameSync(dirname(path), outside)
  symlinkSync(outside, dirname(path), process.platform === 'win32' ? 'junction' : 'dir')
  await rejected(f.assets.root, asset.url)
}))

test('managed async source rejects a real same-byte path replacement between preflight and descriptor completion', () => withV3Fixture(async f => {
  const bytes = Buffer.from('actual stable bytes'), [asset] = await f.assets.import([{ name: 'actual-replaced.png', bytes }])
  const path = f.assets.resolve(asset.url), promise = readManagedAssetSource(f.assets.root, asset.url)
  unlinkSync(path); writeFileSync(path, bytes)
  await assert.rejects(promise)
}))
