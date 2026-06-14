export type MarkdownRenderableBlock = {
  id?: string
  type: string
  content: string
  checked?: boolean
  depth?: number
  parentBlockId?: string | null
  language?: string | null
  tags?: string[]
  highlight?: string
}

export type MarkdownDocumentFrontmatter = Record<string, string>

export interface ParsedMarkdownDocument {
  frontmatter: MarkdownDocumentFrontmatter
  blocks: MarkdownRenderableBlock[]
}

type MarkdownBlockMetadata = {
  id?: string
  parentBlockId?: string | null
  tags?: string[]
  highlight?: string
}

import { isMarkdownTable } from './markdownTable'

const MARKDOWN_BLOCK_METADATA_PREFIX = '<!-- knowbook:block '
const MARKDOWN_BLOCK_METADATA_SUFFIX = ' -->'

function isNestableMarkdownBlock(type: string) {
  return ['todo', 'bulleted-list', 'numbered-list'].includes(type)
}

function normalizeMarkdownDepth(type: string, depth: number) {
  return isNestableMarkdownBlock(type) ? Math.max(0, Math.min(6, Math.trunc(depth))) : 0
}

function normalizeMarkdownTags(tags: string[] | undefined): string[] | undefined {
  if (!Array.isArray(tags) || tags.length === 0) {
    return undefined
  }

  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
  return normalized.length > 0 ? normalized : undefined
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

function buildMarkdownBlockMetadata(block: MarkdownRenderableBlock): MarkdownBlockMetadata | null {
  const id = block.id?.trim()
  const parentBlockId = block.parentBlockId?.trim()
  const tags = normalizeMarkdownTags(block.tags)
  const highlight = block.highlight?.trim().toLowerCase()

  const metadata: MarkdownBlockMetadata = {}
  if (id) {
    metadata.id = id
  }
  if (parentBlockId) {
    metadata.parentBlockId = parentBlockId
  }
  if (tags) {
    metadata.tags = tags
  }
  if (highlight) {
    metadata.highlight = highlight
  }

  return Object.keys(metadata).length > 0 ? metadata : null
}

function renderMarkdownBlockMetadata(block: MarkdownRenderableBlock): string | null {
  const metadata = buildMarkdownBlockMetadata(block)
  return metadata ? `${MARKDOWN_BLOCK_METADATA_PREFIX}${JSON.stringify(metadata)}${MARKDOWN_BLOCK_METADATA_SUFFIX}` : null
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
    case 'table':
      return block.content
    default:
      return block.content
  }
}

function decodeMarkdownFrontmatterValue(rawValue: string): string {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return ''
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    return typeof parsed === 'string' ? parsed : String(parsed ?? '')
  } catch {
    return trimmed
  }
}

function parseMarkdownFrontmatter(markdown: string): { frontmatter: MarkdownDocumentFrontmatter; body: string } {
  const normalizedMarkdown = markdown.replace(/\r\n/g, '\n')
  if (!normalizedMarkdown.startsWith('---\n')) {
    return {
      frontmatter: {},
      body: normalizedMarkdown
    }
  }

  const closingIndex = normalizedMarkdown.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return {
      frontmatter: {},
      body: normalizedMarkdown
    }
  }

  const frontmatterLines = normalizedMarkdown.slice(4, closingIndex).split('\n')
  const frontmatter: MarkdownDocumentFrontmatter = {}

  for (const line of frontmatterLines) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    if (!key) {
      continue
    }

    frontmatter[key] = decodeMarkdownFrontmatterValue(line.slice(separatorIndex + 1))
  }

  return {
    frontmatter,
    body: normalizedMarkdown.slice(closingIndex + 5)
  }
}

function parseMarkdownBlockMetadata(line: string): MarkdownBlockMetadata | null {
  if (!line.startsWith(MARKDOWN_BLOCK_METADATA_PREFIX) || !line.endsWith(MARKDOWN_BLOCK_METADATA_SUFFIX)) {
    return null
  }

  const rawJson = line.slice(
    MARKDOWN_BLOCK_METADATA_PREFIX.length,
    line.length - MARKDOWN_BLOCK_METADATA_SUFFIX.length
  )

  try {
    const parsed = JSON.parse(rawJson) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const candidate = parsed as Record<string, unknown>
    const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : undefined
    const parentBlockId = typeof candidate.parentBlockId === 'string' && candidate.parentBlockId.trim()
      ? candidate.parentBlockId.trim()
      : null
    const tags = Array.isArray(candidate.tags)
      ? normalizeMarkdownTags(candidate.tags.filter((tag): tag is string => typeof tag === 'string'))
      : undefined
    const highlight = typeof candidate.highlight === 'string' && candidate.highlight.trim()
      ? candidate.highlight.trim().toLowerCase()
      : undefined

    return {
      id,
      parentBlockId,
      tags,
      highlight
    }
  } catch {
    return null
  }
}

function applyMarkdownBlockMetadata(block: MarkdownRenderableBlock, metadata: MarkdownBlockMetadata | null): MarkdownRenderableBlock {
  if (!metadata) {
    return block
  }

  const nextBlock: MarkdownRenderableBlock = {
    ...block,
    id: metadata.id ?? block.id,
    parentBlockId: metadata.parentBlockId ?? block.parentBlockId ?? null
  }

  const tags = metadata.tags ?? block.tags
  if (tags) {
    nextBlock.tags = tags
  }

  const highlight = metadata.highlight ?? block.highlight
  if (highlight) {
    nextBlock.highlight = highlight
  }

  return nextBlock
}

function finalizeParsedMarkdownBlocks(blocks: MarkdownRenderableBlock[]): MarkdownRenderableBlock[] {
  const depthStack: Array<string | undefined> = []

  return blocks.map((block) => {
    const type = block.type.trim() || 'paragraph'
    const id = block.id?.trim() || undefined
    const depth = normalizeMarkdownDepth(type, block.depth ?? 0)
    const parentBlockId = block.parentBlockId?.trim()
      ? block.parentBlockId.trim()
      : (depth > 0 ? depthStack[depth - 1] ?? null : null)

    depthStack.length = depth + 1
    depthStack[depth] = id

    return {
      ...block,
      id,
      depth,
      parentBlockId
    }
  })
}

function parseMarkdownBlocks(markdownBody: string): MarkdownRenderableBlock[] {
  const normalizedBody = markdownBody.replace(/\r\n/g, '\n').trim()
  if (!normalizedBody) {
    return []
  }

  const lines = normalizedBody.split('\n')
  const blocks: MarkdownRenderableBlock[] = []
  let pendingMetadata: MarkdownBlockMetadata | null = null

  for (let index = 0; index < lines.length;) {
    while (index < lines.length && lines[index]?.trim() === '') {
      index += 1
    }

    if (index >= lines.length) {
      break
    }

    const metadata = parseMarkdownBlockMetadata(lines[index] ?? '')
    if (metadata) {
      pendingMetadata = metadata
      index += 1
      continue
    }

    const line = lines[index] ?? ''
    let block: MarkdownRenderableBlock

    if (line.startsWith('```')) {
      const language = line.slice(3).trim() || undefined
      const contentLines: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        contentLines.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }

      block = {
        type: 'code',
        content: contentLines.join('\n'),
        checked: false,
        depth: 0,
        language
      }
    } else if (line === '$$') {
      const contentLines: string[] = []
      index += 1
      while (index < lines.length && (lines[index] ?? '') !== '$$') {
        contentLines.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }

      block = {
        type: 'math',
        content: contentLines.join('\n'),
        checked: false,
        depth: 0
      }
    } else if (/^##\s+/.test(line)) {
      block = {
        type: 'heading-2',
        content: line.replace(/^##\s+/, ''),
        checked: false,
        depth: 0
      }
      index += 1
    } else if (/^#\s+/.test(line)) {
      block = {
        type: 'heading-1',
        content: line.replace(/^#\s+/, ''),
        checked: false,
        depth: 0
      }
      index += 1
    } else if (/^> ?/.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^> ?/.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^> ?/, ''))
        index += 1
      }

      block = {
        type: 'quote',
        content: quoteLines.join('\n'),
        checked: false,
        depth: 0
      }
    } else if (line === '---') {
      block = {
        type: 'divider',
        content: '',
        checked: false,
        depth: 0
      }
      index += 1
    } else if (line.includes('|') && index + 1 < lines.length && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1]?.trim() ?? '')) {
      const tableLines: string[] = [line]
      index += 1
      while (index < lines.length && (lines[index] ?? '').trim() !== '') {
        tableLines.push(lines[index] ?? '')
        index += 1
      }

      block = {
        type: 'table',
        content: tableLines.join('\n'),
        checked: false,
        depth: 0
      }
    } else {
      const todoMatch = line.match(/^(\s*)-\s\[([xX ])\]\s+(.*)$/)
      const bulletMatch = line.match(/^(\s*)-\s+(.*)$/)
      const numberedMatch = line.match(/^(\s*)1\.\s+(.*)$/)

      if (todoMatch) {
        block = {
          type: 'todo',
          content: todoMatch[3] ?? '',
          checked: (todoMatch[2] ?? '').toLowerCase() === 'x',
          depth: Math.floor((todoMatch[1] ?? '').length / 2)
        }
        index += 1
      } else if (bulletMatch) {
        block = {
          type: 'bulleted-list',
          content: bulletMatch[2] ?? '',
          checked: false,
          depth: Math.floor((bulletMatch[1] ?? '').length / 2)
        }
        index += 1
      } else if (numberedMatch) {
        block = {
          type: 'numbered-list',
          content: numberedMatch[2] ?? '',
          checked: false,
          depth: Math.floor((numberedMatch[1] ?? '').length / 2)
        }
        index += 1
      } else {
        const paragraphLines = [line]
        index += 1
        while (index < lines.length && (lines[index] ?? '').trim() !== '') {
          if (parseMarkdownBlockMetadata(lines[index] ?? '')) {
            break
          }
          paragraphLines.push(lines[index] ?? '')
          index += 1
        }

        block = {
          type: 'paragraph',
          content: paragraphLines.join('\n'),
          checked: false,
          depth: 0
        }
      }
    }

    blocks.push(applyMarkdownBlockMetadata(block, pendingMetadata))
    pendingMetadata = null
  }

  return finalizeParsedMarkdownBlocks(blocks)
}

export function serializeBlocksToMarkdown(
  blocks: MarkdownRenderableBlock[],
  options: {
    fallbackCodeLanguage?: string
    includeBlockMetadata?: boolean
  } = {}
): string {
  const effectiveDepths = resolveMarkdownBlockDepths(blocks)

  return blocks
    .map((block, index) => {
      const renderedBlock = renderMarkdownBlock(block, effectiveDepths[index] ?? 0, options.fallbackCodeLanguage ?? '')
      if (!options.includeBlockMetadata) {
        return renderedBlock
      }

      const metadata = renderMarkdownBlockMetadata(block)
      return metadata ? `${metadata}\n${renderedBlock}` : renderedBlock
    })
    .join('\n\n')
}

export function renderMarkdownFrontmatter(frontmatter: MarkdownDocumentFrontmatter): string {
  const lines = ['---']

  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${JSON.stringify(value)}`)
  }

  lines.push('---', '')
  return lines.join('\n')
}

export function parseMarkdownBackupDocument(markdown: string): ParsedMarkdownDocument {
  const { frontmatter, body } = parseMarkdownFrontmatter(markdown)
  return {
    frontmatter,
    blocks: parseMarkdownBlocks(body)
  }
}