import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { UpdateDatabaseEntityInput, UpdateDocumentDatabaseValueInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type SourceKind = 'custom' | 'catalog'
type WriteChannel = 'knowbook:update-database-entity' | 'knowbook:update-document-database-value'
type WriteInput = UpdateDatabaseEntityInput | UpdateDocumentDatabaseValueInput
type Request = { channel: WriteChannel; input: WriteInput }
type Handler = (event: unknown, ...inputs: unknown[]) => unknown | Promise<unknown>
type MainProbe = { originals: Map<string, Handler>; requests: Request[]; writes: Request[];
  failures: Array<Request & { message: string }>; captureDropReads: boolean;
  dropRefreshReads: Array<{ channel: string; input: unknown }> }
type ProbeGlobal = typeof globalThis & { __knowbookBoardTextRefresh?: MainProbe }
type Ids = { kind: SourceKind; databaseId: string; fieldId: string; recordId: string;
  otherRecordId: string; secondaryId: string; viewId: string }
type RawRow = Record<string, string | number | null>
type RawStores = { entities: RawRow[]; entityValues: RawRow[]; documentValues: RawRow[] }
const primarySourceName = 'Board text primary source'
const secondarySourceName = 'Board text secondary source'
const recordTitle = 'Board record A'
const otherRecordTitle = 'Board record B'
const viewName = 'Text grouping board'

function card(page: Page, title = recordTitle) {
  return page.locator('.dbw-board-card').filter({ has: page.locator('strong[title]').filter({ hasText: new RegExp(`^${title}$`) }) })
}

function column(page: Page, label: string) {
  return page.locator('.dbw-board-column').filter({ has: page.locator('header > strong').filter({ hasText: new RegExp(`^${label}$`) }) })
}

async function seed(page: Page, language: Language, kind: SourceKind): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, kind, recordTitle, otherRecordTitle, primarySourceName, secondarySourceName, viewName }) => {
    const database = kind === 'custom'
      ? await window.knowbook.createDocumentDatabase({ name: primarySourceName, description: 'Preserve primary source metadata.' })
      : (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')!
    if (!database) throw new Error('The actual document catalog database is required')
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const owner = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Hidden owner', type: 'text' })
    const createRecord = async (title: string, notes: string, ownerValue: string) => {
      if (kind === 'custom') {
        return (await window.knowbook.createDatabaseEntity({ databaseId: database.id, title,
          fieldValues: { [field.id]: notes, [owner.id]: ownerValue } })).id
      }
      const document = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(document.id, { title, summary: `Keep ${title} summary.`,
        blocks: [{ type: 'paragraph', content: `Keep ${title} original document content.`, checked: false, depth: 0 }] })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: document.id, columnId: field.id, value: notes })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: document.id, columnId: owner.id, value: ownerValue })
      return document.id
    }
    const recordId = await createRecord(recordTitle, 'Alpha', 'Keep A owner')
    const otherRecordId = await createRecord(otherRecordTitle, 'Beta', 'Keep B owner')
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config: {
      version: 1, layout: 'board', query: 'Board record', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: field.id },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id, owner.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id]
    } })
    const secondary = await window.knowbook.createDocumentDatabase({ name: secondarySourceName, description: 'Keep secondary source unchanged.' })
    await window.knowbook.createDatabaseEntity({ databaseId: secondary.id, title: 'Secondary preserved record', fieldValues: {} })
    const secondaryView = await window.knowbook.createDatabaseSavedView({ databaseId: secondary.id, name: 'Secondary table', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__'], fieldOrder: ['__title__'], columnWidths: { __title__: 180 }, cardFieldIds: []
    } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    window.localStorage.setItem(`knowbook.database.last-view.${secondary.id}`, secondaryView.id)
    return { kind, databaseId: database.id, fieldId: field.id, recordId, otherRecordId, secondaryId: secondary.id, viewId: view.id }
  }, { language, kind, recordTitle, otherRecordTitle, primarySourceName, secondarySourceName, viewName })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.getByTestId('database-board-view')).toBeVisible()
  await expect(column(page, 'Alpha').locator('.dbw-board-card')).toHaveCount(1)
  await expect(column(page, 'Beta').locator('.dbw-board-card')).toHaveCount(1)
  await expect(card(page)).toBeVisible()
  await twoFrames(page)
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

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const writeChannels: WriteChannel[] = ['knowbook:update-database-entity', 'knowbook:update-document-database-value']
    const readChannels = ['knowbook:get-database-entities', 'knowbook:get-document-catalog-page']
    const originals = new Map<string, Handler>()
    for (const channel of [...writeChannels, ...readChannels]) {
      const original = handlers.get(channel)
      if (!original) throw new Error(`The actual authenticated IPC handler is required: ${channel}`)
      originals.set(channel, original)
    }
    const probe: MainProbe = { originals, requests: [], writes: [], failures: [], captureDropReads: false, dropRefreshReads: [] }
    ;(globalThis as ProbeGlobal).__knowbookBoardTextRefresh = probe
    for (const channel of writeChannels) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, input: WriteInput) => {
        const request: Request = { channel, input: structuredClone(input) }
        probe.requests.push(request)
        try {
          // Delegate the original with its real sender/senderFrame. The real
          // store performs the write; this probe does not change UI or data.
          const result = await originals.get(channel)!(event, input)
          probe.writes.push(request)
          return result
        } catch (error) {
          probe.failures.push({ ...request, message: error instanceof Error ? error.message : String(error) })
          throw error
        }
      })
    }
    for (const channel of readChannels) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, ...inputs: unknown[]) => {
        if (probe.captureDropReads) probe.dropRefreshReads.push({ channel, input: structuredClone(inputs[0]) })
        return originals.get(channel)!(event, ...inputs)
      })
    }
  })
  await pageDragProbe(app)
}

async function pageDragProbe(app: ElectronApplication) {
  const page = await app.firstWindow()
  await page.evaluate(() => {
    const events: Array<{ type: string; card: string | null; group: string | null }> = []
    ;(window as unknown as { __boardDragEvents: typeof events }).__boardDragEvents = events
    for (const type of ['dragstart', 'drop', 'dragend']) document.addEventListener(type, event => {
      const target = event.target instanceof Element ? event.target : null
      events.push({ type, card: target?.closest('.dbw-board-card')?.querySelector('strong')?.textContent ?? null,
        group: target?.closest('.dbw-board-column')?.querySelector('header > strong')?.textContent ?? null })
    }, true)
  })
}

async function mainState(app: ElectronApplication, endDropReadPhase = false) {
  return app.evaluate((_electron, endDropReadPhase) => {
    const probe = (globalThis as ProbeGlobal).__knowbookBoardTextRefresh!
    // End the measured user-action phase BEFORE artifact API reads. Subsequent
    // full snapshots remain authenticated, but cannot inflate these UI counts.
    if (endDropReadPhase) probe.captureDropReads = false
    return { requests: probe.requests, writes: probe.writes, failures: probe.failures,
      dropRefreshReads: probe.dropRefreshReads,
      readCountScope: 'Actual renderer reads between native drag start and ACK evidence, excluding artifact/source-switch/reload reads.' }
  }, endDropReadPhase)
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string, endDropReadPhase = false) {
  // Capture IPC first, before the full API/readonly-SQL proof below.
  const ipc = await mainState(app, endDropReadPhase)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const state = await card(page).evaluate((element, recordTitle) => {
    const target = element as HTMLElement, board = target.closest('.dbw-board')!, button = target.querySelector('button')!
    const geometry = (node: Element) => {
      const box = node.getBoundingClientRect(), boardBox = board.getBoundingClientRect()
      const left = Math.max(0, boardBox.left), right = Math.min(innerWidth, boardBox.right)
      const top = Math.max(0, boardBox.top), bottom = Math.min(innerHeight, boardBox.bottom)
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return { x: box.x, y: box.y, width: box.width, height: box.height,
        ratio: Math.max(0, Math.min(box.right, right) - Math.max(box.left, left)) *
          Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)) / (box.width * box.height),
        hit: hit === node || Boolean(hit && node.contains(hit)) }
    }
    const beta = Array.from(board.querySelectorAll('.dbw-board-column')).find(node => node.querySelector('header > strong')?.textContent === 'Beta')!
    const betaBox = beta.getBoundingClientRect(), dropHit = document.elementFromPoint(betaBox.left + 100, betaBox.top + 100)
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      source: document.querySelector('.dbw-source-trigger')?.textContent,
      selectedView: document.querySelector('.dbw-view-tab-wrap.is-active')?.textContent,
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      targetTitle: target.querySelector('strong')?.textContent, targetGroup: target.closest('.dbw-board-column')?.querySelector('header > strong')?.textContent,
      card: geometry(target), button: geometry(button), betaColumn: geometry(beta),
      dropPoint: { x: betaBox.left + 100, y: betaBox.top + 100, hit: dropHit === beta || Boolean(dropHit && beta.contains(dropHit)) },
      columns: Array.from(board.querySelectorAll('.dbw-board-column')).map(node => ({
        label: node.querySelector('header > strong')?.textContent, count: node.querySelector('header > b')?.textContent,
        titles: Array.from(node.querySelectorAll('.dbw-board-card strong')).map(title => title.textContent) })),
      active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') },
      dragging: board.querySelectorAll('.is-dragging').length, hovered: board.querySelectorAll('.is-drag-over').length,
      dragEvents: (window as unknown as { __boardDragEvents?: unknown[] }).__boardDragEvents ?? [],
      targetCards: Array.from(board.querySelectorAll('.dbw-board-card strong')).filter(title => title.textContent === recordTitle).length }
  }, recordTitle)
  const stored = await readStored(page, app, language)
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, ipc, state, stored }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { ipc, state, stored }
}

function expectedRequest(ids: Ids): Request {
  return ids.kind === 'custom'
    ? { channel: 'knowbook:update-database-entity', input: { entityId: ids.recordId, fieldValues: { [ids.fieldId]: 'Beta' } } }
    : { channel: 'knowbook:update-document-database-value', input: { documentId: ids.recordId, columnId: ids.fieldId, value: 'Beta' } }
}

function expectOnlyTargetFieldChanged(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids) {
  if (ids.kind === 'custom') {
    const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.recordId)!
    const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.recordId)!
    expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.fieldId]: 'Beta' }, updatedAt: saved.updatedAt })
    expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt))
    const originalRawEntity = before.raw.entities.find(row => row.id === ids.recordId)!
    const savedRawEntity = after.raw.entities.find(row => row.id === ids.recordId)!
    expect(savedRawEntity).toEqual({ ...originalRawEntity, updated_at: saved.updatedAt })
    const originalRawValue = before.raw.entityValues.find(row => row.entity_id === ids.recordId && row.column_id === ids.fieldId)!
    const savedRawValue = after.raw.entityValues.find(row => row.entity_id === ids.recordId && row.column_id === ids.fieldId)!
    expect(savedRawValue).toEqual({ ...originalRawValue, value_text: 'Beta', updated_at: saved.updatedAt })
    expect(after).toEqual({ ...before, sources: before.sources.map(source => source.id === ids.databaseId
      ? { ...source, entities: source.entities.map(entity => entity.id === ids.recordId ? saved : entity) } : source),
      raw: { ...before.raw, entities: before.raw.entities.map(row => row.id === ids.recordId ? savedRawEntity : row),
        entityValues: before.raw.entityValues.map(row => row.entity_id === ids.recordId && row.column_id === ids.fieldId ? savedRawValue : row) } })
  } else {
    const original = before.catalog.find(document => document.id === ids.recordId)!
    const saved = after.catalog.find(document => document.id === ids.recordId)!
    expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.fieldId]: 'Beta' } })
    const originalRawValue = before.raw.documentValues.find(row => row.document_id === ids.recordId && row.column_id === ids.fieldId)!
    const savedRawValue = after.raw.documentValues.find(row => row.document_id === ids.recordId && row.column_id === ids.fieldId)!
    expect(savedRawValue).toEqual({ ...originalRawValue, value_text: 'Beta', updated_at: savedRawValue.updated_at })
    expect(Date.parse(String(savedRawValue.updated_at))).toBeGreaterThanOrEqual(Date.parse(String(originalRawValue.updated_at)))
    // All document details/catalog metadata and unrelated values remain exact.
    expect(after).toEqual({ ...before, catalog: before.catalog.map(document => document.id === ids.recordId ? saved : document),
      raw: { ...before.raw, documentValues: before.raw.documentValues.map(row =>
        row.document_id === ids.recordId && row.column_id === ids.fieldId ? savedRawValue : row) } })
  }
}

async function selectSource(page: Page, name: string) {
  await page.locator('.dbw-source-trigger').click()
  const picker = page.locator('.dbw-source-picker')
  await expect(picker).toBeVisible()
  await picker.locator('.dbw-source-option').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${name}$`) }) }).click()
  await expect(picker).toHaveCount(0)
}

for (const language of ['en-US', 'zh-CN'] as const) {
  for (const kind of ['custom', 'catalog'] as const) {
    test(`native text-group board drop refreshes its ${kind} card after real ACK in ${language} @electron`, async ({}, info) => {
      test.setTimeout(120_000)
      test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
      await withElectronApp(async ({ page, app }) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        const ids = await seed(page, language, kind)
        const before = await readStored(page, app, language)
        await installProbe(app)
        const initial = await record(page, app, info, language, `${language}-${kind}-before-native-text-group-drag`)
        expect(initial.stored).toEqual(before)
        expect(initial.state.targetGroup).toBe('Alpha')
        expect(initial.state.card.ratio).toBeCloseTo(1, 5)
        expect(initial.state.button.hit).toBe(true)
        expect(initial.state.dropPoint.hit).toBe(true)
        await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookBoardTextRefresh!.captureDropReads = true })
        await card(page).dragTo(column(page, 'Beta'), { targetPosition: { x: 100, y: 100 } })
        await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
        await twoFrames(page)
        // Save real ACK/disk/geometry before the position oracle. The old app
        // writes Beta successfully but leaves this card in Alpha indefinitely.
        const acknowledged = await record(page, app, info, language, `${language}-${kind}-real-write-ack-before-card-position-oracle`, true)
        expect(acknowledged.ipc.requests).toEqual([expectedRequest(ids)])
        expect(acknowledged.ipc.writes).toEqual([expectedRequest(ids)])
        expect(acknowledged.ipc.failures).toEqual([])
        expect(acknowledged.state.dragEvents.some(event => (event as { type: string }).type === 'dragstart')).toBe(true)
        expect(acknowledged.state.dragEvents.some(event => (event as { type: string }).type === 'drop')).toBe(true)
        expectOnlyTargetFieldChanged(before, acknowledged.stored, ids)
        await expect(column(page, 'Beta').locator('.dbw-board-card').filter({ has: page.locator('strong[title]').filter({ hasText: new RegExp(`^${recordTitle}$`) }) })).toHaveCount(1)
        const settled = await record(page, app, info, language, `${language}-${kind}-real-board-card-refreshed-into-beta`)
        expect(settled.state.targetGroup).toBe('Beta')
        expect(settled.state.columns).toEqual([{ label: 'Beta', count: '2', titles: [recordTitle, otherRecordTitle] }])
        expect(settled.state.targetCards).toBe(1)
        expect(settled.state.query).toBe('Board record')
        expect(settled.state.selectedView).toContain(viewName)
        expect(settled.state.dragging).toBe(0)
        expect(settled.state.hovered).toBe(0)
        expect(settled.state.card.ratio).toBeCloseTo(1, 5)
        expect(settled.state.button.hit).toBe(true)
        expect(settled.ipc.dropRefreshReads.filter(read => read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId)).toHaveLength(1)
        expect(settled.ipc.dropRefreshReads.filter(read => read.channel === 'knowbook:get-document-catalog-page').length).toBeGreaterThanOrEqual(1)
        expect(settled.stored).toEqual(acknowledged.stored)
        expect(settled.ipc).toEqual(acknowledged.ipc)

        await selectSource(page, secondarySourceName)
        await expect(page.getByText('Secondary preserved record', { exact: true })).toBeVisible()
        await selectSource(page, kind === 'catalog' ? (language === 'zh-CN' ? '全部文档' : 'All documents') : primarySourceName)
        await expect(column(page, 'Beta').locator('.dbw-board-card')).toHaveCount(2)
        await twoFrames(page)
        const returned = await record(page, app, info, language, `${language}-${kind}-source-roundtrip-keeps-correct-board-without-extra-write`)
        expect(returned.state.targetGroup).toBe('Beta')
        expect(returned.state.query).toBe('Board record')
        expect(returned.state.selectedView).toContain(viewName)
        expect(returned.stored).toEqual(settled.stored)
        expect(returned.ipc).toEqual(settled.ipc)
        await page.reload()
        await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
        await expect(column(page, 'Beta').locator('.dbw-board-card')).toHaveCount(2)
        await twoFrames(page)
        const reloaded = await record(page, app, info, language, `${language}-${kind}-reload-persists-only-target-notes-and-allowed-time`)
        expect(reloaded.state.targetGroup).toBe('Beta')
        expect(reloaded.state.query).toBe('Board record')
        expect(reloaded.stored).toEqual(settled.stored)
        expect(reloaded.ipc).toEqual(settled.ipc)
        expect(errors).toEqual([])
      }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
    })
  }
}
