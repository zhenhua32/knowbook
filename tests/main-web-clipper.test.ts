import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import { KnowbookStore } from '../src/main/database/store.ts'
import { createPinnedLookup, WebClipperService } from '../src/main/web-clipper.ts'

async function withHtmlServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === '/cover.jpg') {
      response.writeHead(200, { 'Content-Type': 'image/jpeg' })
      response.end('fake-image')
      return
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html>
        <head>
          <title>Example Article</title>
          <meta property="og:title" content="Example Article" />
          <meta property="og:description" content="A concise article summary for clipping." />
          <meta property="og:site_name" content="Example Site" />
          <meta property="article:published_time" content="2026-05-31T08:00:00.000Z" />
          <meta name="author" content="Alice Example" />
          <meta property="og:image" content="/cover.jpg" />
        </head>
        <body>
          <article>
            <h1>Example Article</h1>
            <p>Alpha paragraph with enough detail to survive readability extraction.</p>
            <p>Beta paragraph with <strong>formatting</strong> and a <a href="/more">relative link</a>.</p>
          </article>
        </body>
      </html>`)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    await run(baseUrl)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }
}

async function withLazyArticleServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url?.endsWith('.jpg') || request.url === '/site-logo.svg') {
      response.writeHead(200, { 'Content-Type': request.url.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg' })
      response.end(`image:${request.url}`)
      return
    }
    if (request.url === '/lazy-placeholder.gif') {
      response.writeHead(200, { 'Content-Type': 'image/gif' })
      response.end('placeholder')
      return
    }

    const origin = `http://${request.headers.host}`
    const encodedHero = Buffer.from(`${origin}/hero.jpg`, 'utf8').toString('base64')
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html>
        <head>
          <title>GPU Lab Review - Example Tech</title>
          <meta name="description" content="Example Tech focuses on every technology category across the entire site." />
          <meta property="og:image" content="/site-logo.svg" />
        </head>
        <body>
          <header><img src="/site-logo.svg" alt="logo" /></header>
          <h1>GPU Lab Review</h1>
          <div id="post_body" class="newsCo">
            <p>This is the real article introduction with enough detail to become the useful clipping summary and readable body.</p>
            <p><img class="lazy" src="/lazy-placeholder.gif" data-original="${encodedHero}" /></p>
            <p><img class="lazy" src="/lazy-placeholder.gif" data-original="${encodedHero}" /></p>
            <p><a href="/gallery.jpg"><img class="expwatermark" src="blob:${origin}/runtime-watermark" /></a></p>
            <p><img class="expwatermark" src="blob:${origin}/unrecoverable-watermark" /></p>
            <h1>Performance</h1>
            <p>The benchmark section contains useful prose and should remain part of the clipped document.</p>
            <table>
              <tr><th>Mode</th><th>Score</th></tr>
              <tr><td>Default</td><td>100</td></tr>
            </table>
            <script>
              var title_text = "Frame rate comparison";
              var unit_text = "fps";
              var data_arr = [
                {"type":"Game A","GPU One":"120","GPU Two":"110"},
                {"type":"Game B","GPU One":"90","GPU Two":"88"}
              ];
            </script>
          </div>
        </body>
      </html>`)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    await run(baseUrl)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

test('WebClipperService clips a webpage into a child document and stores source fields', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'), { allowPrivateNetwork: true })

  try {
    const parentId = store.createDocument(null)
    store.updateDocument(parentId, {
      title: 'Inbox',
      summary: 'Inbox summary',
      blocks: [
        { type: 'heading-1', content: 'Inbox', checked: false, depth: 0 },
        { type: 'paragraph', content: 'Incoming notes live here.', checked: false, depth: 0 }
      ]
    })

    await withHtmlServer(async (baseUrl) => {
      const result = await service.clipWebPage({
        url: `${baseUrl}/article`,
        parentId
      })

      assert.equal(result.created, true)
      assert.equal(result.duplicateOfDocumentId, null)
      assert.equal(result.title, 'Example Article')
      assert.equal(result.sourceUrl, `${baseUrl}/article`)
      assert.deepEqual(result.warnings, [])

      const detail = store.getDocumentDetail(result.documentId)
      assert.ok(detail)
      assert.equal(detail.title, 'Example Article')
      assert.equal(detail.path, 'Inbox/Example Article')
      assert.equal(detail.blocks[0]?.type, 'heading-1')
      assert.equal(detail.blocks[0]?.content, 'Example Article')
      assert.equal(detail.blocks.some((block) => block.content.includes('来源：')), true)
      assert.equal(detail.blocks.some((block) => block.content.includes('Alpha paragraph')), true)

      const home = store.getHomeData(join(tempRoot, 'backup'))
      const clippedEntry = home.documentCatalog.find((entry) => entry.id === result.documentId)
      const sourceUrlColumn = home.databaseColumns.find((column) => column.name === 'Source URL')
      const sourceSiteColumn = home.databaseColumns.find((column) => column.name === 'Source Site')
      const publishedAtColumn = home.databaseColumns.find((column) => column.name === 'Published At')
      const authorColumn = home.databaseColumns.find((column) => column.name === 'Author')
      const clipStatusColumn = home.databaseColumns.find((column) => column.name === 'Clip Status')
      const coverImageColumn = home.databaseColumns.find((column) => column.name === 'Cover Image')

      assert.ok(clippedEntry)
      assert.ok(sourceUrlColumn)
      assert.ok(sourceSiteColumn)
      assert.ok(publishedAtColumn)
      assert.ok(authorColumn)
      assert.ok(clipStatusColumn)
      assert.ok(coverImageColumn)
      assert.equal(clippedEntry.fieldValues[sourceUrlColumn.id], `${baseUrl}/article`)
      assert.equal(clippedEntry.fieldValues[sourceSiteColumn.id], 'Example Site')
      assert.equal(clippedEntry.fieldValues[publishedAtColumn.id], '2026-05-31')
      assert.equal(clippedEntry.fieldValues[authorColumn.id], 'Alice Example')
      assert.equal(clippedEntry.fieldValues[clipStatusColumn.id], 'clipped')
      assert.match(String(clippedEntry.fieldValues[coverImageColumn.id]), /^file:\/\//)
    })
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService normalizes lazy images, runtime blob images, titles, tables, and duplicate covers', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-rich-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'), { allowPrivateNetwork: true })

  try {
    await withLazyArticleServer(async (baseUrl) => {
      const result = await service.clipWebPage({
        url: `${baseUrl}/review`,
        parentId: null
      })

      assert.equal(result.created, true)
      assert.equal(result.title, 'GPU Lab Review')
      assert.deepEqual(result.warnings, [])

      const detail = store.getDocumentDetail(result.documentId)
      assert.ok(detail)
      const markdown = detail.blocks.map((block) => block.content).join('\n\n')
      const localizedImages = [...markdown.matchAll(/!\[[^\]]*\]\((file:\/\/[^)]+)\)/g)].map((match) => match[1])

      assert.equal(detail.blocks[0]?.type, 'heading-1')
      assert.equal(detail.blocks[0]?.content, 'GPU Lab Review')
      assert.equal(detail.blocks.some((block) => block.type === 'heading-2' && block.content === 'Performance'), true)
      assert.equal(detail.blocks.some((block) => block.type === 'table' && block.content.includes('| Mode | Score |')), true)
      assert.equal(detail.blocks.some((block) => block.type === 'heading-2' && block.content === 'Frame rate comparison'), true)
      assert.equal(detail.blocks.some((block) => block.type === 'table' && block.content.includes('| 项目 | GPU One | GPU Two |')), true)
      assert.equal(detail.blocks.some((block) => block.content.includes('来源：[Example Tech]')), true)
      assert.equal(markdown.includes('blob:'), false)
      assert.equal(markdown.includes('lazy-placeholder.gif'), false)
      assert.equal(markdown.includes('site-logo.svg'), false)
      assert.equal(localizedImages.length, 2)
      assert.equal(new Set(localizedImages).size, 2)

      const home = store.getHomeData(join(tempRoot, 'backup'))
      const entry = home.documentCatalog.find((item) => item.id === result.documentId)
      const sourceSiteColumn = home.databaseColumns.find((column) => column.name === 'Source Site')
      const coverImageColumn = home.databaseColumns.find((column) => column.name === 'Cover Image')
      assert.ok(entry)
      assert.ok(sourceSiteColumn)
      assert.ok(coverImageColumn)
      assert.equal(entry.fieldValues[sourceSiteColumn.id], 'Example Tech')
      assert.equal(entry.fieldValues[coverImageColumn.id], localizedImages[0])
    })
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService reuses an existing document when source URL and clip hash already match', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-dup-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'), { allowPrivateNetwork: true })

  try {
    await withHtmlServer(async (baseUrl) => {
      const first = await service.clipWebPage({
        url: `${baseUrl}/article`,
        parentId: null
      })
      const second = await service.clipWebPage({
        url: `${baseUrl}/article`,
        parentId: null
      })

      assert.equal(first.created, true)
      assert.equal(second.created, false)
      assert.equal(second.documentId, first.documentId)
      assert.equal(second.duplicateOfDocumentId, first.documentId)

      const matchingEntries = store.getHomeData(join(tempRoot, 'backup')).documentCatalog.filter((entry) => entry.path === 'Example Article')
      assert.equal(matchingEntries.length, 1)
    })
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService blocks local network targets by default', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-ssrf-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))

  try {
    await assert.rejects(
      () => service.clipWebPage({ url: 'http://127.0.0.1/private', parentId: null }),
      /cannot access local or private network addresses/
    )
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService rolls back the entire clip when metadata persistence fails', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-rollback-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))
  const catalogBefore = store.getHomeData(join(tempRoot, 'backup')).documentCatalog.map((entry) => entry.id)
  const originalUpdateValue = store.updateDocumentDatabaseValue.bind(store)
  let updateCount = 0

  store.updateDocumentDatabaseValue = ((...args: Parameters<KnowbookStore['updateDocumentDatabaseValue']>) => {
    updateCount += 1
    if (updateCount === 2) {
      throw new Error('simulated metadata failure')
    }
    return originalUpdateValue(...args)
  }) as KnowbookStore['updateDocumentDatabaseValue']

  try {
    await assert.rejects(
      () => service.importWebClipPayload({
        url: 'https://example.com/atomic-clip',
        parentId: null,
        title: 'Atomic Clip',
        text: 'This document must not survive a partial metadata write.'
      }),
      /simulated metadata failure/
    )

    const homeAfter = store.getHomeData(join(tempRoot, 'backup'))
    assert.deepEqual(homeAfter.documentCatalog.map((entry) => entry.id), catalogBefore)
    assert.equal(homeAfter.databaseColumns.some((column) => column.name === 'Source URL'), false)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService does not reuse user columns with incompatible types', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-column-type-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))

  try {
    const incompatibleColumn = store.createDocumentDatabaseColumn({
      name: 'Source URL',
      type: 'checkbox'
    })
    const result = await service.importWebClipPayload({
      url: 'https://example.com/typed-columns',
      parentId: null,
      title: 'Typed Columns',
      text: 'The clipper should create and use its own text metadata column.'
    })

    const home = store.getHomeData(join(tempRoot, 'backup'))
    const sourceUrlTextColumn = home.databaseColumns.find((column) => column.name === 'Source URL' && column.type === 'text')
    const entry = home.documentCatalog.find((item) => item.id === result.documentId)
    assert.ok(sourceUrlTextColumn)
    assert.ok(entry)
    assert.equal(entry.fieldValues[sourceUrlTextColumn.id], 'https://example.com/typed-columns')
    assert.equal(entry.fieldValues[incompatibleColumn.id], undefined)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService rejects malformed runtime payloads before touching the store', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-input-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))
  const documentCountBefore = store.getHomeData(join(tempRoot, 'backup')).summary.documents

  try {
    await assert.rejects(
      () => service.importWebClipPayload({ url: 42 } as never),
      /URL is required/
    )
    await assert.rejects(
      () => service.importWebClipPayload({
        url: 'https://example.com',
        parentId: null,
        text: ['not', 'text']
      } as never),
      /field "text" must be a string/
    )
    assert.equal(store.getHomeData(join(tempRoot, 'backup')).summary.documents, documentCountBefore)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('createPinnedLookup returns the pinned address in scalar and all-address modes', async () => {
  const pinned = { address: '203.0.113.9', family: 4 }
  const pinnedLookup = createPinnedLookup(pinned)
  const allAddresses = await new Promise<unknown>((resolve, reject) => {
    pinnedLookup('example.com', { all: true }, (error, address) => {
      if (error) reject(error)
      else resolve(address)
    })
  })
  const scalarAddress = await new Promise<{ address: unknown; family: number | undefined }>((resolve, reject) => {
    pinnedLookup('example.com', { all: false }, (error, address, family) => {
      if (error) reject(error)
      else resolve({ address, family })
    })
  })

  assert.deepEqual(allAddresses, [pinned])
  assert.deepEqual(scalarAddress, { address: pinned.address, family: pinned.family })
})

test('WebClipperService prefers captured article HTML, sanitizes repository titles, and persists notes', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-browser-payload-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))

  try {
    const result = await service.importWebClipPayload({
      url: 'https://github.com/microsoft/TypeScript',
      parentId: null,
      title: 'GitHub - microsoft/TypeScript: TypeScript is JavaScript with syntax for types - GitHub',
      sourceSite: 'GitHub',
      author: 'https://github.com/microsoft',
      publishedAt: 'not-a-valid-date',
      html: '<!doctype html><html><head><title>GitHub</title></head><body><main>Global navigation and repository shell</main></body></html>',
      articleHtml: '<article><h1>microsoft/TypeScript</h1><p>TypeScript extends JavaScript by adding types to the language.</p><p>This repository contains the compiler, language services, and project documentation.</p><p><a href="javascript:alert(1)">Unsafe action</a></p><p>&lt;script&gt;window.__NUXT__={huge:true}&lt;/script&gt;</p><p>&lt;/article&gt;&lt;div class="comment-skeleton"&gt;Hydration page tail&lt;/div&gt;</p></article>',
      text: 'TypeScript extends JavaScript by adding types to the language.\n\nThis repository contains the compiler, language services, and project documentation.',
      notes: 'Keep this repository handy.'
    })

    assert.equal(result.created, true)
    assert.equal(result.title, 'microsoft／TypeScript: TypeScript is JavaScript with syntax for types')
    const detail = store.getDocumentDetail(result.documentId)
    assert.ok(detail)
    const markdown = detail.blocks.map((block) => block.content).join('\n\n')
    assert.equal(markdown.includes('compiler, language services'), true)
    assert.equal(markdown.includes('Global navigation'), false)
    assert.equal(markdown.includes('Extension notes: Keep this repository handy.'), true)
    assert.equal(markdown.includes('<script'), false)
    assert.equal(markdown.includes('comment-skeleton'), false)
    assert.equal(markdown.includes('javascript:'), false)
    assert.equal(markdown.includes('Unsafe action'), true)

    const home = store.getHomeData(join(tempRoot, 'backup'))
    const entry = home.documentCatalog.find((item) => item.id === result.documentId)
    const authorColumn = home.databaseColumns.find((column) => column.name === 'Author')
    const publishedAtColumn = home.databaseColumns.find((column) => column.name === 'Published At')
    assert.ok(entry)
    assert.ok(authorColumn)
    assert.ok(publishedAtColumn)
    assert.equal(entry.fieldValues[authorColumn.id], undefined)
    assert.equal(entry.fieldValues[publishedAtColumn.id], undefined)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService cleans site and author suffixes, prefers visible article dates, and decodes embedded rich text', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-metadata-cleanup-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))

  try {
    const result = await service.importWebClipPayload({
      url: 'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs',
      parentId: null,
      title: 'Introduction to Node.js | Node.js Learn',
      sourceSite: 'Node.js',
      author: 'Node Team 粉丝 - 4336 关注 - 106',
      publishedAt: '2026-08-16T10:00:00+08:00',
      articleHtml: [
        '<article><h1>Introduction to Node.js</h1>',
        '<p>Node.js is a cross-platform JavaScript runtime with an asynchronous event-driven architecture.</p>',
        '<p>发布于 2025年07月16日</p>',
        '<p>The rendered introduction remains readable before embedded content.&lt;/span&gt;&lt;/p&gt;',
        '&lt;p data-type="paragraph"&gt;&lt;span&gt;Decoded continuation paragraph one.&lt;/span&gt;&lt;/p&gt;',
        '&lt;p data-type="paragraph"&gt;&lt;strong&gt;Decoded heading&lt;/strong&gt;&lt;/p&gt;',
        '&lt;p data-type="paragraph"&gt;&lt;span&gt;Decoded continuation paragraph two.&lt;/span&gt;&lt;/p&gt;',
        '&lt;p&gt;Meaningful tail\u2028点赞\u2028收藏\u2028关注作者&lt;/p&gt;',
        '&lt;img alt="博客详情页底部广告位.jpg" src="https://cdn.example.com/ad-banner.jpg"&gt;',
        '&lt;p&gt;&lt;img alt="logo" src="https://cdn.example.com/logo.png"&gt;&lt;/p&gt;',
        '&lt;p&gt;促进软件开发及相关领域知识与创新的传播&lt;/p&gt;',
        '&lt;script&gt;window.__NUXT__={huge:true}&lt;/script&gt;',
        '</article>'
      ].join('')
    })

    assert.equal(result.title, 'Introduction to Node.js')
    const detail = store.getDocumentDetail(result.documentId)
    assert.ok(detail)
    const markdown = detail.blocks.map((block) => block.content).join('\n\n')
    assert.equal(markdown.includes('Decoded continuation paragraph two.'), true)
    assert.equal(markdown.includes('data-type='), false)
    assert.equal(markdown.includes('__NUXT__'), false)
    assert.equal(markdown.includes('促进软件开发'), false)
    assert.equal(markdown.includes('点赞'), false)
    assert.equal(markdown.includes('底部广告位'), false)
    assert.equal(markdown.includes('Meaningful tail'), true)

    const home = store.getHomeData(join(tempRoot, 'backup'))
    const entry = home.documentCatalog.find((item) => item.id === result.documentId)
    const authorColumn = home.databaseColumns.find((column) => column.name === 'Author')
    const publishedAtColumn = home.databaseColumns.find((column) => column.name === 'Published At')
    assert.ok(entry)
    assert.ok(authorColumn)
    assert.ok(publishedAtColumn)
    assert.equal(entry.fieldValues[authorColumn.id], 'Node Team')
    assert.equal(entry.fieldValues[publishedAtColumn.id], '2025-07-16')
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService falls back to sufficiently rich browser-visible text when HTML extraction is empty', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-visible-text-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))
  const visibleText = Array.from({ length: 35 }, (_, index) => (
    `第 ${index + 1} 段介绍动态渲染文章的实际内容，包含足够的技术细节、示例说明与实现背景。`
  )).join('\n\n')

  try {
    const result = await service.importWebClipPayload({
      url: 'https://www.infoq.cn/article/dynamic-example',
      parentId: null,
      title: '动态渲染文章',
      sourceSite: 'InfoQ',
      html: '<!doctype html><html><head><title>InfoQ</title></head><body><div id="app"></div></body></html>',
      text: visibleText
    })

    assert.equal(result.created, true)
    assert.equal(result.warnings.some((warning) => warning.includes('browser-visible text')), true)
    const detail = store.getDocumentDetail(result.documentId)
    assert.ok(detail)
    assert.equal(detail.blocks.some((block) => block.content.includes('动态渲染文章的实际内容')), true)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService rejects short application shells instead of reporting a successful clip', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-shell-quality-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))
  const shellText = '首页 产品 文档 社区 登录 注册 搜索 热门推荐 联系我们 '.repeat(12)

  try {
    await assert.rejects(
      () => service.importWebClipPayload({
        url: 'https://developer.cloud.tencent.com/article/2640038',
        parentId: null,
        title: '腾讯云开发者社区',
        sourceSite: '腾讯云开发者社区',
        html: `<!doctype html><html><head><title>腾讯云开发者社区</title></head><body><main>${shellText}</main></body></html>`,
        text: shellText
      }),
      /application shell|structured article body|site shell/
    )
    await assert.rejects(
      () => service.importWebClipPayload({
        url: 'https://www.ithome.com/block/dajia.html',
        parentId: null,
        title: 'IT之家',
        html: '<!doctype html><html><body><main><h2>大家在看</h2><ul><li>热门文章一</li><li>热门文章二</li></ul><p>换一换推荐内容，不是用户请求的文章正文。</p></main></body></html>',
        text: '大家在看 热门文章一 热门文章二 换一换推荐内容，不是用户请求的文章正文。'
      }),
      /block or challenge page/
    )
    assert.equal(store.getHomeData(join(tempRoot, 'backup')).documentCatalog.some((entry) => entry.title === '腾讯云开发者社区'), false)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
