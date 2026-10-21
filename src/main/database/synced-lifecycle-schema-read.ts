import type Database from 'better-sqlite3'
import { assertSyncedLifecycleSchemaMetadata } from './synced-lifecycle-schema-metadata'
import { assertSyncedLifecycleCoverage } from './synced-lifecycle-state'
import { assertSyncedRemoteObservationRecords } from './synced-remote-observation-read'

/** No DDL or data repairs. Schema-26 authority is verified separately and stays
 * byte-for-byte unchanged; these checks only add the schema-27 namespace. */
export function assertSyncedLifecycleSchema(db: Database.Database): void {
  assertSyncedLifecycleSchemaMetadata(db)
  assertSyncedLifecycleCoverage(db)
  assertSyncedRemoteObservationRecords(db)
}
