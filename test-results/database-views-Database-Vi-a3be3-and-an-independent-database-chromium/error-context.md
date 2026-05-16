# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: database-views.spec.ts >> Database Views @electron >> isolates schema columns between the default database and an independent database
- Location: e2e-tests\database-views.spec.ts:106:3

# Error details

```
TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /^(?:Standalone databases|独立数据库)$/i })
    - locator resolved to <button type="button" class="secondary-button">独立数据库</button>
  - attempting click action
    - waiting for element to be visible, enabled and stable

```

# Test source

```ts
  1   | import { expect, test, type Page } from '@playwright/test'
  2   | import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'
  3   | 
  4   | async function openDatabasePage(page: Page): Promise<void> {
  5   |   await page.getByTitle(uiText('Database', '数据库')).click()
  6   |   await expect(page.locator('[data-testid="database-grid"]')).toBeVisible()
  7   | }
  8   | 
  9   | async function openDocumentCatalogView(page: Page): Promise<void> {
  10  |   await page.getByRole('button', { name: uiText('Document catalog', '文档目录') }).click()
  11  |   await expect(page.getByRole('heading', { name: uiText('Document catalog', '文档目录') })).toBeVisible()
  12  | }
  13  | 
  14  | async function openStandaloneDatabasesView(page: Page): Promise<void> {
> 15  |   await page.getByRole('button', { name: uiText('Standalone databases', '独立数据库') }).click()
      |                                                                                     ^ TimeoutError: locator.click: Timeout 30000ms exceeded.
  16  |   await expect(page.getByRole('heading', { name: uiText('Standalone databases', '独立数据库') })).toBeVisible()
  17  | }
  18  | 
  19  | function getDatabaseButton(page: Page, databaseName: string) {
  20  |   return page.getByRole('button', { name: databaseName }).last()
  21  | }
  22  | 
  23  | async function selectDatabase(page: Page, databaseName: string): Promise<void> {
  24  |   const button = getDatabaseButton(page, databaseName)
  25  |   await expect(button).toBeVisible()
  26  |   await button.click()
  27  |   await expect(button).toHaveClass(/primary-button/)
  28  | }
  29  | 
  30  | async function addTextColumn(page: Page, columnName: string): Promise<void> {
  31  |   await page.getByRole('button', { name: uiText('Add column', '新增列') }).click()
  32  |   const form = page.locator('.database-schema-form').filter({ has: page.getByLabel(uiText('Column name', '列名')) }).first()
  33  |   await expect(form).toBeVisible()
  34  |   await form.getByLabel(uiText('Column name', '列名')).fill(columnName)
  35  |   const saveButton = form.getByRole('button', { name: uiText('Save column', '保存列') })
  36  |   await expect(saveButton).toBeEnabled()
  37  |   await saveButton.click()
  38  |   await expect(form).toHaveCount(0)
  39  |   await expect.poll(async () => {
  40  |     const values = await page.locator('.database-schema-name-input').evaluateAll((inputs) =>
  41  |       inputs.map((input) => (input as HTMLInputElement).value)
  42  |     )
  43  |     return values.includes(columnName)
  44  |   }, { timeout: 60000 }).toBe(true)
  45  |   await expect(page.getByRole('button', { name: uiText('Add column', '新增列') })).toBeVisible()
  46  | }
  47  | 
  48  | async function createDatabase(page: Page, databaseName: string, description: string): Promise<void> {
  49  |   await page.getByRole('button', { name: uiText('Add database', '新增数据库') }).click()
  50  |   await page.getByLabel(uiText('Database name', '数据库名称')).fill(databaseName)
  51  |   await page.getByLabel(uiText('Description', '描述')).fill(description)
  52  |   await page.getByRole('button', { name: uiText('Create database', '创建数据库') }).click()
  53  |   await expect(getDatabaseButton(page, databaseName)).toBeVisible()
  54  | }
  55  | 
  56  | async function ensureDatabaseEntityFormOpen(page: Page): Promise<void> {
  57  |   if (await page.locator('.database-schema-form').count() === 0) {
  58  |     await page.getByRole('button', { name: uiText('Add entity', '新增实体') }).click()
  59  |   }
  60  | 
  61  |   await expect(page.locator('.database-schema-form').last()).toBeVisible()
  62  | }
  63  | 
  64  | async function createStandaloneTextEntity(page: Page, fieldLabel: string, value: string): Promise<void> {
  65  |   await ensureDatabaseEntityFormOpen(page)
  66  | 
  67  |   const form = page.locator('.database-schema-form').last()
  68  |   await form.getByLabel(fieldLabel).fill(value)
  69  |   await form.getByRole('button', { name: uiText('Create Entity', '创建实体') }).click()
  70  | 
  71  |   const flashMessage = page.locator('.flash-message')
  72  |   await expect(flashMessage).toBeVisible()
  73  |   expect(await flashMessage.textContent()).toMatch(/Database entity created successfully\.|数据库实体已创建。/)
  74  | }
  75  | 
  76  | async function getStandaloneEntityTextValues(page: Page): Promise<string[]> {
  77  |   return page.locator('.database-entity-card .catalog-cell-input').evaluateAll((inputs) =>
  78  |     inputs.map((input) => (input as HTMLInputElement).value)
  79  |   )
  80  | }
  81  | 
  82  | async function getStandaloneEntityTableTextValues(page: Page): Promise<string[]> {
  83  |   return page.locator('.database-entity-table tbody [data-column-id] .catalog-cell-input').evaluateAll((inputs) =>
  84  |     inputs.map((input) => (input as HTMLInputElement).value)
  85  |   )
  86  | }
  87  | 
  88  | async function getStandaloneEntitySelectionStates(page: Page): Promise<boolean[]> {
  89  |   return page.locator('.database-entity-select-checkbox').evaluateAll((inputs) =>
  90  |     inputs.map((input) => (input as HTMLInputElement).checked)
  91  |   )
  92  | }
  93  | 
  94  | async function expectSchemaColumnNames(page: Page, expectedNames: string[]): Promise<void> {
  95  |   await expect
  96  |     .poll(async () => {
  97  |       const values = await page.locator('.database-schema-name-input').evaluateAll((inputs) =>
  98  |         inputs.map((input) => (input as HTMLInputElement).value)
  99  |       )
  100 |       return [...new Set(values)].sort()
  101 |     }, { timeout: 60000 })
  102 |     .toEqual([...expectedNames].sort())
  103 | }
  104 | 
  105 | test.describe('Database Views @electron', () => {
  106 |   test('isolates schema columns between the default database and an independent database', async () => {
  107 |     test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  108 |     test.slow()
  109 | 
  110 |     await withElectronApp(async ({ page }) => {
  111 |       await openDatabasePage(page)
  112 |       await openDocumentCatalogView(page)
  113 | 
  114 |       await addTextColumn(page, 'Status')
  115 |       await expectSchemaColumnNames(page, ['Status'])
```