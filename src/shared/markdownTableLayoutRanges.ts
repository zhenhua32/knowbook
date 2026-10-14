import { markdownEngine } from './markdownEngine'

/** Protect each authored width as a value while allowing edits in other columns
 * or in the table body to merge independently. Unbound comments stay literal. */
export function markdownTableWidthValueRanges(source: string): Array<{ from: number; to: number }> {
  if (!source.includes('<!-- knowbook:table-widths:v1 ')) return []
  const lines = source.split('\n'), offsets: number[] = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length + 1 }
  const ranges: Array<{ from: number; to: number }> = []
  for (const token of markdownEngine.parse(source, {})) {
    if (token.type !== 'knowbook_table_layout' || !token.meta?.boundTableLayout || !token.map) continue
    const raw = lines[token.map[0]] ?? '', bracket = raw.indexOf('['), close = raw.lastIndexOf(']')
    if (bracket < 0 || close <= bracket) continue
    const json = raw.slice(bracket + 1, close)
    for (const match of json.matchAll(/null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
      const from = offsets[token.map[0]] + bracket + 1 + match.index!
      ranges.push({ from, to: from + match[0].length })
    }
  }
  return ranges
}
