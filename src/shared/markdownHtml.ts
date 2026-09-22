import type MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import { parseFragment, type DefaultTreeAdapterTypes as Html } from 'parse5'
import { capturedMarkdownSourceLinks, shiftMarkdownSourceCapture, type MarkdownDestination } from './markdownSourceLinks'

const tags = new Set(['br', 'kbd', 'sub', 'sup', 'img', 'a', 'details', 'summary'])
const voidTags = new Set(['br', 'img'])
type TokenFactory = (type: string, tag: string, nesting: -1 | 0 | 1) => Token

/** Locate one complete element; this scan only bounds the input to the HTML5
 * parser. It never makes a tag or attribute safe to render. */
function elementSource(source: string, position: number): string | null {
  const name = /^<([a-z][\w-]*)(?=[\s/>])/i.exec(source.slice(position))?.[1].toLowerCase()
  if (!name || !tags.has(name)) return null
  const markup = /<!--[\s\S]*?-->|<\/?[a-z][\w-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi
  markup.lastIndex = position
  const fences: Array<[number, number]> = []
  if (name === 'details') {
    let fence: { marker: string; width: number; start: number } | undefined
    const lines = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/gm
    lines.lastIndex = position
    for (let line = lines.exec(source); line; line = lines.exec(source)) {
      if (fence) {
        if (line[1][0] === fence.marker && line[1].length >= fence.width && !line[2].trim()) {
          fences.push([fence.start, lines.lastIndex]); fence = undefined
        }
      } else if (line[1][0] !== '`' || !line[2].includes('`')) fence = { marker: line[1][0], width: line[1].length, start: line.index }
    }
    if (fence) fences.push([fence.start, source.length])
  }
  let fenceIndex = 0
  let depth = 0, first = true
  for (let match = markup.exec(source); match; match = markup.exec(source)) {
    if (first && match.index !== position) return null
    first = false
    while (fenceIndex < fences.length && match.index >= fences[fenceIndex][1]) fenceIndex++
    if (fenceIndex < fences.length && match.index >= fences[fenceIndex][0]) continue
    if (match[0].startsWith('<!--')) continue
    const current = /^<(\/?)([a-z][\w-]*)/i.exec(match[0])!
    if (current[2].toLowerCase() !== name) continue
    if (voidTags.has(name)) return source.slice(position, markup.lastIndex)
    depth += current[1] ? -1 : 1
    if (depth === 0) return source.slice(position, markup.lastIndex)
  }
  return null
}

function safeUrl(value: string, image: boolean): boolean {
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('//')) return false
  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1].toLowerCase()
  return !protocol || ['http', 'https', 'file', ...image ? [] : ['mailto']].includes(protocol)
}

function attributes(element: Html.Element): Array<[string, string]> {
  const result: Array<[string, string]> = []
  for (const { name, value } of element.attrs) {
    if (name === 'title' || name === 'id' || (element.tagName === 'a' && name === 'name')) result.push([name, value])
    else if (element.tagName === 'details' && name === 'open') result.push(['open', ''])
    else if (element.tagName === 'img' && (name === 'alt' || ['width', 'height'].includes(name) && /^(?:[1-9]\d{0,3}|10000)$/.test(value))) result.push([name, value])
    else if ((element.tagName === 'a' && name === 'href' || element.tagName === 'img' && name === 'src') && safeUrl(value.trim(), name === 'src')) result.push([name, value.trim()])
  }
  return result
}

function destination(element: Html.Element, source: string, attrs: Array<[string, string]>): MarkdownDestination[] {
  const name = element.tagName === 'img' ? 'src' : element.tagName === 'a' ? 'href' : ''
  const url = attrs.find(([key]) => key === name)?.[1], location = element.sourceCodeLocation?.attrs?.[name]
  if (!url || !location) return []
  const raw = source.slice(location.startOffset, location.endOffset)
  const prefix = /^[^=]+=[\t\n\r ]*/.exec(raw)?.[0]
  if (!prefix) return []
  const quoted = ['"', "'"].includes(raw[prefix.length])
  return [{ kind: name === 'src' ? 'image' : 'link', syntax: 'html', url,
    start: location.startOffset + prefix.length + (quoted ? 1 : 0), end: location.endOffset - (quoted ? 1 : 0) }]
}

function htmlTokens(nodes: Html.ChildNode[], source: string, make: TokenFactory, links: MarkdownDestination[], depth = 0): Token[] {
  return nodes.flatMap((node): Token[] => {
    const text = (value: string) => { const token = make('text', '', 0); token.content = value; return [token] }
    if ('value' in node) return text(node.value)
    if (!('tagName' in node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !tags.has(node.tagName) || depth > 100) {
      const location = node.sourceCodeLocation
      return location ? text(source.slice(location.startOffset, location.endOffset)) : []
    }
    const attrs = attributes(node), tag = node.tagName
    links.push(...destination(node, source, attrs))
    const type = tag === 'img' ? 'image' : tag === 'br' ? 'hardbreak' : tag === 'a' && attrs.some(([name]) => name === 'href') ? 'link_open' : 'html_element_open'
    const token = make(type, tag, voidTags.has(tag) ? 0 : 1)
    token.attrs = attrs; token.meta = { html: true }
    if (tag === 'img') {
      token.content = attrs.find(([name]) => name === 'alt')?.[1] ?? ''
      token.attrSet('alt', token.content)
      token.meta.htmlSource = source.slice(node.sourceCodeLocation!.startOffset, node.sourceCodeLocation!.endOffset)
      const alt = make('text', '', 0); alt.content = token.content; token.children = [alt]
    }
    if (voidTags.has(tag)) return [token]
    return [token, ...htmlTokens(node.childNodes, source, make, links, depth + 1), make(type === 'link_open' ? 'link_close' : 'html_element_close', tag, -1)]
  })
}

function parsedElement(source: string): Html.Element | null {
  const nodes = parseFragment(source, { sourceCodeLocationInfo: true }).childNodes
  const root = nodes[0]
  if (nodes.length !== 1 || !root || !('tagName' in root) || !tags.has(root.tagName)) return null
  const location = root.sourceCodeLocation
  return location?.startOffset === 0 && location.endOffset === source.length
    && (voidTags.has(root.tagName) || location.endTag) ? root : null
}

/** HTML is converted to the same safe token tree as Markdown. No raw HTML,
 * CSS, event handlers, foreign namespaces or executable URL schemes reach the
 * renderer. Unsupported/malformed markup remains editable literal text. */
export function installMarkdownHtml(md: InstanceType<typeof MarkdownIt>): void {
  const renderImage = md.renderer.rules.image!
  const renderBreak = md.renderer.rules.hardbreak!
  md.renderer.rules.hardbreak = (tokens, index, options, env, renderer) => tokens[index].meta?.html
    ? renderer.renderToken(tokens, index, options) : renderBreak(tokens, index, options, env, renderer)
  md.renderer.rules.image = (tokens, index, options, env, renderer) => tokens[index].meta?.html && !tokens[index].attrGet('src')
    ? md.utils.escapeHtml(String(tokens[index].meta?.htmlSource ?? '')) : renderImage(tokens, index, options, env, renderer)
  md.inline.ruler.before('html_inline', 'safe_html', (state, silent) => {
    if (state.src[state.pos] !== '<') return false
    const source = elementSource(state.src, state.pos)
    if (!source) return false
    const root = parsedElement(source)
    if (!root || root.tagName === 'details' || root.tagName === 'a' && state.linkLevel > 0) return false
    if (!silent) {
      const links: MarkdownDestination[] = []
      const tokens = htmlTokens([root], source, (type, tag, nesting) => new state.Token(type, tag, nesting), links)
      tokens[0].meta = { ...tokens[0].meta, htmlSourceLinks: links }
      for (const token of tokens) {
        const pushed = state.push(token.type, token.tag, token.nesting)
        Object.assign(pushed, token, { level: pushed.level })
      }
    }
    state.pos += source.length
    return true
  })

  md.block.ruler.before('html_block', 'html_details', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4 || Number(state.env.htmlDetailsDepth ?? 0) >= md.options.maxNesting) return false
    const from = state.bMarks[start] + state.tShift[start]
    if (!/^<details(?=[\s>])/i.test(state.src.slice(from))) return false
    const candidate = state.getLines(start, end, state.blkIndent, false)
    const source = elementSource(candidate, candidate.length - candidate.trimStart().length)
    if (!source) return false
    // Parse only the HTML shell. The body is Markdown, so a closing tag in a
    // fenced code block must not close the real details element.
    const opening = /^<details(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(source)?.[0]
    const closing = /<\/details[\t\n\r ]*>$/i.exec(source)
    const root = opening && parsedElement(opening + '</details>')
    if (!root || !closing) return false
    const positions: number[] = []
    const sourceLines = source.split('\n')
    sourceLines.forEach((line, index) => {
      const rawStart = state.bMarks[start + index], rawEnd = state.eMarks[start + index]
      const raw = state.src.slice(rawStart, rawEnd)
      let at = raw.indexOf(line)
      if (at < 0) at = raw.indexOf(line.trimStart()) - (line.length - line.trimStart().length)
      for (let column = 0; column < line.length; column++) positions.push(rawStart + at + column)
      if (index < sourceLines.length - 1) positions.push(rawEnd)
    })
    const endOffset = positions.at(-1)! + 1
    positions.push(endOffset)
    const nextLine = start + sourceLines.length
    if (state.src.slice(endOffset, state.eMarks[nextLine - 1]).trim()) return false
    if (silent) return true
    const open = state.push('html_details_open', 'details', 1)
    open.attrs = attributes(root); open.meta = { html: true }; open.map = [start, nextLine]
    let bodyStart = opening!.length
    const summaryStart = bodyStart + source.slice(bodyStart).length - source.slice(bodyStart).trimStart().length
    const summarySource = /^<summary(?=[\s>])/i.test(source.slice(summaryStart)) ? elementSource(source, summaryStart) : null
    const first = summarySource ? parsedElement(summarySource) : null
    if (first?.sourceCodeLocation?.endTag) {
      const location = first.sourceCodeLocation
      const summary = state.push('html_element_open', 'summary', 1)
      summary.attrs = attributes(first); summary.meta = { html: true }
      const inline = state.push('inline', '', 0)
      inline.content = summarySource!.slice(location.startTag!.endOffset, location.endTag!.startOffset)
      inline.children = []
      inline.meta = { sourceMap: Array.from({ length: inline.content.length }, (_, index) => positions[summaryStart + location.startTag!.endOffset + index]) }
      state.push('html_element_close', 'summary', -1)
      bodyStart = summaryStart + location.endOffset
    }
    const body = source.slice(bodyStart, closing.index)
    const bodyTokens: Token[] = [], linkStart = capturedMarkdownSourceLinks(state.env).length
    const previous = state.env.suppressFrontmatter
    const previousDepth = Number(state.env.htmlDetailsDepth ?? 0)
    state.env.suppressFrontmatter = true
    state.env.htmlDetailsDepth = previousDepth + 1
    try { md.block.parse(body, md, state.env, bodyTokens) }
    finally { state.env.suppressFrontmatter = previous; state.env.htmlDetailsDepth = previousDepth }
    const lineOffset = start + (source.slice(0, bodyStart).match(/\n/g)?.length ?? 0)
    shiftMarkdownSourceCapture(state.env, bodyTokens, linkStart, (offset) => positions[bodyStart + offset], lineOffset)
    for (const token of bodyTokens) token.level += state.level
    state.tokens.push(...bodyTokens)
    state.push('html_details_close', 'details', -1)
    state.line = nextLine
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
}
