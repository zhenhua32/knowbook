import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type NativeHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown | Promise<unknown>
type PendingStatus = {
  event: IpcMainInvokeEvent
  resolve: (status: unknown) => void
  reject: (error: Error) => void
}
type FocusProbe = {
  originalRead: NativeHandler | null
  originalSave: NativeHandler
  readMode: 'pending' | 'failed' | 'live'
  reads: PendingStatus[]
  saves: Array<PendingStatus & { input: unknown }>
  saveCalls: number
}
type ProbeGlobal = typeof globalThis & { __knowbookSettingsFocusProbe?: FocusProbe }

async function seedWebDav(page: Page) {
  await page.evaluate(async () => {
    await window.knowbook.saveWebDavSyncConfig({ enabled: false, url: 'https://focus-webdav.example.invalid/dav/',
      username: 'focus-user', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: false,
      password: 'e2e-focus-password' })
    await window.knowbook.saveSetting('ui.language', 'en-US')
    await window.knowbook.saveSetting('appearance.theme', 'light')
  })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
}

async function openWebDav(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Sync', '同步'), exact: true }).click()
  const section = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步'), exact: true })
  await expect(section).toBeVisible()
  return {
    section,
    url: section.getByLabel('WebDAV URL', { exact: true }),
    username: section.getByLabel('Username', { exact: true }),
    save: section.locator('.settings-actions button.primary-button'),
    reload: section.getByRole('button', { name: 'Reload', exact: true })
  }
}

async function installProbe(app: ElectronApplication, feature: 'webdav' | 'bridge' | 'ai', gateReads = false) {
  await app.evaluate(({ ipcMain }, { feature, gateReads }) => {
    const channels = {
      webdav: { read: 'knowbook:get-webdav-sync-status', save: 'knowbook:save-webdav-sync-config' },
      bridge: { read: 'knowbook:get-web-clip-bridge-status', save: 'knowbook:update-web-clip-bridge-settings' },
      ai: { read: null, save: 'knowbook:update-ai-config' }
    }[feature]
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, NativeHandler> })._invokeHandlers
    const originalRead = channels.read ? handlers.get(channels.read)! : null
    const originalSave = handlers.get(channels.save)!
    if (!originalSave || (channels.read && !originalRead)) throw new Error('Missing real settings handler')
    const probe: FocusProbe = { originalRead, originalSave, readMode: gateReads ? 'pending' : 'live', reads: [], saves: [], saveCalls: 0 }
    ;(globalThis as ProbeGlobal).__knowbookSettingsFocusProbe = probe
    if (channels.read) {
      ipcMain.removeHandler(channels.read)
      ipcMain.handle(channels.read, event => {
        if (probe.readMode === 'live') return probe.originalRead!(event)
        if (probe.readMode === 'failed') throw new Error('Controlled settings read failure')
        return new Promise<unknown>((resolve, reject) => probe.reads.push({ event, resolve, reject }))
      })
    }
    ipcMain.removeHandler(channels.save)
    ipcMain.handle(channels.save, (event, input: unknown) => {
      probe.saveCalls++
      return new Promise<unknown>((resolve, reject) => probe.saves.push({ event, input, resolve, reject }))
    })
  }, { feature, gateReads })
}

async function readProbe(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookSettingsFocusProbe!
    return { reads: probe.reads.length, saves: probe.saves.length, saveCalls: probe.saveCalls }
  })
}

async function prepareRead(app: ElectronApplication) {
  await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookSettingsFocusProbe!.readMode = 'pending' })
}

async function finishReads(app: ElectronApplication, fail: boolean) {
  await app.evaluate(async (_electron, fail) => {
    const probe = (globalThis as ProbeGlobal).__knowbookSettingsFocusProbe!
    probe.readMode = fail ? 'failed' : 'live'
    for (const pending of probe.reads.splice(0)) {
      if (fail) pending.reject(new Error('Controlled settings read failure'))
      else {
        try { pending.resolve(await probe.originalRead!(pending.event)) }
        catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
      }
    }
  }, fail)
}

async function finishSave(app: ElectronApplication, fail: boolean) {
  await app.evaluate(async (_electron, fail) => {
    const probe = (globalThis as ProbeGlobal).__knowbookSettingsFocusProbe!
    const pending = probe.saves.shift()
    if (!pending) throw new Error('No pending settings save')
    if (fail) pending.reject(new Error('Controlled settings save failure'))
    else {
      try { pending.resolve(await probe.originalSave(pending.event, pending.input)) }
      catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
    }
  }, fail)
}

async function recordFocus(page: Page, app: ElectronApplication, testInfo: TestInfo, name: string) {
  const actual = await page.evaluate(() => {
    const element = document.activeElement
    return { tag: element?.tagName, id: element?.id, role: element?.getAttribute('role'),
      ariaLabel: element?.getAttribute('aria-label'), isBody: element === document.body }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const body = JSON.stringify({ actual, windows }, null, 2)
  console.log(`[settings-focus:${name}] ${body}`)
  await testInfo.attach(name, { body, contentType: 'application/json' })
}

async function enterAction(page: Page, target: Locator) {
  await target.focus()
  await expect(target).toBeFocused()
  await page.keyboard.press('Enter')
}

async function causeReadError(app: ElectronApplication, error: Locator) {
  await prepareRead(app)
  await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
  await finishReads(app, true)
  await expect(error).toContainText('Controlled settings read failure')
}

test('manual WebDAV Reload restores focus on failure and success while background or abandoned reads do not @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await seedWebDav(page)
    await installProbe(app, 'webdav', true)
    const { section, reload, url, username } = await openWebDav(page)
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    await finishReads(app, true)
    await expect(section.getByRole('alert')).toHaveText('Controlled settings read failure')
    await prepareRead(app)
    await enterAction(page, reload)
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    await expect(reload).toBeDisabled()
    await finishReads(app, true)
    await expect(reload).toBeEnabled()
    await expect(reload).toBeFocused()
    // Enter retries directly from the restored button without refocusing it.
    await prepareRead(app)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    await finishReads(app, false)
    await expect(reload).toHaveCount(0)
    await expect(url).toBeEnabled()
    await expect(url).toBeFocused()
    await recordFocus(page, app, testInfo, 'reload-success')
    await page.screenshot({ path: testInfo.outputPath('reload-success-focus.png') })

    // A successful automatic poll has no user action whose focus needs restoration.
    await username.focus()
    await prepareRead(app)
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    await finishReads(app, false)
    await expect(username).toBeFocused()

    // A known status leaves the inputs usable during Reload: preserve a user's new input focus.
    await causeReadError(app, section.getByRole('alert'))
    await prepareRead(app)
    await enterAction(page, reload)
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    await username.focus()
    await expect(username).toBeFocused()
    await finishReads(app, false)
    await expect(reload).toHaveCount(0)
    await expect(username).toBeFocused()

    // Categories retain the sync component; a late response must not focus its hidden input.
    await causeReadError(app, section.getByRole('alert'))
    await prepareRead(app)
    await enterAction(page, reload)
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    const general = page.getByRole('tab', { name: 'General', exact: true })
    await enterAction(page, general)
    await expect(section).toBeHidden()
    await finishReads(app, false)
    await expect(general).toBeFocused()

    await enterAction(page, page.getByRole('tab', { name: 'Sync', exact: true }))
    await causeReadError(app, section.getByRole('alert'))
    await prepareRead(app)
    await enterAction(page, reload)
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    const dashboard = page.getByTitle('Dashboard', { exact: true })
    await enterAction(page, dashboard)
    await expect(section).toHaveCount(0)
    await finishReads(app, false)
    await expect(dashboard).toBeFocused()
    await recordFocus(page, app, testInfo, 'reload-after-leaving-settings')
  })
})

test('WebDAV Save restores focus for Enter retry and success without reclaiming focus after navigation @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await seedWebDav(page)
    await installProbe(app, 'webdav')
    const { section, save, username } = await openWebDav(page)
    await expect(username).toHaveValue('focus-user')
    await username.fill('retry-user')
    await section.getByLabel('App password', { exact: true }).fill('e2e-focus-retry-password')
    await enterAction(page, save)
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    await expect(save).toBeDisabled()
    await finishSave(app, true)
    await expect(section.getByRole('alert')).toHaveText('Controlled settings save failure')
    await expect(save).toBeEnabled()
    await expect(save).toBeFocused()
    await recordFocus(page, app, testInfo, 'save-failure')
    await page.screenshot({ path: testInfo.outputPath('save-failure-focus.png') })
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    expect((await readProbe(app)).saveCalls).toBe(2)
    await finishSave(app, false)
    await expect(save).toBeEnabled()
    await expect(save).toBeFocused()
    await expect(section.getByLabel('App password', { exact: true })).toHaveValue('')

    await enterAction(page, save)
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    const general = page.getByRole('tab', { name: 'General', exact: true })
    await enterAction(page, general)
    await finishSave(app, false)
    await expect(general).toBeFocused()
    await enterAction(page, page.getByRole('tab', { name: 'Sync', exact: true }))
    await expect(save).toBeEnabled()
    await enterAction(page, save)
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    const dashboard = page.getByTitle('Dashboard', { exact: true })
    await enterAction(page, dashboard)
    await expect(section).toHaveCount(0)
    await finishSave(app, false)
    await expect(dashboard).toBeFocused()
    await recordFocus(page, app, testInfo, 'save-after-leaving-settings')
  })
})

test('bridge keyboard Reload and Save recover focus and announce saving without stealing a new focus @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await page.evaluate(async () => {
      await window.knowbook.updateWebClipBridgeSettings({ enabled: false, port: 4321, regenerateToken: false })
      await window.knowbook.saveSetting('ui.language', 'zh-CN')
      await window.knowbook.saveSetting('appearance.theme', 'dark')
    })
    await installProbe(app, 'bridge', true)
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.setViewportSize({ width: 760, height: 850 })
    await page.getByTitle('配置中心', { exact: true }).click()
    await page.getByRole('tab', { name: '网页剪藏', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: '网页剪藏', exact: true })
    const port = panel.getByLabel('监听端口', { exact: true })
    const endpoint = panel.getByLabel('扩展提交地址', { exact: true })
    const reload = panel.getByRole('button', { name: '重试读取', exact: true })
    const save = panel.locator('button.primary-button')
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    await finishReads(app, true)
    await expect(panel.getByRole('alert')).toContainText('Controlled settings read failure')
    await prepareRead(app)
    await enterAction(page, reload)
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    await finishReads(app, true)
    await expect(reload).toBeFocused()
    await prepareRead(app)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    await finishReads(app, false)
    await expect(reload).toHaveCount(0)
    await expect(port).toHaveValue('4321')
    await expect(port).toBeFocused()

    await enterAction(page, save)
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    await expect(save).toBeDisabled()
    await expect(save).toHaveAttribute('aria-busy', 'true')
    const saving = panel.getByRole('status').filter({ hasText: '正在保存桥接设置…' })
    await expect(saving).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('bridge-dark-narrow-saving-focus.png') })
    await finishSave(app, true)
    await expect(save).toBeEnabled()
    await expect(save).toBeFocused()
    await expect(saving).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    expect((await readProbe(app)).saveCalls).toBe(2)
    await finishSave(app, false)
    await expect(save).toBeEnabled()
    await expect(save).toBeFocused()
    await expect(save).toHaveAttribute('aria-busy', 'false')

    await enterAction(page, save)
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    await endpoint.focus()
    await expect(endpoint).toBeFocused()
    await finishSave(app, false)
    await expect(save).toBeEnabled()
    await expect(endpoint).toBeFocused()
    const general = page.getByRole('tab', { name: '通用', exact: true })
    await enterAction(page, general)
    await prepareRead(app)
    await expect.poll(async () => (await readProbe(app)).reads).toBe(1)
    await finishReads(app, false)
    await expect(general).toBeFocused()
    await recordFocus(page, app, testInfo, 'bridge-background-hidden-poll')
  })
})

test('AI Save restores its keyboard trigger but preserves category and page navigation during late replies @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await page.evaluate(async () => {
      await window.knowbook.updateAiConfig({ enabled: false, baseUrl: 'https://focus-ai.example.invalid/v1', model: 'focus-model',
        autoSummaryOnSave: false, relatedNotesEnabled: true, apiKey: 'e2e-focus-ai-key' })
      await window.knowbook.saveSetting('ui.language', 'en-US')
    })
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await installProbe(app, 'ai')
    await page.getByTitle('Settings', { exact: true }).click()
    const aiTab = page.getByRole('tab', { name: 'AI', exact: true })
    await aiTab.click()
    const panel = page.getByRole('tabpanel', { name: 'AI', exact: true })
    const save = panel.locator('.settings-actions button.primary-button')
    const model = panel.getByLabel('Model', { exact: true })
    await model.fill('keyboard-saved-model')
    await enterAction(page, save)
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    await expect(save).toBeDisabled()
    await finishSave(app, true)
    await expect(save).toBeEnabled()
    await expect(save).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    await finishSave(app, false)
    await expect(save).toBeEnabled()
    await expect(save).toBeFocused()

    await enterAction(page, save)
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    const general = page.getByRole('tab', { name: 'General', exact: true })
    await enterAction(page, general)
    await finishSave(app, false)
    await expect(general).toBeFocused()
    await enterAction(page, aiTab)
    await enterAction(page, save)
    await expect.poll(async () => (await readProbe(app)).saves).toBe(1)
    const dashboard = page.getByTitle('Dashboard', { exact: true })
    await enterAction(page, dashboard)
    await expect(panel).toHaveCount(0)
    await finishSave(app, false)
    await expect(dashboard).toBeFocused()
    await recordFocus(page, app, testInfo, 'ai-save-after-leaving-settings')
  })
})
