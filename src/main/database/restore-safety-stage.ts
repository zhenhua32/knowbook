import { createRequire } from 'node:module'
import { KnowbookStore } from './store'
import { inspectOrdinaryRestoreConnection, inspectOrdinaryRestoreDatabase, assertControlledRestoreReceipt, type RestoreDatabaseInspection } from './restore-safety-read'
import { restoreFail, restoreJson, restoreReceiptKey, type RestoreReceipt } from './restore-safety-model'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

/** Only the private copy is opened by the existing migration/safety-copy owner. */
export function migrateControlledRestoreStage(path: string, sourceSchemaVersion: number): RestoreDatabaseInspection {
  if (sourceSchemaVersion < 27) {
    const store = new KnowbookStore(restoreSqliteFilename(path))
    store.destroy()
  }
  const db = new Database(restoreSqliteFilename(path),{fileMustExist:true})
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.pragma('journal_mode = DELETE')
    const actual = db.transaction(()=>inspectOrdinaryRestoreConnection(db))()
    if (actual.schemaVersion !== 27 || actual.workspaceScope === null || actual.recoveryEpoch === null) return restoreFail('原迁移owner未产出完整27 namespace。')
    return actual
  } finally { db.close() }
}

/** No generic caller epoch or plan is exposed by the public maintenance API. */
export function finalizeControlledRestoreStage(path: string, receipt: RestoreReceipt): void {
  const db = new Database(restoreSqliteFilename(path),{fileMustExist:true})
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = DELETE')
    db.transaction(()=>{
      const before = inspectOrdinaryRestoreConnection(db)
      if (before.schemaVersion !== 27 || before.recoveryEpoch === receipt.recoveryEpoch
        || before.documentVersions.includes(receipt.documentBoundary)) return restoreFail('固定新epoch/CAS与旧stage不分离。')
      if (db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(restoreReceiptKey(receipt.operationId))) return restoreFail('本次restore operation已占用。')
      const changed = db.prepare('UPDATE synced_workspace_state SET workspace_scope=?,recovery_epoch=? WHERE singleton=1')
        .run(receipt.workspaceScope,receipt.recoveryEpoch)
      if (changed.changes !== 1) return restoreFail('stage workspace singleton变化。')
      db.prepare('UPDATE documents SET updated_at=?').run(receipt.documentBoundary)
      db.exec("UPDATE system_plugin_installations SET enabled=0,auto_start=0,safe_mode_disabled=1,status='safe-mode-disabled'")
      db.prepare('INSERT OR REPLACE INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('system-plugin.safe-mode-next-boot','1',receipt.acceptedAt)
      db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(restoreReceiptKey(receipt.operationId),restoreJson(receipt),receipt.acceptedAt)
      const final = inspectOrdinaryRestoreConnection(db)
      if (final.workspaceScope !== receipt.workspaceScope || final.recoveryEpoch !== receipt.recoveryEpoch
        || final.documentCas.some(value=>value !== receipt.documentBoundary)) return restoreFail('stage epoch/CAS实际SQL终检不闭合。')
    }).immediate()
  } finally { db.close() }
  assertControlledRestoreReceipt(path,receipt)
  if (inspectOrdinaryRestoreDatabase(path).schemaVersion !== 27) return restoreFail('stage关闭重开后版本变化。')
}
