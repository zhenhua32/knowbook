import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, toNamespacedPath } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repository, profile, backup, mode, transcript] = process.argv.slice(2)
const modes = ['move-db', 'move-wal', 'move-shm', 'stage-epoch', 'stage-receipt', 'result-error', 'cleanup-error', 'installed', 'recover']
if (![repository, profile, backup, transcript].every(value => typeof value === 'string' && isAbsolute(value)) || !modes.includes(mode)) throw new Error('Invalid controlled restore fault child arguments')
const require = createRequire(join(repository, 'package.json')), Database = require('better-sqlite3')
const fsPromises = require('node:fs/promises')
const source = join(repository, 'src/main/database/restore-maintenance.ts')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const note = { pid: process.pid, mode, sourceSHA256: hash(readFileSync(source)),
  safetySHA256: hash(readFileSync(join(repository, 'src/main/database/restore-safety.ts'))), scriptSHA256: hash(readFileSync(new URL(import.meta.url))) }
let injected = false, witness = null
const save = value => writeFileSync(transcript, JSON.stringify({ ...note, injected, witness, ...value }, null, 2) + '\n')
const errorFact = error => error && typeof error === 'object' ? { name: error.name, message: error.message, code: error.code ?? null,
  cause: error.cause === undefined ? null : errorFact(error.cause), errors: Array.isArray(error.errors) ? error.errors.map(errorFact) : [] } : String(error)
const json = path => JSON.parse(readFileSync(path, 'utf8'))
function connectionFacts(db) {
  return { workspace: db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get(),
    documents: db.prepare('SELECT id,updated_at FROM documents ORDER BY id').all(),
    receipts: db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'database.restore.receipt.%' ORDER BY key").all() }
}
function stageFacts(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try { return connectionFacts(db) } finally { db.close() }
}
function installedWitness() {
  const pointer = json(join(profile, 'database-restore-pending.json')), fence = json(join(profile, 'database-restore-fence.json'))
  if (pointer.kind !== 'controlled-database-restore-journal' || pointer.version !== 2 || pointer.phase !== 'installed'
    || fence.phase !== 'installed' || fence.operationId !== pointer.operationId) throw new Error('Injected completion fault did not follow the actual installed journal and fence')
  const actual = stageFacts(join(profile, 'storage', 'knowbook.db'))
  const receipt = actual.receipts.find(row => row.key === 'database.restore.receipt.' + pointer.operationId)
  if (!receipt) throw new Error('Injected completion fault did not follow the actual installed SQL receipt')
  return { pointer, fence, actual, databaseSHA256: hash(readFileSync(join(profile, 'storage', 'knowbook.db'))) }
}
const nativeRename = fsPromises.rename, nativeRm = fsPromises.rm, nativePrepare = Database.prototype.prepare
// No file bytes are changed before sourceStage's exact copy hash check. This
// intercept is immediately before the actual owned SQL prepares its statement;
// TEMP triggers are connection-local and the SQLite engine raises the failure.
Database.prototype.prepare = function (sql, ...rest) {
  if (!injected && mode.startsWith('stage-')) {
    const target = resolve(this.name), inside = relative(toNamespacedPath(resolve(profile, 'backups', 'database-restore')), toNamespacedPath(target)).split(/[\\/]/)
    if (inside.length === 2 && /^[0-9a-f-]{36}$/i.test(inside[0]) && inside[1] === 'candidate.db') {
      if (sql === 'UPDATE synced_workspace_state SET workspace_scope=?,recovery_epoch=? WHERE singleton=1') {
        witness = { stage: target, before: connectionFacts(this), nativeTrigger: mode, inTransaction: this.inTransaction }
        if (mode === 'stage-epoch') {
          this.exec("CREATE TEMP TRIGGER controlled_restore_test_epoch_abort BEFORE UPDATE OF workspace_scope,recovery_epoch ON main.synced_workspace_state BEGIN SELECT RAISE(ABORT,'controlled-stage-epoch-abort'); END")
          injected = true
        }
      }
      if (mode === 'stage-receipt' && witness !== null && sql === 'INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)') {
        this.exec("CREATE TEMP TRIGGER controlled_restore_test_receipt_abort BEFORE INSERT ON main.app_settings WHEN substr(NEW.key,1,25)='database.restore.receipt.' BEGIN SELECT RAISE(ABORT,'controlled-stage-receipt-abort'); END")
        injected = true
      }
    }
  }
  return nativePrepare.call(this, sql, ...rest)
}
fsPromises.rename = async function (from, to) {
  const target = resolve(String(to))
  if (!injected && mode === 'result-error' && target.endsWith('result.json') && dirname(dirname(dirname(target))) === join(profile, 'backups')) {
    witness = installedWitness(); injected = true
    const error = new Error('controlled-installed-result-EIO'); error.code = 'EIO'; throw error
  }
  const result = await nativeRename.call(this, from, to)
  if (!injected && mode === 'installed' && target === join(profile, 'database-restore-pending.json')) {
    const pointer = json(target)
    if (pointer.kind === 'controlled-database-restore-journal' && pointer.version === 2 && pointer.phase === 'installed') {
      injected = true; witness = { pointer, actual: stageFacts(join(profile, 'storage', 'knowbook.db')) }
      save({ interrupted: true }); process.exit(74)
    }
  }
  if (!injected && mode.startsWith('move-')) {
    const name = { 'move-db': 'knowbook.db', 'move-wal': 'knowbook.db-wal', 'move-shm': 'knowbook.db-shm' }[mode]
    const pointer = existsSync(join(profile, 'database-restore-pending.json')) ? json(join(profile, 'database-restore-pending.json')) : null
    if (pointer?.kind === 'controlled-database-restore-journal' && pointer.version === 2 && pointer.phase === 'moving'
      && resolve(String(from)) === join(profile, 'storage', name)
      && target === join(profile, 'backups', 'database-restore', pointer.operationId, 'original', name)) {
      injected = true; witness = { pointer, from: resolve(String(from)), to: target, archivedSHA256: hash(readFileSync(target)) }
      save({ interrupted: true }); process.exit({ 'move-db': 76, 'move-wal': 77, 'move-shm': 78 }[mode])
    }
  }
  return result
}
fsPromises.rm = async function (path, ...rest) {
  if (!injected && mode === 'cleanup-error' && resolve(String(path)) === join(profile, 'database-restore-pending.json')) {
    witness = installedWitness(); injected = true
    const error = new Error('controlled-installed-cleanup-EIO'); error.code = 'EIO'; throw error
  }
  return nativeRm.call(this, path, ...rest)
}
syncBuiltinESMExports()
const api = await import(pathToFileURL(source).href)
try {
  if (mode === 'recover') save({ recovered: await api.recoverInterruptedDatabaseRestore(profile) })
  else {
    const result = await api.restoreKnowbookDatabase({ userDataRoot: profile, backupPath: backup, stopProcesses: async () => [] })
    save({ unexpectedCompletion: true, result }); process.exitCode = 2
  }
} catch (error) {
  const after = mode.startsWith('stage-') && witness?.stage && existsSync(witness.stage) ? stageFacts(witness.stage) : null
  save({ caught: true, error: errorFact(error), after })
  process.exitCode = injected && ['stage-epoch', 'stage-receipt', 'result-error', 'cleanup-error'].includes(mode) ? 0 : 1
}
