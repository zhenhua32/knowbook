import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1 } from '../src/shared/contracts'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __newViewDismissalProbe?: Probe }
const sourceName = 'New view dismissal source'
const viewName = 'Original dismissal table'
const recordTitle = 'Original selected dismissal record'
async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let step = 0; step < 256; step++) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
  }
  await expect(target).toBeFocused()
}

async function prepare(page: Page, language: Language) {
  await page.evaluate(async ({ language, sourceName, viewName, recordTitle }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep records and saved view metadata.' })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const hidden = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Hidden', type: 'text' })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [notes.id]: 'Original Notes', [hidden.id]: 'Original hidden metadata' } })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Hidden neighboring record',
      fieldValues: { [notes.id]: 'Neighboring Notes', [hidden.id]: 'Keep neighbor metadata' } })
    const fields = ['__title__', notes.id]
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original',
      filters: { operator: 'and', rules: [{ id: 'original-filter', fieldId: notes.id, operator: 'contains', value: 'Original' }] },
      sorts: [{ fieldId: notes.id, direction: 'asc' }], groupBy: { fieldId: null }, visibleFieldIds: fields, fieldOrder: [...fields, hidden.id],
      columnWidths: {}, cardFieldIds: [notes.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
  }, { language, sourceName, viewName, recordTitle })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(1)
  await page.locator('tbody .dbw-select-column input').click()
  await expect(page.locator('tbody .dbw-select-column input')).toBeChecked()
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__newViewDismissalProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        const request = { channel, input: structuredClone(input) }
        probe.requests.push(request)
        try { const result = await original(event, ...input); probe.writes.push(request); return result }
        catch (error) { probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) }); throw error }
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
    try { return {
      schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
      columns: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all(),
      entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
      values: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
      documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all(),
      views: database.prepare('SELECT * FROM database_saved_views ORDER BY id').all()
    } } finally { database.close() }
  })
  return { ...api, sql }
}


async function installObservations(page: Page) {
  await page.evaluate(() => {
    const observations = { focus: [] as unknown[], keys: [] as unknown[] }
    ;(window as unknown as { __dismissalObservations: typeof observations }).__dismissalObservations = observations
    const describe = (element: Element | null) => element instanceof HTMLElement
      ? { tag: element.tagName, className: element.className, label: element.getAttribute('aria-label'), text: element.textContent?.slice(0, 120) } : null
    const original = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (...args: Parameters<HTMLElement['focus']>) {
      observations.focus.push(describe(this))
      return original.apply(this, args)
    }
    // Capture the event, then inspect it on the next frame after React and
    // document bubbling have completed, including stopped owned Escape events.
    document.addEventListener('keydown', event => {
      const target = describe(event.target instanceof Element ? event.target : null)
      requestAnimationFrame(() => observations.keys.push({ key: event.key, defaultPrevented: event.defaultPrevented,
        target, active: describe(document.activeElement) }))
    }, true)
  })
}

async function observations(page: Page) {
  return page.evaluate(() => (window as unknown as { __dismissalObservations: {
    focus: unknown[]; keys: Array<{ key: string; defaultPrevented: boolean }>
  } }).__dismissalObservations)
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language,
  firstOwner: 'summary' | 'layout', before: Awaited<ReturnType<typeof readStored>>, phase: string, expectedQuery = 'Original') {
  const state = await page.evaluate(() => {
    const details = document.querySelector<HTMLDetailsElement>('.dbw-new-view-menu')!, active = document.activeElement
    const summary = details.querySelector('summary')!, popup = details.querySelector<HTMLElement>('.dbw-layout-menu')!
    const rectangle = (element: Element) => { const box = element.getBoundingClientRect(); return {
      left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } }
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      activeView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      notes: document.querySelector<HTMLInputElement>('tbody .catalog-cell-input[aria-label="Notes"]')?.value,
      selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent),
      checkedCount: Array.from(document.querySelectorAll<HTMLInputElement>('tbody .dbw-select-column input')).filter(input => input.checked).length,
      menuOpen: details.open, actionsCount: document.querySelectorAll('.dbw-view-actions-menu').length,
      confirmCount: document.querySelectorAll('.app-confirm-dialog').length,
      formCount: document.querySelectorAll('.dbw-form-dialog, .dbw-create-record-dialog').length,
      dirty: document.querySelector('.dbw-unsaved-dot') !== null,
      active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className,
        label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 120), summary: active === summary } : null,
      geometry: { summary: rectangle(summary), popup: rectangle(popup) },
      controls: Array.from(details.querySelectorAll('summary, button')).map(element => ({
        tag: element.tagName, text: element.textContent, focused: element === active })) }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const probe = await app.evaluate(() => (globalThis as ProbeGlobal).__newViewDismissalProbe!)
  const stored = await readStored(page, app, language)
  const result = { phase, language, firstOwner, state, windows, probe, observations: await observations(page), before, stored }
  const path = info.outputPath(language + '-' + firstOwner + '-' + phase + '.json')
  writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(language + '-' + firstOwner + '-' + phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(probe).toEqual({ requests: [], writes: [], failures: [] })
  expect(stored).toEqual(before)
  expect(state.source).toBe(sourceName)
  expect(state.activeView).toBe(viewName)
  expect(state.query).toBe(expectedQuery)
  expect(state.notes).toBe('Original Notes')
  expect(state.selectedTitles).toEqual([recordTitle])
  expect(state.checkedCount).toBe(1)
  expect(state.confirmCount).toBe(0)
  expect(state.formCount).toBe(0)
  return result
}

for (const language of ['en-US', 'zh-CN'] as const) for (const firstOwner of ['summary', 'layout'] as const) {
  test('New view ' + firstOwner + ' dismisses without stealing focus or losing drafts in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(180_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await prepare(page, language)
      await installProbe(app)
      await installObservations(page)
      const before = await readStored(page, app, language), text = getDatabaseWorkspaceText(language)
      const menu = page.locator('.dbw-new-view-menu'), summary = menu.locator('summary'), popup = menu.locator('.dbw-layout-menu')
      const table = popup.getByRole('button', { name: text.table, exact: true })
      const board = popup.getByRole('button', { name: text.board, exact: true })
      const cards = popup.getByRole('button', { name: text.cards, exact: true })
      const query = page.locator('.dbw-main-search input')
      const actions = page.locator('.dbw-view-tab-wrap.is-active .dbw-view-tab-menu')
      const open = async () => {
        if (!(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await summary.click()
        await expect(menu).toHaveJSProperty('open', true)
        await expect(popup).toBeVisible()
        await twoFrames(page)
      }
      await open()
      await expect(summary).toBeFocused()
      if (firstOwner === 'layout') {
        await page.keyboard.press('Tab')
        await expect(table).toBeFocused()
      }
      expect((await observations(page)).focus).toEqual([])
      await page.keyboard.press('Escape')
      await twoFrames(page)
      const initial = await record(page, app, info, language, firstOwner, before, 'first-escape-before-dismissal-business-oracle')
      expect(initial.state.menuOpen, 'Ordinary Escape must dismiss the actual open New view details').toBe(false)
      await expect(summary).toBeFocused()
      expect(initial.observations.focus.length).toBe(firstOwner === 'layout' ? 1 : 0)
      expect(initial.observations.keys.at(-1)?.defaultPrevented).toBe(true)
      expect(initial.state.dirty).toBe(false)

      await page.keyboard.press('Enter')
      await expect(menu).toHaveJSProperty('open', true)
      await tabTo(page, table)
      const imeFocus = (await observations(page)).focus.length
      await table.dispatchEvent('compositionstart', { data: '文' })
      await page.keyboard.press('Escape')
      await twoFrames(page)
      await expect(menu).toHaveJSProperty('open', true)
      await expect(table).toBeFocused()
      expect((await observations(page)).focus.length).toBe(imeFocus)
      expect((await observations(page)).keys.at(-1)?.defaultPrevented).toBe(false)
      await table.dispatchEvent('compositionend', { data: '文' })
      await page.keyboard.press('Escape')
      await twoFrames(page)
      await expect(menu).toHaveJSProperty('open', false)
      await expect(summary).toBeFocused()
      const ime = await record(page, app, info, language, firstOwner, before, 'ime-escape-retains-owner-ordinary-escape-returns-summary')
      expect(ime.observations.focus.length).toBe(imeFocus + 1)
      expect(ime.observations.keys.at(-1)?.defaultPrevented).toBe(true)

      await open()
      await tabTo(page, table)
      const blankFocus = (await observations(page)).focus.length
      const box = await popup.boundingBox()
      expect(box).not.toBeNull()
      // Actual pointer on the non-focusable padding, away from every layout
      // button: Chromium blurs the layout owner to BODY without focusin.
      await popup.click({ position: { x: 3, y: Math.floor(box!.height / 2) } })
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
      await expect(menu).toHaveJSProperty('open', true)
      // An explicit renderer fixture supplies a visible foreign modal without
      // synthesizing focus or opening any native window. BODY cannot own its key.
      await page.evaluate(() => {
        const modal = document.createElement('div')
        modal.id = 'new-view-foreign-modal-fixture'
        modal.setAttribute('role', 'dialog')
        modal.setAttribute('aria-modal', 'true')
        modal.style.cssText = 'position:fixed;left:10px;top:10px;width:80px;height:40px;background:white;z-index:9999'
        document.body.append(modal)
      })
      await page.keyboard.press('Escape')
      await twoFrames(page)
      await expect(menu).toHaveJSProperty('open', true)
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
      expect((await observations(page)).focus.length).toBe(blankFocus)
      expect((await observations(page)).keys.at(-1)?.defaultPrevented).toBe(false)
      await page.evaluate(() => document.getElementById('new-view-foreign-modal-fixture')!.remove())
      await page.keyboard.press('Escape')
      await twoFrames(page)
      const blank = await record(page, app, info, language, firstOwner, before, 'blank-pointer-body-escape-closes-without-return-focus')
      expect(blank.state.menuOpen).toBe(false)
      expect(blank.state.active?.tag).toBe('BODY')
      expect(blank.observations.focus.length).toBe(blankFocus)
      expect(blank.observations.keys.at(-1)?.defaultPrevented).toBe(true)

      await open()
      await tabTo(page, table)
      await actions.click()
      await expect(menu).toHaveJSProperty('open', false)
      await expect(page.locator('.dbw-view-actions-menu')).toHaveCount(1)
      const actionsOpen = await record(page, app, info, language, firstOwner, before, 'actions-open-dismisses-new-view')
      expect(actionsOpen.state.menuOpen).toBe(false)
      expect(actionsOpen.state.actionsCount).toBe(1)
      const peerFocus = (await observations(page)).focus.length
      await summary.click()
      await twoFrames(page)
      await expect(menu).toHaveJSProperty('open', true)
      await expect(page.locator('.dbw-view-actions-menu')).toHaveCount(0)
      const newOpen = await record(page, app, info, language, firstOwner, before, 'new-view-open-dismisses-actions')
      expect(newOpen.state.menuOpen).toBe(true)
      expect(newOpen.state.actionsCount).toBe(0)
      expect(newOpen.observations.focus.length).toBe(peerFocus)

      const tabFocus = (await observations(page)).focus.length
      await tabTo(page, query)
      await expect(query).toBeFocused()
      await expect(menu).toHaveJSProperty('open', false)
      const departure = await record(page, app, info, language, firstOwner, before, 'native-tab-leaves-menu-without-return-focus')
      expect(departure.state.menuOpen).toBe(false)
      expect(departure.observations.focus.length).toBe(tabFocus)

      await open()
      const pointerFocus = (await observations(page)).focus.length
      await query.click()
      await expect(query).toBeFocused()
      await expect(menu).toHaveJSProperty('open', false)
      expect((await observations(page)).focus.length).toBe(pointerFocus)
      await query.fill('Original ')
      const outside = await record(page, app, info, language, firstOwner, before, 'outside-pointer-keeps-external-query-draft', 'Original ')
      expect(outside.state.menuOpen).toBe(false)
      expect(outside.state.dirty).toBe(true)
      await open()
      await tabTo(page, table)
      await page.keyboard.press('Escape')
      await twoFrames(page)
      await expect(menu).toHaveJSProperty('open', false)
      await expect(summary).toBeFocused()
      const draft = await record(page, app, info, language, firstOwner, before, 'query-draft-survives-owned-escape', 'Original ')
      expect(draft.state.dirty).toBe(true)

      const form = page.locator('.dbw-form-dialog')
      for (const [layout, item, label] of [['table', table, text.table], ['board', board, text.board], ['cards', cards, text.cards]] as const) {
        await open()
        await tabTo(page, item)
        await page.keyboard.press('Enter')
        await expect(form).toBeVisible()
        await expect(menu).toHaveJSProperty('open', false)
        const name = form.getByLabel(text.name, { exact: true })
        await expect(name).toBeFocused()
        await expect(name).toHaveValue(label + ' 2')
        await name.fill('Unsaved ' + label)
        await tabTo(page, form.getByRole('button', { name: text.cancel, exact: true }))
        await page.keyboard.press('Enter')
        await expect(form).toHaveCount(0)
        await expect(summary).toBeFocused()
        await expect(menu).toHaveJSProperty('open', false)
        const cancelled = await record(page, app, info, language, firstOwner, before, 'real-' + layout + '-create-form-cancel-retains-summary-and-draft', 'Original ')
        expect(cancelled.state.menuOpen).toBe(false)
        expect(cancelled.state.dirty).toBe(true)
      }

      await page.getByRole('button', { name: text.resetView, exact: true }).click()
      await expect(query).toHaveValue('Original')
      const final = await record(page, app, info, language, firstOwner, before, 'final-reset-preserves-records-saved-views-and-schema')
      expect(final.state.menuOpen).toBe(false)
      expect(final.state.actionsCount).toBe(0)
      expect(final.state.dirty).toBe(false)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
