type SelectionDirection = 'forward' | 'backward' | 'none'

/** Edit literal source indentation without replacing selections or normalizing newlines. */
export function editCodeIndentation(
  content: string,
  start: number,
  end: number,
  outdent: boolean,
  direction: SelectionDirection = 'none'
): { content: string; start: number; end: number; direction: SelectionDirection } {
  const clamp = (position: number) => Math.max(0, Math.min(content.length,
    Number.isFinite(position) ? Math.trunc(position) : 0))
  start = clamp(start)
  end = Math.max(start, clamp(end))
  if (!outdent && start === end) {
    return { content: content.slice(0, start) + '  ' + content.slice(end),
      start: start + 2, end: end + 2, direction }
  }

  // A selected newline belongs to its preceding line. An endpoint at the
  // next line's column zero must not indent that otherwise unselected line.
  const lastTouched = end > start ? end - 1 : start
  let lineStart = start === 0 ? 0 : content.lastIndexOf('\n', start - 1) + 1
  let copiedThrough = 0, mappedStart = start, mappedEnd = end
  const parts: string[] = []
  while (lineStart <= lastTouched) {
    const removed = !outdent ? 0 : content[lineStart] === '\t' ? 1
      : content[lineStart] === ' ' ? (content[lineStart + 1] === ' ' ? 2 : 1) : 0
    if (!outdent || removed) {
      parts.push(content.slice(copiedThrough, lineStart), outdent ? '' : '  ')
      copiedThrough = lineStart + removed
      // Map the original UTF-16 endpoints, clamping only endpoints inside a
      // removed prefix. Backwards selections retain their anchor/head order.
      if (outdent) {
        mappedStart -= Math.min(removed, Math.max(0, start - lineStart))
        mappedEnd -= Math.min(removed, Math.max(0, end - lineStart))
      } else {
        if (start >= lineStart) mappedStart += 2
        if (end >= lineStart) mappedEnd += 2
      }
    }
    const newline = content.indexOf('\n', lineStart)
    if (newline === -1) break
    lineStart = newline + 1
  }
  if (!parts.length) return { content, start, end, direction }
  parts.push(content.slice(copiedThrough))
  return { content: parts.join(''), start: mappedStart, end: mappedEnd, direction }
}
