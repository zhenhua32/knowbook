import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { DatabaseEntity, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, input: UpdateDatabaseEntityInput) => void | Promise<void>
type ReadHandler = (event: unknown, databaseId: string) => DatabaseEntity[] | Promise<DatabaseEntity[]>
type Request = { event: unknown; input: UpdateDatabaseEntityInput; settled: boolean;
  resolve: () => void; reject: (error: Error) => void }
type WriteProbe = { original: Handler; readOriginal: ReadHandler; databaseId: string; failNextRefresh: boolean;
  requests: Request[]; writes: UpdateDatabaseEntityInput[]; failures: string[]; reads: Array<{ databaseId: string; failed: boolean }> }
type ProbeGlobal = typeof globalThis & { __knowbookTextCellDraft?: WriteProbe }
type FocusCall = { field: string | null; tag: string; activeAfter: boolean }
type RendererProbe = { calls: FocusCall[]; restore: () => void; twoFrames: () => Promise<void> }
type ProbeWindow = Window & { __knowbookTextCellDraft?: RendererProbe }
type Ids = { databaseId: string; fieldId: string; otherFieldId: string; entityId: string; otherEntityId: string; viewId: string }
const databaseName = 'Text cell draft ownership'
const recordTitle = 'Cell edit A'
const otherRecordTitle = 'Cell edit B'
const originalValue = 'Saved'
const draftValue = 'Unsaved draft'
const writeFailure = 'The isolated cell write is temporarily unavailable.'

function currentCell(page: Page) {
  const row = page.locator('.dbw-table tbody tr').filter({ has: page.getByText(recordTitle, { exact: true }) })
  return { row, input: row.getByRole('textbox', { name: 'Notes', exact: true }),
    feedback: row.locator('.dbw-text-cell-feedback'),
    retry: row.getByRole('button', { name: uiText('Retry', '重试'), exact: true }),
    refresh: row.getByRole('button', { name: uiText('Refresh', '刷新'), exact: true }) }
}

async function seed(page: Page, language: 'en-US' | 'zh-CN'): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, databaseName, recordTitle, otherRecordTitle, originalValue }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: databaseName, description: 'Keep database metadata intact.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const otherField = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Owner', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [field.id]: originalValue, [otherField.id]: 'Keep original owner' } })
    const other = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: otherRecordTitle,
      fieldValues: { [field.id]: 'Keep other notes', [otherField.id]: 'Keep other owner' } })
    for (let index = 0; index < 98; index++) await window.knowbook.createDatabaseEntity({ databaseId: database.id,
      title: `Other cell record ${String(index).padStart(3, '0')}`,
      fieldValues: { [field.id]: `Other notes ${index}`, [otherField.id]: `Other owner ${index}` } })
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Text draft table', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id, otherField.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id]
    } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { databaseId: database.id, fieldId: field.id, otherFieldId: otherField.id, entityId: entity.id, otherEntityId: other.id, viewId: view.id }
  }, { language, databaseName, recordTitle, otherRecordTitle, originalValue })
  await page.reload()
  await page.setViewportSize({ width: 760, height: 650 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(databaseName)
  await expect(currentCell(page).input).toHaveValue(originalValue)
  return ids
}

async function readStored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    // Store reads may order rows by updatedAt. Compare complete members by
    // immutable identity; timestamps, sortOrder metadata and view config stay intact.
    const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)
    const databases = (await window.knowbook.getDatabases()).sort(byId)
    const catalog = (await window.knowbook.getDocumentCatalog()).sort(byId)
    return { databases, catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: (await window.knowbook.listDocumentTemplates(language)).sort(byId),
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort(byId),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort(byId),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort(byId) }))) }
  }, language)
}

async function installWriteProbe(app: ElectronApplication, databaseId: string) {
  await app.evaluate(({ ipcMain }, databaseId) => {
    const channel = 'knowbook:update-database-entity'
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)
    if (!original) throw new Error('The real database entity update handler is required')
    const readChannel = 'knowbook:get-database-entities'
    const readOriginal = (ipcMain as unknown as { _invokeHandlers: Map<string, ReadHandler> })._invokeHandlers.get(readChannel)
    if (!readOriginal) throw new Error('The real database entity read handler is required')
    const probe: WriteProbe = { original, readOriginal, databaseId, failNextRefresh: false, requests: [], writes: [], failures: [], reads: [] }
    ;(globalThis as ProbeGlobal).__knowbookTextCellDraft = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input: UpdateDatabaseEntityInput) => new Promise<void>((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
    ipcMain.removeHandler(readChannel)
    ipcMain.handle(readChannel, (event, id: string) => {
      const fail = probe.failNextRefresh && id === probe.databaseId
      if (fail) probe.failNextRefresh = false
      probe.reads.push({ databaseId: id, failed: fail })
      if (fail) throw new Error('The isolated database read is temporarily unavailable.')
      return probe.readOriginal(event, id)
    })
  }, databaseId)
}

async function writeState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookTextCellDraft!
    return { requests: probe.requests.map(({ input, settled }) => ({ input, settled })), writes: probe.writes, failures: probe.failures,
      reads: probe.reads, failNextRefresh: probe.failNextRefresh }
  })
}

async function finishWrite(app: ElectronApplication, fail: boolean) {
  await app.evaluate((_electron, fail) => {
    const probe = (globalThis as ProbeGlobal).__knowbookTextCellDraft!
    const request = probe.requests.find(request => !request.settled)
    if (!request) throw new Error('One real text cell update must remain pending')
    request.settled = true
    setImmediate(async () => {
      if (fail) {
        const error = new Error('The isolated cell write is temporarily unavailable.')
        probe.failures.push(error.message)
        request.reject(error)
        return
      }
      try {
        await probe.original(request.event, request.input)
        probe.writes.push(request.input)
        // Only the first actual read after this acknowledged write fails. Proof
        // reads happen after the renderer has consumed this one-shot failure.
        probe.failNextRefresh = true
        request.resolve()
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        probe.failures.push(error.message)
        request.reject(error)
      }
    })
  }, fail)
}

async function tabTo(page: Page, target: Locator, phase: string, reverse = false) {
  const route: Array<{ step: number; tag: string | null; label: string | null; text: string | null; reached: boolean }> = []
  let reached = await target.evaluate(element => document.activeElement === element)
  for (let step = 1; !reached && step <= 40; step++) {
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
    const next = await target.evaluate((element, step) => ({ step, tag: document.activeElement?.tagName ?? null,
      label: document.activeElement?.getAttribute('aria-label') ?? null, text: document.activeElement?.textContent?.trim().slice(0,100) ?? null,
      reached: document.activeElement === element }), step)
    route.push(next)
    if (next.reached) { reached = true; break }
  }
  await page.evaluate(({ phase, route }) => {
    const port = document.querySelector('.dbw-table-scroll')
    port?.setAttribute('data-native-tab-route', JSON.stringify({ phase, route }))
  }, { phase, route })
  expect(reached, `Bounded native Tab route ${phase}: ${JSON.stringify(route)}`).toBe(true)
  await expect(target).toBeFocused()
}

async function installRendererProbe(page: Page) {
  await currentCell(page).input.evaluate(element => element.setAttribute('data-text-cell-field', 'draft'))
  await page.evaluate(() => {
    const nativeFocus = HTMLElement.prototype.focus, nativeFrame = window.requestAnimationFrame.bind(window)
    const calls: FocusCall[] = []
    HTMLElement.prototype.focus = function (options) {
      const call = { field: this.getAttribute('data-text-cell-field'), tag: this.tagName, activeAfter: false }
      calls.push(call)
      nativeFocus.call(this, options)
      call.activeAfter = document.activeElement === this
    }
    ;(window as ProbeWindow).__knowbookTextCellDraft = { calls,
      restore: () => { HTMLElement.prototype.focus = nativeFocus },
      twoFrames: () => new Promise(resolve => nativeFrame(() => nativeFrame(() => resolve()))) }
  })
}

async function recordAway(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const state = await page.evaluate(() => ({ tablePresent: Boolean(document.querySelector('.dbw-table')),
    visibleTitles: Array.from(document.querySelectorAll('.dbw-record-title strong')).map(node => node.textContent),
    scrollTop: document.querySelector('.dbw-table-scroll')?.scrollTop ?? null,
    active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') } }))
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, ipc: await writeState(app), state }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const ipc = await writeState(app)
  const state = await currentCell(page).input.evaluate(input => {
    const field = input as HTMLInputElement, row = field.closest('tr')!, port = field.closest('.dbw-table-scroll')!
    const rect = field.getBoundingClientRect(), rowRect = row.getBoundingClientRect(), portRect = port.getBoundingClientRect()
    const left = Math.max(0, portRect.left + port.clientLeft), top = Math.max(0, portRect.top + port.clientTop)
    const right = Math.min(innerWidth, portRect.right), bottom = Math.min(innerHeight, portRect.bottom)
    const visible = Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left))
      * Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top))
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    const active = document.activeElement, cell = field.closest('td')!
    const buttons = Array.from(cell.querySelectorAll<HTMLButtonElement>('button')).map(button => {
      const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return { text: button.textContent?.trim(), label: button.getAttribute('aria-label'), title: button.getAttribute('title'),
        disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled'), busy: button.getAttribute('aria-busy'),
        description: button.getAttribute('aria-describedby'), width: box.width, height: box.height, hit: hit === button || Boolean(hit && button.contains(hit)),
        ratio: Math.max(0, Math.min(box.right, right) - Math.max(box.left, left))
          * Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)) / (box.width * box.height) }
    })
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      value: field.value, connected: field.isConnected, disabled: field.disabled,
      selection: [field.selectionStart, field.selectionEnd, field.selectionDirection],
      fieldBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, rowHeight: rowRect.height,
      portBox: { top: portRect.top, bottom: portRect.bottom, left: portRect.left, right: portRect.right },
      portScroll: { top: port.scrollTop, left: port.scrollLeft }, ratio: visible / (rect.width * rect.height), hit: hit === field,
      active: { tag: active?.tagName ?? null, label: active?.getAttribute('aria-label') ?? null, isCell: active === field, isBody: active === document.body },
      hasFocus: document.hasFocus(), query: document.querySelector<HTMLInputElement>('input[aria-label="Search records…"],input[aria-label="搜索记录…"]')?.value ?? null,
      source: document.querySelector('.dbw-source-trigger')?.textContent ?? null,
      feedback: Array.from(cell.querySelectorAll<HTMLElement>('.dbw-text-cell-feedback')).map(node => ({ text: node.textContent, role: node.getAttribute('role'), id: node.id })),
      description: field.getAttribute('aria-describedby'), invalid: field.getAttribute('aria-invalid'), buttons,
      tabRoute: port.getAttribute('data-native-tab-route'), calls: (window as ProbeWindow).__knowbookTextCellDraft?.calls ?? [],
      notifications: Array.from(document.querySelectorAll('.app-notification-summary,.app-notification')).map(node => node.textContent) }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, ipc, state }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { ipc, state }
}

function expectGeometry(state: Awaited<ReturnType<typeof record>>['state'], buttonName?: RegExp) {
  expect(state.rowHeight).toBeCloseTo(64, 0)
  expect(state.ratio).toBeCloseTo(1, 5)
  expect(state.hit).toBe(true)
  if (buttonName) {
    const button = state.buttons.find(button => buttonName.test(button.label ?? button.text ?? ''))
    expect(button).toBeDefined()
    expect(button!.width).toBeGreaterThanOrEqual(24)
    expect(button!.height).toBeGreaterThanOrEqual(24)
    expect(button!.ratio).toBeCloseTo(1, 5)
    expect(button!.hit).toBe(true)
  }
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`table text cell keeps its submitted draft during the real write in ${language} @electron`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
    const ids = await seed(page, language)
    const writeMessage = language === 'zh-CN' ? '保存失败，输入已保留，可以重试。' : 'Could not save. Your input has been kept. Try again.'
    const refreshMessage = language === 'zh-CN' ? '记录已保存，但列表刷新失败，请刷新数据库。' : 'The record was saved, but the list could not be refreshed. Refresh the database.'
    const before = await readStored(page, language)
    await installWriteProbe(app, ids.databaseId)
    const cell = currentCell(page)
    await cell.input.fill(draftValue)
    await expect(cell.input).toBeFocused()
    await installRendererProbe(page)
    // Both paths use browser keyboard behavior. Enter invokes the existing blur
    // commit; Tab actually leaves the field. No synthetic submit or target.focus().
    await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Tab')
    await expect.poll(async () => (await writeState(app)).requests.length).toBe(1)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    // Preserve the old-value regression before any new user action or IPC reply.
    const pending = await record(page, app, info, `${language}-native-blur-pending-before-any-save-reply`)
    expect(pending.ipc.requests).toEqual([{ input: { entityId: ids.entityId, fieldValues: { [ids.fieldId]: draftValue } }, settled: false }])
    expect(pending.ipc.writes).toHaveLength(0)
    expect(pending.ipc.failures).toHaveLength(0)
    expect(await readStored(page, language)).toEqual(before)
    expect(pending.state.connected).toBe(true)
    expect(pending.state.value).toBe(draftValue)
    await expect(cell.input).toHaveValue(draftValue)
    expectGeometry(pending.state)
    await expect(cell.feedback).toHaveAttribute('role', 'status')
    await expect(cell.input).toHaveAttribute('aria-describedby', (await cell.feedback.getAttribute('id'))!)

    const outside = page.locator('.dbw-table tbody tr').filter({ has: page.getByText(otherRecordTitle, { exact: true }) })
      .getByRole('button', { name: otherRecordTitle, exact: true })
    await tabTo(page, outside, `${language}-pending-tab-to-other-record-title`)
    const outsideHandle = await outside.elementHandle()
    expect(outsideHandle).not.toBeNull()
    const departed = await record(page, app, info, `${language}-pending-write-with-new-native-focus-owner`)
    expect(departed.ipc.requests).toHaveLength(1)
    await finishWrite(app, true)
    await expect(cell.feedback).toHaveAttribute('role', 'alert')
    await expect(cell.feedback).toHaveText(writeMessage)
    await expect(cell.row.getByRole('alert')).toHaveCount(1)
    await expect(cell.input).toHaveAttribute('title', writeMessage)
    await expect(cell.retry).toHaveAttribute('title', writeMessage)
    await expect(cell.retry).toBeEnabled()
    await page.evaluate(() => (window as ProbeWindow).__knowbookTextCellDraft!.twoFrames())
    const failed = await record(page, app, info, `${language}-failed-write-keeps-draft-and-other-record-focus`)
    expect(failed.state.value).toBe(draftValue)
    expect(failed.state.feedback).toHaveLength(1)
    expect(failed.state.feedback[0].text).not.toMatch(/Error invoking remote method|(?:Error|SqliteError):/)
    expect(failed.state.description).toBe(failed.state.feedback[0].id)
    expect(failed.state.buttons.find(button => uiText('Retry', '重试').test(button.label ?? button.text ?? ''))?.description).toBe(failed.state.feedback[0].id)
    await expect(cell.input).toHaveAttribute('aria-invalid', 'true')
    expect(failed.state.calls.slice(departed.state.calls.length).filter(call => call.field === 'draft')).toHaveLength(0)
    expect(await outsideHandle!.evaluate(element => document.activeElement === element)).toBe(true)
    await expect(outside).toBeFocused()
    expectGeometry(failed.state, uiText('Retry', '重试'))
    expect(failed.ipc.requests).toHaveLength(1)
    expect(failed.ipc.writes).toHaveLength(0)
    expect(failed.ipc.failures).toEqual([writeFailure])
    expect(await readStored(page, language)).toEqual(before)
    await outsideHandle!.dispose()

    // The first row actually leaves the virtual window; its failed draft must
    // come from the cache when a new input DOM node is mounted on return.
    const scroll = page.locator('.dbw-table-scroll')
    await scroll.hover()
    await page.mouse.wheel(0, 6000)
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(2000)
    await expect(cell.input).toHaveCount(0)
    await recordAway(page, app, info, `${language}-failed-draft-row-physically-unmounted-by-scroll`)
    await page.mouse.wheel(0, -10000)
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0)
    await expect(cell.input).toHaveValue(draftValue)
    await expect(cell.feedback).toHaveAttribute('role', 'alert')
    await expect(cell.feedback).toHaveText(writeMessage)
    const virtualReturn = await record(page, app, info, `${language}-virtual-row-return-keeps-failed-draft`)
    expectGeometry(virtualReturn.state, uiText('Retry', '重试'))
    expect(virtualReturn.ipc.requests).toHaveLength(1)
    expect(await readStored(page, language)).toEqual(before)

    // Settings unmounts the database Page. This is session-memory retention,
    // without persisting the unsaved value or automatically retrying the write.
    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await expect(page.locator('.page-settings')).toBeVisible()
    await expect(page.locator('.dbw-table')).toHaveCount(0)
    await recordAway(page, app, info, `${language}-settings-page-with-database-unmounted`)
    await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
    await expect(page.locator('.dbw-source-trigger')).toContainText(databaseName)
    await expect(cell.input).toHaveValue(draftValue)
    await expect(cell.feedback).toHaveAttribute('role', 'alert')
    await expect(cell.feedback).toHaveText(writeMessage)
    const pageReturn = await record(page, app, info, `${language}-page-return-keeps-failed-draft-and-retry`)
    expectGeometry(pageReturn.state, uiText('Retry', '重试'))
    expect(pageReturn.ipc.requests).toHaveLength(1)
    expect(pageReturn.ipc.writes).toHaveLength(0)
    expect(await readStored(page, language)).toEqual(before)

    await tabTo(page, cell.retry, `${language}-bounded-native-tab-to-inline-retry`)
    expect((await writeState(app)).requests).toHaveLength(1)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await writeState(app)).requests.length).toBe(2)
    await expect(cell.retry).toHaveAttribute('aria-disabled', 'true')
    await expect(cell.retry).toHaveAttribute('aria-busy', 'true')
    expect(await cell.retry.evaluate(element => (element as HTMLButtonElement).disabled)).toBe(false)
    await expect(cell.retry).toBeFocused()
    await page.keyboard.press('Enter')
    expect((await writeState(app)).requests).toHaveLength(2)
    const retryPending = await record(page, app, info, `${language}-inline-keyboard-retry-single-flight`)
    expectGeometry(retryPending.state, uiText('Retry', '重试'))
    expect(retryPending.ipc.requests[1]).toEqual({ input: { entityId: ids.entityId, fieldValues: { [ids.fieldId]: draftValue } }, settled: false })
    expect(retryPending.ipc.writes).toHaveLength(0)
    await finishWrite(app, false)
    await expect(cell.refresh).toBeEnabled()
    await expect(cell.feedback).toHaveAttribute('role', 'status')
    await expect(cell.feedback).toHaveText(refreshMessage)
    await expect(cell.row.getByRole('status')).toHaveCount(1)
    await expect(cell.input).toHaveAttribute('title', refreshMessage)
    await expect(cell.refresh).toHaveAttribute('title', refreshMessage)
    await expect(cell.input).toHaveValue(draftValue)
    await expect(cell.input).not.toHaveAttribute('aria-invalid', 'true')
    const savedReadFailed = await record(page, app, info, `${language}-real-write-ack-keeps-value-during-read-failure`)
    expectGeometry(savedReadFailed.state, uiText('Refresh', '刷新'))
    expect(savedReadFailed.state.feedback[0].text).not.toMatch(/Error invoking remote method|(?:Error|SqliteError):/)
    expect(savedReadFailed.ipc.requests).toHaveLength(2)
    expect(savedReadFailed.ipc.writes).toEqual([{ entityId: ids.entityId, fieldValues: { [ids.fieldId]: draftValue } }])
    expect(savedReadFailed.ipc.reads.filter(read => read.failed)).toEqual([{ databaseId: ids.databaseId, failed: true }])
    expect(savedReadFailed.ipc.failNextRefresh).toBe(false)
    const acknowledged = await readStored(page, language)
    const originalSource = before.sources.find(source => source.id === ids.databaseId)!
    const originalEntity = originalSource.entities.find(entity => entity.id === ids.entityId)!
    const acknowledgedEntity = acknowledged.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
    expect(acknowledgedEntity).toMatchObject({ id: originalEntity.id, databaseId: originalEntity.databaseId,
      title: originalEntity.title, documentId: originalEntity.documentId, createdAt: originalEntity.createdAt,
      fieldValues: { ...originalEntity.fieldValues, [ids.fieldId]: draftValue } })
    expect(acknowledged).toEqual({ ...before, sources: before.sources.map(source => source.id === ids.databaseId
      ? { ...source, entities: source.entities.map(entity => entity.id === ids.entityId ? acknowledgedEntity : entity) } : source) })

    // Merely reading the acknowledged value and leaving it must keep the
    // read-only recovery action. Forward Tab stays inside this cell on Refresh;
    // backward Tab really leaves the input's action group for the row title.
    const beforeUnchangedBlur = await writeState(app)
    await cell.input.click()
    await expect(cell.input).toBeFocused()
    await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Shift+Tab')
    await page.evaluate(() => (window as ProbeWindow).__knowbookTextCellDraft!.twoFrames())
    const unchangedBlur = await record(page, app, info, `${language}-unchanged-acknowledged-value-keeps-read-only-recovery`)
    expect(unchangedBlur.ipc.requests).toEqual(beforeUnchangedBlur.requests)
    expect(unchangedBlur.ipc.requests).toHaveLength(2)
    expect(unchangedBlur.ipc.writes).toEqual(beforeUnchangedBlur.writes)
    expect(unchangedBlur.ipc.writes).toHaveLength(1)
    expect(unchangedBlur.ipc.reads).toEqual(beforeUnchangedBlur.reads)
    await expect(cell.input).not.toBeFocused()
    if (language === 'zh-CN') await expect(cell.row.getByRole('button', { name: recordTitle, exact: true })).toBeFocused()
    await expect(cell.input).toHaveValue(draftValue)
    await expect(cell.feedback).toHaveText(refreshMessage)
    await expect(cell.feedback).toHaveAttribute('role', 'status')
    await expect(cell.refresh).toHaveCount(1)
    await expect(cell.retry).toHaveCount(0)
    expectGeometry(unchangedBlur.state, uiText('Refresh', '刷新'))
    expect(await readStored(page, language)).toEqual(acknowledged)

    await tabTo(page, cell.refresh, `${language}-native-inline-refresh-after-acknowledged-write`)
    const beforeRefresh = await writeState(app)
    await page.keyboard.press('Enter')
    await expect(cell.refresh).toHaveCount(0)
    await expect(cell.retry).toHaveCount(0)
    await expect(cell.row.getByRole('alert')).toHaveCount(0)
    await expect(cell.input).toHaveValue(draftValue)
    await expect.poll(async () => (await writeState(app)).reads.length).toBeGreaterThan(beforeRefresh.reads.length)
    const refreshed = await record(page, app, info, `${language}-refresh-only-recovers-without-a-third-write`)
    expectGeometry(refreshed.state)
    expect(refreshed.ipc.requests).toHaveLength(2)
    expect(refreshed.ipc.writes).toHaveLength(1)
    expect(refreshed.ipc.failures).toEqual([writeFailure])
    expect(refreshed.ipc.reads.filter(read => read.failed)).toHaveLength(1)
    expect(await readStored(page, language)).toEqual(acknowledged)
    await page.evaluate(() => (window as ProbeWindow).__knowbookTextCellDraft!.restore())
    await page.reload()
    await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
    await expect(page.locator('.dbw-source-trigger')).toContainText(databaseName)
    await expect(cell.input).toHaveValue(draftValue)
    await expect(cell.retry).toHaveCount(0)
    await expect(cell.refresh).toHaveCount(0)
    expect(await readStored(page, language)).toEqual(acknowledged)
    const reloaded = await record(page, app, info, `${language}-only-the-acknowledged-field-write-survives-reload`)
    expectGeometry(reloaded.state)
    expect(reloaded.ipc.requests).toHaveLength(2)
    expect(reloaded.ipc.writes).toHaveLength(1)
    expect(errors).toEqual([])
    } finally {
      // An assertion failure never releases an old pending RPC as a new write
      // or error. Only the isolated app is closed by withElectronApp.
      await page.evaluate(() => (window as ProbeWindow).__knowbookTextCellDraft?.restore()).catch(() => undefined)
    }
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
