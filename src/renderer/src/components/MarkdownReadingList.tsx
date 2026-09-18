import { createElement, type ReactNode } from 'react'
import type { MarkdownNode } from '@shared/markdownEngine'
import { MarkdownNodes } from './MarkdownContent'
import '../styles/markdown-editing.css'

export function MarkdownReadingList({ node, owners, visible, renderBlock }: {
  node: MarkdownNode
  owners: Map<MarkdownNode['token'], number>
  visible: Set<number>
  renderBlock: (index: number) => ReactNode
}) {
  const containsOwned = (item: MarkdownNode): boolean => {
    const owner = owners.get(item.token)
    return (owner !== undefined && visible.has(owner)) || item.children.some(containsOwned)
  }
  const renderList = (list: MarkdownNode, key = 0): ReactNode => {
    if (!containsOwned(list)) return null
    const loose = list.children.some((item) => item.children.some(({ token }) => token.type === 'paragraph_open' && !token.hidden))
    return createElement(list.token.tag, { key, role: 'list',
      className: `markdown-reading-list markdown-reading-list-${loose ? 'loose' : 'tight'}`,
      ...(list.token.tag === 'ol' ? { start: Number(list.token.attrGet('start') ?? 1) } : {})
    }, list.children.map((item, index) => {
      const owner = owners.get(item.token)
      if (owner === undefined) return <MarkdownNodes key={index} nodes={[item]} />
      if (!visible.has(owner)) return null
      return <li key={index}>{renderBlock(owner)}{item.children.filter((child) => ['bullet_list_open', 'ordered_list_open'].includes(child.token.type) && containsOwned(child)).map(renderList)}</li>
    }))
  }
  return renderList(node)
}
