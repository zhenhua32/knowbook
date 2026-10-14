import type { MarkdownNode } from '@shared/markdownEngine'
import type { MarkdownBlockFormat } from '@shared/markdownFormat'
import { renderMarkdownNodes, type MarkdownRenderOptions } from './MarkdownContent'
import { nativeContainerPresentation } from '../utils/nativeContainerPresentation'
import '../styles/native-containers.css'

export default function NativeMarkdownNode({ node, options }: { node: MarkdownNode; options: MarkdownRenderOptions }) {
  const native = node.token.meta?.nativeContainer as { type: 'callout' | 'toggle'; markdownFormat?: MarkdownBlockFormat }
  const presentation = nativeContainerPresentation(native.type, native.markdownFormat)
  const titleNode = node.children.find(child => child.token.type === 'native_container_title')
  const title = titleNode ? renderMarkdownNodes(titleNode.children, options) : null
  const body = renderMarkdownNodes(node.children.filter(child => child !== titleNode), options)
  if (native.type === 'toggle') return <details className="native-container-markdown" data-native-container="toggle" open={presentation.defaultOpen}>
    <summary>{title}</summary>{body}
  </details>
  return <aside className="native-container-markdown" data-native-container="callout" data-native-container-tone={presentation.tone}>
    <div className="native-container-title"><span className="native-container-icon" data-native-container-icon={presentation.icon} aria-hidden="true" />{title}</div>{body}
  </aside>
}
