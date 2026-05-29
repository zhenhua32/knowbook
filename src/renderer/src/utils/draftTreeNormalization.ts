import { detectCodeLanguage } from '@shared/code'
import type { DocumentBlockDraft } from '@shared/contracts'
import { isNestableBlock } from './draftBlockShape'
import { createDraftBlockId } from './draftTreeFragment'
import { resolveDraftBlockRelationship } from './draftTreePlacement'
import { getNormalizedBlockId, getNormalizedParentBlockId } from './draftTreeMove'

export function normalizeDraftBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
  const seenIds = new Set<string>()
  const resolvedDepthById = new Map<string, number>()
  const depthStack: Array<string | null> = []

  return blocks.map((block) => {
    const requestedId = block.id?.trim() ? block.id : null
    const id = requestedId && !seenIds.has(requestedId) ? requestedId : createDraftBlockId()
    seenIds.add(id)

    const type = block.type.trim() || 'paragraph'
    const checked = type === 'todo' ? Boolean(block.checked) : false

    const { depth, parentBlockId } = resolveDraftBlockRelationship(
      type,
      block.depth ?? 0,
      block.parentBlockId,
      id,
      resolvedDepthById,
      depthStack
    )

    depthStack.length = depth + 1
    depthStack[depth] = id
    resolvedDepthById.set(id, depth)

    return {
      ...block,
      id,
      type,
      checked,
      language: type === 'code' ? (detectCodeLanguage(block.content, block.language) ?? undefined) : undefined,
      depth,
      parentBlockId
    }
  })
}

export function validateBlockTreeStructure(blocks: DocumentBlockDraft[]): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (blocks.length === 0) {
    return { valid: true, errors: [] }
  }

  const knownIds = new Set(blocks.map((block) => block.id).filter((id): id is string => Boolean(id)))
  const seenIds = new Set<string>()
  const resolvedDepthById = new Map<string, number>()
  const resolvedTypeById = new Map<string, string>()

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const blockId = getNormalizedBlockId(block)

    if (!blockId) {
      errors.push(`Block ${index}: missing block id`)
    } else if (seenIds.has(blockId)) {
      errors.push(`Block ${index}: duplicate ID "${blockId}"`)
    } else {
      seenIds.add(blockId)
    }

    if (block.depth < 0) {
      errors.push(`Block ${index}: negative depth ${block.depth}`)
    }

    if (block.depth > 6) {
      errors.push(`Block ${index}: depth ${block.depth} exceeds maximum 6`)
    }

    if (!isNestableBlock(block.type) && block.depth > 0) {
      errors.push(`Block ${index}: non-nestable type "${block.type}" has depth ${block.depth} > 0`)
    }

    const parentBlockId = getNormalizedParentBlockId(block)
    if (!isNestableBlock(block.type) && parentBlockId) {
      errors.push(`Block ${index}: non-nestable type "${block.type}" cannot have parentBlockId "${parentBlockId}"`)
    }

    if (parentBlockId) {
      if (!blockId) {
        errors.push(`Block ${index}: child block is missing its own id`)
      } else if (parentBlockId === blockId) {
        errors.push(`Block ${index}: parentBlockId cannot reference itself`)
      } else if (!knownIds.has(parentBlockId)) {
        errors.push(`Block ${index}: parentBlockId "${parentBlockId}" does not exist in this document`)
      } else if (!seenIds.has(parentBlockId)) {
        errors.push(`Block ${index}: parentBlockId "${parentBlockId}" must appear before the child in flat order`)
      } else {
        const parentDepth = resolvedDepthById.get(parentBlockId)
        const parentType = resolvedTypeById.get(parentBlockId)

        if (parentDepth === undefined) {
          errors.push(`Block ${index}: parentBlockId "${parentBlockId}" could not be resolved`)
        } else {
          if (block.depth !== parentDepth + 1) {
            errors.push(`Block ${index}: depth ${block.depth} does not match parent depth ${parentDepth} + 1`)
          }

          if (parentType && !isNestableBlock(parentType)) {
            errors.push(`Block ${index}: parentBlockId "${parentBlockId}" points to non-nestable type "${parentType}"`)
          }
        }
      }
    } else if (block.depth > 0) {
      errors.push(`Block ${index}: root block cannot have depth ${block.depth} without parentBlockId`)
    }

    if (blockId) {
      resolvedDepthById.set(blockId, block.depth)
      resolvedTypeById.set(blockId, block.type)
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}