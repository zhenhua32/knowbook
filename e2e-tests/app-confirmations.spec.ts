import { expect, test, type Page } from '@playwright/test'
import { ensureDocumentMetadataEditor, uiText, withElectronApp } from './helpers/electron'

async function openDelete(page: Page) {
  await page.getByRole('button', { name: uiText('More actions', '更多操作') }).click()
  await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Delete', '删除') }).click()
  const dialog = page.getByRole('alertdialog', { name: uiText('Delete document', '删除文档') })
  await expect(dialog).toBeVisible()
  return dialog
}

test('document confirmation traps focus, blocks global shortcuts, cancels safely and fits both themes @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page }) => {
    await page.getByTitle(uiText('New root', '新建根文档')).click()
    await ensureDocumentMetadataEditor(page)
    const title = '确认弹窗长标题 '.repeat(12)
    await page.locator('.document-summary-card .editor-input').first().fill(title)
    await page.getByRole('button', { name: uiText('Save', '保存') }).click()
    await expect(page.locator('.document-path')).toContainText(title.trim())
    const before = await page.evaluate(() => window.knowbook.getDocumentCatalog())
    const dialog = await openDelete(page)
    const cancel = dialog.getByRole('button', { name: uiText('Cancel', '取消') })
    const confirm = dialog.getByRole('button', { name: uiText('Delete document', '删除文档') })
    await expect(cancel).toBeFocused()
    await expect(dialog).toContainText(/Child documents will be kept|子文档会被保留/)
    await expect(dialog).toContainText(/move to Trash|移入回收站/)
    await page.keyboard.press('Shift+Tab')
    await expect(confirm).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+2')
    await expect(page.locator('.global-search-modal')).toHaveCount(0)
    await expect(page.locator('.document-summary-card')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('confirmation-light.png') })
    await page.setViewportSize({ width: 420, height: 640 })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(cancel).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('confirmation-dark-narrow.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: uiText('More actions', '更多操作') })).toBeFocused()
    expect(await page.evaluate(() => window.knowbook.getDocumentCatalog())).toEqual(before)
    await openDelete(page)
    await page.keyboard.press('Enter') // Default focus must cancel, never delete.
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate(() => window.knowbook.getDocumentCatalog())).toEqual(before)
  })
})

test('confirmation keeps the target on failure and prevents duplicate execution while running @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    await app.evaluate(({ ipcMain }) => {
      let calls = 0
      ipcMain.removeHandler('knowbook:delete-document')
      ipcMain.handle('knowbook:delete-document', async () => {
        calls++
        if (calls === 1) {
          await new Promise<void>((resolve) => ipcMain.once('knowbook:test-release-delete', () => resolve()))
          throw new Error('Controlled deletion failure')
        }
      })
      ipcMain.on('knowbook:test-delete-calls', (_event, reply: (count: number) => void) => reply(calls))
    })
    const calls = () => app.evaluate(({ ipcMain }) => new Promise<number>((resolve) => ipcMain.emit('knowbook:test-delete-calls', null, resolve)))
    const dialog = await openDelete(page)
    await dialog.getByRole('button', { name: uiText('Delete document', '删除文档') }).click()
    await expect(dialog).toHaveAttribute('aria-busy', 'true')
    await expect(dialog.getByRole('button', { name: uiText('Cancel', '取消') })).toBeDisabled()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    expect(await calls()).toBe(1)
    await app.evaluate(({ ipcMain }) => { ipcMain.emit('knowbook:test-release-delete') })
    await expect(dialog.getByRole('alert')).toContainText('Controlled deletion failure')
    await expect(dialog).toHaveAttribute('aria-busy', 'false')
    // The newer pending keyboard activity owns focus; a failure must not move it to Cancel.
    await expect(dialog).toBeFocused()
    await expect(dialog.getByRole('button', { name: uiText('Cancel', '取消') })).toBeEnabled()
    await dialog.getByRole('button', { name: uiText('Retry', '重试') }).click()
    await expect(dialog).toHaveCount(0)
    expect(await calls()).toBe(2)
  })
})
