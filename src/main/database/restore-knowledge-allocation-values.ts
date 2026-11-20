import Database from 'better-sqlite3'
import { graph3Conflict } from './restore-knowledge-graph3-data'

type Domain = 'identity' | 'document-time' | 'current-physical-block'

export interface StoredRestoreAllocationValues {
  add(domain: Domain, value: string): boolean
  has(domain: Domain, value: string): boolean
}

/** Only membership leaves the file-backed index. Keep JavaScript's exact
 * string equality, including NUL characters and UTF-16 code units. */
export function withStoredRestoreAllocationValues<T>(run: (values: StoredRestoreAllocationValues) => T): T {
  const db = new Database(':memory:')
  try {
    db.pragma('temp_store=FILE')
    if (db.pragma('temp_store', { simple: true }) !== 1) return graph3Conflict('restore-allocation-file-unavailable', null)
    db.pragma('temp.cache_size=-2048')
    db.exec('CREATE TEMP TABLE allocation_values (domain TEXT NOT NULL, code_units BLOB NOT NULL, PRIMARY KEY(domain,code_units)) WITHOUT ROWID')
    const insert = db.prepare('INSERT OR IGNORE INTO temp.allocation_values VALUES (?,?)')
    const find = db.prepare('SELECT 1 FROM temp.allocation_values WHERE domain=? AND code_units=?').pluck()
    return db.transaction(() => run({
      add: (domain, value) => insert.run(domain, Buffer.from(value, 'utf16le')).changes === 1,
      has: (domain, value) => find.get(domain, Buffer.from(value, 'utf16le')) === 1
    }))()
  } finally { db.close() }
}
