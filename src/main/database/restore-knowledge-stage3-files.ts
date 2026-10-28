import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, open as openCallback, read as readCallback,
  readdirSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { CAPSULE_MAX_ORIGINAL_BYTES, CAPSULE_MAX_MANIFEST_BYTES, validateDurableSqlCapsuleInventory,
  type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'

export interface RootRestoreStage3HeldFiles3 { readonly kind: 'main-root-restore-stage3-held-files' }
export interface RootRestoreStage3HeldDatabaseFiles3 extends RootRestoreStage3HeldFiles3 { readonly databaseFiles: true }
export interface RootRestoreStage3CreatedFileIdentity3 { readonly dev: bigint; readonly ino: bigint }
export interface RootRestoreStage3CreatedDatabaseFileIdentity3 extends RootRestoreStage3CreatedFileIdentity3 {
  readonly name: DurableSqlCapsuleFile['name']
}
export interface RootRestoreStage3HeldFilesInput3 {
  readonly profileRoot: string
  readonly directories: readonly { readonly path: string; readonly entries: readonly string[] }[]
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string;
    readonly expectedIdentity?: RootRestoreStage3CreatedFileIdentity3 }[]
  readonly absentFiles?: readonly string[]
}
interface DatabaseInput {
  readonly profileRoot: string
  readonly databaseDirectory: string
  readonly inventory: readonly DurableSqlCapsuleFile[]
}
export type RootRestoreStage3HeldDatabaseInput3 = DatabaseInput & (
  { readonly purpose: 'writable-open'; readonly expectedCreatedIdentities: readonly RootRestoreStage3CreatedDatabaseFileIdentity3[] }
  | { readonly purpose?: 'readonly-tail'; readonly expectedCreatedIdentities?: readonly RootRestoreStage3CreatedDatabaseFileIdentity3[] })
type FileRecord = { path: string; fd: number; stat: BigIntStats; bytes: number; sha256: string; closed: boolean }
type DirectoryRecord = { path: string; stat: BigIntStats; entries: readonly string[] }
type AncestorRecord = { path: string; stat: BigIntStats }
type Saved = {
  root: string; files: FileRecord[]; directories: DirectoryRecord[]; ancestors: AncestorRecord[]; absentFiles: string[]
  closed: boolean; verifying: boolean
  database?: { directory: string; main: FileRecord; connection?: Database.Database; writeAuthorized: boolean; closedChecked: boolean;
    purpose: 'readonly-tail' | 'writable-open'; creationBound: boolean }
}
const guards = new WeakMap<RootRestoreStage3HeldFiles3, Saved>()
const databaseNames = ['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm'] as const
const maxHeldFiles = 5, maxHeldDirectories = 3
const maxHeldBytes = BigInt(CAPSULE_MAX_ORIGINAL_BYTES) + 2n * BigInt(CAPSULE_MAX_MANIFEST_BYTES)
const fail = (message: string): never => { throw new Error('Root3文件保持检查失败：' + message) }
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
const regular = (value: BigIntStats) => value.isFile() && !value.isSymbolicLink() && value.nlink === 1n && value.ino !== 0n
const directory = (value: BigIntStats) => value.isDirectory() && !value.isSymbolicLink() && value.ino !== 0n
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const metadata = (a: BigIntStats, b: BigIntStats) => identity(a, b) && a.nlink === b.nlink && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
/** Windows compatibility is only for this path and its own held FD. It never
 * decides whether two different opened files are aliases. */
const pathMatchesFd = (named: BigIntStats, held: BigIntStats) => regular(named) && regular(held)
  && (named.dev === held.dev || process.platform === 'win32' && (named.dev === 0n || BigInt.asUintN(32, held.dev) === named.dev))
  && named.ino === held.ino && named.mode === held.mode && named.size === held.size
  && named.mtimeNs === held.mtimeNs && named.ctimeNs === held.ctimeNs
const equalNames = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index])
function exactPath(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || !samePath(resolve(value), value))
    return fail('要求规范绝对路径')
  return resolve(value)
}
function inside(value: string, root: string): string {
  const absolute = exactPath(value), child = relative(root, absolute)
  if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) return fail('路径越过自有profile')
  return absolute
}
function optionalStat(file: string): BigIntStats | null {
  try { return lstatSync(file, { bigint: true }) }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error }
}
function ancestry(value: string): AncestorRecord[] {
  const result: AncestorRecord[] = [], volume = parse(value).root
  let current = volume
  for (const part of relative(volume, value).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current, { bigint: true })
    if (!directory(stat) || !samePath(realpathSync.native(current), current)) return fail('父路径含link/reparse或不是准确目录')
    result.push({ path: current, stat })
  }
  return result
}
function ancestorUnchanged(record: AncestorRecord) {
  const actual = lstatSync(record.path, { bigint: true })
  if (!directory(actual) || !identity(record.stat, actual) || !samePath(realpathSync.native(record.path), record.path))
    return fail('父目录身份或重解析路径变化')
}
function directoryUnchanged(record: DirectoryRecord) {
  const actual = lstatSync(record.path, { bigint: true })
  if (!directory(actual) || !metadata(record.stat, actual) || !samePath(realpathSync.native(record.path), record.path)
    || !equalNames(readdirSync(record.path).sort(), record.entries)) return fail('自有目录身份/metadata/闭集变化')
}
function assertFileUnchanged(record: FileRecord) {
  const actual = fstatSync(record.fd, { bigint: true }), named = lstatSync(record.path, { bigint: true })
  if (!regular(actual) || !metadata(record.stat, actual) || !pathMatchesFd(named, actual))
    return fail('已保持文件的FD/path/metadata变化')
}
function assertUnchanged(saved: Saved) {
  if (saved.closed || saved.database?.writeAuthorized) return fail('保持检查已关闭或已进入授权写入阶段')
  for (const record of saved.ancestors) ancestorUnchanged(record)
  for (const record of saved.directories) directoryUnchanged(record)
  for (const record of saved.files) assertFileUnchanged(record)
  for (const file of saved.absentFiles) if (optionalStat(file)) return fail('声明缺失的文件已出现')
  // Repeat directory identities after the finite per-file checks as well.
  for (const record of saved.directories) directoryUnchanged(record)
}
function closeFiles(saved: Saved) {
  if (saved.closed) return
  saved.closed = true
  let first: unknown
  for (const file of [...saved.files].reverse()) if (!file.closed) {
    file.closed = true
    try { closeSync(file.fd) } catch (error) { first ??= error }
  }
  if (first) throw first
}
function owned(guard: RootRestoreStage3HeldFiles3): Saved {
  const saved = guards.get(guard)
  if (!saved) return fail('不是本模块实际保持的文件句柄')
  return saved
}
function copiedIdentity(value: RootRestoreStage3CreatedFileIdentity3 | undefined): RootRestoreStage3CreatedFileIdentity3 | undefined {
  if (value === undefined) return undefined
  const dev = value.dev, ino = value.ino
  if (typeof dev !== 'bigint' || typeof ino !== 'bigint' || dev < 0n || ino <= 0n || process.platform === 'win32' && dev === 0n)
    return fail('创建身份必须来自实际opened FD的dev/ino')
  return { dev, ino }
}
const openRead = (file: string) => new Promise<number>((done, reject) => {
  openCallback(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0), (error, fd) => error ? reject(error) : done(fd))
})
const readPart = (fd: number, buffer: Buffer, length: number, position: number) => new Promise<number>((done, reject) => {
  readCallback(fd, buffer, 0, length, position, (error, count) => error ? reject(error) : done(count))
})
async function capture(input: RootRestoreStage3HeldFilesInput3): Promise<Saved> {
  if (input.directories.length === 0 || input.directories.length > maxHeldDirectories
    || input.files.length + (input.absentFiles?.length ?? 0) > maxHeldFiles)
    return fail('固定保持集合超5文件/3目录格式范围')
  const root = exactPath(input.profileRoot)
  if (!samePath(realpathSync.native(root), root)) return fail('profile不是准确真实目录')
  const saved: Saved = { root, files: [], directories: [], ancestors: [], absentFiles: [], closed: false, verifying: false }
  const parents = new Map<string, DirectoryRecord>(), ancestors = new Map<string, AncestorRecord>(), paths = new Set<string>()
  try {
    for (const supplied of input.directories) {
      const file = inside(supplied.path, root), names = [...supplied.entries].sort()
      if (parents.has(key(file)) || new Set(names).size !== names.length || names.some(name => typeof name !== 'string'
        || !name || name === '.' || name === '..' || /[\\/\0]/.test(name))) return fail('目录闭集含重复或非有限叶名')
      for (const record of ancestry(file)) ancestors.set(key(record.path), record)
      const record = { path: file, stat: lstatSync(file, { bigint: true }), entries: names }
      if (!directory(record.stat) || !equalNames(readdirSync(file).sort(), names)) return fail('目录不是预期完整闭集')
      parents.set(key(file), record); saved.directories.push(record)
    }
    saved.ancestors = [...ancestors.values()]
    const expected = input.files.map(file => ({ path: inside(file.path, root), bytes: file.bytes, sha256: file.sha256,
      expectedIdentity: copiedIdentity(file.expectedIdentity) }))
    let totalBytes = 0n
    for (const file of expected) {
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > CAPSULE_MAX_ORIGINAL_BYTES
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) return fail('文件超原1TB域或没有准确hash')
      totalBytes += BigInt(file.bytes)
    }
    if (totalBytes > maxHeldBytes) return fail('保持集合超原1TB加两份既有小清单的内部预算')
    saved.absentFiles = [...(input.absentFiles ?? [])].map(file => inside(file, root))
    for (const file of [...expected.map(file => file.path), ...saved.absentFiles]) {
      if (paths.has(key(file)) || !parents.has(key(dirname(file)))) return fail('文件重复或缺少明确保持的parent闭集')
      paths.add(key(file))
    }
    const buffer = Buffer.alloc(64 * 1024)
    for (const file of expected) {
      const prior = lstatSync(file.path, { bigint: true })
      if (!regular(prior) || prior.size !== BigInt(file.bytes)) return fail('待保持文件不是准确独立普通原件')
      const fd = await openRead(file.path)
      let retained = false
      try {
        const before = fstatSync(fd, { bigint: true })
        if (!pathMatchesFd(prior, before) || process.platform === 'win32' && before.dev === 0n
          || file.expectedIdentity && (file.expectedIdentity.dev !== before.dev || file.expectedIdentity.ino !== before.ino)
          || saved.files.some(other => other.stat.dev === before.dev && other.stat.ino === before.ino))
          return fail('文件打开身份未知/变化或两个FD实际别名')
        const digest = createHash('sha256'); let offset = 0
        while (offset < file.bytes) {
          const amount = await readPart(fd, buffer, Math.min(buffer.length, file.bytes - offset), offset)
          if (!amount) return fail('保持文件提前EOF')
          digest.update(buffer.subarray(0, amount)); offset += amount
        }
        if (await readPart(fd, buffer, 1, offset) || digest.digest('hex') !== file.sha256) return fail('保持文件尾bytes/hash变化')
        const record: FileRecord = { path: file.path, fd, stat: before, bytes: file.bytes, sha256: file.sha256, closed: false }
        assertFileUnchanged(record)
        saved.files.push(record); retained = true
      } finally { if (!retained) closeSync(fd) }
    }
    assertUnchanged(saved)
    return saved
  } catch (error) {
    try { closeFiles(saved) } catch (closeError) { throw new AggregateError([error, closeError], '保持检查失败且FD关闭失败') }
    throw error
  }
}
/** Async bounded streaming capture keeps numeric FDs open across the caller's
 * awaits. Caller arrays and paths are copied into private records. No whole
 * database Buffer, SQL open or filesystem mutation. The fixed at-most-five-file
 * collection allows the original 1TB plus two existing 256KiB manifests, so
 * metadata does not narrow the original DB inventory domain. Database capture
 * below independently retains validateDurableSqlCapsuleInventory's 1TB rule. */
export async function holdRootRestoreStage3Files3(input: RootRestoreStage3HeldFilesInput3): Promise<RootRestoreStage3HeldFiles3> {
  const saved = await capture(input), guard: RootRestoreStage3HeldFiles3 = Object.freeze({ kind: 'main-root-restore-stage3-held-files' })
  guards.set(guard, saved); return guard
}
export async function holdRootRestoreStage3DatabaseFiles3(input: RootRestoreStage3HeldDatabaseInput3): Promise<RootRestoreStage3HeldDatabaseFiles3> {
  const inventory = validateDurableSqlCapsuleInventory(input.inventory), databaseDirectory = exactPath(input.databaseDirectory)
  const purpose = input.purpose ?? 'readonly-tail', created = new Map<string, RootRestoreStage3CreatedFileIdentity3>()
  if (purpose !== 'readonly-tail' && purpose !== 'writable-open') return fail('未知三文件保持用途')
  for (const supplied of input.expectedCreatedIdentities ?? []) {
    const name = supplied.name, expected = inventory.find(file => file.name === name)
    if (!expected?.present || created.has(name)) return fail('创建身份含缺失/未知文件或重复项')
    created.set(name, copiedIdentity(supplied)!)
  }
  const creationBound = inventory.filter(file => file.present).every(file => created.has(file.name))
  if (purpose === 'writable-open' && !creationBound) return fail('writable保持要求全部present文件的新建FD身份')
  const saved = await capture({ profileRoot: input.profileRoot,
    directories: [{ path: databaseDirectory, entries: inventory.filter(file => file.present).map(file => file.name) }],
    files: inventory.filter(file => file.present).map(file => {
      if (file.sha256 === null) return fail('present三文件缺hash')
      return { path: join(databaseDirectory, file.name), bytes: file.bytes, sha256: file.sha256, expectedIdentity: created.get(file.name) }
    }), absentFiles: inventory.filter(file => !file.present).map(file => join(databaseDirectory, file.name)) })
  const main = saved.files.find(file => samePath(file.path, join(databaseDirectory, 'knowbook.db')))
  if (!main) { closeFiles(saved); return fail('保持集合缺实际main DB') }
  saved.database = { directory: databaseDirectory, main, writeAuthorized: false, closedChecked: false, purpose, creationBound }
  const guard: RootRestoreStage3HeldDatabaseFiles3 = Object.freeze({ kind: 'main-root-restore-stage3-held-files', databaseFiles: true })
  guards.set(guard, saved); return guard
}
/** Synchronous identity/metadata/namespace tail, after content verification's
 * last await and immediately before mint or writable open. This check alone
 * does not authenticate unchanged file bytes when timestamp observations match. */
export function assertRootRestoreStage3FilesHeld3(guard: RootRestoreStage3HeldFiles3): void {
  assertUnchanged(owned(guard))
}
/** Rehash each actual held FD after the caller's final original/manifest awaits.
 * Memory stays at 64KiB and the original complete inventory budget is retained.
 * This verifies the bytes read in this pass; it is not a filesystem snapshot,
 * a write exclusion lock, or atomic proof against all concurrent OS writes.
 * The fixed consumer must immediately do its synchronous tail/mint/open with
 * no further await. The caller retains ownership of closing all FDs in finally. */
export async function verifyRootRestoreStage3FilesHeld3(guard: RootRestoreStage3HeldFiles3): Promise<void> {
  const saved = owned(guard)
  if (saved.verifying) return fail('同一保持集合的内容复核仍在进行')
  assertUnchanged(saved)
  saved.verifying = true
  try {
    const buffer = Buffer.alloc(64 * 1024)
    for (const file of saved.files) {
      assertUnchanged(saved)
      const digest = createHash('sha256'); let offset = 0
      while (offset < file.bytes) {
        const amount = await readPart(file.fd, buffer, Math.min(buffer.length, file.bytes - offset), offset)
        if (saved.closed || saved.database?.writeAuthorized) return fail('内容复核期间保持集合关闭或进入写入阶段')
        if (!amount) return fail('已保持文件内容复核提前EOF')
        digest.update(buffer.subarray(0, amount)); offset += amount
      }
      const extra = await readPart(file.fd, buffer, 1, offset)
      if (saved.closed || saved.database?.writeAuthorized) return fail('内容复核期间保持集合关闭或进入写入阶段')
      assertUnchanged(saved)
      if (extra || digest.digest('hex') !== file.sha256) return fail('已保持文件内容bytes/hash变化')
    }
    assertUnchanged(saved)
  } finally { saved.verifying = false }
}
function sqliteFilename(value: string): string {
  if (typeof value !== 'string') return fail('SQLite main filename不是TEXT')
  if (process.platform === 'win32') {
    if (value.startsWith('\\\\?\\UNC\\')) value = '\\\\' + value.slice(8)
    else if (value.startsWith('\\\\?\\')) value = value.slice(4)
  }
  return exactPath(value)
}
/** The caller owns this native connection and accepts no caller DB/loader in
 * its public stage API. Run synchronously after new Database and immediately
 * before its first business write. Even byte-preserving prewrite metadata
 * changes reject; SQLite-created SHM changes before this check also reject.
 * PRAGMA filename/path stats are observations, NOT access to SQLite's native
 * FD and NOT an OS-exclusive namespace lease. A different OS process can still
 * race path-based SQLite opening; JS cannot prove that native FD atomically. */
export function assertRootRestoreStage3WritableMain3(guard: RootRestoreStage3HeldDatabaseFiles3, db: Database.Database): void {
  const saved = owned(guard), held = saved.database
  if (saved.verifying || !held || held.purpose !== 'writable-open' || !held.creationBound || held.writeAuthorized || !db.open || db.memory || db.readonly)
    return fail('不是创建身份完整绑定的单次自有writable连接')
  assertUnchanged(saved)
  const list = db.pragma('database_list') as Array<{ seq: number; name: string; file: string }>
  if (list.length !== 1 || list[0].seq !== 0 || list[0].name !== 'main' || !list[0].file) return fail('writable连接不是唯一实际main')
  const file = inside(sqliteFilename(list[0].file), saved.root)
  if (!samePath(file, held.main.path)) return fail('SQLite实际main filename不是已固定DB路径')
  const named = lstatSync(file, { bigint: true }), actual = fstatSync(held.main.fd, { bigint: true })
  if (!pathMatchesFd(named, actual) || !metadata(held.main.stat, actual)) return fail('SQLite main路径与固定DB FD身份/metadata不符')
  assertUnchanged(saved)
  held.connection = db; held.writeAuthorized = true
}
/** Authorized SQL may alter DB bytes/times and create/remove WAL/SHM. After
 * close, only the fixed DB identity and finite regular sidecar namespace are
 * checked here; the physical owner must independently seal/hash final bytes. */
export function assertRootRestoreStage3WrittenMainClosed3(guard: RootRestoreStage3HeldDatabaseFiles3, db: Database.Database): void {
  const saved = owned(guard), held = saved.database
  if (saved.closed || !held?.writeAuthorized || held.connection !== db || db.open) return fail('自有writable连接尚未关闭或不匹配')
  for (const record of saved.ancestors) ancestorUnchanged(record)
  const named = lstatSync(held.main.path, { bigint: true }), actual = fstatSync(held.main.fd, { bigint: true })
  if (!regular(actual) || !identity(held.main.stat, actual) || !pathMatchesFd(named, actual)) return fail('写后main DB身份/link变化')
  const names = readdirSync(held.directory).sort()
  if (!names.includes('knowbook.db') || names.some(name => !(databaseNames as readonly string[]).includes(name))) return fail('写后目录含未知文件/journal或缺DB')
  for (const name of names) {
    const file = join(held.directory, name), stat = lstatSync(file, { bigint: true })
    if (!regular(stat)) return fail('写后sidecar不是独立普通文件')
    const old = saved.files.find(record => samePath(record.path, file))
    if (old) {
      const opened = fstatSync(old.fd, { bigint: true })
      if (!regular(opened) || !identity(old.stat, opened) || !pathMatchesFd(stat, opened)) return fail('已保持sidecar被替换')
    }
  }
  held.closedChecked = true
}
/** Numeric descriptors are closed exactly once, including all failure paths.
 * Keep this in finally; it never deletes, renames, checkpoints or repairs. */
export function closeRootRestoreStage3FilesHeld3(guard: RootRestoreStage3HeldFiles3): void {
  closeFiles(owned(guard))
}
