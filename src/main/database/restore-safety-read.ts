import { createRequire } from 'node:module'
import type Sqlite from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { assertSyncedBlockSchema } from './synced-schema'
import { assertSyncedLifecycleSchema } from './synced-lifecycle-schema'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { parseRestoreJson, restoreFail, restoreJson, restoreReceiptKey, validateRestoreReceipt, type RestoreReceipt } from './restore-safety-model'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const syncedTables = ['synced_groups','synced_group_blocks','synced_instances','synced_operations','synced_group_history',
  'synced_host_history','synced_host_history_documents','synced_host_history_state','synced_group_pins',
  'synced_group_lifecycle','synced_group_retirements','synced_exposure_attempts','synced_group_exposure_members']
export interface RestoreDatabaseInspection { schemaVersion: number; workspaceScope: string | null; recoveryEpoch: string | null; documentVersions: string[]; documentCas: string[] }
export class RestoreUnreadableDatabase extends Error {
  constructor(cause: unknown) { super('原数据库物理损坏，无法安全认证同步知识为空。', { cause }) }
}
function physicalFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false
  return typeof error.code === 'string' && (error.code === 'SQLITE_NOTADB' || error.code.startsWith('SQLITE_CORRUPT'))
}
function table(db: Sqlite.Database, name: string): boolean {
  const row = db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(name) as {type:string} | undefined
  if (row && row.type !== 'table') return restoreFail('预期表被替换：' + name)
  return Boolean(row)
}
function drafts(value: unknown): boolean {
  return Array.isArray(value) && value.some(row => row !== null && typeof row === 'object' && 'type' in row && row.type === 'synced-block')
}
function historyJson(source: unknown): unknown {
  if (typeof source !== 'string') return restoreFail('普通历史原JSON不是字符串。')
  try { return JSON.parse(source) } catch (cause) { throw new Error('普通历史原JSON损坏；不会当作同步历史为空。', { cause }) }
}
function contentHasGroup(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'blocks' in value && drafts(value.blocks)
}
function assertHistoryOrdinary(db: Sqlite.Database, versions: Set<string>): void {
  if (table(db,'document_history')) for (const row of db.prepare('SELECT content_json FROM document_history').all() as Array<{content_json:string}>) {
    if (contentHasGroup(historyJson(row.content_json))) return restoreFail('普通历史仍含同步块来源，不能作为ordinary恢复。')
  }
  if (table(db,'document_trash')) for (const row of db.prepare('SELECT snapshot_json FROM document_trash').all() as Array<{snapshot_json:string}>) {
    const value = historyJson(row.snapshot_json)
    if (value !== null && typeof value === 'object' && 'content' in value && contentHasGroup(value.content)) return restoreFail('回收站含同步块来源。')
  }
  if (table(db,'document_block_moves')) for (const row of db.prepare('SELECT before_json,after_json,expected_versions_json FROM document_block_moves').all() as Array<{before_json:string;after_json:string;expected_versions_json:string}>) {
    for (const raw of [row.before_json,row.after_json]) {
      const sides = historyJson(raw)
      if (!Array.isArray(sides)) return restoreFail('成对移动原snapshot不是集合。')
      if (sides.some(value => value !== null && typeof value === 'object' && 'content' in value && contentHasGroup(value.content))) return restoreFail('成对移动含同步块来源。')
    }
    const expected = historyJson(row.expected_versions_json)
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return restoreFail('成对移动原CAS表损坏。')
    for (const value of Object.values(expected)) {
      if (typeof value !== 'string') return restoreFail('成对移动原CAS不是字符串。')
      versions.add(value)
    }
  }
}
/** Strict actual rows; existence rejects without parsing a marker into an empty result. */
function inspectRestoreConnection(db: Sqlite.Database, ordinary: boolean): RestoreDatabaseInspection {
  if (!db.open || !db.inTransaction) return restoreFail('库检查要求真实自有快照。')
  const integrity = db.pragma('integrity_check', { simple:true })
  if (integrity !== 'ok') return restoreFail('integrity_check未通过；可读约束／语义坏报告不能降为灾难空知识。'+String(integrity))
  const version: unknown = db.pragma('user_version', { simple:true })
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > 27) return restoreFail('不支持的schema版本。')
  if ((db.pragma('foreign_key_check') as unknown[]).length) return restoreFail('外键不完整。')
  const required: Record<string,string[]> = {
    documents:['id','title','slug','parent_id','path','summary','created_at','updated_at'], blocks:['id','document_id','type','content'], app_settings:['key','value','updated_at']
  }
  if (version >= 9) Object.assign(required, { system_plugin_installations:['id','plugin_id','enabled','auto_start','safe_mode_disabled','status'],
    system_plugin_runs:['pid','health_json','status'], system_plugin_packages:['id','manifest_snapshot_json'] })
  for (const [name,columns] of Object.entries(required)) {
    if (!table(db,name)) return restoreFail('缺原KnowBook表：'+name)
    const actual = new Set((db.pragma(`table_info(${name})`) as Array<{name:string}>).map(row=>row.name))
    if (columns.some(column=>!actual.has(column))) return restoreFail('原KnowBook列不完整：'+name)
  }
  const namespace = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7)='synced_'").all() as Array<{name:string}>
  const known = new Set(['synced_workspace_state',...syncedTables])
  if (namespace.some(row=>version < 26 || !known.has(row.name))) return restoreFail('未知／错版本同步namespace。')
  if (version >= 26) {
    assertSyncedBlockSchema(db)
    if (version >= 27) assertSyncedLifecycleSchema(db)
  }
  for (const name of syncedTables) if (ordinary && table(db,name) && db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()) return restoreFail('尚不支持恢复包含同步块正文或同步知识／历史的数据库：'+name)
  if (ordinary && db.prepare("SELECT 1 FROM blocks WHERE type='synced-block' LIMIT 1").get()) return restoreFail('原physical仍含同步实例。')
  for (const prefix of ordinary ? ['sync.webdav.protocol5.','synced.backup.v3.'] : []) {
    if (db.prepare('SELECT 1 FROM app_settings WHERE substr(key,1,?)=? LIMIT 1').get(prefix.length,prefix)) return restoreFail('原同步私有metadata仍存在：'+prefix)
  }
  let workspaceScope: string | null = null, recoveryEpoch: string | null = null
  if (version >= 26) {
    const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as {workspace_scope:unknown;recovery_epoch:unknown} | undefined
    if (!row || !isSyncedUuid(row.workspace_scope) || !isSyncedUuid(row.recovery_epoch)) return restoreFail('工作区scope/epoch损坏。')
    workspaceScope = row.workspace_scope; recoveryEpoch = row.recovery_epoch
    if (ordinary && db.prepare("SELECT 1 FROM block_identities WHERE last_owner_kind='group' LIMIT 1").get()) return restoreFail('仍保同步owner身份。')
    if (ordinary && (db.prepare(`SELECT 1 FROM blocks b LEFT JOIN block_identities i ON i.id=b.id
      WHERE i.id IS NULL OR i.state<>'live' OR i.last_owner_kind<>'document' OR i.last_owner_id<>b.document_id OR i.created_at IS NOT b.created_at LIMIT 1`).get()
      || db.prepare(`SELECT 1 FROM block_identities i LEFT JOIN blocks b ON b.id=i.id
        WHERE i.state='live' AND (b.id IS NULL OR i.last_owner_kind<>'document' OR i.last_owner_id<>b.document_id OR i.created_at IS NOT b.created_at) LIMIT 1`).get())) return restoreFail('普通稳定身份与实际physical不一致。')
  }
  const documentCas=(db.prepare('SELECT updated_at FROM documents').all() as Array<{updated_at:string}>).map(row=>row.updated_at)
  const versions = new Set(documentCas)
  if (ordinary) assertHistoryOrdinary(db,versions)
  const prefix = 'database.restore.receipt.'
  for (const row of db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length,prefix) as Array<{key:string;value:string;updated_at:string}>) {
    const receipt = validateRestoreReceipt(parseRestoreJson(row.value))
    if (row.key !== restoreReceiptKey(receipt.operationId) || row.updated_at !== receipt.acceptedAt) return restoreFail('原restore receipt列／key被替换。')
  }
  return {schemaVersion:version,workspaceScope,recoveryEpoch,documentVersions:[...versions],documentCas}
}
export function inspectOrdinaryRestoreConnection(db: Sqlite.Database): RestoreDatabaseInspection { return inspectRestoreConnection(db,true) }
export function inspectOrdinaryRestoreDatabase(path: string): RestoreDatabaseInspection {
  let db: Sqlite.Database | undefined
  try {
    db = new Database(restoreSqliteFilename(path),{readonly:true,fileMustExist:true})
    return db.transaction(()=>inspectOrdinaryRestoreConnection(db!))()
  } catch (error) {
    if (physicalFailure(error)) throw new RestoreUnreadableDatabase(error)
    throw error
  } finally { db?.close() }
}
export function assertControlledRestoreReceipt(path: string, expected: RestoreReceipt): RestoreDatabaseInspection {
  let db: Sqlite.Database | undefined
  try {
    db = new Database(restoreSqliteFilename(path),{readonly:true,fileMustExist:true})
    const current = db
    return current.transaction(()=>{
    const inspection = inspectRestoreConnection(current,false)
    const row = current.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(restoreReceiptKey(expected.operationId)) as {value:string;updated_at:string} | undefined
    if (!row || row.value !== restoreJson(expected) || row.updated_at !== expected.acceptedAt
      || inspection.schemaVersion !== 27 || inspection.workspaceScope !== expected.workspaceScope || inspection.recoveryEpoch !== expected.recoveryEpoch) return restoreFail('已安装库未持有准确原receipt/scope/epoch。')
    return inspection
    })()
  } catch(error) { if(physicalFailure(error))throw new RestoreUnreadableDatabase(error);throw error }
  finally { db?.close() }
}
