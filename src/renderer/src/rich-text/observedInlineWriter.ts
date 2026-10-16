/*
 * The inline state machine below is adapted from prosemirror-markdown 1.13.8,
 * src/to_markdown.ts, MarkdownSerializerState.renderInline / isMarkAhead.
 * https://github.com/ProseMirror/prosemirror-markdown
 *
 * Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { Mark, type Node } from 'prosemirror-model'
import type { MarkdownSerializer, MarkdownSerializerState } from 'prosemirror-markdown'
import type { RichPmSpan } from './linkProvenance'

interface InlinePiece { text: string; spans: RichPmSpan[] }
const emptyPiece = (): InlinePiece => ({ text: '', spans: [] })
function unsupported(): never { throw new Error('富文本实际发射分支无法证明 PM 来源范围，未生成来源声明。') }

/** Cold opt-in counterpart of the installed writer. Content observations happen
 * in its real active-mark state, including whitespace moved across mark edges.
 * It never mutates a PM node or patches a serializer/prototype globally. */
export function renderObservedRichInline(state: MarkdownSerializerState, parent: Node,
  specs: MarkdownSerializer['marks'], content: (spans: readonly RichPmSpan[]) => void): void {
  const runtime = state as MarkdownSerializerState & { atBlockStart: boolean }
  if (typeof runtime.atBlockStart !== 'boolean' || !parent.inlineContent) unsupported()
  const getMark = (mark: Mark) => specs[mark.type.name] ?? unsupported()
  const hardBreak = state.options.hardBreakNodeName ?? 'hard_break'
  const isMarkAhead = (index: number, marks: readonly Mark[]) => {
    // Keep the installed state machine's exact hard-break traversal.
    for (;; index++) {
      if (index >= parent.childCount) return false
      const next = parent.child(index)
      if (next.type.name !== hardBreak) return next.marks.length >= marks.length && Mark.sameSet(next.marks.slice(0, marks.length), marks)
      index++
    }
  }
  const writeWhitespace = (piece: InlinePiece) => {
    if (!piece.text) return
    content(piece.spans)
    state.text(piece.text)
  }
  runtime.atBlockStart = true
  const active: Mark[] = []
  let trailing = emptyPiece()
  const progress = (original: Node | null, offset: number, index: number) => {
    let node = original, marks = node ? node.marks : []
    let from = offset, to = offset + (node?.nodeSize ?? 0)
    if (node && !node.isText && !['soft_break', hardBreak].includes(node.type.name)) unsupported()
    if (node?.type.name === hardBreak) marks = marks.filter(mark => {
      if (index + 1 === parent.childCount) return false
      const next = parent.child(index + 1)
      return mark.isInSet(next.marks) && (!next.isText || /\S/.test(next.text!))
    })
    const inner = marks.length ? marks[marks.length - 1] : null
    const noEsc = inner && getMark(inner).escape === false
    const len = marks.length - (noEsc ? 1 : 0)
    outer: for (let i = 0; i < len; i++) {
      const mark = marks[i]
      if (!getMark(mark).mixable) break
      for (let j = 0; j < active.length; j++) {
        const other = active[j]
        if (!getMark(other).mixable) break
        if (mark.eq(other)) {
          if (i > j) marks = marks.slice(0, j).concat(mark).concat(marks.slice(j, i)).concat(marks.slice(i + 1, len))
          else if (j > i) marks = marks.slice(0, i).concat(marks.slice(i + 1, j)).concat(mark).concat(marks.slice(j, len))
          continue outer
        }
      }
    }
    let keep = 0
    while (keep < Math.min(active.length, len) && marks[keep].eq(active[keep])) keep++
    const leading = trailing
    trailing = emptyPiece()
    if (node?.isText && marks.some(mark => getMark(mark).expelEnclosingWhitespace && !active.some((value, i) => i < keep && value.eq(mark)))) {
      const match = /^(\s*)(.*)$/m.exec(node.text!)!
      const lead = match[1], rest = match[2]
      // The upstream /m regexp can discard another line. Such a result has no
      // exact PM slice correspondence; ordinary serialization stays untouched.
      if (lead + rest !== node.text) unsupported()
      if (lead) {
        leading.text += lead
        leading.spans.push({ from, to: from + lead.length })
        from += lead.length
        node = rest ? node.cut(lead.length) : null
        if (!node) marks = active
      }
    }
    if (node?.isText && marks.some((mark, i) => getMark(mark).expelEnclosingWhitespace && !isMarkAhead(index + 1, marks.slice(0, i + 1)))) {
      const match = /^(.*?)(\s*)$/m.exec(node.text!)!
      const rest = match[1], trail = match[2]
      if (rest + trail !== node.text) unsupported()
      if (trail) {
        trailing = { text: trail, spans: [{ from: to - trail.length, to }] }
        to -= trail.length
        node = rest ? node.cut(0, rest.length) : null
        if (!node) marks = active
      }
    }
    if (node || index === parent.childCount) while (keep < active.length) state.text(state.markString(active.pop()!, false, parent, index), false)
    writeWhitespace(leading)
    if (node) {
      while (active.length < len) {
        const add = marks[active.length]
        active.push(add)
        state.text(state.markString(add, true, parent, index), false)
        runtime.atBlockStart = false
      }
      content([{ from, to }])
      if (noEsc && node.isText) state.text(state.markString(inner!, true, parent, index) + node.text + state.markString(inner!, false, parent, index + 1), false)
      else state.render(node, parent, index)
      runtime.atBlockStart = false
      if (node.isText && node.nodeSize > 0) runtime.atBlockStart = false
    }
  }
  parent.forEach(progress)
  progress(null, 0, parent.childCount)
  runtime.atBlockStart = false
}
