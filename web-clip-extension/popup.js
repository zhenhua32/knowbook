import { collectPagePayload } from './page-collector.js'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:3210/clip'

const endpointInput = document.getElementById('endpoint')
const tokenInput = document.getElementById('token')
const titleInput = document.getElementById('title')
const notesInput = document.getElementById('notes')
const statusNode = document.getElementById('status')
const saveSettingsButton = document.getElementById('saveSettings')
const clipPageButton = document.getElementById('clipPage')
let initializedTitle = ''

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
  initializedTitle = cleanPageTitle(tab?.title || '')
  titleInput.value = initializedTitle
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

    const enteredTitle = titleInput.value.trim()
    const payload = {
      ...result,
      parentId: null,
      title: enteredTitle && enteredTitle !== initializedTitle ? enteredTitle : result.title,
      notes: notesInput.value.trim() || undefined
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
  const shouldStrip = prefix.length >= 6 && Boolean(comparableSite) && (
    comparableSite.includes(comparableSuffix)
    || comparableSuffix.includes(comparableSite)
  )
  return shouldStrip ? prefix : normalized
}
