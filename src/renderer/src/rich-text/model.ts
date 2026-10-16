import { Fragment, type Mark, type Node } from 'prosemirror-model'
import { defaultMarkdownSerializer, MarkdownSerializer, type MarkdownSerializerState } from 'prosemirror-markdown'
import type { DocumentBlockDraft } from '@shared/contracts'
import { markdownEngine, parseMarkdownInline, type MarkdownEnvironment, type MarkdownNode, type MarkdownToken } from '@shared/markdownEngine'
import type { MarkdownInlineLinkProvenance, MarkdownInlineWithLinkProvenance } from '@shared/markdownLinkProvenance'
import { capturedMarkdownCompatibility } from '@shared/markdownSourceLinks'
import { parseInlineTextPresentationAttributes, INLINE_TEXT_COLOR_ATTRIBUTE, INLINE_BACKGROUND_COLOR_ATTRIBUTE, INLINE_TEXT_SHELL_ATTRIBUTE } from '@shared/inlineTextPresentation'
import { hasAdvancedMarkdown, parseMarkdownDocumentBlocks } from '@shared/markdownDocument'
import { getMarkdownListNumbers } from '@shared/markdown'
import { canBlockOwnChildren, isContainerBlockType } from '@shared/blockTypes'
import { createDraftBlockId } from '../utils/draftTreeFragment'
import { resolveDraftBlockRelationship } from '../utils/draftTreePlacement'
import { richTextSchema } from './schema'
import { validateDatabaseViewBlock } from '@shared/databaseViewBlock'
import { RICH_LINK_OCCURRENCE_ATTR, RichLinkTraceCollector, withRichLinkOccurrence, type RichInlineLinkSerialization } from './linkProvenance'
import { renderObservedRichInline } from './observedInlineWriter'

const textBlockTypes = new Set(['paragraph', 'quote', 'heading-1', 'heading-2', 'heading-3',
  'heading-4', 'heading-5', 'heading-6', 'callout', 'toggle', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list'])
const inlineMarks: Record<string, string> = { strong_open: 'strong', em_open: 'em', s_open: 'strike', mark_open: 'highlight' }
const htmlMarks: Record<string, string> = { strong: 'strong', em: 'em', s: 'strike', del: 'strike', mark: 'highlight', code: 'code' }

/** Supplied only by the cold synced editor adapter. Ordinary model calls do
 * not allocate provenance or import its whole-forest implementation. */
export interface RichProvenanceSeedPort {
  parseInline(index: number, block: DocumentBlockDraft, references?: MarkdownEnvironment['references']): MarkdownInlineWithLinkProvenance & { sourceOnly?: boolean }
  link(index: number, token: MarkdownToken, proof: MarkdownInlineLinkProvenance | undefined):
    { kind: 'tracked'; token: string } | { kind: 'external' } | { kind: 'source-only' }
  piece(index: number, token: string, from: number, to: number): void
}
type InlineSeed = { port: RichProvenanceSeedPort; index: number; provenance: MarkdownInlineWithLinkProvenance['provenance']; offset: number }

export function cloneRichTextBlock(block: DocumentBlockDraft): DocumentBlockDraft {
  return { ...block,
    ...(block.tags ? { tags: [...block.tags] } : {}),
    ...(block.markdownFormat ? { markdownFormat: { ...block.markdownFormat } } : {}) }
}

function defaultBlock(): DocumentBlockDraft {
  return { type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null }
}

export function richTextInlineFingerprint(node: Node): string {
  if (!node.content.content.some(child => child.marks.some(mark => mark.type.name === 'link'))) return JSON.stringify(node.content.toJSON() ?? [])
  // Token-only splits must not force untouched source through a serializer.
  // Fragment coalescing restores the ordinary adjacent-text representation.
  const children: Node[] = []
  node.forEach(child => children.push(child.mark(child.marks.map(mark => mark.type.name === 'link'
    ? withRichLinkOccurrence(mark, null) : mark))))
  return JSON.stringify(Fragment.fromArray(children).toJSON() ?? [], (_name, value: unknown) => {
    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'link' || !('attrs' in value)
      || !value.attrs || typeof value.attrs !== 'object') return value
    const { [RICH_LINK_OCCURRENCE_ATTR]: _runtimeOnly, ...attrs } = value.attrs as Record<string, unknown>
    return { ...value, attrs }
  })
}

function inlineContent(nodes: MarkdownNode[], marks: readonly Mark[] = [], seed?: InlineSeed): Node[] | null {
  const output: Node[] = []
  const push = (node: Node) => { output.push(node); if (seed) seed.offset += node.nodeSize }
  for (const { token, children } of nodes) {
    if (token.meta?.unsupportedHtml) return null
    if (token.type === 'text') {
      if (token.meta?.html && !marks.some(mark => mark.type === richTextSchema.marks.code)) {
        const lines = token.content.split('\n')
        lines.forEach((line, index) => {
          if (index) push(richTextSchema.nodes.soft_break.create(null, null, marks))
          if (line) push(richTextSchema.text(line, marks))
        })
      } else if (token.content) push(richTextSchema.text(token.content, marks))
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      push(richTextSchema.nodes[token.type === 'softbreak' ? 'soft_break' : 'hard_break'].create(null, null, marks))
    } else if (token.type === 'code_inline') {
      if (!token.content) return null
      push(richTextSchema.text(token.content, richTextSchema.marks.code.create().addToSet(marks)))
    } else if (inlineMarks[token.type] || token.type === 'link_open') {
      let mark = token.type === 'link_open'
        ? richTextSchema.marks.link.create({ href: token.attrGet('href') ?? '', title: token.attrGet('title') })
        : richTextSchema.marks[inlineMarks[token.type]].create()
      const decision = token.type === 'link_open' && seed ? seed.port.link(seed.index, token, seed.provenance.get(token)) : undefined
      if (decision?.kind === 'source-only') return null
      if (decision?.kind === 'tracked') mark = withRichLinkOccurrence(mark, decision.token)
      const from = seed?.offset ?? 0
      const inner = inlineContent(children, mark.addToSet(marks), seed)
      if (!inner) return null
      if (decision?.kind === 'tracked' && seed) {
        if (seed.offset === from) return null // A local destination with no PM content must remain an opaque source block.
        seed.port.piece(seed.index, decision.token, from, seed.offset)
      }
      output.push(...inner)
    } else if (token.type === 'html_element_open' && ['u', 'span', ...Object.keys(htmlMarks)].includes(token.tag)) {
      let nextMarks = marks
      if (htmlMarks[token.tag]) nextMarks = richTextSchema.marks[htmlMarks[token.tag]].create().addToSet(nextMarks)
      else {
        const presentation = parseInlineTextPresentationAttributes(token.tag, (token.attrs ?? []).map(([name, value]) => ({ name, value: String(value) })))
        if (!presentation) return null
        if (presentation.underline) nextMarks = richTextSchema.marks.underline.create().addToSet(nextMarks)
        if (presentation.textColor) nextMarks = richTextSchema.marks.textColor.create({ color: presentation.textColor }).addToSet(nextMarks)
        if (presentation.backgroundColor) nextMarks = richTextSchema.marks.backgroundColor.create({ color: presentation.backgroundColor }).addToSet(nextMarks)
      }
      const inner = inlineContent(children, nextMarks, seed)
      if (!inner) return null
      output.push(...inner)
    } else {
      // Unknown syntax is retained as one source block, never partially dropped.
      return null
    }
  }
  return output
}

function hasUnsupportedBlockSyntax(nodes: MarkdownNode[]): boolean {
  let inlineGroups = 0
  const visit = (items: MarkdownNode[]): boolean => items.some(node => {
    if (node.token.type === 'inline') inlineGroups++
    // Highlight is supported as a rich mark. Other advanced document syntax
    // (especially callout metadata) requires its original block renderer.
    const inlineHtml = node.token.meta?.html && (['text', 'hardbreak', 'link_open'].includes(node.token.type)
      || node.token.type === 'html_element_open' && ['u', 'span', ...Object.keys(htmlMarks)].includes(node.token.tag))
    if (node.token.type !== 'mark_open' && !inlineHtml && hasAdvancedMarkdown([{ ...node, children: [] }])) return true
    return visit(node.children)
  })
  return visit(nodes) || inlineGroups > 1
}

function blockToNode(block: DocumentBlockDraft, environment: MarkdownEnvironment, blockNodes: MarkdownNode[], listNumber?: number,
  seed?: { port: RichProvenanceSeedPort; index: number; references?: MarkdownEnvironment['references'] }): Node {
  const stored = cloneRichTextBlock(block)
  if (block.type === 'database-view') {
    validateDatabaseViewBlock(block)
    return richTextSchema.nodes.database_view_block.create({ block: stored })
  }
  // Definitions carry document-wide meaning and are not ordinary inline text.
  const hasDefinition = /(?:^|\n) {0,3}\[[^\]\n]+\]:[ \t]*/.test(block.content)
  const inlineEnvironment = { ...environment, captureSourceLinks: true, captureCompatibility: true }
  // The full block parser supplies diagnostic source maps; inline-only parsing
  // has no block offsets. Observation retains code and escape exclusions.
  if (block.content.includes('<')) markdownEngine.parse(block.content, inlineEnvironment)
  const canInline = textBlockTypes.has(block.type) && !hasDefinition && (isContainerBlockType(block.type) || !hasUnsupportedBlockSyntax(blockNodes))
  const traced = canInline && seed ? seed.port.parseInline(seed.index, block, seed.references) : null
  const inline = canInline ? traced?.nodes ?? parseMarkdownInline(block.content, environment) : null
  const content = inline && !traced?.sourceOnly && !capturedMarkdownCompatibility(inlineEnvironment).some(finding => ['unsupported-html', 'html-attributes'].includes(finding.reason))
    ? inlineContent(inline, [], traced && seed ? { port: seed.port, index: seed.index, provenance: traced.provenance, offset: 0 } : undefined) : null
  if (!content) return richTextSchema.nodes.source_block.create({ block: stored, listNumber })
  const node = richTextSchema.nodes.text_block.create({ block: stored, listNumber }, Fragment.fromArray(content))
  return node.type.create({ ...node.attrs, originalInline: richTextInlineFingerprint(node) }, node.content)
}

export function draftBlocksToRichDoc(blocks: DocumentBlockDraft[], references?: MarkdownEnvironment['references'], provenance?: RichProvenanceSeedPort): Node {
  const source = blocks.length ? blocks : [defaultBlock()]
  const model = parseMarkdownDocumentBlocks(source)
  if (references) model.environment.references = { ...references, ...model.environment.references }
  const numbers = getMarkdownListNumbers(source)
  const leaves = source.map((block, index) => blockToNode(block, model.environment, model.blockNodes[index], numbers[index],
    provenance ? { port: provenance, index, references } : undefined))
  const scope = (start: number, end: number): Node[] => {
    const children: Node[] = []
    for (let index = start; index < end;) {
      const block = source[index]
      if (block.type === 'column') throw new Error('A column requires its columns owner.')
      if (block.type !== 'columns') { children.push(leaves[index++]); continue }
      let boundary = index + 1
      while (boundary < end && source[boundary].depth > block.depth) boundary++
      const columns: Node[] = []
      for (let cursor = index + 1; cursor < boundary;) {
        const column = source[cursor]
        if (column.type !== 'column' || column.depth !== block.depth + 1) throw new Error('Invalid columns children.')
        let columnEnd = cursor + 1
        while (columnEnd < boundary && source[columnEnd].depth > column.depth) columnEnd++
        columns.push(richTextSchema.nodes.column_block.create({ block: cloneRichTextBlock(column) }, scope(cursor + 1, columnEnd)))
        cursor = columnEnd
      }
      children.push(richTextSchema.nodes.columns_block.createChecked({ block: cloneRichTextBlock(block) }, columns))
      index = boundary
    }
    return children
  }
  return reconcileRichTextBlockIds(richTextSchema.nodes.doc.create(null, scope(0, source.length)))
}

export type RichBlockEntry = { node: Node; pos: number; index: number }

/** DFS indices match persisted draft indices; positions include structural node boundaries. */
export function richBlockEntries(doc: Node): RichBlockEntry[] {
  const entries: RichBlockEntry[] = []
  doc.descendants((node, pos) => {
    if (!node.isBlock && node.type !== richTextSchema.nodes.column_block) return false
    entries.push({ node, pos, index: entries.length })
    return node.type === richTextSchema.nodes.columns_block || node.type === richTextSchema.nodes.column_block
  })
  return entries
}

export function richBlockEntryAt(doc: Node, position: number): RichBlockEntry | undefined {
  const entries = richBlockEntries(doc)
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (position >= entry.pos && position <= entry.pos + entry.node.nodeSize) return entry
  }
}

/** Preserve existing leaf nodes/marks when a draft operation changes only the flat forest. */
export function rebuildRichStructure(blocks: DocumentBlockDraft[], nodes: Map<string, Node>): Node {
  const doc = draftBlocksToRichDoc(blocks)
  const replace = (node: Node): Node => {
    const saved = nodes.get(node.attrs.block?.id)
    if (node.type === richTextSchema.nodes.text_block && saved?.type === node.type && saved.attrs.block?.content === node.attrs.block?.content) {
      return node.type.create({ ...saved.attrs, block: node.attrs.block }, saved.content, saved.marks)
    }
    if (!node.childCount || node.isTextblock) return node
    const children: Node[] = []
    node.forEach(child => children.push(replace(child)))
    return node.copy(Fragment.fromArray(children))
  }
  return replace(doc)
}

/** Repair IDs copied by a split/paste while retaining the first surviving ID.
 * Reparent descendants by their flat depth, so duplicating a list subtree cannot
 * leave its children attached to the original parent. Node positions do not move.
 */
export function reconcileRichTextBlockIds(doc: Node): Node {
  const ids = new Set<string>()
  const depthStack: Array<string | null> = []
  const depths = new Map<string, number>()
  const types = new Map<string, string>()
  const remappedIds = new Map<string, string>()
  let changed = false
  const entries = richBlockEntries(doc)
  const normalized = new Map<number, DocumentBlockDraft>()
  const layoutParents: Array<{ pos: number; end: number }> = []
  for (const { node, pos } of entries) {
    while (layoutParents.length && layoutParents.at(-1)!.end <= pos) layoutParents.pop()
    const original = node.attrs.block as DocumentBlockDraft | null
    const block = original ?? defaultBlock()
    // Existing identities are opaque. trim only decides whether an ID is blank;
    // changing its bytes would also break exact parent/reference identities.
    const requested = typeof block.id === 'string' && block.id.trim() ? block.id : undefined
    const id = requested && !ids.has(requested) ? requested : createDraftBlockId()
    ids.add(id)
    if (requested) remappedIds.set(requested, id)
    const layoutOwner = layoutParents.at(-1)
    const layoutBlock = layoutOwner && normalized.get(layoutOwner.pos)
    let requestedParent = block.parentBlockId ? remappedIds.get(block.parentBlockId) ?? block.parentBlockId : null
    let requestedDepth = block.depth
    if (layoutBlock && (node.type === richTextSchema.nodes.column_block || requestedDepth <= layoutBlock.depth
      || requestedParent !== layoutBlock.id && !depthStack.slice(layoutBlock.depth + 1).includes(requestedParent))) {
      requestedParent = layoutBlock.id ?? null
      requestedDepth = layoutBlock.depth + 1
    }
    const { depth, parentBlockId } = resolveDraftBlockRelationship(block.type, requestedDepth, requestedParent, id, depths, depthStack, types)
    depthStack.length = depth + 1
    // A prose/source block cannot become an implicit parent of a pasted list.
    depthStack[depth] = canBlockOwnChildren(block.type) ? id : null
    depths.set(id, depth)
    types.set(id, block.type)
    const adjusted = !original || id !== block.id || depth !== block.depth || (block.parentBlockId ?? null) !== parentBlockId
    if (adjusted) changed = true
    normalized.set(pos, adjusted ? { ...cloneRichTextBlock(block), id, depth, parentBlockId } : block)
    if (node.type === richTextSchema.nodes.columns_block || node.type === richTextSchema.nodes.column_block)
      layoutParents.push({ pos, end: pos + node.nodeSize })
  }
  const numbers = getMarkdownListNumbers(entries.map(({ pos }) => normalized.get(pos)!))
  const numbered = new Map<number, number | undefined>()
  entries.forEach(({ node, pos }, index) => {
    numbered.set(pos, numbers[index])
    if (normalized.get(pos)!.type.startsWith('numbered-') && node.attrs.listNumber !== numbers[index]) changed = true
  })
  if (!changed) return doc
  const rebuild = (node: Node, pos: number): Node => {
    const block = normalized.get(pos)
    if (!block) return node
    const children: Node[] = []
    node.forEach((child, offset) => children.push(normalized.has(pos + 1 + offset) ? rebuild(child, pos + 1 + offset) : child))
    return node.type.create({ ...node.attrs, block, ...(block.type.startsWith('numbered-') ? { listNumber: numbered.get(pos) } : {}) }, children, node.marks)
  }
  const children: Node[] = []
  doc.forEach((node, pos) => children.push(rebuild(node, pos)))
  return doc.copy(Fragment.fromArray(children))
}

function codeDelimiter(node: Node, close: boolean): string {
  const text = node.text ?? ''
  const ticks = '`'.repeat(Math.max(1, ...(text.match(/`+/g) ?? []).map(run => run.length + 1)))
  const padding = text.includes('`') || (/^ .* $/s.test(text) && Boolean(text.trim())) ? ' ' : ''
  return close ? padding + ticks : ticks + padding
}

const inlineSerializer = new MarkdownSerializer({
  text_block: (state, node) => { state.renderInline(node); state.closeBlock(node) },
  text: defaultMarkdownSerializer.nodes.text,
  soft_break: state => state.write('\n'),
  hard_break: state => state.write('\\\n')
}, {
  link: {
    ...defaultMarkdownSerializer.marks.link,
    close(state, mark, parent, index) {
      const close = defaultMarkdownSerializer.marks.link.close
      const value = typeof close === 'function' ? close(state, mark, parent, index) : close
      // Without an explicit empty destination the parser reads the quoted
      // title as the href. Preserve the upstream title's exact escaping.
      return mark.attrs.href === '' && mark.attrs.title ? value.slice(0, 2) + '<>' + value.slice(2) : value
    }
  },
  strong: defaultMarkdownSerializer.marks.strong,
  em: defaultMarkdownSerializer.marks.em,
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  highlight: { open: '==', close: '==', mixable: true, expelEnclosingWhitespace: true },
  code: {
    ...defaultMarkdownSerializer.marks.code,
    open: (_state, _mark, parent, index) => codeDelimiter(parent.child(index), false),
    close: (_state, _mark, parent, index) => codeDelimiter(parent.child(index - 1), true)
  }
}, { escapeExtraCharacters: /[$=|<>]/g })

/** UTF-16 source offsets let the source editor restore the selected rendered
 * text after canonical HTML changes its surrounding markup. */
function serializeRichTextInlineHtmlCore(node: Node, trace?: RichLinkTraceCollector): { content: string; startOffsets: number[]; endOffsets: number[] } {
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;')
    const attribute = (value: string) => escape(value).replace(/"/g, '&quot;')
    let content = `<span ${INLINE_TEXT_SHELL_ATTRIBUTE}="true">`
    const startOffsets: number[] = [], endOffsets: number[] = []
    node.forEach((child, offset) => {
      if (trace && !child.isText && !['soft_break', 'hard_break'].includes(child.type.name)) {
        throw new Error('富文本 HTML 实际发射分支无法证明 PM 来源范围，未生成来源声明。')
      }
      let closing = ''
      for (const mark of child.marks) {
        const name = mark.type.name
        let open: string, close: string
        if (name === 'link') {
          content += '<a href="'
          const raw = attribute(mark.attrs.href), from = content.length
          content += raw
          trace?.record(mark, from, raw, 'html', [{ from: offset, to: offset + child.nodeSize }])
          content += `"${mark.attrs.title === null ? '' : ` title="${attribute(mark.attrs.title)}"`}>`
          closing = '</a>' + closing
          continue
        }
        else if (name === 'textColor' || name === 'backgroundColor') { open = `<span ${name === 'textColor' ? INLINE_TEXT_COLOR_ATTRIBUTE : INLINE_BACKGROUND_COLOR_ATTRIBUTE}="${attribute(mark.attrs.color)}">`; close = '</span>' }
        else {
          const tag = name === 'strike' ? 'del' : name === 'highlight' ? 'mark' : name === 'underline' ? 'u' : name === 'em' ? 'em' : name === 'code' ? 'code' : 'strong'
          open = `<${tag}>`; close = `</${tag}>`
        }
        content += open; closing = close + closing
      }
      startOffsets[offset] = content.length
      endOffsets[offset] ??= content.length
      if (child.isText) {
        for (let index = 0; index < child.text!.length; index++) {
          content += escape(child.text![index])
          startOffsets[offset + index + 1] = endOffsets[offset + index + 1] = content.length
        }
      } else {
        content += child.type.name === 'soft_break' ? '&#10;' : '<br>'
        startOffsets[offset + child.nodeSize] = endOffsets[offset + child.nodeSize] = content.length
      }
      content += closing
    })
    if (!node.childCount) startOffsets[0] = endOffsets[0] = content.length
    return { content: content + '</span>', startOffsets, endOffsets }
}

export function serializeRichTextInlineHtml(node: Node): { content: string; startOffsets: number[]; endOffsets: number[] } {
  return serializeRichTextInlineHtmlCore(node)
}

export function serializeRichTextInlineHtmlWithLinkTrace(node: Node): RichInlineLinkSerialization & { startOffsets: number[]; endOffsets: number[] } {
  const trace = new RichLinkTraceCollector(node.content.size), result = serializeRichTextInlineHtmlCore(node, trace)
  return { ...result, linkDestinations: trace.finish(result.content) }
}

/** The installed PM serializer exposes its write buffer at runtime but omits it
 * from the public declaration. Read only at a real write boundary; never search
 * the final source. If that upstream invariant changes, tracing fails closed. */
function emittedMarkdownLength(state: MarkdownSerializerState): number {
  const output = (state as unknown as { out: unknown }).out
  if (typeof output !== 'string') throw new Error('富文本 Markdown serializer 不提供可核验的发射位置。')
  return output.length
}

function serializeRichTextInlineMarkdownWithLinkTrace(node: Node): RichInlineLinkSerialization {
  const trace = new RichLinkTraceCollector(node.content.size), original = inlineSerializer.marks.link
  let autolinkFrom: number | null = null
  let run: { mark: Mark; spans: Array<{ from: number; to: number }> } | null = null
  const serializer: MarkdownSerializer = new MarkdownSerializer({ ...inlineSerializer.nodes,
    text_block(state, parent) {
      renderObservedRichInline(state, parent, serializer.marks, spans => { if (run) run.spans.push(...spans) })
      state.closeBlock(parent)
    }
  }, { ...inlineSerializer.marks, link: {
    ...original,
    open(state, mark, parent, index) {
      const value = typeof original.open === 'function' ? original.open(state, mark, parent, index) : original.open
      // Use the same actual writer as the ordinary mark emitter, including its
      // preceding-! escape. Returning '' prevents a second emission by PM.
      state.text(value, false)
      if (run) throw new Error('富文本链接实际发射发生重叠，未生成来源声明。')
      run = { mark, spans: [] }
      autolinkFrom = value === '<' ? emittedMarkdownLength(state) : null
      return ''
    },
    close(state, mark, parent, index) {
      const value = typeof original.close === 'function' ? original.close(state, mark, parent, index) : original.close
      if (!run || !run.mark.eq(mark)) throw new Error('富文本链接实际发射边界不匹配，未生成来源声明。')
      if (autolinkFrom !== null) {
        trace.record(mark, autolinkFrom, mark.attrs.href as string, 'autolink', run.spans)
        autolinkFrom = null
        state.text(value, false)
      } else {
        const raw = (mark.attrs.href as string).replace(/[\(\)"]/g, '\\$&')
        const prefix = mark.attrs.href === '' && mark.attrs.title ? '](<' : ']('
        state.text(prefix, false)
        const from = emittedMarkdownLength(state)
        state.text(raw, false)
        trace.record(mark, from, raw, 'markdown', run.spans)
        // The title and closing punctuation come from the unchanged upstream
        // emitter. The split point is the href's construction length, not a match.
        state.text(value.slice(prefix.length + raw.length), false)
      }
      run = null
      return ''
    }
  } }, inlineSerializer.options)
  const content = serializer.serialize(richTextSchema.nodes.doc.create(null, node))
  if (run) throw new Error('富文本链接实际发射未正常闭合，未生成来源声明。')
  return { content, linkDestinations: trace.finish(content) }
}

export function serializeRichTextInlineWithLinkTrace(node: Node): RichInlineLinkSerialization {
  return node.content.content.some(child => child.marks.some(mark => ['underline', 'textColor', 'backgroundColor'].includes(mark.type.name)))
    ? serializeRichTextInlineHtmlWithLinkTrace(node) : serializeRichTextInlineMarkdownWithLinkTrace(node)
}

export function serializeRichTextInline(node: Node): string {
  if (node.content.content.some(child => child.marks.some(mark => ['underline', 'textColor', 'backgroundColor'].includes(mark.type.name)))) {
    // One literal HTML shell also protects unmarked Markdown punctuation and
    // paragraph-leading list/heading markers when only part of the text is colored.
    return serializeRichTextInlineHtml(node).content
  }
  return inlineSerializer.serialize(richTextSchema.nodes.doc.create(null, node))
}

export function richDocToDraftBlocks(document: Node): DocumentBlockDraft[] {
  const doc = reconcileRichTextBlockIds(document)
  const blocks: DocumentBlockDraft[] = []
  for (const { node } of richBlockEntries(doc)) {
    const block = cloneRichTextBlock(node.attrs.block as DocumentBlockDraft)
    if (node.type === richTextSchema.nodes.text_block && node.attrs.originalInline !== richTextInlineFingerprint(node)) {
      block.content = serializeRichTextInline(node)
    }
    blocks.push(block)
  }
  return blocks
}
