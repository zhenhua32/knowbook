import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Theme = 'light' | 'dark'
type Kind = 'owner' | 'wiki' | 'local'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; external: unknown[][]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __inlineLinkThemeProbe?: Probe }
const names = { owner: 'Inline link theme original', wiki: 'Inline wiki target', local: 'Inline markdown target' }
const bodies = { owner: 'Inline original body retained.', wiki: 'Exact original wiki target body.', local: 'Exact original local Markdown target body.' }
const href = 'Inline%20markdown%20target.md', external = 'https://example.invalid/inline-link-display', anchor = '#inline-reading-section'
const captions = [names.wiki, 'Local target', 'External display', 'Section anchor']
const cases: Array<{ language: Language; theme: Theme; palette: string | null }> = [
  ...(['en-US', 'zh-CN'] as const).flatMap(language => (['light', 'dark'] as const).map(theme => ({ language, theme, palette: null }))),
  ...(['cloud', 'paper', 'moss'] as const).map(palette => ({ language: 'en-US' as const, theme: 'light' as const, palette })),
  ...(['bay', 'midnight', 'violet'] as const).map(palette => ({ language: 'en-US' as const, theme: 'dark' as const, palette }))
]

async function selectPalette(page: Page, palette: string, theme: Theme) {
  await expect.poll(async () => {
    const plugin = (await page.evaluate(() => window.knowbook.listSystemPlugins())).find(plugin => plugin.pluginId === 'theme-switcher')
    return plugin?.status === 'active' && plugin.runtimeStatus === 'active'
  }).toBe(true)
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Appearance', '外观') }).click()
  await expect(page.getByTestId('theme-switcher-settings')).toBeVisible()
  await page.getByTestId(`theme-option-${palette}`).click()
  await expect(page.getByTestId(`theme-option-${palette}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', palette)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme)
  await expect.poll(() => page.evaluate(async () => {
    const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')
    if (!plugin?.currentArtifactSha256) throw new Error('The active built-in palette must have an installed artifact.')
    return window.knowbook.invokeSystemPluginMain({ pluginId: 'theme-switcher', revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'get-state' })
  })).toMatchObject({ selectedThemeId: palette })
}

async function settle(page: Page) {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => {
    element.getBoundingClientRect()
    return element.getAnimations().filter(animation => animation.playState === 'running' || animation.pending).length
  })).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function resize(page: Page, app: ElectronApplication, width: number) {
  const size = await app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ width, height: 800 }); return window.getContentSize()
  }, width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size); await settle(page)
}
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 80; step++) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}
function link(page: Page, index: number) { return page.locator('[data-block-id="inline-theme-owner"] .inline-link').filter({ hasText: captions[index] }) }
async function ready(page: Page, kind: Kind) {
  await expect(page.locator('.document-header-title')).toHaveText(names[kind])
  const reading = page.locator('.document-view-toggle')
  if (await reading.getAttribute('aria-pressed') !== 'true') await reading.click()
  await expect(page.locator(`[data-block-id="inline-theme-${kind}"]`)).toContainText(bodies[kind]); await settle(page)
}
async function openOwner(page: Page) {
  const tree = page.locator('.tree-button').filter({ has: page.getByText(names.owner, { exact: true }) })
  await expect(tree).toHaveCount(1); await tree.click(); await ready(page, 'owner')
  await expect(page.locator('[data-block-id="inline-theme-owner"] .inline-link')).toHaveCount(4)
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
    const probe: Probe = { requests: [], writes: [], external: [], failures: [] }
    ;(globalThis as ProbeGlobal).__inlineLinkThemeProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (channel === 'knowbook:open-external-url') {
        ipcMain.removeHandler(channel)
        // An accidental activation is recorded and blocked before any OS action.
        ipcMain.handle(channel, (_event, ...input: unknown[]) => { probe.external.push(structuredClone(input)); throw new Error('External links are display-only in this fixture.') })
      } else if (/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (event, ...input: unknown[]) => {
          const request = { channel, input: structuredClone(input) }; probe.requests.push(request)
          try { const result = await original(event, ...input); probe.writes.push(request); return result }
          catch (error) { probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) }); throw error }
        })
      }
    }
  })
}
async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, theme: Theme,
  palette: string | null, before: Awaited<ReturnType<typeof readStored>>, phase: string) {
  const state = await page.evaluate(() => {
    const rgba = (raw: string): number[] | null => {
      const match = raw.match(/^rgba?\((.+)\)$/)
      if (!match) return null
      const values = match[1].split(/[\s,/]+/).filter(Boolean).map((part, index) => parseFloat(part) * (part.endsWith('%') ? (index === 3 ? .01 : 2.55) : 1))
      if (values.length === 3) values.push(1)
      return values.length === 4 && values.every(Number.isFinite) ? values : null
    }
    const over = (front: number[], back: number[]) => {
      const alpha = front[3] + back[3] * (1 - front[3])
      return [...front.slice(0, 3).map((channel, index) => (channel * front[3] + back[index] * back[3] * (1 - front[3])) / alpha), alpha]
    }
    const luminance = (color: number[]) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0)
    const links = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-block-id="inline-theme-owner"] .inline-link')).map(element => {
      const css = getComputedStyle(element), box = element.getBoundingClientRect()
      const layers: Array<{ tag: string; className: string; background: string; rgba: number[] | null; image: string; opacity: string; filter: string; backdropFilter: string }> = []
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node), color = rgba(style.backgroundColor)
        layers.push({ tag: node.tagName, className: node.className, background: style.backgroundColor, rgba: color,
          image: style.backgroundImage, opacity: style.opacity, filter: style.filter, backdropFilter: style.backdropFilter })
        if (node !== element && color?.[3] === 1 && style.backgroundImage === 'none') break
      }
      const base = layers.at(-1)!, foreground = rgba(css.color)
      const known = base.rgba?.[3] === 1 && layers.every(layer => layer.rgba && layer.image === 'none' && Number(layer.opacity) === 1
        && layer.filter === 'none' && layer.backdropFilter === 'none') && Boolean(foreground)
      let background: number[] | null = known ? base.rgba : null
      if (background) for (const layer of layers.slice(0, -1).reverse()) background = over(layer.rgba!, background)
      const effectiveForeground = background && foreground ? over(foreground, background) : null
      const a = effectiveForeground ? luminance(effectiveForeground) : null, b = background ? luminance(background) : null
      const contrast = a !== null && b !== null ? (Math.max(a, b) + .05) / (Math.min(a, b) + .05) : null
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect()
        const bl = parseFloat(style.borderLeftWidth) || 0, br = parseFloat(style.borderRightWidth) || 0
        const bt = parseFloat(style.borderTopWidth) || 0, bb = parseFloat(style.borderBottomWidth) || 0
        const vs = /auto|scroll/.test(style.overflowY) ? Math.max(0, node.offsetWidth - node.clientWidth - Math.round(bl + br)) : 0
        const hs = /auto|scroll/.test(style.overflowX) ? Math.max(0, node.offsetHeight - node.clientHeight - Math.round(bt + bb)) : 0
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, rect.left + bl); right = Math.min(right, rect.right - br - vs) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, rect.top + bt); bottom = Math.min(bottom, rect.bottom - bb - hs) }
        if (style.position === 'fixed') break
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { text: element.textContent, title: element.title, color: css.color, foreground, backgroundColor: css.backgroundColor,
        layers, closestOpaqueBase: base, knownBackground: known, background, effectiveForeground, contrast,
        fontSize: parseFloat(css.fontSize), fontWeight: css.fontWeight, radius: css.borderRadius, padding: css.padding,
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }, clip: { left, top, right, bottom },
        fullyVisible: box.width > 0 && box.height > 0 && box.left >= left - .01 && box.right <= right + .01 && box.top >= top - .01 && box.bottom <= bottom + .01,
        centerHit: hit === element || Boolean(hit && element.contains(hit)), focused: document.activeElement === element,
        focusVisible: element.matches(':focus-visible'), hovered: element.matches(':hover') }
    })
    return { viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme,
      palette: document.documentElement.getAttribute('data-knowbook-theme-switcher'), colorScheme: getComputedStyle(document.documentElement).colorScheme,
      title: document.querySelector('.document-header-title')?.textContent,
      body: Array.from(document.querySelectorAll<HTMLElement>('.preview-panel .document-reading-row')).map(row => ({ blockId: row.dataset.blockId, text: row.textContent })), links,
      tokens: { strong: getComputedStyle(document.documentElement).getPropertyValue('--kb-accent-strong').trim(), soft: getComputedStyle(document.documentElement).getPropertyValue('--kb-accent-soft').trim() },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
  })
  const main = await app.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(),
    contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
    probe: (globalThis as ProbeGlobal).__inlineLinkThemeProbe! }))
  const result = { language, theme, palette, phase, state, ...main, before, stored: await readStored(page) }
  const path = info.outputPath(`${language}-${palette ?? theme}-${phase}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2)); await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${palette ?? theme}-${phase}.png`) }); return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function invariant(result: Evidence, width: number, kind: Kind) {
  expect(result.windows).toHaveLength(1); const window = result.windows[0]
  expect(window.bounds).toMatchObject({ width, height: 800 }); expect(window.minimumSize).toEqual([760, 760])
  expect(result.state.viewport).toEqual(window.contentSize); expect(window.contentSize).toEqual([window.contentBounds.width, window.contentBounds.height])
  expect(result.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(result.probe).toEqual({ requests: [], writes: [], external: [], failures: [] }); expect(result.stored).toEqual(result.before)
  expect(result.state.theme).toBe(result.theme); expect(result.state.palette).toBe(result.palette); expect(result.state.colorScheme).toBe(result.theme)
  expect(result.state.title).toBe(names[kind]); expect(result.state.horizontalOverflow).toBe(false)
  expect(result.state.body.find(row => row.blockId === `inline-theme-${kind}`)?.text).toContain(bodies[kind])
}
function contrast(result: Evidence) {
  // First business oracle uses actual computed colors and alpha-composited backgrounds.
  expect(Math.min(...result.state.links.map(link => link.contrast ?? 0))).toBeGreaterThanOrEqual(4.5)
  expect(result.state.links).toHaveLength(4)
  expect(result.state.links.map(link => link.text)).toEqual(captions)
  expect(result.state.links.map(link => link.title)).toEqual([names.wiki, href, external, anchor])
  for (const link of result.state.links) { expect(link.knownBackground).toBe(true); expect(link.fullyVisible).toBe(true); expect(link.centerHit).toBe(true) }
}

for (const { language, theme, palette } of cases) {
  test(`Inline document links have readable ${palette ?? theme} contrast in ${language} @electron`, async ({}, info) => {
    test.setTimeout(120000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ app, page }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const ids = await page.evaluate(async ({ language, theme, names, bodies, href, external, anchor }) => {
        const ids: Record<string, string> = {}
        for (const kind of ['wiki', 'local', 'owner'] as const) {
          const document = await window.knowbook.createDocument(null); ids[kind] = document.id
          const paragraph = kind === 'owner' ? `${bodies.owner} [[${names.wiki}]] and [Local target](${href}), [External display](${external}), [Section anchor](${anchor}).` : bodies[kind]
          const blocks = [{ id: `inline-theme-${kind}`, type: 'paragraph', content: paragraph, checked: false, depth: 0 }]
          if (kind === 'owner') blocks.unshift({ id: 'inline-theme-heading', type: 'heading-2', content: 'Inline reading section', checked: false, depth: 0 })
          await window.knowbook.updateDocument(document.id, { title: names[kind], summary: `Original ${kind} summary.`, blocks })
        }
        await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme); return ids
      }, { language, theme, names, bodies, href, external, anchor })
      await page.reload(); await resize(page, app, 1360)
      // Real plugin UI persists the palette before the read-only mutation probe starts.
      if (palette) await selectPalette(page, palette, theme)
      await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click()
      const before = await readStored(page)
      // Wait for the actual initial document before choosing our owner; an old initialization request must not race this click.
      await expect.poll(async () => {
        const title = await page.locator('.document-header-title').textContent()
        return before.catalog.some(document => document.title === title)
      }).toBe(true)
      await openOwner(page); await page.mouse.move(1, 1); await installProbe(app)
      const capture = (phase: string) => record(page, app, info, language, theme, palette, before, phase)
      const normal = await capture('normal-wide-before-first-contrast-business-oracle')
      contrast(normal); invariant(normal, 1360, 'owner')
      for (const [index, caption] of captions.entries()) {
        const target = link(page, index); await expect(target).toHaveCount(1); await target.hover(); await settle(page)
        const hovered = await capture(`link-${index}-real-mouse-hover`); contrast(hovered); invariant(hovered, 1360, 'owner')
        expect(hovered.state.links[index].hovered).toBe(true)
        await page.mouse.move(1, 1); await tabTo(page, target); await settle(page)
        const focused = await capture(`link-${index}-real-tab-focus`); contrast(focused); invariant(focused, 1360, 'owner')
        expect(focused.state.links[index]).toMatchObject({ text: caption, focused: true, focusVisible: true, hovered: false })
        if (index === 1) {
          const original = await target.elementHandle(); if (!original) throw new Error('The focused local link must exist.')
          await resize(page, app, 760); const narrow = await capture('native-narrow-keeps-same-focused-local-link')
          contrast(narrow); invariant(narrow, 760, 'owner'); expect(narrow.state.links[index].focused).toBe(true)
          expect(await target.evaluate((element, previous) => element === previous, original)).toBe(true)
          await resize(page, app, 1360); const restored = await capture('native-wide-restores-same-focused-local-link')
          contrast(restored); invariant(restored, 1360, 'owner'); expect(restored.state.links[index].focused).toBe(true)
          expect(await target.evaluate((element, previous) => element === previous, original)).toBe(true); await original.dispose()
        }
      }
      await tabTo(page, link(page, 0)); await page.keyboard.press('Enter'); await ready(page, 'wiki')
      const wiki = await capture('real-wiki-enter-opens-exact-original-target'); invariant(wiki, 1360, 'wiki')
      expect(wiki.before.documents.find(document => document?.id === ids.wiki)?.blocks[0].id).toBe('inline-theme-wiki')
      await openOwner(page); await link(page, 1).click(); await ready(page, 'local')
      const local = await capture('real-markdown-pointer-opens-exact-original-target'); invariant(local, 1360, 'local')
      expect(local.before.documents.find(document => document?.id === ids.local)?.blocks[0].id).toBe('inline-theme-local')
      await openOwner(page); await link(page, 3).click(); await ready(page, 'owner')
      await expect(page.locator('[data-block-id="inline-theme-heading"]')).toContainText('Inline reading section')
      const heading = await capture('real-local-heading-anchor-keeps-original-document'); invariant(heading, 1360, 'owner')
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
