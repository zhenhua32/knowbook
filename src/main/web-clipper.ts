import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'
import type {
  ClipWebPageInput,
  ClipWebPageResult,
  DocumentBlockDraft,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType,
  ImportWebClipPayloadInput
} from '@shared/contracts'
import { parseMarkdownBackupDocument } from '@shared/markdown'
import { DEFAULT_DOCUMENT_SUMMARY, KnowbookStore } from './database/store'

const WEB_CLIP_TIMEOUT_MS = 15_000
const WEB_CLIP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 KnowBook/0.1'
const WEB_CLIP_MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 KnowBook/0.1'
const MAX_HTML_BYTES = 5 * 1024 * 1024
const MAX_ASSET_BYTES = 20 * 1024 * 1024
const MAX_REDIRECTS = 5
const MAX_LOCALIZED_IMAGES = 50
const ASSET_DOWNLOAD_CONCURRENCY = 4
const MAX_WEB_URL_BYTES = 8 * 1024
const MAX_WEB_CLIP_METADATA_BYTES = 32 * 1024

type WebClipperOptions = {
  allowPrivateNetwork?: boolean
}

type WebClipFieldKey =
  | 'sourceUrl'
  | 'sourceSite'
  | 'clippedAt'
  | 'publishedAt'
  | 'author'
  | 'clipStatus'
  | 'coverImage'
  | 'clipHash'

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
  contentHash: string
  warnings: string[]
}

type ExtractedWebClipOverrides = Pick<ImportWebClipPayloadInput,
  'author'
  | 'coverImage'
  | 'excerpt'
  | 'publishedAt'
  | 'sourceSite'
  | 'title'
>

type StructuredArticleData = {
  title: string | null
  description: string | null
  author: string | null
  publishedAt: string | null
  sourceSite: string | null
  image: string | null
}

const WEB_CLIP_FIELDS: WebClipFieldDefinition[] = [
  { key: 'sourceUrl', name: 'Source URL', type: 'text' },
  { key: 'sourceSite', name: 'Source Site', type: 'text' },
  { key: 'clippedAt', name: 'Clipped At', type: 'date' },
  { key: 'publishedAt', name: 'Published At', type: 'date' },
  { key: 'author', name: 'Author', type: 'text' },
  { key: 'clipStatus', name: 'Clip Status', type: 'select', options: ['clipped', 'partial'] },
  { key: 'coverImage', name: 'Cover Image', type: 'text' },
  { key: 'clipHash', name: 'Clip Hash', type: 'text' }
]

export class WebClipperService {
  constructor(
    private readonly store: KnowbookStore,
    private readonly assetRoot: string,
    private readonly options: WebClipperOptions = {}
  ) {}

  async clipWebPage(input: ClipWebPageInput): Promise<ClipWebPageResult> {
    const normalizedInput = normalizeClipWebPageInput(input)
    const sourceUrl = normalizeWebUrl(normalizedInput.url)
    const fetched = await fetchHtmlDocument(sourceUrl, Boolean(this.options.allowPrivateNetwork))
    const extracted = extractWebClip(fetched.html, fetched.documentUrl)
    const canonicalized = fetched.canonicalUrl === extracted.sourceUrl
      ? extracted
      : {
        ...extracted,
        sourceUrl: fetched.canonicalUrl,
        contentHash: hashClipContent(fetched.canonicalUrl, extracted.title, extracted.bodyMarkdown)
      }
    const clip = await finalizeExtractedWebClip(canonicalized, this.assetRoot, Boolean(this.options.allowPrivateNetwork))
    return this.persistClip(normalizedInput.parentId, clip)
  }

  async importWebClipPayload(input: ImportWebClipPayloadInput): Promise<ClipWebPageResult> {
    const normalizedInput = normalizeImportWebClipPayload(input)
    const sourceUrl = normalizeWebUrl(normalizedInput.url)

    let clip: ExtractedWebClip
    if (normalizedInput.html?.trim()) {
      clip = extractWebClip(normalizedInput.html, sourceUrl, {
        author: normalizedInput.author,
        coverImage: normalizedInput.coverImage,
        excerpt: normalizedInput.excerpt,
        publishedAt: normalizedInput.publishedAt,
        sourceSite: normalizedInput.sourceSite,
        title: normalizedInput.title
      })
    } else {
      clip = buildExtractedClipFromPayload(normalizedInput, sourceUrl, normalizeImportedBody(normalizedInput))
    }

    const finalized = await finalizeExtractedWebClip(clip, this.assetRoot, Boolean(this.options.allowPrivateNetwork))
    return this.persistClip(normalizedInput.parentId, finalized)
  }

  private async persistClip(parentId: string | null, clip: ExtractedWebClip): Promise<ClipWebPageResult> {
    return this.store.runInTransaction(() => {
      const columns = this.ensureWebClipColumns()
      const duplicateDocumentId = this.findDuplicateDocumentId(clip, columns)
      if (duplicateDocumentId) {
        const snapshot = this.store.getDocumentSnapshot(duplicateDocumentId)
        return {
          documentId: duplicateDocumentId,
          title: snapshot?.title ?? clip.title,
          sourceUrl: clip.sourceUrl,
          warnings: [...clip.warnings],
          created: false,
          duplicateOfDocumentId: duplicateDocumentId
        }
      }

      const documentId = this.store.createDocument(parentId)
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
        { columnId: columns.coverImage.id, value: clip.coverImage },
        { columnId: columns.clipHash.id, value: clip.contentHash }
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
        warnings: [...clip.warnings],
        created: true,
        duplicateOfDocumentId: null
      }
    })
  }

  private ensureWebClipColumns(): Record<WebClipFieldKey, DocumentDatabaseColumn> {
    const existingColumns = this.store.getDocumentDatabaseColumns()
    const byNameAndType = new Map(existingColumns.map((column) => [
      `${column.name.toLowerCase()}\u0000${column.type}`,
      column
    ]))
    const resolved = {} as Record<WebClipFieldKey, DocumentDatabaseColumn>

    for (const definition of WEB_CLIP_FIELDS) {
      const signature = `${definition.name.toLowerCase()}\u0000${definition.type}`
      let column = byNameAndType.get(signature)

      if (!column) {
        column = this.store.createDocumentDatabaseColumn({
          name: definition.name,
          type: definition.type,
          options: definition.options
        })
        byNameAndType.set(signature, column)
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

  private findDuplicateDocumentId(clip: ExtractedWebClip, columns: Record<WebClipFieldKey, DocumentDatabaseColumn>): string | null {
    const bySourceUrl = new Set(this.store.findDocumentIdsByDatabaseValue(columns.sourceUrl.id, clip.sourceUrl))
    if (bySourceUrl.size === 0) {
      return null
    }

    const byHash = this.store.findDocumentIdsByDatabaseValue(columns.clipHash.id, clip.contentHash)
    return byHash.find((documentId) => bySourceUrl.has(documentId)) ?? null
  }
}

async function fetchHtmlDocument(
  url: string,
  allowPrivateNetwork: boolean
): Promise<{ html: string; documentUrl: string; canonicalUrl: string }> {
  const candidates = buildWebFetchCandidates(url)
  let lastFailure: Error | null = null

  for (const [index, candidateUrl] of candidates.entries()) {
    try {
      const response = await fetchWithValidatedRedirects(candidateUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
          Referer: new URL('/', candidateUrl).toString(),
          'User-Agent': index === 0 ? WEB_CLIP_USER_AGENT : WEB_CLIP_MOBILE_USER_AGENT
        },
        signal: AbortSignal.timeout(WEB_CLIP_TIMEOUT_MS)
      }, allowPrivateNetwork)

      if (!response.ok) {
        lastFailure = new Error(`Failed to fetch webpage (${response.status}).`)
        continue
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        lastFailure = new Error(`Unsupported page type: ${contentType || 'unknown'}`)
        continue
      }

      const html = (await readResponseBody(response, MAX_HTML_BYTES)).toString('utf8')
      if (!html.trim()) {
        lastFailure = new Error('Fetched webpage is empty.')
        continue
      }
      if (looksLikeScriptChallenge(html)) {
        lastFailure = new Error('The webpage requires browser execution before its article content is available.')
        continue
      }

      return {
        html,
        documentUrl: response.url || candidateUrl,
        canonicalUrl: index === 0 ? (response.url || url) : url
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw lastFailure ?? new Error('Failed to fetch webpage.')
}

function buildWebFetchCandidates(url: string): string[] {
  const candidates = [url]

  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'www.expreview.com') {
      const mobileUrl = new URL(parsed.toString())
      mobileUrl.hostname = 'm.expreview.com'
      candidates.push(mobileUrl.toString())
    }
  } catch {
    // URL validation reports malformed values before fetching.
  }

  return candidates
}

function looksLikeScriptChallenge(html: string): boolean {
  const normalized = html.replace(/^\uFEFF/, '').trim()
  if (/<script[^>]+src=["'][^"']*(?:_guard|challenge|captcha)[^"']*["'][^>]*>\s*<\/script>/i.test(normalized)) {
    return true
  }

  const withoutScripts = normalized
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '')

  return normalized.length < 2_048 && withoutScripts.length < 80
}

function extractWebClip(html: string, sourceUrl: string, overrides: ExtractedWebClipOverrides = {}): ExtractedWebClip {
  const dom = new JSDOM(html, { url: sourceUrl })
  const { document } = dom.window
  const structuredData = extractStructuredArticleData(document)
  const rawDocumentTitle = normalizeWhitespace(document.title)
  const primaryHeading = normalizeWhitespace(document.querySelector('h1')?.textContent ?? '')

  materializeScriptDataTables(document)
  removeNoisyNodes(document)
  normalizeDocumentImages(document, sourceUrl)
  absolutizeDocumentUrls(document, sourceUrl)

  const warnings: string[] = []
  const readability = new Readability(document.cloneNode(true) as Document)
  const article = readability.parse()
  const fallbackArticle = findBestArticleCandidate(document)
  const articleContent = chooseRicherArticleContent(
    article?.content?.trim() ?? '',
    fallbackArticle?.outerHTML.trim() ?? '',
    sourceUrl
  )
  const articleText = normalizeWhitespace(article?.textContent ?? fallbackArticle?.textContent ?? '')
  const inferredSiteName = inferSiteName(rawDocumentTitle, primaryHeading)
  const overrideSourceSite = normalizeNullableText(overrides.sourceSite)
  const sourceSite = firstNonEmpty(
    isHostnameLike(overrideSourceSite) ? null : overrideSourceSite,
    structuredData.sourceSite,
    getMetaContent(document, 'meta[property="og:site_name"]', 'meta[name="application-name"]'),
    inferredSiteName,
    inferKnownSiteName(sourceUrl),
    overrideSourceSite,
    safeHostname(sourceUrl)
  ) ?? safeHostname(sourceUrl)
  const title = cleanClipTitle(firstNonEmpty(
    overrides.title,
    structuredData.title,
    normalizeTitle(getMetaContent(document, 'meta[property="og:title"]', 'meta[name="twitter:title"]')),
    primaryHeading,
    normalizeTitle(article?.title),
    normalizeTitle(document.title),
    sourceSite,
    safeHostname(sourceUrl)
  ) ?? safeHostname(sourceUrl), sourceSite, safeHostname(sourceUrl))

  let bodyMarkdown = ''
  let articleImageUrl: string | null = null
  if (articleContent) {
    const articleDom = new JSDOM(`<body>${articleContent}</body>`, { url: sourceUrl })
    prepareArticleDocument(articleDom.window.document, sourceUrl)
    articleImageUrl = findBestArticleImage(articleDom.window.document, sourceUrl)
    const preservedBlocks = preserveStructuredBlocks(articleDom.window.document)
    bodyMarkdown = createTurndownService().turndown(articleDom.window.document.body.innerHTML).trim()
    bodyMarkdown = restoreStructuredBlocks(bodyMarkdown, preservedBlocks)
    bodyMarkdown = stripDuplicateLeadingTitle(bodyMarkdown, title)
    bodyMarkdown = cleanExtractedMarkdown(bodyMarkdown)
  }

  if (!bodyMarkdown) {
    const fallbackText = normalizeWhitespace(
      article?.textContent
      ?? fallbackArticle?.textContent
      ?? document.body?.textContent
      ?? ''
    )
    if (!fallbackText) {
      throw new Error('Could not extract readable text from this webpage.')
    }

    bodyMarkdown = fallbackText
    warnings.push('Readable article extraction fell back to plain page text.')
  }

  const excerpt = pickUsefulExcerpt([
    article?.excerpt,
    structuredData.description,
    overrides.excerpt,
    getMetaContent(document, 'meta[name="description"]', 'meta[property="og:description"]')
  ], title, articleText)
  const coverImage = pickBestCoverImage([
    articleImageUrl,
    structuredData.image,
    getMetaContent(document, 'meta[property="og:image"]', 'meta[name="twitter:image"]'),
    overrides.coverImage,
    findBestArticleImage(document, sourceUrl)
  ], sourceUrl)

  return {
    title,
    sourceUrl,
    sourceSite,
    excerpt,
    author: firstNonEmpty(
      structuredData.author,
      normalizeWhitespace(article?.byline ?? ''),
      normalizeWhitespace(overrides.author ?? ''),
      getMetaContent(document, 'meta[name="author"]', 'meta[property="article:author"]')
    ),
    publishedAt: normalizeDateValue(firstNonEmpty(
      structuredData.publishedAt,
      overrides.publishedAt,
      getMetaContent(document, 'meta[property="article:published_time"]', 'meta[name="date"]', 'meta[name="publish-date"]'),
      document.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ?? null
    )),
    coverImage,
    bodyMarkdown,
    contentHash: hashClipContent(sourceUrl, title, bodyMarkdown),
    warnings
  }
}

function buildExtractedClipFromPayload(input: ImportWebClipPayloadInput, sourceUrl: string, bodyMarkdown: string): ExtractedWebClip {
  const hostname = safeHostname(sourceUrl)
  const inferredSite = inferSiteName(normalizeWhitespace(input.title ?? ''), '')
  const sourceSite = firstNonEmpty(
    isHostnameLike(normalizeNullableText(input.sourceSite)) ? null : input.sourceSite,
    inferredSite,
    input.sourceSite,
    hostname
  ) ?? hostname
  const title = cleanClipTitle(firstNonEmpty(input.title, hostname, sourceUrl) ?? sourceUrl, sourceSite, hostname)
  const cleanedBody = cleanExtractedMarkdown(bodyMarkdown)

  return {
    title,
    sourceUrl,
    sourceSite,
    excerpt: normalizeExcerpt(input.excerpt),
    author: normalizeNullableText(input.author),
    publishedAt: normalizeDateValue(input.publishedAt ?? null),
    coverImage: pickBestCoverImage([input.coverImage], sourceUrl),
    bodyMarkdown: cleanedBody,
    contentHash: hashClipContent(sourceUrl, title, cleanedBody),
    warnings: []
  }
}

async function finalizeExtractedWebClip(clip: ExtractedWebClip, assetRoot: string, allowPrivateNetwork: boolean): Promise<ExtractedWebClip> {
  const warnings = [...clip.warnings]
  const imageUrls = [...new Set(extractMarkdownImageUrls(clip.bodyMarkdown))]
    .filter((url) => !isEphemeralUrl(url))
  const resolvedImageUrls = new Map<string, string>()

  if (imageUrls.length > MAX_LOCALIZED_IMAGES) {
    warnings.push(`Skipped ${imageUrls.length - MAX_LOCALIZED_IMAGES} images because the clip exceeded the image limit.`)
  }

  const failedImageUrls: string[] = []
  await mapWithConcurrency(
    imageUrls.slice(0, MAX_LOCALIZED_IMAGES),
    ASSET_DOWNLOAD_CONCURRENCY,
    async (imageUrl) => {
      try {
        resolvedImageUrls.set(
          imageUrl,
          await localizeAssetUrl(imageUrl, assetRoot, allowPrivateNetwork, clip.sourceUrl)
        )
      } catch {
        failedImageUrls.push(imageUrl)
      }
    }
  )
  if (failedImageUrls.length > 0) {
    warnings.push(`Removed ${failedImageUrls.length} unavailable image${failedImageUrls.length === 1 ? '' : 's'} from the clip.`)
    console.warn(`Removed ${failedImageUrls.length} unavailable clipped image${failedImageUrls.length === 1 ? '' : 's'}.`)
  }

  let coverImage = clip.coverImage
  if (coverImage) {
    try {
      coverImage = await localizeAssetUrl(coverImage, assetRoot, allowPrivateNetwork, clip.sourceUrl)
    } catch (error) {
      warnings.push('Removed the unavailable cover image from the clip.')
      console.warn('Failed to localize clipped cover image.', error)
      coverImage = null
    }
  }

  return {
    ...clip,
    coverImage,
    bodyMarkdown: removeMarkdownImagesByUrls(
      replaceMarkdownImageUrls(clip.bodyMarkdown, resolvedImageUrls),
      new Set(failedImageUrls)
    ),
    warnings
  }
}

function buildClipMarkdownDocument(clip: ExtractedWebClip): string {
  const sections = [
    `# ${clip.title}`,
    `来源：[${escapeMarkdownLabel(clip.sourceSite)}](${formatMarkdownTarget(clip.sourceUrl)})`
  ]

  if (clip.coverImage && !markdownContainsImageUrl(clip.bodyMarkdown, clip.coverImage)) {
    sections.push(`![${escapeMarkdownLabel(clip.title)}](${formatMarkdownTarget(clip.coverImage)})`)
  }

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
  const blocks: DocumentBlockDraft[] = [
    {
      type: 'heading-1',
      content: clip.title,
      checked: false,
      depth: 0,
      parentBlockId: null
    },
    {
      type: 'paragraph',
      content: `来源：[${escapeMarkdownLabel(clip.sourceSite)}](${formatMarkdownTarget(clip.sourceUrl)})`,
      checked: false,
      depth: 0,
      parentBlockId: null
    }
  ]

  if (clip.coverImage && !markdownContainsImageUrl(clip.bodyMarkdown, clip.coverImage)) {
    blocks.push({
      type: 'paragraph',
      content: `![${escapeMarkdownLabel(clip.title)}](${formatMarkdownTarget(clip.coverImage)})`,
      checked: false,
      depth: 0,
      parentBlockId: null
    })
  }

  blocks.push({
    type: 'paragraph',
    content: clip.bodyMarkdown,
    checked: false,
    depth: 0,
    parentBlockId: null
  })

  return blocks
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
  const service = new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    headingStyle: 'atx',
    strongDelimiter: '**'
  })

  service.remove(['button', 'canvas', 'form', 'input', 'select', 'textarea'])
  service.remove((node) => node.nodeName.toLowerCase() === 'svg')
  service.addRule('clean-image', {
    filter: 'img',
    replacement: (_content, node) => {
      const image = node as HTMLImageElement
      const source = image.getAttribute('src')?.trim() ?? ''
      if (!source || isEphemeralUrl(source) || isLikelyPlaceholderImage(source)) {
        return ''
      }

      const alt = escapeMarkdownLabel(image.getAttribute('alt')?.trim() || deriveImageLabel(source))
      return `\n\n![${alt}](${formatMarkdownTarget(source)})\n\n`
    }
  })
  service.addRule('markdown-table', {
    filter: 'table',
    replacement: (_content, node) => `\n\n${convertHtmlTableToMarkdown(node as HTMLTableElement)}\n\n`
  })

  return service
}

function removeNoisyNodes(document: Document): void {
  document.querySelectorAll([
    'script',
    'style',
    'noscript',
    'template',
    'iframe',
    'form',
    'dialog',
    '[aria-hidden="true"]',
    '[hidden]'
  ].join(',')).forEach((node) => node.remove())
}

function materializeScriptDataTables(document: Document): void {
  const chartScripts = Array.from(document.querySelectorAll('script'))
    .filter((script) => /\bdata_arr\s*=\s*\[/i.test(script.textContent ?? ''))
    .slice(0, 30)

  for (const script of chartScripts) {
    const source = script.textContent ?? ''
    const dataMatch = source.match(/\bdata_arr\s*=\s*(\[[\s\S]*?\])\s*;/i)
    if (!dataMatch?.[1]) {
      continue
    }

    let rows: Array<Record<string, string | number | boolean | null>>
    try {
      const parsed = JSON.parse(dataMatch[1]) as unknown
      if (!Array.isArray(parsed)) {
        continue
      }
      rows = parsed
        .filter((row): row is Record<string, string | number | boolean | null> => (
          Boolean(row)
          && typeof row === 'object'
          && !Array.isArray(row)
          && Object.values(row as Record<string, unknown>)
            .every((value) => value == null || ['string', 'number', 'boolean'].includes(typeof value))
        ))
        .slice(0, 200)
    } catch {
      continue
    }
    if (rows.length === 0) {
      continue
    }

    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 20)
    if (headers.length === 0) {
      continue
    }

    const title = readScriptStringVariable(source, 'title_text')
    const unit = readScriptStringVariable(source, 'unit_text')
    const section = document.createElement('section')
    section.className = 'knowbook-script-data-table'
    if (title) {
      const heading = document.createElement('h3')
      heading.textContent = title
      section.append(heading)
    }
    if (unit) {
      const unitLabel = document.createElement('p')
      unitLabel.textContent = `单位：${unit}`
      section.append(unitLabel)
    }

    const table = document.createElement('table')
    const tableHead = document.createElement('thead')
    const headerRow = document.createElement('tr')
    headers.forEach((header, index) => {
      const cell = document.createElement('th')
      cell.textContent = index === 0 && header.toLowerCase() === 'type' ? '项目' : header.trim()
      headerRow.append(cell)
    })
    tableHead.append(headerRow)
    table.append(tableHead)

    const tableBody = document.createElement('tbody')
    rows.forEach((row) => {
      const tableRow = document.createElement('tr')
      headers.forEach((header) => {
        const cell = document.createElement('td')
        const value = row[header]
        cell.textContent = value == null ? '' : normalizeWhitespace(String(value))
        tableRow.append(cell)
      })
      tableBody.append(tableRow)
    })
    table.append(tableBody)
    section.append(table)
    script.before(section)
  }
}

function readScriptStringVariable(source: string, variableName: string): string | null {
  const escapedName = escapeRegExp(variableName)
  const match = source.match(new RegExp(`\\b${escapedName}\\s*=\\s*("(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*')\\s*;`, 'i'))
  const literal = match?.[1]
  if (!literal) {
    return null
  }

  try {
    if (literal.startsWith('"')) {
      return normalizeNullableText(JSON.parse(literal) as string)
    }

    return normalizeNullableText(
      literal.slice(1, -1)
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
    )
  } catch {
    return null
  }
}

function prepareArticleDocument(document: Document, sourceUrl: string): void {
  removeNoisyNodes(document)
  normalizeDocumentImages(document, sourceUrl)
  absolutizeDocumentUrls(document, sourceUrl)
  normalizeArticleHeadings(document)
  cleanArticleImages(document)
  unwrapImageLinks(document)
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

function normalizeDocumentImages(document: Document, baseUrl: string): void {
  const images = Array.from(document.querySelectorAll('img'))

  images.forEach((image, index) => {
    const source = resolveImageSource(image, baseUrl)
    if (!source) {
      removeImageAndEmptyWrapper(image)
      return
    }

    image.setAttribute('src', source)
    image.removeAttribute('srcset')
    for (const attribute of [
      'data-src',
      'data-srcset',
      'data-original',
      'data-lazy-src',
      'data-lazy',
      'data-url',
      'data-actualsrc'
    ]) {
      image.removeAttribute(attribute)
    }
    image.classList.remove('lazy', 'lazyload', 'lazyloaded')

    if (!image.getAttribute('alt')?.trim()) {
      image.setAttribute('alt', deriveImageAlt(image, source, index))
    }
  })
}

function resolveImageSource(image: HTMLImageElement, baseUrl: string): string | null {
  const pictureSources = Array.from(image.closest('picture')?.querySelectorAll('source') ?? [])
    .flatMap((source) => [
      source.getAttribute('data-srcset'),
      source.getAttribute('srcset')
    ])
  const directCandidates = [
    image.getAttribute('data-original'),
    image.getAttribute('data-src'),
    image.getAttribute('data-lazy-src'),
    image.getAttribute('data-url'),
    image.getAttribute('data-actualsrc'),
    image.getAttribute('data-srcset'),
    ...pictureSources,
    image.getAttribute('srcset'),
    image.getAttribute('src')
  ]
  const anchorCandidate = image.closest('a[href]')?.getAttribute('href') ?? null
  const normalizedCandidates = directCandidates
    .flatMap((candidate) => expandImageCandidate(candidate))
    .map((candidate) => absolutizeUrl(candidate, baseUrl))
    .filter((candidate): candidate is string => Boolean(candidate))

  const preferred = normalizedCandidates.find((candidate) => (
    !isEphemeralUrl(candidate) && !isLikelyPlaceholderImage(candidate)
  ))
  if (preferred) {
    return preferred
  }

  const normalizedAnchor = absolutizeUrl(decodePossibleEncodedUrl(anchorCandidate), baseUrl)
  if (normalizedAnchor && !isEphemeralUrl(normalizedAnchor) && !isLikelyPlaceholderImage(normalizedAnchor)) {
    return normalizedAnchor
  }

  return null
}

function expandImageCandidate(value: string | null): string[] {
  const decoded = decodePossibleEncodedUrl(value)
  if (!decoded) {
    return []
  }

  if (!decoded.includes(',')) {
    return [decoded]
  }

  const srcsetCandidates = decoded
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)

  return srcsetCandidates.reverse()
}

function decodePossibleEncodedUrl(value: string | null): string | null {
  const normalized = value?.trim().replace(/^['"]|['"]$/g, '') ?? ''
  if (!normalized) {
    return null
  }
  if (/^(?:https?:|file:|data:image\/|\/|\.\/|\.\.\/)/i.test(normalized)) {
    return normalized
  }

  if (/^[A-Za-z0-9+/=_-]{20,}$/.test(normalized)) {
    try {
      const decoded = Buffer.from(normalized.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
        .toString('utf8')
        .trim()
      if (/^(?:https?:|\/|\.\/|\.\.\/)/i.test(decoded)) {
        return decoded
      }
    } catch {
      // Keep the original value when it was not a valid encoded URL.
    }
  }

  return normalized
}

function cleanArticleImages(document: Document): void {
  const seenSources = new Set<string>()

  for (const image of Array.from(document.querySelectorAll('img'))) {
    const source = image.getAttribute('src')?.trim() ?? ''
    if (
      !source
      || isEphemeralUrl(source)
      || isLikelyPlaceholderImage(source)
      || isTinyTrackingImage(image)
      || seenSources.has(source)
    ) {
      removeImageAndEmptyWrapper(image)
      continue
    }

    seenSources.add(source)
  }
}

function removeImageAndEmptyWrapper(image: Element): void {
  const parent = image.parentElement
  image.remove()

  if (
    parent
    && ['A', 'FIGURE', 'P', 'PICTURE', 'SPAN'].includes(parent.tagName)
    && !parent.textContent?.trim()
    && parent.querySelectorAll('img').length === 0
  ) {
    parent.remove()
  }
}

function unwrapImageLinks(document: Document): void {
  for (const link of Array.from(document.querySelectorAll('a[href]'))) {
    const image = link.querySelector(':scope > img')
    if (!image || link.children.length !== 1 || link.textContent?.trim()) {
      continue
    }

    link.replaceWith(image)
  }
}

function normalizeArticleHeadings(document: Document): void {
  for (const heading of Array.from(document.querySelectorAll('h1'))) {
    const replacement = document.createElement('h2')
    for (const attribute of Array.from(heading.attributes)) {
      replacement.setAttribute(attribute.name, attribute.value)
    }
    replacement.innerHTML = heading.innerHTML
    heading.replaceWith(replacement)
  }
}

function preserveStructuredBlocks(document: Document): Map<string, string> {
  const replacements = new Map<string, string>()
  const elements = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,table'))

  elements.forEach((element, index) => {
    const token = `KNOWBOOKPRESERVEDBLOCK${index}TOKEN`
    let markdown = ''
    if (element.tagName === 'TABLE') {
      markdown = convertHtmlTableToMarkdown(element as HTMLTableElement)
    } else {
      const content = normalizeWhitespace(element.textContent ?? '')
      const level = element.tagName === 'H1' ? '#' : '##'
      markdown = content ? `${level} ${content}` : ''
    }

    if (!markdown) {
      element.remove()
      return
    }

    replacements.set(token, markdown)
    const placeholder = document.createElement('p')
    placeholder.textContent = token
    element.replaceWith(placeholder)
  })

  return replacements
}

function restoreStructuredBlocks(markdown: string, replacements: Map<string, string>): string {
  let restored = markdown
  for (const [token, replacement] of replacements) {
    restored = restored.replaceAll(token, `\n\n${replacement}\n\n`)
  }
  return restored
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

function extractStructuredArticleData(document: Document): StructuredArticleData {
  const empty: StructuredArticleData = {
    title: null,
    description: null,
    author: null,
    publishedAt: null,
    sourceSite: null,
    image: null
  }

  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    const rawJson = script.textContent?.trim()
    if (!rawJson) {
      continue
    }

    try {
      const parsed = JSON.parse(rawJson) as unknown
      const candidates = flattenStructuredData(parsed)
      const article = candidates.find((candidate) => {
        const type = candidate['@type']
        const types = Array.isArray(type) ? type : [type]
        return types.some((value) => typeof value === 'string' && /article|posting|report|review/i.test(value))
      })
      if (!article) {
        continue
      }

      return {
        title: normalizeNullableText(readStructuredString(article.headline) ?? readStructuredString(article.name)),
        description: normalizeNullableText(readStructuredString(article.description)),
        author: normalizeNullableText(readStructuredPersonName(article.author)),
        publishedAt: normalizeNullableText(readStructuredString(article.datePublished)),
        sourceSite: normalizeNullableText(readStructuredPersonName(article.publisher)),
        image: normalizeNullableText(readStructuredImage(article.image))
      }
    } catch {
      // Ignore malformed third-party structured data.
    }
  }

  return empty
}

function flattenStructuredData(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenStructuredData(entry))
  }
  if (!value || typeof value !== 'object') {
    return []
  }

  const record = value as Record<string, unknown>
  const graph = Array.isArray(record['@graph']) ? flattenStructuredData(record['@graph']) : []
  return [record, ...graph]
}

function readStructuredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readStructuredPersonName(value: unknown): string | null {
  if (Array.isArray(value)) {
    return value
      .map((entry) => readStructuredPersonName(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join(', ') || null
  }
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (value && typeof value === 'object') {
    return readStructuredString((value as Record<string, unknown>).name)
  }

  return null
}

function readStructuredImage(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const image = readStructuredImage(entry)
      if (image) {
        return image
      }
    }
    return null
  }
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return readStructuredString(record.url) ?? readStructuredString(record.contentUrl)
  }

  return null
}

function findBestArticleCandidate(document: Document): Element | null {
  const selectors = [
    'article',
    'main',
    '[role="main"]',
    '#post_body',
    '#article',
    '#content',
    '.article-content',
    '.article-body',
    '.entry-content',
    '.post-content',
    '.news-content',
    '.newsCo'
  ]
  const candidates = [...new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))]
  let best: { element: Element; score: number } | null = null

  for (const element of candidates) {
    const textLength = normalizeWhitespace(element.textContent ?? '').length
    if (textLength < 120) {
      continue
    }

    const paragraphCount = element.querySelectorAll('p').length
    const headingCount = element.querySelectorAll('h1,h2,h3').length
    const imageCount = element.querySelectorAll('img').length
    const linkTextLength = Array.from(element.querySelectorAll('a'))
      .reduce((total, link) => total + normalizeWhitespace(link.textContent ?? '').length, 0)
    const linkDensity = linkTextLength / Math.max(1, textLength)
    const score = textLength + paragraphCount * 100 + headingCount * 60 + imageCount * 40 - linkDensity * textLength * 1.5

    if (!best || score > best.score) {
      best = { element, score }
    }
  }

  return best?.element ?? null
}

function chooseRicherArticleContent(readabilityContent: string, fallbackContent: string, sourceUrl: string): string {
  if (!readabilityContent) {
    return fallbackContent
  }
  if (!fallbackContent) {
    return readabilityContent
  }

  const measure = (content: string) => {
    const candidateDom = new JSDOM(`<body>${content}</body>`, { url: sourceUrl })
    const candidateDocument = candidateDom.window.document
    return {
      textLength: normalizeWhitespace(candidateDocument.body.textContent ?? '').length,
      richElements: candidateDocument.querySelectorAll('img,table,pre,blockquote,h1,h2,h3,figure').length,
      images: candidateDocument.querySelectorAll('img').length,
      tables: candidateDocument.querySelectorAll('table').length
    }
  }
  const readableMetrics = measure(readabilityContent)
  const fallbackMetrics = measure(fallbackContent)
  if (
    fallbackMetrics.textLength >= readableMetrics.textLength * 0.75
    && (
      fallbackMetrics.richElements > readableMetrics.richElements
      || fallbackMetrics.images > readableMetrics.images
      || fallbackMetrics.tables > readableMetrics.tables
    )
  ) {
    return fallbackContent
  }

  return readabilityContent
}

function inferSiteName(documentTitle: string, primaryHeading: string): string | null {
  const segments = documentTitle
    .split(/\s+(?:[-–—|·])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.length < 2) {
    return null
  }

  const suffix = segments.at(-1) ?? ''
  const prefix = segments.slice(0, -1).join(' ')
  if (
    suffix.length > 40
    || suffix.length >= prefix.length
    || (primaryHeading && normalizeComparableText(primaryHeading).includes(normalizeComparableText(suffix)))
  ) {
    return null
  }

  return suffix
}

function cleanClipTitle(value: string, sourceSite: string, hostname: string): string {
  const normalized = normalizeWhitespace(value)
  const segments = normalized
    .split(/\s+(?:[-–—|·])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.length < 2) {
    return normalized
  }

  const suffix = segments.at(-1) ?? ''
  const prefix = segments.slice(0, -1).join(' ')
  const suffixComparable = normalizeComparableText(suffix)
  const siteComparable = normalizeComparableText(sourceSite)
  const hostnameComparable = normalizeComparableText(hostname.replace(/^www\./i, '').split('.')[0] ?? hostname)
  const isKnownSiteSuffix = Boolean(suffixComparable) && (
    siteComparable.includes(suffixComparable)
    || suffixComparable.includes(siteComparable)
    || hostnameComparable === suffixComparable
  )

  return isKnownSiteSuffix && prefix.length >= 6 ? prefix : normalized
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/^www\./, '').replace(/[^\p{L}\p{N}]+/gu, '')
}

function isHostnameLike(value: string | null): boolean {
  return Boolean(value && /^(?:www\.)?[\w-]+(?:\.[\w-]+)+$/i.test(value))
}

function pickUsefulExcerpt(
  candidates: Array<string | null | undefined>,
  title: string,
  articleText: string
): string {
  for (const candidate of candidates) {
    const excerpt = normalizeExcerpt(candidate)
    if (isUsefulExcerpt(excerpt, title, articleText)) {
      return excerpt
    }
  }

  return ''
}

function isUsefulExcerpt(excerpt: string, title: string, articleText: string): boolean {
  if (!excerpt || excerpt.length < 20) {
    return false
  }

  const comparableExcerpt = normalizeComparableText(excerpt)
  if (!comparableExcerpt || comparableExcerpt === normalizeComparableText(title)) {
    return false
  }
  if (!articleText) {
    return true
  }

  const comparableArticle = normalizeComparableText(articleText)
  const excerptLead = comparableExcerpt.slice(0, Math.min(24, comparableExcerpt.length))
  return excerptLead.length >= 12 && comparableArticle.includes(excerptLead)
}

function findBestArticleImage(document: Document, sourceUrl: string): string | null {
  const root = findBestArticleCandidate(document) ?? document.body
  if (!root) {
    return null
  }

  const candidates = Array.from(root.querySelectorAll('img'))
    .map((image) => ({
      image,
      source: absolutizeUrl(image.getAttribute('src')?.trim() ?? null, sourceUrl)
    }))
    .filter((candidate): candidate is { image: HTMLImageElement; source: string } => Boolean(candidate.source))
    .filter(({ image, source }) => (
      !isEphemeralUrl(source)
      && !isLikelyPlaceholderImage(source)
      && !isTinyTrackingImage(image)
      && !isLikelyDecorativeImage(source, image)
    ))

  return candidates[0]?.source ?? null
}

function pickBestCoverImage(candidates: Array<string | null | undefined>, sourceUrl: string): string | null {
  for (const candidate of candidates) {
    const source = absolutizeUrl(decodePossibleEncodedUrl(candidate ?? null), sourceUrl)
    if (
      source
      && !isEphemeralUrl(source)
      && !isLikelyPlaceholderImage(source)
      && !isLikelyDecorativeImage(source)
    ) {
      return source
    }
  }

  return null
}

function isLikelyDecorativeImage(source: string, image?: HTMLImageElement): boolean {
  const normalizedSource = source.toLowerCase()
  const className = image?.className.toLowerCase() ?? ''
  const alt = image?.getAttribute('alt')?.toLowerCase() ?? ''
  return /(?:^|[/_.-])(avatar|favicon|icon|logo|qr|sprite|loading|placeholder)(?:[/_.-]|$)/i.test(normalizedSource)
    || /\b(?:avatar|icon|logo|emoji)\b/.test(className)
    || /^(?:logo|头像|图标)$/.test(alt)
}

function isTinyTrackingImage(image: HTMLImageElement): boolean {
  const width = Number(image.getAttribute('width'))
  const height = Number(image.getAttribute('height'))
  return Number.isFinite(width)
    && Number.isFinite(height)
    && width > 0
    && height > 0
    && width <= 48
    && height <= 48
}

function isLikelyPlaceholderImage(source: string): boolean {
  return /(?:^|[/_.-])(?:l\d{2,4}|loading|lazy|placeholder|spacer|transparent|blank)(?:[/_.-]|$)/i
    .test(source.split(/[?#]/)[0] ?? source)
}

function isEphemeralUrl(source: string): boolean {
  return /^(?:blob:|javascript:|about:)/i.test(source.trim())
}

function deriveImageAlt(image: HTMLImageElement, source: string, index: number): string {
  const caption = normalizeWhitespace(image.closest('figure')?.querySelector('figcaption')?.textContent ?? '')
  const title = normalizeWhitespace(image.getAttribute('title') ?? '')
  return firstNonEmpty(caption, title, deriveImageLabel(source), `Clipped image ${index + 1}`) ?? `Clipped image ${index + 1}`
}

function deriveImageLabel(source: string): string {
  try {
    const pathName = decodeURIComponent(new URL(source).pathname)
    const fileName = pathName.split('/').filter(Boolean).at(-1) ?? ''
    if (fileName && !/^[a-f0-9]{32,}\.[a-z0-9]+$/i.test(fileName)) {
      return fileName
    }
  } catch {
    // Fall through to a neutral image label.
  }

  return 'Clipped image'
}

function cleanExtractedMarkdown(markdown: string): string {
  const artifactLines = new Set(['预览', '展开全文', '收起', 'advertisement', '广告'])
  const lines = markdown
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .filter((line) => !artifactLines.has(line.trim().toLowerCase()))

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .trim()
}

function convertHtmlTableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll('tr'))
    .map((row) => Array.from(row.children)
      .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
      .map((cell) => escapeMarkdownTableCell(normalizeWhitespace(cell.textContent ?? ''))))
    .filter((row) => row.length > 0)
  if (rows.length === 0) {
    return ''
  }

  const columnCount = Math.max(...rows.map((row) => row.length))
  const normalizedRows = rows.map((row) => [
    ...row,
    ...Array.from({ length: Math.max(0, columnCount - row.length) }, () => '')
  ])
  const header = normalizedRows[0] ?? []
  const body = normalizedRows.slice(1)
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n')
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function formatMarkdownTarget(value: string): string {
  return /[\s()]/.test(value) ? `<${value}>` : value
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[[\]\\]/g, '\\$&')
}

function markdownContainsImageUrl(markdown: string, url: string): boolean {
  return extractMarkdownImageUrls(markdown).includes(url)
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

function normalizeImportedBody(input: ImportWebClipPayloadInput): string {
  const body = firstNonEmpty(input.markdown, input.text)
  if (!body) {
    throw new Error('Imported web clip payload is missing html, markdown, or text content.')
  }

  return body.trim()
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

function normalizeNullableText(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value ?? '')
  return normalized || null
}

function normalizeTitle(value: string | null | undefined): string | null {
  return normalizeNullableText(value)
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

  if (value.startsWith('data:') || value.startsWith('file:')) {
    return value
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

function inferKnownSiteName(value: string): string | null {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./i, '').toLowerCase()
    if (hostname === 'expreview.com' || hostname.endsWith('.expreview.com')) {
      return '超能网'
    }
  } catch {
    // Fall back to the raw hostname when URL parsing fails.
  }

  return null
}

function extractMarkdownImageUrls(markdown: string): string[] {
  const urls: string[] = []
  const regex = /!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g

  for (const match of markdown.matchAll(regex)) {
    const rawValue = match[1]?.trim() ?? ''
    const url = rawValue.replace(/^<|>$/g, '').trim()
    if (url) {
      urls.push(url)
    }
  }

  return urls
}

function replaceMarkdownImageUrls(markdown: string, replacements: Map<string, string>): string {
  let nextMarkdown = markdown

  for (const [sourceUrl, targetUrl] of replacements.entries()) {
    nextMarkdown = nextMarkdown.replaceAll(`](${sourceUrl})`, `](${targetUrl})`)
    nextMarkdown = nextMarkdown.replaceAll(`](<${sourceUrl}>)`, `](<${targetUrl}>)`)
  }

  return nextMarkdown
}

function removeMarkdownImagesByUrls(markdown: string, urls: Set<string>): string {
  if (urls.size === 0) {
    return markdown
  }

  return markdown
    .replace(
      /!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g,
      (match, rawTarget: string) => urls.has(rawTarget.replace(/^<|>$/g, '').trim()) ? '' : match
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function localizeAssetUrl(
  assetUrl: string,
  assetRoot: string,
  allowPrivateNetwork: boolean,
  sourceUrl: string
): Promise<string> {
  if (assetUrl.startsWith('file:')) {
    return assetUrl
  }

  if (assetUrl.startsWith('data:')) {
    const dataAsset = decodeDataImageUrl(assetUrl)
    return persistLocalizedAsset(dataAsset.buffer, assetRoot, dataAsset.extension)
  }

  const response = await fetchWithValidatedRedirects(assetUrl, {
    headers: {
      Accept: 'image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      Referer: sourceUrl,
      'User-Agent': WEB_CLIP_USER_AGENT
    },
    signal: AbortSignal.timeout(WEB_CLIP_TIMEOUT_MS)
  }, allowPrivateNetwork)

  if (!response.ok) {
    throw new Error(`Failed to fetch asset (${response.status})`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Unsupported asset type: ${contentType || 'unknown'}`)
  }
  const buffer = await readResponseBody(response, MAX_ASSET_BYTES)
  const extension = normalizeAssetExtension(assetUrl, contentType)
  return persistLocalizedAsset(buffer, assetRoot, extension)
}

function persistLocalizedAsset(buffer: Buffer, assetRoot: string, extension: string): string {
  const hash = createHash('sha256').update(buffer).digest('hex')
  const filePath = join(assetRoot, 'web-clips', hash.slice(0, 2), `${hash}${extension}`)
  mkdirSync(dirname(filePath), { recursive: true })
  if (!existsSync(filePath)) {
    writeFileSync(filePath, buffer)
  }

  return pathToFileURL(filePath).toString()
}

function decodeDataImageUrl(assetUrl: string): { buffer: Buffer; extension: string } {
  const match = assetUrl.match(/^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;(base64),([\s\S]+)$/i)
  if (!match) {
    throw new Error('Unsupported inline image format.')
  }

  const contentType = match[1]?.toLowerCase() ?? ''
  const buffer = Buffer.from(match[3] ?? '', 'base64')
  if (buffer.length === 0 || buffer.length > MAX_ASSET_BYTES) {
    throw new Error('Inline image is empty or exceeds the asset size limit.')
  }

  return {
    buffer,
    extension: normalizeAssetExtension('inline-image', contentType)
  }
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  run: (value: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex]
        nextIndex += 1
        if (value !== undefined) {
          await run(value)
        }
      }
    }
  )

  await Promise.all(workers)
}

function normalizeClipWebPageInput(input: ClipWebPageInput): ClipWebPageInput {
  if (!input || typeof input !== 'object' || typeof input.url !== 'string' || !input.url.trim()) {
    throw new Error('Web clip URL is required.')
  }
  assertTextSize(input.url, MAX_WEB_URL_BYTES, 'Web clip URL')
  if (input.parentId != null && typeof input.parentId !== 'string') {
    throw new Error('Web clip parent id must be a string or null.')
  }
  return {
    url: input.url,
    parentId: typeof input.parentId === 'string' ? input.parentId : null
  }
}

function normalizeImportWebClipPayload(input: ImportWebClipPayloadInput): ImportWebClipPayloadInput {
  const normalizedBase = normalizeClipWebPageInput(input)
  const candidate = input as ImportWebClipPayloadInput & Record<string, unknown>
  const optionalTextFields = [
    'title',
    'html',
    'markdown',
    'text',
    'sourceSite',
    'excerpt',
    'author',
    'publishedAt',
    'coverImage'
  ] as const

  for (const field of optionalTextFields) {
    const value = candidate[field]
    if (value != null && typeof value !== 'string') {
      throw new Error(`Web clip field "${field}" must be a string or null.`)
    }
    if (typeof value === 'string') {
      const maxBytes = field === 'html' || field === 'markdown' || field === 'text'
        ? MAX_HTML_BYTES
        : field === 'coverImage'
          ? MAX_WEB_URL_BYTES
          : MAX_WEB_CLIP_METADATA_BYTES
      assertTextSize(value, maxBytes, `Web clip field "${field}"`)
    }
  }

  return {
    ...normalizedBase,
    title: typeof candidate.title === 'string' ? candidate.title : undefined,
    html: typeof candidate.html === 'string' ? candidate.html : undefined,
    markdown: typeof candidate.markdown === 'string' ? candidate.markdown : undefined,
    text: typeof candidate.text === 'string' ? candidate.text : undefined,
    sourceSite: typeof candidate.sourceSite === 'string' ? candidate.sourceSite : undefined,
    excerpt: typeof candidate.excerpt === 'string' ? candidate.excerpt : undefined,
    author: typeof candidate.author === 'string' ? candidate.author : null,
    publishedAt: typeof candidate.publishedAt === 'string' ? candidate.publishedAt : null,
    coverImage: typeof candidate.coverImage === 'string' ? candidate.coverImage : null
  }
}

function assertTextSize(value: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte size limit.`)
  }
}

async function fetchWithValidatedRedirects(
  initialUrl: string,
  init: RequestInit,
  allowPrivateNetwork: boolean
): Promise<Response> {
  let currentUrl = initialUrl

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertSafeRemoteUrl(currentUrl, allowPrivateNetwork)
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' })
    if (response.status < 300 || response.status >= 400) {
      return response
    }

    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) {
      throw new Error('Redirect response is missing a location header.')
    }
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error('Too many redirects while fetching web clip content.')
    }

    currentUrl = new URL(location, currentUrl).toString()
  }

  throw new Error('Too many redirects while fetching web clip content.')
}

async function assertSafeRemoteUrl(value: string, allowPrivateNetwork: boolean): Promise<void> {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs may be fetched.')
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not supported.')
  }
  if (allowPrivateNetwork) {
    return
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Web clipping cannot access local or private network addresses.')
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error('Web clipping cannot access local or private network addresses.')
  }
}

function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized.startsWith('::ffff:')) {
    const mappedAddress = normalized.slice('::ffff:'.length)
    if (isIP(mappedAddress) === 4) {
      return isPublicIpAddress(mappedAddress)
    }

    const mappedParts = mappedAddress.split(':')
    if (mappedParts.length === 2) {
      const high = Number.parseInt(mappedParts[0], 16)
      const low = Number.parseInt(mappedParts[1], 16)
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return isPublicIpAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
      }
    }

    return false
  }

  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number)
    const [first, second] = octets
    return !(first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224)
  }

  if (isIP(normalized) === 6) {
    return normalized !== '::'
      && normalized !== '::1'
      && !normalized.startsWith('fc')
      && !normalized.startsWith('fd')
      && !/^fe[89ab]/.test(normalized)
      && !normalized.startsWith('ff')
  }

  return false
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Response exceeds the ${maxBytes}-byte size limit.`)
  }

  if (!response.body) {
    return Buffer.alloc(0)
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new Error(`Response exceeds the ${maxBytes}-byte size limit.`)
    }
    chunks.push(Buffer.from(value))
  }

  return Buffer.concat(chunks, totalBytes)
}

function normalizeAssetExtension(assetUrl: string, contentType: string): string {
  const typeMap: Record<string, string> = {
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp'
  }
  const normalizedType = contentType.split(';')[0]?.trim().toLowerCase()

  if (normalizedType && typeMap[normalizedType]) {
    return typeMap[normalizedType]
  }

  try {
    const extension = extname(new URL(assetUrl).pathname)
    if (extension) {
      return extension.slice(0, 8)
    }
  } catch {
    // Ignore URL parsing fallback errors.
  }

  return '.bin'
}

function hashClipContent(sourceUrl: string, title: string, bodyMarkdown: string): string {
  return createHash('sha256')
    .update(sourceUrl.trim())
    .update('\n')
    .update(title.trim())
    .update('\n')
    .update(bodyMarkdown.replace(/\s+/g, ' ').trim())
    .digest('hex')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
