import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function openDatabasePage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Database', '数据库')).click({ noWaitAfter: true })
  await expect(page.locator('[data-testid="database-grid"]')).toBeVisible()
  await expect(page.locator('.dbw-source-trigger')).toBeVisible()
}

async function createDatabase(page: Page, name: string, description: string): Promise<void> {
  await page.locator('.dbw-source-trigger').click()
  await page.getByRole('button', { name: uiText('New database', '新建数据库') }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(uiText('Name', '名称')).fill(name)
  await dialog.getByLabel(uiText('Description', '描述')).fill(description)
  await dialog.getByRole('button', { name: uiText('Create', '创建') }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(name)
}

async function addField(page: Page, name: string, type: 'text' | 'select' | 'multi-select' | 'date' | 'checkbox', options = ''): Promise<void> {
  await page.getByRole('button', { name: /Fields|字段/ }).click()
  const drawer = page.getByRole('dialog', { name: uiText('Manage fields', '字段管理') })
  await drawer.getByRole('button', { name: /Add field|新增字段/ }).click()
  await drawer.getByPlaceholder(uiText('Name', '名称')).fill(name)
  await drawer.locator('.dbw-field-create-form select').selectOption(type)
  if (options) await drawer.getByPlaceholder(/Options|选项/).fill(options)
  await drawer.getByRole('button', { name: uiText('Create', '创建') }).click()
  await expect(drawer.getByRole('button', { name })).toBeVisible()
  await drawer.getByRole('button', { name: uiText('Close', '关闭') }).click()
}

async function addSelectField(page: Page, name: string): Promise<void> {
  await addField(page, name, 'select', 'Todo, Doing, Done')
}

async function createRecord(page: Page, title: string, status?: string, linkedDocument?: string): Promise<void> {
  await page.getByRole('button', { name: uiText('New record', '新建记录') }).click()
  const dialog = page.getByRole('dialog', { name: uiText('Create record', '新建记录') })
  await dialog.getByLabel(/Title|标题/).fill(title)
  if (linkedDocument) await dialog.getByLabel(/Linked document|关联文档/).selectOption({ label: linkedDocument })
  if (status) {
    await dialog.getByLabel('Status').selectOption(status)
  }
  await dialog.getByRole('button', { name: uiText('Create', '创建'), exact: true }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
}

test.describe('Unified Database Workspace @electron', () => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

  test('uses one source picker and one canvas for system and custom databases', async () => {
    await withElectronApp(async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 })
      await openDatabasePage(page)

      await expect(page.locator('.dbw-table-scroll')).toBeVisible()
      await expect(page.getByRole('button', { name: uiText('New document', '新建文档') })).toBeVisible()
      await expect(page.getByRole('button', { name: uiText('Standalone databases', '独立数据库') })).toHaveCount(0)

      const documentCountBefore = await page.evaluate(() => window.knowbook.getDocumentCatalog().then((documents) => documents.length))
      await page.getByRole('button', { name: uiText('New document', '新建文档') }).click()
      await openDatabasePage(page)
      await expect.poll(() => page.evaluate(() => window.knowbook.getDocumentCatalog().then((documents) => documents.length))).toBe(documentCountBefore + 1)

      await createDatabase(page, 'Product work', 'Tasks and release planning')
      await expect(page.getByRole('button', { name: uiText('New record', '新建记录') })).toBeVisible()
      await expect(page.locator('.dbw-empty-state')).toBeVisible()

      await page.locator('.dbw-source-trigger').click()
      await page.getByRole('button', { name: /All documents|全部文档/ }).click()
      await expect(page.locator('.dbw-table-scroll')).toBeVisible()
      await expect(page.getByRole('button', { name: uiText('New document', '新建文档') })).toBeVisible()
    })
  })

  test('creates fields and titled records, then edits through the record drawer', async () => {
    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await createDatabase(page, 'Projects', 'Project tracker')
      await addSelectField(page, 'Status')
      await createRecord(page, 'Ship database redesign', 'Doing')

      await page.getByRole('button', { name: /Ship database redesign/ }).click()
      const drawer = page.getByRole('dialog', { name: uiText('Record details', '记录详情') })
      await expect(drawer).toBeVisible()
      await drawer.getByLabel(/Title|标题/).fill('Ship unified workspace')
      await drawer.getByRole('button', { name: uiText('Save', '保存') }).click()
      await expect(page.getByRole('button', { name: /Ship unified workspace/ })).toBeVisible()
    })
  })

  test('edits all five property types from the table and persists their values', async () => {
    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await createDatabase(page, 'Field types', 'Inline editing coverage')
      await addField(page, 'Notes', 'text')
      await addField(page, 'Priority', 'select', 'Low, High')
      await addField(page, 'Tags', 'multi-select', 'Red, Blue')
      await addField(page, 'Due date', 'date')
      await addField(page, 'Done', 'checkbox')
      await createRecord(page, 'Five field values')

      const row = page.locator('.dbw-table tbody tr').filter({ hasText: 'Five field values' })
      await row.locator('input.catalog-cell-input:not([type="date"])').fill('Ready for review')
      await row.locator('input.catalog-cell-input:not([type="date"])').press('Enter')
      await row.locator('select.catalog-cell-input').selectOption('High')
      await row.locator('.dbw-multi-editor summary').click()
      await row.locator('.dbw-multi-editor label').filter({ hasText: 'Red' }).getByRole('checkbox').check()
      await row.locator('input.catalog-cell-input[type="date"]').fill('2026-09-15')
      await row.locator('.dbw-checkbox-editor input').click()

      await expect.poll(async () => page.evaluate(async () => {
        const database = (await window.knowbook.getDatabases()).find((candidate) => candidate.name === 'Field types')
        if (!database) return null
        const columns = await window.knowbook.getDocumentDatabaseColumns(database.id)
        const entity = (await window.knowbook.getDatabaseEntities(database.id)).find((candidate) => candidate.title === 'Five field values')
        if (!entity) return null
        return Object.fromEntries(columns.map((column) => [column.name, entity.fieldValues[column.id] ?? null]))
      })).toEqual({ Notes: 'Ready for review', Priority: 'High', Tags: ['Red'], 'Due date': '2026-09-15', Done: true })
    })
  })

  test('persists a complete board view and reapplies it after switching sources', async () => {
    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await createDatabase(page, 'Saved views', 'View persistence')
      await addSelectField(page, 'Status')
      await createRecord(page, 'Alpha', 'Todo')
      await createRecord(page, 'Beta', 'Doing')

      await page.locator('.dbw-new-view-menu summary').click()
      const newViewMenu = page.locator('.dbw-layout-menu')
      await expect(newViewMenu).toBeVisible()
      await newViewMenu.getByRole('button', { name: uiText('Board', '看板') }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel(uiText('Name', '名称')).fill('Status board')
      await dialog.getByRole('button', { name: uiText('Create', '创建') }).click()
      await expect(page.locator('.dbw-board')).toBeVisible()
      await expect(page.locator('.dbw-board-column')).toHaveCount(2)

      const alphaCard = page.locator('.dbw-board-card').filter({ hasText: 'Alpha' })
      const doingColumn = page.locator('.dbw-board-column').filter({ has: page.locator('header strong').filter({ hasText: 'Doing' }) })
      await alphaCard.dragTo(doingColumn)
      await expect(doingColumn.getByRole('button', { name: /Alpha/ })).toBeVisible()
      await page.locator('.dbw-main-search input').fill('Alpha')
      await page.getByRole('button', { name: uiText('Save changes', '保存更改') }).click()

      await page.locator('.dbw-source-trigger').click()
      await page.getByRole('button', { name: /All documents|全部文档/ }).click()
      await page.locator('.dbw-source-trigger').click()
      await page.getByRole('button', { name: 'Saved views' }).click()
      await expect(page.locator('.dbw-board')).toBeVisible()
      await expect(page.locator('.dbw-view-tab-wrap.is-active')).toContainText('Status board')
      await expect(page.locator('.dbw-main-search input')).toHaveValue('Alpha')
      await expect(page.locator('.dbw-board-card')).toHaveCount(1)
    })
  })

  test('manages field naming, order, visibility, and deletion from the drawer', async () => {
    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await createDatabase(page, 'Field management', 'Drawer behavior')
      await addField(page, 'Owner', 'text')
      await addField(page, 'Stage', 'select', 'Draft, Published')

      const fieldsButton = page.getByRole('button', { name: /Fields|字段/ })
      await fieldsButton.click()
      const drawer = page.getByRole('dialog', { name: uiText('Manage fields', '字段管理') })
      const ownerRow = drawer.locator('.dbw-field-row').filter({ hasText: 'Owner' })
      await ownerRow.getByRole('button', { name: 'Owner', exact: true }).click()
      const renameInput = drawer.locator('.dbw-field-copy input').first()
      await renameInput.fill('Assignee')
      await renameInput.press('Enter')

      const assigneeRow = drawer.locator('.dbw-field-row').filter({ hasText: 'Assignee' })
      await expect(assigneeRow).toBeVisible()
      await assigneeRow.getByRole('button', { name: uiText('Move up', '上移'), exact: true }).click()
      await assigneeRow.getByRole('button', { name: uiText('Hide', '隐藏') }).click()
      await drawer.getByRole('button', { name: uiText('Close', '关闭') }).click()
      await expect(fieldsButton).toBeFocused()
      await expect(page.locator('.dbw-table thead th').filter({ hasText: 'Assignee' })).toHaveCount(0)

      await page.getByRole('button', { name: /Fields|字段/ }).click()
      const reopenedDrawer = page.getByRole('dialog', { name: uiText('Manage fields', '字段管理') })
      const reopenedAssigneeRow = reopenedDrawer.locator('.dbw-field-row').filter({ hasText: 'Assignee' })
      await reopenedAssigneeRow.getByRole('button', { name: uiText('Show', '显示') }).click()
      await reopenedAssigneeRow.getByRole('button', { name: uiText('Delete field', '删除字段') }).click()
      const confirm = page.getByRole('alertdialog')
      await confirm.getByRole('button', { name: uiText('Delete field', '删除字段') }).click()
      await expect(reopenedDrawer.locator('.dbw-field-row').filter({ hasText: 'Assignee' })).toHaveCount(0)
    })
  })

  test('links records, applies a bulk field update, unlinks, and bulk deletes', async () => {
    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await createDatabase(page, 'Bulk records', 'Selection workflows')
      await addField(page, 'Notes', 'text')
      await createRecord(page, 'Linked record', undefined, 'Home/Product')
      await createRecord(page, 'Plain record')

      for (const title of ['Linked record', 'Plain record']) {
        const row = page.locator('.dbw-table tbody tr').filter({ hasText: title })
        await row.locator('.dbw-select-column input[type="checkbox"]').check()
      }

      const selectionToolbar = page.locator('.dbw-selection-toolbar')
      await expect(selectionToolbar).toContainText(/2 selected|已选 2 条/)
      await selectionToolbar.locator('input.catalog-cell-input:not([type="date"])').fill('Reviewed together')
      await selectionToolbar.getByRole('button', { name: /Apply|应用/ }).click()
      await selectionToolbar.getByRole('button', { name: /Unlink documents|解除文档关联/ }).click()

      await expect.poll(async () => page.evaluate(async () => {
        const database = (await window.knowbook.getDatabases()).find((candidate) => candidate.name === 'Bulk records')
        if (!database) return null
        const notes = (await window.knowbook.getDocumentDatabaseColumns(database.id)).find((column) => column.name === 'Notes')
        const entities = await window.knowbook.getDatabaseEntities(database.id)
        return notes ? entities
          .map((entity) => ({ title: entity.title, note: entity.fieldValues[notes.id], documentId: entity.documentId }))
          .sort((left, right) => left.title.localeCompare(right.title)) : null
      })).toEqual([
        { title: 'Linked record', note: 'Reviewed together', documentId: null },
        { title: 'Plain record', note: 'Reviewed together', documentId: null }
      ])

      await selectionToolbar.getByRole('button', { name: uiText('Delete record', '删除记录') }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: uiText('Delete record', '删除记录') }).click()
      await expect(page.locator('.dbw-empty-state')).toBeVisible()
    })
  })

  test('uses application dialogs for destructive actions', async () => {
    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      await createDatabase(page, 'Disposable', 'Delete confirmation')
      await page.getByLabel(uiText('Database settings', '数据库设置')).click()
      await page.getByRole('button', { name: uiText('Delete database', '删除数据库') }).click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toContainText('Disposable')
      const cancelButton = dialog.getByRole('button', { name: uiText('Cancel', '取消') })
      const confirmButton = dialog.getByRole('button', { name: uiText('Delete database', '删除数据库') })
      await expect(cancelButton).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(confirmButton).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(cancelButton).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(page.locator('.dbw-source-trigger')).toContainText('Disposable')
    })
  })

  test('captures the supported desktop workspace sizes', async ({}, testInfo: TestInfo) => {
    await withElectronApp(async ({ page }) => {
      await openDatabasePage(page)
      for (const size of [
        { width: 1600, height: 1000 },
        { width: 1280, height: 800 },
        { width: 1024, height: 768 },
        { width: 960, height: 720 },
        { width: 900, height: 680 }
      ]) {
        await page.setViewportSize(size)
        await expect(page.locator('.dbw-shell')).toBeVisible()
        await page.screenshot({ path: testInfo.outputPath(`database-workspace-${size.width}x${size.height}.png`), fullPage: true })
      }
    })
  })
})
