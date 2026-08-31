import { expect, test, type Page } from '@playwright/test'
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

test('management pages keep the readable typography and responsive canvas contract', async () => {
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

test('management layouts use the available minimum-window space without compressed auxiliary columns', async () => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

  await withElectronApp(async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 760 })

    await openManagementPage(page, 'Dashboard', '总览', '.hero')
    const dashboardLayout = await page.locator('.detail-grid').first().evaluate((grid) => {
      const panel = grid.querySelector<HTMLElement>('.large-panel')
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
    const emptyTranscriptHeight = await page.locator('.assistant-transcript.is-empty').evaluate((element) => element.getBoundingClientRect().height)
    expect(emptyTranscriptHeight).toBeLessThanOrEqual(180)

    await openManagementPage(page, 'Plugins', '插件中心', '.plugins-page')
    const pluginLayout = await page.locator('.plugin-management-layout').evaluate((layout) => {
      const inventory = layout.querySelector<HTMLElement>('.plugin-inventory-panel')?.getBoundingClientRect()
      const inspector = layout.querySelector<HTMLElement>('.plugin-inspector')?.getBoundingClientRect()
      return {
        columns: getComputedStyle(layout).gridTemplateColumns.split(' ').filter(Boolean).length,
        inspectorFollowsInventory: Boolean(inventory && inspector && inspector.top >= inventory.bottom - 1)
      }
    })
    expect(pluginLayout).toEqual({ columns: 1, inspectorFollowsInventory: true })

    await openManagementPage(page, 'Database', '数据库', '[data-testid="database-grid"]')
    const tableOverflow = await page.locator('.dbw-table-scroll').evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(tableOverflow).toBeLessThanOrEqual(1)
  })
})

test('dark management surfaces keep primary text readable and use one coherent database palette', async () => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

  await withElectronApp(async ({ page }) => {
    await page.evaluate(async () => window.knowbook.saveSetting('appearance.theme', 'dark'))
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    const samples = [
      { en: 'Dashboard', zh: '总览', ready: '.hero', selectors: ['.hero h2', '.stat-card strong', '.panel-head h3', '.plugin-dashboard-card p:last-child'] },
      { en: 'AI Assistant', zh: 'AI 助手', ready: '.management-page-header', selectors: ['.management-page-heading h2', '.panel-head h3'] },
      { en: 'Plugins', zh: '插件中心', ready: '.plugins-page', selectors: ['.plugin-page-heading h3', '.plugin-card-title-row > strong', '.plugin-status-running', '.plugin-inspector h4'] },
      { en: 'Settings', zh: '配置中心', ready: '.settings-layout', selectors: ['.management-page-heading h2', '.panel-head h3', '.settings-group-heading h4'] },
      { en: 'Database', zh: '数据库', ready: '[data-testid="database-grid"]', selectors: ['.dbw-source-trigger', '.dbw-table th', '.dbw-record-title strong'] }
    ]

    for (const item of samples) {
      await openManagementPage(page, item.en, item.zh, item.ready)
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
