import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type AiState = 'disabled' | 'key-needed' | 'configured'
type Counts = { documents: number; blocks: number; links: number }
type Rectangle = { left: number; top: number; right: number; bottom: number; width: number; height: number }

const states: AiState[] = ['disabled', 'key-needed', 'configured']
const labels = { 'en-US': ['Documents', 'Blocks', 'Links', 'AI'], 'zh-CN': ['文档数', '块数', '链接数', 'AI'] }
const statusLabels = { 'en-US': ['Disabled', 'API key needed', 'Configured'], 'zh-CN': ['未启用', '待配置密钥', '已配置'] }

async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function openDashboard(page: Page): Promise<void> {
  await page.locator('[data-page-id="dashboard"]').click()
  await expect(page.locator('.page-dashboard > .stats-grid')).toBeVisible()
  await page.locator('.page-dashboard').evaluate(element => { element.scrollTop = 0 })
  await settle(page)
}

async function configureAi(page: Page, state: AiState, language: Language): Promise<Counts> {
  const home = await page.evaluate(async state => {
    const input = { enabled: state !== 'disabled', baseUrl: 'http://127.0.0.1:9/v1', model: 'dashboard-layout-fixture',
      autoSummaryOnSave: false, relatedNotesEnabled: false }
    await window.knowbook.updateAiConfig({ ...input, ...(state === 'configured' ? { apiKey: 'dashboard-layout-fixture-key' } : {}) })
    // The clear-key action intentionally preserves non-key settings. Save the
    // requested enabled state first so the fixture exercises three real states.
    if (state !== 'configured') await window.knowbook.updateAiConfig({ ...input, clearApiKey: true })
    const { aiConfig, summary } = await window.knowbook.getHomeData()
    return { aiConfig, counts: { documents: summary.documents, blocks: summary.blocks, links: summary.links } }
  }, state)
  expect(home.aiConfig).toMatchObject({ enabled: state !== 'disabled', hasApiKey: state === 'configured',
    autoSummaryOnSave: false, relatedNotesEnabled: false, baseUrl: 'http://127.0.0.1:9/v1' })
  await page.reload()
  await openDashboard(page)
  await expect(page.locator('.page-dashboard > .stats-grid > .stat-card').last().locator('strong'))
    .toHaveText(statusLabels[language][states.indexOf(state)])
  return home.counts
}

async function setNativeSize(app: ElectronApplication, page: Page, width: number): Promise<void> {
  // These are ordinary product windows. Keep the native minimum size unchanged
  // and never replace the native content viewport with browser emulation.
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 760])
  await settle(page)
}

async function setSidebarCollapsed(page: Page, collapsed: boolean): Promise<void> {
  if (await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed')) !== collapsed) {
    await page.locator('.rail-toggle-btn').click()
    await settle(page)
  }
  expect(await page.locator('.sidebar-workspace-navigation').evaluate(element => element.classList.contains('collapsed'))).toBe(collapsed)
}

function expectInside(child: Rectangle, parent: Rectangle, message: string): void {
  expect(child.width, `${message} has real width`).toBeGreaterThan(0)
  expect(child.height, `${message} has real height`).toBeGreaterThan(0)
  expect(child.left, `${message} left edge`).toBeGreaterThanOrEqual(parent.left - 1)
  expect(child.top, `${message} top edge`).toBeGreaterThanOrEqual(parent.top - 1)
  expect(child.right, `${message} right edge`).toBeLessThanOrEqual(parent.right + 1)
  expect(child.bottom, `${message} bottom edge`).toBeLessThanOrEqual(parent.bottom + 1)
}

async function verifyMetrics(page: Page, app: ElectronApplication, tempRoot: string, info: TestInfo, phase: string,
  language: Language, state: AiState, width: number, counts: Counts) {
  const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'),
    windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), size: window.getSize(),
      content: window.getContentSize(), minimum: window.getMinimumSize(), visible: window.isVisible(),
      focused: window.isFocused(), focusable: window.isFocusable() })) }))
  const layout = await page.locator('.page-dashboard > .stats-grid').evaluate(grid => {
    const rectangle = (element: Element): Rectangle => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
      return { left, top, right, bottom, width, height }
    }
    const rgba = (color: string) => {
      const values = color.match(/[\d.]+/g)!.map(Number)
      return [values[0], values[1], values[2], values[3] ?? 1]
    }
    const luminance = (color: number[]) => {
      const [r, g, b] = color.slice(0, 3).map(channel => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const text = (element: Element) => {
      const css = getComputedStyle(element), range = document.createRange()
      range.selectNodeContents(element)
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      const ancestors: Element[] = []
      for (let current: Element | null = element; current; current = current.parentElement) {
        ancestors.push(current)
        const style = getComputedStyle(current), bounds = current.getBoundingClientRect()
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          left = Math.max(left, bounds.left + current.clientLeft)
          right = Math.min(right, bounds.left + current.clientLeft + current.clientWidth)
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          top = Math.max(top, bounds.top + current.clientTop)
          bottom = Math.min(bottom, bounds.top + current.clientTop + current.clientHeight)
        }
      }
      let background = [255, 255, 255]
      for (const ancestor of ancestors.reverse()) {
        const color = rgba(getComputedStyle(ancestor).backgroundColor)
        background = color.slice(0, 3).map((channel, index) => channel * color[3] + background[index] * (1 - color[3]))
      }
      const foreground = luminance(rgba(css.color)), behind = luminance(background)
      return { text: element.textContent, box: rectangle(element), rectangles: Array.from(range.getClientRects(), box => ({
        left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height })),
        fontSize: css.fontSize, lineHeight: css.lineHeight, textOverflow: css.textOverflow, fontVariantNumeric: css.fontVariantNumeric,
        clip: { left, top, right, bottom, width: right - left, height: bottom - top },
        contrast: (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05) }
    }
    const content = grid.closest<HTMLElement>('.content')!
    return { inner: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme,
      palette: document.documentElement.getAttribute('data-knowbook-theme-switcher'), grid: rectangle(grid),
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
      content: rectangle(content), horizontalOverflow: content.scrollWidth - content.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      hero: rectangle(content.querySelector(':scope > .hero')!), detail: rectangle(content.querySelector(':scope > .detail-grid')!),
      cards: Array.from(grid.children).map(card => ({ box: rectangle(card), label: text(card.querySelector('.stat-label')!), value: text(card.querySelector('strong')!) })) }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, tempRoot, native, layout, counts }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })

  expect(native.userData.toLowerCase()).toBe(tempRoot.toLowerCase())
  expect(native.windows).toHaveLength(1)
  expect(native.windows[0].size).toEqual([native.windows[0].bounds.width, native.windows[0].bounds.height])
  expect(native.windows[0].content).toEqual([width, 760])
  expect(native.windows[0].minimum).toEqual([760, 760])
  expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(layout.inner).toEqual(native.windows[0].content)
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(layout.documentOverflow).toBeLessThanOrEqual(1)
  const columns = width > 1080 ? 4 : 2
  expect(layout.columns).toBe(columns)
  expect(layout.cards).toHaveLength(4)
  expect(layout.grid.height).toBeGreaterThanOrEqual(columns === 4 ? 86 : 184)
  expect(layout.grid.height).toBeLessThanOrEqual(columns === 4 ? 87 : 185)
  expectInside(layout.grid, layout.content, 'metrics grid')
  expect(layout.grid.bottom).toBeLessThanOrEqual(layout.inner[1])
  expect(layout.hero.bottom).toBeLessThanOrEqual(layout.grid.top)
  expect(layout.grid.bottom).toBeLessThanOrEqual(layout.detail.top)
  const values = [String(counts.documents), String(counts.blocks), String(counts.links), statusLabels[language][states.indexOf(state)]]
  for (const [index, card] of layout.cards.entries()) {
    expectInside(card.box, layout.grid, `card ${index}`)
    expect(card.box.height).toBeGreaterThanOrEqual(86)
    expect(card.box.height).toBeLessThanOrEqual(87)
    expect(card.label.text).toBe(labels[language][index])
    expect(card.label.fontSize).toBe('13px')
    expect(card.label.lineHeight).toBe('20px')
    expect(card.value.text).toBe(values[index])
    expect(card.value.fontSize).toBe(index === 3 ? '16px' : '24px')
    expect(card.value.lineHeight).toBe('28px')
    if (index < 3) expect(card.value.fontVariantNumeric).toContain('tabular-nums')
    expect(card.value.contrast, `card ${index} readable value`).toBeGreaterThanOrEqual(4.5)
    expect(card.label.box.bottom).toBeLessThanOrEqual(card.value.box.top)
    for (const [kind, value] of [['label', card.label], ['value', card.value]] as const) {
      expect(value.textOverflow, `card ${index} ${kind} must not replace text with ellipsis`).not.toBe('ellipsis')
      expect(value.rectangles).toHaveLength(1)
      expectInside(value.box, card.box, `card ${index} ${kind} box`)
      for (const box of value.rectangles) {
        // Windows font glyph metrics can exceed a CSS line box without being
        // clipped. Check the actual clipping ancestors and the card boundary.
        expectInside(box, value.clip, `card ${index} complete unclipped ${kind}`)
        expectInside(box, card.box, `card ${index} complete ${kind} inside card`)
        expect(box.left).toBeGreaterThanOrEqual(value.box.left - 1)
        expect(box.right).toBeLessThanOrEqual(value.box.right + 1)
      }
    }
    expect(Math.abs(card.box.top - layout.cards[Math.floor(index / columns) * columns].box.top)).toBeLessThanOrEqual(1)
  }
  return layout
}

for (const language of ['en-US', 'zh-CN'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`dashboard metrics stay compact and complete in native windows ${language} ${theme} @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    test.setTimeout(120_000)
    await withElectronApp(async ({ page, app, tempRoot }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async ({ language, theme }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', theme)
      }, { language, theme })
      let expectedCounts: Counts | undefined
      for (const state of states) {
        const counts = await configureAi(page, state, language)
        if (expectedCounts) expect(counts).toEqual(expectedCounts)
        expectedCounts = counts
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(page.locator('html')).not.toHaveAttribute('data-knowbook-theme-switcher')
        await setSidebarCollapsed(page, false)
        for (const width of [1440, 1081, 1080, 760]) {
          await setNativeSize(app, page, width)
          await verifyMetrics(page, app, tempRoot, info, `${state}-${width}-expanded`, language, state, width, counts)
        }
        await setSidebarCollapsed(page, true)
        for (const width of [1081, 760]) {
          await setNativeSize(app, page, width)
          await verifyMetrics(page, app, tempRoot, info, `${state}-${width}-collapsed`, language, state, width, counts)
        }
        await setSidebarCollapsed(page, false)
        await page.locator('[data-page-id="settings"]').click()
        await expect(page.locator('.settings-layout')).toBeVisible()
        await openDashboard(page)
        await verifyMetrics(page, app, tempRoot, info, `${state}-return-from-settings`, language, state, 760, counts)
        if (state === 'disabled') {
          // Use the real create action, which also refreshes the renderer's
          // workspace snapshot. Calling persistence alone bypasses that flow.
          await page.locator('.sidebar-create-button').click()
          await expect.poll(() => page.evaluate(async () => (await window.knowbook.getHomeData()).summary.documents)).toBe(counts.documents + 1)
          const after = await page.evaluate(async () => {
            const { summary, aiConfig } = await window.knowbook.getHomeData()
            return { counts: { documents: summary.documents, blocks: summary.blocks, links: summary.links }, aiConfig }
          })
          expect(after.aiConfig).toMatchObject({ enabled: false, hasApiKey: false, autoSummaryOnSave: false })
          expect(after.counts.documents).toBe(counts.documents + 1)
          expect(after.counts.blocks).toBeGreaterThan(counts.blocks)
          await openDashboard(page)
          await expect(page.locator('.page-dashboard > .stats-grid > .stat-card strong').first()).toHaveText(String(after.counts.documents))
          await verifyMetrics(page, app, tempRoot, info, 'disabled-live-workspace-update', language, state, 760, after.counts)
          expectedCounts = after.counts
        }
      }
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}

test('dashboard metrics preserve complete labels and value contrast in all six built-in palettes @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  test.setTimeout(120_000)
  await withElectronApp(async ({ page, app, tempRoot }) => {
    await page.evaluate(() => window.knowbook.saveSetting('ui.language', 'en-US'))
    const counts = await configureAi(page, 'key-needed', 'en-US')
    await expect.poll(async () => (await page.evaluate(() => window.knowbook.listSystemPlugins()))
      .find(plugin => plugin.pluginId === 'theme-switcher')?.runtimeStatus).toBe('active')
    for (const palette of ['cloud', 'paper', 'moss', 'bay', 'midnight', 'violet']) {
      await page.evaluate(async themeId => {
        const plugin = (await window.knowbook.listSystemPlugins()).find(plugin => plugin.pluginId === 'theme-switcher')!
        await window.knowbook.invokeSystemPluginMain({ pluginId: plugin.pluginId,
          revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'set-theme', input: { themeId } })
      }, palette)
      await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', palette)
      for (const width of [1081, 760]) {
        await setNativeSize(app, page, width)
        await verifyMetrics(page, app, tempRoot, info, `${palette}-${width}`, 'en-US', 'key-needed', width, counts)
      }
    }
  })
})
