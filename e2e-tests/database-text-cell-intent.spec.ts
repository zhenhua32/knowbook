import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type WriteHandler = (event: unknown, input: UpdateDatabaseEntityInput) => void | Promise<void>
type MainProbe = { original: WriteHandler; requests: UpdateDatabaseEntityInput[];
  writes: UpdateDatabaseEntityInput[]; failures: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookCellIntent?: MainProbe }
type Ids = { databaseId: string; fieldId: string; entityId: string }
type Language = 'en-US' | 'zh-CN'
const databaseName = 'Text cell save intent'
const recordTitle = 'Intent record A'
const otherRecordTitle = 'Intent record B'
const originalValue = 'Saved'
const draftValue = 'Inspected unsaved draft B'
const failureReason = 'Database cell update is temporarily unavailable.'

function currentCell(page: Page) {
  const row = page.locator('.dbw-table tbody tr').filter({ has: page.getByText(recordTitle, { exact: true }) })
  return { row, input: row.getByRole('textbox', { name: 'Notes', exact: true }),
    title: row.getByRole('button', { name: recordTitle, exact: true }),
    feedback: row.locator('.dbw-text-cell-feedback'),
    retry: row.getByRole('button', { name: uiText('Retry', '重试'), exact: true }) }
}

async function seed(page: Page, language: Language): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, databaseName, recordTitle, otherRecordTitle, originalValue }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: databaseName, description: 'Preserve metadata and hidden values.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const owner = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Hidden owner', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [field.id]: originalValue, [owner.id]: 'Keep original owner' } })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: otherRecordTitle,
      fieldValues: { [field.id]: 'Keep other notes', [owner.id]: 'Keep other owner' } })
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Intent table', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id, owner.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id]
    } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { databaseId: database.id, fieldId: field.id, entityId: entity.id }
  }, { language, databaseName, recordTitle, otherRecordTitle, originalValue })
  await page.reload()
  await page.setViewportSize({ width: 760, height: 650 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(databaseName)
  await expect(currentCell(page).input).toHaveValue(originalValue)
  return ids
}

async function readStored(page: Page, language: Language) {
  return page.evaluate(async language => {
    // The store orders entities by updatedAt. Stable identity ordering retains
    // every member and timestamp without treating a legitimate save as deletion.
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

async function installWriteProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const channel = 'knowbook:update-database-entity'
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, WriteHandler> })._invokeHandlers.get(channel)
    if (!original) throw new Error('The authenticated real entity update handler is required')
    const probe: MainProbe = { original, requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookCellIntent = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, input: UpdateDatabaseEntityInput) => {
      probe.requests.push(structuredClone(input))
      try {
        // Preserve the real IPC event and original sender guard. SQLite, rather
        // than a fabricated renderer rejection, decides whether this write fails.
        await probe.original(event, input)
        probe.writes.push(structuredClone(input))
      } catch (error) {
        probe.failures.push(error instanceof Error ? error.message : String(error))
        throw error
      }
    })
  })
}

async function mainState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookCellIntent!
    return { requests: probe.requests, writes: probe.writes, failures: probe.failures }
  })
}

async function setFailure(app: ElectronApplication, entityId: string, enabled: boolean) {
  await app.evaluate(({ app }, { entityId, enabled, failureReason }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_cell_intent_failure')
      if (enabled) {
        const quote = (text: string) => text.replace(/'/g, "''")
        database.exec('CREATE TRIGGER knowbook_e2e_cell_intent_failure BEFORE UPDATE ON database_entities ' +
          `WHEN NEW.id = '${quote(entityId)}' BEGIN SELECT RAISE(ABORT, '${quote(failureReason)}'); END`)
      }
    } finally { database.close() }
  }, { entityId, enabled, failureReason })
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const stored = await readStored(page, language)
  const ipc = await mainState(app)
  const state = await currentCell(page).input.evaluate(element => {
    const input = element as HTMLInputElement, row = input.closest('tr')!, port = input.closest('.dbw-table-scroll')!
    const box = input.getBoundingClientRect(), rowBox = row.getBoundingClientRect(), portBox = port.getBoundingClientRect()
    const left = Math.max(0, portBox.left + port.clientLeft), top = Math.max(0, portBox.top + port.clientTop)
    const right = Math.min(innerWidth, portBox.right), bottom = Math.min(innerHeight, portBox.bottom)
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    const buttons = Array.from(input.closest('td')!.querySelectorAll<HTMLButtonElement>('button')).map(button => {
      const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { text: button.textContent?.trim(), disabled: button.disabled, busy: button.getAttribute('aria-busy'),
        width: rect.width, height: rect.height, hit: hit === button || Boolean(hit && button.contains(hit)),
        ratio: Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left)) *
          Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top)) / (rect.width * rect.height) }
    })
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      value: input.value, readOnly: input.readOnly, disabled: input.disabled,
      selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
      active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'),
        isInput: document.activeElement === input, insideCell: input.closest('.dbw-text-cell-editor')!.contains(document.activeElement) },
      rowHeight: rowBox.height, inputBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      ratio: Math.max(0, Math.min(box.right, right) - Math.max(box.left, left)) *
        Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)) / (box.width * box.height), hit: hit === input,
      invalid: input.getAttribute('aria-invalid'), description: input.getAttribute('aria-describedby'), title: input.title,
      feedback: Array.from(row.querySelectorAll('.dbw-text-cell-feedback')).map(node => ({
        id: node.id, text: node.textContent, role: node.getAttribute('role') })), buttons,
      source: document.querySelector('.dbw-source-trigger')?.textContent,
      query: document.querySelector<HTMLInputElement>('input[aria-label="Search records…"],input[aria-label="搜索记录…"]')?.value,
      notifications: Array.from(document.querySelectorAll('.app-notification-summary,.app-notification')).map(node => node.textContent) }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, ipc, state, stored }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { ipc, state, stored }
}

function expectGeometry(state: Awaited<ReturnType<typeof record>>['state'], withRetry = false) {
  expect(state.rowHeight).toBeCloseTo(64, 0)
  expect(state.ratio).toBeCloseTo(1, 5)
  expect(state.hit).toBe(true)
  if (withRetry) {
    const retry = state.buttons.find(button => /^(Retry|重试)$/.test(button.text ?? ''))
    expect(retry).toBeDefined()
    expect(retry!.width).toBeGreaterThanOrEqual(24)
    expect(retry!.height).toBeGreaterThanOrEqual(24)
    expect(retry!.ratio).toBeCloseTo(1, 5)
    expect(retry!.hit).toBe(true)
  }
}

function expectOnlyNotesChanged(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids, value: string | null = draftValue) {
  const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  const fieldValues = { ...original.fieldValues }
  if (value === null) delete fieldValues[ids.fieldId]
  else fieldValues[ids.fieldId] = value
  expect(saved).toEqual({ ...original, fieldValues, updatedAt: saved.updatedAt })
  expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt))
  expect(after).toEqual({ ...before, sources: before.sources.map(source => source.id === ids.databaseId
    ? { ...source, entities: source.entities.map(entity => entity.id === ids.entityId ? saved : entity) } : source) })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`clean table text browsing does not save an unchanged value in ${language} @electron`, async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seed(page, language)
      const before = await readStored(page, language)
      await installWriteProbe(app)
      const cell = currentCell(page)
      // No fill, typing, onChange dispatch, cache injection or target.focus().
      // Native focus and leaving an unchanged control are browsing, not saving.
      await cell.input.click()
      await expect(cell.input).toBeFocused()
      const focused = await record(page, app, info, language, `${language}-clean-native-focus-without-an-edit`)
      expect(focused.ipc.requests).toHaveLength(0)
      expect(focused.stored).toEqual(before)
      await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Tab')
      await twoFrames(page)
      const browsed = await record(page, app, info, language, `${language}-clean-native-blur-before-zero-write-oracle`)
      expectGeometry(browsed.state)
      expect(browsed.state.active.insideCell).toBe(false)
      expect(browsed.state.value).toBe(originalValue)
      expect(browsed.ipc.requests).toHaveLength(0)
      expect(browsed.ipc.writes).toHaveLength(0)
      expect(browsed.ipc.failures).toHaveLength(0)
      expect(browsed.stored).toEqual(before)

      await cell.input.click()
      await expect(cell.input).toBeFocused()
      await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Tab')
      await twoFrames(page)
      const browsedAgain = await record(page, app, info, language, `${language}-repeated-clean-browsing-keeps-the-entire-store-unchanged`)
      expectGeometry(browsedAgain.state)
      expect(browsedAgain.state.value).toBe(originalValue)
      expect(browsedAgain.ipc).toEqual(browsed.ipc)
      expect(browsedAgain.stored).toEqual(before)

      // A genuine edit still writes through the original IPC and SQLite. The
      // subsequent successful read must not turn later browsing into a save.
      await cell.input.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.type(draftValue)
      await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Tab')
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
      await expect(cell.feedback).toHaveCount(0)
      await expect(cell.input).toHaveValue(draftValue)
      await expect(cell.input).toBeEditable()
      await twoFrames(page)
      const changed = await record(page, app, info, language, `${language}-genuine-native-edit-has-one-acknowledged-write`)
      const firstWrite = { entityId: ids.entityId, fieldValues: { [ids.fieldId]: draftValue } }
      expect(changed.ipc.requests).toEqual([firstWrite])
      expect(changed.ipc.writes).toEqual([firstWrite])
      expect(changed.ipc.failures).toHaveLength(0)
      expectOnlyNotesChanged(before, changed.stored, ids)
      expectGeometry(changed.state)
      await cell.input.click()
      await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Tab')
      await twoFrames(page)
      const afterRefreshBrowse = await record(page, app, info, language, `${language}-browsing-after-successful-refresh-does-not-save-b-again`)
      expect(afterRefreshBrowse.ipc).toEqual(changed.ipc)
      expect(afterRefreshBrowse.stored).toEqual(changed.stored)
      expect(afterRefreshBrowse.state.value).toBe(draftValue)
      expectGeometry(afterRefreshBrowse.state)

      // Clearing a real value is a mutation, whereas simply leaving the
      // resulting empty control must not repeat the null write or touch time.
      await cell.input.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Tab')
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(2)
      await expect(cell.feedback).toHaveCount(0)
      await expect(cell.input).toHaveValue('')
      await expect(cell.input).toBeEditable()
      await twoFrames(page)
      const cleared = await record(page, app, info, language, `${language}-native-clear-saves-null-and-deletes-only-the-note-key`)
      const nullWrite = { entityId: ids.entityId, fieldValues: { [ids.fieldId]: null } }
      expect(cleared.ipc.requests).toEqual([firstWrite, nullWrite])
      expect(cleared.ipc.writes).toEqual(cleared.ipc.requests)
      expect(cleared.ipc.failures).toHaveLength(0)
      expectOnlyNotesChanged(before, cleared.stored, ids, null)
      expect(cleared.stored.sources.find(source => source.id === ids.databaseId)!
        .entities.find(entity => entity.id === ids.entityId)!.fieldValues).not.toHaveProperty(ids.fieldId)
      expectGeometry(cleared.state)
      await cell.input.click()
      await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Tab')
      await twoFrames(page)
      const emptyBrowse = await record(page, app, info, language, `${language}-empty-native-browsing-does-not-repeat-the-null-write`)
      expect(emptyBrowse.ipc).toEqual(cleared.ipc)
      expect(emptyBrowse.stored).toEqual(cleared.stored)
      expect(emptyBrowse.state.value).toBe('')
      expectGeometry(emptyBrowse.state)
      await page.reload()
      await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
      await expect(cell.input).toHaveValue('')
      await expect(cell.feedback).toHaveCount(0)
      const reloaded = await record(page, app, info, language, `${language}-only-two-intended-writes-survive-reload`)
      expect(reloaded.stored).toEqual(cleared.stored)
      expect(reloaded.ipc).toEqual(cleared.ipc)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })

  test(`inspecting a failed table text draft does not retry it in ${language} @electron`, async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seed(page, language)
      const before = await readStored(page, language)
      const message = language === 'zh-CN' ? '保存失败，输入已保留，可以重试。' : 'Could not save. Your input has been kept. Try again.'
      await installWriteProbe(app)
      await setFailure(app, ids.entityId, true)
      const cell = currentCell(page)
      try {
        await cell.input.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.type(draftValue)
        await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Tab')
        await expect.poll(async () => (await mainState(app)).failures.length).toBe(1)
        await expect(cell.feedback).toHaveAttribute('role', 'alert')
        await expect(cell.feedback).toHaveText(message)
        await expect(cell.input).toHaveValue(draftValue)
        await expect(cell.input).toBeEditable()
        await twoFrames(page)
        const failed = await record(page, app, info, language, `${language}-real-sqlite-failure-preserves-b-and-retry`)
        expect(failed.ipc.requests).toEqual([{ entityId: ids.entityId, fieldValues: { [ids.fieldId]: draftValue } }])
        expect(failed.ipc.writes).toHaveLength(0)
        expect(failed.ipc.failures).toHaveLength(1)
        expect(failed.ipc.failures[0]).toContain(failureReason)
        expect(failed.stored).toEqual(before)
        expectGeometry(failed.state, true)
        await expect(cell.input).toHaveAttribute('aria-invalid', 'true')
        await expect(cell.input).toHaveAttribute('title', message)
        await expect(cell.input).toHaveAttribute('aria-describedby', (await cell.feedback.getAttribute('id'))!)

        // The user only returns to read the retained text/error. Forward Tab
        // reaches Retry inside the cell and is not an outside blur; Shift+Tab
        // really leaves to the record title in the Chinese flow.
        await cell.input.click()
        await expect(cell.input).toBeFocused()
        await record(page, app, info, language, `${language}-failed-draft-inspected-without-changing-raw-text`)
        await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Shift+Tab')
        if (language === 'zh-CN') await expect(cell.title).toBeFocused()
        await twoFrames(page)
        const inspected = await record(page, app, info, language, `${language}-failed-native-blur-before-no-implicit-retry-oracle`)
        expectGeometry(inspected.state, true)
        expect(inspected.state.active.insideCell).toBe(false)
        expect(inspected.state.value).toBe(draftValue)
        expect(inspected.ipc.requests).toEqual(failed.ipc.requests)
        expect(inspected.ipc.writes).toHaveLength(0)
        expect(inspected.ipc.failures).toEqual(failed.ipc.failures)
        expect(inspected.stored).toEqual(before)
        await expect(cell.feedback).toHaveAttribute('role', 'alert')
        await expect(cell.feedback).toHaveText(message)
        await expect(cell.retry).toBeEnabled()

        // Retry is explicit intent. Removing the genuine SQLite fault does
        // not write until this actual native button activation occurs.
        await setFailure(app, ids.entityId, false)
        await cell.input.click()
        await page.keyboard.press('Tab')
        await expect(cell.retry).toBeFocused()
        expect((await mainState(app)).requests).toHaveLength(1)
        await page.keyboard.press('Enter')
        await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
        await expect(cell.feedback).toHaveCount(0)
        await expect(cell.input).toHaveValue(draftValue)
        await expect(cell.input).toBeEditable()
        await twoFrames(page)
        const retried = await record(page, app, info, language, `${language}-explicit-native-retry-is-the-only-accepted-write`)
        expect(retried.ipc.requests).toEqual([failed.ipc.requests[0], failed.ipc.requests[0]])
        expect(retried.ipc.writes).toEqual([failed.ipc.requests[0]])
        expect(retried.ipc.failures).toEqual(failed.ipc.failures)
        expectOnlyNotesChanged(before, retried.stored, ids)
        expectGeometry(retried.state)
        await page.reload()
        await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
        await expect(cell.input).toHaveValue(draftValue)
        await expect(cell.feedback).toHaveCount(0)
        const reloaded = await record(page, app, info, language, `${language}-one-real-write-persists-with-all-other-data-intact`)
        expect(reloaded.stored).toEqual(retried.stored)
        expect(reloaded.ipc).toEqual(retried.ipc)
        expect(errors).toEqual([])
      } finally {
        await setFailure(app, ids.entityId, false).catch(() => undefined)
      }
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
