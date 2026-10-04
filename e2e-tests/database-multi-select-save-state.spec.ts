import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Ids = { databaseId: string; entityId: string; tagsId: string; notesId: string; viewId: string }
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Gate = { started: boolean; released: boolean; release?: () => void }
type Probe = { databaseId: string; requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }>;
  reads: Array<{ databaseId: string; failed: boolean }>; diagnosticReads: boolean; failNextRead: boolean;
  gate?: Gate; readGate?: Gate & { captured?: unknown } }
type ProbeGlobal = typeof globalThis & { __multiSelectSaveProbe?: Probe }
type SchemaRow = { name: string; [key: string]: unknown }
type EntityRow = { id: string; updated_at: string; [key: string]: unknown }
type ValueRow = { entity_id: string; column_id: string; value_text: string | null; updated_at: string; [key: string]: unknown }
const sourceName = 'Multi-select save source'
const recordTitle = 'Original multi-select record'
const viewName = 'Original multi-select table'
const failureReason = 'Database Tags update is temporarily unavailable.'

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
    const tags = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Tags', type: 'multi-select', options: ['Blue', 'Red', 'Green'] })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [tags.id]: ['Blue'], [notes.id]: 'Original Notes' } })
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', tags.id, notes.id], fieldOrder: ['__title__', tags.id, notes.id],
      columnWidths: { __title__: 220, [tags.id]: 160, [notes.id]: 160 }, cardFieldIds: [tags.id, notes.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { databaseId: database.id, entityId: entity.id, tagsId: tags.id, notesId: notes.id, viewId: view.id }
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
      database.exec('CREATE TRIGGER knowbook_e2e_multi_select_failure BEFORE INSERT ON database_entity_values ' +
        `WHEN NEW.entity_id = '${ids.entityId.replace(/'/g, "''")}' AND NEW.column_id = '${ids.tagsId.replace(/'/g, "''")}' ` +
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
    try { database.exec('DROP TRIGGER knowbook_e2e_multi_select_failure') } finally { database.close() }
  })
}

async function installWriteProbe(app: ElectronApplication, ids: Ids) {
  await app.evaluate(({ ipcMain }, ids) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { databaseId: ids.databaseId, requests: [], writes: [], failures: [], reads: [], diagnosticReads: false, failNextRead: false }
    ;(globalThis as ProbeGlobal).__multiSelectSaveProbe = probe
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
    const probe = (globalThis as ProbeGlobal).__multiSelectSaveProbe!
    return { databaseId: probe.databaseId, readChannel: 'knowbook:get-database-entities', requests: probe.requests, writes: probe.writes, failures: probe.failures, reads: probe.reads,
      failNextRead: probe.failNextRead, gate: probe.gate ? { started: probe.gate.started, released: probe.gate.released } : null,
      readGate: probe.readGate ? { started: probe.readGate.started, released: probe.readGate.released, captured: probe.readGate.captured } : null }
  })
}

async function armWriteAndReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__multiSelectSaveProbe!
    probe.gate = { started: false, released: false }
    probe.readGate = { started: false, released: false }
    probe.failNextRead = true
  })
}

async function releaseWrite(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as ProbeGlobal).__multiSelectSaveProbe!.gate
    if (!gate?.started || !gate.release) throw new Error('A genuine pending write is required')
    gate.released = true
    gate.release()
  })
}

async function releaseReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as ProbeGlobal).__multiSelectSaveProbe!.readGate
    if (!gate?.started || !gate.release) throw new Error('A genuine captured entities read is required')
    gate.released = true
    gate.release()
  })
}

async function readStored(page: Page, app: ElectronApplication, language: Language) {
  // Evidence reads still delegate the real authenticated handler, but are
  // excluded from the UI refresh counter and its one-shot reply fault.
  await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__multiSelectSaveProbe; if (probe) probe.diagnosticReads = true })
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
    await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__multiSelectSaveProbe; if (probe) probe.diagnosticReads = false })
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

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, tabs: unknown[], before: Awaited<ReturnType<typeof readStored>>,
  phase = language + '-real-tags-write-rejected-before-rollback-oracle') {
  const state = await page.locator('tbody .dbw-multi-editor').evaluate(element => {
    const details = element as HTMLDetailsElement, row = details.closest('tr')!, summary = details.querySelector('summary')!, menu = details.querySelector('.dbw-multi-editor-menu')!
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
      menuOpen: details.open, summary: summary.textContent, summaryTitle: summary.title,
      rowHeight: row.getBoundingClientRect().height,
      choices: Array.from(menu.querySelectorAll('label')).map(label => ({ name: label.textContent, checked: label.querySelector('input')?.checked,
        disabled: label.querySelector('input')?.disabled, focused: label.querySelector('input') === document.activeElement,
        busy: label.querySelector('input')?.getAttribute('aria-busy'), ariaDisabled: label.querySelector('input')?.getAttribute('aria-disabled'),
        description: label.querySelector('input')?.getAttribute('aria-describedby') })),
      menuRect: menu.getBoundingClientRect().toJSON(), visibleNotifications,
      feedback: Array.from(details.closest('td')!.querySelectorAll('[role="alert"],[role="status"]')).map(node => {
        const rect = node.getBoundingClientRect()
        return { id: node.id, text: node.textContent, role: node.getAttribute('role'), rect: rect.toJSON(),
          notificationIntersections: visibleNotifications.map(notification => ({ text: notification.text,
            area: Math.max(0, Math.min(rect.right, notification.rect.right) - Math.max(rect.left, notification.rect.left))
              * Math.max(0, Math.min(rect.bottom, notification.rect.bottom) - Math.max(rect.top, notification.rect.top)) })) }
      }),
      actions: Array.from(details.closest('td')!.querySelectorAll('button')).map(button => {
        const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { text: button.textContent, disabled: button.disabled, busy: button.getAttribute('aria-busy'),
          ariaDisabled: button.getAttribute('aria-disabled'), focused: button === document.activeElement, rect: rect.toJSON(),
          centerHit: hit === button || Boolean(hit && button.contains(hit)),
          hitElement: hit instanceof HTMLElement ? { tag: hit.tagName, className: hit.className, text: hit.textContent } : null,
          notificationIntersections: visibleNotifications.map(notification => ({ text: notification.text,
            area: Math.max(0, Math.min(rect.right, notification.rect.right) - Math.max(rect.left, notification.rect.left))
              * Math.max(0, Math.min(rect.bottom, notification.rect.bottom) - Math.max(rect.top, notification.rect.top)) })) }
      }),
      active: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName,
        text: document.activeElement.textContent, label: document.activeElement.getAttribute('aria-label') } : null,
      notifications: Array.from(document.querySelectorAll('.app-notification-summary,.app-notification')).map(node => node.textContent) }
  })
  const menu = page.locator('tbody .dbw-multi-editor-menu')
  const layout = { menu: await geometry(menu),
    feedback: await Promise.all((await menu.locator('.dbw-multi-feedback').all()).map(node => geometry(node))),
    actions: await Promise.all((await menu.getByRole('button').all()).map(node => geometry(node))) }
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const ipc = await mainState(app), stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, tabs, state, layout, windows, ipc, before, stored }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { state, layout, ipc, stored }
}

function withoutFailureTrigger(before: Awaited<ReturnType<typeof readStored>>) {
  return { ...before, sql: { ...before.sql, schema: before.sql.schema.filter(row => row.name !== 'knowbook_e2e_multi_select_failure') } }
}

function expectOnlyTagsSaved(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids, tags: string[]) {
  const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.tagsId]: tags }, updatedAt: saved.updatedAt })
  expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt))
  expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true)
  const expected = withoutFailureTrigger(before)
  expect(after).toEqual({ ...expected,
    sources: expected.sources.map(source => source.id !== ids.databaseId ? source : {
      ...source, entities: source.entities.map(entity => entity.id === ids.entityId ? saved : entity)
    }),
    sql: { ...expected.sql,
      entities: expected.sql.entities.map(entity => entity.id === ids.entityId ? { ...entity, updated_at: saved.updatedAt } : entity),
      values: expected.sql.values.map(value => value.entity_id === ids.entityId && value.column_id === ids.tagsId
        ? { ...value, value_text: JSON.stringify(tags), updated_at: saved.updatedAt } : value)
    }
  })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('failed multi-select write rolls back the visible choice in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language)
      const text = getDatabaseWorkspaceText(language)
      await installFailure(app, ids)
      // Include the real fixture trigger in both schema snapshots.
      const before = await readStored(page, app, language)
      await installWriteProbe(app, ids)
      const details = page.locator('tbody .dbw-multi-editor'), summary = details.locator('summary')
      const feedback = details.locator('.dbw-multi-feedback')
      await expect(summary).toHaveText('Blue')
      await summary.click()
      await expect(details).toHaveJSProperty('open', true)
      const blue = details.getByRole('checkbox', { name: 'Blue', exact: true })
      const red = details.getByRole('checkbox', { name: 'Red', exact: true })
      await expect(blue).toBeChecked()
      await expect(red).not.toBeChecked()
      const tabs = await tabTo(page, red)
      await expect(red).toBeFocused()
      await page.keyboard.press('Space')
      await expect.poll(async () => (await mainState(app)).failures.length).toBe(1)
      await expect(feedback).toHaveAttribute('role', 'alert')
      await expect(feedback).toHaveText(text.multiSelectSaveFailed)
      await expect(page.locator('.app-notifications')).toContainText(text.multiSelectSaveFailed)
      await twoFrames(page)
      const result = await record(page, app, info, language, tabs, before)
      const update: UpdateDatabaseEntityInput = { entityId: ids.entityId, fieldValues: { [ids.tagsId]: ['Blue', 'Red'] } }
      expect(result.ipc.requests).toEqual([{ channel: 'knowbook:update-database-entity', input: [update] }])
      expect(result.ipc.failures).toHaveLength(1)
      expect(result.ipc.failures[0].reason).toContain(failureReason)
      expect(result.ipc.writes).toHaveLength(0)
      expect(result.stored).toEqual(before)
      expect(result.state.source).toBe(sourceName)
      expect(result.state.view).toBe(viewName)
      expect(result.state.query).toBe('Original')
      expect(result.state.notes).toBe('Original Notes')
      expect(result.state.menuOpen).toBe(true)
      expect(errors).toEqual([])
      // First business oracle: rejected persistence cannot remain selected.
      expect(result.state.choices.find(choice => choice.name === 'Red')?.checked).toBe(false)
      expect(result.state.summary).toBe('Blue')
      expect(result.state.summaryTitle).toBe('Blue')
      await expect(blue).toBeChecked()
      await expect(red).not.toBeChecked()
      await expect(red).toBeFocused()
      expect(result.state.choices.find(choice => choice.name === 'Red')?.focused).toBe(true)
      expect(result.state.feedback.map(node => ({ id: node.id, text: node.text, role: node.role })))
        .toEqual([{ id: result.state.feedback[0].id, text: text.multiSelectSaveFailed, role: 'alert' }])
      await expect(red).toHaveAttribute('aria-describedby', result.state.feedback[0].id)
      await expect(summary).toHaveAttribute('aria-describedby', result.state.feedback[0].id)

      await removeFailure(app)
      const readyToRetry = await readStored(page, app, language)
      expect(readyToRetry).toEqual(withoutFailureTrigger(before))
      await armWriteAndReadFailure(app)
      // Refocusing by native Tab does not retry; only a new Space choice does.
      await page.keyboard.press('Shift+Tab')
      await expect(blue).toBeFocused()
      tabs.push(...await tabTo(page, red))
      await page.keyboard.press('Space')
      await expect.poll(async () => (await mainState(app)).requests.length).toBe(2)
      await expect.poll(async () => (await mainState(app)).gate?.started).toBe(true)
      await expect(red).toHaveAttribute('aria-disabled', 'true')
      await expect(red).toHaveAttribute('aria-busy', 'true')
      await expect(red).toHaveJSProperty('disabled', false)
      await expect(red).toBeFocused()
      await expect(feedback).toHaveAttribute('role', 'status')
      await expect(feedback).toHaveText(text.saving)
      await page.keyboard.press('Space')
      await twoFrames(page)
      const saving = await record(page, app, info, language, tabs, before, language + '-native-repeat-space-cannot-duplicate-pending-tags-write')
      expect(saving.ipc.requests).toEqual([result.ipc.requests[0], result.ipc.requests[0]])
      expect(saving.ipc.writes).toHaveLength(0)
      expect(saving.ipc.failures).toHaveLength(1)
      expect(saving.ipc.reads).toHaveLength(0)
      expect(saving.stored).toEqual(readyToRetry)
      expect(saving.state.menuOpen).toBe(true)
      expect(saving.state.choices.find(choice => choice.name === 'Red')).toMatchObject({ checked: true, disabled: false, focused: true, busy: 'true', ariaDisabled: 'true' })
      expect(saving.state.feedback[0].text).toBe(text.saving)

      await releaseWrite(app)
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
      await expect.poll(async () => (await mainState(app)).readGate?.started).toBe(true)
      await expect(summary).toHaveText('Blue · Red')
      await expect(red).toBeChecked()
      await expect(red).not.toHaveAttribute('aria-disabled', 'true')
      await expect(red).toHaveJSProperty('disabled', false)
      await expect(red).toBeFocused()
      await expect(feedback).toHaveAttribute('role', 'status')
      await expect(feedback).toHaveText(text.cellRefreshing)
      const acknowledged = await record(page, app, info, language, tabs, before, language + '-real-tags-ack-unlocks-choices-before-captured-read-reply')
      expect(acknowledged.ipc.requests).toHaveLength(2)
      expect(acknowledged.ipc.writes).toEqual([result.ipc.requests[0]])
      expect(acknowledged.ipc.failures).toEqual(result.ipc.failures)
      expect(acknowledged.ipc.reads).toHaveLength(0)
      expect(acknowledged.ipc.readGate).toMatchObject({ started: true, released: false })
      expect(acknowledged.ipc.readGate?.captured).toEqual(acknowledged.stored.sources.find(source => source.id === ids.databaseId)!.entities)
      expectOnlyTagsSaved(before, acknowledged.stored, ids, ['Blue', 'Red'])
      await releaseReadFailure(app)
      await expect.poll(async () => (await mainState(app)).reads.filter(read => read.failed).length).toBe(1)
      await expect(feedback).toHaveAttribute('role', 'status')
      await expect(feedback).toHaveText(text.savedRefreshFailed)
      await expect(summary).toHaveText('Blue · Red')
      await expect(red).toBeChecked()
      await expect(red).toBeEnabled()
      await expect(red).not.toHaveAttribute('aria-disabled', 'true')
      await expect(red).toBeFocused()
      const refresh = details.getByRole('button', { name: text.refresh, exact: true })
      await expect(refresh).toBeVisible()
      const liveNotifications = page.locator('.app-notification:visible,.app-notification-summary:visible')
      await expect(liveNotifications).toHaveCount(2)
      await twoFrames(page)
      const savedReadFailed = await record(page, app, info, language, tabs, before, language + '-genuine-tags-ack-remains-saved-after-temporary-ipc-read-fault')
      expect(savedReadFailed.ipc.requests).toHaveLength(2)
      expect(savedReadFailed.ipc.writes).toEqual([result.ipc.requests[0]])
      expect(savedReadFailed.ipc.failures).toEqual(result.ipc.failures)
      expect(savedReadFailed.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true }])
      expect(savedReadFailed.ipc.failNextRead).toBe(false)
      expectOnlyTagsSaved(before, savedReadFailed.stored, ids, ['Blue', 'Red'])
      expect(savedReadFailed.state.feedback[0].text).toBe(text.savedRefreshFailed)
      expect(savedReadFailed.state.feedback[0].text).not.toMatch(/SqliteError|Error invoking remote method|E2E temporary/)
      expect(savedReadFailed.state.source).toBe(sourceName)
      expect(savedReadFailed.state.view).toBe(viewName)
      expect(savedReadFailed.state.query).toBe('Original')
      expect(savedReadFailed.state.notes).toBe('Original Notes')
      await expect(liveNotifications).toHaveCount(2)
      expect(savedReadFailed.state.visibleNotifications).toHaveLength(2)
      const refreshGeometry = savedReadFailed.state.actions.find(action => action.text?.trim() === text.refresh)
      expect(refreshGeometry).toBeDefined()
      expect(savedReadFailed.layout.menu.ratio).toBe(1)
      expect(savedReadFailed.layout.feedback).toHaveLength(1)
      expect(savedReadFailed.layout.feedback[0].ratio).toBe(1)
      expect(savedReadFailed.layout.actions).toHaveLength(1)
      expect(savedReadFailed.layout.actions[0].ratio).toBe(1)
      expect(refreshGeometry!.disabled).toBe(false)
      expect(refreshGeometry!.ariaDisabled).not.toBe('true')
      for (const node of [...savedReadFailed.state.feedback, refreshGeometry!]) {
        expect(node.notificationIntersections).toHaveLength(2)
        for (const intersection of node.notificationIntersections) expect(intersection.area).toBe(0)
      }
      // Both real error toasts stay present. The recovery action must still
      // receive a normal pointer at its actual center, without clearing them.
      expect(refreshGeometry!.centerHit).toBe(true)

      if (language === 'en-US') await refresh.click()
      else {
        tabs.push(...await tabTo(page, refresh))
        await page.keyboard.press('Enter')
      }
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(2)
      await expect(feedback).toHaveCount(0)
      await expect(refresh).toHaveCount(0)
      await expect(summary).toHaveText('Blue · Red')
      await expect(details).toHaveJSProperty('open', true)
      await twoFrames(page)
      const refreshed = await record(page, app, info, language, tabs, before, language + '-native-refresh-recovers-without-replaying-the-tags-write')
      expect(refreshed.ipc.requests).toEqual(savedReadFailed.ipc.requests)
      expect(refreshed.ipc.writes).toEqual(savedReadFailed.ipc.writes)
      expect(refreshed.ipc.failures).toEqual(savedReadFailed.ipc.failures)
      expect(refreshed.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true }, { databaseId: ids.databaseId, failed: false }])
      expect(refreshed.stored).toEqual(savedReadFailed.stored)
      expect(refreshed.state.feedback).toHaveLength(0)
      expect(refreshed.state.choices.find(choice => choice.name === 'Green')?.checked).toBe(false)

      await page.reload()
      await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
      await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
      await expect(summary).toHaveText('Blue · Red')
      await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
      await expect(page.locator('.dbw-main-search input')).toHaveValue('Original')
      expect(await readStored(page, app, language)).toEqual(savedReadFailed.stored)
      // Reload hydrates ui.language and persists that exact setting once.
      // Keep every IPC in the final comparison, including this bootstrap write.
      const localeSave = { channel: 'knowbook:save-setting', input: ['ui.language', language] }
      await expect.poll(async () => (await mainState(app)).requests.filter(request => request.channel === localeSave.channel
        && request.input.length === 2 && request.input[0] === 'ui.language' && request.input[1] === language).length).toBe(1)
      await expect.poll(async () => (await mainState(app)).writes.filter(request => request.channel === localeSave.channel
        && request.input.length === 2 && request.input[0] === 'ui.language' && request.input[1] === language).length).toBe(1)
      expect(await page.evaluate(() => window.knowbook.getSetting('ui.language'))).toBe(language)
      const reloaded = await record(page, app, info, language, tabs, before, language + '-only-the-acknowledged-tags-change-survives-reload')
      expect(reloaded.ipc.requests).toEqual([...savedReadFailed.ipc.requests, localeSave])
      expect(reloaded.ipc.writes).toEqual([...savedReadFailed.ipc.writes, localeSave])
      expect(reloaded.ipc.failures).toEqual(savedReadFailed.ipc.failures)
      expect(reloaded.ipc.writes.filter(request => request.channel === 'knowbook:update-database-entity')).toHaveLength(1)
      expect(reloaded.state.query).toBe('Original')
      expect(reloaded.state.view).toBe(viewName)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
