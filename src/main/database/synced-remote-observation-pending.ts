import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { observationCorrupt, observationJson, observationKey, validateObservedIncarnation, type SyncedObservedIncarnation } from './synced-remote-observation-codec'

/** Rejection-only leases: no remote proof, DB writer or caller cleanup callback. */
export interface SyncedObservationPendingLease { readonly kind: 'synced-observation-pending-lease' }
type Held = { path: string; tuple: SyncedObservedIncarnation }
const leases = new WeakMap<SyncedObservationPendingLease, Held>()
const held = new Map<string, Set<SyncedObservationPendingLease>>()
export function hasAnySyncedObservationPending(): boolean { return held.size !== 0 }
export function observationDatabasePath(value: string): string {
  const canonical = resolve(realpathSync(value)); return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}
const key = (path: string, tuple: SyncedObservedIncarnation): string => observationJson([path, observationKey(tuple)])
function heldPath(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) return observationCorrupt('pending 必须使用原 canonical DB 路径')
  const path = resolve(value); return process.platform === 'win32' ? path.toLowerCase() : path
}
export function holdSyncedObservationPending(databasePath: string, incarnation: SyncedObservedIncarnation): SyncedObservationPendingLease {
  const tuple = validateObservedIncarnation(JSON.parse(observationJson(validateObservedIncarnation(incarnation)))), path = heldPath(databasePath)
  Object.freeze(tuple.origin); Object.freeze(tuple)
  const lease = Object.freeze({ kind: 'synced-observation-pending-lease' as const }), saved = { path, tuple }
  leases.set(lease, saved)
  const index = key(path, tuple), entries = held.get(index) ?? new Set<SyncedObservationPendingLease>()
  entries.add(lease); held.set(index, entries); return lease
}
export function releaseSyncedObservationPending(lease: SyncedObservationPendingLease): boolean {
  const saved = leases.get(lease)
  if (!saved) return false
  leases.delete(lease)
  const index = key(saved.path, saved.tuple), entries = held.get(index)
  entries?.delete(lease); if (entries?.size === 0) held.delete(index)
  return true
}
export function hasSyncedObservationPending(databasePath: string, incarnation: SyncedObservedIncarnation): boolean {
  const tuple = validateObservedIncarnation(incarnation), entries = held.get(key(heldPath(databasePath), tuple))
  if (!entries?.size) return false
  for (const lease of entries) {
    const saved = leases.get(lease)
    if (!saved || observationJson(saved.tuple) !== observationJson(tuple)) return observationCorrupt('已知本机 pending tuple 被替换')
  }
  return true
}
