import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { link, lstat, readFile, rename, symlink, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertRootKnowledgeArtifactsFreshNow } from '../src/main/database/restore-knowledge-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { prepareSyncWitnessPair, extractSyncWitnessMaterial, syncWitnessFailure } from './helpers/sync-witness-fixture'

function contained(profileRoot: string, path: string): void {
  const child = relative(resolve(profileRoot), resolve(path))
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child), 'The exact fixture path stays below its canonical profile')
}
function existingWithinProfile(path: string, profileRoot: string): void {
  const root = resolve(realpathSync.native(profileRoot))
  assert.ok(isAbsolute(path))
  contained(root, path)
  contained(root, realpathSync.native(path))
  contained(root, realpathSync.native(dirname(path)))
}
async function unusedWithinProfile(path: string, profileRoot: string): Promise<void> {
  const root = resolve(realpathSync.native(profileRoot))
  assert.ok(isAbsolute(path))
  contained(root, path)
  contained(root, realpathSync.native(dirname(path)))
  await assert.rejects(lstat(path), { code: 'ENOENT' })
}

test('synchronous prepared witness rejects a real second hardlink outside its closed capsule and preserves it until the test removes only that alias', () => withV3Fixture(async f => {
  const pair = await prepareSyncWitnessPair(f), material = await extractSyncWitnessMaterial(pair)
  const original = join(pair.current.info.originalDirectory, 'knowbook.db'), alias = join(pair.recoveryDirectory, 'test-only-hardlink-' + randomUUID() + '.db')
  existingWithinProfile(original, pair.profileRoot)
  await unusedWithinProfile(alias, pair.profileRoot)
  const bytes = await readFile(original), before = await lstat(original, { bigint: true })
  assert.equal(before.nlink, 1n)
  assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined)
  let created = false
  try {
    await link(original, alias); created = true
    existingWithinProfile(alias, pair.profileRoot)
    const actual = await lstat(original, { bigint: true }), linked = await lstat(alias, { bigint: true })
    assert.equal(actual.nlink, 2n); assert.equal(linked.nlink, 2n)
    assert.equal(actual.ino, linked.ino); assert.equal(actual.dev, linked.dev)
    assert.deepEqual(await readFile(original), bytes); assert.deepEqual(await readFile(alias), bytes)
    assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material), syncWitnessFailure)
    assert.equal((await lstat(alias, { bigint: true })).nlink, 2n, 'The witness preserved the real alias instead of fixing nlink')
    assert.deepEqual(await readFile(alias), bytes)
  } finally {
    if (created) {
      existingWithinProfile(alias, pair.profileRoot)
      const actual = await lstat(alias, { bigint: true })
      assert.equal(actual.isFile(), true); assert.equal(actual.isSymbolicLink(), false)
      assert.equal(actual.ino, before.ino)
      await unlink(alias) // Exact test-created alias only; no recursive cleanup.
    }
  }
  await assert.rejects(lstat(alias), { code: 'ENOENT' })
  assert.equal((await lstat(original, { bigint: true })).nlink, 1n)
  assert.deepEqual(await readFile(original), bytes)
  assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined, 'The original private material remains valid once the test removes its own extra hardlink')
}))

test('synchronous prepared witness refuses a real original-directory redirect with unchanged bytes and preserves the link until exact test-owned restoration', () => withV3Fixture(async f => {
  const pair = await prepareSyncWitnessPair(f), material = await extractSyncWitnessMaterial(pair)
  const original = pair.current.info.originalDirectory, moved = join(pair.recoveryDirectory, 'test-only-moved-original-' + randomUUID())
  existingWithinProfile(original, pair.profileRoot)
  await unusedWithinProfile(moved, pair.profileRoot)
  assert.equal((await lstat(original)).isSymbolicLink(), false)
  const bytes = await readFile(join(original, 'knowbook.db'))
  assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined)
  let movedOriginal = false, createdLink = false
  try {
    await rename(original, moved); movedOriginal = true
    existingWithinProfile(moved, pair.profileRoot)
    await unusedWithinProfile(original, pair.profileRoot)
    await symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir'); createdLink = true
    existingWithinProfile(original, pair.profileRoot)
    assert.equal((await lstat(original)).isSymbolicLink(), true, 'Windows uses a real junction; other platforms use a real directory symlink')
    assert.equal(resolve(realpathSync.native(original)), resolve(realpathSync.native(moved)))
    assert.deepEqual(await readFile(join(original, 'knowbook.db')), bytes, 'The path still reaches the complete original bytes')
    assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material), syncWitnessFailure)
    assert.equal((await lstat(original)).isSymbolicLink(), true, 'Rejection leaves the redirect in place')
    assert.deepEqual(await readFile(join(moved, 'knowbook.db')), bytes)
  } finally {
    if (createdLink) {
      existingWithinProfile(original, pair.profileRoot)
      assert.equal((await lstat(original)).isSymbolicLink(), true)
      assert.equal(resolve(realpathSync.native(original)), resolve(realpathSync.native(moved)))
      await unlink(original) // Removes the junction/symlink itself; never its target.
    }
    if (movedOriginal) {
      await unusedWithinProfile(original, pair.profileRoot)
      existingWithinProfile(moved, pair.profileRoot)
      const actual = await lstat(moved)
      assert.equal(actual.isDirectory(), true); assert.equal(actual.isSymbolicLink(), false)
      await rename(moved, original)
    }
  }
  existingWithinProfile(original, pair.profileRoot)
  assert.equal((await lstat(original)).isSymbolicLink(), false)
  await assert.rejects(lstat(moved), { code: 'ENOENT' })
  assert.deepEqual(await readFile(join(original, 'knowbook.db')), bytes)
  assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined, 'The same genuine material passes after the test removes only the link and restores the original directory')
}))
