import type { DocumentBlockDraft } from '@shared/contracts'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { canBlockNestUnder, canBlockOwnChildren, isContainerBlockType } from '@shared/blockTypes'
import { isDraftTreeContiguous } from './draftTreeDepthChange'
import { materializeDraftFragment } from './draftTreeFragment'
import { getBlockSubtreeEndIndex, getNormalizedParentBlockId } from './draftTreeMove'
import { reparentOrphanedBlocksAfterRangeDeletion } from './draftTreePlacement'
import { promoteDraftBlockChildren } from './draftTreeTextEditing'

type DraftRange = { start: number; end: number }

/** Pasted roots stay in their container; ordinary text still exits lists. */
export function materializePastedDraftFragment(parsed: DocumentBlockDraft[], template: DocumentBlockDraft,
  contextBlocks: readonly DocumentBlockDraft[] = []): DocumentBlockDraft[] | null {
  const fragment: DocumentBlockDraft[] = []
  const byId = new Map(contextBlocks.map(block => [block.id, block]))
  let rootDepth = template.depth
  let rootParent = getNormalizedParentBlockId(template)
  for (let start = 0; start < parsed.length;) {
    const root = parsed[start]
    let end = start + 1
    while (end < parsed.length && parsed[end].depth > root.depth) end++
    while (rootParent) {
      const parent = byId.get(rootParent)
      if (canBlockNestUnder(parent?.type ?? 'bulleted-list', root.type)) break
      rootParent = parent ? getNormalizedParentBlockId(parent) : null
      rootDepth = rootParent ? (byId.get(rootParent)?.depth ?? -1) + 1 : 0
    }
    if (!rootParent) rootDepth = 0
    const subtree = parsed.slice(start, end).map(block => ({
      ...block, depth: block.depth - root.depth + rootDepth
    }))
    // Keep the source as text instead of silently clamping away nested levels.
    if (subtree.some(block => block.depth > 6 || block.depth < 0)) return null
    fragment.push(...materializeDraftFragment(subtree, rootParent))
    start = end
  }
  return fragment
}

/** Replace text in one parent, or replace an entire selected range, atomically. */
export function planDraftBlockPaste(
  blocks: DocumentBlockDraft[], range: DraftRange, pasted: DocumentBlockDraft[], preserveChildren: boolean
): { blocks: DocumentBlockDraft[]; focusIndex: number } | null {
  if (!pasted.length || range.start < 0 || range.end < range.start || range.end >= blocks.length) return null
  const current = blocks[range.start]
  const fragment = pasted.map(block => ({ ...block }))
  let next: DocumentBlockDraft[]
  if (preserveChildren) {
    const generatedId = fragment[0].id
    fragment[0] = { ...fragment[0], id: current.id, tags: current.tags, highlight: current.highlight }
    for (const block of fragment) if (block.parentBlockId === generatedId) block.parentBlockId = current.id
    const subtreeEnd = getBlockSubtreeEndIndex(blocks, range.start)
    const source = !canBlockOwnChildren(fragment[0].type) || blocks.slice(range.start + 1, subtreeEnd + 1)
      .some(block => block.depth === current.depth + 1 && !canBlockNestUnder(fragment[0].type, block.type))
      ? promoteDraftBlockChildren(blocks, range.start)
      : current.depth > 0 && fragment.some(block => block.depth === 0)
        ? promoteDraftBlockChildren(blocks, subtreeEnd) : blocks
    const firstSubtreeEnd = getBlockSubtreeEndIndex(fragment, 0)
    next = [...source.slice(0, range.start), ...fragment.slice(0, firstSubtreeEnd + 1),
      ...source.slice(range.start + 1, subtreeEnd + 1), ...fragment.slice(firstSubtreeEnd + 1), ...source.slice(subtreeEnd + 1)]
  } else {
    // A visible parent-plus-child selection may leave later children outside
    // the range. Promote them rather than adopting them into the pasted root.
    let remaining = reparentOrphanedBlocksAfterRangeDeletion(blocks, range.start, range.end)
    if (current.depth > 0 && fragment.some(block => block.depth === 0)) {
      remaining = promoteDraftBlockChildren(remaining, range.start - 1)
    }
    next = [...remaining.slice(0, range.start), ...fragment, ...remaining.slice(range.start)]
  }
  if (!isDraftTreeContiguous(next)) return null
  return { blocks: next, focusIndex: next.findIndex(block => block.id === fragment.at(-1)!.id) }
}

/** A structural title paste appends body blocks without splitting the owner. */
export function planDraftContainerTitlePaste(blocks: DocumentBlockDraft[], index: number,
  pasted: DocumentBlockDraft[], prefix: string, suffix: string): { blocks: DocumentBlockDraft[]; focusIndex: number; cursorPosition: number } | null {
  const current = blocks[index]
  if (!current || !isContainerBlockType(current.type) || !pasted.length || !isDraftTreeContiguous(blocks)) return null
  const tail: DocumentBlockDraft[] = suffix ? [{ type: 'paragraph', content: suffix, checked: false, depth: 0, parentBlockId: null }] : []
  const template = { ...current, type: 'paragraph', depth: current.depth + 1, parentBlockId: current.id }
  let fragment = materializePastedDraftFragment([...pasted, ...tail], template, blocks)
  // Frontmatter cannot be adopted. Over-deep incoming trees stay intact as
  // Markdown text; at depth six the text becomes a sibling of the owner.
  const invalidBody = !fragment || fragment.some(block => block.depth <= current.depth ||
    block.depth === current.depth + 1 && block.parentBlockId !== current.id)
  if (invalidBody) {
    const fallbackTemplate = current.depth < 6 ? template : { ...template, depth: current.depth, parentBlockId: current.parentBlockId ?? null }
    const literal: DocumentBlockDraft = { type: 'paragraph', content: serializeBlocksToMarkdown(pasted), checked: false, depth: 0, parentBlockId: null }
    fragment = materializePastedDraftFragment([literal, ...tail], fallbackTemplate, blocks)
  }
  if (!fragment) return null
  const insertionIndex = getBlockSubtreeEndIndex(blocks, index) + 1
  const next = [...blocks]
  next[index] = { ...current, content: prefix }
  next.splice(insertionIndex, 0, ...fragment)
  if (!isDraftTreeContiguous(next)) return null
  return { blocks: next, focusIndex: insertionIndex + fragment.length - 1,
    cursorPosition: suffix ? 0 : fragment.at(-1)!.content.length }
}
