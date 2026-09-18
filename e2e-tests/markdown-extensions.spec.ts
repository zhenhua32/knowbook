import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { withElectronApp, uiText } from './helpers/electron'
import { extensionMarkdown } from '../tests/fixtures/markdown-extensions'

test('GFM extensions remain editable and survive actual file export and import @electron', async () => {
  test.setTimeout(120_000)
  await withElectronApp(async ({ app, page, tempRoot }) => {
    const id = await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Extensions', summary: '', blocks: [
        { id: `${id}-body`, type: 'paragraph', content: '', checked: false, depth: 0 }
      ] })
      return id
    })
    const openDocument = async () => {
      await page.reload()
      await page.locator('.tree-button', { hasText: 'Extensions' }).first().click()
    }
    await openDocument()
    await page.locator('textarea.block-inline-textarea').first().evaluate((element, source) => {
      const input = element as HTMLTextAreaElement
      input.focus()
      const data = new DataTransfer()
      data.setData('text/plain', source)
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    }, extensionMarkdown)
    const task = page.locator('.block-editor-row').filter({ has: page.locator('textarea.type-numbered-todo') }).first()
    await expect(task.locator('.block-number-label')).toHaveText('3.')
    await expect(task.locator('input[type="checkbox"]')).toBeChecked()
    await task.locator('input[type="checkbox"]').uncheck()
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks.find((block) => block.type === 'numbered-todo')?.checked).toBe(false)
    const before = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))!.blocks
    await openDocument()
    await expect(task.locator('input[type="checkbox"]')).not.toBeChecked()
    await page.locator('.document-view-toggle').click()
    const table = page.locator('.document-reading-row.type-table .block-markdown-table').first()
    await expect(table.locator('th').nth(1)).toHaveCSS('text-align', 'center')
    await expect(table.locator('td code')).toHaveText('a|b')
    await expect(table.locator('td del')).toHaveText(['old', 'replaced'])
    await expect(page.locator('.document-reading-row.type-table').nth(1).locator('tbody')).toHaveCount(0)
    await expect(page.locator('.document-reading-row.type-numbered-todo .reading-list-marker')).toHaveText(['3.', '5.', '1.'])
    await expect(page.locator('.document-reading-row.type-quote input')).toHaveCount(1)
    await expect(page.locator('.document-reading-content del strong')).toHaveText('double')

    const directory = join(tempRoot, 'markdown-export')
    mkdirSync(directory)
    const filePath = join(directory, 'Extensions.md')
    await app.evaluate(({ dialog }, { directory, filePath }) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, { directory, filePath })
    const exportFile = async () => {
      rmSync(filePath, { force: true })
      await page.locator('.document-header-more-button').click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
      await expect.poll(() => { try { return readFileSync(filePath, 'utf8') } catch { return '' } }).toContain('3) [ ] Ship')
      return readFileSync(filePath, 'utf8')
    }
    const exported = await exportFile()
    expect(exported).toContain('~~old~~')
    expect(exported).toContain('~replaced~')
    expect(exported).toContain('a\\|b')
    const result = await page.evaluate(() => window.knowbook.restoreBackupFromFolder())
    expect(result?.restored).toBe(1)
    await openDocument()
    const after = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))!.blocks
    const content = (blocks: typeof after) => blocks.map(({ type, content, checked, depth, listStart, markdownFormat }) => ({ type, content, checked, depth, listStart, markdownFormat }))
    expect(content(after)).toEqual(content(before))
    expect(await exportFile()).toBe(exported)
    await page.screenshot({ path: 'test-results/markdown-extensions.png', fullPage: false })
  })
})

test('typed numbered tasks continue on Enter with unchecked state and contiguous numbers @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Task typing', summary: '', blocks: [
        { type: 'paragraph', content: '', checked: false, depth: 0 }
      ] })
      return id
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Task typing' }).first().click()
    const editor = page.locator('textarea.block-inline-textarea').first()
    await editor.pressSequentially('3. [x] Done')
    await expect(editor).toHaveClass(/type-numbered-todo/)
    await editor.press('Enter')
    const next = page.locator('textarea.block-inline-textarea').nth(1)
    await expect(next).toHaveClass(/type-numbered-todo/)
    await next.pressSequentially('Next')
    await expect(page.locator('.block-number-label')).toHaveText(['3.', '4.'])
    await expect(page.locator('.block-todo-checkbox').nth(1)).not.toBeChecked()
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks.map(({ type, checked }) => ({ type, checked }))).toEqual([
      { type: 'numbered-todo', checked: true }, { type: 'numbered-todo', checked: false }
    ])
  })
})
