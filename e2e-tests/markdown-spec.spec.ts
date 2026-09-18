import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withElectronApp, uiText } from './helpers/electron'
import { markdownEngine } from '../src/shared/markdownEngine'
import { serializeBlocksToMarkdown } from '../src/shared/markdown'
import { canonicalMarkdownHtml } from '../tests/helpers/markdownSpec'

test('standard syntax retains structure after import, editing, reload and actual file export @electron', async () => {
  test.setTimeout(120_000)
  await withElectronApp(async ({ app, page, tempRoot }) => {
    const directory = join(tempRoot, 'spec-import')
    mkdirSync(directory)
    const source = [
      'Foo *bar', 'baz*', '===', '',
      '- compact one', '- compact two', '+ separate list', '',
      '## Loose list', '', '* loose one', '', '* loose two', '',
      '## Code', '', '>\t\tquoted code', '', '```', '```', '',
      '```JS title="Info"', 'console.log(1)', '```', '',
      '## Lazy continuation', '', '> foo', 'bar', '===', '',
      'www.google.com/search?q=(business))+ok', '',
      '## Tasks', '', '- [x] Parent', '  - [x] Child', '    - [x] Deep'
    ].join('\n')
    writeFileSync(join(directory, 'Spec fidelity.md'), source)
    const filePath = join(tempRoot, 'Spec fidelity.md')
    await app.evaluate(({ dialog }, { directory, filePath }) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as typeof dialog.showOpenDialog
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, { directory, filePath })
    const result = await page.evaluate(() => window.knowbook.restoreBackupFromFolder())
    expect(result?.restored).toBe(1)
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Spec fidelity' }).first().click()
    const id = await page.evaluate(async () => {
      const tree = await window.knowbook.getDocumentCatalog()
      return tree.find((d) => d.title === 'Spec fidelity')!.id
    })
    const before = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))!.blocks
    expect(canonicalMarkdownHtml(markdownEngine.render(serializeBlocksToMarkdown(before)))).toBe(canonicalMarkdownHtml(markdownEngine.render(source)))
    // Textareas expose their current content as a value, not child text.
    const firstList = page.locator('textarea.type-bulleted-list').first()
    await expect(firstList).toHaveValue('compact one')
    await firstList.fill('compact one edited')
    const expected = source.replace('compact one', 'compact one edited')
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks.find((b) => b.type === 'bulleted-list')?.content).toBe('compact one edited')
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Spec fidelity' }).first().click()
    await expect(firstList).toHaveValue('compact one edited')
    await page.locator('.document-view-toggle').click()
    await expect(page.locator('.document-reading-content h1 em')).toHaveText('bar\nbaz')
    await expect(page.locator('button.inline-link[title="http://www.google.com/search?q=(business))+ok"]')).toHaveText('www.google.com/search?q=(business))+ok')
    await expect(page.locator('.document-reading-row.type-quote').first().locator('pre code')).toHaveText('  quoted code\n')
    await expect(page.locator('.document-reading-row.type-quote').last()).toContainText('===')
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
    await expect.poll(() => { try { return readFileSync(filePath, 'utf8') } catch { return '' } }).toContain('compact one edited')
    const exported = readFileSync(filePath, 'utf8').replace(/^# Spec fidelity\r?\n\r?\n/, '')
    expect(canonicalMarkdownHtml(markdownEngine.render(exported))).toBe(canonicalMarkdownHtml(markdownEngine.render(expected)))
    expect(exported).toContain('- compact one edited\n- compact two\n+ separate list')
    expect(exported).toContain('* loose one\n\n* loose two')
    expect(exported).toContain('```JS title="Info"')
    const saved = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))!.blocks
    expect(saved.filter((b) => b.type === 'todo').every((b) => b.checked)).toBe(true)
    await page.screenshot({ path: 'test-results/markdown-spec-fidelity.png', fullPage: false })
  })
})
