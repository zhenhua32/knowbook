import { lazy, memo, Suspense, type ReactNode } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import type { UiText } from '../i18n'
import { parseMarkdownStyles, renderStyledContent } from './InlineContentRenderer'
import { BlockRichMediaPreview } from './BlockRichMediaPreview'
import { MarkdownTablePreview } from './MarkdownTablePreview'
import { parseMarkdownTable } from '../utils/markdownTable'
import { extractBlockRichMedia } from '../utils/blockRichMedia'

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
    const inline: ReactNode[] = []
    let end = 0
    // Keep reference navigation on the same resolver as the editor. React escapes
    // all text; document contents are never inserted as HTML.
    for (const match of block.content.matchAll(/`[^`\n]+`|\[\[([^\]\n]+)\]\]|!?\[[^\]\n]*\]\([^)\n]+\)/g)) {
      inline.push(<span key={`text-${end}`}>{renderStyledContent(parseMarkdownStyles(block.content.slice(end, match.index)))}</span>)
      if (match[1]) {
        inline.push(<button className="inline-link" key={`ref-${match.index}`} type="button"
          onClick={() => { void onNavigateReference(block.content, match.index + 2) }}>{match[1]}</button>)
      } else if (match[0].startsWith('`')) {
        inline.push(<span key={`code-${match.index}`}>{renderStyledContent(parseMarkdownStyles(match[0]))}</span>)
      } else {
        const media = extractBlockRichMedia(match[0])
        const link = media.links[0]
        if (link) inline.push(<button className="inline-link" key={`link-${match.index}`} type="button"
          title={link.url} onClick={() => {
            void window.knowbook.openExternalUrl(link.url).catch((error) => console.warn('Failed to open reading link.', error))
          }}>{link.label}</button>)
        // Valid images are rendered by the existing media preview below. Keep
        // unsupported markup as text so malformed content never disappears.
        else if (!media.images.length) inline.push(<span key={`raw-${match.index}`}>{match[0]}</span>)
      }
      end = match.index + match[0].length
    }
    inline.push(<span key={`text-${end}`}>{renderStyledContent(parseMarkdownStyles(block.content.slice(end)))}</span>)
    content = block.type === 'heading-1' ? <h1>{inline}</h1>
      : block.type === 'heading-2' ? <h2>{inline}</h2>
      : block.type === 'quote' ? <blockquote>{inline}</blockquote>
      : <div className="document-reading-text">{inline}</div>
  }
  return <div
    className={`document-reading-row type-${block.type}${isHighlighted ? ' block-editor-row-highlighted' : ''}${isSearchMatch ? ' block-editor-row-search-match' : ''}`}
    data-block-index={index} data-block-id={block.id}
    data-heading-level={block.type === 'heading-1' ? 1 : block.type === 'heading-2' ? 2 : undefined}
    style={{ marginInlineStart: indentPx, ...(block.highlight ? { background: `var(--highlight-${block.highlight})` } : {}) }}
  >
    {hasChildren && block.id ? <button className="reading-collapse" type="button" aria-expanded={!collapsed}
      aria-label={collapsed ? ui.expandBlock : ui.collapseBlock}
      onClick={() => onToggleCollapse(block.id!)}>{collapsed ? '▸' : '▾'}</button> : null}
    {block.type === 'todo' ? <input type="checkbox" checked={block.checked} disabled aria-label={isZh ? '待办状态' : 'Todo status'} />
      : block.type === 'bulleted-list' ? <span className="reading-list-marker" aria-hidden="true">•</span>
      : block.type === 'numbered-list' ? <span className="reading-list-marker" aria-hidden="true">{numberLabel}</span> : null}
    <div className="document-reading-content">{content}
      {!structured ? <BlockRichMediaPreview content={block.content} ui={ui} /> : null}
    </div>
  </div>
})
