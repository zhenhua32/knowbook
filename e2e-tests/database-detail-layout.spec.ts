import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function createDatabase(page: Page, name: string): Promise<void> {
  await page.getByTitle(uiText('Database', '数据库')).click({ noWaitAfter: true })
  await expect(page.locator('.dbw-shell')).toBeVisible()
  await page.locator('.dbw-source-trigger').click()
  await page.getByRole('button', { name: uiText('New database', '新建数据库') }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(uiText('Name', '名称')).fill(name)
  await dialog.getByRole('button', { name: uiText('Create', '创建') }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(name)
}

async function addField(page: Page, name: string, type: 'checkbox' | 'multi-select', options?: string): Promise<void> {
  await page.getByRole('button', { name: /Fields|字段/ }).click()
  const drawer = page.getByRole('dialog', { name: uiText('Manage fields', '字段管理') })
  await drawer.getByRole('button', { name: /Add field|新增字段/ }).click()
  await drawer.getByPlaceholder(uiText('Name', '名称')).fill(name)
  await drawer.locator('.dbw-field-create-form select').selectOption(type)
  if (options) await drawer.getByPlaceholder(/Options|选项/).fill(options)
  await drawer.getByRole('button', { name: uiText('Create', '创建') }).click()
  await expect(drawer.getByRole('button', { name, exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: uiText('Close', '关闭') }).click()
}

async function expectWithin(element: Locator, container: Locator): Promise<void> {
  await expect(element).toBeVisible()
  await expect.poll(async () => {
    const [inner, outer] = await Promise.all([element.boundingBox(), container.boundingBox()])
    return Boolean(inner && outer
      && inner.x >= outer.x - 1 && inner.y >= outer.y - 1
      && inner.x + inner.width <= outer.x + outer.width + 1
      && inner.y + inner.height <= outer.y + outer.height + 1)
  }).toBe(true)
}

async function expectCompactCheckbox(checkbox: Locator): Promise<void> {
  await expect(checkbox).toBeVisible()
  const box = await checkbox.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(12)
  expect(box!.width).toBeLessThanOrEqual(24)
  expect(Math.abs(box!.height - box!.width)).toBeLessThanOrEqual(1)
}

test.describe('Database layout details @electron', () => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

  test('keeps long source titles, management controls and filter popovers inside a narrow workspace', async ({}, testInfo) => {
    await withElectronApp(async ({ page }) => {
      await page.setViewportSize({ width: 820, height: 860 })
      await createDatabase(page, '产品研发与版本交付计划 '.repeat(12))

      const shell = page.locator('.dbw-shell')
      await expectWithin(page.locator('.dbw-source-trigger'), shell)
      await expectWithin(page.locator('.dbw-header-actions'), shell)
      await expectWithin(page.getByRole('button', { name: /Fields|字段/ }), shell)
      await expectWithin(page.locator('.dbw-toolbar-select'), shell)
      await expect.poll(() => shell.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)

      await page.locator('.dbw-toolbar-menu > summary').first().click()
      const filters = page.locator('.dbw-filter-popover')
      await filters.getByRole('button', { name: /Add filter|添加筛选/ }).click()
      await expectWithin(filters, shell)
      const rule = filters.locator('.dbw-filter-row')
      await rule.locator('select').nth(1).selectOption('is-empty')
      await expectWithin(rule.getByRole('button', { name: uiText('Delete', '删除') }), filters)
      await page.screenshot({ path: testInfo.outputPath('database-narrow-filter.png'), fullPage: true })

      // The field manager must remain reachable after reducing the window width.
      await page.locator('.dbw-toolbar-menu > summary').first().click()
      await page.getByRole('button', { name: /Fields|字段/ }).click()
      await expect(page.getByRole('dialog', { name: uiText('Manage fields', '字段管理') })).toBeVisible()
    })
  })

  test('keeps property controls compact and bottom-row multi-select options reachable without stretching rows', async ({}, testInfo) => {
    await withElectronApp(async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 })
      const databaseName = 'Property layout checks'
      await createDatabase(page, databaseName)
      await addField(page, 'Done', 'checkbox')
      await addField(page, 'Tags', 'multi-select', 'Red, Blue, Green, Amber, Purple, Orange, Cyan, Silver, Gold')

      // A real set of records gives the table a scroll boundary to exercise.
      await page.evaluate(async (name) => {
        const database = (await window.knowbook.getDatabases()).find((candidate) => candidate.name === name)
        if (!database) throw new Error('Layout test database was not created')
        for (let index = 0; index < 18; index += 1) {
          await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: `Layout record ${String(index).padStart(2, '0')}` })
        }
      }, databaseName)

      await page.getByRole('button', { name: uiText('New record', '新建记录') }).first().click()
      const dialog = page.getByRole('dialog', { name: uiText('Create record', '新建记录') })
      const longTitle = 'LongRecordTitle'.repeat(18)
      await dialog.getByLabel(/Title|标题/).fill(longTitle)
      await expectCompactCheckbox(dialog.getByRole('checkbox', { name: 'Done', exact: true }))
      await dialog.getByRole('checkbox', { name: 'Done', exact: true }).check()
      await expect(dialog.locator('label label')).toHaveCount(0)
      await dialog.locator('.dbw-multi-editor summary').click()
      const formMenu = dialog.locator('.dbw-multi-editor-menu')
      await expectWithin(formMenu, dialog.locator('.dbw-record-form'))
      await formMenu.getByRole('checkbox', { name: 'Blue', exact: true }).check()
      await dialog.locator('.dbw-multi-editor summary').click()
      await dialog.getByRole('button', { name: uiText('Create', '创建'), exact: true }).click()

      const longRow = page.locator('.dbw-table tbody tr').filter({ hasText: longTitle })
      await expect(longRow).toBeVisible()
      const longRowHeight = (await longRow.boundingBox())!.height
      expect(longRowHeight).toBeGreaterThanOrEqual(63)
      expect(longRowHeight).toBeLessThanOrEqual(65)

      // Check the same accessible controls in the edit drawer, not only creation.
      await longRow.locator('.dbw-record-title').click()
      const drawer = page.getByRole('dialog', { name: uiText('Record details', '记录详情') })
      await expectCompactCheckbox(drawer.getByRole('checkbox', { name: 'Done', exact: true }))
      await expect(drawer.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked()
      await expectWithin(drawer.locator('h2'), drawer)
      await expectWithin(drawer.getByRole('button', { name: uiText('Close', '关闭') }), drawer)
      await drawer.getByRole('button', { name: uiText('Close', '关闭') }).click()

      // Updating a property changes updatedAt. Use a stable sort so the edited
      // record stays at the scroll boundary while the workspace refreshes.
      const sortMenu = page.locator('.dbw-toolbar-menu').nth(1)
      await sortMenu.locator('summary').click()
      await sortMenu.getByRole('combobox', { name: uiText('Sort', '排序'), exact: true }).selectOption('__title__')
      await sortMenu.getByRole('combobox', { name: uiText('Ascending', '升序'), exact: true }).selectOption('asc')
      await sortMenu.locator('summary').click()
      const target = await page.evaluate(async ({ name, title }) => {
        const database = (await window.knowbook.getDatabases()).find((candidate) => candidate.name === name)
        if (!database) throw new Error('Layout test database disappeared')
        const record = (await window.knowbook.getDatabaseEntities(database.id)).find((candidate) => candidate.title === title)
        const tags = (await window.knowbook.getDocumentDatabaseColumns(database.id)).find((column) => column.name === 'Tags')
        if (!record || !tags) throw new Error('Layout test record or Tags field disappeared')
        return { databaseId: database.id, recordId: record.id, tagsId: tags.id }
      }, { name: databaseName, title: longTitle })

      const table = page.locator('.dbw-table-scroll')
      await table.evaluate((node) => { node.scrollTop = node.scrollHeight })
      await expect.poll(() => table.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1)
      await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)').last()).toContainText(longTitle)
      const bottomRow = longRow
      const summary = bottomRow.locator('.dbw-multi-editor summary')
      await summary.scrollIntoViewIfNeeded()
      const rowHeightBefore = (await bottomRow.boundingBox())!.height
      await summary.click()
      const menu = bottomRow.locator('.dbw-multi-editor-menu')
      await expectWithin(menu, table)
      const menuBox = (await menu.boundingBox())!
      const summaryBox = (await summary.boundingBox())!
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(summaryBox.y + 1)
      expect(Math.abs((await bottomRow.boundingBox())!.height - rowHeightBefore)).toBeLessThanOrEqual(1)
      await menu.getByRole('checkbox', { name: 'Gold', exact: true }).check()
      await expect.poll(() => page.evaluate(async ({ databaseId, recordId, tagsId }) => {
        const record = (await window.knowbook.getDatabaseEntities(databaseId)).find((candidate) => candidate.id === recordId)
        return record?.fieldValues[tagsId]
      }, target)).toEqual(['Blue', 'Gold'])
      await expect(menu.getByRole('checkbox', { name: 'Gold', exact: true })).toBeChecked()
      await expectWithin(menu, table)
      await page.screenshot({ path: testInfo.outputPath('database-bottom-multiselect.png'), fullPage: true })
    })
  })
})
