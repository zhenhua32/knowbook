import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'
import type {
  ClipWebPageInput,
  ClipWebPageResult,
  DocumentBlockDraft,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType
} from '@shared/contracts'
import { parseMarkdownBackupDocument } from '@shared/markdown'
import { DEFAULT_DOCUMENT_SUMMARY, KnowbookStore } from './database/store'

const WEB_CLIP_TIMEOUT_MS = 15_000
const WEB_CLIP_USER_AGENT = 'KnowBook/0.1 WebClip'

type WebClipFieldKey =
  | 'sourceUrl'
  | 'sourceSite'
  | 'clippedAt'
  | 'publishedAt'
  | 'author'
  | 'clipStatus'
  | 'coverImage'

type WebClipFieldDefinition = {
  key: WebClipFieldKey
  name: string
  type: DocumentDatabaseColumnType
  options?: string[]
}

type ExtractedWebClip = {
  title: string
  sourceUrl: string
  sourceSite: string
  excerpt: string
  author: string | null
  publishedAt: string | null
  coverImage: string | null
  bodyMarkdown: string
  warnings: string[]
}

const WEB_CLIP_FIELDS: WebClipFieldDefinition[] = [
  { key: 'sourceUrl', name: 'Source URL', type: 'text' },
  { key: 'sourceSite', name: 'Source Site', type: 'text' },
  { key: 'clippedAt', name: 'Clipped At', type: 'date' },
  { key: 'publishedAt', name: 'Published At', type: 'date' },
  { key: 'author', name: 'Author', type: 'text' },
  { key: 'clipStatus', name: 'Clip Status', type: 'select', options: ['clipped', 'partial'] },
  { key: 'coverImage', name: 'Cover Image', type: 'text' }
]

export class WebClipperService {
  constructor(private readonly store: KnowbookStore) {}

  async clipWebPage(input: ClipWebPageInput): Promise<ClipWebPageResult> {
    const sourceUrl = normalizeWebUrl(input.url)
    const fetched = await fetchHtmlDocument(sourceUrl)
    const clip = extractWebClip(fetched.html, fetched.finalUrl)
    const columns = this.ensureWebClipColumns()

    const documentId = this.store.createDocument(input.parentId)
    const parsed = parseMarkdownBackupDocument(buildClipMarkdownDocument(clip))
    const blocks = toDocumentDraftBlocks(parsed.blocks)

    this.store.updateDocument(documentId, {
      title: clip.title,
      summary: DEFAULT_DOCUMENT_SUMMARY,
      blocks: blocks.length > 0 ? blocks : buildFallbackBlocks(clip)
    })

    const clippedAt = new Date().toISOString().slice(0, 10)
    const clipStatus = clip.warnings.length > 0 ? 'partial' : 'clipped'
    const fieldValues = [
      { columnId: columns.sourceUrl.id, value: clip.sourceUrl },
      { columnId: columns.sourceSite.id, value: clip.sourceSite },
      { columnId: columns.clippedAt.id, value: clippedAt },
      { columnId: columns.publishedAt.id, value: clip.publishedAt },
      { columnId: columns.author.id, value: clip.author },
      { columnId: columns.clipStatus.id, value: clipStatus },
      { columnId: columns.coverImage.id, value: clip.coverImage }
    ]

    for (const field of fieldValues) {
      if (!field.value) {
        continue
      }

      this.store.updateDocumentDatabaseValue({
        documentId,
        columnId: field.columnId,
        value: field.value
      })
    }

    return {
      documentId,
      title: clip.title,
      sourceUrl: clip.sourceUrl,
      warnings: [...clip.warnings]
    }
  }

  private ensureWebClipColumns(): Record<WebClipFieldKey, DocumentDatabaseColumn> {
    const existingColumns = this.store.getDocumentDatabaseColumns()
    const byName = new Map(existingColumns.map((column) => [column.name.toLowerCase(), column]))
    const resolved = {} as Record<WebClipFieldKey, DocumentDatabaseColumn>

    for (const definition of WEB_CLIP_FIELDS) {
      let column = byName.get(definition.name.toLowerCase())

      if (!column) {
        column = this.store.createDocumentDatabaseColumn({
          name: definition.name,
          type: definition.type,
          options: definition.options
        })
        byName.set(definition.name.toLowerCase(), column)
      } else if (definition.type === 'select' && column.type === 'select' && definition.options) {
        const mergedOptions = [...column.options]
        let changed = false

        for (const option of definition.options) {
          if (!mergedOptions.includes(option)) {
            mergedOptions.push(option)
            changed = true
          }
        }

        if (changed) {
          this.store.updateDocumentDatabaseColumnOptions({
            columnId: column.id,
            options: mergedOptions
          })
          column = {
            ...column,
            options: mergedOptions
          }
        }
      }

      resolved[definition.key] = column
    }

    return resolved
  }
}

async function fetchHtmlDocument(url: string): Promise<{ html: string; finalUrl: string }> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': WEB_CLIP_USER_AGENT
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(WEB_CLIP_TIMEOUT_MS)
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch webpage (${response.status}).`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error(`Unsupported page type: ${contentType || 'unknown'}`)
  }

  const html = await response.text()
  if (!html.trim()) {
    throw new Error('Fetched webpage is empty.')
  }

  return {
    html,
    finalUrl: response.url || url
  }
}

function extractWebClip(html: string, sourceUrl: string): ExtractedWebClip {
  const dom = new JSDOM(html, { url: sourceUrl })
  const { document } = dom.window

  removeNoisyNodes(document)
  absolutizeDocumentUrls(document, sourceUrl)

  const warnings: string[] = []
  const readability = new Readability(document.cloneNode(true) as Document)
  const article = readability.parse()
  const sourceSite = firstNonEmpty(
    getMetaContent(document, 'meta[property="og:site_name"]', 'meta[name="application-name"]'),
    safeHostname(sourceUrl)
  ) ?? safeHostname(sourceUrl)
  const title = firstNonEmpty(
    normalizeTitle(article?.title),
    normalizeTitle(getMetaContent(document, 'meta[property="og:title"]', 'meta[name="twitter:title"]')),
    normalizeTitle(document.title),
    sourceSite,
    safeHostname(sourceUrl)
  ) ?? safeHostname(sourceUrl)

  let bodyMarkdown = ''
  if (article?.content?.trim()) {
    const articleDom = new JSDOM(`<body>${article.content}</body>`, { url: sourceUrl })
    absolutizeDocumentUrls(articleDom.window.document, sourceUrl)
    bodyMarkdown = createTurndownService().turndown(articleDom.window.document.body.innerHTML).trim()
    bodyMarkdown = stripDuplicateLeadingTitle(bodyMarkdown, title)
  }

  if (!bodyMarkdown) {
    const fallbackText = normalizeWhitespace(article?.textContent ?? document.body?.textContent ?? '')
    if (!fallbackText) {
      throw new Error('Could not extract readable text from this webpage.')
    }

    bodyMarkdown = fallbackText
    warnings.push('Readable article extraction fell back to plain page text.')
  }

  return {
    title,
    sourceUrl,
    sourceSite,
    excerpt: normalizeExcerpt(article?.excerpt ?? getMetaContent(document, 'meta[name="description"]', 'meta[property="og:description"]')),
    author: firstNonEmpty(
      normalizeWhitespace(article?.byline ?? ''),
      getMetaContent(document, 'meta[name="author"]', 'meta[property="article:author"]')
    ),
    publishedAt: normalizeDateValue(firstNonEmpty(
      getMetaContent(document, 'meta[property="article:published_time"]', 'meta[name="date"]', 'meta[name="publish-date"]'),
      document.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ?? null
    )),
    coverImage: absolutizeUrl(
      firstNonEmpty(
        getMetaContent(document, 'meta[property="og:image"]', 'meta[name="twitter:image"]'),
        document.querySelector('article img')?.getAttribute('src')?.trim() ?? null,
        document.querySelector('img')?.getAttribute('src')?.trim() ?? null
      ),
      sourceUrl
    ),
    bodyMarkdown,
    warnings
  }
}

function buildClipMarkdownDocument(clip: ExtractedWebClip): string {
  const sections = [
    `# ${clip.title}`,
    `Source URL: ${clip.sourceUrl}`
  ]

  if (clip.excerpt) {
    sections.push(`> ${clip.excerpt}`)
  }

  sections.push('---')
  sections.push(clip.bodyMarkdown)

  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n')
}

function buildFallbackBlocks(clip: ExtractedWebClip): DocumentBlockDraft[] {
  return [
    {
      type: 'heading-1',
      content: clip.title,
      checked: false,
      depth: 0,
      parentBlockId: null
    },
    {
      type: 'paragraph',
      content: `Source URL: ${clip.sourceUrl}`,
      checked: false,
      depth: 0,
      parentBlockId: null
    },
    {
      type: 'paragraph',
      content: clip.bodyMarkdown,
      checked: false,
      depth: 0,
      parentBlockId: null
    }
  ]
}

function toDocumentDraftBlocks(blocks: ReturnType<typeof parseMarkdownBackupDocument>['blocks']): DocumentBlockDraft[] {
  return blocks.map((block) => ({
    id: block.id,
    type: block.type,
    content: block.content,
    checked: Boolean(block.checked),
    depth: block.depth ?? 0,
    parentBlockId: block.parentBlockId ?? null,
    tags: block.tags,
    language: block.language ?? undefined,
    highlight: block.highlight
  }))
}

function createTurndownService(): TurndownService {
  return new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    headingStyle: 'atx'
  })
}

function removeNoisyNodes(document: Document): void {
  document.querySelectorAll('script, style, noscript, template, iframe').forEach((node) => node.remove())
}

function absolutizeDocumentUrls(document: Document, baseUrl: string): void {
  document.querySelectorAll('[href]').forEach((element) => {
    const href = element.getAttribute('href')?.trim()
    const nextHref = absolutizeUrl(href ?? null, baseUrl)
    if (nextHref) {
      element.setAttribute('href', nextHref)
    }
  })

  document.querySelectorAll('[src]').forEach((element) => {
    const src = element.getAttribute('src')?.trim()
    const nextSrc = absolutizeUrl(src ?? null, baseUrl)
    if (nextSrc) {
      element.setAttribute('src', nextSrc)
    }
  })
}

function getMetaContent(document: Document, ...selectors: string[]): string | null {
  for (const selector of selectors) {
    const content = document.querySelector(selector)?.getAttribute('content')?.trim()
    if (content) {
      return content
    }
  }

  return null
}

function stripDuplicateLeadingTitle(markdown: string, title: string): string {
  const trimmed = markdown.trim()
  if (!trimmed) {
    return ''
  }

  const escapedTitle = escapeRegExp(title.trim())
  return trimmed
    .replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, 'i'), '')
    .replace(new RegExp(`^${escapedTitle}\\s*\\n+`, 'i'), '')
    .trim()
}

function normalizeWebUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim())
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs are supported for web clipping.')
  }

  return url.toString()
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeExcerpt(value: string | null | undefined): string {
  const excerpt = normalizeWhitespace(value ?? '')
  if (!excerpt) {
    return ''
  }

  return excerpt.length > 180 ? `${excerpt.slice(0, 177).trimEnd()}...` : excerpt
}

function normalizeTitle(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value ?? '')
  return normalized || null
}

function normalizeDateValue(value: string | null): string | null {
  if (!value) {
    return null
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return value.trim() || null
  }

  return new Date(parsed).toISOString().slice(0, 10)
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function absolutizeUrl(value: string | null, baseUrl: string): string | null {
  if (!value) {
    return null
  }

  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return value
  }
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return value
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}