import type { SyncedBindingSource, SyncedGroupSnapshot } from '@shared/synced-blocks'
export interface ControllerRecoverySource {
  workspaceScope: string; readOwnerId: string; snapshot: SyncedGroupSnapshot; bindingSource: SyncedBindingSource
}
const ports = new WeakMap<object, () => ControllerRecoverySource | null>()
/** Tiny data-only lazy bridge. The genuine source owner factory registers its
 * own reader; this module never imports the ledger or mints a source owner. */
export function installControllerRecoverySource(context: object, read: () => ControllerRecoverySource | null): void {
  if (ports.has(context)) throw new Error('Recovery source reader already registered')
  ports.set(context, read)
}
export function readControllerRecoverySource(context: object): ControllerRecoverySource | null { return ports.get(context)?.() ?? null }
