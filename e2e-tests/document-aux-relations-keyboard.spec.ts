import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Language = 'en-US' | 'zh-CN'
type Kind = 'owner' | 'child' | 'outgoing' | 'backlink'
type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type Request = { channel: string; input: unknown[] }
type Probe = { requests: Request[]; writes: Request[]; failures: Array<Request & { reason: string }> }
type ProbeGlobal = typeof globalThis & { __auxRelationKeyboardProbe?: Probe }
const storageKey = 'knowbook.documents.auxPanelWidth'
const parentTitle = `Relation parent ${'Branch '.repeat(5)}END`
const names = {
  owner: 'Reading owner', child: `Long child ${'Readable '.repeat(4)}FINAL CHILD`,
  outgoing: `Long outgoing ${'Readable '.repeat(3)}FINAL OUTGOING`, backlink: `Long backlink ${'Readable '.repeat(3)}FINAL BACKLINK`
}
const bodies = {
  owner: `Owner body follows [[${names.outgoing}]] for keyboard reading.`,
  child: 'Exact original child body for keyboard navigation.',
  outgoing: 'Exact original outgoing target body for keyboard navigation.',
  backlink: `Unbroken${'Z'.repeat(58)} [[${names.owner}]] tail.`
}
const kinds = ['child', 'outgoing', 'backlink'] as const

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
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 80; step++) {
    if (await target.evaluate(element => document.activeElement === element)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}
async function readyDocument(page: Page, kind: Kind) {
  await expect(page.locator('.document-header-title')).toHaveText(names[kind])
  const reading = page.locator('.document-view-toggle')
  if (await reading.getAttribute('aria-pressed') !== 'true') await reading.click()
  await expect(page.locator(`[data-block-id="aux-keyboard-${kind}"]`)).toContainText(bodies[kind].replace(/\[\[([^\]]+)\]\]/g, '$1'))
  await settle(page)
}
async function openOwner(page: Page) {
  const tree = page.locator('.tree-button').filter({ has: page.getByText(names.owner, { exact: true }) })
  await expect(tree).toHaveCount(1); await tree.click(); await readyDocument(page, 'owner')
  await expect(page.locator('.document-aux-relation-grid .relation-chip')).toHaveCount(3)
}
function relation(page: Page, index: number) { return page.locator('.document-aux-relation-grid .relation-panel').nth(index).locator('.relation-chip') }
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
    ;(globalThis as ProbeGlobal).__auxRelationKeyboardProbe = probe
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
      const box = element.getBoundingClientRect(), style = getComputedStyle(element)
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect()
        const bl = parseFloat(css.borderLeftWidth) || 0, br = parseFloat(css.borderRightWidth) || 0
        const bt = parseFloat(css.borderTopWidth) || 0, bb = parseFloat(css.borderBottomWidth) || 0
        const vs = /auto|scroll/.test(css.overflowY) ? Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - Math.round(bl + br)) : 0
        const hs = /auto|scroll/.test(css.overflowX) ? Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - Math.round(bt + bb)) : 0
        if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) { left = Math.max(left, rect.left + bl); right = Math.min(right, rect.right - br - vs) }
        if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) { top = Math.max(top, rect.top + bt); bottom = Math.min(bottom, rect.bottom - bb - hs) }
        if (css.position === 'fixed') break
      }
      const visible = (rect: DOMRect) => rect.width > 0 && rect.height > 0 && rect.left >= left - .01 && rect.right <= right + .01
        && rect.top >= top - .01 && rect.bottom <= bottom + .01
      const own = (rect: DOMRect) => visible(rect) && rect.left >= box.left - .01 && rect.right <= box.right + .01
        && rect.top >= box.top - .01 && rect.bottom <= box.bottom + .01
      const full = document.createRange(); full.selectNodeContents(element)
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes: Text[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.length) nodes.push(node as Text)
      const last = nodes.at(-1), suffix = document.createRange()
      if (last) { suffix.setStart(last, last.length - 1); suffix.setEnd(last, last.length) }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
        clip: { left, top, right, bottom }, fullyVisible: visible(box), centerHit: hit === element || Boolean(hit && element.contains(hit)),
        text: element.textContent, wholeTextVisible: Array.from(full.getClientRects()).every(own),
        lastCharacter: last?.textContent?.slice(-1), lastCharacterVisible: Boolean(last && own(suffix.getBoundingClientRect())),
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
        focused: document.activeElement === element, focusVisible: element.matches(':focus-visible') }
    }
    const scroll = document.querySelector<HTMLElement>('[data-testid="document-aux-scroll-region"]')
    const row = document.querySelector<HTMLElement>('.preview-panel .document-reading-row[data-block-id]')
    return { viewport: [innerWidth, innerHeight], savedWidth: localStorage.getItem(storageKey), theme: document.documentElement.dataset.theme,
      title: document.querySelector('.document-header-title')?.textContent, body: row ? { blockId: row.dataset.blockId, text: row.textContent } : null,
      cards: Array.from(document.querySelectorAll<HTMLButtonElement>('.document-aux-relation-grid .relation-chip')).map(button => ({
        button: metric(button), tooltip: button.title, title: metric(button.querySelector<HTMLElement>('strong')),
        path: metric(button.querySelector<HTMLElement>('span')), context: metric(button.querySelector<HTMLElement>('.relation-chip-context')),
        label: metric(button.querySelector<HTMLElement>('small')) })),
      auxScroll: scroll ? { top: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight } : null,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
  }, storageKey)
  const main = await app.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().map(window => ({
    bounds: window.getBounds(), contentBounds: window.getContentBounds(), contentSize: window.getContentSize(), minimumSize: window.getMinimumSize(),
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
    probe: (globalThis as ProbeGlobal).__auxRelationKeyboardProbe! }))
  const result = { language, widthPreference, phase, state, ...main, before, stored: await readStored(page) }
  const path = info.outputPath(`${language}-${widthPreference}-${phase}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2)); await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${language}-${widthPreference}-${phase}.png`) })
  return result
}
type Evidence = Awaited<ReturnType<typeof record>>
function invariant(result: Evidence, width: number, kind: Kind) {
  expect(result.windows).toHaveLength(1)
  const window = result.windows[0]
  expect(window.bounds).toMatchObject({ width, height: 800 }); expect(window.minimumSize).toEqual([760, 760])
  expect(result.state.viewport).toEqual(window.contentSize)
  expect(window.contentSize).toEqual([window.contentBounds.width, window.contentBounds.height])
  expect(result.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(result.probe).toEqual({ requests: [], writes: [], failures: [] }); expect(result.stored).toEqual(result.before)
  expect(result.state.savedWidth).toBe(String(result.widthPreference)); expect(result.state.horizontalOverflow).toBe(false)
  expect(result.state.theme).toBe(result.language === 'zh-CN' ? 'dark' : 'light')
  expect(result.state.title).toBe(names[kind]); expect(result.state.body!.blockId).toBe(`aux-keyboard-${kind}`)
  expect(result.state.body!.text).toContain(bodies[kind].replace(/\[\[([^\]]+)\]\]/g, '$1'))
}
function readable(result: Evidence, index: number, expected: { title: string; path: string; label: string; contextSnippet?: string }) {
  const card = result.state.cards[index]
  // First business oracle proves actual suffix visibility, before styling checks.
  expect(card.title!.lastCharacterVisible).toBe(true)
  expect(card.button!.focused).toBe(true); expect(card.button!.focusVisible).toBe(true)
  expect(card.button!.fullyVisible).toBe(true); expect(card.button!.centerHit).toBe(true)
  expect(card.title!.text).toBe(expected.title); expect(card.path!.text).toBe(expected.path)
  expect(card.tooltip).toBe(`${expected.title}\n${expected.path}`)
  if (expected.contextSnippet) expect(card.context!.text).toBe(expected.contextSnippet)
  else expect(card.label!.text).toBe(expected.label)
  for (const text of [card.title!, card.path!, ...(card.context ? [card.context] : []), ...(card.label ? [card.label] : [])]) {
    expect(text.lastCharacterVisible).toBe(true); expect(text.wholeTextVisible).toBe(true)
    expect(text.fullyVisible).toBe(true); expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1)
    expect(text.whiteSpace).toBe('normal')
  }
}
function compact(result: Evidence) {
  for (const card of result.state.cards) for (const text of [card.title!, card.path!]) {
    expect(text.whiteSpace).toBe('nowrap'); expect(text.textOverflow).toBe('ellipsis')
  }
}

for (const language of ['en-US', 'zh-CN'] as const) for (const widthPreference of [360, 280]) {
  test(`Keyboard reads complete auxiliary relations at ${widthPreference}px in ${language} @electron`, async ({}, info) => {
    test.setTimeout(120000); test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ app, page }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const seed = await page.evaluate(async ({ language, widthPreference, storageKey, parentTitle, names, bodies }) => {
        const parent = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(parent.id, { title: parentTitle, summary: 'Original parent metadata.',
          blocks: [{ id: 'aux-keyboard-parent', type: 'paragraph', content: 'Original parent body.', checked: false, depth: 0 }] })
        const ids: Record<string, string> = {}
        for (const kind of ['outgoing', 'owner', 'child', 'backlink'] as const) {
          const document = await window.knowbook.createDocument(kind === 'child' ? ids.owner : parent.id)
          ids[kind] = document.id
          await window.knowbook.updateDocument(document.id, { title: names[kind], summary: `Original ${kind} summary.`,
            blocks: [{ id: `aux-keyboard-${kind}`, type: 'paragraph', content: bodies[kind], checked: false, depth: 0 }] })
        }
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        localStorage.setItem(storageKey, String(widthPreference))
        const owner = await window.knowbook.getDocumentDetail(ids.owner)
        if (!owner) throw new Error('The prepared keyboard relation owner must exist.')
        return { ids, owner }
      }, { language, widthPreference, storageKey, parentTitle, names, bodies })
      await page.reload(); await resize(page, app, 1360)
      await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click()
      const tree = page.locator('.tree-button').filter({ has: page.getByText(names.owner, { exact: true }) })
      await expect(tree).toHaveCount(1); await tree.click(); await readyDocument(page, 'owner')
      await page.locator('.document-header-aux-button').click()
      await expect(page.locator('.document-header-aux-button')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.document-aux-relation-grid .relation-chip')).toHaveCount(3); await settle(page)
      const before = await readStored(page); await installProbe(app)
      const capture = (phase: string) => record(page, app, info, language, widthPreference, before, phase)
      const unfocused = await capture('unfocused-original-single-line-relations')
      const expected = [seed.owner.children.map(child => ({ ...child, label: 'child', contextSnippet: undefined })),
        seed.owner.outgoingLinks, seed.owner.backlinks].map(links => links[0])
      expect(expected.map(link => link.id)).toEqual(kinds.map(kind => seed.ids[kind]))
      expect(expected[2].contextSnippet!.length).toBeLessThanOrEqual(120)
      expect(expected[2].contextSnippet).toContain('Z'.repeat(58))
      for (const [index, kind] of kinds.entries()) {
        const button = relation(page, index)
        await tabTo(page, page.locator('.document-header-aux-button')); await tabTo(page, button); await settle(page)
        const focused = await capture(`${kind}-real-tab-focused-before-reading-oracle`)
        readable(focused, index, expected[index]); invariant(focused, 1360, 'owner')
        if (index === 0) { compact(unfocused); invariant(unfocused, 1360, 'owner') }
        const original = await button.elementHandle()
        if (!original) throw new Error('The focused relation button must exist.')
        await resize(page, app, 760)
        const stacked = await capture(`${kind}-native-stack-same-focused-button`)
        readable(stacked, index, expected[index]); invariant(stacked, 760, 'owner')
        expect(await button.evaluate((element, previous) => element === previous, original)).toBe(true)
        await resize(page, app, 1360)
        const restored = await capture(`${kind}-native-wide-same-focused-button`)
        readable(restored, index, expected[index]); invariant(restored, 1360, 'owner')
        expect(await button.evaluate((element, previous) => element === previous, original)).toBe(true)
        if (index === 2) {
          await page.keyboard.press('Shift+Tab'); await expect(relation(page, 1)).toBeFocused(); await settle(page)
          const reverse = await capture('reverse-tab-reads-previous-outgoing-target')
          readable(reverse, 1, expected[1]); invariant(reverse, 1360, 'owner')
          await page.keyboard.press('Tab'); await expect(button).toBeFocused(); await settle(page)
          const forward = await capture('forward-tab-restores-backlink-reading-target')
          readable(forward, index, expected[index]); invariant(forward, 1360, 'owner')
        }
        await page.keyboard.press('Enter'); await readyDocument(page, kind)
        const selected = await capture(`${kind}-real-enter-selects-exact-stored-document`)
        invariant(selected, 1360, kind)
        const detail = selected.before.documents.find(document => document?.id === seed.ids[kind])
        expect(detail?.title).toBe(names[kind]); expect(detail?.blocks[0].id).toBe(selected.state.body!.blockId)
        await original.dispose(); await openOwner(page)
      }
      const final = await capture('owner-returned-unfocused-original-content')
      invariant(final, 1360, 'owner'); compact(final)
      for (const [index, card] of final.state.cards.entries()) {
        expect(card.title!.text).toBe(expected[index].title); expect(card.path!.text).toBe(expected[index].path)
        expect(card.tooltip).toBe(`${expected[index].title}\n${expected[index].path}`)
        if (expected[index].contextSnippet) expect(card.context!.text).toBe(expected[index].contextSnippet)
        else expect(card.label!.text).toBe(expected[index].label)
      }
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
