import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const collectorSource = readFileSync(new URL('../web-clip-extension/page-collector.js', import.meta.url), 'utf8')
  .replace(/^export\s+/, '')
const popupSource = `${collectorSource}\n${readFileSync(new URL('../web-clip-extension/popup.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '')}`

type PopupScriptContext = vm.Context & {
  cleanPageTitle: (title: string, siteName?: string) => string
  clipCurrentPage: () => Promise<void>
  collectPagePayload: () => {
    url: string
    title: string
    html: string
    articleHtml: string | null
    text: string
    excerpt: string | null
    author: string | null
    publishedAt: string | null
    sourceSite: string
    coverImage: string | null
  }
  document: Document
  location: Location
}

function loadPopupScript(
  tab = { id: 1, title: 'KnowBook Guide - Example', url: 'https://example.com/guide' },
  options: {
    stored?: Record<string, string>
    collected?: PopupScriptContext['collectPagePayload'] extends () => infer T ? T : never
    fetchImpl?: typeof fetch
  } = {}
): {
  context: PopupScriptContext
  popupDocument: Document
} {
  const popupDom = new JSDOM([
    '<!doctype html><html><body>',
    '<input id="endpoint">',
    '<input id="token">',
    '<input id="title">',
    '<textarea id="notes"></textarea>',
    '<div id="status"></div>',
    '<button id="saveSettings"></button>',
    '<button id="clipPage"></button>',
    '</body></html>'
  ].join(''), { url: 'https://extension.example/popup.html' })

  const chrome = {
    storage: {
      sync: {
        get: async (defaults: Record<string, string>) => ({ ...defaults, ...options.stored }),
        set: async () => undefined
      }
    },
    tabs: {
      query: async () => [tab]
    },
    scripting: {
      executeScript: async () => options.collected ? [{ result: options.collected }] : []
    }
  }
  const context = vm.createContext({
    console,
    document: popupDom.window.document,
    location: popupDom.window.location,
    URL: popupDom.window.URL,
    atob: popupDom.window.atob.bind(popupDom.window),
    chrome,
    fetch: options.fetchImpl ?? (async () => {
      throw new Error('unexpected fetch')
    })
  }) as PopupScriptContext

  new vm.Script(popupSource, { filename: 'web-clip-extension/popup.js' }).runInContext(context)
  return { context, popupDocument: popupDom.window.document }
}

test('web clip extension title helper normalizes user-facing payload text', () => {
  const { context } = loadPopupScript()

  assert.equal(context.cleanPageTitle('  A practical KnowBook guide   -   Example  ', 'Example'), 'A practical KnowBook guide')
  assert.equal(context.cleanPageTitle('Short - Topic', 'Elsewhere'), 'Short - Topic')
})

test('collectPagePayload captures metadata, resolves lazy images, and removes unsafe embedded content', () => {
  const { context } = loadPopupScript()
  const pageDom = new JSDOM([
    '<!doctype html><html><head>',
    '<title>A practical KnowBook guide - Example</title>',
    '<meta property="og:title" content="A practical KnowBook guide - Example">',
    '<meta property="og:site_name" content="Example">',
    '<meta name="description" content="A useful article">',
    '<meta name="author" content="Ada">',
    '<meta property="article:published_time" content="2026-08-16T10:00:00+08:00">',
    '<meta name="date" content="2026-08-16">',
    '<script>window.tracker = true</script>',
    '<script>const data_arr = [1, 2, 3]</script>',
    '</head><body>',
    '<main><h1>A practical KnowBook guide</h1>',
    '<figure><img alt="Cover" data-src="/images/cover.jpg" src="/images/loading.gif"></figure>',
    '<iframe src="https://tracker.example"></iframe>',
    '<p>发布于 2026年07月29日</p><p>Article body</p></main>',
    '</body></html>'
  ].join(''), { url: 'https://example.com/articles/guide' })

  context.document = pageDom.window.document
  context.location = pageDom.window.location
  const payload = context.collectPagePayload()

  assert.equal(payload.url, 'https://example.com/articles/guide')
  assert.equal(payload.title, 'A practical KnowBook guide')
  assert.equal(payload.sourceSite, 'Example')
  assert.equal(payload.coverImage, 'https://example.com/images/cover.jpg')
  assert.equal(payload.excerpt, 'A useful article')
  assert.equal(payload.author, 'Ada')
  assert.equal(payload.publishedAt, '2026-07-29')
  assert.equal(payload.html.includes('https://example.com/images/cover.jpg'), true)
  assert.equal(payload.html.includes('data-src='), false)
  assert.equal(payload.html.includes('window.tracker'), false)
  assert.equal(payload.html.includes('data_arr'), true)
  assert.equal(payload.html.includes('<iframe'), false)
  assert.match(payload.articleHtml ?? '', /<main>/)
  assert.equal(payload.text.includes('Article body'), true)
})

test('clipCurrentPage keeps the collected title unless the user edits it and sends notes independently', async () => {
  let submittedPayload: Record<string, unknown> | null = null
  const collected = {
    url: 'https://github.com/microsoft/TypeScript',
    title: 'microsoft/TypeScript: TypeScript is JavaScript with syntax for types',
    html: '<!doctype html><html><body><main>Repository</main></body></html>',
    articleHtml: '<main><h1>TypeScript</h1><p>Repository documentation.</p></main>',
    text: 'Repository documentation.',
    excerpt: null,
    author: null,
    publishedAt: null,
    sourceSite: 'GitHub',
    coverImage: null
  }
  const { context, popupDocument } = loadPopupScript({
    id: 7,
    title: 'GitHub - microsoft/TypeScript: TypeScript is JavaScript with syntax for types',
    url: collected.url
  }, {
    stored: { token: 'bridge-token' },
    collected,
    fetchImpl: (async (_input, init) => {
      submittedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ created: true, title: collected.title }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof fetch
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  ;(popupDocument.getElementById('notes') as HTMLTextAreaElement).value = 'Keep this repository handy.'

  await context.clipCurrentPage()

  assert.ok(submittedPayload)
  const submitted = submittedPayload as Record<string, unknown>
  assert.equal(submitted.title, collected.title)
  assert.equal(submitted.notes, 'Keep this repository handy.')
  assert.equal(submitted.text, collected.text)
  assert.equal(popupDocument.getElementById('status')?.textContent, `剪藏成功：${collected.title}`)

  ;(popupDocument.getElementById('title') as HTMLInputElement).value = '自定义 TypeScript 标题'
  await context.clipCurrentPage()
  assert.equal((submittedPayload as Record<string, unknown>).title, '自定义 TypeScript 标题')
})

test('clipCurrentPage stops before page injection when the bearer token is missing', async () => {
  const { context, popupDocument } = loadPopupScript()
  await new Promise((resolve) => setTimeout(resolve, 0))

  await context.clipCurrentPage()

  assert.equal(popupDocument.getElementById('status')?.textContent, '请先填写 Bearer Token。')
  assert.equal((popupDocument.getElementById('clipPage') as HTMLButtonElement).disabled, false)
})
