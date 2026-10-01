import { expect, test, type Locator, type Page } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import type { SaveWebDavSyncConfig, WebDavSyncConfig, WebDavSyncStatus } from '../src/shared/webdav-sync'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type ReadHandler = (event: IpcMainInvokeEvent) => WebDavSyncStatus | Promise<WebDavSyncStatus>
type SaveHandler = (event: IpcMainInvokeEvent, input: SaveWebDavSyncConfig) => WebDavSyncStatus | Promise<WebDavSyncStatus>
type DeferredStatus = {
  event: IpcMainInvokeEvent
  resolve: (status: WebDavSyncStatus) => void
  reject: (error: Error) => void
}
type WebDavSettingsProbe = {
  originalRead: ReadHandler
  originalSave: SaveHandler
  readMode: 'pending' | 'failed' | 'live'
  pendingReads: DeferredStatus[]
  pendingSaves: Array<DeferredStatus & { input: SaveWebDavSyncConfig }>
  writes: SaveWebDavSyncConfig[]
}
type ProbeGlobal = typeof globalThis & { __knowbookWebDavSettingsProbe?: WebDavSettingsProbe }

const savedConfig: WebDavSyncConfig = {
  enabled: false,
  url: 'https://saved-webdav.example.invalid/dav/',
  username: 'saved-user',
  directory: 'KnowBook',
  intervalMinutes: 5,
  allowInsecureHttp: false
}

function settingsFields(section: Locator) {
  return {
    url: section.getByLabel(uiText('WebDAV URL', 'WebDAV 服务地址'), { exact: true }),
    username: section.getByLabel(uiText('Username', '用户名'), { exact: true }),
    password: section.getByLabel(uiText('App password', '应用密码'), { exact: true }),
    clearPassword: section.getByLabel(uiText('Clear saved password (disable automatic sync first)', '清除已保存的应用密码（请同时关闭自动同步）'), { exact: true }),
    directory: section.getByLabel(uiText('Remote sync folder', '远端同步目录'), { exact: true }),
    enabled: section.getByLabel(uiText('Automatic sync while the app is running', '启用自动同步（应用运行时）'), { exact: true }),
    interval: section.getByLabel(uiText('Sync interval (minutes)', '同步间隔（分钟）'), { exact: true }),
    insecure: section.getByLabel(uiText('Allow HTTP (unencrypted; trusted networks only)', '允许 HTTP（连接不加密，仅用于可信网络）'), { exact: true }),
    save: section.locator('.settings-actions button.primary-button'),
    testConnection: section.getByRole('button', { name: uiText('Test connection', '测试连接'), exact: true }),
    syncNow: section.getByRole('button', { name: uiText('Sync now', '立即同步'), exact: true }),
    stop: section.getByRole('button', { name: uiText('Stop this sync', '停止本次同步'), exact: true })
  }
}

async function openSettings(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Sync', '同步'), exact: true }).click()
  const section = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步'), exact: true })
  await expect(section).toBeVisible()
  return { section, fields: settingsFields(section) }
}

async function seedSettings(page: Page, language: 'en-US' | 'zh-CN') {
  await page.evaluate(async ({ config, language }) => {
    await window.knowbook.saveWebDavSyncConfig({ ...config, password: 'e2e-saved-webdav-password' })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
  }, { config: savedConfig, language })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', language === 'zh-CN' ? 'dark' : 'light')
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, ReadHandler | SaveHandler> })._invokeHandlers
    const originalRead = handlers.get('knowbook:get-webdav-sync-status') as ReadHandler
    const originalSave = handlers.get('knowbook:save-webdav-sync-config') as SaveHandler
    if (!originalRead || !originalSave) throw new Error('Missing real WebDAV settings IPC handler')
    const probe: WebDavSettingsProbe = {
      originalRead, originalSave, readMode: 'pending', pendingReads: [], pendingSaves: [], writes: []
    }
    ;(globalThis as ProbeGlobal).__knowbookWebDavSettingsProbe = probe
    ipcMain.removeHandler('knowbook:get-webdav-sync-status')
    ipcMain.handle('knowbook:get-webdav-sync-status', event => {
      if (probe.readMode === 'live') return probe.originalRead(event)
      if (probe.readMode === 'failed') throw new Error('Error: Controlled WebDAV settings read failure')
      return new Promise<WebDavSyncStatus>((resolve, reject) => probe.pendingReads.push({ event, resolve, reject }))
    })
    ipcMain.removeHandler('knowbook:save-webdav-sync-config')
    ipcMain.handle('knowbook:save-webdav-sync-config', (event, input: SaveWebDavSyncConfig) => {
      probe.writes.push({ ...input })
      return new Promise<WebDavSyncStatus>((resolve, reject) => probe.pendingSaves.push({ event, input, resolve, reject }))
    })
  })
}

async function readProbe(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookWebDavSettingsProbe!
    return { writes: probe.writes, pendingReads: probe.pendingReads.length, pendingSaves: probe.pendingSaves.length }
  })
}

async function finishReads(app: ElectronApplication, fail: boolean) {
  await app.evaluate(async (_electron, fail) => {
    const probe = (globalThis as ProbeGlobal).__knowbookWebDavSettingsProbe!
    probe.readMode = fail ? 'failed' : 'live'
    for (const pending of probe.pendingReads.splice(0)) {
      if (fail) pending.reject(new Error('Error: Controlled WebDAV settings read failure'))
      else {
        try { pending.resolve(await probe.originalRead(pending.event)) }
        catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
      }
    }
  }, fail)
}

async function prepareReadRetry(app: ElectronApplication) {
  await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookWebDavSettingsProbe!.readMode = 'pending' })
}

async function finishSave(app: ElectronApplication, fail = false) {
  await app.evaluate(async (_electron, fail) => {
    const probe = (globalThis as ProbeGlobal).__knowbookWebDavSettingsProbe!
    const pending = probe.pendingSaves.shift()
    if (!pending) throw new Error('No pending WebDAV settings save')
    if (fail) pending.reject(new Error('Error: Controlled WebDAV settings save failure'))
    else {
      try { pending.resolve(await probe.originalSave(pending.event, pending.input)) }
      catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
    }
  }, fail)
}

async function readPersistedConfig(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), {
      readonly: true, fileMustExist: true
    })
    try {
      const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get('sync.webdav.config') as { value: string } | undefined
      return row ? JSON.parse(row.value) as WebDavSyncConfig : null
    } finally { database.close() }
  })
}

async function expectNetworkActions(fields: ReturnType<typeof settingsFields>, enabled: boolean) {
  if (enabled) {
    await expect(fields.testConnection).toBeEnabled()
    await expect(fields.syncNow).toBeEnabled()
  } else {
    await expect(fields.testConnection).toBeDisabled()
    await expect(fields.syncNow).toBeDisabled()
  }
}

async function expectNativeBackground(app: ElectronApplication) {
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .some(window => window.isVisible() || window.isFocused() || window.isFocusable()))).toBe(false)
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`WebDAV settings recover, validate drafts and reliably save through real IPC (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page }) => {
      const isZh = language === 'zh-CN'
      await seedSettings(page, language)
      if (isZh) await page.setViewportSize({ width: 760, height: 850 })
      await installProbe(app)
      const now = new Date('2026-10-01T10:00:00Z')
      await page.clock.install({ time: now })
      await page.clock.pauseAt(new Date(now.getTime() + 1_000))
      const { section, fields } = await openSettings(page)
      const reload = section.getByRole('button', { name: uiText('Reload', '重新加载'), exact: true })
      const loading = section.getByRole('status').filter({ hasText: uiText('Loading sync settings…', '正在加载同步设置…') })
      await expect.poll(async () => (await readProbe(app)).pendingReads).toBe(1)
      await expect(loading).toBeVisible()
      await expect(section.locator('fieldset')).toHaveAttribute('disabled', '')
      await expect(fields.save).toBeDisabled()
      await finishReads(app, true)
      await expect(section.getByRole('alert')).toHaveText('Controlled WebDAV settings read failure')
      await expect(section.getByRole('status')).toHaveText(isZh
        ? '同步设置未加载，请重试。' : 'Sync settings are unavailable. Reload to retry.')
      await expect(fields.url).toBeDisabled()
      await expect(fields.save).toBeDisabled()
      expect((await readProbe(app)).writes).toHaveLength(0)
      if (isZh) await page.screenshot({ path: testInfo.outputPath('webdav-dark-narrow-read-error.png') })

      await prepareReadRetry(app)
      await reload.click()
      await expect.poll(async () => (await readProbe(app)).pendingReads).toBe(1)
      await expect(loading).toBeVisible()
      await finishReads(app, false)
      await expect(section.getByRole('alert')).toHaveCount(0)
      await page.clock.resume()
      await expect(fields.url).toHaveValue(savedConfig.url)
      await expect(fields.username).toHaveValue(savedConfig.username)
      await expect(fields.directory).toHaveValue(savedConfig.directory)
      await expect(fields.interval).toHaveValue('5')
      await expect(fields.password).toHaveValue('')
      await expect(fields.password).toHaveAttribute('type', 'password')
      await expect(fields.password).toHaveAttribute('placeholder', /Saved|已保存/)
      await expectNetworkActions(fields, true)
      await expect(fields.interval).toHaveAttribute('type', 'text')
      await expect(fields.interval).toHaveAttribute('inputmode', 'numeric')

      const intervalError = isZh
        ? '同步间隔应为 1–1440 分钟的整数。'
        : 'Sync interval must be a whole number from 1 to 1440 minutes.'
      for (const invalid of ['', '1.5', '0', '1441', 'e', '+5', '-5']) {
        await fields.interval.fill(invalid)
        await expect(fields.interval).toHaveValue(invalid)
        await expect(fields.interval).toHaveAttribute('aria-invalid', 'true')
        await expect(section.getByRole('alert')).toHaveText(intervalError)
        expect(await fields.interval.evaluate((input, message) => (input.getAttribute('aria-describedby') ?? '')
          .split(/\s+/).some(id => document.getElementById(id)?.textContent === message), intervalError)).toBe(true)
        await expect(fields.save).toBeDisabled()
        await fields.save.evaluate(button => (button as HTMLButtonElement).click())
        expect((await readProbe(app)).writes).toHaveLength(0)
      }
      if (!isZh) await page.screenshot({ path: testInfo.outputPath('webdav-light-invalid-interval.png') })
      await fields.interval.fill('05')
      await expect(fields.interval).not.toHaveAttribute('aria-invalid', 'true')
      await expect(section.getByRole('alert')).toHaveCount(0)
      await expectNetworkActions(fields, true)

      // Dirty state follows the current draft, including semantic interval equality and undone password edits.
      for (const [field, saved, changed] of [
        [fields.url, savedConfig.url, 'https://unsaved-webdav.example.invalid/dav/'],
        [fields.username, savedConfig.username, 'unsaved-user'],
        [fields.directory, savedConfig.directory, 'Unsaved-directory']
      ] as const) {
        await field.fill(changed)
        await expectNetworkActions(fields, false)
        await field.fill(saved)
        await expectNetworkActions(fields, true)
      }
      for (const toggle of [fields.enabled, fields.insecure]) {
        await toggle.check()
        await expectNetworkActions(fields, false)
        await toggle.uncheck()
        await expectNetworkActions(fields, true)
      }
      await fields.password.fill('e2e-withdrawn-password')
      await expectNetworkActions(fields, false)
      await fields.password.fill('')
      await expectNetworkActions(fields, true)
      await fields.clearPassword.check()
      await expectNetworkActions(fields, false)
      await fields.clearPassword.uncheck()
      await expectNetworkActions(fields, true)

      const input: SaveWebDavSyncConfig = {
        ...savedConfig, url: 'https://WEBDAV-SETTINGS.example.invalid/dav', username: ' updated-user ',
        directory: ' /Published/ ', intervalMinutes: 1, password: 'e2e-new-webdav-password'
      }
      await fields.url.fill(input.url)
      await fields.username.fill(input.username)
      await fields.directory.fill(input.directory)
      await fields.interval.fill('1')
      await fields.password.fill(input.password!)
      await expect(fields.save).toBeEnabled()
      await fields.save.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
      await expect.poll(async () => (await readProbe(app)).pendingSaves).toBe(1)
      expect((await readProbe(app)).writes).toEqual([input])
      await expect(section.locator('fieldset')).toHaveAttribute('disabled', '')
      for (const field of [fields.url, fields.username, fields.password, fields.clearPassword, fields.directory, fields.enabled, fields.interval, fields.insecure]) {
        await expect(field).toBeDisabled()
      }
      await expect(fields.save).toBeDisabled()
      await expect(fields.save).toHaveText(isZh ? '正在保存…' : 'Saving…')
      await expect(section.getByRole('status')).toHaveText(isZh ? '正在保存同步设置…' : 'Saving sync settings…')
      await expect(fields.stop).toHaveCount(0)
      await expectNetworkActions(fields, false)
      expect(await readPersistedConfig(app)).toEqual(savedConfig)
      if (isZh) {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('webdav-dark-narrow-saving.png') })
      }

      await finishSave(app, true)
      await expect(fields.save).toBeEnabled()
      await expect(section.getByRole('alert')).toHaveText('Controlled WebDAV settings save failure')
      await expect(fields.password).toHaveValue(input.password!)
      await expect(fields.url).toHaveValue(input.url)
      await expect(fields.username).toHaveValue(input.username)
      await expect(fields.directory).toHaveValue(input.directory)
      await expect(fields.interval).toHaveValue('1')
      await expect(fields.stop).toHaveCount(0)
      expect(await readPersistedConfig(app)).toEqual(savedConfig)
      await fields.save.click()
      await expect.poll(async () => (await readProbe(app)).pendingSaves).toBe(1)
      expect((await readProbe(app)).writes).toEqual([input, input])
      await finishSave(app)
      const normalized: WebDavSyncConfig = {
        ...savedConfig, url: 'https://webdav-settings.example.invalid/dav/', username: 'updated-user',
        directory: 'Published', intervalMinutes: 1
      }
      await expect(section.getByRole('alert')).toHaveCount(0)
      await expect(fields.save).toBeEnabled()
      await expect(fields.url).toHaveValue(normalized.url)
      await expect(fields.username).toHaveValue(normalized.username)
      await expect(fields.directory).toHaveValue(normalized.directory)
      await expect(fields.password).toHaveValue('')
      await expectNetworkActions(fields, true)
      expect(await readPersistedConfig(app)).toEqual(normalized)

      await fields.interval.fill('1440')
      await expect(fields.interval).not.toHaveAttribute('aria-invalid', 'true')
      await fields.save.click()
      await expect.poll(async () => (await readProbe(app)).pendingSaves).toBe(1)
      expect((await readProbe(app)).writes[2]).toEqual({ ...normalized, intervalMinutes: 1440 })
      await finishSave(app)
      await expect(fields.save).toBeEnabled()
      const persisted = { ...normalized, intervalMinutes: 1440 }
      expect(await readPersistedConfig(app)).toEqual(persisted)
      const realStatus = await page.evaluate(() => window.knowbook.getWebDavSyncStatus())
      expect(realStatus.config).toEqual(persisted)
      expect(realStatus.hasPassword).toBe(true)
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      const reopened = await openSettings(page)
      await expect(reopened.fields.interval).toHaveValue('1440')
      await expect(reopened.fields.url).toHaveValue(persisted.url)
      await expect(reopened.fields.password).toHaveValue('')
      await expect(reopened.fields.password).toHaveAttribute('placeholder', /Saved|已保存/)
      await expectNetworkActions(reopened.fields, true)
      await expectNativeBackground(app)
    })
  })
}
