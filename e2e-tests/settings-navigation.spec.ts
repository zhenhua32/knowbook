import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function openSettings(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await expect(page.getByRole('tab', { name: uiText('General', '通用') })).toHaveAttribute('aria-selected', 'true')
}

async function expectSeparatedHeader(page: Page) {
  const header = await page.locator('.settings-page-header').boundingBox()
  const layout = await page.locator('.settings-layout').boundingBox()
  expect(header).not.toBeNull()
  expect(layout).not.toBeNull()
  expect(header!.height).toBeGreaterThan(0)
  expect(header!.y + header!.height).toBeLessThanOrEqual(layout!.y + 1)
}

test('settings categories preserve drafts and remain usable with keyboard, dark theme, and narrow windows @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  await withElectronApp(async ({ page }) => {
    await openSettings(page)
    await expect(page.getByRole('tab')).toHaveCount(7)
    await expect(page.getByRole('tabpanel')).toHaveCount(1)
    await expectSeparatedHeader(page)
    await expect(page.getByLabel(uiText('Interface language', '界面语言'))).toBeVisible()
    await expect(page.getByLabel(uiText('Model', '模型'))).toBeHidden()
    const generalTab = page.getByRole('tab', { name: uiText('General', '通用') })
    await generalTab.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('tab', { name: 'AI', exact: true })).toBeFocused()
    await page.getByLabel(uiText('Model', '模型')).fill('unsaved-category-model')
    await page.getByLabel(uiText('API Key (leave blank to keep current)', 'API Key（留空表示保持当前值）')).fill('unsaved-category-key')

    await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
    const sync = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步') })
    await sync.getByLabel(uiText('Username', '用户名'), { exact: true }).fill('unsaved-sync-username')
    await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏') }).click()
    await page.getByLabel(uiText('Listening port', '监听端口')).fill('4455')
    await page.getByRole('tab', { name: 'AI', exact: true }).click()
    await expect(page.getByLabel(uiText('Model', '模型'))).toHaveValue('unsaved-category-model')
    await expect(page.getByLabel(uiText('API Key (leave blank to keep current)', 'API Key（留空表示保持当前值）'))).toHaveValue('unsaved-category-key')
    await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
    await expect(sync.getByLabel(uiText('Username', '用户名'), { exact: true })).toHaveValue('unsaved-sync-username')
    await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏') }).click()
    await expect(page.getByLabel(uiText('Listening port', '监听端口'))).toHaveValue('4455')
    await page.getByRole('tab', { name: uiText('Storage & recovery', '存储与恢复') }).click()
    await expect(page.getByRole('button', { name: uiText('Open Trash', '打开回收站') })).toBeVisible()
    await page.getByRole('tab', { name: uiText('Appearance', '外观') }).click()
    await expect(page.getByTestId('theme-switcher-settings')).toBeVisible()
    await expectSeparatedHeader(page)
    await page.screenshot({ path: testInfo.outputPath('settings-categories-light.png') })

    await page.evaluate(async () => {
      await window.knowbook.saveSetting('appearance.theme', 'dark')
      await window.knowbook.saveSetting('ui.language', 'zh-CN')
    })
    await page.reload()
    await page.setViewportSize({ width: 760, height: 850 })
    await openSettings(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('tab', { name: '通用', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '网页剪藏', exact: true }).click()
    await expect(page.getByRole('tabpanel')).toHaveCount(1)
    const panel = page.getByRole('tabpanel')
    const dimensions = await panel.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1)
    await expect(panel.getByRole('button', { name: '保存桥接设置', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('settings-categories-dark-narrow.png') })
  })
})
