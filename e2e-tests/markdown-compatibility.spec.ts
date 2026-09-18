import { expect, test } from '@playwright/test'
import { withElectronApp } from './helpers/electron'

test('Markdown paste, persistence, reading, outline and copy agree @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => { (globalThis as { markdownOpenedUrl?: string }).markdownOpenedUrl = url }
    })
    const id = await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Markdown compatibility', summary: '', blocks: [
        { id: `${id}-body`, type: 'paragraph', content: '', checked: false, depth: 0 }
      ] })
      return id
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Markdown compatibility' }).first().click()
    const source = [
      '### Third level', '', '###### Sixth level', '',
      '7. First', '   * Nested', '8. Second', '',
      '__bold__ and **bold *italic*** and \\*literal\\*', '',
      '[Reference][ref] and [Email](mailto:notes@example.com)', '',
      '| Name | Value |', '| :- | -: |', '| **Cell** | a\\|b |', '',
      '~~~js', 'const x = 1', '~~~', '',
      '> outer', '> > inner', '',
      '[ref]: https://example.com "Reference title"'
    ].join('\n')
    await page.locator('textarea.block-inline-textarea').first().evaluate((element, source) => {
      const input = element as HTMLTextAreaElement
      input.focus()
      input.setSelectionRange(0, 0)
      const data = new DataTransfer()
      data.setData('text/plain', source)
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    }, source)
    await expect(page.locator('textarea.type-heading-3')).toHaveValue('Third level')
    await expect(page.locator('textarea.type-heading-6')).toHaveValue('Sixth level')
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks.map((block) => block.type)).toEqual([
      'heading-3', 'heading-6', 'numbered-list', 'bulleted-list', 'numbered-list', 'paragraph', 'paragraph', 'table', 'code', 'quote', 'paragraph'
    ])
    const before = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))!.blocks
    expect(before[0].id).toBe(`${id}-body`)
    expect(before[2].listStart).toBe(7)
    expect(before[3].parentBlockId).toBe(before[2].id)
    expect(before[8].content).toBe('const x = 1')
    await expect(page.locator('.block-number-label')).toHaveText(['7.', '8.'])
    await page.locator('.document-view-toggle').click()
    await expect(page.locator('.document-reading-content h3')).toHaveText('Third level')
    await expect(page.locator('.document-reading-content h6')).toHaveText('Sixth level')
    await expect(page.locator('.document-reading-content strong em')).toHaveText('italic')
    await expect(page.locator('button.inline-link[title="Reference title"]')).toHaveText('Reference')
    await page.locator('button.inline-link[title="mailto:notes@example.com"]').click()
    await expect.poll(() => app.evaluate(() => (globalThis as { markdownOpenedUrl?: string }).markdownOpenedUrl)).toBe('mailto:notes@example.com')
    await expect(page.locator('.block-markdown-table td strong')).toHaveText('Cell')
    await expect(page.locator('.block-markdown-table td').nth(1)).toHaveText('a|b')
    await expect(page.locator('.document-reading-content blockquote blockquote')).toContainText('inner')
    await page.locator('.document-outline-control > button').click()
    await expect(page.locator('.toc-item-h6')).toHaveText('Sixth level')
    await page.locator('.document-outline-control > button').click()
    await page.locator('.document-reading-row').first().locator('.reading-collapse').click()
    await expect(page.locator('.document-reading-row')).toHaveCount(1)
    await page.locator('.document-reading-row').first().locator('.reading-collapse').click()
    await page.locator('.document-view-toggle').click()
    const first = page.locator('textarea.block-inline-textarea').first()
    await first.click()
    await first.press('Control+a')
    await first.press('Control+a')
    await first.press('Control+c')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('###### Sixth level')
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copied).toContain('7. First\n   * Nested\n8. Second')
    expect(copied).toContain('[ref]: https://example.com "Reference title"')
    await page.keyboard.press('Escape')
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Markdown compatibility' }).first().click()
    expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks).toEqual(before)
  })
})
