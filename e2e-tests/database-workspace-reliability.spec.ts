import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

async function openDatabase(page: Page, name: string) {
  await page.getByTitle('数据库', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(name)
}

async function seedCustomDatabase(page: Page, count = 1) {
  const ids = await page.evaluate(async count => {
    const database = await window.knowbook.createDocumentDatabase({ name: '操作可靠性' })
    const owner = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Owner', type: 'text' })
    for (let index = 0; index < count; index++) {
      await window.knowbook.createDatabaseEntity({ databaseId: database.id,
        title: `${index < 5 ? 'Match entry' : 'Record'} ${String(index).padStart(4, '0')}`,
        fieldValues: { [owner.id]: 'Original owner' } })
    }
    const fields = ['__title__', owner.id, '__document__', '__created_at__', '__updated_at__']
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: '操作视图', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: fields, fieldOrder: fields, columnWidths: { __title__: 300, [owner.id]: 220 }, cardFieldIds: [owner.id]
    } })
    await window.knowbook.saveSetting('ui.language', 'zh-CN')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { database: database.id, owner: owner.id }
  }, count)
  await page.reload()
  await openDatabase(page, '操作可靠性')
  return ids
}

test('deep table scrolling can filter to five results and clear search without a blank viewport @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 })
    const ids = await seedCustomDatabase(page, 1000)
    const scroll = page.locator('.dbw-table-scroll')
    const titles = page.locator('.dbw-table .dbw-record-title strong')
    await scroll.hover()
    await page.mouse.wheel(0, 14000)
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(5000)
    expect(await titles.count()).toBeLessThan(40)
    await page.mouse.wheel(240, 0)
    await expect.poll(() => scroll.evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
    const left = await scroll.evaluate(node => node.scrollLeft)
    const search = page.getByLabel('搜索记录…', { exact: true })
    await search.fill('Match entry')
    await expect(titles).toHaveText(Array.from({ length: 5 }, (_, index) => `Match entry ${String(index).padStart(4, '0')}`))
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0)
    expect(await scroll.evaluate(node => node.scrollLeft)).toBe(left)
    await scroll.screenshot({ path: testInfo.outputPath('filtered-table.png') })
    await page.getByRole('button', { name: '清除搜索', exact: true }).click()
    await expect(search).toBeFocused()
    await expect(search).toHaveValue('')
    await expect(titles.first()).toHaveText('Match entry 0000')
    expect(await titles.count()).toBeGreaterThan(5)
    expect(await titles.count()).toBeLessThan(40)
    expect(await scroll.evaluate(node => node.scrollTop)).toBe(0)
    expect((await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)).length).toBe(1000)
  })
})

test('numeric conditions retain native numeric input and saved number semantics after clearing @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    const ids = await page.evaluate(async () => {
      for (const [name, count] of [['Low', 3], ['Medium', 999], ['High', 1001]] as const) {
        const document = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(document.id, { title: `Numeric boundary ${name}`, summary: '',
          blocks: Array.from({ length: count }, (_, index) => ({ type: 'paragraph', content: `Block ${index}`, checked: false, depth: 0 })) })
      }
      const database = (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')!
      const fields = ['__title__', '__block_count__']
      const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: '数值边界', config: {
        version: 1, layout: 'table', query: 'Numeric boundary', filters: { operator: 'and', rules: [
          { id: 'numeric-boundary', fieldId: '__block_count__', operator: 'greater-than', value: 5 }
        ] }, sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
        visibleFieldIds: fields, fieldOrder: fields, columnWidths: {}, cardFieldIds: []
      } })
      await window.knowbook.saveSetting('ui.language', 'zh-CN')
      window.localStorage.setItem('knowbook.database.last-source', database.id)
      window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
      return { database: database.id, view: view.id }
    })
    await page.reload()
    await page.getByTitle('数据库', { exact: true }).click()
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    const value = page.getByRole('group', { name: '筛选 1', exact: true }).getByLabel('值 1', { exact: true })
    await expect(value).toHaveAttribute('type', 'number')
    await value.press('ControlOrMeta+A')
    await value.press('Backspace')
    await expect(value).toHaveAttribute('type', 'number')
    await value.pressSequentially('1e3')
    await expect(value).toHaveValue('1000')
    await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Numeric boundary High'])
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    await page.getByRole('button', { name: '保存更改', exact: true }).click()
    await expect.poll(() => page.evaluate(async ids => {
      const rule = (await window.knowbook.getDatabaseSavedViews(ids.database)).find(view => view.id === ids.view)?.config.filters.rules[0]
      return rule && !('rules' in rule) ? rule.value : undefined
    }, ids)).toBe(1000)
    await page.reload()
    await page.getByTitle('数据库', { exact: true }).click()
    await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Numeric boundary High'])
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    await expect(value).toHaveAttribute('type', 'number')
    await expect(value).toHaveValue('1000')
  })
})

for (const theme of ['light', 'dark']) {
  test(`field submission retains failed drafts and treats persisted changes as success in ${theme} theme @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seedCustomDatabase(page)
      await page.evaluate(theme => window.knowbook.saveSetting('appearance.theme', theme), theme)
      await page.reload()
      await openDatabase(page, '操作可靠性')
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: unknown, input: unknown) => unknown
        type Pending = { event: unknown; input: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
        const create = handlers.get('knowbook:create-document-database-column')!
        const read = handlers.get('knowbook:get-database-entities')!
        const pending: Pending[] = []
        let failNextRefresh = false
        process.env.KNOWBOOK_FIELD_REQUEST_COUNT = '0'
        ipcMain.removeHandler('knowbook:create-document-database-column')
        ipcMain.handle('knowbook:create-document-database-column', (event, input) => new Promise((resolve, reject) => {
          pending.push({ event, input, resolve, reject })
          process.env.KNOWBOOK_FIELD_REQUEST_COUNT = String(pending.length)
        }))
        ipcMain.on('knowbook:test-field-settle', (_event, result: { index: number; fail: boolean }) => {
          const request = pending[result.index]
          if (result.fail) request.reject(new Error('The isolated field save failed.'))
          else Promise.resolve(create(request.event, request.input)).then(value => {
            failNextRefresh = true
            request.resolve(value)
          }, request.reject)
        })
        ipcMain.removeHandler('knowbook:get-database-entities')
        ipcMain.handle('knowbook:get-database-entities', (event, input) => {
          if (failNextRefresh) { failNextRefresh = false; throw new Error('The isolated field list refresh failed.') }
          return read(event, input)
        })
      })
      const requestCount = () => app.evaluate(() => Number(process.env.KNOWBOOK_FIELD_REQUEST_COUNT))
      const settle = (index: number, fail: boolean) => app.evaluate(({ ipcMain }, result) => {
        ipcMain.emit('knowbook:test-field-settle', null, result)
      }, { index, fail })
      await page.getByRole('button', { name: /^字段/ }).click()
      const drawer = page.getByRole('dialog', { name: '字段管理', exact: true })
      await drawer.getByRole('button', { name: '＋ 新增字段', exact: true }).click()
      const name = drawer.getByLabel('名称', { exact: true })
      const type = drawer.getByLabel('字段类型', { exact: true })
      await name.fill('Stage')
      await type.selectOption('select')
      const options = drawer.getByLabel('选项（逗号分隔）', { exact: true })
      await options.fill('Low, High')
      await drawer.getByRole('button', { name: '创建', exact: true }).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click() })
      await expect.poll(requestCount).toBe(1)
      await expect(drawer).toHaveAttribute('aria-busy', 'true')
      await expect(name).toBeDisabled()
      await expect(drawer.getByRole('status')).toHaveText('正在创建…')
      await expect(drawer.getByRole('button', { name: '关闭', exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(drawer).toBeVisible()
      await settle(0, true)
      await expect(drawer.getByRole('alert')).toHaveText('操作失败，请重试。')
      await expect(name).toHaveValue('Stage')
      await expect(name).toBeEnabled()
      await expect(type).toHaveValue('select')
      await expect(type.locator('option:checked')).toHaveText('单选')
      await expect(options).toHaveValue('Low, High')
      await drawer.screenshot({ path: testInfo.outputPath(`field-failure-${theme}.png`) })
      await drawer.getByRole('button', { name: '创建', exact: true }).click()
      await expect.poll(requestCount).toBe(2)
      await settle(1, false)
      await expect(drawer.locator('.dbw-field-create-form')).toHaveCount(0)
      await expect(page.locator('.app-notifications')).toContainText('字段已保存，但列表刷新失败，请刷新数据库。')
      expect((await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), ids.database)).filter(field => field.name === 'Stage')).toHaveLength(1)
      await drawer.getByRole('button', { name: '关闭', exact: true }).click()
      await page.reload()
      await openDatabase(page, '操作可靠性')
      await page.getByRole('button', { name: /^字段/ }).click()
      await expect(drawer.getByRole('button', { name: 'Stage', exact: true })).toBeVisible()
      await expect(drawer.getByLabel('选项（逗号分隔） · Stage', { exact: true })).toHaveValue('Low, High')
      expect(await requestCount()).toBe(2)
      expect(errors).toEqual([])
    })
  })
}
