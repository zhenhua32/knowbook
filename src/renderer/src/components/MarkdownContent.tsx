import { createContext, createElement, Fragment, lazy, Suspense, useContext, type ReactNode } from 'react'
import {
  markdownEngine, markdownTokenTree, parseMarkdownInline, normalizeMarkdownExternalUrl,
  type MarkdownEnvironment, type MarkdownNode
} from '@shared/markdownEngine'
import { toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'
import { parseLocalMarkdownUrl } from '@shared/markdownLinks'
import { parseWikiReference, wikiDisplayText } from '@shared/markdownWiki'
import { MarkdownNavigationContext } from './MarkdownNavigationContext'
import { MarkdownBlockNodesContext, MarkdownDocumentContext } from './MarkdownDocumentContext'

export const MarkdownReferencesContext = createContext<MarkdownEnvironment['references']>(undefined)
const MathPreview = lazy(async () => {
  const [module] = await Promise.all([import('./MathBlockPreview'), import('katex/dist/katex.min.css'), import('../styles/markdown-advanced.css')])
  return { default: module.MathBlockPreview }
})

const AdvancedNode = lazy(async () => {
  const [module] = await Promise.all([import('./AdvancedMarkdownNode'), import('../styles/markdown-advanced.css')])
  return { default: module.AdvancedMarkdownNode }
})
const MermaidPreview = lazy(async () => {
  const [module] = await Promise.all([import('./MermaidPreview'), import('../styles/markdown-advanced.css')])
  return { default: module.MermaidPreview }
})

export type MarkdownRenderOptions = {
  onReference?: (label: string) => void
  renderReference?: (label: string, index: number) => ReactNode
  hideImages?: boolean
  onNavigateLink?: (url: string) => void
  onToggleTask?: (offset: number, checked: boolean) => void
  canToggleTask?: (offset: number) => boolean
  taskLabel?: string
}

function openLink(url: string) {
  void window.knowbook.openExternalUrl(url).catch((error) => console.warn('Failed to open Markdown link.', error))
}

// A reference in a link label must remain its own control. Split the link
// around it, including references nested in emphasis, to avoid nested buttons.
function renderLinkParts(nodes: MarkdownNode[], link: (content: ReactNode, key: number) => ReactNode, options: MarkdownRenderOptions): ReactNode[] {
  const hasReference = (node: MarkdownNode): boolean => node.token.type === 'footnote_ref' || node.children.some(hasReference)
  const output: ReactNode[] = []
  let pending: MarkdownNode[] = []
  const flush = () => {
    if (pending.length) output.push(link(renderMarkdownNodes(pending, options), output.length))
    pending = []
  }
  for (const node of nodes) {
    if (!hasReference(node)) { pending.push(node); continue }
    flush()
    if (node.token.type === 'footnote_ref') output.push(<Fragment key={output.length}>{renderMarkdownNodes([node], options)}</Fragment>)
    else {
      const tag = ['strong', 'em', 's', 'del', 'mark'].includes(node.token.tag) ? node.token.tag : 'span'
      output.push(createElement(tag, { key: output.length }, renderLinkParts(node.children, link, options)))
    }
  }
  flush()
  return output
}

export function MarkdownMermaidPreview({ source, label }: { source: string; label: string }) {
  return <Suspense fallback={<pre>{source}</pre>}><MermaidPreview source={source} label={label} /></Suspense>
}

export function renderMarkdownNodes(nodes: MarkdownNode[], options: MarkdownRenderOptions = {}): ReactNode[] {
  return nodes.map((node, index) => {
    const { token, children } = node
    const anchor = token.meta?.html ? String(token.attrGet('id') || token.attrGet('name') || '') : ''
    const nested = () => renderMarkdownNodes(children, options)
    if (token.meta?.callout || ['mark_open', 'footnote_ref', 'footnote_missing', 'footnote_block_open', 'footnote_open', 'footnote_anchor', 'table_of_contents'].includes(token.type)) {
      return <Suspense key={index} fallback={<span>{token.content || (token.type === 'footnote_ref' ? `[${Number(token.meta?.id) + 1}]` : nested())}</span>}>
        <AdvancedNode node={node} options={options} />
      </Suspense>
    }
    switch (token.type) {
      case 'text': return token.content
      case 'inline': return <Fragment key={index}>{nested()}</Fragment>
      case 'softbreak': return '\n'
      case 'hardbreak': return <br key={index} data-markdown-anchor={anchor || undefined} />
      case 'code_inline': return <code className="inline-code" key={index}>{token.content}</code>
      case 'fence': if (/^mermaid(?:\s|$)/i.test(token.info.trim())) return <MarkdownMermaidPreview key={index} source={token.content} label="Mermaid" />
        return <pre key={index}><code>{token.content}</code></pre>
      case 'code_block': return <pre key={index}><code>{token.content}</code></pre>
      case 'hr': return <hr key={index} />
      case 'task_checkbox': return <Fragment key={index}><input type="checkbox"
        disabled={!options.onToggleTask || typeof token.meta?.sourceOffset !== 'number' || options.canToggleTask?.(Number(token.meta.sourceOffset)) === false} checked={Boolean(token.meta?.checked)}
        onChange={(event) => options.onToggleTask?.(Number(token.meta?.sourceOffset), event.target.checked)}
        aria-label={`${options.taskLabel ?? 'Task'}${token.meta?.label ? ': ' + token.meta.label : ''}`} />{' '}</Fragment>
      case 'math_inline':
      case 'math_block': return <Suspense key={index} fallback={token.type === 'math_inline' ? <code>{token.content}</code> : <pre>{token.content}</pre>}>
        <MathPreview expression={token.content} label="Math" displayMode={token.type === 'math_block'} />
      </Suspense>
      case 'callout_title':
      case 'frontmatter':
      case 'knowbook_metadata': return null
      case 'wiki_embed': return <span key={index}>{token.content}</span>
      case 'wiki_link': {
        if (parseWikiReference(token.content).fragment.startsWith('^')) return <span key={index}>{`[[${token.content}]]`}</span>
        const navigate = options.onReference ?? (options.onNavigateLink ? (raw: string) => options.onNavigateLink?.('knowbook-wiki:' + raw) : undefined)
        return options.renderReference ? options.renderReference(token.content, index) : navigate
          ? <button key={index} className="inline-link" type="button" title={parseWikiReference(token.content).target} onClick={() => navigate(token.content)}>{wikiDisplayText(token.content)}</button>
          : <span key={index}>{wikiDisplayText(token.content)}</span>
      }
      case 'link_open': {
        const href = String(token.attrGet('href') ?? '')
        const url = normalizeMarkdownExternalUrl(href)
        const local = parseLocalMarkdownUrl(href)
        if (!url && !(local && options.onNavigateLink)) return <span key={index} data-markdown-anchor={anchor || undefined} title={href}>{nested()}</span>
        const parts = renderLinkParts(children, (content, key) => <button key={key} className="inline-link" type="button" title={String(token.attrGet('title') || href)}
          onClick={() => url ? openLink(url) : options.onNavigateLink?.(href)}>{content}</button>, options)
        return anchor ? <span key={index} data-markdown-anchor={anchor}>{parts}</span> : <Fragment key={index}>{parts}</Fragment>
      }
      case 'image': {
        const src = normalizeMarkdownExternalUrl(String(token.attrGet('src') ?? ''))
        if (!src || src.startsWith('mailto:')) return <span key={index}>{token.meta?.wiki ? String(token.meta.wikiSource) : token.meta?.html ? String(token.meta.htmlSource ?? '') : `![${token.content}](${String(token.attrGet('src') ?? '')})`}</span>
        if (options.hideImages) return null
        return <img key={index} alt={token.content} title={String(token.attrGet('title') ?? '') || undefined} loading="lazy"
          width={token.meta?.html ? token.attrGet('width') ?? undefined : undefined} height={token.meta?.html ? token.attrGet('height') ?? undefined : undefined}
          data-markdown-anchor={anchor || undefined}
          className="markdown-inline-image" src={toBlockRichMediaPreviewUrl(src)} />
      }
      default: {
        // Only parser-generated, allowlisted elements and attributes reach React.
        if (!['p', 'strong', 'em', 's', 'del', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(token.tag)
          && !(token.meta?.html && ['details', 'summary', 'kbd', 'sub', 'sup', 'a'].includes(token.tag))) return token.content
        if (token.hidden) return <Fragment key={index}>{nested()}</Fragment>
        const alignment = String(token.attrGet('style') ?? '').match(/^text-align:(left|center|right)$/)?.[1] as 'left' | 'center' | 'right' | undefined
        return createElement(token.tag === 's' ? 'del' : token.tag === 'a' ? 'span' : token.tag, {
          key: index,
          ...(token.meta?.html ? { title: token.attrGet('title') ?? undefined, 'data-markdown-anchor': anchor || undefined } : {}),
          ...(token.tag === 'details' ? { open: token.attrGet('open') !== null, className: 'markdown-details' } : {}),
          ...(token.tag === 'table' ? { className: 'block-markdown-table' } : {}),
          ...(token.tag === 'ol' && token.attrGet('start') !== null ? { start: Number(token.attrGet('start')) } : {}),
          ...(alignment ? { style: { textAlign: alignment } } : {}),
          ...(token.tag === 'li' && token.meta?.task ? { style: { listStyleType: 'none' } } : {})
        }, nested())
      }
    }
  })
}

export function MarkdownInline({ content, ...options }: { content: string } & MarkdownRenderOptions) {
  const references = useContext(MarkdownReferencesContext)
  const onNavigateLink = useContext(MarkdownNavigationContext)
  return <>{renderMarkdownNodes(parseMarkdownInline(content, { references }), { onNavigateLink, ...options })}</>
}

export function MarkdownNodes({ nodes, ...options }: { nodes: MarkdownNode[] } & MarkdownRenderOptions) {
  const onNavigateLink = useContext(MarkdownNavigationContext)
  const { onToggleTask, isZh, model } = useContext(MarkdownDocumentContext)
  return <>{renderMarkdownNodes(nodes, { onNavigateLink, onToggleTask, canToggleTask: (offset) => model?.taskTargets.has(offset) ?? false,
    taskLabel: isZh ? '任务' : 'Task', ...options })}</>
}

export function MarkdownBlockContent(options: MarkdownRenderOptions) {
  const nodes = useContext(MarkdownBlockNodesContext)
  return <MarkdownNodes nodes={nodes ?? []} {...options} />
}

export function MarkdownContent({ content, ...options }: { content: string } & MarkdownRenderOptions) {
  const references = useContext(MarkdownReferencesContext)
  const onNavigateLink = useContext(MarkdownNavigationContext)
  const env = { references: { ...references } }
  return <>{renderMarkdownNodes(markdownTokenTree(markdownEngine.parse(content, env)), { onNavigateLink, ...options })}</>
}
