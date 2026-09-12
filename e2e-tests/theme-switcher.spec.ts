import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  closeElectronApp, hasBuiltElectronApp, launchElectronApp, uiText,
  type ElectronAppContext
} from './helpers/electron'

const pluginId = 'theme-switcher'
const themeAttribute = 'data-knowbook-theme-switcher'
const themes = [
  { id: 'cloud', mode: 'light' },
  { id: 'paper', mode: 'light' },
  { id: 'moss', mode: 'light' },
  { id: 'bay', mode: 'dark' },
  { id: 'midnight', mode: 'dark' },
  { id: 'violet', mode: 'dark' }
] as const

async function openPage(page: Page, en: string, zh: string): Promise<void> {
  const button = page.locator('button.nav-icon-btn').and(page.getByTitle(uiText(en, zh))).first()
  await button.click()
  await expect(button).toHaveClass(/active/)
}

async function waitForActivePlugin(page: Page): Promise<void> {
  await expect.poll(async () => {
    const plugin = (await page.evaluate(() => window.knowbook.listSystemPlugins()))
      .find((candidate) => candidate.pluginId === pluginId)
    return plugin?.status === 'active' && plugin.runtimeStatus === 'active'
      ? 'active'
      : JSON.stringify({ status: plugin?.status, runtimeStatus: plugin?.runtimeStatus, error: plugin?.lastError, run: plugin?.lastRun })
  }, { message: 'Theme Switcher Main and Renderer must activate after the reviewed restart' }).toBe('active')
}

async function invokeMain(page: Page, method: string, input?: { themeId: string }): Promise<unknown> {
  return page.evaluate(async ({ pluginId, method, input }) => {
    const plugin = (await window.knowbook.listSystemPlugins()).find((candidate) => candidate.pluginId === pluginId)
    if (!plugin?.currentArtifactSha256) throw new Error('Theme Switcher has no installed revision.')
    return window.knowbook.invokeSystemPluginMain({
      pluginId,
      revisionHash: `sha256:${plugin.currentArtifactSha256}`,
      method,
      ...(input ? { input } : {})
    })
  }, { pluginId, method, input })
}

async function readSurfaces(page: Page): Promise<Record<string, string>> {
  await expect(page.locator('.management-page-header')).toBeVisible()
  await expect(page.locator('.settings-group').first()).toBeVisible()
  return page.evaluate(() => {
    const surfaces: Record<string, string> = {}
    for (const selector of ['body', '.shell', '.content', '.sidebar', '.management-page-header', '.settings-group']) {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`Missing host surface: ${selector}`)
      const style = getComputedStyle(element)
      surfaces[`${selector}:background`] = style.backgroundColor
      surfaces[`${selector}:color`] = style.color
    }
    return surfaces
  })
}

async function chooseTheme(page: Page, theme: typeof themes[number], hostTheme: 'light' | 'dark'): Promise<void> {
  await page.getByTestId(`theme-option-${theme.id}`).click()
  await expect(page.getByTestId(`theme-option-${theme.id}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute(themeAttribute, theme.id)
  await expect(page.locator('html')).toHaveAttribute('data-theme', hostTheme)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme.mode)
  await expect.poll(() => invokeMain(page, 'get-state')).toMatchObject({ selectedThemeId: theme.id })
  expect((await page.evaluate(() => window.knowbook.getHomeData())).appearanceTheme).toBe(hostTheme)
}

async function restoreHostTheme(page: Page, hostTheme: 'light' | 'dark'): Promise<void> {
  await page.getByTestId('theme-option-default').click()
  await expect(page.getByTestId('theme-option-default')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).not.toHaveAttribute(themeAttribute)
  await expect(page.locator('html')).toHaveAttribute('data-theme', hostTheme)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(hostTheme)
  await expect.poll(() => invokeMain(page, 'get-state')).toMatchObject({ selectedThemeId: 'default' })
}

async function changeHostTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => window.knowbook.saveSetting('appearance.theme', value), theme)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await openPage(page, 'Settings', '配置中心')
  await expect(page.getByTestId('theme-switcher-settings')).toBeVisible()
}

async function verifyLazyPagePalettes(page: Page, themeId: 'paper' | 'midnight', testInfo: TestInfo): Promise<void> {
  const catalog = await invokeMain(page, 'get-catalog') as {
    themes: Array<{ id: string, colors: { surface: string, surfaceRaised: string } }>
  }
  const theme = catalog.themes.find((candidate) => candidate.id === themeId)
  expect(theme, 'The installed artifact must provide the selected palette').toBeDefined()
  const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`
  const surface = rgb(theme!.colors.surface)
  const raised = rgb(theme!.colors.surfaceRaised)
  const pages = [
    ...(themeId === 'midnight' ? [{
      en: 'Documents', zh: '文档', name: 'documents',
      surfaces: ['.preview-panel', '.document-header-shell'], text: ['.document-header-title']
    }] : []),
    { en: 'Plugins', zh: '插件中心', name: 'plugins',
      surfaces: ['.plugin-inventory-panel', '.plugin-inspector', '.plugin-overview-card'],
      text: ['.plugin-inventory-head h4', '.plugin-card-title-row > strong', '.plugin-inspector-head code'] },
    { en: 'Database', zh: '数据库', name: 'database',
      surfaces: ['.dbw-header', '.dbw-toolbar', '.dbw-table-scroll'],
      text: ['.dbw-source-trigger', '.dbw-table th.dbw-title-column'] }
  ]
  for (const item of pages) {
    await openPage(page, item.en, item.zh)
    if (item.name === 'plugins') {
      const toggle = page.locator('.plugin-item button.plugin-details-toggle').first()
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    }
    await expect(page.locator('html')).toHaveAttribute(themeAttribute, themeId)
    for (const selector of item.surfaces) {
      await expect(page.locator(selector).first()).toBeVisible()
      await expect(page.locator(selector).first()).toHaveCSS('background-color', surface)
    }
    if (item.name === 'database') {
      await expect(page.locator('.dbw-table th.dbw-title-column')).toHaveCSS('background-color', raised)
    }
    for (const selector of item.text) {
      const text = page.locator(selector).first()
      await expect(text).toBeVisible()
      const contrast = await text.evaluate((element) => {
        const rgba = (color: string): number[] => color.match(/[\d.]+/g)!.map(Number)
        const luminance = (color: number[]): number => {
          const [r, g, b] = color.slice(0, 3).map((channel) => {
            const value = channel / 255
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
          })
          return r * 0.2126 + g * 0.7152 + b * 0.0722
        }
        const foreground = luminance(rgba(getComputedStyle(element).color))
        let current: Element | null = element
        while (current) {
          const background = rgba(getComputedStyle(current).backgroundColor)
          if ((background[3] ?? 1) === 1) {
            const value = luminance(background)
            return (Math.max(foreground, value) + 0.05) / (Math.min(foreground, value) + 0.05)
          }
          current = current.parentElement
        }
        throw new Error('Text has no opaque ancestor surface.')
      })
      expect(contrast, `${themeId} ${item.name} ${selector} text contrast`).toBeGreaterThanOrEqual(4.5)
    }
    await page.screenshot({ path: testInfo.outputPath(`${themeId}-${item.name}.png`) })
  }
  await openPage(page, 'Settings', '配置中心')
  await expect(page.getByTestId('theme-switcher-settings')).toBeVisible()
}

test('v3 Theme Switcher applies six palettes, preserves selection, and restores host appearance on disable @electron', async ({}, testInfo) => {
  test.setTimeout(180_000)
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  let context: ElectronAppContext | null = null
  let retainedRoot: string | null = null
  try {
    context = await launchElectronApp()
    retainedRoot = context.tempRoot
    await openPage(context.page, 'Settings', '配置中心')
    await expect(context.page.getByTestId('theme-switcher-settings')).toHaveCount(0)
    await expect(context.page.locator('html')).toHaveAttribute('data-theme', 'light')
    const originalLight = await readSurfaces(context.page)

    await context.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
    }, resolve('plugins/theme-switcher'))
    const prepared = await context.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    expect(prepared?.pluginId).toBe(pluginId)
    expect(prepared?.status).toBe('awaiting-confirmation')
    await openPage(context.page, 'Plugins', '插件中心')
    const request = context.page.locator('.system-plugin-request').filter({ hasText: '主题切换' }).first()
    await expect(request).toContainText(`SHA-256: ${prepared!.artifactSha256}`)
    const confirm = request.getByRole('button', { name: uiText('Confirm system install', '确认系统安装') })
    await expect(confirm).toBeDisabled()
    await request.locator('input[type="checkbox"]').check()
    await request.locator('.plugin-field input').fill('incorrect-plugin-id')
    await expect(confirm).toBeDisabled()
    await request.locator('.plugin-field input').fill(pluginId)
    await confirm.click()
    await expect(request.locator('.plugin-status')).toHaveText('pending-restart')
    await expect(context.page.locator('html')).not.toHaveAttribute(themeAttribute)
    await closeElectronApp(context, { preserveUserData: true })
    context = null

    context = await launchElectronApp({}, { userDataRoot: retainedRoot })
    await waitForActivePlugin(context.page)
    await openPage(context.page, 'Settings', '配置中心')
    const settings = context.page.getByTestId('theme-switcher-settings')
    await expect(settings).toBeVisible()
    await expect(settings.locator('[data-testid^="theme-option-"]')).toHaveCount(7)
    await expect(context.page.getByTestId('theme-option-default')).toHaveAttribute('aria-pressed', 'true')
    await expect(context.page.locator('html')).not.toHaveAttribute(themeAttribute)
    expect(await readSurfaces(context.page)).toEqual(originalLight)
    expect(await context.page.locator(`style[data-full-trust-plugin="${pluginId}"]`).count()).toBeGreaterThan(0)

    const palettes = new Map<string, Record<string, string>>()
    for (const theme of themes) {
      await chooseTheme(context.page, theme, 'light')
      const surfaces = await readSurfaces(context.page)
      expect(surfaces['.shell:background']).not.toBe('rgba(0, 0, 0, 0)')
      expect(surfaces['.sidebar:background']).not.toBe('rgba(0, 0, 0, 0)')
      palettes.set(theme.id, surfaces)
    }
    // Different card selections must change the real application canvas.
    expect(new Set([...palettes.values()].map((palette) => palette['.shell:background'])).size).toBe(6)
    await expect(invokeMain(context.page, 'set-theme', { themeId: 'missing-theme' })).rejects.toThrow()
    await expect(context.page.locator('html')).toHaveAttribute(themeAttribute, 'violet')
    await expect.poll(() => invokeMain(context!.page, 'get-state')).toMatchObject({ selectedThemeId: 'violet' })

    await changeHostTheme(context.page, 'dark')
    await restoreHostTheme(context.page, 'dark')
    const originalDark = await readSurfaces(context.page)
    expect(originalDark).not.toEqual(originalLight)
    await chooseTheme(context.page, themes[0], 'dark')
    expect(await readSurfaces(context.page)).toEqual(palettes.get('cloud'))
    await context.page.getByTestId('theme-switcher-settings').scrollIntoViewIfNeeded()
    await context.page.screenshot({ path: testInfo.outputPath('cloud-over-dark-host.png') })
    await context.page.getByTestId('theme-switcher-settings').screenshot({ path: testInfo.outputPath('cloud-theme-picker.png') })
    await chooseTheme(context.page, themes[1], 'dark')
    expect(await readSurfaces(context.page)).toEqual(palettes.get('paper'))
    await context.page.screenshot({ path: testInfo.outputPath('paper-over-dark-host.png') })
    await verifyLazyPagePalettes(context.page, 'paper', testInfo)
    await restoreHostTheme(context.page, 'dark')
    expect(await readSurfaces(context.page)).toEqual(originalDark)

    await changeHostTheme(context.page, 'light')
    await chooseTheme(context.page, themes[3], 'light')
    expect(await readSurfaces(context.page)).toEqual(palettes.get('bay'))
    await restoreHostTheme(context.page, 'light')
    expect(await readSurfaces(context.page)).toEqual(originalLight)
    await chooseTheme(context.page, themes[4], 'light')
    await context.page.getByTestId('theme-switcher-settings').scrollIntoViewIfNeeded()
    await context.page.screenshot({ path: testInfo.outputPath('midnight-over-light-host.png') })
    await context.page.getByTestId('theme-switcher-settings').screenshot({ path: testInfo.outputPath('midnight-theme-picker.png') })
    await verifyLazyPagePalettes(context.page, 'midnight', testInfo)
    await closeElectronApp(context, { preserveUserData: true })
    context = null

    context = await launchElectronApp({}, { userDataRoot: retainedRoot })
    await waitForActivePlugin(context.page)
    await openPage(context.page, 'Settings', '配置中心')
    await expect(context.page.getByTestId('theme-option-midnight')).toHaveAttribute('aria-pressed', 'true')
    await expect(context.page.locator('html')).toHaveAttribute(themeAttribute, 'midnight')
    await expect(context.page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect.poll(() => invokeMain(context!.page, 'get-state')).toMatchObject({ selectedThemeId: 'midnight' })
    expect(await readSurfaces(context.page)).toEqual(palettes.get('midnight'))

    await context.page.evaluate(() => window.knowbook.setSystemPluginEnabled({ pluginId: 'theme-switcher', enabled: false }))
    await expect(context.page.getByTestId('theme-switcher-settings')).toHaveCount(0)
    await expect(context.page.locator('html')).not.toHaveAttribute(themeAttribute)
    await expect(context.page.locator('html')).not.toHaveAttribute(`${themeAttribute}-owner`)
    await expect(context.page.locator(`style[data-full-trust-plugin="${pluginId}"]`)).toHaveCount(0)
    await expect(context.page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect.poll(() => context!.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light')
    await expect.poll(() => readSurfaces(context!.page)).toEqual(originalLight)
    await expect(invokeMain(context.page, 'get-state')).rejects.toThrow(/active|disposed|registered/i)
    expect((await context.page.evaluate(() => window.knowbook.getHomeData())).appearanceTheme).toBe('light')
  } finally {
    if (context) await closeElectronApp(context)
    if (retainedRoot) rmSync(retainedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
