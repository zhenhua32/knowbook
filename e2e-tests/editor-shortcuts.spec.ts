import { expect, test, type Locator, type Page } from '@playwright/test'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function createFreshDocumentEditor(page: Page): Promise<Locator> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await ensureDocumentMetadataEditor(page)
  await expect(page.locator('.document-summary-card .editor-input').first()).toHaveValue(/Untitled/i)

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
      await expect(page.getByRole('math', { name: uiText('Math preview', '公式预览') })).toBeVisible()
      await editor.fill('x^2 + y^2')
      await expect(page.getByRole('math', { name: uiText('Math preview', '公式预览') })).toContainText('x')
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
      await expect(page.getByRole('region', { name: uiText('Code preview', '代码预览') })).toBeVisible()
      await expect(page.locator('.block-code-hljs .hljs-keyword').first()).toContainText('const')
    })
  })

  test('keeps markdown table source editable while rendering a live preview', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('| Name | Value |\n| --- | ---: |\n| Alpha | 1 |')
      const row = editor.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " block-editor-row ")][1]')
      await row.locator('.block-drag-handle').click()
      await row.locator('.block-type-selector').selectOption('table')

      await expect(editor).toHaveClass(/type-table/)
      const preview = page.getByRole('region', { name: uiText('Table preview', '表格预览') })
      await expect(preview).toContainText('Alpha')

      await editor.fill('| Name | Value |\n| --- | ---: |\n| Beta | 2 |')
      await expect(preview).toContainText('Beta')
      await expect(preview).not.toContainText('Alpha')
    })
  })

  test('undoes and redoes an edit immediately before the history debounce expires', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      const originalValue = await editor.inputValue()

      await editor.fill('Immediate undo value')
      await editor.press('Control+z')
      await expect(editor).toHaveValue(originalValue)

      await editor.press('Control+Shift+z')
      await expect(editor).toHaveValue('Immediate undo value')
    })
  })

  test('dismisses a slash command without moving the cursor to trailing text', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const editor = await createFreshDocumentEditor(page)
      await editor.fill('   /todo after')
      for (let index = 0; index < 6; index += 1) {
        await editor.press('ArrowLeft')
      }

      await expect(page.locator('.floating-slash-command-panel')).toBeVisible()
      await editor.press('Escape')

      await expect(editor).toHaveValue('    after')
      await expect(page.locator('.floating-slash-command-panel')).toHaveCount(0)
      await expect.poll(() => editor.evaluate(
        (element) => (element as HTMLTextAreaElement).selectionStart
      )).toBe(3)
    })
  })
})
