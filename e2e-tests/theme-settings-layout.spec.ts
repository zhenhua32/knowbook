import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Catalog = { themes: Array<{ id: string; name: string; description: string; mode: 'light' | 'dark' }>; css: string }
type Request = { channel: string; input: unknown[] }
type Probe = typeof globalThis & { __themeLayoutRequests?: Request[] }
const ids = ['cloud', 'paper', 'moss', 'bay', 'midnight', 'violet', 'default'] as const
const marker = 'Appearance theme picker integration.'

async function invoke(page: Page, method: string) {
  return page.evaluate(async method => {
    const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')!
    return window.knowbook.invokeSystemPluginMain({ pluginId: plugin.pluginId, revisionHash: `sha256:${plugin.currentArtifactSha256}`, method })
  }, method)
}

async function settle(page: Page) {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function nativeSize(page: Page, app: ElectronApplication, width: number, collapsed: boolean) {
  if (await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed')) !== collapsed) await page.locator('.rail-toggle-btn').click()
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 760]); await settle(page)
}

async function tabTo(page: Page, target: Locator) {
  const path = []
  for (let step = 0; step <= 128; step++) {
    const state = await target.evaluate(element => ({ reached: document.activeElement === element, tag: document.activeElement?.tagName,
      id: (document.activeElement as HTMLElement | null)?.dataset.testid, label: document.activeElement?.getAttribute('aria-label') }))
    path.push(state); if (state.reached || step === 128) break
    await page.keyboard.press('Tab')
  }
  writeFileSync(test.info().outputPath('last-keyboard-path.json'), JSON.stringify(path, null, 2)); await expect(target).toBeFocused()
}

async function stored(page: Page, app: ElectronApplication) {
  const api = await page.evaluate(async () => {
    const byId = (first: { id: string }, second: { id: string }) => first.id.localeCompare(second.id)
    const databases = (await window.knowbook.getDatabases()).sort(byId)
    return { databases, documents: (await window.knowbook.getDocumentCatalog()).sort(byId), sources: await Promise.all(databases.map(async database => ({ id: database.id,
      records: (await window.knowbook.getDatabaseEntities(database.id)).sort(byId), fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort(byId), views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort(byId) }))) }
  })
  const sql = await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3'), database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try { return { schema: database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      tables: Object.fromEntries(['documents', 'blocks', 'links', 'databases', 'document_database_columns', 'database_entities', 'database_entity_values', 'document_database_values', 'database_saved_views']
        .map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1,2`).all()])) } } finally { database.close() }
  })
  return { api, sql }
}

async function capture(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, phase: string, catalog: Catalog, requireFocus = false) {
  await settle(page)
  const plugin = (await page.evaluate(() => window.knowbook.listSystemPlugins())).find(plugin => plugin.pluginId === 'theme-switcher')!
  const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({ content: window.getContentSize(), minimum: window.getMinimumSize(), size: window.getSize(), bounds: window.getBounds(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
  const metrics = await page.getByTestId('theme-switcher-settings').evaluate(inner => {
    const measure = (element: Element) => { const css = getComputedStyle(element); return { bounds: element.getBoundingClientRect().toJSON(), padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft],
      border: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth], background: css.backgroundColor, radius: css.borderRadius, shadow: css.boxShadow, scroll: [element.scrollWidth, element.scrollHeight], client: [element.clientWidth, element.clientHeight], scrollTop: element.scrollTop } }
    const wrapper = inner.closest<HTMLElement>('.plugin-full-trust-view')!, panel = inner.closest<HTMLElement>('.settings-category-panel')!
    const options = [...inner.querySelectorAll<HTMLButtonElement>('button')].map(button => {
      const css = getComputedStyle(button), bounds = button.getBoundingClientRect(), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, ancestors = []
      for (let parent = button.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), area = parent.getBoundingClientRect(), border = { left: parseFloat(style.borderLeftWidth), right: parseFloat(style.borderRightWidth), top: parseFloat(style.borderTopWidth), bottom: parseFloat(style.borderBottomWidth) }
        const gutter = { x: Math.max(0, parent.offsetHeight - parent.clientHeight - Math.round(border.top + border.bottom)), y: Math.max(0, parent.offsetWidth - parent.clientWidth - Math.round(border.left + border.right)) }
        const client = { left: area.left + border.left, right: area.right - border.right - gutter.y, top: area.top + border.top, bottom: area.bottom - border.bottom - gutter.x }
        ancestors.push({ className: parent.className, client, scrollTop: parent.scrollTop, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight, overflowX: style.overflowX, overflowY: style.overflowY })
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { clip.left = Math.max(clip.left, client.left); clip.right = Math.min(clip.right, client.right) }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { clip.top = Math.max(clip.top, client.top); clip.bottom = Math.min(clip.bottom, client.bottom) }
      }
      const focused = button === document.activeElement, focusVisible = button.matches(':focus-visible'), extent = focused && focusVisible && css.outlineStyle !== 'none' ? Math.max(0, parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset)) : 0
      const glyphs = [], walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.trim()) { const range = document.createRange(); range.selectNodeContents(node)
        for (const glyph of range.getClientRects()) if (glyph.width > 0 && glyph.height > 0) glyphs.push({ text: node.textContent, bounds: glyph.toJSON(), own: glyph.left >= bounds.left - .5 && glyph.right <= bounds.right + .5 && glyph.top >= bounds.top - .5 && glyph.bottom <= bounds.bottom + .5,
          visible: glyph.left >= clip.left - .5 && glyph.right <= clip.right + .5 && glyph.top >= clip.top - .5 && glyph.bottom <= clip.bottom + .5 }) }
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return { id: button.dataset.testid, text: button.textContent, title: button.querySelector('.theme-switcher-option-title')?.childNodes[0]?.textContent,
        description: button.querySelector('.theme-switcher-description')?.textContent, pressed: button.getAttribute('aria-pressed'), label: button.getAttribute('aria-label'), bounds: bounds.toJSON(), focused, focusVisible,
        outline: { style: css.outlineStyle, width: css.outlineWidth, offset: css.outlineOffset, color: css.outlineColor, extent }, glyphs, clip, ancestors, hit: Boolean(hit && button.contains(hit)),
        contained: bounds.left - extent >= clip.left - .5 && bounds.right + extent <= clip.right + .5 && bounds.top - extent >= clip.top - .5 && bounds.bottom + extent <= clip.bottom + .5 }
    })
    return { inner: [innerWidth, innerHeight], dpr: devicePixelRatio, hostTheme: document.documentElement.dataset.theme, palette: document.documentElement.getAttribute('data-knowbook-theme-switcher'),
      revision: wrapper.dataset.fullTrustPluginRevision, outer: measure(panel), wrapper: measure(wrapper), panel: measure(inner), options,
      grids: [...inner.querySelectorAll<HTMLElement>('.theme-switcher-grid')].map(grid => ({ ...measure(grid), columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length })),
      styles: [...document.querySelectorAll<HTMLStyleElement>('style[data-full-trust-plugin="theme-switcher"]')].map(style => ({ id: style.dataset.fullTrustStyle, revision: style.dataset.fullTrustRevision, marker: style.textContent?.includes('Appearance theme picker integration.') })),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  writeFileSync(info.outputPath(`${phase}.json`), JSON.stringify({ phase, plugin, tempRoot, native, metrics }, null, 2)); await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(plugin.source).toBe('builtin'); expect(plugin.status).toBe('active'); expect(plugin.runtimeStatus).toBe('active')
  expect(metrics.revision).toBe(`sha256:${plugin.currentArtifactSha256}`); expect(metrics.styles).toHaveLength(2)
  expect(metrics.styles.every(style => style.revision === metrics.revision && style.marker)).toBe(true); expect(catalog.css).toContain(marker)
  expect(native.userData.toLowerCase()).toBe(tempRoot.toLowerCase()); expect(native.windows).toHaveLength(1); expect(native.windows[0].minimum).toEqual([760, 760]); expect(native.windows[0].content).toEqual(metrics.inner)
  expect(native.windows[0].size).toEqual([native.windows[0].bounds.width, native.windows[0].bounds.height]); expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  for (const box of [metrics.wrapper, metrics.panel]) { expect(box.padding).toEqual(['0px', '0px', '0px', '0px']); expect(box.border).toEqual(['0px', '0px', '0px', '0px']); expect(box.radius).toBe('0px'); expect(box.background).toBe('rgba(0, 0, 0, 0)'); expect(box.shadow).toBe('none') }
  expect(metrics.options.map(option => option.id)).toEqual(ids.map(id => `theme-option-${id}`)); expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1)
  for (const [index, option] of metrics.options.entries()) {
    expect(option.bounds.width).toBeGreaterThan(0); expect(option.bounds.height).toBeGreaterThanOrEqual(32); expect(option.glyphs.length).toBeGreaterThan(0); expect(option.glyphs.every(glyph => glyph.own), `${option.id} complete title and description`).toBe(true)
    if (index < 6) { expect(option.title).toBe(catalog.themes[index].name); expect(option.description).toBe(catalog.themes[index].description) } else expect(option.text).toBe('跟随 KnowBook')
  }
  if (requireFocus) { const focused = metrics.options.filter(option => option.focused); expect(focused).toHaveLength(1); expect(focused[0].focusVisible).toBe(true); expect(focused[0].contained && focused[0].hit).toBe(true)
    expect(focused[0].glyphs.every(glyph => glyph.visible)).toBe(true); expect(focused[0].outline.style).toBe('solid'); expect(parseFloat(focused[0].outline.width)).toBeGreaterThan(0) }
  return metrics
}

for (const { language, theme } of [{ language: 'en-US', theme: 'light' }, { language: 'zh-CN', theme: 'dark' }] as const) {
  test(`theme settings uses one container and reachable native options in ${language} ${theme} @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.'); test.setTimeout(180_000)
    await withElectronApp(async ({ page, app, tempRoot }) => {
      await page.evaluate(async ({ language, theme }) => { await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme) }, { language, theme })
      await page.reload(); await page.locator('[data-page-id="settings"]').click(); await page.getByRole('tab', { name: language === 'en-US' ? 'Appearance' : '外观', exact: true }).click()
      await expect(page.getByTestId('theme-switcher-settings')).toBeVisible(); await expect(page.getByTestId('theme-option-default')).toHaveAttribute('aria-pressed', 'true')
      const catalog = await invoke(page, 'get-catalog') as unknown as Catalog; expect(catalog.themes.map(theme => theme.id)).toEqual(ids.slice(0, 6))
      const before = await stored(page, app)
      await app.evaluate(({ ipcMain }) => {
        const requests: Request[] = []; (globalThis as Probe).__themeLayoutRequests = requests
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...input: unknown[]) => unknown> })._invokeHandlers
        for (const [channel, original] of [...handlers]) if (/^knowbook:(create|update|delete|rename|move|save)-/.test(channel) || channel === 'knowbook:invoke-system-plugin-main') {
          ipcMain.removeHandler(channel); ipcMain.handle(channel, async (event, ...input) => { requests.push({ channel, input: structuredClone(input) }); return original(event, ...input) })
        }
      })
      await nativeSize(page, app, 760, false)
      for (const id of ids) { await tabTo(page, page.getByTestId(`theme-option-${id}`)); const layout = await capture(page, app, tempRoot, info, `760-expanded-keyboard-${id}`, catalog, true); expect(layout.grids.every(grid => grid.columns === 2)).toBe(true) }
      for (const [width, collapsed] of [[760, true], [1280, false]] as const) {
        await nativeSize(page, app, width, collapsed); await tabTo(page, page.getByTestId('theme-option-cloud'))
        const layout = await capture(page, app, tempRoot, info, `${width}-${collapsed ? 'collapsed' : 'expanded'}-keyboard`, catalog, true); expect(layout.grids.every(grid => grid.columns === 3)).toBe(true)
      }
      await nativeSize(page, app, 760, false)
      for (const [index, id] of ids.entries()) {
        const button = page.getByTestId(`theme-option-${id}`); await tabTo(page, button); await page.keyboard.press(index % 2 ? 'Enter' : 'Space')
        await expect(button).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByTestId('theme-switcher-settings')).toHaveAttribute('aria-busy', 'false')
        await expect.poll(() => invoke(page, 'get-state')).toMatchObject({ selectedThemeId: id })
        if (id === 'default') await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher'); else await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', id)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(id === 'default' ? theme : catalog.themes.find(candidate => candidate.id === id)!.mode)
        await capture(page, app, tempRoot, info, `selected-${id}`, catalog)
      }
      const after = await stored(page, app), requests = await app.evaluate(() => (globalThis as Probe).__themeLayoutRequests!)
      const sets = requests.filter(request => request.channel === 'knowbook:invoke-system-plugin-main' && (request.input[0] as { method: string }).method === 'set-theme')
      writeFileSync(info.outputPath('persistence.json'), JSON.stringify({ before, after, requests, sets }, null, 2)); expect(after).toEqual(before)
      expect(requests.filter(request => request.channel !== 'knowbook:invoke-system-plugin-main')).toEqual([])
      expect(sets.map(request => (request.input[0] as { input: { themeId: string } }).input.themeId)).toEqual(ids)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
