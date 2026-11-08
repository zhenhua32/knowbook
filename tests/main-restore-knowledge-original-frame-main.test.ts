import assert from 'node:assert/strict'
import test from 'node:test'
import fs, { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { readPreparedMixedOriginBundleOriginalInputs } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { assertOriginalFrameDirectory, writeOriginalFrameDirectory } from '../src/main/database/restore-knowledge-original-frame-files'
import { referenceContextObjectPath } from '../src/main/database/restore-knowledge-reference-context-model'
import { allTables, withMixedBundleFixture } from './helpers/mixed-origin-bundle-fixture'

test('complete Main mixed originals supply the exact SQL, metadata and managed files for independent flat-frame copies', context => withMixedBundleFixture([1, 2], async f => {
  const mountedRoot = await realpath(join(f.receiver.userDataRoot, 'backups', 'database-restore', f.reopen.operationId,
    'mixed-origin-bundle-mounts', f.reopen.mountId, 'original'))
  const readdir = fs.readdir
  let rootVisits = 0, beforeTail: (() => Promise<void>) | undefined
  const observed = context.mock.method(fs, 'readdir', (async (...args: unknown[]) => {
    const result = await Reflect.apply(readdir, fs, args)
    if (args[0] === mountedRoot) {
      rootVisits++
      if (rootVisits === 2) await beforeTail?.()
    }
    return result
  }) as typeof fs.readdir)
  syncBuiltinESMExports()
  try {
    const original = await readPreparedMixedOriginBundleOriginalInputs(f.handle)
    assert.equal(rootVisits, 4, 'One full tree scan before and one after reading the actual SQL, with no duplicate package scans')
    assert.deepEqual(original.value, f.value)
    assert.equal(original.acceptedCoverage, false); assert.equal(original.effective, false); assert.equal(original.permit, false)
    assert.ok(original.files.some(file => file.path.endsWith('/original/knowbook.db')))
    assert.ok(original.files.some(file => /\/files\/[0-9a-f]{64}$/.test(file.path)))
    assert.ok(original.files.some(file => file.path === 'descriptor.json'))
    const files = original.files.map(file => ({ ...file, frame: [], sourceRoot: original.profileRoot }))
    const directory = join(original.profileRoot, 'complete-frame-copy'), descriptorText = '{"transportOnly":true}\n'
    await writeOriginalFrameDirectory({ profileRoot: original.profileRoot, directory, descriptorText, files })
    for (const file of files) {
      const target = join(directory, ...referenceContextObjectPath(file.frame, file.path).split('/'))
      const bytes = await readFile(target), source = await lstat(file.sourcePath, { bigint: true }), copy = await lstat(target, { bigint: true })
      assert.equal(bytes.length, file.bytes); assert.equal(capsuleBytesHash(bytes), file.sha256)
      assert.equal(copy.nlink, 1n); assert.ok(source.dev !== copy.dev || source.ino !== copy.ino)
    }
    const blob = original.files.find(file => /\/files\/[0-9a-f]{64}$/.test(file.path))!
    const bytes = await readFile(blob.sourcePath), changed = Buffer.from(bytes)
    changed[0] ^= 1
    rootVisits = 0
    beforeTail = () => writeFile(blob.sourcePath, changed)
    await assert.rejects(readPreparedMixedOriginBundleOriginalInputs(f.handle))
    assert.ok(rootVisits > 2, 'The source changed after the initial tree scan had checked its content')
    await assertOriginalFrameDirectory(directory, descriptorText, files)
    assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  } finally { observed.mock.restore(); syncBuiltinESMExports() }
}))

test('Main mixed original input seam rejects fake, diagnostic and accessor handles before observing caller properties', async () => {
  let observed = 0
  const accessor = Object.defineProperty({}, 'kind', { get() { observed++; throw new Error('caller getter ran') } })
  for (const fake of [null, undefined, {}, { kind: 'prepared-mixed-origin-bundle' }, { rootScope: 'prepared-first-mixed-original-inputs' }, accessor])
    await assert.rejects(readPreparedMixedOriginBundleOriginalInputs(fake as never), /私有|原件句柄/)
  assert.equal(observed, 0)
})
