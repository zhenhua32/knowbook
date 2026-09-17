import { useContext } from 'react'
import { parseMarkdownTableNode } from '@shared/markdownTable'
import { MarkdownReferencesContext, renderMarkdownNodes } from './MarkdownContent'
import { MarkdownNavigationContext } from './MarkdownNavigationContext'

type MarkdownTablePreviewProps = { content: string; label: string }

export function MarkdownTablePreview({ content, label }: MarkdownTablePreviewProps) {
  const references = useContext(MarkdownReferencesContext)
  const onNavigateLink = useContext(MarkdownNavigationContext)
  const table = parseMarkdownTableNode(content, { references: { ...references } })
  if (!table) return null
  return <div aria-label={label} className="block-table-content" role="region">
    {renderMarkdownNodes([table], { onNavigateLink })}
  </div>
}
