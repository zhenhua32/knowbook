import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type ClipSourceServer = {
  articleUrl: string
  baseUrl: string
  coverUrl: string
  inlineImageUrl: string
  close: () => Promise<void>
}

function getTitleInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-input').first()
}

function getTreeButton(page: Page, title: string): Locator {
  return page.locator('.tree-button', { hasText: title }).first()
}

function getWebClipUrlInput(page: Page): Locator {
  return page.getByPlaceholder(uiText('Paste a webpage URL, for example https://example.com/article', '粘贴网页 URL，例如 https://example.com/article'))
}

async function startClipSourceServer(articleTitle: string): Promise<ClipSourceServer> {
  const coverSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="100%" height="100%" fill="#f2e4c8"/><text x="40" y="160" font-size="48" fill="#7a4b12">Cover</text></svg>'
  const inlineSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220"><rect width="100%" height="100%" fill="#dbeafe"/><text x="32" y="120" font-size="38" fill="#1d4ed8">Inline</text></svg>'

  const server = createServer((request, response) => {
    if (request.url === '/cover.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
      response.end(coverSvg)
      return
    }

    if (request.url === '/inline.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
      response.end(inlineSvg)
      return
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const trailingParagraphs = Array.from({ length: 18 }, (_, index) => (
      `<p>Trailing paragraph ${index + 1} for scroll validation in clipped documents.</p>`
    )).join('')
    response.end(`<!doctype html>
      <html>
        <head>
          <title>${articleTitle}</title>
          <meta property="og:title" content="${articleTitle}" />
          <meta property="og:description" content="An end-to-end article for KnowBook web clip E2E validation." />
          <meta property="og:site_name" content="Clip Source Site" />
          <meta property="article:published_time" content="2026-05-31T08:00:00.000Z" />
          <meta name="author" content="E2E Author" />
          <meta property="og:image" content="/cover.svg" />
        </head>
        <body>
          <article>
            <h1>${articleTitle}</h1>
            <p>Alpha paragraph captured through the in-app web clipping flow.</p>
            <p>Beta paragraph with a <a href="/more">relative link</a> and an inline image.</p>
            <img src="/inline.svg" alt="Inline diagram" />
            ${trailingParagraphs}
          </article>
        </body>
      </html>`)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    articleUrl: `${baseUrl}/article`,
    baseUrl,
    coverUrl: `${baseUrl}/cover.svg`,
    inlineImageUrl: `${baseUrl}/inline.svg`,
    close: () => new Promise<void>((resolve, reject) => {
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

async function getFreePort(): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(204)
    response.end()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

  return address.port
}

async function openSettingsPage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Settings', '配置中心')).first().click()
  await expect(page.locator('.current-page-text')).toHaveText(uiText('Settings', '配置中心'))
}

async function openDocumentsPage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Documents', '文档')).first().click()
  await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()
}

async function ensureAuxiliaryPanelOpen(page: Page): Promise<void> {
  const showAuxiliaryButton = page.getByRole('button', { name: uiText('Show auxiliary', '展开辅助区') })
  if (await showAuxiliaryButton.count() > 0) {
    await showAuxiliaryButton.click()
  }

  await expect(getWebClipUrlInput(page)).toBeVisible()
}

async function getEditorValues(page: Page): Promise<string[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((elements) =>
    elements.map((element) => (element as HTMLTextAreaElement).value)
  )
}

async function getContentScrollTop(page: Page): Promise<number> {
  return page.locator('.content').evaluate((element) => (element as HTMLElement).scrollTop)
}

test.describe('Web Clipping @electron', () => {
  test('clips a webpage from the document auxiliary panel and opens the imported child document', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const articleTitle = `Web Clip Article ${suffix}`
    const sourceServer = await startClipSourceServer(articleTitle)

    try {
      await withElectronApp(async ({ page }) => {
        await openDocumentsPage(page)
        const parentTitle = await getTitleInput(page).inputValue()
        expect(parentTitle.trim().length).toBeGreaterThan(0)
        await ensureAuxiliaryPanelOpen(page)

        await getWebClipUrlInput(page).fill(sourceServer.articleUrl)
        await page.getByRole('button', { name: uiText('Clip webpage', '剪藏网页') }).click()

        await expect(page.locator('.flash-message')).toContainText(/Clipped webpage into|已剪藏网页并创建文档/)
        await expect(getTitleInput(page)).toHaveValue(articleTitle)
        await expect(page.locator('.document-path')).toContainText(`${parentTitle}/${articleTitle}`)
        await expect.poll(async () => {
          return page.locator('.block-rich-media-image').evaluateAll((elements) =>
            elements.map((element) => ({
              complete: (element as HTMLImageElement).complete,
              naturalWidthPositive: (element as HTMLImageElement).naturalWidth > 0
            }))
          )
        }).toEqual([
          { complete: true, naturalWidthPositive: true },
          { complete: true, naturalWidthPositive: true }
        ])
        await expect(page.locator('.block-rich-media-link').first()).toBeVisible()

        await expect.poll(async () => (await getEditorValues(page)).join('\n')).toContain(`Source URL: ${sourceServer.articleUrl}`)
        await expect.poll(async () => (await getEditorValues(page)).join('\n')).toContain('Alpha paragraph captured through the in-app web clipping flow.')
      })
    } finally {
      await sourceServer.close()
    }
  })

  test('receives a local bridge POST payload and refreshes the workspace tree without a manual reload', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const bridgeTitle = `Bridge Clip ${suffix}`
    const sourceServer = await startClipSourceServer(`Bridge Source ${suffix}`)
    const bridgePort = await getFreePort()

    try {
      await withElectronApp(async ({ page }) => {
        await openSettingsPage(page)

        await page.getByLabel(uiText('Enable local web clip bridge service', '启用本地网页剪藏桥接服务')).check()
        await page.getByLabel(uiText('Listening port', '监听端口')).fill(`${bridgePort}`)
        await page.getByRole('button', { name: uiText('Save bridge settings', '保存桥接设置') }).click()

        await expect(page.locator('.flash-message')).toContainText(/Web clip bridge settings saved|网页剪藏桥接设置已保存/)
        await expect(page.getByLabel(uiText('Extension endpoint', '扩展提交地址'))).toHaveValue(`http://127.0.0.1:${bridgePort}/clip`)
        const token = await page.getByLabel(uiText('Authorization token', '授权令牌')).inputValue()

        await openDocumentsPage(page)

        const response = await fetch(`http://127.0.0.1:${bridgePort}/clip`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            url: `${sourceServer.baseUrl}/bridge-source`,
            parentId: null,
            title: bridgeTitle,
            markdown: [
              'Bridge clip body created through the local loopback service.',
              '',
              `![Bridge inline](${sourceServer.inlineImageUrl})`,
              '',
              '[Bridge source](https://example.com/bridge-source)'
            ].join('\n'),
            excerpt: 'Bridge clip excerpt',
            author: 'Bridge Author',
            coverImage: sourceServer.coverUrl,
            sourceSite: 'Bridge Source Site'
          })
        })

        expect(response.ok).toBeTruthy()

        await expect(getTreeButton(page, bridgeTitle)).toBeVisible()
        await getTreeButton(page, bridgeTitle).click()
        await expect(getTitleInput(page)).toHaveValue(bridgeTitle)
        await expect.poll(async () => {
          return page.locator('.block-rich-media-image').evaluateAll((elements) =>
            elements.map((element) => ({
              complete: (element as HTMLImageElement).complete,
              naturalWidthPositive: (element as HTMLImageElement).naturalWidth > 0
            }))
          )
        }).toEqual([
          { complete: true, naturalWidthPositive: true },
          { complete: true, naturalWidthPositive: true }
        ])

        await expect.poll(async () => (await getEditorValues(page)).join('\n')).toContain('Bridge clip body created through the local loopback service.')
        await expect.poll(async () => (await getEditorValues(page)).join('\n')).toContain('Bridge source')
      })
    } finally {
      await sourceServer.close()
    }
  })

  test('keeps the main document page scrolling when the wheel is used over rich media preview cards', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const articleTitle = `Web Clip Scroll ${suffix}`
    const sourceServer = await startClipSourceServer(articleTitle)

    try {
      await withElectronApp(async ({ page }) => {
        await openDocumentsPage(page)
        await ensureAuxiliaryPanelOpen(page)

        await getWebClipUrlInput(page).fill(sourceServer.articleUrl)
        await page.getByRole('button', { name: uiText('Clip webpage', '剪藏网页') }).click()

        await expect(getTitleInput(page)).toHaveValue(articleTitle)
        await expect(page.locator('.block-rich-media-image-card').first()).toBeVisible()

        await page.locator('.content').evaluate((element) => {
          (element as HTMLElement).scrollTop = 0
        })
        const startScrollTop = await getContentScrollTop(page)

        await page.locator('.block-rich-media-image-card').first().hover()
        await page.mouse.wheel(0, 900)

        await expect.poll(async () => getContentScrollTop(page)).toBeGreaterThan(startScrollTop)

        const imageMarkdownIndex = await page.locator('textarea.block-inline-textarea').evaluateAll((elements) =>
          elements.findIndex((element) => (element as HTMLTextAreaElement).value.includes('![Inline diagram]'))
        )
        expect(imageMarkdownIndex).toBeGreaterThanOrEqual(0)

        await page.locator('.content').evaluate((element) => {
          (element as HTMLElement).scrollTop = 0
        })
        const textareaStartScrollTop = await getContentScrollTop(page)

        await page.locator('textarea.block-inline-textarea').nth(imageMarkdownIndex).hover()
        await page.mouse.wheel(0, 900)

        await expect.poll(async () => getContentScrollTop(page)).toBeGreaterThan(textareaStartScrollTop)
      })
    } finally {
      await sourceServer.close()
    }
  })
})