import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { copyOriginCatalogFile, copyOriginCatalogFileWithIdentity3 } from '../src/main/database/restore-knowledge-origin-bundle-files'
import type { DurableSqlCapsuleFile } from '../src/main/database/restore-knowledge-capsule-model'
import { restoreSqliteFilename } from '../src/main/database/restore-safety-sqlite-path'
import { holdRootRestoreStage3DatabaseFiles3, assertRootRestoreStage3FilesHeld3,
  assertRootRestoreStage3WritableMain3, assertRootRestoreStage3WrittenMainClosed3, closeRootRestoreStage3FilesHeld3,
  type RootRestoreStage3HeldDatabaseFiles3, type RootRestoreStage3CreatedDatabaseFileIdentity3 }
  from '../src/main/database/restore-knowledge-stage3-files'

// Native filesystem/SQLite leaf only. These fixtures mint no genuine bundle,
// reference or stage owner and do not stand in for actual stage acceptance.
interface Fixture {
  root: string; victim: string; working: string; workingDirectory: string; original: Buffer
  inventory: readonly DurableSqlCapsuleFile[]
  created: readonly RootRestoreStage3CreatedDatabaseFileIdentity3[]
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function inside(root: string, file: string) {
  const child = relative(root, resolve(file))
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))
}
function value(file: string): string {
  const db = new Database(restoreSqliteFilename(file), { readonly: true, fileMustExist: true })
  try { return (db.prepare('SELECT value FROM native_guard_fixture WHERE id=1').get() as { value: string }).value }
  finally { db.close() }
}
async function withFiles(run: (fixture: Fixture) => Promise<void>) {
  const parent = await realpath(tmpdir()), cleanupRoot = await mkdtemp(join(parent, 'knowbook-stage3-files-'))
  const root = await realpath(cleanupRoot)
  try {
    const victimDirectory = join(root, 'victim'), workingDirectory = join(root, 'working')
    await mkdir(victimDirectory); await mkdir(workingDirectory)
    const victim = join(victimDirectory, 'knowbook.db'), working = join(workingDirectory, 'knowbook.db')
    const db = new Database(restoreSqliteFilename(victim))
    try {
      db.pragma('journal_mode=DELETE')
      db.exec('CREATE TABLE native_guard_fixture(id INTEGER PRIMARY KEY,value TEXT NOT NULL)')
      db.prepare('INSERT INTO native_guard_fixture VALUES(1,?)').run('baseline')
    } finally { db.close() }
    const original = await readFile(victim), expected = { path: 'knowbook.db', bytes: original.length, sha256: digest(original) }
    const identity = await copyOriginCatalogFileWithIdentity3(victim, root, working, root, expected)
    assert.equal(typeof identity.dev, 'bigint'); assert.equal(typeof identity.ino, 'bigint')
    const inventory: readonly DurableSqlCapsuleFile[] = [
      { name: 'knowbook.db', present: true, bytes: original.length, sha256: expected.sha256 },
      { name: 'knowbook.db-wal', present: false, bytes: 0, sha256: null },
      { name: 'knowbook.db-shm', present: false, bytes: 0, sha256: null }
    ]
    const created: readonly RootRestoreStage3CreatedDatabaseFileIdentity3[] = [{ name: 'knowbook.db', ...identity }]
    await run({ root, victim, working, workingDirectory, original, inventory, created })
  } finally {
    assert.equal(dirname(root), parent)
    assert.ok(basename(root).startsWith('knowbook-stage3-files-'))
    assert.equal((await lstat(cleanupRoot)).isSymbolicLink(), false)
    assert.equal(await realpath(cleanupRoot), root)
    await rm(root, { recursive: true, force: true })
  }
}
const writable = (f: Fixture) => holdRootRestoreStage3DatabaseFiles3({ profileRoot: f.root,
  databaseDirectory: f.workingDirectory, inventory: f.inventory, purpose: 'writable-open', expectedCreatedIdentities: f.created })
const tail = (f: Fixture) => holdRootRestoreStage3DatabaseFiles3({ profileRoot: f.root,
  databaseDirectory: f.workingDirectory, inventory: f.inventory })
async function replaceWithSameBytes(f: Fixture) {
  const replacement = join(f.root, 'same-bytes-replacement.db'), retired = join(f.root, 'retired-created.db')
  for (const file of [f.working, replacement, retired]) inside(f.root, file)
  assert.equal((await lstat(f.working)).isSymbolicLink(), false)
  await writeFile(replacement, f.original, { flag: 'wx' })
  const replacementStat = await lstat(replacement, { bigint: true })
  assert.equal(replacementStat.nlink, 1n)
  assert.notEqual(replacementStat.ino, f.created[0].ino, 'The original created file still exists when its independent replacement is made')
  await rename(f.working, retired)
  await rename(replacement, f.working)
  assert.equal((await lstat(f.working, { bigint: true })).nlink, 1n)
  assert.deepEqual(await readFile(f.working), f.original)
}

test('stage3 native file leaf holds its own working DB through actual SQL close and keeps the victim and legacy copy bytes unchanged', () =>
  withFiles(async f => {
    const legacyDirectory = join(f.root, 'legacy-copy'); await mkdir(legacyDirectory)
    const legacy = join(legacyDirectory, 'knowbook.db')
    assert.equal(await copyOriginCatalogFile(f.victim, f.root, legacy, f.root,
      { path: 'knowbook.db', bytes: f.original.length, sha256: digest(f.original) }), undefined)
    assert.deepEqual(await readFile(legacy), f.original)
    const guard = await writable(f)
    let db: Database.Database | undefined
    try {
      assertRootRestoreStage3FilesHeld3(guard)
      db = new Database(restoreSqliteFilename(f.working), { fileMustExist: true })
      assertRootRestoreStage3WritableMain3(guard, db)
      db.transaction(() => db!.prepare('UPDATE native_guard_fixture SET value=? WHERE id=1').run('owned-write')).immediate()
      db.close()
      assertRootRestoreStage3WrittenMainClosed3(guard, db)
    } finally {
      try { if (db?.open) db.close() } finally { closeRootRestoreStage3FilesHeld3(guard) }
    }
    assert.equal(value(f.working), 'owned-write')
    assert.notDeepEqual(await readFile(f.working), f.original)
    assert.equal(value(f.victim), 'baseline')
    assert.deepEqual(await readFile(f.victim), f.original)
    assert.deepEqual(await readFile(legacy), f.original)
  }))

test('stage3 native file leaf rejects a same-byte nlink-one replacement before hold using the actual created FD identity', () =>
  withFiles(async f => {
    await replaceWithSameBytes(f)
    let unexpected: RootRestoreStage3HeldDatabaseFiles3 | undefined
    try {
      await assert.rejects(async () => { unexpected = await writable(f) }, /文件打开身份未知/)
    } finally { if (unexpected) closeRootRestoreStage3FilesHeld3(unexpected) }
    assert.deepEqual(await readFile(f.working), f.original)
    assert.deepEqual(await readFile(f.victim), f.original)
  }))

test('stage3 native file leaf rejects actual SQL-cell bytes changed during an awaited held read', () =>
  withFiles(async f => {
    const guard = await tail(f)
    try {
      await nextTurn()
      const changed = Buffer.from(f.original), index = changed.indexOf(Buffer.from('baseline'))
      assert.ok(index >= 0)
      Buffer.from('tampered').copy(changed, index)
      await writeFile(f.working, changed, { flag: 'r+' })
      assert.equal(value(f.working), 'tampered', 'The actual native SQLite row has changed, not a returned DTO')
      assert.notDeepEqual(await readFile(f.working), f.original)
      assert.throws(() => assertRootRestoreStage3FilesHeld3(guard), /metadata|闭集/)
    } finally { closeRootRestoreStage3FilesHeld3(guard) }
    assert.deepEqual(await readFile(f.victim), f.original)
  }))

test('stage3 native file leaf rejects same-byte file replacement across an await while the original FD remains held', () =>
  withFiles(async f => {
    const guard = await tail(f)
    try {
      await nextTurn()
      await replaceWithSameBytes(f)
      assert.throws(() => assertRootRestoreStage3FilesHeld3(guard), /身份|metadata|闭集/)
      assert.deepEqual(await readFile(f.working), f.original, 'Equal file bytes do not excuse a changed held identity')
    } finally { closeRootRestoreStage3FilesHeld3(guard) }
    assert.deepEqual(await readFile(f.victim), f.original)
  }))

test('stage3 native file leaf rejects an extra real directory entry after an awaited held read without changing DB bytes', () =>
  withFiles(async f => {
    const guard = await tail(f)
    try {
      await nextTurn()
      await writeFile(join(f.workingDirectory, 'unexpected-journal'), 'outside the closed three-file set', { flag: 'wx' })
      assert.throws(() => assertRootRestoreStage3FilesHeld3(guard), /目录.*闭集/)
      assert.deepEqual(await readFile(f.working), f.original)
    } finally { closeRootRestoreStage3FilesHeld3(guard) }
    assert.deepEqual(await readFile(f.victim), f.original)
  }))

test('stage3 native file leaf rejects a different actual main before the business write even when both SQLite files have identical contents', () =>
  withFiles(async f => {
    const guard = await writable(f)
    let db: Database.Database | undefined
    try {
      assertRootRestoreStage3FilesHeld3(guard)
      db = new Database(restoreSqliteFilename(f.victim), { fileMustExist: true })
      const victim = db
      assert.throws(() => {
        assertRootRestoreStage3WritableMain3(guard, victim)
        victim.prepare('UPDATE native_guard_fixture SET value=? WHERE id=1').run('wrong-main-write')
      }, /SQLite实际main filename不是已固定DB路径/)
    } finally {
      try { if (db?.open) db.close() } finally { closeRootRestoreStage3FilesHeld3(guard) }
    }
    assert.equal(value(f.victim), 'baseline')
    assert.deepEqual(await readFile(f.victim), f.original)
    assert.deepEqual(await readFile(f.working), f.original)
  }))

test('stage3 native file leaf cannot upgrade a readonly-tail guard into a working writer', () =>
  withFiles(async f => {
    const guard = await tail(f)
    let db: Database.Database | undefined
    try {
      assertRootRestoreStage3FilesHeld3(guard)
      db = new Database(restoreSqliteFilename(f.working), { fileMustExist: true })
      const working = db
      assert.throws(() => {
        assertRootRestoreStage3WritableMain3(guard, working)
        working.prepare('UPDATE native_guard_fixture SET value=? WHERE id=1').run('readonly-upgrade-write')
      }, /创建身份完整绑定/)
    } finally {
      try { if (db?.open) db.close() } finally { closeRootRestoreStage3FilesHeld3(guard) }
    }
    assert.equal(value(f.working), 'baseline')
    assert.deepEqual(await readFile(f.working), f.original)
    assert.deepEqual(await readFile(f.victim), f.original)
  }))
