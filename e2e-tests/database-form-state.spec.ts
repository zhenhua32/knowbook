import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateDatabaseInput, DatabaseViewConfigV1, DocumentDatabase, UpdateDatabaseMetadataInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Input = CreateDatabaseInput | UpdateDatabaseMetadataInput
type MutationHandler = (event: IpcMainInvokeEvent, input: Input) => DocumentDatabase | Promise<DocumentDatabase>
type ReadHandler = (event: IpcMainInvokeEvent) => DocumentDatabase[] | Promise<DocumentDatabase[]>
type Probe = {
  originalCreate: MutationHandler; originalEdit: MutationHandler; originalRead: ReadHandler; holdReads: boolean; readsCompleted: number
  calls: Array<{ kind: 'create' | 'edit'; input: Input }>; written: DocumentDatabase[]; failures: string[]
  pending: Array<{ kind: 'create' | 'edit'; event: IpcMainInvokeEvent; input: Input;
    resolve: (value: DocumentDatabase) => void; reject: (error: Error) => void }>
  pendingReads: Array<{ event: IpcMainInvokeEvent; resolve: (value: DocumentDatabase[]) => void; reject: (error: Error) => void }>
}
type ProbeGlobal = typeof globalThis & { __knowbookDatabaseFormProbe?: Probe }
type ProbeWindow = Window & { __knowbookDatabaseFormRoute?: Array<{ phase: string; step: number; tag: string | null; label: string | null; text: string | null; reached: boolean }> }
const databaseName = 'Database form sample'
const viewName = 'Saved Alpha'
const form = (page: Page) => page.locator('form.dbw-dialog')
const name = (page: Page) => form(page).getByLabel(uiText('Name', '名称'), { exact: true })
const description = (page: Page) => form(page).getByRole('textbox', { name: uiText('Description', '描述'), exact: true })
const submit = (page: Page) => form(page).locator('button[type="submit"]')
const source = (page: Page) => page.locator('.dbw-source-trigger')
const settings = (page: Page) => page.getByRole('button', { name: uiText('Database settings', '数据库设置'), exact: true })
const query = (page: Page) => page.getByLabel(uiText('Search records…', '搜索记录…'), { exact: true })
const activeView = (page: Page) => page.locator('.dbw-view-tab[aria-current="page"]')
const sourceOption = (page: Page, sourceName: string, sourceDescription: string) => page.locator('.dbw-source-picker')
  .getByRole('button', { name: `${sourceName} ${sourceDescription}`, exact: true })

async function seed(page: Page, language: 'en-US' | 'zh-CN') {
  const fixture = await page.evaluate(async ({ language, databaseName, viewName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: databaseName, description: 'Original source description' })
    for (const title of ['Alpha first', 'Beta first', 'Beta second']) {
      await window.knowbook.createDatabaseEntity({ databaseId: database.id, title, fieldValues: {} })
    }
    const fields = ['__title__', '__document__', '__created_at__', '__updated_at__']
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Alpha', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: fields, fieldOrder: fields, columnWidths: { __title__: 300 }, cardFieldIds: [] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { database, view, entities: await window.knowbook.getDatabaseEntities(database.id) }
  }, { language, databaseName, viewName })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: language === 'zh-CN' ? 850 : 800 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(source(page)).toContainText(databaseName)
  await expect(query(page)).toHaveValue('Alpha')
  return fixture
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, MutationHandler | ReadHandler> })._invokeHandlers
    const originalCreate = handlers.get('knowbook:create-document-database') as MutationHandler
    const originalEdit = handlers.get('knowbook:update-database-metadata') as MutationHandler
    const originalRead = handlers.get('knowbook:get-databases') as ReadHandler
    if (!originalCreate || !originalEdit || !originalRead) throw new Error('Real database IPC handlers are required')
    const probe: Probe = { originalCreate, originalEdit, originalRead, holdReads: false, readsCompleted: 0,
      calls: [], written: [], failures: [], pending: [], pendingReads: [] }
    ;(globalThis as ProbeGlobal).__knowbookDatabaseFormProbe = probe
    for (const [kind, channel] of [['create', 'knowbook:create-document-database'], ['edit', 'knowbook:update-database-metadata']] as const) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, input: Input) => {
        probe.calls.push({ kind, input })
        return new Promise<DocumentDatabase>((resolve, reject) => probe.pending.push({ kind, event, input, resolve, reject }))
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
    const probe = (globalThis as ProbeGlobal).__knowbookDatabaseFormProbe!
    return { calls: probe.calls, written: probe.written, failures: probe.failures, pending: probe.pending.map(request => request.kind),
      holdReads: probe.holdReads, pendingReads: probe.pendingReads.length, readsCompleted: probe.readsCompleted }
  })
}

async function finish(app: ElectronApplication, page: Page, count: number, options: { holdRefresh?: boolean; failure?: boolean; waitRefresh?: boolean } = {}) {
  const before = await state(app)
  await app.evaluate((_electron, holdRefresh) => {
    const probe = (globalThis as ProbeGlobal).__knowbookDatabaseFormProbe!
    const pending = probe.pending.shift()
    if (!pending) throw new Error('No database mutation is pending')
    if (holdRefresh) probe.holdReads = true
    // The real store is the only producer of both success and failure results.
    setImmediate(async () => {
      try {
        const result = await (pending.kind === 'create' ? probe.originalCreate : probe.originalEdit)(pending.event, pending.input)
        probe.written.push(result)
        pending.resolve(result)
      } catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error))
        probe.failures.push(reason.message)
        pending.reject(reason)
      }
    })
  }, Boolean(options.holdRefresh))
  await expect.poll(async () => {
    const probe = await state(app)
    return options.failure ? probe.failures.length : probe.written.length
  }).toBe(count)
  if (options.holdRefresh) await expect.poll(async () => (await state(app)).pendingReads).toBeGreaterThan(0)
  if (options.waitRefresh) await expect.poll(async () => (await state(app)).readsCompleted).toBeGreaterThan(before.readsCompleted)
  await twoFrames(page)
}

async function releaseRefresh(app: ElectronApplication, page: Page) {
  const before = (await state(app)).readsCompleted
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookDatabaseFormProbe!
    probe.holdReads = false
    const requests = probe.pendingReads.splice(0)
    if (!requests.length) throw new Error('No real database-list refresh is held')
    setImmediate(async () => {
      for (const request of requests) {
        try {
          const result = await probe.originalRead(request.event)
          probe.readsCompleted++
          request.resolve(result)
        } catch (error) { request.reject(error instanceof Error ? error : new Error(String(error))) }
      }
    })
  })
  await expect.poll(async () => (await state(app)).readsCompleted).toBeGreaterThan(before)
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
      const stop = { phase, step, tag: active?.tagName ?? null, label: active?.getAttribute('aria-label') ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null, reached: active === element }
      ;((window as ProbeWindow).__knowbookDatabaseFormRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function openCreate(page: Page) {
  await tabTo(page, source(page), 'query-to-source-create', 'Shift+Tab')
  await page.keyboard.press('Enter')
  const picker = page.locator('.dbw-source-picker')
  await expect(picker.locator('input')).toBeFocused()
  await tabTo(page, picker.getByRole('button', { name: uiText('New database', '新建数据库'), exact: true }), 'picker-to-create')
  await page.keyboard.press('Enter')
  await expect(name(page)).toBeFocused()
}

async function openEdit(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string, direction: 'Tab' | 'Shift+Tab' = 'Shift+Tab') {
  await tabTo(page, settings(page), 'current-control-to-edit-settings', direction)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(page.locator('.dbw-action-menu').getByRole('button', { name: uiText('Edit database', '编辑数据库'), exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(name(page)).toBeFocused()
  await record(page, app, testInfo, phase)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const ui = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const form = document.querySelector('form.dbw-dialog')
    const input = form?.querySelector<HTMLInputElement>('input')
    const description = form?.querySelector<HTMLTextAreaElement>('textarea')
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]')
    const descriptionRect = description?.getBoundingClientRect()
    const descriptionHit = descriptionRect ? document.elementFromPoint(descriptionRect.x + descriptionRect.width / 2,
      descriptionRect.y + descriptionRect.height / 2) : null
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName,
      text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null, label: active?.getAttribute('aria-label') },
      source: document.querySelector('.dbw-source-trigger')?.textContent?.trim(), sourceFocused: active === document.querySelector('.dbw-source-trigger'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      tabs: Array.from(document.querySelectorAll<HTMLButtonElement>('.dbw-view-tab')).map(tab => ({ title: tab.title,
        current: tab.getAttribute('aria-current'), dirty: Boolean(tab.querySelector('.dbw-unsaved-dot')) })),
      form: form ? { title: form.getAttribute('aria-label'), name: input ? { value: input.value, readOnly: input.readOnly, disabled: input.disabled, focused: active === input } : null,
        description: description ? { value: description.value, readOnly: description.readOnly, disabled: description.disabled, focused: active === description,
          tag: description.tagName, id: description.id, ariaLabel: description.getAttribute('aria-label'),
          ariaLabelledby: description.getAttribute('aria-labelledby'), labels: Array.from(description.labels ?? []).map(label => label.textContent?.trim()),
          rect: descriptionRect?.toJSON(), hit: descriptionHit ? { tag: descriptionHit.tagName, className: descriptionHit.className,
            isTextarea: descriptionHit === description } : null } : null,
        labels: Array.from(form.querySelectorAll('label')).map(label => ({ text: label.textContent?.trim(), htmlFor: label.htmlFor })),
        submit: submit ? { text: submit.textContent?.trim(), disabled: submit.disabled, ariaBusy: submit.getAttribute('aria-busy'),
          ariaDisabled: submit.getAttribute('aria-disabled'), focused: active === submit } : null,
        status: form.querySelector('[role="status"]')?.textContent, error: form.querySelector('[role="alert"]')?.textContent } : null,
      route: (window as ProbeWindow).__knowbookDatabaseFormRoute ?? [] }
  })
  const probe = await state(app)
  const formAriaSnapshot = await form(page).count() === 1 ? await form(page).ariaSnapshot() : null
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, ui, probe, formAriaSnapshot }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  if (formAriaSnapshot) await testInfo.attach(`${phase}-form-aria`, { body: formAriaSnapshot, contentType: 'text/yaml' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return { ui, probe }
}

test('creating a database acknowledges the source and keyboard opener before list refresh in English @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await seed(page, 'en-US')
    await installProbe(app)
    await query(page).fill('Beta')
    await openCreate(page)
    await name(page).fill('Keyboard created source')
    await description(page).fill('Submitted description')
    await tabTo(page, submit(page), 'description-to-create-submit', 'Tab', 8)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await state(app)).calls.length).toBe(1)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    const pending = await record(page, app, testInfo, 'en-create-pending')
    await finish(app, page, 1, { holdRefresh: true })
    await expect(form(page)).toHaveCount(0)
    await record(page, app, testInfo, 'en-create-ack-refresh-held')
    // Old out is recorded before requiring the new acknowledgement behavior.
    await expect(source(page)).toContainText('Keyboard created source')
    await expect(source(page)).toBeFocused()
    await expect(source(page)).toBeInViewport({ ratio: 1 })
    expect(pending.probe.calls).toHaveLength(1)
    expect(pending.ui.form?.name).toMatchObject({ value: 'Keyboard created source', readOnly: true, disabled: false })
    expect(pending.ui.form?.description).toMatchObject({ value: 'Submitted description', readOnly: true, disabled: false })
    expect(pending.ui.form?.submit).toMatchObject({ disabled: false, ariaBusy: 'true', ariaDisabled: 'true', focused: true })
    expect(pending.ui.form?.submit?.text).toBe('Creating…')
    expect((await state(app)).written[0]).toMatchObject({ name: 'Keyboard created source', description: 'Submitted description' })
    await releaseRefresh(app, page)
    const stored = await page.evaluate(() => window.knowbook.getDatabases())
    expect(stored.filter(database => database.name === 'Keyboard created source')).toHaveLength(1)
    expect((await state(app)).calls).toHaveLength(1)
    await expect(source(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(sourceOption(page, 'Keyboard created source', 'Submitted description')).toBeVisible()
    await sourceOption(page, databaseName, 'Original source description').click()
    await expect(source(page)).toContainText(databaseName)
    await expect(query(page)).toHaveValue('Beta')
    await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
    expect((await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id))[0].config).toEqual(fixture.view.config)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
    await record(page, app, testInfo, 'en-created-and-original-draft-preserved')
  })
})

async function setMetadataFailure(app: ElectronApplication, databaseId: string, enabled: boolean) {
  await app.evaluate(({ app }, { databaseId, enabled }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_metadata_failure')
      if (enabled) {
        const id = databaseId.replace(/'/g, "''")
        database.exec("CREATE TRIGGER knowbook_e2e_metadata_failure BEFORE UPDATE ON databases WHEN NEW.id = '" + id +
          "' AND NEW.name = 'Blocked metadata' BEGIN SELECT RAISE(ABORT, 'Database metadata is temporarily unavailable.'); END")
      }
    } finally { database.close() }
  }, { databaseId, enabled })
}

test('editing database metadata preserves focused failed drafts and retries a real SQLite failure in Chinese @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await seed(page, 'zh-CN')
    await installProbe(app)
    await query(page).fill('Beta')
    await openEdit(page, app, testInfo, 'zh-edit-open-diagnostic')
    await name(page).fill('Blocked metadata')
    await description(page).fill('保留这段未保存描述')
    await page.keyboard.press('Shift+Tab')
    await expect(name(page)).toBeFocused()
    await setMetadataFailure(app, fixture.database.id, true)
    try {
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await state(app)).calls.length).toBe(1)
      await record(page, app, testInfo, 'zh-edit-name-enter-pending')
      await expect(name(page)).toBeFocused()
      await expect(name(page)).toBeEnabled()
      await expect(name(page)).toHaveJSProperty('readOnly', true)
      await expect(description(page)).toBeEnabled()
      await expect(description(page)).toHaveJSProperty('readOnly', true)
      await tabTo(page, submit(page), 'readonly-name-to-edit-submit', 'Tab', 8)
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      await expect(submit(page)).toBeFocused()
      await expect(submit(page)).toHaveAttribute('aria-busy', 'true')
      await expect(submit(page)).toHaveAttribute('aria-disabled', 'true')
      expect(await submit(page).evaluate(button => (button as HTMLButtonElement).disabled)).toBe(false)
      expect((await state(app)).calls).toHaveLength(1)
      await finish(app, page, 1, { failure: true })
      await expect(form(page).getByRole('alert')).toBeVisible()
      await record(page, app, testInfo, 'zh-edit-real-sqlite-failure')
      await expect(form(page).getByRole('alert')).toContainText('Database metadata is temporarily unavailable.')
      await expect(form(page).getByRole('alert')).not.toContainText(/Error invoking|remote method/i)
      await expect(submit(page)).toBeFocused()
      await expect(name(page)).toHaveValue('Blocked metadata')
      await expect(description(page)).toHaveValue('保留这段未保存描述')
      await expect(name(page)).toHaveJSProperty('readOnly', false)
      await expect(query(page)).toHaveValue('Beta')
      await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
      expect((await state(app)).written).toEqual([])
      expect((await page.evaluate(() => window.knowbook.getDatabases())).find(database => database.id === fixture.database.id)).toEqual(fixture.database)
      await setMetadataFailure(app, fixture.database.id, false)
      await tabTo(page, name(page), 'failed-submit-to-name', 'Shift+Tab', 8)
      await name(page).fill('数据库修改成功')
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await state(app)).calls.length).toBe(2)
      await record(page, app, testInfo, 'zh-edit-enter-retry-pending')
      await finish(app, page, 1, { waitRefresh: true })
      await expect(form(page)).toHaveCount(0)
      await record(page, app, testInfo, 'zh-edit-acknowledged')
      await expect(source(page)).toContainText('数据库修改成功')
      await expect(settings(page)).toBeFocused()
      await expect(activeView(page)).toHaveAttribute('title', viewName)
      await expect(query(page)).toHaveValue('Beta')
      await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
      expect((await page.evaluate(() => window.knowbook.getDatabases())).find(database => database.id === fixture.database.id)).toMatchObject({
        name: '数据库修改成功', description: '保留这段未保存描述' })
      expect((await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id))[0].config).toEqual(fixture.view.config)
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
      expect((await state(app)).calls).toHaveLength(2)
      expect((await state(app)).written).toHaveLength(1)
    } finally { await setMetadataFailure(app, fixture.database.id, false) }
  })
})

test('a canceled database creation cannot navigate away from a newer edit form or steal its focus @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await seed(page, 'en-US')
    await installProbe(app)
    await query(page).fill('Beta')
    await openCreate(page)
    await name(page).fill('Background created source')
    await description(page).fill('Background submitted description')
    await tabTo(page, submit(page), 'background-description-to-submit', 'Tab', 8)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await state(app)).calls.length).toBe(1)
    await record(page, app, testInfo, 'en-background-create-pending')
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    await twoFrames(page)
    await openEdit(page, app, testInfo, 'en-new-edit-open-diagnostic', 'Tab')
    await name(page).fill('New edit draft Y')
    await description(page).fill('Do not replace this newer description')
    await page.keyboard.press('Shift+Tab')
    await expect(name(page)).toBeFocused()
    await record(page, app, testInfo, 'en-new-edit-owner')
    await finish(app, page, 1)
    await record(page, app, testInfo, 'en-old-create-returned')
    await expect(form(page)).toBeVisible()
    await expect(form(page)).toHaveAttribute('aria-label', 'Edit database')
    await expect(name(page)).toHaveValue('New edit draft Y')
    await expect(description(page)).toHaveValue('Do not replace this newer description')
    await expect(name(page)).toBeFocused()
    await expect(source(page)).toContainText(databaseName)
    await expect(query(page)).toHaveValue('Beta')
    await expect(activeView(page)).toHaveAttribute('title', viewName)
    await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
    expect((await state(app)).calls).toHaveLength(1)
    const persisted = await page.evaluate(() => window.knowbook.getDatabases())
    expect(persisted.filter(database => database.name === 'Background created source')).toHaveLength(1)
    expect(persisted.find(database => database.id === fixture.database.id)).toEqual(fixture.database)
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    await twoFrames(page)
    await tabTo(page, source(page), 'settings-to-source-after-cancel', 'Shift+Tab', 8)
    await page.keyboard.press('Enter')
    await expect(sourceOption(page, 'Background created source', 'Background submitted description')).toBeVisible()
    await record(page, app, testInfo, 'en-background-source-discoverable')
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
  })
})

test('a creation from an unmounted source publishes its saved database without replacing the new source form @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const fixture = await seed(page, 'en-US')
    // Seed B before intercepting mutations: every result comes from the real store.
    const other = await page.evaluate(async config => {
      const database = await window.knowbook.createDocumentDatabase({ name: 'Other source B', description: 'Other source description' })
      for (const title of ['Alpha other', 'Beta other']) {
        await window.knowbook.createDatabaseEntity({ databaseId: database.id, title, fieldValues: {} })
      }
      const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Other saved Alpha', config })
      window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
      return { database, view, entities: await window.knowbook.getDatabaseEntities(database.id) }
    }, fixture.view.config)
    // Direct IPC seeds the store; re-enter with a fresh list before exercising UI mutations.
    await page.reload()
    await page.getByTitle('Database', { exact: true }).click()
    await expect(source(page)).toContainText(databaseName)
    await expect(query(page)).toHaveValue('Alpha')
    await expect(activeView(page)).toHaveAttribute('title', viewName)
    await installProbe(app)
    await query(page).fill('Beta')
    await openCreate(page)
    await name(page).fill('Late created source X')
    await description(page).fill('Created from source A')
    await tabTo(page, submit(page), 'cross-source-create-submit', 'Tab', 8)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await state(app)).calls.length).toBe(1)
    await record(page, app, testInfo, 'en-cross-source-create-pending')
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    await twoFrames(page)
    const oldWorkspace = await page.locator('.dbw-shell').elementHandle()
    expect(oldWorkspace).not.toBeNull()
    await source(page).click()
    await sourceOption(page, 'Other source B', 'Other source description').click()
    await expect(source(page)).toContainText('Other source B')
    await expect(query(page)).toHaveValue('Alpha')
    await expect(activeView(page)).toHaveAttribute('title', 'Other saved Alpha')
    await expect.poll(() => oldWorkspace!.evaluate(element => element.isConnected)).toBe(false)
    await query(page).fill('Beta')
    await openEdit(page, app, testInfo, 'en-source-b-edit-open-diagnostic')
    await name(page).fill('Edit source B draft Y')
    await description(page).fill('Keep the new source description draft')
    await page.keyboard.press('Shift+Tab')
    await expect(name(page)).toBeFocused()
    await record(page, app, testInfo, 'en-cross-source-new-edit-owner')
    await finish(app, page, 1)
    await record(page, app, testInfo, 'en-unmounted-create-acknowledged')
    await expect(form(page)).toBeVisible()
    await expect(form(page)).toHaveAttribute('aria-label', 'Edit database')
    await expect(name(page)).toHaveValue('Edit source B draft Y')
    await expect(description(page)).toHaveValue('Keep the new source description draft')
    await expect(name(page)).toBeFocused()
    await expect(source(page)).toContainText('Other source B')
    await expect(activeView(page)).toHaveAttribute('title', 'Other saved Alpha')
    await expect(query(page)).toHaveValue('Beta')
    await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
    expect((await state(app)).calls).toHaveLength(1)
    const stored = await page.evaluate(() => window.knowbook.getDatabases())
    expect(stored.filter(database => database.name === 'Late created source X')).toHaveLength(1)
    expect(stored.find(database => database.id === fixture.database.id)).toEqual(fixture.database)
    expect(stored.find(database => database.id === other.database.id)).toEqual(other.database)
    expect((await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id))[0].config).toEqual(fixture.view.config)
    expect((await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), other.database.id))[0].config).toEqual(other.view.config)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), other.database.id)).toEqual(other.entities)
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    await twoFrames(page)
    await tabTo(page, source(page), 'source-b-settings-to-picker', 'Shift+Tab', 8)
    await page.keyboard.press('Enter')
    await expect(sourceOption(page, 'Late created source X', 'Created from source A')).toBeVisible()
    await record(page, app, testInfo, 'en-late-created-source-discoverable-from-b')
  })
})
