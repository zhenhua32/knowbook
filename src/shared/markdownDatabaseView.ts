import type MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import { DATABASE_VIEW_FENCE_INFO, parseDatabaseViewPayload, serializeDatabaseViewPayload } from './databaseViewBlock'
import { nativeMarkdownContainer } from './markdownContainers'

export class MarkdownDatabaseViewError extends Error {
  constructor(message: string) { super('Invalid database view Markdown: ' + message); this.name = 'MarkdownDatabaseViewError' }
}

/** Only actual document/native-container fences are database atoms. Literal
 * code, quotes, list bodies, footnotes and legacy HTML keep their own grammar. */
export function installMarkdownDatabaseView(md: InstanceType<typeof MarkdownIt>): void {
  md.core.ruler.after('block', 'knowbook_database_views', state => {
    const ancestors: boolean[] = []
    let opaque = 0
    const lines = state.src.split('\n')
    for (const token of state.tokens) {
      if (token.nesting === -1) { if (ancestors.pop()) opaque--; continue }
      if (token.nesting === 1) {
        const blocked = !nativeMarkdownContainer(token)
        ancestors.push(blocked)
        if (blocked) opaque++
        continue
      }
      if (opaque || token.type !== 'fence' || !/^knowbook-database-view(?:-|$)/i.test(token.info.trim())) continue
      if (token.info.trim() !== DATABASE_VIEW_FENCE_INFO) throw new MarkdownDatabaseViewError('unknown reserved fence version or attributes')
      const close = token.map && lines[token.map[1] - 1]
      const marker = token.markup[0]
      if (!close || !new RegExp('^ {0,3}' + marker + '{' + token.markup.length + ',}[ \\t]*$').test(close))
        throw new MarkdownDatabaseViewError('database view fence must be closed')
      try {
        const value = parseDatabaseViewPayload(token.content)
        token.type = 'knowbook_database_view'
        token.content = serializeDatabaseViewPayload(value)
        token.meta = { ...token.meta, databaseViewPayload: value }
      } catch (error) { throw new MarkdownDatabaseViewError(error instanceof Error ? error.message : String(error)) }
    }
  })
  md.renderer.rules.knowbook_database_view = (tokens, index) => '<pre><code class="language-' + DATABASE_VIEW_FENCE_INFO + '">'
    + md.utils.escapeHtml(tokens[index].content) + '\n</code></pre>\n'
}

export function hasMarkdownDatabaseViewTokens(tokens: Token[]): boolean {
  return tokens.some(token => token.type === 'knowbook_database_view' || !!token.children && hasMarkdownDatabaseViewTokens(token.children))
}

export function renderDatabaseViewFence(content: string): string {
  const canonical = serializeDatabaseViewPayload(parseDatabaseViewPayload(content))
  const fence = '`'.repeat(Math.max(3, ...(canonical.match(/`+/g) ?? []).map(run => run.length + 1)))
  return [fence + DATABASE_VIEW_FENCE_INFO, canonical, fence].join('\n')
}
