import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Ids = { databaseId: string; entityId: string; doneId: string; notesId: string; viewId: string }
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Gate = { released: boolean; release?: () => void }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }>; gates: Gate[]; diagnosticReads: boolean;
  reads: Array<{ databaseId: string; failed: boolean }>; failNextRead: boolean; readGate?: Gate & { started: boolean; captured?: unknown } }
type ProbeGlobal = typeof globalThis & { __checkboxHitProbe?: Probe }
type SchemaRow = { name: string; [key: string]: unknown }
type EntityRow = { id: string; updated_at: string; [key: string]: unknown }
type ValueRow = { entity_id: string; column_id: string; value_text: string | null; updated_at: string; [key: string]: unknown }
const sourceName = 'Checkbox hit source'
const recordTitle = 'Original checkbox record'
const viewName = 'Original checkbox table'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function prepare(page: Page, language: Language): Promise<Ids> {
  const ids = await page.evaluate(async ({ language, sourceName, recordTitle, viewName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep original records, fields and view configuration.' })
    const done = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Done', type: 'checkbox' })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle,
      fieldValues: { [done.id]: false, [notes.id]: 'Original Notes' } })
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', done.id, notes.id], fieldOrder: ['__title__', done.id, notes.id],
      columnWidths: { __title__: 220, [done.id]: 160, [notes.id]: 160 }, cardFieldIds: [done.id, notes.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: viewName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { databaseId: database.id, entityId: entity.id, doneId: done.id, notesId: notes.id, viewId: view.id }
  }, { language, sourceName, recordTitle, viewName })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', viewName)
  await expect(page.locator('.dbw-main-search input')).toHaveValue('Original')
  await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
  return ids
}

async function installProbe(app: ElectronApplication, ids: Ids) {
  await app.evaluate(({ ipcMain }, ids) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [], gates: [], diagnosticReads: false, reads: [], failNextRead: false }
    ;(globalThis as ProbeGlobal).__checkboxHitProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        const request = { channel, input: structuredClone(input) }
        probe.requests.push(request)
        try {
          if (channel === 'knowbook:update-database-entity' && (input[0] as UpdateDatabaseEntityInput).entityId === ids.entityId) {
            // All accepted target writes wait before the real authenticated SQLite
            // handler, so evidence can prove both the accepted bool and unchanged disk.
            const gate: Gate = { released: false }
            probe.gates.push(gate)
            await new Promise<void>(resolve => { gate.release = resolve })
          }
          const result = await original(event, ...input)
          probe.writes.push(request)
          return result
        } catch (error) {
          probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) })
          throw error
        }
      })
    }
    const readChannel = 'knowbook:get-database-entities', originalRead = handlers.get(readChannel)
    if (!originalRead) throw new Error('The original authenticated database entities handler is required')
    ipcMain.removeHandler(readChannel)
    ipcMain.handle(readChannel, async (event, databaseId: string) => {
      const result = await originalRead(event, databaseId)
      if (databaseId === ids.databaseId && !probe.diagnosticReads) {
        const failed = probe.failNextRead
        probe.failNextRead = false
        if (failed && probe.readGate) {
          probe.readGate.started = true
          probe.readGate.captured = structuredClone(result)
          await new Promise<void>(resolve => { probe.readGate!.release = resolve })
        }
        probe.reads.push({ databaseId, failed })
        // The real authenticated GET succeeded; this fixture fails only its reply.
        if (failed) throw new Error('E2E temporary database entities IPC reply failure.')
      }
      return result
    })
  }, ids)
}

async function mainState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__checkboxHitProbe!
    return { requests: probe.requests, writes: probe.writes, failures: probe.failures,
      gates: probe.gates.map(gate => ({ released: gate.released })), reads: probe.reads,
      readGate: probe.readGate ? { started: probe.readGate.started, released: probe.readGate.released, captured: probe.readGate.captured } : null }
  })
}

async function clickAround(page: Page, target: Locator) {
  const initial = await target.boundingBox()
  expect(initial).not.toBeNull()
  await page.mouse.move(initial!.x + initial!.width / 2, initial!.y + initial!.height + 4)
  await twoFrames(page)
  const click = await target.evaluate(element => {
    const input = element as HTMLInputElement, rect = input.getBoundingClientRect()
    const x = rect.x + rect.width / 2, y = rect.bottom + 4
    const hit = document.elementFromPoint(x, y), owner = input.closest('td,article,.dbw-record-field')!
    const ownerRect = owner.getBoundingClientRect()
    return { x, y, bounds: rect.toJSON(), checkedBefore: input.checked,
      outsideNativeBox: y > rect.bottom, insideOwnerBox: x >= ownerRect.left && x < ownerRect.right && y >= ownerRect.top && y < ownerRect.bottom,
      ownerContainsHit: Boolean(hit && owner.contains(hit)),
      hit: hit instanceof HTMLElement ? { tag: hit.tagName, className: hit.className, label: hit.getAttribute('aria-label'), text: hit.textContent } : null }
  })
  expect(click.bounds.width).toBe(16)
  expect(click.bounds.height).toBe(16)
  expect(click.outsideNativeBox).toBe(true)
  expect(click.insideOwnerBox).toBe(true)
  expect(click.ownerContainsHit).toBe(true)
  // A genuine pointer click outside the painted 16px box. No label class,
  // synthetic click, focus repair, force, or implicit browser behavior is assumed.
  await page.mouse.click(click.x, click.y)
  await twoFrames(page)
  return click
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language,
  target: Locator, before: Awaited<ReturnType<typeof readStored>>, phase: string, click: unknown, unchanged = true) {
  const state = await target.evaluate(element => {
    const input = element as HTMLInputElement, rect = input.getBoundingClientRect()
    const row = input.closest('tr'), card = input.closest('.dbw-record-card'), form = input.closest('.dbw-record-form')
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
      view: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      notes: row?.querySelector<HTMLInputElement>('.catalog-cell-input[aria-label="Notes"]')?.value
        ?? form?.querySelector<HTMLInputElement>('.catalog-cell-input[aria-label="Notes"]')?.value
        ?? Array.from(card?.querySelectorAll('dd') ?? []).map(node => node.textContent).find(value => value === 'Original Notes'),
      layout: document.querySelector('.dbw-layout-switcher button[aria-pressed="true"]')?.getAttribute('aria-label'),
      checked: input.checked, disabled: input.disabled, focused: document.activeElement === input,
      busy: input.getAttribute('aria-busy'), ariaDisabled: input.getAttribute('aria-disabled'), bounds: rect.toJSON(), centerHit: hit === input,
      labelBounds: input.closest('label')?.getBoundingClientRect().toJSON() ?? null,
      labelTabIndex: input.closest('label')?.getAttribute('tabindex') ?? null,
      rowSelected: row?.classList.contains('is-selected') ?? null, cardSelected: card?.classList.contains('is-selected') ?? null,
      selectedCount: document.querySelectorAll('tbody tr.is-selected,.dbw-record-card.is-selected').length,
      drawerCount: document.querySelectorAll('.dbw-record-drawer').length,
      active: document.activeElement instanceof HTMLElement ? { tag: document.activeElement.tagName, text: document.activeElement.textContent,
        label: document.activeElement.getAttribute('aria-label'), className: document.activeElement.className } : null }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const ipc = await mainState(app), stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, click, state, windows, ipc, before, stored }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  if (unchanged) expect(stored).toEqual(before)
  expect(state.source).toBe(sourceName)
  expect(state.view).toBe(viewName)
  expect(state.query).toBe('Original')
  expect(state.notes).toBe('Original Notes')
  expect(state.disabled).toBe(false)
  return { state, ipc, stored }
}

async function releaseWrite(app: ElectronApplication, index: number) {
  await app.evaluate(({}, index) => {
    const gate = (globalThis as ProbeGlobal).__checkboxHitProbe!.gates[index]
    if (!gate?.release) throw new Error('The target write has not reached its real handler gate')
    gate.released = true
    gate.release()
  }, index)
}

async function armReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__checkboxHitProbe!
    probe.failNextRead = true
    probe.readGate = { started: false, released: false }
  })
}

async function releaseReadFailure(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as ProbeGlobal).__checkboxHitProbe!.readGate
    if (!gate?.release) throw new Error('The actual authenticated GET reply is not pending')
    gate.released = true
    gate.release()
  })
}

async function tabTo(page: Page, target: Locator) {
  const steps: Array<{ tag: string; label: string | null; text: string | null }> = []
  for (let index = 0; index < 24; index += 1) {
    if (await target.evaluate(element => element === document.activeElement)) return steps
    await page.keyboard.press('Tab')
    steps.push(await page.evaluate(() => ({ tag: document.activeElement?.tagName ?? '',
      label: document.activeElement?.getAttribute('aria-label') ?? null, text: document.activeElement?.textContent ?? null })))
  }
  await expect(target).toBeFocused()
  return steps
}

async function expectHitTarget(input: Locator) {
  const geometry = await input.evaluate(element => {
    const rect = element.getBoundingClientRect(), label = element.closest('label')
    const target = label?.getBoundingClientRect(), hit = target ? document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2) : null
    return { input: rect.toJSON(), target: target?.toJSON() ?? null, labelTabIndex: label?.getAttribute('tabindex') ?? null,
      centerHit: Boolean(label && hit && label.contains(hit)), sameControl: label?.control === element }
  })
  expect(geometry.input.width).toBe(16)
  expect(geometry.input.height).toBe(16)
  expect(geometry.target).not.toBeNull()
  expect(geometry.target!.width).toBe(32)
  expect(geometry.target!.height).toBe(32)
  expect(geometry.labelTabIndex).toBeNull()
  expect(geometry.sameControl).toBe(true)
  expect(geometry.centerHit).toBe(true)
  return geometry
}

function expectOnlyDoneSaved(before: Awaited<ReturnType<typeof readStored>>, after: Awaited<ReturnType<typeof readStored>>, ids: Ids, checked: boolean, touchedFields: readonly string[] = [ids.doneId]) {
  const original = before.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  const saved = after.sources.find(source => source.id === ids.databaseId)!.entities.find(entity => entity.id === ids.entityId)!
  expect(saved).toEqual({ ...original, fieldValues: { ...original.fieldValues, [ids.doneId]: checked }, updatedAt: saved.updatedAt })
  expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true)
  expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt))
  const storedValue = after.sql.values.find(value => value.entity_id === ids.entityId && value.column_id === ids.doneId)
  expect(storedValue).toBeDefined()
  expect(storedValue!.value_text).toBe(checked ? 'true' : 'false')
  expect(after).toEqual({ ...before,
    sources: before.sources.map(source => source.id !== ids.databaseId ? source : {
      ...source, entities: source.entities.map(entity => entity.id === ids.entityId ? saved : entity)
    }),
    sql: { ...before.sql,
      entities: before.sql.entities.map(entity => entity.id === ids.entityId ? { ...entity, updated_at: saved.updatedAt } : entity),
      values: before.sql.values.map(value => value.entity_id === ids.entityId && touchedFields.includes(value.column_id)
        ? { ...value, value_text: value.column_id === ids.doneId ? (checked ? 'true' : 'false') : value.value_text, updated_at: saved.updatedAt } : value)
    }
  })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('property checkbox surrounding pointer target accepts the bool in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(90_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language), before = await readStored(page, app, language)
      await installProbe(app, ids)
      const done = page.locator('tbody input[type="checkbox"][aria-label="Done"]')
      await expect(done).not.toBeChecked()
      const click = await clickAround(page, done)
      const accepted = await record(page, app, info, language, done, before,
        language + '-property-surrounding-pointer-before-bool-acceptance-oracle', click)
      expect(accepted.ipc.writes).toHaveLength(0)
      expect(accepted.ipc.failures).toHaveLength(0)
      expect(accepted.state.selectedCount).toBe(0)
      expect(accepted.state.drawerCount).toBe(0)
      expect(errors).toEqual([])
      // The old surrounding span has no activation behavior; record its actual
      // state first rather than waiting for a request that it never dispatches.
      expect(accepted.state.checked).toBe(true)
      expect(accepted.ipc.requests).toEqual([{ channel: 'knowbook:update-database-entity',
        input: [{ entityId: ids.entityId, fieldValues: { [ids.doneId]: true } }] }])
      expect(accepted.ipc.gates).toEqual([{ released: false }])
      await expectHitTarget(done)
      await expect(done).toBeFocused()
      const repeatClick = await clickAround(page, done)
      await page.locator('tbody .catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(done).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(done).toBeFocused()
      await page.keyboard.press('Space')
      await twoFrames(page)
      const pending = await record(page, app, info, language, done, before,
        language + '-pending-peripheral-repeat-and-native-space-remain-one-write', repeatClick)
      expect(pending.state.checked).toBe(true)
      expect(pending.state.focused).toBe(true)
      expect(pending.state.ariaDisabled).toBe('true')
      expect(pending.ipc.requests).toEqual(accepted.ipc.requests)
      expect(pending.ipc.writes).toHaveLength(0)
      expect(pending.ipc.reads).toHaveLength(0)

      const text = getDatabaseWorkspaceText(language), cell = done.locator('xpath=ancestor::td')
      const feedback = cell.locator('[role="alert"],[role="status"]')
      const refresh = cell.getByRole('button', { name: text.refresh, exact: true })
      await armReadFailure(app)
      await releaseWrite(app, 0)
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(1)
      await expect.poll(async () => (await mainState(app)).readGate?.started).toBe(true)
      await expect(done).toBeChecked()
      await expect(done).not.toHaveAttribute('aria-disabled', 'true')
      const acknowledged = await record(page, app, info, language, done, before,
        language + '-true-real-sqlite-ack-before-authenticated-get-reply', { kind: 'real-ack' }, false)
      expectOnlyDoneSaved(before, acknowledged.stored, ids, true)
      expect(acknowledged.ipc.requests).toEqual(accepted.ipc.requests)
      expect(acknowledged.ipc.writes).toEqual(accepted.ipc.requests)
      expect(acknowledged.ipc.readGate?.captured).toEqual(acknowledged.stored.sources.find(source => source.id === ids.databaseId)!.entities)
      await releaseReadFailure(app)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(1)
      await expect(feedback).toHaveText(text.savedRefreshFailed)
      await expect(refresh).toBeVisible()
      await expect(done).toBeChecked()
      const readFailed = await record(page, app, info, language, done, before,
        language + '-true-retained-after-authenticated-get-temporary-reply-failure', { kind: 'temporary-reply-failure' }, false)
      expectOnlyDoneSaved(before, readFailed.stored, ids, true)
      expect(readFailed.stored).toEqual(acknowledged.stored)
      expect(readFailed.ipc.requests).toEqual(accepted.ipc.requests)
      const refreshClick = await refresh.evaluate(button => {
        const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { kind: 'genuine-refresh-click', bounds: rect.toJSON(), centerHit: hit === button || Boolean(hit && button.contains(hit)),
          insideCheckboxLabel: Boolean(button.closest('label')) }
      })
      expect(refreshClick.centerHit).toBe(true)
      expect(refreshClick.insideCheckboxLabel).toBe(false)
      await refresh.click()
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(2)
      await expect(refresh).toHaveCount(0)
      await expect(done).toBeChecked()
      const refreshed = await record(page, app, info, language, done, before,
        language + '-refresh-is-read-only-and-never-retoggles-checkbox', refreshClick, false)
      expect(refreshed.stored).toEqual(acknowledged.stored)
      expect(refreshed.ipc.requests).toEqual(accepted.ipc.requests)
      expect(refreshed.ipc.writes).toEqual(accepted.ipc.requests)
      expect(refreshed.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true }, { databaseId: ids.databaseId, failed: false }])

      const cancelClick = await clickAround(page, done)
      await expect(done).not.toBeChecked()
      const cancelled = await record(page, app, info, language, done, before,
        language + '-surrounding-pointer-accepts-false-before-second-real-write', cancelClick, false)
      expect(cancelled.stored).toEqual(acknowledged.stored)
      const falseRequest = { channel: 'knowbook:update-database-entity', input: [{ entityId: ids.entityId, fieldValues: { [ids.doneId]: false } }] }
      expect(cancelled.ipc.requests).toEqual([...accepted.ipc.requests, falseRequest])
      expect(cancelled.ipc.writes).toEqual(accepted.ipc.requests)
      await releaseWrite(app, 1)
      await expect.poll(async () => (await mainState(app)).writes.length).toBe(2)
      await expect.poll(async () => (await mainState(app)).reads.length).toBe(3)
      await expect(feedback).toHaveCount(0)
      const falseSaved = await record(page, app, info, language, done, before,
        language + '-false-real-ack-keeps-an-explicit-sql-boolean-value', { kind: 'real-false-ack' }, false)
      expectOnlyDoneSaved(before, falseSaved.stored, ids, false)
      expect(falseSaved.ipc.writes).toEqual(cancelled.ipc.requests)

      const title = page.locator('tbody .dbw-record-title')
      await title.click()
      const drawer = page.locator('.dbw-record-drawer'), formDone = drawer.locator('input[type="checkbox"][aria-label="Done"]')
      await expect(drawer.getByRole('button', { name: text.close, exact: true })).toBeFocused()
      await expect(formDone).not.toBeChecked()
      const draftClick = await clickAround(page, formDone)
      await expect(formDone).toBeChecked()
      await expectHitTarget(formDone)
      const localDraft = await record(page, app, info, language, formDone, before,
        language + '-record-form-surrounding-click-only-changes-local-draft', draftClick, false)
      expect(localDraft.stored).toEqual(falseSaved.stored)
      expect(localDraft.ipc.requests).toEqual(cancelled.ipc.requests)
      await drawer.getByRole('button', { name: text.cancel, exact: true }).click()
      await expect(drawer).toHaveCount(0)
      const cancelledDraft = await record(page, app, info, language, done, before,
        language + '-record-form-cancel-has-no-third-write', { kind: 'genuine-form-cancel' }, false)
      expect(cancelledDraft.stored).toEqual(falseSaved.stored)
      expect(cancelledDraft.ipc.requests).toEqual(cancelled.ipc.requests)

      await title.click()
      await expect(drawer.getByRole('button', { name: text.close, exact: true })).toBeFocused()
      await expect(formDone).not.toBeChecked()
      const saveDraftClick = await clickAround(page, formDone)
      await expect(formDone).toBeChecked()
      await drawer.locator('.catalog-cell-input[aria-label="Notes"]').click()
      await page.keyboard.press('Shift+Tab')
      await expect(formDone).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(drawer.locator('.catalog-cell-input[aria-label="Notes"]')).toBeFocused()
      const retryDraft = await record(page, app, info, language, formDone, before,
        language + '-reopened-record-draft-has-one-native-checkbox-tab-stop', saveDraftClick, false)
      expect(retryDraft.stored).toEqual(falseSaved.stored)
      expect(retryDraft.ipc.requests).toEqual(cancelled.ipc.requests)
      await drawer.getByRole('button', { name: text.save, exact: true }).click()
      await expect.poll(async () => (await mainState(app)).gates.length).toBe(3)
      const formRequest = { channel: 'knowbook:update-database-entity', input: [{ entityId: ids.entityId, title: recordTitle,
        documentId: null, fieldValues: { [ids.doneId]: true, [ids.notesId]: 'Original Notes' } }] }
      expect((await mainState(app)).requests).toEqual([...cancelled.ipc.requests, formRequest])
      await releaseWrite(app, 2)
      await expect(drawer).toHaveCount(0)
      await expect(done).toBeChecked()
      const formSaved = await record(page, app, info, language, done, before,
        language + '-record-save-is-the-only-draft-write-and-protects-all-other-data', { kind: 'genuine-record-save' }, false)
      expectOnlyDoneSaved(before, formSaved.stored, ids, true, [ids.doneId, ids.notesId])
      expect(formSaved.ipc.requests).toEqual([...cancelled.ipc.requests, formRequest])
      expect(formSaved.ipc.writes).toEqual(formSaved.ipc.requests)
      expect(formSaved.ipc.failures).toHaveLength(0)
      expect(formSaved.ipc.reads).toEqual([{ databaseId: ids.databaseId, failed: true },
        { databaseId: ids.databaseId, failed: false }, { databaseId: ids.databaseId, failed: false }, { databaseId: ids.databaseId, failed: false }])
      expect(errors).toEqual([])
    })
  })

  test('table and card selection surrounding pointer targets select without opening records in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(90_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language), before = await readStored(page, app, language)
      await installProbe(app, ids)
      const selection = page.locator('tbody .dbw-select-column input[type="checkbox"]')
      await expect(selection).not.toBeChecked()
      const tableClick = await clickAround(page, selection)
      const table = await record(page, app, info, language, selection, before,
        language + '-table-surrounding-pointer-before-selection-oracle', tableClick)
      // A real native-box click clears any successfully accepted table selection
      // before the independent card case. No UI/cache or focus is injected.
      if (await selection.isChecked()) await selection.click()
      await expect(selection).not.toBeChecked()
      const text = getDatabaseWorkspaceText(language)
      await page.getByRole('group', { name: text.layout, exact: true }).getByRole('button', { name: text.cards, exact: true }).click()
      const cardSelection = page.locator('.dbw-card-grid input.dbw-card-checkbox')
      await expect(cardSelection).not.toBeChecked()
      const cardClick = await clickAround(page, cardSelection)
      const card = await record(page, app, info, language, cardSelection, before,
        language + '-cards-surrounding-pointer-before-selection-and-record-opening-oracles', cardClick)
      expect(table.ipc.requests).toHaveLength(0)
      expect(card.ipc.requests).toHaveLength(0)
      expect(table.ipc.writes).toHaveLength(0)
      expect(card.ipc.writes).toHaveLength(0)
      expect(card.ipc.failures).toHaveLength(0)
      expect(errors).toEqual([])
      // Both actual clicks and full unchanged SQLite/API snapshots are preserved
      // before the first old-version business failure can interrupt this case.
      expect(table.state.checked).toBe(true)
      expect(table.state.selectedCount).toBe(1)
      expect(table.state.drawerCount).toBe(0)
      expect(card.state.checked).toBe(true)
      expect(card.state.cardSelected).toBe(true)
      expect(card.state.selectedCount).toBe(1)
      expect(card.state.drawerCount).toBe(0)
      await expectHitTarget(cardSelection)
      const clearCardClick = await clickAround(page, cardSelection)
      await expect(cardSelection).not.toBeChecked()
      await expect(cardSelection).toBeFocused()
      await page.keyboard.press('Space')
      await expect(cardSelection).toBeChecked()
      await page.keyboard.press('Space')
      await expect(cardSelection).not.toBeChecked()
      const clearCard = await record(page, app, info, language, cardSelection, before,
        language + '-card-peripheral-cancel-and-native-space-do-not-open-details', clearCardClick)
      expect(clearCard.state.selectedCount).toBe(0)
      expect(clearCard.state.drawerCount).toBe(0)
      expect(clearCard.ipc.requests).toHaveLength(0)
      expect(clearCard.ipc.writes).toHaveLength(0)
      await page.keyboard.press('Tab')
      await expect(page.locator('.dbw-card-body')).toBeFocused()
      await page.getByRole('group', { name: text.layout, exact: true }).getByRole('button', { name: text.table, exact: true }).click()
      await expect(selection).not.toBeChecked()
      await expectHitTarget(selection)
      const tableTabRoute = await tabTo(page, selection)
      await page.keyboard.press('Space')
      await expect(selection).toBeChecked()
      await page.keyboard.press('Space')
      await expect(selection).not.toBeChecked()
      await page.keyboard.press('Tab')
      await expect(page.locator('tbody .dbw-record-title')).toBeFocused()
      const selectedAgainClick = await clickAround(page, selection)
      await expect(selection).toBeChecked()
      const selectedAgain = await record(page, app, info, language, selection, before,
        language + '-table-32px-label-and-original-native-tab-space-path-select', { tableTabRoute, selectedAgainClick })
      expect(selectedAgain.state.rowSelected).toBe(true)
      expect(selectedAgain.state.selectedCount).toBe(1)
      expect(selectedAgain.state.drawerCount).toBe(0)
      expect(selectedAgain.ipc.requests).toHaveLength(0)
      const clearTableClick = await clickAround(page, selection)
      await expect(selection).not.toBeChecked()
      const clearTable = await record(page, app, info, language, selection, before,
        language + '-table-surrounding-cancel-keeps-saved-config-and-all-data-unchanged', clearTableClick)
      expect(clearTable.state.rowSelected).toBe(false)
      expect(clearTable.state.selectedCount).toBe(0)
      expect(clearTable.state.drawerCount).toBe(0)
      expect(clearTable.ipc.requests).toHaveLength(0)
      expect(clearTable.ipc.writes).toHaveLength(0)
      expect(clearTable.ipc.failures).toHaveLength(0)
      expect(errors).toEqual([])
    })
  })
}
async function readStored(page: Page, app: ElectronApplication, language: Language) {
  // Evidence reads still delegate the real authenticated handler, but are
  // excluded from the UI refresh counter; no data or handler result is faked.
  await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__checkboxHitProbe; if (probe) probe.diagnosticReads = true })
  try {
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
        schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as SchemaRow[],
        columns: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all() as EntityRow[],
        values: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all() as ValueRow[],
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all(),
        views: database.prepare('SELECT * FROM database_saved_views ORDER BY id').all()
      } } finally { database.close() }
    })
    return { ...api, sql }
  } finally {
    await app.evaluate(() => { const probe = (globalThis as ProbeGlobal).__checkboxHitProbe; if (probe) probe.diagnosticReads = false })
  }
}
