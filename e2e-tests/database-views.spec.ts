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
  const form = page.locator('.database-schema-form').filter({ has: page.getByLabel(uiText('Column name', '列名')) }).first()
  await expect(form).toBeVisible()
  await form.getByLabel(uiText('Column name', '列名')).fill(columnName)
  await form.getByRole('button', { name: uiText('Save column', '保存列') }).click()
  await expect(page.getByRole('button', { name: uiText('Add column', '新增列') })).toBeVisible()
}

async function createDatabase(page: Page, databaseName: string, description: string): Promise<void> {
  await page.getByRole('button', { name: uiText('Add database', '新增数据库') }).click()
  await page.getByLabel(uiText('Database name', '数据库名称')).fill(databaseName)
  await page.getByLabel(uiText('Description', '描述')).fill(description)
  await page.getByRole('button', { name: uiText('Create database', '创建数据库') }).click()
  await expect(getDatabaseButton(page, databaseName)).toBeVisible()
}

async function ensureDatabaseEntityFormOpen(page: Page): Promise<void> {
  if (await page.locator('.database-schema-form').count() === 0) {
    await page.getByRole('button', { name: uiText('Add entity', '新增实体') }).click()
  }

  await expect(page.locator('.database-schema-form').last()).toBeVisible()
}

async function createStandaloneTextEntity(page: Page, fieldLabel: string, value: string): Promise<void> {
  await ensureDatabaseEntityFormOpen(page)

  const form = page.locator('.database-schema-form').last()
  await form.getByLabel(fieldLabel).fill(value)
  await form.getByRole('button', { name: uiText('Create Entity', '创建实体') }).click()

  const flashMessage = page.locator('.flash-message')
  await expect(flashMessage).toBeVisible()
  expect(await flashMessage.textContent()).toMatch(/Database entity created successfully\.|数据库实体已创建。/)
}

async function getStandaloneEntityTextValues(page: Page): Promise<string[]> {
  return page.locator('.database-entity-card .catalog-cell-input').evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value)
  )
}

async function getStandaloneEntityTableTextValues(page: Page): Promise<string[]> {
  return page.locator('.database-entity-table tbody [data-column-id] .catalog-cell-input').evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value)
  )
}

async function getStandaloneEntitySelectionStates(page: Page): Promise<boolean[]> {
  return page.locator('.database-entity-select-checkbox').evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).checked)
  )
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

      await ensureDatabaseEntityFormOpen(page)
      const createFormDocumentSelect = page.locator('.database-schema-form').last().locator('.database-entity-document-select').first()
      await createFormDocumentSelect.selectOption({ index: 1 })
      await expect(createFormDocumentSelect).not.toHaveValue('')
      await page.locator('.database-schema-form').last().getByRole('button', { name: uiText('Create Entity', '创建实体') }).click()

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

  test('filters and sorts standalone entities by field values', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await openStandaloneDatabasesView(page)

      await createDatabase(page, 'Entity Filters', 'Standalone entity list controls')
      await selectDatabase(page, 'Entity Filters')
      await addTextColumn(page, 'Owner')

      await createStandaloneTextEntity(page, 'Owner', 'alpha')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['alpha'])
      await createStandaloneTextEntity(page, 'Owner', 'beta')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['beta', 'alpha'])

      const filterQuery = page.locator('.database-entity-filter-query')
      const filterScope = page.locator('.database-entity-filter-scope-select')
      const sortSelect = page.locator('.database-entity-sort-select')

      await expect(sortSelect).toHaveValue('updated-desc')

      await sortSelect.selectOption('created-asc')
      await expect(sortSelect).toHaveValue('created-asc')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['alpha', 'beta'])

      await filterScope.selectOption({ index: 2 })
      await filterQuery.fill('beta')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['beta'])
    })
  })

  test('selects visible standalone entities and deletes them in bulk', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await openStandaloneDatabasesView(page)

      await createDatabase(page, 'Entity Bulk Delete', 'Standalone entity bulk actions')
      await selectDatabase(page, 'Entity Bulk Delete')
      await addTextColumn(page, 'Owner')

      await createStandaloneTextEntity(page, 'Owner', 'alpha')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['alpha'])
      await createStandaloneTextEntity(page, 'Owner', 'beta')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['beta', 'alpha'])

      await page.locator('.database-entity-select-visible-button').click()
      await expect.poll(() => getStandaloneEntitySelectionStates(page)).toEqual([true, true])

      page.once('dialog', async (dialog) => {
        expect(dialog.message()).toMatch(/Delete these 2 database entities\?|确定删除这 2 条数据库实体吗？/)
        await dialog.accept()
      })
      await page.locator('.database-entity-delete-selected-button').click()

      await expect(page.locator('.database-entity-card')).toHaveCount(0)
      await expect(page.locator('.flash-message')).toContainText(/Deleted 2 database entities\.|已删除 2 条数据库实体。/)
    })
  })

  test('applies and clears a field value across selected standalone entities', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await openStandaloneDatabasesView(page)

      await createDatabase(page, 'Entity Bulk Edit', 'Standalone entity bulk field editing')
      await selectDatabase(page, 'Entity Bulk Edit')
      await addTextColumn(page, 'Owner')

      await createStandaloneTextEntity(page, 'Owner', 'alpha')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['alpha'])
      await createStandaloneTextEntity(page, 'Owner', 'beta')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['beta', 'alpha'])

      await page.locator('.database-entity-select-visible-button').click()
      await expect.poll(() => getStandaloneEntitySelectionStates(page)).toEqual([true, true])

      const bulkPanel = page.locator('.database-entity-bulk-panel')
      const ownerField = bulkPanel.locator('[data-column-name="Owner"]')
      await expect(bulkPanel).toBeVisible()

      await ownerField.locator('.catalog-cell-input').fill('shared-owner')
      await ownerField.locator('.database-entity-bulk-field-apply-button').click()
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['shared-owner', 'shared-owner'])

      await ownerField.locator('.database-entity-bulk-field-clear-button').click()
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['', ''])
      await expect(page.locator('.flash-message')).toContainText(/Updated 2 database entities\.|已更新 2 条数据库实体。/)
    })
  })

  test('switches standalone entities into table view and edits fields there', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await openStandaloneDatabasesView(page)

      await createDatabase(page, 'Entity Table View', 'Standalone entity table view')
      await selectDatabase(page, 'Entity Table View')
      await addTextColumn(page, 'Owner')

      await createStandaloneTextEntity(page, 'Owner', 'alpha')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['alpha'])
      await createStandaloneTextEntity(page, 'Owner', 'beta')
      await expect.poll(() => getStandaloneEntityTextValues(page)).toEqual(['beta', 'alpha'])

      await page.locator('.database-entity-table-view-button').click()
      await expect(page.locator('.database-entity-table')).toBeVisible()
      await expect.poll(() => getStandaloneEntityTableTextValues(page)).toEqual(['beta', 'alpha'])

      const firstRowOwnerInput = page.locator('.database-entity-table tbody tr').first().locator('[data-column-id] .catalog-cell-input').first()
      await firstRowOwnerInput.fill('table-updated')
      await firstRowOwnerInput.blur()

      await expect.poll(() => getStandaloneEntityTableTextValues(page)).toEqual(['table-updated', 'alpha'])
    })
  })
})