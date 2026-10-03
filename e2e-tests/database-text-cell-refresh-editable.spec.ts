import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { DatabaseEntity, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type WriteHandler = (event: unknown, input: UpdateDatabaseEntityInput) => void | Promise<void>
type ReadHandler = (event: unknown, databaseId: string) => DatabaseEntity[] | Promise<DatabaseEntity[]>
type HeldRead = { event: unknown; databaseId: string; snapshot: DatabaseEntity[]; settled: boolean;
  resolve: (entities: DatabaseEntity[]) => void; reject: (error: Error) => void }
type MainProbe = { originalWrite: WriteHandler; originalRead: ReadHandler; databaseId: string; armed: boolean;
  requests: UpdateDatabaseEntityInput[]; writes: UpdateDatabaseEntityInput[];
  reads: Array<{ databaseId: string; held: boolean }>; held: HeldRead[] }
type ProbeGlobal = typeof globalThis & { __knowbookCellRefreshEditable?: MainProbe }
type EntitySnapshot = { databaseId: string; entities: DatabaseEntity[] }
type FocusCall = { marker: string | null; tag: string; activeAfter: boolean }
type RendererProbe = { calls: FocusCall[]; focusIns: Array<{ marker: string | null; tag: string }>;
  restore: () => void; twoFrames: () => Promise<void> }
type ProbeWindow = Window & { __knowbookCellRefreshEditable?: RendererProbe }
type Ids = { databaseId: string; fieldId: string; entityId: string }
const databaseName = 'Acknowledged text cell editing'
const recordTitle = 'Refresh edit A'
const otherRecordTitle = 'Refresh edit B'
const originalValue = 'Saved'
const valueA = 'Persisted A'
const valueB = 'New draft B'
const oldReadFailure = 'The delayed database snapshot could not be delivered.'

function currentCell(page: Page) {
  const row = page.locator('.dbw-table tbody tr').filter({ has: page.getByText(recordTitle, { exact: true }) })
  return { row, input: row.getByRole('textbox', { name: 'Notes', exact: true }), feedback: row.locator('.dbw-text-cell-feedback') }
}

async function seed(page: Page, language: 'en-US' | 'zh-CN'): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, databaseName, recordTitle, otherRecordTitle, originalValue }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: databaseName, description: 'Keep this database metadata unchanged.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const owner = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Hidden owner', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [field.id]: originalValue, [owner.id]: 'Keep the original owner' } })
    await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: otherRecordTitle,
      fieldValues: { [field.id]: 'Other notes remain unchanged', [owner.id]: 'Other owner remains unchanged' } })
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Editable text table', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id, owner.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id]
    } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { databaseId: database.id, fieldId: field.id, entityId: entity.id }
  }, { language, databaseName, recordTitle, otherRecordTitle, originalValue })
  await page.reload()
  await page.setViewportSize({ width: 760, height: 650 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(databaseName)
  await expect(currentCell(page).input).toHaveValue(originalValue)
  return ids
}

async function readStored(page: Page, language: 'en-US' | 'zh-CN', entitySnapshots?: EntitySnapshot[]) {
  return page.evaluate(async ({ language, entitySnapshots }) => {
    const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)
    const databases = (await window.knowbook.getDatabases()).sort(byId)
    const catalog = (await window.knowbook.getDocumentCatalog()).sort(byId)
    return { databases, catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: (await window.knowbook.listDocumentTemplates(language)).sort(byId),
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (entitySnapshots?.find(snapshot => snapshot.databaseId === database.id)?.entities
          ?? await window.knowbook.getDatabaseEntities(database.id)).sort(byId),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort(byId),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort(byId) }))) }
  }, { language, entitySnapshots })
}

async function installProbe(app: ElectronApplication, databaseId: string) {
  await app.evaluate(({ ipcMain }, databaseId) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, WriteHandler | ReadHandler> })._invokeHandlers
    const writeChannel = 'knowbook:update-database-entity', readChannel = 'knowbook:get-database-entities'
    const originalWrite = handlers.get(writeChannel) as WriteHandler | undefined
    const originalRead = handlers.get(readChannel) as ReadHandler | undefined
    if (!originalWrite || !originalRead) throw new Error('Real entity write and read handlers are required')
    const probe: MainProbe = { originalWrite, originalRead, databaseId, armed: false, requests: [], writes: [], reads: [], held: [] }
    ;(globalThis as ProbeGlobal).__knowbookCellRefreshEditable = probe
    ipcMain.removeHandler(writeChannel)
    ipcMain.handle(writeChannel, async (event, input: UpdateDatabaseEntityInput) => {
      probe.requests.push(structuredClone(input))
      await probe.originalWrite(event, input)
      probe.writes.push(structuredClone(input))
      if (probe.writes.length === 1) probe.armed = true
    })
    ipcMain.removeHandler(readChannel)
    ipcMain.handle(readChannel, async (event, id: string) => {
      const hold = probe.armed && id === probe.databaseId
      if (hold) probe.armed = false
      probe.reads.push({ databaseId: id, held: hold })
      const snapshot = await probe.originalRead(event, id)
      if (!hold) return snapshot
      // The real SQLite read already contains the accepted A value. Only its
      // IPC delivery is delayed; the renderer state and navigation are genuine.
      return new Promise<DatabaseEntity[]>((resolve, reject) => {
        probe.held.push({ event, databaseId: id, snapshot: structuredClone(snapshot), settled: false, resolve, reject })
      })
    })
  }, databaseId)
}

async function mainState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookCellRefreshEditable!
    return { requests: probe.requests, writes: probe.writes, reads: probe.reads,
      held: probe.held.map(({ databaseId, snapshot, settled }) => ({ databaseId, snapshot, settled })) }
  })
}

async function readDiskDirectly(app: ElectronApplication, databaseIds: string[]): Promise<EntitySnapshot[]> {
  return app.evaluate(async (_electron, databaseIds) => {
    const probe = (globalThis as ProbeGlobal).__knowbookCellRefreshEditable!
    const event = probe.held.find(read => !read.settled)?.event
    if (!event) throw new Error('A real pending IPC read event is required for authenticated store proof')
    return Promise.all(databaseIds.map(async databaseId => ({ databaseId,
      entities: await probe.originalRead(event, databaseId) })))
  }, databaseIds)
}

async function settleOldRead(app: ElectronApplication, fail: boolean) {
  await app.evaluate((_electron, fail) => {
    const probe = (globalThis as ProbeGlobal).__knowbookCellRefreshEditable!
    const read = probe.held.find(read => !read.settled)
    if (!read) throw new Error('One real A snapshot delivery must still be pending')
    read.settled = true
    setImmediate(() => {
      if (fail) read.reject(new Error('The delayed database snapshot could not be delivered.'))
      else read.resolve(structuredClone(read.snapshot))
    })
  }, fail)
}

async function installRendererProbe(page: Page) {
  await currentCell(page).input.evaluate(element => element.setAttribute('data-refresh-edit-owner', 'cell'))
  await page.evaluate(() => {
    const nativeFocus = HTMLElement.prototype.focus, nativeFrame = window.requestAnimationFrame.bind(window)
    const calls: FocusCall[] = [], focusIns: Array<{ marker: string | null; tag: string }> = []
    HTMLElement.prototype.focus = function (options) {
      const call = { marker: this.getAttribute('data-refresh-edit-owner'), tag: this.tagName, activeAfter: false }
      calls.push(call)
      nativeFocus.call(this, options)
      call.activeAfter = document.activeElement === this
    }
    const focusIn = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement) focusIns.push({ marker: target.getAttribute('data-refresh-edit-owner'), tag: target.tagName })
    }
    document.addEventListener('focusin', focusIn, true)
    ;(window as ProbeWindow).__knowbookCellRefreshEditable = { calls, focusIns,
      restore: () => { HTMLElement.prototype.focus = nativeFocus; document.removeEventListener('focusin', focusIn, true) },
      twoFrames: () => new Promise(resolve => nativeFrame(() => nativeFrame(() => resolve()))) }
  })
}

async function selectNativeRange(page: Page) {
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  for (let index = 0; index < 6; index++) await page.keyboard.press('Shift+ArrowRight')
}

function expectOnlyNotesChanged(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids, value: string) {
  const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  expect(saved).toMatchObject({ id: original.id, databaseId: original.databaseId, title: original.title,
    documentId: original.documentId, createdAt: original.createdAt })
  expect(saved.fieldValues).toEqual({ ...original.fieldValues, [ids.fieldId]: value })
  expect(after).toEqual({ ...before, sources: before.sources.map(source => source.id === ids.databaseId
    ? { ...source, entities: source.entities.map(entity => entity.id === ids.entityId ? saved : entity) } : source) })
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const ipc = await mainState(app)
  const state = await currentCell(page).input.evaluate(element => {
    const input = element as HTMLInputElement, row = input.closest('tr')!, port = input.closest('.dbw-table-scroll')!
    const box = input.getBoundingClientRect(), rowBox = row.getBoundingClientRect(), portBox = port.getBoundingClientRect()
    const left = Math.max(0, portBox.left + port.clientLeft), top = Math.max(0, portBox.top + port.clientTop)
    const right = Math.min(innerWidth, portBox.right), bottom = Math.min(innerHeight, portBox.bottom)
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      value: input.value, readOnly: input.readOnly, disabled: input.disabled, busy: input.getAttribute('aria-busy'),
      selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
      active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), isInput: document.activeElement === input },
      hasFocus: document.hasFocus(), rowHeight: rowBox.height,
      inputBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      ratio: Math.max(0, Math.min(box.right, right) - Math.max(box.left, left))
        * Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)) / (box.width * box.height),
      hit: hit === input, scrollTop: port.scrollTop,
      feedback: Array.from(row.querySelectorAll('.dbw-text-cell-feedback')).map(node => ({ text: node.textContent, role: node.getAttribute('role') })),
      source: document.querySelector('.dbw-source-trigger')?.textContent,
      query: document.querySelector<HTMLInputElement>('input[aria-label="Search records…"],input[aria-label="搜索记录…"]')?.value,
      calls: (window as ProbeWindow).__knowbookCellRefreshEditable?.calls ?? [],
      focusIns: (window as ProbeWindow).__knowbookCellRefreshEditable?.focusIns ?? [],
      notifications: Array.from(document.querySelectorAll('.app-notification-summary,.app-notification')).map(node => node.textContent) }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, ipc, state }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { ipc, state }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`acknowledged table text remains editable while its real read is pending in ${language} @electron`, async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      try {
      const ids = await seed(page, language)
      const before = await readStored(page, language)
      await installProbe(app, ids.databaseId)
      const cell = currentCell(page)
      await cell.input.fill(valueA)
      await expect(cell.input).toBeFocused()
      await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Tab')
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
      await expect.poll(async () => (await mainState(app)).held.filter(read => !read.settled).length).toBe(1)
      const direct = await readDiskDirectly(app, before.databases.map(database => database.id))
      const acknowledged = await readStored(page, language, direct)
      const originalEntity = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
      const savedEntity = acknowledged.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
      expect(savedEntity).toMatchObject({ id: originalEntity.id, databaseId: originalEntity.databaseId,
        title: originalEntity.title, documentId: originalEntity.documentId, createdAt: originalEntity.createdAt,
        fieldValues: { ...originalEntity.fieldValues, [ids.fieldId]: valueA } })
      expect(savedEntity.fieldValues).toEqual({ ...originalEntity.fieldValues, [ids.fieldId]: valueA })
      expect(acknowledged).toEqual({ ...before, sources: before.sources.map(source => source.id === ids.databaseId
        ? { ...source, entities: source.entities.map(entity => entity.id === ids.entityId ? savedEntity : entity) } : source) })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      // Store proof, native geometry and busy feedback are saved before the
      // editable oracle, so a failing old build still yields the actual cause.
      const pending = await record(page, app, info, `${language}-actual-write-ack-with-original-read-still-held`)
      expect(pending.ipc.requests).toEqual([{ entityId: ids.entityId, fieldValues: { [ids.fieldId]: valueA } }])
      expect(pending.ipc.writes).toEqual(pending.ipc.requests)
      expect(pending.ipc.held).toHaveLength(1)
      expect(pending.ipc.held[0].settled).toBe(false)
      expect(pending.ipc.held[0].snapshot.find(entity => entity.id === ids.entityId)?.fieldValues[ids.fieldId]).toBe(valueA)
      expect(pending.state.value).toBe(valueA)
      expect(pending.state.rowHeight).toBeCloseTo(64, 0)
      expect(pending.state.ratio).toBeCloseTo(1, 5)
      expect(pending.state.hit).toBe(true)
      await expect(cell.input).toBeEditable()
      await installRendererProbe(page)

      // Reading the acknowledged A value and leaving without any change does
      // not queue another write or another automatic read behind the held one.
      await cell.input.click()
      await expect(cell.input).toBeFocused()
      await page.keyboard.press(language === 'en-US' ? 'Enter' : 'Shift+Tab')
      await page.evaluate(() => (window as ProbeWindow).__knowbookCellRefreshEditable!.twoFrames())
      const unchanged = await record(page, app, info, `${language}-unchanged-acknowledged-a-does-not-write-again`)
      expect(unchanged.ipc.requests).toEqual(pending.ipc.requests)
      expect(unchanged.ipc.writes).toEqual(pending.ipc.writes)
      expect(unchanged.ipc.reads).toEqual(pending.ipc.reads)
      expect(unchanged.state.value).toBe(valueA)
      await expect(cell.input).toBeEditable()

      await cell.input.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.type(valueB)
      await expect(cell.input).toHaveValue(valueB)
      await selectNativeRange(page)
      await expect(cell.input).toBeFocused()
      const edited = await record(page, app, info, `${language}-native-b-draft-and-selection-while-a-read-is-held`)
      expect(edited.state.selection.slice(0, 2)).toEqual([2, 8])
      expect(edited.state.active.isInput).toBe(true)
      expect(edited.ipc.writes).toHaveLength(1)
      expect(edited.ipc.requests).toHaveLength(1)
      expect(edited.ipc.held.filter(read => !read.settled)).toHaveLength(1)
      expectOnlyNotesChanged(before, await readStored(page, language,
        await readDiskDirectly(app, before.databases.map(database => database.id))), ids, valueA)

      let beforeOldReply = edited
      if (language === 'zh-CN') {
        // B is actually written before A's original delivery fails. The newest
        // renderer read must wait for that physical per-cell read to finish.
        await page.keyboard.press('Enter')
        await expect.poll(async () => (await mainState(app)).writes.length).toBe(2)
        await page.evaluate(() => (window as ProbeWindow).__knowbookCellRefreshEditable!.twoFrames())
        const secondAck = await record(page, app, info, `${language}-b-write-ack-before-the-older-read-can-settle`)
        expect(secondAck.ipc.requests).toEqual([
          { entityId: ids.entityId, fieldValues: { [ids.fieldId]: valueA } },
          { entityId: ids.entityId, fieldValues: { [ids.fieldId]: valueB } }
        ])
        expect(secondAck.ipc.writes).toEqual(secondAck.ipc.requests)
        expect(secondAck.ipc.reads.filter(read => read.databaseId === ids.databaseId)).toEqual([{ databaseId: ids.databaseId, held: true }])
        expect(secondAck.ipc.held.filter(read => !read.settled)).toHaveLength(1)
        expect(secondAck.state.value).toBe(valueB)
        await expect(cell.input).toBeEditable()
        expectOnlyNotesChanged(before, await readStored(page, language,
          await readDiskDirectly(app, before.databases.map(database => database.id))), ids, valueB)
        await cell.input.click()
        await selectNativeRange(page)
        await expect(cell.input).toBeFocused()
        beforeOldReply = await record(page, app, info, `${language}-new-b-focus-owner-before-old-a-read-fails`)
        expect(beforeOldReply.state.selection.slice(0, 2)).toEqual([2, 8])
      }

      const inputHandle = await cell.input.elementHandle()
      expect(inputHandle).not.toBeNull()
      await settleOldRead(app, language === 'zh-CN')
      await expect.poll(async () => (await mainState(app)).held.filter(read => !read.settled).length).toBe(0)
      if (language === 'zh-CN') {
        await expect.poll(async () => (await mainState(app)).reads.filter(read => read.databaseId === ids.databaseId).length).toBe(2)
      }
      await expect(cell.feedback).toHaveCount(0)
      await page.evaluate(() => (window as ProbeWindow).__knowbookCellRefreshEditable!.twoFrames())
      const stale = await record(page, app, info, `${language}-old-a-read-${language === 'zh-CN' ? 'failure' : 'success'}-cannot-own-b`)
      expect(stale.state.value).toBe(valueB)
      expect(stale.state.selection).toEqual(beforeOldReply.state.selection)
      expect(stale.state.active.isInput).toBe(true)
      expect(await inputHandle!.evaluate(input => input.isConnected && document.activeElement === input)).toBe(true)
      expect(stale.state.calls.slice(beforeOldReply.state.calls.length)).toHaveLength(0)
      expect(stale.state.focusIns.slice(beforeOldReply.state.focusIns.length)).toHaveLength(0)
      expect(stale.ipc.writes).toEqual(beforeOldReply.ipc.writes)
      expect(stale.ipc.requests).toEqual(beforeOldReply.ipc.requests)
      await expect(cell.input).toBeEditable()
      await expect(cell.row.getByRole('alert')).toHaveCount(0)
      expect(stale.state.notifications.join(' ')).not.toContain(oldReadFailure)
      expect(stale.state.notifications.join(' ')).not.toContain(language === 'zh-CN'
        ? '记录已保存，但列表刷新失败，请刷新数据库。'
        : 'The record was saved, but the list could not be refreshed. Refresh the database.')
      await inputHandle!.dispose()

      if (language === 'en-US') {
        // The successful old A snapshot was discarded while B was still only
        // local. This ordinary Enter is the second and final actual mutation.
        expect(stale.ipc.reads.filter(read => read.databaseId === ids.databaseId)).toHaveLength(1)
        await page.keyboard.press('Enter')
        await expect.poll(async () => (await mainState(app)).writes.length).toBe(2)
      }
      await expect.poll(async () => (await mainState(app)).reads.filter(read => read.databaseId === ids.databaseId).length).toBe(2)
      await expect(cell.feedback).toHaveCount(0)
      await expect(cell.input).toHaveValue(valueB)
      await expect(cell.input).toBeEditable()
      await page.evaluate(() => (window as ProbeWindow).__knowbookCellRefreshEditable!.twoFrames())
      const finished = await record(page, app, info, `${language}-latest-b-refresh-follows-the-old-read-with-two-writes`)
      expect(finished.ipc.requests).toEqual([
        { entityId: ids.entityId, fieldValues: { [ids.fieldId]: valueA } },
        { entityId: ids.entityId, fieldValues: { [ids.fieldId]: valueB } }
      ])
      expect(finished.ipc.writes).toEqual(finished.ipc.requests)
      expect(finished.ipc.reads.filter(read => read.databaseId === ids.databaseId)).toEqual([
        { databaseId: ids.databaseId, held: true }, { databaseId: ids.databaseId, held: false }
      ])
      expect(finished.state.rowHeight).toBeCloseTo(64, 0)
      expect(finished.state.ratio).toBeCloseTo(1, 5)
      expect(finished.state.hit).toBe(true)
      expect(finished.state.query).toBe('')
      const finalStore = await readStored(page, language)
      expectOnlyNotesChanged(before, finalStore, ids, valueB)
      await page.evaluate(() => (window as ProbeWindow).__knowbookCellRefreshEditable!.restore())
      await page.reload()
      await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
      await expect(page.locator('.dbw-source-trigger')).toContainText(databaseName)
      await expect(cell.input).toHaveValue(valueB)
      await expect(cell.input).toBeEditable()
      await expect(cell.feedback).toHaveCount(0)
      expect(await readStored(page, language)).toEqual(finalStore)
      const reloaded = await record(page, app, info, `${language}-only-two-real-note-writes-persist-after-reload`)
      expect(reloaded.ipc.requests).toEqual(finished.ipc.requests)
      expect(reloaded.ipc.writes).toEqual(finished.ipc.writes)
      expect(errors).toEqual([])
      } finally {
        // A failing baseline never releases the read gate or fabricates a UI
        // reply; only this isolated app is closed by the background helper.
        await page.evaluate(() => (window as ProbeWindow).__knowbookCellRefreshEditable?.restore()).catch(() => undefined)
      }
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
