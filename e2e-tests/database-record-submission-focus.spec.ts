import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { kind: 'create' | 'update'; event: unknown; input: unknown; original: Handler; settled: boolean;
  resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { requests: Request[]; failures: string[]; saved: unknown[] }
type ProbeGlobal = typeof globalThis & { __knowbookRecordSubmissionFocus?: Probe }
type ProbeWindow = Window & { __knowbookRecordSubmissionTabRoute?: Array<{ phase: string; step: number;
  tag: string | null; label: string | null; text: string | null; reached: boolean }> }

const sourceName = 'Record submission focus'
const failureReason = 'The isolated record submission is temporarily unavailable.'
const createDialog = (page: Page) => page.getByRole('dialog', { name: uiText('Create record', '新建记录'), exact: true })
const recordDrawer = (page: Page) => page.getByRole('dialog', { name: uiText('Record details', '记录详情'), exact: true })
const titleInput = (scope: Locator) => scope.getByRole('textbox', { name: /Title|标题/ })
const noteInput = (scope: Locator) => scope.getByLabel('Notes', { exact: true })
const linkedInput = (scope: Locator) => scope.getByLabel(/Linked document|关联文档/)
const createButton = (scope: Locator) => scope.locator('footer .dbw-primary-button')

async function seed(page: Page, language: 'en-US' | 'zh-CN') {
  const ids = await page.evaluate(async ({ sourceName, language }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const original = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Original focus record',
      fieldValues: { [field.id]: 'Original note' } })
    // Each record has its own real linked document: the store deliberately
    // permits only one record per document in a given database.
    const documentIds: [string, string, string] = [
      (await window.knowbook.createDocument(null)).id,
      (await window.knowbook.createDocument(null)).id,
      (await window.knowbook.createDocument(null)).id
    ]
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    return { databaseId: database.id, fieldId: field.id, recordId: original.id, documentIds }
  }, { sourceName, language })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: language === 'zh-CN' ? 850 : 800 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(sourceName)
  await expect(page.locator('.dbw-table')).toBeVisible()
  return ids
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], failures: [], saved: [] }
    ;(globalThis as ProbeGlobal).__knowbookRecordSubmissionFocus = probe
    for (const kind of ['create', 'update'] as const) {
      const channel = `knowbook:${kind}-database-entity`
      const original = handlers.get(channel)
      if (!original) throw new Error(`The real ${channel} handler is required`)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, input) => new Promise((resolve, reject) => {
        probe.requests.push({ kind, event, input, original, settled: false, resolve, reject })
      }))
    }
  })
}

async function setFailure(app: ElectronApplication, databaseId: string, title: string, enabled: boolean) {
  await app.evaluate(({ app }, { databaseId, title, enabled, failureReason }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_submission_create_failure')
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_submission_update_failure')
      if (enabled) {
        const quotedId = databaseId.replace(/'/g, "''")
        const quotedTitle = title.replace(/'/g, "''")
        const quotedReason = failureReason.replace(/'/g, "''")
        for (const kind of ['INSERT', 'UPDATE']) {
          const trigger = kind === 'INSERT' ? 'create' : 'update'
          database.exec(`CREATE TRIGGER knowbook_e2e_submission_${trigger}_failure BEFORE ${kind} ON database_entities ` +
            `WHEN NEW.database_id = '${quotedId}' AND NEW.title = '${quotedTitle}' ` +
            `BEGIN SELECT RAISE(ABORT, '${quotedReason}'); END`)
        }
      }
    } finally { database.close() }
  }, { databaseId, title, enabled, failureReason })
}

async function requestCount(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as ProbeGlobal).__knowbookRecordSubmissionFocus!.requests.length)
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookRecordSubmissionFocus!
    const request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real unsettled record request is required')
    request.settled = true
    // Let Inspector evaluation return before the real SQLite result/rejection.
    setImmediate(async () => {
      try {
        const saved = await request.original(request.event, request.input)
        probe.saved.push(saved)
        request.resolve(saved)
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason))
        probe.failures.push(error.message)
        request.reject(error)
      }
    })
  }, index)
}

async function tabTo(page: Page, target: Locator, phase: string, limit = 12) {
  let reached = false
  for (let step = 1; step <= limit; step++) {
    await page.keyboard.press('Tab')
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const stop = { phase, step, tag: active?.tagName ?? null, label: active?.getAttribute('aria-label') ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null, reached: active === element }
      ;((window as ProbeWindow).__knowbookRecordSubmissionTabRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function expectSubmissionReachable(trigger: Locator) {
  await expect(trigger).toBeFocused()
  await expect(trigger).toBeInViewport({ ratio: 1 })
  const geometry = await trigger.evaluate(element => {
    const container = element.closest<HTMLElement>('.dbw-create-record-dialog, .dbw-record-drawer')
    if (!container) throw new Error('The real record form container is required')
    const bounds = container.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    const clip = { left: bounds.left + container.clientLeft, top: bounds.top + container.clientTop,
      right: bounds.left + container.clientLeft + container.clientWidth,
      bottom: bounds.top + container.clientTop + container.clientHeight }
    return { rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, height: rect.height }, clip,
      inside: rect.left >= clip.left - .5 && rect.top >= clip.top - .5 && rect.right <= clip.right + .5 && rect.bottom <= clip.bottom + .5 }
  })
  expect(geometry.inside, JSON.stringify(geometry)).toBe(true)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, scope: Locator, phase: string) {
  // Combine native-window and request diagnostics into one Inspector call.
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookRecordSubmissionFocus!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(),
      focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds() })),
      requests: probe.requests.map(request => ({ kind: request.kind, input: request.input, settled: request.settled })),
      failures: probe.failures, savedCount: probe.saved.length }
  })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await scope.evaluate(element => {
    const active = document.activeElement as HTMLElement | null
    const container = element.getBoundingClientRect()
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName,
      label: active?.getAttribute('aria-label'), text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null },
      containerRect: { left: container.left, top: container.top, right: container.right,
        bottom: container.bottom, width: container.width, height: container.height },
      ariaBusy: element.getAttribute('aria-busy'), dialogFocused: active === element,
      controls: Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')).map(input => ({
        label: input.getAttribute('aria-label') ?? input.closest('label')?.querySelector('span')?.textContent,
        value: input.value, disabled: input.disabled, focused: active === input })),
      alerts: Array.from(element.querySelectorAll('[role=alert]')).map(alert => ({ id: alert.id, text: alert.textContent })),
      buttons: Array.from(element.querySelectorAll<HTMLButtonElement>('footer button')).map(button => {
        const rect = button.getBoundingClientRect()
        return { text: button.textContent, disabled: button.disabled, ariaBusy: button.getAttribute('aria-busy'),
          describedBy: button.getAttribute('aria-describedby'), focused: active === button,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } }
      }),
      route: (window as ProbeWindow).__knowbookRecordSubmissionTabRoute ?? [] }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return { main, state }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`record submission failures preserve Create, Continue and Save keyboard focus in ${language} @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seed(page, language)
      expect(new Set(ids.documentIds).size).toBe(3)
      const before = await page.evaluate(async id => ({
        records: await window.knowbook.getDatabaseEntities(id),
        columns: await window.knowbook.getDocumentDatabaseColumns(id),
        views: await window.knowbook.getDatabaseSavedViews(id)
      }), ids.databaseId)
      const readRecords = () => page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
      await installProbe(app)

      for (const [index, action] of (['create', 'continue', 'save'] as const).entries()) {
        const title = `Failure focus ${action}`
        const note = `Retained note for ${action}`
        const documentId = ids.documentIds[index]!
        const recordsBefore = await readRecords()
        await setFailure(app, ids.databaseId, title, true)
        if (action === 'save') {
          await page.locator('.dbw-table').getByRole('button', { name: 'Original focus record', exact: true }).click()
          await expect(recordDrawer(page).locator('.dbw-drawer-header .dbw-icon-button')).toBeFocused()
        } else {
          await page.getByRole('button', { name: uiText('New record', '新建记录'), exact: true }).click()
          await expect(titleInput(createDialog(page))).toBeFocused()
        }
        // Resize after normal opening/navigation, then rely on real Tab and
        // the product's failure restoration to keep the footer reachable.
        if (language === 'zh-CN') await page.setViewportSize({ width: 1180, height: 440 })
        const scope = action === 'save' ? recordDrawer(page) : createDialog(page)
        await titleInput(scope).fill(title)
        await linkedInput(scope).selectOption(documentId)
        await noteInput(scope).fill(note)
        const trigger = action === 'continue' ? scope.locator('footer > .dbw-quiet-button') : createButton(scope)
        await expect(trigger).toHaveText(action === 'continue'
          ? uiText('Create and add another', '创建并继续添加')
          : action === 'save' ? uiText('Save', '保存') : uiText('Create', '创建'))
        await tabTo(page, trigger, `${action}-notes-to-submit`)
        const originalTrigger = await trigger.elementHandle()
        expect(originalTrigger).not.toBeNull()
        await page.keyboard.press('Enter')
        await expect.poll(() => requestCount(app)).toBe(index * 2 + 1)
        await expect(scope).toHaveAttribute('aria-busy', 'true')
        await expect(trigger).toBeDisabled()
        await expect(titleInput(scope)).toBeDisabled()
        await expect(linkedInput(scope)).toBeDisabled()
        await expect(noteInput(scope)).toBeDisabled()
        await record(page, app, testInfo, scope, `${language}-${action}-submission-pending`)
        // No input, key, mouse or focus interaction occurs while the request is held.
        await settle(app, index * 2)
        const alert = scope.getByRole('alert')
        await expect(alert).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
        await expect(scope).toHaveAttribute('aria-busy', 'false')
        // Record actual focus before checking the new restoration behavior.
        const failed = await record(page, app, testInfo, scope, `${language}-${action}-submission-failed`)
        expect(failed.main.requests).toHaveLength(index * 2 + 1)
        expect(failed.main.savedCount).toBe(index)
        expect(failed.main.failures).toEqual(Array(index + 1).fill(failureReason))
        await expect(titleInput(scope)).toHaveValue(title)
        await expect(linkedInput(scope)).toHaveValue(documentId)
        await expect(noteInput(scope)).toHaveValue(note)
        expect(await readRecords()).toEqual(recordsBefore)
        await expect(trigger).toBeEnabled()
        await expect(trigger).toBeFocused()
        await expectSubmissionReachable(trigger)
        expect(await originalTrigger!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true)
        const alertId = await alert.getAttribute('id')
        expect(alertId).toBeTruthy()
        expect((await trigger.getAttribute('aria-describedby') ?? '').split(/\s+/)).toContain(alertId)

        await setFailure(app, ids.databaseId, title, false)
        await expect(trigger).toBeFocused()
        // Immediate native Enter retries from the restored original button:
        // no click(), focus() or draft re-entry repairs this state.
        await page.keyboard.press('Enter')
        await expect.poll(() => requestCount(app)).toBe(index * 2 + 2)
        await expect(scope).toHaveAttribute('aria-busy', 'true')
        await expect(trigger).toBeDisabled()
        await settle(app, index * 2 + 1)
        if (action === 'continue') {
          await expect(scope).toBeVisible()
          await expect(scope).toHaveAttribute('aria-busy', 'false')
          await expect(titleInput(scope)).toHaveValue('')
          await expect(titleInput(scope)).toBeFocused()
          await expect(linkedInput(scope)).toHaveValue('')
          await expect(noteInput(scope)).toHaveValue('')
          await expect(scope.getByRole('alert')).toHaveCount(0)
        } else await expect(scope).toHaveCount(0)
        const records = await readRecords()
        const matching = records.filter(record => record.title === title)
        expect(matching).toHaveLength(1)
        expect(matching[0].documentId).toBe(documentId)
        expect(matching[0].fieldValues[ids.fieldId]).toBe(note)
        expect(records).toHaveLength(recordsBefore.length + (action === 'save' ? 0 : 1))
        if (action === 'save') expect(matching[0].id).toBe(ids.recordId)
        expect(records.filter(record => record.id !== matching[0].id)).toEqual(
          recordsBefore.filter(record => record.id !== matching[0].id))
        const completed = await record(page, app, testInfo,
          action === 'continue' ? scope : page.locator('.dbw-shell'), `${language}-${action}-retry-saved`)
        expect(completed.main.requests).toHaveLength(index * 2 + 2)
        expect(completed.main.savedCount).toBe(index + 1)
        expect(completed.main.failures).toHaveLength(index + 1)
        if (action === 'continue') {
          await page.keyboard.press('Escape')
          await expect(scope).toHaveCount(0)
        }
        if (language === 'zh-CN') await page.setViewportSize({ width: 1180, height: 850 })
      }

      const savedRecords = await readRecords()
      const savedRecord = page.locator('.dbw-table .dbw-record-title').filter({ has: page.getByText('Failure focus save', { exact: true }) })
      await expect(savedRecord).toHaveCount(1)
      await savedRecord.click()
      const drawer = recordDrawer(page)
      await expect(drawer.locator('.dbw-drawer-header h2')).toHaveText('Failure focus save')
      await expect(drawer.locator('.dbw-drawer-header .dbw-icon-button')).toBeFocused()
      if (language === 'zh-CN') await page.setViewportSize({ width: 1180, height: 440 })
      const movedTitle = 'Failure focus transferred owner'
      await setFailure(app, ids.databaseId, movedTitle, true)
      await titleInput(drawer).fill(movedTitle)
      await noteInput(drawer).fill('Draft remains with the new focus owner')
      const save = createButton(drawer)
      await tabTo(page, save, 'ownership-notes-to-save')
      await page.keyboard.press('Enter')
      await expect.poll(() => requestCount(app)).toBe(7)
      await expect(drawer).toHaveAttribute('aria-busy', 'true')
      // With every control disabled, actual Tab is handled by the existing
      // focus trap and moves focus to the real, focusable ASIDE container.
      await page.keyboard.press('Tab')
      await expect(drawer).toBeFocused()
      expect(await drawer.evaluate(element => element.tagName)).toBe('ASIDE')
      await record(page, app, testInfo, drawer, `${language}-pending-tab-transfers-focus`)
      await settle(app, 6)
      await expect(drawer.getByRole('alert')).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
      await expect(drawer).toHaveAttribute('aria-busy', 'false')
      const transferred = await record(page, app, testInfo, drawer, `${language}-late-failure-keeps-aside-focus`)
      await expect(drawer).toBeFocused()
      await expect(save).not.toBeFocused()
      expect(transferred.state.dialogFocused).toBe(true)
      expect(transferred.main.requests).toHaveLength(7)
      expect(transferred.main.savedCount).toBe(3)
      expect(transferred.main.failures).toEqual(Array(4).fill(failureReason))
      expect(transferred.main.requests.map(request => request.kind)).toEqual(['create', 'create', 'create', 'create', 'update', 'update', 'update'])
      await expect(titleInput(drawer)).toHaveValue(movedTitle)
      await expect(linkedInput(drawer)).toHaveValue(ids.documentIds[2])
      await expect(noteInput(drawer)).toHaveValue('Draft remains with the new focus owner')
      expect(await readRecords()).toEqual(savedRecords)
      expect(savedRecords).toHaveLength(before.records.length + 2)
      await setFailure(app, ids.databaseId, movedTitle, false)
      await page.keyboard.press('Escape')
      await expect(drawer).toHaveCount(0)
      if (language === 'zh-CN') await page.setViewportSize({ width: 1180, height: 850 })
      const final = await page.evaluate(async id => ({
        columns: await window.knowbook.getDocumentDatabaseColumns(id),
        views: await window.knowbook.getDatabaseSavedViews(id),
        records: await window.knowbook.getDatabaseEntities(id)
      }), ids.databaseId)
      expect(final.columns).toEqual(before.columns)
      expect(final.views).toEqual(before.views)
      expect(final.records).toEqual(savedRecords)
      expect(errors).toEqual([])
    })
  })
}
