import { expect, test } from '@playwright/test'
import { withElectronApp } from './helpers/electron'

test('source blocks keep literal slash and wiki syntax through keyboard editing and reload @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const types = ['code', 'math', 'table', 'frontmatter', 'html']
    const title = 'Source editing without prose suggestions'
    const id = await page.evaluate(async ({ types, title }) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks: types.map(type => ({
        id: `source-${type}`, type, content: 'Original source', depth: 0, checked: false,
        tags: ['source'], highlight: 'yellow'
      })) })
      return id
    }, { types, title })
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    const expectedContent = '/todo\n[[Target\n'
    for (const type of types) {
      const row = page.locator(`[data-block-id="source-${type}"]`)
      if (type === 'table') await row.locator('details.markdown-table-source summary').click()
      const editor = row.locator('textarea.block-inline-textarea')
      await editor.fill('/todo')
      await editor.press('End')
      await expect(page.locator('.floating-slash-command-panel')).toHaveCount(0)
      await editor.press('Escape')
      await expect(editor).toHaveValue('/todo')
      await editor.press('Enter')
      await expect(editor).toHaveValue('/todo\n')
      await editor.pressSequentially('[[Target')
      await expect(page.locator('.link-helper-panel')).toHaveCount(0)
      await editor.press('Escape')
      await expect(editor).toHaveValue('/todo\n[[Target')
      await editor.press('Enter')
      await expect(editor).toHaveValue(expectedContent)
      await expect(editor).toHaveClass(new RegExp(`type-${type}(?:\\s|$)`))
    }
    const saved = () => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(
      ({ id, type, content, tags, highlight }) => ({ id, type, content, tags, highlight })), id)
    const expected = types.map(type => ({ id: `source-${type}`, type, content: expectedContent, tags: ['source'], highlight: 'yellow' }))
    await expect.poll(saved).toEqual(expected)
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    await expect.poll(saved).toEqual(expected)
    for (const type of types) {
      await expect(page.locator(`[data-block-id="source-${type}"] textarea`)).toHaveValue(expectedContent)
    }
  })
})
