import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { CDPSession, ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type ProbeGlobal = typeof globalThis & { __settingsShortcutWrites?: WriteRequest[] }
const sourceName = 'Header settings shortcut source'
const recordTitle = 'Original selected shortcut record'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, reverse = false, onFailure?: (steps: unknown[]) => Promise<void>) {
  const steps: unknown[] = []
  for (let count = 0; count < 30; count += 1) {
    const state = await target.evaluate(element => {
      const active = document.activeElement
      return { focused: active === element, foreground: document.hasFocus(),
        active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className,
          label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 120) } : null }
    })
    steps.push({ step: count, direction: reverse ? 'Shift+Tab' : 'Tab', ...state })
    if (state.focused) return
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
  }
  if (await target.evaluate(element => document.activeElement === element)) return
  await onFailure?.(steps)
  await expect(target).toBeFocused()
}

async function readContext(page: Page) {
  return page.evaluate(() => ({
    selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent),
    checked: Array.from(document.querySelectorAll<HTMLInputElement>('.dbw-select-column input[type="checkbox"]')).filter(input => input.checked).length,
    query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
    view: document.querySelector('.dbw-view-tab-wrap.is-active')?.textContent,
    source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
    expanded: document.querySelector('.dbw-menu-wrap > button')?.getAttribute('aria-expanded'),
    menuCount: document.querySelectorAll('.dbw-action-menu').length,
    sourcePickerCount: document.querySelectorAll('.dbw-source-picker').length,
    confirmCount: document.querySelectorAll('.app-confirm-dialog').length,
    formCount: document.querySelectorAll('.dbw-form-dialog, .dbw-create-record-dialog').length
  }))
}

async function prepare(page: Page, language: Language) {
  const ids = await page.evaluate(async ({ language, sourceName, recordTitle }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep all shortcut source metadata.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle, fieldValues: { [field.id]: 'Original shortcut Notes' } })
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Original shortcut table', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id]
    } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, view.id)
    return { databaseId: database.id, fieldId: field.id, entityId: entity.id, viewId: view.id }
  }, { language, sourceName, recordTitle })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.catalog-cell-input')).toHaveValue('Original shortcut Notes')
  await twoFrames(page)
  return ids
}

async function installWriteProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const writes: WriteRequest[] = []
    ;(globalThis as ProbeGlobal).__settingsShortcutWrites = writes
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
    try {
      return { schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        entities: database.prepare('SELECT * FROM database_entities ORDER BY id').all(),
        entityValues: database.prepare('SELECT * FROM database_entity_values ORDER BY entity_id, column_id').all(),
        documentValues: database.prepare('SELECT * FROM document_database_values ORDER BY document_id, column_id').all() }
    } finally { database.close() }
  })
  return { ...api, sql }
}

async function record(page: Page, app: ElectronApplication, cdp: CDPSession, info: TestInfo,
  language: Language, phase: string, beforeKey: unknown, before: Awaited<ReturnType<typeof readStored>>) {
  const state = await page.evaluate(() => {
    const active = document.activeElement
    const trigger = document.querySelector<HTMLButtonElement>('.dbw-menu-wrap > button')
    const menu = document.querySelector('.dbw-action-menu')
    const confirm = document.querySelector<HTMLDialogElement>('.app-confirm-dialog')
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'), selectedCount: document.querySelectorAll('tbody > tr.is-selected').length,
      checked: Array.from(document.querySelectorAll<HTMLInputElement>('.dbw-select-column input[type="checkbox"]')).filter(input => input.checked).length,
      selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(element => element.textContent),
      settings: { expanded: trigger?.getAttribute('aria-expanded'), focused: active === trigger, connected: trigger?.isConnected },
      menuCount: document.querySelectorAll('.dbw-action-menu').length,
      menuButtons: Array.from(menu?.querySelectorAll('button') ?? []).map(button => ({ text: button.textContent, focused: active === button })),
      confirmCount: document.querySelectorAll('.app-confirm-dialog').length,
      confirm: confirm ? { role: confirm.getAttribute('role'), open: confirm.open, heading: confirm.querySelector('h2')?.textContent,
        description: confirm.querySelector('.app-confirm-body')?.textContent, buttons: Array.from(confirm.querySelectorAll('button')).map(button => button.textContent) } : null,
      sourcePickerCount: document.querySelectorAll('.dbw-source-picker').length,
      mainQuery: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      selectedView: document.querySelector('.dbw-view-tab-wrap.is-active')?.textContent,
      active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className, label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 160) } : null }
  })
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.app-confirm-dialog' })
  const accessibility = nodeId ? await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false }) : null
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const writes = await app.evaluate(() => (globalThis as ProbeGlobal).__settingsShortcutWrites ?? [])
  const stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, beforeKey, state, accessibility, windows, writes, before, stored }, null, 2))
  await info.attach(phase + '-state', { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { state, writes, stored }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('Database settings owns Delete rather than the selected-record canvas shortcut in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language)
      const before = await readStored(page, app, language)
      await installWriteProbe(app)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Accessibility.enable')
      try {
        const row = page.locator('tbody > tr').filter({ hasText: recordTitle })
        const checkbox = row.locator('.dbw-select-column input[type="checkbox"]')
        await checkbox.check()
        await expect(checkbox).toBeChecked()
        await expect(row).toHaveClass(/is-selected/)
        const settings = page.getByRole('button', { name: language === 'zh-CN' ? '数据库设置' : 'Database settings', exact: true })
        // Actual pointer round-trip establishes the native button focus owner;
        // the measured opening and movement into Edit are real Enter and Tab.
        await settings.click()
        await expect(page.locator('.dbw-action-menu')).toBeVisible()
        await settings.click()
        await expect(page.locator('.dbw-action-menu')).toHaveCount(0)
        await expect(settings).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(settings).toHaveAttribute('aria-expanded', 'true')
        if (language === 'en-US') await page.keyboard.press('Tab')
        const edit = page.locator('.dbw-action-menu').getByRole('button', { name: language === 'zh-CN' ? '编辑数据库' : 'Edit database', exact: true })
        const menuOwner = language === 'zh-CN' ? settings : edit
        await expect(menuOwner).toBeFocused()
        const beforeKey = await menuOwner.evaluate(element => ({ tag: element.tagName, text: element.textContent,
          focused: document.activeElement === element, expanded: document.querySelector('.dbw-menu-wrap > button')?.getAttribute('aria-expanded'),
          selectedCount: document.querySelectorAll('tbody > tr.is-selected').length,
          selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent) }))
        await page.keyboard.press('Delete')
        await twoFrames(page)
        const result = await record(page, app, cdp, info, language, language + '-real-menu-delete-before-no-canvas-confirm-oracle', beforeKey, before)
        expect(result.writes).toEqual([])
        expect(result.stored).toEqual(before)
        expect(result.stored.sources.find(source => source.id === ids.databaseId)?.entities.map(entity => entity.id)).toEqual([ids.entityId])
        expect(result.state.selectedCount).toBe(1)
        expect(result.state.selectedTitles).toEqual([recordTitle])
        expect(result.state.confirmCount).toBe(0)
        expect(result.state.menuCount).toBe(1)
        await expect(settings).toHaveAttribute('aria-expanded', 'true')
        await expect(menuOwner).toBeFocused()

        const menuDelete = page.locator('.dbw-action-menu').getByRole('button', { name: language === 'zh-CN' ? '删除数据库' : 'Delete database', exact: true })
        const keys = ['/', 'Control+Shift+L', 'Control+Shift+V', 'Delete'] as const
        const ownedSteps: unknown[] = []
        // Use actual Tab transitions among the expanded trigger and both items.
        // Merely having an open menu elsewhere must not suppress canvas keys.
        for (const [ownerName, owner] of [['expanded-trigger', settings], ['edit-item', edit], ['delete-item', menuDelete]] as const) {
          await tabTo(page, owner, ownerName === 'expanded-trigger')
          await expect(owner).toBeFocused()
          for (const key of keys) {
            const context = await readContext(page)
            await page.keyboard.press(key)
            await twoFrames(page)
            await expect(owner).toBeFocused()
            expect(await readContext(page)).toEqual(context)
            await expect(page.locator('.app-confirm-dialog')).toHaveCount(0)
            ownedSteps.push({ owner: ownerName, key, context, focused: await owner.evaluate(element => document.activeElement === element) })
          }
        }
        const scoped = await record(page, app, cdp, info, language, language + '-three-real-menu-owners-keep-all-four-canvas-keys-scoped', ownedSteps, before)
        expect(scoped.writes).toEqual([])
        expect(scoped.stored).toEqual(before)
        expect(scoped.state.selectedTitles).toEqual([recordTitle])
        expect(scoped.state.menuCount).toBe(1)
        expect(scoped.state.confirmCount).toBe(0)

        // Space still activates Edit normally; popup closure must yield to Name
        // autofocus and Cancel must return the visible, stable Settings entry.
        await tabTo(page, edit, true)
        await page.keyboard.press('Space')
        const form = page.locator('.dbw-form-dialog')
        await expect(form.getByRole('heading')).toHaveText(language === 'zh-CN' ? '编辑数据库' : 'Edit database')
        await expect(form.getByRole('textbox', { name: language === 'zh-CN' ? '名称' : 'Name', exact: true })).toBeFocused()
        await expect(form.getByRole('textbox', { name: language === 'zh-CN' ? '名称' : 'Name', exact: true })).toHaveValue(sourceName)
        await tabTo(page, form.getByRole('button', { name: language === 'zh-CN' ? '取消' : 'Cancel', exact: true }))
        await page.keyboard.press('Enter')
        await expect(form).toHaveCount(0)
        await expect(settings).toBeFocused()
        const edited = await record(page, app, cdp, info, language, language + '-native-space-edit-and-cancel-return-stable-settings-without-writing', ownedSteps, before)
        expect(edited.writes).toEqual([])
        expect(edited.stored).toEqual(before)
        expect(edited.state.menuCount).toBe(0)

        // Enter on the menu's Delete action is intentionally different from the
        // Delete key: it opens the DATABASE danger dialog, then only Cancel.
        await page.keyboard.press('Enter')
        await tabTo(page, menuDelete)
        await page.keyboard.press('Enter')
        const confirm = page.locator('.app-confirm-dialog')
        const cancel = confirm.getByRole('button', { name: language === 'zh-CN' ? '取消' : 'Cancel', exact: true })
        await expect(confirm.getByRole('heading')).toHaveText(language === 'zh-CN' ? '删除数据库' : 'Delete database')
        await expect(confirm.locator('.app-confirm-body')).toContainText(sourceName)
        await expect(cancel).toBeFocused()
        const databaseDanger = await record(page, app, cdp, info, language, language + '-native-menu-delete-enter-opens-only-correct-database-confirm', { action: 'Enter on database Delete item' }, before)
        expect(databaseDanger.state.confirmCount).toBe(1)
        expect(databaseDanger.state.confirm?.heading).toBe(language === 'zh-CN' ? '删除数据库' : 'Delete database')
        expect(databaseDanger.writes).toEqual([])
        expect(databaseDanger.stored).toEqual(before)
        await page.keyboard.press('Enter')
        await expect(confirm).toHaveCount(0)
        const mainQuery = page.locator('.dbw-main-search input')
        await expect(mainQuery).toBeFocused()

        const source = page.locator('.dbw-source-trigger')
        const viewTrigger = page.locator('.dbw-new-view-menu summary')
        const primary = page.locator('.dbw-header-actions > .dbw-primary-button')
        const canvasSteps: unknown[] = []
        for (const openMenu of [false, true]) {
          if (openMenu) {
            await tabTo(page, settings, true)
            await page.keyboard.press('Enter')
            await expect(settings).toHaveAttribute('aria-expanded', 'true')
          }
          for (const key of keys) {
            // Ctrl+Shift+L was just asserted to focus Source. DOM order is
            // Source -> Refresh -> New record -> Settings, so use forward Tab;
            // record search and New view are after Settings and use Shift+Tab.
            const fromSource = await source.evaluate(element => document.activeElement === element)
            await tabTo(page, settings, !fromSource, async steps => {
              await record(page, app, cdp, info, language,
                language + (openMenu ? '-open-menu' : '-closed-menu') + '-before-' + key.replaceAll('/', 'slash') + '-settings-reacquire-failed',
                { nextKey: key, fromSource, direction: fromSource ? 'Tab' : 'Shift+Tab', steps }, before)
            })
            if (openMenu) {
              // Reopen for every key, then follow genuine Shift+Tab out of its
              // own scope. Dismissal preserves the outside canvas shortcuts.
              if (await settings.getAttribute('aria-expanded') === 'false') await page.keyboard.press('Enter')
              await expect(settings).toHaveAttribute('aria-expanded', 'true')
              await expect(page.locator('.dbw-action-menu')).toHaveCount(1)
              await page.keyboard.press('Shift+Tab')
              await expect(primary).toBeFocused()
              await expect(page.locator('.dbw-action-menu')).toHaveCount(0)
            } else {
              await expect(settings).toBeFocused()
              await expect(settings).toHaveAttribute('aria-expanded', 'false')
            }
            const context = await readContext(page)
            await page.keyboard.press(key)
            await twoFrames(page)
            if (key === 'Delete') {
              await expect(confirm.getByRole('heading')).toHaveText(language === 'zh-CN' ? '删除记录' : 'Delete record')
              await expect(confirm.locator('.app-confirm-body')).toContainText(language === 'zh-CN' ? '已选 1 条' : '1 selected')
              await expect(cancel).toBeFocused()
              const selectedDanger = await record(page, app, cdp, info, language,
                language + (openMenu ? '-external-new-record-after-menu-dismissal' : '-closed-settings-trigger') + '-native-delete-opens-only-selected-record-confirm',
                { owner: openMenu ? 'external-new-record' : 'closed-settings-trigger', key, context }, before)
              expect(selectedDanger.state.confirmCount).toBe(1)
              expect(selectedDanger.writes).toEqual([])
              expect(selectedDanger.stored).toEqual(before)
              await page.keyboard.press('Enter')
              await expect(confirm).toHaveCount(0)
              await expect(mainQuery).toBeFocused()
            } else {
              const target = key === '/' ? mainQuery : key === 'Control+Shift+L' ? source : viewTrigger
              await expect(target).toBeFocused()
            }
            expect(await readContext(page)).toEqual(context)
            canvasSteps.push({ owner: openMenu ? 'external-new-record' : 'closed-settings-trigger', key, context,
              active: await page.evaluate(() => document.activeElement instanceof HTMLElement ? {
                tag: document.activeElement.tagName, className: document.activeElement.className,
                text: document.activeElement.textContent?.slice(0, 120) } : null) })
          }
        }
        await tabTo(page, settings, true)
        await page.keyboard.press('Escape')
        await expect(page.locator('.dbw-action-menu')).toHaveCount(0)
        await expect(settings).toBeFocused()
        const final = await record(page, app, cdp, info, language, language + '-closed-trigger-and-menu-dismissal-preserve-normal-canvas-shortcuts', canvasSteps, before)
        expect(final.writes).toEqual([])
        expect(final.stored).toEqual(before)
        expect(final.state.confirmCount).toBe(0)
        expect(final.state.sourcePickerCount).toBe(0)
        expect(final.state.menuCount).toBe(0)
        expect(final.state.selectedTitles).toEqual([recordTitle])
        await expect(checkbox).toBeChecked()
        expect(errors).toEqual([])
      } finally { await cdp.detach() }
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
