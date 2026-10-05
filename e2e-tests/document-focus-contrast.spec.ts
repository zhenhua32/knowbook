import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Theme = 'light' | 'dark'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __documentFocusContrastProbe?: Probe }
const names = { owner: 'Focus contrast original', target: 'Focus contrast target' }
const bodies = { owner: 'Original focus body retained.', target: 'Exact original focus target body.' }
const summary = 'Original focus summary retained.'
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
    element.getBoundingClientRect(); return element.getAnimations().filter(animation => animation.playState === 'running' || animation.pending).length
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
  for (let step = 0; step < 80; step++) { if (await target.evaluate(element => document.activeElement === element)) return; await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab') }
  await expect(target).toBeFocused()
}
async function ready(page: Page, kind: 'owner' | 'target') {
  await expect(page.locator('.document-header-title')).toHaveText(names[kind])
  const reading = page.locator('.document-view-toggle'); if (await reading.getAttribute('aria-pressed') !== 'true') await reading.click()
  await expect(page.locator(`[data-block-id="focus-contrast-${kind}"]`)).toContainText(bodies[kind]); await settle(page)
}
async function owner(page: Page) {
  const tree = page.locator('.tree-button').filter({ has: page.getByText(names.owner, { exact: true }) })
  await expect(tree).toHaveCount(1); await tree.click(); await ready(page, 'owner')
}
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
    const probe: Probe = { requests: [], writes: [], failures: [] }; (globalThis as ProbeGlobal).__documentFocusContrastProbe = probe
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
  before: Awaited<ReturnType<typeof readStored>>, phase: string, target: Locator) {
  const control = await target.evaluate(element => {
    const rgba = (raw: string): number[] | null => {
      const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i, srgb = raw.match(/^color\(srgb\s+([^/]+?)(?:\s*\/\s*([^/]+?))?\)$/)
      if (srgb) {
        const parts = srgb[1].trim().split(/\s+/); if (parts.length !== 3) return null; parts.push(srgb[2]?.trim() ?? '1'); if (!parts.every(part => numeric.test(part))) return null
        const values = parts.map(part => Number(part.replace(/%$/, '')) * (part.endsWith('%') ? .01 : 1))
        return values.every(value => Number.isFinite(value) && value >= 0 && value <= 1) ? values.map((value, index) => index < 3 ? value * 255 : value) : null
      }
      const match = raw.match(/^rgba?\((.+)\)$/); if (!match) return null; const split = match[1].trim().split(/\s*\/\s*/); if (split.length > 2 || (split.length === 2 && split[0].includes(','))) return null
      const parts = split[0].includes(',') ? split[0].split(',').map(part => part.trim()) : split[0].split(/\s+/)
      if (split.length === 2) { if (parts.length !== 3) return null; parts.push(split[1]) }
      else if (!split[0].includes(',') && parts.length !== 3) return null
      if (parts.length === 3) parts.push('1'); if (parts.length !== 4 || !parts.every(part => numeric.test(part))) return null
      const values = parts.map((part, index) => Number(part.replace(/%$/, '')) * (part.endsWith('%') ? (index === 3 ? .01 : 2.55) : 1))
      return values.every((value, index) => Number.isFinite(value) && value >= 0 && value <= (index === 3 ? 1 : 255)) ? values : null
    }
    const over = (front: number[], back: number[]) => { const alpha = front[3] + back[3] * (1 - front[3])
      return [...front.slice(0, 3).map((channel, index) => (channel * front[3] + back[index] * back[3] * (1 - front[3])) / alpha), alpha] }
    const luminance = (color: number[]) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0)
    const css = getComputedStyle(element), box = element.getBoundingClientRect(), ancestors: HTMLElement[] = []
    const containsPoint = (rect: DOMRect, point: { x: number; y: number }) => rect.width > 0 && rect.height > 0 && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
    const positions = (distance: number) => [ { side: 'top', x: box.left + box.width / 2, y: box.top - distance }, { side: 'right', x: box.right + distance, y: box.top + box.height / 2 },
      { side: 'bottom', x: box.left + box.width / 2, y: box.bottom + distance }, { side: 'left', x: box.left - distance, y: box.top + box.height / 2 } ]
    const opaqueAt = (style: CSSStyleDeclaration, rect: DOMRect, point: { x: number; y: number }) => {
      const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].flatMap(value => value.split(/\s+/))
      const radius = Math.max(...radii.map(value => parseFloat(value))), borders = [style.borderLeftWidth, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth].map(value => parseFloat(value) || 0)
      return rgba(style.backgroundColor)?.[3] === 1 && style.backgroundImage === 'none' && style.backgroundClip === 'border-box' && containsPoint(rect, point)
        && Number(style.opacity) === 1 && style.filter === 'none' && style.mixBlendMode === 'normal' && style.transform === 'none' && style.clipPath === 'none' && style.maskImage === 'none' && !/\binset\b/.test(style.boxShadow)
        && point.x >= rect.left + borders[0] && point.y >= rect.top + borders[1] && point.x <= rect.right - borders[2] && point.y <= rect.bottom - borders[3]
        && radii.every(value => /^\d+(?:\.\d+)?px$/.test(value)) && ((point.x >= rect.left + radius && point.x <= rect.right - radius) || (point.y >= rect.top + radius && point.y <= rect.bottom - radius))
    }
    const layers: Array<{ tag: string; className: string; background: string; rgba: number[] | null; image: string }> = []
    const effects: Array<{ tag: string; className: string; opacity: string; filter: string; backdropFilter: string; backdropOccluded: boolean; blend: string }> = []
    let baseFound = false, left = 0, top = 0, right = innerWidth, bottom = innerHeight
    // The offset outline lies outside the pill: background compositing starts at the parent.
    for (let node = element.parentElement; node; node = node.parentElement) {
      ancestors.push(node); const style = getComputedStyle(node), rect = node.getBoundingClientRect(), color = rgba(style.backgroundColor)
      effects.push({ tag: node.tagName, className: node.className, opacity: style.opacity, filter: style.filter, backdropFilter: style.backdropFilter,
        backdropOccluded: positions((parseFloat(css.outlineWidth) || 0) + (parseFloat(css.outlineOffset) || 0) + 1).every(point => opaqueAt(style, rect, point)), blend: style.mixBlendMode })
      if (!baseFound) { layers.push({ tag: node.tagName, className: node.className, background: style.backgroundColor, rgba: color, image: style.backgroundImage })
        baseFound = color?.[3] === 1 && style.backgroundImage === 'none' }
      const bl = parseFloat(style.borderLeftWidth) || 0, br = parseFloat(style.borderRightWidth) || 0, bt = parseFloat(style.borderTopWidth) || 0, bb = parseFloat(style.borderBottomWidth) || 0
      const vs = /auto|scroll/.test(style.overflowY) ? Math.max(0, node.offsetWidth - node.clientWidth - Math.round(bl + br)) : 0
      const hs = /auto|scroll/.test(style.overflowX) ? Math.max(0, node.offsetHeight - node.clientHeight - Math.round(bt + bb)) : 0
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, rect.left + bl); right = Math.min(right, rect.right - br - vs) }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, rect.top + bt); bottom = Math.min(bottom, rect.bottom - bb - hs) }
    }
    const selfEffects = { opacity: css.opacity, filter: css.filter, backdropFilter: css.backdropFilter, backdropOccluded: false, blend: css.mixBlendMode }
    const known = baseFound && layers.every(layer => layer.rgba && layer.image === 'none') && [...effects, selfEffects]
      .every(effect => Number(effect.opacity) === 1 && effect.filter === 'none' && (effect.backdropFilter === 'none' || effect.backdropOccluded) && effect.blend === 'normal')
    let background = known ? layers.at(-1)!.rgba : null
    if (background) for (const layer of layers.slice(0, -1).reverse()) background = over(layer.rgba!, background)
    const stroke = rgba(css.outlineColor), effectiveStroke = background && stroke ? over(stroke, background) : null
    const a = effectiveStroke ? luminance(effectiveStroke) : null, b = background ? luminance(background) : null
    const ratio = a !== null && b !== null ? (Math.max(a, b) + .05) / (Math.min(a, b) + .05) : null
    const width = parseFloat(css.outlineWidth) || 0, offset = parseFloat(css.outlineOffset) || 0, extent = width + offset
    // Only known hard shadows wholly inside the outer stroke can leave the outside-adjacent sample unchanged.
    const shadowColor = css.boxShadow.match(/(?:rgba?|color)\([^)]*\)/)?.[0], shadowParts = shadowColor ? css.boxShadow.replace(shadowColor, '').trim().split(/\s+/).map(part => parseFloat(part)) : []
    const shadowExtent = shadowParts.length === 4 ? Math.max(0, Math.abs(shadowParts[0]) + shadowParts[3], Math.abs(shadowParts[1]) + shadowParts[3]) : null
    const shadowKnown = css.boxShadow === 'none' || Boolean(shadowColor && rgba(shadowColor) && !/inset|,/.test(css.boxShadow.replace(shadowColor, ''))
      && shadowParts.every(Number.isFinite) && shadowParts[2] === 0 && shadowExtent !== null && shadowExtent <= extent)
    const localSurface = (hit: HTMLElement | null, point: { x: number; y: number }) => {
      const paints: Array<(typeof layers)[number] & { backgroundClip: string; containsPoint: boolean; box: { left: number; top: number; right: number; bottom: number } }> = []
      const chain: Array<(typeof effects)[number] & { transform: string; clipPath: string; maskImage: string }> = []; let found = false
      for (let node = hit; node; node = node.parentElement) { const style = getComputedStyle(node), color = rgba(style.backgroundColor), rect = node.getBoundingClientRect()
        chain.push({ tag: node.tagName, className: node.className, opacity: style.opacity, filter: style.filter, backdropFilter: style.backdropFilter, backdropOccluded: opaqueAt(style, rect, point), blend: style.mixBlendMode, transform: style.transform, clipPath: style.clipPath, maskImage: style.maskImage })
        if (!found) { paints.push({ tag: node.tagName, className: node.className, background: style.backgroundColor, rgba: color, image: style.backgroundImage,
          backgroundClip: style.backgroundClip, containsPoint: containsPoint(rect, point), box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }); found = color?.[3] === 1 && style.backgroundImage === 'none' } }
      const known = found && paints.every(paint => paint.rgba && paint.image === 'none' && (paint.rgba[3] === 0 || (paint.backgroundClip === 'border-box' && paint.containsPoint)))
        && chain.every(effect => Number(effect.opacity) === 1 && effect.filter === 'none' && (effect.backdropFilter === 'none' || effect.backdropOccluded) && effect.blend === 'normal' && effect.transform === 'none' && effect.clipPath === 'none' && effect.maskImage === 'none')
      let background = known ? paints.at(-1)!.rgba : null
      if (background) for (const paint of paints.slice(0, -1).reverse()) background = over(paint.rgba!, background)
      const effective = background && stroke ? over(stroke, background) : null, a = effective ? luminance(effective) : null, b = background ? luminance(background) : null
      return { layers: paints, effects: chain, known, background, effectiveStroke: effective, ratio: a !== null && b !== null ? (Math.max(a, b) + .05) / (Math.min(a, b) + .05) : null }
    }
    const atomic = 'button,input,textarea,select,a[href],img,svg,canvas,video,iframe,object,embed,[role="button"],[contenteditable="true"],[tabindex]'
    const visibleAt = (node: Element, point: { x: number; y: number }) => { const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && Array.from(node.getClientRects()).some(rect => containsPoint(rect, point)) }
    const branchAt = (hit: HTMLElement | null, point: { x: number; y: number }) => {
      const common = hit ? ancestors.find(ancestor => ancestor === hit || ancestor.contains(hit)) : null
      const branch: Array<{ tag: string; className: string; transparent: boolean; borderAtPoint: boolean; plain: boolean }> = [], branchNodes: HTMLElement[] = []
      for (let node = hit; node && node !== common; node = node.parentElement) { const style = getComputedStyle(node), rect = node.getBoundingClientRect()
        branchNodes.push(node); const widths = ['Left', 'Top', 'Right', 'Bottom'].map(side => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0)
        const borderAtPoint = containsPoint(rect, point) && (point.x < rect.left + widths[0] || point.y < rect.top + widths[1] || point.x > rect.right - widths[2] || point.y > rect.bottom - widths[3])
        branch.push({ tag: node.tagName, className: node.className, transparent: rgba(style.backgroundColor)?.[3] === 0, borderAtPoint,
          plain: style.backgroundImage === 'none' && style.boxShadow === 'none' && (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0)
            && ['::before', '::after'].every(pseudo => ['none', 'normal'].includes(getComputedStyle(node!, pseudo).content)) && !node.matches(atomic) }) }
      let textAtPoint = false, atomicAtPoint = false
      for (const node of branchNodes) { const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        for (let text = walker.nextNode(); text; text = walker.nextNode()) if (text.textContent?.trim() && text.parentElement && getComputedStyle(text.parentElement).display !== 'none' && getComputedStyle(text.parentElement).visibility === 'visible') {
          const range = document.createRange(); range.selectNodeContents(text); if (Array.from(range.getClientRects()).some(rect => containsPoint(rect, point))) textAtPoint = true }
        atomicAtPoint ||= Array.from(node.querySelectorAll(atomic)).some(node => visibleAt(node, point)) }
      return { common: common ? { tag: common.tagName, className: common.className, parentChainIndex: ancestors.indexOf(common) } : null, branch, textAtPoint, atomicAtPoint,
        eligible: Boolean(common && branch.every(node => node.transparent && node.plain && !node.borderAtPoint) && !textAtPoint && !atomicAtPoint) }
    }
    const points = (distance: number) => positions(distance).map(point => { const raw = document.elementFromPoint(point.x, point.y), hit = raw instanceof HTMLElement ? raw : null
        return { ...point, ancestorHit: Boolean(hit && ancestors.includes(hit)), hit: raw ? { tag: raw.tagName, className: String(raw.className) } : null,
          branch: branchAt(hit, point), surface: localSurface(hit, point), withinClip: point.x >= left && point.x <= right && point.y >= top && point.y <= bottom } })
    const center = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return { tag: element.tagName, className: element.className, value: 'value' in element ? String(element.value) : null, text: element.textContent,
      focused: document.activeElement === element, focusVisible: element.matches(':focus-visible'), outline: { color: css.outlineColor, stroke, style: css.outlineStyle, width, offset, extent, ratio, effectiveStroke },
      ownBackground: css.backgroundColor, layers, closestOpaqueBase: layers.at(-1), effects, selfEffects, knownBackground: known, background,
      shadow: { css: css.boxShadow, color: shadowColor, parts: shadowParts, extent: shadowExtent, known: shadowKnown },
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }, clip: { left, top, right, bottom },
      ringFullyVisible: box.width > 0 && box.height > 0 && extent > 0 && box.left - extent >= left - .01 && box.right + extent <= right + .01 && box.top - extent >= top - .01 && box.bottom + extent <= bottom + .01,
      centerHit: center === element || Boolean(center && element.contains(center)), strokePoints: points(offset + width / 2), outsideAdjacentPoints: points(extent + 1) }
  })
  const state = await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme, palette: document.documentElement.getAttribute('data-knowbook-theme-switcher'),
    colorScheme: getComputedStyle(document.documentElement).colorScheme, title: document.querySelector('.document-header-title')?.textContent,
    reading: document.querySelector('.document-view-toggle')?.getAttribute('aria-pressed') === 'true',
    body: Array.from(document.querySelectorAll<HTMLElement>('.preview-panel .document-reading-row, .preview-panel .block-editor-row')).map(row => {
      const input = row.querySelector<HTMLTextAreaElement>('.block-inline-textarea')
      return { blockId: row.dataset.blockId, mode: row.matches('.block-editor-row') ? 'edit' : 'read', inputValue: input?.value ?? null, text: input ? input.value : row.textContent }
    }),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }))
  const main = await app.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(), contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(),
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })), probe: (globalThis as ProbeGlobal).__documentFocusContrastProbe! }))
  const result = { language, theme, palette, phase, control, state, ...main, before, stored: await readStored(page) }
  const path = info.outputPath(`${language}-${palette ?? theme}-${phase}.json`); writeFileSync(path, JSON.stringify(result, null, 2)); await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${palette ?? theme}-${phase}.png`) }); return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function invariant(value: Evidence, width: number, kind: 'owner' | 'target') {
  expect(value.windows).toHaveLength(1); const window = value.windows[0]
  expect(window.bounds).toMatchObject({ width, height: 800 }); expect(window.minimumSize).toEqual([760, 760]); expect(value.state.viewport).toEqual(window.contentSize)
  expect(window.contentSize).toEqual([window.contentBounds.width, window.contentBounds.height]); expect(value.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(value.probe).toEqual({ requests: [], writes: [], failures: [] }); expect(value.stored).toEqual(value.before)
  expect(value.state).toMatchObject({ theme: value.theme, palette: value.palette, colorScheme: value.theme, title: names[kind], horizontalOverflow: false })
  const editing = /^(metadata-|move-)/.test(value.phase), body = value.state.body.find(row => row.blockId === `focus-contrast-${kind}`)
  expect(value.state.reading).toBe(!editing); expect(body?.mode).toBe(editing ? 'edit' : 'read'); expect(body?.text).toContain(bodies[kind])
  if (editing) expect(body?.inputValue).toBe(`${bodies.owner} [[${names.target}]]`)
}
function ring(value: Evidence) {
  // First business oracle uses the outline's actual composite against the outside parent surface, not the pill.
  expect(value.control.outline.ratio ?? 0).toBeGreaterThanOrEqual(3)
  expect(value.control).toMatchObject({ focused: true, focusVisible: true, knownBackground: true, ringFullyVisible: true, centerHit: true })
  expect(value.control.outline).toMatchObject({ style: 'solid', width: 2, offset: 2 }); expect(value.control.shadow.known).toBe(true)
  for (const point of [...value.control.strokePoints, ...value.control.outsideAdjacentPoints]) {
    expect(point).toMatchObject({ withinClip: true, branch: { eligible: true }, surface: { known: true } }); expect(point.surface.ratio ?? 0).toBeGreaterThanOrEqual(3)
  }
}
for (const { language, theme, palette } of cases) test(`Document keyboard focus remains visible in ${language} ${palette ?? theme} @electron`, async ({}, info) => {
  test.setTimeout(120000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ app, page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const ids = await page.evaluate(async ({ language, theme, names, bodies, summary }) => {
      const ids: Record<string, string> = {}
      for (const kind of ['target', 'owner'] as const) { const document = await window.knowbook.createDocument(null); ids[kind] = document.id
        await window.knowbook.updateDocument(document.id, { title: names[kind], summary, blocks: [{ id: `focus-contrast-${kind}`, type: 'paragraph', checked: false, depth: 0,
          content: kind === 'owner' ? `${bodies.owner} [[${names.target}]]` : bodies.target }] }) }
      await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme); return ids
    }, { language, theme, names, bodies, summary })
    await page.reload(); await resize(page, app, 1360); if (palette) await paletteSetup(page, palette, theme)
    await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click(); const before = await readStored(page)
    await expect.poll(async () => {
      const title = await page.locator('.document-header-title').textContent(); return before.catalog.some(document => document.title === title)
    }).toBe(true)
    await owner(page); await installProbe(app)
    const capture = (phase: string, target: Locator) => record(page, app, info, language, theme, palette, before, phase, target)
    const inline = page.locator('[data-block-id="focus-contrast-owner"] .inline-link'); await expect(inline).toHaveCount(1)
    await tabTo(page, inline); await settle(page); const first = await capture('inline-real-tab-before-first-focus-contrast-oracle', inline)
    ring(first); invariant(first, 1360, 'owner')
    const original = await inline.elementHandle(); if (!original) throw new Error('The focused inline link must exist.')
    await resize(page, app, 760); const narrow = await capture('native-narrow-same-focused-inline-node', inline); ring(narrow); invariant(narrow, 760, 'owner')
    expect(await inline.evaluate((element, previous) => element === previous, original)).toBe(true)
    await resize(page, app, 1360); const restored = await capture('native-wide-same-focused-inline-node', inline); ring(restored); invariant(restored, 1360, 'owner')
    expect(await inline.evaluate((element, previous) => element === previous, original)).toBe(true); await original.dispose()
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await settle(page)
    const reversed = await capture('inline-real-reverse-tab-restores-same-control', inline); ring(reversed); invariant(reversed, 1360, 'owner')
    await page.keyboard.press('Enter'); await ready(page, 'target')
    const targetReading = page.locator('.document-view-toggle'); await tabTo(page, targetReading); await settle(page)
    const navigated = await capture('real-inline-enter-opens-exact-stored-target', targetReading); invariant(navigated, 1360, 'target')
    expect(navigated.before.documents.find(document => document?.id === ids.target)?.blocks[0].id).toBe('focus-contrast-target')
    await owner(page); const editToggle = page.locator('.document-view-toggle'); await tabTo(page, editToggle); await page.keyboard.press('Enter')
    await expect(editToggle).toHaveAttribute('aria-pressed', 'false')
    const title = page.locator('.document-summary-card .document-title-input'); await expect(title).toBeVisible(); await tabTo(page, title); await settle(page)
    const input = await capture('metadata-title-real-tab-focus', title); ring(input); invariant(input, 1360, 'owner'); expect(input.control.value).toBe(names.owner)
    const properties = page.locator('.document-summary-edit-button'); await tabTo(page, properties); await page.keyboard.press('Enter')
    const textarea = page.locator('.document-summary-card .editor-textarea'); await expect(textarea).toBeVisible()
    // Opening autofocus is not our oracle: leave it and genuinely Tab back to the textarea.
    await page.keyboard.press('Shift+Tab'); await tabTo(page, textarea); await settle(page)
    const area = await capture('metadata-summary-real-tab-focus', textarea); ring(area); invariant(area, 1360, 'owner'); expect(area.control.value).toBe(summary)
    await page.keyboard.press('Escape'); await expect(textarea).toHaveCount(0); await expect(properties).toBeFocused()
    const more = page.locator('.document-header-more-button'); await tabTo(page, more, true); await page.keyboard.press('Enter')
    const select = page.locator('.document-header-action-menu .document-header-menu-select'); await expect(select).toBeVisible(); await tabTo(page, select); await settle(page)
    const moved = await capture('move-select-real-tab-focus-no-native-dropdown', select); ring(moved); invariant(moved, 1360, 'owner'); expect(moved.control.value).toBe('')
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await settle(page)
    const selectReverse = await capture('move-select-real-reverse-tab-return', select); ring(selectReverse); invariant(selectReverse, 1360, 'owner'); expect(selectReverse.control.value).toBe('')
    await page.keyboard.press('Escape'); await expect(page.locator('.document-header-action-menu')).toHaveCount(0); await expect(more).toBeFocused()
    expect(await readStored(page)).toEqual(before); expect(errors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
