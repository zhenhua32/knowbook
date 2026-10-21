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
import { prepareFirstImportedQualifiedKnowledge, readPreparedFirstImportedQualifiedKnowledge } from '../src/main/database/restore-knowledge-qualified-first-bundle-read'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'
import { createV3Fixture, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import type { QualifiedOwnerChildResult } from './helpers/qualified-owner-reopen-process'

const execute = promisify(execFile), worker = fileURLToPath(new URL('./helpers/qualified-owner-reopen-process.ts', import.meta.url))
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const inside = (root: string, target: string): boolean => {
  const child = relative(root, target)
  return child !== '' && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}
/** This new test's one disposable collection only, never any immutable catalog,
 * user profile or another mount. Every ancestor and descendant is checked. */
async function removeOwnVerificationProfiles(fixtureInput: string, receiverInput: string,
  mounted: Awaited<ReturnType<typeof readPreparedOriginBundle>>) {
  const fixture = await realpath(fixtureInput), temp = await realpath(tmpdir()), receiver = await realpath(receiverInput)
  assert.ok(samePath(dirname(fixture), temp) && basename(fixture).startsWith('knowbook-v3-backup-'))
  assert.ok(samePath(receiver, join(fixture, 'qualified-child-receiver', 'profile')))
  assert.ok(samePath(mounted.profileRoot, receiver) && canonicalUuid.test(mounted.operationId) && canonicalUuid.test(mounted.mountId))
  const mount = join(receiver, 'backups', 'database-restore', mounted.operationId, 'origin-bundle-mounts', mounted.mountId)
  assert.ok(samePath(mounted.originalDirectory, join(mount, 'original')))
  const target = join(mount, 'verification-profiles'), absolute = resolve(target)
  assert.ok(isAbsolute(target) && samePath(absolute, target) && inside(receiver, absolute) && inside(fixture, absolute))
  assert.equal(basename(absolute), 'verification-profiles'); assert.ok(!samePath(absolute, mounted.originalDirectory) && !inside(absolute, mounted.originalDirectory))
  async function ancestors(): Promise<void> {
    let current = parse(absolute).root
    for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
      current = join(current, part); const info = await lstat(current)
      assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true); assert.ok(samePath(await realpath(current), current))
    }
  }
  async function tree(path: string): Promise<void> {
    assert.ok(samePath(path, absolute) || inside(absolute, path)); const info = await lstat(path)
    assert.equal(info.isSymbolicLink(), false); assert.ok(samePath(await realpath(path), path))
    if (info.isDirectory()) for (const name of await readdir(path)) await tree(join(path, name))
    else { assert.equal(info.isFile(), true); assert.equal(info.nlink, 1) }
  }
  await ancestors(); const profileIds = (await readdir(absolute)).sort()
  assert.ok(profileIds.length > 0 && profileIds.every(id => canonicalUuid.test(id)))
  for (const id of profileIds) assert.equal((await lstat(join(absolute, id))).isDirectory(), true)
  await tree(absolute); await ancestors(); await rm(absolute, { recursive: true })
  await assert.rejects(lstat(absolute), { code: 'ENOENT' })
  return { directory: absolute, profileIds }
}

test('qualified owner child restart performs genuine mount recertification after old verification removal and preserves full material hashes and native inner history', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), exported = await exportPreparedOriginBundle(await extractRequiredRootKnowledgeMaterial(pair.dag), { operationId: randomUUID(), bundleId: randomUUID() })
  const receiver = createV3Fixture(join(f.root, 'qualified-child-receiver'))
  try {
    const bundle = await importPreparedOriginBundle({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory })
    const mounted = await readPreparedOriginBundle(bundle), handle = await prepareFirstImportedQualifiedKnowledge(bundle), value = await readPreparedFirstImportedQualifiedKnowledge(handle)
    const paths = ['descriptor.json', ...originBundleExpectedFiles(exported.descriptor).map(file => file.path)].sort()
    const catalog = () => Promise.all(paths.map(async path => ({ path, bytes: await readFile(join(mounted.originalDirectory, ...path.split('/'))) })))
    const before = await catalog(), old = await removeOwnVerificationProfiles(f.root, receiver.userDataRoot, mounted)
    await assert.rejects(readPreparedFirstImportedQualifiedKnowledge(handle), /ENOENT|原件|目录|capsule/)
    const response = await execute(process.execPath, ['--import', 'tsx', worker, JSON.stringify({ profileRoot: mounted.profileRoot,
      operationId: mounted.operationId, mountId: mounted.mountId, expectedDescriptorHash: mounted.descriptorHash })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, maxBuffer: 1024 * 1024 })
    const child = JSON.parse(response.stdout) as QualifiedOwnerChildResult
    assert.equal(child.kind, 'qualified-owner-real-process-reopen-result'); assert.notEqual(child.pid, process.pid)
    assert.equal(child.materialHash, value.materialHash); assert.equal(child.unionHash, value.unionHash); assert.equal(child.descriptorHash, value.descriptorHash)
    assert.deepEqual(child.root, value.root); assert.deepEqual(child.originalRoot, value.originalRoot); assert.equal(child.originalNodeText, exported.descriptor.nodeText)
    assert.deepEqual(child.projectionHashes, value.inputBindings.map(input => input.projectionHash)); assert.deepEqual(child.payloadHashes, value.inputBindings.map(input => input.payloadHash))
    assert.equal(child.groups, value.union.groups.length); assert.ok(child.groups > 0)
    assert.equal(child.preparedEvidence, true); assert.equal(child.certified, false); assert.equal(child.acceptedCoverage, false)
    assert.equal(child.effective, false); assert.equal(child.permit, false); assert.equal(child.fullRootInputSetProven, false)
    assert.deepEqual(await catalog(), before)
    const freshIds = await readdir(old.directory)
    assert.ok(freshIds.length > 0 && freshIds.every(id => canonicalUuid.test(id) && !old.profileIds.includes(id)))
    for (const id of old.profileIds) await assert.rejects(lstat(join(old.directory, id)), { code: 'ENOENT' })
    await assert.rejects(readPreparedFirstImportedQualifiedKnowledge(handle), /ENOENT|原件|目录|capsule/)
  } finally { receiver.close() }
}))
