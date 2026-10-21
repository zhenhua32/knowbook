import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, realpath, rename, symlink, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { exportPreparedOriginBundle, importPreparedOriginBundle, readPreparedOriginBundle } from '../src/main/database/restore-knowledge-origin-bundle-read'
import { originBundleExpectedDirectories, originBundleExpectedFiles } from '../src/main/database/restore-knowledge-origin-bundle-model'
import { extractRequiredRootKnowledgeMaterial } from '../src/main/database/restore-knowledge-required-dag-read'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'
import { createV3Fixture, withV3Fixture } from './helpers/synced-backup-v3-fixture'

const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}
async function existingOwned(path: string, fixtureRoot: string, leafLink = false): Promise<void> {
  assert.ok(isAbsolute(path) && samePath(resolve(path), path) && (samePath(fixtureRoot, path) || inside(fixtureRoot, path)))
  let current = parse(path).root
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current), leaf = samePath(current, path), actual = await realpath(current)
    if (leaf && leafLink) { assert.equal(info.isSymbolicLink(), true); assert.ok(inside(fixtureRoot, actual)) }
    else { assert.equal(info.isSymbolicLink(), false); assert.ok(samePath(actual, current)) }
    if (!leaf) assert.equal(info.isDirectory(), true)
  }
}
async function unusedOwned(path: string, fixtureRoot: string): Promise<void> {
  assert.ok(isAbsolute(path) && samePath(resolve(path), path) && inside(fixtureRoot, path))
  await existingOwned(dirname(path), fixtureRoot)
  await assert.rejects(lstat(path), { code: 'ENOENT' })
}
async function withRealExport(run: (value: {
  fixtureRoot: string; exported: Awaited<ReturnType<typeof exportPreparedOriginBundle>>
  receiver: ReturnType<typeof createV3Fixture>; operationId: string
}) => Promise<void>) {
  return withV3Fixture(async f => {
    const pair = await actualRequiredDagPair(f), exported = await exportPreparedOriginBundle(await extractRequiredRootKnowledgeMaterial(pair.dag),
      { operationId: randomUUID(), bundleId: randomUUID() })
    const fixtureRoot = await realpath(f.root), receiver = createV3Fixture(join(fixtureRoot, 'origin-bundle-files-receiver'))
    try { await run({ fixtureRoot, exported, receiver, operationId: randomUUID() }) }
    finally { receiver.close() }
  })
}
async function allCatalogBytes(exported: Awaited<ReturnType<typeof exportPreparedOriginBundle>>) {
  const paths = ['descriptor.json', ...originBundleExpectedFiles(exported.descriptor).map(file => file.path)].sort()
  return Promise.all(paths.map(async path => ({ path, bytes: await readFile(join(exported.directory, ...path.split('/'))) })))
}
async function assertRealTwoLinks(original: string, alias: string): Promise<void> {
  const left = await open(original, 'r')
  try {
    const right = await open(alias, 'r')
    try {
      const a = await left.stat({ bigint: true }), b = await right.stat({ bigint: true })
      assert.equal(a.isFile(), true); assert.equal(b.isFile(), true)
      assert.equal(a.nlink, 2n); assert.equal(b.nlink, 2n)
      assert.notEqual(a.ino, 0n); assert.equal(a.ino, b.ino); assert.equal(a.dev, b.dev)
      if (process.platform === 'win32') assert.notEqual(a.dev, 0n, 'Both simultaneous real FDs have a usable exact volume identity')
    } finally { await right.close() }
  } finally { await left.close() }
}

test('real origin bundle import rejects a second hardlink outside its catalog without changing bytes and accepts the same catalog after exact alias removal', () => withRealExport(async f => {
  const file = originBundleExpectedFiles(f.exported.descriptor).find(row => row.path.endsWith('/original/knowbook.db'))!
  const original = join(f.exported.directory, ...file.path.split('/')), alias = join(f.fixtureRoot, 'origin-bundle-hardlink-alias-' + randomUUID() + '.db')
  await existingOwned(original, f.fixtureRoot); await unusedOwned(alias, f.fixtureRoot)
  assert.ok(!inside(f.exported.directory, alias) && !samePath(f.exported.directory, alias))
  const before = await allCatalogBytes(f.exported), originalBytes = await readFile(original), identity = await lstat(original, { bigint: true })
  assert.equal(identity.nlink, 1n); assert.notEqual(identity.ino, 0n)
  const input = { profileRoot: f.receiver.userDataRoot, operationId: f.operationId, sourceDirectory: f.exported.directory }
  let created = false
  try {
    await link(original, alias); created = true
    await existingOwned(alias, f.fixtureRoot); await assertRealTwoLinks(original, alias)
    assert.deepEqual(await readFile(alias), originalBytes); assert.deepEqual(await allCatalogBytes(f.exported), before)
    await assert.rejects(importPreparedOriginBundle(input), /独立|普通原件|nlink/)
    await assertRealTwoLinks(original, alias)
    assert.deepEqual(await readFile(alias), originalBytes, 'Rejection does not fix or remove the test-created alias')
    assert.deepEqual(await allCatalogBytes(f.exported), before, 'All source catalog bytes stay unchanged on rejection')
    const receiverRoot = await realpath(f.receiver.userDataRoot)
    await assert.rejects(lstat(join(receiverRoot, 'backups', 'database-restore', f.operationId)), { code: 'ENOENT' })
  } finally {
    if (created) {
      await existingOwned(alias, f.fixtureRoot); await assertRealTwoLinks(original, alias)
      const info = await lstat(alias, { bigint: true })
      assert.equal(info.isSymbolicLink(), false); assert.equal(info.ino, identity.ino)
      await unlink(alias) // Exactly this task-created ordinary file alias; no recursive operation.
    }
  }
  await assert.rejects(lstat(alias), { code: 'ENOENT' }); assert.equal((await lstat(original, { bigint: true })).nlink, 1n)
  assert.deepEqual(await allCatalogBytes(f.exported), before)
  const actual = await readPreparedOriginBundle(await importPreparedOriginBundle(input))
  assert.equal(actual.descriptorHash, f.exported.descriptorHash); assert.equal(actual.root.namespace.kind, 'imported-bundle')
  assert.ok(actual.groups > 0); assert.equal(actual.acceptedCoverage, false); assert.equal(actual.effectivePermit, false)
  assert.deepEqual(await allCatalogBytes(f.exported), before, 'The same actual restored catalog completes real SQL/typed certification')
}))

test('real origin bundle import rejects an unchanged index-directory redirect and accepts the same catalog after exact junction removal and directory restoration', () => withRealExport(async f => {
  const relativeIndex = originBundleExpectedDirectories(f.exported.descriptor).find(path => path.endsWith('/index'))!
  const original = join(f.exported.directory, ...relativeIndex.split('/')), moved = join(f.fixtureRoot, 'origin-bundle-moved-index-' + randomUUID())
  await existingOwned(original, f.fixtureRoot); await unusedOwned(moved, f.fixtureRoot)
  assert.ok(!inside(f.exported.directory, moved) && !samePath(f.exported.directory, moved))
  const before = await allCatalogBytes(f.exported), identity = await lstat(original, { bigint: true })
  assert.equal(identity.isDirectory(), true); assert.notEqual(identity.ino, 0n)
  const input = { profileRoot: f.receiver.userDataRoot, operationId: f.operationId, sourceDirectory: f.exported.directory }
  let movedDirectory = false, createdLink = false
  try {
    await rename(original, moved); movedDirectory = true
    await existingOwned(moved, f.fixtureRoot); await unusedOwned(original, f.fixtureRoot)
    await symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir'); createdLink = true
    await existingOwned(original, f.fixtureRoot, true)
    assert.ok(samePath(await realpath(original), moved)); assert.equal((await lstat(original)).isSymbolicLink(), true)
    assert.equal((await lstat(moved, { bigint: true })).ino, identity.ino)
    assert.deepEqual(await allCatalogBytes(f.exported), before, 'The redirected path still reaches every original catalog byte')
    await assert.rejects(importPreparedOriginBundle(input), /额外|错类型|目录|symlink|junction|重定向/)
    assert.equal((await lstat(original)).isSymbolicLink(), true, 'Rejection preserves the bad junction until exact test-owned restoration')
    assert.ok(samePath(await realpath(original), moved)); assert.deepEqual(await allCatalogBytes(f.exported), before)
    const receiverRoot = await realpath(f.receiver.userDataRoot)
    await assert.rejects(lstat(join(receiverRoot, 'backups', 'database-restore', f.operationId)), { code: 'ENOENT' })
  } finally {
    if (createdLink) {
      await existingOwned(original, f.fixtureRoot, true); assert.ok(samePath(await realpath(original), moved))
      await unlink(original) // Removes only the actual junction/symlink itself, never its target.
    }
    if (movedDirectory) {
      await unusedOwned(original, f.fixtureRoot); await existingOwned(moved, f.fixtureRoot)
      const info = await lstat(moved, { bigint: true })
      assert.equal(info.isDirectory(), true); assert.equal(info.isSymbolicLink(), false); assert.equal(info.ino, identity.ino); assert.equal(info.dev, identity.dev)
      await rename(moved, original) // Both exact resolved endpoints are inside this task fixture.
    }
  }
  await existingOwned(original, f.fixtureRoot); assert.equal((await lstat(original)).isSymbolicLink(), false)
  await assert.rejects(lstat(moved), { code: 'ENOENT' }); assert.deepEqual(await allCatalogBytes(f.exported), before)
  const actual = await readPreparedOriginBundle(await importPreparedOriginBundle(input))
  assert.equal(actual.descriptorHash, f.exported.descriptorHash); assert.equal(actual.root.namespace.kind, 'imported-bundle')
  assert.ok(actual.groups > 0); assert.equal(actual.acceptedCoverage, false); assert.equal(actual.effectivePermit, false)
  assert.deepEqual(await allCatalogBytes(f.exported), before, 'Restored ordinary directories complete the real same-catalog SQL/typed import')
}))
