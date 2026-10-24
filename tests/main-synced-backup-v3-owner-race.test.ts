import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { readBackupV3Archive, readBackupV3Files } from '../src/main/backup/v3-reader'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { withV3Fixture, randomUUID, sha256, allTables } from './helpers/synced-backup-v3-fixture'

const require = createRequire(import.meta.url)
const nativeFs: typeof import('node:fs') = require('node:fs')
type Fixture = Parameters<Parameters<typeof withV3Fixture>[0]>[0]

function actualArchive(f: Fixture) {
  // The real Main producer requires the canonical owner, including on Windows
  // runners whose TEMP uses an actual 8.3 alias.
  const root = nativeFs.realpathSync(f.root), directory = join(root, 'archive')
  writeSyncedBackupV3(f.db, { userDataRoot: nativeFs.realpathSync(f.userDataRoot), destination: directory, snapshotId: randomUUID() })
  assert.equal(readBackupV3Archive(directory).groups[0].wire.id, f.groupId)
  return { root, directory, group: join(directory, '__knowbook', 'synced', 'group-' + sha256(f.groupId) + '.json') }
}

function duringGroupRead(t: TestContext, file: string, change: (fd: number) => void, run: () => void) {
  const open = nativeFs.openSync, read = nativeFs.readSync
  let checkedFd: number | undefined, injected = false
  t.mock.method(nativeFs, 'openSync', (...args: Parameters<typeof nativeFs.openSync>) => {
    const fd = Reflect.apply(open, nativeFs, args) as number
    if (String(args[0]) === file) checkedFd = fd
    return fd
  })
  t.mock.method(nativeFs, 'readSync', (...args: unknown[]) => {
    const bytes = Reflect.apply(read, nativeFs, args) as number
    if (!injected && args[0] === checkedFd && bytes > 0) { injected = true; change(checkedFd!) }
    return bytes
  })
  syncBuiltinESMExports()
  try {
    run()
    assert.equal(injected, true, 'The mutation happened during the real group fd read, after a true complete Main export')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}

function afterGroupClose(t: TestContext, file: string, change: () => void, run: () => void) {
  const open = nativeFs.openSync, close = nativeFs.closeSync, fstat = nativeFs.fstatSync
  let checkedFd: number | undefined, opened: ReturnType<typeof fstat> | undefined, injected = false
  const identity = (s: ReturnType<typeof fstat>) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]
  t.mock.method(nativeFs, 'openSync', (...args: Parameters<typeof nativeFs.openSync>) => {
    const fd = Reflect.apply(open, nativeFs, args) as number
    if (String(args[0]) === file) { checkedFd = fd; opened = fstat(fd) }
    return fd
  })
  t.mock.method(nativeFs, 'closeSync', (fd: number) => {
    const target = fd === checkedFd && !injected
    if (target) assert.deepEqual(identity(fstat(fd)), identity(opened!), 'The real group fd stayed unchanged until its actual close')
    close(fd)
    if (target) { injected = true; change() }
  })
  syncBuiltinESMExports()
  try {
    run()
    assert.equal(injected, true, 'The replacement follows the actual native group fd close, before the directory reader returns')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}

test('V3 complete Main archive rejects an outside hardlink without modifying live SQL', () => withV3Fixture(f => {
  const a = actualArchive(f), before = allTables(f.db), outside = join(a.root, 'outside-group.json')
  nativeFs.writeFileSync(outside, nativeFs.readFileSync(a.group), { flag: 'wx' })
  nativeFs.unlinkSync(a.group); nativeFs.linkSync(outside, a.group)
  assert.equal(nativeFs.lstatSync(a.group).nlink, 2, 'This is a real external hardlink, with the unchanged complete archive bytes')
  assert.throws(() => readBackupV3Archive(a.directory), /archive.*(?:link|independent|standalone)/i)
  assert.deepEqual(allTables(f.db), before)
}))

test('V3 complete Main archive rejects a source directory replaced immediately after its real group fd closes', { concurrency: false }, t => withV3Fixture(f => {
  const a = actualArchive(f), before = allTables(f.db)
  afterGroupClose(t, a.group, () => {
    nativeFs.renameSync(dirname(a.group), join(a.root, 'displaced-synced'))
    nativeFs.mkdirSync(dirname(a.group))
    nativeFs.writeFileSync(a.group, 'not the exported group JSON', { flag: 'wx' })
  }, () => assert.throws(() => readBackupV3Archive(a.directory), /archive.*(?:changed|replaced|identity)/i))
  assert.deepEqual(allTables(f.db), before)
}))

test('V3 complete Main archive rejects a file added after the directory inventory was captured', { concurrency: false }, t => withV3Fixture(f => {
  const a = actualArchive(f), before = allTables(f.db)
  duringGroupRead(t, a.group, () => nativeFs.writeFileSync(join(a.directory, 'late.md'), 'unlisted late document', { flag: 'wx' }),
    () => assert.throws(() => readBackupV3Archive(a.directory), /archive.*(?:changed|inventory|closure)/i))
  assert.deepEqual(allTables(f.db), before)
}))

test('V3 complete Main archive rechecks previously read document identities before returning its whole closure', { concurrency: false }, t => withV3Fixture(f => {
  const a = actualArchive(f), before = allTables(f.db)
  const document = readBackupV3Files(a.directory).find(file => !file.relativePath.startsWith('__knowbook/') && file.relativePath.endsWith('.md'))
  assert.ok(document, 'A real complete Main export contains its actual host document')
  const file = join(a.directory, ...document.relativePath.split('/'))
  assert.notEqual(basename(file), basename(a.group))
  duringGroupRead(t, a.group, () => nativeFs.writeFileSync(file, 'changed after its fd was closed'),
    () => assert.throws(() => readBackupV3Archive(a.directory), /archive.*(?:changed|identity|closure)/i))
  assert.deepEqual(allTables(f.db), before)
}))
