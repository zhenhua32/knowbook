import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateDocumentFromTemplateInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { event: unknown; input: CreateDocumentFromTemplateInput; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; requests: Request[]; saved: unknown[]; failures: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookCaptureFocusProbe?: Probe }
type FocusWindow = Window & { __knowbookTemplateFocusCalls?: Array<{ tag: string; name: string | null; className: string }> }
const picker = (page: Page) => page.getByRole('dialog', { name: uiText('From template', '从模板新建'), exact: true })
const title = (page: Page) => picker(page).locator('[name="document-title"]')
const preview = (page: Page) => picker(page).locator('.document-template-preview')
const completedFrames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

async function readStored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { catalog, documents: await Promise.all(catalog.map(entry => window.knowbook.getDocumentDetail(entry.id))),
      templates: await window.knowbook.listDocumentTemplates(language) }
  }, language)
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('knowbook:create-document-from-template')
    if (!original) throw new Error('The real template creation handler is required')
    const probe: Probe = { original, requests: [], saved: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookCaptureFocusProbe = probe
    ipcMain.removeHandler('knowbook:create-document-from-template')
    ipcMain.handle('knowbook:create-document-from-template', (event, input) => new Promise((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
  })
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookCaptureFocusProbe!, request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real pending template request is required')
    request.settled = true
    setImmediate(async () => {
      try { const saved = await probe.original(request.event, request.input); probe.saved.push(saved); request.resolve(saved) }
      catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); probe.failures.push(error.message); request.reject(error) }
    })
  }, index)
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookCaptureFocusProbe!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
      requests: probe.requests.map(({ input, settled }) => ({ input, settled })), saved: probe.saved, failures: probe.failures }
  })
  const state = await picker(page).evaluate(element => {
    const active = document.activeElement, preview = element.querySelector('.document-template-preview')!
    return { active: { tag: active?.tagName, isBody: active === document.body, isDialog: active === element },
      previewFocused: active === preview, busy: element.getAttribute('aria-busy'),
      controls: Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')).map(input => ({
        tag: input.tagName, name: input.getAttribute('name'), value: input.value, disabled: input.disabled, focused: active === input })),
      error: element.querySelector('[role="alert"]')?.textContent ?? '',
      focusCalls: (window as FocusWindow).__knowbookTemplateFocusCalls ?? [] }
  })
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await info.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { main, state }
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`a newer preview focus survives template creation failure in ${language} @electron`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const ids = await page.evaluate(async language => {
      const parent = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(parent.id, { title: 'Focus ownership parent', summary: 'Keep the original parent', blocks: [] })
      const template = await window.knowbook.saveDocumentTemplate({ name: 'Focus ownership template', title: 'Preview reading draft', summary: 'Preserved template',
        blocks: [{ id: 'focus-preview-paragraph', type: 'paragraph', content: 'Reading continues while creation is pending. Keep this original template body.', checked: false, depth: 0 }] })
      await window.knowbook.saveSetting('ui.language', language)
      await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
      return { parentId: parent.id, templateId: template.id }
    }, language)
    await page.reload()
    await page.setViewportSize({ width: 1180, height: 850 })
    const before = await readStored(page, language)
    await installProbe(app)
    await page.evaluate(() => {
      const nativeFocus = HTMLElement.prototype.focus
      ;(window as FocusWindow).__knowbookTemplateFocusCalls = []
      HTMLElement.prototype.focus = function (options) {
        ;(window as FocusWindow).__knowbookTemplateFocusCalls!.push({ tag: this.tagName, name: this.getAttribute('name'), className: this.className })
        nativeFocus.call(this, options)
      }
    })
    await page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true }).click()
    await picker(page).getByRole('button', { name: uiText('Custom', '自定义模板'), exact: true }).click()
    const template = picker(page).locator('.document-template-item').filter({ hasText: 'Focus ownership template' })
    await template.click()
    await expect(template).toHaveAttribute('aria-pressed', 'true')
    await picker(page).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true }).selectOption(ids.parentId)
    await title(page).fill('Invalid/template/title')
    await title(page).press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookCaptureFocusProbe!.requests.length)).toBe(1)
    await expect(picker(page)).toHaveAttribute('aria-busy', 'true')
    await expect(title(page)).toBeDisabled()
    // The preview is a real enabled article while the creation fields are busy.
    await preview(page).click()
    await expect(preview(page)).toBeFocused()
    const reading = await record(page, app, info, `${language}-newer-preview-focus-while-creation-is-pending`)
    expect(reading.main.requests).toEqual([{ input: { templateId: ids.templateId, title: 'Invalid/template/title', parentId: ids.parentId, language }, settled: false }])
    expect(await readStored(page, language)).toEqual(before)
    await settle(app, 0)
    await expect(picker(page).getByRole('alert')).toHaveText('Document title cannot contain path separators, control characters, or dot segments')
    await expect(picker(page)).toHaveAttribute('aria-busy', 'false')
    // Let the real completion frame run before checking the lasting focus owner.
    await completedFrames(page)
    const failed = await record(page, app, info, `${language}-real-failure-must-preserve-newer-preview-focus`)
    expect(failed.state.previewFocused).toBe(true)
    expect(failed.state.focusCalls).toEqual(reading.state.focusCalls)
    expect(failed.main.saved).toHaveLength(0)
    expect(failed.main.failures).toEqual(['Document title cannot contain path separators, control characters, or dot segments'])
    await expect(title(page)).toHaveValue('Invalid/template/title')
    expect(await readStored(page, language)).toEqual(before)

    // The user explicitly chooses the title again and retries the same template/parent.
    const correctedTitle = 'Created without interrupting preview'
    await title(page).click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(correctedTitle)
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookCaptureFocusProbe!.requests.length)).toBe(2)
    const retry = await record(page, app, info, `${language}-explicit-title-choice-retries-original-template`)
    expect(retry.main.requests[1]).toEqual({ input: { templateId: ids.templateId, title: correctedTitle, parentId: ids.parentId, language }, settled: false })
    await settle(app, 1)
    await expect(picker(page)).toHaveCount(0)
    await completedFrames(page)
    await expect(page.locator('.document-header-title')).toHaveText(correctedTitle)
    const persisted = await readStored(page, language)
    const added = persisted.catalog.filter(entry => !before.catalog.some(original => original.id === entry.id))
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ title: correctedTitle, parentId: ids.parentId, path: `Focus ownership parent/${correctedTitle}` })
    const created = persisted.documents.find(document => document?.id === added[0].id)!
    const originalTemplate = before.templates.find(template => template.id === ids.templateId)!
    expect(created.summary).toBe(originalTemplate.summary)
    expect(created.blocks.map(({ type, content, checked, depth }) => ({ type, content, checked, depth }))).toEqual(originalTemplate.blocks.map(({ type, content, checked, depth }) => ({ type, content, checked, depth })))
    expect(created.blocks[0].id).not.toBe('focus-preview-paragraph')
    expect(persisted.templates).toEqual(before.templates)
    expect(persisted.catalog.filter(entry => before.catalog.some(original => original.id === entry.id))).toEqual(before.catalog.map(entry => entry.id === ids.parentId ? { ...entry, childCount: entry.childCount + 1 } : entry))
    expect(before.documents.map(original => persisted.documents.find(document => document?.id === original!.id))).toEqual(before.documents.map(original => original?.id === ids.parentId ? { ...original, children: [...original.children, { id: added[0].id, title: correctedTitle, path: added[0].path }] } : original))

    // Without any newer input, failure still restores Title exactly once.
    await page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true }).click()
    await picker(page).getByRole('button', { name: uiText('Custom', '自定义模板'), exact: true }).click()
    await template.click()
    await picker(page).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true }).selectOption(ids.parentId)
    await title(page).fill('Invalid/template/title')
    await title(page).press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookCaptureFocusProbe!.requests.length)).toBe(3)
    const normalPending = await record(page, app, info, `${language}-normal-failure-has-no-newer-interaction`)
    await settle(app, 2)
    await expect(picker(page).getByRole('alert')).toHaveText('Document title cannot contain path separators, control characters, or dot segments')
    await completedFrames(page)
    await expect(title(page)).toBeFocused()
    const normalFailed = await record(page, app, info, `${language}-normal-failure-restores-title-once`)
    expect(normalFailed.state.focusCalls.filter(call => call.name === 'document-title').length).toBe(normalPending.state.focusCalls.filter(call => call.name === 'document-title').length + 1)
    expect(normalFailed.main.requests).toHaveLength(3)
    expect(normalFailed.main.saved).toEqual([{ id: added[0].id }])
    expect(normalFailed.main.failures).toHaveLength(2)
    await expect(title(page)).toHaveValue('Invalid/template/title')
    await expect(picker(page).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true })).toHaveValue(ids.parentId)
    expect(await readStored(page, language)).toEqual(persisted)
    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true })).toBeEnabled()
    expect(await readStored(page, language)).toEqual(persisted)
    expect(pageErrors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
