import type Database from 'better-sqlite3'
import { publicationInvalid } from '../sync/synced-publication-model'
import { assertSyncedBlockSchema } from './synced-schema'
import { assertSyncedLifecycleCoverage } from './synced-lifecycle-state'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'
import { readRawSyncedPersistentPublicationSnapshotOwned, type SyncedPublicationLocalSnapshot } from './synced-publication-raw-read'

/** Readonly SQL integrity checks copied from the public reader. This leaf
 * neither consults effective recovery knowledge nor creates admission authority. */
export function assertRawSyncedPublicationSqlStructureOwned(db: Database.Database): void {
  if (!db.inTransaction) return publicationInvalid('完整持久图读取须位于调用方自有一致事务。')
  assertSyncedBlockSchema(db); assertSyncedLifecycleCoverage(db)
  const foreignKeys = db.pragma('foreign_key_check')
  if (!Array.isArray(foreignKeys) || foreignKeys.length) return publicationInvalid('完整数据库存在外键损坏。')
  // The old public group wrapper checked this in every group batch. Keep
  // admission here when the raw core no longer calls that capability wrapper;
  // an empty graph must not hide an orphan recovery marker/anchor either.
  if ((db.pragma('user_version', { simple: true }) as number) >= 27) assertSyncedRecoveryBoundaryRecords(db)
}

/** Validated original facts only; public writers retain their own admission. */
export function readRawValidatedSyncedPersistentPublicationSnapshotOwned(db: Database.Database): SyncedPublicationLocalSnapshot {
  assertRawSyncedPublicationSqlStructureOwned(db)
  return readRawSyncedPersistentPublicationSnapshotOwned(db)
}
