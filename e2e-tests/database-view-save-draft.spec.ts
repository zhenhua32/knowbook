import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { DatabaseSavedView, DatabaseViewConfigV1, UpdateDatabaseSavedViewInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type SaveHandler = (event: IpcMainInvokeEvent, input: UpdateDatabaseSavedViewInput) => DatabaseSavedView | Promise<DatabaseSavedView>
type ReadHandler = (event: IpcMainInvokeEvent, databaseId: string) => DatabaseSavedView[] | Promise<DatabaseSavedView[]>
type Probe = {
  originalSave: SaveHandler; originalRead: ReadHandler; completed: number; readsAfterWrite: number
  calls: UpdateDatabaseSavedViewInput[]
  pending: Array<{ event: IpcMainInvokeEvent; input: UpdateDatabaseSavedViewInput;
    resolve: (value: DatabaseSavedView) => void; reject: (error: Error) => void }>
}
type ProbeGlobal = typeof globalThis & { __knowbookViewSaveProbe?: Probe }
type Fixture = {
  databaseId: string; otherDatabaseId: string; viewId: string; secondViewId: string; otherViewId: string; stageId: string
}
type TabStop = { phase: string; step: number; tag: string | null; label: string | null; text: string | null; reached: boolean }
type ProbeWindow = Window & { __knowbookViewSaveTabRoute?: TabStop[] }
const databaseName = 'View draft reliability'
const otherDatabaseName = 'Other draft source'
const firstViewName = 'Primary view'
const secondViewName = 'Secondary view'
const otherViewName = 'Other source view'
const search = (page: Page) => page.getByLabel(uiText('Search records…', '搜索记录…'), { exact: true })
const save = (page: Page) => page.locator('.dbw-save-button')
const titles = (page: Page) => page.locator('.dbw-table .dbw-record-title strong')
const view = (page: Page, name: string) => page.locator('.dbw-view-tab').getByText(name, { exact: true }).locator('..')
const dirty = (page: Page) => page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')

async function seed(page: Page, language: 'en-US' | 'zh-CN'): Promise<Fixture> {
  const ids = await page.evaluate(async ({ language, databaseName, otherDatabaseName, firstViewName, secondViewName, otherViewName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: databaseName })
    const stage = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Stage', type: 'select', options: ['Keep', 'Skip'] })
    for (const [title, value] of [['Alpha first', 'Keep'], ['Beta keep', 'Keep'], ['Beta skip', 'Skip'], ['Gamma keep', 'Keep']]) {
      await window.knowbook.createDatabaseEntity({ databaseId: database.id, title, fieldValues: { [stage.id]: value } })
    }
    const fields = ['__title__', stage.id, '__document__', '__created_at__', '__updated_at__']
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: fields, fieldOrder: fields, columnWidths: { __title__: 300, [stage.id]: 160 }, cardFieldIds: [stage.id] }
    const first = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: firstViewName, config, sortOrder: 0 })
    const second = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: secondViewName, config, sortOrder: 1 })
    const other = await window.knowbook.createDocumentDatabase({ name: otherDatabaseName })
    await window.knowbook.createDatabaseEntity({ databaseId: other.id, title: 'Delta first', fieldValues: {} })
    await window.knowbook.createDatabaseEntity({ databaseId: other.id, title: 'Epsilon second', fieldValues: {} })
    const otherFields = ['__title__', '__document__', '__created_at__', '__updated_at__']
    const otherView = await window.knowbook.createDatabaseSavedView({ databaseId: other.id, name: otherViewName,
      config: { ...config, visibleFieldIds: otherFields, fieldOrder: otherFields, columnWidths: { __title__: 300 }, cardFieldIds: [] } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, first.id)
    window.localStorage.setItem(`knowbook.database.last-view.${other.id}`, otherView.id)
    return { databaseId: database.id, otherDatabaseId: other.id, viewId: first.id, secondViewId: second.id, otherViewId: otherView.id, stageId: stage.id }
  }, { language, databaseName, otherDatabaseName, firstViewName, secondViewName, otherViewName })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: language === 'zh-CN' ? 850 : 800 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(databaseName)
  await expect(view(page, firstViewName)).toHaveAttribute('aria-current', 'page')
  await expect(titles(page)).toHaveText(['Alpha first', 'Beta keep', 'Beta skip', 'Gamma keep'])
  return ids
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, SaveHandler | ReadHandler> })._invokeHandlers
    const originalSave = handlers.get('knowbook:update-database-saved-view') as SaveHandler
    const originalRead = handlers.get('knowbook:get-database-saved-views') as ReadHandler
    if (!originalSave || !originalRead) throw new Error('Real saved-view IPC handlers are required')
    const probe: Probe = { originalSave, originalRead, completed: 0, readsAfterWrite: 0, calls: [], pending: [] }
    ;(globalThis as ProbeGlobal).__knowbookViewSaveProbe = probe
    ipcMain.removeHandler('knowbook:update-database-saved-view')
    ipcMain.handle('knowbook:update-database-saved-view', (event, input: UpdateDatabaseSavedViewInput) => {
      probe.calls.push(input)
      return new Promise<DatabaseSavedView>((resolve, reject) => probe.pending.push({ event, input, resolve, reject }))
    })
    ipcMain.removeHandler('knowbook:get-database-saved-views')
    ipcMain.handle('knowbook:get-database-saved-views', async (event, databaseId: string) => {
      const result = await probe.originalRead(event, databaseId)
      if (probe.completed > 0) probe.readsAfterWrite++
      return result
    })
  })
}

async function probeState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookViewSaveProbe!
    return { calls: probe.calls, completed: probe.completed, pending: probe.pending.length, readsAfterWrite: probe.readsAfterWrite }
  })
}

async function finishSave(app: ElectronApplication, page: Page, count: number, waitForRefresh = false) {
  const before = await probeState(app)
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookViewSaveProbe!
    const pending = probe.pending.shift()
    if (!pending) throw new Error('No saved-view request is pending')
    // Inspector returns before real IPC settlement; no fabricated save result.
    setImmediate(async () => {
      try {
        const result = await probe.originalSave(pending.event, pending.input)
        probe.completed++
        pending.resolve(result)
      } catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
    })
  })
  await expect.poll(async () => (await probeState(app)).completed).toBe(count)
  if (waitForRefresh) await expect.poll(async () => (await probeState(app)).readsAfterWrite).toBeGreaterThan(before.readsAfterWrite)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function savedConfig(page: Page, databaseId: string, viewId: string) {
  return page.evaluate(async ({ databaseId, viewId }) => {
    const saved = (await window.knowbook.getDatabaseSavedViews(databaseId)).find(candidate => candidate.id === viewId)
    if (!saved) throw new Error('The real saved view disappeared')
    return saved.config
  }, { databaseId, viewId })
}

async function expectSaving(page: Page, focused = false) {
  await expect(save(page)).toHaveAttribute('aria-busy', 'true')
  await expect(save(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(save(page)).toHaveText(uiText('Saving…', '正在保存…'))
  // aria-disabled prevents mutation while the native button retains keyboard focus.
  expect(await save(page).evaluate(element => (element as HTMLButtonElement).disabled)).toBe(false)
  if (focused) await expect(save(page)).toBeFocused()
  await expect(search(page)).toBeEnabled()
}

async function keyboardSave(page: Page, app: ElectronApplication, testInfo: TestInfo, ids: Fixture, count: number, phase: string) {
  let reached = false
  for (let step = 1; step <= 24; step++) {
    await page.keyboard.press('Tab')
    const stop = await save(page).evaluate((button, { step, phase }) => {
      const active = document.activeElement as HTMLElement | null
      const stop: TabStop = { phase, step, tag: active?.tagName ?? null, label: active?.getAttribute('aria-label') ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null, reached: active === button }
      ;((window as ProbeWindow).__knowbookViewSaveTabRoute ??= []).push(stop)
      return stop
    }, { step, phase })
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  await record(page, app, testInfo, ids, `${phase}-tab-route`)
  expect(reached).toBe(true)
  await expect(save(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await probeState(app)).calls.length).toBe(count)
  await expect.poll(async () => (await probeState(app)).pending).toBe(1)
  await record(page, app, testInfo, ids, `${phase}-keyboard-pending`)
  await expectSaving(page, true)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await expectSaving(page, true)
  expect((await probeState(app)).calls).toHaveLength(count)
  expect((await probeState(app)).pending).toBe(1)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, ids: Fixture, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const button = document.querySelector<HTMLButtonElement>('.dbw-save-button')
    const query = document.querySelector<HTMLInputElement>('.dbw-main-search input')
    const rect = (element: Element | null) => {
      const bounds = element?.getBoundingClientRect()
      return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null
    }
    return { viewport: { width: innerWidth, height: innerHeight }, query: query?.value,
      active: { tag: active?.tagName, label: active?.getAttribute('aria-label'), text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null },
      source: document.querySelector('.dbw-source-trigger')?.textContent?.trim(),
      tabs: Array.from(document.querySelectorAll<HTMLButtonElement>('.dbw-view-tab')).map(tab => ({
        name: tab.title, current: tab.getAttribute('aria-current'), dirty: Boolean(tab.querySelector('.dbw-unsaved-dot')) })),
      save: button ? { text: button.textContent?.trim(), disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled'),
        ariaBusy: button.getAttribute('aria-busy'), focused: active === button, rect: rect(button) } : null,
      queryFocused: active === query, queryDisabled: query?.disabled,
      tabRoute: (window as ProbeWindow).__knowbookViewSaveTabRoute ?? [],
      records: Array.from(document.querySelectorAll('.dbw-table .dbw-record-title strong')).map(title => title.textContent),
      filters: Array.from(document.querySelectorAll('.dbw-filter-row')).map(row => Array.from(row.querySelectorAll('input,select')).map(input => ({
        label: input.getAttribute('aria-label'), value: (input as HTMLInputElement).value }))) }
  })
  const saved = await page.evaluate(async ids => ({
    currentDatabase: await window.knowbook.getDatabaseSavedViews(ids.databaseId),
    otherDatabase: await window.knowbook.getDatabaseSavedViews(ids.otherDatabaseId)
  }), ids)
  const body = JSON.stringify({ phase, windows, state, probe: await probeState(app), saved }, null, 2)
  const jsonPath = testInfo.outputPath(`${phase}.json`)
  writeFileSync(jsonPath, body)
  await testInfo.attach(`${phase}-geometry`, { path: jsonPath, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

test('saving a view preserves newer query and filter drafts, then persists the second save in English @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seed(page, 'en-US')
    const entitiesBefore = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
    await installProbe(app)
    await search(page).fill('Alpha')
    await expect(titles(page)).toHaveText(['Alpha first'])
    await keyboardSave(page, app, testInfo, ids, 1, 'en-first-save')
    expect((await probeState(app)).calls[0].config?.query).toBe('Alpha')
    await expect(search(page)).toBeEnabled()
    await search(page).fill('Beta')
    await expect(search(page)).toBeFocused()
    await expectSaving(page)
    const filterMenu = page.locator('.dbw-toolbar-menu').first().locator('summary')
    await filterMenu.click()
    await page.getByRole('button', { name: '＋ Add filter', exact: true }).click()
    const row = page.getByRole('group', { name: 'Filter 1', exact: true })
    await row.getByLabel('Filter field 1', { exact: true }).selectOption(ids.stageId)
    await row.getByLabel('Value 1', { exact: true }).selectOption('Keep')
    await filterMenu.click()
    await expect(titles(page)).toHaveText(['Beta keep'])
    await record(page, app, testInfo, ids, 'en-pending-newer-draft')
    await expectSaving(page)
    expect((await probeState(app)).calls).toHaveLength(1)
    expect((await probeState(app)).pending).toBe(1)
    await finishSave(app, page, 1, true)
    // The old build's overwritten query/dirty/tab state is captured first.
    await record(page, app, testInfo, ids, 'en-first-save-returned')
    await expect(search(page)).toHaveValue('Beta')
    await expect(view(page, firstViewName)).toHaveAttribute('aria-current', 'page')
    await expect(dirty(page)).toHaveCount(1)
    await expect(save(page)).toBeEnabled()
    await expect(save(page)).toHaveAttribute('aria-busy', 'false')
    await expect(save(page)).toHaveAttribute('aria-disabled', 'false')
    await expect(save(page)).toHaveText('Save changes')
    await expect(titles(page)).toHaveText(['Beta keep'])
    const persistedA = await savedConfig(page, ids.databaseId, ids.viewId)
    expect(persistedA.query).toBe('Alpha')
    expect(persistedA.filters.rules).toEqual([])
    await keyboardSave(page, app, testInfo, ids, 2, 'en-second-save')
    expect((await probeState(app)).calls[1].config?.query).toBe('Beta')
    await finishSave(app, page, 2, true)
    await expect(dirty(page)).toHaveCount(0)
    await expect(save(page)).toBeDisabled()
    await expect(save(page)).toHaveAttribute('aria-busy', 'false')
    await expect(save(page)).toHaveText('Saved')
    await expect(search(page)).toHaveValue('Beta')
    const persistedB = await savedConfig(page, ids.databaseId, ids.viewId)
    expect(persistedB.query).toBe('Beta')
    expect(persistedB.filters.rules).toEqual([expect.objectContaining({ fieldId: ids.stageId, operator: 'equals', value: 'Keep' })])
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(entitiesBefore)
    await record(page, app, testInfo, ids, 'en-second-save-clean')
    await page.reload()
    await page.getByTitle('Database', { exact: true }).click()
    await expect(search(page)).toHaveValue('Beta')
    await expect(titles(page)).toHaveText(['Beta keep'])
    await expect(dirty(page)).toHaveCount(0)
    await record(page, app, testInfo, ids, 'en-reloaded-persisted-draft')
  })
})

test('late saved-view replies keep a newly selected view and source draft in Chinese @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seed(page, 'zh-CN')
    const entitiesBefore = await page.evaluate(async ids => ({
      first: await window.knowbook.getDatabaseEntities(ids.databaseId), other: await window.knowbook.getDatabaseEntities(ids.otherDatabaseId)
    }), ids)
    await installProbe(app)
    await search(page).fill('Alpha')
    await keyboardSave(page, app, testInfo, ids, 1, 'zh-first-save')
    await view(page, secondViewName).click()
    await expect(view(page, secondViewName)).toHaveAttribute('aria-current', 'page')
    await search(page).fill('Gamma')
    await expect(titles(page)).toHaveText(['Gamma keep'])
    await record(page, app, testInfo, ids, 'zh-new-view-while-save-pending')
    await finishSave(app, page, 1, true)
    await record(page, app, testInfo, ids, 'zh-old-view-save-returned')
    await expect(view(page, secondViewName)).toHaveAttribute('aria-current', 'page')
    await expect(search(page)).toHaveValue('Gamma')
    await expect(dirty(page)).toHaveCount(1)
    expect((await savedConfig(page, ids.databaseId, ids.viewId)).query).toBe('Alpha')
    expect((await savedConfig(page, ids.databaseId, ids.secondViewId)).query).toBe('')
    await keyboardSave(page, app, testInfo, ids, 2, 'zh-second-save')
    await page.locator('.dbw-source-trigger').click()
    await page.getByRole('button', { name: otherDatabaseName, exact: true }).click()
    await expect(page.locator('.dbw-source-trigger')).toContainText(otherDatabaseName)
    await expect(view(page, otherViewName)).toHaveAttribute('aria-current', 'page')
    await search(page).fill('Delta')
    await expect(titles(page)).toHaveText(['Delta first'])
    await record(page, app, testInfo, ids, 'zh-new-source-while-save-pending')
    await finishSave(app, page, 2)
    await record(page, app, testInfo, ids, 'zh-old-source-save-returned')
    await expect(page.locator('.dbw-source-trigger')).toContainText(otherDatabaseName)
    await expect(view(page, otherViewName)).toHaveAttribute('aria-current', 'page')
    await expect(search(page)).toHaveValue('Delta')
    await expect(dirty(page)).toHaveCount(1)
    expect((await savedConfig(page, ids.databaseId, ids.secondViewId)).query).toBe('Gamma')
    expect((await savedConfig(page, ids.otherDatabaseId, ids.otherViewId)).query).toBe('')
    await keyboardSave(page, app, testInfo, ids, 3, 'zh-third-save')
    await finishSave(app, page, 3, true)
    await expect(dirty(page)).toHaveCount(0)
    await expect(save(page)).toBeDisabled()
    await expect(save(page)).toHaveAttribute('aria-busy', 'false')
    await expect(save(page)).toHaveText('已保存')
    expect((await savedConfig(page, ids.otherDatabaseId, ids.otherViewId)).query).toBe('Delta')
    expect(await page.evaluate(async ids => ({
      first: await window.knowbook.getDatabaseEntities(ids.databaseId), other: await window.knowbook.getDatabaseEntities(ids.otherDatabaseId)
    }), ids)).toEqual(entitiesBefore)
    await record(page, app, testInfo, ids, 'zh-new-source-save-clean')
    await page.reload()
    await page.getByTitle('数据库', { exact: true }).click()
    await expect(page.locator('.dbw-source-trigger')).toContainText(otherDatabaseName)
    await expect(search(page)).toHaveValue('Delta')
    await expect(titles(page)).toHaveText(['Delta first'])
    await expect(dirty(page)).toHaveCount(0)
    await record(page, app, testInfo, ids, 'zh-reloaded-current-source')
  })
})
