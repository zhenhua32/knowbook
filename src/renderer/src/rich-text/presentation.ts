import type { Command, EditorState } from 'prosemirror-state'
import { normalizeInlineTextColor, type InlineTextColor } from '@shared/inlineTextPresentation'
import { richTextSchema } from './schema'

/** A color action replaces only its own mark. The selection (including its
 * direction), underline, code and the other color remain untouched. */
export function setRichTextColor(name: 'textColor' | 'backgroundColor', color?: InlineTextColor): Command {
  if (normalizeInlineTextColor(color) === null) throw new Error('Invalid text color.')
  return (state, dispatch) => {
    const { selection } = state, type = richTextSchema.marks[name]
    if (selection.empty) {
      if (selection.$from.parent.type !== richTextSchema.nodes.text_block) return false
      const tr = state.tr.removeStoredMark(type)
      if (color) tr.addStoredMark(type.create({ color }))
      dispatch?.(tr)
      return true
    }
    let applicable = false
    state.doc.nodesBetween(selection.from, selection.to, node => {
      if (node.type === richTextSchema.nodes.text_block && node.content.size) applicable = true
    })
    if (!applicable) return false
    const tr = state.tr.removeMark(selection.from, selection.to, type)
    if (color) tr.addMark(selection.from, selection.to, type.create({ color }))
    dispatch?.(tr)
    return true
  }
}

/** Undefined is the default, null is a mixed selection. Empty selections read
 * the stored marks so typing immediately after a palette action stays correct. */
export function selectedRichTextColor(state: EditorState, name: 'textColor' | 'backgroundColor'): InlineTextColor | undefined | null {
  const type = richTextSchema.marks[name], { selection } = state
  const read = (marks: typeof state.storedMarks) => marks?.find(mark => mark.type === type)?.attrs.color as InlineTextColor | undefined
  if (selection.empty) return read(state.storedMarks ?? selection.$from.marks())
  let seen = false, value: InlineTextColor | undefined | null
  state.doc.nodesBetween(selection.from, selection.to, node => {
    if (!node.isInline) return
    const color = read(node.marks)
    if (seen && value !== color) value = null
    else if (!seen) value = color
    seen = true
  })
  return value
}
