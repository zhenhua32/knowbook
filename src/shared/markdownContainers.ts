import { parseFragment, type DefaultTreeAdapterTypes as Html } from 'parse5'
import type { Token } from 'markdown-it'
import { NATIVE_LITERAL_ATTRIBUTE, NATIVE_LITERAL_VERSION, encodeNativeLiteralText } from './markdownNativeText'
import { NATIVE_CALLOUT_KINDS, NATIVE_CALLOUT_ICONS, NATIVE_CONTAINER_TONES, normalizeMarkdownFormat, type MarkdownBlockFormat } from './markdownFormat'

export const NATIVE_CONTAINER_ATTRIBUTE = 'data-knowbook-container'
export type NativeMarkdownContainer = {
  type: 'toggle' | 'callout'
  markdownFormat?: MarkdownBlockFormat
  headerRange: [number, number]
  bodyRange: [number, number]
  closingRange: [number, number]
  literalEscaped?: boolean
}
type NativeOpening = Pick<NativeMarkdownContainer, 'type' | 'markdownFormat' | 'literalEscaped'> & { tag: 'details' | 'aside'; titleTag: 'summary' | 'div' }

export class NativeMarkdownContainerError extends Error {
  constructor(message: string) {
    super('Invalid native Markdown container: ' + message)
    this.name = 'NativeMarkdownContainerError'
  }
}
export function nativeMarkdownContainer(token: Token): NativeMarkdownContainer | undefined {
  return token.meta?.nativeContainer as NativeMarkdownContainer | undefined
}
function elementShell(source: string, tag: string): Html.Element {
  let malformed = false
  const nodes = parseFragment(source + '</' + tag + '>', { sourceCodeLocationInfo: true,
    onParseError: error => { if (error.code === 'duplicate-attribute') malformed = true } }).childNodes
  const root = nodes[0]
  if (malformed || nodes.length !== 1 || !root || !('tagName' in root) || root.tagName !== tag
    || root.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !root.sourceCodeLocation?.endTag) {
    throw new NativeMarkdownContainerError('malformed or duplicate shell attributes')
  }
  return root
}
export function validateNativeContainerFormat(type: string, value: unknown): void {
  if (!['toggle', 'callout'].includes(type) || value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeMarkdownContainerError('invalid backup container format')
  const allowed = type === 'toggle' ? ['toggleDefaultOpen'] : ['calloutKind', 'calloutIcon', 'calloutTone']
  const normalized = normalizeMarkdownFormat(type, value)
  for (const [key, field] of Object.entries(value))
    if (!allowed.includes(key) || field !== normalized?.[key as keyof MarkdownBlockFormat])
      throw new NativeMarkdownContainerError('invalid backup container format field ' + key)
}
export function nativeContainerFormatsAgree(type: string, authored: MarkdownBlockFormat | undefined, derived: MarkdownBlockFormat | undefined): boolean {
  if (type === 'toggle') return (authored?.toggleDefaultOpen ?? true) === (derived?.toggleDefaultOpen ?? false)
  const kind = authored?.calloutKind ?? 'note', otherKind = derived?.calloutKind ?? 'note'
  return kind === otherKind && (authored?.calloutIcon ?? kind) === (derived?.calloutIcon ?? otherKind)
    && (authored?.calloutTone ?? 'gray') === (derived?.calloutTone ?? 'gray')
}export function parseNativeContainerOpening(source: string): NativeOpening | null {
  if (!/\bdata-knowbook-container\b/i.test(source)) return null
  const tag = /^<([a-z][\w-]*)(?=[\s>])/i.exec(source)?.[1].toLowerCase()
  if (!tag) throw new NativeMarkdownContainerError('unsupported shell')
  const probe = parseFragment(source + '</' + tag + '>').childNodes[0]
  if (!probe || !('tagName' in probe) || !probe.attrs.some(attr => attr.name === NATIVE_CONTAINER_ATTRIBUTE)) return null
  if (!['details', 'aside'].includes(tag)) throw new NativeMarkdownContainerError('unsupported marked shell')
  const root = elementShell(source, tag)
  const attrs = new Map(root.attrs.map(attr => [attr.name, attr.value]))
  const marker = attrs.get(NATIVE_CONTAINER_ATTRIBUTE)
  const type = marker === 'toggle-v1' ? 'toggle' : marker === 'callout-v1' ? 'callout' : null
  if (!type || tag !== (type === 'toggle' ? 'details' : 'aside')) throw new NativeMarkdownContainerError('unknown marker or mismatched shell')
  const allowed = new Set([NATIVE_CONTAINER_ATTRIBUTE, NATIVE_LITERAL_ATTRIBUTE, ...(type === 'toggle' ? ['open']
    : ['data-knowbook-kind', 'data-knowbook-icon', 'data-knowbook-tone'])])
  if (root.attrs.some(attr => !allowed.has(attr.name))) throw new NativeMarkdownContainerError('unsupported shell attribute')
  const escape = attrs.get(NATIVE_LITERAL_ATTRIBUTE)
  if (escape !== undefined && escape !== NATIVE_LITERAL_VERSION) throw new NativeMarkdownContainerError('unknown native text escape version')
  const format: MarkdownBlockFormat = type === 'toggle' ? { toggleDefaultOpen: false } : {}
  if (type === 'toggle' && attrs.has('open')) {
    if (!['', 'open'].includes(attrs.get('open')!)) throw new NativeMarkdownContainerError('invalid open attribute')
    format.toggleDefaultOpen = true
  }
  for (const [attribute, field, values] of [
    ['data-knowbook-kind', 'calloutKind', NATIVE_CALLOUT_KINDS],
    ['data-knowbook-icon', 'calloutIcon', NATIVE_CALLOUT_ICONS],
    ['data-knowbook-tone', 'calloutTone', NATIVE_CONTAINER_TONES]
  ] as const) {
    const value = attrs.get(attribute)
    if (value !== undefined) {
      if (!(values as readonly string[]).includes(value)) throw new NativeMarkdownContainerError('invalid ' + attribute)
      Object.assign(format, { [field]: value })
    }
  }
  return { type, tag: tag as NativeOpening['tag'], titleTag: type === 'toggle' ? 'summary' : 'div',
    markdownFormat: normalizeMarkdownFormat(type, format), literalEscaped: escape === NATIVE_LITERAL_VERSION }
}
export function parseNativeContainerTitle(source: string, opening: NativeOpening): { content: string; offset: number } {
  const tag = opening.titleTag
  const match = new RegExp('^<' + tag + '((?:[^"\'<>]|"[^"]*"|\'[^\']*\')*)>([\\s\\S]*)</' + tag + '>$', 'i').exec(source)
  if (!match) throw new NativeMarkdownContainerError('expected a complete title shell')
  const shell = elementShell('<' + tag + match[1] + '>', tag)
  if (opening.type === 'toggle' ? shell.attrs.length !== 0
    : shell.attrs.length !== 1 || shell.attrs[0].name !== 'data-knowbook-title' || shell.attrs[0].value !== 'true') {
    throw new NativeMarkdownContainerError('invalid title attributes')
  }
  return { content: match[2], offset: match[0].indexOf('>') + 1 }
}

/** Locate a title shell without treating a closing-looking inline code span as
 * markup. Canonical headers end before the blank separator preceding children. */
export function nativeContainerTitleLines(lines: string[], start: number, opening: NativeOpening): { source: string; endLine: number } {
  const close = '</' + opening.titleTag + '>'
  let boundary = lines.length
  for (let line = start; line < lines.length; line++) {
    if (lines[line].trimEnd().toLowerCase().endsWith(close) && (!lines[line + 1]?.trim())) { boundary = line + 1; break }
  }
  let source = lines.slice(start, boundary).join('\n')
  const complete = lines.slice(start).join('\n')
  const prefix = /^<(?:summary|div)(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(source.trimStart())?.[0]
  if (!prefix) throw new NativeMarkdownContainerError('missing title shell')
  let position = source.indexOf(prefix) + prefix.length
  while (position < source.length) {
    if (source[position] === '`') {
      const run = /^`+/.exec(source.slice(position))![0]
      let escaped = 0
      for (let at = position - 1; at >= 0 && source[at] === '\\'; at--) escaped++
      if (escaped % 2 === 0) {
        const runs = /`+/g; runs.lastIndex = position + run.length
        let closing: RegExpExecArray | null
        while ((closing = runs.exec(source))) if (closing[0].length === run.length) break
        if (!closing) {
          // A provisional closing followed by a blank line may itself be
          // inside a multi-line code span. Extend only through its real title
          // close; an unrelated body code span cannot consume the title.
          const futureRuns = /`+/g; futureRuns.lastIndex = position + run.length
          let future: RegExpExecArray | null
          while ((future = futureRuns.exec(complete))) if (future[0].length === run.length) break
          if (future) {
            const afterCode = future.index + future[0].length
            const tail = complete.slice(afterCode)
            const blank = /\n[ \t]*\n/.exec(tail)?.index ?? tail.length
            const nextClose = tail.slice(0, blank).toLowerCase().lastIndexOf(close)
            const openingTitle = new RegExp('<' + opening.titleTag + '(?=[\\s>])', 'i')
            if (nextClose >= 0 && nextClose < blank && !openingTitle.test(tail.slice(0, nextClose))) {
              const closeAt = afterCode + nextClose + close.length
              const lineEnd = complete.indexOf('\n', closeAt)
              if (!complete.slice(closeAt, lineEnd < 0 ? complete.length : lineEnd).trim()) {
                boundary = start + (complete.slice(0, closeAt).match(/\n/g)?.length ?? 0) + 1
                source = lines.slice(start, boundary).join('\n')
                closing = future
              }
            }
          }
        }
        if (closing) { position = closing.index + closing[0].length; continue }
      }
      position += run.length; continue
    }
    if (source.slice(position, position + close.length).toLowerCase() === close) {
      const after = position + close.length
      // A line-ending literal close followed by a soft break remains title
      // content. Only the closing at the canonical header boundary owns it.
      if (!source.slice(after).trim()) {
        const endLine = start + (source.slice(0, after).match(/\n/g)?.length ?? 0) + 1
        return { source: lines.slice(start, endLine).join('\n').trim(), endLine }
      }
    }
    position++
  }
  throw new NativeMarkdownContainerError('missing title closing shell')
}
/** Native shells have dedicated closing lines; code fences never terminate them. */
export function nativeContainerClosingLine(lines: string[], start: number, end: number, tag: string, nesting = 0): number {
  if (nesting > 20) throw new NativeMarkdownContainerError('container shell nesting limit exceeded')
  let depth = 1
  let fence: { marker: string; width: number } | undefined
  for (let line = start; line < end; line++) {
    const text = lines[line]
    const code = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(text)
    if (fence) {
      if (code && code[1][0] === fence.marker && code[1].length >= fence.width && !code[2].trim()) fence = undefined
      continue
    }
    if (code && (code[1][0] !== '`' || !code[2].includes('`'))) {
      fence = { marker: code[1][0], width: code[1].length }; continue
    }
    // An atomic legacy shell owns all of its Markdown/literal body. A closing
    // tag example inside it cannot terminate the enclosing native owner.
    const legacy = /^ {0,3}<(details|figure)(?=[\s>])/i.exec(text)?.[1].toLowerCase()
    if (legacy && !/\bdata-knowbook-container\b/i.test(text)) {
      if (new RegExp('</' + legacy + '[\\t ]*>[\\t ]*$', 'i').test(text)) continue
      line = nativeContainerClosingLine(lines, line + 1, end, legacy, nesting + 1); continue
    }
    const math = /^ {0,3}(\$\$|\\\[)[\t ]*$/.exec(text)
    if (math) {
      const close = math[1] === '$$' ? /^ {0,3}\$\$[\t ]*$/ : /^ {0,3}\\\][\t ]*$/
      const last = lines.findIndex((value, index) => index > line && index < end && close.test(value))
      if (last >= 0) { line = last; continue }
    }
    const nestedSource = /^ {0,3}(<[a-z][\w-]*(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>)/i.exec(text)?.[1]
    const nested = nestedSource && parseNativeContainerOpening(nestedSource)
    if (nested) {
      const title = nativeContainerTitleLines(lines, line + 1, nested)
      line = nativeContainerClosingLine(lines, title.endLine, end, nested.tag, nesting + 1)
      continue
    }    const open = new RegExp('^ {0,3}<' + tag + '(?=[\\s>])', 'i').test(text)
    const closes = new RegExp('</' + tag + '[\\t ]*>[\\t ]*$', 'i').test(text)
    if (open) {
      if (!closes) depth++
    } else if (new RegExp('^ {0,3}</' + tag + '[\\t ]*>[\\t ]*$', 'i').test(text) && --depth === 0) return line
  }
  throw new NativeMarkdownContainerError('missing closing shell')
}
export function recordNativeContainerError(environment: Record<string, unknown>, message: string): void {
  const errors: unknown[] = Array.isArray(environment.nativeContainerErrors) ? environment.nativeContainerErrors : []
  errors.push(message); environment.nativeContainerErrors = errors
}export function assertNativeContainerParse(environment: Record<string, unknown>): void {
  const errors = environment.nativeContainerErrors
  if (Array.isArray(errors) && errors.length) throw new NativeMarkdownContainerError(String(errors[0]))
}
export function shiftNativeContainerRanges(token: Token, lineOffset: number): void {
  const value = nativeMarkdownContainer(token)
  if (!value) return
  token.meta = { ...token.meta, nativeContainer: { ...value,
    headerRange: value.headerRange.map(line => line + lineOffset),
    bodyRange: value.bodyRange.map(line => line + lineOffset),
    closingRange: value.closingRange.map(line => line + lineOffset) } }
}
export function renderNativeContainerHeader(block: { type: string; content: string; markdownFormat?: MarkdownBlockFormat }): string {
  const content = encodeNativeLiteralText(block.content, 'title').source
  const escape = ' ' + NATIVE_LITERAL_ATTRIBUTE + '="' + NATIVE_LITERAL_VERSION + '"'
  // A title remains Markdown source. Closing shell-looking text is safe because
  // only an entire dedicated body line can close a native container.
  if (block.type === 'toggle') return '<details data-knowbook-container="toggle-v1"'
    + escape + (block.markdownFormat?.toggleDefaultOpen !== false ? ' open' : '') + '>\n<summary>' + content + '</summary>'
  const format = normalizeMarkdownFormat('callout', block.markdownFormat)
  const attrs = [['data-knowbook-kind', format?.calloutKind], ['data-knowbook-icon', format?.calloutIcon], ['data-knowbook-tone', format?.calloutTone]]
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([name, value]) => ' ' + name + '="' + value + '"').join('')
  return '<aside data-knowbook-container="callout-v1"' + attrs + escape + '>\n<div data-knowbook-title="true">' + content + '</div>'
}
export function nativeContainerClosingTag(type: string): string { return type === 'toggle' ? '</details>' : '</aside>' }
