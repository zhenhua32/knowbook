import { expect, test, type Locator, type Page } from '@playwright/test'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type PersistedBodyBlock = {
  type: string
  content: string
  checked: boolean
  depth: number
  parentIndex: number | null
}

function getTitleInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-input').first()
}

function getPreviewTitle(page: Page): Locator {
  return page.locator('.preview-panel .panel-head h3')
}

function getBodyEditor(page: Page, bodyIndex: number): Locator {
  return page.locator('textarea.block-inline-textarea').nth(bodyIndex + 1)
}

async function getBodyBlockValues(page: Page): Promise<string[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.slice(1).map((textarea) => (textarea as HTMLTextAreaElement).value)
  )
}

async function getBodyBlockTypes(page: Page): Promise<string[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.slice(1).map((textarea) => {
      const className = Array.from(textarea.classList).find((value) => value.startsWith('type-'))
      return className?.slice('type-'.length) ?? ''
    })
  )
}

async function findDocumentIdByTitle(page: Page, title: string): Promise<string | null> {
  return page.evaluate(async (documentTitle) => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return catalog.find((document) => document.title === documentTitle)?.id ?? null
  }, title)
}

async function createSavedRootDocument(page: Page, title: string, body: string): Promise<string> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await ensureDocumentMetadataEditor(page)
  await expect(getTitleInput(page)).toHaveValue(/Untitled/i)

  await getTitleInput(page).fill(title)
  await getBodyEditor(page, 0).fill(body)
  await page.getByRole('button', { name: uiText('Save', '保存') }).click()
  await expect(getPreviewTitle(page)).toHaveText(title)

  await expect.poll(() => findDocumentIdByTitle(page, title)).not.toBeNull()
  const documentId = await findDocumentIdByTitle(page, title)
  if (!documentId) {
    throw new Error(`Could not resolve document id for ${title}`)
  }

  return documentId
}

async function getPersistedBodyBlocks(page: Page, documentId: string): Promise<PersistedBodyBlock[] | null> {
  return page.evaluate(async (id) => {
    const detail = await window.knowbook.getDocumentDetail(id)
    if (!detail) {
      return null
    }

    const bodyBlocks = detail.blocks.slice(1)
    const bodyIndexById = new Map(bodyBlocks.map((block, index) => [block.id, index]))
    return bodyBlocks.map((block) => ({
      type: block.type,
      content: block.content,
      checked: block.checked,
      depth: block.depth,
      parentIndex: block.parentBlockId ? bodyIndexById.get(block.parentBlockId) ?? null : null
    }))
  }, documentId)
}

async function reopenDocument(page: Page, title: string): Promise<void> {
  await page.locator('.tree-button:not(.tree-button-active)').first().click()
  await expect(getPreviewTitle(page)).not.toHaveText(title)

  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(getPreviewTitle(page)).toHaveText(title)
  await ensureDocumentMetadataEditor(page)
}

test.describe('Editor Common Operations Durability @electron', () => {
  test('auto-saves text edits and keeps a footer-added empty block after reload', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common empty row ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Initial body')

      await getBodyEditor(page, 0).fill('Edited body')
      await page.getByRole('button', { name: uiText('Add block', '新增块') }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Edited body', ''])

      const expectedBlocks: PersistedBodyBlock[] = [
        { type: 'paragraph', content: 'Edited body', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: '', checked: false, depth: 0, parentIndex: null }
      ]
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual(expectedBlocks)

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Edited body', ''])
    })
  })

  test('persists split, keyboard insertion, and backspace merge operations', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common split merge ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'AlphaBeta')
      const firstBody = getBodyEditor(page, 0)

      await firstBody.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement
        textarea.focus()
        textarea.setSelectionRange(5, 5)
      })
      await firstBody.press('Alt+Enter')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta'])

      await getBodyEditor(page, 1).press('Control+Enter')
      await getBodyEditor(page, 2).fill('Gamma')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])

      await getBodyEditor(page, 2).press('Home')
      await getBodyEditor(page, 2).press('Backspace')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'BetaGamma'])

      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'paragraph', content: 'Alpha', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'BetaGamma', checked: false, depth: 0, parentIndex: null }
      ])

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'BetaGamma'])
    })
  })

  test('persists todo conversion, checked state, and nested list relationships', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common todo nesting ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Initial body')
      const parentEditor = getBodyEditor(page, 0)

      await parentEditor.fill('- [ ] Parent task')
      await expect(parentEditor).toHaveClass(/type-todo/)
      await page.locator('.block-todo-checkbox').first().check()

      await parentEditor.press('Control+Enter')
      const childEditor = getBodyEditor(page, 1)
      await childEditor.fill('Child task')
      await childEditor.press('Tab')

      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Parent task', 'Child task'])
      await expect.poll(() => getBodyBlockTypes(page)).toEqual(['todo', 'todo'])
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'todo', content: 'Parent task', checked: true, depth: 0, parentIndex: null },
        { type: 'todo', content: 'Child task', checked: false, depth: 1, parentIndex: 0 }
      ])

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockTypes(page)).toEqual(['todo', 'todo'])
      await expect(page.locator('.block-todo-checkbox').nth(0)).toBeChecked()
      await expect(page.locator('.block-todo-checkbox').nth(1)).not.toBeChecked()
    })
  })

  test('persists keyboard reordering and context-menu deletion', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common reorder delete ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'One')

      await getBodyEditor(page, 0).press('Control+Enter')
      await getBodyEditor(page, 1).fill('Two')
      await getBodyEditor(page, 1).press('Control+Enter')
      await getBodyEditor(page, 2).fill('Three')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['One', 'Two', 'Three'])

      await getBodyEditor(page, 2).press('Alt+ArrowUp')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['One', 'Three', 'Two'])

      await getBodyEditor(page, 2).click({ button: 'right' })
      await expect(page.locator('.block-context-menu')).toBeVisible()
      await page.locator('.block-context-menu').getByRole('button', { name: uiText('Delete', '删除') }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['One', 'Three'])

      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'paragraph', content: 'One', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'Three', checked: false, depth: 0, parentIndex: null }
      ])

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['One', 'Three'])
    })
  })
})
