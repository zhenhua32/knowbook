import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { UpdateDatabaseEntityInput, UpdateDocumentDatabaseValueInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type SourceKind = 'custom' | 'catalog'
type CellChannel = 'knowbook:update-database-entity' | 'knowbook:update-document-database-value'
type CellInput = UpdateDatabaseEntityInput | UpdateDocumentDatabaseValueInput
type WriteHandler = (event: unknown, input: CellInput) => void | Promise<void>
type Request = { channel: CellChannel; input: CellInput }
type MainProbe = { originals: Record<CellChannel, WriteHandler>; requests: Request[]; writes: Request[];
  failures: Array<Request & { message: string; stack: string }> }
type ProbeGlobal = typeof globalThis & { __knowbookCellNotification?: MainProbe }
type Ids = { kind: SourceKind; databaseId: string; fieldId: string; recordId: string }
type RawRow = Record<string, string | number | null>
type RawStores = { entities: RawRow[]; entityValues: RawRow[]; documentValues: RawRow[] }
type Diagnostic = { type: string; text: string; errors: Array<{ message: string; stack: string }> }
const recordTitle = 'Notification record A'
const otherRecordTitle = 'Notification record B'
const originalValue = 'Saved'
const draftValue = 'Diagnostic draft B'
const failureReason = 'Database cell notification fixture write is temporarily unavailable.'

function currentCell(page: Page) {
  const row = page.locator('.dbw-table tbody tr').filter({ has: page.getByText(recordTitle, { exact: true }) })
  return { row, input: row.getByRole('textbox', { name: 'Notes', exact: true }),
    feedback: row.locator('.dbw-text-cell-feedback'),
    retry: row.getByRole('button', { name: uiText('Retry', '重试'), exact: true }) }
}

async function seed(page: Page, language: Language, kind: SourceKind): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, kind, recordTitle, otherRecordTitle, originalValue }) => {
    const database = kind === 'custom'
      ? await window.knowbook.createDocumentDatabase({ name: 'Cell notification custom source', description: 'Keep source metadata unchanged.' })
      : (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')!
    if (!database) throw new Error('The real document catalog database is required')
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const owner = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Hidden owner', type: 'text' })
    let recordId: string
    if (kind === 'custom') {
      const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
        fieldValues: { [field.id]: originalValue, [owner.id]: 'Keep original owner' } })
      recordId = entity.id
      await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: otherRecordTitle,
        fieldValues: { [field.id]: 'Keep other notes', [owner.id]: 'Keep other owner' } })
    } else {
      const document = await window.knowbook.createDocument(null)
      recordId = document.id
      await window.knowbook.updateDocument(document.id, { title: recordTitle, summary: 'Preserve this document summary.',
        blocks: [{ type: 'paragraph', content: 'Keep original document content.', checked: false, depth: 0 }] })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: document.id, columnId: field.id, value: originalValue })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: document.id, columnId: owner.id, value: 'Keep original owner' })
      const other = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(other.id, { title: otherRecordTitle, summary: 'Keep the other summary.',
        blocks: [{ type: 'paragraph', content: 'Keep the other document content.', checked: false, depth: 0 }] })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: other.id, columnId: field.id, value: 'Keep other notes' })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: other.id, columnId: owner.id, value: 'Keep other owner' })
    }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Cell notification table', config: {
      version: 1, layout: 'table', query: 'Notification record', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id, owner.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id]
    } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { kind, databaseId: database.id, fieldId: field.id, recordId }
  }, { language, kind, recordTitle, otherRecordTitle, originalValue })
  await page.reload()
  await page.setViewportSize({ width: 760, height: 650 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(currentCell(page).input).toHaveValue(originalValue)
  return ids
}

async function readRawStores(app: ElectronApplication): Promise<RawStores> {
  return app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try {
      return { entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        entityValues: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all() }
    } finally { database.close() }
  })
}

async function readStored(page: Page, app: ElectronApplication, language: Language) {
  const api = await page.evaluate(async language => {
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
  return { ...api, raw: await readRawStores(app) }
}

async function installWriteProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, WriteHandler> })._invokeHandlers
    const channels: CellChannel[] = ['knowbook:update-database-entity', 'knowbook:update-document-database-value']
    const originalEntity = handlers.get(channels[0]), originalDocument = handlers.get(channels[1])
    if (!originalEntity || !originalDocument) throw new Error('Both real authenticated database value handlers are required')
    const probe: MainProbe = { originals: { 'knowbook:update-database-entity': originalEntity,
      'knowbook:update-document-database-value': originalDocument }, requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookCellNotification = probe
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, input: CellInput) => {
        const request = { channel, input: structuredClone(input) }
        probe.requests.push(request)
        try {
          // Keep the real event, including sender/senderFrame authentication.
          // The actual store and SQLite trigger decide the write result.
          await probe.originals[channel](event, input)
          probe.writes.push(request)
        } catch (error) {
          probe.failures.push({ ...request, message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack ?? '' : '' })
          throw error
        }
      })
    }
  })
}

async function mainState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookCellNotification!
    return { requests: probe.requests, writes: probe.writes, failures: probe.failures }
  })
}

async function setFailure(app: ElectronApplication, ids: Ids, enabled: boolean) {
  await app.evaluate(({ app }, { ids, enabled, failureReason }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_cell_notification_failure')
      if (enabled) {
        const quote = (text: string) => text.replace(/'/g, "''")
        const event = ids.kind === 'custom' ? 'BEFORE UPDATE ON database_entities' : 'BEFORE INSERT ON document_database_values'
        const target = ids.kind === 'custom' ? `NEW.id = '${quote(ids.recordId)}'`
          : `NEW.document_id = '${quote(ids.recordId)}' AND NEW.column_id = '${quote(ids.fieldId)}'`
        // The catalog uses INSERT ... ON CONFLICT UPDATE, so BEFORE INSERT
        // catches its real upsert before it can alter an existing value.
        database.exec(`CREATE TRIGGER knowbook_e2e_cell_notification_failure ${event} WHEN ${target} ` +
          `BEGIN SELECT RAISE(ABORT, '${quote(failureReason)}'); END`)
      }
    } finally { database.close() }
  }, { ids, enabled, failureReason })
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string, diagnostics: Diagnostic[]) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const stored = await readStored(page, app, language), ipc = await mainState(app)
  const state = await currentCell(page).input.evaluate(element => {
    const input = element as HTMLInputElement, row = input.closest('tr')!, port = input.closest('.dbw-table-scroll')!
    const rect = input.getBoundingClientRect(), rowRect = row.getBoundingClientRect(), portRect = port.getBoundingClientRect()
    const left = Math.max(0, portRect.left + port.clientLeft), top = Math.max(0, portRect.top + port.clientTop)
    const right = Math.min(innerWidth, portRect.right), bottom = Math.min(innerHeight, portRect.bottom)
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    const text = (root: Element) => ({ title: root.querySelector('.app-notification-title')?.textContent ?? '',
      message: root.querySelector('.app-notification-message')?.textContent ?? '', text: root.textContent,
      role: root.querySelector('[role="alert"],[role="status"]')?.getAttribute('role') })
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      value: input.value, readOnly: input.readOnly, disabled: input.disabled,
      selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
      active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), isInput: document.activeElement === input },
      rowHeight: rowRect.height, ratio: Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left)) *
        Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top)) / (rect.width * rect.height), hit: hit === input,
      title: input.title, invalid: input.getAttribute('aria-invalid'), description: input.getAttribute('aria-describedby'),
      feedback: Array.from(row.querySelectorAll('.dbw-text-cell-feedback')).map(node => ({ id: node.id, text: node.textContent, role: node.getAttribute('role') })),
      buttons: Array.from(input.closest('td')!.querySelectorAll<HTMLButtonElement>('button')).map(button => {
        const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return { text: button.textContent?.trim(), width: box.width, height: box.height, disabled: button.disabled,
          ratio: Math.max(0, Math.min(box.right, right) - Math.max(box.left, left)) *
            Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)) / (box.width * box.height),
          hit: hit === button || Boolean(hit && button.contains(hit)) }
      }),
      query: document.querySelector<HTMLInputElement>('input[aria-label="Search records…"],input[aria-label="搜索记录…"]')?.value,
      source: document.querySelector('.dbw-source-trigger')?.textContent,
      summary: Array.from(document.querySelectorAll('.app-notifications .app-notification-summary')).map(text),
      live: Array.from(document.querySelectorAll('.app-notifications .app-notification')).map(text),
      centerOpen: Boolean(document.querySelector('dialog.notification-center[open]')),
      history: Array.from(document.querySelectorAll('.notification-center .app-notification')).map(text) }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, ipc, state, stored, diagnostics }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { ipc, state, stored }
}

function expectGeometry(state: Awaited<ReturnType<typeof record>>['state'], retry = false) {
  expect(state.rowHeight).toBeCloseTo(56, 0)
  expect(state.ratio).toBeCloseTo(1, 5)
  expect(state.hit).toBe(true)
  if (retry) {
    const button = state.buttons.find(button => /^(Retry|重试)$/.test(button.text ?? ''))
    expect(button).toBeDefined()
    expect(button!.width).toBeGreaterThanOrEqual(24)
    expect(button!.height).toBeGreaterThanOrEqual(24)
    expect(button!.ratio).toBeCloseTo(1, 5)
    expect(button!.hit).toBe(true)
  }
}

function expectedRequest(ids: Ids): Request {
  return ids.kind === 'custom'
    ? { channel: 'knowbook:update-database-entity', input: { entityId: ids.recordId, fieldValues: { [ids.fieldId]: draftValue } } }
    : { channel: 'knowbook:update-document-database-value', input: { documentId: ids.recordId, columnId: ids.fieldId, value: draftValue } }
}

function expectOnlyTargetFieldChanged(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids) {
  if (ids.kind === 'custom') {
    const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.recordId)!
    const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.recordId)!
    expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.fieldId]: draftValue }, updatedAt: saved.updatedAt })
    expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt))
    const originalRawEntity = before.raw.entities.find(row => row.id === ids.recordId)!
    const savedRawEntity = after.raw.entities.find(row => row.id === ids.recordId)!
    expect(savedRawEntity).toEqual({ ...originalRawEntity, updated_at: saved.updatedAt })
    const originalRawValue = before.raw.entityValues.find(row => row.entity_id === ids.recordId && row.column_id === ids.fieldId)!
    const savedRawValue = after.raw.entityValues.find(row => row.entity_id === ids.recordId && row.column_id === ids.fieldId)!
    expect(savedRawValue).toEqual({ ...originalRawValue, value_text: draftValue, updated_at: saved.updatedAt })
    expect(after).toEqual({ ...before, sources: before.sources.map(source => source.id === ids.databaseId
      ? { ...source, entities: source.entities.map(entity => entity.id === ids.recordId ? saved : entity) } : source),
      raw: { ...before.raw, entities: before.raw.entities.map(row => row.id === ids.recordId ? savedRawEntity : row),
        entityValues: before.raw.entityValues.map(row => row.entity_id === ids.recordId && row.column_id === ids.fieldId ? savedRawValue : row) } })
  } else {
    // Catalog records are documents, not database_entities. Their Notes value
    // must change while document content, paths and updatedAt remain identical.
    const original = before.catalog.find(document => document.id === ids.recordId)!
    const saved = after.catalog.find(document => document.id === ids.recordId)!
    expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.fieldId]: draftValue } })
    const originalRawValue = before.raw.documentValues.find(row => row.document_id === ids.recordId && row.column_id === ids.fieldId)!
    const savedRawValue = after.raw.documentValues.find(row => row.document_id === ids.recordId && row.column_id === ids.fieldId)!
    expect(savedRawValue).toEqual({ ...originalRawValue, value_text: draftValue, updated_at: savedRawValue.updated_at })
    expect(Date.parse(String(savedRawValue.updated_at))).toBeGreaterThanOrEqual(Date.parse(String(originalRawValue.updated_at)))
    expect(after).toEqual({ ...before, catalog: before.catalog.map(document => document.id === ids.recordId ? saved : document),
      raw: { ...before.raw, documentValues: before.raw.documentValues.map(row =>
        row.document_id === ids.recordId && row.column_id === ids.fieldId ? savedRawValue : row) } })
  }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  for (const kind of ['custom', 'catalog'] as const) {
    test(`database text failure notification is friendly and preserves diagnostics for ${kind} in ${language} @electron`, async ({}, info) => {
      test.setTimeout(120_000)
      test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
      await withElectronApp(async ({ page, app }) => {
        const errors: string[] = [], diagnostics: Diagnostic[] = [], diagnosticTasks: Array<Promise<void>> = []
        page.on('pageerror', error => errors.push(error.message))
        const ids = await seed(page, language, kind)
        page.on('console', message => {
          if (message.type() !== 'warning') return
          const entry: Diagnostic = { type: message.type(), text: message.text(), errors: [] }
          diagnostics.push(entry)
          const task = Promise.all(message.args().map(argument => argument.evaluate(value => {
            if (value && typeof value === 'object' && 'message' in value && 'stack' in value) {
              return { message: String(value.message), stack: String(value.stack) }
            }
            return null
          }).catch(() => null))).then(values => {
            entry.errors = values.filter((value): value is { message: string; stack: string } => value !== null)
          })
          diagnosticTasks.push(task)
        })
        const before = await readStored(page, app, language)
        const message = language === 'zh-CN' ? '保存失败，输入已保留，可以重试。' : 'Could not save. Your input has been kept. Try again.'
        const errorTitle = language === 'zh-CN' ? '操作失败' : 'Action failed'
        await installWriteProbe(app)
        await setFailure(app, ids, true)
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
          await expect(page.getByTestId('notification-summary')).toBeVisible()
          await twoFrames(page)
          await Promise.all(diagnosticTasks)
          // Preserve both live and real history evidence before the new
          // friendly-message oracle, which must fail on the old built app.
          const failed = await record(page, app, info, language, `${language}-${kind}-real-sqlite-failure-live-before-friendly-oracle`, diagnostics)
          await page.locator('.app-notification-summary-open').click()
          await expect(page.locator('dialog.notification-center[open]')).toBeVisible()
          const history = await record(page, app, info, language, `${language}-${kind}-real-notification-history-before-friendly-oracle`, diagnostics)
          await page.keyboard.press('Escape')
          await expect(page.locator('dialog.notification-center[open]')).toHaveCount(0)
          await twoFrames(page)

          expectGeometry(failed.state, true)
          expect(failed.ipc.requests).toEqual([expectedRequest(ids)])
          expect(failed.ipc.writes).toHaveLength(0)
          expect(failed.ipc.failures).toHaveLength(1)
          expect(failed.ipc.failures[0].message).toContain(failureReason)
          expect(failed.ipc.failures[0].stack).toContain(failureReason)
          expect(failed.stored).toEqual(before)
          expect(history.stored).toEqual(before)
          expect(history.ipc).toEqual(failed.ipc)
          expect(failed.state.summary).toHaveLength(1)
          expect(failed.state.summary[0].message).toBe(message)
          expect(failed.state.summary[0].title).toBe(errorTitle)
          expect(failed.state.summary[0].role).toBe('alert')
          expect(failed.state.live).toHaveLength(1)
          expect(failed.state.live[0].message).toBe(message)
          expect(history.state.history).toHaveLength(1)
          expect(history.state.history[0].message).toBe(message)
          expect(history.state.history[0].title).toBe(errorTitle)
          for (const item of [...failed.state.summary, ...failed.state.live, ...history.state.history]) {
            expect(item.message).not.toMatch(/SqliteError|Error invoking remote method/i)
            expect(item.message).not.toContain(failureReason)
          }
          const diagnosticErrors = diagnostics.flatMap(entry => entry.errors)
          expect(diagnostics.some(entry => entry.text.includes(failureReason))).toBe(true)
          expect(diagnosticErrors.some(error => error.message.includes(failureReason) && error.stack.includes(failureReason))).toBe(true)
          await expect(cell.input).toHaveAttribute('title', message)
          await expect(cell.input).toHaveAttribute('aria-invalid', 'true')
          await expect(cell.input).toHaveAttribute('aria-describedby', (await cell.feedback.getAttribute('id'))!)

          await setFailure(app, ids, false)
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
          const saved = await record(page, app, info, language, `${language}-${kind}-explicit-native-retry-has-one-real-write`, diagnostics)
          expect(saved.ipc.requests).toEqual([expectedRequest(ids), expectedRequest(ids)])
          expect(saved.ipc.writes).toEqual([expectedRequest(ids)])
          expect(saved.ipc.failures).toEqual(failed.ipc.failures)
          expectOnlyTargetFieldChanged(before, saved.stored, ids)
          expectGeometry(saved.state)
          await page.reload()
          await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
          await expect(cell.input).toHaveValue(draftValue)
          await expect(cell.feedback).toHaveCount(0)
          const reloaded = await record(page, app, info, language, `${language}-${kind}-only-target-field-and-allowed-time-persist-after-reload`, diagnostics)
          expect(reloaded.stored).toEqual(saved.stored)
          expect(reloaded.ipc).toEqual(saved.ipc)
          await page.getByTitle(uiText('Notification center', '通知中心'), { exact: true }).click()
          await expect(page.locator('dialog.notification-center[open]')).toBeVisible()
          const restoredHistory = await record(page, app, info, language, `${language}-${kind}-friendly-history-persists-without-exposing-technical-reason`, diagnostics)
          expect(restoredHistory.state.history).toHaveLength(1)
          expect(restoredHistory.state.history[0].message).toBe(message)
          expect(restoredHistory.state.history[0].title).toBe(errorTitle)
          expect(restoredHistory.stored).toEqual(saved.stored)
          expect(restoredHistory.ipc).toEqual(saved.ipc)
          await page.keyboard.press('Escape')
          await expect(page.locator('dialog.notification-center[open]')).toHaveCount(0)
          expect(errors).toEqual([])
        } finally {
          await setFailure(app, ids, false).catch(() => undefined)
        }
      }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
    })
  }
}
