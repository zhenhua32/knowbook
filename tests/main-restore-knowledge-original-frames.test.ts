import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat, readdir, link, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { referenceContextObjectPath, type ReferenceContextFile } from '../src/main/database/restore-knowledge-reference-context-model'
import { assertOriginalFrameDirectory, readOriginalFrameText, writeOriginalFrameDirectory } from '../src/main/database/restore-knowledge-original-frame-files'
import { id } from './helpers/coverage-structure-fixture'

const require = createRequire(import.meta.url)
const fs: typeof import('node:fs/promises') = require('node:fs/promises')
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowbook-original-frames-')))
  try { await run(await setup(root)) } finally { await rm(root, { recursive: true, force: true }) }
}
async function setup(root: string) {
  const source = join(root, 'source'), directory = join(root, 'copy'), descriptorText = '{"transportOnly":true}\n'
  await mkdir(source)
  const content = Buffer.from('完整原件 UTF-8\n'), sourcePath = join(source, '原始.txt')
  await writeFile(sourcePath, content, { flag: 'wx' })
  const deep = Array.from({ length: 128 }, (_, index) => id(index + 1))
  const files = [[], [id(201)], deep].flatMap(frame => ['descriptor.json', '目录/原始.txt'].map(path => ({
    frame, path, bytes: content.length, sha256: capsuleBytesHash(content), sourcePath, sourceRoot: root
  })))
  await writeOriginalFrameDirectory({ profileRoot: root, directory, descriptorText, files })
  const path = (file: ReferenceContextFile) => join(directory, ...referenceContextObjectPath(file.frame, file.path).split('/'))
  return { root, directory, descriptorText, files, path, content, sourcePath }
}

test('original frames keep 64 generations and identical logical files in independently copied constant-depth physical domains', () => fixture(async f => {
  const identities = []
  for (const file of f.files) {
    const path = f.path(file), stat = await lstat(path, { bigint: true })
    assert.equal(referenceContextObjectPath(file.frame, file.path).split('/').length, 3)
    assert.equal(stat.nlink, 1n); assert.notEqual(stat.ino, 0n)
    identities.push(String(stat.dev) + ':' + String(stat.ino))
    assert.deepEqual(await readFile(path), f.content)
    assert.equal(await readOriginalFrameText(f.directory, file, f.content.length), f.content.toString())
  }
  assert.equal(new Set(identities).size, f.files.length, 'Neither equal bytes nor equal logical paths share a physical original')
  await unlink(f.sourcePath)
  await assertOriginalFrameDirectory(f.directory, f.descriptorText, f.files)
  await writeFile(f.path(f.files[0]), 'changed one independent domain')
  assert.deepEqual(await readFile(f.path(f.files[2])), f.content)
  await assert.rejects(assertOriginalFrameDirectory(f.directory, f.descriptorText, f.files))
}))

test('original frames reject missing, extra and externally hardlinked originals and do not overwrite a previous store', () => fixture(async f => {
  const extra = join(f.directory, 'objects', 'unexpected')
  await writeFile(extra, 'unlisted'); await assert.rejects(assertOriginalFrameDirectory(f.directory, f.descriptorText, f.files)); await unlink(extra)
  const file = f.files[1], saved = await readFile(f.path(file)), alias = join(f.root, 'outside-alias')
  await link(f.path(file), alias); await assert.rejects(assertOriginalFrameDirectory(f.directory, f.descriptorText, f.files)); await unlink(alias)
  await unlink(f.path(file)); await assert.rejects(assertOriginalFrameDirectory(f.directory, f.descriptorText, f.files)); await writeFile(f.path(file), saved)
  await assert.rejects(writeOriginalFrameDirectory({ profileRoot: f.root, directory: f.directory, descriptorText: f.descriptorText, files: f.files }), /EEXIST/)
  await assertOriginalFrameDirectory(f.directory, f.descriptorText, f.files)
}))

test('original frame text refuses caller budgets, extra bytes and invalid UTF-8 before returning text', () => fixture(async f => {
  const file = f.files[0]
  for (const budget of [0, -1, NaN, 1.5, f.content.length - 1])
    await assert.rejects(readOriginalFrameText(f.directory, file, budget), /预算/)
  await writeFile(f.path(file), Buffer.alloc(f.content.length, 255))
  await assert.rejects(readOriginalFrameText(f.directory, file, f.content.length))
  const invalid = Buffer.alloc(f.content.length, 255), pinned = { ...file, sha256: capsuleBytesHash(invalid) }
  await assert.rejects(readOriginalFrameText(f.directory, pinned, invalid.length), /UTF|编码|字节/i)
  await writeFile(f.path(file), Buffer.concat([f.content, Buffer.from('extra')]))
  await assert.rejects(readOriginalFrameText(f.directory, file, f.content.length))
}))

async function afterDescriptorCloses(t: TestContext, f: Awaited<ReturnType<typeof setup>>, change: () => Promise<void>) {
  const open = fs.open, descriptorPath = join(f.directory, 'descriptor.json'); let injected = false
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const fd = await Reflect.apply(open, fs, args), close = fd.close.bind(fd)
    if (String(args[0]) === descriptorPath) fd.close = async () => {
      await close()
      if (!injected) { injected = true; await change() }
    }
    return fd
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(assertOriginalFrameDirectory(f.directory, f.descriptorText, f.files))
    assert.equal(injected, true, 'The mutation follows the real descriptor FD close, after all payload streams settled')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}
test('original frames recheck earlier payloads after the final descriptor stream', { concurrency: false }, t => fixture(async f => {
  await afterDescriptorCloses(t, f, () => writeFile(f.path(f.files[0]), Buffer.alloc(f.content.length, 65)))
}))
test('original frames reject a late unlisted file after all payload streams', { concurrency: false }, t => fixture(async f => {
  await afterDescriptorCloses(t, f, () => writeFile(join(f.directory, 'late'), 'unlisted'))
}))
test('original frames reject duplicate domains, traversal and excessive logical depth before creating a store', () => fixture(async f => {
  for (const files of [[f.files[0], f.files[0]], [{ ...f.files[0], path: '../escape' }], [{ ...f.files[0], frame: Array(130).fill(id(1)) }]]) {
    const directory = join(f.root, 'invalid-' + (await readdir(f.root)).length)
    await assert.rejects(writeOriginalFrameDirectory({ profileRoot: f.root, directory, descriptorText: f.descriptorText, files }))
    await assert.rejects(lstat(directory), /ENOENT/)
  }
}))
