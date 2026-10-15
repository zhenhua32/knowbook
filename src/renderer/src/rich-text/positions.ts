import type { Node } from 'prosemirror-model'
import { AllSelection, NodeSelection, TextSelection, type EditorState, type Selection } from 'prosemirror-state'
import type { EditorHistoryBookmark } from '../utils/editorHistoryFocus'
import { richBlockEntries, richBlockEntryAt } from './model'

export type RichEndpoint = NonNullable<EditorHistoryBookmark['richText']>['anchor']
export type RichSelectionBookmark = NonNullable<EditorHistoryBookmark['richText']>

export function richSelectionKind(selection: Selection): NonNullable<RichSelectionBookmark['kind']> {
  return selection instanceof AllSelection ? 'all' : selection instanceof NodeSelection ? 'node' : 'text'
}

export function richSelectionFromBookmark(doc: Node, bookmark: RichSelectionBookmark): Selection {
  if (bookmark.kind === 'all') return new AllSelection(doc)
  if (bookmark.kind === 'node') {
    const entries = richBlockEntries(doc)
    const entry = entries.find(({ node }) => node.attrs.block?.id === bookmark.anchor.blockId) ?? entries[bookmark.anchor.index]
    if (entry && NodeSelection.isSelectable(entry.node)) return NodeSelection.create(doc, entry.pos)
  }
  return TextSelection.between(doc.resolve(richPositionOf(doc, bookmark.anchor)), doc.resolve(richPositionOf(doc, bookmark.head)))
}

export function richTextSelectionBlockIds(state: EditorState): string[] {
  const { selection } = state
  if (selection.empty) {
    const id = richBlockEntryAt(state.doc, selection.from)?.node.attrs.block?.id
    return id ? [id] : []
  }
  return richBlockEntries(state.doc).filter(({ node, pos }) => {
    const structural = node.type.name === 'columns_block' || node.type.name === 'column_block'
    return structural ? selection.from <= pos && selection.to >= pos + node.nodeSize
      : selection.from < pos + node.nodeSize && selection.to > pos
        && !(node.isTextblock && selection.to === pos + 1)
  }).flatMap(({ node }) => node.attrs.block?.id ? [node.attrs.block.id as string] : [])
}

export function richEndpoint(doc: Node, position: number): RichEndpoint {
  const entry = richBlockEntryAt(doc, position)
  return entry ? { blockId: entry.node.attrs.block?.id, index: entry.index,
    offset: Math.max(0, Math.min(entry.node.content.size, position - entry.pos - 1)) } : { index: 0, offset: 0 }
}

export function richPositionOf(doc: Node, point: RichEndpoint): number {
  const entries = richBlockEntries(doc)
  const entry = (point.blockId && entries.find(({ node }) => node.attrs.block?.id === point.blockId)) || entries[point.index] || entries[0]
  return entry ? Math.min(entry.pos + 1 + Math.min(point.offset, entry.node.content.size), doc.content.size) : 0
}
