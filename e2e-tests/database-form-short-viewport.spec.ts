import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { DatabaseViewConfigV1 } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Kind = 'metadata' | 'view'
type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { kind: Kind; event: unknown; input: unknown; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { originals: Record<Kind, Handler>; requests: Request[]; saved: Array<{ kind: Kind; result: unknown }>; failures: Array<{ kind: Kind; message: string }> }
type ProbeGlobal = typeof globalThis & { __knowbookShortFormProbe?: Probe }
type ProbeWindow = Window & { __knowbookShortFormRoute?: Array<{ phase: string; step: number; tag: string | null; reached: boolean }> }

const sourceName = 'Short form viewport'
const metadataReason = 'The isolated metadata update was rejected before writing any retained input.\n' +
  'The original database name and multiline description are still stored. This long diagnostic explains the failure without replacing the readable retry instruction.\n' +
  'Additional detail: the renderer must keep the full Name and Description controls reachable while this SQLite diagnostic is expanded in a short viewport.'
const viewReason = 'The isolated saved-view rename was rejected before changing its original name or config.\n' +
  'This view has no Description field. Its long diagnostic must scroll inside the form body while the dialog heading, readable error and both action buttons remain available.\n' +
  'Additional detail: changing the view name must not overwrite the retained Beta query, Keep filter, field order or any database record.'
// Measured old UI, not a CSS-derived budget: R55's 1180x850 no-toast
// metadata baseline was 370px; the corresponding R54 view baseline was
// 244.6667px. These checks also catch a newly stretched, empty tall form.
const oldNaturalHeight = { metadata: 370, view: 244.6667 }
const form = (page: Page) => page.locator('form.dbw-form-dialog')
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

async function settleLayout(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
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
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Original short-form view', config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { database, view, entities: await window.knowbook.getDatabaseEntities(database.id), columns: await window.knowbook.getDocumentDatabaseColumns(database.id) }
  }, { sourceName, language })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: 850 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(sourceName)
  await query(page).fill('Beta')
  await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Beta keep'])
  await expect(page.locator('.app-notifications')).toHaveCount(0)
  return fixture
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const originals = { metadata: handlers.get('knowbook:update-database-metadata'), view: handlers.get('knowbook:update-database-saved-view-form') }
    if (!originals.metadata || !originals.view) throw new Error('Real metadata and view-form handlers are required')
    const probe: Probe = { originals: originals as Record<Kind, Handler>, requests: [], saved: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookShortFormProbe = probe
    for (const [kind, channel] of [['metadata', 'knowbook:update-database-metadata'], ['view', 'knowbook:update-database-saved-view-form']] as const) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, input) => new Promise((resolve, reject) => probe.requests.push({ kind, event, input, settled: false, resolve, reject })))
    }
  })
}

async function setFailure(app: ElectronApplication, databaseId: string, kind: Kind, message: string | null) {
  await app.evaluate(({ app }, { databaseId, kind, message }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      const trigger = `knowbook_e2e_short_form_${kind}`
      database.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
      if (message !== null) {
        const quote = (value: string) => value.replace(/'/g, "''")
        const table = kind === 'metadata' ? 'databases' : 'database_saved_views', idField = kind === 'metadata' ? 'id' : 'database_id'
        database.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table} WHEN NEW.${idField} = '${quote(databaseId)}' BEGIN SELECT RAISE(ABORT, '${quote(message)}'); END`)
      }
    } finally { database.close() }
  }, { databaseId, kind, message })
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookShortFormProbe!, request = probe.requests[index]
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
      const stop = { phase, step, tag: document.activeElement?.tagName ?? null, reached: document.activeElement === element }
      ;((window as ProbeWindow).__knowbookShortFormRoute ??= []).push(stop)
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
    const probe = (globalThis as ProbeGlobal).__knowbookShortFormProbe!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds() })),
      requests: probe.requests.map(({ kind, input, settled }) => ({ kind, input, settled })), saved: probe.saved, failures: probe.failures }
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
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      const width = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left)), height = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      return { rect: bounds, clip, visibleRatio: bounds.width && bounds.height ? width * height / (bounds.width * bounds.height) : 0,
        centerHit: hit === element || Boolean(hit && element.contains(hit)), hit: hit ? { tag: hit.tagName, className: hit.getAttribute('class') } : null }
    }
    const modal = document.querySelector<HTMLFormElement>('form.dbw-form-dialog'), body = modal?.querySelector<HTMLElement>('.dbw-form-body')
    const active = document.activeElement as HTMLElement | null, details = modal?.querySelector<HTMLDetailsElement>('.dbw-form-error-details')
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName, isBody: active === document.body, text: active?.tagName === 'BUTTON' ? active.textContent : null },
      notificationCount: document.querySelectorAll('.app-notifications').length,
      modal: modal ? { ...box(modal), scrollTop: modal.scrollTop, clientHeight: modal.clientHeight, scrollHeight: modal.scrollHeight } : null,
      header: modal?.querySelector('header') ? box(modal.querySelector('header')!) : null,
      headerItems: Array.from(modal?.querySelectorAll('header h2,header button') ?? []).map(box),
      body: body ? { ...box(body), display: getComputedStyle(body).display, scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight } : null,
      footer: modal?.querySelector('footer') ? box(modal.querySelector('footer')!) : null,
      localErrorCount: modal?.querySelectorAll('[role="alert"]').length ?? 0,
      localError: modal?.querySelector('[role="alert"]') ? { text: modal.querySelector('[role="alert"]')?.textContent, ...box(modal.querySelector('[role="alert"]')!) } : null,
      details: details ? { open: details.open, cause: details.querySelector('pre')?.textContent, ...box(details) } : null,
      inputs: Array.from(modal?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea') ?? []).map(input => ({
        value: input.value, readOnly: input.readOnly, focused: active === input, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, ...box(input) })),
      buttons: Array.from(modal?.querySelectorAll<HTMLButtonElement>('footer > button') ?? []).map(button => ({ text: button.textContent, disabled: button.disabled,
        focused: active === button, ariaBusy: button.getAttribute('aria-busy'), ariaDisabled: button.getAttribute('aria-disabled'), ...box(button) })),
      route: (window as ProbeWindow).__knowbookShortFormRoute ?? [] }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  expect(state.notificationCount).toBe(0)
  await expect(page.locator('.app-notifications')).toHaveCount(0)
  return { main, state }
}

async function expectActionsReachable(page: Page, state: Awaited<ReturnType<typeof record>>['state']) {
  expect(state.buttons).toHaveLength(2)
  for (const button of state.buttons) { expect(button.visibleRatio).toBe(1); expect(button.centerHit).toBe(true) }
  for (const button of await form(page).locator('footer > button').all()) await expect(button).toBeInViewport({ ratio: 1 })
}

function expectFailureVisible(state: Awaited<ReturnType<typeof record>>['state']) {
  expect(state.localErrorCount).toBe(1)
  expect(state.localError).not.toBeNull()
  expect(state.localError!.visibleRatio).toBe(1)
  expect(state.localError!.centerHit).toBe(true)
}

async function expectFocusedFieldReachable(target: Locator, state: Awaited<ReturnType<typeof record>>['state']) {
  const focused = state.inputs.filter(input => input.focused)
  expect(focused).toHaveLength(1)
  expect(focused[0].visibleRatio).toBe(1)
  expect(focused[0].centerHit).toBe(true)
  await expect(target).toBeFocused()
  await expect(target).toBeInViewport({ ratio: 1 })
}

function expectNaturalHeight(state: Awaited<ReturnType<typeof record>>['state'], kind: Kind) {
  expect(state.modal).not.toBeNull()
  expect(Math.abs(state.modal!.rect.height - oldNaturalHeight[kind])).toBeLessThanOrEqual(2)
}

async function resizeFocusedField(page: Page, app: ElectronApplication, testInfo: TestInfo, target: Locator, phase: string) {
  const node = await target.elementHandle()
  expect(node).not.toBeNull()
  const selection = await target.evaluate(element => {
    const input = element as HTMLInputElement | HTMLTextAreaElement
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd }
  })
  for (const [size, viewport] of [
    ['short', { width: 760, height: 440 }], ['narrow-tall', { width: 760, height: 850 }],
    ['wide-tall', { width: 1180, height: 850 }], ['short-return', { width: 760, height: 440 }]
  ] as const) {
    await page.setViewportSize(viewport)
    await settleLayout(page)
    const snapshot = await record(page, app, testInfo, `${phase}-${size}`)
    expect(await node!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true)
    expect(await target.evaluate(element => {
      const input = element as HTMLInputElement | HTMLTextAreaElement
      return { value: input.value, start: input.selectionStart, end: input.selectionEnd }
    })).toEqual(selection)
    await expectFocusedFieldReachable(target, snapshot.state)
    await expectActionsReachable(page, snapshot.state)
    expectFailureVisible(snapshot.state)
  }
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`without-toast short viewport keeps database form failure actions reachable in ${language} @electron`, async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const fixture = await seed(page, language)
    await installProbe(app)
    await openMetadata(page)
    const natural = await record(page, app, testInfo, `${language}-natural-metadata-height-without-toast`)
    await expectActionsReachable(page, natural.state)
    expectNaturalHeight(natural.state, 'metadata')
    await page.setViewportSize({ width: 760, height: 850 })
    await settleLayout(page)
    const naturalTall = await record(page, app, testInfo, `${language}-narrow-tall-natural-metadata-without-toast`)
    expectNaturalHeight(naturalTall.state, 'metadata')
    await expectFocusedFieldReachable(nameInput(page), naturalTall.state)
    await expectActionsReachable(page, naturalTall.state)
    await page.keyboard.press('Escape')
    await expect(form(page)).toHaveCount(0)
    await page.setViewportSize({ width: 760, height: 440 })
    await openMetadata(page)
    const retainedName = 'Retained short-window metadata'
    const retainedDescription = language === 'zh-CN'
      ? '第一行：保留描述。\n第二行：SQLite 失败后仍可编辑。\n第三行：只通过真实操作重新提交。'
      : 'First line: keep this description.\nSecond line: a SQLite failure preserves editing.\nThird line: retry through real user actions.'
    await nameInput(page).fill(retainedName)
    await description(page).fill(retainedDescription)
    await setFailure(app, fixture.database.id, 'metadata', metadataReason)
    await tabTo(page, submit(page), 'short-description-to-submit')
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookShortFormProbe!.requests.length)).toBe(1)
    await expect(nameInput(page)).toHaveJSProperty('readOnly', true)
    await expect(description(page)).toHaveJSProperty('readOnly', true)
    await expect(nameInput(page)).toBeEnabled()
    await expect(description(page)).toBeEnabled()
    await expect(submit(page)).toHaveAttribute('aria-busy', 'true')
    await expect(submit(page)).toBeFocused()
    await expectActionsReachable(page, (await record(page, app, testInfo, `${language}-short-metadata-pending-readonly`)).state)
    await settle(app, 0)
    await expect(form(page).getByRole('alert')).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
    const details = form(page).locator('.dbw-form-error-details')
    await expect(details).toHaveJSProperty('open', false)
    await expect(details.locator('pre')).not.toBeVisible()
    await expect(details.locator('pre')).toContainText(metadataReason)
    await expect(details.locator('pre')).not.toContainText(/Error invoking|remote method/i)
    const failed = await record(page, app, testInfo, `${language}-short-no-toast-metadata-failure-collapsed`)
    expect(failed.main.requests).toHaveLength(1)
    expect(failed.main.saved).toEqual([])
    expect(failed.main.failures).toEqual([{ kind: 'metadata', message: metadataReason }])
    await expect(nameInput(page)).toHaveValue(retainedName)
    await expect(description(page)).toHaveValue(retainedDescription)
    await expect(submit(page)).toBeFocused()
    await expect(query(page)).toHaveValue('Beta')
    expect((await page.evaluate(() => window.knowbook.getDatabases())).find(database => database.id === fixture.database.id)).toEqual(fixture.database)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
    // Save old-build PNG/JSON before demanding real full-box visibility. This
    // flow never creates, dismisses or hides a notification to affect layout.
    await expectActionsReachable(page, failed.state)
    expectFailureVisible(failed.state)
    await tabTo(page, details.locator('summary'), 'metadata-submit-back-to-details', 'Shift+Tab')
    await expect(details.locator('summary')).toHaveAccessibleName(uiText('Error details', '错误详情'))
    await page.keyboard.press('Space')
    await expect(details).toHaveJSProperty('open', true)
    await expect(details.locator('pre')).toBeVisible()
    const expanded = await record(page, app, testInfo, `${language}-short-long-metadata-details-expanded`)
    await expectActionsReachable(page, expanded.state)
    expectFailureVisible(expanded.state)
    expect(expanded.state.body!.scrollHeight).toBeGreaterThan(expanded.state.body!.clientHeight)
    await tabTo(page, description(page), 'expanded-details-back-to-description', 'Shift+Tab')
    const descFocused = await record(page, app, testInfo, `${language}-short-description-whole-control-visible`)
    await expectFocusedFieldReachable(description(page), descFocused.state)
    expectFailureVisible(descFocused.state)
    const correctedDescription = `${retainedDescription}\nKeyboard correction retained on the fourth line.`
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(correctedDescription)
    await page.keyboard.press('ControlOrMeta+Home')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await resizeFocusedField(page, app, testInfo, description(page), `${language}-selected-description-media`)
    await tabTo(page, nameInput(page), 'description-back-to-metadata-name', 'Shift+Tab')
    const nameFocused = await record(page, app, testInfo, `${language}-short-metadata-name-whole-control-visible`)
    await expectFocusedFieldReachable(nameInput(page), nameFocused.state)
    expectFailureVisible(nameFocused.state)
    const correctedName = 'Keyboard-corrected short-window metadata'
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(correctedName)
    await page.keyboard.press('Home')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await resizeFocusedField(page, app, testInfo, nameInput(page), `${language}-selected-metadata-name-media`)
    const pointerReady = await record(page, app, testInfo, `${language}-no-toast-metadata-pointer-retry-ready`)
    await expectActionsReachable(page, pointerReady.state)
    expectFailureVisible(pointerReady.state)
    await setFailure(app, fixture.database.id, 'metadata', null)
    await submit(page).click()
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookShortFormProbe!.requests.length)).toBe(2)
    await settle(app, 1)
    await expect(form(page)).toHaveCount(0)
    await expect(page.locator('.dbw-source-trigger')).toContainText(correctedName)
    await expect(query(page)).toHaveValue('Beta')
    await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
    await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Beta keep'])
    const savedMetadata = (await page.evaluate(() => window.knowbook.getDatabases())).find(database => database.id === fixture.database.id)!
    expect(savedMetadata).toMatchObject({ name: correctedName, description: correctedDescription })
    expect(await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id)).toEqual([fixture.view])

    // The no-Description form must retain its old natural height in a tall
    // viewport, then scroll only its body when a real long error is expanded.
    await page.setViewportSize({ width: 1180, height: 850 })
    await openRename(page)
    const naturalView = await record(page, app, testInfo, `${language}-no-description-natural-height-without-toast`)
    expectNaturalHeight(naturalView.state, 'view')
    await expectActionsReachable(page, naturalView.state)
    await page.setViewportSize({ width: 760, height: 850 })
    await settleLayout(page)
    const tallView = await record(page, app, testInfo, `${language}-no-description-narrow-tall-natural-height`)
    expectNaturalHeight(tallView.state, 'view')
    await expectFocusedFieldReachable(nameInput(page), tallView.state)
    await expectActionsReachable(page, tallView.state)
    await page.setViewportSize({ width: 760, height: 440 })
    await nameInput(page).fill('Retained short-window view rename')
    await setFailure(app, fixture.database.id, 'view', viewReason)
    await tabTo(page, submit(page), 'view-name-to-submit')
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookShortFormProbe!.requests.length)).toBe(3)
    await expect(nameInput(page)).toHaveJSProperty('readOnly', true)
    await expect(nameInput(page)).toBeEnabled()
    await expect(submit(page)).toBeFocused()
    await expect(submit(page)).toHaveAttribute('aria-busy', 'true')
    await settle(app, 2)
    await expect(form(page).getByRole('alert')).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
    const viewDetails = form(page).locator('.dbw-form-error-details')
    await expect(viewDetails).toHaveJSProperty('open', false)
    await expect(viewDetails.locator('pre')).not.toBeVisible()
    await expect(viewDetails.locator('pre')).toContainText(viewReason)
    await expect(viewDetails.locator('pre')).not.toContainText(/Error invoking|remote method/i)
    const viewFailed = await record(page, app, testInfo, `${language}-no-description-failure-collapsed`)
    await expectActionsReachable(page, viewFailed.state)
    expectFailureVisible(viewFailed.state)
    await expect(submit(page)).toBeFocused()
    await expect(nameInput(page)).toHaveValue('Retained short-window view rename')
    expect(await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id)).toEqual([fixture.view])
    await tabTo(page, viewDetails.locator('summary'), 'view-submit-back-to-details', 'Shift+Tab')
    await page.keyboard.press('Space')
    await expect(viewDetails).toHaveJSProperty('open', true)
    await expect(viewDetails.locator('pre')).toBeVisible()
    const viewExpanded = await record(page, app, testInfo, `${language}-no-description-long-failure-expanded`)
    await expectActionsReachable(page, viewExpanded.state)
    expectFailureVisible(viewExpanded.state)
    expect(viewExpanded.state.body!.scrollHeight).toBeGreaterThan(viewExpanded.state.body!.clientHeight)
    expect(viewExpanded.state.headerItems).toHaveLength(2)
    for (const item of viewExpanded.state.headerItems) { expect(item.visibleRatio).toBe(1); expect(item.centerHit).toBe(true) }
    await tabTo(page, nameInput(page), 'view-details-back-to-name', 'Shift+Tab')
    const viewNameFocused = await record(page, app, testInfo, `${language}-no-description-keyboard-name-visible`)
    await expectFocusedFieldReachable(nameInput(page), viewNameFocused.state)
    expectFailureVisible(viewNameFocused.state)
    const correctedViewName = 'Keyboard-corrected short-window view'
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(correctedViewName)
    const viewPointerReady = await record(page, app, testInfo, `${language}-no-description-pointer-retry-ready`)
    await expectActionsReachable(page, viewPointerReady.state)
    expectFailureVisible(viewPointerReady.state)
    await setFailure(app, fixture.database.id, 'view', null)
    await submit(page).click()
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookShortFormProbe!.requests.length)).toBe(4)
    await settle(app, 3)
    await expect(form(page)).toHaveCount(0)
    await expect(page.locator('.dbw-view-tab[aria-current="page"]')).toHaveAttribute('title', correctedViewName)
    const savedViews = await page.evaluate(id => window.knowbook.getDatabaseSavedViews(id), fixture.database.id)
    expect(savedViews).toHaveLength(1)
    expect(savedViews[0]).toMatchObject({ id: fixture.view.id, name: correctedViewName, config: fixture.view.config })
    const final = await record(page, app, testInfo, `${language}-two-real-writes-and-unchanged-draft-records`)
    expect(final.main.requests).toHaveLength(4)
    expect(final.main.saved.map(saved => saved.kind)).toEqual(['metadata', 'view'])
    expect(final.main.failures).toEqual([{ kind: 'metadata', message: metadataReason }, { kind: 'view', message: viewReason }])
    expect((await page.evaluate(() => window.knowbook.getDatabases())).find(database => database.id === fixture.database.id)).toEqual(savedMetadata)
    expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database.id)).toEqual(fixture.entities)
    expect(await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), fixture.database.id)).toEqual(fixture.columns)
    await expect(query(page)).toHaveValue('Beta')
    await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
    await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Beta keep'])
    expect(errors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
