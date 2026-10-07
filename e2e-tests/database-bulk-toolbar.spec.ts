import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

export type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type WriteRequest = { channel: string; input: unknown[] }
type Probe = typeof globalThis & { __bulkToolbarWrites?: WriteRequest[] }
const sourceName = 'Bulk toolbar records'

export async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

export async function resize(page: Page, app: ElectronApplication, width = 760, collapsed = false): Promise<void> {
  if (await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed')) !== collapsed) await page.locator('.rail-toggle-btn').click()
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 760]); await settle(page)
}

export async function prepare(page: Page, language: Language, theme: 'light' | 'dark') {
  const fixture = await page.evaluate(async ({ language, theme, sourceName }) => {
    const catalog = (await window.knowbook.getDatabases()).find(database => database.kind === 'document-catalog')!
    const documents = await window.knowbook.getDocumentCatalog()
    if (documents.length < 2) throw new Error('The isolated workspace requires two actual catalog documents.')
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName, description: 'Selected records and local bulk drafts.' })
    const fields = []
    for (const [name, type] of [['Notes', 'text'], ['Stage', 'select'], ['Tags', 'multi-select'], ['Due', 'date'], ['Done', 'checkbox'], ['跨团队项目资料整理与研究进度备注', 'text']] as const) {
      fields.push(await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name, type, options: type === 'select' || type === 'multi-select' ? ['Plan', 'Done'] : [] }))
    }
    const records = []
    for (let index = 0; index < 3; index++) records.push(await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: `Bulk record ${index}`,
      documentId: index === 0 ? documents[0].id : undefined,
      fieldValues: { [fields[0].id]: `Original ${index}`, [fields[1].id]: 'Plan', [fields[2].id]: ['Plan'], [fields[3].id]: '2026-10-08', [fields[4].id]: false, [fields[5].id]: 'Original long note' } }))
    const order = ['__title__', ...fields.map(field => field.id)]
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: 'Bulk table', viewMode: 'table', config: { version: 1, layout: 'table', query: '',
      filters: { operator: 'and', rules: [] }, sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: ['__title__', fields[0].id], fieldOrder: order, columnWidths: {}, cardFieldIds: [fields[0].id] } })
    localStorage.setItem('knowbook.database.last-source', database.id); localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme)
    return { catalogId: catalog.id, customId: database.id, fields, records, view }
  }, { language, theme, sourceName })
  await page.reload(); await page.locator('[data-page-id="database"]').click()
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', sourceName)
  await expect(page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer)')).toHaveCount(3)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme); await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
  await settle(page); return fixture
}

export async function stored(page: Page, app: ElectronApplication) {
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

export async function installProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const requests: WriteRequest[] = []; (globalThis as Probe).__bulkToolbarWrites = requests
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    for (const [channel, original] of Array.from(handlers.entries())) if (/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) {
      ipcMain.removeHandler(channel); ipcMain.handle(channel, async (event, ...input: unknown[]) => { requests.push({ channel, input: structuredClone(input) }); return original(event, ...input) })
    }
  })
}

export async function writes(app: ElectronApplication): Promise<WriteRequest[]> {
  return app.evaluate(() => (globalThis as Probe).__bulkToolbarWrites!)
}

export async function zeroWrites(page: Page, app: ElectronApplication, before: Awaited<ReturnType<typeof stored>>, info: TestInfo, phase: string): Promise<void> {
  const after = await stored(page, app), requests = await writes(app)
  writeFileSync(info.outputPath(`${phase}-persistence.json`), JSON.stringify({ before, after, requests }, null, 2))
  expect(after).toEqual(before); expect(requests).toEqual([])
}

export async function tabTo(page: Page, target: Locator, reverse = false): Promise<void> {
  const path = [], destination = await target.evaluate(element => ({ tag: element.tagName, className: element.className, label: element.getAttribute('aria-label'), text: element.textContent }))
  for (let step = 0; step <= 128; step++) {
    const state = await target.evaluate(element => {
      const active = document.activeElement as HTMLElement | null
      return { focused: active === element, active: active ? { tag: active.tagName, type: (active as HTMLInputElement).type, className: active.className,
        label: active.getAttribute('aria-label'), value: (active as HTMLInputElement).value } : null }
    })
    path.push({ step, ...state }); if (state.focused || step === 128) break
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab')
  }
  const paths = await page.evaluate(entry => {
    const runtime = globalThis as typeof globalThis & { __bulkKeyboardPaths?: unknown[] }
    runtime.__bulkKeyboardPaths ??= []; runtime.__bulkKeyboardPaths.push(entry); return runtime.__bulkKeyboardPaths
  }, { key: reverse ? 'Shift+Tab' : 'Tab', destination, path })
  writeFileSync(test.info().outputPath('tab-navigation.json'), JSON.stringify(paths, null, 2))
  await expect(target).toBeFocused()
}

export async function chooseField(page: Page, id: string): Promise<void> {
  const select = page.locator('.dbw-bulk-field-editor > select')
  await tabTo(page, select); await page.keyboard.press('Home')
  const index = await select.evaluate((element, id) => Array.from((element as HTMLSelectElement).options).findIndex(option => option.value === id), id)
  expect(index).toBeGreaterThanOrEqual(0)
  for (let step = 0; step < index; step++) await page.keyboard.press('ArrowDown')
  await expect(select).toHaveValue(id)
}

export async function selectSource(page: Page, language: Language, custom: boolean): Promise<void> {
  const name = custom ? sourceName : getDatabaseWorkspaceText(language).allDocuments
  if (await page.locator('.dbw-source-trigger').getAttribute('title') !== name) {
    await page.locator('.dbw-source-trigger').click(); await page.locator('.dbw-source-search input').fill(custom ? sourceName : '')
    const option = custom ? page.locator('.dbw-source-option').filter({ hasText: sourceName }) : page.locator('.dbw-source-option').filter({ has: page.locator('.dbw-system-badge') })
    await expect(option).toHaveCount(1); await option.click()
  }
  await expect(page.locator('.dbw-source-trigger')).toHaveAttribute('title', name); await settle(page)
}

export async function selectRows(page: Page, titles: string[]): Promise<void> {
  for (const title of titles) await page.locator('.dbw-table tbody tr').filter({ has: page.locator('.dbw-record-title strong', { hasText: new RegExp(`^${title}$`) }) }).locator('.dbw-select-column input').check()
  await expect(page.locator('.dbw-selection-toolbar strong')).toHaveText(new RegExp(String(titles.length)))
}

export async function record(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, phase: string) {
  await settle(page)
  const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({ content: window.getContentSize(),
    size: window.getSize(), bounds: window.getBounds(), minimum: window.getMinimumSize(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
  const metrics = await page.locator('.dbw-selection-toolbar').evaluate(toolbar => {
    const css = getComputedStyle(toolbar), bounds = toolbar.getBoundingClientRect(), active = document.activeElement as HTMLElement
    const metric = (element: HTMLElement) => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, ancestors = []
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const area = parent.getBoundingClientRect(), parentCss = getComputedStyle(parent)
        const border = { left: parseFloat(parentCss.borderLeftWidth), right: parseFloat(parentCss.borderRightWidth), top: parseFloat(parentCss.borderTopWidth), bottom: parseFloat(parentCss.borderBottomWidth) }
        const gutter = { x: Math.max(0, parent.offsetHeight - parent.clientHeight - Math.round(border.top + border.bottom)), y: Math.max(0, parent.offsetWidth - parent.clientWidth - Math.round(border.left + border.right)) }
        const client = { left: area.left + border.left, right: area.right - border.right - gutter.y, top: area.top + border.top, bottom: area.bottom - border.bottom - gutter.x }
        ancestors.push({ className: parent.className, bounds: area.toJSON(), border, gutter, client, overflowX: parentCss.overflowX, overflowY: parentCss.overflowY })
        if (/^(auto|scroll|hidden|clip)$/.test(parentCss.overflowX)) { clip.left = Math.max(clip.left, client.left); clip.right = Math.min(clip.right, client.right) }
        if (/^(auto|scroll|hidden|clip)$/.test(parentCss.overflowY)) { clip.top = Math.max(clip.top, client.top); clip.bottom = Math.min(clip.bottom, client.bottom) }
      }
      const focused = element === active, focusVisible = element.matches(':focus-visible'), extent = focused && focusVisible && style.outlineStyle !== 'none' ? Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) : 0
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      const glyphs = []
      if (element.matches('button,strong,summary,label')) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.trim()) {
          const range = document.createRange(); range.selectNodeContents(node)
          for (const glyph of range.getClientRects()) if (glyph.width > 0 && glyph.height > 0) glyphs.push({ text: node.textContent, bounds: glyph.toJSON(),
            contained: glyph.left >= Math.max(box.left, clip.left) - .5 && glyph.right <= Math.min(box.right, clip.right) + .5 && glyph.top >= Math.max(box.top, clip.top) - .5 && glyph.bottom <= Math.min(box.bottom, clip.bottom) + .5 })
        }
      }
      let preferredNativeWidth: number | null = null
      if (element instanceof HTMLSelectElement) {
        const clone = element.cloneNode(true) as HTMLSelectElement; clone.removeAttribute('id'); clone.tabIndex = -1; clone.setAttribute('aria-hidden', 'true')
        for (const option of Array.from(clone.options)) if (option.value !== element.value) option.remove()
        Object.assign(clone.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', width: 'auto', minWidth: '0', maxWidth: 'none' })
        element.parentElement!.append(clone); try { preferredNativeWidth = clone.getBoundingClientRect().width } finally { clone.remove() }
      }
      return { tag: element.tagName, type: (element as HTMLInputElement).type, className: element.className, text: element.textContent, label: element.getAttribute('aria-label'), title: element.getAttribute('title'),
        value: (element as HTMLInputElement).value, selectedText: element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent : null,
        popup: Boolean(element.closest('.dbw-multi-editor-menu')), hitTarget: element instanceof HTMLInputElement && element.type === 'checkbox' ? element.closest('label')?.getBoundingClientRect().toJSON() : null,
        preferredNativeWidth, bounds: box.toJSON(), clip, ancestors, focused, focusVisible, outline: { width: style.outlineWidth, offset: style.outlineOffset, style: style.outlineStyle, color: style.outlineColor, extent },
        hit: Boolean(hit && element.contains(hit)), glyphs, fontSize: style.fontSize, lineHeight: style.lineHeight,
        contained: box.width > 0 && box.height > 0 && box.left - extent >= clip.left - .5 && box.right + extent <= clip.right + .5 && box.top - extent >= clip.top - .5 && box.bottom + extent <= clip.bottom + .5 }
    }
    const controls = Array.from(toolbar.querySelectorAll<HTMLElement>('button,input,select,summary')).filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 }).map(metric)
    const groups = Array.from(toolbar.children).map(element => ({ tag: element.tagName, className: element.className, bounds: element.getBoundingClientRect().toJSON() }))
    const count = metric(toolbar.querySelector<HTMLElement>('strong')!), rows: number[] = []
    for (const control of [count, ...controls.filter(control => !control.popup)]) { const middle = control.bounds.top + control.bounds.height / 2; if (!rows.some(row => Math.abs(row - middle) < 6)) rows.push(middle) }
    return { inner: [innerWidth, innerHeight], dpr: devicePixelRatio, theme: document.documentElement.dataset.theme, toolbar: bounds.toJSON(), padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft], gap: css.gap,
      groups, rows: rows.length, selected: document.querySelectorAll('tbody tr.is-selected').length, count, controls,
      labels: Array.from(toolbar.querySelectorAll<HTMLElement>('label')).filter(element => element.getBoundingClientRect().width > 0).map(metric),
      bulk: toolbar.querySelector('.dbw-bulk-field-editor')?.getBoundingClientRect().toJSON(), horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  const focused = metrics.controls.find(control => control.focused), margin = focused ? focused.outline.extent + 2 : 0
  const focusCrop = focused ? { x: Math.max(0, focused.bounds.left - margin), y: Math.max(0, focused.bounds.top - margin),
    width: Math.min(metrics.inner[0], focused.bounds.right + margin) - Math.max(0, focused.bounds.left - margin),
    height: Math.min(metrics.inner[1], focused.bounds.bottom + margin) - Math.max(0, focused.bounds.top - margin) } : null
  writeFileSync(info.outputPath(`${phase}.json`), JSON.stringify({ phase, tempRoot, native, metrics, focusCrop }, null, 2)); await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  if (focusCrop) await page.screenshot({ path: info.outputPath(`${phase}-native-focus.png`), clip: focusCrop })
  expect(native.userData.toLowerCase()).toBe(tempRoot.toLowerCase()); expect(native.windows).toHaveLength(1); expect(native.windows[0].content).toEqual(metrics.inner)
  expect(native.windows[0].minimum).toEqual([760, 760]); expect(native.windows[0].bounds.width).toBe(native.windows[0].size[0]); expect(native.windows[0].bounds.height).toBe(native.windows[0].size[1])
  expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return metrics
}

function verify(layout: Awaited<ReturnType<typeof record>>, language: Language, state: { custom: boolean; selected: number; maxRows: number; linked?: boolean; popup?: boolean; long?: boolean }) {
  const text = getDatabaseWorkspaceText(language), zh = language === 'zh-CN'
  expect(layout.selected).toBe(state.selected); expect(layout.count.text).toBe(text.selected(state.selected))
  expect(layout.count.glyphs.length).toBeGreaterThan(0)
  expect(layout.count.contained && layout.count.glyphs.every(glyph => glyph.contained)).toBe(true)
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1); expect(layout.rows).toBeLessThanOrEqual(state.maxRows)
  const captions = [zh ? '全选当前视图' : 'Select all visible', text.clearSelection,
    ...(state.custom ? [zh ? '应用' : 'Apply', zh ? '清空字段' : 'Clear field', text.deleteRecord] : []),
    ...(state.linked ? [zh ? '解除文档关联' : 'Unlink documents'] : [])]
  expect(layout.controls.filter(control => control.tag === 'BUTTON').map(control => control.text).sort()).toEqual(captions.sort())
  const normal = layout.controls.filter(control => !control.popup)
  expect(normal).toHaveLength(state.custom ? 7 + (state.linked ? 1 : 0) : 2)
  for (const control of state.popup ? layout.controls.filter(control => control.popup) : normal) {
    expect(control.contained, `Complete control and focus ring: ${control.selectedText || control.label || control.text || control.type}`).toBe(true)
    expect(control.hit, `Control receives a hit at its center: ${control.label || control.text || control.type}`).toBe(true)
    if ((control.tag === 'BUTTON' || control.tag === 'SUMMARY') && control.text?.trim()) expect(control.glyphs.length, 'Caption has actual rendered text Ranges').toBeGreaterThan(0)
    expect(control.glyphs.every(glyph => glyph.contained), 'Short captions show every text Range').toBe(true)
    if (control.type === 'checkbox' && !control.popup) { expect(control.hitTarget!.width).toBeGreaterThanOrEqual(32); expect(control.hitTarget!.height).toBeGreaterThanOrEqual(32) }
    else if (control.type !== 'checkbox') expect(control.bounds.height).toBeGreaterThanOrEqual(28)
    if (control.focused) { expect(control.focusVisible).toBe(true); expect(control.outline.style).not.toBe('none'); expect(parseFloat(control.outline.width)).toBeGreaterThan(0) }
  }
  if (state.popup) {
    expect(layout.controls.filter(control => control.popup)).toHaveLength(2)
    const labels = layout.labels.filter(label => label.popup)
    expect(labels).toHaveLength(2); expect(labels.map(label => label.text?.trim())).toEqual(['Plan', 'Done'])
    for (const label of labels) { expect(label.glyphs.length).toBeGreaterThan(0); expect(label.contained && label.hit && label.glyphs.every(glyph => glyph.contained)).toBe(true) }
  }
  const fields = normal.filter(control => control.tag === 'SELECT')
  for (const [index, field] of fields.entries()) {
    if (state.long && index === 0) { expect(field.selectedText).toBe('跨团队项目资料整理与研究进度备注'); expect(field.preferredNativeWidth!).toBeGreaterThan(field.bounds.width) }
    else expect(field.bounds.width, 'Browser native short option and arrow preferred width').toBeGreaterThanOrEqual(field.preferredNativeWidth! - .5)
  }
}

async function explicitWrite(page: Page, app: ElectronApplication, info: TestInfo, language: Language,
  fixture: Awaited<ReturnType<typeof prepare>>, value: 'Done' | null, phase: string) {
  const before = await stored(page, app), previousRequests = await writes(app), ids = fixture.records.slice(1).map(record => record.id), fieldId = fixture.fields[1].id
  const button = page.locator('.dbw-bulk-field-editor').getByRole('button', { name: language === 'zh-CN' ? value === null ? '清空字段' : '应用' : value === null ? 'Clear field' : 'Apply', exact: true })
  await tabTo(page, button); await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(async ({ databaseId, ids, fieldId, value }) => {
    const records = await window.knowbook.getDatabaseEntities(databaseId)
    return ids.every(id => value === null ? !Object.hasOwn(records.find(record => record.id === id)!.fieldValues, fieldId) : records.find(record => record.id === id)!.fieldValues[fieldId] === value)
  }, { databaseId: fixture.customId, ids, fieldId, value })).toBe(true)
  await expect(page.locator('.dbw-selection-toolbar strong')).toHaveText(getDatabaseWorkspaceText(language).selected(2)); await settle(page)
  const after = await stored(page, app), requests = await writes(app)
  writeFileSync(info.outputPath(`${phase}-persistence.json`), JSON.stringify({ phase, language, ids, fieldId, value, before, after, previousRequests, requests }, null, 2))
  expect(requests).toEqual([...previousRequests, { channel: 'knowbook:update-database-entities', input: [{ updates: ids.map(entityId => ({ entityId, fieldValues: { [fieldId]: value } })) }] }])
  expect(after.api).toEqual({ ...before.api, sources: before.api.sources.map(source => ({ ...source, entities: source.entities.map(entity => {
    if (!ids.includes(entity.id)) return entity
    const current = after.api.sources.find(candidate => candidate.id === source.id)!.entities.find(candidate => candidate.id === entity.id)!
    expect(Number.isFinite(Date.parse(current.updatedAt))).toBe(true); expect(current.updatedAt >= entity.updatedAt).toBe(true)
    const fieldValues = { ...entity.fieldValues }; if (value === null) delete fieldValues[fieldId]; else fieldValues[fieldId] = value
    return { ...entity, fieldValues, updatedAt: current.updatedAt }
  }) })) })
  expect(after.sql.schema).toEqual(before.sql.schema)
  const rows = (data: typeof before, table: string) => data.sql.tables[table] as Array<Record<string, unknown>>
  for (const table of Object.keys(before.sql.tables)) {
    if (table === 'database_entities') expect(rows(after, table)).toEqual(rows(before, table).map(row => ids.includes(String(row.id))
      ? { ...row, updated_at: after.api.sources.find(source => source.id === fixture.customId)!.entities.find(entity => entity.id === row.id)!.updatedAt } : row))
    else if (table === 'database_entity_values') expect(rows(after, table)).toEqual(rows(before, table).flatMap(row => {
      if (!ids.includes(String(row.entity_id)) || row.column_id !== fieldId) return [row]
      return value === null ? [] : [{ ...row, value_text: value, updated_at: after.api.sources.find(source => source.id === fixture.customId)!.entities.find(entity => entity.id === row.entity_id)!.updatedAt }]
    }))
    else expect(rows(after, table), `Untouched business table ${table}`).toEqual(rows(before, table))
  }
  return { after, requests }
}

for (const { language, theme } of [{ language: 'en-US', theme: 'light' }, { language: 'zh-CN', theme: 'dark' }] as const) {
  test(`native selected toolbar, bulk drafts and target-only writes in ${language} ${theme} @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.'); test.setTimeout(180_000)
    await withElectronApp(async ({ page, app, tempRoot }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const fixture = await prepare(page, language, theme), text = getDatabaseWorkspaceText(language)
      await resize(page, app); const before = await stored(page, app); await installProbe(app)
      const capture = async (phase: string, state: Parameters<typeof verify>[2]) => { const layout = await record(page, app, tempRoot, info, phase); verify(layout, language, state); return layout }
      const ordinary = { custom: true, selected: 2, maxRows: 2 }
      await selectRows(page, ['Bulk record 1', 'Bulk record 2']); await page.locator('.dbw-main-search input').click()
      await chooseField(page, fixture.fields[0].id); await capture('text-field-focused', ordinary)
      const input = page.locator('.dbw-bulk-field-editor input.catalog-cell-input')
      await tabTo(page, input); await input.fill('Batch'); await capture('text-draft-focused', ordinary)
      await page.keyboard.press('Escape'); await expect(input).toHaveValue('')
      await chooseField(page, fixture.fields[1].id); const choice = page.locator('.dbw-bulk-field-editor select.catalog-cell-input')
      await tabTo(page, choice); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await expect(choice).toHaveValue('Plan'); await capture('select-draft-focused', ordinary)
      await chooseField(page, fixture.fields[2].id); const summary = page.locator('.dbw-bulk-field-editor summary')
      await tabTo(page, summary); await page.keyboard.press('Enter'); await expect(page.locator('.dbw-bulk-field-editor details')).toHaveAttribute('open', '')
      const option = page.locator('.dbw-bulk-field-editor .dbw-multi-editor-menu input').first()
      await page.keyboard.press('Tab'); await expect(option).toBeFocused(); await page.keyboard.press('Space'); await expect(option).toBeChecked()
      await capture('multi-menu-keyboard', { ...ordinary, maxRows: 3, popup: true })
      await page.keyboard.press('Shift+Tab'); await expect(summary).toBeFocused(); await page.keyboard.press('Enter')
      await expect(summary).toHaveText('Plan'); await capture('multi-closed-focused', { ...ordinary, maxRows: 3 })
      await chooseField(page, fixture.fields[3].id); const date = page.locator('.dbw-bulk-field-editor input[type=date]')
      await tabTo(page, date); await date.fill('2026-10-08'); await expect(date).toHaveValue('2026-10-08'); await capture('date-draft-focused', ordinary)
      await page.keyboard.press('Escape'); await expect(date).toHaveValue('')
      await chooseField(page, fixture.fields[4].id); const checkbox = page.locator('.dbw-bulk-field-editor input[type=checkbox]')
      await tabTo(page, checkbox); await page.keyboard.press('Space'); await expect(checkbox).toBeChecked(); await capture('checkbox-draft-focused', ordinary)
      await chooseField(page, fixture.fields[5].id); await capture('long-cjk-field-focused', { ...ordinary, long: true })
      await chooseField(page, fixture.fields[0].id)
      for (const [width, collapsed] of [[760, true], [1280, false]] as const) { await resize(page, app, width, collapsed); await chooseField(page, fixture.fields[0].id); await capture(`text-${width}-${collapsed ? 'collapsed' : 'expanded'}`, ordinary) }
      await resize(page, app)
      const remove = page.locator('.dbw-selection-toolbar').getByRole('button', { name: text.deleteRecord, exact: true })
      await tabTo(page, remove); await capture('delete-focused', ordinary); await page.keyboard.press('Enter')
      await expect(page.getByRole('alertdialog')).toBeVisible(); await tabTo(page, page.getByRole('alertdialog').getByRole('button', { name: text.cancel, exact: true }))
      await page.keyboard.press('Enter'); await expect(page.getByRole('alertdialog')).toHaveCount(0)
      const clear = page.locator('.dbw-selection-toolbar').getByRole('button', { name: text.clearSelection, exact: true })
      await tabTo(page, clear, true); await capture('clear-selection-focused', ordinary); await page.keyboard.press('Enter'); await expect(page.locator('.dbw-selection-toolbar')).toHaveCount(0)
      await selectRows(page, ['Bulk record 0', 'Bulk record 1']); await chooseField(page, fixture.fields[0].id); await capture('linked-selected', { ...ordinary, linked: true, maxRows: 3 })
      await page.locator('.dbw-selection-toolbar').getByRole('button', { name: text.clearSelection, exact: true }).click()
      await selectSource(page, language, false)
      await page.locator('.dbw-table tbody tr:not(.dbw-virtual-spacer) .dbw-select-column input').first().check()
      const selectAll = page.locator('.dbw-selection-toolbar').getByRole('button', { name: language === 'zh-CN' ? '全选当前视图' : 'Select all visible', exact: true })
      await tabTo(page, selectAll); await page.keyboard.press('Enter')
      const catalogCount = before.api.catalog.length; await capture('catalog-select-all-focused', { custom: false, selected: catalogCount, maxRows: 2 })
      await tabTo(page, page.locator('.dbw-selection-toolbar').getByRole('button', { name: text.clearSelection, exact: true })); await page.keyboard.press('Enter'); await expect(page.locator('.dbw-selection-toolbar')).toHaveCount(0)
      await selectSource(page, language, true); await zeroWrites(page, app, before, info, 'local-drafts')
      await selectRows(page, ['Bulk record 1', 'Bulk record 2']); await chooseField(page, fixture.fields[1].id); await tabTo(page, choice)
      await page.keyboard.press('End'); await expect(choice).toHaveValue('Done'); await capture('apply-draft-focused', ordinary)
      await zeroWrites(page, app, before, info, 'before-explicit-apply')
      await explicitWrite(page, app, info, language, fixture, 'Done', 'explicit-apply')
      const cleared = await explicitWrite(page, app, info, language, fixture, null, 'explicit-clear-field')
      await page.reload(); await page.locator('[data-page-id="database"]').click(); await resize(page, app)
      const reloadStored = await stored(page, app); await expect.poll(() => writes(app)).toEqual([...cleared.requests, { channel: 'knowbook:save-setting', input: ['ui.language', language] }])
      const reloadRequests = await writes(app)
      writeFileSync(info.outputPath('reload-persistence.json'), JSON.stringify({ language, expected: cleared.after, reloadStored, requests: cleared.requests, reloadRequests }, null, 2))
      expect(reloadStored).toEqual(cleared.after); await expect(page.locator('.dbw-selection-toolbar')).toHaveCount(0); expect(errors).toEqual([])
    })
  })
}
