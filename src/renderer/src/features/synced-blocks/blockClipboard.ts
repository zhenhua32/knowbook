import type { DocumentBlockDraft } from '@shared/contracts'
import type { SyncedGroupWire, SyncedNewRefSource, SyncedReferenceIdentity, SyncedStableBlockDraft } from '@shared/synced-blocks'
import { parseSyncedBlockPayload, validateSyncedHostForest } from '@shared/syncedBlockValidation'
import { getBlockSubtreeEndIndex } from '../../utils/draftTreeMove'
import { blockActionRoots } from '../../utils/documentBlockActions'
import { reparentOrphanedBlocksAfterRangeDeletion } from '../../utils/draftTreePlacement'
import { openCanonicalHostEdit, readSyncedClipboardScope } from './inlineBridge'
import { assertClipboardIndependentlySerializable, renderPublicSyncedClipboard, rewriteClipboardLocalBlockLinks } from './clipboardMarkdown'

type Address = { documentId: string; workspaceScope: string; recoveryEpoch: string }
type BlockRange = { start: number; end: number }
type ClipboardRead = { text: string; marker: string }
type ClipboardOpening = { blocks: DocumentBlockDraft[]; documentId: string; getDraftBlocks: () => DocumentBlockDraft[] }
type PasteFocus = readonly [clearSelection: () => void, endDrag: () => void, activeBlock: (index: number) => void,
  cursor: (position: number) => void, pendingFocus: (index: number, position: number) => void]
type CapturedFragment = {
  blocks: SyncedStableBlockDraft[]; groups: Map<string, SyncedReferenceIdentity>
}
type Packet = ClipboardRead & Pick<Address, 'workspaceScope' | 'recoveryEpoch'> & CapturedFragment
let clipboard: Packet | null = null
let copying: object | null = null

const normalizedText = (text: string) => text.replace(/\r\n?/g, '\n')
const invalid = () => new Error('The selected blocks and current shared references could not be copied.')
const stillOwnsScope = (documentId: string, scope: Omit<Address, 'documentId'>): boolean => {
  const actual = readSyncedClipboardScope(documentId)
  return actual?.workspaceScope === scope.workspaceScope && actual.recoveryEpoch === scope.recoveryEpoch
}

async function captureSyncedSelection(blocks: DocumentBlockDraft[], range: BlockRange, address: Address,
  current: () => boolean, forClipboard: boolean) {
  if (range.end < range.start || range.end >= blocks.length || range.start < 0 || !current()) return null
  const depth = blocks[range.start].depth, parentBlockId = blocks[range.start].parentBlockId ?? null
  for (let index = range.start; index <= range.end;) {
    const root = blocks[index], end = getBlockSubtreeEndIndex(blocks, index)
    if (root.depth !== depth || (root.parentBlockId ?? null) !== parentBlockId || end > range.end) throw invalid()
    index = end + 1
  }
  const fragment = validateSyncedHostForest(blocks.slice(range.start, range.end + 1).map(block => ({ ...block,
    depth: block.depth - depth, parentBlockId: block.depth === depth ? null : block.parentBlockId ?? null })))
  if (forClipboard) assertClipboardIndependentlySerializable(blocks, fragment, range.start, range.end)
  const groups = new Map<string, SyncedReferenceIdentity>(), wires = new Map<string, SyncedGroupWire>()
  const revisions = new Map<string, string>()
  for (const block of fragment) if (block.type === 'synced-block') {
    if (!current()) return null
    const { groupId } = parseSyncedBlockPayload(block.content)
    const resolved = await window.knowbook.resolveSyncedInlineInstance({ instanceId: block.id, hostDocumentId: address.documentId, groupId })
    if (resolved.status !== 'ready' || resolved.instance.workspaceScope !== address.workspaceScope
      || resolved.instance.recoveryEpoch !== address.recoveryEpoch || resolved.instance.groupId !== groupId
      || resolved.snapshot.groupId !== groupId || resolved.snapshot.creationId !== resolved.instance.creationId) throw invalid()
    const { creationId, createdAt, origin, bindings, blocks: body } = resolved.snapshot
    const revision = resolved.snapshot.revision + '/' + resolved.snapshot.topologyRevision
    if (wires.has(groupId) && (groups.get(groupId)?.creationId !== creationId || revisions.get(groupId) !== revision)) throw invalid()
    wires.set(groupId, { kind: 'synced-group', id: groupId, creationId, createdAt, origin, bindings, blocks: body })
    groups.set(groupId, { workspaceScope: address.workspaceScope, groupId, creationId })
    revisions.set(groupId, revision)
  }
  return groups.size && current() ? { blocks: fragment, groups, wires } : null
}

export async function copySyncedClipboardRange(blocks: DocumentBlockDraft[], range: BlockRange, address: Address,
  isCurrent: () => boolean, plain = false): Promise<boolean> {
  const operation = {}
  copying = operation
  const current = () => copying === operation && isCurrent()
  const captured = await captureSyncedSelection(blocks, range, address, current, true)
  if (!captured || !current()) return false
  const { blocks: fragment, groups, wires } = captured
  const text = renderPublicSyncedClipboard(address.documentId, fragment, [...wires.values()])
  if (plain) { await window.knowbook.writeClipboardText(text); return current() }
  const marker = crypto.randomUUID()
  await window.knowbook.writeSyncedBlockClipboard(text, marker)
  if (!current()) return false
  clipboard = { text: normalizedText(text), marker, workspaceScope: address.workspaceScope, recoveryEpoch: address.recoveryEpoch, blocks: fragment, groups }
  return true
}

export function readSyncedClipboardFragment(text: string, clipboardHtml: string, scope: Omit<Address, 'documentId'>) {
  const marker = /\bdata-knowbook-synced-clipboard="([a-f0-9-]{36})"/.exec(clipboardHtml)?.[1]
  const saved = clipboard
  if (!saved || marker !== saved.marker || normalizedText(text) !== saved.text
    || scope.workspaceScope !== saved.workspaceScope || scope.recoveryEpoch !== saved.recoveryEpoch) return null
  return allocateSyncedFragment(saved)
}

function allocateSyncedFragment(saved: CapturedFragment) {
  const allocated = new Map(saved.blocks.map(block => [block.id, crypto.randomUUID()]))
  const ordinaryIds = new Map(saved.blocks.filter(block => block.type !== 'synced-block').map(block => [block.id, allocated.get(block.id)!]))
  const newRefSources: SyncedNewRefSource[] = []
  const fragment = rewriteClipboardLocalBlockLinks(saved.blocks, ordinaryIds).map(block => {
    const id = allocated.get(block.id)!
    if (block.type === 'synced-block') newRefSources.push({ kind: 'internal', instanceId: id,
      identity: saved.groups.get(parseSyncedBlockPayload(block.content).groupId)! })
    return { ...block, id, parentBlockId: block.parentBlockId === null ? null : allocated.get(block.parentBlockId)! }
  })
  return { fragment, newRefSources }
}

/** Duplicate by the same exact internal identity as paste, without using the clipboard. */
export async function duplicateSyncedBlocks(opening: ClipboardOpening, selection: BlockRange | readonly string[], stillCurrent: () => boolean,
  opener: HTMLElement | null, onAccepted: (blocks: DocumentBlockDraft[]) => void) {
  const { documentId, blocks, getDraftBlocks } = opening, scope = readSyncedClipboardScope(documentId)
  if (!scope) throw invalid()
  let range: BlockRange
  if ('start' in selection) range = selection
  else {
    const roots = blockActionRoots(blocks, selection)
    if (!roots?.length) throw invalid()
    const indices = roots.map(id => blocks.findIndex(block => block.id === id))
    range = { start: indices[0], end: getBlockSubtreeEndIndex(blocks, indices[indices.length - 1]) }
    let next = range.start
    for (const index of indices) {
      if (index !== next) throw invalid()
      next = getBlockSubtreeEndIndex(blocks, index) + 1
    }
  }
  const current = () => getDraftBlocks() === blocks && stillOwnsScope(documentId, scope) && stillCurrent()
  const captured = await captureSyncedSelection(blocks, range, { documentId, ...scope }, current, false)
  if (!captured || !current()) return
  const { fragment, newRefSources } = allocateSyncedFragment(captured), root = blocks[range.start]
  const duplicated = fragment.map(block => ({ ...block, depth: root.depth + block.depth,
    parentBlockId: block.parentBlockId === null ? root.parentBlockId ?? null : block.parentBlockId }))
  const index = range.end + 1, next = [...blocks.slice(0, index), ...duplicated, ...blocks.slice(index)]
  return openCanonicalHostEdit(blocks, next, { opener, shouldContinue: current, newRefSources,
    afterBookmark: { index, blockId: duplicated[0].id, direction: 'none', start: 0, end: 0 },
    onAccepted: () => onAccepted(duplicated) })
}

function planSyncedClipboardPaste(blocks: DocumentBlockDraft[], targetIndex: number, destination: BlockRange | null,
  source: NonNullable<ReturnType<typeof readSyncedClipboardFragment>>) {
  const target = blocks[destination?.start ?? targetIndex]
  if (!target) return null
  const insertionIndex = destination?.start ?? getBlockSubtreeEndIndex(blocks, targetIndex) + 1
  const last = destination?.end ?? insertionIndex - 1
  if (destination) for (let index = insertionIndex; index <= last;) {
    const root = blocks[index], end = getBlockSubtreeEndIndex(blocks, index)
    if (root.depth !== target.depth || (root.parentBlockId ?? null) !== (target.parentBlockId ?? null) || end > last) return null
    index = end + 1
  }
  const fragment = source.fragment.map(block => ({ ...block, depth: target.depth + block.depth,
    parentBlockId: block.parentBlockId === null ? target.parentBlockId ?? null : block.parentBlockId }))
  return { blocks: [...blocks.slice(0, insertionIndex), ...fragment, ...blocks.slice(last + 1)],
    newRefSources: source.newRefSources, focusIndex: insertionIndex }
}

export async function copyOrCutSyncedBlocks(opening: ClipboardOpening, range: BlockRange, plain: boolean, onCut?: () => void) {
  const { documentId, blocks, getDraftBlocks } = opening, scope = readSyncedClipboardScope(documentId)
  if (!scope) throw invalid()
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const current = () => getDraftBlocks() === blocks && stillOwnsScope(documentId, scope)
  if (!await copySyncedClipboardRange(blocks, range, { documentId, ...scope }, current, plain)) return false
  if (!onCut) return true
  const remaining = reparentOrphanedBlocksAfterRangeDeletion(blocks, range.start, range.end)
  const after = remaining.length ? remaining : [{ id: crypto.randomUUID(), type: 'paragraph', content: '', depth: 0, parentBlockId: null, checked: false }]
  return openCanonicalHostEdit(blocks, after, { opener, shouldContinue: current, onAccepted: onCut })
}

export async function pasteSyncedBlocks(opening: ClipboardOpening, text: string, clipboardHtml: string, targetIndex: number,
  selection: BlockRange | null, fallback: () => void, focus: PasteFocus) {
  const { documentId, blocks, getDraftBlocks } = opening, scope = readSyncedClipboardScope(documentId)
  if (getDraftBlocks() !== blocks) return
  const source = scope && readSyncedClipboardFragment(text, clipboardHtml, scope)
  if (!scope || !source) { fallback(); return }
  const plan = planSyncedClipboardPaste(blocks, targetIndex, selection, source)
  if (!plan) return
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const current = () => getDraftBlocks() === blocks && stillOwnsScope(documentId, scope) && opener === document.activeElement
  const index = plan.focusIndex
  return openCanonicalHostEdit(blocks, plan.blocks, { reason: 'paste', newRefSources: plan.newRefSources,
    opener, shouldContinue: current, afterBookmark: { index, start: 0, end: 0, direction: 'none', blockId: plan.blocks[index].id },
    onAccepted: () => {
      const [clearSelection, endDrag, activeBlock, cursor, pendingFocus] = focus
      clearSelection(); endDrag(); activeBlock(index); cursor(0); pendingFocus(index, 0)
    } })
}
