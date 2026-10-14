import { Schema, type DOMOutputSpec, type Node } from 'prosemirror-model'
import type { DocumentBlockDraft } from '@shared/contracts'
import { getHeadingLevel, markdownEngine } from '@shared/markdownEngine'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { parseMarkdownDocumentBlocks } from '@shared/markdownDocument'
import type { MarkdownNode } from '@shared/markdownEngine'
import { INLINE_TEXT_COLOR_ATTRIBUTE, INLINE_BACKGROUND_COLOR_ATTRIBUTE, parseInlineTextPresentationAttributes } from '@shared/inlineTextPresentation'
import type { MarkSpec } from 'prosemirror-model'
import { isContainerBlockType } from '@shared/blockTypes'
import { nativeContainerPresentation } from '../utils/nativeContainerPresentation'

function presentationMark(name: 'textColor' | 'backgroundColor', attribute: string): MarkSpec {
  return {
    attrs: { color: {} },
    parseDOM: ['span', 'u'].map(tag => ({ tag: `${tag}[${attribute}]`, consuming: false, getAttrs: (element: HTMLElement) => {
      const presentation = parseInlineTextPresentationAttributes(element.tagName.toLowerCase(), Array.from(element.attributes))
      return presentation?.[name] ? { color: presentation[name] } : false
    } })),
    toDOM: mark => ['span', { [attribute]: mark.attrs.color }, 0]
  }
}

function blockAttributes(node: Node): Record<string, string> {
  const block = node.attrs.block as DocumentBlockDraft | null
  const native = block && isContainerBlockType(block.type) ? nativeContainerPresentation(block.type, block.markdownFormat) : null
  return {
    class: `block-editor-row rich-text-block type-${block?.type ?? 'paragraph'}`,
    'data-block-id': block?.id ?? '',
    'data-block-type': block?.type ?? 'paragraph',
    'data-block-depth': String(block?.depth ?? 0),
    'data-block-checked': String(Boolean(block?.checked)),
    ...(native ? { 'data-native-container': block!.type, ...(block!.type === 'callout' ? { 'data-native-container-tone': native.tone } : {}) } : {}),
    ...(block?.type.startsWith('numbered-') ? { 'data-list-number': String(node.attrs.listNumber ?? block.listStart ?? 1) } : {}),
    style: `padding-left: ${(block?.depth ?? 0) * 24}px`
  }
}

function textBlockDom(node: Node): DOMOutputSpec {
  const block = node.attrs.block as DocumentBlockDraft | null
  const heading = getHeadingLevel(block?.type ?? '')
  return [heading ? `h${heading}` : block?.type === 'quote' ? 'blockquote' : 'div', blockAttributes(node), 0]
}

function importedBlock(type: string): Record<string, unknown> {
  // Clipboard DOM can provide display structure, never an existing block ID or
  // private metadata. Each parse invocation creates its own draft object.
  return { block: { type, content: '', checked: false, depth: 0, parentBlockId: null }, originalInline: null }
}

export function richTextSourceMarkdown(node: Node): string {
  const block = node.attrs.block as DocumentBlockDraft | null
  return block ? serializeBlocksToMarkdown([block]) : ''
}

function requiresLiteralClipboard(block: DocumentBlockDraft): boolean {
  if (['math', 'frontmatter'].includes(block.type) || /(?:^|\n) {0,3}\[[^\]\n]+\]:/.test(block.content) || block.content.includes('<!--')) return true
  const unsupported = new Set(['math_inline', 'math_block', 'footnote_ref', 'footnote_missing', 'footnote_block_open',
    'table_of_contents', 'wiki_link', 'html_details_open', 'html_element_open'])
  const visit = (nodes: MarkdownNode[]): boolean => nodes.some(({ token, children }) =>
    unsupported.has(token.type) || Boolean(token.meta?.callout || token.meta?.wiki) || visit(children))
  return visit(parseMarkdownDocumentBlocks([block]).blockNodes[0])
}

/** The editor uses its own NodeView. This DOM is used for clipboard HTML:
 * code/table/image semantics are rendered through the existing safe grammar,
 * and unsupported semantics retain the complete Markdown as literal text.
 */
export function richTextSourceDom(node: Node, ownerDocument: Document | undefined = typeof document === 'undefined' ? undefined : document): DOMOutputSpec {
  const block = node.attrs.block as DocumentBlockDraft | null
  const markdown = richTextSourceMarkdown(node)
  const attrs = { ...blockAttributes(node), class: `${blockAttributes(node).class} rich-text-source-block`, contenteditable: 'false' }
  if (!ownerDocument) return ['div', { ...attrs, 'data-knowbook-markdown-source': 'true' }, markdown]
  const wrapper = ownerDocument.createElement('div')
  for (const [name, value] of Object.entries(attrs)) wrapper.setAttribute(name, value)
  const html = block && !requiresLiteralClipboard(block) ? markdownEngine.render(markdown) : ''
  if (html.trim()) {
    wrapper.innerHTML = html
  } else {
    wrapper.setAttribute('data-knowbook-markdown-source', 'true')
    wrapper.style.whiteSpace = 'pre-wrap'
    wrapper.textContent = markdown
  }
  return wrapper
}

// Object-valued defaults would be shared by every new/split node. The codec
// materializes a fresh paragraph and ID for nodes whose block attribute is null.
const blockAttrs = {
  block: { default: null },
  originalInline: { default: null },
  listNumber: { default: null }
}

export const richTextSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text_block: {
      attrs: blockAttrs,
      content: 'inline*',
      group: 'block',
      defining: true,
      toDOM: textBlockDom,
      parseDOM: [
        ...Array.from({ length: 6 }, (_, index) => ({ tag: `h${index + 1}`, getAttrs: () => importedBlock(`heading-${index + 1}`) })),
        { tag: 'blockquote', getAttrs: () => importedBlock('quote') },
        { tag: 'p', getAttrs: () => importedBlock('paragraph') },
        { tag: 'div.rich-text-block', getAttrs: () => importedBlock('paragraph') }
      ]
    },
    source_block: {
      attrs: blockAttrs,
      group: 'block',
      atom: true,
      selectable: true,
      draggable: true,
      leafText: richTextSourceMarkdown,
      toDOM: richTextSourceDom
    },
    text: { group: 'inline' },
    soft_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      toDOM: () => ['br', { 'data-soft-break': 'true' }],
      parseDOM: [{ tag: 'br[data-soft-break]' }]
    },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      toDOM: () => ['br'],
      parseDOM: [{ tag: 'br:not([data-soft-break])' }]
    }
  },
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [{ tag: 'a[href]', getAttrs: (element) => {
        const href = element.getAttribute('href') ?? ''
        return markdownEngine.validateLink(href) ? { href, title: element.getAttribute('title') } : false
      } }],
      toDOM: (mark) => ['a', { href: mark.attrs.href, ...(mark.attrs.title ? { title: mark.attrs.title } : {}) }, 0]
    },
    strong: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight=bold' }],
      toDOM: () => ['strong', 0]
    },
    em: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
      toDOM: () => ['em', 0]
    },
    strike: {
      parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
      toDOM: () => ['s', 0]
    },
    highlight: {
      parseDOM: [{ tag: 'mark' }],
      toDOM: () => ['mark', 0]
    },
    underline: {
      parseDOM: [{ tag: 'u', consuming: false, getAttrs: element => parseInlineTextPresentationAttributes('u', Array.from(element.attributes)) ? null : false }],
      toDOM: () => ['u', 0]
    },
    textColor: presentationMark('textColor', INLINE_TEXT_COLOR_ATTRIBUTE),
    backgroundColor: presentationMark('backgroundColor', INLINE_BACKGROUND_COLOR_ATTRIBUTE),
    // Code is ordered last so the Markdown serializer can emit it as the
    // innermost non-escaping mark, while retaining surrounding bold/link marks.
    code: {
      code: true,
      excludes: '',
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0]
    }
  }
})
