import { expect, test, type Locator, type Page } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import type { AiConfig, HomeData, UpdateAiConfigInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type UpdateHandler = (event: IpcMainInvokeEvent, input: UpdateAiConfigInput) => AiConfig | Promise<AiConfig>
type HomeHandler = (event: IpcMainInvokeEvent) => HomeData | Promise<HomeData>
type AiSettingsProbe = {
  originalUpdate: UpdateHandler
  originalHome: HomeHandler | null
  writes: UpdateAiConfigInput[]
  pendingUpdates: {
    event: IpcMainInvokeEvent
    input: UpdateAiConfigInput
    resolve: (config: AiConfig) => void
    reject: (error: Error) => void
  }[]
  pendingHome: { event: IpcMainInvokeEvent; resolve: (home: HomeData) => void; reject: (error: Error) => void }[]
}
type AiSettingsProbeGlobal = typeof globalThis & { __knowbookAiSettingsProbe?: AiSettingsProbe }
type AiDraft = Omit<AiConfig, 'hasApiKey'> & { apiKey: string }
type AiFields = ReturnType<typeof aiFields>

const savedConfig: Omit<AiConfig, 'hasApiKey'> = {
  enabled: false,
  baseUrl: 'https://saved-ai.example.invalid/v1',
  model: 'saved-model',
  autoSummaryOnSave: false,
  relatedNotesEnabled: true
}
const dirtyDraft: AiDraft = {
  enabled: true,
  baseUrl: 'https://draft-ai.example.invalid/v1',
  model: 'draft-model',
  autoSummaryOnSave: true,
  relatedNotesEnabled: false,
  apiKey: 'e2e-unsaved-new-key'
}

function aiFields(panel: Locator) {
  return {
    enabled: panel.getByLabel(uiText('Enable AI features', '启用 AI 功能'), { exact: true }),
    autoSummary: panel.getByLabel(uiText('Auto-generate summary when summary is empty', '摘要为空时自动生成摘要'), { exact: true }),
    relatedNotes: panel.getByLabel(uiText('Retrieve related notes when asking AI', '询问 AI 时检索相关笔记'), { exact: true }),
    baseUrl: panel.getByLabel(uiText('Base URL', '基础地址'), { exact: true }),
    model: panel.getByLabel(uiText('Model', '模型'), { exact: true }),
    apiKey: panel.getByLabel(uiText('API Key (leave blank to keep current)', 'API Key（留空表示保持当前值）'), { exact: true }),
    save: panel.locator('.settings-actions button.primary-button'),
    clear: panel.locator('.settings-inline-field button.secondary-button')
  }
}

async function openAiSettings(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: 'AI', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: 'AI', exact: true, includeHidden: true })
  await expect(panel).toBeVisible()
  return { panel, fields: aiFields(panel) }
}

async function seedSettings(page: Page, language: 'en-US' | 'zh-CN' = 'en-US') {
  await page.evaluate(async ({ config, language }) => {
    await window.knowbook.updateAiConfig({ ...config, apiKey: 'e2e-original-key' })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
  }, { config: savedConfig, language })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', language === 'zh-CN' ? 'dark' : 'light')
}

async function setDraft(fields: AiFields, draft: AiDraft) {
  await fields.enabled.setChecked(draft.enabled)
  await fields.autoSummary.setChecked(draft.autoSummaryOnSave)
  await fields.relatedNotes.setChecked(draft.relatedNotesEnabled)
  await fields.baseUrl.fill(draft.baseUrl)
  await fields.model.fill(draft.model)
  await fields.apiKey.fill(draft.apiKey)
}

async function expectDraft(fields: AiFields, draft: AiDraft) {
  await expect(fields.enabled).toBeChecked({ checked: draft.enabled })
  await expect(fields.autoSummary).toBeChecked({ checked: draft.autoSummaryOnSave })
  await expect(fields.relatedNotes).toBeChecked({ checked: draft.relatedNotesEnabled })
  await expect(fields.baseUrl).toHaveValue(draft.baseUrl)
  await expect(fields.model).toHaveValue(draft.model)
  await expect(fields.apiKey).toHaveValue(draft.apiKey)
}

async function expectMutationLocked(panel: Locator, fields: AiFields, clearing: boolean) {
  await expect(panel.locator('.settings-form-fields')).toHaveAttribute('aria-busy', 'true')
  await expect(panel).not.toHaveAttribute('aria-busy', 'true')
  for (const input of [fields.enabled, fields.autoSummary, fields.relatedNotes, fields.baseUrl, fields.model, fields.apiKey]) {
    await expect(input).toBeDisabled()
  }
  await expect(fields.save).toBeDisabled()
  await expect(fields.clear).toBeDisabled()
  await expect(fields.save).toHaveAttribute('aria-busy', String(!clearing))
  await expect(fields.clear).toHaveAttribute('aria-busy', String(clearing))
  const status = panel.getByRole('status', { includeHidden: true })
  await expect(status).toHaveText(clearing
    ? uiText('Clearing the saved API key…', '正在清除已保存的 API Key…')
    : uiText('Saving AI settings…', '正在保存 AI 设置…'))
  await expectNoBusyAncestor(status)
}

async function expectNoBusyAncestor(feedback: Locator) {
  await expect(feedback).toHaveCount(1)
  expect(await feedback.evaluate(element => element.closest('[aria-busy="true"]') !== null)).toBe(false)
}

async function dismissNotifications(page: Page) {
  const dismiss = page.locator('.app-notifications').getByRole('button', {
    name: uiText('Dismiss notification', '关闭通知'), exact: true
  })
  while (await dismiss.count()) await dismiss.first().click()
}

async function expectNativeBackground(app: ElectronApplication) {
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))).toEqual(expect.arrayContaining([{ visible: false, focused: false, focusable: false }]))
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .some(window => window.isVisible() || window.isFocused() || window.isFocusable()))).toBe(false)
}

async function installAiProbe(app: ElectronApplication, holdHome = false) {
  await app.evaluate(({ ipcMain }, holdHome) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, UpdateHandler | HomeHandler> })._invokeHandlers
    const originalUpdate = handlers.get('knowbook:update-ai-config') as UpdateHandler
    const originalHome = holdHome ? handlers.get('knowbook:get-home-data') as HomeHandler : null
    if (!originalUpdate || (holdHome && !originalHome)) throw new Error('Missing real AI settings IPC handler')
    const probe: AiSettingsProbe = {
      originalUpdate, originalHome, writes: [], pendingUpdates: [], pendingHome: []
    }
    ;(globalThis as AiSettingsProbeGlobal).__knowbookAiSettingsProbe = probe
    ipcMain.removeHandler('knowbook:update-ai-config')
    ipcMain.handle('knowbook:update-ai-config', (event, input: UpdateAiConfigInput) => {
      probe.writes.push({ ...input })
      return new Promise<AiConfig>((resolve, reject) => probe.pendingUpdates.push({ event, input, resolve, reject }))
    })
    if (holdHome) {
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', event => new Promise<HomeData>((resolve, reject) => {
        probe.pendingHome.push({ event, resolve, reject })
      }))
    }
  }, holdHome)
}

async function readProbe(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as AiSettingsProbeGlobal).__knowbookAiSettingsProbe!
    return { writes: probe.writes, pendingUpdates: probe.pendingUpdates.length, pendingHome: probe.pendingHome.length }
  })
}

async function finishUpdate(app: ElectronApplication, failure?: string) {
  await app.evaluate(async (_electron, failure) => {
    const probe = (globalThis as AiSettingsProbeGlobal).__knowbookAiSettingsProbe!
    const pending = probe.pendingUpdates.shift()
    if (!pending) throw new Error('No pending AI settings update')
    if (failure) {
      pending.reject(new Error(`Error: ${failure}`))
      return
    }
    try { pending.resolve(await probe.originalUpdate(pending.event, pending.input)) }
    catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
  }, failure ?? null)
}

async function restoreHandlers(app: ElectronApplication) {
  await app.evaluate(async ({ ipcMain }) => {
    const probe = (globalThis as AiSettingsProbeGlobal).__knowbookAiSettingsProbe!
    ipcMain.removeHandler('knowbook:update-ai-config')
    ipcMain.handle('knowbook:update-ai-config', probe.originalUpdate)
    if (probe.originalHome) {
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', probe.originalHome)
      for (const pending of probe.pendingHome.splice(0)) {
        try { pending.resolve(await probe.originalHome(pending.event)) }
        catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
      }
    }
  })
}

// Read only public settings and an opaque digest. Neither plaintext nor encrypted API keys leave the main process.
async function readStoredAiConfig(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const { createHash } = process.getBuiltinModule('node:crypto')
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), {
      readonly: true, fileMustExist: true
    })
    try {
      const statement = database.prepare('SELECT value FROM app_settings WHERE key = ?')
      const value = (key: string) => (statement.get(key) as { value: string } | undefined)?.value ?? null
      const storedKey = value('ai.apiKey')
      return {
        enabled: value('ai.enabled') === 'true',
        baseUrl: value('ai.baseUrl'),
        model: value('ai.model'),
        autoSummaryOnSave: value('ai.autoSummaryOnSave') === 'true',
        relatedNotesEnabled: value('ai.relatedNotesEnabled') === 'true',
        hasApiKey: Boolean(storedKey),
        keyProtected: Boolean(storedKey?.startsWith('safe-storage:v1:')),
        keyDigest: storedKey ? createHash('sha256').update(storedKey).digest('hex') : null
      }
    } finally { database.close() }
  })
}

test('AI settings lock every draft during saving and retain the new key after failure before a real retry @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await seedSettings(page)
    const { panel, fields } = await openAiSettings(page)
    const before = await readStoredAiConfig(app)
    await installAiProbe(app)
    await setDraft(fields, dirtyDraft)
    await fields.save.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
    await expect.poll(async () => (await readProbe(app)).pendingUpdates).toBe(1)
    await expectMutationLocked(panel, fields, false)
    await fields.clear.evaluate(button => (button as HTMLButtonElement).click())
    expect((await readProbe(app)).writes).toEqual([dirtyDraft])
    expect(await readStoredAiConfig(app)).toEqual(before)
    await page.screenshot({ path: testInfo.outputPath('ai-settings-light-saving.png') })

    await finishUpdate(app, 'Controlled AI settings save failure')
    await expect(fields.save).toBeEnabled()
    await expect(fields.clear).toBeEnabled()
    await expect(panel.locator('.settings-form-fields')).toHaveAttribute('aria-busy', 'false')
    await expect(panel).not.toHaveAttribute('aria-busy', 'true')
    const saveError = panel.locator('.settings-ai-save-error')
    await expect(saveError).toHaveText('Controlled AI settings save failure')
    await expectNoBusyAncestor(saveError)
    await expectDraft(fields, dirtyDraft)
    await expect(page.locator('.app-notifications')).toContainText('Controlled AI settings save failure')
    expect(await readStoredAiConfig(app)).toEqual(before)
    await page.screenshot({ path: testInfo.outputPath('ai-settings-light-save-error.png') })
    await dismissNotifications(page)

    await fields.save.click()
    await expect.poll(async () => (await readProbe(app)).writes.length).toBe(2)
    await finishUpdate(app)
    await expect(fields.save).toBeEnabled()
    await expectDraft(fields, { ...dirtyDraft, apiKey: '' })
    const after = await readStoredAiConfig(app)
    const { apiKey: _apiKey, ...savedDraft } = dirtyDraft
    expect(after).toMatchObject({ ...savedDraft, hasApiKey: true, keyProtected: true })
    expect(after.keyDigest).not.toBe(before.keyDigest)
    await restoreHandlers(app)
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    expect((await page.evaluate(() => window.knowbook.getHomeData())).aiConfig).toEqual({ ...savedDraft, hasApiKey: true })
    const reopened = await openAiSettings(page)
    await expectDraft(reopened.fields, { ...dirtyDraft, apiKey: '' })
    await expectNativeBackground(app)
  })
})

test('a key-only save clears its draft from the real IPC result without waiting for home-data refresh @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await seedSettings(page)
    const { panel, fields } = await openAiSettings(page)
    const before = await readStoredAiConfig(app)
    await installAiProbe(app, true)
    await fields.apiKey.fill('e2e-key-only-replacement')
    await fields.save.click()
    await expect.poll(async () => (await readProbe(app)).pendingUpdates).toBe(1)
    await expectMutationLocked(panel, fields, false)
    expect((await readProbe(app)).writes).toEqual([{ ...savedConfig, apiKey: 'e2e-key-only-replacement' }])
    await finishUpdate(app)
    // Home-data responses remain held here: a public AiConfig response must finish the operation itself.
    await expect(fields.save).toBeEnabled()
    await expect(fields.apiKey).toHaveValue('')
    await expectDraft(fields, { ...savedConfig, apiKey: '' })
    const after = await readStoredAiConfig(app)
    expect(after).toMatchObject({ ...savedConfig, hasApiKey: true, keyProtected: true })
    expect(after.keyDigest).not.toBe(before.keyDigest)
    await restoreHandlers(app)
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    const publicConfig = (await page.evaluate(() => window.knowbook.getHomeData())).aiConfig
    expect(publicConfig).toEqual({ ...savedConfig, hasApiKey: true })
    expect(Object.keys(publicConfig)).not.toContain('apiKey')
    const reopened = await openAiSettings(page)
    await expectDraft(reopened.fields, { ...savedConfig, apiKey: '' })
    await expectNativeBackground(app)
  })
})

test('clearing an AI key cancels safely, retries the saved configuration and preserves unrelated dirty drafts @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await seedSettings(page, 'zh-CN')
    await page.setViewportSize({ width: 760, height: 850 })
    const { panel, fields } = await openAiSettings(page)
    const before = await readStoredAiConfig(app)
    await installAiProbe(app)
    await setDraft(fields, dirtyDraft)
    const dialog = page.getByRole('alertdialog', { name: '清除 API Key', exact: true })

    await fields.clear.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await expect(panel.locator('.settings-form-fields')).toHaveAttribute('aria-busy', 'false')
    await expect(panel).not.toHaveAttribute('aria-busy', 'true')
    // The confirmation session already owns the operation lock, even before the mutation starts.
    await fields.save.evaluate(button => (button as HTMLButtonElement).click())
    expect((await readProbe(app)).writes).toHaveLength(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(fields.clear).toBeFocused()
    await expectDraft(fields, dirtyDraft)
    expect(await readStoredAiConfig(app)).toEqual(before)

    const latestSavedConfig = { ...savedConfig, baseUrl: 'https://latest-ai.example.invalid/v1', model: 'latest-saved-model' }
    await setDraft(fields, { ...latestSavedConfig, apiKey: 'e2e-latest-saved-key' })
    await fields.save.click()
    await expect.poll(async () => (await readProbe(app)).pendingUpdates).toBe(1)
    await finishUpdate(app)
    await expect(fields.save).toBeEnabled()
    await expectDraft(fields, { ...latestSavedConfig, apiKey: '' })
    const beforeClear = await readStoredAiConfig(app)
    expect(beforeClear).toMatchObject({ ...latestSavedConfig, hasApiKey: true, keyProtected: true })
    await dismissNotifications(page)
    await setDraft(fields, dirtyDraft)
    await fields.clear.click()
    await dialog.getByRole('button', { name: '清除 API Key', exact: true }).click()
    await expect.poll(async () => (await readProbe(app)).pendingUpdates).toBe(1)
    const clearPayload = { ...latestSavedConfig, clearApiKey: true }
    expect((await readProbe(app)).writes).toEqual([{ ...latestSavedConfig, apiKey: 'e2e-latest-saved-key' }, clearPayload])
    await expectMutationLocked(panel, fields, true)
    await expect(fields.save).toHaveText('保存 AI 设置')
    await expect(fields.clear).toHaveText('正在清除…')
    await expect(dialog).toHaveAttribute('aria-busy', 'true')
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
    await expect(dialog).toBeVisible()
    expect((await readProbe(app)).writes).toHaveLength(2)
    expect(await readStoredAiConfig(app)).toEqual(beforeClear)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('ai-settings-dark-narrow-clearing.png') })

    await finishUpdate(app, 'Controlled API key clear failure')
    await expect(dialog.getByRole('alert')).toHaveText('Controlled API key clear failure')
    await expect(panel.locator('.settings-form-fields')).toHaveAttribute('aria-busy', 'false')
    await expect(panel).not.toHaveAttribute('aria-busy', 'true')
    await expectNoBusyAncestor(dialog.getByRole('alert'))
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await expect(fields.apiKey).toHaveValue(dirtyDraft.apiKey)
    expect(await readStoredAiConfig(app)).toEqual(beforeClear)
    await page.screenshot({ path: testInfo.outputPath('ai-settings-dark-narrow-clear-error.png') })
    await dialog.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(async () => (await readProbe(app)).pendingUpdates).toBe(1)
    expect((await readProbe(app)).writes.slice(1)).toEqual([clearPayload, clearPayload])
    await expectMutationLocked(panel, fields, true)
    // New keyboard activity revokes automatic failure-focus recovery. Exercise
    // the pending keyboard guard on the successful retry, after the first
    // failure has verified its undisturbed return to Cancel.
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    expect((await readProbe(app)).writes).toHaveLength(3)
    expect(await readStoredAiConfig(app)).toEqual(beforeClear)
    await finishUpdate(app)
    await expect(dialog).toHaveCount(0)
    await expect(fields.clear).toBeFocused()
    await expect(fields.save).toBeEnabled()
    await expectDraft(fields, { ...dirtyDraft, apiKey: '' })
    expect(await readStoredAiConfig(app)).toEqual({
      ...latestSavedConfig, hasApiKey: false, keyProtected: false, keyDigest: null
    })
    await expect(fields.apiKey).toBeVisible()
    await fields.save.scrollIntoViewIfNeeded()
    await expect(fields.save).toBeInViewport()
    await restoreHandlers(app)

    // Exercise the real main-process contract directly: clearApiKey cannot persist a client's dirty settings.
    await page.evaluate(config => window.knowbook.updateAiConfig({ ...config, apiKey: 'e2e-main-protection-key' }), savedConfig)
    expect((await readStoredAiConfig(app)).hasApiKey).toBe(true)
    const clearResult = await page.evaluate(draft => window.knowbook.updateAiConfig({ ...draft, clearApiKey: true }), dirtyDraft)
    expect(clearResult).toEqual({ ...savedConfig, hasApiKey: false })
    expect(await readStoredAiConfig(app)).toEqual({
      ...savedConfig, hasApiKey: false, keyProtected: false, keyDigest: null
    })
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    expect((await page.evaluate(() => window.knowbook.getHomeData())).aiConfig).toEqual({ ...savedConfig, hasApiKey: false })
    const reopened = await openAiSettings(page)
    await expectDraft(reopened.fields, { ...savedConfig, apiKey: '' })
    await expectNativeBackground(app)
  })
})
