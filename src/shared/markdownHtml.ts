import type MarkdownIt from 'markdown-it'
import type { StateBlock, Token } from 'markdown-it'
import { parseFragment, type DefaultTreeAdapterTypes as Html } from 'parse5'
import { capturedMarkdownSourceLinks, capturedMarkdownCompatibility, recordMarkdownCompatibility, shiftMarkdownSourceCapture, type MarkdownDestination, type MarkdownCompatibilityFinding } from './markdownSourceLinks'
import { IMAGE_ALIGN_ATTRIBUTE, IMAGE_CROP_ATTRIBUTE, parseImageCropAttribute, parseImageFigure, type ImagePresentation } from './markdownMedia'

const tags = new Set(['br', 'kbd', 'sub', 'sup', 'img', 'a', 'details', 'summary', 'figure'])
const voidTags = new Set(['br', 'img'])
type TokenFactory = (type: string, tag: string, nesting: -1 | 0 | 1) => Token
type FigureRange = { start: number; end: number }
type FigureTokenMeta = {
  html: true
  imagePresentation: ImagePresentation
  inlineFigure: boolean
  htmlSourceLinks: MarkdownDestination[]
  htmlFigureRange?: FigureRange
}

function isFigureRange(value: unknown): value is FigureRange {
  return typeof value === 'object' && value !== null && 'start' in value && 'end' in value
    && typeof value.start === 'number' && Number.isInteger(value.start) && value.start >= 0
    && typeof value.end === 'number' && Number.isInteger(value.end) && value.end >= value.start
}

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
  if (element.tagName === 'figure') {
    const align = element.attrs.find(attr => attr.name === IMAGE_ALIGN_ATTRIBUTE)?.value
    const crop = parseImageCropAttribute(element.attrs.find(attr => attr.name === IMAGE_CROP_ATTRIBUTE)?.value ?? '')
    return [...(align && ['left', 'center', 'right'].includes(align) ? [[IMAGE_ALIGN_ATTRIBUTE, align] as [string, string]] : []),
      ...(crop ? [[IMAGE_CROP_ATTRIBUTE, [crop.x, crop.y, crop.width, crop.height].join(',')] as [string, string]] : [])]
  }
  if (element.tagName === 'figcaption') return []
  const result: Array<[string, string]> = []
  for (const { name, value } of element.attrs) {
    if (name === 'title' || name === 'id' || (element.tagName === 'a' && name === 'name')) result.push([name, value])
    else if (element.tagName === 'details' && name === 'open') result.push(['open', ''])
    else if (element.tagName === 'img' && (name === 'alt' || ['width', 'height'].includes(name) && /^(?:[1-9]\d{0,3}|10000)$/.test(value))) result.push([name, value])
    else if ((element.tagName === 'a' && name === 'href' || element.tagName === 'img' && name === 'src') && safeUrl(value.trim(), name === 'src')) result.push([name, value.trim()])
  }
  return result
}

function figureTokens(source: string, presentation: ImagePresentation, make: TokenFactory, inline = false): { tokens: Token[]; meta: FigureTokenMeta } {
  const root = parseFragment(source, { sourceCodeLocationInfo: true }).childNodes.find((node): node is Html.Element => 'tagName' in node && node.tagName === 'figure')!
  const originalImage = root.childNodes.find((node): node is Html.Element => 'tagName' in node && node.tagName === 'img')!
  const open = make('html_figure_open', 'figure', 1)
  open.attrs = [[IMAGE_ALIGN_ATTRIBUTE, presentation.align], ...(presentation.crop
    ? [[IMAGE_CROP_ATTRIBUTE, [presentation.crop.x, presentation.crop.y, presentation.crop.width, presentation.crop.height].join(',')] as [string, string]] : [])]
  const image = make('image', 'img', 0)
  const imageAttrs: Array<[string, string]> = [['src', presentation.src], ['alt', presentation.alt], ...(['width', 'height'] as const).flatMap(name =>
    presentation[name] === undefined ? [] : [[name, String(presentation[name])] as [string, string]]),
  ...(presentation.title === undefined ? [] : [['title', presentation.title] as [string, string]])]
  image.attrs = imageAttrs
  image.content = presentation.alt
  image.meta = { html: true, htmlSource: source.slice(originalImage.sourceCodeLocation!.startOffset, originalImage.sourceCodeLocation!.endOffset) }
  const alt = make('text', '', 0); alt.content = presentation.alt; image.children = [alt]
  const meta: FigureTokenMeta = { html: true, imagePresentation: presentation, inlineFigure: inline, htmlSourceLinks: destination(originalImage, source, imageAttrs) }
  open.meta = meta
  const caption = make('html_element_open', inline ? 'span' : 'figcaption', 1)
  caption.meta = { html: true }; caption.attrs = inline ? [['class', 'markdown-image-caption']] : []
  const captionText = make('text', '', 0); captionText.content = presentation.caption
  const captionClose = make('html_element_close', caption.tag, -1); captionClose.meta = { html: true }
  const close = make('html_figure_close', 'figure', -1); close.meta = { html: true, inlineFigure: inline }
  return { tokens: [open, image, caption, captionText, captionClose, close], meta }
}

function htmlSourcePositions(state: StateBlock, start: number, source: string): number[] | null {
  const positions: number[] = [], lines = source.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const rawStart = state.bMarks[start + index], rawEnd = state.eMarks[start + index], raw = state.src.slice(rawStart, rawEnd)
    const line = lines[index]
    let at = raw.indexOf(line)
    if (at < 0) at = raw.indexOf(line.trimStart()) - (line.length - line.trimStart().length)
    if (at < 0) return null
    for (let column = 0; column < line.length; column++) positions.push(rawStart + at + column)
    if (index < lines.length - 1) positions.push(rawEnd)
  }
  positions.push((positions.at(-1) ?? state.bMarks[start]) + 1)
  return positions
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
    if (node.tagName === 'figure') {
      const location = node.sourceCodeLocation!
      const raw = source.slice(location.startOffset, location.endOffset), presentation = parseImageFigure(raw)
      if (!presentation) return text(raw)
      const { tokens, meta } = figureTokens(raw, presentation, make, true)
      links.push(...meta.htmlSourceLinks.map(link => ({ ...link, start: location.startOffset + link.start, end: location.startOffset + link.end })))
      return tokens
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

function compatibilityFindings(source: string): MarkdownCompatibilityFinding[] {
  const issues: MarkdownCompatibilityFinding[] = []
  const figure = parseImageFigure(source)
  const visit = (nodes: Html.ChildNode[]) => {
    for (const node of nodes) {
      const location = node.sourceCodeLocation
      if (!location || 'value' in node) continue
      if (!('tagName' in node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || (!tags.has(node.tagName) && !(figure && node.tagName === 'figcaption'))
        || node.tagName === 'figure' && !figure) {
        issues.push({ start: location.startOffset, end: location.endOffset, reason: 'unsupported-html' })
        continue
      }
      const kept = new Set(attributes(node).map(([name]) => name))
      if (node.attrs.some((attr) => !kept.has(attr.name))) {
        issues.push({ start: location.startOffset, end: node.sourceCodeLocation?.startTag?.endOffset ?? location.endOffset, reason: 'html-attributes' })
      }
      visit(node.childNodes)
    }
  }
  visit(parseFragment(source, { sourceCodeLocationInfo: true }).childNodes)
  return issues
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
  md.renderer.rules.html_figure_open = (tokens, index, options, _env, renderer) => tokens[index].meta?.inlineFigure
    ? '<span' + renderer.renderAttrs(tokens[index]) + '>' : renderer.renderToken(tokens, index, options)
  md.renderer.rules.html_figure_close = (tokens, index, options, _env, renderer) => tokens[index].meta?.inlineFigure
    ? '</span>' : renderer.renderToken(tokens, index, options)
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

  md.block.ruler.before('html_block', 'html_figure', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false
    const from = state.bMarks[start] + state.tShift[start]
    if (!/^<figure(?=[\s>])/i.test(state.src.slice(from))) return false
    const candidate = state.getLines(start, end, state.blkIndent, false)
    const source = elementSource(candidate, candidate.length - candidate.trimStart().length)
    const presentation = source && parseImageFigure(source)
    if (!source || !presentation) return false
    const positions = htmlSourcePositions(state, start, source)
    if (!positions) return false
    const nextLine = start + source.split('\n').length, endOffset = positions.at(-1)!
    if (state.src.slice(endOffset, state.eMarks[nextLine - 1]).trim()) return false
    if (silent) return true
    const { tokens, meta } = figureTokens(source, presentation, (type, tag, nesting) => new state.Token(type, tag, nesting))
    tokens[0].map = [start, nextLine]
    meta.htmlFigureRange = { start: positions[0], end: endOffset }
    if (state.env.captureSourceLinks) for (const link of meta.htmlSourceLinks) {
      capturedMarkdownSourceLinks(state.env).push({ ...link, start: positions[link.start], end: positions[link.end - 1] + 1 })
    }
    for (const finding of state.env.captureCompatibility ? compatibilityFindings(source) : []) {
      recordMarkdownCompatibility(state.env, { ...finding, start: positions[finding.start], end: positions[finding.end - 1] + 1 }, true)
    }
    for (const token of tokens) {
      const pushed = state.push(token.type, token.tag, token.nesting)
      Object.assign(pushed, token, { level: pushed.level, block: token === tokens[0] || token.type === 'html_figure_close' })
    }
    state.line = nextLine
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })

  // Observation only: do not consume input or change how Markdown renders.
  // Escapes, code, math, YAML and image alt text retain the parser's exclusions.
  md.inline.ruler.before('safe_html', 'html_compatibility', (state, silent) => {
    if (silent || !state.env.captureCompatibility || state.src[state.pos] !== '<') return false
    const rest = state.src.slice(state.pos)
    const complete = elementSource(state.src, state.pos)
    const raw = complete ?? /^(?:<!--[\s\S]*?-->|<[a-z][\w-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>)/i.exec(rest)?.[0]
    if (!raw) return false
    const findings = complete && parsedElement(complete) ? compatibilityFindings(raw)
      : [{ start: 0, end: raw.length, reason: 'unsupported-html' as const }]
    for (const finding of findings) recordMarkdownCompatibility(state.env, {
      ...finding, start: state.pos + finding.start, end: state.pos + finding.end
    })
    return false
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
    for (const finding of state.env.captureCompatibility ? compatibilityFindings(opening! + '</details>') : []) {
      recordMarkdownCompatibility(state.env, { ...finding, start: positions[finding.start], end: positions[finding.end] }, true)
    }
    let bodyStart = opening!.length
    const summaryStart = bodyStart + source.slice(bodyStart).length - source.slice(bodyStart).trimStart().length
    const summarySource = /^<summary(?=[\s>])/i.test(source.slice(summaryStart)) ? elementSource(source, summaryStart) : null
    const first = summarySource ? parsedElement(summarySource) : null
    if (first?.sourceCodeLocation?.endTag) {
      const location = first.sourceCodeLocation
      const summary = state.push('html_element_open', 'summary', 1)
      summary.attrs = attributes(first); summary.meta = { html: true }
      for (const finding of state.env.captureCompatibility ? compatibilityFindings(summarySource!.slice(0, location.startTag!.endOffset) + '</summary>') : []) {
        recordMarkdownCompatibility(state.env, { ...finding, start: positions[summaryStart + finding.start], end: positions[summaryStart + finding.end] }, true)
      }
      const inline = state.push('inline', '', 0)
      inline.content = summarySource!.slice(location.startTag!.endOffset, location.endTag!.startOffset)
      inline.children = []
      inline.meta = { sourceMap: Array.from({ length: inline.content.length }, (_, index) => positions[summaryStart + location.startTag!.endOffset + index]) }
      state.push('html_element_close', 'summary', -1)
      bodyStart = summaryStart + location.endOffset
    }
    const body = source.slice(bodyStart, closing.index)
    const bodyTokens: Token[] = [], linkStart = capturedMarkdownSourceLinks(state.env).length
    const diagnosticStart = capturedMarkdownCompatibility(state.env).length
    const previous = state.env.suppressFrontmatter
    const previousDepth = Number(state.env.htmlDetailsDepth ?? 0)
    state.env.suppressFrontmatter = true
    state.env.htmlDetailsDepth = previousDepth + 1
    try { md.block.parse(body, md, state.env, bodyTokens) }
    finally { state.env.suppressFrontmatter = previous; state.env.htmlDetailsDepth = previousDepth }
    const lineOffset = start + (source.slice(0, bodyStart).match(/\n/g)?.length ?? 0)
    shiftMarkdownSourceCapture(state.env, bodyTokens, linkStart, (offset) => positions[bodyStart + offset], lineOffset, diagnosticStart)
    for (const token of bodyTokens) {
      token.level += state.level
      const range = token.meta?.htmlFigureRange
      if (token.meta && isFigureRange(range)) token.meta.htmlFigureRange = {
        start: positions[bodyStart + range.start], end: positions[bodyStart + range.end]
      }
    }
    state.tokens.push(...bodyTokens)
    state.push('html_details_close', 'details', -1)
    state.line = nextLine
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
}
