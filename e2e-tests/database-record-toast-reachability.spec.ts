import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { event: unknown; input: unknown; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; requests: Request[]; failures: string[]; saved: unknown[] }
type ProbeGlobal = typeof globalThis & { __knowbookRecordToastProbe?: Probe }
type ProbeWindow = Window & { __knowbookRecordToastRoute?: Array<{ phase: string; step: number; tag: string | null; text: string | null; reached: boolean }> }

const sourceName = 'Record toast reachability'
const reason = 'The isolated record creation is temporarily unavailable.'
const longReason = `${reason} The isolated storage rejected the second record before any data was written. ` +
  'The complete diagnostic must remain in notification history while the retained title, linked document and Notes can be corrected and submitted again.'
const dialog = (page: Page) => page.getByRole('dialog', { name: uiText('Create record', '新建记录'), exact: true })
const titleInput = (scope: Locator) => scope.getByRole('textbox', { name: /Title|标题/ })
const linkedInput = (scope: Locator) => scope.getByLabel(/Linked document|关联文档/)
const noteInput = (scope: Locator) => scope.getByLabel('Notes', { exact: true })
const continueButton = (scope: Locator) => scope.locator('footer > .dbw-quiet-button')

async function seed(page: Page, language: 'en-US' | 'zh-CN') {
  const ids = await page.evaluate(async ({ sourceName, language }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const documents: [string, string] = [(await window.knowbook.createDocument(null)).id, (await window.knowbook.createDocument(null)).id]
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    return { databaseId: database.id, fieldId: field.id, documents }
  }, { sourceName, language })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: 850 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(sourceName)
  await expect(page.locator('.dbw-empty-state')).toBeVisible()
  return ids
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('knowbook:create-database-entity')
    if (!original) throw new Error('The real create-record handler is required')
    const probe: Probe = { original, requests: [], failures: [], saved: [] }
    ;(globalThis as ProbeGlobal).__knowbookRecordToastProbe = probe
    ipcMain.removeHandler('knowbook:create-database-entity')
    ipcMain.handle('knowbook:create-database-entity', (event, input) => new Promise((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
  })
}

async function setFailure(app: ElectronApplication, databaseId: string, title: string, message: string | null) {
  await app.evaluate(({ app }, { databaseId, title, message }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_record_toast_failure')
      if (message !== null) {
        const quote = (value: string) => value.replace(/'/g, "''")
        database.exec(`CREATE TRIGGER knowbook_e2e_record_toast_failure BEFORE INSERT ON database_entities ` +
          `WHEN NEW.database_id = '${quote(databaseId)}' AND NEW.title = '${quote(title)}' ` +
          `BEGIN SELECT RAISE(ABORT, '${quote(message)}'); END`)
      }
    } finally { database.close() }
  }, { databaseId, title, message })
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookRecordToastProbe!
    const request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real pending record request is required')
    request.settled = true
    setImmediate(async () => {
      try {
        const saved = await probe.original(request.event, request.input)
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

async function tabTo(page: Page, target: Locator, phase: string, direction: 'Tab' | 'Shift+Tab' = 'Tab', limit = 12) {
  let reached = false
  for (let step = 1; step <= limit; step++) {
    await page.keyboard.press(direction)
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const stop = { phase, step, tag: active?.tagName ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null, reached: active === element }
      ;((window as ProbeWindow).__knowbookRecordToastRoute ??= []).push(stop)
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
    const probe = (globalThis as ProbeGlobal).__knowbookRecordToastProbe!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(),
      focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds() })),
      requests: probe.requests.map(request => ({ input: request.input, settled: request.settled })),
      failures: probe.failures, savedCount: probe.saved.length }
  })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
    }
    const box = (element: Element) => {
      const bounds = rect(element)
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      const ancestors: Array<{ className: string; position: string; overflowX: string; overflowY: string }> = []
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), parentBox = rect(parent)
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
          clip.left = Math.max(clip.left, parentBox.left + parent.clientLeft)
          clip.right = Math.min(clip.right, parentBox.left + parent.clientLeft + parent.clientWidth)
        }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
          clip.top = Math.max(clip.top, parentBox.top + parent.clientTop)
          clip.bottom = Math.min(clip.bottom, parentBox.top + parent.clientTop + parent.clientHeight)
        }
        ancestors.push({ className: parent.getAttribute('class') ?? '', position: style.position, overflowX: style.overflowX, overflowY: style.overflowY })
        // Ordinary workspace ancestors do not clip this fixed modal/portal.
        if (style.position === 'fixed') break
      }
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      const width = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left))
      const height = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      const style = getComputedStyle(element)
      return { rect: bounds, clip, ancestors, visible: bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        visibleRatio: bounds.width && bounds.height ? width * height / (bounds.width * bounds.height) : 0,
        centerHit: hit === element || Boolean(hit && element.contains(hit)),
        hit: hit ? { tag: hit.tagName, className: hit.getAttribute('class'), notificationId: hit.closest('[data-notification-id]')?.getAttribute('data-notification-id') } : null }
    }
    const toasts = Array.from(document.querySelectorAll('.app-notifications .app-notification-summary, .app-notifications .app-notification')).map(element => ({
      id: element.getAttribute('data-notification-id'), title: element.querySelector('.app-notification-title')?.textContent,
      message: element.querySelector('.app-notification-message')?.textContent, ...box(element) }))
    const visibleToasts = toasts.filter(toast => toast.visible)
    const modal = document.querySelector<HTMLElement>('.dbw-create-record-dialog')
    const fieldset = modal?.querySelector<HTMLFieldSetElement>('fieldset')
    const footer = modal?.querySelector('footer')
    const localError = modal?.querySelector('.dbw-record-submit-error')
    const fieldsetStyle = fieldset ? getComputedStyle(fieldset) : null
    const active = document.activeElement as HTMLElement | null
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName,
      text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null },
      modal: modal ? { ...box(modal), scrollTop: modal.scrollTop, scrollHeight: modal.scrollHeight, clientHeight: modal.clientHeight } : null,
      fieldset: fieldset ? { ...box(fieldset), scrollTop: fieldset.scrollTop, scrollHeight: fieldset.scrollHeight, clientHeight: fieldset.clientHeight,
        computedHeight: fieldsetStyle!.height, flexBasis: fieldsetStyle!.flexBasis, minHeight: fieldsetStyle!.minHeight, overflowY: fieldsetStyle!.overflowY } : null,
      footer: footer ? box(footer) : null, localError: localError ? { text: localError.textContent, ...box(localError) } : null,
      toasts, visibleToastCount: visibleToasts.length,
      buttons: Array.from(footer?.querySelectorAll<HTMLButtonElement>('button') ?? []).map(button => {
        const geometry = box(button)
        return { text: button.textContent, disabled: button.disabled, focused: active === button, ...geometry,
          intersectsToasts: visibleToasts.filter(toast => Math.min(geometry.rect.right, toast.rect.right) > Math.max(geometry.rect.left, toast.rect.left)
            && Math.min(geometry.rect.bottom, toast.rect.bottom) > Math.max(geometry.rect.top, toast.rect.top)).map(toast => toast.id) }
      }),
      inputs: Array.from(modal?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select') ?? []).map(input => ({
        label: input.getAttribute('aria-label') ?? input.closest('label')?.querySelector('span')?.textContent,
        value: input.value, focused: active === input, ...box(input) })),
      route: (window as ProbeWindow).__knowbookRecordToastRoute ?? [] }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return { main, state }
}

async function expectBothActionsReachable(scope: Locator, state: Awaited<ReturnType<typeof record>>['state']) {
  expect(state.buttons).toHaveLength(2)
  for (const button of state.buttons) {
    expect(button.visibleRatio).toBe(1)
    expect(button.centerHit).toBe(true)
    expect(button.intersectsToasts).toEqual([])
  }
  for (const button of await scope.locator('footer > button').all()) await expect(button).toBeInViewport({ ratio: 1 })
}

async function expectFocusedInputReachable(target: Locator, state: Awaited<ReturnType<typeof record>>['state']) {
  const focused = state.inputs.filter(input => input.focused)
  expect(focused).toHaveLength(1)
  expect(focused[0].visibleRatio).toBe(1)
  expect(focused[0].centerHit).toBe(true)
  await expect(target).toBeFocused()
  await expect(target).toBeInViewport({ ratio: 1 })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`persistent record failure toast leaves both modal actions reachable in ${language} @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seed(page, language)
      const before = await page.evaluate(async ids => ({
        columns: await window.knowbook.getDocumentDatabaseColumns(ids.databaseId),
        views: await window.knowbook.getDatabaseSavedViews(ids.databaseId),
        documents: await Promise.all(ids.documents.map(id => window.knowbook.getDocumentDetail(id)))
      }), ids)
      await installProbe(app)
      const title = 'Continue despite persistent failure notice'
      const note = 'Retained draft with persistent notification'
      await setFailure(app, ids.databaseId, title, reason)
      await page.getByRole('button', { name: uiText('New record', '新建记录'), exact: true }).click()
      const scope = dialog(page)
      await expect(titleInput(scope)).toBeFocused()
      const natural = await record(page, app, testInfo, `${language}-normal-height-no-toast-empty-modal`)
      expect(natural.state.visibleToastCount).toBe(0)
      expect(natural.state.localError).toBeNull()
      expect(natural.state.modal).not.toBeNull()
      const naturalHeight = natural.state.modal!.rect.height
      await page.setViewportSize(language === 'zh-CN' ? { width: 1180, height: 440 } : { width: 760, height: 640 })
      await titleInput(scope).fill(title)
      await linkedInput(scope).selectOption(ids.documents[0])
      await noteInput(scope).fill(note)
      const trigger = continueButton(scope)
      await tabTo(page, trigger, 'notes-to-continue')
      await page.keyboard.press('Enter')
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookRecordToastProbe!.requests.length)).toBe(1)
      await expect(scope).toHaveAttribute('aria-busy', 'true')
      await settle(app, 0)
      await expect(scope.getByRole('alert')).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
      await expect(scope).toHaveAttribute('aria-busy', 'false')
      const toast = page.getByTestId('notification-summary')
      await expect(toast).toBeVisible()
      await expect(toast).toHaveClass(/app-notification-error/)
      await expect(toast.locator('.app-notification-message')).toContainText(reason)
      // No notification is dismissed, hidden or artificially expired. Capture
      // actual old-build overlap/hit testing before the reachability oracle.
      const failed = await record(page, app, testInfo, `${language}-persistent-toast-first-failure`)
      expect(failed.main.requests).toHaveLength(1)
      expect(failed.main.savedCount).toBe(0)
      expect(failed.main.failures).toEqual([reason])
      await expect(titleInput(scope)).toHaveValue(title)
      await expect(linkedInput(scope)).toHaveValue(ids.documents[0])
      await expect(noteInput(scope)).toHaveValue(note)
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual([])
      await expect(trigger).toBeFocused()
      await expectBothActionsReachable(scope, failed.state)
      const firstToastId = await toast.getAttribute('data-notification-id')
      expect(firstToastId).not.toBeNull()

      // Exercise the narrow/short intersection with the persistent error still
      // present. Native Tab must scroll the fieldset, rather than our probe.
      await page.setViewportSize({ width: 760, height: 440 })
      const narrow = await record(page, app, testInfo, `${language}-persistent-toast-narrow-short`)
      await expectBothActionsReachable(scope, narrow.state)
      await expect(toast).toHaveAttribute('data-notification-id', firstToastId!)
      await tabTo(page, noteInput(scope), 'continue-back-to-notes', 'Shift+Tab')
      const notesFocused = await record(page, app, testInfo, `${language}-keyboard-notes-inside-fieldset`)
      await expectFocusedInputReachable(noteInput(scope), notesFocused.state)
      const editedNote = `${note}; edited through native keyboard`
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type(editedNote)
      await tabTo(page, titleInput(scope), 'notes-back-to-title', 'Shift+Tab')
      const titleFocused = await record(page, app, testInfo, `${language}-keyboard-title-inside-fieldset`)
      await expectFocusedInputReachable(titleInput(scope), titleFocused.state)
      const editedTitle = 'Continue after correcting retained draft'
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type(editedTitle)
      await expect(linkedInput(scope)).toHaveValue(ids.documents[0])
      await expect(noteInput(scope)).toHaveValue(editedNote)
      // The compact notice must not stretch a naturally sized modal on a tall
      // renderer viewport; compare measured content/error boxes, not CSS rules.
      await page.setViewportSize({ width: 760, height: 850 })
      const tall = await record(page, app, testInfo, `${language}-tall-compact-toast-natural-modal-height`)
      await expectFocusedInputReachable(titleInput(scope), tall.state)
      await expectBothActionsReachable(scope, tall.state)
      await expect(toast).toHaveAttribute('data-notification-id', firstToastId!)
      expect(tall.state.modal).not.toBeNull()
      expect(tall.state.localError).not.toBeNull()
      expect(tall.state.modal!.rect.height).toBeLessThanOrEqual(naturalHeight + tall.state.localError!.rect.height + 2)
      await page.setViewportSize({ width: 760, height: 440 })
      await expect(titleInput(scope)).toBeFocused()
      const ready = await record(page, app, testInfo, `${language}-persistent-toast-before-pointer-continue`)
      await expectBothActionsReachable(scope, ready.state)
      await setFailure(app, ids.databaseId, title, null)
      // Real pointer retry, with the original notification retained: no force,
      // focus repair, notification dismissal or artificial timer advancement.
      await trigger.click()
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookRecordToastProbe!.requests.length)).toBe(2)
      await expect(scope).toHaveAttribute('aria-busy', 'true')
      await settle(app, 1)
      await expect(scope).toHaveAttribute('aria-busy', 'false')
      await expect(titleInput(scope)).toHaveValue('')
      await expect(titleInput(scope)).toBeFocused()
      await expect(linkedInput(scope)).toHaveValue('')
      await expect(noteInput(scope)).toHaveValue('')
      await expect(scope.getByRole('alert')).toHaveCount(0)
      const continued = await record(page, app, testInfo, `${language}-pointer-continue-clears-draft-with-toast-retained`)
      expect(continued.main.savedCount).toBe(1)
      expect(continued.main.requests).toHaveLength(2)
      await expect(toast).toHaveAttribute('data-notification-id', firstToastId!)
      const firstRecords = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
      expect(firstRecords).toHaveLength(1)
      expect(firstRecords[0]).toMatchObject({ title: editedTitle, documentId: ids.documents[0], fieldValues: { [ids.fieldId]: editedNote } })

      const secondTitle = 'Primary creation with accumulated failure notices'
      const secondNote = 'Second document draft remains available after storage failure'
      await page.keyboard.type(secondTitle)
      await linkedInput(scope).selectOption(ids.documents[1])
      await noteInput(scope).fill(secondNote)
      await setFailure(app, ids.databaseId, secondTitle, longReason)
      const primary = scope.locator('footer > .dbw-primary-button')
      await tabTo(page, primary, 'second-notes-to-primary')
      await page.keyboard.press('Enter')
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookRecordToastProbe!.requests.length)).toBe(3)
      await expect(scope).toHaveAttribute('aria-busy', 'true')
      await settle(app, 2)
      await expect(scope).toHaveAttribute('aria-busy', 'false')
      await expect(scope.getByRole('alert')).toHaveText(uiText('Could not save. Your input has been kept. Try again.', '保存失败，输入已保留，可以重试。'))
      // SQLite's native error name is present in the genuine baseline IPC
      // diagnostic; the complete long cause remains available in DOM/history.
      await expect(toast.locator('.app-notification-message')).toHaveText(`SqliteError: ${longReason}`)
      await expect(toast.getByRole('button', { name: uiText('View 2 notifications', '查看 2 条通知'), exact: true })).toBeVisible()
      const secondToastId = await toast.getAttribute('data-notification-id')
      expect(secondToastId).not.toBe(firstToastId)
      await expect(page.locator('.app-notifications .app-notification')).toHaveCount(2)
      const secondFailed = await record(page, app, testInfo, `${language}-second-long-failure-two-persistent-notices`)
      expect(secondFailed.main.requests).toHaveLength(3)
      expect(secondFailed.main.savedCount).toBe(1)
      expect(secondFailed.main.failures).toEqual([reason, longReason])
      expect(secondFailed.state.toasts.map(notification => notification.id)).toContain(firstToastId)
      await expect(primary).toBeFocused()
      await expectBothActionsReachable(scope, secondFailed.state)
      await expect(titleInput(scope)).toHaveValue(secondTitle)
      await expect(linkedInput(scope)).toHaveValue(ids.documents[1])
      await expect(noteInput(scope)).toHaveValue(secondNote)
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(firstRecords)
      await setFailure(app, ids.databaseId, secondTitle, null)
      await primary.click()
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookRecordToastProbe!.requests.length)).toBe(4)
      await expect(scope).toHaveAttribute('aria-busy', 'true')
      await settle(app, 3)
      await expect(scope).toHaveCount(0)
      await expect(page.locator('.dbw-table .dbw-record-title')).toHaveCount(2)
      const completed = await record(page, app, testInfo, `${language}-pointer-primary-persists-once-and-closes`)
      expect(completed.main.requests).toHaveLength(4)
      expect(completed.main.savedCount).toBe(2)
      expect(completed.main.failures).toEqual([reason, longReason])
      const rows = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
      expect(rows).toHaveLength(2)
      expect(rows.find(row => row.id === firstRecords[0].id)).toEqual(firstRecords[0])
      expect(rows.find(row => row.documentId === ids.documents[1])).toMatchObject({ title: secondTitle, fieldValues: { [ids.fieldId]: secondNote } })

      // Only after both pointer retries have passed do we clear completed
      // notices through the real notification center and test the no-toast UI.
      await page.setViewportSize({ width: 1180, height: 850 })
      await expect(toast).toHaveCount(0)
      await expect(page.locator('.app-notifications .app-notification')).toHaveCount(2)
      await record(page, app, testInfo, `${language}-normal-height-retains-both-full-notices`)
      await page.locator('.notification-bell').click()
      const center = page.getByRole('dialog', { name: uiText('Notification center', '通知中心'), exact: true })
      await expect(center.locator('.app-notification')).toHaveCount(2)
      await expect(center.locator('.app-notification-message').filter({ hasText: longReason })).toHaveCount(1)
      await center.getByRole('button', { name: uiText('Clear completed', '清除已结束通知'), exact: true }).click()
      await expect(center.locator('.app-notification')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(center).toHaveCount(0)
      await expect(page.locator('.app-notifications')).toHaveCount(0)
      await page.setViewportSize({ width: 760, height: 440 })
      await page.getByRole('button', { name: uiText('New record', '新建记录'), exact: true }).click()
      await expect(titleInput(scope)).toBeFocused()
      await page.keyboard.type('Unsaved follow-up after clearing completed notices')
      await tabTo(page, continueButton(scope), 'no-toast-title-to-continue')
      const noToast = await record(page, app, testInfo, `${language}-short-no-toast-modal-remains-operable`)
      expect(noToast.state.visibleToastCount).toBe(0)
      await expectBothActionsReachable(scope, noToast.state)
      await page.keyboard.press('Escape')
      await expect(scope).toHaveCount(0)
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)).toEqual(rows)
      const after = await page.evaluate(async ids => ({
        columns: await window.knowbook.getDocumentDatabaseColumns(ids.databaseId),
        views: await window.knowbook.getDatabaseSavedViews(ids.databaseId),
        documents: await Promise.all(ids.documents.map(id => window.knowbook.getDocumentDetail(id)))
      }), ids)
      expect(after).toEqual(before)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
