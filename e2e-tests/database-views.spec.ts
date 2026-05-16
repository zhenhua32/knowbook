import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function openDatabasePage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Database', '数据库')).click()
  await expect(page.locator('[data-testid="database-grid"]')).toBeVisible()
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
    })
    .toEqual([...expectedNames].sort())
}

test.describe('Database Views @electron', () => {
  test('isolates schema columns between the default database and an independent database', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
    test.slow()

    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await selectDatabase(page, 'Default')

      await addTextColumn(page, 'Status')
      await expectSchemaColumnNames(page, ['Status'])

      await createDatabase(page, 'Projects', 'Project tracking')
      await expectSchemaColumnNames(page, [])

      await addTextColumn(page, 'Owner')
      await expectSchemaColumnNames(page, ['Owner'])

      await selectDatabase(page, 'Default')
      await expectSchemaColumnNames(page, ['Status'])

      await selectDatabase(page, 'Projects')
      await expectSchemaColumnNames(page, ['Owner'])
    })
  })
})