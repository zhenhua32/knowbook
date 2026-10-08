import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

const managementPages = [
  { en: 'Dashboard', zh: '总览', ready: '.hero' },
  { en: 'Database', zh: '数据库', ready: '[data-testid="database-grid"]' },
  { en: 'AI Assistant', zh: 'AI 助手', ready: '.management-page-header' },
  { en: 'Plugins', zh: '插件中心', ready: '.plugins-page' },
  { en: 'Settings', zh: '配置中心', ready: '.settings-layout' }
]

async function openManagementPage(page: Page, en: string, zh: string, ready: string): Promise<void> {
  await page.getByTitle(uiText(en, zh)).click()
  await expect(page.locator('.content.management-page')).toBeVisible()
  await expect(page.locator(ready)).toBeVisible()
}

async function settingsToggleColors(toggle: Locator) {
  await expect.poll(() => toggle.evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  return toggle.evaluate(element => {
    const rgba = (value: string): number[] => {
      const match = /^rgba?\(([^)]+)\)$/.exec(value)
      if (!match) throw new Error(`Unsupported computed switch color: ${value}`)
      const channels = match[1].split(',').map(Number)
      if (channels.length === 3) channels.push(1)
      if (channels.length !== 4 || !channels.every(Number.isFinite)) throw new Error(`Invalid computed switch color: ${value}`)
      return channels
    }
    const luminance = (color: number[]): number => color.slice(0, 3)
      .map(channel => channel / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0)
    const contrast = (first: number[], second: number[]): number => {
      const values = [luminance(first), luminance(second)]
      return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
    }
    const style = getComputedStyle(element), thumb = getComputedStyle(element, '::before')
    const trackColor = rgba(style.backgroundColor), thumbColor = rgba(thumb.backgroundColor)
    const backgrounds: number[][] = []
    for (let node = element.parentElement; node; node = node.parentElement) {
      const ancestor = getComputedStyle(node)
      if (ancestor.backgroundImage !== 'none' || Number(ancestor.opacity) !== 1) throw new Error('Switch contrast needs a known solid surface.')
      const color = rgba(ancestor.backgroundColor)
      backgrounds.push(color)
      if (color[3] === 1) break
    }
    let surface = backgrounds.pop()
    if (!surface || surface[3] !== 1 || trackColor[3] !== 1 || thumbColor[3] !== 1 || Number(style.opacity) !== 1) {
      throw new Error('Enabled switches must expose opaque track, thumb and surface colors.')
    }
    for (const front of backgrounds.reverse()) {
      surface = [...front.slice(0, 3).map((channel, index) => channel * front[3] + surface![index] * (1 - front[3])), 1]
    }
    const focusColor = rgba(style.outlineColor)
    return {
      checked: (element as HTMLInputElement).checked,
      track: style.backgroundColor, thumb: thumb.backgroundColor, surface,
      trackContrast: contrast(trackColor, surface), thumbContrast: contrast(thumbColor, trackColor),
      thumbOffset: thumb.transform === 'none' ? 0 : new DOMMatrixReadOnly(thumb.transform).m41,
      focusVisible: element.matches(':focus-visible'), outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth), outlineAlpha: focusColor[3],
      focusContrast: contrast(focusColor, surface)
    }
  })
}

test('settings switches retain visible states and native label and keyboard interaction in every built-in palette @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  test.setTimeout(120_000)
  await withElectronApp(async ({ page }) => {
    await page.evaluate(async () => window.knowbook.saveSetting('ui.language', 'en-US'))
    const stored = (await page.evaluate(() => window.knowbook.getHomeData())).aiConfig
    const evidence: unknown[] = []
    for (const palette of ['light', 'dark', 'cloud', 'paper', 'moss', 'bay', 'midnight', 'violet']) {
      if (palette === 'light' || palette === 'dark') {
        await page.evaluate(async theme => window.knowbook.saveSetting('appearance.theme', theme), palette)
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('data-theme', palette)
        await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
      }
      await openManagementPage(page, 'Settings', '配置中心', '.settings-layout')
      if (palette !== 'light' && palette !== 'dark') {
        await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
        await page.getByTestId(`theme-option-${palette}`).click()
        await expect(page.getByTestId(`theme-option-${palette}`)).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', palette)
      }
      const tab = page.getByRole('tab', { name: 'AI', exact: true })
      await tab.click()
      const row = page.locator('.settings-ai-panel .toggle-row').first()
      const toggle = row.getByRole('checkbox')
      await expect(toggle).toBeEnabled()
      const initiallyChecked = await toggle.isChecked()
      await page.keyboard.press('Tab')
      await expect(toggle).toBeFocused()
      const initial = await settingsToggleColors(toggle)
      expect(initial.focusVisible, `${palette} keyboard focus is visible`).toBe(true)
      expect(initial.outlineStyle).toBe('solid')
      expect(initial.outlineWidth).toBeGreaterThanOrEqual(2)
      expect(initial.outlineAlpha).toBe(1)
      expect(initial.focusContrast, `${palette} focus ring contrast`).toBeGreaterThanOrEqual(3)

      // Clicking the text must activate the whole native label, not just the thumb.
      await row.locator('span').click()
      await expect(toggle).toBeChecked({ checked: !initiallyChecked })
      const changed = await settingsToggleColors(toggle)
      for (const [state, sample] of [['initial', initial], ['changed', changed]] as const) {
        expect(sample.trackContrast, `${palette} ${state} track against its panel`).toBeGreaterThanOrEqual(3)
        expect(sample.thumbContrast, `${palette} ${state} thumb against its track`).toBeGreaterThanOrEqual(3)
        expect(sample.thumbOffset, `${palette} ${state} position indicates the checked state`).toBe(sample.checked ? 16 : 0)
      }
      await tab.click()
      await page.keyboard.press('Tab')
      await expect(toggle).toBeFocused()
      await page.keyboard.press('Space')
      await expect(toggle).toBeChecked({ checked: initiallyChecked })
      evidence.push({ palette, initial, changed })
    }
    expect((await page.evaluate(() => window.knowbook.getHomeData())).aiConfig).toEqual(stored)
    await info.attach('settings-switch-computed-colors', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  })
})

test('management pages keep the readable typography and responsive canvas contract @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  test.slow()

  await withElectronApp(async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })

    for (const item of managementPages) {
      await openManagementPage(page, item.en, item.zh, item.ready)
      const tinyText = await page.locator('.content.management-page').evaluate((root) => {
        return Array.from(root.querySelectorAll<HTMLElement>('*'))
          .filter((element) => {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            const hasOwnText = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
            return hasOwnText && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
          })
          .map((element) => ({
            className: element.className,
            fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
            text: element.textContent?.trim().slice(0, 48) ?? ''
          }))
          .filter((entry) => entry.fontSize < 12)
      })

      expect(tinyText, `${item.zh} contains informational text below 12px`).toEqual([])
    }

    for (const width of [1280, 1024, 768]) {
      await page.setViewportSize({ width, height: 900 })
      for (const item of managementPages) {
        await openManagementPage(page, item.en, item.zh, item.ready)
        const overflow = await page.locator('.content.management-page').evaluate((element) => element.scrollWidth - (element as HTMLElement).offsetWidth)
        expect(overflow, `${item.zh} overflows the management canvas at ${width}px`).toBeLessThanOrEqual(1)
      }
    }
  })
})

test('management layouts use the available minimum-window space without compressed auxiliary columns @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

  await withElectronApp(async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 760 })

    await openManagementPage(page, 'Dashboard', '总览', '.hero')
    const dashboardLayout = await page.locator('.detail-grid').first().evaluate((grid) => {
      const panel = grid.querySelector<HTMLElement>('.dashboard-activity-panel')
      const gridRect = grid.getBoundingClientRect()
      const panelRect = panel?.getBoundingClientRect()
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
        panelWidthDelta: panelRect ? Math.abs(gridRect.width - panelRect.width) : Number.POSITIVE_INFINITY,
        panelHeight: panelRect?.height ?? Number.POSITIVE_INFINITY
      }
    })
    expect(dashboardLayout.columns).toBe(1)
    expect(dashboardLayout.panelWidthDelta).toBeLessThanOrEqual(1)
    expect(dashboardLayout.panelHeight).toBeLessThanOrEqual(200)

    await openManagementPage(page, 'AI Assistant', 'AI 助手', '.management-page-header')
    await page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手') }).click()
    await expect(page.locator('.assistant-transcript.is-empty')).toBeVisible()
    await expect(page.locator('.assistant-composer textarea')).toBeInViewport()
    await expect(page.locator('.assistant-composer button')).toBeInViewport()
    const assistantLayout = await page.locator('.content.page-ai').evaluate((element) => {
      const transcript = element.querySelector<HTMLElement>('.assistant-transcript')!
      const composer = element.querySelector<HTMLElement>('.assistant-composer')!
      return { pageOverflow: element.scrollHeight - element.clientHeight,
        transcriptBottom: transcript.getBoundingClientRect().bottom, composerTop: composer.getBoundingClientRect().top }
    })
    expect(assistantLayout.pageOverflow).toBeLessThanOrEqual(1)
    expect(assistantLayout.transcriptBottom).toBeLessThanOrEqual(assistantLayout.composerTop)

    await openManagementPage(page, 'Plugins', '插件中心', '.plugins-page')
    await expect(page.locator('.plugin-inspector')).toHaveCount(0)
    await page.locator('button.plugin-details-toggle').first().click()
    await expect(page.locator('.plugin-inline-details')).toBeVisible()
    const pluginLayout = await page.locator('.plugin-management-layout').evaluate((layout) => {
      const inventory = layout.querySelector<HTMLElement>('.plugin-inventory-panel')?.getBoundingClientRect()
      const summary = layout.querySelector<HTMLElement>('.plugin-card-main')?.getBoundingClientRect()
      const inspector = layout.querySelector<HTMLElement>('.plugin-inspector')?.getBoundingClientRect()
      return {
        inventoryUsesFullWidth: Boolean(inventory && Math.abs(inventory.width - layout.getBoundingClientRect().width) <= 1),
        inspectorFollowsSummary: Boolean(summary && inspector && inspector.top >= summary.bottom - 1),
        inspectorInsideItem: Boolean(layout.querySelector('.plugin-item > .plugin-inline-details'))
      }
    })
    expect(pluginLayout).toEqual({ inventoryUsesFullWidth: true, inspectorFollowsSummary: true, inspectorInsideItem: true })

    await openManagementPage(page, 'Database', '数据库', '[data-testid="database-grid"]')
    const tableOverflow = await page.locator('.dbw-table-scroll').evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(tableOverflow).toBeLessThanOrEqual(1)
  })
})

test('dark management surfaces keep primary text readable and use one coherent database palette @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

  await withElectronApp(async ({ page }) => {
    await page.evaluate(async () => window.knowbook.saveSetting('appearance.theme', 'dark'))
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    const samples = [
      { en: 'Dashboard', zh: '总览', ready: '.hero', selectors: ['.hero h2', '.stat-card strong', '.panel-head h3', '.plugin-dashboard-card p:last-child'] },
      { en: 'AI Assistant', zh: 'AI 助手', ready: '.management-page-header', selectors: ['.management-page-heading h2', '.ai-task-switcher [aria-selected="true"]', '.ai-prompt-label'] },
      { en: 'Plugins', zh: '插件中心', ready: '.plugins-page', selectors: ['.plugin-page-heading h3', '.plugin-card-title-row > strong', '.plugin-status-running', '.plugin-inspector h4'] },
      { en: 'Settings', zh: '配置中心', ready: '.settings-layout', selectors: ['.management-page-heading h2', '.settings-category-nav [role="tab"][aria-selected="true"]', '.settings-category-panel:not([hidden]) .settings-group-heading h3'] },
      { en: 'Database', zh: '数据库', ready: '[data-testid="database-grid"]', selectors: ['.dbw-source-trigger', '.dbw-table th', '.dbw-record-title strong'] }
    ]

    for (const item of samples) {
      await openManagementPage(page, item.en, item.zh, item.ready)
      if (item.en === 'Plugins') {
        await page.locator('button.plugin-details-toggle').first().click()
        await expect(page.locator('.plugin-inline-details')).toBeVisible()
      }
      for (const selector of item.selectors) {
        const ratio = await page.locator(selector).first().evaluate((element) => {
          const rgb = (value: string): [number, number, number, number] => {
            const values = value.match(/[\d.]+/g)?.map(Number) ?? []
            return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1]
          }
          const luminance = ([red, green, blue]: [number, number, number, number]): number => {
            const channels = [red, green, blue].map((channel) => {
              const value = channel / 255
              return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
            })
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
          }
          const foreground = rgb(getComputedStyle(element).color)
          let current: Element | null = element
          let background: [number, number, number, number] = [23, 28, 37, 1]
          while (current) {
            const candidate = rgb(getComputedStyle(current).backgroundColor)
            if (candidate[3] > 0.8) {
              background = candidate
              break
            }
            current = current.parentElement
          }
          const light = Math.max(luminance(foreground), luminance(background))
          const dark = Math.min(luminance(foreground), luminance(background))
          return (light + 0.05) / (dark + 0.05)
        })
        expect(ratio, `${item.zh} ${selector} misses WCAG AA contrast`).toBeGreaterThanOrEqual(4.5)
      }
    }

    await openManagementPage(page, 'Database', '数据库', '[data-testid="database-grid"]')
    const databaseSurfaces = await page.locator('.dbw-shell').evaluate((shell) => {
      return ['.dbw-header', '.dbw-toolbar', '.dbw-table-scroll'].map((selector) => (
        getComputedStyle(shell.querySelector(selector) as Element).backgroundColor
      ))
    })
    expect(databaseSurfaces).not.toContain('rgb(255, 255, 255)')
  })
})
