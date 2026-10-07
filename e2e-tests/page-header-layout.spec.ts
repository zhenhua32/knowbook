import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

const managementPages = [
  { id: 'dashboard', en: 'Dashboard', zh: '总览', header: ':scope > .hero' },
  { id: 'ai', en: 'AI Assistant', zh: 'AI 助手', header: ':scope > .management-page-header' },
  { id: 'settings', en: 'Settings', zh: '配置中心', header: ':scope > .settings-page-header' },
  { id: 'search', en: 'Search', zh: '搜索', header: '.workspace-search-page > .management-page-header' },
  { id: 'plugins', en: 'Plugins', zh: '插件中心', header: '.plugins-page > .plugin-page-hero' }
] as const

type ManagementPage = typeof managementPages[number]
type Rectangle = { left: number; top: number; right: number; bottom: number; width: number; height: number }

async function openPage(page: Page, item: ManagementPage): Promise<void> {
  const navigation = page.getByTitle(uiText(item.en, item.zh), { exact: true })
  await navigation.click()
  await expect(navigation).toHaveClass(/active/)
  const content = page.locator(`.content.page-${item.id}`)
  // Search is retained in a hidden child after first navigation. A direct-child
  // selector distinguishes AI/settings headers from that hidden search header.
  await expect(content.locator(item.header)).toBeVisible()
  await content.evaluate(element => { element.scrollTop = 0 })
}

async function setNativeSize(app: ElectronApplication, page: Page, width: number) {
  // Exercise the product's ordinary minimum size without lowering its limits or
  // replacing the native viewport with Playwright's renderer-only emulation.
  await app.evaluate(({ BrowserWindow }, width) => {
    BrowserWindow.getAllWindows()[0].setContentSize(width, 760)
  }, width)
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    .toEqual({ width, height: 760 })
  const native = await app.evaluate(({ app, BrowserWindow }) => ({
    userData: app.getPath('userData'), userDataOverride: process.env.KNOWBOOK_USER_DATA_DIR,
    windows: BrowserWindow.getAllWindows().map(window => ({
      bounds: window.getBounds(), size: window.getSize(), contentSize: window.getContentSize(),
      visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
    }))
  }))
  expect(native.userData).toBe(native.userDataOverride)
  expect(native.windows).toHaveLength(1)
  expect(native.windows[0].contentSize).toEqual([width, 760])
  expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return native
}

function expectInside(child: Rectangle, parent: Rectangle, name: string): void {
  expect(child.width, `${name} has readable width`).toBeGreaterThan(0)
  expect(child.height, `${name} has readable height`).toBeGreaterThan(0)
  expect(child.left, `${name} left edge`).toBeGreaterThanOrEqual(parent.left - 1)
  expect(child.top, `${name} top edge`).toBeGreaterThanOrEqual(parent.top - 1)
  expect(child.right, `${name} right edge`).toBeLessThanOrEqual(parent.right + 1)
  expect(child.bottom, `${name} bottom edge`).toBeLessThanOrEqual(parent.bottom + 1)
}

function intersects(first: Rectangle, second: Rectangle): boolean {
  return Math.min(first.right, second.right) > Math.max(first.left, second.left) + 1
    && Math.min(first.bottom, second.bottom) > Math.max(first.top, second.top) + 1
}

async function verifyHeader(page: Page, item: ManagementPage, testInfo: TestInfo, imageName: string) {
  const header = page.locator(`.content.page-${item.id}`).locator(item.header)
  const layout = await header.evaluate(element => {
    const title = element.querySelector<HTMLElement>('h2,h3')!
    const description = element.querySelector<HTMLElement>('.hero-copy,.management-page-description,.plugin-page-heading p')!
    const content = element.closest<HTMLElement>('.content')!
    const rectangle = (node: Element) => {
      const rect = node.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const textRectangles = (node: Element) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      const rectangles = []
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(walker.currentNode)
        rectangles.push(...Array.from(range.getClientRects(), rect => ({
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height
        })))
      }
      return rectangles
    }
    const rgba = (color: string) => {
      const values = color.match(/[\d.]+/g)!.map(Number)
      return [values[0], values[1], values[2], values[3] ?? 1]
    }
    const luminance = (color: number[]) => {
      const [red, green, blue] = color.slice(0, 3).map(channel => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
    const ancestors: Element[] = []
    for (let current: Element | null = title; current; current = current.parentElement) ancestors.push(current)
    let background = [255, 255, 255]
    for (const ancestor of ancestors.reverse()) {
      const color = rgba(getComputedStyle(ancestor).backgroundColor)
      background = color.slice(0, 3).map((channel, index) => channel * color[3] + background[index] * (1 - color[3]))
    }
    const foreground = luminance(rgba(getComputedStyle(title).color))
    const backgroundLuminance = luminance(background)
    const style = getComputedStyle(element)
    const titleStyle = getComputedStyle(title)
    return {
      header: rectangle(element), content: rectangle(content), inner: [innerWidth, innerHeight],
      title: { text: title.textContent, ...rectangle(title), fontSize: titleStyle.fontSize, lineHeight: titleStyle.lineHeight,
        rectangles: textRectangles(title), contrast: (Math.max(foreground, backgroundLuminance) + 0.05) / (Math.min(foreground, backgroundLuminance) + 0.05) },
      description: { text: description.textContent, ...rectangle(description), rectangles: textRectangles(description) },
      backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, shadow: style.boxShadow,
      borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      headerOverflow: element.scrollWidth - element.clientWidth,
      controls: Array.from(element.querySelectorAll<HTMLButtonElement>('button')).map(button => {
        const rect = button.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return { text: button.textContent, ...rectangle(button), enabled: !button.disabled, receivesPointer: Boolean(hit && button.contains(hit)) }
      })
    }
  })
  expect(layout.title.fontSize).toBe('24px')
  expect(layout.title.lineHeight).toBe('32px')
  expect(layout.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(layout.backgroundImage).toBe('none')
  expect(layout.shadow).toBe('none')
  expect(layout.borderWidths).toEqual(['0px', '0px', '0px', '0px'])
  expect(layout.headerOverflow, `${item.id} header overflow`).toBeLessThanOrEqual(1)
  expect(layout.title.contrast, `${item.id} title contrast`).toBeGreaterThanOrEqual(4.5)
  expectInside(layout.header, layout.content, `${item.id} header`)
  expect(layout.header.bottom).toBeLessThanOrEqual(layout.inner[1])
  expect(layout.title.rectangles.length).toBeGreaterThan(0)
  expect(layout.description.rectangles.length).toBeGreaterThan(0)
  for (const rect of [...layout.title.rectangles, ...layout.description.rectangles]) expectInside(rect, layout.header, `${item.id} text`)
  for (const control of layout.controls) {
    expectInside(control, layout.header, `${item.id} ${control.text}`)
    expect(control.enabled, `${item.id} ${control.text} enabled`).toBe(true)
    expect(control.receivesPointer, `${item.id} ${control.text} pointer target`).toBe(true)
    for (const rect of [...layout.title.rectangles, ...layout.description.rectangles]) {
      expect(intersects(control, rect), `${item.id} action overlaps heading text`).toBe(false)
    }
  }
  if (item.id === 'dashboard') expect(layout.controls).toHaveLength(2)
  if (item.id === 'plugins') expect(layout.controls).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath(`${imageName}.png`) })
  return layout
}

async function saveEvidence(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value, null, 2)
  writeFileSync(testInfo.outputPath(`${name}.json`), body)
  await testInfo.attach(name, { body, contentType: 'application/json' })
}

async function smokePageActions(page: Page): Promise<void> {
  await openPage(page, managementPages[0])
  const versions = await page.evaluate(() => window.knowbook.listBackupVersions())
  const backup = page.getByRole('button', { name: uiText('Run backup now', '立即执行备份'), exact: true })
  await backup.focus()
  await expect(backup).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.knowbook.listBackupVersions()).then(versions => versions.map(version => version.id)))
    .not.toEqual(versions.map(version => version.id))
  const restore = page.getByRole('button', { name: uiText('Import Markdown / restore backup', '导入 Markdown / 恢复备份'), exact: true })
  await restore.focus()
  await expect(restore).toBeFocused()

  await openPage(page, managementPages[1])
  await page.getByRole('button', { name: uiText('Configure AI', '配置 AI'), exact: true }).click()
  await expect(page.locator('.content.page-settings')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel(uiText('Model', '模型'), { exact: true })).toBeVisible()

  await openPage(page, managementPages[3])
  const query = page.getByLabel(uiText('Keywords', '关键词'), { exact: true })
  await query.fill('Header smoke document')
  await query.press('Enter')
  await expect(page.getByTestId('workspace-search-result').filter({ hasText: 'Header smoke document' }).first()).toBeVisible()
  await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')

  await openPage(page, managementPages[4])
  // This page currently searches workspace plugins separately from Full Trust
  // plugins. Verify the existing input rather than requiring a future unified filter.
  const pluginSearch = page.getByLabel(uiText('Search plugins', '搜索插件'), { exact: true })
  await pluginSearch.fill('theme-switcher')
  await expect(pluginSearch).toHaveValue('theme-switcher')
  await pluginSearch.fill('')
  await expect(pluginSearch).toHaveValue('')
  await expect(page.locator('.system-plugin-request').filter({ hasText: '主题切换' }).first()).toBeVisible()
}

for (const language of ['en-US', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`native management page headers stay compact and usable in ${language}/${theme} @electron`, async ({}, testInfo) => {
      test.setTimeout(120_000)
      test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
      await withElectronApp(async ({ app, page, tempRoot }) => {
        await page.evaluate(async ({ language, theme }) => {
          await window.knowbook.saveSetting('ui.language', language)
          await window.knowbook.saveSetting('appearance.theme', theme)
          const { id } = await window.knowbook.createDocument(null)
          await window.knowbook.updateDocument(id, { title: 'Header smoke document', summary: '', blocks: [
            { id: `${id}-body`, type: 'paragraph', content: 'Local page header smoke content', checked: false, depth: 0 }
          ] })
        }, { language, theme })
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        const evidence: unknown[] = []
        for (const width of [1280, 760]) {
          const native = await setNativeSize(app, page, width)
          for (const item of managementPages) {
            await openPage(page, item)
            const layout = await verifyHeader(page, item, testInfo, `${width}-${item.id}`)
            evidence.push({ width, page: item.id, native, layout })
          }
        }
        await smokePageActions(page)
        await saveEvidence(testInfo, 'native-page-header-geometry', { language, theme, tempRoot, evidence })
      })
    })
  }
}

test('all built-in color palettes preserve flat readable management headers after navigation @electron', async ({}, testInfo) => {
  test.setTimeout(180_000)
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  await withElectronApp(async ({ app, page, tempRoot }) => {
    await page.evaluate(async () => {
      await window.knowbook.saveSetting('ui.language', 'en-US')
      await window.knowbook.saveSetting('appearance.theme', 'light')
    })
    await page.reload()
    const native = await setNativeSize(app, page, 760)
    await expect.poll(async () => {
      const plugin = (await page.evaluate(() => window.knowbook.listSystemPlugins())).find(plugin => plugin.pluginId === 'theme-switcher')
      return plugin?.source === 'builtin' && plugin.status === 'active' && plugin.runtimeStatus === 'active'
    }).toBe(true)
    const evidence: unknown[] = []
    for (const themeId of ['cloud', 'paper', 'moss', 'bay', 'midnight', 'violet']) {
      await page.evaluate(async themeId => {
        const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')!
        if (!plugin.currentArtifactSha256) throw new Error('Missing built-in Theme Switcher artifact')
        await window.knowbook.invokeSystemPluginMain({ pluginId: plugin.pluginId,
          revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'set-theme', input: { themeId } })
      }, themeId)
      await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', themeId)
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      for (const item of managementPages) {
        await openPage(page, item)
        const layout = await verifyHeader(page, item, testInfo, `${themeId}-${item.id}`)
        evidence.push({ themeId, page: item.id, native, layout })
      }
    }
    await saveEvidence(testInfo, 'palette-page-header-geometry', { tempRoot, evidence })
  })
})
