import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function seedDocument(page: Page, title: string): Promise<void> {
  await page.evaluate(async (title) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, {
      title,
      summary: 'A reading summary that should share the document body’s horizontal alignment.',
      blocks: [
        { type: 'heading-1', content: 'Layout regression section', checked: false, depth: 0 },
        { type: 'paragraph', content: 'LayoutNeedle: a readable search result in both themes.', checked: false, depth: 0 },
        { type: 'paragraph', content: 'LayoutNeedle: a second result exercises the unselected row.', checked: false, depth: 0 }
      ]
    })
  }, title)
  await page.reload()
  await page.locator('.tree-button').filter({ has: page.locator('.tree-document-title', { hasText: title }) }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  await expect(page.locator('.document-navigation-bar')).toBeVisible()
}

async function expectReadable(locator: Locator, description: string): Promise<void> {
  await expect(locator).toBeVisible()
  const contrast = await locator.evaluate((element) => {
    // A transparent text span often has several translucent ancestors. Compose
    // those surfaces instead of comparing with the span's transparent background.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      return [pixel[0], pixel[1], pixel[2], pixel[3] / 255]
    }
    const over = (front: number[], back: number[]): number[] =>
      front.slice(0, 3).map((channel, index) => channel * front[3] + back[index] * (1 - front[3]))
    const layers: number[][] = []
    let ancestor: Element | null = element
    while (ancestor) {
      const background = rgba(getComputedStyle(ancestor).backgroundColor)
      layers.push(background)
      if (background[3] === 1) break
      ancestor = ancestor.parentElement
    }
    if (layers.at(-1)?.[3] !== 1) throw new Error('Text has no opaque ancestor surface.')
    const background = layers.reverse().reduce((back, front) => over(front, back), [255, 255, 255])
    const foreground = over(rgba(getComputedStyle(element).color), background)
    const luminance = (color: number[]): number => {
      const [r, g, b] = color.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return r * 0.2126 + g * 0.7152 + b * 0.0722
    }
    const light = luminance(foreground), dark = luminance(background)
    return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
  })
  expect(contrast, description).toBeGreaterThanOrEqual(4.5)
}

async function useDarkTheme(page: Page): Promise<void> {
  await page.evaluate(() => window.knowbook.saveSetting('appearance.theme', 'dark'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
}

test.describe('UI detail layout @electron', () => {
  test.beforeEach(() => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  })

  test('global search keeps inset hints, wraps long titles and remains readable in both themes', async ({}, testInfo) => {
    await withElectronApp(async ({ page }) => {
      const title = `LayoutSearch${'ContinuousDocumentTitle'.repeat(12)}`
      await seedDocument(page, title)

      for (const theme of ['light', 'dark']) {
        if (theme === 'dark') await useDarkTheme(page)
        await page.keyboard.press('Control+k')
        const input = page.locator('.global-search-input')
        const hint = page.locator('.global-search-results > .mini-hint')
        await expect(input).toBeFocused()
        await expect(hint).toBeVisible()
        const inset = await hint.evaluate((element) => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect()
          const input = document.querySelector('.global-search-input')!.getBoundingClientRect()
          return {
            left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight),
            alignment: Math.abs(rect.left + parseFloat(style.paddingLeft) - input.left)
          }
        })
        expect(inset.left).toBe(16)
        expect(inset.right).toBe(16)
        expect(inset.alignment).toBeLessThanOrEqual(1)
        await expectReadable(hint, `${theme} search empty hint`)

        await input.fill('LayoutSearch')
        const result = page.locator('.global-search-result').filter({ hasText: title }).first()
        await expect(result).toBeVisible()
        const titleElement = result.locator('.global-search-doc-title')
        const layout = await titleElement.evaluate((element) => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect()
          const result = element.closest('.global-search-result')!
          const resultRect = result.getBoundingClientRect()
          return {
            wraps: rect.height > parseFloat(style.fontSize) * 2,
            overflow: result.scrollWidth - result.clientWidth,
            contained: rect.left >= resultRect.left && rect.right <= resultRect.right
          }
        })
        expect(layout.wraps).toBe(true)
        expect(layout.overflow).toBeLessThanOrEqual(1)
        expect(layout.contained).toBe(true)
        await expectReadable(titleElement, `${theme} search title`)
        await expectReadable(result.locator('.global-search-doc-path'), `${theme} search path`)
        await expectReadable(result.locator('.global-search-match-badge'), `${theme} search match label`)
        await page.locator('.global-search-modal').screenshot({ path: testInfo.outputPath(`search-${theme}.png`) })

        await input.fill('NoDocumentMatchesThisLayoutQuery')
        await expect(page.locator('.global-search-result')).toHaveCount(0)
        await expect(hint).toHaveText(uiText('No matches found.', '没有找到匹配的内容。'))
        await expectReadable(hint, `${theme} search no-results hint`)
        await input.press('Escape')
        await expect(page.locator('.global-search-modal')).toHaveCount(0)
      }
    })
  })

  test('in-document find has readable selected, unselected and empty states in dark mode', async ({}, testInfo) => {
    await withElectronApp(async ({ page }) => {
      const title = 'Find layout sample'
      await seedDocument(page, title)
      await useDarkTheme(page)
      await page.locator('.tree-button', { hasText: title }).first().click()
      await expect(page.locator('.document-navigation-bar')).toBeVisible()
      await page.keyboard.press('Control+f')
      const input = page.locator('.block-find-input')
      await expect(input).toBeFocused()
      await input.fill('LayoutNeedle')
      await expect(page.locator('.block-find-result')).toHaveCount(2)
      await expectReadable(input, 'dark find input')
      await expectReadable(page.locator('.block-find-count'), 'dark find match count')
      await expectReadable(page.locator('.block-find-result-active .block-find-result-preview'), 'dark find selected result')
      await expectReadable(page.locator('.block-find-result:not(.block-find-result-active) .block-find-result-preview'), 'dark find unselected result')
      await expectReadable(page.locator('.block-find-close'), 'dark find close control')
      await page.locator('.block-find-panel').screenshot({ path: testInfo.outputPath('find-dark-results.png') })
      await input.fill('NoBlockMatchesThisLayoutQuery')
      await expect(page.locator('.block-find-result')).toHaveCount(0)
      await expectReadable(page.locator('.block-find-empty'), 'dark find empty hint')
      await page.locator('.block-find-panel').screenshot({ path: testInfo.outputPath('find-dark-empty.png') })
      await input.press('Escape')

      const summaryEdit = page.locator('.document-summary-edit-button')
      await summaryEdit.hover()
      await expectReadable(summaryEdit, 'dark summary edit hover')

      const outlineButton = page.locator('.document-outline-control > button')
      await outlineButton.click()
      const outlineItem = page.locator('.toc-item').first()
      await outlineItem.hover()
      await expectReadable(outlineItem, 'dark outline item hover')
      await outlineButton.click()

      await page.locator('.document-header-more-button').click()
      const deleteItem = page.locator('.document-header-action-menu .context-menu-item-danger')
      await deleteItem.hover()
      await expectReadable(deleteItem, 'dark document delete menu hover')
    })
  })

  test('reading summary aligns with normal and wide content while copy feedback stays inside the header', async ({}, testInfo) => {
    await withElectronApp(async ({ page, app }) => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
      await seedDocument(page, 'Reading alignment sample')
      const auxiliary = page.locator('.document-header-aux-button')
      if (await auxiliary.getAttribute('aria-pressed') === 'true') await auxiliary.click()
      await expect(page.locator('.document-aux-sidebar')).toHaveCount(0)
      await page.locator('.document-view-toggle').click()
      await expect(page.locator('.document-reading-summary')).toBeVisible()

      const alignment = () => page.locator('.document-reading-summary').evaluate((summary) => {
        const body = summary.parentElement!.querySelector('.preview-section')!.getBoundingClientRect()
        const rect = summary.getBoundingClientRect()
        return { difference: Math.max(Math.abs(rect.left - body.left), Math.abs(rect.right - body.right)), width: body.width }
      })
      await expect.poll(async () => (await alignment()).difference).toBeLessThanOrEqual(1)
      const normalWidth = (await alignment()).width
      expect(normalWidth).toBeGreaterThan(800)
      await page.screenshot({ path: testInfo.outputPath('reading-normal.png') })
      await page.locator('.document-header-more-button').click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Enable wide mode', '开启宽屏模式') }).click()
      await expect(page.locator('.preview-panel')).toHaveClass(/preview-panel-wide/)
      await expect.poll(async () => (await alignment()).difference).toBeLessThanOrEqual(1)
      expect((await alignment()).width).toBeGreaterThan(normalWidth + 100)
      await page.screenshot({ path: testInfo.outputPath('reading-wide.png') })

      // Exercise the real copy feedback without changing the user's OS clipboard.
      // The handler belongs only to this isolated, short-lived Electron instance.
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('knowbook:write-clipboard-text')
        process.env.KNOWBOOK_E2E_LAYOUT_COPY_COUNT = '0'
        ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => {
          if (!text.includes('Reading alignment sample')) throw new Error('Unexpected copy payload')
          process.env.KNOWBOOK_E2E_LAYOUT_COPY_COUNT = String(Number(process.env.KNOWBOOK_E2E_LAYOUT_COPY_COUNT) + 1)
        })
      })
      await page.locator('.document-header-more-button').click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Copy MD', '复制 Markdown') }).click()
      const flash = page.locator('.autosave-flash-copy')
      await expect(flash).toBeVisible()
      const feedback = await flash.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const header = element.closest('.document-header-shell')!.getBoundingClientRect()
        const navigation = document.querySelector('.document-navigation-bar')!.getBoundingClientRect()
        return {
          contained: rect.top >= header.top && rect.bottom <= header.bottom && rect.left >= header.left && rect.right <= header.right,
          clearOfNavigation: rect.bottom <= navigation.top
        }
      })
      expect(feedback.contained).toBe(true)
      expect(feedback.clearOfNavigation).toBe(true)
      expect(await app.evaluate(() => process.env.KNOWBOOK_E2E_LAYOUT_COPY_COUNT)).toBe('1')
    })
  })
})
