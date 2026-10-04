import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { CDPSession, ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Ids = { databaseId: string; entityId: string; dateId: string; notesId: string; viewId: string }
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Gate = { started: boolean; released: boolean; release?: () => void }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }>;
  reads: Array<{ databaseId: string; failed: boolean }>; diagnosticReads: boolean; gates: Gate[]; holdWrites: boolean;
  failNextRead: boolean; readGate?: Gate & { captured?: unknown } }
type ProbeGlobal = typeof globalThis & { __dateSaveProbe?: Probe }
type SchemaRow = { name: string; [key: string]: unknown }
type EntityRow = { id: string; updated_at: string; [key: string]: unknown }
type ValueRow = { entity_id: string; column_id: string; value_text: string | null; updated_at: string; [key: string]: unknown }
const sourceName = 'Date save source', recordTitle = 'Original date record', viewName = 'Original date table'
const originalDate = '2026-10-01', acceptedDate = '2026-10-02', retryDate = '2026-10-03'
const failureReason = 'Database Due update is temporarily unavailable.'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function prepare(page: Page, language: Language): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, sourceName, recordTitle, viewName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep original records, fields and view configuration.' })
    const date = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Due', type: 'date' })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [date.id]: '2026-10-01', [notes.id]: 'Original Notes' } })
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', date.id, notes.id], fieldOrder: ['__title__', date.id, notes.id],
      columnWidths: { __title__: 220, [date.id]: 160, [notes.id]: 160 }, cardFieldIds: [date.id, notes.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { databaseId: database.id, entityId: entity.id, dateId: date.id, notesId: notes.id, viewId: view.id }
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
    ;(globalThis as ProbeGlobal).__dateSaveProbe = probe
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
        // this is a temporary IPC reply fault, not a SQLite read failure.
        if (failed) throw new Error('E2E temporary database entities IPC reply failure.')
      }
      return result
    })
  }, ids)
}

async function mainState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__dateSaveProbe!
    return { requests: probe.requests, writes: probe.writes, failures: probe.failures, reads: probe.reads,
      readChannel: 'knowbook:get-database-entities', holdWrites: probe.holdWrites,
      gates: probe.gates.map(gate => ({ started: gate.started, released: gate.released })),
      readGate: probe.readGate ? { started: probe.readGate.started, released: probe.readGate.released, captured: probe.readGate.captured } : null }
  })
}

async function releaseWrite(app: ElectronApplication, index: number) {
  await app.evaluate(({}, index) => {
    const gate = (globalThis as ProbeGlobal).__dateSaveProbe!.gates[index]
    if (!gate?.started || gate.released || !gate.release) throw new Error('An unreleased genuine accepted write is required')
    gate.released = true
    gate.release()
  }, index)
}

async function armReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__dateSaveProbe!
    probe.failNextRead = true
    probe.readGate = { started: false, released: false }
  })
}

async function releaseReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as ProbeGlobal).__dateSaveProbe!.readGate
    if (!gate?.started || !gate.release) throw new Error('A genuine captured authenticated GET is required')
    gate.released = true
    gate.release()
  })
}

async function readStored(page: Page, app: ElectronApplication, language: Language) {
  // Evidence reads still delegate the real authenticated handler, but are
  // excluded from the UI refresh counter; no data or handler result is faked.
  await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__dateSaveProbe; if (probe) probe.diagnosticReads = true })
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
    await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__dateSaveProbe; if (probe) probe.diagnosticReads = false })
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

async function dateParts(page: Page, date: Locator, inputGeometry: Awaited<ReturnType<typeof geometry>>) {
  const session = await page.context().newCDPSession(page)
  try {
    const ax = await dateSegments(session), parts = []
    const clip = { left: Math.max(inputGeometry.clip.left, inputGeometry.bounds.left), top: Math.max(inputGeometry.clip.top, inputGeometry.bounds.top),
      right: Math.min(inputGeometry.clip.right, inputGeometry.bounds.right), bottom: Math.min(inputGeometry.clip.bottom, inputGeometry.bounds.bottom) }
    for (const control of ax.controls) {
      if (!control.backendDOMNodeId) throw new Error('A native date component must expose its actual DOM node for geometry')
      const { model } = await session.send('DOM.getBoxModel', { backendNodeId: control.backendDOMNodeId })
      const xs = model.border.filter((_, index) => index % 2 === 0), ys = model.border.filter((_, index) => index % 2 === 1)
      const bounds = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
      const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top
      const area = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left))
        * Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      const centerHit = await date.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element,
        { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 })
      parts.push({ ...control, bounds, width, height, clip, ratio: width > 0 && height > 0 ? area / (width * height) : 0, centerHit })
    }
    return parts
  } finally { await session.detach() }
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, date: Locator,
  before: Awaited<ReturnType<typeof readStored>>, phase: string, diagnostics?: unknown) {
  const state = await date.evaluate(element => {
    const input = element as HTMLInputElement, cell = input.closest('td')!, row = cell.closest('tr')!, bounds = input.getBoundingClientRect()
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    const visibleNotifications = Array.from(document.querySelectorAll<HTMLElement>('.app-notification-summary,.app-notification'))
      .filter(node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
        return node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
      }).map(node => ({ text: node.textContent, rect: node.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number } }))
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      view: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      notes: row.querySelector<HTMLInputElement>('.catalog-cell-input[aria-label="Notes"]')?.value,
      rowHeight: row.getBoundingClientRect().height, value: input.value, focused: document.activeElement === input,
      disabled: input.disabled, readOnly: input.readOnly, busy: input.getAttribute('aria-busy'), ariaDisabled: input.getAttribute('aria-disabled'),
      description: input.getAttribute('aria-describedby'), title: input.title, bounds: bounds.toJSON(), centerHit: hit === input,
      feedback: Array.from(cell.querySelectorAll('[role="alert"],[role="status"]')).map(node => ({ id: node.id, role: node.getAttribute('role'), text: node.textContent })),
      visibleNotifications,
      notificationIntersections: visibleNotifications.map(node => ({ text: node.text, area:
        Math.max(0, Math.min(bounds.right, node.rect.right) - Math.max(bounds.left, node.rect.left))
        * Math.max(0, Math.min(bounds.bottom, node.rect.bottom) - Math.max(bounds.top, node.rect.top)) })),
      actions: Array.from(cell.querySelectorAll('button')).map(button => {
        const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { text: button.textContent, label: button.getAttribute('aria-label'), disabled: button.disabled,
          busy: button.getAttribute('aria-busy'), ariaDisabled: button.getAttribute('aria-disabled'), description: button.getAttribute('aria-describedby'),
          bounds: rect.toJSON(), centerHit: hit === button || Boolean(hit && button.contains(hit)),
          notificationIntersections: visibleNotifications.map(node => ({ text: node.text, area:
            Math.max(0, Math.min(rect.right, node.rect.right) - Math.max(rect.left, node.rect.left))
            * Math.max(0, Math.min(rect.bottom, node.rect.bottom) - Math.max(rect.top, node.rect.top)) })) }
      }),
      active: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName,
        label: document.activeElement.getAttribute('aria-label'), text: document.activeElement.textContent } : null }
  })
  const inputGeometry = await geometry(date)
  const layout = { input: inputGeometry, parts: await dateParts(page, date, inputGeometry),
    actions: await Promise.all((await date.locator('xpath=ancestor::td').getByRole('button').all()).map(button => geometry(button))) }
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const ipc = await mainState(app), stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, state, layout, windows, ipc, before, stored, diagnostics }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(state.source).toBe(sourceName)
  expect(state.view).toBe(viewName)
  expect(state.query).toBe('Original')
  expect(state.notes).toBe('Original Notes')
  expect(state.rowHeight).toBe(64)
  return { state, layout, ipc, stored }
}

function expectOnlyDateSaved(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids, value: string | null) {
  const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  const fieldValues = { ...original.fieldValues }
  if (value === null) delete fieldValues[ids.dateId]
  else fieldValues[ids.dateId] = value
  expect(saved).toEqual({ ...original, fieldValues, updatedAt: saved.updatedAt })
  expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true)
  expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt))
  const dateRows = after.sql.values.filter(row => row.entity_id === ids.entityId && row.column_id === ids.dateId)
  if (value === null) expect(dateRows).toHaveLength(0)
  else { expect(dateRows).toHaveLength(1); expect(dateRows[0].value_text).toBe(value) }
  expect(after).toEqual({ ...before,
    sources: before.sources.map(source => source.id !== ids.databaseId ? source : {
      ...source, entities: source.entities.map(entity => entity.id === ids.entityId ? saved : entity)
    }),
    sql: { ...before.sql,
      entities: before.sql.entities.map(entity => entity.id === ids.entityId ? { ...entity, updated_at: saved.updatedAt } : entity),
      values: before.sql.values.filter(row => value !== null || row.entity_id !== ids.entityId || row.column_id !== ids.dateId)
        .map(row => row.entity_id === ids.entityId && row.column_id === ids.dateId ? { ...row, value_text: value, updated_at: saved.updatedAt } : row)
    }
  })
}

function dateRequest(ids: Ids, value: string | null): Request {
  const update: UpdateDatabaseEntityInput = { entityId: ids.entityId, fieldValues: { [ids.dateId]: value } }
  return { channel: 'knowbook:update-database-entity', input: [update] }
}

function expectRecoveryReachable(snapshot: Awaited<ReturnType<typeof record>>, label: string, notificationCount: number) {
  expect(snapshot.state.centerHit).toBe(true)
  expect(snapshot.layout.input.ratio).toBe(1)
  expect(snapshot.layout.parts.filter(part => part.role === 'spinbutton')).toHaveLength(3)
  expect(snapshot.layout.parts.filter(part => part.role === 'button')).toHaveLength(1)
  for (const part of snapshot.layout.parts) { expect(part.ratio).toBe(1); expect(part.centerHit).toBe(true) }
  expect(snapshot.state.actions).toHaveLength(1)
  expect(snapshot.state.actions[0].label).toBe(label)
  expect(snapshot.state.actions[0].centerHit).toBe(true)
  expect(snapshot.state.actions[0].bounds.height).toBe(32)
  expect(snapshot.state.actions[0].bounds.width).toBe(32)
  expect(snapshot.layout.actions[0].ratio).toBe(1)
  expect(snapshot.state.visibleNotifications).toHaveLength(notificationCount)
  for (const node of [snapshot.state, snapshot.state.actions[0]]) {
    expect(node.notificationIntersections).toHaveLength(notificationCount)
    for (const intersection of node.notificationIntersections) expect(intersection.area).toBe(0)
  }
  expect(snapshot.state.description).toBe(snapshot.state.feedback[0].id)
  expect(snapshot.state.actions[0].description).toBe(snapshot.state.feedback[0].id)
}

async function useRecovery(page: Page, language: Language, button: Locator) {
  if (language === 'en-US') await button.click()
  else {
    for (let step = 0; step < 5; step += 1) {
      if (await button.evaluate(element => document.activeElement === element)) break
      await page.keyboard.press('Tab')
    }
    await expect(button).toBeFocused()
    await page.keyboard.press('Enter')
  }
}

async function setWriteHold(app: ElectronApplication, hold: boolean) {
  await app.evaluate(({}, hold) => { (globalThis as ProbeGlobal).__dateSaveProbe!.holdWrites = hold }, hold)
}

async function installFailure(app: ElectronApplication, ids: Ids) {
  await app.evaluate(({ app }, { ids, retryDate, failureReason }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try { database.exec('CREATE TRIGGER knowbook_e2e_date_failure BEFORE INSERT ON database_entity_values ' +
      "WHEN NEW.entity_id = '" + ids.entityId.replace(/'/g, "''") + "' AND NEW.column_id = '" + ids.dateId.replace(/'/g, "''") +
      "' AND NEW.value_text = '" + retryDate + "' BEGIN SELECT RAISE(ABORT, '" + failureReason + "'); END") }
    finally { database.close() }
  }, { ids, retryDate, failureReason })
}

async function removeFailure(app: ElectronApplication) {
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try { database.exec('DROP TRIGGER knowbook_e2e_date_failure') } finally { database.close() }
  })
}

function withoutFailureTrigger(snapshot: Awaited<ReturnType<typeof readStored>>) {
  return { ...snapshot, sql: { ...snapshot.sql, schema: snapshot.sql.schema.filter(row => row.name !== 'knowbook_e2e_date_failure') } }
}

async function dateSegments(session: CDPSession) {
  const { root } = await session.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'tbody input[type="date"][aria-label="Due"]' })
  const { node } = await session.send('DOM.describeNode', { nodeId })
  const { nodes } = await session.send('Accessibility.getFullAXTree')
  const host = nodes.find(candidate => candidate.backendDOMNodeId === node.backendNodeId)
  const descendants = new Set<string>(), pending = host ? [host.nodeId] : []
  while (pending.length > 0) {
    const current = pending.shift()!
    if (descendants.has(current)) continue
    descendants.add(current)
    pending.push(...(nodes.find(candidate => candidate.nodeId === current)?.childIds ?? []))
  }
  return { hostFound: Boolean(host), host: host ? { role: host.role?.value, name: host.name?.value, properties: host.properties } : null,
    controls: nodes.filter(candidate => descendants.has(candidate.nodeId) && ['spinbutton', 'button'].includes(String(candidate.role?.value)))
      .map(candidate => ({ role: candidate.role?.value, name: candidate.name?.value, backendDOMNodeId: candidate.backendDOMNodeId })),
    segments: nodes.filter(candidate => descendants.has(candidate.nodeId) && candidate.role?.value === 'spinbutton')
      .map(candidate => ({ role: candidate.role?.value, name: candidate.name?.value, value: candidate.value?.value,
        focused: candidate.properties?.some(property => property.name === 'focused' && property.value.value === true) ?? false,
        properties: candidate.properties })),
    focusedNodes: nodes.filter(candidate => candidate.properties?.some(property => property.name === 'focused' && property.value.value === true))
      .map(candidate => ({ role: candidate.role?.value, name: candidate.name?.value, value: candidate.value?.value })) }
}

function focusedYear(snapshot: Awaited<ReturnType<typeof dateSegments>>) {
  return snapshot.segments.some(segment => segment.focused && /year|年/i.test(String(segment.name)))
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('a pending date keeps its accepted value and does not dispatch another native ArrowUp write in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(90_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language), before = await readStored(page, app, language), text = getDatabaseWorkspaceText(language)
      await installProbe(app, ids)
      const date = page.locator('tbody input[type="date"][aria-label="Due"]')
      await expect(date).toHaveValue(originalDate)
      await page.locator('tbody .catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(date).toBeFocused()
      await date.fill(acceptedDate)
      const draft = await record(page, app, info, language, date, before, language + '-complete-date-draft-has-no-ipc-before-enter')
      expect(draft.state.value).toBe(acceptedDate)
      expect(draft.ipc.requests).toHaveLength(0)
      expect(draft.ipc.writes).toHaveLength(0)
      expect(draft.stored).toEqual(before)
      // Date parts may be incomplete while typing: genuine Enter is now the
      // explicit complete-ISO submission boundary, preserving the old oracles.
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await mainState(app)).gates.length).toBe(1)
      await twoFrames(page)
      const first = await record(page, app, info, language, date, before, language + '-first-date-fill-accepted-before-real-sqlite-handler')
      const request = dateRequest(ids, acceptedDate)
      expect(first.ipc.requests).toEqual([request])
      expect(first.ipc.writes).toHaveLength(0)
      expect(first.ipc.failures).toHaveLength(0)
      expect(first.ipc.reads).toHaveLength(0)
      expect(first.stored).toEqual(before)
      await expect(date).toBeFocused()
      await page.keyboard.press('Enter')
      await page.keyboard.press('ArrowUp')
      await twoFrames(page)
      const repeated = await record(page, app, info, language, date, before, language + '-native-arrow-up-before-pending-date-and-singleflight-oracles')
      expect(repeated.stored).toEqual(before)
      expect(repeated.ipc.writes).toHaveLength(0)
      expect(repeated.ipc.failures).toHaveLength(0)
      expect(repeated.ipc.reads).toHaveLength(0)
      expect(first.state.value).toBe(acceptedDate)
      expect(repeated.state.value).toBe(acceptedDate)
      expect(repeated.ipc.requests).toEqual([request])
      expect(repeated.ipc.gates).toEqual([{ started: true, released: false }])
      expect(first.state.focused).toBe(true)
      expect(repeated.state.focused).toBe(true)
      expect(repeated.state.disabled).toBe(false)
      expect(repeated.state.readOnly).toBe(true)
      expect(repeated.state.busy).toBe('true')
      expect(repeated.state.feedback.map(node => ({ role: node.role, text: node.text }))).toEqual([{ role: 'status', text: text.saving }])
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })

  test('a genuinely saved date stays visible when its authenticated GET reply fails in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language), before = await readStored(page, app, language), text = getDatabaseWorkspaceText(language)
      await installProbe(app, ids)
      await armReadFailure(app)
      const date = page.locator('tbody input[type="date"][aria-label="Due"]'), cell = date.locator('xpath=ancestor::td')
      const feedback = cell.locator('[role="alert"],[role="status"]')
      const refresh = cell.getByRole('button', { name: text.refresh, exact: true }), retry = cell.getByRole('button', { name: text.retry, exact: true })
      const notifications = page.locator('.app-notification:visible')
      await expect(date).toHaveValue(originalDate)
      await page.locator('tbody .catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(date).toBeFocused()
      await date.fill(acceptedDate)
      const draft = await record(page, app, info, language, date, before, language + '-date-b-draft-awaits-explicit-enter')
      expect(draft.state.value).toBe(acceptedDate)
      expect(draft.ipc.requests).toHaveLength(0)
      expect(draft.stored).toEqual(before)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await mainState(app)).gates.length).toBe(1)
      await releaseWrite(app, 0)
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
      await expect.poll(async () => (await mainState(app)).readGate?.started).toBe(true)
      await expect(date).toHaveJSProperty('readOnly', false)
      const acknowledged = await record(page, app, info, language, date, before, language + '-genuine-date-ack-before-captured-get-reply')
      const request = dateRequest(ids, acceptedDate), retryRequest = dateRequest(ids, retryDate), clearRequest = dateRequest(ids, null)
      expect(acknowledged.ipc.requests).toEqual([request])
      expect(acknowledged.ipc.writes).toEqual([request])
      expect(acknowledged.ipc.failures).toHaveLength(0)
      expect(acknowledged.ipc.reads).toHaveLength(0)
      expect(acknowledged.ipc.readGate).toMatchObject({ started: true, released: false })
      expect(acknowledged.ipc.readGate?.captured).toEqual(acknowledged.stored.sources.find(source => source.id === ids.databaseId)!.entities)
      expectOnlyDateSaved(before, acknowledged.stored, ids, acceptedDate)
      await releaseReadFailure(app)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(1)
      await expect(feedback).toHaveText(text.savedRefreshFailed)
      await expect(notifications).toHaveCount(1)
      await twoFrames(page)
      const failedRead = await record(page, app, info, language, date, before, language + '-saved-date-after-real-authenticated-get-temporary-reply-failure')
      expect(failedRead.ipc.requests).toEqual([request])
      expect(failedRead.ipc.writes).toEqual([request])
      expect(failedRead.ipc.failures).toHaveLength(0)
      expect(failedRead.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true }])
      expect(failedRead.stored).toEqual(acknowledged.stored)
      expectOnlyDateSaved(before, failedRead.stored, ids, acceptedDate)
      expect(failedRead.state.value).toBe(acceptedDate)
      expect(failedRead.state.feedback.map(node => ({ role: node.role, text: node.text })))
        .toEqual([{ role: 'status', text: text.savedRefreshFailed }])
      expect(failedRead.state.actions.map(button => button.label)).toEqual([text.refresh])
      expectRecoveryReachable(failedRead, text.refresh, 1)
      await useRecovery(page, language, refresh)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(2)
      await expect(feedback).toHaveCount(0)
      await expect(refresh).toHaveCount(0)
      const refreshed = await record(page, app, info, language, date, before, language + '-pure-get-recovers-date-b-without-another-write')
      expect(refreshed.stored).toEqual(acknowledged.stored)
      expect(refreshed.ipc.requests).toEqual([request])
      expect(refreshed.ipc.writes).toEqual([request])
      expect(refreshed.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true }, { databaseId: ids.databaseId, failed: false }])
      await notifications.getByRole('button', { name: language === 'zh-CN' ? '关闭通知' : 'Dismiss notification', exact: true }).click()
      await expect(notifications).toHaveCount(0)
      await page.locator('tbody .catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(date).toBeFocused()
      await setWriteHold(app, false)
      await installFailure(app, ids)
      const failureReady = await readStored(page, app, language)
      expect(withoutFailureTrigger(failureReady)).toEqual(acknowledged.stored)
      expect(failureReady.sql.schema.filter(row => row.name === 'knowbook_e2e_date_failure')).toHaveLength(1)
      await date.fill(retryDate)
      const retryDraft = await record(page, app, info, language, date, before, language + '-date-c-draft-does-not-reach-the-real-sqlite-trigger')
      expect(retryDraft.state.value).toBe(retryDate)
      expect(retryDraft.ipc.requests).toEqual([request])
      expect(retryDraft.stored).toEqual(failureReady)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await mainState(app)).failures.length).toBe(1)
      await expect(feedback).toHaveAttribute('role', 'alert')
      await expect(feedback).toHaveText(text.dateSaveFailed)
      await expect(notifications).toHaveCount(1)
      const rejected = await record(page, app, info, language, date, before, language + '-real-sqlite-date-c-rejection-keeps-its-draft-and-previous-disk-value')
      expect(rejected.ipc.requests).toEqual([request, retryRequest])
      expect(rejected.ipc.writes).toEqual([request])
      expect(rejected.ipc.failures).toHaveLength(1)
      expect(rejected.ipc.failures[0]).toMatchObject(retryRequest)
      expect(rejected.ipc.failures[0].reason).toContain(failureReason)
      expect(rejected.ipc.reads).toEqual(refreshed.ipc.reads)
      expect(rejected.stored).toEqual(failureReady)
      expect(rejected.state.value).toBe(retryDate)
      expect(rejected.state.focused).toBe(true)
      expect(rejected.state.readOnly).toBe(false)
      expect(rejected.state.feedback.map(node => ({ role: node.role, text: node.text }))).toEqual([{ role: 'alert', text: text.dateSaveFailed }])
      expect(rejected.state.title).toBe(text.dateSaveFailed)
      expectRecoveryReachable(rejected, text.retry, 1)
      await removeFailure(app)
      expect(await readStored(page, app, language)).toEqual(acknowledged.stored)
      await setWriteHold(app, true)
      await armReadFailure(app)
      await useRecovery(page, language, retry)
      await expect.poll(async () => (await mainState(app)).gates.length).toBe(2)
      const pendingRetry = await record(page, app, info, language, date, before, language + '-explicit-retry-accepts-only-the-complete-date-c')
      expect(pendingRetry.ipc.requests).toEqual([request, retryRequest, retryRequest])
      expect(pendingRetry.ipc.writes).toEqual([request])
      expect(pendingRetry.stored).toEqual(acknowledged.stored)
      expect(pendingRetry.state.value).toBe(retryDate)
      expect(pendingRetry.state.readOnly).toBe(true)
      await releaseWrite(app, 1)
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(2)
      await expect.poll(async () => (await mainState(app)).readGate?.started).toBe(true)
      await expect(date).toHaveJSProperty('readOnly', false)
      const retryAcknowledged = await record(page, app, info, language, date, before, language + '-date-c-retry-ack-before-genuine-get-reply')
      expect(retryAcknowledged.ipc.writes).toEqual([request, retryRequest])
      expectOnlyDateSaved(before, retryAcknowledged.stored, ids, retryDate)
      expect(retryAcknowledged.ipc.readGate?.captured).toEqual(retryAcknowledged.stored.sources.find(source => source.id === ids.databaseId)!.entities)
      await releaseReadFailure(app)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(3)
      await expect(feedback).toHaveText(text.savedRefreshFailed)
      await expect(notifications).toHaveCount(2)
      await page.setViewportSize({ width: 980, height: 760 })
      await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations().length)).toBe(0)
      await twoFrames(page)
      const retryReadFailed = await record(page, app, info, language, date, before, language + '-date-parts-picker-and-refresh-stay-reachable-beside-two-real-notifications-at-980')
      expect(retryReadFailed.state.value).toBe(retryDate)
      expect(retryReadFailed.stored).toEqual(retryAcknowledged.stored)
      expect(retryReadFailed.ipc.requests).toEqual([request, retryRequest, retryRequest])
      expect(retryReadFailed.ipc.writes).toEqual([request, retryRequest])
      expect(retryReadFailed.ipc.failures).toEqual(rejected.ipc.failures)
      expect(retryReadFailed.ipc.reads).toEqual([...refreshed.ipc.reads, { databaseId: ids.databaseId, failed: true }])
      expect(retryReadFailed.state.feedback.map(node => ({ role: node.role, text: node.text }))).toEqual([{ role: 'status', text: text.savedRefreshFailed }])
      expectRecoveryReachable(retryReadFailed, text.refresh, 2)
      await useRecovery(page, language, refresh)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(4)
      await expect(feedback).toHaveCount(0)
      const retryRefreshed = await record(page, app, info, language, date, before, language + '-pure-get-recovers-date-c-without-replaying-retry')
      expect(retryRefreshed.stored).toEqual(retryAcknowledged.stored)
      expect(retryRefreshed.ipc.requests).toEqual(retryReadFailed.ipc.requests)
      expect(retryRefreshed.ipc.writes).toEqual([request, retryRequest])
      expect(retryRefreshed.ipc.reads).toEqual([...retryReadFailed.ipc.reads, { databaseId: ids.databaseId, failed: false }])
      await page.setViewportSize({ width: 1100, height: 760 })
      await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations().length)).toBe(0)
      await twoFrames(page)
      await page.locator('tbody .catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(date).toBeFocused()
      await date.fill('')
      const emptyDraft = await record(page, app, info, language, date, before, language + '-empty-date-is-a-draft-before-explicit-null-save')
      expect(emptyDraft.state.value).toBe('')
      expect(emptyDraft.ipc.requests).toEqual(retryReadFailed.ipc.requests)
      expect(emptyDraft.stored).toEqual(retryAcknowledged.stored)
      await armReadFailure(app)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await mainState(app)).gates.length).toBe(3)
      await releaseWrite(app, 2)
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(3)
      await expect.poll(async () => (await mainState(app)).readGate?.started).toBe(true)
      const cleared = await record(page, app, info, language, date, before, language + '-genuine-null-ack-removes-only-the-date-value-row')
      expect(cleared.ipc.requests).toEqual([request, retryRequest, retryRequest, clearRequest])
      expect(cleared.ipc.writes).toEqual([request, retryRequest, clearRequest])
      expect(cleared.ipc.failures).toEqual(rejected.ipc.failures)
      expectOnlyDateSaved(before, cleared.stored, ids, null)
      expect(cleared.state.value).toBe('')
      expect(cleared.ipc.readGate?.captured).toEqual(cleared.stored.sources.find(source => source.id === ids.databaseId)!.entities)
      await releaseReadFailure(app)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(5)
      await expect(feedback).toHaveText(text.savedRefreshFailed)
      const clearedReadFailed = await record(page, app, info, language, date, before, language + '-saved-null-survives-another-authenticated-get-reply-fault')
      expect(clearedReadFailed.state.value).toBe('')
      expect(clearedReadFailed.stored).toEqual(cleared.stored)
      expect(clearedReadFailed.ipc.writes).toEqual([request, retryRequest, clearRequest])
      expect(clearedReadFailed.ipc.reads).toEqual([...retryRefreshed.ipc.reads, { databaseId: ids.databaseId, failed: true }])
      await useRecovery(page, language, refresh)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(6)
      await expect(feedback).toHaveCount(0)
      await expect(refresh).toHaveCount(0)
      const clearRefreshed = await record(page, app, info, language, date, before, language + '-pure-get-recovers-null-with-no-fourth-entity-write')
      expect(clearRefreshed.stored).toEqual(cleared.stored)
      expect(clearRefreshed.ipc.requests).toEqual(cleared.ipc.requests)
      expect(clearRefreshed.ipc.writes).toEqual(cleared.ipc.writes)
      expect(clearRefreshed.ipc.failures).toEqual(rejected.ipc.failures)
      expect(clearRefreshed.ipc.reads).toEqual([...clearedReadFailed.ipc.reads, { databaseId: ids.databaseId, failed: false }])
      await page.reload()
      await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
      await expect(date).toHaveValue('')
      await expect(page.locator('.dbw-main-search input')).toHaveValue('Original')
      const localeSave = { channel: 'knowbook:save-setting', input: ['ui.language', language] }
      await expect.poll(async () => (await mainState(app)).writes.filter(item => item.channel === localeSave.channel
        && item.input.length === 2 && item.input[0] === 'ui.language' && item.input[1] === language).length).toBe(1)
      expect(await page.evaluate(() => window.knowbook.getSetting('ui.language'))).toBe(language)
      const reloaded = await record(page, app, info, language, date, before, language + '-date-null-reload-preserves-all-other-data-and-only-saves-locale-once')
      expect(reloaded.stored).toEqual(cleared.stored)
      expect(reloaded.ipc.requests).toEqual([...cleared.ipc.requests, localeSave])
      expect(reloaded.ipc.writes).toEqual([...cleared.ipc.writes, localeSave])
      expect(reloaded.ipc.failures).toEqual(rejected.ipc.failures)
      expect(reloaded.ipc.writes.filter(item => item.channel === 'knowbook:update-database-entity')).toHaveLength(3)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('diagnoses actual native date year-segment typing in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(90_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language), before = await readStored(page, app, language)
      await installProbe(app, ids)
      const date = page.locator('tbody input[type="date"][aria-label="Due"]')
      await page.locator('tbody .catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(date).toBeFocused()
      const session = await page.context().newCDPSession(page)
      try {
        await session.send('Accessibility.enable')
        const navigation: Array<{ key: string; ax: Awaited<ReturnType<typeof dateSegments>> }> = []
        let ax = await dateSegments(session)
        navigation.push({ key: 'Shift+Tab from Notes', ax })
        // Native reverse Tab traverses Chromium's picker and date segments;
        // the actual AX year focus is required before genuine numeric typing.
        for (let step = 0; step < 5 && !focusedYear(ax); step += 1) {
          await page.keyboard.press('Shift+Tab')
          ax = await dateSegments(session)
          navigation.push({ key: 'Shift+Tab within date', ax })
          if (!await date.evaluate(element => document.activeElement === element)) break
        }
        await record(page, app, info, language, date, before, language + '-year-diagnostic-native-segment-navigation', { navigation, yearFocused: focusedYear(ax) })
        expect(focusedYear(ax), 'Actual AX focus must prove the year segment before typing').toBe(true)
        for (const [index, key] of ['2', '0', '2', '7'].entries()) {
          await page.keyboard.press(key)
          await expect(date).toBeFocused()
          ax = await dateSegments(session)
          const observed = await record(page, app, info, language, date, before, language + '-year-diagnostic-key-' + (index + 1) + '-' + key,
            { key, keyIndex: index + 1, ax })
          expect(observed.state.focused).toBe(true)
          expect(observed.ipc.requests).toHaveLength(0)
          expect(observed.ipc.writes).toHaveLength(0)
          expect(observed.ipc.failures).toHaveLength(0)
          expect(observed.ipc.reads).toHaveLength(0)
          expect(observed.stored).toEqual(before)
        }
        const completeDate = '2027-10-01', request = dateRequest(ids, completeDate)
        await expect(date).toHaveValue(completeDate)
        await page.keyboard.press('Enter')
        await expect.poll(async () => (await mainState(app)).gates.length).toBe(1)
        const pending = await record(page, app, info, language, date, before, language + '-complete-native-year-enters-one-authenticated-write')
        expect(pending.state.value).toBe(completeDate)
        expect(pending.state.focused).toBe(true)
        expect(pending.state.readOnly).toBe(true)
        expect(pending.ipc.requests).toEqual([request])
        expect(pending.ipc.writes).toHaveLength(0)
        expect(pending.stored).toEqual(before)
        await releaseWrite(app, 0)
        await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
        await expect.poll(async () => (await mainState(app)).reads.length).toBe(1)
        await expect(date).toHaveValue(completeDate)
        await expect(date).toHaveJSProperty('readOnly', false)
        await expect(date.locator('xpath=ancestor::td').locator('[role="status"],[role="alert"]')).toHaveCount(0)
        const saved = await record(page, app, info, language, date, before, language + '-complete-native-year-is-persisted-once-with-all-other-data-kept')
        expect(saved.ipc.requests).toEqual([request])
        expect(saved.ipc.writes).toEqual([request])
        expect(saved.ipc.failures).toHaveLength(0)
        expect(saved.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: false }])
        expectOnlyDateSaved(before, saved.stored, ids, completeDate)
        await page.reload()
        await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
        await expect(date).toHaveValue(completeDate)
        const localeSave = { channel: 'knowbook:save-setting', input: ['ui.language', language] }
        await expect.poll(async () => (await mainState(app)).writes.filter(item => item.channel === localeSave.channel
          && item.input.length === 2 && item.input[0] === 'ui.language' && item.input[1] === language).length).toBe(1)
        expect(await page.evaluate(() => window.knowbook.getSetting('ui.language'))).toBe(language)
        const reloaded = await record(page, app, info, language, date, before, language + '-actual-native-2027-year-survives-reload-with-only-locale-bootstrap')
        expect(reloaded.stored).toEqual(saved.stored)
        expect(reloaded.ipc.requests).toEqual([request, localeSave])
        expect(reloaded.ipc.writes).toEqual([request, localeSave])
        expect(reloaded.ipc.failures).toHaveLength(0)
        expect(errors).toEqual([])
      } finally { await session.detach() }
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
