import { useContext } from 'react'
import { parseMarkdownTableNode } from '@shared/markdownTable'
import { MarkdownReferencesContext, renderMarkdownNodes } from './MarkdownContent'
import { MarkdownNavigationContext } from './MarkdownNavigationContext'
import { MarkdownBlockNodesContext } from './MarkdownDocumentContext'

type MarkdownTablePreviewProps = { content: string; label: string }

export function MarkdownTablePreview({ content, label }: MarkdownTablePreviewProps) {
  const references = useContext(MarkdownReferencesContext)
  const nodes = useContext(MarkdownBlockNodesContext)
  const onNavigateLink = useContext(MarkdownNavigationContext)
  const table = nodes ? nodes.find((node) => node.token.type === 'table_open') : parseMarkdownTableNode(content, { references: { ...references } })
  if (!table) return null
  return <div aria-label={label} className="block-table-content" role="region">
    {renderMarkdownNodes([table], { onNavigateLink })}
  </div>
}
