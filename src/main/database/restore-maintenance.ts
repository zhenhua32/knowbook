import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CURRENT_DATABASE_SCHEMA_VERSION } from './schema-version'
import { stopDatabaseRestoreProcesses, type RestoreProcessIdentity } from './restore-process-guard'
import { isSystemPluginManagedPath, resolveSystemPluginPhysicalPath } from '../system-plugin/managed-paths'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const ARGUMENT = '--knowbook-restore-database'
const JOURNAL = 'database-restore-pending.json'
const SAFE_MARKER = 'database-restore-safe-mode.json'
const FILES = ['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm'] as const
type DatabaseFile = typeof FILES[number]
interface RestoreJournal { version: 1; id: string; phase: 'moving' | 'installed'; originalFiles: DatabaseFile[]; safeModeAfterRollback?: boolean }

export function parseDatabaseRestoreArgument(argv: readonly string[]): string | null {
  const matches = argv.filter((argument) => argument.startsWith(ARGUMENT))
  if (!matches.length) return null
  const path = matches[0]?.slice(ARGUMENT.length + 1)
  if (matches.length !== 1 || !matches[0]!.startsWith(`${ARGUMENT}=`) || !path || path.includes('\0') || !isAbsolute(path)) {
    throw new Error('数据库恢复参数必须为一个 --knowbook-restore-database=<绝对备份路径>。')
  }
  if (argv.some((argument) => argument.startsWith('--knowbook-uninstall-cleanup'))) {
    throw new Error('数据库恢复与卸载维护参数不能同时使用。')
  }
  return resolve(path)
}

async function durableJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx')
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync() } finally { await handle.close() }
  try { await rename(temp, path) } catch (error) { await rm(temp, { force: true }); throw error }
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function paths(userDataRoot: string, id: string) {
  const root = resolve(userDataRoot)
  const storage = join(root, 'storage')
  const recovery = join(root, 'backups', 'database-restore', id)
  return { root, storage, recovery, original: join(recovery, 'original'), staged: join(storage, `.restore-${id}.db`),
    database: join(storage, 'knowbook.db'), journal: join(root, JOURNAL), safeMarker: join(root, SAFE_MARKER) }
}

async function ensureProfileDirectory(directory: string, root: string): Promise<void> {
  const child = relative(resolve(root), resolve(directory))
  if (!await isSystemPluginManagedPath(directory, root, child)) {
    throw new Error('数据库恢复目录指向指定工作区之外，已拒绝操作。')
  }
  await mkdir(directory, { recursive: true })
  if (!await isSystemPluginManagedPath(directory, root, child)) throw new Error('数据库恢复目录身份发生变化，已拒绝操作。')
}

function verifyDatabase(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('SQLite integrity_check 未通过。')
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('SQLite 外键校验未通过。')
    const version = db.pragma('user_version', { simple: true }) as number
    if (!Number.isSafeInteger(version) || version < 1 || version > CURRENT_DATABASE_SCHEMA_VERSION) {
      throw new Error(`不支持的 KnowBook schema 版本 ${version}；支持 1–${CURRENT_DATABASE_SCHEMA_VERSION}。`)
    }
    const required: Record<string, string[]> = {
      documents: ['id', 'title', 'slug', 'parent_id', 'path', 'summary', 'created_at', 'updated_at'],
      blocks: ['id', 'document_id', 'type', 'content'],
      app_settings: ['key', 'value', 'updated_at']
    }
    if (version >= 9) Object.assign(required, {
      system_plugin_installations: ['id', 'plugin_id', 'enabled', 'auto_start', 'safe_mode_disabled', 'status'],
      system_plugin_runs: ['pid', 'health_json', 'status'], system_plugin_packages: ['id', 'manifest_snapshot_json']
    })
    for (const [table, columns] of Object.entries(required)) {
      const kind = db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(table) as { type: string } | undefined
      const actual = db.pragma(`table_info(${table})`) as Array<{ name: string }>
      if (kind?.type !== 'table' || columns.some((column) => !actual.some((row) => row.name === column))) {
        throw new Error(`备份不是完整的 KnowBook 数据库：${table} 表结构不匹配。`)
      }
    }
    return version
  } finally { db.close() }
}

function disableRestoredPlugins(path: string): void {
  const db = new Database(path, { fileMustExist: true })
  try {
    db.pragma('journal_mode = DELETE')
    db.transaction(() => {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_plugin_installations'").get()) {
        db.exec("UPDATE system_plugin_installations SET enabled = 0, auto_start = 0, safe_mode_disabled = 1, status = 'safe-mode-disabled'")
      }
      db.prepare('INSERT OR REPLACE INTO app_settings(key,value,updated_at) VALUES(?,?,?)')
        .run('system-plugin.safe-mode-next-boot', '1', new Date().toISOString())
    })()
  } finally { db.close() }
}

async function readCurrentIdentities(root: string, recovery: string): Promise<RestoreProcessIdentity[]> {
  const directory = join(recovery, 'inspection')
  await mkdir(directory)
  // Inspect an independent copy: opening SQLite must not checkpoint or rewrite
  // a damaged source DB, WAL or SHM before the original files are preserved.
  for (const file of FILES) {
    const current = join(root, 'storage', file)
    if (existsSync(current)) await copyFile(current, join(directory, file), constants.COPYFILE_EXCL)
  }
  if (!existsSync(join(directory, 'knowbook.db'))) return []
  let db: InstanceType<typeof Database> | undefined
  try {
    db = new Database(join(directory, 'knowbook.db'), { readonly: true, fileMustExist: true })
    const rows = db.prepare("SELECT pid, health_json FROM system_plugin_runs WHERE component = 'detached' AND pid IS NOT NULL").all() as Array<{ pid: number; health_json: string | null }>
    const result: RestoreProcessIdentity[] = []
    for (const row of rows) {
      let identity: unknown
      try { identity = JSON.parse(row.health_json ?? 'null')?.detachedProcessIdentity } catch { continue }
      if (!identity || typeof identity !== 'object') continue
      const item = identity as Record<string, unknown>
      if (item.schemaVersion === 1 && item.pid === row.pid && Number.isSafeInteger(item.pid)
        && typeof item.executable === 'string' && isAbsolute(item.executable)
        && typeof item.startToken === 'string' && item.startToken.startsWith('windows:')
        && typeof item.serviceEntry === 'string' && isAbsolute(item.serviceEntry)
        && typeof item.launchNonce === 'string' && /^[0-9a-f-]{36}$/i.test(item.launchNonce)) {
        result.push(item as unknown as RestoreProcessIdentity)
      }
    }
    return result
  } catch {
    // A corrupt DB is recoverable when OS inspection proves no profile service
    // is running. Missing identity with a live service is rejected by the guard.
    return []
  } finally { db?.close() }
}

async function rollback(userDataRoot: string, journal: RestoreJournal): Promise<void> {
  const p = paths(userDataRoot, journal.id)
  if (journal.safeModeAfterRollback) await durableJson(p.safeMarker, { id: journal.id, recoveryDirectory: p.recovery })
  // Once the staged DB was installed, any newly created sidecars belong to the
  // rejected candidate. They must never be replayed onto the original DB.
  if (!existsSync(p.staged)) {
    for (const file of FILES.filter((name) => !journal.originalFiles.includes(name))) {
      const target = join(p.storage, file)
      if (existsSync(target)) await rename(target, join(p.recovery, `rejected-${file}-${randomUUID()}`))
    }
  }
  for (const file of journal.originalFiles) {
    const original = join(p.original, file)
    const target = join(p.storage, file)
    if (!existsSync(original)) {
      if (!existsSync(target)) throw new Error(`无法回退 ${file}：原始文件与目标文件均不存在，已保留恢复日志。`)
      continue
    }
    if (existsSync(target)) await rename(target, join(p.recovery, `rejected-${file}-${randomUUID()}`))
    await rename(original, target)
  }
  await rm(p.staged, { force: true })
  if (!journal.safeModeAfterRollback && existsSync(p.safeMarker) && JSON.parse(await readFile(p.safeMarker, 'utf8')).id === journal.id) await rm(p.safeMarker)
  await durableJson(join(p.recovery, 'result.json'), { status: 'rolled-back', completedAt: new Date().toISOString() })
  await rm(p.journal)
}

/** Must run before creating any Store, worker, or plugin host on every boot. */
export async function recoverInterruptedDatabaseRestore(userDataRoot: string): Promise<boolean> {
  const journalPath = join(resolve(userDataRoot), JOURNAL)
  if (existsSync(journalPath)) {
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as RestoreJournal
    if (journal.version !== 1 || !/^[0-9a-f-]{36}$/i.test(journal.id)
      || !['moving', 'installed'].includes(journal.phase) || !Array.isArray(journal.originalFiles)
      || (journal.safeModeAfterRollback !== undefined && typeof journal.safeModeAfterRollback !== 'boolean')
      || journal.originalFiles.some((file) => !FILES.includes(file))) throw new Error('数据库恢复日志无效，请保留工作区并检查 database-restore-pending.json。')
    const p = paths(userDataRoot, journal.id)
    await ensureProfileDirectory(p.storage, p.root)
    await ensureProfileDirectory(p.original, p.root)
    if (journal.phase === 'installed') {
      try {
        verifyDatabase(p.database)
      } catch (error) {
        // The commit marker can outlive a missing/corrupt candidate after a
        // crash. Require the complete archive before beginning a retryable
        // rollback; an existing target is not proof that it is the original.
        if (journal.originalFiles.some((file) => !existsSync(join(p.original, file)))) {
          throw new Error('恢复后的数据库无效且原始文件不完整，已保留恢复日志与现有文件。', { cause: error })
        }
        journal.phase = 'moving'
        journal.safeModeAfterRollback = true
        await durableJson(p.journal, journal)
        await rollback(userDataRoot, journal)
        await durableJson(join(p.recovery, 'result.json'), {
          status: 'rolled-back', reason: String(error), completedAt: new Date().toISOString()
        })
        return true
      }
      await durableJson(p.safeMarker, { id: journal.id, recoveryDirectory: p.recovery })
      await rm(p.journal)
    } else await rollback(userDataRoot, journal)
  }
  return existsSync(join(resolve(userDataRoot), SAFE_MARKER))
}

export async function consumeDatabaseRestoreSafeMode(userDataRoot: string): Promise<void> {
  await rm(join(resolve(userDataRoot), SAFE_MARKER), { force: true })
}

export async function restoreKnowbookDatabase(input: {
  userDataRoot: string
  backupPath: string
  stopProcesses?: typeof stopDatabaseRestoreProcesses
  /** Tests inject actual filesystem failures without changing production operations. */
  beforeReplace?: () => Promise<void>
}): Promise<{ recoveryDirectory: string; sourceSha256: string; schemaVersion: number; stoppedPids: number[] }> {
  if (!isAbsolute(input.backupPath)) throw new Error('数据库备份必须使用绝对路径。')
  await recoverInterruptedDatabaseRestore(input.userDataRoot)
  const p = paths(input.userDataRoot, randomUUID())
  await ensureProfileDirectory(p.storage, p.root)
  await ensureProfileDirectory(p.original, p.root)
  const source = await lstat(input.backupPath)
  if (!source.isFile() || source.isSymbolicLink()) throw new Error('备份必须为独立的普通 SQLite 文件。')
  const sourcePhysical = await resolveSystemPluginPhysicalPath(input.backupPath)
  if (sourcePhysical.toLowerCase() === (await resolveSystemPluginPhysicalPath(p.database)).toLowerCase()) throw new Error('不能把当前工作区数据库作为恢复备份。')
  if (existsSync(`${input.backupPath}-wal`) && (await lstat(`${input.backupPath}-wal`)).size > 0) throw new Error('备份含活动 WAL；请使用 KnowBook 生成的独立 .db 安全备份。')
  let journal: RestoreJournal | null = null
  try {
    for (const file of FILES) {
      const path = join(p.storage, file)
      if (existsSync(path) && !(await lstat(path)).isFile()) throw new Error(`当前数据库文件 ${file} 不是普通文件。`)
    }
    const sourceSha256 = await digest(input.backupPath)
    await copyFile(input.backupPath, p.staged, constants.COPYFILE_EXCL)
    if (await digest(p.staged) !== sourceSha256 || await digest(input.backupPath) !== sourceSha256) throw new Error('复制期间备份发生变化，已拒绝恢复。')
    const schemaVersion = verifyDatabase(p.staged)
    const identities = await readCurrentIdentities(p.root, p.recovery)
    const stoppedPids = await (input.stopProcesses ?? stopDatabaseRestoreProcesses)({ userDataRoot: p.root, identities })
    disableRestoredPlugins(p.staged)
    verifyDatabase(p.staged)
    const stagedHandle = await open(p.staged, 'r+')
    try { await stagedHandle.sync() } finally { await stagedHandle.close() }
    journal = { version: 1, id: p.recovery.split(sep).at(-1)!, phase: 'moving', originalFiles: FILES.filter((file) => existsSync(join(p.storage, file))) }
    await durableJson(p.journal, journal)
    await durableJson(p.safeMarker, { id: journal.id, recoveryDirectory: p.recovery })
    for (const file of journal.originalFiles) await rename(join(p.storage, file), join(p.original, file))
    await input.beforeReplace?.()
    await rename(p.staged, p.database)
    journal.phase = 'installed'
    await durableJson(p.journal, journal)
    const result = { recoveryDirectory: p.recovery, sourceSha256, schemaVersion, stoppedPids }
    await durableJson(join(p.recovery, 'result.json'), { ...result, status: 'restored', completedAt: new Date().toISOString() })
    await rm(p.journal)
    return result
  } catch (error) {
    if (journal) {
      try { await rollback(p.root, journal) } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `恢复失败且回退未完成。不要修改工作区；下次启动会先恢复日志。原始文件保留在 ${p.original}`)
      }
    } else await rm(p.staged, { force: true })
    await durableJson(join(p.recovery, 'result.json'), { status: 'failed', error: String(error), completedAt: new Date().toISOString() })
    throw new Error(`数据库未替换或已回退。恢复记录：${p.recovery}\n${String(error)}`, { cause: error })
  }
}
