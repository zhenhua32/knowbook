import { Fragment, type Mark, type Node } from 'prosemirror-model'
import { defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown'
import type { DocumentBlockDraft } from '@shared/contracts'
import { parseMarkdownInline, type MarkdownEnvironment, type MarkdownNode } from '@shared/markdownEngine'
import { hasAdvancedMarkdown, parseMarkdownDocumentBlocks } from '@shared/markdownDocument'
import { getMarkdownListNumbers } from '@shared/markdown'
import { isNestableBlock } from '../utils/draftBlockShape'
import { createDraftBlockId } from '../utils/draftTreeFragment'
import { resolveDraftBlockRelationship } from '../utils/draftTreePlacement'
import { richTextSchema } from './schema'

const textBlockTypes = new Set(['paragraph', 'quote', 'heading-1', 'heading-2', 'heading-3',
  'heading-4', 'heading-5', 'heading-6', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list'])
const inlineMarks: Record<string, string> = { strong_open: 'strong', em_open: 'em', s_open: 'strike', mark_open: 'highlight' }

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
    if (token.type === 'text') {
      if (token.content) output.push(richTextSchema.text(token.content, marks))
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
    if (node.token.type !== 'mark_open' && hasAdvancedMarkdown([{ ...node, children: [] }])) return true
    return visit(node.children)
  })
  return visit(nodes) || inlineGroups > 1
}

function blockToNode(block: DocumentBlockDraft, environment: MarkdownEnvironment, blockNodes: MarkdownNode[], listNumber?: number): Node {
  const stored = cloneRichTextBlock(block)
  // Definitions carry document-wide meaning and are not ordinary inline text.
  const hasDefinition = /(?:^|\n) {0,3}\[[^\]\n]+\]:[ \t]*/.test(block.content)
  const content = textBlockTypes.has(block.type) && !hasDefinition && !hasUnsupportedBlockSyntax(blockNodes)
    ? inlineContent(parseMarkdownInline(block.content, environment)) : null
  if (!content) return richTextSchema.nodes.source_block.create({ block: stored, listNumber })
  const node = richTextSchema.nodes.text_block.create({ block: stored, listNumber }, Fragment.fromArray(content))
  return node.type.create({ ...node.attrs, originalInline: richTextInlineFingerprint(node) }, node.content)
}

export function draftBlocksToRichDoc(blocks: DocumentBlockDraft[]): Node {
  const source = blocks.length ? blocks : [defaultBlock()]
  const model = parseMarkdownDocumentBlocks(source)
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
    const { depth, parentBlockId } = resolveDraftBlockRelationship(block.type, block.depth, requestedParent, id, depths, depthStack)
    depthStack.length = depth + 1
    // A prose/source block cannot become an implicit parent of a pasted list.
    depthStack[depth] = isNestableBlock(block.type) ? id : null
    if (isNestableBlock(block.type)) depths.set(id, depth)
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

export function serializeRichTextInline(node: Node): string {
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
