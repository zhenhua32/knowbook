import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Theme = 'light' | 'dark'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __sidebarMetadataContrastProbe?: Probe }
const titles = { parent: 'Sidebar metadata root', child: 'Sidebar metadata child with a deliberately long complete accessible title, retained original wording, and a unique final ending' }
const bodies = { parent: 'Exact original sidebar metadata root body.', child: 'Exact original sidebar metadata child body.' }
const cases: Array<{ language: Language; theme: Theme; palette: string | null }> = [
  ...(['en-US', 'zh-CN'] as const).flatMap(language => (['light', 'dark'] as const).map(theme => ({ language, theme, palette: null }))),
  ...(['cloud', 'paper', 'moss'] as const).map(palette => ({ language: 'en-US' as const, theme: 'light' as const, palette })),
  ...(['bay', 'midnight', 'violet'] as const).map(palette => ({ language: 'en-US' as const, theme: 'dark' as const, palette }))
]
async function paletteSetup(page: Page, palette: string, theme: Theme) {
  await expect.poll(async () => {
    const plugin = (await page.evaluate(() => window.knowbook.listSystemPlugins())).find(plugin => plugin.pluginId === 'theme-switcher')
    return plugin?.status === 'active' && plugin.runtimeStatus === 'active'
  }).toBe(true)
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Appearance', '外观') }).click()
  await expect(page.getByTestId('theme-switcher-settings')).toBeVisible(); await page.getByTestId(`theme-option-${palette}`).click()
  await expect(page.getByTestId(`theme-option-${palette}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', palette)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme)
  await expect.poll(() => page.evaluate(async () => {
    const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')
    if (!plugin?.currentArtifactSha256) throw new Error('The active palette must have an installed artifact.')
    return window.knowbook.invokeSystemPluginMain({ pluginId: 'theme-switcher', revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'get-state' })
  })).toMatchObject({ selectedThemeId: palette })
}
async function settle(page: Page) {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => {
    element.getBoundingClientRect(); return element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' || animation.pending).length
  })).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function resize(page: Page, app: ElectronApplication, width: number) {
  const size = await app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ width, height: 800 }); return window.getContentSize()
  }, width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size); await settle(page)
}
async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let step = 0; step < 60; step++) { if (await target.evaluate(element => document.activeElement === element)) return; await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab') }
  await expect(target).toBeFocused()
}
async function pointAt(page: Page, target: Locator) {
  const box = await target.boundingBox(); if (!box || box.width <= 0 || box.height <= 0) throw new Error('The real pointer target must have visible geometry.')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await settle(page)
}
async function away(page: Page) { await page.mouse.move(await page.evaluate(() => innerWidth - 20), 400); await settle(page) }
async function dateReady(date: Locator) { await expect.poll(() => date.evaluate(element => getComputedStyle(element).opacity)).toBe('1') }
async function readStored(page: Page) {
  return page.evaluate(async () => {
    const catalog = (await window.knowbook.getDocumentCatalog()).sort((a, b) => a.id.localeCompare(b.id))
    const databases = (await window.knowbook.getDatabases()).sort((a, b) => a.id.localeCompare(b.id))
    return { catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))), databases,
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort((a, b) => a.id.localeCompare(b.id)),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort((a, b) => a.id.localeCompare(b.id)),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort((a, b) => a.id.localeCompare(b.id)) }))) }
  })
}
async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }; (globalThis as ProbeGlobal).__sidebarMetadataContrastProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) if (/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) {
      ipcMain.removeHandler(channel); ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        const request = { channel, input: structuredClone(input) }; probe.requests.push(request)
        try { const result = await original(event, ...input); probe.writes.push(request); return result }
        catch (error) { probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) }); throw error }
      })
    }
  })
}
async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, theme: Theme, palette: string | null,
  before: Awaited<ReturnType<typeof readStored>>, phase: string, selectedTitle: string, hoveredTitle: string | null = null, interaction: unknown = null) {
  const metadata = await page.evaluate(({ selectedTitle, hoveredTitle, language, catalog }) => {
    const parse = (raw: string): number[] | null => {
      const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i
      const srgb = raw.match(/^color\(srgb\s+([^/]+?)(?:\s*\/\s*([^/]+?))?\)$/)
      if (srgb) { const parts = srgb[1].trim().split(/\s+/); if (parts.length !== 3) return null; parts.push(srgb[2]?.trim() ?? '1')
        if (!parts.every(part => numeric.test(part))) return null; const values = parts.map(part => Number(part.replace(/%$/, '')) * (part.endsWith('%') ? .01 : 1))
        return values.every(value => value >= 0 && value <= 1) ? values.map((value, index) => index < 3 ? value * 255 : value) : null }
      const match = raw.match(/^rgba?\((.+)\)$/); if (!match) return null; const split = match[1].trim().split(/\s*\/\s*/)
      if (split.length > 2 || (split.length === 2 && split[0].includes(','))) return null
      const parts = split[0].includes(',') ? split[0].split(',').map(part => part.trim()) : split[0].split(/\s+/)
      if (split.length === 2) { if (parts.length !== 3) return null; parts.push(split[1]) } else if (!split[0].includes(',') && parts.length !== 3) return null
      if (parts.length === 3) parts.push('1'); if (parts.length !== 4 || !parts.every(part => numeric.test(part))) return null
      const values = parts.map((part, index) => Number(part.replace(/%$/, '')) * (part.endsWith('%') ? (index === 3 ? .01 : 2.55) : 1))
      return values.every((value, index) => Number.isFinite(value) && value >= 0 && value <= (index === 3 ? 1 : 255)) ? values : null
    }
    const over = (front: number[], back: number[]) => { const alpha = front[3] + back[3] * (1 - front[3])
      return [...front.slice(0, 3).map((value, index) => (value * front[3] + back[index] * back[3] * (1 - front[3])) / alpha), alpha] }
    const luminance = (color: number[]) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0)
    const plainBox = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
    const contains = (outer: ReturnType<typeof plainBox>, inner: ReturnType<typeof plainBox>) => inner.width > 0 && inner.height > 0 && inner.left >= outer.left - .01 && inner.right <= outer.right + .01 && inner.top >= outer.top - .01 && inner.bottom <= outer.bottom + .01
    const row = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('.tree-node[role="treeitem"]')).find(node => node.getAttribute('aria-label') === title)
    const selected = row(selectedTitle), hovered = hoveredTitle ? row(hoveredTitle) : null
    const requested = [ { key: 'selected-date', element: selected?.querySelector<HTMLElement>('.tree-button > small'), expected: new Date(catalog.find(document => document.title === selectedTitle)!.updatedAt).toLocaleDateString(language) },
      { key: 'document-count', element: document.querySelector<HTMLElement>('.sidebar-section-count'), expected: String(catalog.length) },
      { key: 'search-shortcut', element: document.querySelector<HTMLElement>('.sidebar-search-button kbd'), expected: 'Ctrl K' },
      ...(hoveredTitle ? [{ key: 'hovered-date', element: hovered?.querySelector<HTMLElement>('.tree-button > small'), expected: new Date(catalog.find(document => document.title === hoveredTitle)!.updatedAt).toLocaleDateString(language) }] : []) ]
    const measures = requested.map(({ key, element, expected }) => {
      if (!element) throw new Error(`The real sidebar metadata is missing: ${key}`)
      const css = getComputedStyle(element), box = plainBox(element.getBoundingClientRect()), range = document.createRange(); range.selectNodeContents(element)
      const textRects = Array.from(range.getClientRects()).map(plainBox), textBox = plainBox(range.getBoundingClientRect())
      const layers: Array<{ tag: string; className: string; background: string; rgba: number[] | null; resolvedPaintRGBA: number[] | null; image: string; imageKnown: boolean; boundedGradient: boolean; gradient: unknown; box: ReturnType<typeof plainBox>; origin: string; clip: string; coversText: boolean }> = []
      const effects: Array<{ tag: string; className: string; opacity: string; filter: string; backdropFilter: string; blend: string; transform: string; translationOnly: boolean; clipPath: string; mask: string }> = []
      let found = false, left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node), rect = plainBox(node.getBoundingClientRect()), color = parse(style.backgroundColor)
        const border = [style.borderLeftWidth, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth].map(value => parseFloat(value) || 0)
        const matrix = style.transform.match(/^matrix\(([^)]+)\)$/)?.[1].split(',').map(Number)
        effects.push({ tag: node.tagName, className: node.className, opacity: style.opacity, filter: style.filter, backdropFilter: style.backdropFilter, blend: style.mixBlendMode,
          transform: style.transform, translationOnly: style.transform === 'none' || Boolean(matrix && matrix.length === 6 && matrix.every(Number.isFinite) && matrix[0] === 1 && matrix[1] === 0 && matrix[2] === 0 && matrix[3] === 1), clipPath: style.clipPath, mask: style.maskImage })
        if (!found) {
          let imageKnown = style.backgroundImage === 'none', gradient: unknown = null, resolvedPaintRGBA = color, boundedGradient = false
          if (!imageKnown) {
            const match = style.backgroundImage.match(/^radial-gradient\(circle at 18% 0%, (rgba?\([^)]*\))(?: 0%)?, (rgba?\([^)]*\)|transparent) 28%\)(?:, none)?$/)
            const first = match ? parse(match[1]) : null, last = match ? (match[2] === 'transparent' ? [0, 0, 0, 0] : parse(match[2])) : null
            const origin = { left: rect.left + border[0], top: rect.top + border[1], right: rect.right - border[2], bottom: rect.bottom - border[3] }
            const center = { x: origin.left + (origin.right - origin.left) * .18, y: origin.top }
            const radius = Math.max(...[origin.left, origin.right].flatMap(x => [origin.top, origin.bottom].map(y => Math.hypot(x - center.x, y - center.y))))
            const nearest = { x: Math.max(textBox.left, Math.min(center.x, textBox.right)), y: Math.max(textBox.top, Math.min(center.y, textBox.bottom)) }
            const nearestDistance = Math.hypot(nearest.x - center.x, nearest.y - center.y), transparentRadius = radius * .28
            const farthestDistance = Math.max(...[textBox.left, textBox.right].flatMap(x => [textBox.top, textBox.bottom].map(y => Math.hypot(x - center.x, y - center.y))))
            const maxAlpha = .18 * Math.max(0, 1 - nearestDistance / transparentRadius), minAlpha = .18 * Math.max(0, 1 - farthestDistance / transparentRadius)
            const baseMonotonic = Boolean(first && color?.[3] === 1 && first.slice(0, 3).every((value, index) => value >= color[index]))
            imageKnown = Boolean(node.matches('.sidebar') && match && first?.every((value, index) => Math.abs(value - [91, 99, 232, .18][index]) < 1e-8) && last?.[3] === 0
              && style.backgroundOrigin.split(',').every(value => value.trim() === 'padding-box') && style.backgroundClip.split(',').every(value => value.trim() === 'border-box')
              && style.backgroundSize.split(',').every(value => value.trim() === 'auto') && style.backgroundPosition.split(',').every(value => value.trim() === '0% 0%') && transparentRadius > 0 && baseMonotonic)
            const paintRGBA = first ? [...first.slice(0, 3), maxAlpha] : null
            resolvedPaintRGBA = imageKnown && paintRGBA && color ? over(paintRGBA, color) : null; boundedGradient = imageKnown
            gradient = { method: 'premultiplied-srgb-whole-text-bright-background-upper-bound', first, last, opaqueBaseRGBA: color, origin, center, radius, transparentRadius,
              nearest, nearestDistance, farthestDistance, minAlpha, maxAlpha, paintRGBA, resolvedPaintRGBA, baseMonotonic, wholeTextOutside: nearestDistance >= transparentRadius }
          }
          layers.push({ tag: node.tagName, className: node.className, background: style.backgroundColor, rgba: color, resolvedPaintRGBA, image: style.backgroundImage, imageKnown, boundedGradient, gradient, box: rect,
            origin: style.backgroundOrigin, clip: style.backgroundClip, coversText: style.backgroundClip.split(',').every(value => value.trim() === 'border-box') && contains(rect, textBox) })
          found = resolvedPaintRGBA?.[3] === 1 && imageKnown
        }
        const vs = /auto|scroll/.test(style.overflowY) ? Math.max(0, node.offsetWidth - node.clientWidth - Math.round(border[0] + border[2])) : 0
        const hs = /auto|scroll/.test(style.overflowX) ? Math.max(0, node.offsetHeight - node.clientHeight - Math.round(border[1] + border[3])) : 0
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, rect.left + border[0]); right = Math.min(right, rect.right - border[2] - vs) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, rect.top + border[1]); bottom = Math.min(bottom, rect.bottom - border[3] - hs) }
      }
      const foreground = parse(css.color), structureKnown = Boolean(foreground && found && css.textShadow === 'none' && layers.every(layer => layer.resolvedPaintRGBA && layer.imageKnown && (layer.resolvedPaintRGBA[3] === 0 || layer.coversText))
        && effects.every(effect => Number(effect.opacity) === 1 && effect.filter === 'none' && effect.backdropFilter === 'none' && effect.blend === 'normal' && effect.translationOnly && effect.clipPath === 'none' && effect.mask === 'none'))
      let background = structureKnown ? layers.at(-1)!.resolvedPaintRGBA : null; if (background) for (const layer of layers.slice(0, -1).reverse()) background = over(layer.resolvedPaintRGBA!, background)
      const hasBoundedGradient = layers.some(layer => layer.boundedGradient), maximumBackground = background
      const foregroundMonotonic = Boolean(foreground?.[3] === 1 && maximumBackground && foreground.slice(0, 3).every((value, index) => value >= maximumBackground[index]))
      const known = structureKnown && (!hasBoundedGradient || foregroundMonotonic)
      const effective = known && background && foreground ? over(foreground, background) : null, a = effective ? luminance(effective) : null, b = background ? luminance(background) : null
      const clip = { left, top, right, bottom, width: right - left, height: bottom - top }, hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { key, expected, text: element.textContent, fontSize: parseFloat(css.fontSize), rawColor: css.color, foreground, background, effectiveColor: effective,
        known, ratioMethod: hasBoundedGradient ? 'whole-text-contrast-lower-bound' : 'solid-background-composite', foregroundMonotonic,
        ratio: a !== null && b !== null ? (Math.max(a, b) + .05) / (Math.min(a, b) + .05) : null, opacity: css.opacity, textShadow: css.textShadow,
        layers, effects, box, textBox, textRects, clip, wholeBoxVisible: contains(clip, box), fullTextVisible: textRects.length > 0 && textRects.every(rect => contains(box, rect) && contains(clip, rect)),
        centerHit: hit === element || Boolean(hit && element.contains(hit)), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, whiteSpace: css.whiteSpace, overflow: css.overflow, textOverflow: css.textOverflow }
    })
    const long = row(hoveredTitle ?? selectedTitle)?.querySelector<HTMLElement>('.tree-document-title')
    return { measures, selected: selected ? { title: selected.getAttribute('aria-label'), selected: selected.getAttribute('aria-selected'), focused: document.activeElement === selected, expanded: selected.getAttribute('aria-expanded') } : null,
      longTitle: long ? { text: long.textContent, rowName: long.closest('[role="treeitem"]')?.getAttribute('aria-label'), scrollWidth: long.scrollWidth, clientWidth: long.clientWidth, textOverflow: getComputedStyle(long).textOverflow, whiteSpace: getComputedStyle(long).whiteSpace } : null,
      hovered: { selected: Boolean(selected?.querySelector('.tree-button')?.matches(':hover')), child: Boolean(hovered?.querySelector('.tree-button')?.matches(':hover')), search: Boolean(document.querySelector('.sidebar-search-button')?.matches(':hover')) },
      active: { tag: document.activeElement?.tagName, className: document.activeElement?.className }, viewport: [innerWidth, innerHeight], devicePixelRatio,
      theme: document.documentElement.dataset.theme, palette: document.documentElement.getAttribute('data-knowbook-theme-switcher'), colorScheme: getComputedStyle(document.documentElement).colorScheme,
      title: document.querySelector('.document-header-title')?.textContent, body: Array.from(document.querySelectorAll('.document-reading-row')).map(row => ({ id: (row as HTMLElement).dataset.blockId, text: row.textContent })),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
  }, { selectedTitle, hoveredTitle, language, catalog: before.catalog })
  const main = await app.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(), contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(),
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })), probe: (globalThis as ProbeGlobal).__sidebarMetadataContrastProbe! }))
  const result = { language, theme, palette, phase, metadata, interaction, ...main, before, stored: await readStored(page) }
  const path = info.outputPath(`${language}-${palette ?? theme}-${phase}.json`); writeFileSync(path, JSON.stringify(result, null, 2)); await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${palette ?? theme}-${phase}.png`) }); return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function metadataVisible(value: Evidence) {
  // First business oracle is measured text contrast; no theme-token assertion can replace it.
  for (const measure of value.metadata.measures) {
    expect(measure.ratio ?? 0, measure.key).toBeGreaterThanOrEqual(4.5)
    expect(measure.fontSize, measure.key).toBeGreaterThanOrEqual(10)
    expect(measure, measure.key).toMatchObject({ known: true, opacity: '1', wholeBoxVisible: true, fullTextVisible: true, centerHit: true })
    expect(measure.text).toBe(measure.expected); expect(measure.scrollWidth).toBeLessThanOrEqual(measure.clientWidth + 1)
  }
}
function invariant(value: Evidence, width: number, kind: 'parent' | 'child') {
  expect(value.windows).toHaveLength(1); const window = value.windows[0]
  expect(window.bounds).toMatchObject({ width, height: 800 }); expect(window.minimumSize).toEqual([760, 760]); expect(value.metadata.viewport).toEqual(window.contentSize)
  expect(window.contentSize).toEqual([window.contentBounds.width, window.contentBounds.height]); expect(value.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(value.probe).toEqual({ requests: [], writes: [], failures: [] }); expect(value.stored).toEqual(value.before)
  expect(value.metadata).toMatchObject({ theme: value.theme, palette: value.palette, colorScheme: value.theme, title: titles[kind], horizontalOverflow: false, selected: { title: titles[kind], selected: 'true' } })
  expect(value.metadata.body.find(row => row.id === `sidebar-metadata-${kind}`)?.text).toContain(bodies[kind])
}
function completeLongTitle(value: Evidence) {
  expect(value.metadata.longTitle).toMatchObject({ text: titles.child, rowName: titles.child, textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  expect(value.metadata.longTitle!.scrollWidth).toBeGreaterThan(value.metadata.longTitle!.clientWidth)
}
for (const { language, theme, palette } of cases) test(`Sidebar metadata remains readable in ${language} ${palette ?? theme} @electron`, async ({}, info) => {
  test.setTimeout(120000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ app, page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const ids = await page.evaluate(async ({ language, theme, titles, bodies }) => {
      const parent = await window.knowbook.createDocument(null); await window.knowbook.updateDocument(parent.id, { title: titles.parent, summary: 'Original sidebar root summary.',
        blocks: [{ id: 'sidebar-metadata-parent', type: 'paragraph', content: bodies.parent, checked: false, depth: 0 }] })
      const child = await window.knowbook.createDocument(parent.id); await window.knowbook.updateDocument(child.id, { title: titles.child, summary: 'Original sidebar child summary.',
        blocks: [{ id: 'sidebar-metadata-child', type: 'paragraph', content: bodies.child, checked: false, depth: 0 }] })
      await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme); return { parent: parent.id, child: child.id }
    }, { language, theme, titles, bodies })
    await page.reload(); await resize(page, app, 1360); if (palette) await paletteSetup(page, palette, theme)
    await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click(); const before = await readStored(page)
    await expect.poll(async () => { const title = await page.locator('.document-header-title').textContent(); return before.catalog.some(document => document.title === title) }).toBe(true)
    const parent = page.getByRole('treeitem', { name: titles.parent, exact: true }), child = page.getByRole('treeitem', { name: titles.child, exact: true })
    const search = page.locator('.sidebar-search-button'), parentDate = parent.locator('.tree-button > small'), childDate = child.locator('.tree-button > small')
    const ready = async (kind: 'parent' | 'child') => { await expect(page.locator('.document-header-title')).toHaveText(titles[kind])
      const toggle = page.locator('.document-view-toggle'); if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
      await expect(page.locator(`[data-block-id="sidebar-metadata-${kind}"]`)).toContainText(bodies[kind]); await settle(page) }
    await parent.locator('.tree-button').click(); await ready('parent'); await installProbe(app); await away(page); await dateReady(parentDate)
    const capture = (phase: string, kind: 'parent' | 'child', hover = false, interaction: unknown = null) => record(page, app, info, language, theme, palette, before, phase, titles[kind], hover ? titles.child : null, interaction)
    const first = await capture('wide-selected-root-before-first-metadata-contrast-oracle', 'parent'); metadataVisible(first); invariant(first, 1360, 'parent')
    expect(first.metadata.hovered.selected).toBe(false); expect(before.catalog.find(document => document.id === ids.child)?.parentId).toBe(ids.parent)
    const parentNode = await parent.elementHandle(); if (!parentNode) throw new Error('The selected tree row must exist.')
    await pointAt(page, child.locator('.tree-button')); await dateReady(childDate)
    const longWide = await capture('wide-hovered-unselected-long-child', 'parent', true); metadataVisible(longWide); invariant(longWide, 1360, 'parent'); completeLongTitle(longWide)
    expect(longWide.metadata.hovered.child).toBe(true); await expect(child).toHaveAttribute('aria-selected', 'false')
    await pointAt(page, search); const searchWide = await capture('wide-hovered-search-shortcut', 'parent'); metadataVisible(searchWide); invariant(searchWide, 1360, 'parent'); expect(searchWide.metadata.hovered.search).toBe(true)
    await resize(page, app, 760); await away(page); const narrow = await capture('native-narrow-same-selected-root-node', 'parent'); metadataVisible(narrow); invariant(narrow, 760, 'parent')
    expect(await parent.evaluate((element, original) => element === original, parentNode)).toBe(true); await parentNode.dispose()
    await pointAt(page, child.locator('.tree-button')); await dateReady(childDate)
    const longNarrow = await capture('narrow-hovered-unselected-long-child', 'parent', true); metadataVisible(longNarrow); invariant(longNarrow, 760, 'parent'); completeLongTitle(longNarrow)
    await pointAt(page, search); const searchNarrow = await capture('narrow-hovered-search-shortcut', 'parent'); metadataVisible(searchNarrow); invariant(searchNarrow, 760, 'parent'); expect(searchNarrow.metadata.hovered.search).toBe(true)
    await away(page); await tabTo(page, search, true); await page.keyboard.press('Tab'); await tabTo(page, parent); await expect(parent).toBeFocused(); await expect(parent).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowRight'); await expect(child).toBeFocused(); await page.keyboard.press('Enter'); await ready('child'); await dateReady(childDate)
    const opened = await capture('narrow-real-roving-tab-arrow-right-enter-child', 'child'); metadataVisible(opened); invariant(opened, 760, 'child'); completeLongTitle(opened); expect(opened.metadata.selected?.focused).toBe(true)
    const childNode = await child.elementHandle(); if (!childNode) throw new Error('The focused child tree row must exist.')
    await resize(page, app, 1360); await away(page); const returned = await capture('native-wide-same-focused-child-treeitem', 'child'); metadataVisible(returned); invariant(returned, 1360, 'child')
    expect(returned.metadata.selected?.focused).toBe(true); expect(await child.evaluate((element, original) => element === original, childNode)).toBe(true); await childNode.dispose()
    await tabTo(page, search, true); await page.keyboard.press('Enter'); const input = page.locator('.global-search-input'); await expect(input).toBeFocused()
    await page.keyboard.type('Sidebar metadata'); const interaction = await input.evaluate(element => ({ inputFocused: document.activeElement === element, query: (element as HTMLInputElement).value, dialogOpen: Boolean(element.closest('dialog[open]')) }))
    expect(interaction).toEqual({ inputFocused: true, query: 'Sidebar metadata', dialogOpen: true })
    await page.keyboard.press('Escape'); await expect(page.locator('.global-search-modal')).toHaveCount(0); await expect(search).toBeFocused(); await settle(page)
    const dismissed = await capture('real-tab-enter-search-escape-returns-stable-trigger', 'child', false, interaction); metadataVisible(dismissed); invariant(dismissed, 1360, 'child')
    expect(dismissed.metadata.active.className).toBe('sidebar-search-button'); expect(await readStored(page)).toEqual(before); expect(errors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
