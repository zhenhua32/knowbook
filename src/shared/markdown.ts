import { getHeadingLevel, markdownEngine, markdownTokenTree, type MarkdownNode } from './markdownEngine'

export type MarkdownRenderableBlock = {
  id?: string
  type: string
  content: string
  checked?: boolean
  depth?: number
  parentBlockId?: string | null
  language?: string | null
  listStart?: number
  tags?: string[]
  highlight?: string
}

export type MarkdownDocumentFrontmatter = Record<string, string>

export interface ParsedMarkdownDocument {
  frontmatter: MarkdownDocumentFrontmatter
  blocks: MarkdownRenderableBlock[]
}

type MarkdownBlockMetadata = {
  type?: string
  depth?: number
  listStart?: number
  id?: string
  parentBlockId?: string | null
  tags?: string[]
  highlight?: string
}

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

  return blocks.map((block, index) => {
    const type = block.type.trim() || 'paragraph'
    const blockId = block.id?.trim() && !seenIds.has(block.id) ? block.id
      : !block.id && isNestableMarkdownBlock(type) ? `\0anonymous:${index}` : null
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
    if (!block.id && effectiveDepth > 0 && !depthStack[effectiveDepth - 1]) effectiveDepth = 0
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

  const metadata: MarkdownBlockMetadata = { type: block.type, depth: block.depth ?? 0, listStart: block.listStart }
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
  indent: string,
  fallbackCodeLanguage = '',
  orderedDelimiter = '.'
): string {
  const type = block.type.trim() || 'paragraph'
  const heading = getHeadingLevel(type)
  if (heading) return '#'.repeat(heading) + ' ' + block.content
  const listItem = (marker: string) => indent + marker + block.content.split('\n').map((line, index) => index === 0 ? line : '\n' + indent + ' '.repeat(marker.startsWith('-') ? 2 : marker.length) + line).join('')

  switch (type) {
    case 'todo':
      return listItem(`- [${block.checked ? 'x' : ' '}] `)
    case 'quote':
      return block.content
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'bulleted-list':
      return listItem('- ')
    case 'numbered-list':
      return listItem(`${block.listStart ?? 1}${orderedDelimiter} `)
    case 'divider':
      return '---'
    case 'math':
      return ['$$', block.content, '$$'].join('\n')
    case 'code': {
      const language = block.language ?? fallbackCodeLanguage
      const marker = language.includes('`') ? '~' : '`'
      const runs = block.content.match(marker === '`' ? /`+/g : /~+/g) ?? []
      const fence = marker.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
      return [fence + language, block.content, fence].join('\n')
    }
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
  const normalizedMarkdown = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalizedMarkdown.startsWith('---\n')) {
    return {
      frontmatter: {},
      body: normalizedMarkdown
    }
  }

  const closingIndex = normalizedMarkdown.search(/\n---(?:\n|$)/)
  if (closingIndex === -1) {
    return {
      frontmatter: {},
      body: normalizedMarkdown
    }
  }

  const frontmatterLines = normalizedMarkdown.slice(4, closingIndex).split('\n')
  if (!frontmatterLines.some((line) => /^[A-Za-z][\w-]*:/.test(line))) return { frontmatter: {}, body: normalizedMarkdown }
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
      type: typeof candidate.type === 'string' ? candidate.type : undefined,
      depth: typeof candidate.depth === 'number' ? candidate.depth : undefined,
      listStart: typeof candidate.listStart === 'number' ? candidate.listStart : undefined,
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
    depth: metadata.depth ?? block.depth,
    ...(metadata.listStart !== undefined ? { listStart: metadata.listStart } : {}),
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
  const depthById = new Map<string, number>()
  return blocks.map((block) => {
    const id = block.id?.trim() || undefined
    const explicitParent = block.parentBlockId?.trim() || null
    const parentDepth = explicitParent ? depthById.get(explicitParent) : undefined
    const depth = normalizeMarkdownDepth(block.type, parentDepth === undefined ? block.depth ?? 0 : parentDepth + 1)
    const parentBlockId = explicitParent ?? (depth > 0 ? depthStack[depth - 1] ?? null : null)
    depthStack.length = depth + 1
    depthStack[depth] = id
    if (id) depthById.set(id, depth)
    return { ...block, id, depth, parentBlockId }
  })
}

function trimBlankLines(source: string): string {
  return source.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '')
}

function stripListMarker(source: string): string {
  const lines = source.split('\n')
  const prefix = lines[0].match(/^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/)?.[0] ?? ''
  const indent = prefix.replace(/\t/g, '    ').length
  lines[0] = lines[0].slice(prefix.length)
  return trimBlankLines([lines[0], ...lines.slice(1).map((line) => {
    let removed = 0
    return line.replace(/^[ \t]*/, (space) => {
      let index = 0
      while (index < space.length && removed < indent) {
        removed += space[index++] === '\t' ? 4 - removed % 4 : 1
      }
      return ' '.repeat(Math.max(0, removed - indent)) + space.slice(index)
    })
  })].join('\n'))
}

/** Parse source into editable blocks. Complex list bodies remain Markdown in the
 * item; simple nested lists become the existing flat parent/depth structure. */
export function parseMarkdownBlocks(markdownBody: string): MarkdownRenderableBlock[] {
  const source = markdownBody.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return []
  const lines = source.split('\n')
  const nodes = markdownTokenTree(markdownEngine.parse(source, {}))
  const blocks: MarkdownRenderableBlock[] = []
  const raw = (node: MarkdownNode) => trimBlankLines(lines.slice(...node.token.map!).join('\n'))
  const make = (type: string, content: string, depth = 0): MarkdownRenderableBlock => ({ type, content, checked: false, depth })
  const append = (node: MarkdownNode, depth = 0) => {
    const { token, children } = node
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const ordered = token.type === 'ordered_list_open'
      children.forEach((item, index) => {
        const simple = item.children[0]?.token.type === 'paragraph_open'
          && item.children.slice(1).every((child) => ['bullet_list_open', 'ordered_list_open'].includes(child.token.type))
          && depth < 6 && !/^\s*\[[^\]]+\]:/m.test(raw(item))
        let content = simple ? item.children[0].children[0]?.token.content ?? '' : stripListMarker(raw(item))
        const task = !ordered && content.match(/^\[([ xX])\](?:[ \t]+|$)/)
        if (task) content = content.slice(task[0].length)
        const block = make(task ? 'todo' : ordered ? 'numbered-list' : 'bulleted-list', content, depth)
        block.checked = task ? task[1].toLowerCase() === 'x' : false
        if (ordered && index === 0) block.listStart = Number(token.attrGet('start') ?? 1)
        blocks.push(block)
        if (simple) item.children.slice(1).forEach((child) => append(child, depth + 1))
      })
    } else if (token.type === 'heading_open') {
      blocks.push(make('heading-' + token.tag.slice(1), children[0]?.token.content ?? ''))
    } else if (token.type === 'fence' || token.type === 'code_block') {
      blocks.push({ ...make('code', token.content.replace(/\n$/, '')), language: token.info.trim() || undefined })
    } else if (token.type === 'math_block') {
      blocks.push(make('math', token.content))
    } else if (token.type === 'hr') {
      blocks.push(make('divider', ''))
    } else if (token.type === 'table_open') {
      blocks.push(make('table', raw(node)))
    } else if (token.type === 'blockquote_open') {
      blocks.push(make('quote', raw(node).split('\n').map((line) => line.replace(/^ {0,3}>[ \t]?/, '')).join('\n')))
    } else {
      blocks.push(make('paragraph', raw(node)))
    }
  }

  let cursor = 0
  let pending: MarkdownBlockMetadata | null = null
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (!node.token.map) continue
    const gap = trimBlankLines(lines.slice(cursor, node.token.map[0]).join('\n'))
    // Reference definitions produce no Markdown tokens. Keep their source so
    // definitions stay editable, survive export, and can resolve across blocks.
    if (gap.trim()) blocks.push(make('paragraph', gap))
    cursor = node.token.map[1]
    if (node.token.type === 'knowbook_metadata') {
      pending = parseMarkdownBlockMetadata(node.token.content)
      if (!pending) blocks.push(make('paragraph', node.token.content))
      else if (pending.type) {
        let next = index + 1
        while (next < nodes.length && nodes[next].token.type !== 'knowbook_metadata') next++
        const end = nodes[next]?.token.map?.[0] ?? lines.length
        const body = trimBlankLines(lines.slice(cursor, end).join('\n'))
        let parsed = parseMarkdownBlocks(body)[0] ?? make(pending.type, '')
        if (['paragraph', 'table'].includes(pending.type)) parsed = make(pending.type, body)
        else if (isNestableMarkdownBlock(pending.type)) {
          let content = stripListMarker(body)
          if (pending.type === 'todo') content = content.replace(/^\[[ xX]\](?:[ \t]+|$)/, '')
          parsed = { ...parsed, type: pending.type, content }
        }
        if (getHeadingLevel(pending.type)) parsed.content = body.replace(/^ {0,3}#{1,6}[ \t]?/, '')
        if (pending.type === 'numbered-list') {
          delete parsed.listStart
          if (pending.listStart !== undefined) parsed.listStart = normalizeListStart(pending.listStart)
        }
        blocks.push(applyMarkdownBlockMetadata({ ...parsed, type: pending.type }, pending))
        pending = null
        cursor = end
        index = next - 1
      }
      continue
    }
    const before = blocks.length
    append(node)
    if (pending && blocks[before]) {
      blocks[before] = applyMarkdownBlockMetadata(blocks[before], pending)
      pending = null
    }
  }
  const remaining = trimBlankLines(lines.slice(cursor).join('\n'))
  if (remaining.trim()) blocks.push(applyMarkdownBlockMetadata(make('paragraph', remaining), pending))
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
  const indents: string[] = []
  const markers: number[] = []
  const orderedDelimiters = new Map<number, string>()
  const numbers = getMarkdownListNumbers(blocks)

  return blocks
    .map((block, index) => {
      const depth = effectiveDepths[index] ?? 0
      const indent = depth > 0 ? (indents[depth - 1] ?? '') + ' '.repeat(markers[depth - 1] ?? 2) : ''
      indents[depth] = indent
      const number = numbers[index]
      markers[depth] = block.type === 'numbered-list' ? String(number).length + 2 : 2
      for (const key of orderedDelimiters.keys()) if (key > depth) orderedDelimiters.delete(key)
      const previousDelimiter = orderedDelimiters.get(depth)
      // Changing delimiter starts a separate CommonMark list. Blank lines alone
      // cannot preserve an explicit numbering restart between adjacent lists.
      const delimiter = previousDelimiter && block.listStart !== undefined ? previousDelimiter === '.' ? ')' : '.' : previousDelimiter ?? '.'
      if (block.type === 'numbered-list') orderedDelimiters.set(depth, delimiter)
      else orderedDelimiters.delete(depth)
      const renderedBlock = renderMarkdownBlock(block.type === 'numbered-list' ? { ...block, listStart: number } : block, indent, options.fallbackCodeLanguage ?? '', delimiter)
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
/** Number the complete document before hiding folded rows. Child lists must not
 * reset their parent's sequence. Explicit starts are retained on the first item. */
export function getMarkdownListNumbers(blocks: MarkdownRenderableBlock[]): number[] {
  const counts = new Map<number, number>()
  return blocks.map((block) => {
    const depth = block.depth ?? 0
    for (const key of counts.keys()) if (key > depth) counts.delete(key)
    if (block.type !== 'numbered-list') { counts.delete(depth); return 0 }
    const value = normalizeListStart(block.listStart) ?? (counts.get(depth) ?? 0) + 1
    counts.set(depth, value)
    return value
  })
}

export function normalizeListStart(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value! >= 0 && value! <= 999999999 ? value : undefined
}
