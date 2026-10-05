import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __documentAuxPreferencesProbe?: Probe }
const storageKey = 'knowbook.documents.auxPanelWidth'
const documentTitle = 'Auxiliary width preference original'
const variants = [
  { name: 'missing', stored: null, initial: 360 },
  { name: 'empty', stored: '', initial: 360 },
  { name: 'whitespace', stored: '   ', initial: 360 },
  { name: 'valid376', stored: '376', initial: 376 }
] as const

async function settle(page: Page) {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => {
    element.getBoundingClientRect()
    return element.getAnimations().filter(animation => animation.playState === 'running' || animation.pending).length
  })).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function resize(page: Page, app: ElectronApplication, width: number) {
  const content = await app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width, height: 800 })
    return window.getContentSize()
  }, width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(content)
  await settle(page)
}
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 64; step++) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}
async function openOriginal(page: Page) {
  await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click()
  const entry = page.locator('.tree-button').filter({ has: page.getByText(documentTitle, { exact: true }) })
  await expect(entry).toHaveCount(1); await entry.click()
  await expect(page.locator('.document-header-title')).toHaveText(documentTitle)
  const reading = page.locator('.document-view-toggle')
  if (await reading.getAttribute('aria-pressed') !== 'true') await reading.click()
  await expect(page.locator('[data-block-id="aux-preference-body"]')).toContainText('Original body retained through preference restoration.')
  await settle(page)
}
async function readStored(page: Page) {
  return page.evaluate(async () => {
    const catalog = (await window.knowbook.getDocumentCatalog()).sort((left, right) => left.id.localeCompare(right.id))
    const databases = (await window.knowbook.getDatabases()).sort((left, right) => left.id.localeCompare(right.id))
    return { catalog, documents: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))), databases,
      sources: await Promise.all(databases.map(async database => ({ id: database.id,
        entities: (await window.knowbook.getDatabaseEntities(database.id)).sort((left, right) => left.id.localeCompare(right.id)),
        fields: (await window.knowbook.getDocumentDatabaseColumns(database.id)).sort((left, right) => left.id.localeCompare(right.id)),
        views: (await window.knowbook.getDatabaseSavedViews(database.id)).sort((left, right) => left.id.localeCompare(right.id)) }))) }
  })
}
async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe: Probe = { requests: [], writes: [], failures: [] }
    ;(globalThis as ProbeGlobal).__documentAuxPreferencesProbe = probe
    for (const [channel, original] of Array.from(handlers.entries())) {
      if (!/^knowbook:(create|update|delete|rename|move|save)-/.test(channel)) continue
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...input: unknown[]) => {
        const request = { channel, input: structuredClone(input) }; probe.requests.push(request)
        try { const result = await original(event, ...input); probe.writes.push(request); return result }
        catch (error) { probe.failures.push({ ...request, reason: error instanceof Error ? error.message : String(error) }); throw error }
      })
    }
  })
}
async function nativeState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(),
      contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(),
      visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
    probe: (globalThis as ProbeGlobal).__documentAuxPreferencesProbe!
  }))
}
async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, variant: string,
  before: Awaited<ReturnType<typeof readStored>>, phase: string) {
  const state = await page.evaluate(storageKey => {
    const metric = (element: HTMLElement | null) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
        const bl = parseFloat(style.borderLeftWidth) || 0, br = parseFloat(style.borderRightWidth) || 0
        const bt = parseFloat(style.borderTopWidth) || 0, bb = parseFloat(style.borderBottomWidth) || 0
        const vs = /auto|scroll/.test(style.overflowY) ? Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - Math.round(bl + br)) : 0
        const hs = /auto|scroll/.test(style.overflowX) ? Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - Math.round(bt + bb)) : 0
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, bounds.left + bl); right = Math.min(right, bounds.right - br - vs) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, bounds.top + bt); bottom = Math.min(bottom, bounds.bottom - bb - hs) }
        if (style.position === 'fixed') break
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        clip: { left, top, right, bottom }, fullyVisible: rect.width > 0 && rect.height > 0 && rect.left >= left - .01 && rect.right <= right + .01
          && rect.top >= top - .01 && rect.bottom <= bottom + .01, centerHit: hit === element || Boolean(hit && element.contains(hit)),
        focused: document.activeElement === element }
    }
    const separator = document.querySelector<HTMLElement>('.document-aux-resizer')
    return { viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme, savedWidth: localStorage.getItem(storageKey),
      preview: metric(document.querySelector<HTMLElement>('[data-testid="document-scroll-region"]')),
      aside: metric(document.querySelector<HTMLElement>('.document-aux-sidebar')),
      toggle: metric(document.querySelector<HTMLElement>('.document-header-aux-button')),
      separator: separator ? { ...metric(separator)!, value: separator.getAttribute('aria-valuenow'), orientation: separator.getAttribute('aria-orientation') } : null,
      title: document.querySelector('.document-header-title')?.textContent,
      auxiliary: document.querySelector('.document-header-aux-button')?.getAttribute('aria-pressed'),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      active: document.activeElement instanceof HTMLElement ? document.activeElement.className : null }
  }, storageKey)
  const main = await nativeState(app), stored = await readStored(page)
  const result = { language, variant, phase, state, ...main, before, stored }
  const path = info.outputPath(`${language}-${variant}-${phase}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2)); await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${variant}-${phase}.png`) })
  return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function invariant(result: Evidence, width: number, language: Language, reloaded = false) {
  expect(result.windows).toHaveLength(1)
  expect(result.windows[0].bounds.width).toBe(width); expect(result.windows[0].bounds.height).toBe(800)
  expect(result.state.viewport).toEqual(result.windows[0].contentSize)
  expect(result.windows[0].contentSize).toEqual([result.windows[0].contentBounds.width, result.windows[0].contentBounds.height])
  expect(result.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const locale = { channel: 'knowbook:save-setting', input: ['ui.language', language] }
  expect(result.probe).toEqual(reloaded ? { requests: [locale], writes: [locale], failures: [] } : { requests: [], writes: [], failures: [] })
  expect(result.stored).toEqual(result.before); expect(result.state.title).toBe(documentTitle)
  expect(result.state.theme).toBe(language === 'zh-CN' ? 'dark' : 'light'); expect(result.state.horizontalOverflow).toBe(false)
  expect(result.state.toggle!.fullyVisible).toBe(true); expect(result.state.toggle!.centerHit).toBe(true)
  expect(result.state.aside!.fullyVisible).toBe(true); expect(result.state.aside!.centerHit).toBe(true)
}

for (const language of ['en-US', 'zh-CN'] as const) for (const variant of variants) {
  test(`Auxiliary width ${variant.name} restores native default and user preference in ${language} @electron`, async ({}, info) => {
    test.setTimeout(90000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ app, page }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async ({ language, stored, storageKey, documentTitle }) => {
        const document = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(document.id, { title: documentTitle, summary: 'Original preference-test summary.',
          blocks: [{ id: 'aux-preference-body', type: 'paragraph', content: 'Original body retained through preference restoration.', checked: false, depth: 0 }] })
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        if (stored === null) localStorage.removeItem(storageKey)
        else localStorage.setItem(storageKey, stored)
      }, { language, stored: variant.stored, storageKey, documentTitle })
      await page.reload(); await resize(page, app, 1360); await openOriginal(page)
      const before = await readStored(page)
      // All fixture writes and locale bootstrap finish before the observer.
      await installProbe(app)
      const toggle = page.locator('.document-header-aux-button'), separator = page.locator('.document-aux-resizer')
      await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await settle(page)
      const capture = (phase: string) => record(page, app, info, language, variant.name, before, phase)
      const initial = await capture('initial-before-first-width-business-oracle')
      // Number(null), Number(''), and Number('   ') used to become zero and
      // produce a false 280px preference instead of the real default 360px.
      expect(initial.state.aside!.box.width).toBeCloseTo(variant.initial, 1)
      invariant(initial, 1360, language); expect(initial.state.savedWidth).toBe(String(variant.initial))
      await tabTo(page, separator); await page.keyboard.press('ArrowLeft'); await settle(page)
      const saved = variant.initial + 16
      const keyboard = await capture('real-separator-arrow-left-saves-user-width')
      invariant(keyboard, 1360, language); expect(keyboard.state.aside!.box.width).toBeCloseTo(saved, 1)
      expect(keyboard.state.separator!.focused).toBe(true); expect(keyboard.state.separator!.value).toBe(String(saved))
      expect(keyboard.state.savedWidth).toBe(String(saved))
      await resize(page, app, 760)
      const narrow = await capture('native-stack-keeps-saved-wide-preference')
      invariant(narrow, 760, language); expect(narrow.state.savedWidth).toBe(String(saved))
      expect(narrow.state.aside!.box.top).toBeGreaterThanOrEqual(narrow.state.preview!.box.bottom - .01)
      await resize(page, app, 1360)
      const restored = await capture('native-wide-restores-saved-user-width')
      invariant(restored, 1360, language); expect(restored.state.aside!.box.width).toBeCloseTo(saved, 1)
      expect(restored.state.savedWidth).toBe(String(saved)); expect(restored.state.separator!.value).toBe(String(saved))
      await toggle.click(); await expect(page.locator('.document-aux-sidebar')).toHaveCount(0)
      await page.reload(); await openOriginal(page)
      await expect(page.locator('.document-aux-sidebar')).toHaveCount(0)
      await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await settle(page)
      // The existing app locale bootstrap performs one exact setting write on
      // reload. It is not a document mutation and no other write is allowed.
      await expect.poll(async () => (await nativeState(app)).probe.writes.length).toBe(1)
      const reloaded = await capture('real-reload-restores-only-explicit-user-preference')
      invariant(reloaded, 1360, language, true); expect(reloaded.state.aside!.box.width).toBeCloseTo(saved, 1)
      expect(reloaded.state.savedWidth).toBe(String(saved)); expect(reloaded.state.separator!.value).toBe(String(saved))
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
