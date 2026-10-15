import type { DatabaseEmbedSnapshot } from '@shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '@shared/database-workspace'
import type { DatabaseViewBlockPayloadV1 } from '@shared/databaseViewBlock'

export function defaultDatabaseEmbedPayload(snapshot: Extract<DatabaseEmbedSnapshot, { status: 'ready' }>): DatabaseViewBlockPayloadV1 {
  const ids = [DATABASE_SYSTEM_FIELD_IDS.title, ...snapshot.columns.slice(0, 64).map(column => column.id),
    snapshot.database.kind === 'document-catalog' ? DATABASE_SYSTEM_FIELD_IDS.path : DATABASE_SYSTEM_FIELD_IDS.document,
    DATABASE_SYSTEM_FIELD_IDS.updatedAt]
  return { version: 1, databaseId: snapshot.database.id, viewId: null,
    config: createDefaultDatabaseViewConfig('table', ids) }
}
