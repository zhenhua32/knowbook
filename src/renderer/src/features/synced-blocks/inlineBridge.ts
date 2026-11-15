import type { DocumentHostAdoptContext, DocumentHostHistoryContext, DocumentLocalDraftContext } from '../../utils/documentHostHistory'
import type { SyncedNewRefSource, SyncedStructureApplied } from '@shared/synced-blocks'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import type { DocumentBlockDraft } from '@shared/contracts'
import type { SyncedHostHistoryTransition } from './hostHistoryTypes'
import type { PendingBlockNavigationTarget } from '../../hooks/useDocumentNavigationState'
import type { EditorHistoryBookmark } from '../../utils/editorHistoryFocus'

type HeadingCallbacks = {
  onPendingTargetResolved: (index: number, id: string, headingIndex?: number) => void
  onPendingTargetMissing: () => void
}
export type CanonicalHeadingAction = (target: PendingBlockNavigationTarget, blocks: readonly DocumentBlockDraft[], callbacks: HeadingCallbacks,
  clear: () => void) => (() => void) | undefined
export interface CanonicalHostEditOptions {
  preserveSameParentDraft?: true
  reason?: 'selection-edit' | 'drop' | 'paste'
  newRefSources?: readonly SyncedNewRefSource[]
  opener: HTMLElement | null
  shouldContinue: () => boolean
  onAccepted?: () => void
  afterBookmark?: EditorHistoryBookmark
}
type CanonicalHostEdit = (before: readonly DocumentBlockDraft[], after: readonly DocumentBlockDraft[], options: CanonicalHostEditOptions) => Promise<boolean>

// Thin lazy-chunk bridge only. These callbacks block local transitions; they
// never create a Main session, a binding, a file claim or mutation permission.
export interface CanonicalInlineFlushOptions {
  shouldContinue?: () => boolean
  purpose?: 'document-navigation' | 'move'
}
interface InlineTransitionPort {
  flush: (options?: CanonicalInlineFlushOptions) => Promise<boolean>
  pending: () => boolean
  hostPending: () => boolean
  navigate: () => Promise<boolean>
  notifyBlocked: () => void
  locked: () => boolean
  restoreHistory?: (transition: SyncedHostHistoryTransition, direction: 'undo' | 'redo') => Promise<boolean>
  ownsHistory?: (transition: SyncedHostHistoryTransition) => boolean
  adoptHostResult?: (context: DocumentHostAdoptContext, before: SyncedHostSourceCurrent, result: SyncedStructureApplied, history: boolean,
    afterBookmark?: EditorHistoryBookmark) => boolean
  runHostHistory?: (context: DocumentHostHistoryContext) => Promise<boolean>
  openHeading?: CanonicalHeadingAction
  openHostEdit?: CanonicalHostEdit
  deleteHostBlocks?: (before: DocumentBlockDraft[], after: DocumentBlockDraft[], index: number,
    current: () => boolean, accepted: (index: number) => void) => void
  clipboardScope?: (hostId: string) => { workspaceScope: string; recoveryEpoch: string } | null
  adoptLocalDraft?: (context: DocumentLocalDraftContext, before: SyncedHostSourceCurrent,
    after: { documentId?: string; title: string; summary: string; blocks: DocumentBlockDraft[] }, recovery: boolean) => boolean
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
export const ownsCanonicalHostHistory = (transition: SyncedHostHistoryTransition) => port?.ownsHistory?.(transition) ?? false
export const restoreCanonicalHostHistory = (transition: SyncedHostHistoryTransition, direction: 'undo' | 'redo') =>
  asynchronousEdits.size ? Promise.resolve(false) : port?.restoreHistory?.(transition, direction) ?? Promise.resolve(false)
/** A local synchronous adoption route only. No provider means no adoption. */
export const adoptCanonicalHostResult = (context: DocumentHostAdoptContext, before: SyncedHostSourceCurrent,
  result: SyncedStructureApplied, history: boolean, afterBookmark?: EditorHistoryBookmark): boolean =>
  port?.adoptHostResult?.(context, before, result, history, afterBookmark) ?? false
export const getCanonicalHostHistoryAction = () => port?.runHostHistory ?? null
export const getCanonicalHeadingAction = () => port?.openHeading
export const openCanonicalHostEdit: CanonicalHostEdit = (...input) => port?.openHostEdit?.(...input) ?? Promise.resolve(false)
export const deleteCanonicalHostBlocks: NonNullable<InlineTransitionPort['deleteHostBlocks']> = (...input) => port?.deleteHostBlocks?.(...input)
export const readSyncedClipboardScope = (hostId: string) => port?.clipboardScope?.(hostId) ?? null
export const adoptCanonicalLocalDraft = (context: DocumentLocalDraftContext, before: SyncedHostSourceCurrent,
  after: { documentId?: string; title: string; summary: string; blocks: DocumentBlockDraft[] }, recovery: boolean): boolean => port?.adoptLocalDraft?.(context, before, after, recovery) ?? false
export const hasCanonicalInlinePendingChanges = () => asynchronousEdits.size > 0 || (port?.pending() ?? false)
export async function flushCanonicalInlinePendingChanges(options?: CanonicalInlineFlushOptions): Promise<boolean> {
  // Document navigation may retire the original attachment view. Its real
  // callback still owns the marker and must pass the original scope/body guard.
  // Default Save/close drains remain strict; no pending import is forgotten.
  if (asynchronousEdits.size && options?.purpose !== 'document-navigation') return false
  if (options?.purpose === 'document-navigation' && port?.locked()) return false
  return port ? port.flush(options) : options?.shouldContinue?.() !== false
}
const refs = (blocks: readonly DocumentBlockDraft[]) => blocks.filter(block => block.type === 'synced-block')
  .map(block => [block.id ?? null, block.content, block.parentBlockId ?? null, block.depth])
export const changesCanonicalHostReferences = (before: readonly DocumentBlockDraft[], after: readonly DocumentBlockDraft[]) =>
  JSON.stringify(refs(before)) !== JSON.stringify(refs(after))
/** Keep a dirty canonical mount alive until its own queue is drained. Text in
 * ordinary host rows remains independent; canonical children never enter here. */
export function canApplyCanonicalHostDraftChange(before: readonly DocumentBlockDraft[], after: readonly DocumentBlockDraft[]): boolean {
  if (!port) return true
  if (port.locked() || port.pending() && changesCanonicalHostReferences(before, after)) {
    port.notifyBlocked(); return false
  }
  return true
}
