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
        const overflow = await page.locator('.content.management-page').evaluate((element) => element.scrollWidth - element.offsetWidth)
        expect(overflow, `${item.zh} overflows the management canvas at ${width}px`).toBeLessThanOrEqual(1)
      }
    }
  })
})
