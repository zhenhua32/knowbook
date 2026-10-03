import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type ProbeGlobal = typeof globalThis & { __headerEscapeWrites?: WriteRequest[] }
type FocusProbe = {
  calls: { owner: string; wasActive: boolean; preventScroll: boolean }[]
  entries: string[]
  events: { type: string; key?: string; isComposing?: boolean; keyCode?: number; activeComposition: boolean }[]
  composing: boolean
}
type RendererProbe = Window & { __headerEscapeFocus?: FocusProbe }
const customName = 'Header Escape custom source'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let count = 0; count < 30; count += 1) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
  }
  await expect(target).toBeFocused()
}

async function clickExposedQuery(input: Locator) {
  const box = await input.boundingBox()
  if (!box) throw new Error('The actual record search input must remain connected')
  expect(box.width).toBeGreaterThan(16)
  expect(await input.evaluate((element, point) => element.ownerDocument.elementFromPoint(point.x, point.y) === element,
    { x: box.x + 8, y: box.y + box.height / 2 })).toBe(true)
  await input.click({ position: { x: 8, y: box.height / 2 } })
}

async function installFocusProbe(page: Page) {
  await page.evaluate(() => {
    const probe: FocusProbe = { calls: [], entries: [], events: [], composing: false }
    ;(window as RendererProbe).__headerEscapeFocus = probe
    const ownerOf = (element: Element | null) => element?.matches('.dbw-source-trigger') ? 'source'
      : element?.matches('.dbw-menu-wrap > button') ? 'settings' : null
    const originalFocus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (options?: FocusOptions) {
      const owner = ownerOf(this)
      if (owner) probe.calls.push({ owner, wasActive: document.activeElement === this, preventScroll: Boolean(options?.preventScroll) })
      return originalFocus.call(this, options)
    }
    document.addEventListener('focusin', event => {
      const owner = ownerOf(event.target instanceof Element ? event.target : null)
      if (owner) probe.entries.push(owner)
    }, true)
    document.addEventListener('compositionstart', () => {
      probe.composing = true
      probe.events.push({ type: 'compositionstart', activeComposition: true })
    }, true)
    document.addEventListener('compositionend', () => {
      probe.composing = false
      probe.events.push({ type: 'compositionend', activeComposition: false })
    }, true)
    document.addEventListener('keydown', event => {
      probe.events.push({ type: 'keydown', key: event.key, isComposing: event.isComposing,
        keyCode: event.keyCode, activeComposition: probe.composing })
    }, true)
  })
}

async function focusProbe(page: Page) {
  return page.evaluate(() => (window as RendererProbe).__headerEscapeFocus!)
}

async function prepare(page: Page, language: Language) {
  const ids = await page.evaluate(async ({ language, customName }) => {
    const catalog = (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')
    if (!catalog) throw new Error('The actual document catalog source is required')
    const custom = await window.knowbook.createDocumentDatabase({ name: customName, description: 'Keep original Escape source metadata.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: custom.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: custom.id, title: 'Keep original Escape record',
      fieldValues: { [field.id]: 'Keep original Escape Notes' } })
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: custom.id, name: 'Keep original Escape table', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id], columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id]
    } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', language === 'zh-CN' ? custom.id : catalog.id)
    localStorage.setItem('knowbook.database.last-view.' + custom.id, view.id)
    return { catalogId: catalog.id, customId: custom.id, fieldId: field.id, entityId: entity.id }
  }, { language, customName })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', language === 'zh-CN' ? customName : 'All documents')
  if (language === 'zh-CN') await expect(page.locator('.catalog-cell-input')).toHaveValue('Keep original Escape Notes')
  await twoFrames(page)
  return ids
}

async function installWriteProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const writes: WriteRequest[] = []
    ;(globalThis as ProbeGlobal).__headerEscapeWrites = writes
    // Observe actual authenticated persistence calls. Every handler receives
    // its original sender/senderFrame and payload; nothing is short-circuited.
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        writes.push({ channel, input: structuredClone(input) })
        return original(event, ...input)
      })
    }
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
  const sql = await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try {
      return { schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        entityValues: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all() }
    } finally { database.close() }
  })
  return { ...api, sql }
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, phase: string) {
  const writes = await app.evaluate(() => (globalThis as ProbeGlobal).__headerEscapeWrites ?? [])
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const state = await page.locator('.dbw-header').evaluate(header => {
    const source = header.querySelector<HTMLButtonElement>('.dbw-source-trigger')!
    const settings = header.querySelector<HTMLButtonElement>('.dbw-menu-wrap > button')
    const original = (window as unknown as { __headerEscapeOpener?: HTMLButtonElement }).__headerEscapeOpener
    const active = document.activeElement
    const mainQuery = document.querySelector<HTMLInputElement>('.dbw-main-search input')
    const metric = (element: HTMLElement | null) => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      return { text: element.textContent, label: element.getAttribute('aria-label'), title: element.title,
        expanded: element.getAttribute('aria-expanded'), focused: active === element, connected: element.isConnected,
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height } }
    }
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      source: metric(source), settings: metric(settings), originalConnected: Boolean(original?.isConnected),
      exactOriginalIsCurrent: original === source || original === settings, originalFocused: active === original,
      sourcePickerCount: header.querySelectorAll('.dbw-source-picker').length,
      settingsMenuCount: header.querySelectorAll('.dbw-action-menu').length,
      query: header.querySelector<HTMLInputElement>('.dbw-source-search input')?.value ?? null,
      active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className, label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 160) } : null,
      mainQuery: mainQuery?.value, mainQueryControl: metric(mainQuery), mainQueryFocused: active === mainQuery,
      mainQuerySelection: mainQuery ? [mainQuery.selectionStart, mainQuery.selectionEnd] : null,
      selectedView: document.querySelector('.dbw-view-tab-wrap.is-active')?.textContent,
      formCount: document.querySelectorAll('.dbw-form-dialog, .dbw-create-record-dialog').length }
  })
  const focus = await focusProbe(page)
  const stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, windows, writes, state, focus, stored }, null, 2))
  await info.attach(phase + '-state', { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { writes, windows, state, focus, stored }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('Header Escape closes its active popover and returns its stable opener in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language)
      const before = await readStored(page, app, language)
      await installWriteProbe(app)
      await installFocusProbe(page)
      const source = page.locator('.dbw-source-trigger')
      if (language === 'en-US') {
        // Real pointer open/close establishes the visible button as native
        // focus owner. The measured opening itself is an actual Enter press.
        await source.click()
        const search = page.getByRole('textbox', { name: 'Search databases…', exact: true })
        await expect(search).toBeFocused()
        await source.click()
        await expect(page.locator('.dbw-source-picker')).toHaveCount(0)
        await expect(source).toBeFocused()
        await source.evaluate(element => { (window as unknown as { __headerEscapeOpener: Element }).__headerEscapeOpener = element })
        await page.keyboard.press('Enter')
        await expect(source).toHaveAttribute('aria-expanded', 'true')
        await expect(search).toBeFocused()
        await page.keyboard.type('Escape source query')
        const opened = await record(page, app, info, language, language + '-source-picker-opened-by-real-enter-with-typed-query')
        expect(opened.writes).toEqual([])
        expect(opened.stored).toEqual(before)
        expect(opened.state.query).toBe('Escape source query')
        expect(opened.state.originalConnected).toBe(true)
        await page.keyboard.press('Escape')
        await twoFrames(page)
        const closed = await record(page, app, info, language, language + '-source-picker-real-escape-before-close-and-focus-oracle')
        expect(closed.writes).toEqual([])
        expect(closed.stored).toEqual(before)
        expect(closed.state.exactOriginalIsCurrent).toBe(true)
        expect(closed.state.originalConnected).toBe(true)
        expect(closed.state.sourcePickerCount).toBe(0)
        await expect(source).toHaveAttribute('aria-expanded', 'false')
        expect(closed.state.originalFocused).toBe(true)
        await expect(source).toBeFocused()
      } else {
        const settings = page.getByRole('button', { name: '数据库设置', exact: true })
        await settings.click()
        await expect(page.locator('.dbw-action-menu')).toBeVisible()
        await settings.click()
        await expect(page.locator('.dbw-action-menu')).toHaveCount(0)
        await expect(settings).toBeFocused()
        await settings.evaluate(element => { (window as unknown as { __headerEscapeOpener: Element }).__headerEscapeOpener = element })
        await page.keyboard.press('Enter')
        await expect(settings).toHaveAttribute('aria-expanded', 'true')
        await page.keyboard.press('Tab')
        const edit = page.locator('.dbw-action-menu').getByRole('button', { name: '编辑数据库', exact: true })
        await expect(edit).toBeFocused()
        const opened = await record(page, app, info, language, language + '-custom-settings-real-enter-and-tab-to-edit')
        expect(opened.writes).toEqual([])
        expect(opened.stored).toEqual(before)
        expect(opened.state.source?.title).toBe(customName)
        expect(opened.stored.databases.find(database => database.id === ids.customId)?.name).toBe(customName)
        await page.keyboard.press('Escape')
        await twoFrames(page)
        const closed = await record(page, app, info, language, language + '-custom-settings-real-escape-before-close-and-focus-oracle')
        expect(closed.writes).toEqual([])
        expect(closed.stored).toEqual(before)
        expect(closed.state.exactOriginalIsCurrent).toBe(true)
        expect(closed.state.originalConnected).toBe(true)
        expect(closed.state.settingsMenuCount).toBe(0)
        await expect(settings).toHaveAttribute('aria-expanded', 'false')
        expect(closed.state.originalFocused).toBe(true)
        await expect(settings).toBeFocused()
      }

      const searchName = language === 'zh-CN' ? '搜索数据库…' : 'Search databases…'
      const search = page.getByRole('textbox', { name: searchName, exact: true })
      await tabTo(page, source, true)
      await source.evaluate(element => { (window as unknown as { __headerEscapeOpener: Element }).__headerEscapeOpener = element })
      await page.keyboard.press('Enter')
      await expect(search).toBeFocused()
      if (language === 'en-US') {
        await expect(search).toHaveValue('Escape source query')
      } else {
        await page.keyboard.type('Escape source query')
        await page.keyboard.press('Escape')
        await expect(page.locator('.dbw-source-picker')).toHaveCount(0)
        await expect(source).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(search).toBeFocused()
        await expect(search).toHaveValue('Escape source query')
      }
      // Shift+Tab really returns to the expanded trigger; Escape on that same
      // button must close it without losing the actual stable focus owner.
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Shift+Tab')
      await expect(source).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.locator('.dbw-source-picker')).toHaveCount(0)
      await expect(source).toHaveAttribute('aria-expanded', 'false')
      await expect(source).toBeFocused()

      if (language === 'en-US') {
        await page.keyboard.press('Enter')
        await expect(search).toBeFocused()
        const cdp = await page.context().newCDPSession(page)
        const compositionBefore = await focusProbe(page)
        try {
          // Chromium's actual composition path, not a synthetic DOM key or
          // an installed OS input method. Listeners only observe its events.
          await cdp.send('Input.imeSetComposition', { text: '数据库', selectionStart: 3, selectionEnd: 3 })
          await expect.poll(async () => (await focusProbe(page)).events.filter(event => event.type === 'compositionstart').length)
            .toBeGreaterThan(compositionBefore.events.filter(event => event.type === 'compositionstart').length)
          await page.keyboard.press('Escape')
          await twoFrames(page)
          const composing = await record(page, app, info, language, language + '-real-cdp-composition-escape-keeps-source-picker-and-search-owner')
          const nativeEscape = composing.focus.events.slice(compositionBefore.events.length)
            .find(event => event.type === 'keydown' && event.key === 'Escape')
          expect(Boolean(nativeEscape && (nativeEscape.isComposing || nativeEscape.keyCode === 229 || nativeEscape.activeComposition))).toBe(true)
          expect(composing.state.sourcePickerCount).toBe(1)
          await expect(search).toBeFocused()
          expect(composing.writes).toEqual([])
          expect(composing.stored).toEqual(before)
          await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
          await expect.poll(async () => (await focusProbe(page)).events.filter(event => event.type === 'compositionend').length)
            .toBeGreaterThan(compositionBefore.events.filter(event => event.type === 'compositionend').length)
          await page.keyboard.press('Escape')
          await expect(page.locator('.dbw-source-picker')).toHaveCount(0)
          await expect(source).toHaveAttribute('aria-expanded', 'false')
          await expect(source).toBeFocused()
        } finally { await cdp.detach() }
      }

      // A real keyboard New database route must keep its form ownership;
      // closing the picker cannot return focus over the new Name autofocus.
      await page.keyboard.press('Enter')
      await expect(search).toBeFocused()
      await page.keyboard.press('Control+A')
      await page.keyboard.type('No matching Escape source')
      await expect(page.locator('.dbw-source-option')).toHaveCount(0)
      await tabTo(page, page.locator('.dbw-menu-create'))
      await page.keyboard.press('Enter')
      const form = page.locator('.dbw-form-dialog')
      const formName = form.getByRole('textbox', { name: language === 'zh-CN' ? '名称' : 'Name', exact: true })
      await expect(form.getByRole('heading')).toHaveText(language === 'zh-CN' ? '新建数据库' : 'New database')
      await expect(formName).toBeFocused()
      await twoFrames(page)
      await expect(formName).toBeFocused()
      await page.keyboard.type('Discard this Escape test database')
      await tabTo(page, form.getByRole('button', { name: language === 'zh-CN' ? '取消' : 'Cancel', exact: true }))
      await page.keyboard.press('Enter')
      await expect(form).toHaveCount(0)
      await expect(source).toBeFocused()
      const newCancelled = await record(page, app, info, language, language + '-source-reopen-trigger-escape-and-keyboard-new-cancel-return-to-exact-source')
      expect(newCancelled.state.sourcePickerCount).toBe(0)
      expect(newCancelled.state.formCount).toBe(0)
      expect(newCancelled.state.originalConnected && newCancelled.state.exactOriginalIsCurrent && newCancelled.state.originalFocused).toBe(true)
      expect(newCancelled.writes).toEqual([])
      expect(newCancelled.stored).toEqual(before)

      if (language === 'en-US') {
        await page.keyboard.press('Enter')
        await expect(search).toBeFocused()
        await page.keyboard.press('Control+A')
        await page.keyboard.type(customName)
        const option = page.locator('.dbw-source-option').filter({ hasText: customName })
        await expect(option).toHaveCount(1)
        await tabTo(page, option)
        await page.keyboard.press('Enter')
        await expect(source).toHaveAttribute('title', customName)
        await expect(page.locator('.catalog-cell-input')).toHaveValue('Keep original Escape Notes')
      }
      const settings = page.getByRole('button', { name: language === 'zh-CN' ? '数据库设置' : 'Database settings', exact: true })
      // Native pointer round-trip establishes the current custom-source entry
      // before measuring its keyboard Enter/Tab/Escape sequence in both locales.
      await settings.click()
      await expect(page.locator('.dbw-action-menu')).toBeVisible()
      await settings.click()
      await expect(page.locator('.dbw-action-menu')).toHaveCount(0)
      await expect(settings).toBeFocused()
      await settings.evaluate(element => { (window as unknown as { __headerEscapeOpener: Element }).__headerEscapeOpener = element })
      await page.keyboard.press('Enter')
      await page.keyboard.press('Tab')
      const edit = page.locator('.dbw-action-menu').getByRole('button', { name: language === 'zh-CN' ? '编辑数据库' : 'Edit database', exact: true })
      await expect(edit).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.locator('.dbw-action-menu')).toHaveCount(0)
      await expect(settings).toHaveAttribute('aria-expanded', 'false')
      await expect(settings).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.locator('.dbw-action-menu')).toBeVisible()
      await expect(settings).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.locator('.dbw-action-menu')).toHaveCount(0)
      await expect(settings).toBeFocused()
      await page.keyboard.press('Enter')
      await tabTo(page, edit)
      await page.keyboard.press('Enter')
      await expect(form.getByRole('heading')).toHaveText(language === 'zh-CN' ? '编辑数据库' : 'Edit database')
      await expect(formName).toBeFocused()
      await expect(formName).toHaveValue(customName)
      await twoFrames(page)
      await expect(formName).toBeFocused()
      await page.keyboard.press('Control+A')
      await page.keyboard.type('Discard this Escape metadata edit')
      await tabTo(page, form.getByRole('button', { name: language === 'zh-CN' ? '取消' : 'Cancel', exact: true }))
      await page.keyboard.press('Enter')
      await expect(form).toHaveCount(0)
      await expect(settings).toBeFocused()
      const editCancelled = await record(page, app, info, language, language + '-settings-child-and-trigger-escape-keyboard-edit-cancel-return-to-exact-settings')
      expect(editCancelled.state.settingsMenuCount).toBe(0)
      expect(editCancelled.state.formCount).toBe(0)
      expect(editCancelled.state.originalConnected && editCancelled.state.exactOriginalIsCurrent && editCancelled.state.originalFocused).toBe(true)
      expect(editCancelled.writes).toEqual([])
      expect(editCancelled.stored).toEqual(before)

      // Real outside pointer focus must close each popover while preserving
      // the newly focused record search, including any transient focusin.
      const mainQuery = page.locator('.dbw-main-search input')
      await source.click()
      await expect(search).toBeFocused()
      const sourceBeforeDeparture = await record(page, app, info, language, language + '-source-picker-open-before-native-click-on-exposed-query-left-edge')
      expect(sourceBeforeDeparture.state.sourcePickerCount).toBe(1)
      expect(sourceBeforeDeparture.writes).toEqual([])
      expect(sourceBeforeDeparture.stored).toEqual(before)
      const beforeSourceDeparture = sourceBeforeDeparture.focus
      await clickExposedQuery(mainQuery)
      await twoFrames(page)
      const sourceDeparture = await record(page, app, info, language, language + '-outside-native-query-click-closes-source-without-opener-handoff')
      expect(sourceDeparture.state.sourcePickerCount).toBe(0)
      await expect(source).toHaveAttribute('aria-expanded', 'false')
      await expect(mainQuery).toBeFocused()
      expect(sourceDeparture.state.mainQueryFocused).toBe(true)
      expect(sourceDeparture.focus.calls).toHaveLength(beforeSourceDeparture.calls.length)
      expect(sourceDeparture.focus.entries).toHaveLength(beforeSourceDeparture.entries.length)
      expect(sourceDeparture.writes).toEqual([])
      expect(sourceDeparture.stored).toEqual(before)
      await settings.click()
      await tabTo(page, edit)
      await expect(edit).toBeFocused()
      const beforeSettingsDeparture = await focusProbe(page)
      await clickExposedQuery(mainQuery)
      await twoFrames(page)
      const settingsDeparture = await record(page, app, info, language, language + '-outside-native-query-click-closes-settings-without-opener-handoff')
      expect(settingsDeparture.state.settingsMenuCount).toBe(0)
      await expect(settings).toHaveAttribute('aria-expanded', 'false')
      await expect(mainQuery).toBeFocused()
      expect(settingsDeparture.state.mainQueryFocused).toBe(true)
      expect(settingsDeparture.focus.calls).toHaveLength(beforeSettingsDeparture.calls.length)
      expect(settingsDeparture.focus.entries).toHaveLength(beforeSettingsDeparture.entries.length)
      expect(settingsDeparture.writes).toEqual([])
      expect(settingsDeparture.stored).toEqual(before)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
