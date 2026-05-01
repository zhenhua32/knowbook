export type MarkdownRenderableBlock = {
  id?: string
  type: string
  content: string
  checked?: boolean
  depth?: number
  parentBlockId?: string | null
  language?: string | null
}

function isNestableMarkdownBlock(type: string) {
  return ['todo', 'bulleted-list', 'numbered-list'].includes(type)
}

function normalizeMarkdownDepth(type: string, depth: number) {
  return isNestableMarkdownBlock(type) ? Math.max(0, Math.min(6, Math.trunc(depth))) : 0
}

function resolveMarkdownBlockDepths(blocks: MarkdownRenderableBlock[]): number[] {
  const seenIds = new Set<string>()
  const resolvedDepthById = new Map<string, number>()
  const depthStack: Array<string | null> = []

  return blocks.map((block) => {
    const type = block.type.trim() || 'paragraph'
    const blockId = block.id?.trim() && !seenIds.has(block.id) ? block.id : null
    if (blockId) {
      seenIds.add(blockId)
    }

    const parentBlockId = block.parentBlockId?.trim() ? block.parentBlockId : null
    const explicitParentDepth = parentBlockId ? resolvedDepthById.get(parentBlockId) : undefined
    if (explicitParentDepth !== undefined) {
      const explicitDepth = normalizeMarkdownDepth(type, explicitParentDepth + 1)
      if (explicitDepth > explicitParentDepth) {
        depthStack.length = explicitDepth + 1
        depthStack[explicitDepth] = blockId
        if (blockId) {
          resolvedDepthById.set(blockId, explicitDepth)
        }
        return explicitDepth
      }
    }

    let effectiveDepth = normalizeMarkdownDepth(type, block.depth ?? 0)
    while (effectiveDepth > 0 && !depthStack[effectiveDepth - 1]) {
      effectiveDepth -= 1
    }

    depthStack.length = effectiveDepth + 1
    depthStack[effectiveDepth] = blockId
    if (blockId) {
      resolvedDepthById.set(blockId, effectiveDepth)
    }

    return effectiveDepth
  })
}

function renderMarkdownBlock(
  block: MarkdownRenderableBlock,
  effectiveDepth: number,
  fallbackCodeLanguage = ''
): string {
  const type = block.type.trim() || 'paragraph'
  const indent = '  '.repeat(Math.max(0, effectiveDepth))

  switch (type) {
    case 'heading-1':
      return `# ${block.content}`
    case 'heading-2':
      return `## ${block.content}`
    case 'todo':
      return `${indent}- [${block.checked ? 'x' : ' '}] ${block.content}`
    case 'quote':
      return block.content
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'bulleted-list':
      return `${indent}- ${block.content}`
    case 'numbered-list':
      return `${indent}1. ${block.content}`
    case 'divider':
      return '---'
    case 'math':
      return ['$$', block.content, '$$'].join('\n')
    case 'code':
      return ['```' + (block.language ?? fallbackCodeLanguage), block.content, '```'].join('\n')
    default:
      return block.content
  }
}

export function serializeBlocksToMarkdown(
  blocks: MarkdownRenderableBlock[],
  options: {
    fallbackCodeLanguage?: string
  } = {}
): string {
  const effectiveDepths = resolveMarkdownBlockDepths(blocks)

  return blocks
    .map((block, index) => renderMarkdownBlock(block, effectiveDepths[index] ?? 0, options.fallbackCodeLanguage ?? ''))
    .join('\n\n')
}