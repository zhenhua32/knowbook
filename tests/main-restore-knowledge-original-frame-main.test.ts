import assert from 'node:assert/strict'
import test from 'node:test'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { readPreparedMixedOriginBundleOriginalInputs } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { assertOriginalFrameDirectory, writeOriginalFrameDirectory } from '../src/main/database/restore-knowledge-original-frame-files'
import { referenceContextObjectPath } from '../src/main/database/restore-knowledge-reference-context-model'
import { allTables, withMixedBundleFixture } from './helpers/mixed-origin-bundle-fixture'

test('complete Main mixed originals supply the exact SQL, metadata and managed files for independent flat-frame copies', () => withMixedBundleFixture([1, 2], async f => {
  const original = await readPreparedMixedOriginBundleOriginalInputs(f.handle)
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
  await writeFile(blob.sourcePath, 'late changed actual mounted blob')
  await assert.rejects(readPreparedMixedOriginBundleOriginalInputs(f.handle))
  await assertOriginalFrameDirectory(directory, descriptorText, files)
  assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))

test('Main mixed original input seam rejects fake, diagnostic and accessor handles before observing caller properties', async () => {
  let observed = 0
  const accessor = Object.defineProperty({}, 'kind', { get() { observed++; throw new Error('caller getter ran') } })
  for (const fake of [null, undefined, {}, { kind: 'prepared-mixed-origin-bundle' }, { rootScope: 'prepared-first-mixed-original-inputs' }, accessor])
    await assert.rejects(readPreparedMixedOriginBundleOriginalInputs(fake as never), /私有|原件句柄/)
  assert.equal(observed, 0)
})
