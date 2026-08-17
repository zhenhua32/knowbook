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
  const inferKnownSite = (hostname) => {
    const normalized = String(hostname || '').replace(/^www\./i, '').toLowerCase()
    const knownSites = [
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
      ['jianshu.com', '简书']
    ]
    for (const [domain, name] of knownSites) {
      if (normalized === domain || normalized.endsWith(`.${domain}`)) return name
    }
    return null
  }
  const readElementValue = (selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const value = typeof element.value === 'string' ? element.value : element.textContent
    return value?.trim() || null
  }
  const normalizeCollectedAuthor = (value) => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim()
    if (
      !normalized
      || /^\d+$/u.test(normalized)
      || /^(?:chinanews|discuz! team and comsenz ui team)$/i.test(normalized)
      || /^本词条由.+审核/u.test(normalized)
    ) return null
    return normalized
  }
  const normalizeTimestamp = (value) => {
    const normalized = String(value || '').trim()
    if (!/^\d{10,13}$/.test(normalized)) return null
    const numeric = Number(normalized)
    const date = new Date(normalized.length === 10 ? numeric * 1000 : numeric)
    return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10)
  }
  const materializeEmbeddedArticle = () => {
    const field = document.querySelector('textarea.article-content')
    const embeddedHtml = typeof field?.value === 'string' ? field.value.trim() : field?.textContent?.trim()
    if (!field || !embeddedHtml || !/<(?:article|section|p)\b/i.test(embeddedHtml)) return null

    const root = document.createElement('article')
    root.className = 'knowbook-embedded-article'
    root.innerHTML = embeddedHtml
    return root
  }
  const cleanCollectedTitle = (title, siteName = '') => {
    const normalized = String(title || '').replace(/\s+/g, ' ').trim()
    if (siteName === '澎湃新闻' && normalized.includes('_')) {
      return normalized.split('_')[0].trim()
    }
    const compactSiteSuffix = `--${String(siteName || '').trim()}`
    if (compactSiteSuffix.length > 2 && normalized.endsWith(compactSiteSuffix)) {
      const withoutSite = normalized.slice(0, -compactSiteSuffix.length).trim()
      const channelSeparator = withoutSite.lastIndexOf('--')
      return channelSeparator >= 6 ? withoutSite.slice(0, channelSeparator).trim() : withoutSite
    }
    const segments = normalized.split(/(?:\s+[-–—]\s+|\s*[|_]\s*|\s+·\s+)/).map((segment) => segment.trim()).filter(Boolean)
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
      '.knowbook-embedded-article',
      'article',
      '#post_body',
      '#article-content',
      '#articleContent',
      '#content_area',
      '.content_area',
      '.rm_txt_con',
      '#J-lemma-main-wrapper',
      '.mw-parser-output',
      '#blog_article',
      '.main_content',
      '.wang-editor-content',
      '#sonsyuanwen',
      '.main3',
      '.left',
      '[class^="cententWrap__"]',
      '[class*=" cententWrap__"]',
      '.article',
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
      const siteSpecificBonus = /(?:^|\s)(?:knowbook-embedded-article|mw-parser-output|main_content|wang-editor-content)(?:\s|$)/i.test(identity)
        || /^(?:J-lemma-main-wrapper|blog_article|content_area|sonsyuanwen)$/i.test(element.id || '')
        || (element.classList.contains('article') && /(?:^|\.)douban\.com$/i.test(location.hostname))
        || (/cententWrap__/i.test(identity) && /(?:^|\.)thepaper\.cn$/i.test(location.hostname))
        || (/(?:^|\s)(?:main3|left)(?:\s|$)/i.test(identity) && /(?:gushiwen\.cn|guwendao\.net)$/i.test(location.hostname))
        ? 15000
        : 0
      const contentBonus = /(?:^|\s)(?:editor|markdown-body|article-content|article-body|post-content|entry-content|rich_media_content|blog-content-body|newsCo)(?:\s|$)/i.test(identity)
        ? 5000
        : /(?:article|post|entry|markdown|editor|news)[-_ ]?(?:body|content|detail)?/i.test(identity) ? 1000 : 0
      const score = text.length + paragraphCount * 110 + headingCount * 70 + richCount * 35
        + semanticBonus + siteSpecificBonus + contentBonus - linkDensity * text.length * 1.5
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
    clonedRoot.querySelectorAll([
      'noscript',
      'template',
      'iframe',
      'dialog',
      'nav',
      'aside',
      'footer',
      '#adSide',
      '.operate-block',
      '[data-mod-name^="pep-ad"]',
      '[class^="recommend-"]',
      '[class*=" recommend-"]',
      '[id^="recommend-"]',
      '[class^="comment-"]',
      '[class*=" comment-"]',
      '[id^="comment-"]',
      '#comments',
      '.comments',
      '.Post-Sub',
      '.ContentItem-actions',
      '.RichContent-actions',
      '[class*="Recommendations"]',
      '[class*="advert"]',
      '[id*="advert"]',
      '[class*="ad-container"]',
      '[class*="ad_placeholder"]'
    ].join(',')).forEach((node) => node.remove())

    const trailingBoundary = Array.from(clonedRoot.querySelectorAll('h2,h3,h4,strong,div,p'))
      .find((node) => /^(?:猜您喜欢|相关推荐|推荐阅读|延伸阅读)$/u.test(String(node.textContent || '').replace(/\s+/g, ' ').trim()))
    if (trailingBoundary) {
      let section = trailingBoundary.closest('section,aside,.sons') || trailingBoundary
      while (section) {
        const next = section.nextElementSibling
        section.remove()
        section = next
      }
    }
  }

  const embeddedTitle = readElementValue('textarea.article-title')
  const embeddedTimestamp = readElementValue('textarea.article-time')
  const embeddedArticle = materializeEmbeddedArticle()
  const articleRoot = embeddedArticle || findBestContentRoot()
  const clonedDocument = document.documentElement.cloneNode(true)
  sanitizeClone(document, clonedDocument)
  const clonedArticle = articleRoot?.cloneNode(true) || null
  if (articleRoot && clonedArticle) sanitizeClone(articleRoot, clonedArticle)
  const articleImage = Array.from(articleRoot?.querySelectorAll('img') || [])
    .map((image) => resolveImage(image))
    .find((source) => isUsableImage(source) && !/(?:avatar|favicon|icon|logo|qr|sprite)/i.test(source))
  const metadataTitle = pickMeta('meta[property="og:title"]', 'meta[name="twitter:title"]')
  const headingTitle = document.querySelector('h1')?.textContent?.trim()
  const rawTitle = embeddedTitle
    || (/^(?:博文|文章|首页|详情|正文)$/u.test(metadataTitle || '') ? null : metadataTitle)
    || headingTitle
    || document.title
    || location.hostname
  const sourceSite = inferKnownSite(location.hostname)
    || pickMeta('meta[property="og:site_name"]', 'meta[name="application-name"]')
    || inferPageSite(document.title, document.querySelector('h1')?.textContent || '')
    || location.hostname
  const coverImage = articleImage
    || pickMeta('meta[property="og:image"]', 'meta[name="twitter:image"]')
    || null
  const visibleArticleText = String(articleRoot?.innerText || articleRoot?.textContent || '')
  const explicitDateMatch = visibleArticleText.match(/(?:发布于|发布时间|上传时间|编辑于)\s*[:：]?\s*(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?/)
  const visibleDateMatch = explicitDateMatch || visibleArticleText.slice(0, 2500)
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
    author: normalizeCollectedAuthor(pickMeta('meta[name="author"]', 'meta[property="article:author"]')),
    publishedAt: articleRoot?.querySelector('time[datetime]')?.getAttribute('datetime')
      || visiblePublishedAt
      || normalizeTimestamp(embeddedTimestamp)
      || pickMeta('meta[property="article:published_time"]')
      || pickMeta('meta[name="date"]')
      || null,
    sourceSite,
    coverImage
  }
}
