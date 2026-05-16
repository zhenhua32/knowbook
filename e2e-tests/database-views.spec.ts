import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function openDatabasePage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Database', '数据库')).click()
  await expect(page.locator('[data-testid="database-grid"]')).toBeVisible()
}

async function openDocumentCatalogView(page: Page): Promise<void> {
  await page.getByRole('button', { name: uiText('Document catalog', '文档目录') }).click()
  await expect(page.getByRole('heading', { name: uiText('Document catalog', '文档目录') })).toBeVisible()
}

async function openStandaloneDatabasesView(page: Page): Promise<void> {
  await page.getByRole('button', { name: uiText('Standalone databases', '独立数据库') }).click()
  await expect(page.getByRole('heading', { name: uiText('Standalone databases', '独立数据库') })).toBeVisible()
}

function getDatabaseButton(page: Page, databaseName: string) {
  return page.getByRole('button', { name: databaseName }).last()
}

async function selectDatabase(page: Page, databaseName: string): Promise<void> {
  const button = getDatabaseButton(page, databaseName)
  await expect(button).toBeVisible()
  await button.click()
  await expect(button).toHaveClass(/primary-button/)
}

async function addTextColumn(page: Page, columnName: string): Promise<void> {
  await page.getByRole('button', { name: uiText('Add column', '新增列') }).click()
  await page.getByLabel(uiText('Column name', '列名')).fill(columnName)
  await page.getByRole('button', { name: uiText('Save column', '保存列') }).click()
  await expect(page.getByRole('button', { name: uiText('Add column', '新增列') })).toBeVisible()
}

async function createDatabase(page: Page, databaseName: string, description: string): Promise<void> {
  await page.getByRole('button', { name: uiText('Add database', '新增数据库') }).click()
  await page.getByLabel(uiText('Database name', '数据库名称')).fill(databaseName)
  await page.getByLabel(uiText('Description', '描述')).fill(description)
  await page.getByRole('button', { name: uiText('Create database', '创建数据库') }).click()
  await expect(getDatabaseButton(page, databaseName)).toBeVisible()
}

async function expectSchemaColumnNames(page: Page, expectedNames: string[]): Promise<void> {
  await expect
    .poll(async () => {
      const values = await page.locator('.database-schema-name-input').evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value)
      )
      return [...new Set(values)].sort()
    }, { timeout: 30000 })
    .toEqual([...expectedNames].sort())
}

test.describe('Database Views @electron', () => {
  test('isolates schema columns between the default database and an independent database', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
    test.slow()

    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await openDocumentCatalogView(page)

      await addTextColumn(page, 'Status')
      await expectSchemaColumnNames(page, ['Status'])

      await expect(page.getByPlaceholder(uiText('Search documents...', '搜索文档...'))).toBeVisible()

      await openStandaloneDatabasesView(page)
      await createDatabase(page, 'Projects', 'Project tracking')
      await selectDatabase(page, 'Projects')
      await expectSchemaColumnNames(page, [])

      await addTextColumn(page, 'Owner')
      await expectSchemaColumnNames(page, ['Owner'])

      await expect(page.getByPlaceholder(uiText('Search documents...', '搜索文档...'))).toHaveCount(0)

      await openDocumentCatalogView(page)
      await expectSchemaColumnNames(page, ['Status'])
      await expect(page.locator('.board-panel')).toBeVisible()

      await openStandaloneDatabasesView(page)
      await selectDatabase(page, 'Projects')
      await expectSchemaColumnNames(page, ['Owner'])
      await expect(page.locator('.board-panel')).toHaveCount(0)
    })
  })

  test('creates a standalone entity with a selected document and can clear the link later', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await openStandaloneDatabasesView(page)

      await createDatabase(page, 'Entity Links', 'Standalone entity link flow')
      await selectDatabase(page, 'Entity Links')

      const createFormDocumentSelect = page.locator('.database-schema-form .database-entity-document-select').first()
      await createFormDocumentSelect.selectOption({ index: 1 })
      await expect(createFormDocumentSelect).not.toHaveValue('')
      await page.getByRole('button', { name: uiText('Create Entity', '创建实体') }).click()

      const entityCard = page.locator('.database-entity-card').first()
      const entityDocumentSelect = entityCard.locator('.database-entity-document-select')
      const entityPath = entityCard.locator('.database-entity-head p').first()
      await expect(entityCard).toBeVisible()
      await expect(entityDocumentSelect).not.toHaveValue('')
      await expect(entityPath).not.toHaveText(uiText('No linked document', '未关联文档'))

      await entityDocumentSelect.selectOption('')
      await expect(entityDocumentSelect).toHaveValue('')
      await expect(entityPath).toHaveText(uiText('No linked document', '未关联文档'))
    })
  })
})