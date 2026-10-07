import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type Probe = typeof globalThis & { __searchFocusWrites?: WriteRequest[] }
type FocusKind = 'main' | 'source' | 'clear'
const mainName = 'Search focus records', referenceName = 'Search focus reference'
const mainInput = '.dbw-main-search > input', sourceInput = '.dbw-source-search > input'

async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function resize(page: Page, app: ElectronApplication, collapsed: boolean): Promise<void> {
  if (await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed')) !== collapsed) {
    await page.locator('.rail-toggle-btn').click()
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 760))
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([760, 760])
  await settle(page)
}

async function prepare(page: Page, language: Language, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate(async ({ language, theme, mainName, referenceName }) => {
    const sources = []
    for (const name of [mainName, referenceName]) {
      const database = await window.knowbook.createDocumentDatabase({ name, description: 'Keyboard search and local view drafts.' })
      const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
      for (let index = 0; index < (name === mainName ? 7 : 1); index++) {
        await window.knowbook.createDatabaseEntity({ databaseId: database.id,
          title: name === referenceName ? 'Reference entry' : `${index < 5 ? 'Match entry' : 'Other entry'} ${index}`,
          fieldValues: { [notes.id]: 'Original notes' } })
      }
      const fields = ['__title__', notes.id]
      const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Search table', viewMode: 'table',
        config: { version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] }, sorts: [{ fieldId: '__title__', direction: 'asc' }],
          groupBy: { fieldId: null }, visibleFieldIds: fields, fieldOrder: fields, columnWidths: {}, cardFieldIds: [notes.id] } })
      sources.push(database)
      localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    }
    localStorage.setItem('knowbook.database.last-source', sources[0].id)
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', theme)
  }, { language, theme, mainName, referenceName })
  await page.reload(); await page.locator('[data-page-id="database"]').click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(mainName)
  await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(7)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
  await settle(page)
}

async function stored(page: Page, app: ElectronApplication) {
  const api = await page.evaluate(async () => {
    const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)
    const databases = (await window.knowbook.getDatabases()).sort(byId), catalog = (await window.knowbook.getDocumentCatalog()).sort(byId)
    return { databases, catalog, sources: await Promise.all(databases.map(async database => ({ id: database.id,
      entities: (await window.knowbook.getDatabaseEntities(database.id)).sort(byId), fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort(byId),
      views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort(byId) }))) }
  })
  const sql = await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try { return { schema: database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      tables: Object.fromEntries(['documents', 'blocks', 'links', 'databases', 'document_database_columns', 'database_entities', 'database_entity_values',
        'document_database_values', 'database_saved_views'].map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1,2`).all()])) }
    } finally { database.close() }
  })
  return { api, sql }
}

async function installProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const writes: WriteRequest[] = []; (globalThis as Probe).__searchFocusWrites = writes
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    for (const [channel, original] of Array.from(handlers.entries())) if (/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => { writes.push({ channel, input: structuredClone(input) }); return original(event, ...input) })
    }
  })
}

async function zeroWrites(page: Page, app: ElectronApplication, before: Awaited<ReturnType<typeof stored>>, info: TestInfo): Promise<void> {
  const after = await stored(page, app), writes = await app.evaluate(() => (globalThis as Probe).__searchFocusWrites!)
  writeFileSync(info.outputPath('persistence.json'), JSON.stringify({ scope: 'Business API, schema and nine tables; explicit palette calls may update plugin KV.', before, after, writes }, null, 2))
  expect(writes).toEqual([]); expect(after).toEqual(before)
}

async function sourceTrigger(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+L')
  await expect(page.locator('.dbw-source-trigger')).toBeFocused()
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let count = 0; count < 32; count++) {
    if (await target.evaluate(element => document.activeElement === element)) break
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

async function focusMain(page: Page): Promise<void> {
  await sourceTrigger(page); await tabTo(page, page.locator(mainInput))
  await expect(page.locator(mainInput)).toBeFocused()
}

function recorder(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo) {
  const evidence: unknown[] = []
  return async (phase: string, kind: FocusKind) => {
    await settle(page)
    const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({
      content: window.getContentSize(), bounds: window.getBounds(), size: window.getSize(), minimum: window.getMinimumSize(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
    const metrics = await page.evaluate(({ kind, mainInput, sourceInput }) => {
      type RGBA = [number, number, number, number]
      const parse = (raw: string): RGBA | null => {
        if (raw === 'transparent') return [0, 0, 0, 0]
        const match = raw.match(/^rgba?\((.+)\)$/)
        if (!match) return null
        const parts = match[1].trim().split(/[\s,/]+/), rgb = parts.slice(0, 3).map(value => value.endsWith('%') ? parseFloat(value) * 2.55 : Number(value))
        const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3])
        return parts.length >= 3 && parts.length <= 4 && [...rgb, alpha].every(Number.isFinite) ? [rgb[0], rgb[1], rgb[2], alpha] : null
      }
      const over = (front: RGBA, back: RGBA): RGBA => {
        const alpha = front[3] + back[3] * (1 - front[3])
        return [0, 1, 2].map(index => alpha ? (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha : 0).concat(alpha) as RGBA
      }
      const luminance = (rgba: RGBA) => rgba.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
      const contrast = (first: RGBA, second: RGBA) => (Math.max(luminance(first), luminance(second)) + .05) / (Math.min(luminance(first), luminance(second)) + .05)
      const surface = (start: HTMLElement | null) => {
        const layers = []
        for (let element = start; element; element = element.parentElement) {
          const css = getComputedStyle(element)
          layers.unshift({ tag: element.tagName, className: element.className, raw: css.backgroundColor, rgba: parse(css.backgroundColor), image: css.backgroundImage, opacity: css.opacity })
        }
        // An opaque descendant covers earlier backgrounds; ancestor opacity still applies to its whole subtree.
        let startIndex = -1
        layers.forEach((layer, index) => { if (layer.rgba?.[3] === 1) startIndex = index })
        const unsupported = layers.filter(layer => Number(layer.opacity) !== 1).map(layer => `opacity:${layer.opacity}:${layer.className}`)
        if (startIndex < 0) unsupported.push('No opaque background establishes the painted surface')
        let rgba: RGBA = [0, 0, 0, 0]
        for (const layer of layers.slice(Math.max(0, startIndex))) {
          if (!layer.rgba || layer.image !== 'none') unsupported.push(`background:${layer.raw}:${layer.image}:${layer.className}`)
          if (layer.rgba) rgba = over(layer.rgba, rgba)
        }
        return { layers, rgba, unsupported }
      }
      const target = document.querySelector<HTMLElement>(kind === 'clear' ? '.dbw-main-search > button' : kind === 'main' ? mainInput : sourceInput)!
      const label = target.closest<HTMLElement>('.dbw-search-field')!, input = label.querySelector<HTMLInputElement>('input')!
      const owner = kind === 'clear' ? target : label, css = getComputedStyle(owner), labelCss = getComputedStyle(label), inputCss = getComputedStyle(input)
      const bounds = owner.getBoundingClientRect(), targetBounds = target.getBoundingClientRect(), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      const ancestors = []
      for (let parent = owner.parentElement; parent; parent = parent.parentElement) {
        const box = parent.getBoundingClientRect(), style = getComputedStyle(parent)
        const border = { left: parseFloat(style.borderLeftWidth), right: parseFloat(style.borderRightWidth), top: parseFloat(style.borderTopWidth), bottom: parseFloat(style.borderBottomWidth) }
        const gutter = { x: Math.max(0, parent.offsetHeight - parent.clientHeight - Math.round(border.top + border.bottom)),
          y: Math.max(0, parent.offsetWidth - parent.clientWidth - Math.round(border.left + border.right)) }
        const client = { left: box.left + border.left, right: box.right - border.right - gutter.y, top: box.top + border.top, bottom: box.bottom - border.bottom - gutter.x }
        ancestors.push({ tag: parent.tagName, className: parent.className, bounds: box.toJSON(), clientLeft: parent.clientLeft, clientTop: parent.clientTop,
          clientWidth: parent.clientWidth, clientHeight: parent.clientHeight, border, gutter, client, overflowX: style.overflowX, overflowY: style.overflowY })
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { clip.left = Math.max(clip.left, client.left); clip.right = Math.min(clip.right, client.right) }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { clip.top = Math.max(clip.top, client.top); clip.bottom = Math.min(clip.bottom, client.bottom) }
      }
      const width = parseFloat(css.outlineWidth), offset = parseFloat(css.outlineOffset), extent = css.outlineStyle !== 'none' ? Math.max(0, width + offset) : 0
      const outside = surface(owner.parentElement), inside = surface(owner), ring = parse(css.outlineColor)
      const ratios = ring ? [outside, inside].map(paint => contrast(over(ring, paint.rgba), paint.rgba)) : []
      const probe = document.createElement('span'); probe.style.color = 'var(--dbw-accent)'; probe.style.visibility = 'hidden'; probe.style.position = 'fixed'
      label.append(probe)
      let accent: RGBA | null, line: RGBA | null
      try { accent = parse(getComputedStyle(probe).color); probe.style.color = 'var(--dbw-line)'; line = parse(getComputedStyle(probe).color) } finally { probe.remove() }
      const hit = document.elementFromPoint(targetBounds.left + targetBounds.width / 2, targetBounds.top + targetBounds.height / 2)
      return { inner: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme, palette: document.documentElement.getAttribute('data-knowbook-theme-switcher'),
        sidebarCollapsed: document.querySelector('.sidebar-workspace-navigation')!.classList.contains('collapsed'),
        source: document.querySelector('.dbw-source-trigger > span')!.textContent, query: document.querySelector<HTMLInputElement>(mainInput)!.value,
        titles: Array.from(document.querySelectorAll('.dbw-record-title strong')).map(element => element.textContent),
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        focus: { kind, active: document.activeElement === target, focusVisible: target.matches(':focus-visible'), inputIndicator: label.matches(':has(> input:focus-visible)'),
          targetBounds: targetBounds.toJSON(), bounds: bounds.toJSON(), ringBounds: { left: bounds.left - extent, right: bounds.right + extent, top: bounds.top - extent, bottom: bounds.bottom + extent }, clip, ancestors, extent,
          contained: bounds.width > 0 && bounds.height > 0 && bounds.left - extent >= clip.left - .5 && bounds.right + extent <= clip.right + .5
            && bounds.top - extent >= clip.top - .5 && bounds.bottom + extent <= clip.bottom + .5,
          hit: Boolean(hit && target.contains(hit)),
          owner: { outlineStyle: css.outlineStyle, width, offset, outlineColor: css.outlineColor, shadow: css.boxShadow },
          input: { outlineStyle: inputCss.outlineStyle, width: parseFloat(inputCss.outlineWidth), shadow: inputCss.boxShadow, value: input.value, scrollLeft: input.scrollLeft, clientWidth: input.clientWidth },
          label: { outlineStyle: labelCss.outlineStyle, width: parseFloat(labelCss.outlineWidth), shadow: labelCss.boxShadow, border: parse(labelCss.borderTopColor) },
          contrast: { ring, accent, line, outside, inside, ratios, minimum: ratios.length ? Math.min(...ratios) : null } } }
    }, { kind, mainInput, sourceInput })
    evidence.push({ phase, tempRoot, native, metrics }); writeFileSync(info.outputPath('points.json'), JSON.stringify(evidence, null, 2))
    await page.screenshot({ path: info.outputPath(`${phase}.png`) })
    expect(native.userData.toLowerCase()).toBe(tempRoot.toLowerCase()); expect(native.windows).toHaveLength(1)
    const window = native.windows[0]
    expect(window.content).toEqual(metrics.inner); expect(window.minimum).toEqual([760, 760]); expect(metrics.inner).toEqual([760, 760])
    expect(window.bounds.width).toBe(window.size[0]); expect(window.bounds.height).toBe(window.size[1])
    expect(window.visible || window.focused || window.focusable).toBe(false); expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1)
    const focus = metrics.focus
    expect(focus.active && focus.focusVisible, `${phase}: real keyboard focus`).toBe(true)
    expect(focus.contained, `${phase}: four sides of the focused control and ring`).toBe(true); expect(focus.hit).toBe(true)
    expect(focus.owner.outlineStyle).toBe('solid'); expect(focus.owner.width).toBe(2); expect(focus.owner.shadow).toBe('none')
    expect(focus.input.width).toBe(0); expect(focus.input.outlineStyle).toBe('none'); expect(focus.input.shadow).toBe('none')
    expect(focus.label.shadow).toBe('none'); expect(focus.label.border).toEqual(focus.contrast.line)
    expect(focus.contrast.ring).not.toBeNull(); expect(focus.contrast.accent).not.toBeNull(); expect(focus.contrast.ring).toEqual(focus.contrast.accent)
    expect(focus.contrast.outside.unsupported).toEqual([]); expect(focus.contrast.inside.unsupported).toEqual([])
    expect(focus.contrast.minimum).not.toBeNull(); expect(focus.contrast.minimum!).toBeGreaterThanOrEqual(3)
    expect(focus.inputIndicator).toBe(kind !== 'clear')
    if (kind === 'clear') { expect(focus.label.width).toBe(0); expect(focus.label.outlineStyle).toBe('none') }
    return metrics
  }
}

async function results(page: Page, count: number): Promise<void> {
  await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(count)
}

async function picker(page: Page): Promise<void> {
  await sourceTrigger(page); await page.keyboard.press('Enter')
  await expect(page.locator('.dbw-source-picker')).toBeVisible(); await expect(page.locator(sourceInput)).toBeFocused()
}

async function selectSource(page: Page, name: string): Promise<void> {
  await picker(page); await page.locator(sourceInput).fill(name)
  await expect(page.locator('.dbw-source-option')).toHaveCount(1)
  await page.keyboard.press('Tab'); await expect(page.locator('.dbw-source-option')).toBeFocused(); await page.keyboard.press('Enter')
  await expect(page.locator('.dbw-source-picker')).toHaveCount(0); await expect(page.locator('.dbw-source-trigger')).toContainText(name)
}

test.describe('database search focus', () => {
  test.skip(!hasBuiltElectronApp(), 'Build the app before running Electron search focus tests.')
  for (const { language, theme } of [{ language: 'en-US', theme: 'light' }, { language: 'zh-CN', theme: 'dark' }] as const) {
    test(`${language} uses one complete keyboard search ring and preserves local query, clear and source behavior @electron`, async ({}, info) => {
      await withElectronApp(async ({ page, app, tempRoot }) => {
        await prepare(page, language, theme); await resize(page, app, false)
        const before = await stored(page, app); await installProbe(app)
        writeFileSync(info.outputPath('before.json'), JSON.stringify(before, null, 2))
        const record = recorder(page, app, tempRoot, info), text = getDatabaseWorkspaceText(language)
        for (const collapsed of [false, true]) {
          const phase = collapsed ? 'collapsed' : 'expanded'
          await resize(page, app, collapsed); await focusMain(page)
          await expect(page.locator(mainInput)).toHaveValue(''); await results(page, 7); await record(`${phase}-empty`, 'main')
          await page.locator(mainInput).fill('Match entry'); await results(page, 5)
          await expect(page.locator('.dbw-record-title strong')).toHaveText(['Match entry 0', 'Match entry 1', 'Match entry 2', 'Match entry 3', 'Match entry 4'])
          await record(`${phase}-five`, 'main')
          await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: text.clearSearch, exact: true })).toBeFocused()
          await record(`${phase}-clear-tab`, 'clear')
          await page.keyboard.press('Shift+Tab'); await expect(page.locator(mainInput)).toBeFocused(); await record(`${phase}-input-shift-tab`, 'main')
          await page.keyboard.press('Tab'); await page.keyboard.press('Enter')
          await expect(page.locator(mainInput)).toBeFocused(); await expect(page.locator(mainInput)).toHaveValue(''); await results(page, 7)
          await expect(page.locator('.dbw-main-search > button')).toHaveCount(0); await record(`${phase}-enter-clear`, 'main')
          await page.locator(mainInput).fill('No hits 842'); await expect(page.locator('.dbw-empty-state')).toContainText(text.noMatchingRecords)
          await expect(page.locator('.dbw-record-title strong')).toHaveCount(0); await record(`${phase}-no-results`, 'main')
          const reset = page.getByRole('button', { name: text.resetView, exact: true }); await tabTo(page, reset); await page.keyboard.press('Enter')
          await expect(page.locator(mainInput)).toHaveValue(''); await results(page, 7); await expect(reset).toHaveCount(0)
          await focusMain(page); await record(`${phase}-reset`, 'main')
          await picker(page); await record(`${phase}-picker-empty`, 'source')
          await page.locator(sourceInput).fill(referenceName); await expect(page.locator('.dbw-source-option')).toHaveCount(1); await record(`${phase}-picker-filter`, 'source')
          await page.keyboard.press('Tab'); await expect(page.locator('.dbw-source-option')).toBeFocused(); await page.keyboard.press('Enter')
          await expect(page.locator('.dbw-source-picker')).toHaveCount(0); await expect(page.locator('.dbw-source-trigger')).toContainText(referenceName)
          await results(page, 1); await expect(page.locator('.dbw-record-title strong')).toHaveText('Reference entry')
          await focusMain(page); await record(`${phase}-reference-input`, 'main')
          await picker(page); await record(`${phase}-picker-reopen`, 'source'); await page.keyboard.press('Escape')
          await expect(page.locator('.dbw-source-picker')).toHaveCount(0); await expect(page.locator('.dbw-source-trigger')).toBeFocused()
          await selectSource(page, mainName); await results(page, 7)
        }
        await zeroWrites(page, app, before, info)
      }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
    })
  }

  test('six real palettes keep input and clear rings distinct, visible and above 3:1 contrast @electron', async ({}, info) => {
    await withElectronApp(async ({ page, app, tempRoot }) => {
      await prepare(page, 'en-US', 'light'); await resize(page, app, false)
      await expect.poll(() => page.evaluate(async () => (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')?.runtimeStatus)).toBe('active')
      const before = await stored(page, app); await installProbe(app)
      writeFileSync(info.outputPath('before.json'), JSON.stringify(before, null, 2))
      const record = recorder(page, app, tempRoot, info), calls = []
      for (const themeId of ['cloud', 'paper', 'moss', 'bay', 'midnight', 'violet']) {
        const call = await page.evaluate(async themeId => {
          const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')!
          const request = { pluginId: plugin.pluginId, revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'set-theme', input: { themeId } }
          return { request, response: await window.knowbook.invokeSystemPluginMain(request) }
        }, themeId)
        calls.push(call); writeFileSync(info.outputPath('palette-calls.json'), JSON.stringify(calls, null, 2))
        await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', themeId)
        await focusMain(page); await page.locator(mainInput).fill('Match entry'); await results(page, 5); await record(`${themeId}-input`, 'main')
        await page.keyboard.press('Tab'); await expect(page.locator('.dbw-main-search > button')).toBeFocused(); await record(`${themeId}-clear`, 'clear')
        await page.keyboard.press('Enter'); await expect(page.locator(mainInput)).toHaveValue(''); await results(page, 7)
        await picker(page); await record(`${themeId}-source`, 'source'); await page.keyboard.press('Escape')
        await expect(page.locator('.dbw-source-picker')).toHaveCount(0); await expect(page.locator('.dbw-source-trigger')).toBeFocused()
      }
      await zeroWrites(page, app, before, info)
    })
  })
})
