import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Ids = { databaseId: string; entityId: string; doneId: string; notesId: string; viewId: string }
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Gate = { started: boolean; released: boolean; release?: () => void }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }>;
  reads: Array<{ databaseId: string; failed: boolean }>; diagnosticReads: boolean; gates: Gate[]; holdWrites: boolean;
  failNextRead: boolean; readGate?: Gate & { captured?: unknown } }
type ProbeGlobal = typeof globalThis & { __checkboxSaveProbe?: Probe }
type SchemaRow = { name: string; [key: string]: unknown }
type EntityRow = { id: string; updated_at: string; [key: string]: unknown }
type ValueRow = { entity_id: string; column_id: string; value_text: string | null; updated_at: string; [key: string]: unknown }
const sourceName = 'Checkbox save source'
const recordTitle = 'Original checkbox record'
const viewName = 'Original checkbox table'
const failureReason = 'Database Done update is temporarily unavailable.'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function prepare(page: Page, language: Language): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, sourceName, recordTitle, viewName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep original records, fields and view configuration.' })
    const done = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Done', type: 'checkbox' })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [done.id]: false, [notes.id]: 'Original Notes' } })
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', done.id, notes.id], fieldOrder: ['__title__', done.id, notes.id],
      columnWidths: { __title__: 220, [done.id]: 160, [notes.id]: 160 }, cardFieldIds: [done.id, notes.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { databaseId: database.id, entityId: entity.id, doneId: done.id, notesId: notes.id, viewId: view.id }
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

async function installProbe(app: ElectronApplication, ids: Ids) {
  await app.evaluate(({ ipcMain }, ids) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [], reads: [], diagnosticReads: false, gates: [], holdWrites: true, failNextRead: false }
    ;(globalThis as ProbeGlobal).__checkboxSaveProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        const request = { channel, input: structuredClone(input) }
        probe.requests.push(request)
        try {
          if (probe.holdWrites && channel === 'knowbook:update-database-entity' && (input[0] as UpdateDatabaseEntityInput).entityId === ids.entityId) {
            // Every accepted request is held before the genuine authenticated
            // handler. A duplicate cannot bypass the first request's gate.
            const gate: Gate = { started: true, released: false }
            probe.gates.push(gate)
            await new Promise<void>(resolve => { gate.release = resolve })
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
    const readChannel = 'knowbook:get-database-entities', originalRead = handlers.get(readChannel)
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
        // The original authenticated GET completed. Only its IPC reply fails;
        // this is distinct from the real SQLite write failure fixture below.
        if (failed) throw new Error('E2E temporary database entities IPC reply failure.')
      }
      return result
    })
  }, ids)
}

async function mainState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__checkboxSaveProbe!
    return { requests: probe.requests, writes: probe.writes, failures: probe.failures, reads: probe.reads,
      readChannel: 'knowbook:get-database-entities', holdWrites: probe.holdWrites,
      gates: probe.gates.map(gate => ({ started: gate.started, released: gate.released })),
      readGate: probe.readGate ? { started: probe.readGate.started, released: probe.readGate.released, captured: probe.readGate.captured } : null }
  })
}

async function releaseWrite(app: ElectronApplication, index: number) {
  await app.evaluate(({}, index) => {
    const gate = (globalThis as ProbeGlobal).__checkboxSaveProbe!.gates[index]
    if (!gate?.started || gate.released || !gate.release) throw new Error('An unreleased genuine accepted write is required')
    gate.released = true
    gate.release()
  }, index)
}

async function armReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__checkboxSaveProbe!
    probe.failNextRead = true
    probe.readGate = { started: false, released: false }
  })
}

async function releaseReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as ProbeGlobal).__checkboxSaveProbe!.readGate
    if (!gate?.started || !gate.release) throw new Error('A genuine captured authenticated GET is required')
    gate.released = true
    gate.release()
  })
}

async function holdWrites(app: ElectronApplication, hold: boolean) {
  await app.evaluate(({}, hold) => { (globalThis as ProbeGlobal).__checkboxSaveProbe!.holdWrites = hold }, hold)
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
      database.exec('CREATE TRIGGER knowbook_e2e_checkbox_failure BEFORE INSERT ON database_entity_values ' +
        `WHEN NEW.entity_id = '${ids.entityId.replace(/'/g, "''")}' AND NEW.column_id = '${ids.doneId.replace(/'/g, "''")}' AND NEW.value_text = 'false' ` +
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
    try { database.exec('DROP TRIGGER knowbook_e2e_checkbox_failure') } finally { database.close() }
  })
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

async function readStored(page: Page, app: ElectronApplication, language: Language) {
  // Evidence reads still delegate the real authenticated handler, but are
  // excluded from the UI refresh counter; no data or handler result is faked.
  await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__checkboxSaveProbe; if (probe) probe.diagnosticReads = true })
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
    await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__checkboxSaveProbe; if (probe) probe.diagnosticReads = false })
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

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, input: Locator,
  before: Awaited<ReturnType<typeof readStored>>, phase: string) {
  const state = await input.evaluate(element => {
    const input = element as HTMLInputElement, cell = input.closest('td')!, row = cell.closest('tr')!, bounds = input.getBoundingClientRect()
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    const visibleNotifications = Array.from(document.querySelectorAll<HTMLElement>('.app-notification-summary,.app-notification'))
      .filter(notification => {
        const rect = notification.getBoundingClientRect(), style = getComputedStyle(notification)
        return notification.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
      }).map(notification => ({ text: notification.textContent, rect: notification.getBoundingClientRect().toJSON() as {
        left: number; right: number; top: number; bottom: number; width: number; height: number
      } }))
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      view: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      notes: row.querySelector<HTMLInputElement>('.catalog-cell-input[aria-label="Notes"]')?.value,
      rowHeight: row.getBoundingClientRect().height, checked: input.checked, focused: input === document.activeElement,
      disabled: input.disabled, busy: input.getAttribute('aria-busy'), ariaDisabled: input.getAttribute('aria-disabled'),
      description: input.getAttribute('aria-describedby'), title: input.title, bounds: bounds.toJSON(), centerHit: hit === input, visibleNotifications,
      notificationIntersections: visibleNotifications.map(notification => ({ text: notification.text,
        area: Math.max(0, Math.min(bounds.right, notification.rect.right) - Math.max(bounds.left, notification.rect.left))
          * Math.max(0, Math.min(bounds.bottom, notification.rect.bottom) - Math.max(bounds.top, notification.rect.top)) })),
      feedback: Array.from(cell.querySelectorAll('[role="alert"],[role="status"]')).map(node => ({ id: node.id, role: node.getAttribute('role'), text: node.textContent })),
      actions: Array.from(cell.querySelectorAll('button')).map(button => {
        const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { text: button.textContent, disabled: button.disabled, busy: button.getAttribute('aria-busy'), ariaDisabled: button.getAttribute('aria-disabled'),
          rect: rect.toJSON(), centerHit: hit === button || Boolean(hit && button.contains(hit)),
          notificationIntersections: visibleNotifications.map(notification => ({ text: notification.text,
            area: Math.max(0, Math.min(rect.right, notification.rect.right) - Math.max(rect.left, notification.rect.left))
              * Math.max(0, Math.min(rect.bottom, notification.rect.bottom) - Math.max(rect.top, notification.rect.top)) })) }
      }),
      active: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName,
        text: document.activeElement.textContent, label: document.activeElement.getAttribute('aria-label') } : null }
  })
  const layout = { input: await geometry(input), actions: await Promise.all((await input.locator('xpath=ancestor::td').getByRole('button').all()).map(button => geometry(button))) }
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

function withoutFailureTrigger(snapshot: Awaited<ReturnType<typeof readStored>>) {
  return { ...snapshot, sql: { ...snapshot.sql, schema: snapshot.sql.schema.filter(row => row.name !== 'knowbook_e2e_checkbox_failure') } }
}

function expectOnlyDoneSaved(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids, checked: boolean) {
  const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.doneId]: checked }, updatedAt: saved.updatedAt })
  expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true)
  expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt))
  const storedValue = after.sql.values.find(value => value.entity_id === ids.entityId && value.column_id === ids.doneId)
  expect(storedValue).toBeDefined()
  // False is an actual boolean property, never null or a deleted value row.
  expect(storedValue!.value_text).toBe(checked ? 'true' : 'false')
  expect(after).toEqual({ ...before,
    sources: before.sources.map(source => source.id !== ids.databaseId ? source : {
      ...source, entities: source.entities.map(entity => entity.id === ids.entityId ? saved : entity)
    }),
    sql: { ...before.sql,
      entities: before.sql.entities.map(entity => entity.id === ids.entityId ? { ...entity, updated_at: saved.updatedAt } : entity),
      values: before.sql.values.map(value => value.entity_id === ids.entityId && value.column_id === ids.doneId
        ? { ...value, value_text: checked ? 'true' : 'false', updated_at: saved.updatedAt } : value)
    }
  })
}

async function recoverByNativeInput(page: Page, language: Language, refresh: Locator) {
  if (language === 'en-US') await refresh.click()
  else { await tabTo(page, refresh); await page.keyboard.press('Enter') }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('a pending checkbox choice stays accepted and cannot dispatch a duplicate Space write in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language), text = getDatabaseWorkspaceText(language)
      const before = await readStored(page, app, language)
      await installProbe(app, ids)
      const done = page.locator('tbody input[type="checkbox"][aria-label="Done"]')
      await expect(done).not.toBeChecked()
      await page.locator('tbody .catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(done).toBeFocused()
      await page.keyboard.press('Space')
      await expect.poll(async () => (await mainState(app)).gates.length).toBe(1)
      await twoFrames(page)
      const first = await record(page, app, info, language, done, before, language + '-first-space-accepted-before-genuine-sqlite-handler')
      const update: UpdateDatabaseEntityInput = { entityId: ids.entityId, fieldValues: { [ids.doneId]: true } }
      const request = { channel: 'knowbook:update-database-entity', input: [update] }
      expect(first.ipc.requests).toEqual([request])
      expect(first.ipc.gates).toEqual([{ started: true, released: false }])
      expect(first.ipc.writes).toHaveLength(0)
      expect(first.ipc.failures).toHaveLength(0)
      expect(first.ipc.reads).toHaveLength(0)
      expect(first.stored).toEqual(before)
      expect(first.state.source).toBe(sourceName)
      expect(first.state.view).toBe(viewName)
      expect(first.state.query).toBe('Original')
      expect(first.state.notes).toBe('Original Notes')
      expect(first.state.focused).toBe(true)
      expect(first.state.disabled).toBe(false)
      expect(first.state.centerHit).toBe(true)
      await page.keyboard.press('Space')
      await twoFrames(page)
      const repeated = await record(page, app, info, language, done, before, language + '-repeat-native-space-before-pending-choice-and-singleflight-oracles')
      expect(repeated.stored).toEqual(before)
      expect(repeated.ipc.writes).toHaveLength(0)
      expect(repeated.ipc.failures).toHaveLength(0)
      expect(repeated.ipc.reads).toHaveLength(0)
      expect(repeated.ipc.gates).toHaveLength(repeated.ipc.requests.length)
      expect(repeated.ipc.gates.every(gate => gate.started && !gate.released)).toBe(true)
      for (const accepted of repeated.ipc.requests) expect(accepted).toEqual(request)
      expect(repeated.state.source).toBe(sourceName)
      expect(repeated.state.view).toBe(viewName)
      expect(repeated.state.query).toBe('Original')
      expect(repeated.state.notes).toBe('Original Notes')
      expect(repeated.state.focused).toBe(true)
      expect(repeated.state.disabled).toBe(false)
      expect(repeated.state.centerHit).toBe(true)
      expect(errors).toEqual([])
      // These business oracles follow the real accepted requests and full
      // unchanged storage proof; no held request has been released to SQLite.
      expect(first.state.checked).toBe(true)
      expect(repeated.state.checked).toBe(true)
      expect(repeated.ipc.requests).toEqual([request])
      expect(repeated.state.busy).toBe('true')
      expect(repeated.state.ariaDisabled).toBe('true')

      const cell = done.locator('xpath=ancestor::td'), feedback = cell.locator('[role="alert"],[role="status"]')
      const refresh = cell.getByRole('button', { name: text.refresh, exact: true })
      const liveNotifications = page.locator('.app-notification:visible,.app-notification-summary:visible')
      await armReadFailure(app)
      await releaseWrite(app, 0)
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
      await expect.poll(async () => (await mainState(app)).readGate?.started).toBe(true)
      await expect(done).toBeChecked()
      await expect(done).toHaveJSProperty('disabled', false)
      await expect(done).not.toHaveAttribute('aria-disabled', 'true')
      await expect(done).toBeFocused()
      await expect(feedback).toHaveAttribute('role', 'status')
      await expect(feedback).toHaveText(text.cellRefreshing)
      const acknowledgedTrue = await record(page, app, info, language, done, before, language + '-true-ack-unlocks-checkbox-before-genuine-get-reply')
      expect(acknowledgedTrue.ipc.requests).toEqual([request])
      expect(acknowledgedTrue.ipc.writes).toEqual([request])
      expect(acknowledgedTrue.ipc.failures).toHaveLength(0)
      expect(acknowledgedTrue.ipc.reads).toHaveLength(0)
      expect(acknowledgedTrue.ipc.readGate).toMatchObject({ started: true, released: false })
      expect(acknowledgedTrue.ipc.readGate?.captured).toEqual(acknowledgedTrue.stored.sources.find(source => source.id === ids.databaseId)!.entities)
      expectOnlyDoneSaved(before, acknowledgedTrue.stored, ids, true)
      await releaseReadFailure(app)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(1)
      await expect(feedback).toHaveAttribute('role', 'status')
      await expect(feedback).toHaveText(text.savedRefreshFailed)
      await expect(refresh).toBeVisible()
      await expect(liveNotifications).toHaveCount(1)
      await twoFrames(page)
      const trueReadFailed = await record(page, app, info, language, done, before, language + '-true-stays-saved-after-temporary-authenticated-get-reply-fault')
      expect(trueReadFailed.ipc.requests).toEqual([request])
      expect(trueReadFailed.ipc.writes).toEqual([request])
      expect(trueReadFailed.ipc.failures).toHaveLength(0)
      expect(trueReadFailed.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true }])
      expect(trueReadFailed.stored).toEqual(acknowledgedTrue.stored)
      expect(trueReadFailed.state.checked).toBe(true)
      expect(trueReadFailed.state.focused).toBe(true)
      expect(trueReadFailed.state.feedback.map(node => ({ role: node.role, text: node.text })))
        .toEqual([{ role: 'status', text: text.savedRefreshFailed }])
      expect(trueReadFailed.layout.actions).toHaveLength(1)
      expect(trueReadFailed.layout.actions[0].ratio).toBe(1)
      expect(trueReadFailed.state.actions[0].centerHit).toBe(true)
      await recoverByNativeInput(page, language, refresh)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(2)
      await expect(feedback).toHaveCount(0)
      await expect(refresh).toHaveCount(0)
      await expect(done).toBeChecked()
      const trueRefreshed = await record(page, app, info, language, done, before, language + '-pure-get-recovers-confirmed-true-without-write-replay')
      expect(trueRefreshed.ipc.requests).toEqual([request])
      expect(trueRefreshed.ipc.writes).toEqual([request])
      expect(trueRefreshed.ipc.failures).toHaveLength(0)
      expect(trueRefreshed.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true }, { databaseId: ids.databaseId, failed: false }])
      expect(trueRefreshed.stored).toEqual(acknowledgedTrue.stored)
      // Dismiss this already recovered read-fault notification through its
      // genuine UI button, leaving the later two real failures to test occlusion.
      await expect(page.locator('.app-notification:visible')).toHaveCount(1)
      await page.locator('.app-notification:visible').getByRole('button', {
        name: language === 'zh-CN' ? '关闭通知' : 'Dismiss notification', exact: true
      }).click()
      await expect(liveNotifications).toHaveCount(0)
      await page.locator('tbody .catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(done).toBeFocused()
      await holdWrites(app, false)
      await installFailure(app, ids)
      const failureReady = await readStored(page, app, language)
      expect(withoutFailureTrigger(failureReady)).toEqual(acknowledgedTrue.stored)
      expect(failureReady.sql.schema.filter(row => row.name === 'knowbook_e2e_checkbox_failure')).toHaveLength(1)
      await page.keyboard.press('Space')
      await expect.poll(async () => (await mainState(app)).failures.length).toBe(1)
      await expect(feedback).toHaveAttribute('role', 'alert')
      await expect(feedback).toHaveText(text.checkboxSaveFailed)
      await expect(page.locator('.app-notifications')).toContainText(text.checkboxSaveFailed)
      await twoFrames(page)
      const rejectedFalse = await record(page, app, info, language, done, before, language + '-real-sqlite-rejected-uncheck-restores-confirmed-true')
      const falseUpdate: UpdateDatabaseEntityInput = { entityId: ids.entityId, fieldValues: { [ids.doneId]: false } }
      const falseRequest = { channel: 'knowbook:update-database-entity', input: [falseUpdate] }
      expect(rejectedFalse.ipc.requests).toEqual([request, falseRequest])
      expect(rejectedFalse.ipc.writes).toEqual([request])
      expect(rejectedFalse.ipc.failures).toHaveLength(1)
      expect(rejectedFalse.ipc.failures[0]).toMatchObject(falseRequest)
      expect(rejectedFalse.ipc.failures[0].reason).toContain(failureReason)
      expect(rejectedFalse.ipc.reads).toEqual(trueRefreshed.ipc.reads)
      expect(rejectedFalse.stored).toEqual(failureReady)
      expect(rejectedFalse.state.checked).toBe(true)
      expect(rejectedFalse.state.focused).toBe(true)
      expect(rejectedFalse.state.feedback.map(node => ({ role: node.role, text: node.text })))
        .toEqual([{ role: 'alert', text: text.checkboxSaveFailed }])
      await expect(done).toHaveAttribute('aria-describedby', rejectedFalse.state.feedback[0].id)
      await expect(done).toHaveAttribute('title', text.checkboxSaveFailed)
      await expect(done).toBeFocused()
      await removeFailure(app)
      expect(await readStored(page, app, language)).toEqual(acknowledgedTrue.stored)
      await holdWrites(app, true)
      await armReadFailure(app)
      await page.keyboard.press('Space')
      await expect.poll(async () => (await mainState(app)).gates.length).toBe(2)
      await expect(done).not.toBeChecked()
      await expect(done).toHaveJSProperty('disabled', false)
      await expect(done).toHaveAttribute('aria-disabled', 'true')
      await expect(done).toHaveAttribute('aria-busy', 'true')
      await expect(done).toBeFocused()
      await expect(feedback).toHaveText(text.saving)
      await page.keyboard.press('Space')
      await twoFrames(page)
      const pendingFalse = await record(page, app, info, language, done, before, language + '-repeat-native-space-cannot-replace-accepted-false-or-duplicate-write')
      expect(pendingFalse.ipc.requests).toEqual([request, falseRequest, falseRequest])
      expect(pendingFalse.ipc.writes).toEqual([request])
      expect(pendingFalse.ipc.failures).toEqual(rejectedFalse.ipc.failures)
      expect(pendingFalse.ipc.reads).toEqual(trueRefreshed.ipc.reads)
      expect(pendingFalse.ipc.gates).toEqual([{ started: true, released: true }, { started: true, released: false }])
      expect(pendingFalse.stored).toEqual(acknowledgedTrue.stored)
      expect(pendingFalse.state.checked).toBe(false)
      expect(pendingFalse.state.focused).toBe(true)
      expect(pendingFalse.state.disabled).toBe(false)
      expect(pendingFalse.state.busy).toBe('true')
      expect(pendingFalse.state.ariaDisabled).toBe('true')
      await releaseWrite(app, 1)
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(2)
      await expect.poll(async () => (await mainState(app)).readGate?.started).toBe(true)
      await expect(done).not.toBeChecked()
      await expect(done).toHaveJSProperty('disabled', false)
      await expect(done).not.toHaveAttribute('aria-disabled', 'true')
      await expect(done).toBeFocused()
      await expect(feedback).toHaveText(text.cellRefreshing)
      const acknowledgedFalse = await record(page, app, info, language, done, before, language + '-false-ack-is-an-explicit-stored-boolean-before-get-reply')
      expect(acknowledgedFalse.ipc.requests).toEqual([request, falseRequest, falseRequest])
      expect(acknowledgedFalse.ipc.writes).toEqual([request, falseRequest])
      expect(acknowledgedFalse.ipc.failures).toEqual(rejectedFalse.ipc.failures)
      expect(acknowledgedFalse.ipc.reads).toEqual(trueRefreshed.ipc.reads)
      expect(acknowledgedFalse.ipc.readGate).toMatchObject({ started: true, released: false })
      expect(acknowledgedFalse.ipc.readGate?.captured).toEqual(acknowledgedFalse.stored.sources.find(source => source.id === ids.databaseId)!.entities)
      expectOnlyDoneSaved(acknowledgedTrue.stored, acknowledgedFalse.stored, ids, false)
      expectOnlyDoneSaved(before, acknowledgedFalse.stored, ids, false)
      await releaseReadFailure(app)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(3)
      await expect(feedback).toHaveAttribute('role', 'status')
      await expect(feedback).toHaveText(text.savedRefreshFailed)
      await expect(refresh).toBeVisible()
      await expect(liveNotifications).toHaveCount(2)
      await twoFrames(page)
      const falseReadFailed = await record(page, app, info, language, done, before, language + '-false-remains-saved-and-recovery-is-not-covered-by-two-real-notifications')
      expect(falseReadFailed.ipc.requests).toEqual(acknowledgedFalse.ipc.requests)
      expect(falseReadFailed.ipc.writes).toEqual([request, falseRequest])
      expect(falseReadFailed.ipc.failures).toEqual(rejectedFalse.ipc.failures)
      expect(falseReadFailed.ipc.reads).toEqual([...trueRefreshed.ipc.reads, { databaseId: ids.databaseId, failed: true }])
      expect(falseReadFailed.stored).toEqual(acknowledgedFalse.stored)
      expect(falseReadFailed.state.checked).toBe(false)
      expect(falseReadFailed.state.focused).toBe(true)
      expect(falseReadFailed.state.rowHeight).toBe(56)
      expect(falseReadFailed.state.source).toBe(sourceName)
      expect(falseReadFailed.state.view).toBe(viewName)
      expect(falseReadFailed.state.query).toBe('Original')
      expect(falseReadFailed.state.notes).toBe('Original Notes')
      expect(falseReadFailed.state.feedback.map(node => ({ role: node.role, text: node.text })))
        .toEqual([{ role: 'status', text: text.savedRefreshFailed }])
      expect(falseReadFailed.state.title).toBe(text.savedRefreshFailed)
      expect(falseReadFailed.state.description).toBe(falseReadFailed.state.feedback[0].id)
      expect(falseReadFailed.layout.input.ratio).toBe(1)
      expect(falseReadFailed.layout.actions).toHaveLength(1)
      expect(falseReadFailed.layout.actions[0].ratio).toBe(1)
      expect(falseReadFailed.state.centerHit).toBe(true)
      expect(falseReadFailed.state.actions).toHaveLength(1)
      expect(falseReadFailed.state.actions[0].centerHit).toBe(true)
      expect(falseReadFailed.state.actions[0].disabled).toBe(false)
      expect(falseReadFailed.state.actions[0].ariaDisabled).not.toBe('true')
      await expect(liveNotifications).toHaveCount(2)
      expect(falseReadFailed.state.visibleNotifications).toHaveLength(2)
      for (const node of [falseReadFailed.state, falseReadFailed.state.actions[0]]) {
        expect(node.notificationIntersections).toHaveLength(2)
        for (const intersection of node.notificationIntersections) expect(intersection.area).toBe(0)
      }
      await recoverByNativeInput(page, language, refresh)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(4)
      await expect(feedback).toHaveCount(0)
      await expect(refresh).toHaveCount(0)
      await expect(done).not.toBeChecked()
      const falseRefreshed = await record(page, app, info, language, done, before, language + '-pure-get-recovers-confirmed-false-without-replaying-either-write')
      expect(falseRefreshed.ipc.requests).toEqual(falseReadFailed.ipc.requests)
      expect(falseRefreshed.ipc.writes).toEqual([request, falseRequest])
      expect(falseRefreshed.ipc.failures).toEqual(rejectedFalse.ipc.failures)
      expect(falseRefreshed.ipc.reads).toEqual([...falseReadFailed.ipc.reads, { databaseId: ids.databaseId, failed: false }])
      expect(falseRefreshed.stored).toEqual(acknowledgedFalse.stored)
      await page.reload()
      await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
      await expect(done).not.toBeChecked()
      await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
      await expect(page.locator('.dbw-main-search input')).toHaveValue('Original')
      await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
      expect(await readStored(page, app, language)).toEqual(acknowledgedFalse.stored)
      const localeSave = { channel: 'knowbook:save-setting', input: ['ui.language', language] }
      await expect.poll(async () => (await mainState(app)).requests.filter(accepted => accepted.channel === localeSave.channel
        && accepted.input.length === 2 && accepted.input[0] === 'ui.language' && accepted.input[1] === language).length).toBe(1)
      await expect.poll(async () => (await mainState(app)).writes.filter(accepted => accepted.channel === localeSave.channel
        && accepted.input.length === 2 && accepted.input[0] === 'ui.language' && accepted.input[1] === language).length).toBe(1)
      expect(await page.evaluate(() => window.knowbook.getSetting('ui.language'))).toBe(language)
      const reloaded = await record(page, app, info, language, done, before, language + '-true-and-false-acknowledgements-preserve-all-other-data-after-reload')
      expect(reloaded.ipc.requests).toEqual([...falseReadFailed.ipc.requests, localeSave])
      expect(reloaded.ipc.writes).toEqual([...falseReadFailed.ipc.writes, localeSave])
      expect(reloaded.ipc.failures).toEqual(rejectedFalse.ipc.failures)
      expect(reloaded.ipc.writes.filter(accepted => accepted.channel === 'knowbook:update-database-entity')).toHaveLength(2)
      expect(reloaded.state.source).toBe(sourceName)
      expect(reloaded.state.view).toBe(viewName)
      expect(reloaded.state.query).toBe('Original')
      expect(reloaded.state.notes).toBe('Original Notes')
      expect(errors).toEqual([])

    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
