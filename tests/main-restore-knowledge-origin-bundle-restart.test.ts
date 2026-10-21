import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportPreparedOriginBundle, importPreparedOriginBundle, readPreparedOriginBundle } from '../src/main/database/restore-knowledge-origin-bundle-read'
import { originBundleExpectedFiles } from '../src/main/database/restore-knowledge-origin-bundle-model'
import { extractRequiredRootKnowledgeMaterial } from '../src/main/database/restore-knowledge-required-dag-read'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'
import { createV3Fixture, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import type { OriginBundleChildResult } from './helpers/origin-bundle-reopen-process'

const execute = promisify(execFile), worker = fileURLToPath(new URL('./helpers/origin-bundle-reopen-process.ts', import.meta.url))
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const inside = (root: string, target: string): boolean => {
  const child = relative(root, target)
  return child !== '' && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

/** Only the exact verification-profiles collection created by this test's own
 * newly imported mount. It cannot be pointed at a catalog/source/user profile. */
async function removeOldVerificationProfiles(fixtureInput: string, receiverInput: string,
  mounted: Awaited<ReturnType<typeof readPreparedOriginBundle>>): Promise<{ directory: string; profileIds: readonly string[] }> {
  const fixture = await realpath(fixtureInput), temp = await realpath(tmpdir()), receiver = await realpath(receiverInput)
  assert.ok(samePath(dirname(fixture), temp) && basename(fixture).startsWith('knowbook-v3-backup-'))
  assert.ok(samePath(receiver, join(fixture, 'origin-bundle-child-receiver', 'profile')))
  assert.ok(samePath(mounted.profileRoot, receiver) && canonicalUuid.test(mounted.operationId) && canonicalUuid.test(mounted.mountId))
  const mount = join(receiver, 'backups', 'database-restore', mounted.operationId, 'origin-bundle-mounts', mounted.mountId)
  assert.ok(samePath(mounted.originalDirectory, join(mount, 'original')))
  const target = join(mount, 'verification-profiles'), absolute = resolve(target)
  assert.ok(isAbsolute(target) && samePath(absolute, target) && inside(receiver, absolute) && inside(fixture, absolute))
  assert.equal(basename(absolute), 'verification-profiles')
  assert.ok(!samePath(absolute, mounted.originalDirectory) && !inside(absolute, mounted.originalDirectory))
  async function ancestors(): Promise<void> {
    let current = parse(absolute).root
    for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
      current = join(current, part)
      const info = await lstat(current)
      assert.equal(info.isSymbolicLink(), false, 'No symlink/junction ancestor is removed')
      assert.equal(info.isDirectory(), true)
      assert.ok(samePath(await realpath(current), current), 'Every ancestor stays at its exact physical path')
    }
  }
  async function closedOwnedTree(path: string): Promise<void> {
    assert.ok(samePath(path, absolute) || inside(absolute, path))
    const info = await lstat(path)
    assert.equal(info.isSymbolicLink(), false, 'Disposable copies cannot redirect deletion outside the owned collection')
    assert.ok(samePath(await realpath(path), path))
    if (info.isDirectory()) for (const name of await readdir(path)) await closedOwnedTree(join(path, name))
    else { assert.equal(info.isFile(), true); assert.equal(info.nlink, 1, 'Only independent task-created disposable files are removed') }
  }
  await ancestors()
  const profileIds = (await readdir(absolute)).sort()
  assert.ok(profileIds.length > 0 && profileIds.every(id => canonicalUuid.test(id)), 'The import actually created independent verification profiles')
  for (const id of profileIds) assert.equal((await lstat(join(absolute, id))).isDirectory(), true)
  await closedOwnedTree(absolute); await ancestors()
  // One explicitly checked absolute target; no extension scan, other mount,
  // immutable catalog, sealed original, receiver Store or recursive parent.
  await rm(absolute, { recursive: true })
  await assert.rejects(lstat(absolute), { code: 'ENOENT' })
  return { directory: absolute, profileIds }
}

test('real origin bundle child restart recertifies its immutable catalog after old verification profiles are removed and keeps original and qualified refs', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), material = await extractRequiredRootKnowledgeMaterial(pair.dag)
  const exported = await exportPreparedOriginBundle(material, { operationId: randomUUID(), bundleId: randomUUID() })
  const receiver = createV3Fixture(join(f.root, 'origin-bundle-child-receiver'))
  try {
    const handle = await importPreparedOriginBundle({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory })
    const value = await readPreparedOriginBundle(handle), paths = ['descriptor.json', ...originBundleExpectedFiles(exported.descriptor).map(file => file.path)].sort()
    const catalogBytes = () => Promise.all(paths.map(async path => ({ path, bytes: await readFile(join(value.originalDirectory, ...path.split('/'))) })))
    const before = await catalogBytes(), old = await removeOldVerificationProfiles(f.root, receiver.userDataRoot, value)
    await assert.rejects(readPreparedOriginBundle(handle), /ENOENT|原件|目录|capsule/)
    assert.deepEqual(await catalogBytes(), before, 'Dropping disposable verification copies does not touch mounted originals')
    const response = await execute(process.execPath, ['--import', 'tsx', worker, JSON.stringify({ profileRoot: value.profileRoot,
      operationId: value.operationId, mountId: value.mountId, expectedDescriptorHash: value.descriptorHash })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, maxBuffer: 1024 * 1024 })
    const child = JSON.parse(response.stdout) as OriginBundleChildResult
    assert.equal(child.kind, 'origin-bundle-real-process-reopen-result'); assert.notEqual(child.pid, process.pid)
    assert.equal(child.descriptorHash, value.descriptorHash); assert.deepEqual(child.originalRoot, value.originalRoot)
    assert.deepEqual(child.root, value.root); assert.deepEqual(child.capsules, value.capsules)
    assert.equal(child.root.namespace.kind, 'imported-bundle'); assert.equal(child.originalRoot.namespace.kind, 'native')
    assert.equal(child.groups, value.groups); assert.ok(child.groups > 0)
    assert.equal(child.preparedEvidence, true); assert.equal(child.acceptedCoverage, false)
    assert.equal(child.effectivePermit, false); assert.equal(child.fullNonemptyAncestorSupport, false); assert.equal(child.badHashRejected, true)
    assert.deepEqual(await catalogBytes(), before, 'Child SQL/typed recertification leaves every mounted descriptor/catalog byte unchanged')
    const freshIds = await readdir(old.directory)
    assert.ok(freshIds.length > 0 && freshIds.every(id => canonicalUuid.test(id) && !old.profileIds.includes(id)), 'The new process used fresh profiles, never old cached scratch')
    for (const id of old.profileIds) await assert.rejects(lstat(join(old.directory, id)), { code: 'ENOENT' })
    await assert.rejects(readPreparedOriginBundle(handle), /ENOENT|原件|目录|capsule/, 'The old process handle remains bound to its removed verification originals')
  } finally { receiver.close() }
}))
