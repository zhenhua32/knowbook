import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateDocumentFromTemplateInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { event: unknown; input: CreateDocumentFromTemplateInput; settled: boolean; resolve: (result: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; requests: Request[]; saved: unknown[]; failures: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookTemplateScrollProbe?: Probe }
type ProbeWindow = Window & { __knowbookTemplateScrollRoute?: Array<{ phase: string; step: number; tag: string | null; reached: boolean }> }
const picker = (page: Page) => page.getByRole('dialog', { name: uiText('From template', '从模板新建'), exact: true })
const opener = (page: Page) => page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true })
const search = (page: Page) => picker(page).getByRole('searchbox', { name: uiText('Search templates', '搜索模板'), exact: true })
const title = (page: Page) => picker(page).getByRole('textbox', { name: uiText('Document title', '文档标题'), exact: true })
const parent = (page: Page) => picker(page).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true })
const preview = (page: Page) => picker(page).locator('.document-template-preview')
const create = (page: Page) => picker(page).getByRole('button', { name: uiText('Create document', '创建文档'), exact: true })
const cancel = (page: Page) => picker(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true })
const item = (page: Page, name: string) => picker(page).locator('.document-template-item').filter({ has: page.getByText(name, { exact: true }) })
const twoFrames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

async function stored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { catalog, details: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))),
      templates: await window.knowbook.listDocumentTemplates(language) }
  }, language)
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('knowbook:create-document-from-template')
    if (!original) throw new Error('The real template creation handler is required')
    const probe: Probe = { original, requests: [], saved: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookTemplateScrollProbe = probe
    ipcMain.removeHandler('knowbook:create-document-from-template')
    ipcMain.handle('knowbook:create-document-from-template', (event, input) => new Promise((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
  })
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookTemplateScrollProbe!, request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real pending template request is required')
    request.settled = true
    setImmediate(async () => {
      try { const result = await probe.original(request.event, request.input); probe.saved.push(result); request.resolve(result) }
      catch (reason) { const error = reason instanceof Error ? reason : new Error(String(reason)); probe.failures.push(error.message); request.reject(error) }
    })
  }, index)
}

async function tabTo(page: Page, target: Locator, phase: string, direction: 'Tab' | 'Shift+Tab' = 'Tab') {
  let reached = await target.evaluate(element => document.activeElement === element)
  for (let step = 1; step <= 40 && !reached; step++) {
    await page.keyboard.press(direction)
    const stop = await target.evaluate((element, { phase, step }) => {
      const stop = { phase, step, tag: document.activeElement?.tagName ?? null, reached: document.activeElement === element }
      ;((window as ProbeWindow).__knowbookTemplateScrollRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached) break
  }
  expect(reached, `Native ${direction} must reach the control without repairing focus`).toBe(true)
  await expect(target).toBeFocused()
}

async function replaceQuery(page: Page, value: string) {
  await tabTo(page, search(page), 'native-tab-to-template-search')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  if (value) await page.keyboard.type(value)
}

async function chooseParent(page: Page, id: string) {
  await tabTo(page, parent(page), 'native-tab-to-parent-folder')
  await page.keyboard.press('Home')
  for (let step = 0; step < 24; step++) {
    if (await parent(page).inputValue() === id) return
    await page.keyboard.press('ArrowDown')
  }
  throw new Error('Native parent-folder selection must reach the seeded parent')
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookTemplateScrollProbe!
    return { windows: BrowserWindow.getAllWindows().map(window => ({
      visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds(), contentBounds: window.getContentBounds()
    })), calls: probe.requests.map(({ input, settled }) => ({ input, settled })), saved: probe.saved, failures: probe.failures }
  })
  const state = await page.evaluate(() => {
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const box = (element: Element) => {
      const bounds = rect(element), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), r = rect(parent)
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { clip.left = Math.max(clip.left, r.left + parent.clientLeft); clip.right = Math.min(clip.right, r.left + parent.clientLeft + parent.clientWidth) }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { clip.top = Math.max(clip.top, r.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, r.top + parent.clientTop + parent.clientHeight) }
      }
      const width = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left))
      const height = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return { rect: bounds, clip, visibleRatio: bounds.width && bounds.height ? width * height / (bounds.width * bounds.height) : 0,
        centerHit: hit === element || Boolean(hit && element.contains(hit)), hit: hit ? { tag: hit.tagName, className: hit.getAttribute('class') } : null }
    }
    const modal = document.querySelector<HTMLDialogElement>('.document-template-dialog'), active = document.activeElement
    const scrollBox = (element: HTMLElement) => ({ ...box(element), scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })
    const getBox = (selector: string) => { const element = modal?.querySelector<HTMLElement>(selector); return element ? box(element) : null }
    const getScrollBox = (selector: string) => { const element = modal?.querySelector<HTMLElement>(selector); return element ? scrollBox(element) : null }
    const alert = modal?.querySelector<HTMLElement>('[role="alert"]')
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      active: { tag: active?.tagName, isBody: active === document.body, name: active?.getAttribute('name'), connected: active?.isConnected },
      modal: modal ? { ...scrollBox(modal), busy: modal.getAttribute('aria-busy') } : null,
      header: getBox('.document-capture-header'), heading: getBox('h2'), footer: getBox('.document-capture-footer'),
      workspace: getScrollBox('.document-template-workspace'), browserList: getScrollBox('.document-template-list'), preview: getScrollBox('.document-template-preview'),
      error: alert ? { ...scrollBox(alert), text: alert.textContent } : null,
      title: modal?.querySelector<HTMLInputElement>('[name="document-title"]') ? {
        value: modal.querySelector<HTMLInputElement>('[name="document-title"]')!.value,
        focused: active === modal.querySelector('[name="document-title"]'), ...getBox('[name="document-title"]')!
      } : null,
      parentId: modal?.querySelector<HTMLSelectElement>('select')?.value,
      selected: modal?.querySelector('.document-template-item[aria-pressed="true"] strong')?.textContent,
      buttons: Array.from(modal?.querySelectorAll<HTMLButtonElement>('header > button, footer > button') ?? []).map(button => ({
        text: button.textContent, disabled: button.disabled, focused: active === button, ...box(button) })),
      notifications: document.querySelectorAll('.app-notifications').length,
      route: (window as ProbeWindow).__knowbookTemplateScrollRoute ?? [] }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { main, state }
}

function expectFrame(state: Awaited<ReturnType<typeof record>>['state']) {
  expect(state.modal).not.toBeNull()
  expect(state.heading).not.toBeNull()
  expect(state.header).not.toBeNull()
  expect(state.footer).not.toBeNull()
  expect(state.buttons).toHaveLength(2)
  // Check real clipping and hit testing before any click could scroll a button
  // into view. Header and footer must remain available while content moves.
  for (const element of [state.heading!, state.header!, state.footer!, ...state.buttons]) {
    expect(element.visibleRatio).toBeGreaterThanOrEqual(0.999)
    expect(element.centerHit).toBe(true)
  }
  expect(state.modal!.scrollTop).toBe(0)
  expect(state.modal!.scrollHeight).toBeLessThanOrEqual(state.modal!.clientHeight + 1)
  expect(state.modal!.scrollWidth).toBeLessThanOrEqual(state.modal!.clientWidth + 1)
}

for (const scenario of [
  { language: 'en-US', theme: 'light', viewport: { width: 1360, height: 520 } },
  { language: 'zh-CN', theme: 'dark', viewport: { width: 600, height: 560 } }
] as const) {
  test(`template scroll frame keeps long previews and creation controls usable (${scenario.language}) @electron`, async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const pageErrors: string[] = []
      page.on('pageerror', error => pageErrors.push(error.message))
      const ids = await page.evaluate(async ({ language, theme }) => {
        const { id: parentId } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(parentId, { title: 'Scroll frame parent', summary: 'Keep the original parent summary', blocks: [
          { id: `${parentId}-body`, type: 'paragraph', content: 'Keep the original parent content.', checked: false, depth: 0 }
        ] })
        const templates = []
        for (const name of ['Alpha', 'Beta']) templates.push(await window.knowbook.saveDocumentTemplate({
          name: `Scroll Frame ${name}`, description: `Long ${name} preview for reading before creation`, title: `${name} automatic title`, summary: `${name} template summary`,
          blocks: Array.from({ length: 32 }, (_, index) => ({ id: `${name.toLowerCase()}-preview-${index}`, type: 'paragraph' as const,
            content: `${name} preview paragraph ${index + 1}: preserve the complete original template content while reading and creating a document.`, checked: false, depth: 0 }))
        }))
        for (let index = 0; index < 6; index++) await window.knowbook.saveDocumentTemplate({ name: `Frame list sample ${index + 1}`,
          description: 'A separate template remains available in the scrollable browser.', title: `List sample ${index + 1}`, summary: '',
          blocks: [{ id: `frame-list-${index}`, type: 'paragraph', content: 'Independent template body.', checked: false, depth: 0 }] })
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', theme)
        return { parentId, alphaId: templates[0].id, betaId: templates[1].id }
      }, scenario)
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize(scenario.viewport)
      await app.evaluate(({ BrowserWindow }, viewport) => BrowserWindow.getAllWindows()[0].setContentSize(viewport.width, viewport.height), scenario.viewport)
      await twoFrames(page)
      const before = await stored(page, scenario.language)
      await installProbe(app)
      await tabTo(page, opener(page), 'native-tab-to-template-opener')
      await page.keyboard.press('Enter')
      await expect(picker(page)).toBeVisible()
      await expect(search(page)).toBeFocused()
      await page.keyboard.type('Scroll Frame Alpha')
      await tabTo(page, item(page, 'Scroll Frame Alpha'), 'native-tab-to-long-alpha-template')
      await page.keyboard.press('Enter')
      await expect(item(page, 'Scroll Frame Alpha')).toHaveAttribute('aria-pressed', 'true')
      await replaceQuery(page, '')
      const initial = await record(page, app, info, `${scenario.language}-long-alpha-preview-before-frame-assertion`)
      expect(initial.state.theme).toBe(scenario.theme)
      expect(initial.state.viewport).toEqual(scenario.viewport)
      expect(initial.state.preview!.scrollHeight).toBeGreaterThan(initial.state.preview!.clientHeight)
      expect(initial.state.browserList!.scrollHeight).toBeGreaterThan(initial.state.browserList!.clientHeight)
      expectFrame(initial.state)

      await tabTo(page, preview(page), 'native-tab-to-scrollable-preview')
      await page.keyboard.press('End')
      await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await expect.poll(() => preview(page).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
      const read = await record(page, app, info, `${scenario.language}-native-preview-end-keeps-frame`)
      expectFrame(read.state)
      expect(read.state.preview!.scrollTop).toBeGreaterThan(0)
      await tabTo(page, title(page), 'native-tab-from-preview-to-draft-title')
      const invalidTitle = 'Invalid/scroll-frame-draft'
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type(invalidTitle)
      await chooseParent(page, ids.parentId)
      await replaceQuery(page, 'Scroll Frame Beta')
      await tabTo(page, item(page, 'Scroll Frame Beta'), 'native-tab-to-beta-with-manual-draft')
      await page.keyboard.press('Enter')
      const switched = await record(page, app, info, `${scenario.language}-beta-selection-preserves-draft-and-frame`)
      expectFrame(switched.state)
      expect(switched.state.selected).toBe('Scroll Frame Beta')
      await expect(title(page)).toHaveValue(invalidTitle)
      await expect(parent(page)).toHaveValue(ids.parentId)
      await expect(preview(page)).toContainText('Beta preview paragraph 32')
      await expect(preview(page)).not.toContainText('Alpha preview paragraph')
      await tabTo(page, create(page), 'native-tab-to-visible-create-button')
      const ready = await record(page, app, info, `${scenario.language}-before-native-create-enter`)
      expectFrame(ready.state)
      await expect(create(page)).toBeEnabled()
      await page.keyboard.press('Enter')
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookTemplateScrollProbe!.requests.length)).toBe(1)
      await expect(picker(page)).toHaveAttribute('aria-busy', 'true')
      const pending = await record(page, app, info, `${scenario.language}-real-create-pending-keeps-frame`)
      expectFrame(pending.state)
      expect(pending.main.calls).toEqual([{ input: { templateId: ids.betaId, title: invalidTitle, parentId: ids.parentId, language: scenario.language }, settled: false }])
      await expect(create(page)).toBeDisabled()
      await expect(cancel(page)).toBeDisabled()
      expect(await stored(page, scenario.language)).toEqual(before)
      await settle(app, 0)
      await expect(picker(page).getByRole('alert')).toHaveText('Document title cannot contain path separators, control characters, or dot segments')
      await expect(picker(page)).toHaveAttribute('aria-busy', 'false')
      await twoFrames(page)
      const failed = await record(page, app, info, `${scenario.language}-real-failure-before-error-frame-and-keyboard-assertions`)
      expectFrame(failed.state)
      expect(failed.state.error).not.toBeNull()
      expect(failed.state.error!.visibleRatio).toBeGreaterThanOrEqual(0.999)
      expect(failed.state.error!.centerHit).toBe(true)
      expect(failed.state.title!.visibleRatio).toBeGreaterThanOrEqual(0.999)
      expect(failed.state.title!.centerHit).toBe(true)
      await expect(title(page)).toBeFocused()
      await expect(title(page)).toHaveValue(invalidTitle)
      await expect(parent(page)).toHaveValue(ids.parentId)
      await expect(create(page)).toBeEnabled()
      await expect(cancel(page)).toBeEnabled()
      expect(failed.main.saved).toHaveLength(0)
      expect(failed.main.failures).toEqual(['Document title cannot contain path separators, control characters, or dot segments'])
      expect(await stored(page, scenario.language)).toEqual(before)

      const correctedTitle = `Created from ${scenario.language} scroll frame`
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type(correctedTitle)
      await page.keyboard.press('Enter')
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookTemplateScrollProbe!.requests.length)).toBe(2)
      const retry = await record(page, app, info, `${scenario.language}-keyboard-title-correction-retries-beta`)
      expectFrame(retry.state)
      expect(retry.main.calls[1]).toEqual({ input: { templateId: ids.betaId, title: correctedTitle, parentId: ids.parentId, language: scenario.language }, settled: false })
      await settle(app, 1)
      await expect(picker(page)).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText(correctedTitle)
      await twoFrames(page)
      const persisted = await stored(page, scenario.language)
      const added = persisted.catalog.filter(document => !before.catalog.some(original => original.id === document.id))
      expect(added).toHaveLength(1)
      expect(added[0]).toMatchObject({ title: correctedTitle, parentId: ids.parentId, path: `Scroll frame parent/${correctedTitle}` })
      const created = persisted.details.find(document => document?.id === added[0].id)!
      const beta = before.templates.find(template => template.id === ids.betaId)!
      expect(created.summary).toBe(beta.summary)
      expect(created.blocks.map(({ type, content, checked, depth }) => ({ type, content, checked, depth }))).toEqual(beta.blocks.map(({ type, content, checked, depth }) => ({ type, content, checked, depth })))
      expect(persisted.templates).toEqual(before.templates)
      expect(persisted.details.find(document => document?.id === ids.parentId)!.blocks).toEqual(before.details.find(document => document?.id === ids.parentId)!.blocks)
      const saved = await record(page, app, info, `${scenario.language}-one-real-created-document`)
      expect(saved.main.saved).toEqual([{ id: added[0].id }])
      expect(saved.main.calls).toHaveLength(2)

      await tabTo(page, opener(page), 'native-tab-to-reopen-template-dialog')
      await page.keyboard.press('Enter')
      await expect(picker(page)).toBeVisible()
      await expect(search(page)).toBeFocused()
      await page.keyboard.type('Scroll Frame Beta')
      await tabTo(page, item(page, 'Scroll Frame Beta'), 'native-tab-to-beta-before-cancel')
      await page.keyboard.press('Enter')
      await tabTo(page, title(page), 'native-tab-to-canceled-draft')
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type('Canceled scroll-frame draft')
      await chooseParent(page, ids.parentId)
      await tabTo(page, cancel(page), 'native-tab-to-fixed-cancel-button')
      const cancelReady = await record(page, app, info, `${scenario.language}-long-preview-cancel-ready`)
      expectFrame(cancelReady.state)
      await page.keyboard.press('Enter')
      await expect(picker(page)).toHaveCount(0)
      await twoFrames(page)
      const canceled = await record(page, app, info, `${scenario.language}-native-cancel-restores-opener-without-write`)
      await expect(opener(page)).toBeFocused()
      expect(canceled.main.calls).toHaveLength(2)
      expect(canceled.main.saved).toHaveLength(1)
      expect(await stored(page, scenario.language)).toEqual(persisted)
      expect(pageErrors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: scenario.language })
  })
}
