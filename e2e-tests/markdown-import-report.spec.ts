import { expect, test } from '@playwright/test'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { withElectronApp, uiText } from './helpers/electron'

test('import report lists successful files, filters issues, locates saved blocks and survives cancellation @electron', async () => {
  test.setTimeout(120_000)
  await withElectronApp(async ({ app, page, tempRoot }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const input = join(tempRoot, 'migration-input')
    cpSync(resolve('tests/fixtures/markdown-real-documents/vault/input'), input, { recursive: true })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [input] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, input)
    await page.locator('button.nav-icon-btn').and(page.getByTitle(uiText('Dashboard', '总览'))).click()
    await page.getByRole('button', { name: uiText('Import Markdown / restore backup', '导入 Markdown / 恢复备份'), exact: true }).click()
    const report = page.getByRole('dialog', { name: uiText('Markdown import report', 'Markdown 导入报告') })
    await expect(report).toBeVisible()
    await expect(report.getByRole('status')).toContainText(/2/)
    await expect(report.getByRole('status')).toContainText(/8/)
    await expect(report.locator('summary')).toHaveCount(2)
    await report.getByRole('checkbox').check()
    await expect(report.locator('summary')).toHaveCount(1)
    await report.getByRole('searchbox').fill('不存在')
    await expect(report.locator('summary')).toHaveCount(0)
    await report.getByRole('searchbox').fill('项目')
    await report.locator('summary').click()
    await expect(report.getByRole('button', { name: /Attachment missing|找不到附件/ })).toBeVisible()
    await expect(report.getByRole('button', { name: /HTML is not fully supported|HTML 未完整支持/ })).toBeVisible()
    await expect(report.getByRole('button', { name: /example.*iframe/ })).toHaveCount(0)
    mkdirSync('test-results', { recursive: true })
    await page.screenshot({ path: 'test-results/markdown-import-report.png', fullPage: true })
    await report.getByRole('button', { name: /HTML is not fully supported|HTML 未完整支持/ }).click()
    await expect(report).toHaveCount(0)
    await expect(page.locator('.document-header-title')).toHaveText('项目说明')
    await expect.poll(async () => page.locator('textarea.block-inline-textarea:focus').inputValue().catch(() => '')).toContain('<div align="center">')
    const catalog = await page.evaluate(() => window.knowbook.getHomeData())
    const id = catalog.documentCatalog.find((document) => document.path === '项目说明')!.id
    const detail = await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id)
    expect(detail!.blocks.some((block) => block.type === 'code' && block.content.includes('__knowbook/assets/does-not-exist.png'))).toBe(true)
    await page.getByRole('button', { name: uiText('View latest import report', '查看最近导入报告') }).click()
    await expect(report).toBeVisible()
    await report.press('Escape')
    await expect(report).toHaveCount(0)
    await expect(page.getByRole('button', { name: uiText('View latest import report', '查看最近导入报告') })).toBeFocused()
    await page.locator('button.nav-icon-btn').and(page.getByTitle(uiText('Dashboard', '总览'))).click()
    await page.getByRole('button', { name: uiText('Import Markdown / restore backup', '导入 Markdown / 恢复备份'), exact: true }).click()
    await expect(report).toBeVisible()
    await expect(report.locator('summary').first()).toContainText(/Updated|已更新/)
    await report.press('Escape')
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => {
        process.env.KNOWBOOK_TEST_IMPORT_CANCELED = '1'
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    const beforeCancel = await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id)
    writeFileSync(join(input, '项目说明.md'), '# 项目说明\n\nThis should not be imported.\n')
    await page.getByRole('button', { name: uiText('Import Markdown / restore backup', '导入 Markdown / 恢复备份'), exact: true }).click()
    await expect.poll(() => app.evaluate(() => process.env.KNOWBOOK_TEST_IMPORT_CANCELED)).toBe('1')
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))!.updatedAt).toBe(beforeCancel!.updatedAt)
    await page.getByRole('button', { name: uiText('View latest import report', '查看最近导入报告') }).click()
    await expect(report.getByRole('status')).toContainText(/8/)
    expect(errors).toEqual([])
    writeFileSync('test-results/markdown-import-report.json', JSON.stringify({ importedFiles: 2, expectedIssues: 8, filtering: true, blockNavigation: true, reopen: true, cancellation: true, errors }, null, 2))
  })
})
