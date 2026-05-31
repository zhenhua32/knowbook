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

const IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g
const LINK_REGEX = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g
const PLAIN_URL_REGEX = /(?:^|[\s(])((?:https?:\/\/|file:\/\/)[^\s<>)\]]+)/g

export function extractBlockRichMedia(content: string): BlockRichMedia {
  const images: BlockRichMediaImage[] = []
  const links: BlockRichMediaLink[] = []
  const imageUrls = new Set<string>()
  const linkUrls = new Set<string>()

  for (const match of content.matchAll(IMAGE_REGEX)) {
    const url = normalizeMarkdownTarget(match[2] ?? '')
    if (!url || imageUrls.has(url)) {
      continue
    }

    imageUrls.add(url)
    images.push({
      alt: (match[1] ?? '').trim(),
      url
    })
  }

  for (const match of content.matchAll(LINK_REGEX)) {
    const url = normalizeMarkdownTarget(match[2] ?? '')
    if (!url || imageUrls.has(url) || linkUrls.has(url)) {
      continue
    }

    linkUrls.add(url)
    links.push({
      label: (match[1] ?? '').trim() || url,
      url
    })
  }

  for (const match of content.matchAll(PLAIN_URL_REGEX)) {
    const url = normalizePlainUrl(match[1] ?? '')
    if (!url || imageUrls.has(url) || linkUrls.has(url)) {
      continue
    }

    linkUrls.add(url)
    links.push({
      label: url,
      url
    })
  }

  return { images, links }
}

export function toBlockRichMediaPreviewUrl(url: string): string {
  if (!url.startsWith('file://')) {
    return url
  }

  return `${KNOWBOOK_ASSET_PREVIEW_SCHEME}://preview/?source=${encodeURIComponent(url)}`
}

function normalizeMarkdownTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim()
  if (!trimmed) {
    return null
  }

  const withoutBrackets = trimmed.replace(/^<|>$/g, '')
  const withoutTitle = withoutBrackets.split(/\s+"/)[0]?.trim() ?? ''
  return normalizeSupportedUrl(withoutTitle)
}

function normalizePlainUrl(rawUrl: string): string | null {
  return normalizeSupportedUrl(rawUrl.trim().replace(/[),.;!?]+$/g, ''))
}

function normalizeSupportedUrl(rawUrl: string): string | null {
  if (!rawUrl) {
    return null
  }

  try {
    const url = new URL(rawUrl)
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}