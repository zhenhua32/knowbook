import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1 } from '../src/shared/contracts'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type SqlColumn = { id: string; name: string; updated_at: string; [key: string]: unknown }
type RenameProbe = { requests: { channel: string; input: unknown[] }[]; writes: number; held: boolean; released: boolean; release?: () => void }
type ProbeGlobal = typeof globalThis & { __fieldRenameAttention?: RenameProbe }
const sourceName = 'Field attention source'
const viewName = 'Original field attention table'
const renamedName = 'Notes renamed once'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function prepare(page: Page, language: Language) {
  const ids = await page.evaluate(async ({ language, sourceName, viewName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Preserve the original field values and view configuration.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Original attention record', fieldValues: { [field.id]: 'Original Notes' } })
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original', filters: { operator: 'and', rules: [] }, sorts: [],
      groupBy: { fieldId: null }, visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { databaseId: database.id, fieldId: field.id, entityId: entity.id, viewId: view.id }
  }, { language, sourceName, viewName })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', viewName)
  await expect(page.locator('.dbw-main-search input')).toHaveValue('Original')
  await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
  return ids
}

async function installProbe(app: ElectronApplication, page: Page) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: RenameProbe = { requests: [], writes: 0, held: false, released: false }
    ;(globalThis as ProbeGlobal).__fieldRenameAttention = probe
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        probe.requests.push({ channel, input: structuredClone(input) })
        const result = await original(event, ...input)
        if (channel === 'knowbook:rename-document-database-column') {
          probe.writes += 1
          probe.held = true
          await new Promise<void>(resolve => { probe.release = resolve })
          probe.released = true
        }
        return result
      })
    }
  })
  await page.evaluate(() => {
    const calls: unknown[] = []
    ;(window as unknown as { __fieldAttentionFocus?: unknown[] }).__fieldAttentionFocus = calls
    const original = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (...args) {
      if (this.matches('.dbw-field-name, .dbw-field-copy > input')) calls.push({ kind: 'focus', tag: this.tagName,
        label: this.getAttribute('aria-label'), text: this.textContent, args })
      return original.apply(this, args)
    }
    document.addEventListener('focusin', event => {
      if (event.target instanceof HTMLElement && event.target.matches('.dbw-field-name, .dbw-field-copy > input')) {
        calls.push({ kind: 'focusin', tag: event.target.tagName, label: event.target.getAttribute('aria-label'), text: event.target.textContent })
      }
    }, true)
  })
}

async function mainState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__fieldRenameAttention!
    return { requests: probe.requests, writes: probe.writes, held: probe.held, released: probe.released }
  })
}

async function readStored(page: Page, app: ElectronApplication, language: Language) {
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
    try {
      return { schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        columns: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all() as SqlColumn[],
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        entityValues: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all() }
    } finally { database.close() }
  })
  return { ...api, sql }
}

function onlyRenamed(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, fieldId: string) {
  const expected = structuredClone(before)
  for (const source of expected.sources) for (const field of source.fields) if (field.id === fieldId) field.name = renamedName
  const previousColumn = before.sql.columns.find(column => column.id === fieldId)!
  const actualColumn = after.sql.columns.find(column => column.id === fieldId)!
  expect(actualColumn.name).toBe(renamedName)
  expect(Number.isFinite(Date.parse(actualColumn.updated_at))).toBe(true)
  expect(Date.parse(actualColumn.updated_at)).toBeGreaterThanOrEqual(Date.parse(previousColumn.updated_at))
  const expectedColumn = expected.sql.columns.find(column => column.id === fieldId)!
  expectedColumn.name = renamedName
  expectedColumn.updated_at = actualColumn.updated_at
  expect(after).toEqual(expected)
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string,
  before: Awaited<ReturnType<typeof readStored>>) {
  const state = await page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>('.dbw-field-drawer'), active = document.activeElement
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      drawerFocused: active === drawer, drawerBusy: drawer?.getAttribute('aria-busy'),
      active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className, label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 160) } : null,
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'), query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      activeView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      fieldNames: Array.from(document.querySelectorAll('.dbw-field-name')).map(button => button.textContent),
      editors: Array.from(document.querySelectorAll<HTMLInputElement>('.dbw-field-copy > input')).map(input => ({ label: input.getAttribute('aria-label'), value: input.value, disabled: input.disabled })),
      enabledControls: Array.from(drawer?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]') ?? [])
        .filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0)
        .map(element => ({ tag: element.tagName, label: element.getAttribute('aria-label'), text: element.textContent })),
      focus: (window as unknown as { __fieldAttentionFocus?: unknown[] }).__fieldAttentionFocus ?? [] }
  })
  const mutation = await mainState(app)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const stored = await readStored(page, app, language)
  const path = info.outputPath(language + '-' + phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, state, mutation, windows, before, stored }, null, 2))
  await info.attach(language + '-' + phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(language + '-' + phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { state, mutation, stored }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('Field rename completion preserves intervening native Tab attention in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(90_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language)
      const before = await readStored(page, app, language)
      await installProbe(app, page)
      await page.locator('.dbw-toolbar > .dbw-toolbar-button').click()
      const drawer = page.locator('.dbw-field-drawer')
      await expect(drawer.getByRole('button', { name: language === 'zh-CN' ? '关闭' : 'Close', exact: true })).toBeFocused()
      await drawer.getByRole('button', { name: 'Notes', exact: true }).click()
      const input = drawer.getByRole('textbox', { name: (language === 'zh-CN' ? '名称' : 'Name') + ' · Notes', exact: true })
      await expect(input).toBeFocused()
      await input.fill(renamedName)
      await page.keyboard.press('Enter')
      await expect.poll(() => mainState(app).then(state => state.held && state.writes === 1)).toBe(true)
      await expect(drawer).toHaveAttribute('aria-busy', 'true')
      await expect(input).toBeDisabled()
      await page.keyboard.press('Tab')
      await expect(drawer).toBeFocused()
      const pending = await record(page, app, info, language, 'real-mutation-held-native-tab-aside-before-release', before)
      expect(pending.state.enabledControls).toEqual([])
      expect(pending.mutation.requests).toEqual([{ channel: 'knowbook:rename-document-database-column', input: [{ columnId: ids.fieldId, name: renamedName }] }])
      expect(pending.mutation.writes).toBe(1)
      expect(pending.mutation.released).toBe(false)
      onlyRenamed(before, pending.stored, ids.fieldId)

      await app.evaluate(() => (globalThis as ProbeGlobal).__fieldRenameAttention!.release!())
      await expect(drawer).not.toHaveAttribute('aria-busy', 'true')
      await expect(drawer.getByRole('button', { name: renamedName, exact: true })).toBeVisible()
      await twoFrames(page)
      const completed = await record(page, app, info, language, 'completed-after-new-tab-owner-before-focus-oracle', before)
      expect(completed.mutation.requests).toEqual(pending.mutation.requests)
      expect(completed.mutation.writes).toBe(1)
      expect(completed.mutation.released).toBe(true)
      onlyRenamed(before, completed.stored, ids.fieldId)
      expect(completed.state.source).toBe(sourceName)
      expect(completed.state.activeView).toBe(viewName)
      expect(completed.state.query).toBe('Original')
      expect(completed.state.drawerFocused).toBe(true)
      expect(completed.state.focus).toEqual(pending.state.focus)
      await expect(drawer).toBeFocused()
      // Preserving the deliberate aside owner must still allow ordinary
      // keyboard navigation once the real mutation and refresh have finished.
      await page.keyboard.press('Tab')
      const close = drawer.getByRole('button', { name: language === 'zh-CN' ? '关闭' : 'Close', exact: true })
      await expect(close).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(drawer).toHaveCount(0)
      await expect(page.locator('.dbw-toolbar > .dbw-toolbar-button')).toBeFocused()
      const closed = await record(page, app, info, language, 'new-aside-owner-naturally-tabs-to-close-and-returns-fields', before)
      expect(closed.mutation.requests).toEqual(pending.mutation.requests)
      expect(closed.mutation.writes).toBe(1)
      onlyRenamed(before, closed.stored, ids.fieldId)
      expect(closed.state.source).toBe(sourceName)
      expect(closed.state.activeView).toBe(viewName)
      expect(closed.state.query).toBe('Original')
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('Uninterrupted native Enter rename returns once to the saved field name in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(90_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language)
      const before = await readStored(page, app, language)
      await installProbe(app, page)
      await page.locator('.dbw-toolbar > .dbw-toolbar-button').click()
      const drawer = page.locator('.dbw-field-drawer')
      await expect(drawer.getByRole('button', { name: language === 'zh-CN' ? '关闭' : 'Close', exact: true })).toBeFocused()
      await drawer.getByRole('button', { name: 'Notes', exact: true }).click()
      const input = drawer.getByRole('textbox', { name: (language === 'zh-CN' ? '名称' : 'Name') + ' · Notes', exact: true })
      await expect(input).toBeFocused()
      await input.fill(renamedName)
      await page.keyboard.press('Enter')
      await expect.poll(() => mainState(app).then(state => state.held && state.writes === 1)).toBe(true)
      await expect(drawer).toHaveAttribute('aria-busy', 'true')
      await expect(input).toBeDisabled()
      // No pending key, pointer or focus operation: this is the independent
      // positive control for the same genuine mutation and delayed reply.
      const pending = await record(page, app, info, language, 'uninterrupted-real-enter-mutation-held-before-normal-return', before)
      expect(pending.state.enabledControls).toEqual([])
      expect(pending.mutation.requests).toEqual([{ channel: 'knowbook:rename-document-database-column', input: [{ columnId: ids.fieldId, name: renamedName }] }])
      expect(pending.mutation.writes).toBe(1)
      expect(pending.mutation.released).toBe(false)
      onlyRenamed(before, pending.stored, ids.fieldId)
      await app.evaluate(() => (globalThis as ProbeGlobal).__fieldRenameAttention!.release!())
      await expect(drawer).not.toHaveAttribute('aria-busy', 'true')
      const savedButton = drawer.getByRole('button', { name: renamedName, exact: true })
      await expect(savedButton).toBeVisible()
      await twoFrames(page)
      const completed = await record(page, app, info, language, 'uninterrupted-completion-before-exact-saved-name-return-oracle', before)
      expect(completed.mutation.requests).toEqual(pending.mutation.requests)
      expect(completed.mutation.writes).toBe(1)
      expect(completed.mutation.released).toBe(true)
      onlyRenamed(before, completed.stored, ids.fieldId)
      expect(completed.state.source).toBe(sourceName)
      expect(completed.state.activeView).toBe(viewName)
      expect(completed.state.query).toBe('Original')
      await expect(savedButton).toBeFocused()
      expect(completed.state.active).toEqual({ tag: 'BUTTON', className: 'dbw-field-name', label: null, text: renamedName })
      expect(completed.state.focus.slice(pending.state.focus.length)).toEqual([
        { kind: 'focus', tag: 'BUTTON', label: null, text: renamedName, args: [{ preventScroll: true }] },
        { kind: 'focusin', tag: 'BUTTON', label: null, text: renamedName }
      ])
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
