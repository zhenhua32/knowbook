import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1 } from '../src/shared/contracts'
import { DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type ProbeGlobal = typeof globalThis & { __newViewScopeWrites?: WriteRequest[] }
type SavedViewRow = { id: string; database_id: string; name: string; config_json: string; created_at: string; updated_at: string; [key: string]: unknown }
const sourceName = 'New view shortcut source'
const viewName = 'Original new view table'
const recordTitle = 'Original selected new view record'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, reverse = false, maximum = 6) {
  const steps: unknown[] = []
  for (let step = 0; step < maximum; step += 1) {
    const state = await target.evaluate(element => ({ focused: document.activeElement === element,
      active: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName,
        className: document.activeElement.className, label: document.activeElement.getAttribute('aria-label'), text: document.activeElement.textContent?.slice(0, 120) } : null }))
    steps.push({ step, direction: reverse ? 'Shift+Tab' : 'Tab', ...state })
    if (state.focused) return steps
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
  }
  await expect(target).toBeFocused()
  return steps
}

async function readContext(page: Page) {
  return page.evaluate(() => ({
    source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
    view: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
    query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
    notes: document.querySelector<HTMLInputElement>('tbody .catalog-cell-input[aria-label="Notes"]')?.value,
    selected: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent),
    checked: Array.from(document.querySelectorAll<HTMLInputElement>('tbody .dbw-select-column input[type="checkbox"]')).filter(input => input.checked).length,
    menuOpen: document.querySelector<HTMLDetailsElement>('.dbw-new-view-menu')?.open,
    confirms: document.querySelectorAll('.app-confirm-dialog').length,
    forms: document.querySelectorAll('.dbw-form-dialog, .dbw-create-record-dialog').length,
    sourcePickers: document.querySelectorAll('.dbw-source-picker').length
  }))
}

async function installFocusProbe(page: Page) {
  await page.evaluate(() => {
    const calls: unknown[] = []
    ;(window as unknown as { __newViewScopeFocus: unknown[] }).__newViewScopeFocus = calls
    const original = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<HTMLElement['focus']>) {
      calls.push({ kind: 'focus', tag: this.tagName, className: this.className,
        label: this.getAttribute('aria-label'), text: this.textContent?.slice(0, 120), args })
      return original.apply(this, args)
    }
    document.addEventListener('focusin', event => {
      if (!(event.target instanceof HTMLElement)) return
      calls.push({ kind: 'focusin', tag: event.target.tagName, className: event.target.className,
        label: event.target.getAttribute('aria-label'), text: event.target.textContent?.slice(0, 120) })
    }, true)
  })
}

async function readFocusProbe(page: Page) {
  return page.evaluate(() => (window as unknown as { __newViewScopeFocus: unknown[] }).__newViewScopeFocus)
}

function expectUnchanged(result: Awaited<ReturnType<typeof record>>, before: Awaited<ReturnType<typeof readStored>>) {
  expect(result.writes).toEqual([])
  expect(result.stored).toEqual(before)
  expect(result.state.source).toBe(sourceName)
  expect(result.state.activeView).toBe(viewName)
  expect(result.state.query).toBe('Original')
  expect(result.state.notes).toBe('Original Notes')
  expect(result.state.selectedTitles).toEqual([recordTitle])
}

async function prepare(page: Page, language: Language) {
  const ids = await page.evaluate(async ({ language, sourceName, viewName, recordTitle }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Preserve selected records while choosing a view layout.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle, fieldValues: { [field.id]: 'Original Notes' } })
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original', filters: { operator: 'and', rules: [] }, sorts: [],
      groupBy: { fieldId: null }, visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { databaseId: database.id, fieldId: field.id, entityId: entity.id, viewId: view.id }
  }, { language, sourceName, viewName, recordTitle })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', viewName)
  await expect(page.locator('.dbw-main-search input')).toHaveValue('Original')
  await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
  return ids
}

async function installWriteProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const writes: WriteRequest[] = []
    ;(globalThis as ProbeGlobal).__newViewScopeWrites = writes
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        writes.push({ channel, input: structuredClone(input) })
        return original(event, ...input)
      })
    }
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
        views: database.prepare('SELECT * FROM database_saved_views ORDER BY id').all() as SavedViewRow[],
        columns: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        entityValues: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all() }
    } finally { database.close() }
  })
  return { ...api, sql }
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, beforeOwner: unknown,
  before: Awaited<ReturnType<typeof readStored>>, phase = language + '-real-table-owner-delete-before-no-record-confirm-oracle') {
  const state = await page.evaluate(() => {
    const menu = document.querySelector<HTMLDetailsElement>('.dbw-new-view-menu')
    const confirm = document.querySelector<HTMLDialogElement>('.app-confirm-dialog'), active = document.activeElement
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      activeView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      notes: document.querySelector<HTMLInputElement>('tbody .catalog-cell-input[aria-label="Notes"]')?.value,
      selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent),
      menuOpen: menu?.open, menuControls: Array.from(menu?.querySelectorAll('button') ?? []).map(button => ({ text: button.textContent, focused: button === active })),
      confirmCount: document.querySelectorAll('.app-confirm-dialog').length,
      confirm: confirm ? { role: confirm.getAttribute('role'), open: confirm.open, heading: confirm.querySelector('h2')?.textContent,
        body: confirm.querySelector('.app-confirm-body')?.textContent, buttons: Array.from(confirm.querySelectorAll('button')).map(button => button.textContent) } : null,
      form: document.querySelector('.dbw-form-dialog') ? { heading: document.querySelector('.dbw-form-dialog h2')?.textContent,
        name: document.querySelector<HTMLInputElement>('.dbw-form-dialog .dbw-form-body input')?.value } : null,
      focusProbe: (window as unknown as { __newViewScopeFocus?: unknown[] }).__newViewScopeFocus ?? [],
      active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className, label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 160) } : null }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const writes = await app.evaluate(() => (globalThis as ProbeGlobal).__newViewScopeWrites ?? [])
  const stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, beforeOwner, state, windows, writes, before, stored }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { state, writes, stored }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('New view layout choice owns Delete rather than selected-record deletion in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(150_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language)
      const before = await readStored(page, app, language)
      await installWriteProbe(app)
      const row = page.locator('tbody > tr').filter({ hasText: recordTitle })
      const checkbox = row.locator('.dbw-select-column input[type="checkbox"]')
      await checkbox.check()
      await expect(checkbox).toBeChecked()
      await expect(row).toHaveClass(/is-selected/)
      // Pointer establishes the already active view; only real Tab and Enter
      // open New view and choose its Table focus owner. No click dispatch.
      await page.getByTitle(viewName, { exact: true }).click()
      const summary = page.locator('.dbw-new-view-menu > summary')
      await tabTo(page, summary)
      await expect(summary).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.locator('.dbw-new-view-menu')).toHaveAttribute('open', '')
      await page.keyboard.press('Tab')
      const table = page.locator('.dbw-layout-menu').getByRole('button', { name: language === 'zh-CN' ? '表格' : 'Table', exact: true })
      await expect(table).toBeFocused()
      const beforeOwner = await table.evaluate(element => ({ focused: document.activeElement === element, tag: element.tagName,
        text: element.textContent, menuOpen: element.closest('details')?.open,
        selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent) }))
      await page.keyboard.press('Delete')
      await twoFrames(page)
      const result = await record(page, app, info, language, beforeOwner, before)
      expect(result.writes).toEqual([])
      expect(result.stored).toEqual(before)
      expect(result.stored.sources.find(source => source.id === ids.databaseId)?.entities.map(entity => entity.id)).toEqual([ids.entityId])
      expect(result.state.source).toBe(sourceName)
      expect(result.state.activeView).toBe(viewName)
      expect(result.state.query).toBe('Original')
      expect(result.state.notes).toBe('Original Notes')
      expect(result.state.selectedTitles).toEqual([recordTitle])
      expect(result.state.confirmCount).toBe(0)
      await expect(table).toBeFocused()
      expect(result.state.menuOpen).toBe(true)
      expect(errors).toEqual([])

      await installFocusProbe(page)
      const board = page.locator('.dbw-layout-menu').getByRole('button', { name: language === 'zh-CN' ? '看板' : 'Board', exact: true })
      const cards = page.locator('.dbw-layout-menu').getByRole('button', { name: language === 'zh-CN' ? '卡片' : 'Cards', exact: true })
      const query = page.locator('.dbw-main-search input')
      const source = page.locator('.dbw-source-trigger')
      const activeView = page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')
      const keys = ['/', 'Control+Shift+L', 'Control+Shift+V', 'Delete'] as const
      const steps: unknown[] = []
      const scopedContext = await readContext(page)
      for (const [name, owner] of [['summary', summary], ['table', table], ['board', board], ['cards', cards]] as const) {
        steps.push({ owner: name, tabs: await tabTo(page, owner, name === 'summary', 24) })
        const observations: unknown[] = []
        for (const key of keys) {
          const focusBefore = await readFocusProbe(page)
          await page.keyboard.press(key)
          await twoFrames(page)
          observations.push({ key, context: await readContext(page), focusBefore, focusAfter: await readFocusProbe(page) })
          await expect(owner).toBeFocused()
          expect(await readContext(page)).toEqual(scopedContext)
          expect(await readFocusProbe(page)).toEqual(focusBefore)
        }
        const scoped = await record(page, app, info, language, { steps, observations }, before, language + '-open-' + name + '-owns-four-canvas-keys')
        expectUnchanged(scoped, before)
        expect(scoped.state.menuOpen).toBe(true)
        expect(scoped.state.confirmCount).toBe(0)
      }

      const canvasObservations: unknown[] = []
      // Closed summary is a normal canvas control. Leaving open details must
      // dismiss the menu while keeping outside canvas shortcuts available.
      for (const mode of ['closed-summary', 'outside-menu-dismissal'] as const) {
        steps.push({ mode, tabs: await tabTo(page, summary, true, 24) })
        await page.keyboard.press('Enter')
        await expect(page.locator('.dbw-new-view-menu')).toHaveJSProperty('open', mode !== 'closed-summary')
        const owner = mode === 'closed-summary' ? summary : activeView
        for (const key of keys) {
          // Ctrl+Shift+L leaves focus before the tabs; / and confirmation
          // Cancel leave it after the tabs. Follow that actual DOM direction.
          const fromSource = await source.evaluate(element => document.activeElement === element)
          steps.push({ mode, key, tabs: await tabTo(page, owner, !fromSource, 24) })
          await expect(owner).toBeFocused()
          await expect(page.locator('.dbw-new-view-menu')).toHaveJSProperty('open', false)
          const contextBefore = await readContext(page)
          await page.keyboard.press(key)
          await twoFrames(page)
          if (key === '/') await expect(query).toBeFocused()
          else if (key === 'Control+Shift+L') await expect(source).toBeFocused()
          else if (key === 'Control+Shift+V') await expect(summary).toBeFocused()
          else {
            const danger = await record(page, app, info, language, { mode, contextBefore, steps }, before,
              language + '-' + mode + '-delete-still-opens-record-confirm')
            expectUnchanged(danger, before)
            expect(danger.state.confirmCount).toBe(1)
            expect(danger.state.confirm?.heading).toContain(language === 'zh-CN' ? '删除记录' : 'Delete record')
            expect(danger.state.confirm?.body).toContain(language === 'zh-CN' ? '已选 1 条' : '1 selected')
            const cancel = page.locator('.app-confirm-dialog').getByRole('button', { name: language === 'zh-CN' ? '取消' : 'Cancel', exact: true })
            await expect(cancel).toBeFocused()
            await page.keyboard.press('Enter')
            await expect(page.locator('.app-confirm-dialog')).toHaveCount(0)
            await expect(query).toBeFocused()
          }
          await twoFrames(page)
          expect(await readContext(page)).toEqual(contextBefore)
          canvasObservations.push({ mode, key, context: await readContext(page), focus: await readFocusProbe(page) })
        }
        const canvas = await record(page, app, info, language, { steps, observations: canvasObservations }, before,
          language + '-' + mode + '-keeps-canvas-shortcuts')
        expectUnchanged(canvas, before)
        expect(canvas.state.menuOpen).toBe(false)
        expect(canvas.state.confirmCount).toBe(0)
      }

      const form = page.locator('.dbw-form-dialog')
      for (const [layout, item] of [['table', table], ['board', board], ['cards', cards]] as const) {
        const fromSource = await source.evaluate(element => document.activeElement === element)
        steps.push({ layout, tabs: await tabTo(page, summary, !fromSource, 24) })
        if (!(await page.locator('.dbw-new-view-menu').evaluate(element => (element as HTMLDetailsElement).open))) {
          await page.keyboard.press('Enter')
        }
        steps.push({ layout, tabs: await tabTo(page, item, false, 24) })
        await page.keyboard.press('Enter')
        await expect(page.getByRole('dialog', { name: language === 'zh-CN' ? '新建视图' : 'New view', exact: true })).toBeVisible()
        const name = form.getByLabel(language === 'zh-CN' ? '名称' : 'Name', { exact: true })
        await expect(name).toBeFocused()
        const label = layout === 'table' ? (language === 'zh-CN' ? '表格' : 'Table')
          : layout === 'board' ? (language === 'zh-CN' ? '看板' : 'Board') : (language === 'zh-CN' ? '卡片' : 'Cards')
        await expect(name).toHaveValue(label + ' 2')
        const cancel = form.getByRole('button', { name: language === 'zh-CN' ? '取消' : 'Cancel', exact: true })
        steps.push({ layout, tabs: await tabTo(page, cancel, false, 6) })
        await page.keyboard.press('Enter')
        await expect(form).toHaveCount(0)
        await expect(summary).toBeFocused()
        const cancelled = await record(page, app, info, language, { layout, steps }, before,
          language + '-real-' + layout + '-create-form-cancel-returns-summary')
        expectUnchanged(cancelled, before)
        expect(cancelled.state.menuOpen).toBe(false)
        expect(cancelled.state.confirmCount).toBe(0)
      }

      const originalSource = before.sources.find(item => item.id === ids.databaseId)!
      const expectedCreatedConfig = originalSource.views.find(view => view.id === ids.viewId)!.config
      expect(expectedCreatedConfig.sorts).toEqual([{ fieldId: DATABASE_SYSTEM_FIELD_IDS.updatedAt, direction: 'desc' }])
      await page.keyboard.press('Enter')
      await expect(page.locator('.dbw-new-view-menu')).toHaveAttribute('open', '')
      await page.keyboard.press('Tab')
      await expect(table).toBeFocused()
      await page.keyboard.press('Enter')
      const name = form.getByLabel(language === 'zh-CN' ? '名称' : 'Name', { exact: true })
      await expect(name).toBeFocused()
      const createdName = 'Created through real New view'
      await name.fill(createdName)
      // Ordinary Name Enter submits the real typed create-form API once.
      await page.keyboard.press('Enter')
      await expect(form).toHaveCount(0)
      await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', createdName)
      await expect(summary).toBeFocused()
      await expect(query).toHaveValue('Original')
      await expect(row.locator('.catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
      const created = await record(page, app, info, language, { createdName, steps }, before,
        language + '-real-table-create-ack-persists-only-new-saved-view')
      expect(created.writes).toHaveLength(1)
      expect(created.writes[0]).toEqual({ channel: 'knowbook:create-database-saved-view-form',
        input: [expect.objectContaining({ databaseId: ids.databaseId, name: createdName, config: expectedCreatedConfig })] })
      const targetSource = created.stored.sources.find(item => item.id === ids.databaseId)!
      const newViews = targetSource.views.filter(view => !originalSource.views.some(original => original.id === view.id))
      expect(newViews).toHaveLength(1)
      const newView = newViews[0]
      expect(newView.name).toBe(createdName)
      expect(newView.databaseId).toBe(ids.databaseId)
      expect(newView.config).toEqual(expectedCreatedConfig)
      const newRows = created.stored.sql.views.filter(view => !before.sql.views.some(original => original.id === view.id))
      expect(newRows).toHaveLength(1)
      expect(newRows[0].id).toBe(newView.id)
      expect(newRows[0].database_id).toBe(ids.databaseId)
      expect(newRows[0].name).toBe(createdName)
      expect(JSON.parse(newRows[0].config_json)).toEqual(expectedCreatedConfig)
      expect(newRows[0].created_at).toBe(newView.createdAt)
      expect(newRows[0].updated_at).toBe(newView.updatedAt)
      expect(Number.isFinite(Date.parse(newRows[0].created_at))).toBe(true)
      expect(Number.isFinite(Date.parse(newRows[0].updated_at))).toBe(true)
      // Remove only the observed new ID from this comparison, retaining every
      // old row, metadata field, timestamp, document and SQLite schema entry.
      expect({ ...created.stored,
        sources: created.stored.sources.map(item => item.id !== ids.databaseId ? item : { ...item, views: item.views.filter(view => view.id !== newView.id) }),
        sql: { ...created.stored.sql, views: created.stored.sql.views.filter(view => view.id !== newView.id) }
      }).toEqual(before)
      expect(created.state.source).toBe(sourceName)
      expect(created.state.activeView).toBe(createdName)
      expect(created.state.query).toBe('Original')
      expect(created.state.notes).toBe('Original Notes')
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
