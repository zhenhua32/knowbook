import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { CDPSession, ElectronApplication } from 'playwright'
import type { DatabaseViewConfigV1 } from '../src/shared/contracts'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type ProbeGlobal = typeof globalThis & { __viewActionWrites?: WriteRequest[] }
const sourceName = 'View actions source'
const primaryName = 'Primary working table'
const targetName = 'Inactive managed table'
const edgeName = 'Far edge managed view'

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let step = 0; step < 12; step += 1) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
  }
  await expect(target).toBeFocused()
}

async function prepare(page: Page, language: Language) {
  const ids = await page.evaluate(async ({ language, sourceName, primaryName, targetName, edgeName }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep all original view action metadata.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Original view action record', fieldValues: { [field.id]: 'Original Notes' } })
    const config: DatabaseViewConfigV1 = { version: 1, layout: 'table', query: 'Original', filters: { operator: 'and', rules: [] }, sorts: [],
      groupBy: { fieldId: null }, visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id],
      columnWidths: { __title__: 180, [field.id]: 180 }, cardFieldIds: [field.id] }
    const primary = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: primaryName, config })
    const target = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: targetName, config: { ...config, query: 'Independent managed query' } })
    const extraIds: string[] = []
    for (let index = 0; index < 8; index += 1) {
      const extra = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Additional managed view ' + (index + 1), config })
      extraIds.push(extra.id)
    }
    const edge = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: edgeName, config })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    localStorage.setItem('knowbook.database.last-source', database.id)
    localStorage.setItem('knowbook.database.last-view.' + database.id, primary.id)
    return { databaseId: database.id, fieldId: field.id, entityId: entity.id, primaryId: primary.id, targetId: target.id, extraIds, edgeId: edge.id }
  }, { language, sourceName, primaryName, targetName, edgeName })
  await page.reload()
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByTitle(language === 'zh-CN' ? '数据库' : 'Database', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', primaryName)
  await expect(page.locator('.dbw-main-search input')).toHaveValue('Original')
  await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
  await twoFrames(page)
  return ids
}

async function installWriteProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const writes: WriteRequest[] = []
    ;(globalThis as ProbeGlobal).__viewActionWrites = writes
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
  language: Language, beforeOwner: unknown, before: Awaited<ReturnType<typeof readStored>>,
  phase = language + '-inactive-view-menu-native-enter-before-no-direct-danger-oracle') {
  const state = await page.evaluate(() => {
    const confirm = document.querySelector<HTMLDialogElement>('.app-confirm-dialog')
    const active = document.activeElement
    return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
      source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'), query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
      activeView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
      selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent),
      viewActionMenuCount: document.querySelectorAll('.dbw-view-actions-menu').length,
      menu: document.querySelector('.dbw-view-actions-menu') ? {
        id: document.querySelector('.dbw-view-actions-menu')?.id,
        role: document.querySelector('.dbw-view-actions-menu')?.getAttribute('role'),
        name: document.querySelector('.dbw-view-actions-menu')?.getAttribute('aria-label'),
        bounds: document.querySelector('.dbw-view-actions-menu')?.getBoundingClientRect().toJSON(),
        buttons: Array.from(document.querySelectorAll('.dbw-view-actions-menu button')).map(button => ({ text: button.textContent, focused: active === button }))
      } : null,
      strip: { left: document.querySelector('.dbw-view-tab-list')?.scrollLeft,
        clientWidth: document.querySelector('.dbw-view-tab-list')?.clientWidth,
        scrollWidth: document.querySelector('.dbw-view-tab-list')?.scrollWidth },
      focusProbe: (window as unknown as { __viewActionFocus?: unknown[] }).__viewActionFocus ?? [],
      confirmCount: document.querySelectorAll('.app-confirm-dialog').length,
      confirm: confirm ? { role: confirm.getAttribute('role'), open: confirm.open, heading: confirm.querySelector('h2')?.textContent,
        description: confirm.querySelector('.app-confirm-body')?.textContent, buttons: Array.from(confirm.querySelectorAll('button')).map(button => button.textContent) } : null,
      active: active instanceof HTMLElement ? { tag: active.tagName, className: active.className, label: active.getAttribute('aria-label'), text: active.textContent?.slice(0, 160) } : null }
  })
  const { root } = await cdp.send('DOM.getDocument')
  const trigger = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.dbw-view-tab-wrap:not(.is-active) .dbw-view-tab-menu' })
  const danger = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.app-confirm-dialog' })
  const accessibility = { trigger: trigger.nodeId ? await cdp.send('Accessibility.getPartialAXTree', { nodeId: trigger.nodeId, fetchRelatives: false }) : null,
    danger: danger.nodeId ? await cdp.send('Accessibility.getPartialAXTree', { nodeId: danger.nodeId, fetchRelatives: false }) : null }
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  const writes = await app.evaluate(() => (globalThis as ProbeGlobal).__viewActionWrites ?? [])
  const stored = await readStored(page, app, language)
  const path = info.outputPath(phase + '.json')
  writeFileSync(path, JSON.stringify({ phase, beforeOwner, state, accessibility, windows, writes, before, stored }, null, 2))
  await info.attach(phase + '-state', { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(phase + '.png') })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { state, writes, stored }
}

async function readContext(page: Page) {
  return page.evaluate(() => ({
    source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
    activeView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
    query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
    draftDirty: Boolean(document.querySelector('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')),
    selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent),
    notes: document.querySelector<HTMLInputElement>('tbody .catalog-cell-input[aria-label="Notes"]')?.value
  }))
}

async function installFocusProbe(page: Page) {
  await page.evaluate(() => {
    const log: unknown[] = []
    ;(window as unknown as { __viewActionFocus?: unknown[] }).__viewActionFocus = log
    const original = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (...args) {
      if (this.matches('.dbw-view-tab-menu')) log.push({ kind: 'focus', label: this.getAttribute('aria-label'), args, beforeActive: document.activeElement === this })
      return original.apply(this, args)
    }
    document.addEventListener('focusin', event => {
      if (event.target instanceof HTMLElement && event.target.matches('.dbw-view-tab-menu')) {
        log.push({ kind: 'focusin', label: event.target.getAttribute('aria-label') })
      }
    }, true)
  })
}

async function focusLog(page: Page) {
  return page.evaluate(() => (window as unknown as { __viewActionFocus?: unknown[] }).__viewActionFocus ?? [])
}

async function geometry(target: Locator) {
  return target.evaluate(element => {
    const box = element.getBoundingClientRect()
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    const ancestors: unknown[] = []
    for (let ancestor: HTMLElement | null = element as HTMLElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
      const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0
      const borderRight = Number.parseFloat(style.borderRightWidth) || 0
      const borderTop = Number.parseFloat(style.borderTopWidth) || 0
      const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0
      // client/offset dimensions round to integer CSS pixels. Their difference
      // measures occupied scrollbar space; the DOMRect preserves the actual
      // fractional padding edge instead of replacing it with clientWidth.
      const scrollbarWidth = /auto|scroll/.test(style.overflowY)
        ? Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - Math.round(borderLeft + borderRight)) : 0
      const scrollbarHeight = /auto|scroll/.test(style.overflowX)
        ? Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - Math.round(borderTop + borderBottom)) : 0
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        left = Math.max(left, bounds.left + borderLeft)
        right = Math.min(right, bounds.right - borderRight - scrollbarWidth)
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        top = Math.max(top, bounds.top + borderTop)
        bottom = Math.min(bottom, bounds.bottom - borderBottom - scrollbarHeight)
      }
      ancestors.push({ tag: ancestor.tagName, className: ancestor.className, bounds: bounds.toJSON(),
        clientWidth: ancestor.clientWidth, clientHeight: ancestor.clientHeight, clientLeft: ancestor.clientLeft, clientTop: ancestor.clientTop,
        offsetWidth: ancestor.offsetWidth, offsetHeight: ancestor.offsetHeight,
        scrollWidth: ancestor.scrollWidth, scrollHeight: ancestor.scrollHeight,
        style: { overflowX: style.overflowX, overflowY: style.overflowY, position: style.position,
          borderLeft: style.borderLeftWidth, borderRight: style.borderRightWidth, borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth },
        scrollbarWidth, scrollbarHeight, intersection: { left, top, right, bottom } })
      // A fixed menu is clipped by the viewport, rather than the ordinary
      // shell above its containing DOM ancestry.
      if (style.position === 'fixed') break
    }
    const intersection = Math.max(0, Math.min(box.right, right) - Math.max(box.left, left))
      * Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top))
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return { bounds: box.toJSON(), clip: { left, top, right, bottom }, ancestors,
      ratio: box.width && box.height ? intersection / (box.width * box.height) : 0,
      hit: hit === element || element.contains(hit) }
  })
}

async function clickExposedQuery(query: Locator) {
  const point = await query.evaluate(element => {
    const box = element.getBoundingClientRect()
    for (const x of [8, box.width - 8, box.width / 2]) {
      const y = box.height / 2
      if (document.elementFromPoint(box.left + x, box.top + y) === element) return { x, y }
    }
    return null
  })
  expect(point).not.toBeNull()
  if (!point) throw new Error('No genuinely exposed database query click point.')
  await query.click({ position: point })
}

async function menuGeometry(menu: Locator) {
  const popup = await geometry(menu)
  const controls = await Promise.all((await menu.locator('button').all()).map(button => geometry(button)))
  return { popup, controls }
}

function assertMenuGeometry(metrics: Awaited<ReturnType<typeof menuGeometry>>) {
  expect(metrics.popup.ratio).toBe(1)
  expect(metrics.controls).toHaveLength(2)
  for (const control of metrics.controls) {
    expect(control.ratio).toBe(1)
    expect(control.hit).toBe(true)
    expect(control.bounds.height).toBeGreaterThanOrEqual(24)
  }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test('Inactive saved view actions opens a menu rather than direct danger in ' + language + ' @electron', async ({}, info) => {
    test.setTimeout(150_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await prepare(page, language)
      const before = await readStored(page, app, language)
      await installWriteProbe(app)
      const cdp = await page.context().newCDPSession(page)
      try {
        await cdp.send('Accessibility.enable')
        // Same active primary title: pointer establishes real focus without
        // activating the old destructive View menu. Tab reaches inactive target.
        await page.getByTitle(primaryName, { exact: true }).click()
        const target = page.getByRole('button', { name: (language === 'zh-CN' ? '视图菜单: ' : 'View menu: ') + targetName, exact: true })
        await tabTo(page, target)
        await expect(target).toBeFocused()
        const beforeOwner = await target.evaluate(element => ({ tag: element.tagName, label: element.getAttribute('aria-label'), title: element.getAttribute('title'),
          focused: document.activeElement === element, activeView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
          query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
          selectedTitles: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(title => title.textContent) }))
        await page.keyboard.press('Enter')
        await twoFrames(page)
        const result = await record(page, app, cdp, info, language, beforeOwner, before)
        expect(result.writes).toEqual([])
        expect(result.stored).toEqual(before)
        expect(result.stored.sources.find(source => source.id === ids.databaseId)?.views.map(view => view.id).sort()).toEqual([ids.primaryId, ids.targetId, ...ids.extraIds, ids.edgeId].sort())
        expect(result.state.activeView).toBe(primaryName)
        expect(result.state.query).toBe('Original')
        expect(result.state.selectedTitles).toEqual(beforeOwner.selectedTitles)
        expect(result.state.confirmCount).toBe(0)
        await expect(page.locator('.dbw-view-actions-menu')).toBeVisible()

        const menu = page.getByRole('dialog', { name: (language === 'zh-CN' ? '视图菜单: ' : 'View menu: ') + targetName, exact: true })
        const rename = menu.getByRole('button', { name: language === 'zh-CN' ? '重命名' : 'Rename', exact: true })
        const menuDelete = menu.getByRole('button', { name: language === 'zh-CN' ? '删除视图' : 'Delete view', exact: true })
        const query = page.locator('.dbw-main-search input')
        const newView = page.locator('.dbw-new-view-menu > summary')
        await expect(rename).toBeFocused()
        await expect(target).toHaveAttribute('aria-expanded', 'true')
        await expect(target).toHaveAttribute('aria-haspopup', 'dialog')
        expect(await target.getAttribute('aria-controls')).toBe(await menu.getAttribute('id'))
        expect(await menu.getAttribute('id')).toBeTruthy()
        const initialGeometry = await menuGeometry(menu)
        await record(page, app, cdp, info, language, initialGeometry, before, language + '-named-related-menu-first-rename-focus-and-full-hit')
        assertMenuGeometry(initialGeometry)

        // Local navigation changes only the two actions. It never switches the
        // active view or begins a rename/delete until native activation occurs.
        const initialContext = await readContext(page)
        const arrowSteps: unknown[] = []
        for (const [key, owner] of [['ArrowUp', menuDelete], ['ArrowDown', rename], ['End', menuDelete], ['Home', rename]] as const) {
          await page.keyboard.press(key)
          await expect(owner).toBeFocused()
          expect(await readContext(page)).toEqual(initialContext)
          arrowSteps.push({ key, owner: await owner.textContent() })
        }
        await page.keyboard.press('Escape')
        await expect(menu).toHaveCount(0)
        await expect(target).toBeFocused()
        await expect(target).toHaveAttribute('aria-expanded', 'false')

        // A genuine local query edit and a real selected row make accidental
        // canvas shortcuts observable, while every action targets INACTIVE view.
        await query.fill('Original view')
        const row = page.locator('tbody > tr').filter({ hasText: 'Original view action record' })
        const checkbox = row.locator('.dbw-select-column input[type="checkbox"]')
        await checkbox.check()
        await expect(checkbox).toBeChecked()
        const context = await readContext(page)
        expect(context.activeView).toBe(primaryName)
        expect(context.draftDirty).toBe(true)
        expect(context.selectedTitles).toEqual(['Original view action record'])
        expect(context.notes).toBe('Original Notes')
        await expect(page.locator('tbody .catalog-cell-input[aria-label="Notes"]')).toHaveValue('Original Notes')
        await installFocusProbe(page)
        await target.click()
        await expect(rename).toBeFocused()
        const shortcutSteps: unknown[] = []
        for (const [ownerName, owner] of [['rename-item', rename], ['delete-item', menuDelete]] as const) {
          await tabTo(page, owner)
          for (const key of ['/', 'Control+Shift+L', 'Control+Shift+V', 'Delete']) {
            await page.keyboard.press(key)
            await twoFrames(page)
            await expect(owner).toBeFocused()
            await expect(menu).toHaveCount(1)
            await expect(page.locator('.app-confirm-dialog')).toHaveCount(0)
            expect(await readContext(page)).toEqual(context)
            shortcutSteps.push({ ownerName, key, focused: true })
          }
        }
        const shortcutProof = await record(page, app, cdp, info, language, { arrowSteps, shortcutSteps }, before,
          language + '-both-real-menu-owners-preserve-selected-record-and-view-draft')
        expect(shortcutProof.writes).toEqual([])
        expect(shortcutProof.stored).toEqual(before)

        await page.keyboard.press('Home')
        for (const activation of ['Space', 'Enter'] as const) {
          if (await menu.count() === 0) { await target.click(); await expect(rename).toBeFocused() }
          await page.keyboard.press(activation)
          const form = page.getByRole('dialog', { name: language === 'zh-CN' ? '重命名' : 'Rename', exact: true })
          const name = form.getByRole('textbox', { name: language === 'zh-CN' ? '名称' : 'Name', exact: true })
          await expect(form).toBeVisible()
          await expect(name).toBeFocused()
          await expect(name).toHaveValue(targetName)
          await expect(menu).toHaveCount(0)
          expect(await readContext(page)).toEqual(context)
          if (activation === 'Space') {
            await tabTo(page, form.getByRole('button', { name: language === 'zh-CN' ? '取消' : 'Cancel', exact: true }))
            await page.keyboard.press('Enter')
          } else await page.keyboard.press('Escape')
          await expect(form).toHaveCount(0)
          await expect(target).toBeFocused()
          expect(await readContext(page)).toEqual(context)
        }
        const renameProof = await record(page, app, cdp, info, language, { cancel: 'native Enter', close: 'native Escape', context }, before,
          language + '-space-and-enter-rename-inactive-view-cancel-keep-active-draft-and-return-trigger')
        expect(renameProof.writes).toEqual([])
        expect(renameProof.stored).toEqual(before)

        await page.keyboard.press('Enter')
        await expect(rename).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(menuDelete).toBeFocused()
        await page.keyboard.press('Enter')
        const danger = page.locator('.app-confirm-dialog')
        const cancel = danger.getByRole('button', { name: language === 'zh-CN' ? '取消' : 'Cancel', exact: true })
        await expect(cancel).toBeFocused()
        const dangerProof = await record(page, app, cdp, info, language, context, before,
          language + '-native-delete-action-targets-only-inactive-view-and-cancel-returns-trigger')
        expect(dangerProof.state.confirmCount).toBe(1)
        expect(dangerProof.state.confirm?.heading).toBe(language === 'zh-CN' ? '删除视图' : 'Delete view')
        expect(dangerProof.state.confirm?.description).toContain(targetName)
        expect(dangerProof.writes).toEqual([])
        expect(dangerProof.stored).toEqual(before)
        await page.keyboard.press('Enter')
        await expect(danger).toHaveCount(0)
        await expect(target).toBeFocused()
        expect(await readContext(page)).toEqual(context)

        // This popup is nonmodal: native Tab and Shift+Tab really leave its
        // scope, close it, and keep the newly reached control rather than trap.
        await page.keyboard.press('Enter')
        await expect(rename).toBeFocused()
        const reverseLog = await focusLog(page)
        await page.keyboard.press('Shift+Tab')
        await expect(newView).toBeFocused()
        await expect(menu).toHaveCount(0)
        expect(await focusLog(page)).toEqual(reverseLog)
        await target.click()
        await expect(rename).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(menuDelete).toBeFocused()
        const forwardLog = await focusLog(page)
        await page.keyboard.press('Tab')
        await expect(query).toBeFocused()
        await expect(menu).toHaveCount(0)
        expect(await focusLog(page)).toEqual(forwardLog)

        await target.click()
        await expect(rename).toBeFocused()
        const outsideLog = await focusLog(page)
        await clickExposedQuery(query)
        await twoFrames(page)
        await expect(query).toBeFocused()
        await expect(menu).toHaveCount(0)
        expect(await focusLog(page)).toEqual(outsideLog)
        expect(await readContext(page)).toEqual(context)
        const exitProof = await record(page, app, cdp, info, language,
          { reverseLog, forwardLog, outsideLog, context }, before, language + '-native-tab-exits-and-outside-pointer-keep-new-focus')
        expect(exitProof.writes).toEqual([])
        expect(exitProof.stored).toEqual(before)

        await target.click()
        await expect(rename).toBeFocused()
        const resizeLog = await focusLog(page)
        await page.setViewportSize({ width: 760, height: 650 })
        await expect(menu).toHaveCount(0)
        await twoFrames(page)
        expect(await focusLog(page)).toEqual(resizeLog)
        expect(await readContext(page)).toEqual(context)

        // The expanded sidebar animates its responsive width for 180 ms.
        // Measure the actual settled scrollport without disabling that UI.
        const sidebar = page.locator('.sidebar')
        await expect(sidebar).not.toHaveClass(/collapsed/)
        await expect.poll(() => sidebar.evaluate(element => element.getAnimations().length)).toBe(0)

        // Genuine horizontal wheel scrolling exposes the far-edge trigger.
        // Never use hover's scrollIntoView or scripted scroll/focus repair.
        const strip = page.locator('.dbw-view-tab-list')
        const stripBox = await strip.boundingBox()
        expect(stripBox).not.toBeNull()
        if (!stripBox) throw new Error('View strip lacks a visible box.')
        await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2)
        await page.mouse.wheel(4000, 0)
        await expect.poll(() => strip.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThanOrEqual(1)
        const edge = page.getByRole('button', { name: (language === 'zh-CN' ? '视图菜单: ' : 'View menu: ') + edgeName, exact: true })
        const edgeMetrics = await geometry(edge)
        await edge.click()
        const edgeMenu = page.getByRole('dialog', { name: (language === 'zh-CN' ? '视图菜单: ' : 'View menu: ') + edgeName, exact: true })
        await expect(edgeMenu.getByRole('button', { name: language === 'zh-CN' ? '重命名' : 'Rename', exact: true })).toBeFocused()
        const narrowMetrics = await menuGeometry(edgeMenu)
        const narrow = await record(page, app, cdp, info, language, { edgeMetrics, narrowMetrics, context }, before,
          language + '-expanded-sidebar-760-far-edge-menu-full-viewport-and-controls-hit')
        expect(edgeMetrics.ratio).toBe(1)
        expect(edgeMetrics.hit).toBe(true)
        assertMenuGeometry(narrowMetrics)
        expect(narrow.writes).toEqual([])
        expect(narrow.stored).toEqual(before)
        expect(await readContext(page)).toEqual(context)
        await expect(edge).toHaveAttribute('aria-expanded', 'true')
        expect(await edge.getAttribute('aria-controls')).toBe(await edgeMenu.getAttribute('id'))
        await page.keyboard.press('Escape')
        await expect(edgeMenu).toHaveCount(0)
        await expect(edge).toBeFocused()

        await page.keyboard.press('Enter')
        await expect(edgeMenu).toHaveCount(1)
        const scrollLog = await focusLog(page)
        await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2)
        await page.mouse.wheel(-4000, 0)
        await expect(edgeMenu).toHaveCount(0)
        await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(0)
        await twoFrames(page)
        expect(await focusLog(page)).toEqual(scrollLog)
        expect(await readContext(page)).toEqual(context)
        const final = await record(page, app, cdp, info, language, { resizeLog, scrollLog, context }, before,
          language + '-resize-and-real-scroll-dismiss-without-return-focus-or-writing')
        expect(final.writes).toEqual([])
        expect(final.stored).toEqual(before)
        expect(final.state.confirmCount).toBe(0)
        expect(final.state.viewActionMenuCount).toBe(0)
        await expect(checkbox).toBeChecked()
        expect(errors).toEqual([])
      } finally { await cdp.detach() }
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
