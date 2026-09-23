import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withElectronApp, uiText } from './helpers/electron'

test('Wiki aliases, sections, image embeds and legacy blocks work through editing, move, reload and file export @electron', async () => {
  test.setTimeout(180_000)
  await withElectronApp(async ({ app, page, tempRoot }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const input = join(tempRoot, 'wiki-input'), output = join(tempRoot, 'export', '入口.md')
    mkdirSync(join(input, '指南'), { recursive: true }); mkdirSync(join(input, '附件'))
    writeFileSync(join(input, '附件', '中文 图.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7isAAAAASUVORK5CYII=', 'base64'))
    writeFileSync(join(input, '入口.md'), '# 入口\n\n[[指南/目标|别名总览]] [[目标.md#安装 指南|章节入口]]\n\n![[中文 图.png|图片说明]]\n\n| 链接 |\n| --- |\n| [[指南/目标#安装 指南\\|表格章节]] |\n\n`![[code.png]]`')
    writeFileSync(join(input, '指南', '目标.md'), '# 目标\n\n[[#安装 指南|本页章节]]\n\n# 概览\n\n'
      + Array.from({ length: 12 }, (_, index) => `开篇 ${index}`).join('\n\n') + '\n\n## 安装 指南\n\n旧块正文\n\n'
      + Array.from({ length: 16 }, (_, index) => `后续 ${index}`).join('\n\n'))
    await app.evaluate(({ dialog }, { input, output }) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [input] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: output })) as typeof dialog.showSaveDialog
    }, { input, output })
    const report = await page.evaluate(() => window.knowbook.restoreBackupFromFolder())
    expect(report!.importReport!.issueCount).toBe(0)
    const ids = await page.evaluate(async () => {
      const home = await window.knowbook.getHomeData()
      const entry = home.documentCatalog.find((document) => document.path === '入口')!.id
      const target = home.documentCatalog.find((document) => document.path === '指南/目标')!.id
      const detail = (await window.knowbook.getDocumentDetail(target))!
      const block = detail.blocks.find((block) => block.content === '旧块正文')!.id
      const source = (await window.knowbook.getDocumentDetail(entry))!
      await window.knowbook.updateDocument(entry, { ...source, blocks: [...source.blocks, { type: 'paragraph', content: `[[指南/目标#${block}|旧块引用]]`, checked: false, depth: 0 }] })
      const archive = (await window.knowbook.createDocument(null)).id
      await window.knowbook.updateDocument(archive, { title: '归档', summary: '', blocks: [] })
      return { entry, target, block, archive }
    })
    rmSync(input, { recursive: true, force: true })
    await page.reload()
    const openEntry = async () => {
      await page.locator('.tree-button', { hasText: '入口' }).first().click()
      await expect(page.locator('.document-header-title')).toHaveText('入口')
    }
    await openEntry()
    await page.locator('.markdown-advanced-preview').getByRole('button', { name: '别名总览', exact: true }).click()
    await expect(page.locator('.document-header-title')).toHaveText('目标')
    await openEntry()
    await page.locator('.document-view-toggle').click()
    await expect.poll(() => page.locator('img.markdown-inline-image[alt="图片说明"]').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1)
    await page.locator('table').getByRole('button', { name: '表格章节', exact: true }).click()
    await expect(page.locator('.document-reading-row.type-heading-2')).toBeInViewport()
    await page.locator('.document-reading-row.type-heading-1 .reading-collapse').click()
    await expect(page.locator('.document-reading-row.type-heading-2')).toHaveCount(0)
    await page.getByRole('button', { name: '本页章节', exact: true }).click()
    await expect(page.locator('.document-reading-row.type-heading-2')).toBeInViewport()
    await openEntry()
    await page.getByRole('button', { name: '旧块引用', exact: true }).click()
    await expect(page.locator(`[data-block-id="${ids.block}"]`)).toBeInViewport()
    await page.locator('.document-view-toggle').click()
    await page.locator('textarea.type-heading-2').fill('新版 指南')
    await page.locator('.document-header-save-button').click()
    await page.locator('.document-summary-edit-button').click()
    await page.locator('.document-summary-card .editor-input').fill('新目标')
    await page.locator('.document-header-save-button').click()
    await expect(page.locator('.document-header-title')).toHaveText('新目标')
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-menu-select').selectOption(ids.archive)
    await page.locator('.document-header-menu-move-button').click()
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), ids.target))!.path).toBe('归档/新目标')
    const source = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), ids.entry))!
    expect(source.blocks.some((block) => block.content.includes('[[归档/新目标#新版-指南|章节入口]]'))).toBe(true)
    expect(source.blocks.some((block) => block.content.includes(`[[归档/新目标#${ids.block}|旧块引用]]`))).toBe(true)
    expect(source.outgoingLinks.some((link) => link.id === ids.target)).toBe(true)
    expect((await page.evaluate((id) => window.knowbook.checkDocumentLinks(id), ids.entry)).issues).toEqual([])
    await page.reload(); await openEntry()
    await page.locator('.document-view-toggle').click()
    await page.getByRole('button', { name: '章节入口', exact: true }).click()
    await expect(page.locator('.document-reading-row.type-heading-2')).toContainText('新版 指南')
    await expect(page.locator('.document-reading-row.type-heading-2')).toBeInViewport()
    await openEntry()
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
    await expect.poll(() => { try { return readFileSync(output, 'utf8') } catch { return '' } }).toContain('.assets/')
    expect(readFileSync(output, 'utf8')).toContain('|图片说明]]')
    expect(readFileSync(output, 'utf8')).not.toContain('file:///')
    mkdirSync('test-results', { recursive: true })
    await page.screenshot({ path: 'test-results/markdown-wiki.png', fullPage: true })
    expect(errors).toEqual([])
    writeFileSync('test-results/markdown-wiki.json', JSON.stringify({ aliases: true, sections: true, table: true, images: true, legacyBlocks: true, renameMove: true, reload: true, export: true, errors }, null, 2))
  })
})
