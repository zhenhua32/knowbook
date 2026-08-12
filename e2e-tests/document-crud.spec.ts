import { expect, test, type Page } from '@playwright/test'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

function getTitleInput(page: Page) {
  return page.locator('.document-summary-card .editor-input').first()
}

function getSummaryInput(page: Page) {
  return page.locator('.document-summary-card .editor-textarea').first()
}

function getTreeButton(page: Page, title: string) {
  return page.locator('.tree-button', { hasText: title }).first()
}

function getMoveTargetSelect(page: Page) {
  return page.locator('.document-header-action-menu .compact-select').first()
}

test.describe('Document CRUD Operations @electron', () => {
  test('creates a new root document and persists edited title and summary', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const uniqueSuffix = Date.now().toString(36)
    const nextTitle = `E2E Root ${uniqueSuffix}`
    const nextSummary = `Created from Electron E2E ${uniqueSuffix}`
    const incrementallyUpdatedSummary = `${nextSummary} (updated)`

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)

      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(nextTitle)
      await getSummaryInput(page).fill(nextSummary)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await expect(page.locator('.preview-panel .panel-head h3')).toHaveText(nextTitle)
      await expect(page.locator('.document-path')).toContainText(nextTitle)

      await getSummaryInput(page).fill(incrementallyUpdatedSummary)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()
      await expect(getSummaryInput(page)).toHaveValue(incrementallyUpdatedSummary)

      await page.locator('.tree-button:not(.tree-button-active)').first().click()
      await expect(getTitleInput(page)).not.toHaveValue(nextTitle)

      await getTreeButton(page, nextTitle).click()
      await expect(getTitleInput(page)).toHaveValue(nextTitle)
      await expect(getSummaryInput(page)).toHaveValue(incrementallyUpdatedSummary)
    })
  })

  test('renames a parent document and rewrites descendant paths', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const uniqueSuffix = Date.now().toString(36)
    const parentTitle = `E2E Parent ${uniqueSuffix}`
    const renamedParentTitle = `E2E Parent Renamed ${uniqueSuffix}`
    const childTitle = `E2E Child ${uniqueSuffix}`

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(parentTitle)
      await getSummaryInput(page).fill(`Parent summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await expect(page.locator('.document-path')).toContainText(parentTitle)

      await page.getByRole('button', { name: uiText('Add child', '新增子文档') }).click()
      await ensureDocumentMetadataEditor(page)
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(childTitle)
      await getSummaryInput(page).fill(`Child summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await expect(page.locator('.document-path')).toContainText(`${parentTitle}/${childTitle}`)

      await getTreeButton(page, parentTitle).click()
      await expect(getTitleInput(page)).toHaveValue(parentTitle)
      await getTitleInput(page).fill(renamedParentTitle)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await expect(page.locator('.document-path')).toContainText(renamedParentTitle)

      await getTreeButton(page, childTitle).click()
      await ensureDocumentMetadataEditor(page)
      await expect(getTitleInput(page)).toHaveValue(childTitle)
      await expect(page.locator('.document-path')).toContainText(`${renamedParentTitle}/${childTitle}`)
    })
  })

  test('moves a document subtree under another parent and rewrites descendant paths', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const uniqueSuffix = Date.now().toString(36)
    const sourceParentTitle = `E2E Source Parent ${uniqueSuffix}`
    const targetParentTitle = `E2E Target Parent ${uniqueSuffix}`
    const childTitle = `E2E Moving Child ${uniqueSuffix}`
    const grandchildTitle = `E2E Grandchild ${uniqueSuffix}`

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(sourceParentTitle)
      await getSummaryInput(page).fill(`Source parent summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(targetParentTitle)
      await getSummaryInput(page).fill(`Target parent summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await getTreeButton(page, sourceParentTitle).click()
      await page.getByRole('button', { name: uiText('Add child', '新增子文档') }).click()
      await ensureDocumentMetadataEditor(page)
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(childTitle)
      await getSummaryInput(page).fill(`Child summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await page.getByRole('button', { name: uiText('Add child', '新增子文档') }).click()
      await ensureDocumentMetadataEditor(page)
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(grandchildTitle)
      await getSummaryInput(page).fill(`Grandchild summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await expect(page.locator('.document-path')).toContainText(`${sourceParentTitle}/${childTitle}/${grandchildTitle}`)

      await getTreeButton(page, childTitle).click()
      await expect(page.locator('.document-path')).toContainText(`${sourceParentTitle}/${childTitle}`)

      await page.getByRole('button', { name: uiText('More actions', '更多操作') }).click()
      await expect(page.locator('.document-header-action-menu')).toBeVisible()
      await getMoveTargetSelect(page).selectOption({ label: targetParentTitle })
      await page.getByRole('button', { name: uiText('Move', '移动') }).click()

      await expect(page.locator('.document-path')).toContainText(`${targetParentTitle}/${childTitle}`)

      await getTreeButton(page, grandchildTitle).click()
      await ensureDocumentMetadataEditor(page)
      await expect(getTitleInput(page)).toHaveValue(grandchildTitle)
      await expect(page.locator('.document-path')).toContainText(`${targetParentTitle}/${childTitle}/${grandchildTitle}`)
    })
  })

  test('moves a document into a parent and back to root by dragging the tree', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const sourceTitle = `E2E Drag Source ${suffix}`
    const targetTitle = `E2E Drag Target ${suffix}`

    await withElectronApp(async ({ page }) => {
      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await getTitleInput(page).fill(sourceTitle)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await getTitleInput(page).fill(targetTitle)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      const targetId = await page.evaluate(async (title) => {
        const catalog = await window.knowbook.getDocumentCatalog()
        return catalog.find((document) => document.title === title)?.id ?? null
      }, targetTitle)
      expect(targetId).not.toBeNull()

      await getTreeButton(page, sourceTitle).dragTo(getTreeButton(page, targetTitle))
      await expect.poll(() => page.evaluate(async (source) => {
        const catalog = await window.knowbook.getDocumentCatalog()
        const sourceDocument = catalog.find((document) => document.title === source)
        return sourceDocument ? { parentId: sourceDocument.parentId, path: sourceDocument.path } : null
      }, sourceTitle)).toEqual({
        parentId: targetId,
        path: `${targetTitle}/${sourceTitle}`
      })

      const nestedSource = getTreeButton(page, sourceTitle)
      await nestedSource.dragTo(page.locator('.root-drop-zone-compact'))
      await expect.poll(() => page.evaluate(async (title) => {
        const catalog = await window.knowbook.getDocumentCatalog()
        const document = catalog.find((entry) => entry.title === title)
        return document ? { parentId: document.parentId, path: document.path } : null
      }, sourceTitle)).toEqual({ parentId: null, path: sourceTitle })
    })
  })

  test('reconciles a sibling title normalized by the main process', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const duplicateTitle = `E2E Duplicate ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await getTitleInput(page).fill(duplicateTitle)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()
      await expect(getTitleInput(page)).toHaveValue(duplicateTitle)

      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await getTitleInput(page).fill(duplicateTitle)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await expect(getTitleInput(page)).toHaveValue(`${duplicateTitle} 1`)
      await expect(page.locator('.preview-panel .panel-head h3')).toHaveText(`${duplicateTitle} 1`)
      await expect(page.locator('.document-path')).toContainText(`${duplicateTitle} 1`)
    })
  })

  test('surfaces a document save validation failure without losing the draft', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await getTitleInput(page).fill('Invalid/Title')
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await expect(page.locator('.flash-message')).toContainText('Document title cannot contain path separators')
      await expect(getTitleInput(page)).toHaveValue('Invalid/Title')
      await expect(page.getByRole('button', { name: uiText('Save', '保存') })).toBeEnabled()
    })
  })

  test('deletes a leaf document and removes it from persistent catalog state', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `E2E Delete Leaf ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await getTitleInput(page).fill(title)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()
      await expect(getTreeButton(page, title)).toBeVisible()

      page.once('dialog', (dialog) => dialog.accept())
      await page.getByRole('button', { name: uiText('More actions', '更多操作') }).click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Delete', '删除') }).click()

      await expect(getTreeButton(page, title)).toHaveCount(0)
      await expect.poll(() => page.evaluate(async (documentTitle) => {
        const catalog = await window.knowbook.getDocumentCatalog()
        return catalog.some((document) => document.title === documentTitle)
      }, title)).toBe(false)
    })
  })

  test('deleting a parent promotes its child and rewrites the child path', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const parentTitle = `E2E Delete Parent ${suffix}`
    const childTitle = `E2E Promoted Child ${suffix}`

    await withElectronApp(async ({ page }) => {
      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await ensureDocumentMetadataEditor(page)
      await getTitleInput(page).fill(parentTitle)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await page.getByRole('button', { name: uiText('Add child', '新增子文档') }).click()
      await ensureDocumentMetadataEditor(page)
      await getTitleInput(page).fill(childTitle)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()
      await expect(page.locator('.document-path')).toContainText(`${parentTitle}/${childTitle}`)

      await getTreeButton(page, parentTitle).click()
      page.once('dialog', (dialog) => dialog.accept())
      await page.getByRole('button', { name: uiText('More actions', '更多操作') }).click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Delete', '删除') }).click()

      await expect(getTreeButton(page, parentTitle)).toHaveCount(0)
      await getTreeButton(page, childTitle).click()
      await expect(page.locator('.document-path')).toContainText(childTitle)
      await expect(page.locator('.document-path')).not.toContainText(`${parentTitle}/${childTitle}`)
      await expect.poll(() => page.evaluate(async (title) => {
        const catalog = await window.knowbook.getDocumentCatalog()
        const document = catalog.find((entry) => entry.title === title)
        return document ? { parentId: document.parentId, path: document.path } : null
      }, childTitle)).toEqual({ parentId: null, path: childTitle })
    })
  })
})
