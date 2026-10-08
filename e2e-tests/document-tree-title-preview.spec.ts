import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Theme = 'light' | 'dark'
type Kind = 'parent' | 'first' | 'second' | 'huge'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __treeTitlePreviewProbe?: Probe }
const prefix = `共同前缀 Knowledge reading ${'中文English original wording '.repeat(3)}`
const titles = { parent: '00 Short root', first: `01 ${prefix} 第一条唯一末尾 FIRST ENDING`, second: `02 ${prefix} 第二条唯一末尾 SECOND ENDING`,
  huge: `03 超长完整标题 ${'中文ReadingUnbrokenCharacters'.repeat(80)} HUGE UNIQUE ENDING` }
const bodies = { parent: 'Exact original short root body.', first: 'Exact original first child body.', second: 'Exact original second child body.', huge: 'Exact original huge child body.' }
const cases: Array<{ language: Language; theme: Theme; palette: string | null }> = [
  ...(['en-US', 'zh-CN'] as const).flatMap(language => (['light', 'dark'] as const).map(theme => ({ language, theme, palette: null }))),
  ...(['cloud', 'paper', 'moss'] as const).map(palette => ({ language: 'en-US' as const, theme: 'light' as const, palette })),
  ...(['bay', 'midnight', 'violet'] as const).map(palette => ({ language: 'en-US' as const, theme: 'dark' as const, palette }))
]
async function paletteSetup(page: Page, palette: string, theme: Theme) {
  await expect.poll(async () => { const plugin = (await page.evaluate(() => window.knowbook.listSystemPlugins())).find(plugin => plugin.pluginId === 'theme-switcher')
    return plugin?.status === 'active' && plugin.runtimeStatus === 'active' }).toBe(true)
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click(); await page.getByRole('tab', { name: uiText('Appearance', '外观') }).click()
  await expect(page.getByTestId('theme-switcher-settings')).toBeVisible(); await page.getByTestId(`theme-option-${palette}`).click()
  await expect(page.getByTestId(`theme-option-${palette}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', palette)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme)
  await expect.poll(() => page.evaluate(async () => { const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')
    if (!plugin?.currentArtifactSha256) throw new Error('The active palette must have an installed artifact.')
    return window.knowbook.invokeSystemPluginMain({ pluginId: 'theme-switcher', revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'get-state' })
  })).toMatchObject({ selectedThemeId: palette })
}
async function settle(page: Page) {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => { element.getBoundingClientRect()
    return element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' || animation.pending).length })).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function resize(page: Page, app: ElectronApplication, width: number) {
  const size = await app.evaluate(({ BrowserWindow }, width) => { const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width, height: 800 }); return window.getContentSize() }, width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size); await settle(page)
}
async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let step = 0; step < 60; step++) { if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab') }
  await expect(target).toBeFocused()
}
async function pointer(page: Page, target: Locator) {
  const witness = await target.evaluate(element => {
    const box = element.getBoundingClientRect(), plain = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    for (let node = element.parentElement; node; node = node.parentElement) { const css = getComputedStyle(node), rect = node.getBoundingClientRect()
      if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) { left = Math.max(left, rect.left + (parseFloat(css.borderLeftWidth) || 0)); right = Math.min(right, rect.right - (parseFloat(css.borderRightWidth) || 0)) }
      if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) { top = Math.max(top, rect.top + (parseFloat(css.borderTopWidth) || 0)); bottom = Math.min(bottom, rect.bottom - (parseFloat(css.borderBottomWidth) || 0)) }
      if (css.position === 'fixed') break
    }
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2), owner = element.closest<HTMLElement>('.tree-node[role="treeitem"]')
    return { box: plain(box), viewport: [innerWidth, innerHeight], clip: { left, top, right, bottom },
      fullyVisible: box.width > 0 && box.height > 0 && box.left >= left - .01 && box.right <= right + .01 && box.top >= top - .01 && box.bottom <= bottom + .01,
      centerHit: hit === element || Boolean(hit && element.contains(hit)), owner: owner?.getAttribute('aria-label') ?? null,
      ownerBox: owner ? plain(owner.getBoundingClientRect()) : null, titleBox: owner ? plain(owner.querySelector('.tree-document-title')!.getBoundingClientRect()) : null }
  })
  if (!witness.fullyVisible || !witness.centerHit) throw new Error(`The real pointer target must be reachable before mouse movement: ${JSON.stringify(witness)}`)
  await page.mouse.move(witness.box.left + witness.box.width / 2, witness.box.top + witness.box.height / 2, { steps: 8 }); await settle(page); return witness
}
async function away(page: Page) { await page.mouse.move(await page.evaluate(() => innerWidth - 20), 400); await settle(page) }
async function dwell(page: Page) { await page.waitForTimeout(700); await settle(page) }
async function readStored(page: Page) {
  return page.evaluate(async () => { const catalog = (await window.knowbook.getDocumentCatalog()).sort((a, b) => a.id.localeCompare(b.id))
    const databases = (await window.knowbook.getDatabases()).sort((a, b) => a.id.localeCompare(b.id))
    return { catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))), databases,
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort((a, b) => a.id.localeCompare(b.id)),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort((a, b) => a.id.localeCompare(b.id)),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort((a, b) => a.id.localeCompare(b.id)) }))) } })
}
async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => { const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }; (globalThis as ProbeGlobal).__treeTitlePreviewProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) if (/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) {
      ipcMain.removeHandler(channel); ipcMain.handle(channel, async (event, ...input: unknown[]) => { const request = { channel, input: structuredClone(input) }; probe.requests.push(request)
        try { const result = await original(event, ...input); probe.writes.push(request); return result }
        catch (error) { probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) }); throw error } })
    } })
}
async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, theme: Theme, palette: string | null,
  before: Awaited<ReturnType<typeof readStored>>, phase: string, interaction: unknown = null) {
  const state = await page.evaluate(() => {
    const box = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
    const metric = (element: HTMLElement | null) => {
      if (!element) return null
      const rect = box(element.getBoundingClientRect()), css = getComputedStyle(element), clips: Array<{ tag: string; className: string; box: ReturnType<typeof box>; overflowX: string; overflowY: string }> = []
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node), bounds = box(node.getBoundingClientRect())
        const bl = parseFloat(style.borderLeftWidth) || 0, br = parseFloat(style.borderRightWidth) || 0, bt = parseFloat(style.borderTopWidth) || 0, bb = parseFloat(style.borderBottomWidth) || 0
        const vs = /auto|scroll/.test(style.overflowY) ? Math.max(0, node.offsetWidth - node.clientWidth - Math.round(bl + br)) : 0
        const hs = /auto|scroll/.test(style.overflowX) ? Math.max(0, node.offsetHeight - node.clientHeight - Math.round(bt + bb)) : 0
        clips.push({ tag: node.tagName, className: node.className, box: bounds, overflowX: style.overflowX, overflowY: style.overflowY })
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, bounds.left + bl); right = Math.min(right, bounds.right - br - vs) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, bounds.top + bt); bottom = Math.min(bottom, bounds.bottom - bb - hs) }
        if (style.position === 'fixed') break
      }
      const visible = (value: ReturnType<typeof box>) => value.width > 0 && value.height > 0 && value.left >= left - .01 && value.right <= right + .01 && value.top >= top - .01 && value.bottom <= bottom + .01
      const ownBorder = [css.borderLeftWidth, css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth].map(value => parseFloat(value) || 0)
      const ownVS = /auto|scroll/.test(css.overflowY) ? Math.max(0, element.offsetWidth - element.clientWidth - Math.round(ownBorder[0] + ownBorder[2])) : 0
      const ownHS = /auto|scroll/.test(css.overflowX) ? Math.max(0, element.offsetHeight - element.clientHeight - Math.round(ownBorder[1] + ownBorder[3])) : 0
      const textViewport = { left: Math.max(left, rect.left + ownBorder[0]), top: Math.max(top, rect.top + ownBorder[1]),
        right: Math.min(right, rect.right - ownBorder[2] - ownVS), bottom: Math.min(bottom, rect.bottom - ownBorder[3] - ownHS) }
      const own = (value: ReturnType<typeof box>) => visible(value) && value.left >= textViewport.left - .01 && value.right <= textViewport.right + .01 && value.top >= textViewport.top - .01 && value.bottom <= textViewport.bottom + .01
      const nodes: Text[] = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.length) nodes.push(node as Text)
      const textRects = nodes.flatMap(node => { const range = document.createRange(); range.selectNodeContents(node); return Array.from(range.getClientRects()).map(box) })
      const character = (first: boolean) => { const node = first ? nodes[0] : nodes.at(-1); if (!node) return null
        const range = document.createRange(); range.setStart(node, first ? 0 : node.length - 1); range.setEnd(node, first ? 1 : node.length)
        const value = box(range.getBoundingClientRect()); return { value: first ? node.data.slice(0, 1) : node.data.slice(-1), box: value, visible: own(value) } }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { box: rect, clip: { left, top, right, bottom }, textViewport, clips, fullyVisible: visible(rect), centerHit: hit === element || Boolean(hit && element.contains(hit)),
        text: element.textContent, textRects, wholeTextVisible: textRects.length > 0 && textRects.every(own), firstCharacter: character(true), lastCharacter: character(false),
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop,
        whiteSpace: css.whiteSpace, overflowWrap: css.overflowWrap, textOverflow: css.textOverflow, userSelect: css.userSelect,
        focused: document.activeElement === element, focusVisible: element.matches(':focus-visible') }
    }
    const popup = document.querySelector<HTMLElement>('.tree-title-preview'), tree = document.querySelector<HTMLElement>('.tree-virtual-scroll')
    const active = document.activeElement as HTMLElement | null
    return { viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, theme: document.documentElement.dataset.theme,
      palette: document.documentElement.getAttribute('data-knowbook-theme-switcher'), colorScheme: getComputedStyle(document.documentElement).colorScheme,
      title: document.querySelector('.document-header-title')?.textContent,
      body: Array.from(document.querySelectorAll<HTMLElement>('.document-reading-row[data-block-id]')).map(row => ({ id: row.dataset.blockId, text: row.textContent })),
      active: active ? { tag: active.tagName, className: active.className, role: active.getAttribute('role'), name: active.getAttribute('aria-label') } : null,
      popupCount: document.querySelectorAll('.tree-title-preview').length,
      preview: popup ? { id: popup.id, role: popup.getAttribute('role'), popup: metric(popup), text: metric(popup.querySelector<HTMLElement>('.tree-title-preview-text')),
        hint: metric(popup.querySelector<HTMLElement>('.tree-title-preview-hint')) } : null,
      rows: Array.from(document.querySelectorAll<HTMLElement>('.tree-node[role="treeitem"]')).map(row => ({ name: row.getAttribute('aria-label'), selected: row.getAttribute('aria-selected'),
        describedBy: row.getAttribute('aria-describedby'), focused: document.activeElement === row, title: metric(row.querySelector<HTMLElement>('.tree-document-title')),
        nativeTitle: row.querySelector<HTMLElement>('.tree-document-title')?.getAttribute('title') ?? row.querySelector<HTMLElement>('.tree-button')?.getAttribute('title') ?? null })),
      tree: tree ? { top: tree.scrollTop, clientHeight: tree.clientHeight, scrollHeight: tree.scrollHeight, box: box(tree.getBoundingClientRect()) } : null,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
  })
  const main = await app.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(),
    contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
    probe: (globalThis as ProbeGlobal).__treeTitlePreviewProbe! }))
  const result = { language, theme, palette, phase, state, interaction, ...main, before, stored: await readStored(page) }
  const path = info.outputPath(`${language}-${palette ?? theme}-${phase}.json`); writeFileSync(path, JSON.stringify(result, null, 2)); await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${palette ?? theme}-${phase}.png`) }); return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function invariant(value: Evidence, width: number, kind: Kind = 'parent') {
  expect(value.windows).toHaveLength(1); const window = value.windows[0]
  expect(window.bounds).toMatchObject({ width, height: 800 }); expect(window.minimumSize).toEqual([760, 760]); expect(value.state.viewport).toEqual(window.contentSize)
  expect(window.contentSize).toEqual([window.contentBounds.width, window.contentBounds.height]); expect(value.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(value.probe).toEqual({ requests: [], writes: [], failures: [] }); expect(value.stored).toEqual(value.before)
  expect(value.state).toMatchObject({ theme: value.theme, palette: value.palette, colorScheme: value.theme, title: titles[kind], horizontalOverflow: false })
  expect(value.state.body.find(row => row.id === `tree-preview-${kind}`)?.text).toContain(bodies[kind])
}
function previewVisible(value: Evidence, kind: 'first' | 'second' | 'huge', full = true) {
  // The first old-source oracle measures visible rendered text after JSON/PNG capture; it does not wait for a nonexistent tooltip.
  if (full) expect(value.state.preview?.text?.wholeTextVisible ?? false, 'The complete truncated title must have a visible renderer preview.').toBe(true)
  expect(value.state.popupCount).toBe(1); expect(value.state.preview?.role).toBe('tooltip'); expect(value.state.preview?.id).toBeTruthy()
  expect(value.state.preview?.popup).toMatchObject({ fullyVisible: true, centerHit: true })
  expect(value.state.preview?.text?.text).toBe(titles[kind]); expect(value.state.preview!.text!.scrollWidth).toBeLessThanOrEqual(value.state.preview!.text!.clientWidth + 1)
  expect(value.state.preview!.text!.whiteSpace).not.toBe('nowrap')
  const owners = value.state.rows.filter(row => row.describedBy === value.state.preview!.id)
  expect(owners.map(row => row.name)).toEqual([titles[kind]]); expect(owners[0].nativeTitle).toBeNull()
  if (full) { expect(value.state.preview!.text!.lastCharacter?.visible).toBe(true); expect(value.state.preview!.hint).toBeNull() }
}
function noPreview(value: Evidence) { expect(value.state.popupCount).toBe(0); expect(value.state.rows.filter(row => row.describedBy)).toHaveLength(0) }

for (const { language, theme, palette } of cases) test(`Truncated tree titles remain readable in ${language} ${palette ?? theme} @electron`, async ({}, info) => {
  test.setTimeout(120000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ app, page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const ids = await page.evaluate(async ({ language, theme, titles, bodies }) => {
      const ids: Record<string, string> = {}; const parent = await window.knowbook.createDocument(null); ids.parent = parent.id
      await window.knowbook.updateDocument(parent.id, { title: titles.parent, summary: 'Original short root summary.', blocks: [{ id: 'tree-preview-parent', type: 'paragraph', content: bodies.parent, checked: false, depth: 0 }] })
      for (const kind of ['first', 'second', 'huge'] as const) { const child = await window.knowbook.createDocument(parent.id); ids[kind] = child.id
        await window.knowbook.updateDocument(child.id, { title: titles[kind], summary: `Original ${kind} summary.`, blocks: [{ id: `tree-preview-${kind}`, type: 'paragraph', content: bodies[kind], checked: false, depth: 0 }] }) }
      // Real extra rows supply a physical scroll range; no synthetic tree rows or scroll repair are used.
      for (let index = 0; index < 22; index++) { const child = await window.knowbook.createDocument(parent.id)
        await window.knowbook.updateDocument(child.id, { title: `90 Filler ${String(index + 1).padStart(2, '0')}`, summary: 'Original filler summary.', blocks: [{ id: `tree-preview-filler-${index}`, type: 'paragraph', content: `Original filler body ${index + 1}.`, checked: false, depth: 0 }] }) }
      await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme); return ids
    }, { language, theme, titles, bodies })
    await page.reload(); await resize(page, app, 1360); if (palette) await paletteSetup(page, palette, theme)
    await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click(); const before = await readStored(page)
    await expect.poll(async () => { const title = await page.locator('.document-header-title').textContent(); return before.catalog.some(document => document.title === title) }).toBe(true)
    const row = (kind: Kind) => page.getByRole('treeitem', { name: titles[kind], exact: true })
    const parent = row('parent'), first = row('first'), second = row('second'), huge = row('huge'), search = page.locator('.sidebar-search-button')
    const ready = async (kind: Kind) => { await expect(page.locator('.document-header-title')).toHaveText(titles[kind])
      const toggle = page.locator('.document-view-toggle'); if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
      await expect(page.locator(`[data-block-id="tree-preview-${kind}"]`)).toContainText(bodies[kind]); await settle(page) }
    // The initial selected document can be offscreen in the virtual tree. Native
    // Tab enters its retained roving LI; Home reveals the first real root.
    const currentRoving = page.locator('.tree-node[role="treeitem"][tabindex="0"]')
    // Documents navigation precedes Search; enter the sidebar in its forward Tab order.
    await expect(currentRoving).toHaveCount(1); await tabTo(page, search)
    await page.keyboard.press('Tab'); await tabTo(page, currentRoving); await expect(currentRoving).toBeFocused()
    await page.keyboard.press('Home'); await expect(parent).toBeFocused(); await page.keyboard.press('Enter')
    await ready('parent'); await installProbe(app)
    const capture = (phase: string, interaction: unknown = null) => record(page, app, info, language, theme, palette, before, phase, interaction)
    await pointer(page, parent.locator('.tree-button')); await dwell(page)
    const short = await capture('wide-short-hover-no-preview')
    const hoverWitness = await pointer(page, first.locator('.tree-button')); await dwell(page)
    const original = await capture('wide-long-hover-before-first-full-title-oracle', { hoverWitness }); invariant(original, 1360); previewVisible(original, 'first')
    expect(original.interaction).toMatchObject({ hoverWitness: { fullyVisible: true, centerHit: true, owner: titles.first } })
    noPreview(short); invariant(short, 1360); expect(original.state.rows.find(row => row.name === titles.first)?.title?.scrollWidth).toBeGreaterThan(original.state.rows.find(row => row.name === titles.first)!.title!.clientWidth)
    expect(before.catalog.find(document => document.id === ids.first)?.parentId).toBe(ids.parent)
    await pointer(page, page.locator('.tree-title-preview-text')); await dwell(page)
    const entered = await capture('pointer-crosses-gap-and-remains-in-preview'); previewVisible(entered, 'first'); invariant(entered, 1360)
    expect(entered.state.preview!.text!.userSelect).not.toBe('none')
    await pointer(page, first.locator('.tree-button')); const initialFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute('aria-label') }))
    await page.keyboard.press('Escape'); await dwell(page)
    const escapedHover = await capture('escape-same-pointer-does-not-reopen', { initialFocus }); noPreview(escapedHover); invariant(escapedHover, 1360)
    expect({ tag: escapedHover.state.active?.tag, name: escapedHover.state.active?.name }).toEqual(initialFocus)
    await away(page); await pointer(page, second.locator('.tree-button')); await dwell(page)
    const otherHover = await capture('reenter-second-same-prefix-unique-suffix'); previewVisible(otherHover, 'second'); invariant(otherHover, 1360)
    await away(page); await tabTo(page, search, true); await page.keyboard.press('Tab'); await tabTo(page, parent); await expect(parent).toBeFocused()
    await expect(parent).toHaveAttribute('aria-expanded', 'true'); await page.keyboard.press('ArrowRight'); await expect(first).toBeFocused()
    await expect(page.locator('.tree-title-preview-text')).toHaveText(titles.first); await settle(page)
    const focused = await capture('real-tab-roving-arrow-right-focus-preview'); previewVisible(focused, 'first'); invariant(focused, 1360)
    expect(focused.state.active?.name).toBe(titles.first)
    const firstNode = await first.elementHandle(); if (!firstNode) throw new Error('The first genuinely focused row must exist.')
    await page.keyboard.press('Escape'); await dwell(page)
    const escapedFocus = await capture('escape-keeps-same-focused-treeitem'); noPreview(escapedFocus); invariant(escapedFocus, 1360); await expect(first).toBeFocused()
    expect(await first.evaluate((element, original) => element === original, firstNode)).toBe(true); await firstNode.dispose()
    await page.keyboard.press('ArrowDown'); await expect(second).toBeFocused(); await expect(page.locator('.tree-title-preview-text')).toHaveText(titles.second); await settle(page)
    const next = await capture('arrow-down-replaces-only-preview-owner'); previewVisible(next, 'second'); invariant(next, 1360); expect(next.state.active?.name).toBe(titles.second)
    const secondNode = await second.elementHandle(); if (!secondNode) throw new Error('The second genuinely focused row must exist.')
    await resize(page, app, 760); const resized = await capture('native-narrow-dismisses-old-preview'); noPreview(resized); invariant(resized, 760)
    expect(await second.evaluate((element, original) => element === original, secondNode)).toBe(true); await expect(second).toBeFocused(); await secondNode.dispose()
    await away(page); await pointer(page, second.locator('.tree-button')); await dwell(page)
    const narrow = await capture('native-narrow-hover-full-title'); previewVisible(narrow, 'second'); invariant(narrow, 760)
    const tree = page.locator('.tree-virtual-scroll'), treeBox = await tree.boundingBox(); if (!treeBox) throw new Error('The real tree scroll viewport must exist.')
    const scrollBefore = await tree.evaluate(element => element.scrollTop)
    await page.mouse.move(treeBox.x + 8, treeBox.y + treeBox.height - 15); await page.mouse.wheel(0, 600)
    await expect.poll(() => tree.evaluate(element => element.scrollTop)).toBeGreaterThan(scrollBefore); await settle(page)
    const wheeled = await capture('real-tree-wheel-dismisses-preview', { scrollBefore }); noPreview(wheeled); invariant(wheeled, 760)
    await page.keyboard.press('ArrowDown'); await expect(huge).toBeFocused(); await expect(page.locator('.tree-title-preview-text')).toHaveText(titles.huge)
    await expect(page.locator('.tree-title-preview-hint')).toBeVisible(); await settle(page)
    const hugeNode = await huge.elementHandle(); if (!hugeNode) throw new Error('The huge title owner must be genuinely focused.')
    for (let step = 0; step < 35; step++) {
      const done = await page.locator('.tree-title-preview-text').evaluate(element => element.scrollTop >= element.scrollHeight - element.clientHeight - 1)
      if (done) break; await page.keyboard.press('PageDown'); await settle(page)
    }
    const end = await capture('huge-owner-page-down-last-character'); previewVisible(end, 'huge', false); invariant(end, 760)
    expect(end.state.preview!.text!.lastCharacter?.visible).toBe(true); expect(end.state.preview!.text!.scrollTop).toBeGreaterThan(0); await expect(huge).toBeFocused()
    expect(await huge.evaluate((element, original) => element === original, hugeNode)).toBe(true)
    for (let step = 0; step < 35; step++) { if (await page.locator('.tree-title-preview-text').evaluate(element => element.scrollTop <= .01)) break
      await page.keyboard.press('PageUp'); await settle(page) }
    const start = await capture('huge-owner-page-up-first-character'); previewVisible(start, 'huge', false); invariant(start, 760)
    expect(start.state.preview!.text!.firstCharacter?.visible).toBe(true); expect(start.state.preview!.text!.scrollTop).toBeLessThanOrEqual(.01); await expect(huge).toBeFocused()
    await resize(page, app, 1360); const wideAgain = await capture('native-wide-dismisses-preview-keeps-owner'); noPreview(wideAgain); invariant(wideAgain, 1360)
    expect(await huge.evaluate((element, original) => element === original, hugeNode)).toBe(true); await expect(huge).toBeFocused(); await hugeNode.dispose()
    await page.keyboard.press('ArrowLeft'); await expect(parent).toBeFocused(); await page.keyboard.press('ArrowRight'); await expect(first).toBeFocused()
    await page.keyboard.press('Enter'); await ready('first'); await away(page)
    const childNavigation = await capture('real-tree-enter-opens-exact-first-child'); invariant(childNavigation, 1360, 'first')
    expect(childNavigation.state.rows.find(row => row.name === titles.first)?.selected).toBe('true')
    await page.keyboard.press('ArrowLeft'); await expect(parent).toBeFocused(); await page.keyboard.press('Enter'); await ready('parent'); await away(page)
    const navigation = await capture('arrow-parent-enter-preserves-real-document-navigation'); noPreview(navigation); invariant(navigation, 1360)
    expect(navigation.state.active?.name).toBe(titles.parent); expect(navigation.state.rows.find(row => row.name === titles.parent)?.selected).toBe('true')
    expect(await readStored(page)).toEqual(before); expect(errors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
