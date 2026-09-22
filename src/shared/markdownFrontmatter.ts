import type MarkdownIt from 'markdown-it'

export const KNOWBOOK_BACKUP_MARKER = '<!-- knowbook:backup v1 -->'

/** Keep YAML opaque: comments, aliases, scalar styles and unknown fields belong
 * to the file. Only KnowBook's own backup envelope is decoded by the importer. */
export function extractMarkdownFrontmatter(source: string): { raw: string; body: string; end: number } | null {
  const match = source.match(/^\uFEFF?---[ \t]*(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)(?:---|\.\.\.)[ \t]*(?=\r\n|\n|\r|$)/)
  if (!match || !/^(?:[^\s#"'\[\]{}][^:\r\n]*|"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'):(?:[ \t]|$)/m.test(match[1])) return null
  const end = match[0].length
  return { raw: match[0], body: source.slice(end).replace(/^(?:\r\n|\n|\r)/, ''), end }
}

export function installMarkdownFrontmatter(md: InstanceType<typeof MarkdownIt>): void {
  md.block.ruler.before('hr', 'frontmatter', (state, start, _end, silent) => {
    const metadata = state.tokens.at(-1)
    const backupHeader = metadata?.type === 'knowbook_metadata' && /"type"\s*:\s*"frontmatter"/.test(metadata.content)
    if (state.env.suppressFrontmatter || (start !== 0 && !backupHeader) || state.blkIndent !== 0 || state.parentType !== 'root') return false
    const header = extractMarkdownFrontmatter(state.src.slice(state.bMarks[start]))
    if (!header) return false
    if (silent) return true
    const token = state.push('frontmatter', '', 0)
    token.content = header.raw
    const endLine = start + (header.raw.match(/\n/g)?.length ?? 0) + 1
    token.map = [start, endLine]
    state.line = endLine
    return true
  })
  md.renderer.rules.frontmatter = () => ''
}
