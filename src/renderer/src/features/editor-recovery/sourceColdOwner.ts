import { readOrdinaryHostRecoverySource, sameOrdinaryRecoveryPhysicalHost } from '@shared/editor-recovery-source'
import type { SyncedHostSourceCurrent } from '../synced-blocks/SyncedHostSourceDialog'

export interface ColdHostSourceOwner { readonly kind: 'actual-cold-host-source-owner' }
const owners = new WeakMap<ColdHostSourceOwner, ReturnType<typeof readOrdinaryHostRecoverySource>>()
/** A genuine Main cold decision is the only mint path. Calling a renderer
 * factory with equal JSON/text cannot register one of these handles. */
export async function openColdHostSourceOwner(recoveryOwnerId: string): Promise<ColdHostSourceOwner> {
  const record = await window.knowbook.decideEditorRecoveryDraft({ recoveryOwnerId, decision: 'restore-draft' })
  if (!record) throw new Error('The actual restored Source record is unavailable')
  const decoded = readOrdinaryHostRecoverySource(record), owner: ColdHostSourceOwner = Object.freeze({ kind: 'actual-cold-host-source-owner' })
  owners.set(owner, decoded); return owner
}
export function readColdHostSourceOwner(owner: ColdHostSourceOwner, current: SyncedHostSourceCurrent) {
  const actual = owners.get(owner)
  if (!actual || !current.hostSession || actual.current.opening.documentId !== current.host.documentId
    || actual.current.opening.expectedPersistedUpdatedAt !== current.host.expectedPersistedUpdatedAt
    || !sameOrdinaryRecoveryPhysicalHost(actual.current.opening.workingBefore, current.host.workingBefore)) throw new Error('The original cold Source owner or unchanged actual UI visit is unavailable')
  return actual
}
