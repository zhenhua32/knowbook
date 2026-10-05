import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __auxRelationsProbe?: Probe }
const storageKey = 'knowbook.documents.auxPanelWidth'
const names = {
  empty: 'Auxiliary empty original', owner: 'Auxiliary linked owner', child: 'Auxiliary child original',
  outgoing: 'Auxiliary outgoing original', backlink: 'Auxiliary backlink original'
}
const bodies = {
  empty: 'Original empty-document body retained.', owner: `Original owner body links to [[${names.outgoing}]].`,
  child: 'Original child body retained.', outgoing: 'Original outgoing target body retained.',
  backlink: `Original backlink source refers to [[${names.owner}]].`
}
const labels = {
  'en-US': { titles: ['Children', 'Outgoing links', 'Backlinks'], empty: ['No child documents yet', 'No outgoing links yet', 'No backlinks yet'] },
  'zh-CN': { titles: ['子文档', '出链', '反向链接'], empty: ['还没有子文档。', '还没有出链。', '还没有反向链接。'] }
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
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width, height: 800 })
    return window.getContentSize()
  }, width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size)
  await settle(page)
}
async function readyDocument(page: Page, kind: keyof typeof names) {
  await expect(page.locator('.document-header-title')).toHaveText(names[kind])
  const reading = page.locator('.document-view-toggle')
  if (await reading.getAttribute('aria-pressed') !== 'true') await reading.click()
  await expect(page.locator(`[data-block-id="aux-relations-${kind}"]`)).toContainText(bodies[kind].replace(/\[\[([^\]]+)\]\]/g, '$1'))
  await settle(page)
}
async function openDocument(page: Page, kind: keyof typeof names) {
  const entry = page.locator('.tree-button').filter({ has: page.getByText(names[kind], { exact: true }) })
  await expect(entry).toHaveCount(1)
  await entry.click()
  await readyDocument(page, kind)
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
    ;(globalThis as ProbeGlobal).__auxRelationsProbe = probe
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
async function record(page: Page, app: ElectronApplication, info: TestInfo, language: Language, widthPreference: number,
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
      const visible = (box: DOMRect) => box.width > 0 && box.height > 0 && box.left >= left - .01 && box.right <= right + .01
        && box.top >= top - .01 && box.bottom <= bottom + .01
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      const range = document.createRange(); range.selectNodeContents(element)
      const textRects = Array.from(range.getClientRects())
      const style = getComputedStyle(element)
      return { box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        clip: { left, top, right, bottom }, fullyVisible: visible(rect), centerHit: hit === element || Boolean(hit && element.contains(hit)),
        text: element.textContent, textFullyVisible: textRects.length > 0 && textRects.every(box => visible(box)
          && box.left >= rect.left - .01 && box.right <= rect.right + .01 && box.top >= rect.top - .01 && box.bottom <= rect.bottom + .01),
        textOverflow: style.textOverflow, lineClamp: style.webkitLineClamp,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, focused: document.activeElement === element }
    }
    const grid = document.querySelector<HTMLElement>('.document-aux-relation-grid')
    return { viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme,
      savedWidth: localStorage.getItem(storageKey), title: document.querySelector('.document-header-title')?.textContent,
      grid: metric(grid), groups: Array.from(grid?.querySelectorAll<HTMLElement>('.relation-panel') || []).map(group => ({
        className: group.className, panel: metric(group), title: metric(group.querySelector<HTMLElement>('.panel-label')),
        empty: metric(group.querySelector<HTMLElement>('.empty-text')),
        buttons: Array.from(group.querySelectorAll<HTMLButtonElement>('.relation-chip')).map(button => ({
          metric: metric(button), title: button.querySelector('strong')?.textContent,
          path: button.querySelector('span')?.textContent, context: button.querySelector('.relation-chip-context')?.textContent || null,
          label: button.querySelector('small')?.textContent || null, tooltip: button.title })) })),
      url: metric(document.querySelector<HTMLElement>('.document-aux-web-clip input[type="url"]')),
      preview: metric(document.querySelector<HTMLElement>('[data-testid="document-scroll-region"]')),
      aside: metric(document.querySelector<HTMLElement>('.document-aux-sidebar')),
      toggle: metric(document.querySelector<HTMLElement>('.document-header-aux-button')),
      auxScrollTop: document.querySelector<HTMLElement>('[data-testid="document-aux-scroll-region"]')?.scrollTop,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
  }, storageKey)
  const main = await app.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(),
      contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(),
      visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
    probe: (globalThis as ProbeGlobal).__auxRelationsProbe!
  }))
  const result = { language, widthPreference, phase, state, ...main, before, stored: await readStored(page) }
  const path = info.outputPath(`${language}-${widthPreference}-${phase}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2)); await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${widthPreference}-${phase}.png`) })
  return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function invariant(result: Evidence, width: number, kind: keyof typeof names) {
  expect(result.windows).toHaveLength(1)
  const window = result.windows[0]
  expect(window.bounds.width).toBe(width); expect(window.bounds.height).toBe(800)
  expect(window.minimumSize).toEqual([760, 760])
  expect(result.state.viewport).toEqual(window.contentSize)
  expect(window.contentSize).toEqual([window.contentBounds.width, window.contentBounds.height])
  expect(result.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(result.probe).toEqual({ requests: [], writes: [], failures: [] })
  expect(result.stored).toEqual(result.before); expect(result.state.title).toBe(names[kind])
  expect(result.state.theme).toBe(result.language === 'zh-CN' ? 'dark' : 'light')
  expect(result.state.savedWidth).toBe(String(result.widthPreference)); expect(result.state.horizontalOverflow).toBe(false)
  expect(result.state.toggle!.fullyVisible).toBe(true); expect(result.state.toggle!.centerHit).toBe(true)
  expect(result.state.aside!.fullyVisible).toBe(true)
}
function emptyReadable(result: Evidence, maximumHeight: number, includeUrl: boolean) {
  expect(result.state.grid!.box.height).toBeLessThanOrEqual(maximumHeight)
  expect(result.state.grid!.fullyVisible).toBe(true)
  expect(result.state.groups).toHaveLength(3)
  for (const [index, group] of result.state.groups.entries()) {
    expect(group.title!.text).toBe(labels[result.language].titles[index])
    expect(group.empty!.text).toBe(labels[result.language].empty[index])
    for (const text of [group.title!, group.empty!]) {
      expect(text.fullyVisible).toBe(true); expect(text.textFullyVisible).toBe(true)
      expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1)
      expect(text.textOverflow).not.toBe('ellipsis'); expect(['none', '', '0']).toContain(text.lineClamp)
    }
    expect(group.buttons).toEqual([])
  }
  if (includeUrl) { expect(result.state.url!.fullyVisible).toBe(true); expect(result.state.url!.centerHit).toBe(true) }
}

for (const language of ['en-US', 'zh-CN'] as const) for (const widthPreference of [360, 280]) {
  test(`Empty auxiliary relations remain readable at ${widthPreference}px in ${language} @electron`, async ({}, info) => {
    test.setTimeout(90000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ app, page }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const seed = await page.evaluate(async ({ language, widthPreference, storageKey, names, bodies }) => {
        const ids: Record<string, string> = {}
        for (const kind of ['empty', 'outgoing', 'owner', 'child', 'backlink'] as const) {
          const document = await window.knowbook.createDocument(kind === 'child' ? ids.owner : null)
          ids[kind] = document.id
          await window.knowbook.updateDocument(document.id, { title: names[kind], summary: `Original ${kind} summary.`,
            blocks: [{ id: `aux-relations-${kind}`, type: 'paragraph', content: bodies[kind], checked: false, depth: 0 }] })
        }
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        localStorage.setItem(storageKey, String(widthPreference))
        const owner = await window.knowbook.getDocumentDetail(ids.owner)
        if (!owner) throw new Error('The prepared relation owner must exist.')
        return { ids, owner }
      }, { language, widthPreference, storageKey, names, bodies })
      await page.reload(); await resize(page, app, 1360)
      await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click()
      await openDocument(page, 'owner')
      await page.locator('.document-header-aux-button').click()
      await expect(page.locator('.document-header-aux-button')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.document-aux-relation-grid .relation-chip')).toHaveCount(3)
      await settle(page)
      const before = await readStored(page); await installProbe(app)
      const capture = (phase: string) => record(page, app, info, language, widthPreference, before, phase)
      // Preserve populated-card geometry even when the old empty layout fails next.
      await capture('populated-original-before-empty-density-oracle')
      await openDocument(page, 'empty')
      const empty = await capture('empty-wide-before-first-density-business-oracle')
      // Compact empty cards must preserve complete titles and explanations.
      // The user-selected 280px panel may legitimately wrap the English copy.
      emptyReadable(empty, widthPreference === 360 ? 210 : 260, true)
      invariant(empty, 1360, 'empty')
      expect(empty.state.aside!.box.width).toBeCloseTo(widthPreference, 1)
      await resize(page, app, 760)
      const stacked = await capture('empty-native-stack-full-copy')
      emptyReadable(stacked, 210, false); invariant(stacked, 760, 'empty')
      expect(stacked.state.aside!.box.top).toBeGreaterThanOrEqual(stacked.state.preview!.box.bottom - .01)
      await resize(page, app, 1360)
      const restored = await capture('empty-wide-user-width-restored')
      emptyReadable(restored, widthPreference === 360 ? 210 : 260, true); invariant(restored, 1360, 'empty')
      expect(restored.state.aside!.box.width).toBeCloseTo(widthPreference, 1)
      await openDocument(page, 'owner')
      const expected = [seed.owner.children.map(child => ({ ...child, label: 'child', contextSnippet: undefined })),
        seed.owner.outgoingLinks, seed.owner.backlinks]
      const assertPopulated = (result: Evidence) => {
        expect(result.state.groups).toHaveLength(3)
        for (const [index, group] of result.state.groups.entries()) {
          expect(group.title!.text).toBe(labels[language].titles[index]); expect(group.empty).toBeNull()
          expect(group.buttons).toHaveLength(expected[index].length)
          for (const [buttonIndex, button] of group.buttons.entries()) {
            const link = expected[index][buttonIndex]
            expect(button.title).toBe(link.title); expect(button.path).toBe(link.path)
            expect(button.tooltip).toBe(`${link.title}\n${link.path}`)
            expect(button.metric!.fullyVisible).toBe(true); expect(button.metric!.centerHit).toBe(true)
            if (link.contextSnippet) expect(button.context).toBe(link.contextSnippet.slice(0, 120) + (link.contextSnippet.length > 120 ? '…' : ''))
            else expect(button.label).toBe(link.label)
          }
        }
      }
      for (const [index, kind] of (['child', 'outgoing', 'backlink'] as const).entries()) {
        const group = page.locator('.document-aux-relation-grid .relation-panel').nth(index)
        const button = group.locator('.relation-chip').filter({ has: page.getByText(names[kind], { exact: true }) })
        await expect(button).toHaveCount(1); await button.click(); await readyDocument(page, kind)
        const target = await capture(`real-${kind}-relation-selects-exact-document`)
        invariant(target, 1360, kind)
        await openDocument(page, 'owner')
      }
      const populated = await capture('populated-owner-final-original-data')
      invariant(populated, 1360, 'owner'); assertPopulated(populated)
      expect(seed.owner.children.map(child => child.id)).toEqual([seed.ids.child])
      expect(seed.owner.outgoingLinks.map(link => link.id)).toEqual([seed.ids.outgoing])
      expect(seed.owner.backlinks.map(link => link.id)).toEqual([seed.ids.backlink])
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
