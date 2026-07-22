import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

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

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      await page.getByTitle(uiText('New root', '新建根文档')).click()

      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(nextTitle)
      await getSummaryInput(page).fill(nextSummary)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await expect(page.locator('.preview-panel .panel-head h3')).toHaveText(nextTitle)
      await expect(page.locator('.document-path')).toContainText(nextTitle)

      await page.locator('.tree-button:not(.tree-button-active)').first().click()
      await expect(getTitleInput(page)).not.toHaveValue(nextTitle)

      await getTreeButton(page, nextTitle).click()
      await expect(getTitleInput(page)).toHaveValue(nextTitle)
      await expect(getSummaryInput(page)).toHaveValue(nextSummary)
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
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(parentTitle)
      await getSummaryInput(page).fill(`Parent summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await expect(page.locator('.document-path')).toContainText(parentTitle)

      await page.getByRole('button', { name: uiText('Add child', '新增子文档') }).click()
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
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(sourceParentTitle)
      await getSummaryInput(page).fill(`Source parent summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await page.getByTitle(uiText('New root', '新建根文档')).click()
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(targetParentTitle)
      await getSummaryInput(page).fill(`Target parent summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await getTreeButton(page, sourceParentTitle).click()
      await page.getByRole('button', { name: uiText('Add child', '新增子文档') }).click()
      await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
      await getTitleInput(page).fill(childTitle)
      await getSummaryInput(page).fill(`Child summary ${uniqueSuffix}`)
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()

      await page.getByRole('button', { name: uiText('Add child', '新增子文档') }).click()
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
      await expect(getTitleInput(page)).toHaveValue(grandchildTitle)
      await expect(page.locator('.document-path')).toContainText(`${targetParentTitle}/${childTitle}/${grandchildTitle}`)
    })
  })
})
