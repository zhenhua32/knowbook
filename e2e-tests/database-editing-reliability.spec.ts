import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

const sourceName = 'Editing reliability'

async function seedDatabase(page: Page) {
  const ids = await page.evaluate(async (name) => {
    const database = await window.knowbook.createDocumentDatabase({ name, description: 'Reliable editing and save feedback.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const record = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Original record', fieldValues: { [field.id]: 'Saved note' } })
    const document = (await window.knowbook.getDocumentCatalog())[0]
    return { database: database.id, field: field.id, record: record.id, document: document.id }
  }, sourceName)
  await page.reload()
  await openSource(page)
  return ids
}

async function openSource(page: Page) {
  await page.getByTitle(uiText('Database', '数据库')).click({ noWaitAfter: true })
  await expect(page.locator('.dbw-source-trigger')).toBeVisible()
  await page.locator('.dbw-source-trigger').click()
  await page.locator('.dbw-source-list').getByRole('button', { name: new RegExp(sourceName) }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(sourceName)
  await expect(page.locator('.dbw-table')).toBeVisible()
}

async function expectReadable(locator: Locator) {
  await expect(locator).toBeVisible()
  const contrast = await locator.evaluate(element => {
    const rgba = (color: string) => color.match(/[\d.]+/g)!.map(Number)
    const over = (front: number[], back: number[]) => front.slice(0, 3).map((value, i) => value * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)))
    const layers: number[][] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor)
      layers.push(color)
      if ((color[3] ?? 1) === 1) break
    }
    if ((layers.at(-1)?.[3] ?? 1) !== 1) throw new Error('Missing opaque background')
    const background = layers.reverse().reduce((back, front) => over(front, back), [255, 255, 255])
    const foreground = over(rgba(getComputedStyle(element).color), background)
    const luminance = (color: number[]) => color.map(channel => {
      const value = channel / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    }).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0)
    const a = luminance(foreground), b = luminance(background)
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
  })
  expect(contrast).toBeGreaterThanOrEqual(4.5)
}

test('database text edits respect IME and Escape without saving discarded values @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    const ids = await seedDatabase(page)
    const readValue = () => page.evaluate(async ids => (await window.knowbook.getDatabaseEntities(ids.database)).find(record => record.id === ids.record)!.fieldValues[ids.field], ids)
    const cell = page.locator('.dbw-table tbody').getByLabel('Notes', { exact: true })
    await cell.fill('Discard this edit')
    await cell.press('Escape')
    await expect(cell).toHaveValue('Saved note')
    expect(await readValue()).toBe('Saved note')
    await cell.fill('输入法确认')
    await cell.dispatchEvent('compositionstart')
    await cell.press('Enter')
    await expect(cell).toBeFocused()
    expect(await readValue()).toBe('Saved note')
    await cell.dispatchEvent('compositionend')
    await cell.press('Enter')
    await expect.poll(readValue).toBe('输入法确认')

    await page.getByRole('button', { name: 'Original record', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: uiText('Record details', '记录详情') })
    const input = drawer.getByLabel('Notes', { exact: true })
    await input.focus()
    await input.dispatchEvent('compositionstart')
    await input.press('Escape')
    await expect(drawer).toBeVisible()
    await expect(input).toBeFocused()
    await input.dispatchEvent('compositionend')
    await input.fill('Keep the drawer open')
    await input.press('Escape')
    await expect(drawer).toBeVisible()
    await expect(input).toHaveValue('输入法确认')
    await drawer.getByRole('button', { name: uiText('Save', '保存'), exact: true }).click()
    await expect(drawer).toBeHidden()
    expect(await readValue()).toBe('输入法确认')
  })
})

test('record forms retain failed drafts, reject duplicate saves and remain readable in both themes @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 960, height: 800 })
    const ids = await seedDatabase(page)
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: unknown, input: unknown) => unknown
      type Pending = { kind: string; event: unknown; input: unknown; original: Handler; resolve: (value: unknown) => void; reject: (error: Error) => void }
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
      const pending: Pending[] = []
      process.env.KNOWBOOK_DB_EDIT_REQUESTS = '[]'
      for (const kind of ['create', 'update']) {
        const channel = `knowbook:${kind}-database-entity`
        const original = handlers.get(channel)!
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (event, input) => new Promise((resolve, reject) => {
          pending.push({ kind, event, input, original, resolve, reject })
          process.env.KNOWBOOK_DB_EDIT_REQUESTS = JSON.stringify(pending.map(request => ({ kind: request.kind, input: request.input })))
        }))
      }
      ipcMain.on('knowbook:test-db-edit-settle', (_event, result: { index: number; fail: boolean }) => {
        const request = pending[result.index]
        if (result.fail) request.reject(new Error('The isolated record save failed.'))
        else Promise.resolve(request.original(request.event, request.input)).then(request.resolve, request.reject)
      })
    })
    const requests = () => app.evaluate(() => JSON.parse(process.env.KNOWBOOK_DB_EDIT_REQUESTS!))
    const settle = (index: number, fail: boolean) => app.evaluate(({ ipcMain }, result) => { ipcMain.emit('knowbook:test-db-edit-settle', null, result) }, { index, fail })
    await page.getByRole('button', { name: uiText('New record', '新建记录') }).click()
    const dialog = page.getByRole('dialog', { name: uiText('Create record', '新建记录') })
    const title = dialog.getByLabel(/Title|标题/)
    const note = dialog.getByLabel('Notes', { exact: true })
    await title.fill('Retained draft')
    await note.fill('Retained property')
    await dialog.getByLabel(/Linked document|关联文档/).selectOption(ids.document)
    await dialog.getByRole('button', { name: uiText('Create and add another', '创建并继续添加'), exact: true }).click()
    await expect.poll(requests).toHaveLength(1)
    await expect(dialog).toHaveAttribute('aria-busy', 'true')
    await expect(title).toBeDisabled()
    await expect(note).toBeDisabled()
    await expect(dialog.locator('footer button')).toHaveCount(2)
    for (const button of await dialog.locator('footer button').all()) await expect(button).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    await expect(dialog).toBeFocused()
    expect(await requests()).toHaveLength(1)
    await settle(0, true)
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(title).toHaveValue('Retained draft')
    await expect(note).toHaveValue('Retained property')
    await expect(dialog.getByLabel(/Linked document|关联文档/)).toHaveValue(ids.document)
    await dialog.screenshot({ path: testInfo.outputPath('create-retry-light.png') })
    await dialog.getByRole('button', { name: uiText('Create and add another', '创建并继续添加'), exact: true }).click()
    await expect.poll(requests).toHaveLength(2)
    await settle(1, false)
    await expect(title).toHaveValue('')
    await expect(note).toHaveValue('')
    await expect(title).toBeFocused()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await dialog.getByRole('button', { name: uiText('Close', '关闭'), exact: true }).click()

    await page.locator('.dbw-record-title').filter({ has: page.locator('strong', { hasText: /^Retained draft$/ }) }).click()
    const drawer = page.getByRole('dialog', { name: uiText('Record details', '记录详情') })
    const notificationBounds = await page.locator('.app-notifications').boundingBox()
    const drawerBounds = await drawer.boundingBox()
    expect(notificationBounds!.x + notificationBounds!.width).toBeLessThanOrEqual(drawerBounds!.x - 16)
    await drawer.getByLabel(uiText('Title', '标题')).fill('Saved after retry')
    await drawer.getByLabel('Notes', { exact: true }).fill('Saved property after retry')
    await drawer.getByRole('button', { name: uiText('Save', '保存'), exact: true }).click()
    await expect.poll(requests).toHaveLength(3)
    await expect(drawer.getByRole('button', { name: uiText('Saving…', '正在保存…'), exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeVisible()
    await settle(2, true)
    await expect(drawer.getByRole('alert')).toBeVisible()
    await expect(drawer.getByLabel(uiText('Title', '标题'))).toHaveValue('Saved after retry')
    await expect(drawer.getByLabel('Notes', { exact: true })).toHaveValue('Saved property after retry')
    await drawer.getByRole('button', { name: uiText('Save', '保存'), exact: true }).click()
    await expect.poll(requests).toHaveLength(4)
    await settle(3, false)
    await expect(drawer).toBeHidden()
    await expect.poll(() => page.evaluate(async ids => (await window.knowbook.getDatabaseEntities(ids.database)).find(record => record.title === 'Saved after retry')?.fieldValues[ids.field], ids)).toBe('Saved property after retry')

    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.evaluate(() => window.knowbook.saveSetting('appearance.theme', 'dark'))
        await page.reload()
        await openSource(page)
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      }
      const newRecord = page.getByRole('button', { name: uiText('New record', '新建记录') })
      await expectReadable(newRecord)
      await newRecord.hover()
      await expectReadable(newRecord)
      await page.locator('.dbw-table tbody tr').first().locator('.dbw-select-column input').check()
      const toolbar = page.locator('.dbw-selection-toolbar')
      await expectReadable(toolbar.locator('strong').first())
      await expectReadable(toolbar.getByRole('button', { name: uiText('Delete record', '删除记录') }))
      await page.screenshot({ path: testInfo.outputPath(`database-selection-${theme}.png`) })
      await page.locator('.dbw-record-title').filter({ has: page.locator('strong', { hasText: /^Saved after retry$/ }) }).click()
      await expectReadable(drawer.getByRole('button', { name: uiText('Save', '保存'), exact: true }))
      await drawer.screenshot({ path: testInfo.outputPath(`database-record-${theme}.png`) })
      await drawer.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    }
    expect(errors).toEqual([])
  })
})

test('a failed list refresh does not turn a successful creation into a duplicate retry @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seedDatabase(page)
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: unknown, input: unknown) => unknown
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
      const create = handlers.get('knowbook:create-database-entity')!
      const read = handlers.get('knowbook:get-database-entities')!
      let failNextRefresh = false
      ipcMain.removeHandler('knowbook:create-database-entity')
      ipcMain.handle('knowbook:create-database-entity', async (event, input) => {
        const record = await create(event, input)
        failNextRefresh = true
        return record
      })
      ipcMain.removeHandler('knowbook:get-database-entities')
      ipcMain.handle('knowbook:get-database-entities', (event, input) => {
        if (failNextRefresh) {
          failNextRefresh = false
          throw new Error('The isolated database refresh failed.')
        }
        return read(event, input)
      })
    })
    await page.getByRole('button', { name: uiText('New record', '新建记录') }).click()
    const dialog = page.getByRole('dialog', { name: uiText('Create record', '新建记录') })
    const title = dialog.getByLabel(/Title|标题/)
    await title.fill('Already saved once')
    await dialog.getByRole('button', { name: uiText('Create and add another', '创建并继续添加') }).click()
    await expect(title).toHaveValue('')
    await expect(title).toBeFocused()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.app-notifications')).toContainText(/The record was saved|记录已保存/)
    expect(await page.evaluate(async id => (await window.knowbook.getDatabaseEntities(id)).filter(record => record.title === 'Already saved once').length, ids.database)).toBe(1)
  })
})
