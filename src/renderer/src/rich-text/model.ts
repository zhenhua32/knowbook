import { Fragment, type Mark, type Node } from 'prosemirror-model'
import { defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown'
import type { DocumentBlockDraft } from '@shared/contracts'
import { markdownEngine, parseMarkdownInline, type MarkdownEnvironment, type MarkdownNode } from '@shared/markdownEngine'
import { capturedMarkdownCompatibility } from '@shared/markdownSourceLinks'
import { parseInlineTextPresentationAttributes, INLINE_TEXT_COLOR_ATTRIBUTE, INLINE_BACKGROUND_COLOR_ATTRIBUTE, INLINE_TEXT_SHELL_ATTRIBUTE } from '@shared/inlineTextPresentation'
import { hasAdvancedMarkdown, parseMarkdownDocumentBlocks } from '@shared/markdownDocument'
import { getMarkdownListNumbers } from '@shared/markdown'
import { canBlockOwnChildren, isContainerBlockType } from '@shared/blockTypes'
import { createDraftBlockId } from '../utils/draftTreeFragment'
import { resolveDraftBlockRelationship } from '../utils/draftTreePlacement'
import { richTextSchema } from './schema'

const textBlockTypes = new Set(['paragraph', 'quote', 'heading-1', 'heading-2', 'heading-3',
  'heading-4', 'heading-5', 'heading-6', 'callout', 'toggle', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list'])
const inlineMarks: Record<string, string> = { strong_open: 'strong', em_open: 'em', s_open: 'strike', mark_open: 'highlight' }
const htmlMarks: Record<string, string> = { strong: 'strong', em: 'em', s: 'strike', del: 'strike', mark: 'highlight', code: 'code' }

export function cloneRichTextBlock(block: DocumentBlockDraft): DocumentBlockDraft {
  return { ...block,
    ...(block.tags ? { tags: [...block.tags] } : {}),
    ...(block.markdownFormat ? { markdownFormat: { ...block.markdownFormat } } : {}) }
}

function defaultBlock(): DocumentBlockDraft {
  return { type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null }
}

export function richTextInlineFingerprint(node: Node): string {
  return JSON.stringify(node.content.toJSON() ?? [])
}

function inlineContent(nodes: MarkdownNode[], marks: readonly Mark[] = []): Node[] | null {
  const output: Node[] = []
  for (const { token, children } of nodes) {
    if (token.meta?.unsupportedHtml) return null
    if (token.type === 'text') {
      if (token.meta?.html && !marks.some(mark => mark.type === richTextSchema.marks.code)) {
        const lines = token.content.split('\n')
        lines.forEach((line, index) => {
          if (index) output.push(richTextSchema.nodes.soft_break.create(null, null, marks))
          if (line) output.push(richTextSchema.text(line, marks))
        })
      } else if (token.content) output.push(richTextSchema.text(token.content, marks))
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      output.push(richTextSchema.nodes[token.type === 'softbreak' ? 'soft_break' : 'hard_break'].create(null, null, marks))
    } else if (token.type === 'code_inline') {
      if (!token.content) return null
      output.push(richTextSchema.text(token.content, richTextSchema.marks.code.create().addToSet(marks)))
    } else if (inlineMarks[token.type] || token.type === 'link_open') {
      const mark = token.type === 'link_open'
        ? richTextSchema.marks.link.create({ href: token.attrGet('href') ?? '', title: token.attrGet('title') })
        : richTextSchema.marks[inlineMarks[token.type]].create()
      const inner = inlineContent(children, mark.addToSet(marks))
      if (!inner) return null
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
      const inner = inlineContent(children, nextMarks)
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

function blockToNode(block: DocumentBlockDraft, environment: MarkdownEnvironment, blockNodes: MarkdownNode[], listNumber?: number): Node {
  const stored = cloneRichTextBlock(block)
  // Definitions carry document-wide meaning and are not ordinary inline text.
  const hasDefinition = /(?:^|\n) {0,3}\[[^\]\n]+\]:[ \t]*/.test(block.content)
  const inlineEnvironment = { ...environment, captureSourceLinks: true, captureCompatibility: true }
  // The full block parser supplies diagnostic source maps; inline-only parsing
  // has no block offsets. Observation retains code and escape exclusions.
  if (block.content.includes('<')) markdownEngine.parse(block.content, inlineEnvironment)
  const inline = textBlockTypes.has(block.type) && !hasDefinition && (isContainerBlockType(block.type) || !hasUnsupportedBlockSyntax(blockNodes))
    ? parseMarkdownInline(block.content, environment) : null
  const content = inline && !capturedMarkdownCompatibility(inlineEnvironment).some(finding => ['unsupported-html', 'html-attributes'].includes(finding.reason))
    ? inlineContent(inline) : null
  if (!content) return richTextSchema.nodes.source_block.create({ block: stored, listNumber })
  const node = richTextSchema.nodes.text_block.create({ block: stored, listNumber }, Fragment.fromArray(content))
  return node.type.create({ ...node.attrs, originalInline: richTextInlineFingerprint(node) }, node.content)
}

export function draftBlocksToRichDoc(blocks: DocumentBlockDraft[], references?: MarkdownEnvironment['references']): Node {
  const source = blocks.length ? blocks : [defaultBlock()]
  const model = parseMarkdownDocumentBlocks(source)
  if (references) model.environment.references = { ...references, ...model.environment.references }
  const numbers = getMarkdownListNumbers(source)
  return reconcileRichTextBlockIds(richTextSchema.nodes.doc.create(null, source.map((block, index) => blockToNode(block, model.environment, model.blockNodes[index], numbers[index]))))
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
  const children: Node[] = []
  doc.forEach(node => {
    const original = node.attrs.block as DocumentBlockDraft | null
    const block = original ?? defaultBlock()
    const requested = block.id?.trim()
    const id = requested && !ids.has(requested) ? requested : createDraftBlockId()
    ids.add(id)
    if (requested) remappedIds.set(requested, id)
    const requestedParent = block.parentBlockId ? remappedIds.get(block.parentBlockId) ?? block.parentBlockId : null
    const { depth, parentBlockId } = resolveDraftBlockRelationship(block.type, block.depth, requestedParent, id, depths, depthStack, types)
    depthStack.length = depth + 1
    // A prose/source block cannot become an implicit parent of a pasted list.
    depthStack[depth] = canBlockOwnChildren(block.type) ? id : null
    depths.set(id, depth)
    types.set(id, block.type)
    if (!original || id !== block.id || depth !== block.depth || (block.parentBlockId ?? null) !== parentBlockId) {
      changed = true
      children.push(node.type.create({ ...node.attrs, block: { ...cloneRichTextBlock(block), id, depth, parentBlockId } }, node.content, node.marks))
    } else {
      children.push(node)
    }
  })
  const numbers = getMarkdownListNumbers(children.map(node => node.attrs.block as DocumentBlockDraft))
  children.forEach((node, index) => {
    const block = node.attrs.block as DocumentBlockDraft
    if (block.type.startsWith('numbered-') && node.attrs.listNumber !== numbers[index]) {
      changed = true
      children[index] = node.type.create({ ...node.attrs, listNumber: numbers[index] }, node.content, node.marks)
    }
  })
  return changed ? doc.copy(Fragment.fromArray(children)) : doc
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
  link: defaultMarkdownSerializer.marks.link,
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
export function serializeRichTextInlineHtml(node: Node): { content: string; startOffsets: number[]; endOffsets: number[] } {
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;')
    const attribute = (value: string) => escape(value).replace(/"/g, '&quot;')
    let content = `<span ${INLINE_TEXT_SHELL_ATTRIBUTE}="true">`
    const startOffsets: number[] = [], endOffsets: number[] = []
    node.forEach((child, offset) => {
      let opening = '', closing = ''
      for (const mark of child.marks) {
        const name = mark.type.name
        let open: string, close: string
        if (name === 'link') { open = `<a href="${attribute(mark.attrs.href)}"${mark.attrs.title === null ? '' : ` title="${attribute(mark.attrs.title)}"`}>`; close = '</a>' }
        else if (name === 'textColor' || name === 'backgroundColor') { open = `<span ${name === 'textColor' ? INLINE_TEXT_COLOR_ATTRIBUTE : INLINE_BACKGROUND_COLOR_ATTRIBUTE}="${attribute(mark.attrs.color)}">`; close = '</span>' }
        else {
          const tag = name === 'strike' ? 'del' : name === 'highlight' ? 'mark' : name === 'underline' ? 'u' : name === 'em' ? 'em' : name === 'code' ? 'code' : 'strong'
          open = `<${tag}>`; close = `</${tag}>`
        }
        opening += open; closing = close + closing
      }
      content += opening
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
  doc.forEach(node => {
    const block = cloneRichTextBlock(node.attrs.block as DocumentBlockDraft)
    if (node.type === richTextSchema.nodes.text_block && node.attrs.originalInline !== richTextInlineFingerprint(node)) {
      block.content = serializeRichTextInline(node)
    }
    blocks.push(block)
  })
  return blocks
}
