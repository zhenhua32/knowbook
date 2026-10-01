import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

test('dashboard localizes structured activity and opens its document in light, dark, and narrow layouts @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  await withElectronApp(async ({ page }) => {
    await page.evaluate(async () => {
      const createNamed = async (title: string) => {
        const document = await window.knowbook.createDocument(null)
        const detail = await window.knowbook.getDocumentDetail(document.id)
        await window.knowbook.updateDocument(document.id, { ...detail!, title })
        return document.id
      }
      const parent = await createNamed('Projects')
      const child = await createNamed('Launch plan')
      await window.knowbook.moveDocument(child, parent)
      const old = await createNamed('Old research')
      await window.knowbook.deleteDocument(old)
      await window.knowbook.updateAiConfig({ enabled: false, baseUrl: 'https://example.invalid/v1', model: 'local-chat',
        autoSummaryOnSave: false, relatedNotesEnabled: false })
    })
    await page.reload()
    await page.getByTitle(uiText('Dashboard', '总览'), { exact: true }).click()
    const list = page.getByRole('list', { name: 'Recent activity' })
    await expect(list).toContainText('AI disabled · Model: local-chat')
    await expect(list).toContainText('Deleted “Old research”')
    await expect(list).toContainText('Location: Launch plan → Projects/Launch plan')
    await expect(list.locator('time[datetime]')).toHaveCount(8)
    await expect(list.locator('button:disabled')).toHaveCount(0)
    await expect(list).not.toContainText('Saved changes to')
    await expect(list).not.toContainText('Saved AI settings for chat model')
    await page.locator('.dashboard-activity-panel').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('dashboard-activity-light-en.png') })
    await list.getByRole('button', { name: 'Open document: Launch plan', exact: true }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText('Launch plan')

    await page.evaluate(async () => {
      await window.knowbook.saveSetting('appearance.theme', 'dark')
      await window.knowbook.saveSetting('ui.language', 'zh-CN')
    })
    await page.reload()
    await page.setViewportSize({ width: 760, height: 850 })
    await page.getByTitle('总览', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const localized = page.getByRole('list', { name: '最近活动' })
    await expect(localized).toContainText('AI 已关闭 · 模型：local-chat')
    await expect(localized).toContainText('已删除「Old research」')
    await expect(localized).toContainText('位置：Launch plan → Projects/Launch plan')
    await expect(localized).not.toContainText('Document saved')
    const dimensions = await localized.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1)
    await page.locator('.dashboard-activity-panel').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('dashboard-activity-dark-narrow-zh.png') })
    await localized.getByRole('button', { name: '打开文档：Launch plan', exact: true }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText('Launch plan')
  })
})
