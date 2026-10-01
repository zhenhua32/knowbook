import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { UpdateWebClipBridgeSettingsInput, WebClipBridgeStatus } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type ReadPhase = 'initial' | 'failed' | 'retry' | 'healthy' | 'refresh'
type BridgeProbe = {
  phase: ReadPhase
  status: WebClipBridgeStatus
  readCount: number
  writes: UpdateWebClipBridgeSettingsInput[]
  pendingReads: { resolve: (status: WebClipBridgeStatus) => void; reject: (error: Error) => void }[]
  pendingSave: { input: UpdateWebClipBridgeSettingsInput; resolve: (status: WebClipBridgeStatus) => void } | null
}
type BridgeProbeGlobal = typeof globalThis & { __knowbookBridgeSettingsProbe?: BridgeProbe }
type RealBridgeWritesGlobal = typeof globalThis & { __knowbookRealBridgeWrites?: UpdateWebClipBridgeSettingsInput[] }

async function dismissNotifications(page: Page) {
  const dismiss = page.locator('.app-notifications').getByRole('button', {
    name: uiText('Dismiss notification', '关闭通知'), exact: true
  })
  while (await dismiss.count()) await dismiss.first().click()
}

async function readStoredBridgeConfig(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), {
      readonly: true, fileMustExist: true
    })
    try {
      const readSetting = database.prepare('SELECT value FROM app_settings WHERE key = ?')
      return {
        enabled: (readSetting.get('webclip.bridge.enabled') as { value: string } | undefined)?.value ?? null,
        port: (readSetting.get('webclip.bridge.port') as { value: string } | undefined)?.value ?? null
      }
    } finally {
      database.close()
    }
  })
}

async function expectPortError(port: Locator, panel: Locator, message: string) {
  await expect(port).toHaveAttribute('aria-invalid', 'true')
  await expect(panel.getByText(message, { exact: true })).toBeVisible()
  expect(await port.evaluate((input, expectedMessage) => (input.getAttribute('aria-describedby') ?? '')
    .split(/\s+/).some(id => document.getElementById(id)?.textContent === expectedMessage), message)).toBe(true)
}

async function installBridgeProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const probe: BridgeProbe = {
      phase: 'initial',
      status: {
        enabled: true,
        running: true,
        port: 4321,
        configuredPort: 4321,
        token: 'restored-bridge-token',
        endpoint: 'http://127.0.0.1:4321/clip',
        lastError: null
      },
      readCount: 0,
      writes: [],
      pendingReads: [],
      pendingSave: null
    }
    ;(globalThis as BridgeProbeGlobal).__knowbookBridgeSettingsProbe = probe
    ipcMain.removeHandler('knowbook:get-web-clip-bridge-status')
    ipcMain.removeHandler('knowbook:update-web-clip-bridge-settings')
    ipcMain.handle('knowbook:get-web-clip-bridge-status', () => {
      probe.readCount++
      if (probe.phase === 'failed') throw new Error('Error: Bridge status read failed.')
      if (probe.phase === 'healthy') return { ...probe.status }
      return new Promise<WebClipBridgeStatus>((resolve, reject) => {
        probe.pendingReads.push({ resolve, reject })
      })
    })
    ipcMain.handle('knowbook:update-web-clip-bridge-settings', (_event, input: UpdateWebClipBridgeSettingsInput) => {
      probe.writes.push({ ...input })
      return new Promise<WebClipBridgeStatus>(resolve => { probe.pendingSave = { input, resolve } })
    })
  })
}

async function readProbe(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as BridgeProbeGlobal).__knowbookBridgeSettingsProbe!
    return { readCount: probe.readCount, writes: probe.writes, pendingReads: probe.pendingReads.length }
  })
}

async function setReadPhase(app: ElectronApplication, phase: ReadPhase) {
  await app.evaluate((_electron, nextPhase) => {
    ;(globalThis as BridgeProbeGlobal).__knowbookBridgeSettingsProbe!.phase = nextPhase
  }, phase)
}

async function finishReads(app: ElectronApplication, result: 'failure' | 'recovered' | 'refreshed') {
  await app.evaluate((_electron, nextResult) => {
    const probe = (globalThis as BridgeProbeGlobal).__knowbookBridgeSettingsProbe!
    probe.phase = nextResult === 'failure' ? 'failed' : 'healthy'
    if (nextResult === 'refreshed') probe.status.token = 'refreshed-bridge-token'
    for (const pending of probe.pendingReads.splice(0)) {
      if (nextResult === 'failure') pending.reject(new Error('Error: Bridge status read failed.'))
      else pending.resolve({ ...probe.status })
    }
  }, result)
}

async function finishSave(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as BridgeProbeGlobal).__knowbookBridgeSettingsProbe!
    const pending = probe.pendingSave!
    probe.pendingSave = null
    probe.status = pending.input.regenerateToken
      ? { ...probe.status, token: `${probe.status.token}-regenerated` }
      : {
          ...probe.status,
          enabled: pending.input.enabled,
          running: pending.input.enabled,
          configuredPort: pending.input.port,
          port: pending.input.enabled ? pending.input.port : null,
          endpoint: pending.input.enabled ? `http://127.0.0.1:${pending.input.port}/clip` : null
        }
    pending.resolve({ ...probe.status })
  })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`bridge settings recover the saved configuration and preserve unsaved drafts (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page }) => {
      await installBridgeProbe(app)
      await page.evaluate(async value => {
        await window.knowbook.saveSetting('ui.language', value)
        await window.knowbook.saveSetting('appearance.theme', value === 'zh-CN' ? 'dark' : 'light')
      }, language)
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      if (language === 'zh-CN') await page.setViewportSize({ width: 760, height: 850 })
      await expect(page.locator('html')).toHaveAttribute('data-theme', language === 'zh-CN' ? 'dark' : 'light')
      const clockTime = new Date('2026-10-01T10:00:00Z')
      await page.clock.install({ time: clockTime })
      await page.clock.pauseAt(new Date(clockTime.getTime() + 1_000))
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
      await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏'), exact: true }).click()

      const panel = page.getByRole('tabpanel', { name: uiText('Web clipping', '网页剪藏'), exact: true })
      const enabled = panel.getByLabel(uiText('Enable local web clip bridge service', '启用本地网页剪藏桥接服务'))
      const port = panel.getByLabel(uiText('Listening port', '监听端口'))
      const token = panel.getByLabel(uiText('Authorization token', '授权令牌'))
      const endpoint = panel.getByLabel(uiText('Extension endpoint', '扩展提交地址'))
      const save = panel.locator('button.primary-button')
      const regenerate = panel.getByRole('button', { name: uiText('Regenerate token', '重新生成令牌'), exact: true })
      const retry = panel.getByRole('button', { name: uiText('Retry loading', '重试读取'), exact: true })
      const loading = panel.getByRole('status').filter({ hasText: uiText('Reading bridge settings…', '正在读取桥接设置…') })
      const regenerating = panel.getByRole('status').filter({ hasText: uiText('Regenerating token…', '正在生成令牌…') })

      await expect.poll(async () => (await readProbe(app)).pendingReads).toBeGreaterThan(0)
      await expect(loading).toBeVisible()
      await expect(enabled).toBeDisabled()
      await expect(port).toBeDisabled()
      await expect(save).toBeDisabled()
      await expect(regenerate).toBeDisabled()
      await finishReads(app, 'failure')
      const loadError = panel.getByRole('alert')
      await expect(loadError).toContainText(language === 'zh-CN' ? '读取桥接设置失败。' : 'Failed to read bridge settings.')
      await expect(loading).toHaveCount(0)
      await expect(enabled).toBeDisabled()
      await expect(port).toBeDisabled()
      await expect(save).toBeDisabled()
      await expect(regenerate).toBeDisabled()
      await expect(retry).toBeEnabled()
      expect((await readProbe(app)).writes).toEqual([])
      await panel.locator('.settings-bridge-read-error').scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('bridge-settings-initial-error.png') })

      const beforeRetry = (await readProbe(app)).readCount
      await setReadPhase(app, 'retry')
      await retry.click()
      await expect.poll(async () => (await readProbe(app)).readCount).toBeGreaterThan(beforeRetry)
      await expect(loading).toBeVisible()
      await expect(enabled).toBeDisabled()
      await expect(port).toBeDisabled()
      await expect(save).toBeDisabled()
      await expect(regenerate).toBeDisabled()
      await expect(loadError).toBeVisible()
      await expect(retry).toBeDisabled()
      await finishReads(app, 'recovered')
      await expect(loadError).toHaveCount(0)
      await expect(loading).toHaveCount(0)
      await expect(enabled).toBeEnabled()
      await expect(enabled).toBeChecked()
      await expect(port).toBeEnabled()
      await expect(port).toHaveValue('4321')
      await expect(token).toHaveValue('restored-bridge-token')
      await expect(endpoint).toHaveValue('http://127.0.0.1:4321/clip')
      const portErrorMessage = language === 'zh-CN'
        ? '请输入 1–65535 之间的整数端口。' : 'Enter an integer port between 1 and 65535.'
      await expect(port).toHaveAttribute('type', 'text')
      await expect(port).toHaveAttribute('inputmode', 'numeric')
      await expect(port).toHaveAttribute('pattern', '[0-9]*')
      for (const draft of ['', '0', '65536', '4321.9', '1e4']) {
        await port.fill(draft)
        await expect(port).toHaveValue(draft)
        await expectPortError(port, panel, portErrorMessage)
        await expect(save).toBeDisabled()
        expect((await readProbe(app)).writes).toEqual([])
      }
      await panel.locator('.settings-bridge-port-error').scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('bridge-settings-invalid-port.png') })
      await port.fill('4321')
      await expect(port).not.toHaveAttribute('aria-invalid', 'true')
      await expect(panel.getByText(portErrorMessage, { exact: true })).toHaveCount(0)
      await expect(save).toBeEnabled()

      await save.click()
      await expect.poll(async () => (await readProbe(app)).writes).toEqual([
        { enabled: true, port: 4321, regenerateToken: false }
      ])
      await expect(enabled).toBeDisabled()
      await expect(port).toBeDisabled()
      await expect(save).toBeDisabled()
      await expect(regenerate).toBeDisabled()
      await finishSave(app)
      await expect(save).toBeEnabled()
      await expect(enabled).toBeChecked()
      await expect(port).toHaveValue('4321')
      await expect(endpoint).toHaveValue('http://127.0.0.1:4321/clip')

      await dismissNotifications(page)
      await enabled.uncheck()
      await expect(panel).toContainText(language === 'zh-CN'
        ? '重新生成令牌只更新已保存配置，未保存的修改会保留。'
        : 'Regenerating the token uses saved settings and preserves unsaved changes.')
      for (const draft of ['5432', '', '1e4']) {
        await dismissNotifications(page)
        await port.fill(draft)
        const beforeRegenerate = await readProbe(app)
        const previousToken = await token.inputValue()
        await expect(regenerate).toBeEnabled()
        await regenerate.click()
        await expect.poll(async () => (await readProbe(app)).writes).toEqual([
          ...beforeRegenerate.writes, { enabled: true, port: 4321, regenerateToken: true }
        ])
        await expect(enabled).toBeDisabled()
        await expect(port).toBeDisabled()
        await expect(regenerating).toBeVisible()
        await expect(regenerate).toHaveAttribute('aria-busy', 'true')
        await expect(save).toBeDisabled()
        await expect(save).toHaveText(language === 'zh-CN' ? '保存桥接设置' : 'Save bridge settings')
        await expect(enabled).not.toBeChecked()
        await expect(port).toHaveValue(draft)
        if (draft === '5432') await page.screenshot({ path: testInfo.outputPath('bridge-settings-regenerating-dirty.png') })
        await finishSave(app)
        await expect(regenerate).toBeEnabled()
        await expect(regenerate).not.toHaveAttribute('aria-busy', 'true')
        await expect(regenerating).toHaveCount(0)
        await expect(token).toHaveValue(`${previousToken}-regenerated`)
        await expect(endpoint).toHaveValue('http://127.0.0.1:4321/clip')
        await expect(enabled).not.toBeChecked()
        await expect(port).toHaveValue(draft)
        if (draft !== '5432') {
          await expectPortError(port, panel, portErrorMessage)
          await expect(save).toBeDisabled()
        }
      }
      const writesAfterRegeneration = (await readProbe(app)).writes
      const tokenAfterRegeneration = await token.inputValue()
      await dismissNotifications(page)
      await port.fill('5432')
      const beforeRefresh = (await readProbe(app)).readCount
      await setReadPhase(app, 'refresh')
      await page.clock.runFor(4_001)
      await expect.poll(async () => (await readProbe(app)).readCount).toBeGreaterThan(beforeRefresh)
      await expect(enabled).not.toBeChecked()
      await expect(port).toHaveValue('5432')
      await finishReads(app, 'failure')
      await expect(loadError).toBeVisible()
      await expect(panel).toContainText(language === 'zh-CN'
        ? '显示最近一次读取的状态，未保存的修改已保留。'
        : 'Showing the last loaded status. Unsaved changes are preserved.')
      await expect(token).toHaveValue(tokenAfterRegeneration)
      await expect(endpoint).toHaveValue('http://127.0.0.1:4321/clip')
      await expect(enabled).toBeEnabled()
      await expect(enabled).not.toBeChecked()
      await expect(port).toBeEnabled()
      await expect(port).toHaveValue('5432')
      await panel.locator('.settings-bridge-read-error').scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('bridge-settings-refresh-error-draft.png') })
      const beforeRefreshRetry = (await readProbe(app)).readCount
      await setReadPhase(app, 'retry')
      await retry.click()
      await expect.poll(async () => (await readProbe(app)).readCount).toBeGreaterThan(beforeRefreshRetry)
      await finishReads(app, 'refreshed')
      await expect(loadError).toHaveCount(0)
      await expect(token).toHaveValue('refreshed-bridge-token')
      await expect(endpoint).toHaveValue('http://127.0.0.1:4321/clip')
      await expect(enabled).not.toBeChecked()
      await expect(port).toHaveValue('5432')
      expect((await readProbe(app)).writes).toEqual(writesAfterRegeneration)
      await save.click()
      await expect.poll(async () => (await readProbe(app)).writes).toEqual([
        ...writesAfterRegeneration,
        { enabled: false, port: 5432, regenerateToken: false }
      ])
      await expect(save).toBeDisabled()
      await finishSave(app)
      await expect(save).toBeEnabled()
      await expect(enabled).not.toBeChecked()
      await expect(port).toHaveValue('5432')
      const nativeWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
      expect(nativeWindows.length).toBeGreaterThan(0)
      expect(nativeWindows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
    })
  })
}

test('a stopped bridge retains its configured port through real IPC reload and save @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    const seeded = await page.evaluate(() => window.knowbook.updateWebClipBridgeSettings({ enabled: false, port: 4321 }))
    expect(seeded).toMatchObject({ enabled: false, running: false, configuredPort: 4321, port: null, endpoint: null })
    for (const invalidPort of [0, -1, 65536, 4321.9, NaN, Infinity]) {
      const rejected = await page.evaluate(async value => {
        try {
          await window.knowbook.updateWebClipBridgeSettings({ enabled: false, port: value })
          return false
        } catch {
          return true
        }
      }, invalidPort)
      expect(rejected).toBe(true)
      expect(await page.evaluate(() => window.knowbook.getWebClipBridgeStatus())).toEqual(seeded)
      expect(await readStoredBridgeConfig(app)).toEqual({ enabled: 'false', port: '4321' })
    }
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏'), exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: uiText('Web clipping', '网页剪藏'), exact: true })
    const enabled = panel.getByLabel(uiText('Enable local web clip bridge service', '启用本地网页剪藏桥接服务'))
    const port = panel.getByLabel(uiText('Listening port', '监听端口'))
    const save = panel.getByRole('button', { name: uiText('Save bridge settings', '保存桥接设置'), exact: true })
    await expect(enabled).toBeEnabled()
    await expect(enabled).not.toBeChecked()
    await expect(port).toHaveValue('4321')
    await save.click()
    await expect(page.locator('.app-notifications')).toContainText(/Web clip bridge settings saved|网页剪藏桥接设置已保存/)
    await expect(save).toBeEnabled()
    await expect(enabled).not.toBeChecked()
    await expect(port).toHaveValue('4321')
    expect(await page.evaluate(() => window.knowbook.getWebClipBridgeStatus())).toMatchObject({
      enabled: false, running: false, configuredPort: 4321, port: null, endpoint: null
    })
    const tokenBeforeRegenerate = await page.evaluate(async () => (await window.knowbook.getWebClipBridgeStatus()).token)
    const regenerated = await page.evaluate(() => window.knowbook.updateWebClipBridgeSettings({
      enabled: true, port: 5432, regenerateToken: true
    }))
    expect(regenerated).toMatchObject({ enabled: false, running: false, configuredPort: 4321, port: null, endpoint: null })
    expect(regenerated.token).not.toBe(tokenBeforeRegenerate)
    expect(await readStoredBridgeConfig(app)).toEqual({ enabled: 'false', port: '4321' })
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏'), exact: true }).click()
    await expect(enabled).not.toBeChecked()
    await expect(port).toHaveValue('4321')
    await expect(panel.getByLabel(uiText('Authorization token', '授权令牌'))).toHaveValue(regenerated.token)
    const nativeWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
    expect(nativeWindows.length).toBeGreaterThan(0)
    expect(nativeWindows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  })
})

test('real bridge actions reject invalid drafts and rotate only saved settings while preserving edits @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    const seeded = await page.evaluate(async () => {
      await window.knowbook.saveSetting('ui.language', 'en-US')
      return window.knowbook.updateWebClipBridgeSettings({ enabled: false, port: 4321 })
    })
    // Record invocations without replacing the production mutation or persistence.
    await app.evaluate(({ ipcMain }) => {
      const channel = 'knowbook:update-web-clip-bridge-settings'
      const handlers = (ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, input: UpdateWebClipBridgeSettingsInput) => unknown>
      })._invokeHandlers
      const updateSettings = handlers.get(channel)!
      ;(globalThis as RealBridgeWritesGlobal).__knowbookRealBridgeWrites = []
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, input: UpdateWebClipBridgeSettingsInput) => {
        ;(globalThis as RealBridgeWritesGlobal).__knowbookRealBridgeWrites!.push({ ...input })
        return updateSettings(event, input)
      })
    })
    const writes = () => app.evaluate(() => (globalThis as RealBridgeWritesGlobal).__knowbookRealBridgeWrites!)
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    const clockTime = new Date('2026-10-01T10:00:00Z')
    await page.clock.install({ time: clockTime })
    await page.clock.pauseAt(new Date(clockTime.getTime() + 1_000))
    await page.getByTitle('Settings', { exact: true }).click()
    await page.getByRole('tab', { name: 'Web clipping', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: 'Web clipping', exact: true })
    const enabled = panel.getByLabel('Enable local web clip bridge service')
    const port = panel.getByLabel('Listening port')
    const token = panel.getByLabel('Authorization token')
    const endpoint = panel.getByLabel('Extension endpoint')
    const save = panel.locator('button.primary-button')
    const regenerate = panel.getByRole('button', { name: 'Regenerate token', exact: true })
    const portErrorMessage = 'Enter an integer port between 1 and 65535.'
    await expect(port).toHaveValue('4321')
    await expect(enabled).not.toBeChecked()
    for (const draft of ['', '0', '65536', '4321.9', '1e4']) {
      await port.fill(draft)
      await expect(port).toHaveValue(draft)
      await expectPortError(port, panel, portErrorMessage)
      await expect(save).toBeDisabled()
      expect(await writes()).toEqual([])
      expect(await page.evaluate(() => window.knowbook.getWebClipBridgeStatus())).toEqual(seeded)
    }
    await port.fill('4321')
    await expect(port).not.toHaveAttribute('aria-invalid', 'true')
    await expect(panel.getByText(portErrorMessage, { exact: true })).toHaveCount(0)
    await save.click()
    await expect.poll(writes).toEqual([{ enabled: false, port: 4321, regenerateToken: false }])
    await expect(save).toBeEnabled()
    await expect(port).toHaveValue('4321')
    await expect(panel).toContainText('Regenerating the token uses saved settings and preserves unsaved changes.')

    for (const draft of ['5432', '', '1e4']) {
      await dismissNotifications(page)
      await port.fill(draft)
      const previousToken = await token.inputValue()
      const previousWrites = await writes()
      await regenerate.click()
      await expect.poll(writes).toEqual([...previousWrites, { enabled: false, port: 4321, regenerateToken: true }])
      await expect.poll(() => token.inputValue()).not.toBe(previousToken)
      await expect(regenerate).toBeEnabled()
      await expect(port).toHaveValue(draft)
      await expect(enabled).not.toBeChecked()
      await expect(endpoint).toHaveValue('Not running yet')
      expect(await page.evaluate(() => window.knowbook.getWebClipBridgeStatus())).toMatchObject({
        enabled: false, configuredPort: 4321, port: null, endpoint: null, running: false
      })
      if (draft !== '5432') {
        await expectPortError(port, panel, portErrorMessage)
        await expect(save).toBeDisabled()
      }
    }
    await dismissNotifications(page)
    const beforeExternalRotation = await token.inputValue()
    const externallyRotated = await page.evaluate(() => window.knowbook.updateWebClipBridgeSettings({
      enabled: true, port: 5432, regenerateToken: true
    }))
    expect(externallyRotated.token).not.toBe(beforeExternalRotation)
    expect(externallyRotated).toMatchObject({ enabled: false, configuredPort: 4321, port: null, endpoint: null, running: false })
    await page.clock.runFor(4_001)
    await expect(token).toHaveValue(externallyRotated.token)
    await expect(port).toHaveValue('1e4')
    await expect(enabled).not.toBeChecked()
    await expectPortError(port, panel, portErrorMessage)
    await expect(save).toBeDisabled()
    await expect(endpoint).toHaveValue('Not running yet')
    expect(await readStoredBridgeConfig(app)).toEqual({ enabled: 'false', port: '4321' })
    const nativeWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
    expect(nativeWindows.length).toBeGreaterThan(0)
    expect(nativeWindows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  })
})
