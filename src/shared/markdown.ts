import { encodeNativeLiteralText, decodedNativeSourceLines, type NativeTextProjection } from './markdownNativeText'
import { getHeadingLevel, markdownEngine, markdownTokenTree, type MarkdownNode } from './markdownEngine'
import { isTaskBlockType, isOrderedListBlockType, isContainerBlockType, isNativeStructureBlockType, canBlockNestUnder, isListBlockType } from './blockTypes'
import { assertColumnStructure } from './columns'
import { assertNativeContainerParse, nativeMarkdownContainer, renderNativeContainerHeader, nativeContainerClosingTag, validateNativeContainerFormat, nativeContainerFormatsAgree, parseNativeContainerOpening, NativeMarkdownContainerError } from './markdownContainers'
import { parseTaskListMarker } from './markdownExtensions'
import { normalizeMarkdownFormat, type MarkdownBlockFormat } from './markdownFormat'
import { extractMarkdownFrontmatter, KNOWBOOK_BACKUP_MARKER } from './markdownFrontmatter'

function assertMarkdownColumnStructure(blocks: MarkdownRenderableBlock[]): void {
  try { assertColumnStructure(blocks) }
  catch (error) { throw new NativeMarkdownContainerError(error instanceof Error ? error.message : String(error)) }
}

export type MarkdownRenderableBlock = {
  id?: string
  type: string
  content: string
  checked?: boolean
  depth?: number
  parentBlockId?: string | null
  language?: string | null
  listStart?: number
  markdownFormat?: MarkdownBlockFormat
  tags?: string[]
  highlight?: string
}

export type MarkdownDocumentFrontmatter = Record<string, string>

export interface ParsedMarkdownDocument {
  frontmatter: MarkdownDocumentFrontmatter
  isKnowbookBackup: boolean
  blocks: MarkdownRenderableBlock[]
}

type MarkdownBlockMetadata = {
  parentSpecified?: boolean
  type?: string
  depth?: number
  listStart?: number
  markdownFormat?: MarkdownBlockFormat
  id?: string
  parentBlockId?: string | null
  tags?: string[]
  highlight?: string
}

const MARKDOWN_BLOCK_METADATA_PREFIX = '<!-- knowbook:block '
const MARKDOWN_BLOCK_METADATA_SUFFIX = ' -->'

function isNestableMarkdownBlock(type: string) {
  return ['todo', 'numbered-todo', 'bulleted-list', 'numbered-list'].includes(type)
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

  const metadata: MarkdownBlockMetadata = { type: block.type, depth: block.depth ?? 0, listStart: block.listStart, markdownFormat: block.markdownFormat }
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
  if (heading) {
    if (heading <= 2 && (block.content.includes('\n') || /[ \t]#+$/.test(block.content))) {
      return block.content + '\n' + (heading === 1 ? '===' : '---')
    }
    return '#'.repeat(heading) + ' ' + block.content
  }
  const listItem = (marker: string, content = block.content) => indent + marker + content.split('\n').map((line, index) => index === 0 ? line : '\n' + indent + ' '.repeat(marker.length) + line).join('')

  switch (type) {
    case 'todo':
      return listItem(`${block.markdownFormat?.listMarker ?? '-'} `, `[${block.checked ? 'x' : ' '}] ${block.content}`)
    case 'numbered-todo':
      return listItem(`${block.listStart ?? 1}${orderedDelimiter} `, `[${block.checked ? 'x' : ' '}] ${block.content}`)
    case 'quote':
      return block.content
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'bulleted-list':
      return listItem(`${block.markdownFormat?.listMarker ?? '-'} `)
    case 'numbered-list':
      return listItem(`${block.listStart ?? 1}${orderedDelimiter} `)
    case 'divider':
      return '---'
    case 'math':
      return ['$$', block.content, '$$'].join('\n')
    case 'code': {
      const language = block.markdownFormat?.codeInfo ?? block.language ?? fallbackCodeLanguage
      const marker = language.includes('`') ? '~' : '`'
      const runs = block.content.match(marker === '`' ? /`+/g : /~+/g) ?? []
      const fence = marker.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
      return (block.markdownFormat?.emptyCode && !block.content ? [fence + language, fence] : [fence + language, block.content, fence]).join('\n')
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
  const header = extractMarkdownFrontmatter(normalizedMarkdown)
  if (!header) {
    return {
      frontmatter: {},
      body: normalizedMarkdown
    }
  }

  const frontmatterLines = header.raw.split('\n').slice(1, -1)
  const frontmatter: MarkdownDocumentFrontmatter = {}

  for (const line of frontmatterLines) {
    if (!/^[A-Za-z][\w-]*:/.test(line)) continue
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
    body: header.body
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
    if (candidate.type === 'columns' || candidate.type === 'column') {
      const allowed = ['type', 'depth', 'id', 'parentBlockId', 'tags', 'highlight', 'markdownFormat']
      if (Object.keys(candidate).some(key => !allowed.includes(key))
        || Object.hasOwn(candidate, 'id') && (typeof candidate.id !== 'string' || !candidate.id || candidate.id !== candidate.id.trim())
        || Object.hasOwn(candidate, 'parentBlockId') && candidate.parentBlockId !== null
          && (typeof candidate.parentBlockId !== 'string' || !candidate.parentBlockId || candidate.parentBlockId !== candidate.parentBlockId.trim())
        || Object.hasOwn(candidate, 'depth') && (!Number.isSafeInteger(candidate.depth) || Number(candidate.depth) < 0 || Number(candidate.depth) > 6)) {
        throw new NativeMarkdownContainerError('invalid backup layout identity, depth or property')
      }
    }
    if (typeof candidate.type === 'string') validateNativeContainerFormat(candidate.type, candidate.markdownFormat)
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
      markdownFormat: normalizeMarkdownFormat(typeof candidate.type === 'string' ? candidate.type : '', candidate.markdownFormat),
      id,
      parentBlockId,
      parentSpecified: Object.hasOwn(candidate, 'parentBlockId'),
      tags,
      highlight
    }
  } catch (error) {
    if (error instanceof NativeMarkdownContainerError) throw error
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
    ...(metadata.markdownFormat ? { markdownFormat: metadata.markdownFormat } : {}),
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

/** Anonymous keys stay private: ordinary files do not acquire persistent IDs. */
function resolveContainerMarkdownDepths(blocks: MarkdownRenderableBlock[]): number[] {
  const stack: Array<{ key: string; type: string }> = []
  return blocks.map((block, index) => {
    const explicit = block.parentBlockId ? stack.findIndex(parent => parent.key === block.parentBlockId) : -1
    let depth = explicit >= 0 ? explicit + 1 : Math.max(0, Math.min(6, Math.trunc(block.depth ?? 0)))
    depth = Math.min(depth, stack.length)
    while (depth > 0 && !canBlockNestUnder(stack[depth - 1].type, block.type)) depth--
    stack.length = depth
    stack[depth] = { key: block.id || '\0anonymous:' + index, type: block.type }
    return depth
  })
}
function finalizeParsedMarkdownBlocks(blocks: MarkdownRenderableBlock[]): MarkdownRenderableBlock[] {
  const depthStack: Array<string | undefined> = []
  const depthById = new Map<string, number>()
  const nativeDepths = blocks.some(block => isNativeStructureBlockType(block.type)) ? resolveContainerMarkdownDepths(blocks) : null
  return blocks.map((block, index) => {
    const id = block.id?.trim() || undefined
    const explicitParent = block.parentBlockId?.trim() || null
    const parentDepth = explicitParent ? depthById.get(explicitParent) : undefined
    const depth = nativeDepths?.[index] ?? normalizeMarkdownDepth(block.type, parentDepth === undefined ? block.depth ?? 0 : parentDepth + 1)
    const parentBlockId = nativeDepths ? depth > 0 ? depthStack[depth - 1] ?? null : null
      : explicitParent ?? (depth > 0 ? depthStack[depth - 1] ?? null : null)
    depthStack.length = depth + 1
    depthStack[depth] = id
    if (id) depthById.set(id, depth)
    return { ...block, id, depth, parentBlockId }
  })
}

function trimBlankLines(source: string): string {
  return source.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '')
}

function stripListMarker(source: string, keepBlankLines = false): string {
  const lines = source.split('\n')
  // Expand only indentation tabs, at real four-column stops. Five or more
  // spaces after the marker mean one padding space followed by code indent.
  const expanded = expandLeadingTabs(lines[0])
  const marker = expanded.match(/^ *(?:[-+*]|\d{1,9}[.)])(?= |$)/)?.[0] ?? ''
  const padding = expanded.slice(marker.length).match(/^ */)![0].length
  const indent = marker.length + (!expanded.slice(marker.length).trim() || padding > 4 ? 1 : padding)
  lines[0] = expanded.slice(Math.min(indent, expanded.length))
  const body = [lines[0], ...lines.slice(1).map((line) => stripIndent(line, indent))].join('\n')
  return keepBlankLines ? body : trimBlankLines(body)
}

function expandLeadingTabs(line: string): string {
  let column = 0
  return line.replace(/^[ \t]*(?:[-+*]|\d{1,9}[.)]|>)?[ \t]*/, (prefix) => [...prefix].map((char) => {
    const width = char === '\t' ? 4 - column % 4 : 1
    column += width
    return char === '\t' ? ' '.repeat(width) : char
  }).join(''))
}

function stripIndent(line: string, indent: number): string {
  const expanded = expandLeadingTabs(line)
  return expanded.slice(Math.min(indent, expanded.match(/^ */)![0].length))
}

function protectParagraphContinuations(content: string): string {
  // Lazy continuation lines can look like new blocks once a container gains
  // explicit indentation/quote markers. Escape only when inline meaning stays
  // identical (in particular, never insert escapes inside a multiline code span).
  const continuations = [...content.matchAll(/\n([ \t]*)(?=(?:#{1,6}[ \t]|[-+*][ \t]|(?:[-*_][ \t]*){3,}$|=+[ \t]*$|`{3,}|~{3,}|>|\$\$[ \t]*$))|\n([ \t]*\d{1,9})(?=[.)][ \t])/gm)]
  if (!continuations.length) return content
  const original = markdownEngine.renderInline(content)
  for (const match of continuations.reverse()) {
    const at = match.index + match[0].length
    const escaped = content.slice(0, at) + '\\' + content.slice(at)
    if (markdownEngine.renderInline(escaped) === original) content = escaped
    else {
      // A newline within a code span already renders as a space. Joining just
      // that newline avoids a Setext heading without changing code contents.
      const joined = content.slice(0, match.index) + ' ' + content.slice(match.index + 1)
      if (markdownEngine.renderInline(joined) === original) content = joined
    }
  }
  return content
}

function protectContainerParagraphs(body: string, children: MarkdownNode[], firstLine: number): string {
  const lines = body.split('\n')
  // Joining code-span newlines can shorten a paragraph. Work backwards so the
  // parser's original line maps remain valid for earlier paragraphs.
  for (const child of [...children].reverse()) {
    if (child.token.type !== 'paragraph_open' || !child.token.map) continue
    const start = child.token.map[0] - firstLine
    const end = child.token.map[1] - firstLine
    lines.splice(start, end - start, ...protectParagraphContinuations(lines.slice(start, end).join('\n')).split('\n'))
  }
  return lines.join('\n')
}

/** Parse source into editable blocks. Complex list bodies remain Markdown in the
 * item; simple nested lists become the existing flat parent/depth structure. */
export function parseMarkdownBlocks(markdownBody: string, sourceRanges?: MarkdownBlockSourceRange[], closingRanges?: MarkdownContainerClosingRange[]): MarkdownRenderableBlock[] {
  if (sourceRanges) sourceRanges.length = 0
  if (closingRanges) closingRanges.length = 0
  const source = markdownBody.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return []
  const environment: Record<string, unknown> = {}
  const tokens = markdownEngine.parse(source, environment)
  const lines = decodedNativeSourceLines(source, tokens)
  const nodes = markdownTokenTree(tokens)
  assertNativeContainerParse(environment)
  const blocks: MarkdownRenderableBlock[] = []
  const declared = new Map<number, { metadata: MarkdownBlockMetadata; scopeDepth: number; scopeParent?: number }>()
  const push = (block: MarkdownRenderableBlock, startLine: number, endLine: number) => {
    while (startLine < endLine && !lines[startLine]?.trim()) startLine++
    while (endLine > startLine && !lines[endLine - 1]?.trim()) endLine--
    sourceRanges?.push({ index: blocks.length, startLine, endLine })
    blocks.push(block)
  }
  const rawStart = (node: MarkdownNode): number => node.token.type === 'table_open' && node.token.meta?.tableLayoutMap
    ? (node.token.meta.tableLayoutMap as [number, number])[0] : node.token.map![0]
  const raw = (node: MarkdownNode) => trimBlankLines(lines.slice(rawStart(node), node.token.map![1]).join('\n'))
  const make = (type: string, content: string, depth = 0): MarkdownRenderableBlock => ({ type, content, checked: false, depth })
  const append = (node: MarkdownNode, depth = 0, metadata: MarkdownBlockMetadata | null = null, metadataLine?: number, scopeParent?: number): void => {
    const { token, children } = node
    // An unsupported multi-line marked opening may have fallen back to a legacy
    // HTML/paragraph node. Validate only that node's opening, never the remaining
    // document or literal code/math/quotes.
    if (token.type === 'paragraph_open' || token.type === 'html_details_open') {
      const opening = /^<[a-z][\w-]*(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(raw(node))?.[0]
      if (opening && /[\r\n]/.test(opening) && parseNativeContainerOpening(opening))
        throw new NativeMarkdownContainerError('marked opening shell must occupy one line')
    }
    const container = nativeMarkdownContainer(token)
    if (container) {
      if (depth > 6) throw new NativeMarkdownContainerError('editable container nesting exceeds six levels')
      if (metadata?.type && metadata.type !== container.type) throw new NativeMarkdownContainerError('backup type does not match its container shell')
      const title = children.find(child => child.token.type === 'native_container_title')
      if (!title && isContainerBlockType(container.type)) throw new NativeMarkdownContainerError('missing title token')
      const ownerIndex = blocks.length
      let owner: MarkdownRenderableBlock = { ...make(container.type, title?.token.content ?? '', depth), markdownFormat: container.markdownFormat }
      if (metadata) {
        if (!nativeContainerFormatsAgree(container.type, metadata.markdownFormat, container.markdownFormat))
          throw new NativeMarkdownContainerError('backup container format conflicts with its shell')
        declared.set(ownerIndex, { metadata, scopeDepth: depth, scopeParent })
        delete owner.markdownFormat
        owner = applyMarkdownBlockMetadata(owner, metadata)
      }
      push(owner, metadataLine ?? container.headerRange[0], container.headerRange[1])
      appendScope(children.filter(child => child !== title), ...container.bodyRange, depth + 1, ownerIndex)
      closingRanges?.push({ index: ownerIndex, startLine: container.closingRange[0], endLine: container.closingRange[1] })
      return
    }
    const put = (block: MarkdownRenderableBlock, startLine: number, endLine: number) => push({ ...block, depth: block.depth || depth }, startLine, endLine)
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const ordered = token.type === 'ordered_list_open'
      const loose = children.some(item => item.children.some(child => child.token.type === 'paragraph_open' && !child.token.hidden))
      children.forEach((item, index) => {
        const simple = item.children[0]?.token.type === 'paragraph_open'
          && item.children.slice(1).every(child => ['bullet_list_open', 'ordered_list_open'].includes(child.token.type))
          && depth < 6 && !/^\s*\[[^\]]+\]:/m.test(raw(item))
        let content = simple ? protectParagraphContinuations(item.children[0].children[0]?.token.content ?? '')
          : trimBlankLines(protectContainerParagraphs(stripListMarker(raw(item), true), item.children, item.token.map![0]))
        const task = item.children[0]?.token.type === 'paragraph_open' ? parseTaskListMarker(content) : null
        if (task) content = content.slice(task.length)
        const block = make(task ? ordered ? 'numbered-todo' : 'todo' : ordered ? 'numbered-list' : 'bulleted-list', content, depth)
        block.checked = task?.checked ?? false
        block.markdownFormat = { listMarker: token.markup as MarkdownBlockFormat['listMarker'], listLoose: loose }
        if (ordered && index === 0) block.listStart = Number(token.attrGet('start') ?? 1)
        push(block, item.token.map![0], simple ? item.children[0].token.map![1] : item.token.map![1])
        if (simple) item.children.slice(1).forEach(child => append(child, depth + 1))
      })
    } else if (token.type === 'heading_open') put(make('heading-' + token.tag.slice(1), children[0]?.token.content ?? ''), ...token.map!)
    else if (token.type === 'fence' || token.type === 'code_block') put({ ...make('code', token.content.replace(/\n$/, '')), language: token.info.trim() || undefined,
      markdownFormat: { codeInfo: token.info.trim(), ...(token.content === '' ? { emptyCode: true } : {}) } }, ...token.map!)
    else if (token.type === 'frontmatter') put(make('frontmatter', token.content), ...token.map!)
    else if (token.type === 'html_details_open' || token.type === 'html_figure_open') put(make('html', raw(node)), ...token.map!)
    else if (token.type === 'math_block') put(make('math', token.content), ...token.map!)
    else if (token.type === 'hr') put(make('divider', ''), ...token.map!)
    else if (token.type === 'table_open') put(make('table', raw(node)), rawStart(node), token.map![1])
    else if (token.type === 'blockquote_open') {
      const body = raw(node).split('\n').map(line => expandLeadingTabs(line).replace(/^ {0,3}> ?/, '')).join('\n')
      put(make('quote', protectContainerParagraphs(body, children, token.map![0])), ...token.map!)
    } else put(make('paragraph', raw(node).replace(/^ {1,3}(?=\S)/gm, '')), ...token.map!)
  }
  const appendScope = (items: MarkdownNode[], scopeStart: number, scopeEnd: number, depth: number, scopeParent?: number): void => {
    if (depth > 6 && trimBlankLines(lines.slice(scopeStart, scopeEnd).join('\n'))) throw new NativeMarkdownContainerError('editable child nesting exceeds six levels')
    let cursor = scopeStart
    let pending: MarkdownBlockMetadata | null = null
    for (let index = 0; index < items.length; index++) {
      const node = items[index]
      if (!node.token.map || node.token.type === 'footnote_block_open') continue
      const gap = trimBlankLines(lines.slice(cursor, node.token.map[0]).join('\n'))
      if (gap.trim()) push(make('paragraph', gap, depth), cursor, node.token.map[0])
      cursor = node.token.map[1]
      if (node.token.type === 'knowbook_table_layout' && node.token.meta?.boundTableLayout) continue
      if (node.token.type === 'knowbook_metadata') {
        pending = parseMarkdownBlockMetadata(node.token.content)
        if (!pending) push(make('paragraph', node.token.content, depth), ...node.token.map)
        else if (pending.type && isNativeStructureBlockType(pending.type)) {
          const next = items[index + 1]
          if (!next || !nativeMarkdownContainer(next.token)) throw new NativeMarkdownContainerError('backup container metadata has no matching shell')
          append(next, depth, pending, node.token.map[0], scopeParent)
          cursor = next.token.map![1]; index++; pending = null
        } else if (pending.type) {
          let next = index + 1
          while (next < items.length && items[next].token.type !== 'knowbook_metadata') next++
          const end = items[next]?.token.map?.[0] ?? scopeEnd
          const body = trimBlankLines(lines.slice(cursor, end).join('\n'))
          let parsed = parseMarkdownBlocks(body)[0] ?? make(pending.type, '')
          if (['paragraph', 'table', 'frontmatter', 'html'].includes(pending.type)) parsed = make(pending.type, body)
          else if (isNestableMarkdownBlock(pending.type)) {
            let content = stripListMarker(body)
            const task = isTaskBlockType(pending.type) ? parseTaskListMarker(content) : null
            if (task) content = content.slice(task.length)
            parsed = { ...make(pending.type, content), checked: task?.checked ?? false }
          }
          if (depth > 0 && pending.type === 'frontmatter') throw new NativeMarkdownContainerError('frontmatter cannot be a container child')
          if (getHeadingLevel(pending.type) && /^ {0,3}#{1,6}(?:[ \t]|$)/.test(body)) parsed.content = body.replace(/^ {0,3}#{1,6}[ \t]?/, '')
          if (isOrderedListBlockType(pending.type)) {
            delete parsed.listStart
            if (pending.listStart !== undefined) parsed.listStart = normalizeListStart(pending.listStart)
          }
          delete parsed.markdownFormat
          declared.set(blocks.length, { metadata: pending, scopeDepth: depth, scopeParent })
          push(applyMarkdownBlockMetadata({ ...parsed, type: pending.type, depth }, pending), node.token.map[0], end)
          pending = null; cursor = end; index = next - 1
        }
        continue
      }
      const before = blocks.length
      append(node, depth, null, undefined, scopeParent)
      if (pending && blocks[before]) { blocks[before] = applyMarkdownBlockMetadata(blocks[before], pending); pending = null }
    }
    const remaining = trimBlankLines(lines.slice(cursor, scopeEnd).join('\n'))
    if (remaining.trim()) push(applyMarkdownBlockMetadata(make('paragraph', remaining, depth), pending), cursor, scopeEnd)
  }
  appendScope(nodes, 0, lines.length, 0)
  if (blocks.some(value => isNativeStructureBlockType(value.type)) && declared.size) {
    const ids = new Set<string>(), active: MarkdownRenderableBlock[] = []
    for (let index = 0; index < blocks.length; index++) {
      const value = blocks[index], entry = declared.get(index)
      if (value.id) {
        if (ids.has(value.id)) throw new NativeMarkdownContainerError('duplicate backup block identity')
        ids.add(value.id)
      }
      const depth = value.depth ?? 0
      if (!Number.isInteger(depth) || depth < 0 || depth > 6) throw new NativeMarkdownContainerError('invalid backup block depth')
      if (entry) {
        if (isListBlockType(value.type)) {
          if (depth < entry.scopeDepth) throw new NativeMarkdownContainerError('list metadata escapes its container scope')
          for (let ancestor = entry.scopeDepth; ancestor < depth; ancestor++)
            if (!isListBlockType(active[ancestor]?.type ?? '')) throw new NativeMarkdownContainerError('list metadata points outside its active list')
        } else if (depth !== entry.scopeDepth) throw new NativeMarkdownContainerError('metadata depth does not match its container scope')
        const scopeOwner = entry.scopeParent === undefined ? null : blocks[entry.scopeParent]
        if (entry.scopeDepth > 0 && active[entry.scopeDepth - 1] !== scopeOwner) throw new NativeMarkdownContainerError('backup child escapes its active container')
        const parent = depth > 0 ? active[depth - 1] : null
        if (depth > 0 && (!parent || !canBlockNestUnder(parent.type, value.type))) throw new NativeMarkdownContainerError('incompatible backup parent')
        if (entry.metadata.parentSpecified && (entry.metadata.parentBlockId ?? null) !== (parent?.id ?? null)) throw new NativeMarkdownContainerError('foreign or inactive backup parent identity')
      }
      active.length = depth; active[depth] = value
    }
  }
  assertMarkdownColumnStructure(blocks)
  return finalizeParsedMarkdownBlocks(blocks)
}
type MarkdownSerializationOptions = { fallbackCodeLanguage?: string; includeBlockMetadata?: boolean }
export type MarkdownBlockSourceRange = { index: number; startLine: number; endLine: number }

export function serializeBlocksToMarkdown(blocks: MarkdownRenderableBlock[], options: MarkdownSerializationOptions = {}): string {
  return serializeMarkdownWithBlockRanges(blocks, options).markdown
}

/** Structural closers deliberately do not overlap any editable block range. */
export type MarkdownContainerClosingRange = MarkdownBlockSourceRange

/** Native forest envelopes are independent of relative list indentation. */
function serializeContainerForest(
  blocks: MarkdownRenderableBlock[], options: MarkdownSerializationOptions
): { markdown: string; ranges: MarkdownBlockSourceRange[]; closingRanges: MarkdownContainerClosingRange[]; contentProjections?: NativeTextProjection[] } {
  const depths = resolveContainerMarkdownDepths(blocks)
  const nativeAncestors: boolean[] = []
  const contentProjections = blocks.map((block, index) => {
    const depth = depths[index]
    nativeAncestors.length = depth
    const native = isNativeStructureBlockType(block.type)
    const scoped = native || nativeAncestors.some(Boolean)
    nativeAncestors[depth] = native
    return encodeNativeLiteralText(block.content, !scoped || ['code', 'math', 'frontmatter'].includes(block.type) ? 'opaque' : isContainerBlockType(block.type) ? 'title' : 'body')
  })
  const parts: string[] = [], ranges: MarkdownBlockSourceRange[] = [], closingRanges: MarkdownContainerClosingRange[] = []
  let line = 0
  const emit = (source: string) => {
    const separator = parts.length ? '\n\n' : ''
    line += separator.length
    const startLine = line
    parts.push(separator + source)
    line += source.match(/\n/g)?.length ?? 0
    return startLine
  }
  const scope = (start: number, end: number, baseDepth: number): void => {
    let index = start
    while (index < end) {
      const block = blocks[index]
      if (isNativeStructureBlockType(block.type)) {
        let subtreeEnd = index + 1
        while (subtreeEnd < end && depths[subtreeEnd] > depths[index]) subtreeEnd++
        const metadata = options.includeBlockMetadata ? renderMarkdownBlockMetadata(block) : null
        const header = (metadata ? metadata + '\n' : '') + renderNativeContainerHeader(block)
        const startLine = emit(header)
        ranges.push({ index, startLine, endLine: startLine + (header.match(/\n/g)?.length ?? 0) + 1 })
        scope(index + 1, subtreeEnd, depths[index] + 1)
        const closeLine = emit(nativeContainerClosingTag(block.type))
        closingRanges.push({ index, startLine: closeLine, endLine: closeLine + 1 })
        index = subtreeEnd
        continue
      }
      const chunkStart = index
      while (index < end && !isNativeStructureBlockType(blocks[index].type)) index++
      const originals = blocks.slice(chunkStart, index)
      const relative = originals.map((value, offset) => ({ ...value, content: contentProjections[chunkStart + offset].source, depth: depths[chunkStart + offset] - baseDepth }))
      const rendered = serializeFlatMarkdownWithBlockRanges(relative, options, originals, true)
      const offset = emit(rendered.markdown)
      for (const range of rendered.ranges) ranges.push({ ...range, index: chunkStart + range.index,
        startLine: offset + range.startLine, endLine: offset + range.endLine })
    }
  }
  scope(0, blocks.length, 0)
  return { markdown: parts.join(''), ranges, closingRanges, contentProjections }
}

export function serializeMarkdownWithBlockRanges(
  blocks: MarkdownRenderableBlock[], options: MarkdownSerializationOptions = {}
): { markdown: string; ranges: MarkdownBlockSourceRange[]; closingRanges: MarkdownContainerClosingRange[]; contentProjections?: NativeTextProjection[] } {
  assertMarkdownColumnStructure(blocks)
  if (blocks.some(block => isNativeStructureBlockType(block.type))) return serializeContainerForest(blocks, options)
  return { ...serializeFlatMarkdownWithBlockRanges(blocks, options), closingRanges: [] }
}
/** Source ranges use the exact same separators and indentation as file export. */
function serializeFlatMarkdownWithBlockRanges(
  blocks: MarkdownRenderableBlock[],
  options: MarkdownSerializationOptions = {},
  metadataBlocks = blocks,
  nativeScope = false
): { markdown: string; ranges: MarkdownBlockSourceRange[] } {
  const effectiveDepths = resolveMarkdownBlockDepths(blocks)
  const indents: string[] = []
  const markers: number[] = []
  const orderedDelimiters = new Map<number, string>()
  const numbers = getMarkdownListNumbers(blocks)

  const rendered = blocks
    .map((block, index) => {
      const depth = effectiveDepths[index] ?? 0
      const indent = depth > 0 ? (indents[depth - 1] ?? '') + ' '.repeat(markers[depth - 1] ?? 2) : ''
      indents[depth] = indent
      // Continuation marker values are ignored by Markdown; keep them within
      // the grammar's nine-digit limit even when the displayed count exceeds it.
      const number = Math.min(numbers[index], 999999999)
      markers[depth] = isOrderedListBlockType(block.type) ? String(number).length + 2 : 2
      for (const key of orderedDelimiters.keys()) if (key > depth) orderedDelimiters.delete(key)
      const previousDelimiter = orderedDelimiters.get(depth)
      // Changing delimiter starts a separate CommonMark list. Blank lines alone
      // cannot preserve an explicit numbering restart between adjacent lists.
      let delimiter = block.listStart === undefined && previousDelimiter ? previousDelimiter : block.markdownFormat?.listMarker ?? previousDelimiter ?? '.'
      if (previousDelimiter === delimiter && block.listStart !== undefined) delimiter = delimiter === '.' ? ')' : '.'
      if (isOrderedListBlockType(block.type)) orderedDelimiters.set(depth, delimiter)
      else orderedDelimiters.delete(depth)
      const renderedBlock = renderMarkdownBlock(isOrderedListBlockType(block.type) ? { ...block, listStart: number } : block, indent, options.fallbackCodeLanguage ?? '', delimiter)
      if (!options.includeBlockMetadata) {
        return renderedBlock
      }

      const metadata = renderMarkdownBlockMetadata(metadataBlocks[index])
      return metadata ? `${metadata}\n${renderedBlock}` : renderedBlock
    })
  const ranges: MarkdownBlockSourceRange[] = []
  let line = 0
  const markdown = rendered.map((text, index) => {
    let separator = index === 0 ? '' : '\n\n'
    const previous = blocks[index - 1]
    const current = blocks[index]
    if (previous && !options.includeBlockMetadata && isNestableMarkdownBlock(previous.type) && isNestableMarkdownBlock(current.type)) {
      const depth = effectiveDepths[index]
      const previousDepth = effectiveDepths[index - 1]
      // Spacing belongs to the containing list, not the deepest child that
      // happened to precede the next sibling in the flattened editor model.
      const loose = depth > previousDepth ? previous.markdownFormat?.listLoose : current.markdownFormat?.listLoose
      separator = loose === false ? '\n' : '\n\n'
      // A non-one ordered start cannot interrupt a parent paragraph. This
      // separator preserves independent native child list blocks in CommonMark.
      if (nativeScope && depth > previousDepth && isOrderedListBlockType(current.type) && (current.listStart ?? 1) !== 1) separator = '\n\n'
    }
    line += separator.length
    const newlines = text.match(/\n/g)?.length ?? 0
    ranges.push({ index, startLine: line, endLine: line + newlines + (text && !text.endsWith('\n') ? 1 : 0) })
    line += newlines
    return separator + text
  }).join('')
  return { markdown, ranges }
}

/** KnowBook's backup envelope, explicitly distinguished from user YAML. */
export function renderMarkdownFrontmatter(frontmatter: MarkdownDocumentFrontmatter): string {
  const lines = ['---']

  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${JSON.stringify(value)}`)
  }

  lines.push('---', KNOWBOOK_BACKUP_MARKER, '')
  return lines.join('\n')
}

export function parseMarkdownBackupDocument(markdown: string): ParsedMarkdownDocument {
  const { frontmatter, body } = parseMarkdownFrontmatter(markdown)
  const marked = body.startsWith(KNOWBOOK_BACKUP_MARKER + '\n') || body === KNOWBOOK_BACKUP_MARKER
  // Older backups had no marker. Recognize their full schema,
  // never an ordinary file's id/path/kind alone.
  const legacyDocument = ['id', 'title', 'path', 'updatedAt', 'summary', 'documentDatabaseColumns', 'documentDatabaseFieldValues'].every((key) => Object.hasOwn(frontmatter, key))
    || Boolean(frontmatter.id && frontmatter.path && /^<!-- knowbook:block \{.*\} -->$/m.test(body))
  const legacyDatabase = frontmatter.kind === 'standalone-database' && ['databaseId', 'databaseName', 'databaseColumns', 'databaseSavedViews', 'databaseEntities'].every((key) => Object.hasOwn(frontmatter, key))
  const isKnowbookBackup = marked || legacyDocument || legacyDatabase
  return {
    frontmatter,
    isKnowbookBackup,
    blocks: parseMarkdownBlocks(isKnowbookBackup ? marked ? body.slice(KNOWBOOK_BACKUP_MARKER.length).replace(/^\n/, '') : body : markdown)
  }
}
/** Number the complete document before hiding folded rows. Child lists must not
 * reset their parent's sequence. Explicit starts are retained on the first item. */
export function getMarkdownListNumbers(blocks: MarkdownRenderableBlock[]): number[] {
  const counts = new Map<number, number>()
  return blocks.map((block) => {
    const depth = block.depth ?? 0
    for (const key of counts.keys()) if (key > depth) counts.delete(key)
    if (!isOrderedListBlockType(block.type)) { counts.delete(depth); return 0 }
    const value = normalizeListStart(block.listStart) ?? (counts.get(depth) ?? 0) + 1
    counts.set(depth, value)
    return value
  })
}

export function normalizeListStart(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value! >= 0 && value! <= 999999999 ? value : undefined
}
