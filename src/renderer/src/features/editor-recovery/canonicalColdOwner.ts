import { decodeCanonicalRecoveryData, decodeCanonicalRecoveryFollowupData, type CanonicalRecoveryAcceptedFrame, type CanonicalRecoveryData } from '@shared/editor-recovery-canonical'
import type { SyncedInstanceGuard } from '@shared/synced-blocks'
import type { CompleteEditorRecoveryGroupInput } from '@shared/editor-recovery-drafts'
import type { ControllerReadOwnerContext, SyncedReadSourcesPort } from '../synced-blocks/sourceReadOwner'
import { installCanonicalRecoveryOwnerPort, type ColdCanonicalRecoveryOwner } from '../synced-blocks/canonicalRecoveryOwnerPort'
export { closeColdCanonicalRecoveryOwner } from '../synced-blocks/canonicalRecoveryOwnerPort'
type Owned = { data: CanonicalRecoveryData; context: ControllerReadOwnerContext | null; consumed: boolean; closed: boolean;
  completion: Omit<CompleteEditorRecoveryGroupInput, 'accepted'>; tracked: boolean }
type Completion = { members: readonly object[]; accepted: CanonicalRecoveryAcceptedFrame[]; input: Owned['completion'] }
const owners = new WeakMap<ColdCanonicalRecoveryOwner, Owned>(), issuer = Object.freeze({})
const completions = new WeakMap<object, Completion>()
installCanonicalRecoveryOwnerPort(issuer, {
  read(owner) { const actual = owners.get(owner); return actual && !actual.consumed && !actual.closed ? actual : null },
  consume(owner, expected) {
    const actual = owners.get(owner)
    if (!actual || actual.consumed || actual.closed || actual !== expected) return false
    actual.consumed = true; return true
  },
  close(owner) {
    const actual = owners.get(owner)
    if (!actual || actual.consumed || actual.closed) return
    actual.closed = true; actual.context?.release()
  },
  track(owner, frames) {
    const actual = owners.get(owner)
    if (!actual?.consumed || actual.tracked || !frames.length || frames.length !== actual.data.frames.length + actual.data.redoFrames.length) return
    actual.tracked = true
    const completion = { members: [...frames], accepted: [], input: actual.completion }
    for (const frame of frames) completions.set(frame, completion)
  },
  saved(frame, transactionId, input, ack) {
    const completion = completions.get(frame)
    if (!completion || completion.members[completion.accepted.length] !== frame) return
    completion.accepted.push(structuredClone({ transactionId, input, ack }))
    if (completion.accepted.length !== completion.members.length) return
    for (const member of completion.members) completions.delete(member)
    // Send only after the controller finishes its normal ACK adoption. A
    // stale owner or newer side head leaves the original retained for review.
    void Promise.resolve().then(() => window.knowbook.completeEditorRecoveryGroup({ ...completion.input, accepted: completion.accepted }))
      .catch(error => console.warn('The saved shared body draft remains retained', error))
  }
})

/** New Main owner comes only from the actual cold side head's sealed Original.
 * The private Main endpoint accepts no original key/hash from this renderer.
 * Its returned new source capability is checked and registered by the genuine
 * Source context factory, never rebuilt from a saved DTO's old ticket strings. */
export async function openColdCanonicalRecoveryOwner(recoveryOwnerId: string, sessionId: string, port: SyncedReadSourcesPort): Promise<ColdCanonicalRecoveryOwner> {
  const { captureControllerReadOwner } = await import('../synced-blocks/sourceReadOwner')
  const prepared = await window.knowbook.prepareEditorRecoveryGroup({ recoveryOwnerId, sessionId })
  if (prepared.baseline.status !== 'ready') throw new Error('The original canonical source is unavailable')
  const baseline = prepared.baseline
  let data: CanonicalRecoveryData
  try { data = decodeCanonicalRecoveryData(prepared.record, baseline, prepared.canonicalOriginalAliasVerified === true) }
  catch (error) { await port.release({ readOwnerId: baseline.readOwnerId }); throw error }
  const registered = await captureControllerReadOwner({ captureBaseline: async input => {
    if (input.groupId !== baseline.snapshot.groupId) throw new Error('A cold canonical source cannot change its actual sealed group')
    return baseline
  }, operation: input => port.operation(input), validate: input => port.validate(input), release: input => port.release(input) }, baseline.snapshot.groupId)
  if (registered.status !== 'ready') throw new Error('Actual canonical recovery context was not registered')
  try {
    const current = await port.validate({ readOwnerId: baseline.readOwnerId })
    if (current.status !== 'ready' || current.workspaceScope !== baseline.workspaceScope) throw new Error('The new canonical source owner expired')
  } catch (error) { registered.context.release(); throw error }
  const owner: ColdCanonicalRecoveryOwner = Object.freeze({ kind: 'actual-cold-canonical-recovery-owner' })
  owners.set(owner, { data, context: registered.context, consumed: false, closed: false, tracked: false,
    completion: { recoveryOwnerId, sessionId, readOwnerId: baseline.readOwnerId } }); return owner
}

/** Actual Main has proved the old A. The later branch can only use current
 * claims, so it receives no original Source owner or old ticket capability. */
export async function openColdCanonicalFollowupOwner(recoveryOwnerId: string, sessionId: string, instance: SyncedInstanceGuard): Promise<ColdCanonicalRecoveryOwner> {
  const prepared = await window.knowbook.prepareEditorRecoveryGroupFloor({ recoveryOwnerId, sessionId, instance })
  const data = decodeCanonicalRecoveryFollowupData(prepared.record, prepared.floor)
  const owner: ColdCanonicalRecoveryOwner = Object.freeze({ kind: 'actual-cold-canonical-recovery-owner' })
  owners.set(owner, { data, context: null, consumed: false, closed: false, tracked: false,
    completion: { recoveryOwnerId, sessionId } })
  return owner
}
