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
type ReadPhase = 'drop' | 'recovery' | 'dirty-refresh' | 'dirty-retry'
type ReadAttempt = { channel: string; input: unknown; phase: ReadPhase }
type MainProbe = { originals: Map<string, Handler>; requests: Request[]; writes: Request[];
  failures: Array<Request & { message: string }>; databaseId: string; phase: 'idle' | ReadPhase;
  rejectReadReply: boolean; readRequests: ReadAttempt[]; successfulReads: ReadAttempt[];
  failedReads: Array<ReadAttempt & { message: string; kind: 'temporary-ipc-reply' }>;
  holdNextRead: boolean; gates: Array<{ attempt: ReadAttempt; settled: boolean; fail: boolean; release: () => void }> }
type ProbeGlobal = typeof globalThis & { __knowbookWorkspaceRefresh?: MainProbe }
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

async function installProbe(app: ElectronApplication, databaseId: string) {
  await app.evaluate(({ ipcMain }, databaseId) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const writeChannels: WriteChannel[] = ['knowbook:update-database-entity', 'knowbook:update-document-database-value']
    const readChannels = ['knowbook:get-database-entities', 'knowbook:get-document-catalog-page']
    const originals = new Map<string, Handler>()
    for (const channel of [...writeChannels, ...readChannels]) {
      const original = handlers.get(channel)
      if (!original) throw new Error('The original authenticated IPC handler is required: ' + channel)
      originals.set(channel, original)
    }
    const probe: MainProbe = { originals, requests: [], writes: [], failures: [], databaseId,
      phase: 'idle', rejectReadReply: true, readRequests: [], successfulReads: [], failedReads: [], holdNextRead: false, gates: [] }
    ;(globalThis as ProbeGlobal).__knowbookWorkspaceRefresh = probe
    for (const channel of writeChannels) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, input: WriteInput) => {
        const request: Request = { channel, input: structuredClone(input) }
        probe.requests.push(request)
        try {
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
      ipcMain.handle(channel, async (event, ...inputs: unknown[]) => {
        const phase = probe.phase
        const attempt: ReadAttempt | null = phase === 'idle' ? null : { channel, input: structuredClone(inputs[0]), phase }
        if (attempt) probe.readRequests.push(attempt)
        // Authenticate and perform the actual read first. Only its IPC reply
        // is temporarily rejected; this fixture does not simulate SQLite loss.
        const result = await originals.get(channel)!(event, ...inputs)
        let rejectHeldReply = false
        if (attempt && channel === 'knowbook:get-database-entities' && inputs[0] === databaseId && probe.holdNextRead) {
          probe.holdNextRead = false
          let release!: () => void
          const pending = new Promise<void>(resolve => { release = resolve })
          const gate = { attempt, settled: false, fail: false, release }
          probe.gates.push(gate)
          await pending
          rejectHeldReply = gate.fail
          gate.settled = true
        }
        if (attempt && (rejectHeldReply || (phase === 'drop' && channel === 'knowbook:get-database-entities' &&
            inputs[0] === databaseId && probe.writes.length === 1 && probe.rejectReadReply && probe.failedReads.length === 0))) {
          const message = 'The authenticated workspace read completed, but its IPC reply is temporarily unavailable.'
          probe.failedReads.push({ ...attempt, message, kind: 'temporary-ipc-reply' })
          throw new Error(message)
        }
        if (attempt) probe.successfulReads.push(attempt)
        return result
      })
    }
  }, databaseId)
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

async function mainState(app: ElectronApplication, endUserReadPhase = false) {
  return app.evaluate((_electron, endUserReadPhase) => {
    const probe = (globalThis as ProbeGlobal).__knowbookWorkspaceRefresh!
    // End the user-action phase before artifact API/readonly-SQL snapshots.
    // Those normal authenticated proof reads cannot inflate recovery counts.
    if (endUserReadPhase) probe.phase = 'idle'
    return { requests: probe.requests, writes: probe.writes, failures: probe.failures,
      readRequests: probe.readRequests, successfulReads: probe.successfulReads, failedReads: probe.failedReads,
      gates: probe.gates.map(gate => ({ attempt: gate.attempt, settled: gate.settled, fail: gate.fail })),
      readCountScope: 'Only native drag and Refresh database actions; artifact and reload reads are excluded.' }
  }, endUserReadPhase)
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string, endUserReadPhase = false) {
  // Capture IPC first, before the full API/readonly-SQL proof below.
  const ipc = await mainState(app, endUserReadPhase)
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

function currentCell(page: Page) {
  const row = page.locator('.dbw-table tbody tr').filter({ has: page.getByText(recordTitle, { exact: true }) })
  return row.getByRole('textbox', { name: 'Notes', exact: true })
}

async function recordCell(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string, endUserReadPhase = false) {
  const ipc = await mainState(app, endUserReadPhase)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const state = await currentCell(page).evaluate(element => {
    const input = element as HTMLInputElement, row = input.closest('tr')!, port = input.closest('.dbw-table-scroll')!
    const box = input.getBoundingClientRect(), portBox = port.getBoundingClientRect()
    const left = Math.max(0, portBox.left + port.clientLeft), right = Math.min(innerWidth, portBox.right)
    const top = Math.max(0, portBox.top + port.clientTop), bottom = Math.min(innerHeight, portBox.bottom)
    const probe = (window as unknown as { __refreshInput?: HTMLInputElement; __refreshFocusCalls?: unknown[] })
    return { value: input.value, readOnly: input.readOnly, disabled: input.disabled,
      sameNode: probe.__refreshInput === input, focused: document.activeElement === input,
      selection: [input.selectionStart, input.selectionEnd, input.selectionDirection], focusCalls: probe.__refreshFocusCalls ?? [],
      rowHeight: row.getBoundingClientRect().height,
      ratio: Math.max(0, Math.min(box.right, right) - Math.max(box.left, left)) *
        Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)) / (box.width * box.height),
      hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input,
      source: document.querySelector('.dbw-source-trigger')?.textContent,
      selectedView: document.querySelector('.dbw-view-tab-wrap.is-active')?.textContent,
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      messages: Array.from(document.querySelectorAll('.app-notifications .app-notification-message')).map(node => node.textContent),
      busyRefreshButtons: Array.from(document.querySelectorAll('.dbw-header button[aria-busy="true"]')).map(button => ({
        text: button.textContent, disabled: (button as HTMLButtonElement).disabled,
        ariaDisabled: button.getAttribute('aria-disabled') })) }
  })
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

const cases: Array<{ language: Language; kind: SourceKind }> = [
  { language: 'en-US', kind: 'custom' }, { language: 'zh-CN', kind: 'catalog' }
]

for (const { language, kind } of cases) {
  test('Refresh database recovers a saved ' + kind + ' Board after an IPC read reply failure in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seed(page, language, kind)
      const before = await readStored(page, app, language)
      await installProbe(app, ids.databaseId)
      const initial = await record(page, app, info, language, language + '-' + kind + '-before-native-drag')
      expect(initial.stored).toEqual(before)
      expect(initial.state.targetGroup).toBe('Alpha')
      expect(initial.state.card.ratio).toBeCloseTo(1, 5)
      expect(initial.state.button.hit).toBe(true)
      expect(initial.state.dropPoint.hit).toBe(true)
      await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookWorkspaceRefresh!.phase = 'drop' })
      await card(page).dragTo(column(page, 'Beta'), { targetPosition: { x: 100, y: 100 } })
      await expect.poll(async () => (await mainState(app)).failedReads.length).toBe(1)
      await twoFrames(page)
      // Preserve the durable SQLite write and stale Board before checking the
      // missing user recovery entry. No reload or fabricated UI refresh occurs.
      const failed = await record(page, app, info, language, language + '-' + kind + '-saved-board-with-temporary-ipc-read-failure-before-refresh-entry-oracle', true)
      expect(failed.ipc.requests).toEqual([expectedRequest(ids)])
      expect(failed.ipc.writes).toEqual([expectedRequest(ids)])
      expect(failed.ipc.failures).toEqual([])
      expect(failed.ipc.failedReads).toHaveLength(1)
      expect(failed.ipc.failedReads[0]).toMatchObject({ channel: 'knowbook:get-database-entities', input: ids.databaseId,
        phase: 'drop', kind: 'temporary-ipc-reply' })
      expect(failed.ipc.readRequests.filter(read => read.phase === 'drop' && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId)).toHaveLength(1)
      expectOnlyTargetFieldChanged(before, failed.stored, ids)
      expect(failed.state.targetGroup).toBe('Alpha')
      expect(failed.state.query).toBe(initial.state.query)
      expect(failed.state.selectedView).toBe(initial.state.selectedView)
      expect(failed.state.source).toBe(initial.state.source)
      expect(failed.state.dragEvents.some(event => (event as { type: string }).type === 'drop')).toBe(true)

      const refresh = page.getByRole('button', { name: language === 'zh-CN' ? '刷新数据库' : 'Refresh database', exact: true })
      await expect(refresh).toBeVisible()
      await expect(refresh).toBeEnabled()
      await app.evaluate(() => {
        const probe = (globalThis as ProbeGlobal).__knowbookWorkspaceRefresh!
        probe.rejectReadReply = false
        probe.phase = 'recovery'
      })
      await refresh.click()
      await expect(column(page, 'Beta').locator('.dbw-board-card')).toHaveCount(2)
      await twoFrames(page)
      const recovered = await record(page, app, info, language, language + '-' + kind + '-actual-header-refresh-reads-without-repeating-write', true)
      expect(recovered.ipc.requests).toEqual([expectedRequest(ids)])
      expect(recovered.ipc.writes).toEqual([expectedRequest(ids)])
      expect(recovered.ipc.failures).toEqual([])
      expect(recovered.ipc.failedReads).toEqual(failed.ipc.failedReads)
      expect(recovered.ipc.readRequests.filter(read => read.phase === 'recovery' && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId)).toHaveLength(1)
      expect(recovered.ipc.successfulReads.filter(read => read.phase === 'recovery' && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId)).toHaveLength(1)
      expect(recovered.state.targetGroup).toBe('Beta')
      expect(recovered.state.columns).toEqual([{ label: 'Beta', count: '2', titles: [recordTitle, otherRecordTitle] }])
      expect(recovered.state.card.ratio).toBeCloseTo(1, 5)
      expect(recovered.state.button.hit).toBe(true)
      expect(recovered.state.query).toBe(initial.state.query)
      expect(recovered.state.selectedView).toBe(initial.state.selectedView)
      expect(recovered.state.source).toBe(initial.state.source)
      expect(recovered.stored).toEqual(failed.stored)

      // Use genuine pointer and keyboard input. A primary pointer refresh
      // must not blur a dirty text cell or turn its raw whitespace into a write.
      await page.locator('.dbw-layout-switcher').getByRole('button', { name: uiText('Table', '表格'), exact: true }).click()
      const input = currentCell(page)
      await expect(input).toHaveValue('Beta')
      await input.click()
      await page.keyboard.press('Control+A')
      const rawDraft = '  Unsaved notes draft  '
      await page.keyboard.type(rawDraft)
      await page.keyboard.press('Home')
      for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight')
      const selection = await input.evaluate(element => {
        const field = element as HTMLInputElement
        const nativeFocus = HTMLElement.prototype.focus
        const calls: Array<{ preventScroll: boolean | undefined }> = []
        ;(window as unknown as { __refreshInput: HTMLInputElement; __refreshFocusCalls: typeof calls }).__refreshInput = field
        ;(window as unknown as { __refreshFocusCalls: typeof calls }).__refreshFocusCalls = calls
        Object.defineProperty(field, 'focus', { configurable: true, value: function(this: HTMLInputElement, options?: FocusOptions) {
          calls.push({ preventScroll: options?.preventScroll })
          nativeFocus.call(this, options)
        } })
        return [field.selectionStart, field.selectionEnd, field.selectionDirection]
      })
      expect(selection.slice(0, 2)).toEqual([0, 3])
      await app.evaluate(() => {
        const probe = (globalThis as ProbeGlobal).__knowbookWorkspaceRefresh!
        probe.phase = 'dirty-refresh'
        probe.holdNextRead = true
      })
      await refresh.click()
      await expect.poll(async () => (await mainState(app)).gates.length).toBe(1)
      const busyRefresh = page.locator('.dbw-header button[aria-busy="true"]')
      await expect(busyRefresh).toHaveCount(1)
      await expect(busyRefresh).toHaveAccessibleName(language === 'zh-CN' ? '刷新数据库' : 'Refresh database')
      expect(await busyRefresh.evaluate(element => (element as HTMLButtonElement).disabled)).toBe(false)
      await expect(busyRefresh).toHaveAttribute('aria-disabled', 'true')
      await expect(page.locator('.dbw-header').getByRole('status')).toHaveText(language === 'zh-CN' ? '正在刷新数据库…' : 'Refreshing database…')
      const busyBox = await busyRefresh.boundingBox()
      expect(busyBox).not.toBeNull()
      // The aria-disabled control retains native focusability. A genuine
      // repeated pointer click must be rejected by the synchronous action lock.
      await page.mouse.click(busyBox!.x + busyBox!.width / 2, busyBox!.y + busyBox!.height / 2)
      await twoFrames(page)
      const pending = await recordCell(page, app, info, language, language + '-' + kind + '-native-pointer-refresh-keeps-dirty-raw-selection-while-read-is-held', true)
      expect(pending.state.value).toBe(rawDraft)
      expect(pending.state.focused).toBe(true)
      expect(pending.state.sameNode).toBe(true)
      expect(pending.state.selection).toEqual(selection)
      expect(pending.state.focusCalls).toEqual([])
      expect(pending.state.readOnly).toBe(false)
      expect(pending.state.rowHeight).toBeCloseTo(64, 0)
      expect(pending.state.ratio).toBeCloseTo(1, 5)
      expect(pending.state.hit).toBe(true)
      expect(pending.ipc.requests).toEqual([expectedRequest(ids)])
      expect(pending.ipc.writes).toEqual([expectedRequest(ids)])
      expect(pending.ipc.readRequests.filter(read => read.phase === 'dirty-refresh' && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId)).toHaveLength(1)
      expect(pending.stored).toEqual(recovered.stored)
      await app.evaluate(() => {
        const gate = (globalThis as ProbeGlobal).__knowbookWorkspaceRefresh!.gates[0]
        gate.fail = true
        gate.release()
      })
      await expect(refresh).toBeVisible()
      await expect(refresh).toBeEnabled()
      const refreshError = language === 'zh-CN' ? '数据库刷新失败，请重试。' : 'The database could not be refreshed. Try again.'
      await expect(page.locator('.app-notifications .app-notification-message').filter({ hasText: refreshError })).toHaveCount(1)
      await twoFrames(page)
      const manualFailed = await recordCell(page, app, info, language, language + '-' + kind + '-manual-read-failure-is-friendly-and-keeps-draft-focus')
      expect(manualFailed.state.value).toBe(rawDraft)
      expect(manualFailed.state.focused).toBe(true)
      expect(manualFailed.state.sameNode).toBe(true)
      expect(manualFailed.state.selection).toEqual(selection)
      expect(manualFailed.state.focusCalls).toEqual([])
      expect(manualFailed.state.messages).toContain(refreshError)
      expect(manualFailed.ipc.failedReads).toHaveLength(2)
      expect(manualFailed.ipc.failedReads[1]).toMatchObject({ channel: 'knowbook:get-database-entities', input: ids.databaseId,
        phase: 'dirty-refresh', kind: 'temporary-ipc-reply' })
      expect(manualFailed.ipc.requests).toEqual([expectedRequest(ids)])
      expect(manualFailed.ipc.writes).toEqual([expectedRequest(ids)])
      expect(manualFailed.stored).toEqual(recovered.stored)
      await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookWorkspaceRefresh!.phase = 'dirty-retry' })
      await refresh.click()
      await expect.poll(async () => (await mainState(app)).successfulReads.filter(read =>
        read.phase === 'dirty-retry' && read.channel === 'knowbook:get-database-entities').length).toBe(1)
      await expect(refresh).toBeVisible()
      await twoFrames(page)
      const dirtyRetried = await recordCell(page, app, info, language, language + '-' + kind + '-successful-pure-read-retry-keeps-whitespace-draft-and-selection', true)
      expect(dirtyRetried.state.value).toBe(rawDraft)
      expect(dirtyRetried.state.focused).toBe(true)
      expect(dirtyRetried.state.sameNode).toBe(true)
      expect(dirtyRetried.state.selection).toEqual(selection)
      expect(dirtyRetried.state.focusCalls).toEqual([])
      expect(dirtyRetried.state.source).toBe(initial.state.source)
      expect(dirtyRetried.state.selectedView).toBe(initial.state.selectedView)
      expect(dirtyRetried.state.query).toBe(initial.state.query)
      expect(dirtyRetried.ipc.readRequests.filter(read => read.phase === 'dirty-retry' && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId)).toHaveLength(1)
      expect(dirtyRetried.ipc.requests).toEqual([expectedRequest(ids)])
      expect(dirtyRetried.ipc.writes).toEqual([expectedRequest(ids)])
      expect(dirtyRetried.stored).toEqual(recovered.stored)
      await page.keyboard.press('Escape')
      await expect(input).toHaveValue('Beta')
      expect((await mainState(app)).requests).toEqual([expectedRequest(ids)])

      await page.reload()
      await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
      await expect(column(page, 'Beta').locator('.dbw-board-card')).toHaveCount(2)
      await twoFrames(page)
      const reloaded = await record(page, app, info, language, language + '-' + kind + '-recovery-survives-reload-with-complete-metadata-unchanged')
      expect(reloaded.state.targetGroup).toBe('Beta')
      expect(reloaded.state.query).toBe(initial.state.query)
      expect(reloaded.state.selectedView).toBe(initial.state.selectedView)
      expect(reloaded.state.source).toBe(initial.state.source)
      expect(reloaded.stored).toEqual(recovered.stored)
      expect(reloaded.ipc).toEqual(dirtyRetried.ipc)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
