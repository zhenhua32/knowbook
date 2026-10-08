import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type ProbeGlobal = typeof globalThis & { __databaseHeaderDensityWrites?: WriteRequest[] }
type Rectangle = { left: number; top: number; right: number; bottom: number; width: number; height: number }
const widths = [1280, 1081, 1080, 901, 900, 760]
const customName = 'Long custom database — ' + 'Quarterly research and project archive '.repeat(4).trim()
const longDescriptionName = customName + ' — retained description'
const shortDescription = 'Project records and notes.'
const longDescription = 'Keep the complete custom database description, record metadata, field values and saved view configuration when changing the window size or cancelling metadata edits.'

async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function setNativeSize(page: Page, app: ElectronApplication, width: number): Promise<void> {
  // Keep the product minimum unchanged and measure the native viewport itself.
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 760])
  await settle(page)
  await page.locator('.content.page-database').evaluate(element => { element.scrollTop = 0 })
}

async function setSidebar(page: Page, collapsed: boolean): Promise<void> {
  if (await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed')) !== collapsed) {
    await page.locator('.rail-toggle-btn').click(); await settle(page)
  }
  expect(await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed'))).toBe(collapsed)
}

async function prepare(page: Page, language: Language, theme: 'light' | 'dark') {
  await page.evaluate(async ({ language, theme, customName, longDescriptionName, shortDescription, longDescription }) => {
    const catalog = (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')!
    for (const [name, description] of [[customName, shortDescription], [longDescriptionName, longDescription]]) {
      const database = await window.knowbook.createDocumentDatabase({ name, description })
      const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
      await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Original density record', fieldValues: { [notes.id]: 'Original density value' } })
      const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Original density table', config: {
        version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [], groupBy: { fieldId: null },
        visibleFieldIds: ['__title__', notes.id], fieldOrder: ['__title__', notes.id], columnWidths: { __title__: 160, [notes.id]: 160 }, cardFieldIds: [notes.id]
      } })
      localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    }
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', theme)
    localStorage.setItem('knowbook.database.last-source', catalog.id)
  }, { language, theme, customName, longDescriptionName, shortDescription, longDescription })
  await page.reload(); await page.locator('[data-page-id="database"]').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
  await expect(page.locator('.dbw-header')).toBeVisible()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', getDatabaseWorkspaceText(language).allDocuments)
  await settle(page)
}

async function selectSource(page: Page, name: string, catalog = false): Promise<void> {
  await page.locator('.dbw-source-trigger').click()
  await expect(page.locator('.dbw-source-search input')).toBeFocused()
  await page.locator('.dbw-source-search input').fill(catalog ? '' : name)
  const option = catalog ? page.locator('.dbw-source-option').filter({ has: page.locator('.dbw-system-badge') })
    : page.locator('.dbw-source-option').filter({ has: page.getByText(name, { exact: true }) })
  await expect(option).toHaveCount(1); await option.click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', name)
  await expect(page.locator('.dbw-source-picker')).toHaveCount(0)
  await settle(page)
  if (!catalog) await expect(page.locator('.catalog-cell-input')).toHaveValue('Original density value')
}

async function installWriteProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const writes: WriteRequest[] = []; (globalThis as ProbeGlobal).__databaseHeaderDensityWrites = writes
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        writes.push({ channel, input: structuredClone(input) }); return original(event, ...input)
      })
    }
  })
}

async function readStored(page: Page, app: ElectronApplication, language: Language) {
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
      tables: Object.fromEntries(['documents', 'blocks', 'links', 'databases', 'document_database_columns', 'database_entities',
        'database_entity_values', 'document_database_values', 'database_saved_views'].map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()])) }
    } finally { database.close() }
  })
  return { api, sql }
}

function expectInside(child: Rectangle, parent: Rectangle, message: string): void {
  expect(child.width, `${message} width`).toBeGreaterThan(0); expect(child.height, `${message} height`).toBeGreaterThan(0)
  expect(child.left, `${message} left`).toBeGreaterThanOrEqual(parent.left - 1); expect(child.top, `${message} top`).toBeGreaterThanOrEqual(parent.top - 1)
  expect(child.right, `${message} right`).toBeLessThanOrEqual(parent.right + 1); expect(child.bottom, `${message} bottom`).toBeLessThanOrEqual(parent.bottom + 1)
}

async function recordHeader(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, phase: string,
  language: Language, width: number, name: string, description: string, custom: boolean, short = false) {
  await page.mouse.move(2, 2)
  const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({
    bounds: window.getBounds(), size: window.getSize(), content: window.getContentSize(), minimum: window.getMinimumSize(),
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
  const state = await page.locator('.dbw-header').evaluate(header => {
    const rectangle = (element: Element): Rectangle => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect(); return { left, top, right, bottom, width, height }
    }
    const text = (element: HTMLElement) => {
      const style = getComputedStyle(element); let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), box = parent.getBoundingClientRect()
        if (/hidden|clip|auto|scroll/.test(css.overflowX)) { left = Math.max(left, box.left + parent.clientLeft); right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth) }
        if (/hidden|clip|auto|scroll/.test(css.overflowY)) { top = Math.max(top, box.top + parent.clientTop); bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight) }
      }
      // Ellipsis painting occupies the trailing edge even when a Range still
      // reports the original glyph's geometry there. Reserve that area.
      if (style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1) right -= parseFloat(style.fontSize)
      const glyphs: Array<{ text: string; visible: boolean; box: Rectangle }> = []
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode, value = node.textContent ?? ''
        for (let index = 0; index < value.length;) {
          const glyph = String.fromCodePoint(value.codePointAt(index)!), range = document.createRange()
          range.setStart(node, index); range.setEnd(node, index + glyph.length)
          if (glyph.trim()) {
            const { left: l, top: t, right: r, bottom: b, width, height } = range.getBoundingClientRect()
            glyphs.push({ text: glyph, visible: l >= left - 1 && r <= right + 1 && t >= top - 1 && b <= bottom + 1,
              box: { left: l, top: t, right: r, bottom: b, width, height } })
          }
          index += glyph.length
        }
      }
      return { text: element.textContent, box: rectangle(element), glyphs, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        fontSize: style.fontSize, lineHeight: style.lineHeight, marginTop: style.marginTop, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace }
    }
    const css = getComputedStyle(header), content = header.closest<HTMLElement>('.content')!
    return { inner: [innerWidth, innerHeight], header: rectangle(header), minHeight: css.minHeight, padding: css.padding,
      identity: rectangle(header.querySelector('.dbw-identity')!), actionsBox: rectangle(header.querySelector('.dbw-header-actions')!),
      content: rectangle(content), horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      title: text(header.querySelector<HTMLElement>('.dbw-source-trigger > span:first-child')!), tooltip: header.querySelector('.dbw-source-trigger')!.getAttribute('title'),
      description: text(header.querySelector<HTMLElement>('.dbw-source-wrap > p')!),
      actions: Array.from(header.querySelectorAll<HTMLButtonElement>('.dbw-header-actions > button, .dbw-header-actions .dbw-menu-wrap > button')).map(button => {
        const box = button.getBoundingClientRect(), points = [[box.left + 3, box.top + box.height / 2], [box.right - 3, box.top + box.height / 2],
          [box.left + box.width / 2, box.top + 3], [box.left + box.width / 2, box.bottom - 3], [box.left + box.width / 2, box.top + box.height / 2]]
        return { box: rectangle(button), label: button.getAttribute('aria-label') || button.textContent, disabled: button.disabled,
          hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && button.contains(hit)) }) }
      }) }
  })
  const writes = await app.evaluate(() => (globalThis as ProbeGlobal).__databaseHeaderDensityWrites ?? [])
  const path = info.outputPath(`${phase}.json`); writeFileSync(path, JSON.stringify({ phase, native, tempRoot, state, writes }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' }); await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(native.userData.toLowerCase()).toBe(tempRoot.toLowerCase()); expect(native.windows).toHaveLength(1)
  expect(native.windows[0].content).toEqual([width, 760]); expect(native.windows[0].size).toEqual([native.windows[0].bounds.width, native.windows[0].bounds.height])
  expect(native.windows[0].minimum).toEqual([760, 760]); expect(state.inner).toEqual(native.windows[0].content)
  expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(writes).toEqual([]); expect(state.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(state.minHeight).toBe('76px'); expect(state.padding).toBe('12px 20px')
  const sameRow = Math.min(state.identity.bottom, state.actionsBox.bottom) - Math.max(state.identity.top, state.actionsBox.top) > 1
  expect(state.header.height, 'Actual compact header height follows its real row arrangement').toBeGreaterThanOrEqual(sameRow ? 77 : 133)
  expect(state.header.height, 'Compact header must leave available space for data').toBeLessThanOrEqual(sameRow ? 78 : 134)
  expect(state.title.fontSize).toBe('24px'); expect(state.title.lineHeight).toBe('32px')
  expect(state.title.text).toBe(name); expect(state.tooltip).toBe(name)
  expect(state.description.text).toBe(description); expect(state.description.fontSize).toBe('13px')
  expect(state.description.lineHeight).toBe('18px'); expect(state.description.marginTop).toBe('2px')
  expect(state.description.whiteSpace).toBe('nowrap')
  expectInside(state.header, state.content, 'database header'); expect(state.header.bottom).toBeLessThanOrEqual(760)
  expect(state.actions).toHaveLength(custom ? 3 : 2)
  for (const action of state.actions) {
    expectInside(action.box, state.header, `header action ${action.label}`)
    expect(action.box.height).toBeGreaterThanOrEqual(40); expect(action.box.width).toBeGreaterThanOrEqual(40)
    expect(action.disabled).toBe(false); expect(action.hits.every(Boolean)).toBe(true)
  }
  expect(state.title.glyphs.length).toBeGreaterThan(0)
  if (!custom) expect(state.title.glyphs.every(glyph => glyph.visible)).toBe(true)
  else {
    expect(state.title.textOverflow).toBe('ellipsis')
    expect(state.title.glyphs.slice(0, 8).every(glyph => glyph.visible)).toBe(true)
  }
  if (short || !custom) {
    expect(state.description.glyphs.every(glyph => glyph.visible)).toBe(true)
    expect(state.description.scrollWidth).toBeLessThanOrEqual(state.description.clientWidth + 1)
  } else expect(state.description.glyphs.slice(0, 8).every(glyph => glyph.visible)).toBe(true)
  return state
}

async function popupEvidence(page: Page, app: ElectronApplication, info: TestInfo, phase: string, selector: string, controls: string) {
  const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    content: window.getContentSize(), minimum: window.getMinimumSize(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  const inner = await page.evaluate(() => [innerWidth, innerHeight])
  const surface = await page.locator(selector).evaluate((element, controls) => {
    const geometry = (node: Element) => {
      const rect = node.getBoundingClientRect(); let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), box = parent.getBoundingClientRect()
        if (/hidden|clip|auto|scroll/.test(css.overflowX)) { left = Math.max(left, box.left + parent.clientLeft); right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth) }
        if (/hidden|clip|auto|scroll/.test(css.overflowY)) { top = Math.max(top, box.top + parent.clientTop); bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight) }
        if (css.position === 'fixed') break
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        clip: { left, top, right, bottom, width: right - left, height: bottom - top }, hit: Boolean(hit && node.contains(hit)) }
    }
    return { root: geometry(element), controls: Array.from(element.querySelectorAll(controls)).map(geometry) }
  }, controls)
  const path = info.outputPath(`${phase}.json`); writeFileSync(path, JSON.stringify({ native, inner, surface }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' }); await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expectInside(surface.root.box, surface.root.clip, `${phase} surface`)
  expect(native).toHaveLength(1); expect(native[0].content).toEqual(inner); expect(native[0].minimum).toEqual([760, 760])
  expect(native.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  for (const control of surface.controls) { expectInside(control.box, control.clip, `${phase} control`); expect(control.hit).toBe(true) }
}

async function exercisePopups(page: Page, app: ElectronApplication, info: TestInfo, language: Language, custom: boolean, name: string, description: string, phase: string) {
  const text = getDatabaseWorkspaceText(language), source = page.locator('.dbw-source-trigger')
  await source.click(); await expect(page.locator('.dbw-source-search input')).toBeFocused()
  for (const width of [1280, 760]) {
    await setNativeSize(page, app, width)
    await expect(page.locator('.dbw-source-search input')).toBeFocused()
    await popupEvidence(page, app, info, `${phase}-picker-open-resize-${width}`, '.dbw-source-picker', '.dbw-source-search input, .dbw-menu-create')
  }
  await page.keyboard.press('Escape'); await expect(page.locator('.dbw-source-picker')).toHaveCount(0); await expect(source).toBeFocused()
  if (!custom) return
  const settings = page.getByRole('button', { name: text.databaseSettings, exact: true })
  await settings.click(); await popupEvidence(page, app, info, `${phase}-settings-menu`, '.dbw-header .dbw-action-menu', 'button')
  await page.keyboard.press('Escape'); await expect(page.locator('.dbw-header .dbw-action-menu')).toHaveCount(0); await expect(settings).toBeFocused()
  await settings.click(); await page.locator('.dbw-header .dbw-action-menu').getByRole('button', { name: text.editDatabase, exact: true }).click()
  const form = page.locator('.dbw-form-dialog'), field = form.getByRole('textbox', { name: text.name, exact: true })
  await expect(field).toBeFocused(); await expect(field).toHaveValue(name)
  await expect(form.getByRole('textbox', { name: text.description, exact: true })).toHaveValue(description)
  await popupEvidence(page, app, info, `${phase}-edit-dialog`, '.dbw-form-dialog', 'input, textarea, footer button')
  await field.fill('Discard this density metadata edit')
  await form.getByRole('button', { name: text.cancel, exact: true }).click()
  await expect(form).toHaveCount(0); await expect(settings).toBeFocused()
  await expect(source).toHaveAttribute('title', name)
  await expect(page.locator('.dbw-source-wrap > p')).toHaveText(description)
}

for (const language of ['en-US', 'zh-CN'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`database header stays compact and reachable in native windows ${language} ${theme} @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.'); test.setTimeout(180_000)
    await withElectronApp(async ({ page, app, tempRoot }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      await prepare(page, language, theme)
      const before = await readStored(page, app, language); await installWriteProbe(app)
      const catalog = getDatabaseWorkspaceText(language)
      for (const source of [{ name: catalog.allDocuments, description: catalog.catalogDescription, custom: false },
        { name: customName, description: shortDescription, custom: true }]) {
        if (source.custom) await selectSource(page, source.name)
        for (const collapsed of [false, true]) {
          await setSidebar(page, collapsed)
          for (const width of widths) {
            await setNativeSize(page, app, width)
            await recordHeader(page, app, tempRoot, info, `${source.custom ? 'custom' : 'catalog'}-${width}-${collapsed ? 'collapsed' : 'expanded'}`,
              language, width, source.name, source.description, source.custom, source.custom)
          }
        }
        await setSidebar(page, false)
        await exercisePopups(page, app, info, language, source.custom, source.name, source.description, source.custom ? 'custom-760' : 'catalog-760')
        await page.locator('[data-page-id="settings"]').click(); await expect(page.locator('.settings-layout')).toBeVisible()
        await page.locator('[data-page-id="database"]').click(); await expect(page.locator('.dbw-header')).toBeVisible(); await settle(page)
        await recordHeader(page, app, tempRoot, info, `${source.custom ? 'custom' : 'catalog'}-return-from-settings`,
          language, 760, source.name, source.description, source.custom, source.custom)
      }
      await selectSource(page, longDescriptionName)
      for (const width of [1280, 760]) {
        await setNativeSize(page, app, width)
        await recordHeader(page, app, tempRoot, info, `long-description-${width}`, language, width, longDescriptionName, longDescription, true)
      }
      await exercisePopups(page, app, info, language, true, longDescriptionName, longDescription, 'long-description-760')
      const after = await readStored(page, app, language)
      const writes = await app.evaluate(() => (globalThis as ProbeGlobal).__databaseHeaderDensityWrites!)
      writeFileSync(info.outputPath('persistence.json'), JSON.stringify({ before, after, writes }, null, 2))
      expect(writes).toEqual([]); expect(after).toEqual(before); expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}

test('database header keeps its native layout in all six built-in palettes @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.'); test.setTimeout(180_000)
  await withElectronApp(async ({ page, app, tempRoot }) => {
    await prepare(page, 'en-US', 'light'); const before = await readStored(page, app, 'en-US'); await installWriteProbe(app)
    await expect.poll(async () => (await page.evaluate(() => window.knowbook.listSystemPlugins()))
      .find(plugin => plugin.pluginId === 'theme-switcher')?.runtimeStatus).toBe('active')
    const text = getDatabaseWorkspaceText('en-US')
    for (const palette of ['cloud', 'paper', 'moss', 'bay', 'midnight', 'violet']) {
      await page.evaluate(async themeId => {
        const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')!
        await window.knowbook.invokeSystemPluginMain({ pluginId: plugin.pluginId, revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'set-theme', input: { themeId } })
      }, palette)
      await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', palette)
      for (const source of [{ name: text.allDocuments, description: text.catalogDescription, custom: false },
        { name: customName, description: shortDescription, custom: true }]) {
        await selectSource(page, source.name, !source.custom)
        for (const width of [1280, 760]) {
          await setNativeSize(page, app, width)
          await recordHeader(page, app, tempRoot, info, `${palette}-${source.custom ? 'custom' : 'catalog'}-${width}`,
            'en-US', width, source.name, source.description, source.custom, source.custom)
        }
      }
    }
    const after = await readStored(page, app, 'en-US'), writes = await app.evaluate(() => (globalThis as ProbeGlobal).__databaseHeaderDensityWrites!)
    writeFileSync(info.outputPath('persistence.json'), JSON.stringify({ before, after, writes }, null, 2))
    expect(writes).toEqual([]); expect(after).toEqual(before)
  })
})
