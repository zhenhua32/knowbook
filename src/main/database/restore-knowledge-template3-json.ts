import { graph3Conflict } from './restore-knowledge-graph3-data'
import type { Navigation3TextEdit } from './restore-knowledge-navigation3-rewrite-cells'

/** Locations in an already JSON.parse-validated saved block array. Ordinary
 * persisted JSON uses last-key-wins semantics. Do not turn it into strict
 * manifest JSON, normalize unrelated literals, or recurse into ignored values. */
export function template3ContentStringRanges(raw: string) {
  let at = 0
  const bad = (): never => graph3Conflict('template-content-string-locator', at)
  const whitespace = () => { while (at < raw.length && /[\t\n\r ]/.test(raw[at])) at++ }
  const string = () => {
    const from = at
    if (raw[at++] !== '"') return bad()
    while (at < raw.length) {
      const character = raw[at++]
      if (character === '\\') at++
      else if (character === '"') return { from, to: at }
    }
    return bad()
  }
  const value = () => {
    whitespace()
    const from = at
    if (raw[at] === '"') return string()
    if (raw[at] === '{' || raw[at] === '[') {
      let depth = 0
      do {
        const character = raw[at]
        if (character === '"') { string(); continue }
        at++
        if (character === '{' || character === '[') depth++
        else if (character === '}' || character === ']') depth--
      } while (depth && at < raw.length)
      if (depth) return bad()
    } else {
      while (at < raw.length && !/[\t\n\r ,}\]]/.test(raw[at])) at++
      if (at === from) return bad()
    }
    return { from, to: at }
  }
  const result: Array<{ from: number; to: number }> = []
  whitespace()
  if (raw[at++] !== '[') return bad()
  whitespace()
  if (raw[at] !== ']') for (;;) {
    if (raw[at++] !== '{') return bad()
    let content: { from: number; to: number } | null = null
    whitespace()
    if (raw[at] !== '}') for (;;) {
      const keyRange = string(), key: unknown = JSON.parse(raw.slice(keyRange.from, keyRange.to))
      whitespace()
      if (raw[at++] !== ':') return bad()
      const range = value()
      if (key === 'content') content = range // Only the last effective key.
      whitespace()
      if (raw[at] === '}') break
      if (raw[at++] !== ',') return bad()
      whitespace()
    }
    at++
    if (!content || raw[content.from] !== '"') return bad()
    result.push(content)
    whitespace()
    if (raw[at] === ']') break
    if (raw[at++] !== ',') return bad()
    whitespace()
  }
  at++; whitespace()
  if (at !== raw.length) return bad()
  return result
}

/** Project decoded UTF-16 positions onto the original spelling of one JSON
 * string. Escapes outside the edited destinations remain byte-for-byte intact. */
export function projectTemplate3ContentStringEdits(raw: string, content: string, edits: readonly Navigation3TextEdit[]) {
  const bad = (): never => graph3Conflict('template-content-string-edit-projection', null)
  if (raw[0] !== '"' || raw.at(-1) !== '"' || JSON.parse(raw) !== content) return bad()
  const required = new Set(edits.flatMap(edit => [edit.from, edit.to])), offsets = new Map<number, number>()
  let decoded = 0, offset = 1
  while (offset < raw.length - 1) {
    if (required.has(decoded)) offsets.set(decoded, offset)
    offset += raw[offset] === '\\' ? raw[offset + 1] === 'u' ? 6 : 2 : 1
    decoded++
  }
  if (offset !== raw.length - 1 || decoded !== content.length) return bad()
  if (required.has(decoded)) offsets.set(decoded, offset)
  return edits.map(edit => {
    const from = offsets.get(edit.from), to = offsets.get(edit.to)
    if (from === undefined || to === undefined || from >= to) return bad()
    const before = raw.slice(from, to)
    if (JSON.parse('"' + before + '"') !== edit.before) return bad()
    return { from, to, before, after: JSON.stringify(edit.after).slice(1, -1) }
  })
}
