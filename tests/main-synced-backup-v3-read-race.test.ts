import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { readBackupV3Files } from '../src/main/backup/v3-reader'

const require = createRequire(import.meta.url)
const nativeFs: typeof import('node:fs') = require('node:fs')

test('Main V3 reader rejects growth after the real fd stat while reading only the checked size plus one byte', { concurrency: false }, () => {
  const root = nativeFs.mkdtempSync(join(tmpdir(), 'knowbook-v3-fd-growth-'))
  const directory = join(root, '__knowbook', 'synced-groups'), file = join(directory, 'isolated-group.json')
  const initial = Buffer.from('{}\n'), append = Buffer.alloc(5 * 1024 * 1024 + 32, 120)
  nativeFs.mkdirSync(directory, { recursive: true })
  nativeFs.writeFileSync(file, initial, { flag: 'wx' })
  const originals = new Map(['fstatSync', 'readSync', 'readFileSync'].map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(nativeFs, key)
    assert.ok(descriptor, 'The native fs test hook has an original own descriptor')
    return [key, descriptor] as const
  }))
  const originalFstat = nativeFs.fstatSync, originalRead = nativeFs.readSync, originalReadFile = nativeFs.readFileSync
  let injected = false, checkedFd: number | null = null, requested = 0, consumed = 0, readCalls = 0, unboundedReads = 0
  try {
    Object.defineProperty(nativeFs, 'fstatSync', { ...originals.get('fstatSync')!, value: (fd: number) => {
      const actual = originalFstat(fd)
      if (!injected) {
        assert.equal(actual.size, initial.length, 'The fault occurs after the original real fd stat of the isolated content file')
        injected = true; checkedFd = fd
        // A real append on another fd, after the original stat, crosses the unchanged 5MiB content limit.
        nativeFs.appendFileSync(file, append)
        assert.ok(nativeFs.statSync(file).size > 5 * 1024 * 1024, 'The physical file has actually grown beyond the original limit')
      }
      return actual
    } })
    Object.defineProperty(nativeFs, 'readSync', { ...originals.get('readSync')!, value: (...args: unknown[]) => {
      if (args[0] === checkedFd) {
        assert.equal(typeof args[3], 'number', 'The reader uses an explicit bounded fd read length')
        requested += args[3] as number; readCalls++
      }
      const count: unknown = Reflect.apply(originalRead, nativeFs, args)
      if (args[0] === checkedFd) { assert.equal(typeof count, 'number'); consumed += count as number }
      return count
    } })
    Object.defineProperty(nativeFs, 'readFileSync', { ...originals.get('readFileSync')!, value: (...args: unknown[]) => {
      unboundedReads++
      return Reflect.apply(originalReadFile, nativeFs, args)
    } })
    syncBuiltinESMExports()
    assert.throws(() => readBackupV3Files(nativeFs.realpathSync(root)), /archive file changed while reading/,
      'A real post-stat append is rejected without accepting any archive facts')
    assert.equal(injected, true, 'The native post-fstat race was actually reached')
    assert.ok(readCalls > 0, 'The regression measures the real read path rather than only an early validation throw')
    assert.equal(unboundedReads, 0, 'The archive capture never calls an unbounded readFileSync')
    assert.equal(requested, initial.length + 1, 'All requested fd bytes are exactly the checked size plus one EOF probe')
    assert.equal(consumed, initial.length + 1, 'The growing physical file cannot make the reader consume its appended megabytes')
  } finally {
    for (const [key, descriptor] of originals) Object.defineProperty(nativeFs, key, descriptor)
    syncBuiltinESMExports()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'Only this directly owned isolated temporary directory is removed')
    assert.ok(basename(root).startsWith('knowbook-v3-fd-growth-'), 'The cleanup target has the test-owned unique prefix')
    nativeFs.rmSync(root, { recursive: true, force: true })
  }
})
