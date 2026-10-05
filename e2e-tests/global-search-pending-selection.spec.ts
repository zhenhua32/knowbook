import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { GlobalSearchResult } from '../src/shared/contracts'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type SearchRead = { query: string; results: GlobalSearchResult[] | null; settled: boolean; replyFault?: boolean;
  resolve?: (results: GlobalSearchResult[]) => void; reject?: (error: Error) => void }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }>; reads: SearchRead[] }
type ProbeGlobal = typeof globalThis & { __globalSearchPendingProbe?: Probe }
type Language = 'en-US' | 'zh-CN'
type Fixture = { language: Language; width: number; height: number }
type ImeEvent = { type: string; key?: string; isComposing?: boolean; keyCode?: number; composing: boolean }
type RendererProbe = typeof window & { __pendingSearchIme?: { events: ImeEvent[]; composing: boolean } }
const targetBlock = 'pending-search-real-target-body', sourceTitle = 'Pending search original source'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function resize(page: Page, app: ElectronApplication, width: number, height: number) {
  const size = await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width, height }); return window.getContentSize()
  }, { width, height })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size)
  await expect.poll(() => page.locator('.sidebar').evaluate(element => {
    element.getBoundingClientRect()
    return element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' || animation.pending).length
  })).toBe(0)
  await frames(page)
}
async function readApi(page: Page, language: Language) {
  return page.evaluate(async language => {
    const catalog = (await window.knowbook.getDocumentCatalog()).sort((a, b) => a.id.localeCompare(b.id))
    const databases = (await window.knowbook.getDatabases()).sort((a, b) => a.id.localeCompare(b.id))
    return { catalog, databases, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: (await window.knowbook.listDocumentTemplates(language)).sort((a, b) => a.id.localeCompare(b.id)),
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort((a, b) => a.id.localeCompare(b.id)),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort((a, b) => a.id.localeCompare(b.id)),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort((a, b) => a.id.localeCompare(b.id)) }))) }
  }, language)
}
async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [], reads: [] }
    ;(globalThis as ProbeGlobal).__globalSearchPendingProbe = probe
    const channel = 'knowbook:search-documents', originalSearch = handlers.get(channel)
    if (!originalSearch) throw new Error('The original authenticated document search handler is required.')
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, query: string) => {
      const read: SearchRead = { query, results: null, settled: false }; probe.reads.push(read)
      // Execute the authenticated SQLite search first; only its genuine IPC
      // reply is delayed. The fixture does not fabricate a search result.
      read.results = await originalSearch(event, query) as GlobalSearchResult[]
      return new Promise<GlobalSearchResult[]>((resolve, reject) => { read.resolve = resolve; read.reject = reject })
    })
    for (const [name, original] of Array.from(handlers.entries())) if (/^knowbook:(create|update|delete|rename|move|save)-/.test(name)) {
      ipcMain.removeHandler(name); ipcMain.handle(name, async (event, ...input: unknown[]) => {
        const request = { channel: name, input: structuredClone(input) }; probe.requests.push(request)
        try { const result = await original(event, ...input); probe.writes.push(request); return result }
        catch (error) { probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) }); throw error }
      })
    }
  })
}
async function readMain(app: ElectronApplication) {
  return app.evaluate(({ app, BrowserWindow }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    const probe = (globalThis as ProbeGlobal).__globalSearchPendingProbe
    try { return { probe: { requests: probe?.requests ?? [], writes: probe?.writes ?? [], failures: probe?.failures ?? [],
        reads: (probe?.reads ?? []).map(({ query, results, settled, replyFault }) => ({ query, results, settled, replyFault: Boolean(replyFault) })) },
      windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(),
        contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(),
        visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
      sql: { schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        documents: database.prepare('SELECT * FROM documents ORDER BY id').all(), blocks: database.prepare('SELECT * FROM blocks ORDER BY id').all(),
        fields: database.prepare('SELECT * FROM document_database_columns ORDER BY id').all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        values: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all(),
        views: database.prepare('SELECT * FROM database_saved_views ORDER BY id').all() } }
    } finally { database.close() }
  })
}
async function release(app: ElectronApplication, index: number, replyFault = false) {
  await app.evaluate((_electron, { index, replyFault }) => {
    const read = (globalThis as ProbeGlobal).__globalSearchPendingProbe!.reads[index]
    if (!read || !read.results || !read.resolve || read.settled) throw new Error('One real captured search reply must still be held.')
    read.settled = true; read.replyFault = replyFault
    // A fault is an explicitly temporary IPC reply failure after the genuine
    // authenticated search succeeded, rather than a fabricated SQLite error.
    if (replyFault) read.reject!(new Error('E2E temporary document-search IPC reply failure'))
    else read.resolve(read.results)
  }, { index, replyFault })
}

async function nextRead(page: Page, app: ElectronApplication, query: string) {
  const index = (await readMain(app)).probe.reads.length
  await page.locator('.global-search-input').fill(query)
  await expect.poll(async () => {
    const read = (await readMain(app)).probe.reads[index]
    return Boolean(read?.query === query && read.results !== null)
  }).toBe(true)
  await frames(page)
  return index
}
type Stored = Awaited<ReturnType<typeof readApi>> & { sql: Awaited<ReturnType<typeof readMain>>['sql'] }
async function record(page: Page, app: ElectronApplication, info: TestInfo, before: Stored, fixture: Fixture, phase: string) {
  const state = await page.evaluate(() => {
    const palette = document.querySelector<HTMLDialogElement>('.global-search-modal'), input = palette?.querySelector<HTMLInputElement>('.global-search-input')
    const bounds = palette?.getBoundingClientRect(), active = document.activeElement
    return { viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme,
      header: document.querySelector('.document-header-title')?.textContent ?? null,
      targetPresent: Boolean(document.querySelector('[data-block-id="pending-search-real-target-body"]')),
      paletteCount: document.querySelectorAll('.global-search-modal').length, paletteOpen: palette?.open ?? false,
      paletteBox: bounds ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height } : null,
      query: input?.value ?? null, inputFocused: input === active, activeDescendant: input?.getAttribute('aria-activedescendant') ?? null,
      listBusy: palette?.querySelector('[role="listbox"]')?.getAttribute('aria-busy') ?? null,
      recoveryCount: palette?.querySelectorAll('.recovery-state').length ?? 0,
      templateDialogCount: document.querySelectorAll('.document-template-dialog').length,
      settingsVisible: Boolean(document.querySelector('.page-settings')),
      active: { tag: active?.tagName ?? null, text: active?.textContent ?? null, insidePalette: Boolean(palette?.contains(active)) },
      selected: Array.from(palette?.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]') ?? []).map(element => ({
        id: element.id, command: element.classList.contains('palette-command'), title: element.querySelector('strong')?.textContent ?? null })),
      options: Array.from(palette?.querySelectorAll<HTMLElement>('[role="option"]') ?? []).map(element => ({ id: element.id,
        command: element.classList.contains('palette-command'), title: element.querySelector('strong')?.textContent ?? null,
        selected: element.getAttribute('aria-selected'), disabled: element.matches(':disabled') })),
      status: Array.from(palette?.querySelectorAll<HTMLElement>('[role="status"]') ?? []).map(element => element.textContent),
      ime: (window as RendererProbe).__pendingSearchIme ?? null }
  })
  const api = await readApi(page, fixture.language), main = await readMain(app)
  const result = { phase, fixture, state, ...main, before, stored: { ...api, sql: main.sql } }
  const path = info.outputPath(`${phase}.json`); writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' }); await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function background(value: Evidence) {
  expect(value.windows).toHaveLength(1); const window = value.windows[0]
  expect(window.bounds).toMatchObject({ width: value.fixture.width, height: value.fixture.height }); expect(window.minimumSize).toEqual([760, 760])
  expect(value.state.viewport).toEqual(window.contentSize); expect(window.contentSize).toEqual([window.contentBounds.width, window.contentBounds.height])
  expect(value.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
}
function unchanged(value: Evidence) {
  background(value); expect(value.probe.requests).toEqual([]); expect(value.probe.writes).toEqual([])
  expect(value.probe.failures).toEqual([]); expect(value.stored).toEqual(value.before)
}

async function prepare(page: Page, app: ElectronApplication, fixture: Fixture) {
  const targetTitle = fixture.language === 'zh-CN' ? '新建文档' : 'New document'
  const settingsTitle = fixture.language === 'zh-CN' ? '配置中心' : 'Settings'
  const ids = await page.evaluate(async ({ targetTitle, settingsTitle, targetBlock, sourceTitle, language }) => {
      const target = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(target.id, { title: targetTitle, summary: 'Original exact-name document, not a create command.',
        blocks: [{ id: targetBlock, type: 'paragraph', content: 'Original exact-name target content remains unchanged.', checked: false, depth: 0 }] })
      const settings = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(settings.id, { title: settingsTitle, summary: 'Original command-name compatibility document.',
        blocks: [{ id: 'pending-search-settings-body', type: 'paragraph', content: 'Original compatibility destination content.', checked: false, depth: 0 }] })
      const source = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(source.id, { title: sourceTitle, summary: 'Original unrelated source summary.',
        blocks: [{ id: 'pending-search-source-body', type: 'paragraph', content: 'Original source content remains unchanged.', checked: false, depth: 0 }] })
      await window.knowbook.saveSetting('ui.language', language)
      await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
      return { target: target.id, source: source.id, settings: settings.id }
    }, { targetTitle, settingsTitle, targetBlock, sourceTitle, language: fixture.language })
    await page.reload(); await resize(page, app, fixture.width, fixture.height)
    await page.locator('.tree-button').filter({ hasText: sourceTitle }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(sourceTitle)
    await expect(page.locator('[data-block-id="pending-search-source-body"] textarea')).toHaveValue('Original source content remains unchanged.')
    const before: Stored = { ...await readApi(page, fixture.language), sql: (await readMain(app)).sql }
    await installProbe(app)
    return { ids, before, targetTitle, settingsTitle }
}

for (const language of ['en-US', 'zh-CN'] as const) for (const width of [1360, 760]) {
  const fixture: Fixture = { language, width, height: width === 760 ? 760 : 800 }
  test(`Ordinary pending search Enter cannot run a default command instead of the matching document ${language} native ${width} @electron`, async ({}, info) => {
    test.setTimeout(120000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const { ids, before, targetTitle, settingsTitle } = await prepare(page, app, fixture)
    await page.keyboard.press(`${mod}+k`)
    const palette = page.locator('.global-search-modal'), input = palette.locator('.global-search-input')
    await expect(input).toBeFocused(); await input.fill(targetTitle)
    await expect.poll(async () => (await readMain(app)).probe.reads[0]?.results?.some(result => result.documentId === ids.target) ?? false).toBe(true)
    await frames(page)
    const pending = await record(page, app, info, before, fixture, 'authenticated-exact-name-search-held-before-enter')
    unchanged(pending); expect(pending.probe.reads).toHaveLength(1); expect(pending.probe.reads[0].settled).toBe(false)
    expect(pending.state).toMatchObject({ paletteOpen: true, query: targetTitle, inputFocused: true, header: sourceTitle })
    // Capture the real old-build command side effect before the first strict
    // business oracle, rather than stopping at its selected-option appearance.
    await page.keyboard.press('Enter'); await frames(page)
    const entered = await record(page, app, info, before, fixture, 'ordinary-enter-while-authenticated-search-reply-is-held')
    background(entered)
    expect(entered.probe.requests, 'A pending ordinary query must not implicitly create or update any document.').toEqual([])
    unchanged(entered); expect(entered.probe.reads[0].settled).toBe(false)
    expect(pending.state.selected).toEqual([]); expect(pending.state.activeDescendant).toBeNull()
    expect(entered.state).toMatchObject({ paletteOpen: true, query: targetTitle, inputFocused: true, activeDescendant: null })
    expect(entered.state.selected).toEqual([])
    expect(entered.state.listBusy).toBe('true')
    for (const key of ['Enter', 'Control+Enter', 'Meta+Enter', 'Enter']) await page.keyboard.press(key)
    await frames(page)
    const repeated = await record(page, app, info, before, fixture, 'repeated-enter-and-control-meta-enter-do-not-execute-a-pending-command')
    unchanged(repeated); expect(repeated.probe.reads).toHaveLength(1)
    expect(repeated.state).toMatchObject({ paletteOpen: true, query: targetTitle, inputFocused: true, activeDescendant: null, listBusy: 'true' })
    expect(repeated.state.selected).toEqual([])
    await release(app, 0)
    await expect(palette.locator('.global-search-result[aria-selected="true"] .global-search-doc-title')).toHaveText(targetTitle)
    const released = await record(page, app, info, before, fixture, 'real-search-reply-selects-the-existing-same-id-document'); unchanged(released)
    expect(released.probe.reads[0].results?.some(result => result.documentId === ids.target)).toBe(true)
    expect(released.state.activeDescendant).toBeTruthy(); expect(released.state.selected).toHaveLength(1)
    expect(released.state.selected[0]).toMatchObject({ command: false, title: targetTitle })
    await page.keyboard.press('Enter'); await expect(palette).toHaveCount(0)
    await expect(page.locator('.document-header-title')).toHaveText(targetTitle)
    await expect(page.locator(`[data-block-id="${targetBlock}"] textarea`)).toHaveValue('Original exact-name target content remains unchanged.')
    const opened = await record(page, app, info, before, fixture, 'real-enter-opens-the-existing-document-without-mutation'); unchanged(opened)
    expect(opened.state.targetPresent).toBe(true); expect(opened.state.header).toBe(targetTitle)

    await page.keyboard.press(`${mod}+k`)
    const oldQuery = await nextRead(page, app, targetTitle)
    await page.keyboard.press('ArrowDown')
    await expect(palette.locator('.palette-command[aria-selected="true"]')).toHaveCount(1)
    const currentQuery = await nextRead(page, app, settingsTitle)
    await release(app, oldQuery); await frames(page)
    const staleQuery = await record(page, app, info, before, fixture, 'old-query-reply-cannot-restore-an-explicit-command-for-the-new-query')
    unchanged(staleQuery); expect(staleQuery.probe.reads[oldQuery].settled).toBe(true)
    expect(staleQuery.probe.reads[currentQuery].settled).toBe(false)
    expect(staleQuery.state).toMatchObject({ query: settingsTitle, activeDescendant: null, listBusy: 'true', inputFocused: true })
    expect(staleQuery.state.selected).toEqual([]); await expect(palette.locator('.global-search-result')).toHaveCount(0)

    await page.keyboard.press('Escape'); await expect(palette).toHaveCount(0)
    await page.keyboard.press(`${mod}+k`)
    const reopenedRead = await nextRead(page, app, targetTitle)
    await release(app, currentQuery); await frames(page)
    await page.keyboard.press('Control+Enter'); await page.keyboard.press('Meta+Enter'); await frames(page)
    const reopened = await record(page, app, info, before, fixture, 'closed-search-reply-cannot-select-or-execute-in-the-reopened-palette')
    unchanged(reopened); expect(reopened.probe.reads[reopenedRead].settled).toBe(false)
    expect(reopened.state).toMatchObject({ paletteOpen: true, query: targetTitle, activeDescendant: null, inputFocused: true, listBusy: 'true' })
    expect(reopened.state.selected).toEqual([]); await expect(palette.locator('.global-search-result')).toHaveCount(0)
    await release(app, reopenedRead)
    await expect(palette.locator('.global-search-result[aria-selected="true"] .global-search-doc-title')).toHaveText(targetTitle)
    await page.keyboard.press('Enter'); await expect(palette).toHaveCount(0)
    await expect(page.locator('.document-header-title')).toHaveText(targetTitle)
    const final = await record(page, app, info, before, fixture, 'only-the-reopened-current-query-opens-the-real-same-id-document')
    unchanged(final); expect(final.state.targetPresent).toBe(true)
    expect(final.probe.reads).toHaveLength(4); expect(final.probe.reads.every(read => read.settled && !read.replyFault)).toBe(true)
    expect(errors).toEqual([])
    })
  })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  const fixture: Fixture = { language, width: 1360, height: 800 }
  test(`Explicit commands, stable selection and failed-search retry remain usable ${language} @electron`, async ({}, info) => {
    test.setTimeout(150000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const { before, ids, settingsTitle } = await prepare(page, app, fixture)
      const palette = page.locator('.global-search-modal'), input = palette.locator('.global-search-input')
      const selected = palette.locator('[role="option"][aria-selected="true"]')
      await page.keyboard.press(`${mod}+k`)
      const downRead = await nextRead(page, app, 'new')
      await expect(selected).toHaveCount(0); await page.keyboard.press('ArrowDown')
      const down = await record(page, app, info, before, fixture, 'explicit-arrow-down-selects-the-first-enabled-command-while-pending')
      unchanged(down); expect(down.state.selected).toHaveLength(1)
      expect(down.state.selected[0].id).toBe(down.state.options.filter(option => !option.disabled)[0].id)
      const upRead = await nextRead(page, app, 'create')
      await expect(selected).toHaveCount(0); await page.keyboard.press('ArrowUp')
      const up = await record(page, app, info, before, fixture, 'explicit-arrow-up-selects-the-last-enabled-command-with-no-previous-selection')
      unchanged(up); expect(up.state.selected).toHaveLength(1)
      const available = up.state.options.filter(option => !option.disabled)
      expect(available.length).toBeGreaterThan(1); expect(up.state.selected[0].id).toBe(available[available.length - 1].id)
      await release(app, downRead); await release(app, upRead); await frames(page)

      const pointerRead = await nextRead(page, app, settingsTitle)
      const settingsCommand = palette.locator('.palette-command').filter({ has: page.getByText(settingsTitle, { exact: true }) })
      if (language === 'en-US') await settingsCommand.hover()
      else await page.keyboard.press('ArrowDown')
      await expect(settingsCommand).toHaveAttribute('aria-selected', 'true')
      await page.mouse.move(0, 0)
      await release(app, pointerRead)
      await expect(palette.locator('.global-search-result')).toHaveCount(1)
      const stable = await record(page, app, info, before, fixture, language === 'en-US'
        ? 'hover-chosen-command-keeps-its-identity-when-the-real-document-result-is-inserted'
        : 'arrow-chosen-command-keeps-its-identity-when-the-real-document-result-is-inserted')
      unchanged(stable); expect(stable.probe.reads[pointerRead].results?.some(result => result.documentId === ids.settings)).toBe(true)
      expect(stable.state.selected).toHaveLength(1); expect(stable.state.selected[0]).toMatchObject({ command: true, title: settingsTitle })
      if (language === 'en-US') await settingsCommand.click()
      else await page.keyboard.press('Enter')
      await expect(palette).toHaveCount(0); await expect(page.locator('.page-settings')).toBeVisible()
      const pointer = await record(page, app, info, before, fixture, 'explicit-pointer-or-arrow-enter-command-activation-navigates-without-writing'); unchanged(pointer)

      // Loading suppresses an implicit command, but a real Arrow selection
      // remains executable before the authenticated search reply is released.
      await page.keyboard.press(`${mod}+k`)
      const pendingCommandRead = await nextRead(page, app, settingsTitle)
      await page.keyboard.press('ArrowDown'); await expect(selected.locator('strong')).toHaveText(settingsTitle)
      await page.keyboard.press('Enter'); await expect(palette).toHaveCount(0); await expect(page.locator('.page-settings')).toBeVisible()
      const pendingCommand = await record(page, app, info, before, fixture, 'explicit-arrow-enter-command-executes-while-the-real-search-reply-is-still-held')
      unchanged(pendingCommand); expect(pendingCommand.probe.reads[pendingCommandRead]).toMatchObject({ query: settingsTitle, settled: false, replyFault: false })
      expect(pendingCommand.probe.reads[pendingCommandRead].results?.some(result => result.documentId === ids.settings)).toBe(true)
      expect(pendingCommand.state).toMatchObject({ paletteCount: 0, settingsVisible: true })
      await release(app, pendingCommandRead); await frames(page)
      const lateCommand = await record(page, app, info, before, fixture, 'late-reply-after-explicit-pending-command-cannot-reopen-or-execute')
      unchanged(lateCommand); expect(lateCommand.probe.reads[pendingCommandRead].settled).toBe(true)
      expect(lateCommand.state).toMatchObject({ paletteCount: 0, settingsVisible: true })

      const readsBeforeCommandMode = lateCommand.probe.reads.length
      await page.keyboard.press(`${mod}+Shift+p`); await expect(input).toHaveValue('>')
      await input.fill('> settings'); await expect(selected.locator('strong')).toHaveText(settingsTitle)
      await expect(palette.locator('[role="listbox"]')).toHaveAttribute('aria-busy', 'false')
      await page.keyboard.press('Enter'); await expect(palette).toHaveCount(0); await expect(page.locator('.page-settings')).toBeVisible()
      const commandMode = await record(page, app, info, before, fixture, 'explicit-command-mode-runs-settings-without-a-document-search')
      unchanged(commandMode); expect(commandMode.probe.reads).toHaveLength(readsBeforeCommandMode)

      await page.keyboard.press(`${mod}+k`)
      const failureRead = await nextRead(page, app, settingsTitle); await release(app, failureRead, true)
      await expect(palette.locator('.recovery-state')).toBeVisible()
      await expect(selected.locator('strong')).toHaveText(settingsTitle)
      const failure = await record(page, app, info, before, fixture, 'genuine-search-success-with-temporary-ipc-reply-failure-still-allows-settings')
      unchanged(failure); expect(failure.probe.reads[failureRead]).toMatchObject({ settled: true, replyFault: true })
      await page.keyboard.press('Enter'); await expect(palette).toHaveCount(0); await expect(page.locator('.page-settings')).toBeVisible()

      await page.keyboard.press(`${mod}+k`)
      const retryFailedRead = await nextRead(page, app, 'new'); await release(app, retryFailedRead, true)
      await expect(palette.locator('.recovery-state')).toBeVisible()
      await page.keyboard.press('ArrowDown')
      const beforeRetry = await record(page, app, info, before, fixture, 'failed-query-has-an-explicit-command-intent-before-retry')
      unchanged(beforeRetry); expect(beforeRetry.state.selected).toHaveLength(1); expect(beforeRetry.state.selected[0].command).toBe(true)
      const retryRead = beforeRetry.probe.reads.length
      await palette.locator('.recovery-actions').getByRole('button', { name: language === 'zh-CN' ? '重试' : 'Retry', exact: true }).click()
      await expect.poll(async () => {
        const read = (await readMain(app)).probe.reads[retryRead]
        return Boolean(read?.query === 'new' && read.results !== null)
      }).toBe(true)
      await input.click(); await page.keyboard.press('Enter'); await frames(page)
      const retried = await record(page, app, info, before, fixture, 'retry-revokes-the-old-command-intent-before-real-enter-on-the-new-pending-query')
      unchanged(retried); expect(retried.state).toMatchObject({ paletteOpen: true, query: 'new', activeDescendant: null,
        listBusy: 'true', inputFocused: true, recoveryCount: 0, templateDialogCount: 0 })
      expect(retried.state.selected).toEqual([]); expect(retried.probe.reads[retryRead].settled).toBe(false)
      await release(app, retryRead); await expect(palette.locator('[role="listbox"]')).toHaveAttribute('aria-busy', 'false')
      await page.keyboard.press('Escape'); await expect(palette).toHaveCount(0)

      if (language === 'en-US') {
        await page.evaluate(() => {
          const probe = { events: [] as ImeEvent[], composing: false }; (window as RendererProbe).__pendingSearchIme = probe
          document.addEventListener('compositionstart', event => {
            if (!(event.target instanceof Element) || !event.target.matches('.global-search-input')) return
            probe.composing = true; probe.events.push({ type: 'compositionstart', composing: true })
          }, true)
          document.addEventListener('compositionend', event => {
            if (!(event.target instanceof Element) || !event.target.matches('.global-search-input')) return
            probe.composing = false; probe.events.push({ type: 'compositionend', composing: false })
          }, true)
          document.addEventListener('keydown', event => {
            if (!(event.target instanceof Element) || !event.target.matches('.global-search-input')) return
            probe.events.push({ type: 'keydown', key: event.key, isComposing: event.isComposing, keyCode: event.keyCode, composing: probe.composing })
          }, true)
        })
        await page.keyboard.press(`${mod}+k`)
        const imeRead = await nextRead(page, app, settingsTitle)
        await page.keyboard.press('ArrowDown'); await expect(selected.locator('strong')).toHaveText(settingsTitle)
        await page.keyboard.press(`${mod}+a`)
        const cdp = await page.context().newCDPSession(page)
        try {
          // Chromium composition, not a synthetic DOM keyboard event or an OS
          // input-method installation. Capture listeners only observe events.
          await cdp.send('Input.imeSetComposition', { text: settingsTitle, selectionStart: settingsTitle.length, selectionEnd: settingsTitle.length })
          await expect.poll(() => page.evaluate(() => (window as RendererProbe).__pendingSearchIme!.events.filter(event => event.type === 'compositionstart').length)).toBeGreaterThan(0)
          await page.keyboard.press('Enter'); await frames(page)
          const composing = await record(page, app, info, before, fixture, 'real-chromium-composition-enter-does-not-execute-an-explicitly-chosen-command')
          unchanged(composing); expect(composing.state.paletteOpen).toBe(true); expect(composing.state.inputFocused).toBe(true)
          const candidateEnter = composing.state.ime!.events.find(event => event.type === 'keydown' && event.key === 'Enter')
          expect(Boolean(candidateEnter && (candidateEnter.isComposing || candidateEnter.keyCode === 229 || candidateEnter.composing))).toBe(true)
          await cdp.send('Input.insertText', { text: settingsTitle })
          await expect.poll(() => page.evaluate(() => (window as RendererProbe).__pendingSearchIme!.events.filter(event => event.type === 'compositionend').length)).toBeGreaterThan(0)
        } finally { await cdp.detach() }
        await page.keyboard.press('Escape'); await expect(palette).toHaveCount(0)
        const reads = (await readMain(app)).probe.reads
        for (let index = imeRead; index < reads.length; index++) if (!reads[index].settled) {
          await expect.poll(async () => (await readMain(app)).probe.reads[index]?.results !== null).toBe(true)
          await release(app, index)
        }
        await frames(page)
      }
      const final = await record(page, app, info, before, fixture, 'compatible-command-and-retry-paths-finish-with-original-data-and-no-late-execution')
      unchanged(final); expect(final.state.paletteCount).toBe(0); expect(final.state.settingsVisible).toBe(true)
      expect(final.probe.reads.every(read => read.settled)).toBe(true)
      expect(final.probe.reads.filter(read => read.replyFault)).toHaveLength(2)
      expect(errors).toEqual([])
    })
  })
}
