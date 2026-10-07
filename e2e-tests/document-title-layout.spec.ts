import { expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

const defaultSummary = 'New knowledge node ready for editing.'

async function openDocument(page: Page, title: string, summary: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, summary, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary, blocks })
    return id
  }, { title, summary, blocks })
  await page.reload()
  await page.locator('.tree-button').filter({ has: page.locator('.tree-document-title', { hasText: title }) }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  return id
}

async function readDocument(page: Page) {
  const toggle = page.locator('.document-view-toggle')
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
  await expect(page.locator('.preview-panel')).toHaveClass(/preview-panel-reading/)
}

async function useMossTheme(page: Page) {
  await expect.poll(async () => {
    const plugin = (await page.evaluate(() => window.knowbook.listSystemPlugins())).find(plugin => plugin.pluginId === 'theme-switcher')
    return plugin?.status === 'active' && plugin.runtimeStatus === 'active'
  }).toBe(true)
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Appearance', '外观') }).click()
  await expect(page.getByTestId('theme-switcher-settings')).toBeVisible()
  await page.getByTestId('theme-option-moss').click()
  await expect(page.getByTestId('theme-option-moss')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', 'moss')
  await expect.poll(() => page.evaluate(async () => {
    const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')
    if (!plugin?.currentArtifactSha256) throw new Error('The moss theme must have an installed artifact.')
    return window.knowbook.invokeSystemPluginMain({ pluginId: 'theme-switcher', revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'get-state' })
  })).toMatchObject({ selectedThemeId: 'moss' })
}

async function resizeDocumentWindow(page: Page, app: ElectronApplication, width: number) {
  const size = await app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(width, 1000)
    return window.getContentSize()
  }, width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test.describe('Document title layout @electron', () => {
  test.beforeEach(() => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  })

  test('the inline title autosaves committed IME text while metadata and help stay optional', async ({}, testInfo) => {
    await withElectronApp(async ({ app, page }) => {
      const title = '直接编辑文档标题'
      const summary = '摘要默认收起，内容仍完整保留。'
      const id = await openDocument(page, title, summary, [
        { id: 'inline-title-body', type: 'paragraph', content: '开始写作，正文保持靠近标题。', checked: false, depth: 0 }
      ])
      const titleInput = page.locator('.document-title-input')
      const properties = page.locator('.document-summary-edit-button')
      const auxiliary = page.locator('.document-header-aux-button')
      if (await auxiliary.getAttribute('aria-pressed') === 'true') await auxiliary.click()
      await expect(titleInput).toHaveValue(title)
      await expect(properties).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('.document-summary-card .editor-textarea')).toHaveCount(0)
      await expect(page.locator('.document-updated')).toHaveCount(0)
      await expect(page.locator('.document-summary-card')).not.toContainText(summary)

      await titleInput.focus()
      await titleInput.press('End')
      const cdp = await page.context().newCDPSession(page)
      try {
        await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 })
        await expect(titleInput).toHaveValue(`${title}zhongwen`)
        await page.waitForTimeout(1000)
        expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))?.title).toBe(title)
        await cdp.send('Input.insertText', { text: '中文' })
        await expect(titleInput).toHaveValue(`${title}中文`)
        await expect(page.locator('.document-save-status')).toHaveClass(/status-saved/)
        await expect.poll(async () => {
          const detail = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
          return { title: detail?.title, summary: detail?.summary }
        }).toEqual({ title: `${title}中文`, summary })
      } finally {
        await cdp.detach()
      }

      await properties.click()
      const summaryInput = page.locator('.document-summary-card .editor-textarea')
      await expect(summaryInput).toBeFocused()
      await expect(summaryInput).toHaveValue(summary)
      await expect(page.locator('.document-updated')).toBeVisible()
      await summaryInput.press('Escape')
      await expect(properties).toBeFocused()
      await expect(titleInput).toBeVisible()

      const helpButton = page.locator('.document-editor-help-button')
      await helpButton.click()
      await expect(page.locator('.shortcut-help-dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(helpButton).toBeFocused()
      await helpButton.evaluate((button: HTMLButtonElement) => button.blur())

      for (const layout of ['normal', 'dark', 'narrow']) {
        await app.evaluate(({ BrowserWindow }, narrow) => BrowserWindow.getAllWindows()[0].setSize(narrow ? 1000 : 1600, narrow ? 820 : 1000), layout === 'narrow')
        const theme = layout === 'dark' ? 'dark' : 'light'
        if (await page.locator('html').getAttribute('data-theme') !== theme) {
          await page.evaluate(theme => window.knowbook.saveSetting('appearance.theme', theme), theme)
          await page.reload()
          await page.locator('.tree-button').filter({ has: page.locator('.tree-document-title', { hasText: `${title}中文` }) }).first().click()
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
          if (await auxiliary.getAttribute('aria-pressed') === 'true') await auxiliary.click()
        }
        await expect(titleInput).toBeInViewport()
        await expect(page.locator('[data-block-id="inline-title-body"]')).toBeInViewport()
        const dimensions = await titleInput.evaluate(input => {
          const body = document.querySelector('[data-block-id="inline-title-body"]')!.getBoundingClientRect()
          const navigation = document.querySelector('.document-navigation')!.getBoundingClientRect()
          const panel = document.querySelector('.preview-panel')!
          return { fontSize: parseFloat(getComputedStyle(input).fontSize), gap: body.top - navigation.bottom, overflow: panel.scrollWidth - panel.clientWidth }
        })
        expect(dimensions.fontSize).toBeGreaterThanOrEqual(24)
        expect(dimensions.gap).toBeGreaterThanOrEqual(0)
        expect(dimensions.gap).toBeLessThan(170)
        expect(dimensions.overflow).toBeLessThanOrEqual(1)
        await page.screenshot({ path: testInfo.outputPath(`inline-title-${layout}.png`), animations: 'disabled' })
      }
    })
  })

  test('an imported article starts with one main title and no placeholder summary at normal, wide and narrow widths', async ({}, testInfo) => {
    await withElectronApp(async ({ app, page }) => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
      const title = '4000美元关口失守后，黄金还要继续跌？-中新网'
      const blocks: DocumentBlockDraft[] = [
        { id: 'article-title', type: 'heading-1', content: title, checked: false, depth: 0 },
        { id: 'article-source', type: 'paragraph', content: '来源：中国新闻网；正文内容从这里开始。', checked: false, depth: 0 }
      ]
      const id = await openDocument(page, title, defaultSummary, blocks)
      const documentName = page.getByRole('textbox', { name: uiText('Document name', '文档名称') })
      await expect(documentName).toHaveValue(title)
      expect(await documentName.evaluate(input => parseFloat(getComputedStyle(input).fontSize))).toBe(16)
      expect(await page.locator('[data-block-id="article-title"] textarea').evaluate(input => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(25)
      const auxiliary = page.locator('.document-header-aux-button')
      if (await auxiliary.getAttribute('aria-pressed') === 'true') await auxiliary.click()
      await page.screenshot({ path: testInfo.outputPath('article-editing-title.png'), animations: 'disabled' })
      await readDocument(page)

      for (const layout of ['normal', 'wide', 'narrow']) {
        if (layout === 'wide') {
          await page.locator('.document-header-more-button').click()
          await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Enable wide mode', '开启宽屏模式') }).click()
          await expect(page.locator('.preview-panel')).toHaveClass(/preview-panel-wide/)
        } else if (layout === 'narrow') {
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 820))
        }
        await expect(page.locator('.document-reading-summary')).toHaveCount(0)
        await expect(page.locator('.preview-panel h1')).toHaveCount(1)
        const heading = page.locator('.document-reading-row[data-block-id="article-title"] h1')
        await expect(heading).toHaveText(title)
        await expect(heading).toBeInViewport()
        await expect(page.locator('.preview-panel')).not.toContainText(defaultSummary)
        await expect(page.locator('.document-save-status')).toHaveClass(/status-saved/)
        await expect(page.locator('.document-header-save-button')).toBeVisible()
        await expect(page.locator('.document-view-toggle')).toBeVisible()
        const spacing = await heading.evaluate((element) => {
          const navigation = document.querySelector('.document-navigation')!.getBoundingClientRect()
          const header = document.querySelector('.document-header-shell')!.getBoundingClientRect()
          const panel = document.querySelector('.preview-panel')!
          return { gap: element.getBoundingClientRect().top - navigation.bottom, headerHeight: header.height, overflow: panel.scrollWidth - panel.clientWidth }
        })
        // The article begins directly below navigation instead of after a
        // second title, placeholder paragraph and summary divider.
        expect(spacing.gap).toBeGreaterThanOrEqual(0)
        expect(spacing.gap).toBeLessThan(96)
        expect(spacing.headerHeight).toBeLessThan(layout === 'narrow' ? 106 : 80)
        expect(spacing.overflow).toBeLessThanOrEqual(1)
        await page.screenshot({ path: testInfo.outputPath(`article-title-${layout}.png`) })
      }
      const saved = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(saved?.title).toBe(title)
      expect(saved?.summary).toBe(defaultSummary)
      expect(saved?.blocks.map(({ id, type, content }) => ({ id, type, content }))).toEqual(blocks.map(({ id, type, content }) => ({ id, type, content })))
    })
  })

  test('the long imported article uses a compact transparent name row and one readable H1 in the moss theme', async ({}, testInfo) => {
    await withElectronApp(async ({ app, page }) => {
      await resizeDocumentWindow(page, app, 1600)
      await useMossTheme(page)
      const title = '16 万 Star 的 OpenCode 彻底重写: API 全部重做、Bun 换 Node、桌面端迁移 Electron'
      const sourceTitle = '16万 Star 的 OpenCode 彻底重写：API 全部重做、 Bun 换 Node、 桌面端迁移 Electron'
      const blocks: DocumentBlockDraft[] = [
        { id: 'opencode-title', type: 'heading-1', content: sourceTitle, checked: false, depth: 0 },
        { id: 'opencode-body', type: 'paragraph', content: '2026 年，OpenCode 已经是一款现象级的开源项目。', checked: false, depth: 0 }
      ]
      const id = await openDocument(page, title, defaultSummary, blocks)
      const titleInput = page.locator('.document-title-input')
      const auxiliary = page.locator('.document-header-aux-button')
      if (await auxiliary.getAttribute('aria-pressed') === 'true') await auxiliary.click()
      await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', 'moss')
      await expect(titleInput).toHaveValue(title)
      await expect(page.locator('.document-title-field-compact')).toBeVisible()
      await expect(page.locator('[data-block-id="opencode-title"] textarea')).toHaveValue(sourceTitle)

      for (const width of [1600, 1000]) {
        await resizeDocumentWindow(page, app, width)
        const layout = await titleInput.evaluate(input => {
          const card = input.closest('.document-summary-card')!
          const cardBounds = card.getBoundingClientRect()
          const cardStyle = getComputedStyle(card)
          const titleStyle = getComputedStyle(input)
          const heading = document.querySelector('[data-block-id="opencode-title"] textarea')!
          const panel = document.querySelector('.preview-panel')!
          return {
            fontSize: parseFloat(titleStyle.fontSize),
            borders: [titleStyle.borderTopColor, titleStyle.borderRightColor, titleStyle.borderBottomColor, titleStyle.borderLeftColor],
            background: cardStyle.backgroundColor,
            shadow: cardStyle.boxShadow,
            height: cardBounds.height,
            headingFontSize: parseFloat(getComputedStyle(heading).fontSize),
            headingGap: heading.getBoundingClientRect().top - cardBounds.bottom,
            overflow: panel.scrollWidth - panel.clientWidth,
            clippedTitle: input.scrollHeight - input.clientHeight
          }
        })
        expect(layout.fontSize).toBe(16)
        expect(layout.borders).toEqual(Array(4).fill('rgba(0, 0, 0, 0)'))
        expect(layout.background).toBe('rgba(0, 0, 0, 0)')
        expect(layout.shadow).toBe('none')
        expect(layout.height).toBeLessThan(width === 1000 ? 110 : 80)
        expect(layout.headingFontSize).toBeGreaterThanOrEqual(24)
        expect(layout.headingFontSize).toBeLessThanOrEqual(28)
        expect(layout.headingGap).toBeGreaterThanOrEqual(0)
        expect(layout.headingGap).toBeLessThan(48)
        expect(layout.overflow).toBeLessThanOrEqual(1)
        expect(layout.clippedTitle).toBeLessThanOrEqual(2)
        await page.screenshot({ path: testInfo.outputPath(`opencode-moss-editing-${width}.png`), animations: 'disabled' })
      }

      await titleInput.focus()
      const focusedStyle = await titleInput.evaluate(input => {
        const style = getComputedStyle(input)
        return { border: style.borderBottomColor, shadow: style.boxShadow }
      })
      expect(focusedStyle.border).toBe('rgba(0, 0, 0, 0)')
      expect(focusedStyle.shadow).toContain('0px 2px 0px')
      await readDocument(page)
      await expect(page.locator('.document-reading-summary')).toHaveCount(0)
      await expect(page.locator('.preview-panel h1')).toHaveCount(1)
      const heading = page.locator('.document-reading-row[data-block-id="opencode-title"] h1')
      await expect(heading).toHaveText(sourceTitle)
      const reading = await heading.evaluate(element => {
        const navigation = document.querySelector('.document-navigation')!
        const panel = document.querySelector('.preview-panel')!
        return {
          fontSize: parseFloat(getComputedStyle(element).fontSize),
          gap: element.getBoundingClientRect().top - navigation.getBoundingClientRect().bottom,
          overflow: panel.scrollWidth - panel.clientWidth
        }
      })
      expect(reading.fontSize).toBeLessThanOrEqual(28)
      expect(reading.gap).toBeGreaterThanOrEqual(0)
      expect(reading.gap).toBeLessThan(96)
      expect(reading.overflow).toBeLessThanOrEqual(1)
      await page.screenshot({ path: testInfo.outputPath('opencode-moss-reading-narrow.png'), animations: 'disabled' })
      const saved = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(saved?.title).toBe(title)
      expect(saved?.summary).toBe(defaultSummary)
      expect(saved?.blocks.map(({ id, type, content }) => ({ id, type, content }))).toEqual(blocks.map(({ id, type, content }) => ({ id, type, content })))
    })
  })

  test('an independent long title wraps completely, resizes and saves edits without introducing newlines', async ({}, testInfo) => {
    await withElectronApp(async ({ app, page }) => {
      await resizeDocumentWindow(page, app, 1600)
      const title = '从知识采集到长期整理：围绕 OpenCode、Electron 与本地优先工作流的完整研究记录，以及团队如何维护长篇文档的标题、来源、上下文和后续行动，让复杂内容在不同窗口尺寸下都能清楚阅读'
      const summary = '独立标题的摘要保持原样。'
      const blocks: DocumentBlockDraft[] = [
        { id: 'long-title-body', type: 'paragraph', content: '这份文档从普通正文开始，长标题必须完整展示。', checked: false, depth: 0 }
      ]
      const id = await openDocument(page, title, summary, blocks)
      const titleInput = page.locator('.document-title-input')
      const auxiliary = page.locator('.document-header-aux-button')
      if (await auxiliary.getAttribute('aria-pressed') === 'true') await auxiliary.click()
      await expect(titleInput).toHaveValue(title)
      await expect(page.locator('.document-title-field-compact')).toHaveCount(0)
      expect(await titleInput.evaluate(input => input.tagName)).toBe('TEXTAREA')

      const heights: number[] = []
      for (const [index, width] of [1600, 1000, 1600].entries()) {
        await resizeDocumentWindow(page, app, width)
        const layout = await titleInput.evaluate(input => {
          const style = getComputedStyle(input)
          const panel = document.querySelector('.preview-panel')!
          return {
            height: input.getBoundingClientRect().height,
            lineHeight: parseFloat(style.lineHeight),
            fontSize: parseFloat(style.fontSize),
            clippedTitle: input.scrollHeight - input.clientHeight,
            overflow: panel.scrollWidth - panel.clientWidth
          }
        })
        expect(layout.fontSize).toBeGreaterThanOrEqual(24)
        expect(layout.fontSize).toBeLessThanOrEqual(28)
        expect(layout.height).toBeGreaterThan(layout.lineHeight * 1.5)
        expect(layout.clippedTitle).toBeLessThanOrEqual(2)
        expect(layout.overflow).toBeLessThanOrEqual(1)
        heights.push(layout.height)
        await expect(titleInput).toHaveValue(title)
        await page.screenshot({ path: testInfo.outputPath(`independent-long-title-${index}-${width}.png`), animations: 'disabled' })
      }
      expect(heights[1]).toBeGreaterThan(heights[0] + 10)
      expect(Math.abs(heights[2] - heights[0])).toBeLessThanOrEqual(2)

      await titleInput.focus()
      await titleInput.press('Control+End')
      await titleInput.press('Enter')
      await expect(titleInput).toHaveValue(title)
      await expect(titleInput).toBeFocused()
      const editedTitle = `${title}中文`
      // The actual CDP composition flow is covered by the inline-title test.
      await page.keyboard.insertText('中文')
      await expect(titleInput).toHaveValue(editedTitle)
      await expect.poll(async () => {
        const saved = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
        return { title: saved?.title, summary: saved?.summary, blocks: saved?.blocks.map(({ id, type, content }) => ({ id, type, content })) }
      }).toEqual({ title: editedTitle, summary, blocks: blocks.map(({ id, type, content }) => ({ id, type, content })) })
      await expect(page.locator('.document-save-status')).toHaveClass(/status-saved/)
      await page.reload()
      await page.locator('.tree-button').filter({ has: page.locator('.tree-document-title', { hasText: editedTitle }) }).first().click()
      await expect(titleInput).toHaveValue(editedTitle)
      await readDocument(page)
      await expect(page.locator('.preview-panel h1')).toHaveCount(1)
      await expect(page.locator('.document-reading-summary h1')).toHaveText(editedTitle)
    })
  })

  test('a real summary remains with the original heading, outline and metadata editing intact', async () => {
    await withElectronApp(async ({ page }) => {
      const title = '有摘要的阅读文档'
      const summary = '这是用户撰写的真实摘要，阅读时必须保留。'
      const id = await openDocument(page, title, summary, [
        { id: 'summary-title', type: 'heading-1', content: title, checked: false, depth: 0 },
        { id: 'summary-body', type: 'paragraph', content: '可编辑的原始正文', checked: false, depth: 0 }
      ])
      await readDocument(page)
      await expect(page.locator('.document-reading-summary p')).toHaveText(summary)
      await expect(page.locator('.document-reading-summary h1')).toHaveCount(0)
      await expect(page.locator('.preview-panel h1')).toHaveCount(1)
      await page.locator('.document-outline-control > button').click()
      await expect(page.locator('.document-outline-popover .toc-item')).toHaveCount(1)
      await expect(page.locator('.document-outline-popover .toc-item')).toContainText(title)
      await page.locator('.document-outline-control > button').click()
      const heading = page.locator('.document-reading-row[data-block-id="summary-title"]')
      await heading.locator('.reading-collapse').click()
      await expect(page.locator('.document-reading-row[data-block-id="summary-body"]')).toHaveCount(0)
      await expect(heading.locator('h1')).toHaveText(title)
      await expect(page.locator('.document-reading-summary p')).toHaveText(summary)
      await heading.locator('.reading-collapse').click()
      await expect(page.locator('.document-reading-row[data-block-id="summary-body"]')).toContainText('可编辑的原始正文')

      await page.locator('.document-view-toggle').click()
      await ensureDocumentMetadataEditor(page)
      const titleInput = page.locator('.document-summary-card .editor-input').first()
      const summaryInput = page.locator('.document-summary-card .editor-textarea').first()
      await expect(titleInput).toHaveValue(title)
      await expect(summaryInput).toHaveValue(summary)
      await expect(page.locator('[data-block-id="summary-title"] textarea')).toHaveValue(title)
      const editedTitle = '更新后的阅读文档'
      const editedSummary = '更新后的真实摘要'
      const editedBody = '更新后的正文仍保持原块标识'
      await titleInput.fill(editedTitle)
      await expect(titleInput).toBeFocused()
      await expect(page.locator('.document-title-field-compact')).toHaveCount(0)
      expect(await titleInput.evaluate(input => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(24)
      await summaryInput.fill(editedSummary)
      await page.locator('[data-block-id="summary-title"] textarea').fill(editedTitle)
      await expect(page.locator('.document-title-field-compact')).toBeVisible()
      await page.locator('[data-block-id="summary-body"] textarea').fill(editedBody)
      await page.locator('.document-header-save-button').click()
      await expect(page.locator('.document-save-status')).toHaveClass(/status-saved/)
      await expect.poll(async () => {
        const document = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
        return { title: document?.title, summary: document?.summary, blocks: document?.blocks.map(block => ({ id: block.id, content: block.content })) }
      }).toEqual({ title: editedTitle, summary: editedSummary, blocks: [
        { id: 'summary-title', content: editedTitle }, { id: 'summary-body', content: editedBody }
      ] })
      await readDocument(page)
      await expect(page.locator('.document-header-title')).toHaveText(editedTitle)
      await expect(page.locator('.preview-panel h1')).toHaveCount(1)
      await expect(page.locator('.document-reading-summary p')).toHaveText(editedSummary)
      await expect(page.locator('.document-reading-row[data-block-id="summary-body"]')).toContainText(editedBody)
    })
  })

  test('a different first heading or plain opening paragraph still shows the document title', async () => {
    await withElectronApp(async ({ page }) => {
      for (const sample of [
        { title: '独立文档标题', type: 'heading-1' as const, content: '第一章与文档名称不同', summary: defaultSummary },
        { title: '从正文开始的文档', type: 'paragraph' as const, content: '普通正文开头，不承担文档标题。', summary: '' }
      ]) {
        const openingId = `${sample.type}-opening`
        const bodyId = `${sample.type}-body`
        const id = await openDocument(page, sample.title, sample.summary, [
          { id: openingId, type: sample.type, content: sample.content, checked: false, depth: 0 },
          { id: bodyId, type: 'paragraph', content: '后续正文', checked: false, depth: 0 }
        ])
        await expect(page.locator('.document-title-field-compact')).toHaveCount(0)
        expect(await page.locator('.document-title-input').evaluate(input => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(24)
        await readDocument(page)
        await expect(page.locator('.document-reading-summary h1')).toHaveText(sample.title)
        await expect(page.locator('.document-reading-summary p')).toHaveCount(0)
        await expect(page.locator('.preview-panel')).not.toContainText(defaultSummary)
        await expect(page.locator(`.document-reading-row[data-block-id="${openingId}"]`)).toContainText(sample.content)
        await expect(page.locator('.preview-panel h1')).toHaveCount(sample.type === 'heading-1' ? 2 : 1)
        const document = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
        expect(document?.blocks[0].content).toBe(sample.content)
        expect(document?.blocks[0].type).toBe(sample.type)
      }
    })
  })

  test('formatted opening H1 titles keep their source and block identity while a matching H2 remains a section', async () => {
    await withElectronApp(async ({ page }) => {
      const samples = [
        { title: '带格式的文章标题', type: 'heading-1' as const, content: '**带格式的文章标题**' },
        { title: '带链接的文章标题', type: 'heading-1' as const, content: '[带链接的文章标题](https://example.com/article)' },
        { title: '次级章节仍需文档标题', type: 'heading-2' as const, content: '次级章节仍需文档标题' }
      ]
      for (const [index, sample] of samples.entries()) {
        const headingId = `formatted-title-${index}`
        const id = await openDocument(page, sample.title, defaultSummary, [
          { id: headingId, type: sample.type, content: sample.content, checked: false, depth: 0 },
          { id: `formatted-body-${index}`, type: 'paragraph', content: '格式化标题下的正文保持完整。', checked: false, depth: 0 }
        ])
        await expect(page.locator('.document-title-field-compact')).toHaveCount(sample.type === 'heading-1' ? 1 : 0)
        await readDocument(page)
        const heading = page.locator(`.document-reading-row[data-block-id="${headingId}"]`)
        await expect(heading.locator(sample.type === 'heading-1' ? 'h1' : 'h2')).toHaveText(sample.title)
        await expect(page.locator('.preview-panel h1')).toHaveCount(1)
        if (sample.type === 'heading-1') {
          await expect(page.locator('.document-reading-summary')).toHaveCount(0)
        } else {
          await expect(page.locator('.document-reading-summary h1')).toHaveText(sample.title)
        }
        const document = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
        expect(document?.blocks[0]).toMatchObject({ id: headingId, type: sample.type, content: sample.content })
        await page.locator('.document-view-toggle').click()
        await expect(page.locator(`[data-block-id="${headingId}"] textarea`)).toHaveValue(sample.content)
      }
    })
  })
})
