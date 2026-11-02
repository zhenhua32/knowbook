import type { DocumentBlockDraft } from '@shared/contracts'

// Thin lazy-chunk bridge only. These callbacks block local transitions; they
// never create a Main session, a binding, a file claim or mutation permission.
interface InlineTransitionPort {
  flush: (options?: { shouldContinue?: () => boolean }) => Promise<boolean>
  pending: () => boolean
  hostPending: () => boolean
  navigate: () => Promise<boolean>
  notifyBlocked: () => void
  locked: () => boolean
}
let port: InlineTransitionPort | null = null, owner: object | null = null
const asynchronousEdits = new Set<object>(), unlockWaiters = new Set<() => void>()
/** Tracks an actual already-started attachment insertion through its final
 * original editor callback. This is a local transition blocker, never a Main
 * session, a writer permit or a synthetic successful flush. */
export function beginCanonicalInlineAsyncEdit(): (() => void) | null {
  if (port?.locked()) return null
  const original = Object.freeze({}); asynchronousEdits.add(original)
  return () => { asynchronousEdits.delete(original) }
}
export const hasCanonicalInlineAsyncEdits = () => asynchronousEdits.size > 0
export function signalCanonicalInlineUnlock(): void {
  if (port?.locked()) return
  for (const resolve of unlockWaiters) resolve()
  unlockWaiters.clear()
}
export function waitForCanonicalInlineUnlock(): Promise<void> {
  return port?.locked() ? new Promise(resolve => unlockWaiters.add(resolve)) : Promise.resolve()
}
export function installCanonicalInlineTransitions(identity: object, next: InlineTransitionPort): () => void {
  if (owner && owner !== identity) throw new Error('A renderer canonical coordinator is already active')
  owner = identity; port = next
  return () => { if (owner === identity) { owner = null; port = null } }
}
export const flushCanonicalWindowNavigation = async () => !asynchronousEdits.size && (!port || !port.locked() && await port.navigate())
export const canonicalInlineInputLocked = () => port?.locked() ?? false
export const hasCanonicalHostSavePending = () => port?.hostPending() ?? false
export const hasCanonicalInlinePendingChanges = () => asynchronousEdits.size > 0 || (port?.pending() ?? false)
export async function flushCanonicalInlinePendingChanges(options?: { shouldContinue?: () => boolean }): Promise<boolean> {
  if (asynchronousEdits.size) return false
  return port ? port.flush(options) : options?.shouldContinue?.() !== false
}
const refs = (blocks: readonly DocumentBlockDraft[]) => blocks.filter(block => block.type === 'synced-block')
  .map(block => [block.id ?? null, block.content, block.parentBlockId ?? null, block.depth])
/** Keep a dirty canonical mount alive until its own queue is drained. Text in
 * ordinary host rows remains independent; canonical children never enter here. */
export function canApplyCanonicalHostDraftChange(before: readonly DocumentBlockDraft[], after: readonly DocumentBlockDraft[]): boolean {
  if (!port) return true
  if (port.locked() || port.pending() && JSON.stringify(refs(before)) !== JSON.stringify(refs(after))) {
    port.notifyBlocked(); return false
  }
  return true
}
