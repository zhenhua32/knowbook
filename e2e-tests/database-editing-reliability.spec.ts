import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

const sourceName = 'Editing reliability'

async function seedDatabase(page: Page, language?: 'en-US' | 'zh-CN') {
  const ids = await page.evaluate(async ({ name, language }) => {
    const database = await window.knowbook.createDocumentDatabase({ name, description: 'Reliable editing and save feedback.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const record = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Original record', fieldValues: { [field.id]: 'Saved note' } })
    const document = (await window.knowbook.getDocumentCatalog())[0]
    if (language) {
      await window.knowbook.saveSetting('ui.language', language)
      await window.knowbook.saveSetting('appearance.theme', 'light')
    }
    return { database: database.id, field: field.id, record: record.id, document: document.id }
  }, { name: sourceName, language })
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

async function setRecordFailure(app: ElectronApplication, databaseId: string, enabled: boolean) {
  await app.evaluate(({ app }, { databaseId, enabled }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_record_create_failure')
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_record_update_failure')
      if (enabled) {
        const id = databaseId.replace(/'/g, "''")
        database.exec("CREATE TRIGGER knowbook_e2e_record_create_failure BEFORE INSERT ON database_entities WHEN NEW.database_id = '" + id +
          "' AND NEW.title = 'Retained draft' BEGIN SELECT RAISE(ABORT, 'The isolated record creation is temporarily unavailable.'); END")
        database.exec("CREATE TRIGGER knowbook_e2e_record_update_failure BEFORE UPDATE ON database_entities WHEN NEW.database_id = '" + id +
          "' AND NEW.title = 'Saved after retry' BEGIN SELECT RAISE(ABORT, 'The isolated record update is temporarily unavailable.'); END")
      }
    } finally { database.close() }
  }, { databaseId, enabled })
}

async function refreshCatalogThroughRealMutation(page: Page, app: ElectronApplication, scope: Locator) {
  const before = await app.evaluate(() => Number(process.env.KNOWBOOK_DB_EDIT_CATALOG_READS))
  // The production captured-document handler emits workspace-mutated; Shell
  // then reads HomeData and the paged catalog without navigating away.
  const created = await page.evaluate(() => window.knowbook.createQuickNote({
    title: 'Background catalog refresh', content: 'Isolated catalog refresh probe.', parentId: null
  }))
  await expect.poll(() => app.evaluate(() => Number(process.env.KNOWBOOK_DB_EDIT_CATALOG_READS))).toBeGreaterThan(before)
  await expect(scope.getByLabel(/Linked document|关联文档/).locator(`option[value="${created.id}"]`)).toHaveCount(1)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  return created.id
}

async function tabTo(page: Page, target: Locator, limit = 16) {
  let reached = false
  for (let step = 0; step < limit; step++) {
    await page.keyboard.press('Tab')
    const state = await target.evaluate(element => ({ reached: document.activeElement === element, tag: document.activeElement?.tagName }))
    reached = state.reached
    if (reached || state.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function expectDescribedFailure(scope: Locator, button: Locator) {
  const alert = scope.getByRole('alert')
  await expect(alert).toHaveCount(1)
  await expect(alert).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
  await expect(alert).not.toContainText(/SqliteError|Error invoking|remote method|temporarily unavailable/i)
  const alertId = await alert.getAttribute('id')
  expect(alertId).toBeTruthy()
  const describedIds = (await button.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  expect(describedIds).toContain(alertId)
}

async function recordDraft(page: Page, app: ElectronApplication, testInfo: TestInfo, scope: Locator, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await scope.evaluate(element => ({
    focused: document.activeElement === element, ariaBusy: element.getAttribute('aria-busy'),
    controls: Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')).map(input => ({
      label: input.getAttribute('aria-label') ?? input.closest('label')?.querySelector('span')?.textContent,
      value: input.value, disabled: input.disabled, focused: document.activeElement === input
    })),
    alerts: Array.from(element.querySelectorAll('[role=alert]')).map(alert => ({ id: alert.id, text: alert.textContent })),
    buttons: Array.from(element.querySelectorAll<HTMLButtonElement>('footer button')).map(button => ({
      text: button.textContent, disabled: button.disabled, describedBy: button.getAttribute('aria-describedby'), focused: document.activeElement === button
    }))
  }))
  const probe = await app.evaluate(() => ({
    requests: JSON.parse(process.env.KNOWBOOK_DB_EDIT_REQUESTS!), failures: JSON.parse(process.env.KNOWBOOK_DB_EDIT_FAILURES!),
    catalogReads: Number(process.env.KNOWBOOK_DB_EDIT_CATALOG_READS)
  }))
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ windows, state, probe }, null, 2))
  await testInfo.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
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
    // Start the IME interaction after the drawer's initial focus frame has completed.
    await expect(drawer.locator('.dbw-drawer-header .dbw-icon-button')).toBeFocused()
    await input.focus()
    await expect(input).toBeFocused()
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

for (const language of ['en-US', 'zh-CN'] as const) {
test(`record forms retain dirty and failed drafts through real catalog refreshes in ${language} @electron`, async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 960, height: 800 })
    const ids = await seedDatabase(page, language)
    const originalRecords = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: unknown, input: unknown) => unknown
      type Pending = { kind: string; event: unknown; input: unknown; original: Handler; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
      const pending: Pending[] = []
      const failures: string[] = []
      process.env.KNOWBOOK_DB_EDIT_REQUESTS = '[]'
      process.env.KNOWBOOK_DB_EDIT_FAILURES = '[]'
      process.env.KNOWBOOK_DB_EDIT_CATALOG_READS = '0'
      for (const kind of ['create', 'update']) {
        const channel = `knowbook:${kind}-database-entity`
        const original = handlers.get(channel)!
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (event, input) => new Promise((resolve, reject) => {
          pending.push({ kind, event, input, original, settled: false, resolve, reject })
          process.env.KNOWBOOK_DB_EDIT_REQUESTS = JSON.stringify(pending.map(request => ({ kind: request.kind, input: request.input })))
        }))
      }
      const readCatalog = handlers.get('knowbook:get-document-catalog-page')!
      if (!readCatalog) throw new Error('The real paged catalog handler is required')
      ipcMain.removeHandler('knowbook:get-document-catalog-page')
      ipcMain.handle('knowbook:get-document-catalog-page', async (event, input) => {
        const result = await readCatalog(event, input)
        process.env.KNOWBOOK_DB_EDIT_CATALOG_READS = String(Number(process.env.KNOWBOOK_DB_EDIT_CATALOG_READS) + 1)
        return result
      })
      ipcMain.on('knowbook:test-db-edit-settle', (_event, result: { index: number }) => {
        const request = pending[result.index]
        if (!request || request.settled) throw new Error('No unsettled real record mutation is pending')
        request.settled = true
        // The original SQLite handler produces both the trigger failure and
        // successful retry; Inspector evaluation returns before settlement.
        setImmediate(async () => {
          try { request.resolve(await request.original(request.event, request.input)) }
          catch (error) {
            const reason = error instanceof Error ? error : new Error(String(error))
            failures.push(reason.message)
            process.env.KNOWBOOK_DB_EDIT_FAILURES = JSON.stringify(failures)
            request.reject(reason)
          }
        })
      })
    })
    const requests = () => app.evaluate(() => JSON.parse(process.env.KNOWBOOK_DB_EDIT_REQUESTS!))
    const settle = (index: number) => app.evaluate(({ ipcMain }, result) => { ipcMain.emit('knowbook:test-db-edit-settle', null, result) }, { index })
    await setRecordFailure(app, ids.database, true)
    await page.getByRole('button', { name: uiText('New record', '新建记录') }).click()
    const dialog = page.getByRole('dialog', { name: uiText('Create record', '新建记录') })
    const title = dialog.getByLabel(/Title|标题/)
    const note = dialog.getByLabel('Notes', { exact: true })
    await title.fill('Retained draft')
    await note.fill('Retained property')
    await dialog.getByLabel(/Linked document|关联文档/).selectOption(ids.document)
    await note.click()
    await expect(note).toBeFocused()
    const alternateDocument = await refreshCatalogThroughRealMutation(page, app, dialog)
    await recordDraft(page, app, testInfo, dialog, `${language}-create-dirty-catalog-refresh`)
    await expect(title).toHaveValue('Retained draft')
    await expect(note).toHaveValue('Retained property')
    await expect(dialog.getByLabel(/Linked document|关联文档/)).toHaveValue(ids.document)
    await expect(note).toBeFocused()
    expect(await requests()).toHaveLength(0)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)).toEqual(originalRecords)
    const continueButton = dialog.getByRole('button', { name: uiText('Create and add another', '创建并继续添加'), exact: true })
    await tabTo(page, continueButton)
    await page.keyboard.press('Enter')
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
    await recordDraft(page, app, testInfo, dialog, `${language}-create-pending-locked`)
    await settle(0)
    await expect(dialog.getByRole('alert')).toBeVisible()
    await recordDraft(page, app, testInfo, dialog, `${language}-create-real-sqlite-failure`)
    await expectDescribedFailure(dialog, continueButton)
    await expectDescribedFailure(dialog, dialog.locator('footer .dbw-primary-button'))
    await expect(title).toHaveValue('Retained draft')
    await expect(note).toHaveValue('Retained property')
    await expect(dialog.getByLabel(/Linked document|关联文档/)).toHaveValue(ids.document)
    await dialog.screenshot({ path: testInfo.outputPath('create-retry-light.png') })
    await note.click()
    await expect(note).toBeFocused()
    await refreshCatalogThroughRealMutation(page, app, dialog)
    await recordDraft(page, app, testInfo, dialog, `${language}-create-failed-catalog-refresh`)
    await expect(title).toHaveValue('Retained draft')
    await expect(note).toHaveValue('Retained property')
    await expect(dialog.getByLabel(/Linked document|关联文档/)).toHaveValue(ids.document)
    await expect(note).toBeFocused()
    await expectDescribedFailure(dialog, continueButton)
    expect(await requests()).toHaveLength(1)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)).toEqual(originalRecords)
    await setRecordFailure(app, ids.database, false)
    await tabTo(page, continueButton)
    await page.keyboard.press('Enter')
    await expect.poll(requests).toHaveLength(2)
    await settle(1)
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
    const storedBeforeEdit = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)
    const editTitle = drawer.getByLabel(uiText('Title', '标题'))
    const editNote = drawer.getByLabel('Notes', { exact: true })
    const editLinked = drawer.getByLabel(/Linked document|关联文档/)
    await expect(editLinked).toHaveCount(1)
    const saveButton = drawer.getByRole('button', { name: uiText('Save', '保存'), exact: true })
    await editTitle.fill('Saved after retry')
    await editLinked.selectOption(alternateDocument)
    await editNote.fill('Saved property after retry')
    await expect(editNote).toBeFocused()
    await refreshCatalogThroughRealMutation(page, app, drawer)
    await recordDraft(page, app, testInfo, drawer, `${language}-edit-dirty-catalog-refresh`)
    await expect(editTitle).toHaveValue('Saved after retry')
    await expect(editNote).toHaveValue('Saved property after retry')
    await expect(editLinked).toHaveValue(alternateDocument)
    await expect(editNote).toBeFocused()
    expect(await requests()).toHaveLength(2)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)).toEqual(storedBeforeEdit)
    await setRecordFailure(app, ids.database, true)
    await tabTo(page, saveButton)
    await page.keyboard.press('Enter')
    await expect.poll(requests).toHaveLength(3)
    await expect(drawer.getByRole('button', { name: uiText('Saving…', '正在保存…'), exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeVisible()
    await recordDraft(page, app, testInfo, drawer, `${language}-edit-pending-locked`)
    await settle(2)
    await expect(drawer.getByRole('alert')).toBeVisible()
    await recordDraft(page, app, testInfo, drawer, `${language}-edit-real-sqlite-failure`)
    await expectDescribedFailure(drawer, saveButton)
    await expect(drawer.getByLabel(uiText('Title', '标题'))).toHaveValue('Saved after retry')
    await expect(drawer.getByLabel('Notes', { exact: true })).toHaveValue('Saved property after retry')
    await expect(editLinked).toHaveValue(alternateDocument)
    await editNote.click()
    await expect(editNote).toBeFocused()
    await refreshCatalogThroughRealMutation(page, app, drawer)
    await recordDraft(page, app, testInfo, drawer, `${language}-edit-failed-catalog-refresh`)
    await expect(editTitle).toHaveValue('Saved after retry')
    await expect(editNote).toHaveValue('Saved property after retry')
    await expect(editLinked).toHaveValue(alternateDocument)
    await expect(editNote).toBeFocused()
    await expectDescribedFailure(drawer, saveButton)
    expect(await requests()).toHaveLength(3)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)).toEqual(storedBeforeEdit)
    await setRecordFailure(app, ids.database, false)
    await tabTo(page, saveButton)
    await page.keyboard.press('Enter')
    await expect.poll(requests).toHaveLength(4)
    await settle(3)
    await expect(drawer).toBeHidden()
    await expect.poll(() => page.evaluate(async ids => (await window.knowbook.getDatabaseEntities(ids.database)).find(record => record.title === 'Saved after retry')?.fieldValues[ids.field], ids)).toBe('Saved property after retry')
    const persisted = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)
    expect(persisted).toHaveLength(originalRecords.length + 1)
    expect(persisted.find(record => record.title === 'Saved after retry')?.documentId).toBe(alternateDocument)
    expect(persisted.find(record => record.id === ids.record)).toEqual(originalRecords.find(record => record.id === ids.record))
    const failures = await app.evaluate(() => JSON.parse(process.env.KNOWBOOK_DB_EDIT_FAILURES!))
    expect(failures).toEqual(['The isolated record creation is temporarily unavailable.', 'The isolated record update is temporarily unavailable.'])
    expect(await requests()).toHaveLength(4)

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
}

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
