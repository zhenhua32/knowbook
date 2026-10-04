import { expect, test } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { uiText, withElectronApp } from './helpers/electron'

test('Trash previews, restores, and permanently deletes documents through the UI @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page }) => {
    const id = await page.evaluate(async () => {
      const { id: documentId } = await window.knowbook.createDocument(null)
      const document = await window.knowbook.getDocumentDetail(documentId)
      await window.knowbook.updateDocument(documentId, { ...document!, title: 'Recovery trash example', summary: 'Preserved summary' })
      await window.knowbook.deleteDocument(documentId)
      return documentId
    })
    await page.getByRole('button', { name: uiText('Trash', '回收站'), exact: true }).click()
    const dialog = page.locator('.data-recovery-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.recovery-preview')).toContainText('Preserved summary')
    await page.keyboard.press('Control+k')
    await expect(page.locator('.global-search-modal')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('trash-preview.png') })
    await dialog.getByRole('button', { name: uiText('Restore selected version', '恢复所选版本') }).click()
    await page.locator('.app-confirm-dialog').getByRole('button', { name: uiText('Restore document', '恢复文档'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.document-summary-card')).toContainText('Recovery trash example')
    expect(await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id)).toMatchObject({ id, summary: 'Preserved summary' })
    await page.getByRole('button', { name: uiText('More actions', '更多操作') }).click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Delete', '删除'), exact: true }).click()
    await page.locator('.app-confirm-dialog').getByRole('button', { name: uiText('Delete document', '删除文档') }).click()
    await expect(page.locator('.app-confirm-dialog')).toHaveCount(0)
    await page.getByRole('button', { name: uiText('Trash', '回收站'), exact: true }).click()
    await expect(dialog.locator('.recovery-preview')).toContainText('Preserved summary')
    await dialog.getByRole('button', { name: uiText('Delete permanently', '永久删除') }).click()
    await page.locator('.app-confirm-dialog').getByRole('button', { name: uiText('Cancel', '取消') }).click()
    expect((await page.evaluate(() => window.knowbook.listTrashedDocuments())).length).toBe(1)
    await dialog.getByRole('button', { name: uiText('Delete permanently', '永久删除') }).click()
    await page.locator('.app-confirm-dialog').getByRole('button', { name: uiText('Delete permanently', '永久删除') }).click()
    await expect(dialog).toContainText(/No records yet|暂无记录/)
    expect(await page.evaluate((id) => window.knowbook.listDocumentHistory(id), id)).toEqual([])
  })
})

test('history compares versions and restoring can itself be undone after autosave @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page }) => {
    const id = await page.evaluate(async () => {
      const { id: documentId } = await window.knowbook.createDocument(null)
      const document = (await window.knowbook.getDocumentDetail(documentId))!
      await window.knowbook.updateDocument(documentId, { ...document, title: 'Recovery history example',
        blocks: [{ ...document.blocks[0], type: 'paragraph', content: 'Latest text preserved before restore' }] })
      return documentId
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Recovery history example' }).click()
    const openHistory = async () => {
      await page.getByRole('button', { name: uiText('More actions', '更多操作') }).click()
      await page.getByRole('button', { name: uiText('Document history', '文档历史'), exact: true }).click()
      return page.locator('.data-recovery-dialog')
    }
    let dialog = await openHistory()
    await expect(dialog.locator('.recovery-comparison article').first()).toContainText('Start writing here.')
    await expect(dialog.locator('.recovery-comparison article').last()).toContainText('Latest text preserved before restore')
    await page.screenshot({ path: testInfo.outputPath('history-comparison.png') })
    await page.setViewportSize({ width: 640, height: 740 })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('history-dark-narrow.png') })
    await dialog.getByRole('button', { name: uiText('Restore selected version', '恢复所选版本') }).click()
    await page.locator('.app-confirm-dialog').getByRole('button', { name: uiText('Restore document', '恢复文档'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks.some((block) => block.content === 'Start writing here.')).toBe(true)
    dialog = await openHistory()
    await expect(dialog.locator('.recovery-comparison article').first()).toContainText('Latest text preserved before restore')
    await dialog.getByRole('button', { name: uiText('Restore selected version', '恢复所选版本') }).click()
    await page.locator('.app-confirm-dialog').getByRole('button', { name: uiText('Restore document', '恢复文档'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.block-inline-textarea').first()).toHaveValue('Latest text preserved before restore')
  })
})

test('backup versions restore with native confirmation and preserve a safety copy @electron', async () => {
  await withElectronApp(async ({ app, page, tempRoot }) => {
    const id = await page.evaluate(async () => {
      const { id: documentId } = await window.knowbook.createDocument(null)
      const document = (await window.knowbook.getDocumentDetail(documentId))!
      await window.knowbook.updateDocument(documentId, { ...document, title: 'Backup restore example', summary: 'Earlier summary' })
      await window.knowbook.triggerBackup()
      await window.knowbook.updateDocument(documentId, { ...document, title: 'Backup restore example', summary: 'Later summary' })
      await window.knowbook.triggerBackup()
      return documentId
    })
    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await page.getByRole('tab', { name: uiText('Storage & recovery', '存储与恢复'), exact: true }).click()
    const storage = page.getByRole('tabpanel', { name: uiText('Storage & recovery', '存储与恢复'), exact: true })
    await storage.getByRole('button', { name: uiText('View backup versions', '查看备份版本'), exact: true }).click()
    const dialog = page.locator('.data-recovery-dialog')
    await expect(dialog.locator('aside li')).toHaveCount(3)
    await dialog.locator('aside li button').nth(1).click()
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await dialog.getByRole('button', { name: uiText('Restore selected backup', '恢复所选备份') }).click()
    await expect(dialog.getByRole('button', { name: uiText('Restore selected backup', '恢复所选备份') })).toBeEnabled()
    expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.summary).toBe('Later summary')
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await dialog.getByRole('button', { name: uiText('Restore selected backup', '恢复所选备份') }).click()
    await expect(dialog).toHaveCount(0)
    expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.summary).toBe('Earlier summary')
    const safetyCopies = readdirSync(join(tempRoot, 'backups', 'restore-safety'))
    expect(safetyCopies.some((file) => file.endsWith('.db'))).toBe(true)
  })
})
