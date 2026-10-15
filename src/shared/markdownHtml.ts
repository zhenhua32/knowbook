import { decodeNativeLiteralText } from './markdownNativeText'
import type MarkdownIt from 'markdown-it'
import type { StateBlock, Token } from 'markdown-it'
import { parseFragment, type DefaultTreeAdapterTypes as Html } from 'parse5'
import { capturedMarkdownSourceLinks, capturedMarkdownCompatibility, recordMarkdownCompatibility, shiftMarkdownSourceCapture, type MarkdownDestination, type MarkdownCompatibilityFinding } from './markdownSourceLinks'
import { IMAGE_ALIGN_ATTRIBUTE, IMAGE_CROP_ATTRIBUTE, parseImageCropAttribute, parseImageFigure, type ImagePresentation } from './markdownMedia'
import { INLINE_TEXT_COLOR_ATTRIBUTE, INLINE_BACKGROUND_COLOR_ATTRIBUTE, INLINE_TEXT_SHELL_ATTRIBUTE, parseInlineTextPresentationAttributes } from './inlineTextPresentation'

import { nativeContainerClosingLine, nativeContainerTitleLines, recordNativeContainerError, parseNativeContainerOpening, parseNativeContainerTitle, shiftNativeContainerRanges, type NativeMarkdownContainer } from './markdownContainers'
import { COLUMN_WEIGHT_TOTAL, MAX_COLUMNS } from './columnStructure'

const presentationTags = new Set(['u', 'span'])
const semanticInlineTags = new Set(['strong', 'em', 's', 'del', 'mark', 'code'])
const tags = new Set(['br', 'kbd', 'sub', 'sup', 'img', 'a', 'details', 'summary', 'figure', ...presentationTags])
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

/** A layout is an explicit sequence of column shells, never a best-effort
 * HTML repair. Check this in the grammar as well as before persistence so
 * hidden source and protocol-gate consumers see the same invalid structure. */
function validateColumnsBody(tokens: Token[], body: string): void {
  const columns: Token[] = []
  let depth = 0
  for (const token of tokens) {
    if (depth === 0 && token.type !== 'knowbook_metadata') {
      const native = token.meta?.nativeContainer as NativeMarkdownContainer | undefined
      if (token.type !== 'native_container_open' || native?.type !== 'column') throw new Error('columns owner accepts only column shells')
      columns.push(token)
    }
    depth += token.nesting
    if (depth < 0) throw new Error('unbalanced column shells')
  }
  if (depth !== 0 || columns.length < 1 || columns.length > MAX_COLUMNS) throw new Error('columns owner requires one to six columns')
  if (columns.reduce((sum, token) => sum + (token.meta!.nativeContainer as NativeMarkdownContainer).markdownFormat!.columnWeight!, 0) !== COLUMN_WEIGHT_TOTAL)
    throw new Error('column weights must sum to 10000')
  const lines = body.split('\n')
  let cursor = 0
  for (const column of columns) {
    const gap = lines.slice(cursor, column.map![0]).filter(line => line.trim())
    if (gap.length > 1 || gap.length === 1 && !/^<!-- knowbook:block \{.*\} -->$/.test(gap[0]))
      throw new Error('columns owner contains content outside its columns')
    cursor = column.map![1]
  }
  if (lines.slice(cursor).some(line => line.trim())) throw new Error('columns owner contains trailing content outside its columns')
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
  if (presentationTags.has(element.tagName)) {
    const presentation = parseInlineTextPresentationAttributes(element.tagName, element.attrs)
    return presentation ? [...(element.tagName === 'span' && element.attrs.some(attr => attr.name === INLINE_TEXT_SHELL_ATTRIBUTE && attr.value === 'true') ? [[INLINE_TEXT_SHELL_ATTRIBUTE, 'true'] as [string, string]] : []),
      ...(presentation.textColor ? [[INLINE_TEXT_COLOR_ATTRIBUTE, presentation.textColor] as [string, string]] : []),
      ...(presentation.backgroundColor ? [[INLINE_BACKGROUND_COLOR_ATTRIBUTE, presentation.backgroundColor] as [string, string]] : [])] : []
  }
  if (semanticInlineTags.has(element.tagName)) return []
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

function htmlTokens(nodes: Html.ChildNode[], source: string, make: TokenFactory, links: MarkdownDestination[], depth = 0, presentationContext = false): Token[] {
  return nodes.flatMap((node): Token[] => {
    const text = (value: string, unsupported = false) => { const token = make('text', '', 0); token.content = value; token.meta = { html: true, ...(unsupported ? { unsupportedHtml: true } : {}) }; return [token] }
    if ('value' in node) return text(node.value)
    if (!('tagName' in node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      || !tags.has(node.tagName) && !(presentationContext && semanticInlineTags.has(node.tagName)) || depth > 100) {
      const location = node.sourceCodeLocation
      return location ? text(source.slice(location.startOffset, location.endOffset), true) : []
    }
    if ((presentationTags.has(node.tagName) && !parseInlineTextPresentationAttributes(node.tagName, node.attrs))
      || semanticInlineTags.has(node.tagName) && node.attrs.length || !voidTags.has(node.tagName) && !node.sourceCodeLocation?.endTag) {
      const location = node.sourceCodeLocation
      return location ? text(source.slice(location.startOffset, location.endOffset), true) : []
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
    return [token, ...htmlTokens(node.childNodes, source, make, links, depth + 1, presentationContext || presentationTags.has(tag)), make(type === 'link_open' ? 'link_close' : 'html_element_close', tag, -1)]
  })
}

function parsedElement(source: string): Html.Element | null {
  let duplicateAttribute = false
  const nodes = parseFragment(source, { sourceCodeLocationInfo: true, onParseError: error => { if (error.code === 'duplicate-attribute') duplicateAttribute = true } }).childNodes
  const root = nodes[0]
  if (duplicateAttribute || nodes.length !== 1 || !root || !('tagName' in root) || !tags.has(root.tagName)) return null
  const location = root.sourceCodeLocation
  return location?.startOffset === 0 && location.endOffset === source.length
    && (voidTags.has(root.tagName) || location.endTag) ? root : null
}

function compatibilityFindings(source: string): MarkdownCompatibilityFinding[] {
  const issues: MarkdownCompatibilityFinding[] = []
  const figure = parseImageFigure(source)
  const visit = (nodes: Html.ChildNode[], presentationContext = false) => {
    for (const node of nodes) {
      const location = node.sourceCodeLocation
      if (!location || 'value' in node) continue
      if ('tagName' in node && node.tagName === 'span' && !node.attrs.length) {
        issues.push({ start: location.startOffset, end: 'startTag' in location ? location.startTag?.endOffset ?? location.endOffset : location.endOffset, reason: 'unsupported-html' })
        continue
      }
      if (!('tagName' in node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
        || (!tags.has(node.tagName) && !(presentationContext && semanticInlineTags.has(node.tagName)) && !(figure && node.tagName === 'figcaption'))
        || node.tagName === 'figure' && !figure) {
        issues.push({ start: location.startOffset, end: location.endOffset, reason: 'unsupported-html' })
        continue
      }
      const kept = new Set(attributes(node).map(([name]) => name))
      if (node.attrs.some((attr) => !kept.has(attr.name)) || presentationTags.has(node.tagName) && !parseInlineTextPresentationAttributes(node.tagName, node.attrs)) {
        issues.push({ start: location.startOffset, end: node.sourceCodeLocation?.startTag?.endOffset ?? location.endOffset, reason: 'html-attributes' })
      }
      visit(node.childNodes, presentationContext || presentationTags.has(node.tagName))
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
    if (!root || root.tagName === 'details' || root.tagName === 'span' && !root.attrs.length || root.tagName === 'a' && state.linkLevel > 0) return false
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

  // Only explicitly marked shells become editable native container forests.
  // Legacy details and advanced quote callouts continue through their old rules.
  const { fn: parseReference, alt: referenceAlt } = md.block.ruler.__rules__.find(rule => rule.name === 'reference')!
  md.block.ruler.at('reference', (state, start, end, silent) => {
    if (!state.env.nativeLiteralEscaped) return parseReference(state, start, end, silent)
    // Let the existing rule parse one real definition into an isolated map.
    // Re-key its original label before first-binding is decided: an encoded
    // label must not collide with a different authored outer/sibling label.
    const previous = state.env.references, first = state.tokens.length
    state.env.references = {}
    let accepted: boolean
    let parsed: NonNullable<typeof state.env.references>
    try { accepted = parseReference(state, start, end, silent); parsed = state.env.references }
    finally { state.env.references = previous }
    if (!accepted || silent) return accepted
    const token = state.tokens.slice(first).find(token => token.type === 'reference_definition')
    if (!token?.map || typeof token.meta?.label !== 'string') return accepted
    let raw = ''
    for (let line = token.map[0]; line < token.map[1]; line++)
      raw += state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]) + '\n'
    const label = /^\[((?:\\[\s\S]|[^\]\\])*)\]:/.exec(raw)?.[1]
    const value = parsed![token.meta.label]
    const normalized = label === undefined ? token.meta.label : md.utils.normalizeReference(decodeNativeLiteralText(label).content)
    const references = state.env.references ??= {}
    if (value && references[normalized] === undefined) references[normalized] = {
      href: decodeNativeLiteralText(value.href).content, title: decodeNativeLiteralText(value.title).content
    }
    token.meta = { ...token.meta, label: normalized, nativeReferenceEscaped: label !== undefined }
    return accepted
  }, { alt: referenceAlt })
  md.block.ruler.before('html_block', 'native_container', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false
    const firstLine = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start])
    if (!/^<[a-z][\w-]*(?=[\s>])/i.test(firstLine)
      || !/\bdata-knowbook-container\b/i.test(firstLine)) return false
    const candidate = state.getLines(start, end, state.blkIndent, false)
    const openingSource = /^(?:[ \t]*)(<(?:[a-z][\w-]*)(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>)/i.exec(candidate)?.[1]
    if (!openingSource) {
      if (!silent && /^\s*<[a-z][\w-]*\s[^\n]*\bdata-knowbook-container\b/i.test(candidate.split('\n')[0]))
        recordNativeContainerError(state.env, 'malformed marked opening shell')
      return false
    }
    if (!/\bdata-knowbook-container\b/i.test(openingSource)) return false
    try {
      if (Number(state.env.htmlDetailsDepth ?? 0) >= md.options.maxNesting) throw new Error('container nesting limit exceeded')
      if (/[\r\n]/.test(openingSource)) throw new Error('opening shell must occupy one line')
      const opening = parseNativeContainerOpening(openingSource)
      if (!opening) return false
      if (!state.env.nativeContainerOpaque && opening.type === 'column' && state.env.nativeContainerParent !== 'columns') throw new Error('column shell requires a columns owner')
      if (!state.env.nativeContainerOpaque && state.env.nativeContainerParent === 'columns' && opening.type !== 'column') throw new Error('columns owner accepts only column shells')
      const lines = candidate.split('\n')
      if (lines[0].trim() !== openingSource) throw new Error('unexpected text after opening shell')
      const titleHeader = opening.titleTag ? nativeContainerTitleLines(lines, 1, opening) : null
      const title = titleHeader ? parseNativeContainerTitle(titleHeader.source, opening) : null
      const bodyLine = titleHeader?.endLine ?? 1
      const closeLine = nativeContainerClosingLine(lines, bodyLine, lines.length, opening.tag)
      const source = lines.slice(0, closeLine + 1).join('\n')
      const positions = htmlSourcePositions(state, start, source)
      if (!positions) throw new Error('container source cannot be mapped safely')
      if (silent) return true
      const meta: NativeMarkdownContainer = { type: opening.type, markdownFormat: opening.markdownFormat, literalEscaped: opening.literalEscaped,
        headerRange: [start, start + bodyLine], bodyRange: [start + bodyLine, start + closeLine], closingRange: [start + closeLine, start + closeLine + 1] }
      const open = state.push('native_container_open', opening.tag, 1)
      open.meta = { nativeContainer: meta, nativeLiteralEscaped: Boolean(opening.literalEscaped) }; open.map = [start, start + closeLine + 1]
      if (title) {
        const inline = state.push('inline', '', 0)
        inline.content = title.content; inline.children = []; inline.map = meta.headerRange
        const titleOffset = lines[0].length + 1 + (lines[1].length - lines[1].trimStart().length) + title.offset
        inline.meta = { nativeContainerTitle: opening.type, nativeLiteralEscaped: Boolean(opening.literalEscaped),
          sourceMap: Array.from({ length: title.content.length }, (_, index) => positions[titleOffset + index]) }
      }
      const bodyStart = lines.slice(0, bodyLine).reduce((length, line) => length + line.length + 1, 0)
      const body = lines.slice(bodyLine, closeLine).join('\n')
      const bodyTokens: Token[] = [], linkStart = capturedMarkdownSourceLinks(state.env).length
      const diagnosticStart = capturedMarkdownCompatibility(state.env).length
      const previous = state.env.suppressFrontmatter, previousDepth = Number(state.env.htmlDetailsDepth ?? 0)
      const priorEscape = state.env.nativeLiteralEscaped
      const priorParent = state.env.nativeContainerParent
      state.env.suppressFrontmatter = true; state.env.htmlDetailsDepth = previousDepth + 1
      state.env.nativeLiteralEscaped = Boolean(opening.literalEscaped)
      state.env.nativeContainerParent = opening.type
      try { md.block.parse(body, md, state.env, bodyTokens) }
      finally { state.env.suppressFrontmatter = previous; state.env.htmlDetailsDepth = previousDepth; state.env.nativeLiteralEscaped = priorEscape
        state.env.nativeContainerParent = priorParent }

      if (opening.type === 'columns' && !state.env.nativeContainerOpaque) validateColumnsBody(bodyTokens, body)

      shiftMarkdownSourceCapture(state.env, bodyTokens, linkStart, offset => positions[bodyStart + offset], start + bodyLine, diagnosticStart)
      let legacyDepth = 0
      for (const token of bodyTokens) {
        if (['html_details_open', 'html_figure_open'].includes(token.type)) legacyDepth++
        if (!Object.hasOwn(token.meta ?? {}, 'nativeLiteralEscaped')) token.meta = { ...token.meta,
          nativeLiteralEscaped: Boolean(opening.literalEscaped) && legacyDepth === 0 && !['fence', 'code_block', 'math_block', 'frontmatter', 'knowbook_metadata'].includes(token.type) }
        if (['html_details_close', 'html_figure_close'].includes(token.type)) legacyDepth--
        token.level += state.level
        shiftNativeContainerRanges(token, start + bodyLine)
        const range = token.meta?.htmlFigureRange
        if (token.meta && isFigureRange(range)) token.meta.htmlFigureRange = { start: positions[bodyStart + range.start], end: positions[bodyStart + range.end] }
      }
      state.tokens.push(...bodyTokens)
      const close = state.push('native_container_close', opening.tag, -1)
      close.meta = { nativeContainer: meta, nativeLiteralEscaped: Boolean(opening.literalEscaped) }; close.map = meta.closingRange
      state.line = start + closeLine + 1
      return true
    } catch (error) {
      if (!silent) recordNativeContainerError(state.env, error instanceof Error ? error.message : String(error))
      return false
    }
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  // Restore scoped source after shell/block recognition, before the one shared
  // inline pass. The source map follows the encoded bytes, including entities.
  md.core.ruler.after('block', 'native_literal_decode', state => {
    for (const token of state.tokens) {
      if (!token.meta?.nativeLiteralEscaped) continue
      const projection = decodeNativeLiteralText(token.content)
      if (projection.content !== token.content) {
        const map = token.meta.sourceMap as number[] | undefined
        const ends = token.meta.sourceEndMap as number[] | undefined
        if (map && projection.starts && projection.ends) token.meta = { ...token.meta,
          sourceMap: projection.starts.map(position => map[position]),
          sourceEndMap: projection.ends.map(position => ends?.[position - 1] ?? map[position - 1] + 1) }
        token.content = projection.content
      }
      if (token.attrs) token.attrs = token.attrs.map(([name, value]) => [name, typeof value === 'string' ? decodeNativeLiteralText(value).content : value])
    }
  })
  md.core.ruler.after('inline', 'native_container_titles', state => {
    for (const token of state.tokens) if (token.meta?.nativeContainerTitle) token.type = 'native_container_title'
  })
  md.renderer.rules.native_container_open = (tokens, index, _options, _env) => {
    const value = tokens[index].meta!.nativeContainer as NativeMarkdownContainer
    if (value.type === 'columns') return '<section class="markdown-native-columns">\n'
    if (value.type === 'column') return '<div class="markdown-native-column" data-column-weight="' + value.markdownFormat!.columnWeight + '">\n'
    if (value.type === 'toggle') return '<details class="markdown-native-toggle"' + (value.markdownFormat?.toggleDefaultOpen ? ' open=""' : '') + '>\n'
    const format = value.markdownFormat
    const attrs = [['data-callout-kind', format?.calloutKind ?? 'note'], ['data-callout-icon', format?.calloutIcon ?? format?.calloutKind ?? 'note'],
      ['data-callout-tone', format?.calloutTone ?? 'gray']].map(([name, item]) => ' ' + name + '="' + md.utils.escapeHtml(item!) + '"').join('')
    return '<aside class="markdown-native-callout"' + attrs + '>\n'
  }
  md.renderer.rules.native_container_title = (tokens, index, options, env, renderer) => {
    const tag = tokens[index].meta?.nativeContainerTitle === 'toggle' ? 'summary' : 'div'
    return '<' + tag + (tag === 'div' ? ' class="markdown-native-callout-title"' : '') + '>'
      + renderer.renderInline(tokens[index].children ?? [], options, env) + '</' + tag + '>\n'
  }
  md.renderer.rules.native_container_close = (tokens, index) => '</' + tokens[index].tag + '>\n'
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
    const previousEscape = state.env.nativeLiteralEscaped
    const previousOpaque = state.env.nativeContainerOpaque
    state.env.nativeLiteralEscaped = false
    state.env.nativeContainerOpaque = true
    try { md.block.parse(body, md, state.env, bodyTokens) }
    finally { state.env.suppressFrontmatter = previous; state.env.htmlDetailsDepth = previousDepth; state.env.nativeLiteralEscaped = previousEscape
      state.env.nativeContainerOpaque = previousOpaque }
    const lineOffset = start + (source.slice(0, bodyStart).match(/\n/g)?.length ?? 0)
    shiftMarkdownSourceCapture(state.env, bodyTokens, linkStart, (offset) => positions[bodyStart + offset], lineOffset, diagnosticStart)
    for (const token of bodyTokens) {
      token.level += state.level
      shiftNativeContainerRanges(token, lineOffset)
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
