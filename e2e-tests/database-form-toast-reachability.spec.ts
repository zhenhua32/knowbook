import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { DatabaseViewConfigV1 } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Kind = 'metadata' | 'view'
type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { kind: Kind; event: unknown; input: unknown; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { originals: Record<Kind, Handler>; requests: Request[]; failures: Array<{ kind: Kind; message: string }>; saved: Array<{ kind: Kind; result: unknown }> }
type ProbeGlobal = typeof globalThis & { __knowbookFormToastProbe?: Probe }
type ProbeWindow = Window & { __knowbookFormToastRoute?: Array<{ phase: string; step: number; tag: string | null; text: string | null; reached: boolean }> }

const sourceName = 'Form toast reachability'
const recordReason = 'The isolated record creation could not be completed.'
const metadataReason = 'The isolated database metadata could not be saved.\n' +
  'The SQLite transaction was aborted before any name or description was written.\n' +
  'This complete diagnostic remains available in the expanded details while the retained input can be corrected and retried.'
const viewReason = 'The isolated saved view could not be renamed.\nThe original query, filters and records have not been changed.'
const form = (page: Page) => page.locator('form.dbw-dialog')
const nameInput = (page: Page) => form(page).getByLabel(uiText('Name', '名称'), { exact: true })
const description = (page: Page) => form(page).getByRole('textbox', { name: uiText('Description', '描述'), exact: true })
const submit = (page: Page) => form(page).locator('button[type="submit"]')
const query = (page: Page) => page.getByLabel(uiText('Search records…', '搜索记录…'), { exact: true })

async function openMetadata(page: Page) {
  await page.getByRole('button', { name: uiText('Database settings', '数据库设置'), exact: true }).click()
  await page.locator('.dbw-action-menu').getByRole('button', { name: uiText('Edit database', '编辑数据库'), exact: true }).click()
  await expect(nameInput(page)).toBeFocused()
}

async function openRename(page: Page) {
  await page.locator('.dbw-view-tab[aria-current="page"]').dblclick()
  await expect(nameInput(page)).toBeFocused()
  await expect(form(page).locator('textarea')).toHaveCount(0)
}

async function seed(page: Page, language: 'en-US' | 'zh-CN') {
  const fixture = await page.evaluate(async ({ sourceName, language }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Original database description' })
    const stage = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Stage', type: 'select', options: ['Keep', 'Skip'] })
    for (const [title, value] of [['Alpha keep', 'Keep'], ['Beta keep', 'Keep'], ['Beta skip', 'Skip']]) {
      await window.knowbook.createDatabaseEntity({ databaseId: database.id, title, fieldValues: { [stage.id]: value } })
    }
    const fields = ['__title__', stage.id, '__document__', '__created_at__', '__updated_at__']
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Alpha',
      filters: { operator: 'and', rules: [{ id: 'keep-stage', fieldId: stage.id, operator: 'equals', value: 'Keep' }] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null }, visibleFieldIds: fields,
      fieldOrder: fields, columnWidths: { __title__: 300 }, cardFieldIds: [stage.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Original saved view', config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { database, view, entities: await window.knowbook.getDatabaseEntities(database.id),
      columns: await window.knowbook.getDocumentDatabaseColumns(database.id) }
  }, { sourceName, language })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: 850 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(sourceName)
  await expect(query(page)).toHaveValue('Alpha')
  await query(page).fill('Beta')
  await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Beta keep'])
  return fixture
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const originals = { metadata: handlers.get('knowbook:update-database-metadata'), view: handlers.get('knowbook:update-database-saved-view-form') }
    if (!originals.metadata || !originals.view) throw new Error('Real metadata and view-form IPC handlers are required')
    const probe: Probe = { originals: originals as Record<Kind, Handler>, requests: [], failures: [], saved: [] }
    ;(globalThis as ProbeGlobal).__knowbookFormToastProbe = probe
    for (const [kind, channel] of [['metadata', 'knowbook:update-database-metadata'], ['view', 'knowbook:update-database-saved-view-form']] as const) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, input) => new Promise((resolve, reject) => probe.requests.push({ kind, event, input, settled: false, resolve, reject })))
    }
  })
}

async function setFailure(app: ElectronApplication, databaseId: string, kind: 'record' | Kind, message: string | null) {
  await app.evaluate(({ app }, { databaseId, kind, message }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      const trigger = `knowbook_e2e_form_toast_${kind}`
      database.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
      if (message !== null) {
        const quote = (value: string) => value.replace(/'/g, "''")
        const target = kind === 'record' ? 'BEFORE INSERT ON database_entities' : kind === 'metadata' ? 'BEFORE UPDATE ON databases' : 'BEFORE UPDATE ON database_saved_views'
        const idField = kind === 'metadata' ? 'id' : 'database_id'
        database.exec(`CREATE TRIGGER ${trigger} ${target} WHEN NEW.${idField} = '${quote(databaseId)}' BEGIN SELECT RAISE(ABORT, '${quote(message)}'); END`)
      }
    } finally { database.close() }
  }, { databaseId, kind, message })
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookFormToastProbe!
    const request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real pending form request is required')
    request.settled = true
    setImmediate(async () => {
      try {
        const result = await probe.originals[request.kind](request.event, request.input)
        probe.saved.push({ kind: request.kind, result })
        request.resolve(result)
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason))
        probe.failures.push({ kind: request.kind, message: error.message })
        request.reject(error)
      }
    })
  }, index)
}

async function tabTo(page: Page, target: Locator, phase: string, direction: 'Tab' | 'Shift+Tab' = 'Tab', limit = 12) {
  let reached = false
  for (let step = 1; step <= limit; step++) {
    await page.keyboard.press(direction)
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const stop = { phase, step, tag: active?.tagName ?? null, text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null, reached: active === element }
      ;((window as ProbeWindow).__knowbookFormToastRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookFormToastProbe!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds() })),
      requests: probe.requests.map(({ kind, input, settled }) => ({ kind, input, settled })), failures: probe.failures, saved: probe.saved }
  })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const box = (element: Element) => {
      const bounds = rect(element), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = rect(parent)
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left + parent.clientLeft); clip.right = Math.min(clip.right, bounds.left + parent.clientLeft + parent.clientWidth) }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, bounds.top + parent.clientTop + parent.clientHeight) }
        if (style.position === 'fixed') break
      }
      const style = getComputedStyle(element), hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      const width = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left)), height = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      return { rect: bounds, clip, visible: bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        visibleRatio: bounds.width && bounds.height ? width * height / (bounds.width * bounds.height) : 0,
        centerHit: hit === element || Boolean(hit && element.contains(hit)), hit: hit ? { tag: hit.tagName, className: hit.getAttribute('class'), notificationId: hit.closest('[data-notification-id]')?.getAttribute('data-notification-id') } : null }
    }
    const toasts = Array.from(document.querySelectorAll('.app-notifications .app-notification-summary, .app-notifications .app-notification')).map(element => ({
      id: element.getAttribute('data-notification-id'), message: element.querySelector('.app-notification-message')?.textContent, ...box(element) }))
    const visibleToasts = toasts.filter(toast => toast.visible), modal = document.querySelector<HTMLFormElement>('form.dbw-dialog')
    const active = document.activeElement as HTMLElement | null, details = modal?.querySelector<HTMLDetailsElement>('.dbw-form-error-details')
    const body = modal?.querySelector<HTMLElement>('.dbw-form-body')
    const center = document.querySelector<HTMLDialogElement>('.notification-center')
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName, className: active?.getAttribute('class'),
      label: active?.getAttribute('aria-label'), isBody: active === document.body, text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null },
      modal: modal ? { ...box(modal), scrollTop: modal.scrollTop, clientHeight: modal.clientHeight, scrollHeight: modal.scrollHeight } : null,
      body: body ? { ...box(body), scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight } : null,
      notificationCenter: center ? { open: center.open, containsActive: Boolean(active && center.contains(active)), ...box(center),
        buttons: Array.from(center.querySelectorAll<HTMLButtonElement>('button')).map(button => ({ text: button.textContent?.trim(),
          disabled: button.disabled, focused: active === button })) } : null,
      footer: modal?.querySelector('footer') ? box(modal.querySelector('footer')!) : null,
      localError: modal?.querySelector('[role="alert"]') ? box(modal.querySelector('[role="alert"]')!) : null,
      localErrorCount: modal?.querySelectorAll('[role="alert"]').length ?? 0,
      details: details ? { open: details.open, cause: details.querySelector('pre')?.textContent, ...box(details) } : null,
      inputs: Array.from(modal?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea') ?? []).map(input => ({
        value: input.value, readOnly: input.readOnly, focused: active === input, selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd, selectionDirection: input.selectionDirection, ...box(input) })),
      buttons: Array.from(modal?.querySelectorAll<HTMLButtonElement>('footer > button') ?? []).map(button => {
        const geometry = box(button)
        return { text: button.textContent, focused: active === button, disabled: button.disabled, ...geometry,
          intersectsToasts: visibleToasts.filter(toast => Math.min(geometry.rect.right, toast.rect.right) > Math.max(geometry.rect.left, toast.rect.left)
            && Math.min(geometry.rect.bottom, toast.rect.bottom) > Math.max(geometry.rect.top, toast.rect.top)).map(toast => toast.id) }
      }), toasts, visibleToastCount: visibleToasts.length, query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      route: (window as ProbeWindow).__knowbookFormToastRoute ?? [] }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return { main, state }
}

async function expectActionsReachable(page: Page, state: Awaited<ReturnType<typeof record>>['state']) {
  expect(state.buttons).toHaveLength(2)
  for (const button of state.buttons) { expect(button.visibleRatio).toBe(1); expect(button.centerHit).toBe(true); expect(button.intersectsToasts).toEqual([]) }
  for (const button of await form(page).locator('footer > button').all()) await expect(button).toBeInViewport({ ratio: 1 })
}

async function expectFocusedFieldReachable(target: Locator, state: Awaited<ReturnType<typeof record>>['state']) {
  const focused = state.inputs.filter(input => input.focused)
  expect(focused).toHaveLength(1)
  expect(focused[0].visibleRatio).toBe(1)
  expect(focused[0].centerHit).toBe(true)
  await expect(target).toBeFocused()
  await expect(target).toBeInViewport({ ratio: 1 })
}

function expectFailureVisible(state: Awaited<ReturnType<typeof record>>['state']) {
  expect(state.localErrorCount).toBe(1)
  expect(state.localError).not.toBeNull()
  expect(state.localError!.visibleRatio).toBe(1)
  expect(state.localError!.centerHit).toBe(true)
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`persistent record toast leaves database form actions reachable in ${language} @electron`, async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const fixture = await seed(page, language)
    await installProbe(app)
    // Reference naturally sized forms before any failure notification exists.
    await openMetadata(page)
    const naturalMetadata = await record(page, app, testInfo, `${language}-metadata-natural-height-without-toast`)
    expect(naturalMetadata.state.visibleToastCount).toBe(0)
    await expectActionsReachable(page, naturalMetadata.state)
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    await openRename(page)
    const naturalView = await record(page, app, testInfo, `${language}-no-description-natural-height-without-toast`)
    await expectActionsReachable(page, naturalView.state)
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    await setFailure(app, fixture.database.id, 'record', recordReason)
    await page.getByRole('button', { name: uiText('New record', '新建记录'), exact: true }).click()
    const recordDialog = page.getByRole('dialog', { name: uiText('Create record', '新建记录'), exact: true })
    await recordDialog.getByRole('textbox', { name: /Title|标题/ }).fill('Record failure supplies persistent notice')
    await tabTo(page, recordDialog.locator('footer > .dbw-primary-button'), 'record-title-to-create')
    await page.keyboard.press('Enter')
    await expect(recordDialog.getByRole('alert')).toBeVisible()
    const toast = page.getByTestId('notification-summary')
    // The 850px initial viewport is wide. A short renderer viewport activates
    // the real compact notification before opening the generic form.
    await page.keyboard.press('Escape')
    await expect(recordDialog).toHaveCount(0)
    await page.setViewportSize({ width: 760, height: 440 })
    await expect(toast).toBeVisible()
    await expect(toast.locator('.app-notification-message')).toContainText(recordReason)
    const toastId = await toast.getAttribute('data-notification-id')
    expect(toastId).not.toBeNull()
    await openMetadata(page)
    await nameInput(page).fill('Retained metadata name')
    const retainedDescription = language === 'zh-CN' ? '保留的描述可以通过键盘修改和重新提交。' : 'The retained description can be edited and submitted again.'
    await description(page).fill(retainedDescription)
    await setFailure(app, fixture.database.id, 'metadata', metadataReason)
    await tabTo(page, submit(page), 'description-to-metadata-submit')
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookFormToastProbe!.requests.length)).toBe(1)
    await expect(nameInput(page)).toHaveJSProperty('readOnly', true)
    await expect(description(page)).toHaveJSProperty('readOnly', true)
    await expect(nameInput(page)).toBeEnabled()
    await expect(description(page)).toBeEnabled()
    await expect(submit(page)).toHaveAttribute('aria-busy', 'true')
    await expect(submit(page)).toBeFocused()
    const pending = await record(page, app, testInfo, `${language}-metadata-pending-readonly-fields`)
    await expectActionsReachable(page, pending.state)
    await settle(app, 0)
    await expect(form(page).getByRole('alert')).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
    const details = form(page).locator('.dbw-form-error-details')
    await expect(details).toHaveJSProperty('open', false)
    await expect(details.locator('pre')).not.toBeVisible()
    await expect(details.locator('pre')).toContainText(metadataReason)
    await expect(details.locator('pre')).not.toContainText(/Error invoking|remote method/i)
    const failed = await record(page, app, testInfo, `${language}-persistent-toast-metadata-failure-collapsed`)
    expect(failed.main.requests).toHaveLength(1)
    expect(failed.main.saved).toEqual([])
    expect(failed.main.failures).toEqual([{ kind: 'metadata', message: metadataReason }])
    await expect(toast).toHaveAttribute('data-notification-id', toastId!)
    await expect(nameInput(page)).toHaveValue('Retained metadata name')
    await expect(description(page)).toHaveValue(retainedDescription)
    await expect(query(page)).toHaveValue('Beta')
    await expect(submit(page)).toBeFocused()
    expect((await page.evaluate(() => window.knowbook.getDatabases())).find(database => database.id === fixture.database.id)).toEqual(fixture.database)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
    // Capture the old-build toast overlap and clipping before this strict
    // oracle. No notices are dismissed, expired or hidden to make it pass.
    await expectActionsReachable(page, failed.state)
    expectFailureVisible(failed.state)
    await tabTo(page, details.locator('summary'), 'metadata-submit-back-to-details', 'Shift+Tab')
    await expect(details.locator('summary')).toHaveAccessibleName(uiText('Error details', '错误详情'))
    await page.keyboard.press('Space')
    await expect(details).toHaveJSProperty('open', true)
    await expect(details.locator('pre')).toBeVisible()
    await expect(details.locator('pre')).toContainText(metadataReason)
    const expanded = await record(page, app, testInfo, `${language}-long-metadata-details-expanded-under-persistent-toast`)
    await expectActionsReachable(page, expanded.state)
    expectFailureVisible(expanded.state)
    await tabTo(page, description(page), 'expanded-details-back-to-description', 'Shift+Tab')
    const descriptionFocused = await record(page, app, testInfo, `${language}-keyboard-description-fully-visible`)
    await expectFocusedFieldReachable(description(page), descriptionFocused.state)
    expectFailureVisible(descriptionFocused.state)
    const correctedDescription = `${retainedDescription} Keyboard correction preserved.`
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(correctedDescription)
    await tabTo(page, nameInput(page), 'description-back-to-metadata-name', 'Shift+Tab')
    const nameFocused = await record(page, app, testInfo, `${language}-keyboard-metadata-name-fully-visible`)
    await expectFocusedFieldReachable(nameInput(page), nameFocused.state)
    expectFailureVisible(nameFocused.state)
    const correctedName = 'Keyboard-corrected database metadata'
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(correctedName)
    const pointerReady = await record(page, app, testInfo, `${language}-persistent-toast-before-metadata-pointer-retry`)
    await expectActionsReachable(page, pointerReady.state)
    expectFailureVisible(pointerReady.state)
    await setFailure(app, fixture.database.id, 'metadata', null)
    await submit(page).click()
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookFormToastProbe!.requests.length)).toBe(2)
    await settle(app, 1)
    await expect(form(page)).toHaveCount(0)
    await expect(page.locator('.dbw-source-trigger')).toContainText(correctedName)
    await expect(query(page)).toHaveValue('Beta')
    await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
    await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Beta keep'])
    await expect(toast).toHaveAttribute('data-notification-id', toastId!)
    const savedMetadata = (await page.evaluate(() => window.knowbook.getDatabases())).find(database => database.id === fixture.database.id)!
    expect(savedMetadata).toMatchObject({ name: correctedName, description: correctedDescription })
    expect(await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id)).toEqual([fixture.view])

    // The same bounded form layout must also serve a form with no Description.
    await openRename(page)
    await page.setViewportSize({ width: 760, height: 850 })
    const tallView = await record(page, app, testInfo, `${language}-no-description-tall-compact-toast-natural-height`)
    await expectFocusedFieldReachable(nameInput(page), tallView.state)
    await expectActionsReachable(page, tallView.state)
    expect(tallView.state.modal).not.toBeNull()
    expect(naturalView.state.modal).not.toBeNull()
    expect(tallView.state.modal!.rect.height).toBeLessThanOrEqual(naturalView.state.modal!.rect.height + 2)
    await page.setViewportSize({ width: 760, height: 440 })
    await nameInput(page).fill('Retained view rename')
    await setFailure(app, fixture.database.id, 'view', viewReason)
    await tabTo(page, submit(page), 'view-name-to-submit')
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookFormToastProbe!.requests.length)).toBe(3)
    await expect(nameInput(page)).toHaveJSProperty('readOnly', true)
    await expect(submit(page)).toBeFocused()
    await settle(app, 2)
    await expect(form(page).getByRole('alert')).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
    const viewDetails = form(page).locator('.dbw-form-error-details')
    await expect(viewDetails).toHaveJSProperty('open', false)
    await expect(viewDetails.locator('pre')).not.toBeVisible()
    await expect(viewDetails.locator('pre')).toContainText(viewReason)
    await expect(viewDetails.locator('pre')).not.toContainText(/Error invoking|remote method/i)
    const viewFailed = await record(page, app, testInfo, `${language}-no-description-view-failure-collapsed`)
    await expectActionsReachable(page, viewFailed.state)
    expectFailureVisible(viewFailed.state)
    await expect(submit(page)).toBeFocused()
    await expect(nameInput(page)).toHaveValue('Retained view rename')
    await expect(toast).toHaveAttribute('data-notification-id', toastId!)
    await tabTo(page, viewDetails.locator('summary'), 'view-submit-back-to-details', 'Shift+Tab')
    await page.keyboard.press('Space')
    await expect(viewDetails).toHaveJSProperty('open', true)
    await expect(viewDetails.locator('pre')).toBeVisible()
    const viewExpanded = await record(page, app, testInfo, `${language}-no-description-view-failure-expanded`)
    await expectActionsReachable(page, viewExpanded.state)
    expectFailureVisible(viewExpanded.state)
    await tabTo(page, nameInput(page), 'view-details-back-to-name', 'Shift+Tab')
    const viewNameFocused = await record(page, app, testInfo, `${language}-no-description-keyboard-name-visible`)
    await expectFocusedFieldReachable(nameInput(page), viewNameFocused.state)
    expectFailureVisible(viewNameFocused.state)
    const correctedViewName = 'Keyboard-corrected saved view'
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(correctedViewName)
    const viewPointerReady = await record(page, app, testInfo, `${language}-persistent-toast-before-view-pointer-retry`)
    await expectActionsReachable(page, viewPointerReady.state)
    expectFailureVisible(viewPointerReady.state)
    await setFailure(app, fixture.database.id, 'view', null)
    await submit(page).click()
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookFormToastProbe!.requests.length)).toBe(4)
    await settle(app, 3)
    await expect(form(page)).toHaveCount(0)
    await expect(page.locator('.dbw-view-tab[aria-current="page"]')).toHaveAttribute('title', correctedViewName)
    await expect(query(page)).toHaveValue('Beta')
    await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
    const savedViews = await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id)
    expect(savedViews).toHaveLength(1)
    expect(savedViews[0]).toMatchObject({ id: fixture.view.id, name: correctedViewName, config: fixture.view.config })

    // Only after both true-SQL failure/retry branches pass do we explicitly
    // hand focus to the notification center and clear its completed history.
    await openRename(page)
    const retainedNode = await nameInput(page).elementHandle()
    expect(retainedNode).not.toBeNull()
    await nameInput(page).fill('Unsaved name survives notification clearance')
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    const selection = await nameInput(page).evaluate(input => ({ value: (input as HTMLInputElement).value,
      start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd }))
    await expectActionsReachable(page, (await record(page, app, testInfo, `${language}-late-uncleared-toast-with-selected-name`)).state)
    // Media changes must preserve focus owned by the form, even when the live
    // notification changes from its compact summary to the full card and back.
    for (const [phase, viewport] of [
      ['wide-tall-full-notice', { width: 1180, height: 850 }],
      ['narrow-tall-compact-notice', { width: 760, height: 850 }],
      ['narrow-short-compact-notice', { width: 760, height: 440 }]
    ] as const) {
      await page.setViewportSize(viewport)
      if (phase === 'wide-tall-full-notice') {
        await expect(toast).toHaveCount(0)
        const fullNotice = page.locator('.app-notifications .app-notification').first()
        await expect(fullNotice).toHaveAttribute('data-notification-id', toastId!)
        await expect(fullNotice).toBeVisible()
      } else {
        await expect(toast).toHaveAttribute('data-notification-id', toastId!)
        await expect(toast).toBeVisible()
      }
      const media = await record(page, app, testInfo, `${language}-selected-name-media-${phase}`)
      expect(await retainedNode!.evaluate(node => node.isConnected && node === document.querySelector('form.dbw-dialog input'))).toBe(true)
      expect(await nameInput(page).evaluate(input => ({ value: (input as HTMLInputElement).value,
        start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd }))).toEqual(selection)
      await expectFocusedFieldReachable(nameInput(page), media.state)
      await expectActionsReachable(page, media.state)
    }
    await toast.getByRole('button', { name: uiText('View 1 notification', '查看 1 条通知'), exact: true }).click()
    const center = page.getByRole('dialog', { name: uiText('Notification center', '通知中心'), exact: true })
    await expect(center.locator('.app-notification')).toHaveCount(1)
    await center.getByRole('button', { name: uiText('Clear completed', '清除已结束通知'), exact: true }).click()
    await expect(center.locator('.app-notification')).toHaveCount(0)
    await record(page, app, testInfo, `${language}-center-cleared-before-real-escape`)
    expect(await retainedNode!.evaluate(node => node.isConnected && node === document.querySelector('form.dbw-dialog input'))).toBe(true)
    expect(await nameInput(page).evaluate(input => ({ value: (input as HTMLInputElement).value,
      start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd }))).toEqual(selection)
    await page.keyboard.press('Escape')
    await record(page, app, testInfo, `${language}-center-after-real-escape-before-close-oracle`)
    await expect(center).toHaveCount(0)
    await expect(page.locator('.notification-bell')).toBeFocused()
    expect(await retainedNode!.evaluate(node => node.isConnected && node === document.querySelector('form.dbw-dialog input'))).toBe(true)
    expect(await nameInput(page).evaluate(input => ({ value: (input as HTMLInputElement).value,
      start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd }))).toEqual(selection)
    await tabTo(page, nameInput(page), 'center-bell-back-to-retained-name')
    const noToastShort = await record(page, app, testInfo, `${language}-no-toast-short-retained-form-and-selection`)
    expect(noToastShort.state.visibleToastCount).toBe(0)
    await expectFocusedFieldReachable(nameInput(page), noToastShort.state)
    await expectActionsReachable(page, noToastShort.state)
    await page.setViewportSize({ width: 760, height: 850 })
    const noToastTall = await record(page, app, testInfo, `${language}-no-toast-tall-natural-view-form`)
    await expectFocusedFieldReachable(nameInput(page), noToastTall.state)
    await expectActionsReachable(page, noToastTall.state)
    expect(noToastTall.state.modal!.rect.height).toBeLessThanOrEqual(naturalView.state.modal!.rect.height + 2)
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    const final = await record(page, app, testInfo, `${language}-real-saved-state-and-unchanged-records`)
    expect(final.main.requests).toHaveLength(4)
    expect(final.main.saved.map(saved => saved.kind)).toEqual(['metadata', 'view'])
    expect(final.main.failures).toEqual([{ kind: 'metadata', message: metadataReason }, { kind: 'view', message: viewReason }])
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
    expect(await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), fixture.database.id)).toEqual(fixture.columns)
    expect(await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id)).toEqual(savedViews)
    expect((await page.evaluate(() => window.knowbook.getDatabases())).find(database => database.id === fixture.database.id)).toEqual(savedMetadata)
    await expect(query(page)).toHaveValue('Beta')
    await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Beta keep'])
    expect(errors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
