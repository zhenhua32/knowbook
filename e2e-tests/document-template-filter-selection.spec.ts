import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { CreateDocumentFromTemplateInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { event: unknown; input: CreateDocumentFromTemplateInput; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; requests: Request[]; saved: unknown[]; failures: string[]; deleteCalls: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookTemplateSelectionProbe?: Probe }
const picker = (page: Page) => page.getByRole('dialog', { name: uiText('From template', '从模板新建'), exact: true })
const search = (page: Page) => picker(page).getByRole('searchbox', { name: uiText('Search templates', '搜索模板'), exact: true })
const title = (page: Page) => picker(page).getByRole('textbox', { name: uiText('Document title', '文档标题'), exact: true })
const parent = (page: Page) => picker(page).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true })
const create = (page: Page) => picker(page).getByRole('button', { name: uiText('Create document', '创建文档'), exact: true })
const item = (page: Page, name: string) => picker(page).locator('.document-template-item').filter({ has: page.getByText(name, { exact: true }) })

async function replaceQuery(page: Page, query: string) {
  await search(page).click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  if (query) await page.keyboard.type(query)
}

async function readStored(page: Page, language: 'en-US' | 'zh-CN') {
  return page.evaluate(async language => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return { catalog, details: await Promise.all(catalog.map(entry => window.knowbook.getDocumentDetail(entry.id))), templates: await window.knowbook.listDocumentTemplates(language) }
  }, language)
}

async function expectEmptySelection(page: Page) {
  await expect(picker(page).locator('.document-template-item')).toHaveCount(0)
  await expect(picker(page).locator('.document-template-preview')).toHaveCount(0)
  await expect(picker(page).getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true })).toHaveCount(0)
  await expect(title(page)).toHaveCount(0)
  await expect(parent(page)).toHaveCount(0)
  await expect(create(page)).toBeDisabled()
}

async function expectSelected(page: Page, name: 'Alpha' | 'Beta') {
  await expect(item(page, `Selection ${name}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(picker(page).locator('.document-template-item[aria-pressed="true"]')).toHaveCount(1)
  await expect(picker(page).locator('.document-template-preview')).toContainText(`${name} template body`)
  await expect(picker(page).locator('.document-template-preview')).not.toContainText(`${name === 'Alpha' ? 'Beta' : 'Alpha'} template body`)
  await expect(create(page)).toBeEnabled()
  await expect(picker(page).getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true })).toBeEnabled()
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('knowbook:create-document-from-template'), originalDelete = handlers.get('knowbook:delete-document-template')
    if (!original || !originalDelete) throw new Error('Real template handlers are required')
    const probe: Probe = { original, requests: [], saved: [], failures: [], deleteCalls: [] }
    ;(globalThis as ProbeGlobal).__knowbookTemplateSelectionProbe = probe
    ipcMain.removeHandler('knowbook:create-document-from-template')
    ipcMain.handle('knowbook:create-document-from-template', (event, input) => new Promise((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
    ipcMain.removeHandler('knowbook:delete-document-template')
    ipcMain.handle('knowbook:delete-document-template', (event, id) => {
      probe.deleteCalls.push(id)
      return originalDelete(event, id)
    })
  })
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookTemplateSelectionProbe!, request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real pending template creation is required')
    request.settled = true
    setImmediate(async () => {
      try { const result = await probe.original(request.event, request.input); probe.saved.push(result); request.resolve(result) }
      catch (reason) { const error = reason instanceof Error ? reason : new Error(String(reason)); probe.failures.push(error.message); request.reject(error) }
    })
  }, index)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookTemplateSelectionProbe!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds() })),
      calls: probe.requests.map(({ input, settled }) => ({ input, settled })), saved: probe.saved, failures: probe.failures, deleteCalls: probe.deleteCalls }
  })
  const state = await page.evaluate(() => {
    const modal = document.querySelector<HTMLDialogElement>('.document-template-dialog')
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const preview = modal?.querySelector('.document-template-preview'), formTitle = modal?.querySelector<HTMLInputElement>('[name="document-title"]'), select = modal?.querySelector<HTMLSelectElement>('select')
    return { viewport: { width: innerWidth, height: innerHeight }, modal: modal ? rect(modal) : null, ariaBusy: modal?.getAttribute('aria-busy') ?? null,
      active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), isBody: document.activeElement === document.body },
      query: modal?.querySelector<HTMLInputElement>('input[type="search"]')?.value ?? null,
      items: Array.from(modal?.querySelectorAll<HTMLButtonElement>('.document-template-item') ?? []).map(item => ({ name: item.querySelector('strong')?.textContent, pressed: item.getAttribute('aria-pressed'), rect: rect(item) })),
      emptyStates: Array.from(modal?.querySelectorAll('.document-capture-empty') ?? []).map(element => element.textContent),
      preview: preview ? { text: preview.textContent, rect: rect(preview) } : null,
      title: formTitle?.value ?? null, parentId: select?.value ?? null,
      fieldsetDisabled: modal?.querySelector('fieldset')?.disabled ?? null,
      error: modal?.querySelector('[role="alert"]')?.textContent ?? null,
      buttons: Array.from(modal?.querySelectorAll<HTMLButtonElement>('.document-template-delete,footer button') ?? []).map(button => ({ text: button.textContent, disabled: button.disabled, focused: document.activeElement === button, rect: rect(button) })) }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  return { main, state }
}

for (const language of ['en-US', 'zh-CN'] as const) {
test(`template filtering keeps preview and creation coherent in ${language} @electron`, async ({}, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const ids = await page.evaluate(async language => {
      const { id: parentId } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(parentId, { title: 'Template selection parent', summary: 'Keep this parent summary', blocks: [
        { id: `${parentId}-body`, type: 'paragraph', content: 'Keep this parent content', checked: false, depth: 0 }
      ] })
      const alpha = await window.knowbook.saveDocumentTemplate({ name: 'Selection Alpha', description: 'Alpha recipe only', title: 'Alpha automatic title', summary: 'Alpha template summary', blocks: [
        { id: 'alpha-body', type: 'paragraph', content: 'Alpha template body {{title}}', checked: false, depth: 0 }
      ] })
      const beta = await window.knowbook.saveDocumentTemplate({ name: 'Selection Beta', description: 'Beta recipe only', title: 'Beta automatic title', summary: 'Beta template summary', blocks: [
        { id: 'beta-body', type: 'paragraph', content: 'Beta template body {{title}}', checked: false, depth: 0 }
      ] })
      await window.knowbook.saveSetting('ui.language', language)
      await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
      return { parentId, alphaId: alpha.id, betaId: beta.id }
    }, language)
    await page.reload()
    await page.setViewportSize({ width: 1180, height: 850 })
    const before = await readStored(page, language)
    await installProbe(app)
    await page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true }).click()
    await expect(picker(page)).toBeVisible()
    await picker(page).getByRole('button', { name: uiText('Custom', '自定义模板'), exact: true }).click()
    const alpha = item(page, 'Selection Alpha')
    await expect(alpha).toHaveCount(1)
    await alpha.click()
    await expect(alpha).toHaveAttribute('aria-pressed', 'true')
    await expect(picker(page).locator('.document-template-preview')).toContainText('Alpha template body')
    await title(page).click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('Manual selection draft')
    await parent(page).selectOption(ids.parentId)
    await search(page).click()
    await page.keyboard.type('No template matches this exact query')
    await expect(picker(page).getByText(uiText('No matching templates', '没有匹配的模板'), { exact: true })).toBeVisible()

    // Capture the old stale Alpha preview/Create/Delete before the first new oracle.
    const noMatch = await record(page, app, testInfo, `${language}-no-match-after-custom-selection`)
    expect(noMatch.main.calls).toHaveLength(0)
    expect(noMatch.main.deleteCalls).toHaveLength(0)
    expect(noMatch.state.items).toHaveLength(0)
    await expectEmptySelection(page)
    await page.keyboard.press('Enter')
    const afterEnter = await record(page, app, testInfo, `${language}-no-match-enter-does-not-create`)
    expect(afterEnter.main.calls).toHaveLength(0)
    expect(afterEnter.main.deleteCalls).toHaveLength(0)
    expect(await readStored(page, language)).toEqual(before)

    await replaceQuery(page, 'Selection Beta')
    await expect(picker(page).locator('.document-template-item')).toHaveCount(1)
    await expectSelected(page, 'Beta')
    await expect(title(page)).toHaveValue('Manual selection draft')
    await expect(parent(page)).toHaveValue(ids.parentId)
    await record(page, app, testInfo, `${language}-only-beta-visible-and-effective`)
    await replaceQuery(page, '')
    await expectSelected(page, 'Alpha')
    await expect(title(page)).toHaveValue('Manual selection draft')
    await expect(parent(page)).toHaveValue(ids.parentId)
    await record(page, app, testInfo, `${language}-clear-query-restores-remembered-alpha`)

    // Category changes keep their existing intent; we only promise query memory within one category.
    await replaceQuery(page, 'Selection Alpha')
    await picker(page).getByRole('button', { name: uiText('Built-in', '内置模板'), exact: true }).click()
    await expect(picker(page).getByText(uiText('No matching templates', '没有匹配的模板'), { exact: true })).toBeVisible()
    await expectEmptySelection(page)
    await search(page).click()
    await page.keyboard.press('Enter')
    const emptyCategory = await record(page, app, testInfo, `${language}-category-and-query-have-no-effective-template`)
    expect(emptyCategory.main.calls).toHaveLength(0)
    expect(emptyCategory.main.deleteCalls).toHaveLength(0)
    await picker(page).getByRole('button', { name: uiText('Custom', '自定义模板'), exact: true }).click()
    await alpha.click()
    await replaceQuery(page, 'Selection Beta')
    await expectSelected(page, 'Beta')
    await expect(title(page)).toHaveValue('Manual selection draft')
    await expect(parent(page)).toHaveValue(ids.parentId)

    // The original handler validates this title; no artificial failure/result is returned.
    await title(page).click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('Invalid/template/title')
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookTemplateSelectionProbe!.requests.length)).toBe(1)
    await expect(picker(page)).toHaveAttribute('aria-busy', 'true')
    await expect(create(page)).toBeDisabled()
    await expect(title(page)).toBeDisabled()
    await expect(parent(page)).toBeDisabled()
    await expect(search(page)).toBeDisabled()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    const bounds = await create(page).boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    const pending = await record(page, app, testInfo, `${language}-beta-create-single-pending-request`)
    expect(pending.main.calls).toEqual([{ input: { templateId: ids.betaId, title: 'Invalid/template/title', parentId: ids.parentId, language }, settled: false }])
    expect(pending.state.fieldsetDisabled).toBe(true)
    await settle(app, 0)
    await expect(picker(page).getByRole('alert')).toHaveText('Document title cannot contain path separators, control characters, or dot segments')
    await expect(title(page)).toBeFocused()
    await expect(title(page)).toHaveValue('Invalid/template/title')
    await expect(parent(page)).toHaveValue(ids.parentId)
    await expect(search(page)).toHaveValue('Selection Beta')
    await expectSelected(page, 'Beta')
    const failed = await record(page, app, testInfo, `${language}-real-invalid-title-retains-beta-and-drafts`)
    expect(failed.main.saved).toEqual([])
    expect(failed.main.failures).toEqual(['Document title cannot contain path separators, control characters, or dot segments'])
    expect(await readStored(page, language)).toEqual(before)

    const correctedTitle = 'Created from visible Beta'
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(correctedTitle)
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookTemplateSelectionProbe!.requests.length)).toBe(2)
    const retry = await record(page, app, testInfo, `${language}-corrected-title-retries-effective-beta`)
    expect(retry.main.calls[1]).toEqual({ input: { templateId: ids.betaId, title: correctedTitle, parentId: ids.parentId, language }, settled: false })
    await settle(app, 1)
    await expect(picker(page)).toHaveCount(0)
    await expect(page.locator('.document-header-title')).toHaveText(correctedTitle)
    const persisted = await readStored(page, language)
    const added = persisted.catalog.filter(entry => !before.catalog.some(original => original.id === entry.id))
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ title: correctedTitle, parentId: ids.parentId, path: `Template selection parent/${correctedTitle}` })
    const note = persisted.details.find(detail => detail?.id === added[0].id)!
    expect(note.summary).toBe('Beta template summary')
    expect(note.blocks.map(({ type, content, checked, depth }) => ({ type, content, checked, depth }))).toEqual([
      { type: 'paragraph', content: `Beta template body ${correctedTitle}`, checked: false, depth: 0 }
    ])
    expect(note.blocks[0].id).not.toBe(before.templates.find(template => template.id === ids.betaId)!.blocks[0].id)
    expect(persisted.templates).toEqual(before.templates)
    expect(persisted.catalog.filter(entry => before.catalog.some(original => original.id === entry.id))).toEqual(
      before.catalog.map(entry => entry.id === ids.parentId ? { ...entry, childCount: entry.childCount + 1 } : entry))
    expect(before.details.map(original => persisted.details.find(detail => detail?.id === original!.id))).toEqual(
      before.details.map(original => original?.id === ids.parentId ? { ...original, children: [...original.children, { id: added[0].id, title: correctedTitle, path: added[0].path }] } : original))
    const saved = await record(page, app, testInfo, `${language}-one-real-beta-note-created`)
    expect(saved.main.calls).toHaveLength(2)
    expect(saved.main.saved).toEqual([{ id: added[0].id }])
    await page.reload()
    await expect(page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true })).toBeEnabled()
    expect(await readStored(page, language)).toEqual(persisted)

    // Deleting the effective B must neither delete nor forget the preferred A.
    await page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true }).click()
    await picker(page).getByRole('button', { name: uiText('Custom', '自定义模板'), exact: true }).click()
    await alpha.click()
    await title(page).click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('Preserved deletion draft')
    await parent(page).selectOption(ids.parentId)
    await replaceQuery(page, 'Selection Beta')
    await expectSelected(page, 'Beta')
    await record(page, app, testInfo, `${language}-delete-target-is-visible-beta-not-preferred-alpha`)
    await picker(page).getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true }).click()
    const confirmation = page.getByRole('alertdialog', { name: uiText('Delete template “Selection Beta”', '删除模板“Selection Beta”'), exact: true })
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(picker(page)).toHaveAttribute('aria-busy', 'false')
    await expect(search(page)).toHaveValue('Selection Beta')
    await expectEmptySelection(page)
    const deleted = await record(page, app, testInfo, `${language}-deleted-beta-leaves-filter-empty-and-creation-blocked`)
    expect(deleted.main.deleteCalls).toEqual([ids.betaId])
    expect(deleted.main.calls).toHaveLength(2)
    await replaceQuery(page, '')
    await expectSelected(page, 'Alpha')
    await expect(title(page)).toHaveValue('Preserved deletion draft')
    await expect(parent(page)).toHaveValue(ids.parentId)
    await record(page, app, testInfo, `${language}-delete-then-clear-still-restores-preferred-alpha`)
    const afterDelete = await readStored(page, language)
    expect(afterDelete).toEqual({ ...persisted, templates: before.templates.filter(template => template.id !== ids.betaId) })
    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true })).toBeEnabled()
    expect(await readStored(page, language)).toEqual(afterDelete)
    const final = await record(page, app, testInfo, `${language}-deleted-template-and-created-note-survive-reload`)
    expect(final.main.calls).toHaveLength(2)
    expect(final.main.saved).toEqual([{ id: added[0].id }])
    expect(final.main.deleteCalls).toEqual([ids.betaId])
    expect(errors).toEqual([])
  }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
})
}
