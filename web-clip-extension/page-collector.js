export function collectPagePayload() {
  const pickMeta = (...selectors) => {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.getAttribute('content')?.trim()
      if (value) {
        return value
      }
    }

    return null
  }
  const inferPageSite = (title, heading) => {
    const segments = String(title || '').split(/\s+(?:[-–—|·])\s+/).map((segment) => segment.trim()).filter(Boolean)
    if (segments.length < 2) return null
    const suffix = segments[segments.length - 1]
    const prefix = segments.slice(0, -1).join(' ')
    if (!suffix || suffix.length > 40 || suffix.length >= prefix.length || String(heading || '').includes(suffix)) return null
    return suffix
  }
  const cleanCollectedTitle = (title, siteName = '') => {
    const normalized = String(title || '').replace(/\s+/g, ' ').trim()
    const segments = normalized.split(/\s+(?:[-–—|·])\s+/).map((segment) => segment.trim()).filter(Boolean)
    if (segments.length < 2) return normalized
    const suffix = segments[segments.length - 1]
    const prefix = segments.slice(0, -1).join(' ')
    const comparableSuffix = suffix.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const comparableSite = String(siteName || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const shouldStrip = prefix.length >= 6 && Boolean(comparableSite) && (
      comparableSite.includes(comparableSuffix)
      || comparableSuffix.includes(comparableSite)
    )
    return shouldStrip ? prefix : normalized
  }

  const decodeCandidate = (value) => {
    const normalized = value?.trim()?.replace(/^['"]|['"]$/g, '') || ''
    if (!normalized) return null
    if (/^(?:https?:|data:image\/|\/|\.\/|\.\.\/)/i.test(normalized)) return normalized
    if (/^[A-Za-z0-9+/=_-]{20,}$/.test(normalized)) {
      try {
        const decoded = decodeURIComponent(escape(atob(normalized.replace(/-/g, '+').replace(/_/g, '/')))).trim()
        if (/^(?:https?:|\/|\.\/|\.\.\/)/i.test(decoded)) return decoded
      } catch {
        // Keep checking other image candidates.
      }
    }
    return normalized
  }
  const absoluteUrl = (value) => {
    const candidate = decodeCandidate(value)
    if (!candidate) return null
    try {
      return new URL(candidate, location.href).toString()
    } catch {
      return null
    }
  }
  const isUsableImage = (value) => Boolean(
    value
    && !/^(?:blob:|javascript:|about:)/i.test(value)
    && !/(?:^|[/_.-])(?:l\d{2,4}|loading|lazy|placeholder|spacer|transparent|blank)(?:[/_.-]|$)/i.test(value.split(/[?#]/)[0])
  )
  const resolveImage = (image) => {
    const pictureSources = Array.from(image.closest('picture')?.querySelectorAll('source') || [])
      .flatMap((source) => [source.getAttribute('data-srcset'), source.getAttribute('srcset')])
    const candidates = [
      image.getAttribute('data-original'),
      image.getAttribute('data-src'),
      image.getAttribute('data-lazy-src'),
      image.getAttribute('data-url'),
      image.getAttribute('data-actualsrc'),
      image.getAttribute('data-srcset'),
      ...pictureSources,
      image.currentSrc,
      image.getAttribute('srcset'),
      image.getAttribute('src'),
      image.closest('a[href]')?.getAttribute('href')
    ]

    for (const candidate of candidates) {
      const expanded = decodeCandidate(candidate)
      const srcsetParts = expanded?.includes(',')
        ? expanded.split(',').map((part) => part.trim().split(/\s+/)[0]).reverse()
        : [expanded]
      for (const part of srcsetParts) {
        const resolved = absoluteUrl(part)
        if (isUsableImage(resolved)) return resolved
      }
    }
    return null
  }
  const removeImageAndEmptyWrapper = (image) => {
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

  const findBestContentRoot = () => {
    const selectors = [
      '[itemprop="articleBody"]',
      'article',
      '#post_body',
      '#article-content',
      '#articleContent',
      '.article-content',
      '.article-body',
      '.article-detail',
      '.detail-content',
      '.entry-content',
      '.post-content',
      '.markdown-body',
      '.rich_media_content',
      '.blog-content-body',
      '.editor.heti',
      '.news-content',
      '.newsCo',
      '[role="main"]',
      'main'
    ]
    const candidates = [...new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))]
    let best = null
    for (const element of candidates) {
      const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
      const identity = `${element.id || ''} ${typeof element.className === 'string' ? element.className : ''}`
      if (/(?:comment|recommend|related|sidebar|footer|header|menu|nav|catalog|toc)(?:\b|[-_])/i.test(identity)) continue
      const paragraphCount = element.querySelectorAll('p').length
      const headingCount = element.querySelectorAll('h1,h2,h3').length
      if (text.length < 20 || (text.length < 120 && paragraphCount === 0 && headingCount === 0)) continue
      const richCount = element.querySelectorAll('pre,table,blockquote,figure,img').length
      const linkTextLength = Array.from(element.querySelectorAll('a'))
        .reduce((total, link) => total + String(link.textContent || '').replace(/\s+/g, ' ').trim().length, 0)
      const linkDensity = linkTextLength / Math.max(1, text.length)
      const semanticBonus = element.tagName === 'ARTICLE' ? 5000 : 0
      const contentBonus = /(?:^|\s)(?:editor|markdown-body|article-content|article-body|post-content|entry-content|rich_media_content|blog-content-body|newsCo)(?:\s|$)/i.test(identity)
        ? 5000
        : /(?:article|post|entry|markdown|editor|news)[-_ ]?(?:body|content|detail)?/i.test(identity) ? 1000 : 0
      const score = text.length + paragraphCount * 110 + headingCount * 70 + richCount * 35
        + semanticBonus + contentBonus - linkDensity * text.length * 1.5
      if (!best || score > best.score) best = { element, score }
    }
    return best?.element || null
  }
  const sanitizeClone = (liveRoot, clonedRoot) => {
    const liveImages = Array.from(liveRoot.querySelectorAll('img'))
    const clonedImages = Array.from(clonedRoot.querySelectorAll('img'))
    clonedImages.forEach((image, index) => {
      const source = resolveImage(liveImages[index] || image)
      if (!source) {
        removeImageAndEmptyWrapper(image)
        return
      }
      image.setAttribute('src', source)
      for (const attribute of [
        'srcset',
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
    })
    clonedRoot.querySelectorAll('script').forEach((node) => {
      const type = node.getAttribute('type')?.toLowerCase() || ''
      if (type !== 'application/ld+json' && !/\bdata_arr\s*=\s*\[/i.test(node.textContent || '')) {
        node.remove()
      }
    })
    clonedRoot.querySelectorAll('noscript, template, iframe, #adSide, .operate-block, [data-mod-name^="pep-ad"]').forEach((node) => node.remove())
  }

  const articleRoot = findBestContentRoot()
  const clonedDocument = document.documentElement.cloneNode(true)
  sanitizeClone(document, clonedDocument)
  const clonedArticle = articleRoot?.cloneNode(true) || null
  if (articleRoot && clonedArticle) sanitizeClone(articleRoot, clonedArticle)
  const articleImage = Array.from(articleRoot?.querySelectorAll('img') || [])
    .map((image) => resolveImage(image))
    .find((source) => isUsableImage(source) && !/(?:avatar|favicon|icon|logo|qr|sprite)/i.test(source))
  const rawTitle = pickMeta('meta[property="og:title"]', 'meta[name="twitter:title"]')
    || document.querySelector('h1')?.textContent?.trim()
    || document.title
    || location.hostname
  const sourceSite = pickMeta('meta[property="og:site_name"]', 'meta[name="application-name"]')
    || inferPageSite(document.title, document.querySelector('h1')?.textContent || '')
    || location.hostname
  const coverImage = articleImage
    || pickMeta('meta[property="og:image"]', 'meta[name="twitter:image"]')
    || null
  const visibleDateMatch = String(articleRoot?.innerText || articleRoot?.textContent || '')
    .match(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?/)
  const visiblePublishedAt = visibleDateMatch
    ? `${visibleDateMatch[1]}-${String(visibleDateMatch[2]).padStart(2, '0')}-${String(visibleDateMatch[3]).padStart(2, '0')}`
    : null

  return {
    url: location.href,
    title: cleanCollectedTitle(rawTitle, sourceSite),
    html: `<!doctype html>${clonedDocument.outerHTML}`,
    articleHtml: clonedArticle?.outerHTML || null,
    text: String(articleRoot?.innerText || articleRoot?.textContent || document.body?.innerText || document.body?.textContent || '').trim(),
    excerpt: pickMeta('meta[name="description"]', 'meta[property="og:description"]'),
    author: pickMeta('meta[name="author"]', 'meta[property="article:author"]'),
    publishedAt: articleRoot?.querySelector('time[datetime]')?.getAttribute('datetime')
      || visiblePublishedAt
      || pickMeta('meta[property="article:published_time"]')
      || pickMeta('meta[name="date"]')
      || null,
    sourceSite,
    coverImage
  }
}
