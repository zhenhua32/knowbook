import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isIP, type LookupFunction } from 'node:net'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'
import { Agent } from 'undici'
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
const MAX_LOCALIZED_IMAGES = 100
const ASSET_DOWNLOAD_CONCURRENCY = 4
const MAX_WEB_URL_BYTES = 8 * 1024
const MAX_WEB_CLIP_METADATA_BYTES = 32 * 1024
const MIN_STRUCTURED_CLIP_TEXT_LENGTH = 120

type WebClipperOptions = {
  allowPrivateNetwork?: boolean
  extractWebClip?: WebClipExtractionRunner
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

export type ExtractedWebClip = {
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
  quality: WebClipContentQuality
}

type WebClipContentQuality = {
  textLength: number
  paragraphCount: number
  headingCount: number
  codeBlockCount: number
  imageCount: number
  usedPlainTextFallback: boolean
}

type ImportedClipCandidate = {
  kind: 'page-html' | 'article-html' | 'visible-text'
  clip: ExtractedWebClip
}

export type ExtractedWebClipOverrides = Pick<ImportWebClipPayloadInput,
  'author'
  | 'coverImage'
  | 'excerpt'
  | 'publishedAt'
  | 'sourceSite'
  | 'title'
>

export type WebClipExtractionInput = {
  html: string
  sourceUrl: string
  overrides?: ExtractedWebClipOverrides
}

export type WebClipExtractionRunner = (input: WebClipExtractionInput) => Promise<ExtractedWebClip>

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
    const extracted = await this.extractWebClip({ html: fetched.html, sourceUrl: fetched.documentUrl })
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

    const overrides: ExtractedWebClipOverrides = {
      author: normalizedInput.author,
      coverImage: normalizedInput.coverImage,
      excerpt: normalizedInput.excerpt,
      publishedAt: normalizedInput.publishedAt,
      sourceSite: normalizedInput.sourceSite,
      title: normalizedInput.title
    }
    const candidates: ImportedClipCandidate[] = []
    let extractionFailure: Error | null = null
    if (normalizedInput.html?.trim()) {
      try {
        candidates.push({
          kind: 'page-html',
          clip: await this.extractWebClip({ html: normalizedInput.html, sourceUrl, overrides })
        })
      } catch (error) {
        extractionFailure = error instanceof Error ? error : new Error(String(error))
      }
    }
    if (normalizedInput.articleHtml?.trim()) {
      try {
        candidates.push({
          kind: 'article-html',
          clip: await this.extractWebClip({
            html: buildArticleExtractionDocument(normalizedInput),
            sourceUrl,
            overrides
          })
        })
      } catch (error) {
        extractionFailure ??= error instanceof Error ? error : new Error(String(error))
      }
    }
    if (normalizedInput.markdown?.trim() || normalizedInput.text?.trim()) {
      candidates.push({
        kind: 'visible-text',
        clip: buildExtractedClipFromPayload(normalizedInput, sourceUrl, normalizeImportedBody(normalizedInput))
      })
    }
    if (candidates.length === 0) {
      throw extractionFailure ?? new Error('Imported web clip payload is missing html, markdown, or text content.')
    }

    let clip = chooseBestImportedClip(candidates)
    if (
      (normalizedInput.html?.trim() || normalizedInput.articleHtml?.trim())
      && clip.quality.usedPlainTextFallback
      && !clip.warnings.some((warning) => warning.includes('browser-visible text'))
    ) {
      clip = {
        ...clip,
        warnings: [
          ...clip.warnings,
          'Used browser-visible text because structured article extraction was incomplete.'
        ]
      }
    }
    if (normalizedInput.html?.trim() || normalizedInput.articleHtml?.trim()) {
      assertImportedClipQuality(clip)
    }
    clip = appendClipNotes(clip, normalizedInput.notes)

    const finalized = await finalizeExtractedWebClip(clip, this.assetRoot, Boolean(this.options.allowPrivateNetwork))
    return this.persistClip(normalizedInput.parentId, finalized)
  }

  private extractWebClip(input: WebClipExtractionInput): Promise<ExtractedWebClip> {
    if (this.options.extractWebClip) {
      return this.options.extractWebClip(input)
    }
    return Promise.resolve(extractWebClip(input.html, input.sourceUrl, input.overrides))
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
      const fetched = await fetchWithValidatedRedirects(candidateUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
          Referer: new URL('/', candidateUrl).toString(),
          'User-Agent': index === 0 ? WEB_CLIP_USER_AGENT : WEB_CLIP_MOBILE_USER_AGENT
        },
        signal: AbortSignal.timeout(WEB_CLIP_TIMEOUT_MS)
      }, allowPrivateNetwork)
      try {
        const { response } = fetched
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
      } finally {
        await fetched.release()
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

export function extractWebClip(html: string, sourceUrl: string, overrides: ExtractedWebClipOverrides = {}): ExtractedWebClip {
  const dom = new JSDOM(html, { url: sourceUrl })
  const { document } = dom.window
  const embeddedArticle = materializeEmbeddedArticleContent(document)
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
  const structuredSourceSite = normalizeNullableText(structuredData.sourceSite)
  const metadataSourceSite = normalizeNullableText(
    getMetaContent(document, 'meta[property="og:site_name"]', 'meta[name="application-name"]')
  )
  const author = normalizeAuthorName(firstNonEmpty(
    structuredData.author,
    normalizeWhitespace(article?.byline ?? ''),
    extractVisibleArticleAuthor(fallbackArticle),
    normalizeWhitespace(overrides.author ?? ''),
    getMetaContent(document, 'meta[name="author"]', 'meta[property="article:author"]')
  ))
  const sourceSite = firstNonEmpty(
    inferKnownSiteName(sourceUrl),
    isHostnameLike(structuredSourceSite) ? null : structuredSourceSite,
    isHostnameLike(metadataSourceSite) ? null : metadataSourceSite,
    isHostnameLike(overrideSourceSite) ? null : overrideSourceSite,
    inferredSiteName,
    overrideSourceSite,
    safeHostname(sourceUrl)
  ) ?? safeHostname(sourceUrl)
  const title = stripAuthorSuffix(sanitizeClipTitle(cleanClipTitle(firstNonEmpty(
    normalizeUsefulPageTitle(overrides.title),
    embeddedArticle.title,
    structuredData.title,
    normalizeUsefulPageTitle(getMetaContent(document, 'meta[property="og:title"]', 'meta[name="twitter:title"]')),
    primaryHeading,
    normalizeTitle(article?.title),
    normalizeTitle(document.title),
    sourceSite,
    safeHostname(sourceUrl)
  ) ?? safeHostname(sourceUrl), sourceSite, safeHostname(sourceUrl))), author)

  let bodyMarkdown = ''
  let articleImageUrl: string | null = null
  let quality = createEmptyClipQuality()
  if (articleContent) {
    const articleDom = new JSDOM(`<body>${articleContent}</body>`, { url: sourceUrl })
    prepareArticleDocument(articleDom.window.document, sourceUrl)
    quality = measureArticleQuality(articleDom.window.document, false)
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
    quality = measurePlainTextQuality(fallbackText)
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
    author,
    publishedAt: normalizeDateValue(firstNonEmpty(
      fallbackArticle?.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ?? null,
      extractVisibleArticleDate(fallbackArticle),
      extractVisibleArticleDate(document.body),
      embeddedArticle.publishedAt,
      structuredData.publishedAt,
      overrides.publishedAt,
      getMetaContent(document, 'meta[property="article:published_time"]', 'meta[name="date"]', 'meta[name="publish-date"]'),
      document.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ?? null
    )),
    coverImage,
    bodyMarkdown,
    contentHash: hashClipContent(sourceUrl, title, bodyMarkdown),
    warnings,
    quality
  }
}

function buildExtractedClipFromPayload(input: ImportWebClipPayloadInput, sourceUrl: string, bodyMarkdown: string): ExtractedWebClip {
  const hostname = safeHostname(sourceUrl)
  const inferredSite = inferSiteName(normalizeWhitespace(input.title ?? ''), '')
  const sourceSite = firstNonEmpty(
    inferKnownSiteName(sourceUrl),
    isHostnameLike(normalizeNullableText(input.sourceSite)) ? null : input.sourceSite,
    inferredSite,
    input.sourceSite,
    hostname
  ) ?? hostname
  const title = sanitizeClipTitle(cleanClipTitle(firstNonEmpty(input.title, hostname, sourceUrl) ?? sourceUrl, sourceSite, hostname))
  const cleanedBody = cleanExtractedMarkdown(bodyMarkdown)

  return {
    title,
    sourceUrl,
    sourceSite,
    excerpt: normalizeExcerpt(input.excerpt),
    author: normalizeAuthorName(input.author),
    publishedAt: normalizeDateValue(input.publishedAt ?? null),
    coverImage: pickBestCoverImage([input.coverImage], sourceUrl),
    bodyMarkdown: cleanedBody,
    contentHash: hashClipContent(sourceUrl, title, cleanedBody),
    warnings: [],
    quality: measurePlainTextQuality(cleanedBody)
  }
}

function buildArticleExtractionDocument(input: ImportWebClipPayloadInput): string {
  const title = escapeHtmlText(input.title?.trim() || safeHostname(input.url))
  const metadata = [
    input.sourceSite ? `<meta property="og:site_name" content="${escapeHtmlAttribute(input.sourceSite)}">` : '',
    input.excerpt ? `<meta name="description" content="${escapeHtmlAttribute(input.excerpt)}">` : '',
    input.author ? `<meta name="author" content="${escapeHtmlAttribute(input.author)}">` : '',
    input.publishedAt ? `<meta property="article:published_time" content="${escapeHtmlAttribute(input.publishedAt)}">` : '',
    input.coverImage ? `<meta property="og:image" content="${escapeHtmlAttribute(input.coverImage)}">` : ''
  ].filter(Boolean).join('')

  return `<!doctype html><html><head><title>${title}</title>${metadata}</head><body>${input.articleHtml ?? ''}</body></html>`
}

function chooseBestImportedClip(candidates: ImportedClipCandidate[]): ExtractedWebClip {
  const pageCandidate = candidates.find((candidate) => candidate.kind === 'page-html')
  const articleCandidate = candidates.find((candidate) => candidate.kind === 'article-html')
  const visibleTextCandidate = candidates.find((candidate) => candidate.kind === 'visible-text')
  let selected = pageCandidate ?? articleCandidate ?? visibleTextCandidate
  if (!selected) {
    throw new Error('Could not extract readable text from this webpage.')
  }

  if (articleCandidate && articleCandidate !== selected) {
    const articleQuality = articleCandidate.clip.quality
    const selectedQuality = selected.clip.quality
    if (
      hasArticleStructure(articleQuality)
      && (
        !hasArticleStructure(selectedQuality)
        || articleQuality.textLength >= selectedQuality.textLength * 0.35
      )
    ) {
      selected = articleCandidate
    }
  }

  if (visibleTextCandidate && visibleTextCandidate !== selected) {
    const visibleLength = visibleTextCandidate.clip.quality.textLength
    const selectedLength = selected.clip.quality.textLength
    if (
      (!hasArticleStructure(selected.clip.quality) && visibleLength >= selectedLength * 1.25)
      || (selectedLength < 500 && visibleLength >= selectedLength * 1.9)
    ) {
      selected = {
        ...visibleTextCandidate,
        clip: {
          ...visibleTextCandidate.clip,
          warnings: [
            ...visibleTextCandidate.clip.warnings,
            'Used browser-visible text because structured article extraction was incomplete.'
          ]
        }
      }
    }
  }

  if (pageCandidate && pageCandidate !== selected) {
    return {
      ...selected.clip,
      author: selected.clip.author ?? pageCandidate.clip.author,
      publishedAt: pageCandidate.clip.publishedAt ?? selected.clip.publishedAt
    }
  }

  return selected.clip
}

function assertImportedClipQuality(clip: ExtractedWebClip): void {
  const { quality } = clip
  if (isKnownBlockedPageUrl(clip.sourceUrl)) {
    throw new Error('The webpage redirected to a block or challenge page instead of the requested article.')
  }
  if (quality.textLength < MIN_STRUCTURED_CLIP_TEXT_LENGTH) {
    throw new Error('The webpage did not expose enough readable article content to clip.')
  }
  if (quality.usedPlainTextFallback && quality.textLength < 900) {
    throw new Error('The webpage only exposed a short application shell; its article content was not available.')
  }
  if (!hasArticleStructure(quality) && quality.textLength < 900) {
    throw new Error('The webpage did not expose a structured article body to clip.')
  }

  const comparableTitle = normalizeComparableText(clip.title)
  const comparableSite = normalizeComparableText(clip.sourceSite)
  if (
    comparableTitle
    && comparableTitle === comparableSite
    && quality.paragraphCount < 2
    && quality.textLength < 1_200
  ) {
    throw new Error('The webpage only exposed its site shell; its article title and body were not available.')
  }
}

function isKnownBlockedPageUrl(value: string): boolean {
  try {
    return /\/(?:block|captcha|challenge)(?:\/|\.|$)/i.test(new URL(value).pathname)
  } catch {
    return false
  }
}

function appendClipNotes(clip: ExtractedWebClip, rawNotes: string | null | undefined): ExtractedWebClip {
  const notes = rawNotes?.trim() ?? ''
  if (!notes) {
    return clip
  }

  const bodyMarkdown = [clip.bodyMarkdown.trim(), `Extension notes: ${notes}`].filter(Boolean).join('\n\n')
  return {
    ...clip,
    bodyMarkdown,
    contentHash: hashClipContent(clip.sourceUrl, clip.title, bodyMarkdown),
    quality: {
      ...clip.quality,
      textLength: clip.quality.textLength + normalizeWhitespace(notes).length
    }
  }
}

function createEmptyClipQuality(): WebClipContentQuality {
  return {
    textLength: 0,
    paragraphCount: 0,
    headingCount: 0,
    codeBlockCount: 0,
    imageCount: 0,
    usedPlainTextFallback: false
  }
}

function measureArticleQuality(document: Document, usedPlainTextFallback: boolean): WebClipContentQuality {
  return {
    textLength: normalizeWhitespace(document.body?.textContent ?? '').length,
    paragraphCount: document.querySelectorAll('p,li,blockquote').length,
    headingCount: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    codeBlockCount: document.querySelectorAll('pre,code').length,
    imageCount: document.querySelectorAll('img').length,
    usedPlainTextFallback
  }
}

function measurePlainTextQuality(value: string): WebClipContentQuality {
  const blocks = value.split(/\n\s*\n|\r?\n/).map((block) => block.trim()).filter(Boolean)
  return {
    textLength: normalizeWhitespace(value).length,
    paragraphCount: blocks.length,
    headingCount: 0,
    codeBlockCount: (value.match(/```/g)?.length ?? 0) >= 2 ? 1 : 0,
    imageCount: extractMarkdownImageUrls(value).length,
    usedPlainTextFallback: true
  }
}

function hasArticleStructure(quality: WebClipContentQuality): boolean {
  return quality.paragraphCount >= 2
    || quality.codeBlockCount > 0
    || (quality.headingCount > 0 && quality.textLength >= 500)
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character)
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;')
}

async function finalizeExtractedWebClip(clip: ExtractedWebClip, assetRoot: string, allowPrivateNetwork: boolean): Promise<ExtractedWebClip> {
  const warnings = [...clip.warnings]
  const cleanedBodyMarkdown = cleanExtractedMarkdown(clip.bodyMarkdown)
  const imageUrls = [...new Set(extractMarkdownImageUrls(cleanedBodyMarkdown))]
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
      replaceMarkdownImageUrls(cleanedBodyMarkdown, resolvedImageUrls),
      new Set(failedImageUrls)
    ),
    contentHash: hashClipContent(clip.sourceUrl, clip.title, cleanedBodyMarkdown),
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

  if (clip.excerpt && !excerptDuplicatesBody(clip.excerpt, clip.bodyMarkdown)) {
    sections.push(`> ${clip.excerpt}`)
  }

  sections.push('---')
  sections.push(stripStandaloneUiArtifacts(clip.bodyMarkdown))

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

function stripStandaloneUiArtifacts(markdown: string): string {
  const artifacts = new Set(['-', '预览', '展开全文', '收起', '举报', '点赞', '收藏', '关注作者', 'advertisement', '广告'])
  return markdown
    .replace(/[\u2028\u2029]/g, '\n')
    .split(/\r?\n/)
    .filter((line) => !artifacts.has(line.replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
    'nav',
    'aside',
    'footer',
    '#adSide',
    '#comments',
    '#reviews-wrapper',
    '.operate-block',
    '.comments',
    '.review-list',
    '.Post-Sub',
    '.ContentItem-actions',
    '.RichContent-actions',
    '[data-mod-name^="pep-ad"]',
    '[class^="recommend-"]',
    '[class*=" recommend-"]',
    '[id^="recommend-"]',
    '[class^="comment-"]',
    '[class*=" comment-"]',
    '[id^="comment-"]',
    '[class*="Recommendations"]',
    '[class*="advert"]',
    '[id*="advert"]',
    '[class*="ad-container"]',
    '[class*="ad_placeholder"]',
    '[aria-hidden="true"]',
    '[hidden]'
  ].join(',')).forEach((node) => node.remove())
}

function materializeEmbeddedArticleContent(document: Document): { title: string | null; publishedAt: string | null } {
  const title = normalizeUsefulPageTitle(readTextAreaValue(document, 'textarea.article-title'))
  const publishedAt = normalizeNumericTimestamp(readTextAreaValue(document, 'textarea.article-time'))
  const field = document.querySelector('textarea.article-content') as HTMLTextAreaElement | null
  const embeddedHtml = (field?.value || field?.textContent || '').trim()
  if (!field || !embeddedHtml || !/<(?:article|section|p)\b/i.test(embeddedHtml)) {
    return { title, publishedAt }
  }

  const root = document.createElement('article')
  root.className = 'knowbook-embedded-article'
  root.innerHTML = embeddedHtml
  const shell = field.closest('article')
  if (shell) {
    shell.replaceWith(root)
  } else {
    field.replaceWith(root)
  }

  return { title, publishedAt }
}

function readTextAreaValue(document: Document, selector: string): string | null {
  const element = document.querySelector(selector) as HTMLTextAreaElement | null
  return normalizeNullableText(element?.value || element?.textContent)
}

function normalizeNumericTimestamp(value: string | null): string | null {
  if (!value || !/^\d{10,13}$/.test(value)) {
    return null
  }

  const timestamp = Number(value) * (value.length === 10 ? 1_000 : 1)
  const date = new Date(timestamp)
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10)
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
  removeTrailingArticleSections(document)
  normalizeDocumentImages(document, sourceUrl)
  absolutizeDocumentUrls(document, sourceUrl)
  normalizeArticleHeadings(document)
  cleanArticleImages(document)
  unwrapImageLinks(document)
}

function removeTrailingArticleSections(document: Document): void {
  const boundary = Array.from(document.querySelectorAll('h2,h3,h4,strong,div,p'))
    .find((element) => /^(?:猜您喜欢|相关推荐|推荐阅读|延伸阅读)$/u.test(normalizeWhitespace(element.textContent ?? '')))
  if (!boundary) {
    return
  }

  let section: Element | null = boundary.closest('section,aside,.sons') ?? boundary
  while (section) {
    const next: Element | null = section.nextElementSibling
    section.remove()
    section = next
  }
}

function absolutizeDocumentUrls(document: Document, baseUrl: string): void {
  document.querySelectorAll('[href]').forEach((element) => {
    const href = element.getAttribute('href')?.trim()
    const nextHref = absolutizeUrl(href ?? null, baseUrl)
    if (nextHref && isSafeClipLink(nextHref)) {
      element.setAttribute('href', nextHref)
    } else {
      element.removeAttribute('href')
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

function isSafeClipLink(value: string): boolean {
  return /^(?:https?:|mailto:|tel:)/i.test(value)
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
      || isLikelyDecorativeImage(source, image)
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
    '[itemprop="articleBody"]',
    '.knowbook-embedded-article',
    'article',
    'main',
    '[role="main"]',
    '#post_body',
    '#article',
    '#article-content',
    '#articleContent',
    '#content_area',
    '.content_area',
    '.rm_txt_con',
    '#J-lemma-main-wrapper',
    '.mw-parser-output',
    '#blog_article',
    '#bodyContent',
    '.main_content',
    '.wang-editor-content',
    '#sonsyuanwen',
    '.main3',
    '.left',
    '[class^="cententWrap__"]',
    '[class*=" cententWrap__"]',
    '#content',
    '.article',
    '.article-content',
    '.article-body',
    '.article-detail',
    '.detail-content',
    '.entry-content',
    '.post-content',
    '.news-content',
    '.newsCo',
    '.markdown-body',
    '.rich_media_content',
    '.blog-content-body',
    '.editor.heti'
  ]
  const candidates = [...new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))]
  let best: { element: Element; score: number } | null = null
  const hostname = document.location.hostname.toLowerCase()

  for (const element of candidates) {
    const textLength = normalizeWhitespace(element.textContent ?? '').length
    const identity = `${element.id} ${typeof element.className === 'string' ? element.className : ''}`
    if (/(?:comment|recommend|related|sidebar|footer|header|menu|nav|catalog|toc)(?:\b|[-_])/i.test(identity)) {
      continue
    }
    const paragraphCount = element.querySelectorAll('p').length
    const headingCount = element.querySelectorAll('h1,h2,h3').length
    if (textLength < 20 || (textLength < 120 && paragraphCount === 0 && headingCount === 0)) {
      continue
    }
    const imageCount = element.querySelectorAll('img').length
    const linkTextLength = Array.from(element.querySelectorAll('a'))
      .reduce((total, link) => total + normalizeWhitespace(link.textContent ?? '').length, 0)
    const linkDensity = linkTextLength / Math.max(1, textLength)
    const semanticBonus = element.tagName === 'ARTICLE' ? 5_000 : 0
    const siteSpecificBonus = /(?:^|\s)(?:knowbook-embedded-article|mw-parser-output|main_content|wang-editor-content)(?:\s|$)/i.test(identity)
      || /^(?:J-lemma-main-wrapper|blog_article|bodyContent|content_area|sonsyuanwen)$/i.test(element.id)
      || (element.classList.contains('article') && /(?:^|\.)douban\.com$/i.test(hostname))
      || (/cententWrap__/i.test(identity) && /(?:^|\.)thepaper\.cn$/i.test(hostname))
      || (/(?:^|\s)(?:main3|left)(?:\s|$)/i.test(identity) && /(?:gushiwen\.cn|guwendao\.net)$/i.test(hostname))
      ? 15_000
      : 0
    const contentBonus = /(?:^|\s)(?:editor|markdown-body|article-content|article-body|post-content|entry-content|rich_media_content|blog-content-body|newsCo)(?:\s|$)/i.test(identity)
      ? 5_000
      : /(?:article|post|entry|markdown|editor|news)[-_ ]?(?:body|content|detail)?/i.test(identity) ? 1_000 : 0
    const score = textLength + paragraphCount * 110 + headingCount * 70 + imageCount * 40
      + semanticBonus + siteSpecificBonus + contentBonus - linkDensity * textLength * 1.5

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
  const compactSiteSuffix = `--${sourceSite.trim()}`
  if (compactSiteSuffix.length > 2 && normalized.endsWith(compactSiteSuffix)) {
    const withoutSite = normalized.slice(0, -compactSiteSuffix.length).trim()
    const channelSeparator = withoutSite.lastIndexOf('--')
    return channelSeparator >= 6 ? withoutSite.slice(0, channelSeparator).trim() : withoutSite
  }
  const segments = normalized
    .split(/(?:\s+[-–—]\s+|\s*\|\s*|\s+·\s+|_)/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const siteComparable = normalizeComparableText(sourceSite)
  const hostnameComparable = normalizeComparableText(hostname.replace(/^www\./i, '').split('.')[0] ?? hostname)
  const isSiteSegment = (segment: string) => {
    const comparable = normalizeComparableText(segment)
    const commonSiteSuffix = /^(?:博客|社区|开发者社区|官方文档|文档|官网|科技有意思|thepaper|learn|docs)$/i
    return Boolean(comparable) && (
      siteComparable === comparable
      || (comparable.startsWith(siteComparable) && commonSiteSuffix.test(comparable.slice(siteComparable.length)))
      || (siteComparable.startsWith(comparable) && commonSiteSuffix.test(siteComparable.slice(comparable.length)))
      || hostnameComparable === comparable
    )
  }
  if (segments.length < 2) {
    const compactSuffix = normalized.match(/^(.*)[-–—|·_]([^-–—|·_]+)$/)
    const prefix = compactSuffix?.[1]?.trim() ?? ''
    const suffix = compactSuffix?.[2]?.trim() ?? ''
    if (prefix.length >= 6 && isSiteSegment(suffix)) {
      return prefix
    }
    return normalized
  }
  while (segments.length > 1 && isSiteSegment(segments[0] ?? '')) {
    segments.shift()
  }
  while (segments.length > 1 && isSiteSegment(segments.at(-1) ?? '')) {
    segments.pop()
  }
  if (sourceSite === '澎湃新闻' && segments.length > 1 && segments.at(-1) === '澎湃研究所') {
    segments.pop()
  }

  const deduplicated = segments.filter((segment, index) => (
    index === 0 || normalizeComparableText(segment) !== normalizeComparableText(segments[index - 1] ?? '')
  ))
  return deduplicated.join(' - ') || normalized
}

function stripAuthorSuffix(title: string, author: string | null): string {
  if (!author) {
    return title
  }

  const match = title.match(/^(.*)\s+[-–—|·]\s+(.+)$/)
  if (!match) {
    return title
  }

  return normalizeComparableText(match[2] ?? '') === normalizeComparableText(author)
    ? (match[1]?.trim() || title)
    : title
}

function sanitizeClipTitle(value: string): string {
  const sanitized = normalizeWhitespace(value)
    .replace(/[/\\]+/g, '／')
    .replace(/[\x00-\x1F]/g, ' ')
    .trim()
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : 'Untitled'
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/^www\./, '').replace(/[^\p{L}\p{N}]+/gu, '')
}

function normalizeAuthorName(value: string | null | undefined): string | null {
  const normalized = normalizeNullableText(value)
  if (
    !normalized
    || /^(?:https?:)?\/\//i.test(normalized)
    || /^\d+$/u.test(normalized)
    || /^(?:chinanews|discuz! team and comsenz ui team)$/i.test(normalized)
    || /^本词条由.+审核/u.test(normalized)
  ) {
    return null
  }

  let cleaned = normalized.replace(/^(?:作者|撰文|文|by)\s*[:：]?\s*/i, '')
  cleaned = cleaned.split(/\s+(?:粉丝|关注|发表于|发布于)(?:\s|$)/i, 1)[0]?.trim() ?? cleaned
  cleaned = cleaned.replace(/(?:台湾)?自由撰稿人$/u, '').trim()
  const repeatedIdentity = cleaned.match(/^(.{2,30}?)\s+\1(?:官方账号.*)?$/)
  if (repeatedIdentity?.[1]) {
    cleaned = repeatedIdentity[1]
  }
  return normalizeNullableText(cleaned)
}

function normalizeUsefulPageTitle(value: string | null | undefined): string | null {
  const normalized = normalizeNullableText(value)
  return normalized && !/^(?:博文|文章|首页|详情|正文)$/u.test(normalized) ? normalized : null
}

function extractVisibleArticleAuthor(element: Element | null): string | null {
  for (const candidate of Array.from(element?.querySelectorAll('p,span,div') ?? []).slice(0, 200)) {
    const text = normalizeWhitespace(candidate.textContent ?? '')
    const match = text.match(/^作者\s*[:：]\s*([\p{L}·•]{2,24})(?=\s*(?:$|编辑\s*[:：]))/u)
    if (match?.[1]) {
      return normalizeAuthorName(match[1])
    }
  }

  return null
}

function extractVisibleArticleDate(element: Element | null): string | null {
  const fullText = normalizeWhitespace(element?.textContent ?? '')
  const explicitMatch = fullText.match(/(?:发布于|发布时间|上传时间|编辑于)\s*[:：]?\s*(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?/)
  const match = explicitMatch ?? fullText.slice(0, 2500).match(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?/)
  if (!match) {
    return null
  }

  return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`
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

function excerptDuplicatesBody(excerpt: string, bodyMarkdown: string): boolean {
  const comparableExcerpt = normalizeComparableText(excerpt)
  const comparableBody = normalizeComparableText(bodyMarkdown)
  if (comparableExcerpt.length < 12 || comparableBody.length < 12) {
    return false
  }

  const excerptLead = comparableExcerpt.slice(0, Math.min(48, comparableExcerpt.length))
  return comparableBody.slice(0, Math.max(400, excerptLead.length * 3)).includes(excerptLead)
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
  return /(?:^|[/_.-])(avatar|favicon|icon|logo|qr|sprite|loading|placeholder|advertisement|advert|ad-banner)(?:[/_.-]|$)/i.test(normalizedSource)
    || /\b(?:avatar|icon|logo|emoji)\b/.test(className)
    || /^(?:logo|头像|图标)$/.test(alt)
    || /(?:广告|advertisement|ad banner)/i.test(alt)
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
  const artifactLines = new Set(['-', '预览', '展开全文', '收起', '举报', '点赞', '收藏', '关注作者', 'advertisement', '广告'])
  const withoutExecutableMarkup = decodeEmbeddedRichTextMarkup(markdown)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  const embeddedPageBoundary = withoutExecutableMarkup.search(
    /<\/article>[\s\S]{0,300}class=["'][^"']*(?:comment|skeleton|footer|page-footer|layout-footer)/i
  )
  const articleOnlyMarkdown = embeddedPageBoundary >= 0
    ? withoutExecutableMarkup.slice(0, embeddedPageBoundary)
    : withoutExecutableMarkup
  const embeddedFooterLead = articleOnlyMarkdown.indexOf('促进软件开发及相关领域知识与创新的传播')
  const precedingFooterImage = embeddedFooterLead >= 0
    ? articleOnlyMarkdown.lastIndexOf('\n![', embeddedFooterLead)
    : -1
  const embeddedFooterBoundary = precedingFooterImage >= 0
    && embeddedFooterLead - precedingFooterImage <= 500
    ? precedingFooterImage
    : embeddedFooterLead
  const contentOnlyMarkdown = embeddedFooterBoundary >= 0
    ? articleOnlyMarkdown.slice(0, embeddedFooterBoundary)
    : articleOnlyMarkdown
  const trailingUiBoundary = contentOnlyMarkdown.search(
    /(?:^|\n)(?:#{1,6}\s*)?(?:猜您喜欢|相关推荐|推荐阅读|延伸阅读|上一篇\s*[:：]|下一篇\s*[:：])/mu
  )
  const trimmedContent = trailingUiBoundary >= 0
    ? contentOnlyMarkdown.slice(0, trailingUiBoundary)
    : contentOnlyMarkdown
  const lines = trimmedContent
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2028\u2029]/g, '\n')
    .split(/\r?\n/)
    .filter((line) => !artifactLines.has(line.replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase()))

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .trim()
}

function decodeEmbeddedRichTextMarkup(markdown: string): string {
  const boundary = /<\/span>\s*<\/p>\s*(?=<(?:p|div|ul|ol)\b[^>]*\bdata-type=)/i.exec(markdown)
  if (boundary?.index === undefined) {
    return markdown
  }

  const suffixStart = boundary.index + boundary[0].length
  const embeddedHtml = markdown.slice(suffixStart)
  if ((embeddedHtml.match(/\bdata-type=/gi) ?? []).length < 3) {
    return markdown
  }

  const dom = new JSDOM(`<body>${embeddedHtml}</body>`)
  try {
    dom.window.document.querySelectorAll('script,style,noscript,template,iframe').forEach((node) => node.remove())
    cleanArticleImages(dom.window.document)
    unwrapImageLinks(dom.window.document)
    const converted = createTurndownService().turndown(dom.window.document.body.innerHTML).trim()
    return [markdown.slice(0, boundary.index).trim(), converted].filter(Boolean).join('\n\n')
  } finally {
    dom.window.close()
  }
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
    return null
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
    const knownSites: Array<[string, string]> = [
      ['zhuanlan.zhihu.com', '知乎专栏'],
      ['news.cn', '新华网'],
      ['people.com.cn', '人民网'],
      ['cctv.com', '央视网'],
      ['chinanews.com.cn', '中国新闻网'],
      ['thepaper.cn', '澎湃新闻'],
      ['jiemian.com', '界面新闻'],
      ['ifeng.com', '凤凰网'],
      ['huanqiu.com', '环球网'],
      ['guancha.cn', '观察者网'],
      ['infzm.com', '南方周末'],
      ['baike.baidu.com', '百度百科'],
      ['wikipedia.org', '维基百科'],
      ['guokr.com', '果壳'],
      ['sciencenet.cn', '科学网'],
      ['gushiwen.cn', '古诗文网'],
      ['guwendao.net', '古文岛'],
      ['mbalib.com', 'MBA智库百科'],
      ['douban.com', '豆瓣'],
      ['dili360.com', '中国国家地理'],
      ['kepuchina.cn', '科普中国'],
      ['jianshu.com', '简书'],
      ['ruanyifeng.com', '阮一峰的网络日志'],
      ['juejin.cn', '掘金'],
      ['cnblogs.com', '博客园'],
      ['oschina.net', 'OSCHINA'],
      ['sspai.com', '少数派'],
      ['csdn.net', 'CSDN'],
      ['infoq.cn', 'InfoQ'],
      ['segmentfault.com', 'SegmentFault'],
      ['36kr.com', '36氪'],
      ['ifanr.com', '爱范儿'],
      ['ithome.com', 'IT之家'],
      ['geekpark.net', '极客公园'],
      ['cloud.tencent.com', '腾讯云开发者社区'],
      ['aliyun.com', '阿里云开发者社区'],
      ['huaweicloud.com', '华为云社区'],
      ['github.com', 'GitHub'],
      ['gitee.com', 'Gitee'],
      ['mozilla.org', 'MDN'],
      ['react.dev', 'React'],
      ['nodejs.org', 'Node.js'],
      ['expreview.com', '超能网']
    ]
    for (const [domain, name] of knownSites) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return name
      }
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

  const fetched = await fetchWithValidatedRedirects(assetUrl, {
    headers: {
      Accept: 'image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      Referer: sourceUrl,
      'User-Agent': WEB_CLIP_USER_AGENT
    },
    signal: AbortSignal.timeout(WEB_CLIP_TIMEOUT_MS)
  }, allowPrivateNetwork)
  try {
    const { response } = fetched
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
  } finally {
    await fetched.release()
  }
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
    'articleHtml',
    'markdown',
    'text',
    'notes',
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
      const maxBytes = field === 'html' || field === 'articleHtml' || field === 'markdown' || field === 'text'
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
    articleHtml: typeof candidate.articleHtml === 'string' ? candidate.articleHtml : undefined,
    markdown: typeof candidate.markdown === 'string' ? candidate.markdown : undefined,
    text: typeof candidate.text === 'string' ? candidate.text : undefined,
    notes: typeof candidate.notes === 'string' ? candidate.notes : undefined,
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
): Promise<{ response: Response; release: () => Promise<void> }> {
  let currentUrl = initialUrl

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const resolvedAddress = await resolveSafeRemoteUrl(currentUrl, allowPrivateNetwork)
    const dispatcher = resolvedAddress
      ? new Agent({
          connect: {
            lookup: createPinnedLookup(resolvedAddress)
          }
        })
      : null
    let response: Response
    try {
      response = await fetch(currentUrl, {
        ...init,
        redirect: 'manual',
        ...(dispatcher ? { dispatcher } : {})
      } as RequestInit & { dispatcher?: Agent })
    } catch (error) {
      await dispatcher?.close()
      throw error
    }

    if (response.status < 300 || response.status >= 400) {
      return {
        response,
        release: async () => {
          await response.body?.cancel().catch(() => undefined)
          await dispatcher?.close()
        }
      }
    }

    const location = response.headers.get('location')
    await response.body?.cancel()
    await dispatcher?.close()
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

export function createPinnedLookup(resolvedAddress: { address: string; family: number }): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [resolvedAddress])
      return
    }

    callback(null, resolvedAddress.address, resolvedAddress.family)
  }
}

async function resolveSafeRemoteUrl(
  value: string,
  allowPrivateNetwork: boolean
): Promise<{ address: string; family: number } | null> {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs may be fetched.')
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not supported.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!allowPrivateNetwork && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) {
    throw new Error('Web clipping cannot access local or private network addresses.')
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0) {
    throw new Error('Web clipping could not resolve the remote address.')
  }
  if (!allowPrivateNetwork && addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error('Web clipping cannot access local or private network addresses.')
  }

  return addresses[0]
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
