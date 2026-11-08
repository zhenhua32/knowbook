import type { SyncedGroupDraftState } from './types'
import type { SyncedCanonicalRecoveryFrame, SyncedCanonicalRecoveryMount } from './controller'
import { syncedCanonicalEdits } from '@shared/syncedBlockValidation'
import { canonicalSyncedPortableJson } from '@shared/syncedBlockPortable'
import { readColdCanonicalRecoveryOwner, trackCanonicalRecoveryFrames, type CanonicalRecoveryOpening, type ColdCanonicalRecoveryOwner } from './canonicalRecoveryOwnerPort'
import { readControllerRecoverySource, restoreControllerRecoveryFrame } from './recoveryReadOwnerPort'
import { dropFrame } from './sourceCopyResources'

export interface CanonicalRecoveryPlan {
  original: CanonicalRecoveryOpening; frames: SyncedCanonicalRecoveryFrame[]; redo: SyncedCanonicalRecoveryFrame[]
  sequence: number; working: SyncedGroupDraftState['working']; noop: boolean
}
const same = (left: unknown, right: unknown) => canonicalSyncedPortableJson(left) === canonicalSyncedPortableJson(right)
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}
/** Loaded only after an explicit cold restoration. Preparation allocates real
 * source-resource frame pins but does not mutate an editor. The controller's
 * actual private commit callback rechecks its mount and original state after
 * module loading and before consuming the opaque Main-derived owner. */
export function restoreCanonicalRecovery(owner: ColdCanonicalRecoveryOwner, before: SyncedGroupDraftState,
  mount: SyncedCanonicalRecoveryMount, commit: (plan: CanonicalRecoveryPlan) => boolean): boolean {
  const original = readColdCanonicalRecoveryOwner(owner)
  if (!original || !same(before.snapshot, original.data.baseline)) return false
  const context = original.context
  if (context) {
    const source = readControllerRecoverySource(context)
    if (!source || source.workspaceScope !== original.data.record.base.workspaceScope || !same(source.snapshot, original.data.baseline)) return false
  } else if ([...original.data.frames, ...original.data.redoFrames].some(frame =>
    frame.bindingClaims?.some(claim => claim.kind === 'copy' && claim.source.kind === 'ticket'))) return false
  const frames: SyncedCanonicalRecoveryFrame[] = [], redo: SyncedCanonicalRecoveryFrame[] = []
  let sequence = before.editSequence, adopted = false
  try {
    const createFrame = (frame: typeof original.data.frames[number]): SyncedCanonicalRecoveryFrame => {
      const copyLease = context && frame.bindingClaims ? restoreControllerRecoveryFrame(context, frame.bindingClaims) : null
      return { before: immutable(structuredClone(frame.before)), after: immutable(structuredClone(frame.after)),
        ...(frame.bindingClaims === undefined ? {} : { bindingClaims: immutable(structuredClone(frame.bindingClaims)) }), copyLease,
        mount, instance: { instanceId: mount.lease.instanceId, hostDocumentId: mount.lease.hostDocumentId, bindingVersion: mount.lease.bindingVersion },
        transactionId: frame.transactionId, sequence: ++sequence, sealed: true, beforeBookmark: null, afterBookmark: null }
    }
    for (const frame of original.data.frames) frames.push(createFrame(frame))
    for (const frame of [...original.data.redoFrames].reverse()) redo.unshift(createFrame(frame))
    adopted = commit({ original, frames, redo, sequence,
      working: frames.at(-1)?.after ?? immutable(syncedCanonicalEdits(original.data.baseline.blocks)),
      noop: !frames.length && !redo.length && !original.data.cutServerRedo })
    if (adopted) trackCanonicalRecoveryFrames(owner, [...frames, ...[...redo].reverse()])
    return adopted
  } finally { if (!adopted) for (const frame of [...frames, ...redo]) if (frame.copyLease) dropFrame(frame.copyLease) }
}
