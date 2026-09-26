import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withElectronApp, uiText } from './helpers/electron'

test('relative images and cross-document headings work after import, reload, folding and file export @electron', async () => {
  test.setTimeout(120_000)
  await withElectronApp(async ({ app, page, tempRoot }) => {
    const input = join(tempRoot, 'markdown-input')
    mkdirSync(join(input, '章节'), { recursive: true })
    mkdirSync(join(input, 'images'))
    writeFileSync(join(input, 'images', '中文 图.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7isAAAAASUVORK5CYII=', 'base64'))
    writeFileSync(join(input, '入口.md'), '# 入口\n\n![本地图片](<images/中文 图.png>)\n\n[前往第二个安装](章节/下一章.md#安装-1)\n\n| 链接 |\n| --- |\n| [表格里的跳转](章节/下一章.md#安装-1) |\n\n[失效](不存在.md)')
    writeFileSync(join(input, '章节', '下一章.md'), '# 下一章\n\n[本页跳转](#安装-1) [引用锚点](#子节)\n\n# 概览\n\n## 安装\n\n第一次安装\n\n'
      + Array.from({ length: 18 }, (_, index) => `填充段落 ${index}：用于验证页面确实滚动到对应章节。`).join('\n\n')
      + '\n\n## 安装\n\n第二次安装\n\n[顶部](#下一章)\n\n[返回入口](../入口.md#入口)\n\n'
      + Array.from({ length: 15 }, (_, index) => `后续内容 ${index}`).join('\n\n')
      + '\n\n> 引用介绍\n>\n> ## 子节\n>\n> 子节内容\n\n结尾正文')
    const output = join(tempRoot, '入口.md')
    await app.evaluate(({ dialog }, { input, output }) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [input] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: output })) as typeof dialog.showSaveDialog
    }, { input, output })
    const restored = await page.evaluate(() => window.knowbook.restoreBackupFromFolder())
    expect(restored?.restored).toBe(2)
    rmSync(input, { recursive: true, force: true })
    await page.reload()
    await page.locator('.tree-button', { hasText: '入口' }).first().click()
    const image = page.locator('.block-rich-media-image').first()
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1)
    // Editing preview cards use the same navigation as reading and table cells.
    await page.locator('.block-rich-media-link', { hasText: '前往第二个安装' }).click()
    await expect(page.locator('.document-header-title')).toHaveText('下一章')
    await page.locator('.document-view-toggle').click()
    const headings = page.locator('.document-reading-row.type-heading-2')
    await expect(headings).toHaveCount(2)
    await page.locator('.document-reading-row.type-heading-1 .reading-collapse').click()
    await expect(headings).toHaveCount(0)
    await page.locator('.document-reading-content .inline-link', { hasText: '本页跳转' }).click()
    await expect(headings).toHaveCount(2)
    await expect(headings.nth(1)).toBeInViewport()
    await expect(headings.first()).not.toBeInViewport()
    await page.locator('.document-reading-content .inline-link', { hasText: '顶部' }).click()
    await expect(page.locator('.document-reading-summary')).toBeInViewport()
    await page.locator('.document-reading-content .inline-link', { hasText: '引用锚点' }).click()
    await expect(page.locator('.document-reading-row.type-quote h2')).toBeInViewport()
    await page.locator('.document-reading-content .inline-link', { hasText: '返回入口' }).click()
    await expect(page.locator('.document-reading-summary h1')).toHaveText('入口')
    await expect.poll(() => page.locator('.block-rich-media-image').first().evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1)
    await page.locator('table .inline-link', { hasText: '表格里的跳转' }).click()
    await expect(headings.nth(1)).toBeInViewport()
    await page.locator('.document-reading-content .inline-link', { hasText: '返回入口' }).click()
    await page.locator('.document-reading-content .inline-link', { hasText: '失效' }).click()
    await expect(page.locator('.app-notifications')).toContainText(/找不到链接目标|Link target not found/)
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
    await expect.poll(() => { try { return readFileSync(output, 'utf8') } catch { return '' } }).toContain('.assets/')
    expect(readFileSync(output, 'utf8')).not.toContain('file:///')
    await page.screenshot({ path: 'test-results/markdown-links.png' })
  })
})
