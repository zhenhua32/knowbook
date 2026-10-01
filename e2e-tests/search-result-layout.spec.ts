import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

test('search results prioritize titles, keep ordinary rows compact and reveal long multilingual matches in both themes @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    const fixtures = await page.evaluate(async () => {
      const create = async (title: string, parent: string | null, content: string, tags: string[] = []) => {
        const { id } = await window.knowbook.createDocument(parent)
        await window.knowbook.updateDocument(id, { title, summary: '', blocks: [{ type: 'paragraph', content, checked: false, depth: 0, tags }] })
        return id
      }
      let parent: string | null = null
      for (let index = 0; index < 4; index++) parent = await create(`深层设计目录 ${index} ${'完整路径'.repeat(5)}`, parent, '')
      const long = await create('中文长标题 — 保留全部信息 '.repeat(8), parent,
        `前言\n\n\n\n\n needle ${'LongEnglishToken'.repeat(12)} <script>plain text</script>`, ['LongTagNoSpaces'.repeat(6), '长标签'.repeat(10)])
      const short: string[] = []
      for (let index = 0; index < 4; index++) short.push(await create(`Compact result ${index}`, null, 'A short needle excerpt for scanning results.'))
      return { long, short }
    })
    await page.reload()
    await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
    await page.getByLabel(uiText('Keywords', '关键词'), { exact: true }).fill('needle')
    await expect(page.getByTestId('workspace-search-result')).toHaveCount(5)
    await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')
    const compact = page.locator(`[data-testid="workspace-search-result"][data-document-id="${fixtures.short[0]}"]`)
    expect((await compact.boundingBox())!.height).toBeLessThanOrEqual(165)
    const long = page.locator(`[data-testid="workspace-search-result"][data-document-id="${fixtures.long}"]`)
    const path = long.locator('.workspace-search-path')
    await expect(path).toContainText('深层设计目录')
    expect(await path.getAttribute('title')).toBe(await path.innerText())
    expect((await long.locator('h4').boundingBox())!.y).toBeLessThan((await path.boundingBox())!.y)
    const timestamp = long.locator('time')
    expect(await timestamp.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await timestamp.getAttribute('title')).toMatch(/\d+:\d+/)
    expect(await timestamp.innerText()).not.toMatch(/\d+:\d+/)
    await expect(long.locator('.workspace-search-tag')).toHaveText([`#${'LongTagNoSpaces'.repeat(6)}`, `#${'长标签'.repeat(10)}`])
    for (const scenario of [{ width: 1360, theme: 'light' }, { width: 800, theme: 'dark' }, { width: 640, theme: 'dark' }]) {
      await page.setViewportSize({ width: scenario.width, height: 880 })
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, scenario.theme)
      const match = long.locator('.workspace-search-snippet mark').filter({ hasText: 'needle' })
      await match.scrollIntoViewIfNeeded(); await expect(match).toBeInViewport()
      expect(await long.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      for (const name of [uiText('Go to block', '定位内容块'), uiText('Open document', '打开文档'), uiText('Copy document link', '复制文档链接')]) {
        const button = long.getByRole('button', { name, exact: true })
        await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport()
        expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      }
      const primary = long.locator('.primary-button')
      const contrast = () => primary.evaluate(element => {
        const style = getComputedStyle(element)
        const luminance = (color: string) => {
          const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
            const channel = value / 255
            return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
          })
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
        }
        const text = luminance(style.color), background = luminance(style.backgroundColor)
        return (Math.max(text, background) + .05) / (Math.min(text, background) + .05)
      })
      await primary.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      await expect.poll(contrast).toBeGreaterThanOrEqual(4.5)
      await primary.hover()
      await expect.poll(contrast).toBeGreaterThanOrEqual(4.5)
      await long.screenshot({ path: testInfo.outputPath(`search-long-${scenario.theme}-${scenario.width}.png`) })
    }
    await page.setViewportSize({ width: 1360, height: 880 })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await compact.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('search-compact-light.png') })
  })
})
