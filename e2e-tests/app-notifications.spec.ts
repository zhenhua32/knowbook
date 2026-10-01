import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

test('unified backup notifications retain hidden progress, retry safely and persist history @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    const failureReason = 'Cannot write C:/Backups/Error: Notes.md\nFree disk space and retry.'
    await app.evaluate(({ ipcMain }, reason) => {
      let calls = 0
      ipcMain.removeHandler('knowbook:trigger-backup')
      ipcMain.handle('knowbook:trigger-backup', () => new Promise((resolve, reject) => {
        const attempt = ++calls
        ipcMain.once('knowbook:test-finish-backup', () => {
          if (attempt === 1) reject(new Error(`Error: ${reason}`))
          else resolve({ exported: 3, root: '/backup', at: new Date().toISOString() })
        })
      }))
    }, failureReason)
    await page.getByTitle(uiText('Dashboard', '总览'), { exact: true }).click()
    await page.getByRole('button', { name: uiText('Run backup now', '立即执行备份') }).click()
    const toasts = page.locator('.app-notifications')
    await expect(toasts.getByRole('progressbar')).toBeVisible()
    await toasts.getByRole('button', { name: uiText('Dismiss notification', '关闭通知') }).click()
    await app.evaluate(({ ipcMain }) => { ipcMain.emit('knowbook:test-finish-backup') })
    const bell = page.getByRole('button', { name: /Notification center|通知中心/ })
    await expect(bell).toHaveAccessibleName(/1 unread|1 条未读/)
    await bell.click()
    const center = page.getByRole('dialog', { name: uiText('Notification center', '通知中心') })
    await expect(center.locator('.app-notification-message')).toHaveText(failureReason)
    await page.screenshot({ path: testInfo.outputPath('notification-failure-reason.png') })
    const recordId = await center.locator('.app-notification').getAttribute('data-notification-id')
    await center.getByRole('button', { name: uiText('Retry', '重试') }).click()
    await expect(center.getByRole('progressbar')).toBeVisible()
    await expect(center.getByRole('button', { name: uiText('Clear completed', '清除已结束通知') })).toBeDisabled()
    await app.evaluate(({ ipcMain }) => { ipcMain.emit('knowbook:test-finish-backup') })
    await expect(center.locator('.app-notification-success')).toContainText(/Exported 3|已导出 3/)
    await expect(center.locator('.app-notification')).toHaveAttribute('data-notification-id', recordId!)
    await page.screenshot({ path: testInfo.outputPath('notification-center-light.png') })
    await page.keyboard.press('Escape')
    await expect(center).not.toBeVisible()
    await expect(bell).toBeFocused()
    await expect(toasts).toHaveCount(0)
    await page.reload()
    await bell.click()
    await expect(center.locator('.app-notification')).toHaveCount(1)
    await expect(center).toContainText(/Exported 3|已导出 3/)
    await expect(center.getByRole('button', { name: uiText('Retry', '重试') })).toHaveCount(0)
    await page.setViewportSize({ width: 420, height: 640 })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await expect(center).toBeVisible()
    expect(await center.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('notification-center-dark-narrow.png') })
    await center.getByRole('button', { name: uiText('Clear completed', '清除已结束通知') }).click()
    await expect(center).toContainText(/No notifications yet|暂无通知/)
  })
})

test('automatic backup failures ignore stale snapshots and repeated events and remain usable after clearing @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler('knowbook:get-backup-health')
      ipcMain.handle('knowbook:get-backup-health', () => {
        BrowserWindow.getAllWindows()[0].webContents.send('knowbook:backup-health', { revision: 3,
          error: "Error invoking remote method 'knowbook:trigger-backup': Error: Latest backup failure" })
        return { revision: 2, error: 'Stale backup failure' }
      })
    })
    await page.reload()
    const toasts = page.locator('.app-notifications')
    await expect(toasts).toContainText('Latest backup failure')
    await expect(toasts.locator('.app-notification-message')).toHaveText('Latest backup failure')
    await page.clock.install()
    await page.clock.runFor(7_000)
    await expect(toasts.getByRole('alert')).toContainText('Latest backup failure')
    await app.evaluate(({ BrowserWindow }) => {
      for (let i = 0; i < 3; i++) BrowserWindow.getAllWindows()[0].webContents.send('knowbook:backup-health', { revision: 3, error: 'Latest backup failure' })
    })
    await expect(toasts.locator('.app-notification')).toHaveCount(1)
    await expect(toasts).not.toContainText('Stale backup failure')
    await page.getByRole('button', { name: /Notification center|通知中心/ }).click()
    const center = page.getByRole('dialog', { name: uiText('Notification center', '通知中心') })
    await center.getByRole('button', { name: uiText('Clear completed', '清除已结束通知') }).click()
    await expect(center.locator('.app-notification')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('knowbook:backup-health', { revision: 4, error: 'New backup failure' })
    })
    await expect(center.locator('.app-notification')).toHaveCount(1)
    await expect(center).toContainText('New backup failure')
    await center.getByRole('button', { name: uiText('Retry backup', '重试备份') }).click()
    await expect(center.locator('.app-notification-success')).toContainText(/backup recovered|自动备份已恢复/)
  })
})

test('failure history retains clean host reasons and original plugin content after reload @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    const reason = 'Cannot write C:/Backups/Error: Notes.md\nChoose a writable folder and retry.'
    await app.evaluate(({ ipcMain }, message) => {
      ipcMain.removeHandler('knowbook:trigger-backup')
      ipcMain.handle('knowbook:trigger-backup', () => { throw new Error(`Error: TypeError: ${message}`) })
    }, reason)
    await page.getByTitle(uiText('Dashboard', '总览'), { exact: true }).click()
    await page.getByRole('button', { name: uiText('Run backup now', '立即执行备份') }).click()
    const toasts = page.locator('.app-notifications')
    await expect(toasts.locator('.app-notification-message')).toHaveText(reason)
    const pluginMessage = "Error invoking remote method 'plugin:example': Error: is the diagnostic text.\nKeep it exactly."
    await app.evaluate(({ BrowserWindow }, message) => {
      BrowserWindow.getAllWindows()[0].webContents.send('knowbook:plugin-notification', {
        title: 'Plugin diagnostic', level: 'error', message
      })
    }, pluginMessage)
    await expect(toasts.locator('.app-notification').filter({ hasText: 'Plugin diagnostic' }).locator('.app-notification-message')).toHaveText(pluginMessage)
    const bell = page.getByRole('button', { name: /Notification center|通知中心/ })
    await bell.click()
    const center = page.getByRole('dialog', { name: uiText('Notification center', '通知中心') })
    const pluginRecord = center.locator('.app-notification').filter({ hasText: 'Plugin diagnostic' })
    const hostRecord = center.locator('.app-notification').filter({ hasNotText: 'Plugin diagnostic' })
    await expect(hostRecord.locator('.app-notification-message')).toHaveText(reason)
    await expect(pluginRecord.locator('.app-notification-message')).toHaveText(pluginMessage)
    await page.reload()
    await bell.click()
    await expect(center.locator('.app-notification')).toHaveCount(2)
    await expect(hostRecord.locator('.app-notification-message')).toHaveText(reason)
    await expect(pluginRecord.locator('.app-notification-message')).toHaveText(pluginMessage)
    await expect(center.getByRole('button', { name: uiText('Retry', '重试') })).toHaveCount(0)
    await page.setViewportSize({ width: 420, height: 640 })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    expect(await center.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('notification-failure-history-dark.png') })
  })
})

test('Chinese settings failures keep the localized explanation and clean IPC reason @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await page.evaluate(() => window.knowbook.saveSetting('ui.language', 'zh-CN'))
    await app.evaluate(({ ipcMain }) => {
      let attempts = 0
      ipcMain.removeHandler('knowbook:get-app-update-state')
      ipcMain.handle('knowbook:get-app-update-state', () => ({ status: 'idle', currentVersion: '1.0.0',
        availableVersion: null, downloadedVersion: null, releaseName: null, releaseNotes: null,
        checkedAt: null, progressPercent: null, message: '', error: null, updatesEnabled: true, canInstall: false }))
      ipcMain.removeHandler('knowbook:check-for-app-updates')
      ipcMain.handle('knowbook:check-for-app-updates', () => {
        throw new Error(++attempts === 1 ? 'Error: 更新服务暂时无法连接。\n请稍后重试。' : 'Error: ')
      })
    })
    await page.reload()
    await page.getByTitle('配置中心', { exact: true }).click()
    await page.getByRole('tab', { name: '更新', exact: true }).click()
    const check = page.getByRole('button', { name: '检查更新', exact: true })
    await check.click()
    const toasts = page.locator('.app-notifications')
    await expect(toasts.locator('.app-notification-message')).toHaveText('检查更新失败。 更新服务暂时无法连接。\n请稍后重试。')
    await expect(check).toBeEnabled()
    await toasts.getByRole('button', { name: '关闭通知', exact: true }).click()
    await check.click()
    await expect(toasts.locator('.app-notification-message')).toHaveText('检查更新失败。')
  })
})

test('import report actions close the center and the bell works in the collapsed Chinese sidebar @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await page.evaluate(() => window.knowbook.saveSetting('ui.language', 'zh-CN'))
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:restore-backup-from-folder')
      ipcMain.handle('knowbook:restore-backup-from-folder', () => ({
        restored: 0, created: 0, updated: 0, deleted: 0, conflictsResolved: 0, placeholdersCreated: 0,
        root: '/test-import', at: new Date().toISOString(), importReport: { files: [], issueCount: 0, ignoredExternalCount: 0 }
      }))
    })
    await page.reload()
    await page.getByTitle('总览', { exact: true }).click()
    await page.getByRole('button', { name: /导入.*备份/ }).click()
    const report = page.getByRole('dialog', { name: 'Markdown 导入报告' })
    await expect(report).toBeVisible()
    await report.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '收起左侧栏', exact: true }).click()
    await page.getByRole('button', { name: /通知中心/ }).click()
    const center = page.getByRole('dialog', { name: '通知中心' })
    await expect(center).toContainText('导入备份完成')
    await page.screenshot({ path: testInfo.outputPath('notification-center-chinese.png') })
    await center.getByRole('button', { name: '查看导入报告', exact: true }).click()
    await expect(center).toHaveCount(0)
    await expect(report).toBeVisible()
  })
})
