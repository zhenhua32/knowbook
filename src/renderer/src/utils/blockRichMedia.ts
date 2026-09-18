import { markdownEngine, markdownTokenTree, normalizeMarkdownExternalUrl, type MarkdownEnvironment, type MarkdownNode } from '@shared/markdownEngine'
import { parseLocalMarkdownUrl } from '@shared/markdownLinks'
export type BlockRichMediaImage = {
  alt: string
  url: string
}

export type BlockRichMediaLink = {
  label: string
  url: string
}

export type BlockRichMedia = {
  images: BlockRichMediaImage[]
  links: BlockRichMediaLink[]
}

const KNOWBOOK_ASSET_PREVIEW_SCHEME = 'knowbook-asset'

export function extractBlockRichMedia(content: string, references?: MarkdownEnvironment['references'], includeLocalLinks = false): BlockRichMedia {
  const images: BlockRichMediaImage[] = []
  const links: BlockRichMediaLink[] = []
  const imageUrls = new Set<string>()
  const linkUrls = new Set<string>()
  const label = (nodes: MarkdownNode[]): string => nodes.map((node) => node.children.length ? label(node.children) : node.token.content).join('')
  const visit = (nodes: MarkdownNode[]) => {
    for (const { token, children } of nodes) {
      if (token.type === 'footnote_block_open') continue
      if (token.type === 'image') {
        const url = normalizeMarkdownExternalUrl(String(token.attrGet('src') ?? ''))
        if (url && !url.startsWith('mailto:') && !imageUrls.has(url)) {
          imageUrls.add(url)
          images.push({ alt: label(children) || token.content, url })
        }
      } else if (token.type === 'link_open') {
        const href = String(token.attrGet('href') ?? '')
        const url = normalizeMarkdownExternalUrl(href) ?? (includeLocalLinks && parseLocalMarkdownUrl(href) ? href : null)
        if (url && !linkUrls.has(url)) {
          linkUrls.add(url)
          links.push({ label: label(children) || url, url })
        }
        visit(children)
      } else if (children.length) visit(children)
    }
  }
  visit(markdownTokenTree(markdownEngine.parse(content, { references: { ...references } })))
  return { images, links: links.filter((link) => !imageUrls.has(link.url)) }
}

export function toBlockRichMediaPreviewUrl(url: string): string {
  if (!url.startsWith('file://')) {
    return url
  }

  return `${KNOWBOOK_ASSET_PREVIEW_SCHEME}://preview/?source=${encodeURIComponent(url)}`
}
