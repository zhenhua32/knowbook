import type { CanonicalRecoveryAcceptedFrame, CanonicalRecoveryData } from '@shared/editor-recovery-canonical'
import type { ControllerReadOwnerContext } from './sourceReadOwner'
export interface ColdCanonicalRecoveryOwner { readonly kind: 'actual-cold-canonical-recovery-owner' }
export type CanonicalRecoveryOpening = Readonly<{ data: CanonicalRecoveryData; context: ControllerReadOwnerContext | null }>
interface Port {
  read: (owner: ColdCanonicalRecoveryOwner) => CanonicalRecoveryOpening | null
  consume: (owner: ColdCanonicalRecoveryOwner, expected: CanonicalRecoveryOpening) => boolean
  close: (owner: ColdCanonicalRecoveryOwner) => void
  track: (owner: ColdCanonicalRecoveryOwner, frames: readonly object[]) => void
  saved: (frame: object, transactionId: string, input: CanonicalRecoveryAcceptedFrame['input'], ack: CanonicalRecoveryAcceptedFrame['ack']) => void
}
let issuer: object | null = null, port: Port | null = null
/** Internal publication from the lazy actual-Main cold adapter. The tiny
 * controller bridge never imports the decoder, calls Main or accepts a DTO as
 * a registered owner. A similarly shaped handle has no entry in this map. */
export function installCanonicalRecoveryOwnerPort(identity: object, reader: Port): void {
  if (issuer && issuer !== identity) throw new Error('The actual canonical cold factory is already registered')
  issuer = identity; port = reader
}
export function readColdCanonicalRecoveryOwner(owner: ColdCanonicalRecoveryOwner): CanonicalRecoveryOpening | null {
  return port?.read(owner) ?? null
}
export function consumeColdCanonicalRecoveryOwner(owner: ColdCanonicalRecoveryOwner, expected: CanonicalRecoveryOpening): boolean {
  return port?.consume(owner, expected) ?? false
}
export function closeColdCanonicalRecoveryOwner(owner: ColdCanonicalRecoveryOwner): void {
  port?.close(owner)
}
export function trackCanonicalRecoveryFrames(owner: ColdCanonicalRecoveryOwner, frames: readonly object[]): void {
  port?.track(owner, frames)
}
export function noteCanonicalRecoveryFrameSaved(frame: object, transactionId: string,
  input: CanonicalRecoveryAcceptedFrame['input'], ack: CanonicalRecoveryAcceptedFrame['ack']): void {
  port?.saved(frame, transactionId, input, ack)
}
