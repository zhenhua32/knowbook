const DEFAULT_ENDPOINT = 'http://127.0.0.1:3210/clip'

const endpointInput = document.getElementById('endpoint')
const tokenInput = document.getElementById('token')
const titleInput = document.getElementById('title')
const notesInput = document.getElementById('notes')
const statusNode = document.getElementById('status')
const saveSettingsButton = document.getElementById('saveSettings')
const clipPageButton = document.getElementById('clipPage')

initialize().catch((error) => {
  setStatus(`初始化失败：${error instanceof Error ? error.message : String(error)}`)
})

saveSettingsButton.addEventListener('click', () => {
  void saveSettings()
})

clipPageButton.addEventListener('click', () => {
  void clipCurrentPage()
})

async function initialize() {
  const stored = await chrome.storage.sync.get({
    endpoint: DEFAULT_ENDPOINT,
    token: ''
  })

  endpointInput.value = stored.endpoint || DEFAULT_ENDPOINT
  tokenInput.value = stored.token || ''

  const tab = await getActiveTab()
  titleInput.value = cleanPageTitle(tab?.title || '')
  setStatus(tab?.url ? `已连接当前页：${tab.url}` : '未获取到当前标签页。')
}

async function saveSettings() {
  await chrome.storage.sync.set({
    endpoint: endpointInput.value.trim() || DEFAULT_ENDPOINT,
    token: tokenInput.value.trim()
  })

  setStatus('扩展配置已保存。')
}

async function clipCurrentPage() {
  const endpoint = endpointInput.value.trim() || DEFAULT_ENDPOINT
  const token = tokenInput.value.trim()

  if (!token) {
    setStatus('请先填写 Bearer Token。')
    return
  }

  const tab = await getActiveTab()
  if (!tab?.id || !tab.url) {
    setStatus('当前没有可剪藏的标签页。')
    return
  }

  if (!/^https?:/i.test(tab.url)) {
    setStatus('只支持剪藏 http/https 页面。')
    return
  }

  clipPageButton.disabled = true
  setStatus('正在读取页面内容并发送到 KnowBook...')

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectPagePayload
    })

    const payload = {
      ...result,
      parentId: null,
      title: titleInput.value.trim() || result.title,
      text: appendNotes(result.text, notesInput.value.trim())
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    })

    const body = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(body?.error || `Bridge request failed (${response.status}).`)
    }

    await chrome.storage.sync.set({ endpoint, token })
    setStatus(body?.created === false
      ? `已复用已有文档：${body.title || payload.title}`
      : `剪藏成功：${body?.title || payload.title}`)
  } catch (error) {
    setStatus(`剪藏失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clipPageButton.disabled = false
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab || null
}

function setStatus(message) {
  statusNode.textContent = message
}

function appendNotes(text, notes) {
  if (!notes) {
    return text
  }

  return [text, `Extension notes: ${notes}`].filter(Boolean).join('\n\n')
}

function collectPagePayload() {
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
    const shouldStrip = prefix.length >= 6 && (
      !comparableSite
      || comparableSite.includes(comparableSuffix)
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

  const clonedDocument = document.documentElement.cloneNode(true)
  const liveImages = Array.from(document.querySelectorAll('img'))
  const clonedImages = Array.from(clonedDocument.querySelectorAll('img'))
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
  clonedDocument.querySelectorAll('script').forEach((node) => {
    if (!/\bdata_arr\s*=\s*\[/i.test(node.textContent || '')) {
      node.remove()
    }
  })
  clonedDocument.querySelectorAll('noscript, template, iframe').forEach((node) => node.remove())

  const articleRoot = document.querySelector([
    'article',
    '#post_body',
    '.article-content',
    '.article-body',
    '.entry-content',
    '.post-content',
    '.news-content',
    '.newsCo',
    'main'
  ].join(','))
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

  return {
    url: location.href,
    title: cleanCollectedTitle(rawTitle, sourceSite),
    html: `<!doctype html>${clonedDocument.outerHTML}`,
    text: document.body?.innerText?.trim() || '',
    excerpt: pickMeta('meta[name="description"]', 'meta[property="og:description"]'),
    author: pickMeta('meta[name="author"]', 'meta[property="article:author"]'),
    publishedAt: pickMeta('meta[property="article:published_time"]', 'meta[name="date"]')
      || document.querySelector('time[datetime]')?.getAttribute('datetime')
      || null,
    sourceSite,
    coverImage
  }
}

function inferSiteName(title, heading) {
  const segments = String(title || '').split(/\s+(?:[-–—|·])\s+/).map((segment) => segment.trim()).filter(Boolean)
  if (segments.length < 2) return null
  const suffix = segments[segments.length - 1]
  const prefix = segments.slice(0, -1).join(' ')
  if (!suffix || suffix.length > 40 || suffix.length >= prefix.length || String(heading || '').includes(suffix)) return null
  return suffix
}

function cleanPageTitle(title, siteName = '') {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim()
  const segments = normalized.split(/\s+(?:[-–—|·])\s+/).map((segment) => segment.trim()).filter(Boolean)
  if (segments.length < 2) return normalized
  const suffix = segments[segments.length - 1]
  const prefix = segments.slice(0, -1).join(' ')
  const comparableSuffix = suffix.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const comparableSite = String(siteName || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const shouldStrip = prefix.length >= 6 && (
    !comparableSite
    || comparableSite.includes(comparableSuffix)
    || comparableSuffix.includes(comparableSite)
  )
  return shouldStrip ? prefix : normalized
}
