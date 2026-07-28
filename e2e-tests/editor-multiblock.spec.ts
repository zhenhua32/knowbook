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

async function createTodoBlocks(page: Page, values: string[]): Promise<void> {
  const editors = page.locator('textarea.block-inline-textarea')
  await createFreshDocumentEditor(page)

  for (let index = 0; index < values.length; index += 1) {
    const editor = editors.nth(index + 1)
    await expect(editor).toBeVisible()
    await editor.fill(`- [ ] ${values[index]}`)
    await expect(editor).toHaveClass(/type-todo/)

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

async function getBodyBlockTypes(page: Page): Promise<string[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.slice(1).map((textarea) => {
      const match = Array.from((textarea as HTMLTextAreaElement).classList).find((className) => className.startsWith('type-'))
      return match ?? ''
    })
  )
}

async function getBodyBlockIndentValues(page: Page): Promise<number[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.slice(1).map((textarea) => {
      const row = textarea.closest('.block-editor-row')
      if (!(row instanceof HTMLElement)) {
        return 0
      }

      return Number.parseFloat(getComputedStyle(row).paddingLeft || '0')
    })
  )
}

async function getSelectedBodyBlockValues(page: Page): Promise<string[]> {
  return page.locator('.block-editor-row-selected textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.map((textarea) => (textarea as HTMLTextAreaElement).value)
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

async function selectLastTwoBodyBlocks(page: Page): Promise<void> {
  const editors = page.locator('textarea.block-inline-textarea')
  const secondBody = editors.nth(2)

  await secondBody.click()
  await secondBody.press('End')
  await secondBody.press('Shift+ArrowDown')

  await expect(page.locator('.block-selection-toolbar')).toBeVisible()
  await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
}

async function openBodyBlockToolbar(page: Page, bodyIndex: number): Promise<void> {
  const row = page.locator('.block-editor-row').nth(bodyIndex + 1)
  await expect(row).toBeVisible()
  await row.locator('.block-drag-handle').click({ force: true })
  await expect(row.locator('.block-edit-toolbar')).toBeVisible()
}

test.describe('Editor Multi-Block Operations @electron', () => {
  test('adds a new empty body block from the footer button', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createFreshDocumentEditor(page)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Start writing here.'])

      await page.getByRole('button', { name: uiText('Add block', '新增块') }).click()

      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Start writing here.', ''])
    })
  })

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

  test('moves a contiguous block range down with Alt+ArrowDown', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createParagraphBlocks(page, ['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])

      await selectFirstTwoBodyBlocks(page)
      await page.locator('textarea.block-inline-textarea').nth(1).press('Alt+ArrowDown')

      await expect(page.locator('.block-selection-toolbar')).toBeVisible()
      await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Gamma', 'Alpha', 'Beta'])
      await expect.poll(() => getSelectedBodyBlockValues(page)).toEqual(['Alpha', 'Beta'])
    })
  })

  test('moves a contiguous block range up with Alt+ArrowUp', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createParagraphBlocks(page, ['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])

      await selectLastTwoBodyBlocks(page)
      await page.locator('textarea.block-inline-textarea').nth(2).press('Alt+ArrowUp')

      await expect(page.locator('.block-selection-toolbar')).toBeVisible()
      await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Beta', 'Gamma', 'Alpha'])
      await expect.poll(() => getSelectedBodyBlockValues(page)).toEqual(['Beta', 'Gamma'])
    })
  })

  test('converts a contiguous block range to todos from the selection toolbar', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createParagraphBlocks(page, ['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockTypes(page)).toEqual(['type-paragraph', 'type-paragraph', 'type-paragraph'])

      await selectFirstTwoBodyBlocks(page)

      const toolbar = page.locator('.block-selection-toolbar')
      await toolbar.locator('select').selectOption('todo')
      await toolbar.getByRole('button', { name: uiText('Convert', '转换') }).click()

      await expect(toolbar).toBeVisible()
      await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockTypes(page)).toEqual(['type-todo', 'type-todo', 'type-paragraph'])
      await expect(page.locator('.block-todo-checkbox')).toHaveCount(2)
    })
  })

  test('cuts a contiguous block range from the selection toolbar', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createParagraphBlocks(page, ['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])

      await selectFirstTwoBodyBlocks(page)

      const toolbar = page.locator('.block-selection-toolbar')
      await toolbar.getByRole('button', { name: uiText('Cut', '剪切') }).click()

      await expect(toolbar).toHaveCount(0)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Gamma'])
    })
  })

  test('deletes a single block from the block toolbar', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createParagraphBlocks(page, ['Alpha', 'Beta'])
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta'])

      await openBodyBlockToolbar(page, 1)
      await page.locator('.block-editor-row').nth(2).locator('.block-toolbar-delete').click()

      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha'])
    })
  })

  test('deletes a single block from the block context menu', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createParagraphBlocks(page, ['Alpha', 'Beta'])
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta'])

      await page.locator('textarea.block-inline-textarea').nth(2).click({ button: 'right' })
      await expect(page.locator('.block-context-menu')).toBeVisible()
      await page.locator('.block-context-menu').getByRole('button', { name: uiText('Delete', '删除') }).click()

      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha'])
    })
  })

  test('adjusts the nesting of a contiguous todo range with Tab and Shift+Tab', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await createTodoBlocks(page, ['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockTypes(page)).toEqual(['type-todo', 'type-todo', 'type-todo'])
      await expect.poll(() => getBodyBlockIndentValues(page)).toEqual([0, 0, 0])

      await selectLastTwoBodyBlocks(page)
      await page.locator('textarea.block-inline-textarea').nth(2).press('Tab')

      await expect(page.locator('.block-selection-toolbar')).toBeVisible()
      await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockIndentValues(page)).toEqual([0, 24, 24])

      await page.locator('textarea.block-inline-textarea').nth(2).press('Shift+Tab')

      await expect(page.locator('.block-selection-toolbar')).toBeVisible()
      await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => getBodyBlockIndentValues(page)).toEqual([0, 0, 0])
    })
  })
})
