import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Ids = { databaseId: string; entityId: string; statusId: string; notesId: string; viewId: string }
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Gate = { started: boolean; released: boolean; release?: () => void }
type Probe = { databaseId: string; requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }>;
  reads: Array<{ databaseId: string; failed: boolean }>; diagnosticReads: boolean; failNextRead: boolean;
  gate?: Gate; readGate?: Gate & { captured?: unknown } }
type ProbeGlobal = typeof globalThis & { __selectSaveProbe?: Probe }
type SchemaRow = { name: string; [key: string]: unknown }
type EntityRow = { id: string; updated_at: string; [key: string]: unknown }
type ValueRow = { entity_id: string; column_id: string; value_text: string | null; updated_at: string; [key: string]: unknown }
const sourceName = 'Select save source'
const recordTitle = 'Original select record'
const viewName = 'Original select table'
const failureReason = 'Database Status update is temporarily unavailable.'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator) {
  const steps: unknown[] = []
  for (let step = 0; step < 4; step += 1) {
    const state = await target.evaluate(element => ({ focused: document.activeElement === element,
      active: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName,
        text: document.activeElement.textContent, label: document.activeElement.getAttribute('aria-label') } : null }))
    steps.push({ step, ...state })
    if (state.focused) return steps
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
  return steps
}

async function prepare(page: Page, language: Language): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, sourceName, recordTitle, viewName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep original records, fields and view configuration.' })
    const status = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Status', type: 'select', options: ['Blue', 'Red', 'Green'] })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [status.id]: 'Blue', [notes.id]: 'Original Notes' } })
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', status.id, notes.id], fieldOrder: ['__title__', status.id, notes.id],
      columnWidths: { __title__: 220, [status.id]: 160, [notes.id]: 160 }, cardFieldIds: [status.id, notes.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { databaseId: database.id, entityId: entity.id, statusId: status.id, notesId: notes.id, viewId: view.id }
  }, { language, sourceName, recordTitle, viewName })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', viewName)
  await expect(page.locator('.dbw-main-search input')).toHaveValue('Original')
  await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
  return ids
}

async function installFailure(app: ElectronApplication, ids: Ids) {
  await app.evaluate(({ app }, { ids, failureReason }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      // Reject the actual target property INSERT inside the store transaction.
      // The preceding entity touch and value DELETE must roll back as well.
      database.exec('CREATE TRIGGER knowbook_e2e_select_failure BEFORE INSERT ON database_entity_values ' +
        `WHEN NEW.entity_id = '${ids.entityId.replace(/'/g, "''")}' AND NEW.column_id = '${ids.statusId.replace(/'/g, "''")}' ` +
        `BEGIN SELECT RAISE(ABORT, '${failureReason.replace(/'/g, "''")}'); END`)
    } finally { database.close() }
  }, { ids, failureReason })
}

async function removeFailure(app: ElectronApplication) {
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try { database.exec('DROP TRIGGER knowbook_e2e_select_failure') } finally { database.close() }
  })
}

async function installProbe(app: ElectronApplication, ids: Ids) {
  await app.evaluate(({ ipcMain }, ids) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { databaseId: ids.databaseId, requests: [], writes: [], failures: [], reads: [], diagnosticReads: false, failNextRead: false }
    ;(globalThis as ProbeGlobal).__selectSaveProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        const request = { channel, input: structuredClone(input) }
        probe.requests.push(request)
        try {
          if (channel === 'knowbook:update-database-entity' && (input[0] as UpdateDatabaseEntityInput).entityId === ids.entityId && probe.gate && !probe.gate.started) {
            probe.gate.started = true
            await new Promise<void>(resolve => { probe.gate!.release = resolve })
          }
          const result = await original(event, ...input)
          probe.writes.push(request)
          return result
        } catch (error) {
          probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) })
          throw error
        }
      })
    }
    const readChannel = 'knowbook:get-database-entities'
    const originalRead = handlers.get(readChannel)
    if (!originalRead) throw new Error('The original authenticated database entities handler is required')
    ipcMain.removeHandler(readChannel)
    ipcMain.handle(readChannel, async (event, databaseId: string) => {
      const result = await originalRead(event, databaseId)
      if (databaseId === ids.databaseId && !probe.diagnosticReads) {
        const failed = probe.failNextRead
        probe.failNextRead = false
        if (failed && probe.readGate) {
          probe.readGate.started = true
          probe.readGate.captured = structuredClone(result)
          await new Promise<void>(resolve => { probe.readGate!.release = resolve })
        }
        probe.reads.push({ databaseId, failed })
        // A temporary IPC reply fault after a genuine authenticated read,
        // explicitly distinct from the preceding real SQLite write failure.
        if (failed) throw new Error('E2E temporary database entities IPC reply failure.')
      }
      return result
    })
  }, ids)
}

async function mainState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__selectSaveProbe!
    return { databaseId: probe.databaseId, readChannel: 'knowbook:get-database-entities', requests: probe.requests, writes: probe.writes, failures: probe.failures, reads: probe.reads,
      failNextRead: probe.failNextRead, gate: probe.gate ? { started: probe.gate.started, released: probe.gate.released } : null,
      readGate: probe.readGate ? { started: probe.readGate.started, released: probe.readGate.released, captured: probe.readGate.captured } : null }
  })
}

async function armWriteAndReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__selectSaveProbe!
    probe.gate = { started: false, released: false }
    probe.readGate = { started: false, released: false }
    probe.failNextRead = true
  })
}

async function releaseWrite(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as ProbeGlobal).__selectSaveProbe!.gate
    if (!gate?.started || !gate.release) throw new Error('A genuine pending write is required')
    gate.released = true
    gate.release()
  })
}

async function releaseReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as ProbeGlobal).__selectSaveProbe!.readGate
    if (!gate?.started || !gate.release) throw new Error('A genuine captured entities read is required')
    gate.released = true
    gate.release()
  })
}

async function readStored(page: Page, app: ElectronApplication, language: Language) {
  // Evidence reads still delegate the real authenticated handler, but are
  // excluded from the UI refresh counter and its one-shot reply fault.
  await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__selectSaveProbe; if (probe) probe.diagnosticReads = true })
  try {
    const api = await page.evaluate(async language => {
      const databases = (await window.knowbook.getDatabases()).sort((left, right) => left.id.localeCompare(right.id))
      const catalog = (await window.knowbook.getDocumentCatalog()).sort((left, right) => left.id.localeCompare(right.id))
      return { databases, catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
        templates: (await window.knowbook.listDocumentTemplates(language)).sort((left, right) => left.id.localeCompare(right.id)),
        sources: await Promise.all(databases.map(async database => ({ id: database.id,
          entities: (await window.knowbook.getDatabaseEntities(database.id)).sort((left, right) => left.id.localeCompare(right.id)),
          fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort((left, right) => left.id.localeCompare(right.id)),
          views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort((left, right) => left.id.localeCompare(right.id)) }))) }
    }, language)
    const sql = await app.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('node:module')!
      const { join } = process.getBuiltinModule('node:path')!
      const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
      const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
      try { return {
        schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as SchemaRow[],
        columns: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all() as EntityRow[],
        values: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all() as ValueRow[],
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all(),
        views: database.prepare('SELECT * FROM database_saved_views ORDER BY id').all()
      } } finally { database.close() }
    })
    return { ...api, sql }
  } finally {
    await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__selectSaveProbe; if (probe) probe.diagnosticReads = false })
  }
}

async function geometry(target: Locator) {
  return target.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    const ancestors: unknown[] = []
    // Preserve fractional border-box edges. Integer client dimensions only
    // identify scrollbar occupancy, rather than rounding the clipping edge.
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect()
      const borderLeft = parseFloat(style.borderLeftWidth) || 0, borderRight = parseFloat(style.borderRightWidth) || 0
      const borderTop = parseFloat(style.borderTopWidth) || 0, borderBottom = parseFloat(style.borderBottomWidth) || 0
      const scrollbarWidth = /auto|scroll/.test(style.overflowY)
        ? Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - Math.round(borderLeft + borderRight)) : 0
      const scrollbarHeight = /auto|scroll/.test(style.overflowX)
        ? Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - Math.round(borderTop + borderBottom)) : 0
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        left = Math.max(left, rect.left + borderLeft)
        right = Math.min(right, rect.right - borderRight - scrollbarWidth)
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        top = Math.max(top, rect.top + borderTop)
        bottom = Math.min(bottom, rect.bottom - borderBottom - scrollbarHeight)
      }
      ancestors.push({ tag: ancestor.tagName, className: ancestor.className, rect: rect.toJSON(),
        clientWidth: ancestor.clientWidth, clientHeight: ancestor.clientHeight, offsetWidth: ancestor.offsetWidth, offsetHeight: ancestor.offsetHeight,
        overflowX: style.overflowX, overflowY: style.overflowY, position: style.position,
        borderLeft, borderRight, borderTop, borderBottom, scrollbarWidth, scrollbarHeight, clip: { left, top, right, bottom } })
      if (style.position === 'fixed') break
    }
    const area = Math.max(0, Math.min(bounds.right, right) - Math.max(bounds.left, left))
      * Math.max(0, Math.min(bounds.bottom, bottom) - Math.max(bounds.top, top))
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    return { text: element.textContent, bounds: bounds.toJSON(), clip: { left, top, right, bottom }, ancestors,
      ratio: bounds.width > 0 && bounds.height > 0 ? area / (bounds.width * bounds.height) : 0,
      centerHit: hit === element || Boolean(hit && element.contains(hit)) }
  })
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, select: Locator,
  before: Awaited<ReturnType<typeof readStored>>, phase: string) {
  const state = await select.evaluate(element => {
    const select = element as HTMLSelectElement, cell = select.closest('td')!, row = cell.closest('tr')!, rect = select.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    const visibleNotifications = Array.from(document.querySelectorAll<HTMLElement>('.app-notification-summary,.app-notification'))
      .filter(notification => {
        const bounds = notification.getBoundingClientRect(), style = getComputedStyle(notification)
        return notification.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          && bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < innerWidth && bounds.top < innerHeight
      }).map(notification => ({ text: notification.textContent, rect: notification.getBoundingClientRect().toJSON() as {
        left: number; right: number; top: number; bottom: number; width: number; height: number
      } }))
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      view: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      notes: row.querySelector<HTMLInputElement>('.catalog-cell-input[aria-label="Notes"]')?.value,
      rowHeight: row.getBoundingClientRect().height, value: select.value, selected: select.selectedOptions[0]?.textContent,
      disabled: select.disabled, focused: select === document.activeElement, busy: select.getAttribute('aria-busy'),
      ariaDisabled: select.getAttribute('aria-disabled'), description: select.getAttribute('aria-describedby'),
      rect: rect.toJSON(), centerHit: hit === select || Boolean(hit && select.contains(hit)), visibleNotifications,
      notificationIntersections: visibleNotifications.map(notification => ({ text: notification.text,
        area: Math.max(0, Math.min(rect.right, notification.rect.right) - Math.max(rect.left, notification.rect.left))
          * Math.max(0, Math.min(rect.bottom, notification.rect.bottom) - Math.max(rect.top, notification.rect.top)) })),
      feedback: Array.from(cell.querySelectorAll('[role="alert"],[role="status"]')).map(node => ({ id: node.id, role: node.getAttribute('role'), text: node.textContent })),
      actions: Array.from(cell.querySelectorAll('button')).map(button => {
        const bounds = button.getBoundingClientRect(), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        return { text: button.textContent, disabled: button.disabled, busy: button.getAttribute('aria-busy'), ariaDisabled: button.getAttribute('aria-disabled'),
          bounds: bounds.toJSON(), centerHit: hit === button || Boolean(hit && button.contains(hit)),
          notificationIntersections: visibleNotifications.map(notification => ({ text: notification.text,
            area: Math.max(0, Math.min(bounds.right, notification.rect.right) - Math.max(bounds.left, notification.rect.left))
              * Math.max(0, Math.min(bounds.bottom, notification.rect.bottom) - Math.max(bounds.top, notification.rect.top)) })) }
      }),
      active: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName, text: document.activeElement.textContent,
        label: document.activeElement.getAttribute('aria-label') } : null,
      notifications: Array.from(document.querySelectorAll('.app-notification-summary,.app-notification')).map(node => node.textContent) }
  })
  const layout = { select: await geometry(select), actions: await Promise.all((await select.locator('xpath=ancestor::td').getByRole('button').all()).map(button => geometry(button))) }
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const ipc = await mainState(app), stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, state, layout, windows, ipc, before, stored }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { state, layout, ipc, stored }
}

function withoutFailureTrigger(before: Awaited<ReturnType<typeof readStored>>) {
  return { ...before, sql: { ...before.sql, schema: before.sql.schema.filter(row => row.name !== 'knowbook_e2e_select_failure') } }
}

function expectOnlyStatusSaved(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids) {
  const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.statusId]: 'Red' }, updatedAt: saved.updatedAt })
  expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true)
  expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt))
  const expected = withoutFailureTrigger(before)
  expect(after).toEqual({ ...expected,
    sources: expected.sources.map(source => source.id !== ids.databaseId ? source : {
      ...source, entities: source.entities.map(entity => entity.id === ids.entityId ? saved : entity)
    }),
    sql: { ...expected.sql,
      entities: expected.sql.entities.map(entity => entity.id === ids.entityId ? { ...entity, updated_at: saved.updatedAt } : entity),
      values: expected.sql.values.map(value => value.entity_id === ids.entityId && value.column_id === ids.statusId
        ? { ...value, value_text: 'Red', updated_at: saved.updatedAt } : value)
    }
  })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('a saved select choice remains visible when its authenticated refresh reply fails in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language), text = getDatabaseWorkspaceText(language)
      await installFailure(app, ids)
      const before = await readStored(page, app, language)
      await installProbe(app, ids)
      const select = page.locator('tbody select[aria-label="Status"]'), cell = select.locator('xpath=ancestor::td')
      const feedback = cell.locator('[role="alert"],[role="status"]')
      await expect(select).toHaveValue('Blue')
      // Native Shift+Tab reaches the closed select from its real neighbor.
      // ArrowDown changes an option without opening an OS dropdown.
      await page.locator('tbody .catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(select).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect.poll(async () => (await mainState(app)).failures.length).toBe(1)
      await expect(feedback).toHaveAttribute('role', 'alert')
      await expect(feedback).toHaveText(text.selectSaveFailed)
      await expect(page.locator('.app-notifications')).toContainText(text.selectSaveFailed)
      await twoFrames(page)
      const rejected = await record(page, app, info, language, select, before, language + '-real-select-write-rejected-before-rollback-oracle')
      const update: UpdateDatabaseEntityInput = { entityId: ids.entityId, fieldValues: { [ids.statusId]: 'Red' } }
      const request = { channel: 'knowbook:update-database-entity', input: [update] }
      expect(rejected.ipc.requests).toEqual([request])
      expect(rejected.ipc.writes).toHaveLength(0)
      expect(rejected.ipc.failures).toHaveLength(1)
      expect(rejected.ipc.failures[0].reason).toContain(failureReason)
      expect(rejected.ipc.reads).toHaveLength(0)
      expect(rejected.stored).toEqual(before)
      expect(rejected.state.value).toBe('Blue')
      expect(rejected.state.selected).toBe('Blue')
      expect(rejected.state.focused).toBe(true)
      expect(rejected.state.source).toBe(sourceName)
      expect(rejected.state.view).toBe(viewName)
      expect(rejected.state.query).toBe('Original')
      expect(rejected.state.notes).toBe('Original Notes')
      expect(rejected.state.feedback.map(node => ({ role: node.role, text: node.text })))
        .toEqual([{ role: 'alert', text: text.selectSaveFailed }])
      await expect(select).toHaveAttribute('aria-describedby', rejected.state.feedback[0].id)
      await expect(select).toHaveAttribute('title', text.selectSaveFailed)
      await expect(select).toBeFocused()

      await removeFailure(app)
      expect(await readStored(page, app, language)).toEqual(withoutFailureTrigger(before))
      await armWriteAndReadFailure(app)
      await page.keyboard.press('ArrowDown')
      await expect.poll(async () => (await mainState(app)).requests.length).toBe(2)
      await expect.poll(async () => (await mainState(app)).gate?.started).toBe(true)
      await expect(select).toHaveJSProperty('disabled', false)
      await expect(select).toHaveAttribute('aria-disabled', 'true')
      await expect(select).toHaveAttribute('aria-busy', 'true')
      await expect(select).toHaveValue('Red')
      await expect(select).toBeFocused()
      await expect(feedback).toHaveText(text.saving)
      // A second native change while write-pending cannot dispatch Green or
      // replace the accepted Red draft; native focus remains on the select.
      await page.keyboard.press('ArrowDown')
      await twoFrames(page)
      const saving = await record(page, app, info, language, select, before, language + '-native-repeat-arrow-cannot-duplicate-pending-select-write')
      expect(saving.ipc.requests).toEqual([request, request])
      expect(saving.ipc.writes).toHaveLength(0)
      expect(saving.ipc.failures).toEqual(rejected.ipc.failures)
      expect(saving.ipc.reads).toHaveLength(0)
      expect(saving.stored).toEqual(withoutFailureTrigger(before))
      expect(saving.state.value).toBe('Red')
      expect(saving.state.focused).toBe(true)
      expect(saving.state.disabled).toBe(false)
      expect(saving.state.busy).toBe('true')
      expect(saving.state.ariaDisabled).toBe('true')
      expect(saving.state.feedback[0].text).toBe(text.saving)

      await releaseWrite(app)
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
      await expect.poll(async () => (await mainState(app)).readGate?.started).toBe(true)
      await expect(select).toHaveValue('Red')
      await expect(select).toHaveJSProperty('disabled', false)
      await expect(select).not.toHaveAttribute('aria-disabled', 'true')
      await expect(select).toBeFocused()
      await expect(feedback).toHaveAttribute('role', 'status')
      await expect(feedback).toHaveText(text.cellRefreshing)
      const held = await record(page, app, info, language, select, before, language + '-real-select-red-ack-before-captured-authenticated-read-reply')
      expect(held.ipc.requests).toEqual([request, request])
      expect(held.ipc.writes).toEqual([request])
      expect(held.ipc.failures).toEqual(rejected.ipc.failures)
      expect(held.ipc.reads).toHaveLength(0)
      expect(held.ipc.readGate).toMatchObject({ started: true, released: false })
      expect(held.ipc.readGate?.captured).toEqual(held.stored.sources.find(source => source.id === ids.databaseId)!.entities)
      expectOnlyStatusSaved(before, held.stored, ids)
      await releaseReadFailure(app)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(1)
      await expect(feedback).toHaveAttribute('role', 'status')
      await expect(feedback).toHaveText(text.savedRefreshFailed)
      const refresh = cell.getByRole('button', { name: text.refresh, exact: true })
      await expect(refresh).toBeVisible()
      const liveNotifications = page.locator('.app-notification:visible,.app-notification-summary:visible')
      await expect(liveNotifications).toHaveCount(2)
      await twoFrames(page)
      const failedRead = await record(page, app, info, language, select, before, language + '-saved-select-red-after-temporary-ipc-read-fault-before-ui-oracle')
      expect(failedRead.ipc.requests).toEqual(held.ipc.requests)
      expect(failedRead.ipc.writes).toEqual(held.ipc.writes)
      expect(failedRead.ipc.failures).toEqual(rejected.ipc.failures)
      expect(failedRead.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true }])
      expect(failedRead.ipc.readGate).toMatchObject({ started: true, released: true })
      expect(failedRead.stored).toEqual(held.stored)
      expectOnlyStatusSaved(before, failedRead.stored, ids)
      expect(failedRead.state.source).toBe(sourceName)
      expect(failedRead.state.view).toBe(viewName)
      expect(failedRead.state.query).toBe('Original')
      expect(failedRead.state.notes).toBe('Original Notes')
      expect(failedRead.state.centerHit).toBe(true)
      expect(errors).toEqual([])
      // Original business oracle: after a real write ACK and failure of only
      // its authenticated read reply, saved Red must never display old Blue.
      expect(failedRead.state.value).toBe('Red')
      expect(failedRead.state.selected).toBe('Red')
      expect(failedRead.state.feedback.map(node => ({ role: node.role, text: node.text })))
        .toEqual([{ role: 'status', text: text.savedRefreshFailed }])
      await expect(select).toHaveAttribute('title', text.savedRefreshFailed)
      await expect(select).toHaveAttribute('aria-describedby', failedRead.state.feedback[0].id)
      expect(failedRead.layout.select.ratio).toBe(1)
      expect(failedRead.layout.actions).toHaveLength(1)
      expect(failedRead.layout.actions[0].ratio).toBe(1)
      expect(failedRead.state.actions).toHaveLength(1)
      expect(failedRead.state.actions[0].centerHit).toBe(true)
      expect(failedRead.state.actions[0].disabled).toBe(false)
      expect(failedRead.state.actions[0].ariaDisabled).not.toBe('true')
      await expect(liveNotifications).toHaveCount(2)
      expect(failedRead.state.visibleNotifications).toHaveLength(2)
      for (const node of [failedRead.state, failedRead.state.actions[0]]) {
        expect(node.notificationIntersections).toHaveLength(2)
        for (const intersection of node.notificationIntersections) expect(intersection.area).toBe(0)
      }
      if (language === 'en-US') await refresh.click()
      else { await tabTo(page, refresh); await page.keyboard.press('Enter') }
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(2)
      await expect(feedback).toHaveCount(0)
      await expect(refresh).toHaveCount(0)
      await expect(select).toHaveValue('Red')
      await twoFrames(page)
      const refreshed = await record(page, app, info, language, select, before, language + '-native-pure-refresh-recovers-select-without-replaying-write')
      expect(refreshed.ipc.requests).toEqual(failedRead.ipc.requests)
      expect(refreshed.ipc.writes).toEqual(failedRead.ipc.writes)
      expect(refreshed.ipc.failures).toEqual(failedRead.ipc.failures)
      expect(refreshed.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true }, { databaseId: ids.databaseId, failed: false }])
      expect(refreshed.stored).toEqual(failedRead.stored)
      expect(refreshed.state.feedback).toHaveLength(0)
      expect(refreshed.state.actions).toHaveLength(0)

      await page.reload()
      await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
      await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
      await expect(select).toHaveValue('Red')
      await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
      await expect(page.locator('.dbw-main-search input')).toHaveValue('Original')
      expect(await readStored(page, app, language)).toEqual(failedRead.stored)
      const localeSave = { channel: 'knowbook:save-setting', input: ['ui.language', language] }
      await expect.poll(async () => (await mainState(app)).requests.filter(request => request.channel === localeSave.channel
        && request.input.length === 2 && request.input[0] === 'ui.language' && request.input[1] === language).length).toBe(1)
      await expect.poll(async () => (await mainState(app)).writes.filter(request => request.channel === localeSave.channel
        && request.input.length === 2 && request.input[0] === 'ui.language' && request.input[1] === language).length).toBe(1)
      expect(await page.evaluate(() => window.knowbook.getSetting('ui.language'))).toBe(language)
      const reloaded = await record(page, app, info, language, select, before, language + '-only-acknowledged-select-change-survives-reload')
      expect(reloaded.ipc.requests).toEqual([...failedRead.ipc.requests, localeSave])
      expect(reloaded.ipc.writes).toEqual([...failedRead.ipc.writes, localeSave])
      expect(reloaded.ipc.failures).toEqual(failedRead.ipc.failures)
      expect(reloaded.ipc.writes.filter(request => request.channel === 'knowbook:update-database-entity')).toHaveLength(1)
      expect(reloaded.state.source).toBe(sourceName)
      expect(reloaded.state.view).toBe(viewName)
      expect(reloaded.state.query).toBe('Original')
      expect(reloaded.state.notes).toBe('Original Notes')
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
