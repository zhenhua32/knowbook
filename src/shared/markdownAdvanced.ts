import type MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import footnote from 'markdown-it-footnote'
import mark from 'markdown-it-mark'
import { markdownHeadingSlug, markdownInlineText } from './markdownHeadingText'

export type MarkdownCallout = { kind: string; title: string; folded: boolean | null; titleToken: Token }
export type MarkdownHeading = { slug: string; text: string; level: number; line: number }
type FootnoteData = { depth?: number; refs?: Record<string, number>; list?: Array<{ label?: string; count?: number; content?: string; tokens?: Token[] }> }

const escaped = (source: string, position: number) => {
  let slashes = 0
  while (position > 0 && source[--position] === '\\') slashes++
  return slashes % 2 === 1
}

export function findMarkdownInlineMath(source: string, start: number, limit = source.length): { contentStart: number; contentEnd: number; end: number; markup: string } | null {
  const dollar = source[start] === '$' && source[start + 1] !== '$' && source[start - 1] !== '$'
  const bracket = source.startsWith('\\(', start)
  if (!dollar && !bracket) return null
  const opening = dollar ? '$' : '\\(', closing = dollar ? '$' : '\\)'
  const contentStart = start + opening.length
  if (dollar && /\s/.test(source[contentStart] ?? '')) return null
  let end = source.indexOf(closing, contentStart)
  while (end >= 0 && end < limit) {
    if (!escaped(source, end) && (!dollar || (source[end + 1] !== '$' && source[end - 1] !== '$'
      && !/\s/.test(source[end - 1]) && !/\d/.test(source[end + 1] ?? '')))) break
    end = source.indexOf(closing, end + closing.length)
  }
  return end <= contentStart || end >= limit ? null : { contentStart, contentEnd: end, end: end + closing.length, markup: opening }
}

/** Extensions are parsed once for the complete document, before UI block slicing. */
export function installMarkdownAdvanced(md: InstanceType<typeof MarkdownIt>): void {
  md.core.ruler.before('normalize', 'document_environment', (state) => { state.env ??= {} })
  md.use(footnote).use(mark)

  // Reserve the outer note before parsing its body. The upstream inline rule
  // otherwise reuses its id for a nested note and silently loses that body.
  md.inline.ruler.at('footnote_inline', (state, silent) => {
    const start = state.pos
    if (!state.src.startsWith('^[', start)) return false
    const data = (state.env.footnotes ??= {}) as FootnoteData
    if ((data.depth ?? 0) >= md.options.maxNesting) return false
    const end = md.helpers.parseLinkLabel(state, start + 1, false)
    if (end < 0) return false
    if (!silent) {
      const list = data.list ??= []
      const note = { content: state.src.slice(start + 2, end), tokens: [] as Token[] }
      const id = list.push(note) - 1
      data.depth = (data.depth ?? 0) + 1
      try { md.inline.parse(note.content, md, state.env, note.tokens) }
      finally { data.depth-- }
      const token = state.push('footnote_ref', '', 0)
      token.meta = { id, subId: 0 }
    }
    state.pos = end + 1
    return true
  })
  md.inline.ruler.at('footnote_ref', (state, silent) => {
    const match = state.src.slice(state.pos, state.posMax).match(/^\[\^([^\]\s]+)\]/)
    if (!match) return false
    const data = state.env.footnotes as FootnoteData | undefined
    const label = match[1]
    if (!silent) {
      if (!data?.refs || data.refs[`:${label}`] === undefined) {
        const token = state.push('footnote_missing', '', 0)
        token.content = match[0]
        token.meta = { label }
      } else {
        const list = data.list ??= []
        let id = data.refs[`:${label}`]
        if (id < 0) { id = list.push({ label, count: 0 }) - 1; data.refs[`:${label}`] = id }
        const note = list[id]
        const subId = note.count ?? 0
        note.count = subId + 1
        const token = state.push('footnote_ref', '', 0)
        token.meta = { id, subId, label }
      }
    }
    state.pos += match[0].length
    return true
  })
  md.renderer.rules.footnote_caption = (tokens, index) => `[${Number(tokens[index].meta?.id) + 1}]`
  md.renderer.rules.footnote_missing = (tokens, index) => `<span class="markdown-footnote-missing" title="Undefined footnote: ${md.utils.escapeHtml(String(tokens[index].meta?.label))}">${md.utils.escapeHtml(tokens[index].content)}</span>`

  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const match = findMarkdownInlineMath(state.src, state.pos, state.posMax)
    if (!match) return false
    if (!silent) {
      const token = state.push('math_inline', 'math', 0)
      token.content = state.src.slice(match.contentStart, match.contentEnd)
      token.markup = match.markup
    }
    state.pos = match.end
    return true
  })
  md.renderer.rules.math_inline = (tokens, index) => `<span class="markdown-math-inline">${md.utils.escapeHtml(tokens[index].content)}</span>`

  md.block.ruler.before('fence', 'math_block', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false
    const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start])
    const opening = first.startsWith('$$') && first[2] !== '$' ? '$$' : first.startsWith('\\[') ? '\\[' : null
    if (!opening) return false
    const closing = opening === '$$' ? '$$' : '\\]'
    const initial = first.slice(opening.length)
    const closes = (line: string) => {
      const trimmed = line.trimEnd()
      const at = trimmed.length - closing.length
      return at >= 0 && trimmed.endsWith(closing) && !escaped(trimmed, at)
        && (opening !== '$$' || trimmed[at - 1] !== '$')
    }
    let last = start
    let content: string
    if (closes(initial)) content = initial.trimEnd().slice(0, -closing.length)
    else {
      last = start + 1
      while (last < end && !closes(state.src.slice(state.bMarks[last] + state.tShift[last], state.eMarks[last]))) last++
      if (last >= end) return false
      const middle = state.getLines(start + 1, last, state.blkIndent, false)
      const final = state.src.slice(state.bMarks[last] + state.tShift[last], state.eMarks[last]).trimEnd().slice(0, -closing.length)
      content = [initial || null, middle || null, final || null].filter((line) => line !== null).join('\n')
    }
    if (silent) return true
    const token = state.push('math_block', 'math', 0)
    token.content = content
    token.markup = opening
    token.map = [start, last + 1]
    state.line = last + 1
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.renderer.rules.math_block = (tokens, index) => `<pre>${md.utils.escapeHtml(tokens[index].content)}</pre>\n`

  md.block.ruler.before('paragraph', 'table_of_contents', (state, start, _end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false
    const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start])
    if (!/^\[toc\][ \t]*$/i.test(line)) return false
    if (silent) return true
    const token = state.push('table_of_contents', 'nav', 0)
    token.content = line
    token.map = [start, start + 1]
    state.line = start + 1
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })

  // Give titles their own inline token before the inline pass. Re-parsing them
  // afterwards would count footnotes twice and change document-wide numbering.
  md.core.ruler.after('block', 'callout_prepare', (state) => {
    const stack: Array<MarkdownCallout | undefined> = []
    for (let index = 0; index < state.tokens.length; index++) {
      const token = state.tokens[index]
      if (token.type === 'blockquote_close') {
        const callout = stack.pop()
        if (callout) token.meta = { ...token.meta, callout }
        continue
      }
      if (token.type !== 'blockquote_open') continue
      const paragraph = state.tokens[index + 1]
      const inline = state.tokens[index + 2]
      const header = paragraph?.type === 'paragraph_open' && inline?.type === 'inline'
        ? inline.content.match(/^\[!([\w-]+)\]([+-])?(?:[ \t]+([^\n]*))?(?:\n|$)/) : null
      if (!header) { stack.push(undefined); continue }
      const kind = header[1].toLowerCase()
      const title = header[3]?.trim() || kind[0].toUpperCase() + kind.slice(1)
      const titleToken = new state.Token('inline', '', 0)
      titleToken.content = title
      titleToken.children = []
      titleToken.meta = { calloutTitle: true }
      const callout: MarkdownCallout = { kind, title, folded: header[2] ? header[2] === '-' : null, titleToken }
      token.meta = { ...token.meta, callout }
      stack.push(callout)
      inline.content = inline.content.slice(header[0].length)
      if (!inline.content) {
        paragraph.hidden = true
        state.tokens[index + 3].hidden = true
      }
      state.tokens.splice(index + 1, 0, titleToken)
      index++
    }
  })
  md.core.ruler.after('inline', 'callout_titles', (state) => {
    for (const token of state.tokens) if (token.meta?.calloutTitle) token.type = 'callout_title'
  })
  md.renderer.rules.callout_title = () => ''
  md.renderer.rules.blockquote_open = (tokens, index, options, env, renderer) => {
    const callout = tokens[index].meta?.callout as MarkdownCallout | undefined
    if (!callout) return renderer.renderToken(tokens, index, options)
    const title = renderer.renderInline(callout.titleToken.children ?? [], options, env)
    const attrs = `class="markdown-callout" data-callout="${md.utils.escapeHtml(callout.kind)}"`
    return callout.folded === null ? `<aside ${attrs}><div class="markdown-callout-title">${title}</div>\n`
      : `<details ${attrs}${callout.folded ? '' : ' open=""'}><summary>${title}</summary>\n`
  }
  md.renderer.rules.blockquote_close = (tokens, index, options, _env, renderer) => {
    const callout = tokens[index].meta?.callout as MarkdownCallout | undefined
    return callout ? callout.folded === null ? '</aside>\n' : '</details>\n' : renderer.renderToken(tokens, index, options)
  }

  md.core.ruler.before('footnote_tail', 'footnote_source', (state) => {
    if (!state.env.captureFootnoteSource) return
    let inDefinition = false
    const source: Token[] = []
    for (const token of state.tokens) {
      if (token.type === 'footnote_reference_open') inDefinition = true
      else if (token.type === 'footnote_reference_close') inDefinition = false
      else if (inDefinition) source.push(token)
    }
    // An unreferenced definition may contain an inline note of its own. These
    // assets still belong to the source, even though neither note is displayed.
    for (const note of (state.env.footnotes as FootnoteData | undefined)?.list ?? []) {
      for (const token of note.tokens ?? []) source.push(token)
    }
    state.env.footnoteSourceTokens = source
  })

  // Definitions can precede the body or refer to other definitions. Assign IDs
  // from visible references and reachable note bodies, never from unused source
  // definitions. Rebuild backrefs in the order the reader actually encounters.
  md.core.ruler.after('footnote_tail', 'footnote_order', (state) => {
    const start = state.tokens.findIndex((token) => token.type === 'footnote_block_open')
    if (start < 0) return
    const sections = new Map<number, Token[]>()
    let section: Token[] | undefined
    for (const token of state.tokens.slice(start + 1)) {
      if (token.type === 'footnote_open') { section = []; sections.set(Number(token.meta?.id), section) }
      if (token.type !== 'footnote_anchor') section?.push(token)
      if (token.type === 'footnote_close') section = undefined
    }
    const body = state.tokens.slice(0, start)
    const ids = new Map<number, number>()
    const order: number[] = []
    const pending = body.slice().reverse()
    while (pending.length) {
      const token = pending.pop()!
      if (token.type === 'footnote_ref') {
        const id = Number(token.meta?.id)
        if (!ids.has(id) && sections.has(id)) {
          ids.set(id, order.length)
          order.push(id)
          const nested = sections.get(id)!
          for (let index = nested.length - 1; index >= 0; index--) pending.push(nested[index])
        }
      }
      if (token.children) for (let index = token.children.length - 1; index >= 0; index--) pending.push(token.children[index])
    }
    const counts = new Map<number, number>()
    const remap = (tokens: Token[]) => {
      for (const token of tokens) {
        if (token.type === 'footnote_ref' || token.type === 'footnote_open') {
          const id = ids.get(Number(token.meta?.id))!
          token.meta = { ...token.meta, id }
          if (token.type === 'footnote_ref') {
            token.meta.subId = counts.get(id) ?? 0
            counts.set(id, Number(token.meta.subId) + 1)
          }
        }
        if (token.children) remap(token.children)
      }
    }
    remap(body)
    const ordered = order.map((id) => sections.get(id)!)
    ordered.forEach(remap)
    ordered.forEach((tokens, id) => {
      const position = tokens.length - (tokens.at(-2)?.type === 'paragraph_close' ? 2 : 1)
      const anchors = Array.from({ length: counts.get(id) ?? 1 }, (_, subId) => {
        const token = new state.Token('footnote_anchor', '', 0)
        token.meta = { ...tokens[0].meta, subId }
        return token
      })
      tokens.splice(position, 0, ...anchors)
    })
    const data = state.env.footnotes as FootnoteData
    if (data.list) data.list = order.map((oldId, id) => ({ ...data.list![oldId], count: counts.get(id) }))
    if (data.refs) for (const label of Object.keys(data.refs)) data.refs[label] = ids.get(data.refs[label]) ?? -1
    state.tokens = order.length ? [...body, state.tokens[start], ...ordered.flat(), state.tokens.at(-1)!] : body
  })

  md.core.ruler.after('footnote_order', 'document_headings', (state) => {
    const used = new Set<string>()
    if (typeof state.env.documentTitle === 'string') markdownHeadingSlug(markdownInlineText(md.parseInline(state.env.documentTitle, { references: state.env.references })[0]?.children ?? []), used)
    const headings: MarkdownHeading[] = []
    const hasToc = state.tokens.some((token) => token.type === 'table_of_contents')
    for (let index = 0; index < state.tokens.length; index++) {
      const token = state.tokens[index]
      if (token.type === 'footnote_block_open') break
      if (token.type !== 'heading_open') continue
      const text = markdownInlineText(state.tokens[index + 1].children ?? [])
      const heading = { slug: markdownHeadingSlug(text, used), text, level: Number(token.tag.slice(1)), line: token.map?.[0] ?? 0 }
      headings.push(heading)
      token.meta = { ...token.meta, heading }
      if (hasToc) token.attrSet('id', heading.slug)
    }
    state.env.documentHeadings = headings
  })
  md.renderer.rules.table_of_contents = (_tokens, _index, _options, env) => {
    const headings = (env?.documentHeadings ?? []) as MarkdownHeading[]
    return '<nav class="markdown-toc" aria-label="Table of contents"><ul>' + headings.map((heading) =>
      `<li data-level="${heading.level}"><a href="#${md.utils.escapeHtml(heading.slug)}">${md.utils.escapeHtml(heading.text)}</a></li>`
    ).join('') + '</ul></nav>\n'
  }
}
