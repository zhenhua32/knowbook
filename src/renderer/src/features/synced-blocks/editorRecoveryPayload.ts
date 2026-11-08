import type { DocumentBlockDraft } from '@shared/contracts'
import type { EditorRecoveryDraft } from '@shared/editor-recovery-drafts'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedCanonicalEdit, SyncedGroupSnapshot, SyncedHostWorkingBefore } from '@shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, validateSyncedHostForest } from '@shared/syncedBlockValidation'
import { collectDocumentMarkdownLinks } from '@shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '@shared/markdownLinks'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { markdownSourceEditorText } from '../../utils/markdownSourceSession'

type DocumentBase = { title: string; summary: string; blocks: DocumentBlockDraft[] }
type HostAddress = Pick<SyncedHostWorkingBefore, 'documentId' | 'expectedPersistedUpdatedAt'>
const baseHashes = new WeakMap<DocumentBase, Promise<string>>()
export type RecoverySourceText = { source: string; start: number; end: number; anchors?: unknown }
export type RecoveryPayload = {
  host?: SyncedHostWorkingBefore
  persisted?: DocumentBase
  persistedHash?: string
  base?: { host?: HostAddress & Partial<Pick<SyncedHostWorkingBefore, 'workingBefore'>>; hostHash?: string;
    snapshot?: SyncedGroupSnapshot; instanceId?: string; working?: SyncedCanonicalEdit[] }
  sourceKind?: 'canonical' | 'host'
  snapshot?: SyncedGroupSnapshot
  bindingClaims?: SyncedBindingClaim[] | 'legacy' | null
  incoming?: SyncedGroupSnapshot | null
  working?: RecoverySourceText | SyncedCanonicalEdit[] | null
  pending?: { clientOperationId?: string; input?: { clientOperationId?: string; expectedInstanceBinding?: { hostDocumentId: string } } }
}

export function readRecoveryPayload(draft: EditorRecoveryDraft): RecoveryPayload | null {
  try {
    const payload = JSON.parse(draft.payload)
    return payload?.version === 1 ? payload : null
  } catch { return null }
}

export function isDirectlyRecoverable(draft: EditorRecoveryDraft, payload: RecoveryPayload | null): boolean {
  if (!payload || payload.pending || payload.incoming) return false
  if (draft.kind === 'document') return Boolean(payload.host && (payload.persistedHash || payload.persisted))
  if (draft.kind === 'group') return Boolean(payload.snapshot && Array.isArray(payload.working))
  return Boolean(payload.base && payload.working && !Array.isArray(payload.working) && payload.working.anchors !== undefined)
}

export function readRecoveryHostAddress(value: unknown): HostAddress {
  assertSyncedShape(value, ['documentId', 'expectedPersistedUpdatedAt'], ['workingBefore'])
  const { documentId, expectedPersistedUpdatedAt } = value
  if (!isSyncedBlockId(documentId) || typeof expectedPersistedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedPersistedUpdatedAt)))
    throw new Error('Invalid retained document address.')
  return { documentId, expectedPersistedUpdatedAt }
}

export function readRecoveryHost(value: unknown): SyncedHostWorkingBefore {
  const address = readRecoveryHostAddress(value)
  const workingBefore = (value as { workingBefore?: unknown }).workingBefore
  assertSyncedShape(workingBefore, ['title', 'summary', 'blocks'])
  if (typeof workingBefore.title !== 'string' || typeof workingBefore.summary !== 'string') throw new Error('Invalid retained document draft.')
  return { ...address, workingBefore: { title: workingBefore.title, summary: workingBefore.summary,
    blocks: validateSyncedHostForest(workingBefore.blocks) } }
}

export function sameRecoveryDocument(base: DocumentBase, live: DocumentBase) {
  return base.title === live.title && base.summary === live.summary && areDocumentDraftBlocksEqual(base.blocks, live.blocks)
}

export function recoveryDocumentHash(base: DocumentBase) {
  const cached = baseHashes.get(base)
  if (cached) return cached
  const serialized = JSON.stringify([base.title, base.summary, base.blocks])
  const hash = crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
    .then(bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''))
  baseHashes.set(base, hash)
  return hash
}

export function unchangedRecoveryBindings(baseline: SyncedGroupSnapshot, working: SyncedCanonicalEdit[]): SyncedBindingClaim[] | null {
  const key = ({ blockId, from, to, raw, syntax }: SyncedBindingKey) => JSON.stringify([blockId, from, to, raw, syntax])
  const original = new Map(baseline.bindings.map(({ target: _target, ...binding }) => [key(binding), binding]))
  const claims: SyncedBindingClaim[] = []
  for (const link of collectDocumentMarkdownLinks(working)) {
    if (link.kind === 'image' || link.kind !== 'wiki' && !resolveMarkdownDocumentPath(baseline.origin.pathAtCreation, link.url)) continue
    const block = working[link.blockIndex]
    const match = JSON.stringify([link.blockId, link.start, link.end, block.content.slice(link.start, link.end), link.kind === 'wiki' ? 'wiki' : 'markdown'])
    const binding = original.get(match)
    if (!binding) return null
    original.delete(match)
    claims.push({ kind: 'continue', source: binding, destination: binding })
  }
  return original.size ? null : claims
}

export function readRecoverySource(value: RecoveryPayload['working']): RecoverySourceText {
  if (!value || Array.isArray(value) || typeof value.source !== 'string' || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
    || value.start < 0 || value.end < value.start || value.end > markdownSourceEditorText(value.source).length || value.anchors === undefined) {
    throw new Error('Invalid retained Markdown source.')
  }
  return value
}
