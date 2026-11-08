import type { SyncedBindingClaim, SyncedBindingSource, SyncedGroupSnapshot } from '@shared/synced-blocks'
import type { FrameLease } from './sourceCopyResources'
export interface ControllerRecoverySource {
  workspaceScope: string; readOwnerId: string; snapshot: SyncedGroupSnapshot; bindingSource: SyncedBindingSource
}
const ports = new WeakMap<object, { read: () => ControllerRecoverySource | null; frame?: (claims: readonly SyncedBindingClaim[]) => FrameLease | null }>()
/** Tiny data-only lazy bridge. The genuine source owner factory registers its
 * own reader; this module never imports the ledger or mints a source owner. */
export function installControllerRecoverySource(context: object, read: () => ControllerRecoverySource | null, frame?: (claims: readonly SyncedBindingClaim[]) => FrameLease | null): void {
  if (ports.has(context)) throw new Error('Recovery source reader already registered')
  ports.set(context, { read, frame })
}
export function readControllerRecoverySource(context: object): ControllerRecoverySource | null { return ports.get(context)?.read() ?? null }
export function restoreControllerRecoveryFrame(context: object, claims: readonly SyncedBindingClaim[]): FrameLease | null {
  const port = ports.get(context)
  if (!port?.read() || !port.frame) throw new Error('The actual canonical recovery source context is unavailable')
  return port.frame(claims)
}
