import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function createFreshDocumentEditor(page: Page): Promise<Locator> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()

  const editor = page.locator('textarea.block-inline-textarea').nth(1)
  await expect(editor).toBeVisible()
  return editor
}

test.describe('Editor Markdown Shortcuts @electron', () => {
  test('should convert # to heading 1', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('# Heading One')

      await expect(editor).toHaveClass(/type-heading-1/)
    })
  })

  test('should convert ## to heading 2', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('## Heading Two')

      await expect(editor).toHaveClass(/type-heading-2/)
    })
  })

  test('should convert - [ ] to todo unchecked', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('- [ ] Task not done')

      const todoCheckbox = page.locator('.block-todo-checkbox').first()
      await expect(editor).toHaveClass(/type-todo/)
      await expect(todoCheckbox).toBeVisible()
      await expect(todoCheckbox).not.toBeChecked()
    })
  })

  test('should convert - [x] to todo checked', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('- [x] Task done')

      const todoCheckbox = page.locator('.block-todo-checkbox').first()
      await expect(editor).toHaveClass(/type-todo/)
      await expect(todoCheckbox).toBeVisible()
      await expect(todoCheckbox).toBeChecked()
    })
  })

  test('should convert > to quote', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('> This is a quote')

      await expect(editor).toHaveClass(/type-quote/)
    })
  })

  test('should convert - to bulleted list', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('- List item 1')

      await expect(editor).toHaveClass(/type-bulleted-list/)
      await expect(page.locator('.block-bullet-dot').first()).toBeVisible()
    })
  })

  test('should convert 1. to numbered list', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('1. First item')

      await expect(editor).toHaveClass(/type-numbered-list/)
      await expect(page.locator('.block-number-label').first()).toBeVisible()
    })
  })

  test('should convert $$ to math block', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('$$ E = mc^2')

      await expect(editor).toHaveClass(/type-math/)
    })
  })

  test('should convert --- to divider', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('---')

      await expect(page.locator('.block-divider-line').first()).toBeVisible()
    })
  })

  test('should convert ``` to code block', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('```\nconst x = 1;\n```')

      await expect(editor).toHaveClass(/type-code/)
      await expect(page.locator('.block-code-language-badge').first()).toBeVisible()
    })
  })
})
