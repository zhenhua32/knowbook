import { useContext } from 'react'
import type { MarkdownNode } from '@shared/markdownEngine'
import type { MarkdownCallout } from '@shared/markdownAdvanced'
import { MarkdownDocumentContext } from './MarkdownDocumentContext'
import { renderMarkdownNodes, type MarkdownRenderOptions } from './MarkdownContent'

export function AdvancedMarkdownNode({ node, options }: { node: MarkdownNode; options: MarkdownRenderOptions }) {
  const { token, children } = node
  const { model, isZh, footnoteId, navigateFootnote } = useContext(MarkdownDocumentContext)
  const nested = () => renderMarkdownNodes(children, options)
  const id = Number(token.meta?.id)
  const subId = Number(token.meta?.subId ?? 0)
  switch (token.type) {
    case 'mark_open': return <mark>{nested()}</mark>
    case 'footnote_missing': return <span className="markdown-footnote-missing" title={`${isZh ? '未找到脚注定义' : 'Undefined footnote'}: ${String(token.meta?.label)}`}>{token.content}</span>
    case 'footnote_ref': return <sup className="markdown-footnote-reference">
      <button type="button" id={footnoteId(id, subId)} aria-label={`${isZh ? '脚注' : 'Footnote'} ${id + 1}`}
        onClick={() => navigateFootnote(id)}>[{id + 1}]</button>
    </sup>
    case 'footnote_block_open': return <section className="markdown-footnotes" role="doc-endnotes" aria-label={isZh ? '脚注' : 'Footnotes'}><hr /><ol>{nested()}</ol></section>
    case 'footnote_open': return <li id={footnoteId(id)} tabIndex={-1} value={id + 1}>{nested()}</li>
    case 'footnote_anchor': return <button type="button" className="markdown-footnote-backref"
      aria-label={`${isZh ? '返回脚注引用' : 'Back to footnote reference'} ${id + 1}.${subId + 1}`}
      onClick={() => navigateFootnote(id, subId)}>↩{subId > 0 ? subId + 1 : ''}</button>
    case 'table_of_contents': return <nav className="markdown-toc" aria-label={isZh ? '文内目录' : 'Table of contents'}>
      <strong>{isZh ? '目录' : 'Contents'}</strong>
      {model?.headings.length ? <ul>{model.headings.map((heading) => <li key={heading.slug} style={{ paddingInlineStart: `${(heading.level - 1) * 0.85}em` }}>
        <button type="button" className="inline-link" onClick={() => options.onNavigateLink?.(`#${heading.slug}`)}>{heading.text || (isZh ? '未命名标题' : 'Untitled heading')}</button>
      </li>)}</ul> : <p>{isZh ? '添加标题后会显示在这里。' : 'Headings will appear here.'}</p>}
    </nav>
    case 'blockquote_open': {
      const callout = token.meta?.callout as MarkdownCallout
      const title = renderMarkdownNodes(children.find((child) => child.token.type === 'callout_title')?.children ?? [], options)
      const body = <div className="markdown-callout-body">{nested()}</div>
      const attrs = { className: 'markdown-callout', 'data-callout': callout.kind }
      return callout.folded === null ? <aside {...attrs}><div className="markdown-callout-title">{title}</div>{body}</aside>
        : <details {...attrs} open={!callout.folded}><summary>{title}</summary>{body}</details>
    }
    default: return null
  }
}
