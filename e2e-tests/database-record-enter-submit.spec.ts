import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateDatabaseEntityInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { event: unknown; input: CreateDatabaseEntityInput; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; requests: Request[]; saved: unknown[]; failures: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookRecordEnterProbe?: Probe }
type ProbeWindow = Window & { __knowbookRecordEnterRoute?: Array<{ phase: string; tag: string | null; reached: boolean }> }
const sourceName = 'Record Enter submission'
const failureReason = 'The isolated record Enter write is temporarily unavailable.'
const dialog = (page: Page) => page.getByRole('dialog', { name: uiText('Create record', '新建记录'), exact: true })
const title = (page: Page) => dialog(page).getByRole('textbox', { name: /Title|标题/ })
const notes = (page: Page) => dialog(page).getByRole('textbox', { name: 'Notes', exact: true })
const linked = (page: Page) => dialog(page).getByLabel(/Linked document|关联文档/)
const ordinary = (page: Page) => dialog(page).locator('footer .dbw-primary-button')
const continueButton = (page: Page) => dialog(page).locator('footer .dbw-quiet-button')

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('knowbook:create-database-entity')
    if (!original) throw new Error('The real record creation handler is required')
    const probe: Probe = { original, requests: [], saved: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookRecordEnterProbe = probe
    ipcMain.removeHandler('knowbook:create-database-entity')
    ipcMain.handle('knowbook:create-database-entity', (event, input) => new Promise((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
  })
}

async function setFailure(app: ElectronApplication, databaseId: string, enabled: boolean) {
  await app.evaluate(({ app }, { databaseId, enabled, failureReason }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_record_enter_failure')
      if (enabled) database.exec('CREATE TRIGGER knowbook_e2e_record_enter_failure BEFORE INSERT ON database_entities ' +
        `WHEN NEW.database_id = '${databaseId.replace(/'/g, "''")}' AND NEW.title = 'Enter submitted record' ` +
        `BEGIN SELECT RAISE(ABORT, '${failureReason.replace(/'/g, "''")}'); END`)
    } finally { database.close() }
  }, { databaseId, enabled, failureReason })
}

async function requestCount(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as ProbeGlobal).__knowbookRecordEnterProbe!.requests.length)
}

async function tabTo(page: Page, target: Locator, phase: string, direction: 'Tab' | 'Shift+Tab' = 'Tab') {
  let reached = false
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press(direction)
    const stop = await target.evaluate((element, phase) => {
      const value = { phase, tag: document.activeElement?.tagName ?? null, reached: document.activeElement === element }
      ;((window as ProbeWindow).__knowbookRecordEnterRoute ??= []).push(value)
      return value
    }, phase)
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function fillDraft(page: Page, documentId: string, nextTitle: string, nextNotes: string) {
  await expect(title(page)).toBeFocused()
  await page.keyboard.type(nextTitle)
  await page.keyboard.press('Tab')
  await expect(linked(page)).toBeFocused()
  await linked(page).selectOption(documentId)
  await page.keyboard.press('Tab')
  await expect(notes(page)).toBeFocused()
  await page.keyboard.type(nextNotes)
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookRecordEnterProbe!, request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real pending record creation is required')
    request.settled = true
    setImmediate(async () => {
      try { const saved = await probe.original(request.event, request.input); probe.saved.push(saved); request.resolve(saved) }
      catch (reason) { const error = reason instanceof Error ? reason : new Error(String(reason)); probe.failures.push(error.message); request.reject(error) }
    })
  }, index)
}

async function readStored(page: Page, databaseId: string) {
  return page.evaluate(async databaseId => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { records: await window.knowbook.getDatabaseEntities(databaseId), columns: await window.knowbook.getDocumentDatabaseColumns(databaseId),
      views: await window.knowbook.getDatabaseSavedViews(databaseId), catalog, documents: await Promise.all(catalog.map(entry => window.knowbook.getDocumentDetail(entry.id))) }
  }, databaseId)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookRecordEnterProbe!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds() })),
      requests: probe.requests.map(({ input, settled }) => ({ input, settled })), saved: probe.saved, failures: probe.failures }
  })
  const state = await page.evaluate(() => {
    const modal = document.querySelector<HTMLElement>('.dbw-create-record-dialog'), active = document.activeElement
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName, isBody: active === document.body },
      modal: modal ? rect(modal) : null, ariaBusy: modal?.getAttribute('aria-busy') ?? null,
      controls: Array.from(modal?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea') ?? []).map(input => ({
        tag: input.tagName, label: input.getAttribute('aria-label') ?? input.closest('label')?.querySelector('span')?.textContent,
        value: input.value, disabled: input.disabled, focused: active === input, rect: rect(input) })),
      alerts: Array.from(modal?.querySelectorAll('[role="alert"]') ?? []).map(element => ({ text: element.textContent, rect: rect(element) })),
      buttons: Array.from(modal?.querySelectorAll<HTMLButtonElement>('footer button') ?? []).map(button => ({ text: button.textContent,
        disabled: button.disabled, type: button.type, focused: active === button, ariaBusy: button.getAttribute('aria-busy'), rect: rect(button) })),
      route: (window as ProbeWindow).__knowbookRecordEnterRoute ?? [] }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { main, state }
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`record title Enter submits an ordinary creation in ${language} @electron`, async ({}, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const ids = await page.evaluate(async ({ language, sourceName }) => {
      const database = await window.knowbook.createDocumentDatabase({ name: sourceName })
      const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
      const original = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Unchanged original record', fieldValues: { [field.id]: 'Original Notes' } })
      // One record per linked document is a real store invariant.
      const documentIds = [(await window.knowbook.createDocument(null)).id,
        (await window.knowbook.createDocument(null)).id, (await window.knowbook.createDocument(null)).id]
      await window.knowbook.saveSetting('ui.language', language)
      await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
      window.localStorage.setItem('knowbook.database.last-source', database.id)
      return { databaseId: database.id, fieldId: field.id, recordId: original.id, documentIds }
    }, { language, sourceName })
    await page.reload()
    await page.setViewportSize({ width: 1180, height: 850 })
    await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
    await expect(page.locator('.dbw-source-trigger')).toContainText(sourceName)
    await expect(page.locator('.dbw-table')).toBeVisible()
    const before = await readStored(page, ids.databaseId)
    expect(new Set(ids.documentIds).size).toBe(3)
    await installProbe(app)
    await page.getByRole('button', { name: uiText('New record', '新建记录'), exact: true }).click()
    await fillDraft(page, ids.documentIds[0], 'Enter submitted record', 'Retained Notes for Title Enter')
    // Notes is the existing text INPUT, whose Enter commits and blurs. It does
    // not become a multiline editor or accidentally invoke the parent form.
    await page.keyboard.press('Enter')
    await expect(notes(page)).not.toBeFocused()
    await expect(notes(page)).toHaveValue('Retained Notes for Title Enter')
    const propertyEnter = await record(page, app, testInfo, `${language}-notes-input-enter-only-commits-property`)
    expect(propertyEnter.main.requests).toHaveLength(0)
    expect(await readStored(page, ids.databaseId)).toEqual(before)
    await notes(page).click()
    await page.keyboard.press('Shift+Tab')
    await expect(linked(page)).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(title(page)).toBeFocused()
    await title(page).dispatchEvent('compositionstart', { data: 'candidate' })
    await page.keyboard.press('Enter')
    await expect(title(page)).toBeFocused()
    await title(page).dispatchEvent('compositionend', { data: 'candidate' })
    // These explicit form-submit probes model a queued implicit submit after
    // IME confirmation. They do not pretend to operate an OS candidate window.
    await title(page).evaluate(element => {
      const form = element.closest('form')
      if (!form) throw new Error('The actual record creation form is required')
      form.requestSubmit()
    })
    expect(await requestCount(app)).toBe(0)
    for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
      await title(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...flags })
      await title(page).evaluate(element => element.closest('form')!.requestSubmit())
      expect(await requestCount(app)).toBe(0)
    }
    const ime = await record(page, app, testInfo, `${language}-ime-candidate-and-late-implicit-submit-do-not-create`)
    expect(ime.main.requests).toHaveLength(0)
    await expect(title(page)).toHaveValue('Enter submitted record')
    await expect(linked(page)).toHaveValue(ids.documentIds[0])
    await expect(notes(page)).toHaveValue('Retained Notes for Title Enter')
    await setFailure(app, ids.databaseId, true)
    const ready = await record(page, app, testInfo, `${language}-title-enter-before-key`)
    expect(ready.main.requests).toHaveLength(0)
    expect(await readStored(page, ids.databaseId)).toEqual(before)

    await page.keyboard.press('Enter')
    // Save old-out evidence before the first new request/busy oracle or polling.
    const entered = await record(page, app, testInfo, `${language}-title-enter-after-key`)
    expect(entered.state.ariaBusy).toBe('true')
    await expect.poll(() => requestCount(app)).toBe(1)
    const payload = { databaseId: ids.databaseId, title: 'Enter submitted record', documentId: ids.documentIds[0], fieldValues: { [ids.fieldId]: 'Retained Notes for Title Enter' } }
    expect(await app.evaluate(() => (globalThis as ProbeGlobal).__knowbookRecordEnterProbe!.requests.map(({ input, settled }) => ({ input, settled })))).toEqual([{ input: payload, settled: false }])
    await expect(dialog(page)).toHaveAttribute('aria-busy', 'true')
    await expect(title(page)).toBeDisabled()
    expect(await readStored(page, ids.databaseId)).toEqual(before)
    // No newer pending keyboard or pointer activity: the original Title lease
    // must survive automatic disabled-to-BODY focus until the real SQL failure.
    await settle(app, 0)
    await expect(dialog(page).getByRole('alert')).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
    const failed = await record(page, app, testInfo, `${language}-real-sqlite-failure-retains-title-focus-and-draft`)
    expect(failed.main.failures).toEqual([failureReason])
    expect(failed.main.saved).toEqual([])
    await expect(title(page)).toBeFocused()
    await expect(title(page)).toHaveValue(payload.title)
    await expect(linked(page)).toHaveValue(ids.documentIds[0])
    await expect(notes(page)).toHaveValue('Retained Notes for Title Enter')
    expect(await readStored(page, ids.databaseId)).toEqual(before)
    await setFailure(app, ids.databaseId, false)
    // Immediate native Enter on the restored Title; no click/focus repair.
    await page.keyboard.press('Enter')
    await expect.poll(() => requestCount(app)).toBe(2)
    await expect(dialog(page)).toHaveAttribute('aria-busy', 'true')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    const bounds = await ordinary(page).boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    const retry = await record(page, app, testInfo, `${language}-title-enter-retry-single-flight`)
    expect(retry.main.requests).toEqual([{ input: payload, settled: true }, { input: payload, settled: false }])
    // Those intentional pending interactions relinquish the old focus lease;
    // ordinary success only promises persistence and closure here.
    await settle(app, 1)
    await expect(dialog(page)).toHaveCount(0)
    const persisted = await readStored(page, ids.databaseId)
    const added = persisted.records.filter(row => row.id !== ids.recordId)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject(payload)
    expect({ ...persisted, records: persisted.records.filter(row => row.id === ids.recordId) }).toEqual(before)
    const saved = await record(page, app, testInfo, `${language}-title-enter-one-real-created-record`)
    expect(saved.main.saved).toHaveLength(1)
    expect(saved.main.failures).toEqual([failureReason])

    await page.getByRole('button', { name: uiText('New record', '新建记录'), exact: true }).click()
    await fillDraft(page, ids.documentIds[1], 'Explicit Continue record', 'Notes retained by Continue')
    const existingTitle = await title(page).elementHandle()
    expect(existingTitle).not.toBeNull()
    await expect(continueButton(page)).toHaveText(uiText('Create and add another', '创建并继续添加'))
    if (language === 'en-US') await continueButton(page).click()
    else {
      await tabTo(page, continueButton(page), 'notes-to-explicit-continue')
      await page.keyboard.press('Enter')
    }
    await expect.poll(() => requestCount(app)).toBe(3)
    const continuePending = await record(page, app, testInfo, `${language}-explicit-continue-pending`)
    expect(continuePending.main.requests[2]).toEqual({ input: { databaseId: ids.databaseId, title: 'Explicit Continue record', documentId: ids.documentIds[1],
      fieldValues: { [ids.fieldId]: 'Notes retained by Continue' } }, settled: false })
    // Leave this success lease untouched while SQLite completes.
    await settle(app, 2)
    await expect(title(page)).toBeFocused()
    await expect(title(page)).toHaveValue('')
    await expect(linked(page)).toHaveValue('')
    await expect(notes(page)).toHaveValue('')
    expect(await existingTitle!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true)
    const continued = await record(page, app, testInfo, `${language}-continue-clears-draft-and-permits-next-keyboard-record`)
    expect(continued.main.saved).toHaveLength(2)
    const afterContinue = await readStored(page, ids.databaseId)
    expect(afterContinue.records.filter(row => row.documentId === ids.documentIds[1])).toHaveLength(1)
    expect(afterContinue.records.find(row => row.documentId === ids.documentIds[1])).toMatchObject({ title: 'Explicit Continue record', fieldValues: { [ids.fieldId]: 'Notes retained by Continue' } })

    await fillDraft(page, ids.documentIds[2], 'Ordinary record after Continue', 'Next record stays ordinary')
    await tabTo(page, title(page), 'notes-back-to-next-ordinary-title', 'Shift+Tab')
    await page.keyboard.press('Enter')
    const nextOrdinary = await record(page, app, testInfo, `${language}-next-title-enter-is-ordinary-not-sticky-continue`)
    expect(nextOrdinary.state.ariaBusy).toBe('true')
    await expect.poll(() => requestCount(app)).toBe(4)
    await settle(app, 3)
    await expect(dialog(page)).toHaveCount(0)
    const final = await readStored(page, ids.databaseId)
    expect(final.records).toHaveLength(before.records.length + 3)
    for (const [index, [expectedTitle, expectedNotes]] of [
      ['Enter submitted record', 'Retained Notes for Title Enter'], ['Explicit Continue record', 'Notes retained by Continue'],
      ['Ordinary record after Continue', 'Next record stays ordinary']
    ].entries()) {
      const rows = final.records.filter(row => row.documentId === ids.documentIds[index])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ title: expectedTitle, fieldValues: { [ids.fieldId]: expectedNotes } })
    }
    expect({ ...final, records: final.records.filter(row => row.id === ids.recordId) }).toEqual(before)
    const completed = await record(page, app, testInfo, `${language}-four-requests-one-failure-three-real-records`)
    expect(completed.main.requests).toHaveLength(4)
    expect(completed.main.saved).toHaveLength(3)
    expect(completed.main.failures).toEqual([failureReason])
    await page.reload()
    await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
    await expect(page.locator('.dbw-source-trigger')).toContainText(sourceName)
    await expect(page.locator('.dbw-table')).toBeVisible()
    expect(await readStored(page, ids.databaseId)).toEqual(final)
    await record(page, app, testInfo, `${language}-ordinary-and-continue-records-survive-reload`)
    expect(errors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
