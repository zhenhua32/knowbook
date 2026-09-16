import { markdownEngine, markdownTokenTree, type MarkdownEnvironment } from './markdownEngine'

export interface ParsedMarkdownTable {
  headers: string[]
  alignments: Array<'left' | 'center' | 'right' | null>
  rows: string[][]
}

export function parseMarkdownTableNode(content: string, env: MarkdownEnvironment = {}) {
  const nodes = markdownTokenTree(markdownEngine.parse(content, env))
  if (nodes.length !== 1 || nodes[0].token.type !== 'table_open') return null
  return nodes[0]
}

export function parseMarkdownTable(content: string): ParsedMarkdownTable | null {
  const table = parseMarkdownTableNode(content)
  if (!table) return null
  const head = table.children.find((node) => node.token.type === 'thead_open')
  const body = table.children.find((node) => node.token.type === 'tbody_open')
  const cells = head?.children[0]?.children ?? []
  return {
    headers: cells.map((cell) => cell.children[0]?.token.content ?? ''),
    alignments: cells.map((cell) => (String(cell.token.attrGet('style') ?? '').slice('text-align:'.length) || null) as 'left' | 'center' | 'right' | null),
    rows: (body?.children ?? []).map((row) => row.children.map((cell) => cell.children[0]?.token.content ?? ''))
  }
}

export function isMarkdownTable(content: string): boolean {
  return parseMarkdownTable(content) !== null
}

export function renderMarkdownTableHtml(content: string, env: MarkdownEnvironment = {}): string | null {
  if (!isMarkdownTable(content)) return null
  return markdownEngine.render(content, env).replace('<table>', '<table class="block-markdown-table">')
}
