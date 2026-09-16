import { getHeadingLevel, type HeadingLevel } from '@shared/markdownEngine'
import type { DocumentBlockDraft } from '@shared/contracts'

export type DocumentSection = { id: string; index: number; end: number; level: HeadingLevel; parentId: string | null }
export type DocumentFoldView = { collapsedIds: Set<string>; focusedHeadingId: string | null }

export function buildDocumentSections(blocks: DocumentBlockDraft[]): DocumentSection[] {
  const sections: DocumentSection[] = []
  const stack: DocumentSection[] = []
  blocks.forEach((block, index) => {
    const level = getHeadingLevel(block.type)
    if (!level || !block.id) return
    while (stack.length && stack.at(-1)!.level >= level) stack.pop()!.end = index
    const section: DocumentSection = { id: block.id, index, end: blocks.length, level, parentId: stack.at(-1)?.id ?? null }
    sections.push(section)
    stack.push(section)
  })
  return sections
}

export function findDocumentSection(sections: DocumentSection[], index: number): DocumentSection | null {
  let low = 0
  let high = sections.length - 1
  let current: DocumentSection | null = null
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (sections[middle].index <= index) { current = sections[middle]; low = middle + 1 }
    else high = middle - 1
  }
  return current && index < current.end ? current : null
}

export function getVisibleDocumentEntries(blocks: DocumentBlockDraft[], view: DocumentFoldView, sections = buildDocumentSections(blocks)) {
  const byId = new Map(sections.map((section) => [section.id, section]))
  const focus = view.focusedHeadingId ? byId.get(view.focusedHeadingId) : undefined
  const end = focus?.end ?? blocks.length
  const entries: Array<{ block: DocumentBlockDraft; index: number }> = []
  for (let index = focus?.index ?? 0; index < end; index++) {
    const block = blocks[index]
    entries.push({ block, index })
    if (!block.id || !view.collapsedIds.has(block.id)) continue
    const section = byId.get(block.id)
    if (section) index = Math.min(section.end, end) - 1
    else while (index + 1 < end && blocks[index + 1].depth > block.depth) index++
  }
  return entries
}

export function revealDocumentBlock(blocks: DocumentBlockDraft[], view: DocumentFoldView, targetId: string, sections = buildDocumentSections(blocks)): DocumentFoldView {
  const indexById = new Map(blocks.map((block, index) => [block.id, index]))
  const targetIndex = indexById.get(targetId)
  if (targetIndex === undefined) return view
  const collapsedIds = new Set(view.collapsedIds)
  for (const section of sections) {
    if (targetIndex > section.index && targetIndex < section.end) collapsedIds.delete(section.id)
  }
  let parentId = blocks[targetIndex].parentBlockId
  const visited = new Set<string>()
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    collapsedIds.delete(parentId)
    const parentIndex = indexById.get(parentId)
    parentId = parentIndex === undefined ? null : blocks[parentIndex].parentBlockId
  }
  const focus = sections.find((section) => section.id === view.focusedHeadingId)
  const focusedHeadingId = focus && (targetIndex < focus.index || targetIndex >= focus.end)
    ? findDocumentSection(sections, targetIndex)?.id ?? null : focus?.id ?? null
  if (focusedHeadingId) collapsedIds.delete(focusedHeadingId)
  return { collapsedIds, focusedHeadingId }
}

const FOLD_STORAGE_KEY = 'knowbook.documents.folding.v1'
type FoldStorage = Pick<Storage, 'getItem' | 'setItem'>
type StoredView = { collapsedIds: string[]; focusedHeadingId: string | null }
function readEntries(storage: FoldStorage): Array<[string, StoredView]> {
  const parsed: unknown = JSON.parse(storage.getItem(FOLD_STORAGE_KEY) ?? '[]')
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is [string, StoredView] => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === 'string' && entry[1] && Array.isArray(entry[1].collapsedIds)
    && entry[1].collapsedIds.length <= 20_000 && entry[1].collapsedIds.every((id: unknown) => typeof id === 'string')
    && (entry[1].focusedHeadingId === null || typeof entry[1].focusedHeadingId === 'string')).slice(0, 100)
}

export function readDocumentFoldView(documentId: string, storage?: FoldStorage): DocumentFoldView {
  try {
    const stored = readEntries(storage ?? window.localStorage).find(([id]) => id === documentId)?.[1]
    if (stored) return { collapsedIds: new Set(stored.collapsedIds), focusedHeadingId: stored.focusedHeadingId }
  } catch { /* Ignore damaged/unavailable preferences. */ }
  return { collapsedIds: new Set(), focusedHeadingId: null }
}

export function saveDocumentFoldView(documentId: string, view: DocumentFoldView, storage?: FoldStorage): void {
  try {
    const target = storage ?? window.localStorage
    let entries: Array<[string, StoredView]> = []
    try { entries = readEntries(target) } catch { /* Replace damaged preferences. */ }
    target.setItem(FOLD_STORAGE_KEY, JSON.stringify([
      [documentId, { collapsedIds: [...view.collapsedIds].slice(0, 20_000), focusedHeadingId: view.focusedHeadingId }],
      ...entries.filter(([id]) => id !== documentId)
    ].slice(0, 100)))
  } catch { /* Folding still works without preference storage. */ }
}
