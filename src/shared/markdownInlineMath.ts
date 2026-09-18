export type MarkdownInlineMathMatch = { contentStart: number; contentEnd: number; end: number; markup: string }

/** Index valid closing delimiters once per inline source. Repeated unclosed
 * openings must not each scan the rest of a large paragraph. The matcher also
 * supports parser lookahead, which can revisit an earlier source position. */
export function createMarkdownInlineMathMatcher(source: string): (start: number, limit?: number) => MarkdownInlineMathMatch | null {
  let closings: { dollars: number[]; brackets: number[] } | undefined
  return (start, limit = source.length) => {
    const dollar = source[start] === '$' && source[start + 1] !== '$' && source[start - 1] !== '$'
    const bracket = source.startsWith('\\(', start)
    if (!dollar && !bracket) return null
    const opening = dollar ? '$' : '\\(', contentStart = start + opening.length
    if (contentStart >= limit || (dollar && /\s/.test(source[contentStart] ?? ''))) return null
    if (!closings) {
      closings = { dollars: [], brackets: [] }
      let slashes = 0
      for (let index = 0; index < source.length; index++) {
        if (slashes % 2 === 0) {
          if (source[index] === '$' && source[index - 1] !== '$' && source[index + 1] !== '$'
            && !/\s/.test(source[index - 1] ?? '') && !/\d/.test(source[index + 1] ?? '')) closings.dollars.push(index)
          if (source.startsWith('\\)', index)) closings.brackets.push(index)
        }
        slashes = source[index] === '\\' ? slashes + 1 : 0
      }
    }
    const positions = dollar ? closings.dollars : closings.brackets
    let low = 0, high = positions.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (positions[middle] < contentStart) low = middle + 1
      else high = middle
    }
    const end = positions[low] ?? -1
    return end <= contentStart || end >= limit ? null
      : { contentStart, contentEnd: end, end: end + opening.length, markup: opening }
  }
}
