import type MarkdownIt from 'markdown-it'
import type { Delimiter, StateInline } from 'markdown-it'
import { markdownInlineText } from './markdownHeadingText'
import { sliceMarkdownSourceMap } from './markdownSourceLinks'

export function parseTaskListMarker(content: string): { length: number; checked: boolean } | null {
  const match = content.match(/^[ \t]*\[([ xX\t\n\f\v])\](?:[ \t\n\f\v]+|$)/)
  return match ? { length: match[0].length, checked: /x/i.test(match[1]) } : null
}

/** GFM extensions shared by HTML output, React previews and block import. */
export function installMarkdownExtensions(md: InstanceType<typeof MarkdownIt>): void {
  md.core.ruler.before('inline', 'tasklist_prepare', (state) => {
    const lines = state.src.split('\n')
    const offsets: number[] = []
    let offset = 0
    for (const line of lines) { offsets.push(offset); offset += line.length + 1 }
    for (let index = 2; index < state.tokens.length; index++) {
      const inline = state.tokens[index]
      if (inline.type !== 'inline' || state.tokens[index - 1].type !== 'paragraph_open'
        || state.tokens[index - 2].type !== 'list_item_open') continue
      // Inspect source before escape/entity decoding: \[x] and &#91;x]
      // are ordinary text, and code/links must never become task markers.
      const task = parseTaskListMarker(inline.content)
      if (!task) continue
      state.tokens[index - 2].meta = { ...state.tokens[index - 2].meta, task: true }
      const marker = inline.content.slice(0, task.length).trimStart().match(/^\[[ xX\t\n\f\v]\]/)?.[0]
      const line = inline.map?.[0]
      const column = line === undefined || !marker ? -1 : lines[line].indexOf(marker)
      inline.meta = { ...inline.meta, task, taskSource: inline.content,
        taskOffset: line !== undefined && column >= 0 ? offsets[line] + column + 1 : undefined }
      sliceMarkdownSourceMap(inline, task.length)
      inline.content = inline.content.slice(task.length)
    }
  })
  md.core.ruler.after('inline', 'tasklist', (state) => {
    for (const inline of state.tokens) {
      const task = inline.meta?.task as ReturnType<typeof parseTaskListMarker>
      if (inline.type !== 'inline' || !task || typeof inline.meta?.taskSource !== 'string') continue
      inline.content = inline.meta.taskSource
      const checkbox = new state.Token('task_checkbox', 'input', 0)
      checkbox.meta = { checked: task.checked, sourceOffset: inline.meta.taskOffset,
        label: markdownInlineText(inline.children ?? []).trim().split('\n')[0] }
      inline.children?.unshift(checkbox)
    }
  })
  md.renderer.rules.task_checkbox = (tokens, index) => `<input type="checkbox" disabled=""${tokens[index].meta?.checked ? ' checked=""' : ''}> `

  // GFM permits matching single or double tildes, but not runs of three or
  // more. Use the parser's delimiter balancer to preserve nesting and escapes.
  md.inline.ruler.at('strikethrough', (state, silent) => {
    if (silent || state.src.charCodeAt(state.pos) !== 126) return false
    const scanned = state.scanDelims(state.pos, true)
    const token = state.push('text', '', 0)
    token.content = '~'.repeat(scanned.length)
    if (scanned.length <= 2) state.delimiters.push({
      marker: scanned.length === 1 ? 126 : -126, length: 0,
      token: state.tokens.length - 1, end: -1,
      open: scanned.can_open, close: scanned.can_close
    })
    state.pos += scanned.length
    return true
  })
  const convert = (state: StateInline, delimiters: Delimiter[]) => {
    for (const delimiter of delimiters) {
      if (Math.abs(delimiter.marker) !== 126 || delimiter.end < 0) continue
      const opener = state.tokens[delimiter.token]
      const closer = state.tokens[delimiters[delimiter.end].token]
      for (const [token, nesting] of [[opener, 1], [closer, -1]] as const) {
        token.type = nesting === 1 ? 's_open' : 's_close'
        token.tag = 'del'
        token.nesting = nesting
        token.markup = token.content
        token.content = ''
      }
    }
  }
  md.inline.ruler2.at('strikethrough', (state) => {
    convert(state, state.delimiters)
    for (const meta of state.tokens_meta) if (meta?.delimiters) convert(state, meta.delimiters)
  })
}
