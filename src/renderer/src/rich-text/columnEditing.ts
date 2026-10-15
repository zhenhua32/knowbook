import { Selection, type EditorState, type Transaction } from 'prosemirror-state'
import { richBlockEntries } from './model'

export function isCrossColumnSelection(state: EditorState): boolean {
  const { selection } = state
  if (selection.empty) return false
  const owner = (position: typeof selection.$from) => {
    for (let depth = position.depth; depth > 0; depth--)
      if (position.node(depth).type.name === 'column_block') return position.node(depth).attrs.block?.id
    return null
  }
  const from = owner(selection.$from), to = owner(selection.$to)
  return from !== to && Boolean(from || to)
}

/** Text selection across independent columns never joins or deletes their
 * structural shells. Existing empty text blocks keep their original identity. */
export function deleteCrossColumnSelection(state: EditorState): Transaction | null {
  if (!isCrossColumnSelection(state)) return null
  const { from, to } = state.selection, tr = state.tr
  const ranges = richBlockEntries(state.doc).flatMap(({ node, pos }) => {
    if (node.isTextblock) {
      const start = Math.max(from, pos + 1), end = Math.min(to, pos + node.nodeSize - 1)
      return start < end ? [{ from: start, to: end }] : []
    }
    return node.type.name === 'source_block' && from <= pos && to >= pos + node.nodeSize ? [{ from: pos, to: pos + node.nodeSize }] : []
  })
  for (let index = ranges.length - 1; index >= 0; index--) tr.delete(ranges[index].from, ranges[index].to)
  tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(from, -1)), 1))
  return tr
}
