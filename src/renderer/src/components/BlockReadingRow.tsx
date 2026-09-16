import { isTaskBlockType, isOrderedListBlockType } from '@shared/blockTypes'
import { createElement, lazy, memo, Suspense, type ReactNode } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import type { UiText } from '../i18n'
import { getHeadingLevel } from '@shared/markdownEngine'
import { MarkdownContent, MarkdownInline } from './MarkdownContent'
import { BlockRichMediaPreview } from './BlockRichMediaPreview'
import { MarkdownTablePreview } from './MarkdownTablePreview'
import { parseMarkdownTable } from '../utils/markdownTable'

const CodePreview = lazy(async () => {
  const [module] = await Promise.all([import('./CodeBlockPreview'), import('highlight.js/styles/github-dark.css')])
  return { default: module.CodeBlockPreview }
})
const MathPreview = lazy(async () => {
  const [module] = await Promise.all([import('./MathBlockPreview'), import('katex/dist/katex.min.css')])
  return { default: module.MathBlockPreview }
})

export const BlockReadingRow = memo(function BlockReadingRow({
  block, index, indentPx, numberLabel, isHighlighted, isSearchMatch, hasChildren,
  collapsed, onToggleCollapse, onNavigateReference, ui, isZh
}: {
  block: DocumentBlockDraft
  index: number
  indentPx: number
  numberLabel: string
  isHighlighted: boolean
  isSearchMatch?: boolean
  hasChildren: boolean
  collapsed: boolean
  onToggleCollapse: (id: string) => void
  onNavigateReference: (content: string, cursor: number) => void | Promise<void>
  ui: UiText
  isZh: boolean
}) {
  const structured = ['code', 'math', 'table', 'divider'].includes(block.type)
  let content: ReactNode
  if (block.type === 'divider') content = <hr />
  else if (block.type === 'code') content = <Suspense fallback={<pre>{block.content}</pre>}>
    <CodePreview code={block.content} language={block.language ?? null} label={isZh ? '代码' : 'Code'} />
  </Suspense>
  else if (block.type === 'math') content = <Suspense fallback={<pre>{block.content}</pre>}>
    <MathPreview expression={block.content} label={isZh ? '公式' : 'Math'} />
  </Suspense>
  else if (block.type === 'table') content = parseMarkdownTable(block.content)
    ? <MarkdownTablePreview content={block.content} label={isZh ? '表格' : 'Table'} />
    : <pre>{block.content}</pre>
  else {
    const heading = getHeadingLevel(block.type)
    const onReference = (label: string) => { void onNavigateReference('[[' + label + ']]', 2) }
    content = heading ? createElement('h' + heading, null, <MarkdownInline content={block.content} onReference={onReference} hideImages />)
      : block.type === 'quote' ? <blockquote><MarkdownContent content={block.content} onReference={onReference} hideImages /></blockquote>
      : <div className="document-reading-text"><MarkdownContent content={block.content} onReference={onReference} hideImages /></div>
  }
  return <div
    className={`document-reading-row type-${block.type}${isHighlighted ? ' block-editor-row-highlighted' : ''}${isSearchMatch ? ' block-editor-row-search-match' : ''}`}
    data-block-index={index} data-block-id={block.id}
    data-heading-level={getHeadingLevel(block.type) ?? undefined}
    style={{ marginInlineStart: indentPx, ...(block.highlight ? { background: `var(--highlight-${block.highlight})` } : {}) }}
  >
    {hasChildren && block.id ? <button className="reading-collapse" type="button" aria-expanded={!collapsed}
      aria-label={getHeadingLevel(block.type)
        ? `${collapsed ? (isZh ? '展开章节' : 'Expand section') : (isZh ? '折叠章节' : 'Collapse section')}：${block.content}`
        : collapsed ? ui.expandBlock : ui.collapseBlock}
      onClick={() => onToggleCollapse(block.id!)}>{collapsed ? '▸' : '▾'}</button> : null}
    {isOrderedListBlockType(block.type) ? <span className="reading-list-marker" aria-hidden="true">{numberLabel}</span>
      : block.type === 'bulleted-list' ? <span className="reading-list-marker" aria-hidden="true">•</span> : null}
    {isTaskBlockType(block.type) ? <input type="checkbox" checked={block.checked} disabled aria-label={isZh ? '待办状态' : 'Todo status'} /> : null}
    <div className="document-reading-content">{content}
      {!structured ? <BlockRichMediaPreview content={block.content} ui={ui} /> : null}
    </div>
  </div>
})
