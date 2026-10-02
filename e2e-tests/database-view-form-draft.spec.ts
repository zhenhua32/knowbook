import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateDatabaseSavedViewInput, DatabaseSavedView, DatabaseSavedViewFormResult, DatabaseViewConfigV1, UpdateDatabaseSavedViewInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type MutationInput = CreateDatabaseSavedViewInput | UpdateDatabaseSavedViewInput
type MutationResult = DatabaseSavedViewFormResult | DatabaseSavedView
type MutationHandler = (event: IpcMainInvokeEvent, input: MutationInput) => DatabaseSavedViewFormResult | Promise<DatabaseSavedViewFormResult>
type SaveHandler = (event: IpcMainInvokeEvent, input: MutationInput) => DatabaseSavedView | Promise<DatabaseSavedView>
type ReadHandler = (event: IpcMainInvokeEvent, databaseId: string) => DatabaseSavedView[] | Promise<DatabaseSavedView[]>
type Probe = {
  originalCreate: MutationHandler; originalUpdate: MutationHandler; originalSave: SaveHandler; originalRead: ReadHandler; holdReads: boolean; readsCompleted: number
  calls: Array<{ kind: 'create' | 'update'; input: MutationInput }>; written: DatabaseSavedView[]
  failures: Array<{ kind: 'create' | 'update'; input: MutationInput; message: string;
    reason?: Extract<DatabaseSavedViewFormResult, { status: 'invalid-name' }>['reason'] }>
  pending: Array<{ kind: 'create' | 'update'; api: 'form' | 'ordinary'; event: IpcMainInvokeEvent; input: MutationInput;
    resolve: (value: MutationResult) => void; reject: (error: Error) => void }>
  pendingReads: Array<{ event: IpcMainInvokeEvent; databaseId: string;
    resolve: (value: DatabaseSavedView[]) => void; reject: (error: Error) => void }>
}
type ProbeGlobal = typeof globalThis & { __knowbookViewFormProbe?: Probe }
type TabStop = { phase: string; step: number; tag: string | null; text: string | null; label: string | null; reached: boolean }
type ProbeWindow = Window & { __knowbookViewFormRoute?: TabStop[] }
type Fixture = { databaseId: string; viewId: string; stageId: string; initialConfig: DatabaseViewConfigV1 }
const databaseName = 'View form reliability'
const primaryName = 'Primary form view'
const form = (page: Page) => page.locator('form.dbw-dialog')
const nameInput = (page: Page) => form(page).getByLabel(uiText('Name', '名称'), { exact: true })
const submit = (page: Page) => form(page).locator('button[type="submit"]')
const query = (page: Page) => page.getByLabel(uiText('Search records…', '搜索记录…'), { exact: true })
const save = (page: Page) => page.locator('.dbw-save-button')
const titles = (page: Page) => page.locator('.dbw-table .dbw-record-title strong')
const activeTab = (page: Page) => page.locator('.dbw-view-tab[aria-current="page"]')
const dirty = (page: Page) => page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')

async function seed(page: Page, language: 'en-US' | 'zh-CN'): Promise<Fixture> {
  const ids = await page.evaluate(async ({ language, databaseName, primaryName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: databaseName })
    const stage = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Stage', type: 'select', options: ['Keep', 'Skip'] })
    for (const [title, value] of [['Alpha first', 'Keep'], ['Beta keep', 'Keep'], ['Beta skip', 'Skip']]) {
      await window.knowbook.createDatabaseEntity({ databaseId: database.id, title, fieldValues: { [stage.id]: value } })
    }
    const fields = ['__title__', stage.id, '__document__', '__created_at__', '__updated_at__']
    const initialConfig: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Alpha', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null }, visibleFieldIds: fields, fieldOrder: fields,
      columnWidths: { __title__: 300, [stage.id]: 160 }, cardFieldIds: [stage.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: primaryName, config: initialConfig })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { databaseId: database.id, viewId: view.id, stageId: stage.id, initialConfig: view.config }
  }, { language, databaseName, primaryName })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: language === 'zh-CN' ? 850 : 800 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(databaseName)
  await expect(activeTab(page)).toHaveAttribute('title', primaryName)
  await expect(query(page)).toHaveValue('Alpha')
  await expect(titles(page)).toHaveText(['Alpha first'])
  return ids
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, MutationHandler | SaveHandler | ReadHandler> })._invokeHandlers
    const originalCreate = handlers.get('knowbook:create-database-saved-view-form') as MutationHandler
    const originalUpdate = handlers.get('knowbook:update-database-saved-view-form') as MutationHandler
    const originalSave = handlers.get('knowbook:update-database-saved-view') as SaveHandler
    const originalRead = handlers.get('knowbook:get-database-saved-views') as ReadHandler
    if (!originalCreate || !originalUpdate || !originalSave || !originalRead) throw new Error('Real form and ordinary saved-view handlers are required')
    const probe: Probe = { originalCreate, originalUpdate, originalSave, originalRead, holdReads: false, readsCompleted: 0,
      calls: [], written: [], failures: [], pending: [], pendingReads: [] }
    ;(globalThis as ProbeGlobal).__knowbookViewFormProbe = probe
    for (const [api, kind, channel] of [['form', 'create', 'knowbook:create-database-saved-view-form'],
      ['form', 'update', 'knowbook:update-database-saved-view-form'], ['ordinary', 'update', 'knowbook:update-database-saved-view']] as const) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, input: MutationInput) => {
        probe.calls.push({ kind, input })
        return new Promise<MutationResult>((resolve, reject) => probe.pending.push({ api, kind, event, input, resolve, reject }))
      })
    }
    ipcMain.removeHandler('knowbook:get-database-saved-views')
    ipcMain.handle('knowbook:get-database-saved-views', async (event, databaseId: string) => {
      if (probe.holdReads) return new Promise<DatabaseSavedView[]>((resolve, reject) => probe.pendingReads.push({ event, databaseId, resolve, reject }))
      const result = await probe.originalRead(event, databaseId)
      probe.readsCompleted++
      return result
    })
  })
}

async function probeState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookViewFormProbe!
    return { calls: probe.calls, written: probe.written, failures: probe.failures, pending: probe.pending.map(request => request.kind),
      holdReads: probe.holdReads, readsCompleted: probe.readsCompleted, pendingReads: probe.pendingReads.length }
  })
}

async function finishMutation(app: ElectronApplication, page: Page, count: number, waitForRefresh = false, expectFailure = false) {
  const before = await probeState(app)
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookViewFormProbe!
    const pending = probe.pending.shift()
    if (!pending) throw new Error('No view form mutation is pending')
    setImmediate(async () => {
      try {
        const original = pending.api === 'ordinary' ? probe.originalSave : pending.kind === 'create' ? probe.originalCreate : probe.originalUpdate
        const result = await original(pending.event, pending.input)
        if ('status' in result) {
          if (result.status === 'saved') probe.written.push(result.view)
          else probe.failures.push({ kind: pending.kind, input: pending.input, message: result.message, reason: result.reason })
        } else probe.written.push(result)
        // Typed name issues resolve exactly as the real handler returned them.
        pending.resolve(result)
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        probe.failures.push({ kind: pending.kind, input: pending.input, message: failure.message })
        pending.reject(failure)
      }
    })
  })
  await expect.poll(async () => {
    const probe = await probeState(app)
    return expectFailure ? probe.failures.length : probe.written.length
  }).toBe(count)
  if (waitForRefresh) await expect.poll(async () => (await probeState(app)).readsCompleted).toBeGreaterThan(before.readsCompleted)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function releaseRefresh(app: ElectronApplication, page: Page) {
  const before = await probeState(app)
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookViewFormProbe!
    probe.holdReads = false
    const requests = probe.pendingReads.splice(0)
    if (!requests.length) throw new Error('No real saved-view refresh is held')
    setImmediate(async () => {
      for (const request of requests) {
        try {
          const result = await probe.originalRead(request.event, request.databaseId)
          probe.readsCompleted++
          request.resolve(result)
        } catch (error) { request.reject(error instanceof Error ? error : new Error(String(error))) }
      }
    })
  })
  await expect.poll(async () => (await probeState(app)).readsCompleted).toBeGreaterThan(before.readsCompleted)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, phase: string, limit = 24) {
  let reached = false
  for (let step = 1; step <= limit; step++) {
    await page.keyboard.press('Tab')
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const stop: TabStop = { phase, step, tag: active?.tagName ?? null, label: active?.getAttribute('aria-label') ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null, reached: active === element }
      ;((window as ProbeWindow).__knowbookViewFormRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function openCreate(page: Page, name: string) {
  await page.locator('.dbw-new-view-menu summary').click()
  await page.locator('.dbw-layout-menu').getByRole('button', { name: uiText('Table', '表格'), exact: true }).click()
  await expect(form(page)).toBeVisible()
  await nameInput(page).fill(name)
  await expect(nameInput(page)).toBeFocused()
}

async function submitForm(page: Page, app: ElectronApplication, count: number, phase: string) {
  await tabTo(page, submit(page), phase, 8)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await probeState(app)).calls.length).toBe(count)
}

async function expectNameIssue(page: Page, message: string) {
  const alert = form(page).getByRole('alert')
  await expect(alert).toHaveCount(1)
  await expect(alert).toHaveText(message)
  await expect(alert).toBeVisible()
  await expect(nameInput(page)).toHaveAttribute('aria-invalid', 'true')
  const issueId = await alert.getAttribute('id')
  expect(issueId).toBeTruthy()
  const descriptions = await nameInput(page).evaluate(input => (input.getAttribute('aria-describedby') ?? '')
    .split(/\s+/).filter(Boolean).map(id => ({ id, text: document.getElementById(id)?.textContent })))
  expect(descriptions).toContainEqual({ id: issueId, text: message })
}

async function expectNameIssueCleared(page: Page) {
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  await expect(nameInput(page)).not.toHaveAttribute('aria-invalid', 'true')
  await expect(nameInput(page)).not.toHaveAttribute('aria-describedby', /\S/)
  await expect(form(page).locator('.dbw-form-error-details')).toHaveCount(0)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const dialog = document.querySelector<HTMLFormElement>('form.dbw-dialog')
    const name = dialog?.querySelector<HTMLInputElement>('input')
    const button = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]')
    const search = document.querySelector<HTMLInputElement>('.dbw-main-search input')
    const errorDetails = dialog?.querySelector<HTMLDetailsElement>('.dbw-form-error-details')
    const errorPre = errorDetails?.querySelector('pre')
    return { viewport: { width: innerWidth, height: innerHeight },
      active: { tag: active?.tagName, label: active?.getAttribute('aria-label'), text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null },
      query: search?.value, queryFocused: active === search, queryDisabled: search?.disabled,
      tabs: Array.from(document.querySelectorAll<HTMLButtonElement>('.dbw-view-tab')).map(tab => ({
        name: tab.title, current: tab.getAttribute('aria-current'), dirty: Boolean(tab.querySelector('.dbw-unsaved-dot')) })),
      dialog: dialog ? { title: dialog.querySelector('h2')?.textContent, ariaBusy: dialog.getAttribute('aria-busy'),
        name: name ? { value: name.value, readOnly: name.readOnly, disabled: name.disabled, focused: active === name,
          ariaInvalid: name.getAttribute('aria-invalid'), descriptions: (name.getAttribute('aria-describedby') ?? '')
            .split(/\s+/).filter(Boolean).map(id => ({ id, text: document.getElementById(id)?.textContent })) } : null,
        submit: button ? { text: button.textContent?.trim(), disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled'),
          ariaBusy: button.getAttribute('aria-busy'), focused: active === button } : null,
        status: dialog.querySelector('[role="status"]')?.textContent, error: dialog.querySelector('[role="alert"]')?.textContent,
        errorDetails: errorDetails ? { open: errorDetails.open, summary: errorDetails.querySelector('summary')?.textContent,
          text: errorPre?.textContent, rect: errorPre?.getBoundingClientRect().toJSON() } : null } : null,
      save: Array.from(document.querySelectorAll<HTMLButtonElement>('.dbw-save-button')).map(button => ({
        text: button.textContent?.trim(), disabled: button.disabled, ariaBusy: button.getAttribute('aria-busy'), ariaDisabled: button.getAttribute('aria-disabled') })),
      records: Array.from(document.querySelectorAll('.dbw-table .dbw-record-title strong')).map(title => title.textContent),
      headers: Array.from(document.querySelectorAll('.dbw-table thead th')).map(header => header.textContent?.trim()),
      tabRoute: (window as ProbeWindow).__knowbookViewFormRoute ?? [] }
  })
  const probe = await probeState(app)
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, state, probe }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return { state, probe }
}

test('renaming a view preserves its dirty query and filters without saving their configuration in English @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seed(page, 'en-US')
    const before = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
    await installProbe(app)
    await query(page).fill('Beta')
    const filterMenu = page.locator('.dbw-toolbar-menu').first().locator('summary')
    await filterMenu.click()
    await page.getByRole('button', { name: '＋ Add filter', exact: true }).click()
    const filter = page.getByRole('group', { name: 'Filter 1', exact: true })
    await filter.getByLabel('Filter field 1', { exact: true }).selectOption(ids.stageId)
    await filter.getByLabel('Value 1', { exact: true }).selectOption('Keep')
    await filterMenu.click()
    await expect(titles(page)).toHaveText(['Beta keep'])
    await page.getByTitle(primaryName, { exact: true }).dblclick()
    await nameInput(page).fill('Renamed primary')
    await submitForm(page, app, 1, 'en-rename-submit')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    const pending = await record(page, app, testInfo, 'en-rename-pending')
    await finishMutation(app, page, 1, true)
    // Capture the old build's loss of Beta before asserting the new behavior.
    await record(page, app, testInfo, 'en-rename-returned')
    await expect(query(page)).toHaveValue('Beta')
    await expect(dirty(page)).toHaveCount(1)
    await expect(activeTab(page)).toHaveAttribute('title', 'Renamed primary')
    await expect(titles(page)).toHaveText(['Beta keep'])
    await expect(form(page)).toHaveCount(0)
    const persisted = (await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), ids.databaseId)).find(view => view.id === ids.viewId)!
    expect(persisted.name).toBe('Renamed primary')
    expect(persisted.config).toEqual(ids.initialConfig)
    expect(pending.probe.calls).toHaveLength(1)
    expect(pending.probe.calls[0]).toEqual({ kind: 'update', input: { viewId: ids.viewId, name: 'Renamed primary' } })
    expect(pending.state.dialog?.name).toMatchObject({ value: 'Renamed primary', readOnly: true, disabled: false })
    expect(pending.state.dialog?.submit).toMatchObject({ disabled: false, ariaDisabled: 'true', ariaBusy: 'true', focused: true })
    expect(pending.state.dialog?.submit?.text).toBe('Saving…')
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(before)
  })
})

test('a canceled pending create cannot close or overwrite a newer rename form in English @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seed(page, 'en-US')
    const before = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
    await installProbe(app)
    await query(page).fill('Beta')
    await openCreate(page, 'Background created view')
    await submitForm(page, app, 1, 'en-background-create-submit')
    await record(page, app, testInfo, 'en-background-create-pending')
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    await page.getByTitle(primaryName, { exact: true }).dblclick()
    await nameInput(page).fill('New rename draft Y')
    await expect(nameInput(page)).toBeFocused()
    await record(page, app, testInfo, 'en-new-rename-form')
    await finishMutation(app, page, 1, true)
    await record(page, app, testInfo, 'en-old-create-returned')
    await expect(form(page)).toBeVisible()
    await expect(form(page).getByRole('heading')).toHaveText('Rename')
    await expect(nameInput(page)).toHaveValue('New rename draft Y')
    await expect(nameInput(page)).toBeFocused()
    await expect(query(page)).toHaveValue('Beta')
    await expect(activeTab(page)).toHaveAttribute('title', primaryName)
    await expect(dirty(page)).toHaveCount(1)
    const stored = await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), ids.databaseId)
    expect(stored.filter(view => view.name === 'Background created view')).toHaveLength(1)
    expect(stored.find(view => view.id === ids.viewId)?.name).toBe(primaryName)
    expect(stored.find(view => view.id === ids.viewId)?.config).toEqual(ids.initialConfig)
    expect((await probeState(app)).calls).toHaveLength(1)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(before)
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
  })
})

test('a newly created view accepts a newer draft while its real refresh is pending in Chinese @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seed(page, 'zh-CN')
    const before = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
    await installProbe(app)
    await openCreate(page, '新建后继续编辑')
    await submitForm(page, app, 1, 'zh-create-submit')
    const pending = await record(page, app, testInfo, 'zh-create-pending')
    await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookViewFormProbe!.holdReads = true })
    await finishMutation(app, page, 1)
    await expect.poll(async () => (await probeState(app)).pendingReads).toBeGreaterThan(0)
    const created = (await probeState(app)).written[0]
    await record(page, app, testInfo, 'zh-created-refresh-held')
    await expect(form(page)).toHaveCount(0)
    await expect(activeTab(page)).toHaveAttribute('title', '新建后继续编辑')
    await expect(query(page)).toHaveValue('Alpha')
    await expect(page.locator('.dbw-table thead th').filter({ hasText: 'Stage' })).toBeVisible()
    expect(created.config).toEqual(ids.initialConfig)
    expect(pending.state.dialog?.name).toMatchObject({ readOnly: true, disabled: false })
    expect(pending.state.dialog?.submit).toMatchObject({ disabled: false, ariaDisabled: 'true', ariaBusy: 'true', focused: true })
    expect(pending.state.dialog?.submit?.text).toBe('正在创建…')
    await query(page).fill('Beta')
    await expect(query(page)).toBeFocused()
    await expect(titles(page)).toHaveText(['Beta keep', 'Beta skip'])
    await record(page, app, testInfo, 'zh-edit-during-held-refresh')
    await releaseRefresh(app, page)
    await record(page, app, testInfo, 'zh-created-refresh-returned')
    await expect(activeTab(page)).toHaveAttribute('title', '新建后继续编辑')
    await expect(query(page)).toHaveValue('Beta')
    await expect(dirty(page)).toHaveCount(1)
    await expect(titles(page)).toHaveText(['Beta keep', 'Beta skip'])
    await tabTo(page, save(page), 'zh-save-newer-created-draft')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await probeState(app)).calls.length).toBe(2)
    await record(page, app, testInfo, 'zh-created-view-save-pending')
    await finishMutation(app, page, 2, true)
    await expect(dirty(page)).toHaveCount(0)
    await expect(save(page)).toBeDisabled()
    const stored = await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), ids.databaseId)
    expect(stored.filter(view => view.id === created.id)).toHaveLength(1)
    expect(stored.find(view => view.id === created.id)?.config.query).toBe('Beta')
    expect(stored.find(view => view.id === ids.viewId)?.config).toEqual(ids.initialConfig)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(before)
    await record(page, app, testInfo, 'zh-created-view-saved-clean')
    await page.reload()
    await page.getByTitle('数据库', { exact: true }).click()
    await expect(activeTab(page)).toHaveAttribute('title', '新建后继续编辑')
    await expect(query(page)).toHaveValue('Beta')
    await expect(titles(page)).toHaveText(['Beta keep', 'Beta skip'])
    await expect(dirty(page)).toHaveCount(0)
    await record(page, app, testInfo, 'zh-created-view-reloaded')
  })
})

test('a real duplicate view name preserves the focused name draft and supports Enter retry @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seed(page, 'en-US')
    const duplicate = await page.evaluate(ids => window.knowbook.createDatabaseSavedView({
      databaseId: ids.databaseId, name: 'Duplicate name', config: ids.initialConfig
    }), ids)
    const before = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
    await installProbe(app)
    await query(page).fill('Beta')
    await expect(dirty(page)).toHaveCount(1)
    await page.getByTitle(primaryName, { exact: true }).dblclick()
    await nameInput(page).fill('Duplicate name')
    await expect(nameInput(page)).toBeFocused()
    // Implicit native form submission from Name must preserve that input's focus.
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await probeState(app)).calls.length).toBe(1)
    await record(page, app, testInfo, 'en-name-enter-conflict-pending')
    await expect(nameInput(page)).toBeFocused()
    await expect(nameInput(page)).toBeEnabled()
    await expect(nameInput(page)).toHaveJSProperty('readOnly', true)
    await expect(submit(page)).toHaveAttribute('aria-busy', 'true')
    await expect(submit(page)).toHaveAttribute('aria-disabled', 'true')
    expect(await submit(page).evaluate(button => (button as HTMLButtonElement).disabled)).toBe(false)
    // The conflict was added after the renderer loaded its list; only the real
    // store's typed form result can classify this previously unknown name issue.
    await finishMutation(app, page, 1, false, true)
    await expect(form(page).getByRole('alert')).toBeVisible()
    await record(page, app, testInfo, 'en-real-name-conflict-returned-collapsed')
    const rejected = await probeState(app)
    expect(rejected.written).toHaveLength(0)
    expect(rejected.failures).toHaveLength(1)
    expect(rejected.failures[0].kind).toBe('update')
    expect(rejected.failures[0].reason).toBe('name-taken')
    expect(rejected.failures[0].message.trim()).not.toBe('')
    await expectNameIssue(page, 'A view with this name already exists in this database. Choose another name.')
    await expect(form(page).getByRole('alert')).not.toContainText(/Error invoking|remote method|^Error:/i)
    const details = form(page).locator('.dbw-form-error-details')
    const reason = details.locator('pre')
    await expect(details).toHaveJSProperty('open', false)
    await expect(reason).not.toBeVisible()
    await expect(reason).toHaveText(rejected.failures[0].message)
    await expect(reason).not.toContainText(/Error invoking|remote method|^Error:/i)
    await expect(nameInput(page)).toHaveValue('Duplicate name')
    await expect(nameInput(page)).toBeFocused()
    await expect(nameInput(page)).toBeEnabled()
    await expect(nameInput(page)).toHaveJSProperty('readOnly', false)
    await expect(query(page)).toHaveValue('Beta')
    await expect(dirty(page)).toHaveCount(1)
    const afterFailure = await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), ids.databaseId)
    expect(afterFailure.find(view => view.id === ids.viewId)?.name).toBe(primaryName)
    expect(afterFailure.find(view => view.id === ids.viewId)?.config).toEqual(ids.initialConfig)
    expect(afterFailure.find(view => view.id === duplicate.id)?.name).toBe('Duplicate name')
    const summary = details.locator('summary')
    await expect(summary).toHaveAccessibleName('Error details')
    await tabTo(page, summary, 'en-failed-name-to-error-details', 8)
    await page.keyboard.press('Space')
    await expect(details).toHaveJSProperty('open', true)
    await expect(reason).toBeVisible()
    await expect(reason).toHaveText(rejected.failures[0].message)
    await expect(summary).toBeFocused()
    await record(page, app, testInfo, 'en-real-name-conflict-returned-expanded')
    await page.keyboard.press('Shift+Tab')
    await expect(nameInput(page)).toBeFocused()
    await expect(nameInput(page)).toHaveValue('Duplicate name')
    await nameInput(page).fill('Legal retry name')
    await expectNameIssueCleared(page)
    await expect(nameInput(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await probeState(app)).calls.length).toBe(2)
    await record(page, app, testInfo, 'en-name-enter-retry-pending')
    await expect(nameInput(page)).toBeFocused()
    await expect(nameInput(page)).toHaveJSProperty('readOnly', true)
    await finishMutation(app, page, 1, true)
    await record(page, app, testInfo, 'en-name-enter-retry-success')
    await expect(form(page)).toHaveCount(0)
    await expect(activeTab(page)).toHaveAttribute('title', 'Legal retry name')
    await expect(query(page)).toHaveValue('Beta')
    await expect(dirty(page)).toHaveCount(1)
    const final = await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), ids.databaseId)
    expect(final).toHaveLength(2)
    expect(final.find(view => view.id === ids.viewId)?.name).toBe('Legal retry name')
    expect(final.find(view => view.id === ids.viewId)?.config).toEqual(ids.initialConfig)
    expect(final.find(view => view.id === duplicate.id)?.name).toBe('Duplicate name')
    expect((await probeState(app)).written).toHaveLength(1)
    expect((await probeState(app)).failures).toHaveLength(1)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(before)
  })
})

test('a Chinese create form reports a real case-insensitive trimmed name conflict and accepts a corrected Enter retry @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seed(page, 'zh-CN')
    const before = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
    await installProbe(app)
    await query(page).fill('Beta')
    await expect(dirty(page)).toHaveCount(1)
    const duplicateDraft = '  PRIMARY FORM VIEW  '
    await openCreate(page, duplicateDraft)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await probeState(app)).calls.length).toBe(1)
    await page.keyboard.press('Enter')
    const pending = await record(page, app, testInfo, 'zh-trimmed-duplicate-create-pending')
    expect(pending.probe.calls).toHaveLength(1)
    expect(pending.probe.calls[0]).toMatchObject({ kind: 'create', input: { databaseId: ids.databaseId, name: duplicateDraft.trim() } })
    expect(pending.state.dialog?.name).toMatchObject({ value: duplicateDraft, readOnly: true, disabled: false, focused: true })
    await expect(submit(page)).toHaveAttribute('aria-busy', 'true')
    await expect(submit(page)).toHaveAttribute('aria-disabled', 'true')
    expect(await submit(page).evaluate(button => (button as HTMLButtonElement).disabled)).toBe(false)
    // Delegate the production form handler; SQLite's ASCII NOCASE comparison
    // must reject this name without creating or changing any stored view.
    await finishMutation(app, page, 1, false, true)
    await expect(form(page).getByRole('alert')).toBeVisible()
    await record(page, app, testInfo, 'zh-trimmed-duplicate-create-collapsed')
    const rejected = await probeState(app)
    expect(rejected.written).toHaveLength(0)
    expect(rejected.failures).toHaveLength(1)
    expect(rejected.failures[0]).toMatchObject({ kind: 'create', reason: 'name-taken' })
    expect(rejected.failures[0].message.trim()).not.toBe('')
    await expectNameIssue(page, '此数据库中已有同名视图，请换一个名称。')
    await expect(form(page).getByRole('alert')).not.toContainText(/Error invoking|remote method|SqliteError|^Error:/i)
    await expect(nameInput(page)).toHaveValue(duplicateDraft)
    await expect(nameInput(page)).toBeFocused()
    await expect(nameInput(page)).toBeEnabled()
    await expect(nameInput(page)).toHaveJSProperty('readOnly', false)
    await expect(query(page)).toHaveValue('Beta')
    await expect(dirty(page)).toHaveCount(1)
    const details = form(page).locator('.dbw-form-error-details')
    const reason = details.locator('pre')
    await expect(details).toHaveJSProperty('open', false)
    await expect(reason).not.toBeVisible()
    await expect(reason).toHaveText(rejected.failures[0].message)
    await expect(reason).not.toContainText(/Error invoking|remote method|^Error:/i)
    const afterFailure = await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), ids.databaseId)
    expect(afterFailure).toHaveLength(1)
    expect(afterFailure[0].id).toBe(ids.viewId)
    expect(afterFailure[0].name).toBe(primaryName)
    expect(afterFailure[0].config).toEqual(ids.initialConfig)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(before)
    const summary = details.locator('summary')
    await expect(summary).toHaveAccessibleName('错误详情')
    await tabTo(page, summary, 'zh-create-name-to-error-details', 8)
    await page.keyboard.press('Space')
    await expect(details).toHaveJSProperty('open', true)
    await expect(reason).toBeVisible()
    await expect(reason).toHaveText(rejected.failures[0].message)
    await expect(summary).toBeFocused()
    await record(page, app, testInfo, 'zh-trimmed-duplicate-create-expanded')
    await page.keyboard.press('Shift+Tab')
    await expect(nameInput(page)).toBeFocused()
    const correctedName = '合法名称新视图'
    await nameInput(page).fill(correctedName)
    await expectNameIssueCleared(page)
    await expect(nameInput(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await probeState(app)).calls.length).toBe(2)
    await record(page, app, testInfo, 'zh-corrected-create-enter-pending')
    await expect(nameInput(page)).toBeFocused()
    await expect(nameInput(page)).toHaveJSProperty('readOnly', true)
    await finishMutation(app, page, 1, true)
    await record(page, app, testInfo, 'zh-corrected-create-enter-saved')
    await expect(form(page)).toHaveCount(0)
    await expect(activeTab(page)).toHaveAttribute('title', correctedName)
    await expect(query(page)).toHaveValue('Beta')
    await expect(dirty(page)).toHaveCount(0)
    await expect(titles(page)).toHaveText(['Beta keep', 'Beta skip'])
    const stored = await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), ids.databaseId)
    expect(stored).toHaveLength(2)
    expect(stored.find(view => view.id === ids.viewId)?.name).toBe(primaryName)
    expect(stored.find(view => view.id === ids.viewId)?.config).toEqual(ids.initialConfig)
    const created = stored.find(view => view.name === correctedName)!
    expect(created.config).toEqual({ ...ids.initialConfig, query: 'Beta' })
    const final = await probeState(app)
    expect(final.calls).toHaveLength(2)
    expect(final.written).toHaveLength(1)
    expect(final.written[0].id).toBe(created.id)
    expect(final.failures).toHaveLength(1)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(before)
  })
})
