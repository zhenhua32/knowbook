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
  titleInput.value = tab?.title || ''
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

  return [text, '', `Extension notes: ${notes}`].filter(Boolean).join('\n')
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

  const coverImage = pickMeta('meta[property="og:image"]', 'meta[name="twitter:image"]')
    || document.querySelector('article img')?.src
    || document.querySelector('img')?.src
    || null

  return {
    url: location.href,
    title: document.title || location.hostname,
    html: document.documentElement.outerHTML,
    text: document.body?.innerText?.trim() || '',
    excerpt: pickMeta('meta[name="description"]', 'meta[property="og:description"]'),
    author: pickMeta('meta[name="author"]', 'meta[property="article:author"]'),
    publishedAt: pickMeta('meta[property="article:published_time"]', 'meta[name="date"]')
      || document.querySelector('time[datetime]')?.getAttribute('datetime')
      || null,
    sourceSite: pickMeta('meta[property="og:site_name"]', 'meta[name="application-name"]') || location.hostname,
    coverImage
  }
}