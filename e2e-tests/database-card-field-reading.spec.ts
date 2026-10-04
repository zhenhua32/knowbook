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
type ProbeGlobal = typeof globalThis & { __cardReadingProbe?: Probe }
const sourceName = 'Keyboard reading source'
const viewName = 'Original reading cards'
const longName = 'Review-and-delivery-context-'.repeat(4)
const longValue = 'very-long-unbroken-note-'.repeat(12)

async function prepare(page: Page, language: Language) {
  const fixture = await page.evaluate(async ({ language, sourceName, viewName, longName, longValue }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: longName, type: 'text' })
    const stage = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Stage', type: 'select', options: ['Blue', 'Red'] })
    const due = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Due', type: 'date' })
    const done = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Done', type: 'checkbox' })
    const parent = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(parent.id, { title: 'Research-and-delivery-'.repeat(4), summary: '', blocks: [] })
    const document = await window.knowbook.createDocument(parent.id)
    await window.knowbook.updateDocument(document.id, { title: 'Knowledge-workspace-specification-'.repeat(4), summary: '', blocks: [] })
    const record = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Read complete card content', documentId: document.id,
      fieldValues: { [notes.id]: longValue, [stage.id]: 'Blue', [due.id]: '2026-10-01', [done.id]: false } })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Short neighboring card',
      fieldValues: { [notes.id]: 'Original Notes', [stage.id]: 'Blue', [due.id]: '2026-10-01', [done.id]: false } })
    const fieldIds = ['__title__', notes.id, stage.id, due.id, done.id]
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'cards', query: '', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null }, visibleFieldIds: fieldIds, fieldOrder: fieldIds,
      columnWidths: {}, cardFieldIds: fieldIds.slice(1) }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { recordId: record.id, path: (await window.knowbook.getDocumentCatalog()).find(item => item.id === document.id)!.path }
  }, { language, sourceName, viewName, longName, longValue })
  await page.reload()
  await page.setViewportSize({ width: language === 'zh-CN' ? 980 : 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-record-card')).toHaveCount(2)
  return fixture
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__cardReadingProbe = probe
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

async function geometry(body: Locator) {
  return body.evaluate(element => {
    const card = element.closest('.dbw-record-card')!, grid = element.closest('.dbw-card-grid')! as HTMLElement
    const gridRect = grid.getBoundingClientRect(), cardRect = card.getBoundingClientRect()
    const port = { left: Math.max(0, gridRect.left + grid.clientLeft), top: Math.max(0, gridRect.top + grid.clientTop),
      right: Math.min(innerWidth, gridRect.left + grid.clientLeft + grid.clientWidth), bottom: Math.min(innerHeight, gridRect.top + grid.clientTop + grid.clientHeight) }
    return { focused: document.activeElement === element, focusVisible: element.matches(':focus-visible'), card: cardRect.toJSON(),
      grid: { port, scrollTop: grid.scrollTop, scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight },
      shellOverflow: document.querySelector('.dbw-shell')!.scrollWidth - document.querySelector('.dbw-shell')!.clientWidth,
      texts: Array.from(element.querySelectorAll('small, dt, dd')).map(node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node), text = node.firstChild as Text
        const range = document.createRange()
        if (text?.length) { range.setStart(text, text.length - 1); range.setEnd(text, text.length) }
        const tail = range.getBoundingClientRect()
        const left = Math.max(tail.left, rect.left, cardRect.left, port.left), right = Math.min(tail.right, rect.right, cardRect.right, port.right)
        const top = Math.max(tail.top, rect.top, cardRect.top, port.top), bottom = Math.min(tail.bottom, rect.bottom, cardRect.bottom, port.bottom)
        const hit = document.elementFromPoint((tail.left + tail.right) / 2, (tail.top + tail.bottom) / 2)
        return { tag: node.tagName, text: node.textContent, title: node.getAttribute('title'), rect: rect.toJSON(), tail: tail.toJSON(),
          width: node.clientWidth, scrollWidth: node.scrollWidth, height: node.clientHeight, scrollHeight: node.scrollHeight,
          whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap,
          visibleRatio: tail.width && tail.height ? Math.max(0, right - left) * Math.max(0, bottom - top) / (tail.width * tail.height) : 0,
          tailHit: Boolean(hit && (node === hit || node.contains(hit))) }
      }) }
  })
}

async function record(page: Page, app: ElectronApplication, body: Locator, info: TestInfo, language: Language,
  before: Awaited<ReturnType<typeof readStored>>, phase: string) {
  const state = await geometry(body), stored = await readStored(page, app, language)
  const ipc = await app.evaluate(() => (globalThis as ProbeGlobal).__cardReadingProbe!)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, state, ipc, windows, before, stored }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(ipc.requests).toHaveLength(0)
  expect(ipc.writes).toHaveLength(0)
  expect(ipc.failures).toHaveLength(0)
  expect(stored).toEqual(before)
  expect(state.shellOverflow).toBeLessThanOrEqual(1)
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', viewName)
  await expect(page.locator('.dbw-main-search input')).toHaveValue('')
  return state
}

function expectUnclipped(text: Awaited<ReturnType<typeof geometry>>['texts'][number]) {
  expect(text.scrollWidth).toBeLessThanOrEqual(text.width + 1)
  expect(text.scrollHeight).toBeLessThanOrEqual(text.height + 1)
  expect(text.tail.left).toBeGreaterThanOrEqual(text.rect.left - 1)
  expect(text.tail.right).toBeLessThanOrEqual(text.rect.right + 1)
  expect(text.tail.top).toBeGreaterThanOrEqual(text.rect.top - 1)
  expect(text.tail.bottom).toBeLessThanOrEqual(text.rect.bottom + 1)
}

async function readTailWithKeyboard(page: Page, body: Locator, index: number) {
  for (let step = 0; step < 40; step++) {
    const state = await geometry(body), text = state.texts[index]
    expect(state.focusVisible).toBe(true)
    if (text.visibleRatio > .999 && text.tailHit) return
    await page.keyboard.press(text.tail.bottom > state.grid.port.bottom ? 'ArrowDown' : 'ArrowUp')
    await page.waitForTimeout(80)
  }
  const state = await geometry(body)
  expect(state.texts[index].visibleRatio).toBeGreaterThan(.999)
  expect(state.texts[index].tailHit).toBe(true)
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('keyboard focus reveals complete card paths and fields in ' + language + ' @electron', async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'A matching built Electron app is required')
    test.setTimeout(90_000)
    await withElectronApp(async ({ page, app }) => {
      const fixture = await prepare(page, language), text = getDatabaseWorkspaceText(language)
      await installProbe(app)
      const before = await readStored(page, app, language)
      const card = page.locator('.dbw-record-card').filter({ has: page.locator('strong', { hasText: 'Read complete card content' }) })
      const body = card.locator('.dbw-card-body'), checkbox = card.locator('.dbw-card-checkbox')
      await page.mouse.move(40, 40)
      const compact = await record(page, app, body, info, language, before, 'compact-before-keyboard-reading')
      expect(compact.focusVisible).toBe(false)
      expect(compact.texts[0].text).toBe(fixture.path)
      expect(compact.texts[1].text).toBe(longName)
      expect(compact.texts[2].text).toBe(longValue)
      expect(compact.texts.every(value => value.whiteSpace === 'nowrap')).toBe(true)
      await checkbox.click()
      await page.keyboard.press('Tab')
      await expect(body).toBeFocused()
      const expanded = await record(page, app, body, info, language, before, 'native-tab-before-full-text-oracle')
      expect(expanded.focusVisible).toBe(true)
      // The old focused card still clips the actual path, name and value suffixes.
      expanded.texts.forEach(expectUnclipped)
      expect(expanded.card.height).toBeGreaterThan(compact.card.height)
      for (const [index, phase] of [[0, 'path-tail-read'], [1, 'field-name-tail-read'], [2, 'field-value-tail-read']] as const) {
        await readTailWithKeyboard(page, body, index)
        const visible = await record(page, app, body, info, language, before, phase)
        expect(visible.texts[index].visibleRatio).toBeGreaterThan(.999)
        expect(visible.texts[index].tailHit).toBe(true)
      }
      await page.keyboard.press('Shift+Tab')
      await expect(checkbox).toBeFocused()
      await page.keyboard.press('Space')
      await expect(checkbox).not.toBeChecked()
      const restored = await record(page, app, body, info, language, before, 'native-shift-tab-restores-compact-content')
      expect(restored.focusVisible).toBe(false)
      expect(restored.texts.every(value => value.whiteSpace === 'nowrap')).toBe(true)
      expect(restored.card.height).toBeCloseTo(compact.card.height, 0)
      await page.keyboard.press('Tab')
      await expect(body).toBeFocused()
      await page.keyboard.press('Enter')
      const drawer = page.locator('.dbw-record-drawer')
      await expect(drawer).toBeVisible()
      await expect(drawer.locator('.dbw-record-title-input')).toHaveValue('Read complete card content')
      await drawer.getByRole('button', { name: text.close, exact: true }).click()
      await expect(drawer).toHaveCount(0)
      await page.locator('.dbw-main-search input').click()
      const final = await record(page, app, body, info, language, before, 'detail-closed-with-original-data-and-view')
      expect(final.focusVisible).toBe(false)
      expect(final.card.height).toBeCloseTo(compact.card.height, 0)
    })
  })
}
