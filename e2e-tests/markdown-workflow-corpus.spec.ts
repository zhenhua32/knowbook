import { expect, test } from '@playwright/test'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { withElectronApp, uiText } from './helpers/electron'
import { expectSource, selectSource, sourceValue } from './helpers/markdown-source'

test('shared Markdown workflow corpus preserves edits, rendering, links and file round trips @electron', async () => {
  test.setTimeout(180_000)
  await withElectronApp(async ({ app, page, tempRoot }) => {
    const fixture = resolve('tests/fixtures/markdown-workflows')
    const input = join(tempRoot, 'workflow-input'), output = join(tempRoot, 'workflow-output')
    cpSync(fixture, input, { recursive: true }); mkdirSync(output)
    let exportPath = join(output, 'Acceptance.md')
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [input] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, input)
    expect((await page.evaluate(() => window.knowbook.restoreBackupFromFolder()))?.restored).toBe(2)
    await page.reload()
    const open = async (title: string) => page.locator('.tree-button', { hasText: title }).first().click()
    await open('Acceptance')
    const initial = await page.evaluate(async () => {
      const home = await window.knowbook.getHomeData()
      const entry = home.documentTree.find(doc => doc.title === 'Acceptance')!
      return (await window.knowbook.getDocumentDetail(entry.id))!
    })
    const detail = () => page.evaluate(id => window.knowbook.getDocumentDetail(id), initial.id)
    const paragraphs = page.locator('textarea.type-paragraph')
    const index = await paragraphs.evaluateAll(inputs => inputs.findIndex(input => (input as HTMLTextAreaElement).value.startsWith('First editable')))
    expect(index).toBeGreaterThanOrEqual(0)
    const paragraph = paragraphs.nth(index), originalParagraph = await paragraph.inputValue()
    await paragraph.focus()
    await paragraph.evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(6, (input as HTMLTextAreaElement).value.length))
    await paragraph.press('Control+b')
    const formatted = `First **${originalParagraph.slice(6)}**`
    await expect(paragraph).toHaveValue(formatted)
    await paragraph.press('Control+z'); await expect(paragraph).toHaveValue(originalParagraph)
    await paragraph.press('Control+Shift+Z'); await expect(paragraph).toHaveValue(formatted)
    await paragraph.press('Control+z'); await expect(paragraph).toHaveValue(originalParagraph)
    await page.locator('.document-header-more-button').click()
    await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    const sourceEditor = page.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码') })
    const originalSource = await sourceValue(sourceEditor)
    await selectSource(sourceEditor, originalSource.indexOf('First editable') + 6, originalSource.indexOf('Second editable') + 6)
    await sourceEditor.press('Control+b')
    const formattedSource = originalSource.replace(originalParagraph, formatted).replace('Second editable', '**Second** editable')
    await expectSource(sourceEditor, formattedSource)
    await sourceEditor.press('Control+z'); await expectSource(sourceEditor, originalSource)
    await sourceEditor.press('Control+Shift+Z'); await expectSource(sourceEditor, formattedSource)
    await page.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true }).click()
    await expect(sourceEditor).toHaveCount(0)
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await detail())?.blocks.find(block => block.content.startsWith('First '))?.content).toBe(formatted)
    expect((await detail())!.blocks.map(block => block.id)).toEqual(initial.blocks.map(block => block.id))

    const grid = page.getByRole('grid', { name: uiText('Editable table', '可编辑表格') })
    const cell = grid.locator('[data-row="1"][data-column="0"]')
    await cell.click(); await expect(grid.locator('textarea')).toHaveValue('a|b')
    await grid.locator('textarea').fill('a|b edited 中文')
    await grid.locator('textarea').press('Escape')
    await expect(cell).toHaveText('a|b edited 中文')
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await detail())?.blocks.some(block => block.content.includes('a\\|b edited 中文'))).toBe(true)
    await page.reload(); await open('Acceptance')
    await expect(paragraph).toHaveValue(formatted)
    await page.locator('.document-view-toggle').click()
    const table = page.locator('.document-reading-row.type-table table')
    await expect(table.locator('tr')).toHaveCount(3)
    await expect(table.locator('tbody tr').first().locator('td').nth(2)).toHaveText('c|d')
    await expect(table.locator('thead th').nth(1)).toHaveCSS('text-align', 'center')
    await expect(page.locator('.markdown-footnotes > ol > li')).toHaveCount(1)
    await expect(page.locator('.markdown-footnote-backref')).toHaveCount(2)
    await expect(page.locator('.katex')).toHaveCount(2)
    await expect(page.locator('[data-callout="tip"]')).toContainText('Body with formatting.')
    await expect(page.locator('.document-reading-content mark')).toHaveText('highlight')
    await expect.poll(() => page.locator('.markdown-mermaid img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => page.locator('img[alt="local image"]').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(64)
    const todo = page.locator('.document-reading-row.type-todo').filter({ hasText: 'Pending task' }).getByRole('checkbox')
    await todo.check()
    await expect.poll(async () => (await detail())?.blocks.find(block => block.content === 'Pending task')?.checked).toBe(true)
    const beforeRename = (await detail())!
    await open('Target')
    await page.locator('.document-view-toggle').click()
    await page.locator('.document-summary-edit-button').click()
    await page.locator('.document-summary-card .editor-input').fill('Renamed')
    await page.locator('.document-header-save-button').click()
    await expect(page.locator('.document-header-title')).toHaveText('Renamed')
    await expect.poll(async () => (await detail())?.blocks.some(block => block.content.includes('[target](Renamed.md#destination)'))).toBe(true)
    const afterRename = (await detail())!
    expect(afterRename.blocks.find(block => block.type === 'code' && block.content.includes('literal'))?.content)
      .toBe(beforeRename.blocks.find(block => block.type === 'code' && block.content.includes('literal'))?.content)
    expect((await page.evaluate(id => window.knowbook.checkDocumentLinks(id), initial.id)).issues).toEqual([])

    const saveMarkdown = async (title: string) => {
      exportPath = join(output, `${title}.md`)
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      }, exportPath)
      await open(title)
      await page.locator('.document-header-more-button').click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
      await expect.poll(() => { try { return readFileSync(exportPath, 'utf8') } catch { return '' } }).toContain(`# ${title}`)
    }
    await saveMarkdown('Renamed'); await saveMarkdown('Acceptance')
    const exported = readFileSync(exportPath, 'utf8')
    expect(exported).toContain(formatted)
    expect(exported).toContain('a\\|b edited 中文')
    expect(exported).toContain('[[Renamed]]')
    expect(exported).toContain('[^note]:')
    expect(exported).not.toContain('file:///')
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as typeof dialog.showOpenDialog
    }, output)
    for (let round = 0; round < 3; round++) {
      expect((await page.evaluate(() => window.knowbook.restoreBackupFromFolder()))?.restored).toBe(2)
      await page.reload(); await open('Acceptance')
      expect((await page.evaluate(id => window.knowbook.checkDocumentLinks(id), initial.id)).issues).toEqual([])
      await saveMarkdown('Acceptance')
      expect(readFileSync(exportPath, 'utf8')).toBe(exported)
    }
    const report = {
      testedAt: new Date().toISOString(), inputSha256: createHash('sha256').update(readFileSync(join(fixture, 'Acceptance.md'))).digest('hex'),
      formattingScope: 'partial text selection across two independent paragraphs in the full Markdown source editor',
      undo: true, redo: true, reload: true, tableCodePipe: 'c|d', tableEdit: true,
      task: true, footnotes: 1, math: 2, mermaid: true, localImageWidth: 64,
      renameLinks: true, codeLiteralPreserved: true, exportCycles: 3, exportStable: true, exportedMarkdown: exported
    }
    mkdirSync('test-results', { recursive: true })
    writeFileSync('test-results/markdown-workflow-knowbook.json', JSON.stringify(report, null, 2))
    await page.screenshot({ path: 'test-results/markdown-workflow-knowbook.png' })
  })
})
