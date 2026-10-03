import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { DatabaseViewConfigV1, DeleteDatabaseEntitiesInput, DocumentDatabase } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type DeleteKind = 'database' | 'view' | 'field' | 'record' | 'records'
type DeleteInput = string | DeleteDatabaseEntitiesInput
type DeleteHandler = (event: IpcMainInvokeEvent, input: DeleteInput) => void | Promise<void>
type ReadHandler = (event: IpcMainInvokeEvent) => DocumentDatabase[] | Promise<DocumentDatabase[]>
type DeleteCall = { kind: DeleteKind; input: DeleteInput }
type Probe = {
  originals: Map<DeleteKind, DeleteHandler>; originalRead: ReadHandler; holdReads: boolean
  calls: DeleteCall[]; acknowledged: DeleteCall[]; failures: string[]; readsCompleted: number; readsFailed: number
  pending: Array<DeleteCall & { event: IpcMainInvokeEvent; resolve: () => void; reject: (error: Error) => void }>
  pendingReads: Array<{ event: IpcMainInvokeEvent; resolve: (value: DocumentDatabase[]) => void; reject: (error: Error) => void }>
}
type ProbeGlobal = typeof globalThis & { __knowbookDatabaseDeleteProbe?: Probe }
type ProbeWindow = Window & { __knowbookDatabaseDeleteRoute?: Array<{ phase: string; step: number; tag: string | null; label: string | null; text: string | null; reached: boolean }> }
const sourceName = 'Delete flow source'
const sourceDescription = 'Protected deletion fixture'
const source = (page: Page) => page.locator('.dbw-source-trigger')
const query = (page: Page) => page.getByRole('textbox', { name: uiText('Search records…', '搜索记录…'), exact: true })
const confirmation = (page: Page) => page.getByRole('alertdialog')
const form = (page: Page) => page.locator('form.dbw-dialog')
const viewTab = (page: Page, title: string) => page.locator('.dbw-view-tab').filter({ has: page.getByText(title, { exact: true }) })
const recovery = (page: Page) => page.getByRole('region', { name: uiText('Deleted, but refresh failed', '删除已完成，刷新失败'), exact: true })
const row = (page: Page, title: string) => page.locator('.dbw-table tbody tr').filter({ has: page.getByRole('button', { name: title, exact: true }) })

async function seed(page: Page, language: 'en-US' | 'zh-CN') {
  const fixture = await page.evaluate(async ({ sourceName, sourceDescription, language }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: sourceDescription })
    const removable = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Removable property', type: 'text' })
    const kept = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Protected property', type: 'text' })
    for (const [index, title] of ['Delete record 1', 'Delete record 2', 'Delete record 3'].entries()) {
      await window.knowbook.createDatabaseEntity({ databaseId: database.id, title,
        fieldValues: { [removable.id]: `Removable ${index}`, [kept.id]: `Protected ${index}` } })
    }
    const fieldIds = ['__title__', removable.id, kept.id]
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null }, visibleFieldIds: fieldIds,
      fieldOrder: fieldIds, columnWidths: { __title__: 280 }, cardFieldIds: [] }
    const keepView = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Keep view', config })
    const deleteView = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Delete view', config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, deleteView.id)
    return { database, removable, kept, keepView, deleteView, entities: await window.knowbook.getDatabaseEntities(database.id),
      catalog: (await window.knowbook.getDatabases()).find(candidate => candidate.kind === 'document-catalog')! }
  }, { sourceName, sourceDescription, language })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: language === 'zh-CN' ? 850 : 800 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(source(page)).toContainText(sourceName)
  await expect(viewTab(page, 'Delete view')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.dbw-table tbody .dbw-record-title')).toHaveCount(3)
  return fixture
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, DeleteHandler | ReadHandler> })._invokeHandlers
    const channels: Array<[DeleteKind, string]> = [['database', 'knowbook:delete-database'], ['view', 'knowbook:delete-database-saved-view'],
      ['field', 'knowbook:delete-document-database-column'], ['record', 'knowbook:delete-database-entity'], ['records', 'knowbook:delete-database-entities']]
    const originalRead = handlers.get('knowbook:get-databases') as ReadHandler
    if (!originalRead) throw new Error('The real database-list handler is required')
    const probe: Probe = { originals: new Map(), originalRead, holdReads: false, calls: [], acknowledged: [], failures: [],
      readsCompleted: 0, readsFailed: 0, pending: [], pendingReads: [] }
    ;(globalThis as ProbeGlobal).__knowbookDatabaseDeleteProbe = probe
    for (const [kind, channel] of channels) {
      const original = handlers.get(channel) as DeleteHandler
      if (!original) throw new Error(`The real delete handler is required: ${kind}`)
      probe.originals.set(kind, original)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, input: DeleteInput) => {
        probe.calls.push({ kind, input })
        return new Promise<void>((resolve, reject) => probe.pending.push({ kind, input, event, resolve, reject }))
      })
    }
    ipcMain.removeHandler('knowbook:get-databases')
    ipcMain.handle('knowbook:get-databases', async event => {
      if (probe.holdReads) return new Promise<DocumentDatabase[]>((resolve, reject) => probe.pendingReads.push({ event, resolve, reject }))
      const result = await probe.originalRead(event)
      probe.readsCompleted++
      return result
    })
  })
}

async function state(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookDatabaseDeleteProbe!
    return { calls: probe.calls, acknowledged: probe.acknowledged, failures: probe.failures, pending: probe.pending.map(({ kind, input }) => ({ kind, input })),
      readsCompleted: probe.readsCompleted, readsFailed: probe.readsFailed, holdReads: probe.holdReads, pendingReads: probe.pendingReads.length }
  })
}

async function finishDelete(app: ElectronApplication, page: Page, count: number, options: { failure?: boolean; holdRefresh?: boolean } = {}) {
  await app.evaluate((_electron, holdRefresh) => {
    const probe = (globalThis as ProbeGlobal).__knowbookDatabaseDeleteProbe!
    const pending = probe.pending.shift()
    if (!pending) throw new Error('No delete is pending')
    if (holdRefresh) probe.holdReads = true
    // The original SQLite mutation is the only producer of an acknowledgement.
    setImmediate(async () => {
      try {
        await probe.originals.get(pending.kind)!(pending.event, pending.input)
        probe.acknowledged.push({ kind: pending.kind, input: pending.input })
        pending.resolve()
      } catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error))
        probe.failures.push(reason.message)
        pending.reject(reason)
      }
    })
  }, Boolean(options.holdRefresh))
  await expect.poll(async () => {
    const probe = await state(app)
    return options.failure ? probe.failures.length : probe.acknowledged.length
  }).toBe(count)
  if (options.holdRefresh) await expect.poll(async () => (await state(app)).pendingReads).toBeGreaterThan(0)
  await twoFrames(page)
}

async function releaseRefresh(app: ElectronApplication, page: Page, fail = false) {
  const before = await state(app)
  await app.evaluate((_electron, fail) => {
    const probe = (globalThis as ProbeGlobal).__knowbookDatabaseDeleteProbe!
    probe.holdReads = false
    const reads = probe.pendingReads.splice(0)
    if (!reads.length) throw new Error('No database-list refresh is held')
    setImmediate(async () => {
      for (const read of reads) {
        try {
          if (fail) throw new Error('The database list is temporarily unavailable after deletion.')
          const result = await probe.originalRead(read.event)
          probe.readsCompleted++
          read.resolve(result)
        } catch (error) {
          probe.readsFailed++
          read.reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
  }, fail)
  await expect.poll(async () => {
    const probe = await state(app)
    return fail ? probe.readsFailed > before.readsFailed : probe.readsCompleted > before.readsCompleted
  }).toBe(true)
  await twoFrames(page)
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, phase: string, direction: 'Tab' | 'Shift+Tab' = 'Tab', limit = 24) {
  let reached = false
  for (let step = 1; step <= limit; step++) {
    await page.keyboard.press(direction)
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const result = { phase, step, tag: active?.tagName ?? null, label: active?.getAttribute('aria-label') ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null, reached: active === element }
      ;((window as ProbeWindow).__knowbookDatabaseDeleteRoute ??= []).push(result)
      return result
    }, { phase, step })
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function confirmWithKeyboard(page: Page, app: ElectronApplication, expectedCalls: number, options: { retry?: boolean; repeatWhilePending?: boolean } = {}) {
  const dialog = confirmation(page)
  await expect(dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  const confirm = options.retry ? dialog.getByRole('button', { name: uiText('Retry', '重试'), exact: true }) : dialog.locator('.danger-button')
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state(app)).calls.length).toBe(expectedCalls)
  if (options.repeatWhilePending !== false) {
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await page.keyboard.press('Escape')
  }
  expect((await state(app)).calls).toHaveLength(expectedCalls)
  await expect(dialog).toHaveAttribute('aria-busy', 'true')
  await expect(dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true })).toBeDisabled()
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const ui = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName, label: active?.getAttribute('aria-label'),
      text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null }, source: document.querySelector('.dbw-source-trigger')?.textContent?.trim(),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      views: Array.from(document.querySelectorAll('.dbw-view-tab')).map(tab => ({ title: tab.getAttribute('title'), current: tab.getAttribute('aria-current') })),
      rows: Array.from(document.querySelectorAll('.dbw-record-title strong')).map(title => title.textContent),
      dialogs: Array.from(document.querySelectorAll('[role="alertdialog"], form.dbw-dialog, .dbw-record-drawer, .dbw-field-drawer')).map(dialog => ({
        role: dialog.getAttribute('role'), label: dialog.getAttribute('aria-label'), busy: dialog.getAttribute('aria-busy'),
        heading: dialog.querySelector('h2')?.textContent, error: dialog.querySelector('[role="alert"]')?.textContent,
        name: dialog.querySelector<HTMLInputElement>('input')?.value,
        buttons: Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).map(button => ({ text: button.textContent?.trim(),
          label: button.getAttribute('aria-label'), disabled: button.disabled, focused: active === button })) })),
      alerts: Array.from(document.querySelectorAll('.dbw-shell [role="alert"], .app-notification-message')).map(alert => alert.textContent),
      route: (window as ProbeWindow).__knowbookDatabaseDeleteRoute ?? [] }
  })
  const probe = await state(app)
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, ui, probe }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return { ui, probe }
}

async function retryReadWithoutDeleting(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  await expect(recovery(page)).toBeVisible()
  await expect(recovery(page).locator('[role="alert"] p')).toHaveText(uiText(
    'The data was deleted. Retry only refreshes the list; it will not delete again.',
    '数据已删除。重试只会刷新列表，不会再次删除。'))
  const calls = (await state(app)).calls
  // Establish a real user focus inside the workspace, then take the reverse Tab route.
  await query(page).click()
  const retry = recovery(page).locator('.recovery-actions button').first()
  await expect(retry).toHaveText(uiText('Retry', '重试'))
  await tabTo(page, retry, `${phase}-query-to-read-retry`, 'Shift+Tab', 32)
  await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookDatabaseDeleteProbe!.holdReads = true })
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state(app)).pendingReads).toBeGreaterThan(0)
  await expect(retry).toBeDisabled()
  const held = (await state(app)).pendingReads
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  expect((await state(app)).pendingReads).toBe(held)
  expect((await state(app)).calls).toEqual(calls)
  await record(page, app, testInfo, `${phase}-read-retry-pending`)
  await releaseRefresh(app, page)
  await expect(recovery(page)).toHaveCount(0)
  expect((await state(app)).calls).toEqual(calls)
  await expect(confirmation(page)).toHaveCount(0)
}

async function setRecordDeleteFailure(app: ElectronApplication, entityId: string, enabled: boolean) {
  await app.evaluate(({ app }, { entityId, enabled }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_record_delete_failure')
      if (enabled) {
        const id = entityId.replace(/'/g, "''")
        database.exec("CREATE TRIGGER knowbook_e2e_record_delete_failure BEFORE DELETE ON database_entities WHEN OLD.id = '" + id +
          "' BEGIN SELECT RAISE(ABORT, 'The record could not be deleted yet.'); END")
      }
    } finally { database.close() }
  }, { entityId, enabled })
}

async function deletedSourceCounts(app: ElectronApplication, databaseId: string) {
  return app.evaluate(({ app }, databaseId) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try {
      const count = (table: string, column: string) => (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(databaseId) as { count: number }).count
      return { databases: count('databases', 'id'), views: count('database_saved_views', 'database_id'),
        fields: count('document_database_columns', 'database_id'), records: count('database_entities', 'database_id') }
    } finally { database.close() }
  }, databaseId)
}

test('a saved view deletion is acknowledged even when its list refresh fails in English @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await seed(page, 'en-US')
    await installProbe(app)
    await query(page).click()
    const deleteView = page.getByRole('button', { name: 'View menu: Delete view', exact: true })
    await tabTo(page, deleteView, 'query-to-delete-view', 'Shift+Tab')
    await page.keyboard.press('Enter')
    const menu = page.locator('.dbw-view-actions-menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(menu.getByRole('button', { name: 'Delete view', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toHaveAccessibleName('Delete view')
    await expect(confirmation(page)).toContainText('Delete view')
    await confirmWithKeyboard(page, app, 1)
    await record(page, app, testInfo, 'en-view-delete-pending')
    await finishDelete(app, page, 1, { holdRefresh: true })
    const acknowledged = await record(page, app, testInfo, 'en-view-delete-ack-refresh-held')
    expect((await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id)).map(view => view.id)).toEqual([fixture.keepView.id])
    await releaseRefresh(app, page, true)
    await record(page, app, testInfo, 'en-view-delete-saved-refresh-failed')
    // Record the old dangerous Retry state before requiring acknowledgement to close it.
    await expect(confirmation(page)).toHaveCount(0)
    await expect(viewTab(page, 'Delete view')).toHaveCount(0)
    await expect(viewTab(page, 'Keep view')).toHaveAttribute('aria-current', 'page')
    expect(acknowledged.ui.dialogs.filter(dialog => dialog.role === 'alertdialog')).toEqual([])
    expect(acknowledged.ui.active).toMatchObject({ tag: 'INPUT', label: 'Search records…' })
    await expect(query(page)).toBeFocused()
    expect((await state(app)).calls).toEqual([{ kind: 'view', input: fixture.deleteView.id }])
    expect((await state(app)).acknowledged).toHaveLength(1)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
    expect(await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), fixture.database.id)).toEqual([fixture.removable, fixture.kept])
    expect((await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id))[0].config).toEqual(fixture.keepView.config)
    await retryReadWithoutDeleting(page, app, testInfo, 'en-view-delete')
    await expect(viewTab(page, 'Delete view')).toHaveCount(0)
    await expect(viewTab(page, 'Keep view')).toHaveAttribute('aria-current', 'page')
    await record(page, app, testInfo, 'en-view-delete-refreshed')
  })
})

test('a database deletion navigates to the safe source before refresh and cannot close a newer form in Chinese @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await seed(page, 'zh-CN')
    const documents = await page.evaluate(() => window.knowbook.getDocumentCatalog())
    await installProbe(app)
    await query(page).click()
    const settings = page.getByRole('button', { name: '数据库设置', exact: true })
    await tabTo(page, settings, 'zh-query-to-database-settings', 'Shift+Tab')
    await page.keyboard.press('Enter')
    await tabTo(page, page.locator('.dbw-action-menu').getByRole('button', { name: '删除数据库', exact: true }), 'zh-settings-to-delete-source')
    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toHaveAccessibleName('删除数据库')
    await expect(confirmation(page)).toContainText(sourceName)
    await confirmWithKeyboard(page, app, 1)
    await record(page, app, testInfo, 'zh-database-delete-pending')
    await finishDelete(app, page, 1, { holdRefresh: true })
    await record(page, app, testInfo, 'zh-database-delete-ack-refresh-held')
    await expect(confirmation(page)).toHaveCount(0)
    await expect(source(page)).toContainText('全部文档')
    expect(await deletedSourceCounts(app, fixture.database.id)).toEqual({ databases: 0, views: 0, fields: 0, records: 0 })
    // The acknowledgement, not completion of old reads, permits a new user-owned form.
    await query(page).click()
    await tabTo(page, source(page), 'zh-fallback-query-to-source', 'Shift+Tab')
    await page.keyboard.press('Enter')
    await expect(page.locator('.dbw-source-picker input')).toBeFocused()
    await expect(page.locator('.dbw-source-option').filter({ hasText: sourceName })).toHaveCount(0)
    await tabTo(page, page.locator('.dbw-source-picker').getByRole('button', { name: '新建数据库', exact: true }), 'zh-fallback-to-new-database')
    await page.keyboard.press('Enter')
    const name = form(page).getByRole('textbox', { name: '名称', exact: true })
    await expect(name).toBeFocused()
    await name.fill('新窗口保持输入')
    await record(page, app, testInfo, 'zh-new-form-during-old-delete-refresh')
    await releaseRefresh(app, page, true)
    await record(page, app, testInfo, 'zh-old-delete-refresh-failed-new-form-retained')
    await expect(form(page)).toHaveAccessibleName('新建数据库')
    await expect(name).toHaveValue('新窗口保持输入')
    await expect(name).toBeFocused()
    await expect(confirmation(page)).toHaveCount(0)
    await expect(source(page)).toContainText('全部文档')
    expect((await state(app)).calls).toEqual([{ kind: 'database', input: fixture.database.id }])
    expect(await deletedSourceCounts(app, fixture.database.id)).toEqual({ databases: 0, views: 0, fields: 0, records: 0 })
    expect(await page.evaluate(() => window.knowbook.getDocumentCatalog())).toEqual(documents)
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    await retryReadWithoutDeleting(page, app, testInfo, 'zh-database-delete')
    expect((await page.evaluate(() => window.knowbook.getDatabases())).some(database => database.id === fixture.database.id)).toBe(false)
    await expect(source(page)).toContainText('全部文档')
    await record(page, app, testInfo, 'zh-database-delete-refreshed')
  })
})

test('a real record deletion failure can retry once and bulk deletion never repeats after acknowledgement @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await seed(page, 'en-US')
    const deleted = fixture.entities.find(entity => entity.title === 'Delete record 1')!
    const kept = fixture.entities.filter(entity => entity.id !== deleted.id)
    await installProbe(app)
    await setRecordDeleteFailure(app, deleted.id, true)
    try {
      await query(page).click()
      await tabTo(page, row(page, deleted.title).getByRole('button', { name: deleted.title, exact: true }), 'query-to-record-details')
      await page.keyboard.press('Enter')
      const drawer = page.getByRole('dialog', { name: 'Record details', exact: true, includeHidden: true })
      await expect(drawer.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
      // The native danger dialog temporarily makes this underlying drawer inert.
      const title = drawer.getByRole('textbox', { name: 'Title', exact: true, includeHidden: true })
      await title.fill('Retain this unsaved record draft')
      await tabTo(page, drawer.getByRole('button', { name: 'Delete record', exact: true }), 'record-title-to-delete')
      await page.keyboard.press('Enter')
      await expect(confirmation(page)).toContainText(deleted.title)
      // Keep the first failure uninterrupted; repeated pending keys are checked on its real retry below.
      await confirmWithKeyboard(page, app, 1, { repeatWhilePending: false })
      await record(page, app, testInfo, 'en-record-delete-pending')
      await finishDelete(app, page, 1, { failure: true })
      await expect(confirmation(page).getByRole('alert')).toContainText('The record could not be deleted yet.')
      await record(page, app, testInfo, 'en-record-delete-real-failure')
      await expect(confirmation(page).getByRole('alert')).not.toContainText(/Error invoking|remote method/i)
      await expect(confirmation(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
      await expect(title).toHaveValue('Retain this unsaved record draft')
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
      expect((await state(app)).acknowledged).toEqual([])
      await setRecordDeleteFailure(app, deleted.id, false)
      await confirmWithKeyboard(page, app, 2, { retry: true })
      await finishDelete(app, page, 1, { holdRefresh: true })
      await record(page, app, testInfo, 'en-record-delete-ack-refresh-held')
      await expect(confirmation(page)).toHaveCount(0)
      await expect(drawer).toHaveCount(0)
      await expect(row(page, deleted.title)).toHaveCount(0)
      await expect(query(page)).toBeFocused()
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(kept)
      await releaseRefresh(app, page, true)
      await record(page, app, testInfo, 'en-record-delete-saved-refresh-failed')
      await expect(confirmation(page)).toHaveCount(0)
      await retryReadWithoutDeleting(page, app, testInfo, 'en-record-delete')
      await row(page, 'Delete record 2').getByRole('checkbox').check()
      await row(page, 'Delete record 3').getByRole('checkbox').check()
      const bulk = page.locator('.dbw-selection-toolbar').getByRole('button', { name: 'Delete record', exact: true })
      await tabTo(page, bulk, 'selected-record-to-bulk-delete', 'Shift+Tab')
      await page.keyboard.press('Enter')
      await expect(confirmation(page)).toContainText('2 selected')
      await confirmWithKeyboard(page, app, 3)
      await record(page, app, testInfo, 'en-bulk-delete-pending')
      await finishDelete(app, page, 2, { holdRefresh: true })
      await record(page, app, testInfo, 'en-bulk-delete-ack-refresh-held')
      await expect(confirmation(page)).toHaveCount(0)
      await expect(page.locator('.dbw-selection-toolbar')).toHaveCount(0)
      await expect(page.locator('.dbw-record-title')).toHaveCount(0)
      await expect(query(page)).toBeFocused()
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual([])
      await releaseRefresh(app, page)
      expect((await state(app)).calls.filter(call => call.kind === 'record')).toHaveLength(2)
      const bulkCall = (await state(app)).calls.filter(call => call.kind === 'records')
      expect(bulkCall).toHaveLength(1)
      expect(new Set((bulkCall[0].input as DeleteDatabaseEntitiesInput).entityIds)).toEqual(new Set(kept.map(record => record.id)))
      expect(await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id)).toEqual([fixture.keepView, fixture.deleteView])
      expect(await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), fixture.database.id)).toEqual([fixture.removable, fixture.kept])
      await record(page, app, testInfo, 'en-record-and-bulk-delete-finished')
    } finally { await setRecordDeleteFailure(app, deleted.id, false) }
  })
})

test('deleting a field preserves protected record values and only retries its failed refresh in Chinese @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await seed(page, 'zh-CN')
    await installProbe(app)
    await query(page).fill('Delete record')
    const fields = page.locator('.dbw-toolbar-button')
    await tabTo(page, fields, 'zh-query-to-fields')
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('dialog', { name: '字段管理', exact: true })
    await expect(drawer.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
    const removable = drawer.locator('.dbw-field-row').filter({ has: page.getByRole('button', { name: 'Removable property', exact: true }) })
    await tabTo(page, removable.getByRole('button', { name: '删除字段', exact: true }), 'zh-field-close-to-delete')
    await page.keyboard.press('Enter')
    await expect(confirmation(page)).toHaveAccessibleName('删除字段')
    await expect(confirmation(page)).toContainText('Removable property')
    await confirmWithKeyboard(page, app, 1)
    await record(page, app, testInfo, 'zh-field-delete-pending')
    await finishDelete(app, page, 1, { holdRefresh: true })
    await record(page, app, testInfo, 'zh-field-delete-ack-refresh-held')
    await expect(confirmation(page)).toHaveCount(0)
    await expect(query(page)).toBeFocused()
    await expect(query(page)).toHaveValue('Delete record')
    await expect(page.locator('.dbw-column-label').filter({ hasText: 'Removable property' })).toHaveCount(0)
    await expect(page.locator('.dbw-column-label').filter({ hasText: 'Protected property' })).toHaveCount(1)
    expect(await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), fixture.database.id)).toEqual([fixture.kept])
    const stored = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)
    expect(stored).toEqual(fixture.entities.map(entity => ({ ...entity, fieldValues: { [fixture.kept.id]: entity.fieldValues[fixture.kept.id] } })))
    await releaseRefresh(app, page, true)
    await record(page, app, testInfo, 'zh-field-delete-saved-refresh-failed')
    await expect(confirmation(page)).toHaveCount(0)
    await retryReadWithoutDeleting(page, app, testInfo, 'zh-field-delete')
    await expect(query(page)).toHaveValue('Delete record')
    await expect(page.locator('.dbw-record-title')).toHaveCount(3)
    expect((await state(app)).calls).toEqual([{ kind: 'field', input: fixture.removable.id }])
    expect(await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), fixture.database.id)).toEqual([fixture.kept])
    await record(page, app, testInfo, 'zh-field-delete-refreshed')
  })
})
