import type { Node } from 'prosemirror-model'
import { Selection, TextSelection } from 'prosemirror-state'
import type { DocumentBlockDraft } from '@shared/contracts'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { isNestableBlock } from '../utils/draftBlockShape'
import { getBlockSubtreeEndIndex } from '../utils/draftTreeMove'
import { isDraftTreeContiguous } from '../utils/draftTreeDepthChange'
import { validateBlockTreeStructure } from '../utils/draftTreeNormalization'
import { materializePastedDraftFragment, planDraftBlockPaste } from '../utils/draftTreePaste'
import { draftBlocksToRichDoc, richDocToDraftBlocks, serializeRichTextInline } from './model'

export type RichTextTreePastePlan = { doc: Node; selection: Selection }

/** A closed ProseMirror slice splits a list owner before its existing children.
 * Plan structural paste in the draft tree instead, keeping those children with
 * the original owner and placing the pasted roots after its complete subtree.
 */
export function planRichTextTreePaste(doc: Node, selection: Selection, pastedBlocks: DocumentBlockDraft[]): RichTextTreePastePlan | null {
  if (!(selection instanceof TextSelection) || selection.$from.doc !== doc || selection.$to.doc !== doc
    || !selection.$from.sameParent(selection.$to) || selection.$from.parent.type.name !== 'text_block' || !pastedBlocks.length) return null
  const pastedDoc = draftBlocksToRichDoc(pastedBlocks)
  if (pastedBlocks.length === 1 && pastedBlocks[0].type === 'paragraph' && pastedDoc.firstChild?.type.name === 'text_block') return null

  const blocks = richDocToDraftBlocks(doc)
  const index = selection.$from.index(0), current = blocks[index], node = selection.$from.parent
  if (!current || !isNestableBlock(current.type) || getBlockSubtreeEndIndex(blocks, index) === index
    || !isDraftTreeContiguous(blocks) || !validateBlockTreeStructure(blocks).valid) return null

  const inlineMarkdown = (from: number, to: number) => from === 0 && to === node.content.size
    ? current.content : serializeRichTextInline(node.copy(node.content.cut(from, to)))
  // Prefix and suffix are roots of the incoming fragment. The materializer
  // applies the owner's context; retaining their old absolute depth here would
  // accidentally make the suffix a child of the last pasted paragraph/list.
  const prefix: DocumentBlockDraft = { ...current, depth: 0, parentBlockId: null, content: inlineMarkdown(0, selection.$from.parentOffset) }
  const suffix = selection.$to.parentOffset < node.content.size ? {
    ...current, id: undefined, depth: 0, parentBlockId: null, content: inlineMarkdown(selection.$to.parentOffset, node.content.size), checked: false,
    tags: undefined, highlight: undefined, listStart: undefined
  } : null
  const withTail = (fragment: DocumentBlockDraft[]) => [prefix, ...fragment, ...(suffix ? [suffix] : [])]
  let materialized = materializePastedDraftFragment(withTail(pastedBlocks), current)
  if (!materialized) {
    // Contextual depth overflow must preserve the pasted hierarchy as complete
    // standalone Markdown, rather than clamp levels to the six-level tree.
    const literal: DocumentBlockDraft = { type: 'paragraph', content: serializeBlocksToMarkdown(pastedBlocks),
      checked: false, depth: 0, parentBlockId: null }
    materialized = materializePastedDraftFragment(withTail([literal]), current)
  }
  if (!materialized) return null
  const plan = planDraftBlockPaste(blocks, { start: index, end: index }, materialized, true)
  if (!plan || !validateBlockTreeStructure(plan.blocks).valid || !isDraftTreeContiguous(plan.blocks)) return null

  const nextDoc = draftBlocksToRichDoc(plan.blocks)
  const exported = richDocToDraftBlocks(nextDoc)
  if (!validateBlockTreeStructure(exported).valid || !isDraftTreeContiguous(exported)) return null
  let offset = 0
  for (let cursor = 0; cursor < plan.focusIndex; cursor++) offset += nextDoc.child(cursor).nodeSize
  const target = nextDoc.child(plan.focusIndex)
  const nextSelection = target.isTextblock
    ? TextSelection.create(nextDoc, offset + 1 + (suffix ? 0 : target.content.size))
    : Selection.near(nextDoc.resolve(offset + target.nodeSize), -1)
  return { doc: nextDoc, selection: nextSelection }
}
