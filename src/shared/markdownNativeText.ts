/** Native scopes distinguish authored closing-looking text from structural HTML.
 * Ordinary Markdown never enables this finite escape codec. */
export const NATIVE_LITERAL_MARKER = '<!-- knowbook:literal-close:v1 -->'
export const NATIVE_LITERAL_ATTRIBUTE = 'data-knowbook-escape'
export const NATIVE_LITERAL_VERSION = 'literal-v1'
export type NativeTextProjection = { content: string; source: string; starts?: number[]; ends?: number[] }
const closer = /^<\/(?:aside|details|summary|div|section)[\t ]*>/i
const entityCloser = /^&lt;(\/(?:aside|details|summary|div|section)[\t ]*)&gt;/i

/** Bounds code and complete legacy shells only; it grants no HTML permissions. */
function protectedTextRanges(content: string, inlineCode: boolean, legacy: boolean): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const fences = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/gm
  let fence: { start: number; marker: string; width: number } | undefined
  for (let match = fences.exec(content); match; match = fences.exec(content)) {
    if (fence) {
      if (match[1][0] === fence.marker && match[1].length >= fence.width && !match[2].trim()) {
        ranges.push([fence.start, fences.lastIndex]); fence = undefined
      }
    } else if (match[1][0] !== '`' || !match[2].includes('`')) fence = { start: match.index, marker: match[1][0], width: match[1].length }
  }
  if (fence) ranges.push([fence.start, content.length])
  const inRange = (at: number) => ranges.some(([from, to]) => from <= at && at < to)
  const runs = inlineCode ? /`+/g : /$^/g
  for (let match = runs.exec(content); match; match = runs.exec(content)) {
    if (inRange(match.index)) continue
    let slashes = 0
    for (let at = match.index - 1; at >= 0 && content[at] === '\\'; at--) slashes++
    if (slashes % 2) continue
    const future = /`+/g; future.lastIndex = runs.lastIndex
    let end: RegExpExecArray | null
    while ((end = future.exec(content))) if (end[0].length === match[0].length && !inRange(end.index)) break
    if (end) { ranges.push([match.index, future.lastIndex]); runs.lastIndex = future.lastIndex }
  }
  const tags = legacy ? /<\/?(details|figure)(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi : /$^/g
  const stack: Array<{ tag: string; start: number }> = []
  for (let match = tags.exec(content); match; match = tags.exec(content)) {
    if (inRange(match.index)) continue
    const tag = match[1].toLowerCase()
    if (!match[0].startsWith('</')) stack.push({ tag, start: match.index })
    else if (stack.at(-1)?.tag === tag) {
      const opening = stack.pop()!
      if (!stack.length) ranges.push([opening.start, tags.lastIndex])
    }
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

export function encodeNativeLiteralText(content: string, mode: 'title' | 'body' | 'opaque' = 'body'): NativeTextProjection {
  if (mode === 'opaque' || !content.includes(NATIVE_LITERAL_MARKER) && !/<\/(?:aside|details|summary|div)[\t ]*>/i.test(content)) return { content, source: content }
  const protectedRanges = protectedTextRanges(content, mode === 'title', mode === 'body')
  const edits: Array<{ from: number; to: number; source: string; starts: number[]; ends: number[] }> = []
  for (let position = 0; position < content.length;) {
    const protectedText = protectedRanges.some(([from, to]) => from <= position && position < to)
    if (content.startsWith(NATIVE_LITERAL_MARKER, position) && (mode === 'title' || !protectedText)) {
      edits.push({ from: position, to: position + NATIVE_LITERAL_MARKER.length, source: NATIVE_LITERAL_MARKER.repeat(2),
        starts: Array.from({ length: NATIVE_LITERAL_MARKER.length }, (_, index) => index),
        ends: Array.from({ length: NATIVE_LITERAL_MARKER.length }, (_, index) => index + 1) })
      position += NATIVE_LITERAL_MARKER.length; continue
    }
    const match = closer.exec(content.slice(position))
    if (match && !protectedText) {
      const raw = match[0], lineStart = content.lastIndexOf('\n', position - 1) + 1, newline = content.indexOf('\n', position)
      const lineEnd = newline < 0 ? content.length : newline
      if (mode === 'title' || !content.slice(lineStart, position).trim() && !content.slice(position + raw.length, lineEnd).trim()) {
        const encoded = NATIVE_LITERAL_MARKER + '&lt;' + raw.slice(1, -1) + '&gt;', prefix = NATIVE_LITERAL_MARKER.length
        const starts = [prefix, ...Array.from({ length: raw.length - 2 }, (_, index) => prefix + 4 + index), prefix + 4 + raw.length - 2]
        const ends = [prefix + 4, ...Array.from({ length: raw.length - 2 }, (_, index) => prefix + 5 + index), encoded.length]
        edits.push({ from: position, to: position + raw.length, source: encoded, starts, ends })
        position += raw.length; continue
      }
    }
    position++
  }
  if (!edits.length) return { content, source: content }
  const parts: string[] = [], starts: number[] = [], ends: number[] = []
  let cursor = 0, offset = 0
  for (const edit of edits) {
    const before = content.slice(cursor, edit.from); parts.push(before)
    for (let index = 0; index < before.length; index++) { starts.push(offset + index); ends.push(offset + index + 1) }
    offset += before.length; parts.push(edit.source)
    starts.push(...edit.starts.map(position => offset + position)); ends.push(...edit.ends.map(position => offset + position))
    offset += edit.source.length; cursor = edit.to
  }
  const tail = content.slice(cursor); parts.push(tail)
  for (let index = 0; index < tail.length; index++) { starts.push(offset + index); ends.push(offset + index + 1) }
  return { content, source: parts.join(''), starts, ends }
}

export function decodeNativeLiteralText(source: string): NativeTextProjection {
  if (!source.includes(NATIVE_LITERAL_MARKER)) return { source, content: source }
  const parts: string[] = [], starts: number[] = [], ends: number[] = []
  const append = (content: string, from: number) => {
    parts.push(content)
    for (let index = 0; index < content.length; index++) { starts.push(from + index); ends.push(from + index + 1) }
  }
  let position = 0, cursor = 0
  while ((position = source.indexOf(NATIVE_LITERAL_MARKER, cursor)) >= 0) {
    append(source.slice(cursor, position), cursor)
    const next = position + NATIVE_LITERAL_MARKER.length
    if (source.startsWith(NATIVE_LITERAL_MARKER, next)) {
      append(NATIVE_LITERAL_MARKER, position); cursor = next + NATIVE_LITERAL_MARKER.length; continue
    }
    const match = entityCloser.exec(source.slice(next))
    if (match) {
      const content = '<' + match[1] + '>', end = next + match[0].length
      parts.push(content); starts.push(next); ends.push(next + 4)
      for (let index = 0; index < match[1].length; index++) { starts.push(next + 4 + index); ends.push(next + 5 + index) }
      starts.push(end - 4); ends.push(end); cursor = end
    } else { append(NATIVE_LITERAL_MARKER, position); cursor = next }
  }
  append(source.slice(cursor), cursor)
  return { source, content: parts.join(''), starts, ends }
}

/** Translate source boundaries, including gaps occupied by the finite marker. */
export function nativeTextContentOffset(projection: NativeTextProjection, position: number, end = false): number | null {
  if (position < 0 || position > projection.source.length) return null
  if (!projection.starts || !projection.ends) return position
  const map = end ? projection.starts : projection.ends
  let low = 0, high = map.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (end ? map[middle] < position : map[middle] <= position) low = middle + 1
    else high = middle
  }
  return low
}
export function nativeTextSourceOffset(projection: NativeTextProjection, position: number, end = false): number {
  if (!projection.starts || !projection.ends) return position
  return end ? position === 0 ? 0 : projection.ends[position - 1] : projection.starts[position] ?? projection.source.length
}
type NativeTextToken = { type: string; map: [number, number] | null; meta: Record<string, unknown> | null }
/** Restore persistence slices only where the block parser enabled this scope.
 * Native children override their ancestor; opaque code/math never decode. */
export function decodedNativeSourceLines(source: string, tokens: NativeTextToken[]): string[] {
  const lines = source.split('\n'), enabled = new Uint8Array(lines.length)
  let legacyEnd = -1
  for (const token of tokens) {
    if (!token.map) continue
    if (['html_details_open', 'html_figure_open'].includes(token.type)) {
      legacyEnd = Math.max(legacyEnd, token.map[1]); enabled.fill(0, token.map[0], token.map[1]); continue
    }
    if (token.map[0] < legacyEnd) continue
    const native = token.meta?.nativeContainer as { literalEscaped?: boolean } | undefined
    if (token.type === 'native_container_open' && native)
      enabled.fill(native.literalEscaped ? 1 : 0, token.map[0], token.map[1])
    else if (['fence', 'code_block', 'math_block', 'frontmatter', 'knowbook_metadata'].includes(token.type))
      enabled.fill(0, token.map[0], token.map[1])
  }
  return lines.map((line, index) => enabled[index] ? decodeNativeLiteralText(line).content : line)
}

const projectedLines = new WeakMap<object, { source: string; lines: string[]; offsets: number[] }>()
/** All block source consumers use the same exact encoded-content projection. */
export function projectedMarkdownContentPosition(block: { type: string; content: string }, range: { startLine: number; endLine: number },
  markdown: string, lines: string[], offsets: number[], position: number, projection?: NativeTextProjection, end = false): number | null {
  const value = projection ?? { content: block.content, source: block.content }
  if (value.content !== block.content) return null
  if (block.type === 'callout' || block.type === 'toggle') {
    const prefix = block.type === 'toggle' ? '<summary>' : '<div data-knowbook-title="true">'
    const contentStart = offsets[range.startLine + 1] + prefix.length
    return markdown.slice(contentStart, contentStart + value.source.length) === value.source
      ? nativeTextContentOffset(value, position - contentStart, end) : null
  }
  let line = range.startLine
  while (line + 1 < offsets.length && offsets[line + 1] < position + (end ? 0 : 1)) line++
  let cached = projectedLines.get(block)
  if (!cached || cached.source !== value.source) {
    const lines = value.source.split('\n'), offsets = [0]
    for (const text of lines) offsets.push(offsets.at(-1)! + text.length + 1)
    cached = { source: value.source, lines, offsets }; projectedLines.set(block, cached)
  }
  const localLine = line - range.startLine
  const contentLine = cached.lines[localLine]
  if (contentLine === undefined || !lines[line].endsWith(contentLine)) return null
  const column = position - offsets[line] - (lines[line].length - contentLine.length)
  if (column < 0 || column > contentLine.length) return null
  const local = cached.offsets[localLine] + column
  return nativeTextContentOffset(value, local, end)
}
