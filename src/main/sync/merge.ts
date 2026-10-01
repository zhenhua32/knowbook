import type { DocumentBlockDraft } from '../../shared/contracts'
import { isListBlockType, isOrderedListBlockType, isTaskBlockType } from '../../shared/blockTypes'
import { normalizeMarkdownFormat } from '../../shared/markdownFormat'
import { collectMarkdownSourceLinks } from '../../shared/markdownLinks'
import type { WebDavSyncMergeChoice, WebDavSyncMergePart } from '../../shared/webdav-sync'
import { canonicalJson, validId, type SyncDocument } from './model'

const MAX_TEXT_LENGTH = 32_000
const MAX_DIFF_CELLS = 1_000_000
const DOCUMENT_DIFF_BUDGET = 4_000_000
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const blockProperties = ['checked', 'tags', 'language', 'listStart', 'markdownFormat', 'highlight'] as const
const blockKeys = new Set(['id', 'type', 'content', 'depth', 'parentBlockId', ...blockProperties])
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right)
type TextEdit = { from: number; to: number; insert: string[] }
type DiffBudget = { cells: number }

/** Preserve destination identity: two edits to one URL must never create a third URL. */
function textTokens(text: string): string[] {
  const ranges = collectMarkdownSourceLinks(text).map(link => ({ from: link.start, to: link.end }))
  for (const match of text.matchAll(/(?:knowbook-asset:\/\/|file:\/\/\/)[^\s<>()[\]"']+/g)) {
    ranges.push({ from: match.index!, to: match.index! + match[0].length })
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to)
  const protectedRanges: typeof ranges = []
  for (const range of ranges) {
    const previous = protectedRanges.at(-1)
    if (previous && range.from < previous.to) previous.to = Math.max(previous.to, range.to)
    else protectedRanges.push({ ...range })
  }
  const result: string[] = []
  let offset = 0
  const appendText = (value: string) => {
    for (const part of segmenter.segment(value)) result.push(part.segment)
  }
  for (const range of protectedRanges) {
    appendText(text.slice(offset, range.from))
    result.push(text.slice(range.from, range.to))
    offset = range.to
  }
  appendText(text.slice(offset))
  return result
}

function editsBetween(base: string[], next: string[], budget: DiffBudget): TextEdit[] | null {
  let start = 0
  while (start < base.length && start < next.length && base[start] === next[start]) start++
  let baseEnd = base.length, nextEnd = next.length
  while (baseEnd > start && nextEnd > start && base[baseEnd - 1] === next[nextEnd - 1]) { baseEnd--; nextEnd-- }
  const left = base.slice(start, baseEnd), right = next.slice(start, nextEnd)
  if (!left.length && !right.length) return []
  if (!left.length || !right.length) {
    const edit = { from: start, to: baseEnd, insert: right }
    // Repeated runs admit multiple equally valid insertion/deletion locations.
    const changed = left.length ? left : right
    if (same(base.slice(Math.max(0, start - changed.length), start), changed)
      || same(base.slice(baseEnd, baseEnd + changed.length), changed)) return null
    return [edit]
  }
  const width = right.length + 1, cells = (left.length + 1) * width
  if (cells > MAX_DIFF_CELLS || cells > budget.cells) return null
  budget.cells -= cells
  const table = new Uint32Array(cells)
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const edits: TextEdit[] = []
  let i = 0, j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { i++; j++; continue }
    const remaining = table[i * width + j]
    if (!remaining) { edits.push({ from: start + i, to: baseEnd, insert: right.slice(j) }); break }
    let anchor: { i: number; j: number } | undefined
    // Replacement/deletion operation order can tie without making its location
    // ambiguous. Reject only when different first surviving anchors are possible.
    for (let a = i; a < left.length && table[a * width + j] === remaining; a++) {
      for (let b = j; b < right.length && table[a * width + b] === remaining; b++) {
        if (--budget.cells < 0) return null
        if (left[a] !== right[b] || table[(a + 1) * width + b + 1] !== remaining - 1) continue
        if (anchor) return null
        anchor = { i: a, j: b }
      }
    }
    if (!anchor) return null
    edits.push({ from: start + i, to: start + anchor.i, insert: right.slice(j, anchor.j) })
    i = anchor.i + 1; j = anchor.j + 1
  }
  return edits
}

function editOverlap(left: TextEdit, right: TextEdit): boolean {
  if (left.from === left.to) return left.from >= right.from && left.from <= right.to
  if (right.from === right.to) return right.from >= left.from && right.from <= left.to
  return left.from < right.to && right.from < left.to
}

function mergeText(base: string, local: string, remote: string, budget: DiffBudget): string | null {
  if (same(local, remote)) return local
  if (same(base, local)) return remote
  if (same(base, remote)) return local
  if (Math.max(base.length, local.length, remote.length) > MAX_TEXT_LENGTH) return null
  const original = textTokens(base)
  const left = editsBetween(original, textTokens(local), budget)
  const right = editsBetween(original, textTokens(remote), budget)
  if (!left || !right) return null
  const edits = [...left]
  for (const next of right) {
    if (left.some(edit => same(edit, next))) continue
    if (left.some(edit => editOverlap(edit, next))) return null
    edits.push(next)
  }
  const result = [...original]
  for (const edit of edits.sort((a, b) => b.from - a.from || b.to - a.to)) {
    result.splice(edit.from, edit.to - edit.from, ...edit.insert)
  }
  return result.join('')
}

/** Reject trees that the store would silently repair or discard metadata from. */
function validBlocks(blocks: DocumentBlockDraft[]): boolean {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 100_000) return false
  const previous = new Map<string, DocumentBlockDraft>()
  for (const block of blocks) {
    if (!block || !validId(block.id) || previous.has(block.id) || Object.keys(block).some(key => !blockKeys.has(key))
      || typeof block.type !== 'string' || !block.type || block.type !== block.type.trim()
      || typeof block.content !== 'string' || typeof block.checked !== 'boolean'
      || !Number.isInteger(block.depth) || block.depth < 0 || block.depth > 6) return false
    if (!isTaskBlockType(block.type) && block.checked) return false
    const parentId = block.parentBlockId ?? null
    if (parentId !== null && !validId(parentId)) return false
    if (!isListBlockType(block.type) && (block.depth !== 0 || parentId !== null)) return false
    if (parentId) {
      const parent = previous.get(parentId)
      if (!parent || !isListBlockType(parent.type) || block.depth !== parent.depth + 1) return false
    } else if (block.depth !== 0) return false
    if (block.tags !== undefined && (!Array.isArray(block.tags) || block.tags.some(tag => typeof tag !== 'string' || !tag || tag !== tag.trim())
      || new Set(block.tags).size !== block.tags.length)) return false
    if (block.language !== undefined && (block.type !== 'code' || typeof block.language !== 'string' || !block.language || block.language !== block.language.trim())) return false
    if (block.listStart !== undefined && (!isOrderedListBlockType(block.type) || !Number.isInteger(block.listStart) || block.listStart < 0 || block.listStart > 999_999_999)) return false
    if (!same(block.markdownFormat, normalizeMarkdownFormat(block.type, block.markdownFormat))) return false
    if (block.markdownFormat?.emptyCode && block.content.length) return false
    if (block.highlight !== undefined && !['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'].includes(block.highlight)) return false
    previous.set(block.id, block)
  }
  return true
}

function skeleton(blocks: DocumentBlockDraft[]): unknown {
  return blocks.map(({ id, type, depth, parentBlockId, markdownFormat }) => ({ id, type, depth, parentBlockId: parentBlockId ?? null,
    // Empty-code fences carry a content constraint, so their syntax cannot be
    // combined with a content change from the other side as an ordinary property.
    emptyCode: markdownFormat?.emptyCode === true }))
}

const preview = (value: unknown): string => typeof value === 'string' ? value : value === undefined ? '（未设置）' : JSON.stringify(value, null, 2)
const validTitle = (title: string): boolean => Boolean(title.trim()) && title.length <= 500 && !/[/\\\x00-\x1f]/.test(title) && !['.', '..'].includes(title)

export interface SyncDocumentMergeResult {
  /** A preview only; never persist while unresolved is nonempty. */
  document: SyncDocument
  conflicts: WebDavSyncMergePart[]
  unresolved: WebDavSyncMergePart[]
}

export function mergeSyncDocument(base: SyncDocument, local: SyncDocument, remote: SyncDocument,
  choices: Record<string, WebDavSyncMergeChoice> = {}): SyncDocumentMergeResult {
  if (base.kind !== 'document' || local.kind !== 'document' || remote.kind !== 'document'
    || base.id !== local.id || base.id !== remote.id || base.createdAt !== local.createdAt || base.createdAt !== remote.createdAt) {
    throw new Error('三方合并文档的身份或创建时间不一致。')
  }
  const conflicts: WebDavSyncMergePart[] = [], unresolved: WebDavSyncMergePart[] = []
  const budget: DiffBudget = { cells: DOCUMENT_DIFF_BUDGET }
  const resolve = <T>(part: Omit<WebDavSyncMergePart, 'basePreview' | 'localPreview' | 'remotePreview'>,
    before: T, left: T, right: T, valid: (value: T) => boolean = () => true): T => {
    const conflict = { ...part, basePreview: preview(before), localPreview: preview(left), remotePreview: preview(right) }
    conflicts.push(conflict)
    const choice = Object.hasOwn(choices, part.id) ? choices[part.id] : undefined
    let value = left, selected = false
    if (choice?.choice === 'local') { value = left; selected = true }
    else if (choice?.choice === 'remote') { value = right; selected = true }
    else if (choice?.choice === 'custom' && part.canEditText && typeof choice.text === 'string') {
      value = (part.field === 'title' ? choice.text.trim() : choice.text) as T; selected = true
    }
    if (!selected || !valid(value)) { unresolved.push(conflict); return left }
    return value
  }
  const scalar = <T>(field: WebDavSyncMergePart['field'], before: T, left: T, right: T,
    valid: (value: T) => boolean = () => true): T => {
    const automatic = same(left, right) ? left : same(before, left) ? right : same(before, right) ? left : undefined
    if (automatic !== undefined && valid(automatic)) return automatic
    return resolve({ id: field, field, canEditText: field === 'title' || field === 'summary' }, before, left, right, valid)
  }
  const text = (part: Omit<WebDavSyncMergePart, 'basePreview' | 'localPreview' | 'remotePreview'>,
    before: string, left: string, right: string): string => {
    const automatic = mergeText(before, left, right, budget)
    return automatic === null ? resolve(part, before, left, right) : automatic
  }
  const title = scalar('title', base.content.title, local.content.title, remote.content.title, validTitle)
  const summary = text({ id: 'summary', field: 'summary', canEditText: true }, base.content.summary, local.content.summary, remote.content.summary)
  const parentId = scalar('parentId', base.parentId, local.parentId, remote.parentId, value => value === null || validId(value) && value !== base.id)
  const sortOrder = scalar('sortOrder', base.sortOrder, local.sortOrder, remote.sortOrder, value => Number.isSafeInteger(value) && value >= 0)
  const before = base.content.blocks, left = local.content.blocks, right = remote.content.blocks
  let blocks: DocumentBlockDraft[]
  const structuralChoice = () => resolve({ id: 'blocks', field: 'blocks', canEditText: false }, before, left, right, validBlocks)
  if (same(left, right) && validBlocks(left)) blocks = left
  else if (same(before, left) && validBlocks(right)) blocks = right
  else if (same(before, right) && validBlocks(left)) blocks = left
  else if (!validBlocks(before) || !validBlocks(left) || !validBlocks(right)
    || !same(skeleton(before), skeleton(left)) || !same(skeleton(before), skeleton(right))) blocks = structuralChoice()
  else {
    const conflictCount = conflicts.length, unresolvedCount = unresolved.length
    blocks = before.map((block, index) => {
      const localBlock = left[index], remoteBlock = right[index]
      const merged: DocumentBlockDraft = { ...block, content: text({ id: `block:${block.id}:content`, field: 'block-content', blockId: block.id, canEditText: true },
        block.content, localBlock.content, remoteBlock.content) }
      for (const property of blockProperties) {
        const original = block[property], a = localBlock[property], b = remoteBlock[property]
        const value = same(a, b) ? a : same(original, a) ? b : same(original, b) ? a
          : resolve({ id: `block:${block.id}:${property}`, field: 'block-property', blockId: block.id, property, canEditText: false }, original, a, b)
        if (value === undefined) delete merged[property]
        else Object.assign(merged, { [property]: value })
      }
      return merged
    })
    if (!validBlocks(blocks)) {
      conflicts.length = conflictCount; unresolved.length = unresolvedCount
      blocks = structuralChoice()
    }
  }
  return { document: { kind: 'document', id: base.id, createdAt: base.createdAt, parentId, sortOrder,
    content: { title, summary, blocks: structuredClone(blocks) } }, conflicts, unresolved }
}
