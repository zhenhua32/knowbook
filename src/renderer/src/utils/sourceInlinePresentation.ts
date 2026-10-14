import { Fragment, type Node } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import { INLINE_TEXT_SHELL_ATTRIBUTE, type InlineTextColor } from '@shared/inlineTextPresentation'
import { markdownEngine, type MarkdownEnvironment } from '@shared/markdownEngine'
import { draftBlocksToRichDoc, richTextInlineFingerprint, serializeRichTextInlineHtml } from '../rich-text/model'
import { richTextSchema } from '../rich-text/schema'
import { setRichTextColor } from '../rich-text/presentation'

export type SourceInlinePresentationAction = { kind: 'underline' } | { kind: 'textColor' | 'backgroundColor'; color?: InlineTextColor }
export type SourceInlinePresentationSelection = { content: string; start: number; end: number; direction: 'forward' | 'backward' | 'none' }
const documentFor = (content: string, references?: MarkdownEnvironment['references']) => draftBlocksToRichDoc([{ id: 'source-format', type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null }], references)

function withinSurrogate(source: string, position: number): boolean {
  return position > 0 && position < source.length && /[\uD800-\uDBFF]/.test(source[position - 1]) && /[\uDC00-\uDFFF]/.test(source[position])
}

/** Probes locate source selections through the actual grammar. Removing the
 * sentinels must recover the entire original inline model exactly; selection
 * inside tag attributes, entities, link destinations or split delimiters fails
 * this condition and cannot turn existing Markdown marks into literal text. */
function locateSelection(source: string, start: number, end: number, original: Node, references?: MarkdownEnvironment['references']): { start: number; end: number } | null {
  let counter = 0, left: string, right: string
  do { left = `\uE000KnowBookStart${counter}\uE001`; right = `\uE000KnowBookEnd${counter++}\uE001` } while (source.includes(left) || source.includes(right))
  for (const [leftHtml, rightHtml] of [[false, false], [true, true], [false, true], [true, false]]) {
    const inserted = source.slice(0, start) + (leftHtml ? `<span ${INLINE_TEXT_SHELL_ATTRIBUTE}="true">${left}</span>` : left) + source.slice(start, end)
      + (rightHtml ? `<span ${INLINE_TEXT_SHELL_ATTRIBUTE}="true">${right}</span>` : right) + source.slice(end)
    const probe = documentFor(inserted, references).firstChild!
    if (probe.type !== richTextSchema.nodes.text_block) continue
    const children: Node[] = []
    let from = -1, to = -1, leftCount = 0, rightCount = 0
    probe.forEach((node, offset) => {
      if (!node.isText) { children.push(node); return }
      let text = node.text!
      const atLeft = text.indexOf(left), atRight = text.indexOf(right)
      if (atLeft >= 0) { from = offset + atLeft; leftCount++; text = text.replace(left, '') }
      if (atRight >= 0) { to = offset + atRight; rightCount++; text = text.replace(right, '') }
      if (text) children.push(richTextSchema.text(text, node.marks))
    })
    if (leftCount !== 1 || rightCount !== 1 || from < 0 || to < from + left.length) continue
    const stripped = probe.copy(Fragment.fromArray(children))
    if (richTextInlineFingerprint(stripped) !== richTextInlineFingerprint(original)) continue
    return { start: from, end: to - left.length }
  }
  return null
}

export function formatSourceInlinePresentation(content: string, start: number, end: number, action: SourceInlinePresentationAction,
  direction: SourceInlinePresentationSelection['direction'] = 'none', references?: MarkdownEnvironment['references']): SourceInlinePresentationSelection | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > content.length || start >= end
    || withinSurrogate(content, start) || withinSurrogate(content, end)) return null
  if (markdownEngine.parse(content, { references }).some(token => !['paragraph_open', 'paragraph_close', 'inline'].includes(token.type))) return null
  const original = documentFor(content, references), node = original.firstChild!
  if (node.type !== richTextSchema.nodes.text_block) return null
  const range = locateSelection(content, start, end, node, references)
  if (!range || range.start >= range.end) return null
  let state = EditorState.create({ doc: original, selection: TextSelection.create(original,
    1 + (direction === 'backward' ? range.end : range.start), 1 + (direction === 'backward' ? range.start : range.end)) })
  const command = action.kind === 'underline' ? toggleMark(richTextSchema.marks.underline) : setRichTextColor(action.kind, action.color)
  if (!command(state, transaction => { state = state.apply(transaction) })) return null
  const result = serializeRichTextInlineHtml(state.doc.firstChild!)
  const restored = documentFor(result.content, references).firstChild!
  if (restored.type !== richTextSchema.nodes.text_block || richTextInlineFingerprint(restored) !== richTextInlineFingerprint(state.doc.firstChild!)) return null
  return { content: result.content, start: result.startOffsets[range.start], end: result.endOffsets[range.end], direction }
}
