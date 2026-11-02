import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

/** Full original SQL business/history/effective-owner revision. Only this
 * producer's own publication state is excluded: backup must not self-trigger. */
export function readCanonicalBackupRevision(db: Database.Database): string {
  if (!db.open) throw new Error('Backup revision requires the actual open database.')
  if (!db.inTransaction) return db.transaction(() => readCanonicalBackupRevision(db))()
  const hash = createHash('sha256').update('knowbook.canonical-backup-content-revision.v1\0')
  function rows(table: string, condition = '', columns?: string[]): void {
    const names = columns ?? (db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{name:string}>).map(row => row.name)
    const query = names.flatMap((name, index) => [name, 'typeof(' + name + ') AS t_' + index, 'CAST(' + name + ' AS BLOB) AS b_' + index]).join(',')
    hash.update(JSON.stringify([table, names]) + '\0')
    for (const row of db.prepare('SELECT ' + query + ' FROM ' + table + condition + ' ORDER BY rowid').safeIntegers().iterate() as Iterable<Record<string,unknown>>) {
      const values = names.map((name, index) => {
        const type = row['t_' + index], value = row[name], bytes = row['b_' + index]
        if (type === 'null') return [type]
        if (type === 'text' || type === 'blob') {
          if (!Buffer.isBuffer(bytes)) throw new Error('Backup revision original bytes unavailable.')
          return [type, bytes.toString('base64')]
        }
        if (type === 'integer' && typeof value === 'bigint' || type === 'real' && typeof value === 'number') return [type, value.toString()]
        throw new Error('Backup revision encountered an unexpected SQL storage class.')
      })
      hash.update(JSON.stringify(values) + '\0')
    }
  }
  for (const table of ['documents','blocks','databases','document_database_columns','database_saved_views','database_entities','database_entity_values','document_database_values',
    'synced_workspace_state','synced_groups','synced_group_blocks','synced_instances','block_identities','synced_operations','synced_group_history',
    'synced_host_history','synced_host_history_documents','synced_host_history_state','synced_group_pins','synced_group_retirements']) rows(table)
  // Claim/confirmation change only exposure_state/state_version/updated_at.
  rows('synced_group_lifecycle', '', ['group_id','creation_id','state','create_history_id','activation_revision','activation_topology_revision','activation_hash','activation_instances_json','created_at'])
  rows('synced_exposure_attempts', " WHERE channel <> 'backup-v3'")
  rows('synced_group_exposure_members', " WHERE attempt_id IN (SELECT id FROM synced_exposure_attempts WHERE channel <> 'backup-v3')")
  rows('app_settings', " WHERE key='database.defaultId' OR (substr(key,1,7)='synced.' AND substr(key,1,17)<>'synced.backup.v3.' )")
  return hash.digest('hex')
}
