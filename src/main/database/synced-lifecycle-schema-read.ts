import type Database from 'better-sqlite3'
import { assertSyncedLifecycleSchemaMetadata } from './synced-lifecycle-schema-metadata'
import { assertSyncedLifecycleCoverage } from './synced-lifecycle-state'
import { assertSyncedRemoteObservationRecords, readSyncedRemoteObservationWithCoverageOwned } from './synced-remote-observation-read'

/** No DDL or data repairs. Schema-26 authority is verified separately and stays
 * byte-for-byte unchanged; these checks only add the schema-27 namespace. */
export function assertSyncedLifecycleSchema(db: Database.Database): void {
  assertSyncedLifecycleSchemaMetadata(db)
  assertSyncedLifecycleCoverage(db)
  assertSyncedRemoteObservationRecords(db)
}

/** Schema and paired SQL facts for a Main owner that separately checks its
 * installed profile. The returned coverage references remain unresolved. */
export function readSyncedLifecycleSchemaWithCoverageOwned(db: Database.Database) {
  const coverage = readSyncedRemoteObservationWithCoverageOwned(db)
  assertSyncedLifecycleSchemaMetadata(db)
  assertSyncedLifecycleCoverage(db)
  return coverage
}
