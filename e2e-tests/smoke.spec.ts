import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function openRailPage(page: Page, en: string, zh: string): Promise<void> {
  await page.getByTitle(uiText(en, zh)).click()
}

test.describe('Application Shell Smoke @electron', () => {
  test('opens the core workspace pages from the rail', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
    test.slow()

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="shell"]')).toBeVisible()
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      await openRailPage(page, 'Dashboard', '总览')
      await expect(page.locator('.meta-grid')).toBeVisible()

      await openRailPage(page, 'Database', '数据库')
      await expect(page.locator('[data-testid="database-grid"]')).toBeVisible()

      await openRailPage(page, 'AI Assistant', 'AI 助手')
      await expect(page.getByRole('heading', { name: uiText('Document AI assistant', '文档智能助手') })).toBeVisible()

      await openRailPage(page, 'Plugins', '插件中心')
      await expect(page.getByRole('heading', { name: uiText('Workspace extensions', '工作区扩展') })).toBeVisible()
      await expect(page.locator('.plugin-item').first()).toBeVisible()

      await openRailPage(page, 'Settings', '配置中心')
      await expect(page.getByRole('button', { name: uiText('Save AI settings', '保存 AI 设置') })).toBeVisible()

      await openRailPage(page, 'Documents', '文档')
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()
    })
  })
})
