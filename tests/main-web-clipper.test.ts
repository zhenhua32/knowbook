import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import { KnowbookStore } from '../src/main/database/store.ts'
import { createPinnedLookup, extractWebClip, WebClipperService } from '../src/main/web-clipper.ts'

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

test('WebClipperService imports 环球网 article content embedded in textarea fields', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-huanqiu-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))

  try {
    const result = await service.importWebClipPayload({
      url: 'https://tech.huanqiu.com/article/example',
      parentId: null,
      html: [
        '<!doctype html><html><head><title>环球网应用</title></head><body><article>',
        '<textarea class="article-title">智慧城市数据利用顶层框架国际标准发布</textarea>',
        '<textarea class="article-content">&lt;article&gt;',
        '&lt;p&gt;国际标准正文第一段，详细介绍智慧城市数据利用的顶层框架、适用范围、基本原则和实施背景，确保采集器拿到的是完整正文。&lt;/p&gt;',
        '&lt;p&gt;正文第二段继续说明数据治理、跨部门协作、安全保障、技术接口和评估机制，并提供足够的内容用于文章质量判断。&lt;/p&gt;',
        '&lt;p&gt;正文第三段记录标准发布后的应用价值、国际合作意义以及后续推广计划。&lt;/p&gt;',
        '&lt;/article&gt;</textarea>',
        '<textarea class="article-time">1786929066305</textarea>',
        '</article></body></html>'
      ].join('')
    })

    assert.equal(result.created, true)
    assert.equal(result.title, '智慧城市数据利用顶层框架国际标准发布')
    const detail = store.getDocumentDetail(result.documentId)
    assert.ok(detail)
    const markdown = detail.blocks.map((block) => block.content).join('\n\n')
    assert.equal(markdown.includes('国际标准正文第一段'), true)
    assert.equal(markdown.includes('textarea'), false)

    const home = store.getHomeData(join(tempRoot, 'backup'))
    const entry = home.documentCatalog.find((item) => item.id === result.documentId)
    const sourceColumn = home.databaseColumns.find((column) => column.name === 'Source Site')
    const publishedAtColumn = home.databaseColumns.find((column) => column.name === 'Published At')
    assert.ok(entry)
    assert.ok(sourceColumn)
    assert.ok(publishedAtColumn)
    assert.equal(entry.fieldValues[sourceColumn.id], '环球网')
    assert.equal(entry.fieldValues[publishedAtColumn.id], '2026-08-17')
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService cleans 人民网 metadata and avoids duplicating the leading excerpt', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-people-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))
  const leadingParagraph = '人工智能产业正在加速形成新的技术体系、产品形态和应用模式，为经济社会发展持续注入新的增长动力。'

  try {
    const result = await service.importWebClipPayload({
      url: 'http://finance.people.com.cn/n1/2026/0817/c1004-40780581.html',
      parentId: null,
      title: '人工智能加速赋能千行百业--经济·科技--人民网',
      sourceSite: 'finance.people.com.cn',
      author: '1478',
      excerpt: leadingParagraph,
      articleHtml: [
        '<article><h1>人工智能加速赋能千行百业</h1>',
        '<p>发布时间：2026年08月17日</p>',
        `<p>${leadingParagraph}</p>`,
        '<p>文章进一步介绍制造、医疗、交通和科研场景中的落地进展，以及公共数据和算力基础设施建设情况。</p>',
        '<p>各方将继续完善标准规范、人才培养和安全治理机制，推动技术创新成果更好服务实体经济。</p>',
        '</article>'
      ].join('')
    })

    assert.equal(result.title, '人工智能加速赋能千行百业')
    const detail = store.getDocumentDetail(result.documentId)
    assert.ok(detail)
    const markdown = detail.blocks.map((block) => block.content).join('\n\n')
    assert.equal(markdown.split(leadingParagraph).length - 1, 1)

    const home = store.getHomeData(join(tempRoot, 'backup'))
    const entry = home.documentCatalog.find((item) => item.id === result.documentId)
    const sourceColumn = home.databaseColumns.find((column) => column.name === 'Source Site')
    const authorColumn = home.databaseColumns.find((column) => column.name === 'Author')
    const publishedAtColumn = home.databaseColumns.find((column) => column.name === 'Published At')
    assert.ok(entry)
    assert.ok(sourceColumn)
    assert.ok(authorColumn)
    assert.ok(publishedAtColumn)
    assert.equal(entry.fieldValues[sourceColumn.id], '人民网')
    assert.equal(entry.fieldValues[authorColumn.id], undefined)
    assert.equal(entry.fieldValues[publishedAtColumn.id], '2026-08-17')
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('WebClipperService prefers an MBA智库正文 root and removes comments and recommendations', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-mbalib-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))

  try {
    const result = await service.importWebClipPayload({
      url: 'https://wiki.mbalib.com/wiki/AI',
      parentId: null,
      html: [
        '<!doctype html><html><head><title>人工智能 - MBA智库百科</title></head><body>',
        '<main id="content"><nav>百科分类与站点导航</nav><div id="bodyContent" class="main_content">',
        '<h1>人工智能</h1><p>人工智能是研究和开发用于模拟、延伸与扩展人类智能的理论、方法、技术及应用系统的一门综合性学科。</p>',
        '<h2>发展历史</h2><p>相关研究经历了符号主义、连接主义和统计学习等阶段，并在算力、数据与算法共同推动下快速发展。</p>',
        '<h2>主要应用</h2><p>典型应用覆盖自然语言处理、计算机视觉、智能决策、机器人和知识管理等多个方向。</p>',
        '<p>在部署过程中还需要持续关注可靠性、可解释性、隐私保护、安全治理和社会影响。</p>',
        '</div><section id="comments"><p>这是一条用户评论，不属于百科正文。</p></section>',
        '<section><h2>相关推荐</h2><p>另一篇百科词条推荐。</p></section></main>',
        '</body></html>'
      ].join('')
    })

    assert.equal(result.title, '人工智能')
    const detail = store.getDocumentDetail(result.documentId)
    assert.ok(detail)
    const markdown = detail.blocks.map((block) => block.content).join('\n\n')
    assert.equal(markdown.includes('主要应用'), true)
    assert.equal(markdown.includes('用户评论'), false)
    assert.equal(markdown.includes('另一篇百科词条推荐'), false)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('extractWebClip preserves Chinese title interpuncts', () => {
  const clip = extractWebClip([
    '<!doctype html><html><head><title>水调歌头·明月几时有_古诗文网</title></head><body>',
    '<article><h1>水调歌头·明月几时有</h1>',
    '<p>明月几时有？把酒问青天。不知天上宫阙，今夕是何年。</p>',
    '<p>转朱阁，低绮户，照无眠。不应有恨，何事长向别时圆？</p>',
    '<p>人有悲欢离合，月有阴晴圆缺，此事古难全。</p>',
    '</article></body></html>'
  ].join(''), 'https://www.gushiwen.cn/shiwenv_example.aspx', {
    title: '水调歌头·明月几时有',
    sourceSite: '古诗文网'
  })

  assert.equal(clip.title, '水调歌头·明月几时有')
})

test('WebClipperService enriches captured article HTML with the visible page date', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-webclip-page-metadata-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const service = new WebClipperService(store, join(tempRoot, 'assets'))
  const articleHtml = [
    '<article class="rich_media_content"><h1>年度科技回顾</h1>',
    '<p>这篇文章梳理了全年重要科技进展，介绍基础研究、工程创新与产业应用之间的联系，并回顾多项成果从实验室走向现实场景的完整过程。</p>',
    '<p>文章还讨论了人工智能、生命科学、航天工程和清洁能源领域的代表性成果，分析数据、算力、材料和制造能力如何共同推动技术突破。</p>',
    '<p>最后一部分总结未来值得持续关注的研究方向，以及科学传播面临的新问题，包括可信信息、公众参与、风险沟通和跨学科合作。</p>',
    '<p>这些案例展示了长期基础投入的重要性，也说明开放协作、规范治理和人才培养是科技创新持续发展的必要条件。</p>',
    '</article>'
  ].join('')

  try {
    const result = await service.importWebClipPayload({
      url: 'https://www.guokr.com/article/example/',
      parentId: null,
      title: '年度科技回顾| 果壳 科技有意思',
      sourceSite: '果壳',
      publishedAt: '2022-10-10',
      html: [
        '<!doctype html><html><head><title>年度科技回顾| 果壳 科技有意思</title>',
        '<meta property="article:published_time" content="2022-10-10"></head><body>',
        '<p>上传时间：2025年01月01日</p>',
        articleHtml,
        '</body></html>'
      ].join(''),
      articleHtml
    })

    assert.equal(result.title, '年度科技回顾')
    const home = store.getHomeData(join(tempRoot, 'backup'))
    const entry = home.documentCatalog.find((item) => item.id === result.documentId)
    const publishedAtColumn = home.databaseColumns.find((column) => column.name === 'Published At')
    assert.ok(entry)
    assert.ok(publishedAtColumn)
    assert.equal(entry.fieldValues[publishedAtColumn.id], '2025-01-01')
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
