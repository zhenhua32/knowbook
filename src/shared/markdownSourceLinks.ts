import type MarkdownIt from 'markdown-it'
import type { Env, StateBlock, Token } from 'markdown-it'
import { parseWikiReference } from './markdownWiki'

export type MarkdownDestination = { start: number; end: number; url: string; kind: 'link' | 'image' | 'definition' | 'autolink'; syntax?: 'html' | 'bare' | 'wiki' }
export type MarkdownSourceLink = MarkdownDestination | { start: number; end: number; url: string; kind: 'wiki' }
export type MarkdownCompatibilityFinding = { start: number; end: number; reason: 'unsupported-html' | 'html-attributes' | 'wiki-syntax' }
type Capture = { links: MarkdownSourceLink[]; diagnostics: MarkdownCompatibilityFinding[]; maps: WeakMap<Token[], number[]>; ranges?: Array<{ start: number; end: number }>; context?: { positions: number[]; offset: number }; inAlt?: boolean }
const capture = (env: Env) => env.markdownSourceLinks as Capture | undefined
const sourceMap = (token: Token) => token.meta?.sourceMap as number[] | undefined

/** Keep the source map alongside transformations made before inline parsing. */
export function sliceMarkdownSourceMap(token: Token, start: number, end?: number, target = token): void {
  const map = sourceMap(token)
  if (map) target.meta = { ...target.meta, sourceMap: map.slice(start, end) }
}

function mapLines(state: StateBlock, token: Token): number[] {
  const result: number[] = []
  let line = token.map![0]
  for (const content of token.content.split('\n')) {
    if (line >= token.map![1]) break
    const start = state.bMarks[line], end = state.eMarks[line]
    const raw = state.src.slice(start, end)
    let at = raw.indexOf(content, state.tShift[line])
    // getLines can expand indentation tabs. Links cannot start in that padding.
    if (at < 0) {
      const trimmed = content.trimStart(), padding = content.length - trimmed.length
      at = raw.indexOf(trimmed, state.tShift[line]) - padding
    }
    if (at < 0) return []
    for (let index = 0; index < content.length; index++) result.push(start + at + index)
    result.push(end)
    line++
  }
  return result.slice(0, token.content.length)
}

/** GFM unescapes a pipe preceded by a backslash before parsing each cell. */
function mapCells(state: StateBlock, line: number): Array<{ content: string; map: number[] }> {
  const cells: Array<{ content: string; map: number[] }> = []
  const start = state.bMarks[line] + state.tShift[line], end = state.eMarks[line]
  let content = '', map: number[] = []
  const push = () => {
    const trimmed = content.trim(), offset = content.length - content.trimStart().length
    cells.push({ content: trimmed, map: map.slice(offset, offset + trimmed.length) })
    content = ''; map = []
  }
  for (let index = start; index < end; index++) {
    if (state.src[index] === '|') {
      if (state.src[index - 1] !== '\\') { push(); continue }
      content = content.slice(0, -1); map.pop()
    }
    content += state.src[index]; map.push(index)
  }
  push()
  const raw = state.src.slice(start, end).trim()
  if (raw.startsWith('|')) cells.shift()
  if (raw.endsWith('|') && raw.at(-2) !== '\\') cells.pop()
  return cells
}

function record(data: Capture, link: MarkdownSourceLink): void {
  if (data.inAlt || !data.context) return
  const { positions: map, offset } = data.context
  if (map[link.start + offset] === undefined || map[link.end - 1 + offset] === undefined) return
  data.links.push({ ...link, start: map[link.start + offset], end: map[link.end - 1 + offset] + 1 })
}

/** Diagnostics use the same positions and exclusions as rendered links. */
export function recordMarkdownCompatibility(env: Env, finding: MarkdownCompatibilityFinding, block = false): void {
  const data = capture(env)
  if (!env.captureCompatibility || !data || data.inAlt) return
  if (block) { data.diagnostics.push(finding); return }
  if (!data.context) return
  const { positions, offset } = data.context
  const start = positions[finding.start + offset], end = positions[finding.end - 1 + offset]
  if (start !== undefined && end !== undefined) data.diagnostics.push({ ...finding, start, end: end + 1 })
}

export function capturedMarkdownCompatibility(env: Env): MarkdownCompatibilityFinding[] {
  return capture(env)?.diagnostics ?? []
}

/** Capture successful parser rules, not URL matches elsewhere in a document.
 * The ruler's typed rule registry is used only to decorate existing rules;
 * grammar, lookahead, nesting limits and container boundaries remain upstream.
 * Source maps are allocated only for source operations, never normal rendering. */
export function installMarkdownSourceLinks(md: InstanceType<typeof MarkdownIt>): void {
  md.core.ruler.after('normalize', 'source_links_initialize', (state) => {
    if (state.env.captureSourceLinks) state.env.markdownSourceLinks = {
      links: [], diagnostics: [], maps: new WeakMap(), ranges: state.env.captureInlineRanges ? [] : undefined
    } satisfies Capture
  })
  for (const name of ['paragraph', 'heading', 'lheading', 'table', 'reference']) {
    const { fn, alt } = md.block.ruler.__rules__.find((entry) => entry.name === name)!
    md.block.ruler.at(name, (state, start, end, silent) => {
      const data = capture(state.env), first = state.tokens.length
      const accepted = fn(state, start, end, silent)
      if (!accepted || silent || !data) return accepted
      let cells: ReturnType<typeof mapCells> = [], cell = 0
      for (const token of state.tokens.slice(first)) {
        if (token.type === 'tr_open') { cells = mapCells(state, token.map![0]); cell = 0 }
        if (token.type === 'inline') {
          const map = token.map ? mapLines(state, token) : cells[cell++]?.map
          if (map) token.meta = { ...token.meta, sourceMap: map }
        }
        if (token.type === 'reference_definition') {
          let source = '', map: number[] = []
          for (let line = token.map![0]; line < token.map![1]; line++) {
            const from = state.bMarks[line] + state.tShift[line], to = state.eMarks[line]
            source += state.src.slice(from, to) + '\n'
            for (let position = from; position <= to; position++) map.push(position)
          }
          const label = source.match(/^\[(?:\\.|[^\]\\])*\]:[ \t\n]*/)?.[0]
          if (!label) continue
          const destination = md.helpers.parseLinkDestination(source, label.length, source.length)
          if (!destination.ok) continue
          const angled = source[label.length] === '<'
          data.links.push({ start: map[label.length + (angled ? 1 : 0)], end: map[destination.pos - (angled ? 2 : 1)] + 1,
            url: md.normalizeLink(destination.str), kind: 'definition' })
        }
      }
      return accepted
    }, { alt })
  }
  md.core.ruler.before('inline', 'source_links_inline_maps', (state) => {
    const data = capture(state.env)
    if (!data) return
    for (const token of state.tokens) {
      const map = sourceMap(token)
      if (token.type === 'inline' && token.children && map) {
        data.maps.set(token.children, map)
        if (map.length) data.ranges?.push({ start: map[0], end: map.at(-1)! + 1 })
      }
    }
  })
  const parseInline = md.inline.parse.bind(md.inline)
  md.inline.parse = (source, engine, env, tokens) => {
    const data = capture(env), previous = data?.context
    if (data) {
      const positions = data.maps.get(tokens)
      data.context = positions ? { positions, offset: 0 } : previous
    }
    try { parseInline(source, engine, env, tokens) }
    finally { if (data) data.context = previous }
  }
  for (const name of ['link', 'image', 'autolink', 'linkify', 'wiki_link', 'wiki_embed', 'footnote_inline', 'safe_html']) {
    const { fn } = md.inline.ruler.__rules__.find((entry) => entry.name === name)!
    md.inline.ruler.at(name, (state, silent) => {
      const data = capture(state.env)
      if (!data || silent) return fn(state, silent)
      if (name === 'footnote_inline' && !state.src.startsWith('^[', state.pos)) return false
      if (name === 'image' && !state.src.startsWith('![', state.pos)) return false
      const start = state.pos, first = state.tokens.length, previous = data.context, previousAlt = data.inAlt
      const schemeLength = name === 'linkify' ? /[a-z][a-z\d+.-]*$/i.exec(state.src.slice(Math.max(0, start - Math.min(10, state.pending.length)), start))?.[0].length ?? 0 : 0
      // An image's alt text is plain text. Inline footnotes have a separate
      // inline parser whose offsets start after the ^[ opening marker.
      if (name === 'image' || name === 'footnote_inline') {
        data.context = previous && { positions: previous.positions, offset: previous.offset + start + 2 }
        data.inAlt = name === 'image'
      }
      let accepted: boolean
      try { accepted = fn(state, false) }
      finally { data.context = previous; data.inAlt = previousAlt }
      if (!accepted) return false
      if (name === 'safe_html') {
        const html = state.tokens.slice(first).find((token) => token.meta?.htmlSourceLinks)
        for (const link of (html?.meta?.htmlSourceLinks ?? []) as MarkdownDestination[]) record(data, { ...link, start: start + link.start, end: start + link.end })
        return true
      }
      if (name === 'footnote_inline') return true
      if (name === 'wiki_embed') {
        const token = state.tokens.slice(first).find((item) => item.meta?.wiki)!
        if (token.type !== 'image') recordMarkdownCompatibility(state.env, { start, end: state.pos, reason: 'wiki-syntax' })
        else {
          const raw = state.src.slice(start + 3, state.pos - 2), reference = parseWikiReference(raw)
          const from = start + 3 + raw.length - raw.trimStart().length
          record(data, { start: from, end: from + reference.target.length, url: String(token.attrGet('src')), kind: 'image', syntax: 'wiki' })
        }
        return true
      }
      if (name === 'wiki_link') {
        const label = state.src.slice(start + 2, state.pos - 2)
        if (parseWikiReference(label).fragment.startsWith('^')) {
          recordMarkdownCompatibility(state.env, { start, end: state.pos, reason: 'wiki-syntax' })
        }
        record(data, { start: start + 2 + label.length - label.trimStart().length,
          end: state.pos - 2 - (label.length - label.trimEnd().length), url: label.trim(), kind: 'wiki' })
        return true
      }
      const token = state.tokens.slice(first).find((item) => item.type === (name === 'image' ? 'image' : 'link_open'))
      if (!token) return true
      const url = String(token.attrGet(name === 'image' ? 'src' : 'href') ?? '')
      if (name === 'linkify') {
        if (/^file:/i.test(url)) record(data, { start: start - schemeLength, end: state.pos, url, kind: 'autolink', syntax: 'bare' })
      } else if (name === 'autolink') record(data, { start: start + 1, end: state.pos - 1, url, kind: 'autolink' })
      else if (!token.meta?.label) {
        const labelEnd = md.helpers.parseLinkLabel(state, start + (name === 'image' ? 1 : 0), name === 'link')
        let position = labelEnd + 2
        while (position < state.pos && /[ \t\n]/.test(state.src[position])) position++
        const destination = md.helpers.parseLinkDestination(state.src, position, state.pos)
        if (destination.ok) {
          const angled = state.src[position] === '<'
          record(data, { start: position + (angled ? 1 : 0), end: destination.pos - (angled ? 1 : 0), url, kind: name === 'image' ? 'image' : 'link' })
        }
      }
      return true
    })
  }
}

export function capturedMarkdownSourceLinks(env: Env): MarkdownSourceLink[] {
  return capture(env)?.links ?? []
}

/** A details body is block-parsed in its own source slice, then put back into
 * the parent document before the shared inline pass. */
export function shiftMarkdownSourceCapture(env: Env, tokens: Token[], linkStart: number, offset: (position: number) => number, lines: number, diagnosticStart = 0): void {
  const data = capture(env)
  if (data) for (let index = linkStart; index < data.links.length; index++) {
    data.links[index].start = offset(data.links[index].start); data.links[index].end = offset(data.links[index].end)
  }
  if (data) for (let index = diagnosticStart; index < data.diagnostics.length; index++) {
    data.diagnostics[index].start = offset(data.diagnostics[index].start)
    data.diagnostics[index].end = offset(data.diagnostics[index].end)
  }
  for (const token of tokens) {
    if (token.map) token.map = [token.map[0] + lines, token.map[1] + lines]
    const map = sourceMap(token)
    if (map) token.meta = { ...token.meta, sourceMap: map.map(offset) }
  }
}

/** Inline block boundaries after task/callout prefixes, before footnote relocation. */
export function capturedMarkdownInlineRanges(env: Env): Array<{ start: number; end: number }> {
  return capture(env)?.ranges ?? []
}
