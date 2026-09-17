import { createContext, createElement, Fragment, lazy, Suspense, useContext, type ReactNode } from 'react'
import {
  markdownEngine, markdownTokenTree, parseMarkdownInline, normalizeMarkdownExternalUrl,
  type MarkdownEnvironment, type MarkdownNode
} from '@shared/markdownEngine'
import { toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'
import { parseLocalMarkdownUrl } from '@shared/markdownLinks'
import { MarkdownNavigationContext } from './MarkdownNavigationContext'

export const MarkdownReferencesContext = createContext<MarkdownEnvironment['references']>(undefined)
const MathPreview = lazy(async () => {
  const [module] = await Promise.all([import('./MathBlockPreview'), import('katex/dist/katex.min.css')])
  return { default: module.MathBlockPreview }
})

type Options = {
  onReference?: (label: string) => void
  renderReference?: (label: string, index: number) => ReactNode
  hideImages?: boolean
  onNavigateLink?: (url: string) => void
}

function openLink(url: string) {
  void window.knowbook.openExternalUrl(url).catch((error) => console.warn('Failed to open Markdown link.', error))
}

export function renderMarkdownNodes(nodes: MarkdownNode[], options: Options = {}): ReactNode[] {
  return nodes.map(({ token, children }, index) => {
    const nested = () => renderMarkdownNodes(children, options)
    switch (token.type) {
      case 'text': return token.content
      case 'inline': return <Fragment key={index}>{nested()}</Fragment>
      case 'softbreak': return '\n'
      case 'hardbreak': return <br key={index} />
      case 'code_inline': return <code className="inline-code" key={index}>{token.content}</code>
      case 'fence':
      case 'code_block': return <pre key={index}><code>{token.content}</code></pre>
      case 'hr': return <hr key={index} />
      case 'task_checkbox': return <Fragment key={index}><input type="checkbox" disabled checked={Boolean(token.meta?.checked)} aria-label="Task" />{' '}</Fragment>
      case 'math_block': return <Suspense key={index} fallback={<pre>{token.content}</pre>}>
        <MathPreview expression={token.content} label="Math" />
      </Suspense>
      case 'knowbook_metadata': return null
      case 'wiki_link': return options.renderReference ? options.renderReference(token.content, index) : options.onReference
        ? <button key={index} className="inline-link" type="button" onClick={() => options.onReference?.(token.content)}>{token.content}</button>
        : <span key={index}>{`[[${token.content}]]`}</span>
      case 'link_open': {
        const href = String(token.attrGet('href') ?? '')
        const url = normalizeMarkdownExternalUrl(href)
        const local = parseLocalMarkdownUrl(href)
        return url || (local && options.onNavigateLink) ? <button key={index} className="inline-link" type="button" title={String(token.attrGet('title') || href)}
          onClick={() => url ? openLink(url) : options.onNavigateLink?.(href)}>{nested()}</button> : <span key={index} title={href}>{nested()}</span>
      }
      case 'image': {
        const src = normalizeMarkdownExternalUrl(String(token.attrGet('src') ?? ''))
        if (!src || src.startsWith('mailto:')) return <span key={index}>{`![${token.content}](${String(token.attrGet('src') ?? '')})`}</span>
        if (options.hideImages) return null
        return <img key={index} alt={token.content} title={String(token.attrGet('title') ?? '') || undefined} loading="lazy"
          className="markdown-inline-image" src={toBlockRichMediaPreviewUrl(src)} />
      }
      default: {
        // Only parser-generated, allowlisted elements and attributes reach React.
        if (!['p', 'strong', 'em', 's', 'del', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(token.tag)) return token.content
        if (token.hidden) return <Fragment key={index}>{nested()}</Fragment>
        const alignment = String(token.attrGet('style') ?? '').match(/^text-align:(left|center|right)$/)?.[1] as 'left' | 'center' | 'right' | undefined
        return createElement(token.tag === 's' ? 'del' : token.tag, {
          key: index,
          ...(token.tag === 'table' ? { className: 'block-markdown-table' } : {}),
          ...(token.tag === 'ol' && token.attrGet('start') !== null ? { start: Number(token.attrGet('start')) } : {}),
          ...(alignment ? { style: { textAlign: alignment } } : {})
        }, nested())
      }
    }
  })
}

export function MarkdownInline({ content, ...options }: { content: string } & Options) {
  const references = useContext(MarkdownReferencesContext)
  const onNavigateLink = useContext(MarkdownNavigationContext)
  return <>{renderMarkdownNodes(parseMarkdownInline(content, { references }), { onNavigateLink, ...options })}</>
}

export function MarkdownContent({ content, ...options }: { content: string } & Options) {
  const references = useContext(MarkdownReferencesContext)
  const onNavigateLink = useContext(MarkdownNavigationContext)
  const env = { references: { ...references } }
  return <>{renderMarkdownNodes(markdownTokenTree(markdownEngine.parse(content, env)), { onNavigateLink, ...options })}</>
}
