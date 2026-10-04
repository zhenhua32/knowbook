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
type ProbeGlobal = typeof globalThis & { __cardDensityProbe?: Probe }
const sourceName = 'Card density source'
const viewName = 'Original cards'
const singleTitle = 'Single compact card'
const longTitle = 'Long content ' + 'knowledge-review-'.repeat(16)
const longNotes = 'very-long-unbroken-note-'.repeat(12)

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function prepare(page: Page, language: Language) {
  const ids = await page.evaluate(async ({ language, sourceName, viewName, singleTitle, longTitle, longNotes }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep original records and saved view configuration.' })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const done = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Done', type: 'checkbox' })
    const stage = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Stage', type: 'select', options: ['Blue', 'Red'] })
    const due = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Due', type: 'date' })
    const records = []
    for (const title of [singleTitle, 'Compact batch 001', 'Compact batch 002', 'Compact batch 003', 'Compact batch 004', 'Compact batch 005', longTitle]) {
      records.push(await window.knowbook.createDatabaseEntity({ databaseId: database.id, title,
        fieldValues: { [notes.id]: title === longTitle ? longNotes : 'Original Notes', [done.id]: false, [stage.id]: 'Blue', [due.id]: '2026-10-01' } }))
    }
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'cards', query: 'Single compact', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', notes.id, done.id, stage.id, due.id], fieldOrder: ['__title__', notes.id, done.id, stage.id, due.id],
      columnWidths: {}, cardFieldIds: [notes.id, done.id, stage.id, due.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { databaseId: database.id, viewId: view.id, records: records.map(record => ({ id: record.id, title: record.title })) }
  }, { language, sourceName, viewName, singleTitle, longTitle, longNotes })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', viewName)
  await expect(page.locator('.dbw-main-search input')).toHaveValue('Single compact')
  await expect(page.locator('.dbw-record-card')).toHaveCount(1)
  return ids
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__cardDensityProbe = probe
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

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language,
  before: Awaited<ReturnType<typeof readStored>>, phase: string, query: string) {
  const state = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('.dbw-card-grid')!
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      view: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      grid: { bounds: grid.getBoundingClientRect().toJSON(), clientHeight: grid.clientHeight, scrollHeight: grid.scrollHeight, scrollTop: grid.scrollTop },
      selectedCount: document.querySelectorAll('.dbw-record-card.is-selected').length,
      active: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName, className: document.activeElement.className,
        text: document.activeElement.textContent, label: document.activeElement.getAttribute('aria-label') } : null,
      cards: Array.from(grid.querySelectorAll<HTMLElement>('.dbw-record-card')).map(card => {
        const body = card.querySelector<HTMLElement>('.dbw-card-body')!, title = body.querySelector<HTMLElement>('strong')!, last = body.querySelector<HTMLElement>('dl')!
        const rect = card.getBoundingClientRect(), lastRect = last.getBoundingClientRect(), style = getComputedStyle(body), cardStyle = getComputedStyle(card)
        const text = title.firstChild, range = document.createRange()
        if (text && text.textContent) { range.setStart(text, text.textContent.length - 1); range.setEnd(text, text.textContent.length) }
        return { title: title.textContent, bounds: rect.toJSON(), bodyBounds: body.getBoundingClientRect().toJSON(), titleBounds: title.getBoundingClientRect().toJSON(),
          lastContentBounds: lastRect.toJSON(), tailBounds: text?.textContent ? range.getBoundingClientRect().toJSON() : null,
          naturalHeight: lastRect.bottom - rect.top + parseFloat(style.paddingBottom) + parseFloat(cardStyle.borderBottomWidth),
          focused: document.activeElement === body, selected: card.classList.contains('is-selected'),
          checkbox: { bounds: card.querySelector<HTMLInputElement>('.dbw-card-checkbox')!.getBoundingClientRect().toJSON(),
            labelBounds: card.querySelector('label')!.getBoundingClientRect().toJSON(), checked: card.querySelector<HTMLInputElement>('.dbw-card-checkbox')!.checked },
          fields: Array.from(body.querySelectorAll('dl > div')).map(field => ({ name: field.querySelector('dt')?.textContent,
            value: field.querySelector('dd')?.textContent, fullValue: field.querySelector('dd')?.getAttribute('title') })) }
      }) }
  })
  const ipc = await app.evaluate(() => (globalThis as ProbeGlobal).__cardDensityProbe!)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const stored = await readStored(page, app, language), path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, state, ipc, windows, before, stored }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(ipc.requests).toHaveLength(0)
  expect(ipc.writes).toHaveLength(0)
  expect(ipc.failures).toHaveLength(0)
  expect(stored).toEqual(before)
  expect(state.source).toBe(sourceName)
  expect(state.view).toBe(viewName)
  expect(state.query).toBe(query)
  return state
}

function expectCompact(card: Awaited<ReturnType<typeof record>>['cards'][number]) {
  expect(card.bounds.height).toBeGreaterThanOrEqual(190)
  // The short card may grow for its actual fields, but unused grid space
  // must not stretch it beyond the content plus its existing bottom padding.
  expect(card.bounds.height).toBeLessThanOrEqual(Math.ceil(Math.max(190, card.naturalHeight)))
}

async function queryRecords(page: Page, value: string, count: number) {
  const query = page.locator('.dbw-main-search input')
  await query.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  if (value) await page.keyboard.type(value)
  await expect(page.locator('.dbw-record-card')).toHaveCount(count)
  await page.mouse.move(40, 40)
  await twoFrames(page)
}

async function resize(page: Page, width: number) {
  await page.setViewportSize({ width, height: 760 })
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations().length)).toBe(0)
  await twoFrames(page)
}

async function wheelGrid(page: Page, delta: number) {
  const grid = await page.locator('.dbw-card-grid').boundingBox()
  expect(grid).not.toBeNull()
  const viewport = page.viewportSize()!
  const left = Math.max(0, grid!.x), right = Math.min(viewport.width, grid!.x + grid!.width)
  const top = Math.max(0, grid!.y), bottom = Math.min(viewport.height, grid!.y + grid!.height)
  expect(right).toBeGreaterThan(left)
  expect(bottom).toBeGreaterThan(top)
  await page.mouse.move((left + right) / 2, (top + bottom) / 2)
  await page.mouse.wheel(0, delta)
  await twoFrames(page)
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('short cards keep natural density and long titles remain readable in ' + language + ' @electron', async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'A matching built Electron app is required')
    test.setTimeout(90_000)
    await withElectronApp(async ({ page, app }) => {
      await prepare(page, language)
      await installProbe(app)
      const before = await readStored(page, app, language), text = getDatabaseWorkspaceText(language)
      await page.mouse.move(40, 40)
      await twoFrames(page)
      const initial = await record(page, app, info, language, before, 'single-short-before-natural-height-oracle', 'Single compact')
      expect(initial.cards).toHaveLength(1)
      expect(initial.cards[0].title).toBe(singleTitle)
      expect(initial.cards[0].fields.map(field => field.fullValue)).toContain('Original Notes')
      // Earliest business oracle: old implicit grid tracks make this short
      // card about 384px high even though its actual content needs far less.
      expectCompact(initial.cards[0])

      const checkbox = page.locator('.dbw-card-checkbox')
      await checkbox.click()
      await expect(checkbox).toBeChecked()
      await expect(page.getByRole('button', { name: text.clearSelection, exact: true })).toBeVisible()
      await page.mouse.move(40, 40)
      await twoFrames(page)
      const selected = await record(page, app, info, language, before, 'single-short-with-selection-toolbar', 'Single compact')
      expect(selected.selectedCount).toBe(1)
      expectCompact(selected.cards[0])
      expect(selected.cards[0].checkbox.bounds.width).toBe(16)
      expect(selected.cards[0].checkbox.bounds.height).toBe(16)
      expect(selected.cards[0].checkbox.labelBounds.width).toBe(32)
      expect(selected.cards[0].checkbox.labelBounds.height).toBe(32)
      await checkbox.click()
      await expect(checkbox).not.toBeChecked()

      await queryRecords(page, 'Compact', 6)
      for (const width of [1100, 980]) {
        await resize(page, width)
        const rows = await record(page, app, info, language, before, 'short-card-rows-' + width, 'Compact')
        expect(rows.cards).toHaveLength(6)
        rows.cards.forEach(expectCompact)
        const firstTop = rows.cards[0].bounds.top
        const firstRow = rows.cards.filter(card => card.bounds.top === firstTop)
        expect(firstRow.length).toBeGreaterThan(1)
        firstRow.forEach(card => expect(card.bounds.height).toBe(firstRow[0].bounds.height))
        expect(rows.cards.some(card => card.bounds.top > firstTop)).toBe(true)
        for (let index = 0; index < rows.cards.length; index++) {
          for (const other of rows.cards.slice(index + 1)) {
            const card = rows.cards[index]
            expect(card.bounds.right <= other.bounds.left || other.bounds.right <= card.bounds.left
              || card.bounds.bottom <= other.bounds.top || other.bounds.bottom <= card.bounds.top).toBe(true)
          }
        }
      }

      await resize(page, 1100)
      await queryRecords(page, 'Long content', 1)
      const compactLong = await record(page, app, info, language, before, 'long-title-before-native-keyboard-reading', 'Long content')
      expect(compactLong.cards[0].title).toBe(longTitle)
      expect(compactLong.cards[0].fields.find(field => field.name === 'Notes')?.fullValue).toBe(longNotes)
      await page.locator('.dbw-card-checkbox').click()
      await page.keyboard.press('Tab')
      const body = page.locator('.dbw-card-body')
      await expect(body).toBeFocused()
      await twoFrames(page)
      await wheelGrid(page, 240)
      const expanded = await record(page, app, info, language, before, 'long-title-native-tab-expanded-and-readable', 'Long content')
      expect(expanded.cards[0].focused).toBe(true)
      expect(expanded.cards[0].titleBounds.height).toBeGreaterThan(compactLong.cards[0].titleBounds.height)
      expect(expanded.cards[0].bounds.height).toBeGreaterThan(compactLong.cards[0].bounds.height)
      expect(expanded.cards[0].tailBounds).not.toBeNull()
      expect(expanded.cards[0].tailBounds!.top).toBeGreaterThanOrEqual(expanded.cards[0].bounds.top)
      expect(expanded.cards[0].tailBounds!.bottom).toBeLessThanOrEqual(expanded.cards[0].bounds.bottom)
      expect(expanded.cards[0].tailBounds!.bottom).toBeLessThanOrEqual(expanded.viewport.height)
      expect(expanded.cards[0].tailBounds!.top).toBeGreaterThanOrEqual(0)
      await page.keyboard.press('Enter')
      const drawer = page.locator('.dbw-record-drawer')
      await expect(drawer).toBeVisible()
      await expect(drawer.locator('.dbw-record-title-input')).toHaveValue(longTitle)
      await drawer.getByRole('button', { name: text.close, exact: true }).click()
      await expect(drawer).toHaveCount(0)
      await page.locator('.dbw-card-checkbox').click()
      await expect(page.locator('.dbw-card-checkbox')).not.toBeChecked()
      await queryRecords(page, 'Single compact', 1)
      const final = await record(page, app, info, language, before, 'returned-to-original-short-query-without-saving', 'Single compact')
      expect(final.selectedCount).toBe(0)
      expectCompact(final.cards[0])
    })
  })
}
