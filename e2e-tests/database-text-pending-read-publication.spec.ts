import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { UpdateDatabaseEntityInput, UpdateDocumentDatabaseValueInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type SourceKind = 'custom' | 'catalog'
type CellChannel = 'knowbook:update-database-entity' | 'knowbook:update-document-database-value'
type CellInput = UpdateDatabaseEntityInput | UpdateDocumentDatabaseValueInput
type WriteHandler = (event: unknown, input: CellInput) => void | Promise<void>
type WriteOrigin = 'ui-save' | 'fixture-external'
type Request = { channel: CellChannel; input: CellInput; origin: WriteOrigin }
type ReadPhase = 'save' | 'old-cell' | 'header'
type ReadAttempt = { channel: string; input: unknown; phase: ReadPhase }
type ReadHandler = (event: unknown, ...inputs: unknown[]) => unknown | Promise<unknown>
type MainProbe = { originals: Record<CellChannel, WriteHandler>; requests: Request[]; writes: Request[];
  failures: Array<Request & { message: string; stack: string }>; databaseId: string; nextWriteOrigin: WriteOrigin;
  phase: 'none' | ReadPhase; rejectReadReply: boolean; reads: ReadAttempt[]; completedReads: ReadAttempt[];
  failedReads: Array<ReadAttempt & { message: string; kind: 'temporary-ipc-reply' }>;
  holdNextRead: boolean; readGates: Array<{ attempt: ReadAttempt; settled: boolean; release: () => void }>;
  holdNextWrite: boolean; writeGates: Array<{ request: Request; settled: boolean; release: () => void }> }
type ProbeGlobal = typeof globalThis & { __knowbookPendingReadPublication?: MainProbe }
type Ids = { kind: SourceKind; databaseId: string; fieldId: string; recordId: string }
type RawRow = Record<string, string | number | null>
type RawStores = { entities: RawRow[]; entityValues: RawRow[]; documentValues: RawRow[] }
const recordTitle = 'Read confirmation record A'
const otherRecordTitle = 'Read confirmation record B'
const originalValue = 'Alpha'
const draftValue = 'Beta'

function currentCell(page: Page) {
  const row = page.locator('.dbw-table tbody tr').filter({ has: page.getByText(recordTitle, { exact: true }) })
  return { row, input: row.getByRole('textbox', { name: 'Notes', exact: true }),
    feedback: row.locator('.dbw-text-cell-feedback'),
    refresh: row.getByRole('button', { name: uiText('Refresh', '刷新'), exact: true }) }
}

async function seed(page: Page, language: Language, kind: SourceKind): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, kind, recordTitle, otherRecordTitle, originalValue }) => {
    const database = kind === 'custom'
      ? await window.knowbook.createDocumentDatabase({ name: 'Read confirmation custom source', description: 'Keep source metadata unchanged.' })
      : (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')!
    if (!database) throw new Error('The real document catalog database is required')
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const owner = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Hidden owner', type: 'text' })
    let recordId: string
    if (kind === 'custom') {
      const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
        fieldValues: { [field.id]: originalValue, [owner.id]: 'Keep original owner' } })
      recordId = entity.id
      await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: otherRecordTitle,
        fieldValues: { [field.id]: 'Keep other notes', [owner.id]: 'Keep other owner' } })
    } else {
      const document = await window.knowbook.createDocument(null)
      recordId = document.id
      await window.knowbook.updateDocument(document.id, { title: recordTitle, summary: 'Preserve this document summary.',
        blocks: [{ type: 'paragraph', content: 'Keep original document content.', checked: false, depth: 0 }] })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: document.id, columnId: field.id, value: originalValue })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: document.id, columnId: owner.id, value: 'Keep original owner' })
      const other = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(other.id, { title: otherRecordTitle, summary: 'Keep the other summary.',
        blocks: [{ type: 'paragraph', content: 'Keep the other document content.', checked: false, depth: 0 }] })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: other.id, columnId: field.id, value: 'Keep other notes' })
      await window.knowbook.updateDocumentDatabaseValue({ documentId: other.id, columnId: owner.id, value: 'Keep other owner' })
    }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Read confirmation table', config: {
      version: 1, layout: 'table', query: 'Read confirmation record', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id, owner.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id]
    } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { kind, databaseId: database.id, fieldId: field.id, recordId }
  }, { language, kind, recordTitle, otherRecordTitle, originalValue })
  await page.reload()
  await page.setViewportSize({ width: 760, height: 650 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(currentCell(page).input).toHaveValue(originalValue)
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
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, ReadHandler> })._invokeHandlers
    const writeChannels: CellChannel[] = ['knowbook:update-database-entity', 'knowbook:update-document-database-value']
    const entityWrite = handlers.get(writeChannels[0]), documentWrite = handlers.get(writeChannels[1])
    if (!entityWrite || !documentWrite) throw new Error('The original authenticated value write handlers are required')
    const probe: MainProbe = { originals: { 'knowbook:update-database-entity': entityWrite as WriteHandler,
      'knowbook:update-document-database-value': documentWrite as WriteHandler }, requests: [], writes: [], failures: [],
      databaseId, nextWriteOrigin: 'ui-save', phase: 'none', rejectReadReply: true, reads: [], completedReads: [], failedReads: [],
      holdNextRead: false, readGates: [], holdNextWrite: false, writeGates: [] }
    ;(globalThis as ProbeGlobal).__knowbookPendingReadPublication = probe
    for (const channel of writeChannels) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, input: CellInput) => {
        const request: Request = { channel, input: structuredClone(input), origin: probe.nextWriteOrigin }
        probe.nextWriteOrigin = 'ui-save'
        probe.requests.push(request)
        try {
          if (probe.holdNextWrite) {
            probe.holdNextWrite = false
            let release!: () => void
            const pending = new Promise<void>(resolve => { release = resolve })
            const gate = { request, settled: false, release }
            probe.writeGates.push(gate)
            await pending
            gate.settled = true
          }
          await probe.originals[channel](event, input)
          probe.writes.push(request)
        } catch (error) {
          probe.failures.push({ ...request, message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack ?? '' : '' })
          throw error
        }
      })
    }
    for (const channel of ['knowbook:get-database-entities', 'knowbook:get-document-catalog-page']) {
      const original = handlers.get(channel)
      if (!original) throw new Error('The actual authenticated read handler is required: ' + channel)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...inputs: unknown[]) => {
        const phase = probe.phase
        const attempt: ReadAttempt | null = phase === 'none' ? null : { channel, input: structuredClone(inputs[0]), phase }
        if (attempt) probe.reads.push(attempt)
        // Execute the real GET with sender/senderFrame intact, then reject only
        // one IPC reply. This is explicitly not a simulated SQLite read error.
        const result = await original(event, ...inputs)
        if (attempt && channel === 'knowbook:get-database-entities' && inputs[0] === databaseId && probe.holdNextRead) {
          probe.holdNextRead = false
          let release!: () => void
          const pending = new Promise<void>(resolve => { release = resolve })
          const gate = { attempt, settled: false, release }
          probe.readGates.push(gate)
          await pending
          gate.settled = true
        }
        if (attempt && phase === 'save' && channel === 'knowbook:get-database-entities' && inputs[0] === databaseId &&
            probe.rejectReadReply && probe.writes.length === 1 && probe.failedReads.length === 0) {
          const message = 'The actual catalog read completed, but its IPC reply is temporarily unavailable.'
          probe.failedReads.push({ ...attempt, message, kind: 'temporary-ipc-reply' })
          throw new Error(message)
        }
        if (attempt) probe.completedReads.push(attempt)
        return result
      })
    }
  }, databaseId)
}

async function mainState(app: ElectronApplication, finishPhase = false) {
  return app.evaluate((_electron, finishPhase) => {
    const probe = (globalThis as ProbeGlobal).__knowbookPendingReadPublication!
    if (finishPhase) probe.phase = 'none'
    return { requests: probe.requests, writes: probe.writes, failures: probe.failures, reads: probe.reads,
      completedReads: probe.completedReads, failedReads: probe.failedReads,
      readGates: probe.readGates.map(gate => ({ attempt: gate.attempt, settled: gate.settled })),
      writeGates: probe.writeGates.map(gate => ({ request: gate.request, settled: gate.settled })),
      countScope: 'Only labelled actual save, held old inline Refresh, and newer Header Refresh UI reads; authenticated artifact reads and external writes are counted separately.' }
  }, finishPhase)
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string, publication?: string) {
  const ipc = await mainState(app, true)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const state = await currentCell(page).input.evaluate(element => {
    const input = element as HTMLInputElement, row = input.closest('tr')!, port = input.closest('.dbw-table-scroll')!
    const box = input.getBoundingClientRect(), portBox = port.getBoundingClientRect()
    const left = Math.max(0, portBox.left + port.clientLeft), top = Math.max(0, portBox.top + port.clientTop)
    const right = Math.min(innerWidth, portBox.right), bottom = Math.min(innerHeight, portBox.bottom)
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      value: input.value, readOnly: input.readOnly, invalid: input.getAttribute('aria-invalid'), title: input.title,
      rowHeight: row.getBoundingClientRect().height,
      ratio: Math.max(0, Math.min(box.right, right) - Math.max(box.left, left)) *
        Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)) / (box.width * box.height),
      hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input,
      selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
      focused: document.activeElement === input,
      sameNode: (window as unknown as { __pendingReadInput?: HTMLInputElement }).__pendingReadInput === input,
      focusCalls: (window as unknown as { __pendingReadFocusCalls?: unknown[] }).__pendingReadFocusCalls ?? [],
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      source: document.querySelector('.dbw-source-trigger')?.textContent,
      selectedView: document.querySelector('.dbw-view-tab-wrap.is-active')?.textContent,
      feedback: Array.from(row.querySelectorAll('.dbw-text-cell-feedback')).map(node => ({ text: node.textContent, role: node.getAttribute('role') })),
      actions: Array.from(input.closest('td')!.querySelectorAll('button')).map(button => button.textContent?.trim()),
      live: Array.from(document.querySelectorAll('.app-notifications .app-notification-message')).map(node => node.textContent) }
  })
  const stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, windows, ipc, state, publication, stored }, null, 2))
  await info.attach(phase + '-state', { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { ipc, state, stored }
}

function expectedRequest(ids: Ids, value = draftValue, origin: WriteOrigin = 'ui-save'): Request {
  return ids.kind === 'custom'
    ? { channel: 'knowbook:update-database-entity', input: { entityId: ids.recordId, fieldValues: { [ids.fieldId]: value } }, origin }
    : { channel: 'knowbook:update-document-database-value', input: { documentId: ids.recordId, columnId: ids.fieldId, value }, origin }
}

function expectOnlyTargetFieldChanged(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids, value = draftValue) {
  if (ids.kind === 'custom') {
    const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.recordId)!
    const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.recordId)!
    expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.fieldId]: value }, updatedAt: saved.updatedAt })
    expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt))
    const originalRawEntity = before.raw.entities.find(row => row.id === ids.recordId)!
    const savedRawEntity = after.raw.entities.find(row => row.id === ids.recordId)!
    expect(savedRawEntity).toEqual({ ...originalRawEntity, updated_at: saved.updatedAt })
    const originalRawValue = before.raw.entityValues.find(row => row.entity_id === ids.recordId && row.column_id === ids.fieldId)!
    const savedRawValue = after.raw.entityValues.find(row => row.entity_id === ids.recordId && row.column_id === ids.fieldId)!
    expect(savedRawValue).toEqual({ ...originalRawValue, value_text: value, updated_at: saved.updatedAt })
    expect(after).toEqual({ ...before, sources: before.sources.map(source => source.id === ids.databaseId
      ? { ...source, entities: source.entities.map(entity => entity.id === ids.recordId ? saved : entity) } : source),
      raw: { ...before.raw, entities: before.raw.entities.map(row => row.id === ids.recordId ? savedRawEntity : row),
        entityValues: before.raw.entityValues.map(row => row.entity_id === ids.recordId && row.column_id === ids.fieldId ? savedRawValue : row) } })
  } else {
    // Catalog records are documents, not database_entities. Their Notes value
    // must change while document content, paths and updatedAt remain identical.
    const original = before.catalog.find(document => document.id === ids.recordId)!
    const saved = after.catalog.find(document => document.id === ids.recordId)!
    expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.fieldId]: value } })
    const originalRawValue = before.raw.documentValues.find(row => row.document_id === ids.recordId && row.column_id === ids.fieldId)!
    const savedRawValue = after.raw.documentValues.find(row => row.document_id === ids.recordId && row.column_id === ids.fieldId)!
    expect(savedRawValue).toEqual({ ...originalRawValue, value_text: value, updated_at: savedRawValue.updated_at })
    expect(Date.parse(String(savedRawValue.updated_at))).toBeGreaterThanOrEqual(Date.parse(String(originalRawValue.updated_at)))
    expect(after).toEqual({ ...before, catalog: before.catalog.map(document => document.id === ids.recordId ? saved : document),
      raw: { ...before.raw, documentValues: before.raw.documentValues.map(row =>
        row.document_id === ids.recordId && row.column_id === ids.fieldId ? savedRawValue : row) } })
  }
}

async function recordPublication(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string) {
  const ipc = await mainState(app, true)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const publishedCard = page.locator('.dbw-record-card').filter({ has: page.locator('strong[title]').filter({ hasText: new RegExp('^' + recordTitle + '$') }) })
  const notes = publishedCard.locator('dl > div').filter({ has: page.locator('dt').filter({ hasText: /^Notes$/ }) }).locator('dd')
  const publication = await notes.textContent()
  const stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, windows, ipc, publication, stored }, null, 2))
  await info.attach(phase + '-state', { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { ipc, publication, stored }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  const authoritativeValue = language === 'zh-CN' ? 'Authoritative external C' : draftValue
  test('newer Header publication wins while an old inline cell reply is held in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seed(page, language, 'catalog')
      const before = await readStored(page, app, language)
      const cell = currentCell(page)
      const headerRefresh = page.getByRole('button', { name: language === 'zh-CN' ? '刷新数据库' : 'Refresh database', exact: true })
      await installProbe(app, ids.databaseId)
      await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookPendingReadPublication!.phase = 'save' })
      await cell.input.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.type(draftValue)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await mainState(app)).failedReads.length).toBe(1)
      const savedReadError = language === 'zh-CN' ? '记录已保存，但列表刷新失败，请刷新数据库。'
        : 'The record was saved, but the list could not be refreshed. Refresh the database.'
      await expect(cell.feedback).toHaveText(savedReadError)
      await expect(cell.refresh).toBeVisible()
      await expect(cell.input).toBeEditable()
      await twoFrames(page)
      const failed = await record(page, app, info, language, language + '-real-beta-save-and-temporary-ipc-reply-failure')
      const expectedWrites = [expectedRequest(ids)]
      expect(failed.ipc.requests).toEqual(expectedWrites)
      expect(failed.ipc.writes).toEqual(expectedWrites)
      expect(failed.ipc.failures).toEqual([])
      expect(failed.ipc.failedReads).toHaveLength(1)
      expect(failed.ipc.failedReads[0]).toMatchObject({ channel: 'knowbook:get-database-entities', input: ids.databaseId,
        phase: 'save', kind: 'temporary-ipc-reply' })
      expectOnlyTargetFieldChanged(before, failed.stored, ids)
      expect(failed.state.rowHeight).toBeCloseTo(64, 0)
      expect(failed.state.ratio).toBeCloseTo(1, 5)
      expect(failed.state.hit).toBe(true)

      await app.evaluate(() => {
        const probe = (globalThis as ProbeGlobal).__knowbookPendingReadPublication!
        probe.rejectReadReply = false
        probe.phase = 'old-cell'
        probe.holdNextRead = true
      })
      // The authenticated old GET actually executes against Beta before its
      // reply is held. No cache, renderer state, or response value is fabricated.
      await cell.refresh.click()
      await expect.poll(async () => (await mainState(app)).readGates.length).toBe(1)
      await expect(cell.input).toBeEditable()
      await cell.input.click()
      await page.keyboard.press('Home')
      for (let index = 0; index < 2; index++) await page.keyboard.press('Shift+ArrowRight')
      const selection = await cell.input.evaluate(element => {
        const input = element as HTMLInputElement, nativeFocus = HTMLElement.prototype.focus
        const calls: Array<{ preventScroll: boolean | undefined }> = []
        ;(window as unknown as { __pendingReadInput: HTMLInputElement }).__pendingReadInput = input
        ;(window as unknown as { __pendingReadFocusCalls: typeof calls }).__pendingReadFocusCalls = calls
        Object.defineProperty(input, 'focus', { configurable: true, value: function(this: HTMLInputElement, options?: FocusOptions) {
          calls.push({ preventScroll: options?.preventScroll })
          nativeFocus.call(this, options)
        } })
        return [input.selectionStart, input.selectionEnd, input.selectionDirection]
      })
      expect(selection.slice(0, 2)).toEqual([0, 2])
      const held = await record(page, app, info, language, language + '-old-authenticated-beta-read-held-and-original-input-focused')
      expect(held.ipc.readGates).toHaveLength(1)
      expect(held.ipc.readGates[0]).toMatchObject({ settled: false, attempt: { phase: 'old-cell', input: ids.databaseId } })
      expect(held.ipc.completedReads.filter(read => read.phase === 'old-cell' && read.channel === 'knowbook:get-database-entities')).toHaveLength(0)
      expect(held.ipc.completedReads.filter(read => read.phase === 'old-cell' && read.channel === 'knowbook:get-document-catalog-page').length).toBeGreaterThanOrEqual(1)
      expect(held.state.value).toBe(draftValue)
      expect(held.state.focused).toBe(true)
      expect(held.state.sameNode).toBe(true)
      expect(held.state.selection).toEqual(selection)
      expect(held.stored).toEqual(failed.stored)

      let authoritativeStored = failed.stored
      if (language === 'zh-CN') {
        // A genuine separate public IPC origin changes only this catalog value.
        // It runs after the old GET has captured B, so its late reply is stale.
        await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookPendingReadPublication!.nextWriteOrigin = 'fixture-external' })
        await page.evaluate(async ({ ids, authoritativeValue }) => {
          await window.knowbook.updateDocumentDatabaseValue({ documentId: ids.recordId, columnId: ids.fieldId, value: authoritativeValue })
        }, { ids, authoritativeValue })
        expectedWrites.push(expectedRequest(ids, authoritativeValue, 'fixture-external'))
        const external = await record(page, app, info, language, language + '-external-authenticated-c-after-old-beta-get')
        expect(external.ipc.requests).toEqual(expectedWrites)
        expect(external.ipc.writes).toEqual(expectedWrites)
        expect(external.ipc.readGates[0].settled).toBe(false)
        expectOnlyTargetFieldChanged(failed.stored, external.stored, ids, authoritativeValue)
        expect(external.state.value, 'an independent disk write does not pretend the renderer already published C').toBe(draftValue)
        authoritativeStored = external.stored
      }

      await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookPendingReadPublication!.phase = 'header' })
      // A real primary pointer click preserves the original input owner. This
      // newer complete Page GET is independent of the physically held cell GET.
      await headerRefresh.click()
      await expect.poll(async () => (await mainState(app)).completedReads.filter(read => read.phase === 'header'
        && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId).length).toBe(1)
      await expect(headerRefresh).not.toHaveAttribute('aria-busy', 'true')
      await expect(headerRefresh).toBeEnabled()
      await twoFrames(page)
      const published = await record(page, app, info, language, language + '-newer-header-published-while-original-input-and-old-reply-remain')
      expect(published.ipc.requests).toEqual(expectedWrites)
      expect(published.ipc.writes).toEqual(expectedWrites)
      expect(published.ipc.failures).toEqual([])
      expect(published.ipc.failedReads).toEqual(failed.ipc.failedReads)
      expect(published.ipc.readGates[0].settled).toBe(false)
      expect(published.ipc.completedReads.filter(read => read.phase === 'old-cell' && read.channel === 'knowbook:get-database-entities')).toHaveLength(0)
      expect(published.ipc.completedReads.filter(read => read.phase === 'header' && read.channel === 'knowbook:get-document-catalog-page').length).toBeGreaterThanOrEqual(1)
      expect(published.stored).toEqual(authoritativeStored)
      expect(published.state.focused).toBe(true)
      expect(published.state.sameNode).toBe(true)
      expect(published.state.focusCalls).toEqual([])
      if (language === 'en-US') expect(published.state.selection).toEqual(selection)
      expect(published.state.query).toBe(failed.state.query)
      expect(published.state.source).toBe(failed.state.source)
      expect(published.state.selectedView).toBe(failed.state.selectedView)

      // Exercise the original focused reading snapshot before any remount.
      // Escape must not revive its old overlay or action after Header commit,
      // while the old authenticated reply remains physically outstanding.
      await page.keyboard.press('Escape')
      await twoFrames(page)
      const originalEscaped = await record(page, app, info, language, language + '-original-focused-escape-before-cards-with-old-reply-still-held')
      expect(originalEscaped.ipc).toEqual(published.ipc)
      expect(originalEscaped.ipc.readGates[0].settled).toBe(false)
      expect(originalEscaped.stored).toEqual(authoritativeStored)
      expect(originalEscaped.state.sameNode).toBe(true)
      expect(originalEscaped.state.focusCalls).toEqual([])

      // Preserve the ORIGINAL focused Table snapshot above, then independently
      // prove canonical Page record props via Cards without releasing old GET.
      // The value/action oracle below is against the saved original snapshot,
      // never against a remounted input that could conceal the blocked overlay.
      await page.locator('.dbw-layout-switcher').getByRole('button', { name: uiText('Cards', '卡片'), exact: true }).click()
      const publication = await recordPublication(page, app, info, language, language + '-cards-prove-newer-page-publication-with-old-reply-still-held')
      expect(publication.publication).toBe(authoritativeValue)
      expect(publication.stored).toEqual(authoritativeStored)
      expect(publication.ipc).toEqual(published.ipc)
      expect(publication.ipc.readGates[0].settled).toBe(false)
      // Baseline: EN retains the stale reading/action; CN retains Beta even
      // though the newer genuine Page model and SQLite both contain C.
      expect(published.state.value, 'the original focused input must adopt the already-published canonical value before old reply release').toBe(authoritativeValue)
      expect(published.state.feedback, 'a confirmed newer publication must not keep the obsolete inline reading status').toEqual([])
      expect(published.state.actions, 'a confirmed newer publication must not retain an obsolete inline Refresh action').toEqual([])
      expect(originalEscaped.state.value, 'Escape on the original reading snapshot must keep the newer canonical value while the old reply is held').toBe(authoritativeValue)
      expect(originalEscaped.state.feedback).toEqual([])
      expect(originalEscaped.state.actions).toEqual([])

      await page.locator('.dbw-layout-switcher').getByRole('button', { name: uiText('Table', '表格'), exact: true }).click()
      await expect(cell.input).toHaveValue(authoritativeValue)
      await expect(cell.feedback).toHaveCount(0)
      await expect(cell.refresh).toHaveCount(0)
      await cell.input.click()
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+ArrowRight')
      const resumedSelection = await cell.input.evaluate(element => {
        const input = element as HTMLInputElement, nativeFocus = HTMLElement.prototype.focus
        const calls: Array<{ preventScroll: boolean | undefined }> = []
        ;(window as unknown as { __pendingReadInput: HTMLInputElement }).__pendingReadInput = input
        ;(window as unknown as { __pendingReadFocusCalls: typeof calls }).__pendingReadFocusCalls = calls
        Object.defineProperty(input, 'focus', { configurable: true, value: function(this: HTMLInputElement, options?: FocusOptions) {
          calls.push({ preventScroll: options?.preventScroll })
          nativeFocus.call(this, options)
        } })
        return [input.selectionStart, input.selectionEnd, input.selectionDirection]
      })
      await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookPendingReadPublication!.readGates[0].release() })
      await expect.poll(async () => (await mainState(app)).completedReads.filter(read => read.phase === 'old-cell'
        && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId).length).toBe(1)
      await twoFrames(page)
      const released = await record(page, app, info, language, language + '-late-old-beta-reply-cannot-revert-newer-publication-or-focus')
      expect(released.state.value).toBe(authoritativeValue)
      expect(released.state.feedback).toEqual([])
      expect(released.state.actions).toEqual([])
      expect(released.state.focused).toBe(true)
      expect(released.state.sameNode).toBe(true)
      expect(released.state.focusCalls).toEqual([])
      expect(released.state.selection).toEqual(resumedSelection)
      expect(released.ipc.requests).toEqual(expectedWrites)
      expect(released.ipc.writes).toEqual(expectedWrites)
      expect(released.ipc.failures).toEqual([])
      expect(released.ipc.readGates[0].settled).toBe(true)
      expect(released.stored).toEqual(authoritativeStored)
      await page.keyboard.press('Escape')
      await twoFrames(page)
      const escaped = await record(page, app, info, language, language + '-escape-after-late-reply-cannot-revive-old-beta-or-refresh')
      expect(escaped.state.value).toBe(authoritativeValue)
      expect(escaped.state.feedback).toEqual([])
      expect(escaped.state.actions).toEqual([])
      expect(escaped.state.focusCalls).toEqual([])
      expect(escaped.ipc).toEqual(released.ipc)
      expect(escaped.stored).toEqual(authoritativeStored)
      await page.reload()
      await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
      await expect(cell.input).toHaveValue(authoritativeValue)
      await expect(cell.feedback).toHaveCount(0)
      await expect(cell.refresh).toHaveCount(0)
      const reloaded = await record(page, app, info, language, language + '-reload-retains-only-the-genuine-value-writes-and-whole-metadata')
      expect(reloaded.ipc).toEqual(released.ipc)
      expect(reloaded.stored).toEqual(authoritativeStored)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
