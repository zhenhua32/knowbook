import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateDatabaseSavedViewInput, DatabaseSavedView, DatabaseViewConfigV1 } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type CreateHandler = (event: IpcMainInvokeEvent, input: CreateDatabaseSavedViewInput) => DatabaseSavedView | Promise<DatabaseSavedView>
type ReadHandler = (event: IpcMainInvokeEvent, id: string) => DatabaseSavedView[] | Promise<DatabaseSavedView[]>
type Probe = {
  originalCreate: CreateHandler; originalRead: ReadHandler; holdReads: boolean; readsCompleted: number
  calls: CreateDatabaseSavedViewInput[]; written: DatabaseSavedView[]
  pending: Array<{ event: IpcMainInvokeEvent; input: CreateDatabaseSavedViewInput; resolve: (view: DatabaseSavedView) => void; reject: (error: Error) => void }>
  pendingReads: Array<{ event: IpcMainInvokeEvent; id: string; resolve: (views: DatabaseSavedView[]) => void; reject: (error: Error) => void }>
}
type ProbeGlobal = typeof globalThis & { __knowbookFormFocusProbe?: Probe }
type FocusWatch = { element: HTMLElement; calls: Array<{ preventScroll: boolean; beforeScroll: number | null; afterScroll: number | null }> }
type ProbeWindow = Window & {
  __knowbookFormFocusWatches?: Record<string, FocusWatch>
  __knowbookFormFocusTabRoute?: Array<{ phase: string; step: number; tag: string | null; text: string | null; label: string | null; reached: boolean }>
  __knowbookFormFocusFrames?: { originalRequest: typeof requestAnimationFrame; originalCancel: typeof cancelAnimationFrame;
    callbacks: Map<number, FrameRequestCallback>; nextId: number }
}
const databaseName = 'View form focus'
const primaryName = 'Saved Alpha view'
const summary = (page: Page) => page.locator('.dbw-new-view-menu summary')
const menu = (page: Page) => page.locator('.dbw-layout-menu')
const form = (page: Page) => page.locator('form.dbw-dialog')
const name = (page: Page) => form(page).getByLabel(uiText('Name', '名称'), { exact: true })
const query = (page: Page) => page.getByLabel(uiText('Search records…', '搜索记录…'), { exact: true })
const saveAs = (page: Page) => page.getByRole('button', { name: uiText('Save as new view', '另存为新视图'), exact: true })
const activeTab = (page: Page) => page.locator('.dbw-view-tab[aria-current="page"]')
const titles = (page: Page) => page.locator('.dbw-table .dbw-record-title strong')

async function seed(page: Page, language: 'en-US' | 'zh-CN') {
  const ids = await page.evaluate(async ({ language, databaseName, primaryName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: databaseName })
    for (const title of ['Alpha first', 'Beta first', 'Beta second']) {
      await window.knowbook.createDatabaseEntity({ databaseId: database.id, title, fieldValues: {} })
    }
    const fields = ['__title__', '__document__', '__created_at__', '__updated_at__']
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Alpha', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: fields, fieldOrder: fields, columnWidths: { __title__: 300 }, cardFieldIds: [] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: primaryName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { databaseId: database.id, viewId: view.id, config: view.config }
  }, { language, databaseName, primaryName })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: language === 'zh-CN' ? 850 : 800 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(activeTab(page)).toHaveAttribute('title', primaryName)
  await expect(query(page)).toHaveValue('Alpha')
  return ids
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, CreateHandler | ReadHandler> })._invokeHandlers
    const originalCreate = handlers.get('knowbook:create-database-saved-view') as CreateHandler
    const originalRead = handlers.get('knowbook:get-database-saved-views') as ReadHandler
    if (!originalCreate || !originalRead) throw new Error('Real saved-view IPC handlers are required')
    const probe: Probe = { originalCreate, originalRead, holdReads: false, readsCompleted: 0, calls: [], written: [], pending: [], pendingReads: [] }
    ;(globalThis as ProbeGlobal).__knowbookFormFocusProbe = probe
    ipcMain.removeHandler('knowbook:create-database-saved-view')
    ipcMain.handle('knowbook:create-database-saved-view', (event, input: CreateDatabaseSavedViewInput) => {
      probe.calls.push(input)
      return new Promise<DatabaseSavedView>((resolve, reject) => probe.pending.push({ event, input, resolve, reject }))
    })
    ipcMain.removeHandler('knowbook:get-database-saved-views')
    ipcMain.handle('knowbook:get-database-saved-views', async (event, id: string) => {
      if (probe.holdReads) return new Promise<DatabaseSavedView[]>((resolve, reject) => probe.pendingReads.push({ event, id, resolve, reject }))
      const result = await probe.originalRead(event, id)
      probe.readsCompleted++
      return result
    })
  })
}

async function probeState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookFormFocusProbe!
    return { calls: probe.calls, written: probe.written, pending: probe.pending.length,
      holdReads: probe.holdReads, pendingReads: probe.pendingReads.length, readsCompleted: probe.readsCompleted }
  })
}

async function finishCreate(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookFormFocusProbe!
    const pending = probe.pending.shift()
    if (!pending) throw new Error('No create-view request is pending')
    probe.holdReads = true
    setImmediate(async () => {
      try {
        const result = await probe.originalCreate(pending.event, pending.input)
        probe.written.push(result)
        pending.resolve(result)
      } catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
    })
  })
  await expect.poll(async () => (await probeState(app)).written.length).toBe(1)
  await expect.poll(async () => (await probeState(app)).pendingReads).toBeGreaterThan(0)
}

async function releaseRefresh(app: ElectronApplication, page: Page) {
  const before = (await probeState(app)).readsCompleted
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookFormFocusProbe!
    probe.holdReads = false
    const requests = probe.pendingReads.splice(0)
    if (!requests.length) throw new Error('No real saved-view refresh is held')
    setImmediate(async () => {
      for (const request of requests) {
        try {
          const result = await probe.originalRead(request.event, request.id)
          probe.readsCompleted++
          request.resolve(result)
        } catch (error) { request.reject(error instanceof Error ? error : new Error(String(error))) }
      }
    })
  })
  await expect.poll(async () => (await probeState(app)).readsCompleted).toBeGreaterThan(before)
  await twoFrames(page)
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function watchFocus(target: Locator, key: string) {
  await target.evaluate((element, key) => {
    const target = element as HTMLElement
    const watch: FocusWatch = { element: target, calls: [] }
    ;((window as ProbeWindow).__knowbookFormFocusWatches ??= {})[key] = watch
    const original = target.focus
    target.focus = options => {
      const canvas = target.closest<HTMLElement>('.dbw-shell')
      const beforeScroll = canvas?.scrollTop ?? null
      original.call(target, options)
      watch.calls.push({ preventScroll: options?.preventScroll === true, beforeScroll, afterScroll: canvas?.scrollTop ?? null })
    }
  }, key)
}

async function focusCalls(page: Page, key: string) {
  return page.evaluate(key => (window as ProbeWindow).__knowbookFormFocusWatches?.[key]?.calls.length ?? 0, key)
}

async function tabTo(page: Page, target: Locator, phase: string, direction: 'Tab' | 'Shift+Tab' = 'Tab', limit = 24) {
  let reached = false
  for (let step = 1; step <= limit; step++) {
    await page.keyboard.press(direction)
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const stop = { phase, step, tag: active?.tagName ?? null, text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null,
        label: active?.getAttribute('aria-label') ?? null, reached: active === element }
      ;((window as ProbeWindow).__knowbookFormFocusTabRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function openFromFocusedSummary(page: Page) {
  await expect(summary(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Tab')
  const table = menu(page).getByRole('button', { name: uiText('Table', '表格'), exact: true })
  await expect(table).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(form(page)).toBeVisible()
  await expect(name(page)).toBeFocused()
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const dialog = document.querySelector('form.dbw-dialog')
    const input = dialog?.querySelector<HTMLInputElement>('input')
    const opener = document.querySelector<HTMLElement>('.dbw-new-view-menu summary')
    const watches = (window as ProbeWindow).__knowbookFormFocusWatches ?? {}
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName,
      label: active?.getAttribute('aria-label'), text: active?.tagName === 'BUTTON' || active?.tagName === 'SUMMARY' ? active.textContent?.trim() : null },
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      summaryFocused: active === opener, summaryVisible: Boolean(opener && opener.getClientRects().length),
      menuOpen: document.querySelector('.dbw-new-view-menu')?.hasAttribute('open'),
      dialog: dialog ? { ariaLabel: dialog.getAttribute('aria-label'), title: dialog.querySelector('h2')?.textContent,
        name: input?.value, nameFocused: active === input, nameReadOnly: input?.readOnly } : null,
      tabs: Array.from(document.querySelectorAll<HTMLButtonElement>('.dbw-view-tab')).map(tab => ({
        title: tab.title, current: tab.getAttribute('aria-current'), dirty: Boolean(tab.querySelector('.dbw-unsaved-dot')) })),
      route: (window as ProbeWindow).__knowbookFormFocusTabRoute ?? [],
      focusWatches: Object.fromEntries(Object.entries(watches).map(([key, watch]) => [key, {
        connected: watch.element.isConnected, focused: active === watch.element, calls: watch.calls }])),
      heldRestoreFrames: (window as ProbeWindow).__knowbookFormFocusFrames?.callbacks.size ?? 0 }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, state, probe: await probeState(app) }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`view form completion and cancel return to stable keyboard openers in ${language} @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const ids = await seed(page, language)
      const entitiesBefore = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
      await installProbe(app)
      await watchFocus(summary(page), 'new-view')
      await query(page).fill('Beta')
      await tabTo(page, summary(page), 'query-to-new-view', 'Shift+Tab', 8)
      await openFromFocusedSummary(page)
      const createdName = language === 'zh-CN' ? '键盘创建视图' : 'Keyboard created view'
      await name(page).fill(createdName)
      await tabTo(page, form(page).locator('button[type="submit"]'), 'name-to-submit', 'Tab', 8)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await probeState(app)).pending).toBe(1)
      await record(page, app, testInfo, `${language}-create-pending`)
      await finishCreate(app)
      await expect(form(page)).toHaveCount(0)
      await twoFrames(page)
      // The old build's BODY focus is recorded before the new focus assertion.
      await record(page, app, testInfo, `${language}-create-ack-refresh-held`)
      await expect(summary(page)).toBeFocused()
      await expect(summary(page)).toBeVisible()
      await expect(summary(page)).toBeInViewport({ ratio: 1 })
      await expect(activeTab(page)).toHaveAttribute('title', createdName)
      await expect(query(page)).toHaveValue('Beta')
      await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(0)
      await openFromFocusedSummary(page)
      await expect(page.getByRole('dialog', { name: uiText('New view', '新建视图'), exact: true })).toBeVisible()
      await name(page).fill('Canceled keyboard draft')
      if (language === 'en-US') {
        await tabTo(page, form(page).locator('header button'), 'name-to-close', 'Shift+Tab', 4)
        await page.keyboard.press('Enter')
      } else await page.keyboard.press('Escape')
      await expect(form(page)).toHaveCount(0)
      await twoFrames(page)
      await record(page, app, testInfo, `${language}-new-view-cancel-return`)
      await expect(summary(page)).toBeFocused()
      await releaseRefresh(app, page)
      await expect(query(page)).toHaveValue('Beta')
      await watchFocus(saveAs(page), 'save-as')
      await tabTo(page, saveAs(page), 'summary-to-save-as')
      await page.keyboard.press('Enter')
      await expect(name(page)).toBeFocused()
      await name(page).fill('Canceled save-as draft')
      await page.keyboard.press('Escape')
      await expect(form(page)).toHaveCount(0)
      await twoFrames(page)
      await record(page, app, testInfo, `${language}-save-as-return`)
      await expect(saveAs(page)).toBeFocused()
      await watchFocus(activeTab(page), 'rename')
      await activeTab(page).dblclick()
      await expect(page.getByRole('dialog', { name: uiText('Rename', '重命名'), exact: true })).toBeVisible()
      await name(page).fill('Canceled rename draft')
      await page.keyboard.press('Escape')
      await expect(form(page)).toHaveCount(0)
      await twoFrames(page)
      await record(page, app, testInfo, `${language}-rename-return`)
      await expect(activeTab(page)).toBeFocused()
      await expect(activeTab(page)).toHaveAttribute('title', createdName)
      await expect(query(page)).toHaveValue('Beta')
      await expect(titles(page)).toHaveText(['Beta first', 'Beta second'])
      const persisted = await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), ids.databaseId)
      expect(persisted).toHaveLength(2)
      expect(persisted.find(view => view.id === ids.viewId)?.config).toEqual(ids.config)
      expect(persisted.find(view => view.name === createdName)?.config.query).toBe('Beta')
      expect((await probeState(app)).calls).toHaveLength(1)
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(entitiesBefore)
    })
  })
}

async function holdRestoreFrames(page: Page) {
  await page.evaluate(() => {
    const probeWindow = window as ProbeWindow
    if (probeWindow.__knowbookFormFocusFrames) throw new Error('Renderer frames are already controlled')
    const state = { originalRequest: window.requestAnimationFrame, originalCancel: window.cancelAnimationFrame,
      callbacks: new Map<number, FrameRequestCallback>(), nextId: 1_000_000 }
    probeWindow.__knowbookFormFocusFrames = state
    window.requestAnimationFrame = callback => { const id = ++state.nextId; state.callbacks.set(id, callback); return id }
    window.cancelAnimationFrame = id => { if (!state.callbacks.delete(id)) state.originalCancel.call(window, id) }
  })
}

async function releaseRestoreFrames(page: Page) {
  await page.evaluate(() => {
    const state = (window as ProbeWindow).__knowbookFormFocusFrames
    if (!state) return
    window.requestAnimationFrame = state.originalRequest
    window.cancelAnimationFrame = state.originalCancel
    delete (window as ProbeWindow).__knowbookFormFocusFrames
    for (const callback of state.callbacks.values()) state.originalRequest.call(window, callback)
  })
  await twoFrames(page)
}

async function pointerTo(page: Page, target: Locator) {
  const bounds = await target.boundingBox()
  if (!bounds) throw new Error('The actual pointer target is not rendered')
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  expect(await target.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point)).toBe(true)
  await page.mouse.click(point.x, point.y)
}

test('delayed renderer restore frames do not override a newer query or modal focus @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seed(page, 'en-US')
    const before = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
    await installProbe(app)
    await watchFocus(summary(page), 'new-view')
    await query(page).fill('Beta')
    await tabTo(page, summary(page), 'query-to-negative-open', 'Shift+Tab', 8)
    await openFromFocusedSummary(page)
    await name(page).fill('Canceled delayed restore')
    try {
      // This controls renderer callbacks only, never native-window focus.
      await holdRestoreFrames(page)
      await page.keyboard.press('Escape')
      await expect(form(page)).toHaveCount(0)
      await pointerTo(page, query(page))
      await expect(query(page)).toBeFocused()
      const afterUserFocus = await focusCalls(page, 'new-view')
      await releaseRestoreFrames(page)
      await record(page, app, testInfo, 'en-delayed-restore-query')
      await expect(query(page)).toBeFocused()
      expect(await focusCalls(page, 'new-view')).toBe(afterUserFocus)
      await tabTo(page, summary(page), 'query-to-second-negative-open', 'Shift+Tab', 8)
      await openFromFocusedSummary(page)
      await name(page).fill('Canceled before another modal')
      await holdRestoreFrames(page)
      await page.keyboard.press('Escape')
      await expect(form(page)).toHaveCount(0)
      // Real pointer activation creates a new dialog before old RAF settlement.
      await pointerTo(page, saveAs(page))
      await expect(form(page)).toBeVisible()
      await pointerTo(page, name(page))
      await expect(name(page)).toBeFocused()
      const afterNewModal = await focusCalls(page, 'new-view')
      await releaseRestoreFrames(page)
      await record(page, app, testInfo, 'en-delayed-restore-new-modal')
      await expect(form(page)).toBeVisible()
      await expect(name(page)).toBeFocused()
      expect(await focusCalls(page, 'new-view')).toBe(afterNewModal)
      await page.keyboard.press('Escape')
      await expect(form(page)).toHaveCount(0)
      await twoFrames(page)
      await record(page, app, testInfo, 'en-negative-flow-closed')
      await expect(query(page)).toHaveValue('Beta')
      await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
      expect((await probeState(app)).calls).toEqual([])
      expect(await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), ids.databaseId)).toHaveLength(1)
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(before)
    } finally { await releaseRestoreFrames(page) }
  })
})
