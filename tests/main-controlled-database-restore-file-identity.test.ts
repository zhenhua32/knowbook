import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { assertRestoreSourceIndependent, isSameRestoreOpenFileIdentity } from '../src/main/database/restore-safety-files'

type Identity = Parameters<typeof isSameRestoreOpenFileIdentity>[0]
const identity = (dev: bigint, ino: bigint): Identity => ({ dev, ino })

test('restore handle identity keeps adjacent NTFS-sized inode values distinct even when Number collapses them', () => {
  const a = 9007199254740992n, b = 9007199254740993n
  assert.notEqual(a, b)
  assert.equal(Number(a), Number(b), 'The fixture reproduces the exact old Number collision')
  assert.equal(isSameRestoreOpenFileIdentity(identity(7n, a), identity(7n, b)), false)
  assert.equal(isSameRestoreOpenFileIdentity(identity(7n, b), identity(7n, a)), false)
})

test('restore handle identity accepts an exact high-bit descriptor identity', () => {
  const a = identity(0x123456789abcdefn, 0xfedcba987654321n)
  assert.equal(isSameRestoreOpenFileIdentity(a, { ...a }), true)
})

test('restore handle identity keeps full volume IDs when different volumes share an inode', () => {
  const a = identity(0x111111111n, 9007199254740993n), b = identity(0x211111111n, a.ino)
  assert.notEqual(a.dev, b.dev)
  assert.equal(BigInt.asUintN(32, a.dev), BigInt.asUintN(32, b.dev), 'Truncating descriptor volume IDs would lose this distinction')
  assert.equal(isSameRestoreOpenFileIdentity(a, b), false)
  assert.equal(isSameRestoreOpenFileIdentity(b, a), false)
})

test('restore handle identity does not make an unknown zero volume a wildcard', () => {
  const unknown = identity(0n, 99n), known = identity(17n, 99n)
  assert.equal(isSameRestoreOpenFileIdentity(unknown, known), false)
  assert.equal(isSameRestoreOpenFileIdentity(known, unknown), false)
})

test('restore handle identity rejects Number stats instead of rounding or coercing them', () => {
  const actual = identity(7n, 9007199254740993n)
  const malformed: unknown[] = [
    { dev: 7, ino: Number(actual.ino) },
    { dev: 7, ino: actual.ino },
    { dev: 7n, ino: Number(actual.ino) },
    { dev: '7', ino: actual.ino },
    { dev: 7n, ino: actual.ino.toString() }
  ]
  for (const value of malformed) {
    const invalid = value as Identity
    assert.equal(isSameRestoreOpenFileIdentity(invalid, actual), false)
    assert.equal(isSameRestoreOpenFileIdentity(actual, invalid), false)
    assert.equal(isSameRestoreOpenFileIdentity(invalid, invalid), false)
  }
})

test('restore handle identity rejects zero inode evidence', () => {
  const unknown = identity(7n, 0n), known = identity(7n, 99n)
  assert.equal(isSameRestoreOpenFileIdentity(unknown, unknown), false)
  assert.equal(isSameRestoreOpenFileIdentity(unknown, known), false)
  assert.equal(isSameRestoreOpenFileIdentity(known, unknown), false)
})

async function withIdentityFiles(run: (f: { root: string; profile: string; source: string; copied: string; bytes: Buffer }) => Promise<void>) {
  const cleanupRoot = await mkdtemp(join(tmpdir(), 'knowbook-restore-file-identity-'))
  try {
    // The actual native/async canonical spelling also works under a real 8.3 TEMP alias.
    const root = await realpath(cleanupRoot), profile = join(root, 'profile'), source = join(root, 'source.db')
    await mkdir(profile)
    const copied = join(profile, 'knowbook.db'), bytes = Buffer.from('independent original file identity bytes')
    await writeFile(source, bytes, { flag: 'wx' })
    await copyFile(source, copied, constants.COPYFILE_EXCL)
    await run({ root, profile, source, copied, bytes })
  } finally {
    assert.equal(dirname(resolve(cleanupRoot)), resolve(tmpdir()))
    assert.ok(basename(cleanupRoot).startsWith('knowbook-restore-file-identity-'))
    await rm(cleanupRoot, { recursive: true, force: true })
  }
}

test('real independent file copies are accepted without changing either original', () => withIdentityFiles(async f => {
  const source = await open(f.source, constants.O_RDONLY)
  try {
    const copy = await open(f.copied, constants.O_RDONLY)
    try {
      const a = await source.stat({ bigint: true }), b = await copy.stat({ bigint: true })
      assert.equal(isSameRestoreOpenFileIdentity(a, b), false, 'The equal bytes belong to genuinely distinct open files')
      await assertRestoreSourceIndependent(f.source, [f.copied], f.profile)
      assert.deepEqual(await readFile(f.source), f.bytes)
      assert.deepEqual(await readFile(f.copied), f.bytes)
    } finally { await copy.close() }
  } finally { await source.close() }
}))

test('real simultaneously open hardlink descriptors are refused without changing either alias', async t => withIdentityFiles(async f => {
  const alias = join(f.profile, 'source-hardlink.db')
  try { await link(f.source, alias) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error
      && ['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(String(error.code))) {
      t.skip('The actual filesystem cannot create the real hardlink'); return
    }
    throw error
  }
  const source = await open(f.source, constants.O_RDONLY)
  try {
    const target = await open(alias, constants.O_RDONLY)
    try {
      const a = await source.stat({ bigint: true }), b = await target.stat({ bigint: true })
      assert.ok(a.nlink >= 2n)
      assert.equal(isSameRestoreOpenFileIdentity(a, b), true)
      await assert.rejects(assertRestoreSourceIndependent(f.source, [alias], f.profile), /同一实际file\/hardlink/)
      assert.deepEqual(await readFile(f.source), f.bytes)
      assert.deepEqual(await readFile(alias), f.bytes)
      assert.deepEqual(await readFile(f.copied), f.bytes)
      assert.equal((await lstat(alias, { bigint: true })).ino, a.ino)
    } finally { await target.close() }
  } finally { await source.close() }
}))
