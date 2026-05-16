import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function createFreshDocumentEditor(page: Page): Promise<Locator> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()

  const editor = page.locator('textarea.block-inline-textarea').nth(1)
  await expect(editor).toBeVisible()
  return editor
}

async function createParagraphBlocks(page: Page, values: string[]): Promise<void> {
  const editors = page.locator('textarea.block-inline-textarea')
  await createFreshDocumentEditor(page)

  for (let index = 0; index < values.length; index += 1) {
    const editor = editors.nth(index + 1)
    await expect(editor).toBeVisible()
    await editor.fill(values[index])

    if (index < values.length - 1) {
      await editor.press('Control+Enter')
    }
  }
}

async function getBodyBlockValues(page: Page): Promise<string[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.slice(1).map((textarea) => (textarea as HTMLTextAreaElement).value)
  )
}

async function selectFirstTwoBodyBlocks(page: Page): Promise<void> {
  const editors = page.locator('textarea.block-inline-textarea')
  const firstBody = editors.nth(1)

  await firstBody.click()
  await firstBody.press('End')
  await firstBody.press('Shift+ArrowDown')

  await expect(page.locator('.block-selection-toolbar')).toBeVisible()
  await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
}

test.describe('Editor Multi-Block Operations @electron', () => {
  test('selects a contiguous block range with Shift and deletes it from the toolbar', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createParagraphBlocks(page, ['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])

      await selectFirstTwoBodyBlocks(page)

      await page
        .locator('.block-selection-toolbar')
        .getByRole('button', { name: uiText('Delete', '删除') })
        .click()

      await expect(page.locator('.block-selection-toolbar')).toHaveCount(0)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Gamma'])
    })
  })

  test('duplicates a contiguous block range with Ctrl+Shift+D', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createParagraphBlocks(page, ['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])

      await selectFirstTwoBodyBlocks(page)
      await page.locator('textarea.block-inline-textarea').nth(1).press('Control+Shift+D')

      await expect(page.locator('.block-selection-toolbar')).toBeVisible()
      await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Alpha', 'Beta', 'Gamma'])
    })
  })
})