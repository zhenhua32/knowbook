import type Database from 'better-sqlite3'
import type { SyncedRestoreHostInput, SyncedStructureInput } from '../../shared/synced-blocks'
import type { HostContent } from './synced-host-document-read'

type BatchMoveDraft = { apply: SyncedStructureInput; working: HostContent }
export type CrossMoveDraftCheck = (documentId: string, current: HostContent, operation?: SyncedRestoreHostInput | BatchMoveDraft) => boolean
const callbacks = new WeakMap<Database.Database, CrossMoveDraftCheck>()

/** Only the live Main ingress installs a checker over its actual side-store.
 * The existing v4 methods and original ACK lookups do not require this scope. */
export function withCrossMoveDraftCheck<T>(db: Database.Database, check: CrossMoveDraftCheck, run: () => T): T {
  if (db.inTransaction || callbacks.has(db)) throw new Error('Recursive third-page draft inspection')
  callbacks.set(db, check)
  try { return run() } finally { callbacks.delete(db) }
}

export function checkCrossMoveDraftOwned(db: Database.Database, documentId: string, current: HostContent,
  inverse?: SyncedRestoreHostInput): boolean {
  return db.inTransaction && callbacks.get(db)?.(documentId, current, inverse) === true
}

export function checkBatchMoveDraftOwned(db: Database.Database, documentId: string, current: HostContent,
  operation: SyncedRestoreHostInput | BatchMoveDraft): boolean {
  const check = callbacks.get(db)
  return db.inTransaction && (!check || check(documentId, current, operation))
}
