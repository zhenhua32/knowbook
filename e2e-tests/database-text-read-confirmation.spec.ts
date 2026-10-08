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
type Request = { channel: CellChannel; input: CellInput }
type ReadPhase = 'save' | 'header' | 'header-edit' | 'new-write'
type ReadAttempt = { channel: string; input: unknown; phase: ReadPhase }
type ReadHandler = (event: unknown, ...inputs: unknown[]) => unknown | Promise<unknown>
type MainProbe = { originals: Record<CellChannel, WriteHandler>; requests: Request[]; writes: Request[];
  failures: Array<Request & { message: string; stack: string }>; databaseId: string;
  phase: 'none' | ReadPhase; rejectReadReply: boolean; reads: ReadAttempt[]; completedReads: ReadAttempt[];
  failedReads: Array<ReadAttempt & { message: string; kind: 'temporary-ipc-reply' }>;
  holdNextRead: boolean; readGates: Array<{ attempt: ReadAttempt; settled: boolean; release: () => void }>;
  holdNextWrite: boolean; writeGates: Array<{ request: Request; settled: boolean; release: () => void }> }
type ProbeGlobal = typeof globalThis & { __knowbookTextReadConfirmation?: MainProbe }
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
      databaseId, phase: 'none', rejectReadReply: true, reads: [], completedReads: [], failedReads: [],
      holdNextRead: false, readGates: [], holdNextWrite: false, writeGates: [] }
    ;(globalThis as ProbeGlobal).__knowbookTextReadConfirmation = probe
    for (const channel of writeChannels) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, input: CellInput) => {
        const request = { channel, input: structuredClone(input) }
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
    const probe = (globalThis as ProbeGlobal).__knowbookTextReadConfirmation!
    if (finishPhase) probe.phase = 'none'
    return { requests: probe.requests, writes: probe.writes, failures: probe.failures, reads: probe.reads,
      completedReads: probe.completedReads, failedReads: probe.failedReads,
      readGates: probe.readGates.map(gate => ({ attempt: gate.attempt, settled: gate.settled })),
      writeGates: probe.writeGates.map(gate => ({ request: gate.request, settled: gate.settled })),
      countScope: 'Only actual cell save and Header refresh UI reads; subsequent authenticated artifact reads are excluded.' }
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
      sameNode: (window as unknown as { __readConfirmationInput?: HTMLInputElement }).__readConfirmationInput === input,
      focusCalls: (window as unknown as { __readConfirmationFocusCalls?: unknown[] }).__readConfirmationFocusCalls ?? [],
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

function expectedRequest(ids: Ids, value = draftValue): Request {
  return ids.kind === 'custom'
    ? { channel: 'knowbook:update-database-entity', input: { entityId: ids.recordId, fieldValues: { [ids.fieldId]: value } } }
    : { channel: 'knowbook:update-document-database-value', input: { documentId: ids.recordId, columnId: ids.fieldId, value } }
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

for (const language of ['en-US', 'zh-CN'] as const) {
  test('Header canonical read clears an acknowledged catalog cell refresh warning in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seed(page, language, 'catalog')
      const before = await readStored(page, app, language)
      const cell = currentCell(page)
      await installProbe(app, ids.databaseId)
      await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookTextReadConfirmation!.phase = 'save' })
      await cell.input.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.type(draftValue)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await mainState(app)).failedReads.length).toBe(1)
      const savedReadError = language === 'zh-CN' ? '记录已保存，但列表刷新失败，请刷新数据库。'
        : 'The record was saved, but the list could not be refreshed. Refresh the database.'
      await expect(cell.input).toHaveValue(draftValue)
      await expect(cell.input).toBeEditable()
      await expect(cell.feedback).toHaveText(savedReadError)
      await expect(cell.feedback).toHaveAttribute('role', 'status')
      await expect(cell.refresh).toBeVisible()
      await twoFrames(page)
      const failed = await record(page, app, info, language, language + '-real-catalog-ack-with-temporary-read-reply-failure')
      expect(failed.ipc.requests).toEqual([expectedRequest(ids)])
      expect(failed.ipc.writes).toEqual([expectedRequest(ids)])
      expect(failed.ipc.failures).toEqual([])
      expect(failed.ipc.failedReads).toHaveLength(1)
      expect(failed.ipc.failedReads[0]).toMatchObject({ channel: 'knowbook:get-database-entities', input: ids.databaseId,
        phase: 'save', kind: 'temporary-ipc-reply' })
      expectOnlyTargetFieldChanged(before, failed.stored, ids)
      expect(failed.state.rowHeight).toBeCloseTo(56, 0)
      expect(failed.state.ratio).toBeCloseTo(1, 5)
      expect(failed.state.hit).toBe(true)
      expect(failed.state.invalid).not.toBe('true')
      // Capture the existing failed-refresh cache while actually focused.
      // Header success must retire it even if this Editor never remounts.
      await cell.input.click()
      await page.keyboard.press('Home')
      for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight')
      let confirmedSelection = await cell.input.evaluate(element => {
        const input = element as HTMLInputElement
        const calls: Array<{ preventScroll: boolean | undefined }> = []
        const nativeFocus = HTMLElement.prototype.focus
        ;(window as unknown as { __readConfirmationInput: HTMLInputElement }).__readConfirmationInput = input
        ;(window as unknown as { __readConfirmationFocusCalls: typeof calls }).__readConfirmationFocusCalls = calls
        Object.defineProperty(input, 'focus', { configurable: true, value: function(this: HTMLInputElement, options?: FocusOptions) {
          calls.push({ preventScroll: options?.preventScroll })
          nativeFocus.call(this, options)
        } })
        return [input.selectionStart, input.selectionEnd, input.selectionDirection]
      })
      await app.evaluate((_electron, held) => {
        const probe = (globalThis as ProbeGlobal).__knowbookTextReadConfirmation!
        probe.rejectReadReply = false
        probe.phase = 'header'
        probe.holdNextRead = held
      }, language === 'zh-CN')
      await page.getByRole('button', { name: language === 'zh-CN' ? '刷新数据库' : 'Refresh database', exact: true }).click()
      const initialReadGateCount = language === 'zh-CN' ? 1 : 0
      const firstReadRaw = language === 'zh-CN' ? '  Held Delta raw  ' : draftValue
      if (language === 'zh-CN') {
        // This Header request captured the still-present saved-refresh error.
        // A new edit changes its owner before the authentic Beta reply returns.
        await expect.poll(async () => (await mainState(app)).readGates.length).toBe(1)
        await expect(cell.input).toBeFocused()
        await page.keyboard.press('Control+A')
        await page.keyboard.type(firstReadRaw)
        await page.keyboard.press('Home')
        for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight')
        confirmedSelection = await cell.input.evaluate(element => {
          const input = element as HTMLInputElement
          return [input.selectionStart, input.selectionEnd, input.selectionDirection]
        })
        const capturedErrorOwnerChanged = await record(page, app, info, language, language + '-old-saved-refresh-owner-captured-new-delta-draft-before-held-header-reply')
        expect(capturedErrorOwnerChanged.state.value).toBe(firstReadRaw)
        expect(capturedErrorOwnerChanged.state.focused).toBe(true)
        expect(capturedErrorOwnerChanged.state.sameNode).toBe(true)
        expect(capturedErrorOwnerChanged.state.selection).toEqual(confirmedSelection)
        expect(capturedErrorOwnerChanged.state.focusCalls).toEqual([])
        expect(capturedErrorOwnerChanged.ipc.requests).toEqual([expectedRequest(ids)])
        expect(capturedErrorOwnerChanged.ipc.writes).toEqual([expectedRequest(ids)])
        expect(capturedErrorOwnerChanged.ipc.readGates[0].settled).toBe(false)
        expect(capturedErrorOwnerChanged.stored).toEqual(failed.stored)
        await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookTextReadConfirmation!.readGates[0].release() })
      }
      await expect.poll(async () => (await mainState(app)).completedReads.filter(read =>
        read.phase === 'header' && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId).length).toBe(1)
      await twoFrames(page)
      const focusedConfirmed = await record(page, app, info, language, language + '-same-focused-editor-after-canonical-header-read-before-escape')
      expect(focusedConfirmed.state.sameNode).toBe(true)
      expect(focusedConfirmed.state.focused).toBe(true)
      expect(focusedConfirmed.state.value).toBe(firstReadRaw)
      expect(focusedConfirmed.state.selection).toEqual(confirmedSelection)
      expect(focusedConfirmed.state.focusCalls).toEqual([])
      expect(focusedConfirmed.stored).toEqual(failed.stored)
      expect(focusedConfirmed.ipc.requests).toEqual([expectedRequest(ids)])
      expect(focusedConfirmed.ipc.writes).toEqual([expectedRequest(ids)])
      await expect(cell.feedback).toHaveCount(0)
      await expect(cell.refresh).toHaveCount(0)
      await page.keyboard.press('Escape')
      await twoFrames(page)
      const escaped = await record(page, app, info, language, language + '-escape-cannot-restore-retired-refresh-warning-or-overlay')
      expect(escaped.state.sameNode).toBe(true)
      expect(escaped.state.value).toBe(draftValue)
      expect(escaped.state.feedback).toEqual([])
      expect(escaped.state.actions).toEqual([])
      expect(escaped.state.focusCalls).toEqual([])
      expect(escaped.stored).toEqual(failed.stored)
      expect(escaped.ipc).toEqual(focusedConfirmed.ipc)
      // Cards display the published record props, without a text-editor cache.
      // This proves the actual Header read was published, not just disk proof.
      await page.locator('.dbw-layout-switcher').getByRole('button', { name: uiText('Cards', '卡片'), exact: true }).click()
      const publishedCard = page.locator('.dbw-record-card').filter({ has: page.locator('strong[title]').filter({ hasText: new RegExp('^' + recordTitle + '$') }) })
      const publishedNotes = publishedCard.locator('dl > div').filter({ has: page.locator('dt').filter({ hasText: /^Notes$/ }) }).locator('dd')
      await expect(publishedNotes).toHaveText(draftValue)
      const publication = (await publishedNotes.textContent())!
      await page.locator('.dbw-layout-switcher').getByRole('button', { name: uiText('Table', '表格'), exact: true }).click()
      await expect(cell.input).toHaveValue(draftValue)
      await twoFrames(page)
      // Save authoritative read/publication/full-store evidence before the old
      // UI's stale refresh-failure/Refresh-action disappearance oracle.
      const confirmed = await record(page, app, info, language, language + '-actual-header-read-confirmed-beta-before-stale-cell-warning-oracle', publication)
      expect(confirmed.ipc.requests).toEqual([expectedRequest(ids)])
      expect(confirmed.ipc.writes).toEqual([expectedRequest(ids)])
      expect(confirmed.ipc.failures).toEqual([])
      expect(confirmed.ipc.failedReads).toEqual(failed.ipc.failedReads)
      expect(confirmed.ipc.reads.filter(read => read.phase === 'header' && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId)).toHaveLength(1)
      expect(confirmed.ipc.completedReads.filter(read => read.phase === 'header' && read.channel === 'knowbook:get-document-catalog-page').length).toBeGreaterThanOrEqual(1)
      expect(confirmed.stored).toEqual(failed.stored)
      expect(confirmed.state.source).toBe(failed.state.source)
      expect(confirmed.state.selectedView).toBe(failed.state.selectedView)
      expect(confirmed.state.query).toBe(failed.state.query)
      await expect(cell.feedback).toHaveCount(0)
      await expect(cell.refresh).toHaveCount(0)
      await expect(cell.input).not.toHaveAttribute('title', savedReadError)

      // A real Header read captures Beta before the user starts a new draft.
      // Neither its eventual publication nor a later read may retire that edit.
      const headerRefresh = page.getByRole('button', { name: language === 'zh-CN' ? '刷新数据库' : 'Refresh database', exact: true })
      await app.evaluate(() => {
        const probe = (globalThis as ProbeGlobal).__knowbookTextReadConfirmation!
        probe.phase = 'header-edit'
        probe.holdNextRead = true
      })
      await headerRefresh.click()
      await expect.poll(async () => (await mainState(app)).readGates.length).toBe(initialReadGateCount + 1)
      await cell.input.click()
      await page.keyboard.press('Control+A')
      const rawNextDraft = '  New Gamma raw  '
      const canonicalNextValue = rawNextDraft.trim()
      await page.keyboard.type(rawNextDraft)
      await page.keyboard.press('Home')
      for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight')
      const nextSelection = await cell.input.evaluate(element => {
        const input = element as HTMLInputElement
        const calls: Array<{ preventScroll: boolean | undefined }> = []
        const nativeFocus = HTMLElement.prototype.focus
        ;(window as unknown as { __readConfirmationInput: HTMLInputElement }).__readConfirmationInput = input
        ;(window as unknown as { __readConfirmationFocusCalls: typeof calls }).__readConfirmationFocusCalls = calls
        Object.defineProperty(input, 'focus', { configurable: true, value: function(this: HTMLInputElement, options?: FocusOptions) {
          calls.push({ preventScroll: options?.preventScroll })
          nativeFocus.call(this, options)
        } })
        return [input.selectionStart, input.selectionEnd, input.selectionDirection]
      })
      expect(nextSelection.slice(0, 2)).toEqual([0, 3])
      const duringRead = await record(page, app, info, language, language + '-new-native-whitespace-draft-while-original-beta-read-is-held')
      expect(duringRead.state.value).toBe(rawNextDraft)
      expect(duringRead.state.focused).toBe(true)
      expect(duringRead.state.selection).toEqual(nextSelection)
      expect(duringRead.ipc.requests).toEqual([expectedRequest(ids)])
      expect(duringRead.stored).toEqual(confirmed.stored)
      await app.evaluate((_electron, index) => { (globalThis as ProbeGlobal).__knowbookTextReadConfirmation!.readGates[index].release() }, initialReadGateCount)
      await expect(headerRefresh).not.toHaveAttribute('aria-busy', 'true')
      await expect(headerRefresh).toBeEnabled()
      await twoFrames(page)
      const newDraftPreserved = await record(page, app, info, language, language + '-old-header-read-preserves-new-draft-focus-and-selection')
      expect(newDraftPreserved.state.value).toBe(rawNextDraft)
      expect(newDraftPreserved.state.focused).toBe(true)
      expect(newDraftPreserved.state.sameNode).toBe(true)
      expect(newDraftPreserved.state.selection).toEqual(nextSelection)
      expect(newDraftPreserved.state.focusCalls).toEqual([])
      expect(newDraftPreserved.state.feedback).toEqual([])
      expect(newDraftPreserved.state.actions).toEqual([])
      expect(newDraftPreserved.ipc.requests).toEqual([expectedRequest(ids)])
      expect(newDraftPreserved.ipc.writes).toEqual([expectedRequest(ids)])
      expect(newDraftPreserved.stored).toEqual(confirmed.stored)

      // Hold another authenticated Beta reply and accept a new genuine write.
      // Finishing that old Header read must not unlock or clear the newer save.
      await app.evaluate(() => {
        const probe = (globalThis as ProbeGlobal).__knowbookTextReadConfirmation!
        probe.phase = 'header-edit'
        probe.holdNextRead = true
        probe.holdNextWrite = true
      })
      await headerRefresh.click()
      await expect.poll(async () => (await mainState(app)).readGates.length).toBe(initialReadGateCount + 2)
      await expect(cell.input).toBeFocused()
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await mainState(app)).writeGates.length).toBe(1)
      await expect(cell.input).not.toBeEditable()
      await app.evaluate((_electron, index) => { (globalThis as ProbeGlobal).__knowbookTextReadConfirmation!.readGates[index].release() }, initialReadGateCount + 1)
      await expect(headerRefresh).not.toHaveAttribute('aria-busy', 'true')
      await expect(headerRefresh).toBeEnabled()
      await twoFrames(page)
      const newerWritePending = await record(page, app, info, language, language + '-old-header-completion-cannot-release-new-native-write-lock')
      expect(newerWritePending.state.readOnly).toBe(true)
      expect(newerWritePending.state.value).toBe(rawNextDraft)
      expect(newerWritePending.state.sameNode).toBe(true)
      expect(newerWritePending.state.focusCalls).toEqual([])
      expect(newerWritePending.state.feedback).toHaveLength(1)
      expect(newerWritePending.state.feedback[0].role).toBe('status')
      expect(newerWritePending.ipc.requests).toEqual([expectedRequest(ids), expectedRequest(ids, canonicalNextValue)])
      expect(newerWritePending.ipc.writes).toEqual([expectedRequest(ids)])
      expect(newerWritePending.ipc.writeGates[0].settled).toBe(false)
      expect(newerWritePending.ipc.completedReads.filter(read => read.phase === 'header-edit' && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId)).toHaveLength(2)
      expect(newerWritePending.stored).toEqual(confirmed.stored)
      await app.evaluate(() => {
        const probe = (globalThis as ProbeGlobal).__knowbookTextReadConfirmation!
        probe.phase = 'new-write'
        probe.writeGates[0].release()
      })
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(2)
      await expect.poll(async () => (await mainState(app)).completedReads.filter(read => read.phase === 'new-write'
        && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId).length).toBe(1)
      await expect(cell.input).toBeEditable()
      await expect(cell.input).toHaveValue(canonicalNextValue)
      await expect(cell.feedback).toHaveCount(0)
      await expect(cell.refresh).toHaveCount(0)
      await twoFrames(page)
      const newSaved = await record(page, app, info, language, language + '-new-native-write-has-real-ack-and-its-own-authoritative-read')
      expect(newSaved.ipc.requests).toEqual([expectedRequest(ids), expectedRequest(ids, canonicalNextValue)])
      expect(newSaved.ipc.writes).toEqual([expectedRequest(ids), expectedRequest(ids, canonicalNextValue)])
      expect(newSaved.ipc.failures).toEqual([])
      expect(newSaved.ipc.failedReads).toEqual(failed.ipc.failedReads)
      expect(newSaved.ipc.completedReads.filter(read => read.phase === 'new-write' && read.channel === 'knowbook:get-database-entities' && read.input === ids.databaseId)).toHaveLength(1)
      expectOnlyTargetFieldChanged(confirmed.stored, newSaved.stored, ids, canonicalNextValue)
      await page.reload()
      await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
      await expect(cell.input).toHaveValue(canonicalNextValue)
      await expect(cell.feedback).toHaveCount(0)
      await expect(cell.refresh).toHaveCount(0)
      const reloaded = await record(page, app, info, language, language + '-read-confirmed-value-persists-without-extra-write')
      expect(reloaded.stored).toEqual(newSaved.stored)
      expect(reloaded.ipc).toEqual(newSaved.ipc)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
