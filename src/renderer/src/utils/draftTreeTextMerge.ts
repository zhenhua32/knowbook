import type { DocumentBlockDraft } from '@shared/contracts'
import { isNestableBlock } from './draftBlockShape'
import { isDraftTreeContiguous } from './draftTreeDepthChange'
import { shiftDraftFragmentDepth } from './draftTreeFragment'
import { getBlockSubtreeEndIndex, getFragmentLocalRootIds } from './draftTreeMove'
import { promoteDraftBlockChildren } from './draftTreeTextEditing'

const textTypes = new Set(['paragraph', 'quote', 'heading-1', 'heading-2', 'heading-3',
  'heading-4', 'heading-5', 'heading-6', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list'])

/** Consume the next visible text root while retaining both complete child trees. */
export function planDraftTextMerge(
  blocks: DocumentBlockDraft[], leftIndex: number, rightIndex: number
): { blocks: DocumentBlockDraft[]; focusIndex: number; cursorPosition: number } | null {
  if (!Number.isInteger(leftIndex) || !Number.isInteger(rightIndex) || leftIndex < 0 || rightIndex <= leftIndex ||
      rightIndex >= blocks.length || !isDraftTreeContiguous(blocks)) return null
  const left = blocks[leftIndex]
  const right = blocks[rightIndex]
  if (!textTypes.has(left.type) || !textTypes.has(right.type)) return null
  // A folded list may hide its own descendants. Never skip other content,
  // such as a divider or the body of a collapsed heading, to reach a textarea.
  const leftEnd = getBlockSubtreeEndIndex(blocks, leftIndex)
  if (rightIndex !== leftIndex + 1 && rightIndex !== leftEnd + 1) return null
  const rightEnd = getBlockSubtreeEndIndex(blocks, rightIndex)
  let next: DocumentBlockDraft[]
  if (isNestableBlock(left.type)) {
    const children = blocks.slice(rightIndex + 1, rightEnd + 1)
    const delta = left.depth - right.depth
    if (children.some(block => block.depth + delta > 6 || block.depth + delta < 0)) return null
    next = [...blocks]
    next.splice(rightIndex + 1, children.length,
      ...shiftDraftFragmentDepth(children, delta, left.id!, getFragmentLocalRootIds(children)))
  } else {
    next = promoteDraftBlockChildren(blocks, rightIndex)
  }
  next[leftIndex] = { ...left, content: left.content + right.content }
  next.splice(rightIndex, 1)
  return isDraftTreeContiguous(next)
    ? { blocks: next, focusIndex: leftIndex, cursorPosition: left.content.length } : null
}
