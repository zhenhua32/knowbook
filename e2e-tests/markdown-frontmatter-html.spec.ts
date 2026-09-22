import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withElectronApp, uiText } from './helpers/electron'
import { expectSource, selectSource, sourceValue } from './helpers/markdown-source'
import { documentYaml, commonHtml } from '../tests/fixtures/markdown-frontmatter-html'

test('YAML and common HTML agree across paste, reading, source history, reload and file export @electron', async () => {
  test.setTimeout(120_000)
  await withElectronApp(async ({ app, page, tempRoot }) => {
    await page.route('https://example.test/image.png', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7isAAAAASUVORK5CYII=', 'base64') }))
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const id = await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'YAML HTML', summary: '', blocks: [{ type: 'paragraph', content: '', checked: false, depth: 0 }] })
      return id
    })
    await page.reload(); await page.locator('.tree-button', { hasText: 'YAML HTML' }).click()
    const source = documentYaml + '\n\n' + commonHtml.replace('assets/image.png', 'https://example.test/image.png')
    await page.locator('textarea.block-inline-textarea').first().evaluate((element, source) => {
      const input = element as HTMLTextAreaElement
      input.focus()
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', source)
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
    }, source)
    await expect(page.locator('textarea.type-frontmatter')).toHaveValue(documentYaml)
    await expect(page.locator('textarea.type-html')).toHaveCount(1)
    await expect(page.locator('.markdown-advanced-preview kbd')).toHaveCount(2)
    await page.locator('.document-header-save-button').click()
    const originalId = await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks[0].id, id)
    await page.locator('.document-view-toggle').click()
    const details = page.locator('.document-reading-row.type-html details').first()
    await expect(details).not.toHaveAttribute('open')
    await page.getByRole('button', { name: '转到锚点', exact: true }).click()
    await expect(details).toHaveAttribute('open')
    await expect(details.locator('[data-markdown-anchor="中文-anchor"]')).toBeAttached()
    await expect(details.locator('summary strong')).toHaveText('说明')
    await expect(details.locator('img')).toHaveAttribute('width', '240')
    await expect(details.locator('img')).toHaveAttribute('height', '120')
    await expect.poll(() => details.locator('img').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(details.locator('input[type=checkbox]')).toBeEnabled()
    await details.locator('input[type=checkbox]').uncheck()
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))!.blocks.find((block) => block.type === 'html')!.content).toContain('- [ ] 保留任务')
    await expect(page.locator('.markdown-frontmatter')).not.toHaveAttribute('open')
    await page.locator('.markdown-frontmatter summary').click()
    await expect(page.locator('.markdown-frontmatter pre')).toHaveText(documentYaml)
    await page.locator('.document-header-more-button').click()
    await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    const editor = page.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码') })
    const before = await sourceValue(editor), position = before.indexOf('Alice')
    await selectSource(editor, position, position + 5); await editor.press('Control+b'); await expectSource(editor, before)
    await page.keyboard.insertText('李华')
    await editor.press('Control+z'); await expectSource(editor, before)
    await editor.press('Control+Shift+Z'); await expectSource(editor, before.replace('Alice', '李华'))
    await editor.press('Control+s'); await expect(editor).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))!.blocks[0].content).toBe(documentYaml.replace('Alice', '李华'))
    expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))!.blocks[0].id).toBe(originalId)
    await page.reload(); await page.locator('.tree-button', { hasText: 'YAML HTML' }).click()
    const filePath = join(tempRoot, 'YAML HTML.md')
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, filePath)
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
    await expect.poll(() => { try { return readFileSync(filePath, 'utf8') } catch { return '' } }).toContain('# YAML HTML')
    const exported = readFileSync(filePath, 'utf8')
    expect(exported.startsWith(documentYaml.replace('Alice', '李华') + '\n\n# YAML HTML')).toBe(true)
    expect(exported).toContain('<a id="中文-anchor"></a>')
    expect(exported).toContain('width="240" height="120"')
    expect(exported).toContain('- [ ] 保留任务')
    expect(errors).toEqual([])
    await page.locator('.document-view-toggle').click()
    await page.locator('.document-reading-row.type-html summary').first().click()
    await expect(page.locator('.document-reading-row.type-html img')).toBeVisible()
    mkdirSync('test-results', { recursive: true })
    await page.screenshot({ path: 'test-results/markdown-source-interop.png', fullPage: true })
    writeFileSync('test-results/markdown-source-interop.json', JSON.stringify({ frontmatter: true, commonHtml: true, anchorNavigation: true, nestedTask: true, undoRedo: true, savedIdentity: true, fileExport: true, errors }, null, 2))
  })
})
