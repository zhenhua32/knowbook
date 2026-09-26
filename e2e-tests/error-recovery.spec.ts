import { expect, test } from '@playwright/test'
import { encodeDocumentIndexEntry } from '../src/shared/document-catalog-payload'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

test('workspace load failure has diagnostics and retry recovers without restarting @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    const home = await page.evaluate(() => window.knowbook.getHomeData())
    const payload = { ...home, documentCatalog: home.documentCatalog.map(encodeDocumentIndexEntry) }
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', () => { throw new Error('Recovery test: workspace temporarily unavailable') })
    })
    await page.reload()
    const recovery = page.locator('.content .recovery-state')
    await expect(recovery.getByRole('heading')).toHaveText(uiText('Unable to open the workspace', '无法打开工作区'))
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.sidebar-empty-state')).toHaveText(uiText('Document list could not be loaded', '文档列表加载失败'))
    await expect(page.locator('.sidebar-create-button')).toBeDisabled()
    await recovery.locator('summary').click()
    await expect(recovery.locator('pre')).toContainText('workspace temporarily unavailable')
    page.once('dialog', (dialog) => { void dialog.dismiss() })
    await recovery.getByRole('button', { name: uiText('Reload interface', '重新加载界面') }).click()
    await expect(recovery).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('workspace-load-error.png') })
    await app.evaluate(({ ipcMain }, serialized) => {
      const payload = JSON.parse(serialized)
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', () => payload)
    }, JSON.stringify(payload))
    await recovery.getByRole('button', { name: uiText('Retry', '重试') }).click()
    await expect(recovery).toHaveCount(0)
    await expect(page.locator('.document-summary-card')).toBeVisible()
    await expect(page.locator('.sidebar-create-button')).toBeEnabled()
  })
})

test('workspace refresh failure preserves the editor and its draft through retry @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    const home = await page.evaluate(() => window.knowbook.getHomeData())
    const payload = { ...home, documentCatalog: home.documentCatalog.map(encodeDocumentIndexEntry) }
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', () => { throw new Error('Recovery test: refresh unavailable') })
      ipcMain.removeHandler('knowbook:update-document')
      ipcMain.handle('knowbook:update-document', () => { throw new Error('Recovery test: retain unsaved edits') })
    })
    await ensureDocumentMetadataEditor(page)
    const title = page.locator('.document-summary-card .editor-input').first()
    await title.fill('Draft survives a failed refresh')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send('knowbook:workspace-mutated') })
    const recovery = page.locator('.content > .recovery-state')
    await expect(recovery.getByRole('heading')).toHaveText(uiText('Workspace refresh failed', '工作区刷新失败'))
    await expect(title).toHaveValue('Draft survives a failed refresh')
    await app.evaluate(({ ipcMain }, serialized) => {
      const payload = JSON.parse(serialized)
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', () => payload)
    }, JSON.stringify(payload))
    await recovery.getByRole('button', { name: uiText('Retry', '重试') }).click()
    await expect(recovery).toHaveCount(0)
    await expect(title).toHaveValue('Draft survives a failed refresh')
  })
})

test('document load errors and missing documents have an actionable retry @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    const home = await page.evaluate(() => window.knowbook.getHomeData())
    const detail = await page.evaluate((id) => window.knowbook.getDocumentDetail(id), home.initialDocumentId!)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:get-document-detail')
      ipcMain.handle('knowbook:get-document-detail', () => { throw new Error('Recovery test: document read failed') })
    })
    await page.reload()
    const recovery = page.locator('.page-documents .recovery-state')
    await expect(recovery.getByRole('heading')).toHaveText(uiText('Unable to load document', '无法加载文档'))
    await expect(page.locator('.document-summary-card')).toHaveCount(0)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:get-document-detail')
      ipcMain.handle('knowbook:get-document-detail', () => null)
    })
    await recovery.getByRole('button', { name: uiText('Retry', '重试') }).click()
    await expect(recovery.getByRole('heading')).toHaveText(uiText('Document not found', '文档不存在'))
    await app.evaluate(({ ipcMain }, detail) => {
      ipcMain.removeHandler('knowbook:get-document-detail')
      ipcMain.handle('knowbook:get-document-detail', () => detail)
    }, detail)
    await recovery.getByRole('button', { name: uiText('Retry', '重试') }).click()
    await expect(recovery).toHaveCount(0)
    await expect(page.locator('.document-summary-card')).toContainText(detail!.title)
  })
})

test('search failure preserves the query and is not presented as an empty result @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ app, page }) => {
    const results = await page.evaluate(() => window.knowbook.searchDocuments('Home'))
    expect(results.length).toBeGreaterThan(0)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:search-documents')
      ipcMain.handle('knowbook:search-documents', () => { throw new Error('Recovery test: search unavailable') })
    })
    await page.keyboard.press('Control+k')
    const search = page.locator('.global-search-modal')
    await search.locator('input').fill('Home')
    await expect(search.getByRole('heading')).toHaveText(uiText('Search is unavailable', '搜索暂时不可用'))
    await expect(search.locator('.mini-hint')).toHaveCount(0)
    await expect(search.locator('input')).toHaveValue('Home')
    await page.screenshot({ path: testInfo.outputPath('search-error.png') })
    await app.evaluate(({ ipcMain }, results) => {
      ipcMain.removeHandler('knowbook:search-documents')
      ipcMain.handle('knowbook:search-documents', () => results)
    }, results)
    await search.getByRole('button', { name: uiText('Retry', '重试') }).click()
    await expect(search.locator('.recovery-state')).toHaveCount(0)
    await expect(search.locator('.global-search-result')).toHaveCount(results.length)
  })
})

test('database failures recover and an empty catalog finishes loading @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:get-database-entities')
      ipcMain.handle('knowbook:get-database-entities', () => { throw new Error('Recovery test: database read failed') })
    })
    await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
    const recovery = page.locator('.page-database .recovery-state')
    await expect(recovery.getByRole('heading')).toHaveText(uiText('Unable to load database', '数据库加载失败'))
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:get-database-entities')
      ipcMain.handle('knowbook:get-database-entities', () => [])
      ipcMain.removeHandler('knowbook:get-document-catalog-page')
      ipcMain.handle('knowbook:get-document-catalog-page', () => ({ entries: [], total: 0, nextOffset: null }))
    })
    await recovery.getByRole('button', { name: uiText('Retry', '重试') }).click()
    await expect(recovery).toHaveCount(0)
    await expect(page.locator('[data-testid="database-grid"]')).toBeVisible()
    await expect(page.locator('.dbw-loading')).toHaveCount(0)
  })
})

test('page render failure leaves navigation and unsaved editor state available @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ app, page }) => {
    const home = await page.evaluate(() => window.knowbook.getHomeData())
    const payload = { ...home, documentCatalog: home.documentCatalog.map(encodeDocumentIndexEntry), recentEvents: [null] }
    await app.evaluate(({ ipcMain }, serialized) => {
      const payload = JSON.parse(serialized)
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', () => payload)
      ipcMain.removeHandler('knowbook:update-document')
      ipcMain.handle('knowbook:update-document', () => { throw new Error('Recovery test: retain the unsaved draft') })
    }, JSON.stringify(payload))
    await ensureDocumentMetadataEditor(page)
    await page.locator('.document-summary-card .editor-input').first().fill('Unsaved recovery draft')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send('knowbook:workspace-mutated') })
    await page.getByTitle(uiText('Dashboard', '总览'), { exact: true }).click()
    const recovery = page.locator('.shell > .recovery-state')
    await expect(recovery.getByRole('heading')).toHaveText(uiText('Something went wrong on this page', '页面出现异常'))
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('page-render-error.png') })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.setViewportSize({ width: 760, height: 640 })
    await recovery.locator('summary').click()
    expect(await recovery.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('page-render-error-dark.png') })
    await recovery.getByRole('button', { name: uiText('Go to documents', '返回文档') }).click()
    await ensureDocumentMetadataEditor(page)
    await expect(page.locator('.document-summary-card .editor-input').first()).toHaveValue('Unsaved recovery draft')
  })
})

test('root render failure exposes recovery controls instead of a blank window @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    const home = await page.evaluate(() => window.knowbook.getHomeData())
    const payload = { ...home, documentCatalog: home.documentCatalog.map(encodeDocumentIndexEntry) }
    await app.evaluate(({ ipcMain }, serialized) => {
      const payload = JSON.parse(serialized)
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', () => ({ ...payload, aiConfig: null }))
    }, JSON.stringify(payload))
    await page.reload()
    const recovery = page.locator('#root > .recovery-state')
    await expect(recovery.getByRole('heading')).toHaveText(uiText('Something went wrong on this page', '页面出现异常'))
    await expect(recovery.getByRole('button', { name: uiText('Restart in safe mode', '安全模式重启') })).toBeVisible()
    await app.evaluate(({ ipcMain }, serialized) => {
      const payload = JSON.parse(serialized)
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', () => payload)
    }, JSON.stringify(payload))
    await recovery.getByRole('button', { name: uiText('Retry', '重试') }).click()
    await expect(page.locator('.document-summary-card')).toBeVisible()
    await expect(recovery).toHaveCount(0)
  })
})
