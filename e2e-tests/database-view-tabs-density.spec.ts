import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Theme = 'light' | 'dark'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type ProbeGlobal = typeof globalThis & { __viewTabsDensityWrites?: WriteRequest[] }
const sourceName = 'Tabs density source'
const recordTitle = 'Original view density record'
const names = Array.from({ length: 11 }, (_, index) => index === 4 || index === 10
  ? `项目资料视图 ${index + 1} — Research records 与长期知识整理：用于检查中文长标题、完整提示和键盘焦点`
  : `${index === 0 ? 'Primary' : `Working ${index + 1}`} view — Research records and project knowledge with a deliberately long title`)

async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function resize(page: Page, app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 760])
  await settle(page)
  await page.locator('.content.page-database').evaluate(element => { element.scrollTop = 0 })
}

async function collapse(page: Page, collapsed: boolean): Promise<void> {
  if (await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed')) !== collapsed) {
    await page.locator('.rail-toggle-btn').click()
  }
  await settle(page)
}

async function prepare(page: Page, language: Language, theme: Theme) {
  const fixture = await page.evaluate(async ({ language, theme, sourceName, recordTitle, names }) => {
    const catalog = (await window.knowbook.getDatabases()).find(database => database.kind === 'document-catalog')!
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Keep view drafts and selected records.' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const entity = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: recordTitle, fieldValues: { [field.id]: 'Original Notes' } })
    const config = { version: 1 as const, layout: 'table' as const, query: 'Original', filters: { operator: 'and' as const, rules: [] }, sorts: [],
      groupBy: { fieldId: null }, visibleFieldIds: ['__title__', field.id], fieldOrder: ['__title__', field.id], columnWidths: {}, cardFieldIds: [field.id] }
    const views = []
    for (const name of names) views.push(await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name, viewMode: 'table', config }))
    localStorage.setItem('knowbook.database.last-source', catalog.id)
    localStorage.setItem(`knowbook.database.last-view.${database.id}`, views[0].id)
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', theme)
    return { catalogId: catalog.id, customId: database.id, entityId: entity.id, primaryId: views[0].id }
  }, { language, theme, sourceName, recordTitle, names })
  await page.reload(); await page.locator('[data-page-id="database"]').click()
  await expect(page.locator('.dbw-view-tabs')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
  await settle(page)
  return fixture
}

async function selectSource(page: Page, language: Language, custom: boolean): Promise<void> {
  const name = custom ? sourceName : getDatabaseWorkspaceText(language).allDocuments
  if (await page.locator('.dbw-source-trigger').getAttribute('title') !== name) {
    await page.locator('.dbw-source-trigger').click()
    await page.locator('.dbw-source-search input').fill(custom ? sourceName : '')
    const option = custom ? page.locator('.dbw-source-option').filter({ hasText: sourceName })
      : page.locator('.dbw-source-option').filter({ has: page.locator('.dbw-system-badge') })
    await expect(option).toHaveCount(1); await option.click()
  }
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', name)
  await expect(page.locator('.dbw-view-tab-list > .dbw-view-tab-wrap')).toHaveCount(custom ? 11 : 0)
  await expect(page.locator('.dbw-view-tab-list .dbw-view-tab')).toHaveCount(custom ? 11 : 1)
  await expect(page.locator('.dbw-view-tab-menu')).toHaveCount(custom ? 11 : 0)
  if (custom) {
    await expect(page.locator('.dbw-view-tab-wrap.is-active > .dbw-view-tab')).toHaveAttribute('title', names[0])
    await page.locator('.dbw-main-search input').fill('Original view')
    const checkbox = page.locator('tbody > tr').filter({ hasText: recordTitle }).locator('.dbw-select-column input')
    await checkbox.check(); await expect(checkbox).toBeChecked()
    await expect(page.locator('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')).toHaveCount(1)
  } else {
    await expect(page.locator('.dbw-view-tab-list > .dbw-view-tab')).toHaveText(getDatabaseWorkspaceText(language).all)
  }
  await settle(page)
}

async function context(page: Page) {
  return page.evaluate(() => ({ source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
    activeView: document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.getAttribute('title'),
    query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
    dirty: Boolean(document.querySelector('.dbw-view-tab-wrap.is-active .dbw-unsaved-dot')),
    selected: Array.from(document.querySelectorAll('tbody > tr.is-selected .dbw-record-title strong')).map(element => element.textContent),
    notes: document.querySelector<HTMLInputElement>('tbody .catalog-cell-input[aria-label="Notes"]')?.value }))
}

async function stored(page: Page, app: ElectronApplication, language: Language) {
  const api = await page.evaluate(async language => {
    const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)
    const databases = (await window.knowbook.getDatabases()).sort(byId), catalog = (await window.knowbook.getDocumentCatalog()).sort(byId)
    return { databases, catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: (await window.knowbook.listDocumentTemplates(language)).sort(byId),
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort(byId), fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort(byId),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort(byId) }))) }
  }, language)
  const sql = await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try { return { schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
      tables: Object.fromEntries(['documents', 'blocks', 'links', 'databases', 'document_database_columns', 'database_entities', 'database_entity_values',
        'document_database_values', 'database_saved_views'].map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()])) }
    } finally { database.close() }
  })
  return { api, sql }
}

async function installProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const writes: WriteRequest[] = []; (globalThis as ProbeGlobal).__viewTabsDensityWrites = writes
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => { writes.push({ channel, input: structuredClone(input) }); return original(event, ...input) })
    }
  })
}

async function geometry(target: Locator) {
  return target.evaluate(element => {
    const rectangle = (node: Element) => node.getBoundingClientRect().toJSON()
    const css = getComputedStyle(element), box = element.getBoundingClientRect()
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    const ancestors = []
    for (let ancestor = element as HTMLElement | null; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
      const bl = parseFloat(style.borderLeftWidth), br = parseFloat(style.borderRightWidth), bt = parseFloat(style.borderTopWidth), bb = parseFloat(style.borderBottomWidth)
      // Only occupied scrollbar space uses rounded client/offset dimensions;
      // clip edges retain the actual fractional DOMRect padding boundaries.
      const sx = /auto|scroll/.test(style.overflowX) ? Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - Math.round(bt + bb)) : 0
      const sy = /auto|scroll/.test(style.overflowY) ? Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - Math.round(bl + br)) : 0
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, bounds.left + bl); right = Math.min(right, bounds.right - br - sy) }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, bounds.top + bt); bottom = Math.min(bottom, bounds.bottom - bb - sx) }
      ancestors.push({ className: ancestor.className, bounds: rectangle(ancestor), sx, sy, overflowX: style.overflowX, overflowY: style.overflowY })
      if (style.position === 'fixed') break
    }
    const extent = element.matches(':focus-visible') ? Math.max(0, parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset)) : 0
    const focus = { left: box.left - extent, top: box.top - extent, right: box.right + extent, bottom: box.bottom + extent }
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    const rgba = (value: string) => { const values = value.match(/[\d.]+/g)!.map(Number); return [values[0], values[1], values[2], values[3] ?? 1] }
    const luminance = (color: number[]) => { const [r, g, b] = color.slice(0, 3).map(channel => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4 }); return .2126 * r + .7152 * g + .0722 * b }
    const parents: Element[] = []; for (let parent: Element | null = element; parent; parent = parent.parentElement) parents.push(parent)
    let background = [255, 255, 255]
    for (const parent of parents.reverse()) { const color = rgba(getComputedStyle(parent).backgroundColor); background = color.slice(0, 3).map((channel, index) => channel * color[3] + background[index] * (1 - color[3])) }
    const outline = rgba(css.outlineColor), effective = outline.slice(0, 3).map((channel, index) => channel * outline[3] + background[index] * (1 - outline[3]))
    const foreground = luminance(effective), behind = luminance(background)
    const glyphs: Array<{ text: string; bounds: ReturnType<typeof rectangle>; visible: boolean; vertical: boolean }> = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode, value = node.textContent ?? ''
      for (let index = 0; index < value.length;) {
        const glyph = String.fromCodePoint(value.codePointAt(index)!), range = document.createRange()
        range.setStart(node, index); range.setEnd(node, index + glyph.length)
        if (glyph.trim()) {
          const bounds = range.getBoundingClientRect(), owner = (node.parentElement ?? element).getBoundingClientRect()
          const visibleLeft = Math.max(left, owner.left), visibleRight = Math.min(right, owner.right)
          glyphs.push({ text: glyph, bounds: bounds.toJSON(), vertical: bounds.top >= top - .5 && bounds.bottom <= bottom + .5,
            visible: bounds.width > 0 && bounds.height > 0 && bounds.left >= visibleLeft - .5 && bounds.right <= visibleRight + .5 && bounds.top >= top - .5 && bounds.bottom <= bottom + .5 })
        }
        index += glyph.length
      }
    }
    const nav = element.closest('.dbw-view-tabs')!, list = nav.querySelector<HTMLElement>('.dbw-view-tab-list')!, span = element.querySelector<HTMLElement>(':scope > span:not([aria-hidden]):not(.dbw-unsaved-dot)')
    const dot = element.querySelector('.dbw-unsaved-dot')
    const active = nav.querySelector<HTMLElement>('.dbw-view-tab-wrap.is-active'), activeCss = active && getComputedStyle(active)
    return { bounds: rectangle(element), focus, clip: { left, top, right, bottom },
      clipped: focus.left < left - .5 || focus.top < top - .5 || focus.right > right + .5 || focus.bottom > bottom + .5,
      hit: hit === element || Boolean(hit && element.contains(hit)), focusVisible: element.matches(':focus-visible'),
      text: element.textContent, title: element.getAttribute('title'), label: element.getAttribute('aria-label'), tag: element.tagName, className: element.className,
      color: css.color, outline: { width: css.outlineWidth, offset: css.outlineOffset, color: css.outlineColor, style: css.outlineStyle },
      contrast: (Math.max(foreground, behind) + .05) / (Math.min(foreground, behind) + .05), background, glyphs,
      ellipsis: span ? { text: span.textContent, textOverflow: getComputedStyle(span).textOverflow, overflow: getComputedStyle(span).overflowX } : null,
      dirtyDot: dot && rectangle(dot),
      inner: [innerWidth, innerHeight], horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      outerScroll: document.querySelector('.content.page-database')!.scrollTop,
      nav: rectangle(nav), list: rectangle(list), listClientHeight: list.clientHeight, listClientWidth: list.clientWidth,
      scrollLeft: list.scrollLeft, scrollWidth: list.scrollWidth, gutter: list.offsetHeight - list.clientHeight,
      active: active && { bounds: rectangle(active), borderWidth: activeCss!.borderBottomWidth, borderStyle: activeCss!.borderBottomStyle, borderColor: activeCss!.borderBottomColor }, ancestors }
  })
}

async function recordFocus(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, phase: string, target: Locator,
  expected: Awaited<ReturnType<typeof context>>, evidence: unknown[], screenshot = false): Promise<void> {
  await settle(page); await expect(target).toBeFocused()
  const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({
    bounds: window.getBounds(), size: window.getSize(), content: window.getContentSize(), minimum: window.getMinimumSize(),
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
  const metrics = await geometry(target), current = await context(page)
  evidence.push({ phase, native, tempRoot, metrics, context: current })
  writeFileSync(info.outputPath('focus.json'), JSON.stringify(evidence, null, 2))
  expect(native.userData.toLowerCase()).toBe(tempRoot.toLowerCase())
  expect(native.windows).toHaveLength(1)
  const window = native.windows[0]
  expect(window.minimum).toEqual([760, 760]); expect(metrics.inner).toEqual(window.content)
  expect([window.bounds.width, window.bounds.height]).toEqual(window.size)
  expect([window.visible, window.focused, window.focusable]).toEqual([false, false, false])
  expect(current).toEqual(expected)
  expect(metrics.focusVisible, phase).toBe(true); expect(metrics.clipped, phase).toBe(false); expect(metrics.hit, phase).toBe(true)
  expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(metrics.outerScroll).toBe(0)
  expect(metrics.outline.style).toBe('solid'); expect(parseFloat(metrics.outline.width)).toBeGreaterThanOrEqual(2)
  expect(metrics.contrast, `${phase} focus contrast`).toBeGreaterThanOrEqual(3)
  // A compact strip may grow naturally to accommodate the occupied native
  // scrollbar. Preserve control targets instead of forcing every strip to 44px.
  expect(metrics.nav.height, `${phase} compact strip with native gutter`).toBeLessThanOrEqual(44 + metrics.gutter + .5)
  expect(metrics.listClientHeight).toBeGreaterThanOrEqual(36)
  if (metrics.className.includes('dbw-view-tab-menu')) {
    expect(metrics.bounds.width).toBeGreaterThanOrEqual(24); expect(metrics.bounds.height).toBeGreaterThanOrEqual(32)
    expect(metrics.label).toBe(metrics.title); expect(names.some(name => metrics.label?.endsWith(name))).toBe(true)
    expect(metrics.glyphs.every(glyph => glyph.visible)).toBe(true)
    expect(metrics.color).not.toMatch(/transparent|rgba\([^)]*,\s*0\)/)
  } else {
    expect(metrics.bounds.height).toBeGreaterThanOrEqual(36)
    if (metrics.ellipsis) {
      expect(metrics.ellipsis.text).toBe(metrics.title); expect(metrics.ellipsis.textOverflow).toBe('ellipsis')
      expect(metrics.glyphs.some(glyph => glyph.visible)).toBe(true)
      expect(metrics.glyphs.every(glyph => glyph.vertical)).toBe(true)
    } else expect(metrics.glyphs.every(glyph => glyph.visible)).toBe(true)
  }
  if (metrics.active) {
    expect(parseFloat(metrics.active.borderWidth)).toBeGreaterThanOrEqual(2)
    expect(metrics.active.borderStyle).toBe('solid')
    expect(metrics.active.bounds.bottom).toBeLessThanOrEqual(metrics.list.bottom - metrics.gutter + .5)
  }
  if (metrics.dirtyDot) {
    expect(metrics.dirtyDot.width).toBeGreaterThan(0); expect(metrics.dirtyDot.height).toBeGreaterThan(0)
    expect(metrics.dirtyDot.left).toBeGreaterThanOrEqual(metrics.clip.left - .5)
    expect(metrics.dirtyDot.right).toBeLessThanOrEqual(metrics.clip.right + .5)
    expect(metrics.dirtyDot.top).toBeGreaterThanOrEqual(metrics.clip.top - .5)
    expect(metrics.dirtyDot.bottom).toBeLessThanOrEqual(metrics.clip.bottom + .5)
  }
  if (screenshot) await page.screenshot({ path: info.outputPath(`${phase}.png`) })
}

async function traverse(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, phase: string, custom: boolean, evidence: unknown[]): Promise<void> {
  const expected = await context(page), titles = page.locator('.dbw-view-tab-list .dbw-view-tab'), menus = page.locator('.dbw-view-tab-menu')
  const newView = page.locator('.dbw-new-view-menu > summary'), query = page.locator('.dbw-main-search input')
  if (custom) expect(expected).toMatchObject({ activeView: names[0], query: 'Original view', dirty: true, selected: [recordTitle], notes: 'Original Notes' })
  await query.click(); await page.keyboard.press('Shift+Tab')
  await recordFocus(page, app, tempRoot, info, `${phase}-new-summary`, newView, expected, evidence, true)
  for (let index = custom ? 10 : 0; index >= 0; index--) {
    if (custom) { await page.keyboard.press('Shift+Tab'); await recordFocus(page, app, tempRoot, info, `${phase}-reverse-menu-${index}`, menus.nth(index), expected, evidence, index === 10) }
    await page.keyboard.press('Shift+Tab'); await recordFocus(page, app, tempRoot, info, `${phase}-reverse-title-${index}`, titles.nth(index), expected, evidence, index === 0)
  }
  for (let index = 0; index < (custom ? 11 : 1); index++) {
    if (index) { await page.keyboard.press('Tab'); await recordFocus(page, app, tempRoot, info, `${phase}-forward-title-${index}`, titles.nth(index), expected, evidence) }
    if (custom) { await page.keyboard.press('Tab'); await recordFocus(page, app, tempRoot, info, `${phase}-forward-menu-${index}`, menus.nth(index), expected, evidence, index === 0) }
  }
  await page.keyboard.press('Tab'); await recordFocus(page, app, tempRoot, info, `${phase}-forward-new-summary`, newView, expected, evidence)
}

async function endpoints(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, phase: string, custom: boolean, evidence: unknown[]): Promise<void> {
  const expected = await context(page), titles = page.locator('.dbw-view-tab-list .dbw-view-tab'), menus = page.locator('.dbw-view-tab-menu')
  await page.locator('.dbw-main-search input').click(); await page.keyboard.press('Shift+Tab')
  await recordFocus(page, app, tempRoot, info, `${phase}-new-summary`, page.locator('.dbw-new-view-menu > summary'), expected, evidence, true)
  if (!custom) {
    await page.keyboard.press('Shift+Tab'); await recordFocus(page, app, tempRoot, info, `${phase}-all-title`, titles.first(), expected, evidence)
    return
  }
  expect(expected).toMatchObject({ activeView: names[0], query: 'Original view', dirty: true, selected: [recordTitle], notes: 'Original Notes' })
  await page.keyboard.press('Shift+Tab'); await recordFocus(page, app, tempRoot, info, `${phase}-right-menu`, menus.last(), expected, evidence, true)
  await page.keyboard.press('Shift+Tab'); await recordFocus(page, app, tempRoot, info, `${phase}-right-title`, titles.last(), expected, evidence)
  for (let step = 0; step < 20; step++) await page.keyboard.press('Shift+Tab')
  await recordFocus(page, app, tempRoot, info, `${phase}-left-title`, titles.first(), expected, evidence, true)
  await page.keyboard.press('Tab'); await recordFocus(page, app, tempRoot, info, `${phase}-left-menu`, menus.first(), expected, evidence)
}

async function menuAndScrolling(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, language: Language, evidence: unknown[]): Promise<void> {
  await collapse(page, false); await resize(page, app, 1280)
  const expected = await context(page), trigger = page.locator('.dbw-view-tab-menu').last(), menu = page.locator('.dbw-view-actions-menu')
  await page.locator('.dbw-main-search input').click(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab')
  // Activate immediately after native keyboard focus. Settling or measuring
  // here would hide a queued scroll event that wrongly dismisses this menu.
  await page.keyboard.press('Enter'); await expect(menu).toBeVisible()
  const rename = menu.getByRole('button', { name: getDatabaseWorkspaceText(language).rename, exact: true })
  const remove = menu.getByRole('button', { name: getDatabaseWorkspaceText(language).deleteView, exact: true })
  await expect(rename).toBeFocused()
  await settle(page); await expect(menu).toBeVisible(); await expect(rename).toBeFocused()
  for (const [key, owner] of [['ArrowUp', remove], ['ArrowDown', rename], ['End', remove], ['Home', rename]] as const) {
    await page.keyboard.press(key); await expect(owner).toBeFocused(); await expect(menu).toBeVisible()
    const metrics = await geometry(owner)
    expect(metrics.clipped).toBe(false); expect(metrics.hit).toBe(true); expect(await context(page)).toEqual(expected)
    evidence.push({ phase: `menu-${key}`, metrics })
  }
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0)
  await recordFocus(page, app, tempRoot, info, '1280-menu-escape-return', trigger, expected, evidence)
  await page.keyboard.press('Enter'); await expect(menu).toBeVisible()
  await resize(page, app, 760); await expect(menu).toHaveCount(0); expect(await context(page)).toEqual(expected)
  const strip = page.locator('.dbw-view-tab-list'), bounds = await strip.boundingBox()
  expect(bounds).not.toBeNull(); if (!bounds) throw new Error('The real view scrollport has no bounds.')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.wheel(5000, 0)
  await expect.poll(() => strip.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThanOrEqual(1)
  await trigger.click(); await expect(rename).toBeFocused()
  const popup = await geometry(menu)
  expect(popup.clipped).toBe(false); expect(popup.hit).toBe(true)
  evidence.push({ phase: '760-wheel-right-menu', popup, context: await context(page) })
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.wheel(-5000, 0)
  await expect(menu).toHaveCount(0); await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(0)
  expect(await context(page)).toEqual(expected)
  const summary = page.locator('.dbw-new-view-menu > summary')
  await page.locator('.dbw-main-search input').click(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter')
  await expect(page.locator('.dbw-new-view-menu')).toHaveAttribute('open', '')
  const layouts = page.locator('.dbw-new-view-menu .dbw-layout-menu button')
  await expect(layouts).toHaveCount(3)
  await page.keyboard.press('Tab'); await expect(layouts.first()).toBeFocused()
  await page.keyboard.press('Escape'); await expect(page.locator('.dbw-new-view-menu')).not.toHaveAttribute('open')
  await recordFocus(page, app, tempRoot, info, '760-new-view-escape-return', summary, expected, evidence, true)
}

for (const { language, theme } of [{ language: 'en-US', theme: 'light' }, { language: 'zh-CN', theme: 'dark' }] as const) {
  test(`Compact view strip keeps native keyboard focus and data in ${language} ${theme} @electron`, async ({}, info) => {
    test.setTimeout(300_000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app, tempRoot }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const fixture = await prepare(page, language, theme), before = await stored(page, app, language)
      await installProbe(app)
      const evidence: unknown[] = []
      for (const custom of [false, true]) {
        await selectSource(page, language, custom)
        for (const collapsed of [false, true]) {
          await collapse(page, collapsed)
          for (const width of [1280, 760]) {
            await resize(page, app, width)
            await traverse(page, app, tempRoot, info, `${custom ? 'custom' : 'catalog'}-${collapsed ? 'collapsed' : 'expanded'}-${width}`, custom, evidence)
          }
        }
      }
      await menuAndScrolling(page, app, tempRoot, info, language, evidence)
      const expected = await context(page)
      await page.locator('[data-page-id="settings"]').click()
      await expect(page.getByRole('tablist', { name: language === 'zh-CN' ? '设置分类' : 'Settings categories', exact: true })).toBeVisible()
      await expect(page.locator('.dbw-view-tabs')).toHaveCount(0)
      await page.locator('[data-page-id="database"]').click()
      await settle(page)
      const returned = { ...expected, query: 'Original', dirty: false, selected: [] }
      // Existing route reload discards the transient query and row selection.
      // Verify that behavior, then rebuild the real draft fixture for focus QA.
      await expect.poll(() => context(page)).toEqual(returned)
      expect(await stored(page, app, language)).toEqual(before)
      evidence.push({ phase: 'settings-return-existing-route-reload', before: expected, after: await context(page) })
      await selectSource(page, language, true)
      await endpoints(page, app, tempRoot, info, '760-settings-return', true, evidence)
      const after = await stored(page, app, language), writes = await app.evaluate(() => (globalThis as ProbeGlobal).__viewTabsDensityWrites!)
      expect(after).toEqual(before); expect(writes).toEqual([]); expect(errors).toEqual([])
      writeFileSync(info.outputPath('persistence.json'), JSON.stringify({ fixture, before, after, writes, errors }, null, 2))
      writeFileSync(info.outputPath('focus.json'), JSON.stringify(evidence, null, 2))
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}

test('Compact view strip focus remains visible in six real built-in palettes @electron', async ({}, info) => {
  test.setTimeout(240_000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app, tempRoot }) => {
    const fixture = await prepare(page, 'en-US', 'light'), before = await stored(page, app, 'en-US')
    await installProbe(app); await resize(page, app, 760)
    const evidence: unknown[] = []
    await expect.poll(async () => (await page.evaluate(() => window.knowbook.listSystemPlugins()))
      .find(plugin => plugin.pluginId === 'theme-switcher')?.runtimeStatus).toBe('active')
    for (const palette of ['cloud', 'paper', 'moss', 'bay', 'midnight', 'violet']) {
      await page.evaluate(async themeId => {
        const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')!
        await window.knowbook.invokeSystemPluginMain({ pluginId: plugin.pluginId, revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'set-theme', input: { themeId } })
      }, palette)
      await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', palette)
      await selectSource(page, 'en-US', false)
      await endpoints(page, app, tempRoot, info, `${palette}-catalog-760`, false, evidence)
      await selectSource(page, 'en-US', true)
      await endpoints(page, app, tempRoot, info, `${palette}-custom-760`, true, evidence)
    }
    const after = await stored(page, app, 'en-US'), writes = await app.evaluate(() => (globalThis as ProbeGlobal).__viewTabsDensityWrites!)
    expect(after).toEqual(before); expect(writes).toEqual([])
    writeFileSync(info.outputPath('persistence.json'), JSON.stringify({ fixture, before, after, writes }, null, 2))
  })
})
