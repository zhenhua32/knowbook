import { isTaskBlockType, isListBlockType } from './blockTypes'
import { serializeMarkdownWithBlockRanges, type MarkdownBlockSourceRange, type MarkdownRenderableBlock } from './markdown'
import { markdownEngine, markdownTokenTree, type MarkdownEnvironment, type MarkdownNode } from './markdownEngine'
import type { MarkdownHeading } from './markdownAdvanced'
import { collectMarkdownTaskTargets, type MarkdownTaskTarget } from './markdownTasks'

export type MarkdownDocumentModel = {
  source: string
  environment: MarkdownEnvironment
  blockNodes: MarkdownNode[][]
  blockIds: Array<string | undefined>
  footnotes: MarkdownNode[]
  footnoteOrigins: Map<string, number>
  headings: MarkdownHeading[]
  taskTargets: Map<number, MarkdownTaskTarget>
  readingLists: Array<{ node: MarkdownNode; indices: number[] }>
  listItemOwners: Map<MarkdownNode['token'], number>
}

function sliceNodes(nodes: MarkdownNode[], range: MarkdownBlockSourceRange, mappedArrays: WeakMap<MarkdownNode[], boolean>): MarkdownNode[] {
  if (range.startLine >= range.endLine) return []
  let mapped = mappedArrays.get(nodes)
  if (mapped === undefined) {
    mapped = nodes.every((node) => node.token.map !== null)
    mappedArrays.set(nodes, mapped)
  }
  // Sibling source ranges are ordered and do not overlap. Locate just the
  // affected siblings instead of scanning the whole document for every row.
  let start = 0
  if (mapped) {
    let end = nodes.length
    while (start < end) {
      const middle = (start + end) >>> 1
      if (nodes[middle].token.map![1] <= range.startLine) start = middle + 1
      else end = middle
    }
  }
  const result: MarkdownNode[] = []
  for (let index = start; index < nodes.length; index++) {
    const node = nodes[index]
    const map = node.token.map
    if (mapped && map![0] >= range.endLine) break
    if (!map || (map[0] >= range.startLine && map[1] <= range.endLine)) { result.push(node); continue }
    if (map[1] <= range.startLine || map[0] >= range.endLine) continue
    const children = sliceNodes(node.children, range, mappedArrays)
    if (children.length) result.push({ ...node, children })
  }
  return result
}

function findListItem(nodes: MarkdownNode[], line: number): MarkdownNode | undefined {
  for (const node of nodes) {
    if (node.token.type === 'list_item_open' && node.token.map?.[0] === line) return node
    const found = findListItem(node.children, line)
    if (found) return found
  }
}

function withoutLeadingCheckbox(nodes: MarkdownNode[]): MarkdownNode[] {
  return nodes.map((node, index) => index === 0 && node.token.type === 'paragraph_open'
    ? { ...node, children: node.children.map((inline) => ({ ...inline,
      children: inline.children.filter((child, childIndex) => childIndex !== 0 || child.token.type !== 'task_checkbox') })) }
    : node)
}

export function footnoteReferenceKey(id: number, subId = 0): string { return `${id}:${subId}` }

/** One parse gives every block the same definitions, reference order and TOC.
 * Footnote bodies remain separate from the editable source blocks. */
export function parseMarkdownDocumentBlocks(blocks: MarkdownRenderableBlock[], title = ''): MarkdownDocumentModel {
  const { markdown: source, ranges } = serializeMarkdownWithBlockRanges(blocks)
  const environment: MarkdownEnvironment = { documentTitle: title }
  const nodes = markdownTokenTree(markdownEngine.parse(source, environment))
  const footnotes = nodes.filter((node) => node.token.type === 'footnote_block_open')
  const body = nodes.filter((node) => node.token.type !== 'footnote_block_open' && node.token.type !== 'knowbook_metadata')
  const mappedArrays = new WeakMap<MarkdownNode[], boolean>()
  const starts = new Map(ranges.map((range, index) => [range.startLine, index]))
  const listItemOwners = new Map<MarkdownNode['token'], number>()
  const claimed = new Set<number>()
  const readingLists: MarkdownDocumentModel['readingLists'] = []
  const collectListOwners = (node: MarkdownNode, indices: number[]) => {
    const index = node.token.map && starts.get(node.token.map[0])
    if (node.token.type === 'list_item_open' && typeof index === 'number' && isListBlockType(blocks[index].type) && !claimed.has(index)) {
      claimed.add(index); indices.push(index); listItemOwners.set(node.token, index)
    }
    for (const child of node.children) collectListOwners(child, indices)
  }
  for (const node of body) if (['bullet_list_open', 'ordered_list_open'].includes(node.token.type)) {
    const indices: number[] = []
    collectListOwners(node, indices)
    if (indices.length) readingLists.push({ node, indices })
  }
  const blockNodes = ranges.map((range, index) => {
    const owned = sliceNodes(body, range, mappedArrays)
    if (!isListBlockType(blocks[index].type)) return owned
    const content = findListItem(owned, range.startLine)?.children ?? owned
    return isTaskBlockType(blocks[index].type) ? withoutLeadingCheckbox(content) : content
  })
  const footnoteOrigins = new Map<string, number>()
  const visit = (items: MarkdownNode[], index: number) => {
    for (const { token, children } of items) {
      if (token.type === 'footnote_ref') footnoteOrigins.set(footnoteReferenceKey(Number(token.meta?.id), Number(token.meta?.subId ?? 0)), index)
      visit(children, index)
    }
  }
  blockNodes.forEach(visit)
  return { source, environment, blockNodes, blockIds: blocks.map((block) => block.id), footnotes, footnoteOrigins,
    taskTargets: collectMarkdownTaskTargets(nodes, source, ranges, blocks), readingLists, listItemOwners,
    headings: (environment.documentHeadings ?? []) as MarkdownHeading[] }
}

export function hasAdvancedMarkdown(nodes: MarkdownNode[]): boolean {
  return nodes.some(({ token, children }) => ['math_inline', 'math_block', 'footnote_ref', 'footnote_missing', 'table_of_contents', 'mark_open', 'task_checkbox'].includes(token.type)
    || Boolean(token.meta?.callout || token.meta?.html) || (token.type === 'fence' && /^mermaid(?:\s|$)/i.test(token.info.trim()))
    || hasAdvancedMarkdown(children))
}
