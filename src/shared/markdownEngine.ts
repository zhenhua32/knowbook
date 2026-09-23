import MarkdownIt, { type Env, type Token } from 'markdown-it'
import { installMarkdownExtensions } from './markdownExtensions'
import { installMarkdownAutolinks } from './markdownAutolinks'
import { installMarkdownAdvanced } from './markdownAdvanced'
import { installMarkdownSourceLinks } from './markdownSourceLinks'
import { installMarkdownFrontmatter } from './markdownFrontmatter'
import { installMarkdownHtml } from './markdownHtml'
import { installMarkdownWiki } from './markdownWiki'

export type MarkdownEnvironment = Env
export type MarkdownToken = Token
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
export const HEADING_LEVELS: HeadingLevel[] = [1, 2, 3, 4, 5, 6]

export function getHeadingLevel(type: string): HeadingLevel | null {
  return /^heading-[1-6]$/.test(type) ? Number(type.at(-1)) as HeadingLevel : null
}

// One grammar for clipboard/import, reading, table cells and media extraction.
// Common HTML becomes allowlisted tokens; other raw markup remains text.
export const markdownEngine = new MarkdownIt({ html: false, linkify: true, breaks: false })
installMarkdownExtensions(markdownEngine)
installMarkdownAutolinks(markdownEngine)
installMarkdownAdvanced(markdownEngine)
installMarkdownFrontmatter(markdownEngine)
markdownEngine.linkify.add('file:', { validate: (text, pos) => text.slice(pos).match(/^\/\/[^\s<>()\]]+/)?.[0].replace(/[.,;!?]+$/, '').length ?? 0 })
const defaultValidateLink = markdownEngine.validateLink.bind(markdownEngine)
markdownEngine.validateLink = (url) => /^file:\/\//i.test(url) || defaultValidateLink(url)

markdownEngine.block.ruler.before('fence', 'knowbook_metadata', (state, start, _end, silent) => {
  if (state.sCount[start] - state.blkIndent >= 4) return false
  const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start])
  if (!/^<!-- knowbook:block \{.*\} -->$/.test(line)) return false
  if (silent) return true
  const token = state.push('knowbook_metadata', '', 0)
  token.content = line
  token.map = [start, start + 1]
  state.line = start + 1
  return true
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })

// Register wiki links before normal links, so escapes and code spans are handled
// by the parser instead of a second regex pass over already-rendered content.
markdownEngine.inline.ruler.before('link', 'wiki_link', (state, silent) => {
  // Let normal link-label lookahead balance these brackets as text. A Wiki
  // token is interactive and cannot become an anchor inside another anchor.
  if (silent) return false
  if (!state.src.startsWith('[[', state.pos) || state.linkLevel > 0) return false
  const end = state.src.indexOf(']]', state.pos + 2)
  if (end < 0) return false
  const label = state.src.slice(state.pos + 2, end)
  if (!label.trim() || /[\n\[\]]/.test(label)) return false
  if (!silent) {
    const token = state.push('wiki_link', '', 0)
    token.content = label.trim()
  }
  state.pos = end + 2
  return true
})

markdownEngine.renderer.rules.wiki_link = (tokens, index) => markdownEngine.utils.escapeHtml(`[[${tokens[index].content}]]`)
markdownEngine.renderer.rules.knowbook_metadata = () => ''
installMarkdownWiki(markdownEngine)
installMarkdownHtml(markdownEngine)
installMarkdownSourceLinks(markdownEngine)

export type MarkdownNode = { token: Token; children: MarkdownNode[] }

export function markdownTokenTree(tokens: Token[]): MarkdownNode[] {
  const root: MarkdownNode[] = []
  const stack = [root]
  for (const token of tokens) {
    if (token.nesting === -1) { stack.pop(); continue }
    const node = { token, children: token.children ? markdownTokenTree(token.children) : [] }
    stack.at(-1)!.push(node)
    if (token.nesting === 1) stack.push(node.children)
  }
  return root
}

export function parseMarkdownInline(content: string, env: Env = {}): MarkdownNode[] {
  return markdownTokenTree(markdownEngine.parseInline(content, env)[0]?.children ?? [])
}

export function collectMarkdownReferences(content: string): Env['references'] {
  const env: Env = {}
  // Inline rendering is unnecessary when collecting document-wide definitions.
  markdownEngine.block.parse(content, markdownEngine, env, [])
  return env.references
}

export function normalizeMarkdownExternalUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'file:', 'mailto:'].includes(url.protocol) ? url.toString() : null
  } catch { return null }
}
