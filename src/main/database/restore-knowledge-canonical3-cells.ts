import type { SyncedBindingKey, SyncedOriginV1 } from '../../shared/synced-blocks'
import { validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { graph3Conflict, graph3Key } from './restore-knowledge-graph3-data'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'

export interface Canonical3TextEdit { readonly key: SyncedBindingKey; readonly after: string }
const sameKey = (key: SyncedBindingKey) => graph3Key(key.blockId, key.from, key.to, key.raw, key.syntax)
const fail = (reason: string, detail: unknown): never => graph3Conflict('canonical3-' + reason, detail)
const splitSurrogate = (text: string, offset: number) => offset > 0 && offset < text.length
  && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])

/** The whitelist must be the exact whole-forest parser result, not arbitrary
 * substring claims. Empty ranges are accepted only at its real Markdown
 * destination insertion points. This pure function grants no Main authority. */
export function transformCanonical3Cell(original: string, parsed: readonly SyncedBindingKey[], edits: readonly Canonical3TextEdit[], encoding: string) {
  assertMerge3JsonBudget({ original, parsed, edits })
  if (!['UTF-8', 'UTF-16le', 'UTF-16be'].includes(encoding)) return fail('text-encoding', encoding)
  const whitelist = new Map<string, SyncedBindingKey>()
  const orderedKeys = [...parsed].sort((a, b) => a.from - b.from || a.to - b.to)
  for (let i = 0; i < orderedKeys.length; i++) {
    const key = orderedKeys[i], previous = orderedKeys[i - 1]
    if (!Number.isSafeInteger(key.from) || !Number.isSafeInteger(key.to) || key.from < 0 || key.to < key.from || key.to > original.length
      || original.slice(key.from, key.to) !== key.raw || key.to === key.from && (key.syntax !== 'markdown' || key.raw !== '')
      || splitSurrogate(original, key.from) || splitSurrogate(original, key.to)
      || previous && (key.from < previous.to || key.from === previous.from)) fail('parser-key-or-overlap', key)
    const id = sameKey(key)
    if (whitelist.has(id)) fail('duplicate-parser-key', key)
    whitelist.set(id, key)
  }
  const seen = new Set<string>(), ordered = [...edits].sort((a, b) => a.key.from - b.key.from || a.key.to - b.key.to)
  const prefix = [0], exact = new Map<string, { from: number; to: number; raw: string }>()
  let outputLength = original.length, outputBytes = Buffer.byteLength(original, encoding === 'UTF-8' ? 'utf8' : 'utf16le')
  for (let i = 0; i < ordered.length; i++) {
    const edit = ordered[i], id = sameKey(edit.key), previous = ordered[i - 1]
    if (!whitelist.has(id) || seen.has(id) || typeof edit.after !== 'string'
      || previous && (edit.key.from < previous.key.to || edit.key.from === previous.key.from)) fail('unproved-or-overlapping-edit', edit)
    seen.add(id)
    const delta = edit.after.length - edit.key.raw.length
    exact.set(id, { from: edit.key.from + prefix[i], to: edit.key.from + prefix[i] + edit.after.length, raw: edit.after })
    prefix.push(prefix[i] + delta); outputLength += delta
    outputBytes += Buffer.byteLength(edit.after, encoding === 'UTF-8' ? 'utf8' : 'utf16le')
      - Buffer.byteLength(edit.key.raw, encoding === 'UTF-8' ? 'utf8' : 'utf16le')
    if (!Number.isSafeInteger(outputLength) || !Number.isSafeInteger(outputBytes))
      fail('text-budget', null)
  }
  // No intermediate candidate string exists. Account for every declared edit
  // before enforcing the final bound, so a later shrink can offset growth.
  if (outputLength < 0 || outputBytes < 0 || outputBytes > 64 * 1024 * 1024) return fail('text-budget', null)
  const chunks: string[] = []; let offset = 0
  for (const edit of ordered) { chunks.push(original.slice(offset, edit.key.from), edit.after); offset = edit.key.to }
  chunks.push(original.slice(offset))
  const text = chunks.join('')
  if (Buffer.byteLength(text, encoding === 'UTF-8' ? 'utf8' : 'utf16le') !== outputBytes) fail('text-byte-accounting', null)
  const countEndingAt = (position: number) => {
    let low = 0, high = ordered.length
    while (low < high) { const middle = (low + high) >>> 1; if (ordered[middle].key.to <= position) low = middle + 1; else high = middle }
    return low
  }
  const project = (key: SyncedBindingKey): SyncedBindingKey => {
    if (!whitelist.has(sameKey(key))) return fail('unproved-projection', key)
    const own = exact.get(sameKey(key))
    if (own) return { ...key, ...own }
    const before = countEndingAt(key.from), through = countEndingAt(key.to)
    // Half-open destination ranges exclude another destination's insertion at
    // their right edge. An edited empty key itself uses the exact branch above.
    const point = through > 0 ? ordered[through - 1] : undefined
    const endDelta = point && point.key.from === key.to && point.key.to === key.to
      ? prefix[through - 1] : prefix[through]
    const from = key.from + prefix[before], to = key.to + endDelta
    return { ...key, from, to, raw: text.slice(from, to) }
  }
  return { text, edits: ordered, project }
}

function stringEnd(source: string, from: number): number {
  let offset = from + 1
  while (offset < source.length) {
    if (source[offset] === '\\') { offset += 2; continue }
    if (source[offset] === '"') return offset + 1
    offset++
  }
  return fail('origin-string-token', from)
}

/** Origin is strict, shallow and closed. Change only its two ID literals;
 * retain pathAtCreation's original JSON spelling, whitespace and key order. */
export function rewriteCanonical3OriginJson(original: string, next: SyncedOriginV1) {
  const before = validateSyncedOrigin(parseStrictJson(original, { maxBytes: Math.max(1, Buffer.byteLength(original)), maxDepth: 8 }))
  const checked = validateSyncedOrigin(next)
  if (before.pathAtCreation !== checked.pathAtCreation) return fail('origin-path-must-stay-literal', null)
  const replacements = new Map<string, string>([['documentId', checked.documentId], ['firstInstanceId', checked.firstInstanceId]])
  const changes: Array<{ from: number; to: number; before: string; after: string }> = []
  let offset = 0
  const white = () => { while (/\s/.test(original[offset] ?? '') && offset < original.length) offset++ }
  white(); if (original[offset++] !== '{') return fail('origin-object-token', null)
  while (offset < original.length) {
    white(); if (original[offset] === '}') break
    if (original[offset] !== '"') return fail('origin-key-token', offset)
    const endKey = stringEnd(original, offset), key = JSON.parse(original.slice(offset, endKey)) as string
    offset = endKey; white(); if (original[offset++] !== ':') return fail('origin-colon-token', offset)
    white(); const from = offset
    if (original[offset] === '"') {
      offset = stringEnd(original, offset)
      if (replacements.has(key)) {
        const after = JSON.stringify(replacements.get(key))
        if (JSON.parse(original.slice(from, offset)) !== replacements.get(key)) changes.push({ from, to: offset, before: original.slice(from, offset), after })
      }
    } else { while (offset < original.length && original[offset] !== ',' && original[offset] !== '}') offset++ }
    white(); if (original[offset] === ',') { offset++; continue }
    if (original[offset] === '}') break
    return fail('origin-separator-token', offset)
  }
  let text = original
  for (const change of [...changes].reverse()) text = text.slice(0, change.from) + change.after + text.slice(change.to)
  const actual = validateSyncedOrigin(parseStrictJson(text, { maxBytes: Math.max(1, Buffer.byteLength(text)), maxDepth: 8 }))
  if (graph3Key(actual) !== graph3Key(checked)) return fail('origin-result', null)
  return { text, changes }
}
