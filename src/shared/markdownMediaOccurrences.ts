import { parseFragment, type DefaultTreeAdapterTypes as Html } from 'parse5'
import { markdownEngine, type MarkdownEnvironment } from './markdownEngine'
import { capturedMarkdownSourceImages, capturedMarkdownSourceLinks } from './markdownSourceLinks'
import { extractMarkdownFrontmatter } from './markdownFrontmatter'
import { IMAGE_ALIGN_ATTRIBUTE, IMAGE_CROP_ATTRIBUTE, imagePresentationFromElement, normalizeImagePresentation, parseImageCropAttribute, parseImageFigure, serializeImageFigure, type ImagePresentation } from './markdownMedia'

export type MarkdownImageOccurrence = { start: number; end: number; source: string; originalContent: string; presentation: ImagePresentation }

function element(node: Html.ChildNode): node is Html.Element { return 'tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml' }
function htmlImages(source: string): Array<{ start: number; end: number; destinationStart: number; destinationEnd: number; presentation: ImagePresentation }> {
  const images: ReturnType<typeof htmlImages> = []
  const visit = (nodes: Html.ChildNode[], figure: Html.Element | null = null) => {
    for (const node of nodes) {
      if (!element(node)) continue
      if (node.tagName === 'figure') { visit(node.childNodes, node); continue }
      if (node.tagName === 'img') {
        const location = node.sourceCodeLocation, src = location?.attrs?.src
        const range = (figure ?? node).sourceCodeLocation
        if (!location || !src || !range || figure && !range.endTag) continue
        const presentation = figure ? parseImageFigure(source.slice(range.startOffset, range.endOffset)) : imagePresentationFromElement(node)
        if (!presentation) continue
        const raw = source.slice(src.startOffset, src.endOffset), prefix = /^[^=]+=[\t\r\n ]*/.exec(raw)?.[0]
        if (!prefix) continue
        const quoted = ['"', "'"].includes(raw[prefix.length])
        images.push({ start: range.startOffset, end: range.endOffset, presentation,
          destinationStart: src.startOffset + prefix.length + (quoted ? 1 : 0), destinationEnd: src.endOffset - (quoted ? 1 : 0) })
      } else visit(node.childNodes, figure)
    }
  }
  visit(parseFragment(source, { sourceCodeLocationInfo: true }).childNodes)
  return images
}

/** Use the existing Markdown capture for code/YAML/escape exclusions. Parsing
 * HTML only supplies the containing img/figure bounds, never new destinations.
 */
export function collectMarkdownImageOccurrences(content: string, references?: MarkdownEnvironment['references']): MarkdownImageOccurrence[] {
  const offsets: number[] = []
  for (let index = 0; index < content.length; index++) {
    offsets.push(index)
    if (content[index] === '\r' && content[index + 1] === '\n') index++
  }
  offsets.push(content.length)
  const normalized = content.replace(/\r\n?/g, '\n'), headerEnd = extractMarkdownFrontmatter(normalized)?.end ?? 0
  const env: MarkdownEnvironment = { captureSourceLinks: true, captureImageOccurrences: true, references: { ...references } }
  const tokens = markdownEngine.parse(normalized.slice(0, headerEnd).replace(/[^\n]/g, ' ') + normalized.slice(headerEnd), env)
  const destinations = capturedMarkdownSourceLinks(env).filter(link => link.kind === 'image' && link.syntax === 'html')
    .map(link => ({ ...link, start: offsets[link.start], end: offsets[link.end] }))
  const html = destinations.length ? htmlImages(content) : []
  const occurrences: MarkdownImageOccurrence[] = []
  for (const token of tokens) if (token.type === 'html_figure_open' && token.meta?.htmlFigureRange) {
    const presentation = normalizeImagePresentation(token.meta.imagePresentation)
    const range = token.meta.htmlFigureRange as { start: number; end: number }
    const start = offsets[range.start], end = offsets[range.end]
    if (presentation && start !== undefined && end !== undefined) occurrences.push({ start, end, source: content.slice(start, end), originalContent: content, presentation })
  }
  for (const destination of destinations) {
    const image = html.find(item => item.destinationStart === destination.start && item.destinationEnd === destination.end)
    if (image) occurrences.push({ start: image.start, end: image.end, source: content.slice(image.start, image.end), originalContent: content, presentation: image.presentation })
  }
  for (const { start, end, token } of capturedMarkdownSourceImages(env)) {
    const presentation = normalizeImagePresentation({ src: token.attrGet('src'),
      alt: markdownEngine.renderer.renderInlineAsText(token.children ?? [], markdownEngine.options, env),
      title: token.attrGet('title') ?? undefined, caption: '', align: 'left' })
    const from = offsets[start], to = offsets[end]
    if (presentation && from !== undefined && to !== undefined) {
      occurrences.push({ start: from, end: to, source: content.slice(from, to), originalContent: content, presentation })
    }
  }
  return occurrences.sort((first, second) => first.start - second.start)
    .filter((image, index, all) => index === 0 || image.start !== all[index - 1].start || image.end !== all[index - 1].end)
}

/** Return null for a stale source range or invalid draft, preserving newer text. */
export function replaceMarkdownImageOccurrence(content: string, occurrence: MarkdownImageOccurrence, next: ImagePresentation, references?: MarkdownEnvironment['references']): string | null {
  if (content !== occurrence.originalContent || !Number.isInteger(occurrence.start) || !Number.isInteger(occurrence.end) || occurrence.start < 0 || occurrence.end <= occurrence.start
    || occurrence.end > content.length || content.slice(occurrence.start, occurrence.end) !== occurrence.source || !normalizeImagePresentation(next)) return null
  const current = collectMarkdownImageOccurrences(content, references).find(image => image.start === occurrence.start && image.end === occurrence.end && image.source === occurrence.source)
  if (!current || JSON.stringify(current.presentation) !== JSON.stringify(occurrence.presentation)) return null
  return content.slice(0, occurrence.start) + serializeImageFigure(next) + content.slice(occurrence.end)
}

export type MarkdownImageDisplay = { presentation: ImagePresentation; occurrence?: MarkdownImageOccurrence; renderedIndex: number }

/** Match actual rendered images by their full presentation and multiplicity.
 * An unsupported source image stays visible and cannot take another occurrence's
 * controls, including when both use the same URL and alt text. */
export function planMarkdownImageDisplays(content: string, references?: MarkdownEnvironment['references'], renderedHtml?: string): MarkdownImageDisplay[] {
  const occurrences = collectMarkdownImageOccurrences(content, references)
  const displays: MarkdownImageDisplay[] = []
  let renderedIndex = 0
  const footnoteSignatures = new Set<string>()
  const signature = (value: ImagePresentation) => JSON.stringify({ ...value, alt: value.alt.replace(/\r\n?/g, '\n'),
    caption: value.caption.replace(/\r\n?/g, '\n'), ...(value.title === undefined ? {} : { title: value.title.replace(/\r\n?/g, '\n') }) })
  const attribute = (node: Html.Element, name: string) => node.attrs.find(item => item.name === name)?.value
  const plainText = (node: Html.ChildNode): string => 'value' in node ? node.value
    : element(node) ? node.childNodes.map(plainText).join('') : ''
  const visit = (nodes: Html.ChildNode[]) => {
    for (const node of nodes) {
      if (!element(node)) continue
      if (node.tagName !== 'img') { visit(node.childNodes); continue }
      const index = renderedIndex++
      const image = imagePresentationFromElement(node)
      if (!image) continue
      const parent = node.parentNode
      const figure = parent && 'tagName' in parent && attribute(parent, IMAGE_ALIGN_ATTRIBUTE) !== undefined ? parent : null
      const caption = figure?.childNodes.find(child => element(child) && (child.tagName === 'figcaption'
        || attribute(child, 'class') === 'markdown-image-caption'))
      const rawCrop = figure && attribute(figure, IMAGE_CROP_ATTRIBUTE)
      const presentation = normalizeImagePresentation({ ...image,
        align: figure ? attribute(figure, IMAGE_ALIGN_ATTRIBUTE) : image.align,
        crop: rawCrop ? parseImageCropAttribute(rawCrop) : undefined, caption: caption ? plainText(caption) : '' })
      if (presentation) {
        displays.push({ presentation, renderedIndex: index })
        for (let ancestor = node.parentNode; ancestor; ancestor = 'parentNode' in ancestor ? ancestor.parentNode : null) {
          if ('tagName' in ancestor && (attribute(ancestor, 'class') ?? '').split(/\s+/).some(name => ['footnotes', 'footnote-item'].includes(name))) {
            footnoteSignatures.add(signature(presentation)); break
          }
        }
      }
    }
  }
  visit(parseFragment(renderedHtml ?? markdownEngine.render(content, { references: { ...references } })).childNodes)
  const groups = new Map<string, MarkdownImageOccurrence[]>()
  for (const occurrence of occurrences) {
    const key = signature(occurrence.presentation)
    const group = groups.get(key) ?? []
    group.push(occurrence); groups.set(key, group)
  }
  const renderedCounts = new Map<string, number>()
  for (const display of displays) {
    const key = signature(display.presentation)
    renderedCounts.set(key, (renderedCounts.get(key) ?? 0) + 1)
  }
  // Footnotes are relocated after the body. Identical images across that
  // boundary cannot be matched by source order and remain read-only.
  for (const [key, group] of groups) if (renderedCounts.get(key) !== group.length
    || group.length > 1 && footnoteSignatures.has(key)) groups.delete(key)
  for (const display of displays) {
    display.occurrence = groups.get(signature(display.presentation))?.shift()
    if (display.occurrence) display.presentation = display.occurrence.presentation
  }
  return displays
}
