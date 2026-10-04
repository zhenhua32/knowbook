import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import type { AppUpdateState } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

// A packaged process can start autoUpdater before Playwright can replace its IPC handlers.
test.skip(Boolean(process.env.KNOWBOOK_E2E_EXECUTABLE?.trim()), 'Use the unpackaged build so no real startup update or download can run.')

type NativeRead = (event: IpcMainInvokeEvent) => AppUpdateState | Promise<AppUpdateState>
type PendingUpdate = { event: IpcMainInvokeEvent; resolve: (state: AppUpdateState) => void; reject: (error: Error) => void }
type UpdateProbe = {
  originalRead: NativeRead
  mode: 'pending' | 'failed' | 'snapshot' | 'real'
  snapshot: AppUpdateState
  reads: PendingUpdate[]
  checks: PendingUpdate[]
  readCalls: number
  checkCalls: number
  installCalls: number
}
type ProbeGlobal = typeof globalThis & { __knowbookUpdateReliabilityProbe?: UpdateProbe }

const readyState: AppUpdateState = {
  status: 'downloaded', currentVersion: '1.0.0', availableVersion: '1.1.0', downloadedVersion: '1.1.0',
  releaseName: 'Controlled release', releaseNotes: 'Review your update settings.\nDocument editing and sync reliability improvements.',
  checkedAt: '2026-10-02T00:00:00.000Z', progressPercent: 100, message: 'The controlled release is ready.',
  error: null, updatesEnabled: true, canInstall: true
}
const latestState: AppUpdateState = {
  ...readyState, status: 'not-available', availableVersion: null, downloadedVersion: null, releaseName: null,
  progressPercent: null, message: 'The controlled check found no update.', canInstall: false
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }, snapshot) => {
    const readChannel = 'knowbook:get-app-update-state'
    const originalRead = (ipcMain as unknown as { _invokeHandlers: Map<string, NativeRead> })._invokeHandlers.get(readChannel)
    if (!originalRead) throw new Error('Missing real update status handler')
    const probe: UpdateProbe = { originalRead, mode: 'pending', snapshot, reads: [], checks: [], readCalls: 0, checkCalls: 0, installCalls: 0 }
    ;(globalThis as ProbeGlobal).__knowbookUpdateReliabilityProbe = probe
    ipcMain.removeHandler(readChannel)
    ipcMain.handle(readChannel, event => {
      probe.readCalls++
      if (probe.mode === 'real') return probe.originalRead(event)
      if (probe.mode === 'snapshot') return probe.snapshot
      if (probe.mode === 'failed') throw new Error('Error: Controlled update status failure')
      return new Promise<AppUpdateState>((resolve, reject) => probe.reads.push({ event, resolve, reject }))
    })
    // Never delegate either mutation to electron-updater: checks may download, and installation can quit the app.
    ipcMain.removeHandler('knowbook:check-for-app-updates')
    ipcMain.handle('knowbook:check-for-app-updates', event => {
      probe.checkCalls++
      return new Promise<AppUpdateState>((resolve, reject) => probe.checks.push({ event, resolve, reject }))
    })
    ipcMain.removeHandler('knowbook:install-app-update')
    ipcMain.handle('knowbook:install-app-update', () => {
      probe.installCalls++
      throw new Error('The test must never install or restart the application')
    })
  }, readyState)
}

async function counts(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookUpdateReliabilityProbe!
    return { reads: probe.reads.length, checks: probe.checks.length, readCalls: probe.readCalls, checkCalls: probe.checkCalls, installCalls: probe.installCalls }
  })
}

async function setReadMode(app: ElectronApplication, mode: UpdateProbe['mode']) {
  await app.evaluate((_electron, mode) => { (globalThis as ProbeGlobal).__knowbookUpdateReliabilityProbe!.mode = mode }, mode)
}

async function finishRead(app: ElectronApplication, outcome: 'failure' | 'real' | AppUpdateState) {
  return app.evaluate(async (_electron, outcome) => {
    const probe = (globalThis as ProbeGlobal).__knowbookUpdateReliabilityProbe!
    const pending = probe.reads.shift()
    if (!pending) throw new Error('No pending update status read')
    if (outcome === 'failure') { pending.reject(new Error('Error: Controlled update status failure')); return null }
    const state = outcome === 'real' ? await probe.originalRead(pending.event) : outcome
    pending.resolve(state)
    return state
  }, outcome)
}

async function finishCheck(app: ElectronApplication, outcome: string | AppUpdateState) {
  await app.evaluate((_electron, outcome) => {
    const probe = (globalThis as ProbeGlobal).__knowbookUpdateReliabilityProbe!
    const pending = probe.checks.shift()
    if (!pending) throw new Error('No pending controlled update check')
    if (typeof outcome === 'string') pending.reject(new Error(`Error: ${outcome}`))
    else { probe.snapshot = outcome; pending.resolve(outcome) }
  }, outcome)
}

async function seed(page: Page, language: 'en-US' | 'zh-CN') {
  await page.evaluate(async language => {
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
  }, language)
}

async function pausePolling(page: Page) {
  const time = new Date('2026-10-02T00:00:00.000Z')
  await page.clock.install({ time })
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
}

async function openUpdates(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Updates', '更新'), exact: true }).click()
  const panel = page.locator('.settings-updates-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveRole('tabpanel')
  await expect(panel).toHaveAccessibleName(uiText('Updates', '更新'))
  return {
    panel,
    feedback: panel.locator('.settings-update-feedback'),
    buttons: panel.locator('.settings-actions'),
    reload: panel.getByRole('button', { name: uiText('Reload status', '重新加载状态'), exact: true }),
    check: panel.locator('.settings-actions > button').nth(1),
    install: panel.getByRole('button', { name: uiText('Install update and restart', '安装更新并重启'), exact: true })
  }
}

async function enter(page: Page, target: Locator, buttons: Locator) {
  await buttons.scrollIntoViewIfNeeded()
  await expect(target).toBeInViewport({ ratio: 1 })
  await target.focus()
  await expect(target).toBeFocused()
  await page.keyboard.press('Enter')
}

async function expectNearbyFeedback(feedback: Locator, buttons: Locator) {
  await expect(feedback).toBeInViewport({ ratio: 1 })
  await expect(buttons).toBeInViewport({ ratio: 1 })
  const feedbackBox = await feedback.boundingBox(), buttonsBox = await buttons.boundingBox()
  expect(feedbackBox).not.toBeNull()
  expect(buttonsBox).not.toBeNull()
  expect(feedbackBox!.y + feedbackBox!.height).toBeLessThanOrEqual(buttonsBox!.y + 1)
  expect(buttonsBox!.y - feedbackBox!.y - feedbackBox!.height).toBeLessThan(64)
}

async function record(page: Page, app: ElectronApplication, panel: Locator, testInfo: TestInfo, phase: string) {
  const publicState = await panel.evaluate(element => {
    const active = document.activeElement
    const feedback = element.querySelector('.settings-update-feedback')?.getBoundingClientRect()
    const buttons = element.querySelector('.settings-actions')?.getBoundingClientRect()
    return { viewport: { width: innerWidth, height: innerHeight }, activeTag: active?.tagName,
      activeText: active?.tagName === 'BUTTON' ? active.textContent : null,
      feedback: feedback?.toJSON(), buttons: buttons?.toJSON(), content: element.textContent }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const body = JSON.stringify({ publicState, windows, requests: await counts(app) }, null, 2)
  console.log(`[app-update-settings:${phase}] ${body}`)
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`unknown app-update settings require a successful reload before mutations (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page }) => {
      await seed(page, language)
      await installProbe(app)
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await pausePolling(page)
      await page.setViewportSize({ width: 760, height: language === 'zh-CN' ? 850 : 640 })
      const { panel, feedback, buttons, reload, check, install } = await openUpdates(page)
      await expect.poll(async () => (await counts(app)).reads).toBe(1)
      await expect(feedback.getByRole('status')).toHaveText(uiText('Loading...', '加载中...'))
      await expect(check).toBeDisabled()
      await expect(install).toBeDisabled()
      await expect(reload).toBeDisabled()
      await setReadMode(app, 'failed')
      await finishRead(app, 'failure')
      const readError = panel.locator('.settings-update-read-error')
      await expect(readError).toHaveText(language === 'zh-CN'
        ? '读取更新状态失败。 Controlled update status failure' : 'Failed to load update status. Controlled update status failure')
      await expect(panel.locator('.meta-grid')).toContainText(language === 'zh-CN'
        ? '更新状态尚未读取，请重新加载。' : 'Update status is unavailable. Reload to retry.')
      await expect(feedback.getByRole('status')).toHaveCount(0)
      await expect(check).toBeDisabled()
      await expect(install).toBeDisabled()
      await buttons.scrollIntoViewIfNeeded()
      await expectNearbyFeedback(feedback, buttons)
      await record(page, app, panel, testInfo, 'initial-read-failure')
      expect((await counts(app)).checkCalls).toBe(0)
      expect((await counts(app)).installCalls).toBe(0)
      await expect(page.locator('.app-notification-message').filter({ hasText: uiText('Update status refreshed.', '更新状态已刷新。') })).toHaveCount(0)

      await setReadMode(app, 'pending')
      await enter(page, reload, buttons)
      await expect.poll(async () => (await counts(app)).reads).toBe(1)
      const readCalls = (await counts(app)).readCalls
      await expect(reload).toHaveAttribute('aria-busy', 'true')
      await expect(reload).toBeDisabled()
      await page.clock.runFor(8000)
      expect((await counts(app)).readCalls).toBe(readCalls)
      expect((await counts(app)).reads).toBe(1)
      await setReadMode(app, 'real')
      const recovered = await finishRead(app, 'real')
      expect(recovered?.status).toBe('unsupported')
      expect(recovered?.updatesEnabled).toBe(false)
      await expect(readError).toHaveCount(0)
      await expect(feedback.getByRole('status')).toHaveCount(0)
      await expect(reload).toBeEnabled()
      await expect(reload).toBeFocused()
      await expect(panel.locator('.meta-grid')).toContainText(language === 'zh-CN'
        ? '自动更新只在打包后的桌面应用中可用。' : 'Auto updates are only available in packaged desktop builds.')
      await expect(check).toBeDisabled()
      await expect(install).toBeDisabled()
      expect((await counts(app)).installCalls).toBe(0)
      await expect(page.locator('.app-notification-message').filter({ hasText: uiText('Update status refreshed.', '更新状态已刷新。') })).toHaveCount(0)
      await expect(panel.locator('.settings-update-actions')).toBeInViewport({ ratio: 1 })
      await expect(buttons).toBeInViewport({ ratio: 1 })
      await record(page, app, panel, testInfo, 'real-unsupported-recovered')
      await page.clock.resume()
    })
  })
}

test('controlled update checks lock synchronously, recover in place and reject stale reads without stealing category focus @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await seed(page, 'en-US')
    await installProbe(app)
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await pausePolling(page)
    await page.setViewportSize({ width: 760, height: 640 })
    const { panel, feedback, buttons, check, install, reload } = await openUpdates(page)
    await expect.poll(async () => (await counts(app)).reads).toBe(1)
    await setReadMode(app, 'snapshot')
    await finishRead(app, readyState)
    await expect(check).toBeEnabled()
    await expect(install).toBeEnabled()
    await expect(panel.locator('.meta-grid')).toContainText('1.1.0')
    // Hold a prior polling read, then check. Its late 'checking' snapshot must not overwrite the check result.
    await setReadMode(app, 'pending')
    await page.clock.runFor(4000)
    await expect.poll(async () => (await counts(app)).reads).toBe(1)
    await buttons.scrollIntoViewIfNeeded()
    await check.focus()
    await expect(check).toBeFocused()
    await check.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
    await expect.poll(async () => (await counts(app)).checks).toBe(1)
    expect((await counts(app)).checkCalls).toBe(1)
    await expect(check).toHaveAttribute('aria-busy', 'true')
    await expect(check).toBeDisabled()
    await expect(install).toBeDisabled()
    await expect(reload).toBeDisabled()
    await expect(feedback.getByRole('status')).toHaveText('Checking...')
    await expect(panel.locator('.meta-grid')).toContainText('Checking for a newer version...')
    await expectNearbyFeedback(feedback, buttons)
    await record(page, app, panel, testInfo, 'check-pending')
    const readCalls = (await counts(app)).readCalls
    await page.clock.runFor(8000)
    expect((await counts(app)).readCalls).toBe(readCalls)

    await setReadMode(app, 'failed')
    await finishCheck(app, 'Controlled update check failure')
    const checkError = panel.locator('.settings-update-check-error')
    const readError = panel.locator('.settings-update-read-error')
    await expect(checkError).toHaveText('Failed to check for updates. Controlled update check failure')
    await expect(readError).toHaveText('Failed to load update status. Controlled update status failure')
    await expect(check).toBeEnabled()
    await expect(check).toBeFocused()
    await expect(install).toBeDisabled()
    await expect(panel.locator('.meta-grid')).not.toContainText('Checking for a newer version...')
    await record(page, app, panel, testInfo, 'check-failure-with-read-failure')
    await expectNearbyFeedback(feedback, buttons)
    expect(await check.evaluate(button => {
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return hit === button || Boolean(hit && button.contains(hit))
    })).toBe(true)
    await expect(page.locator('.app-notification-message').filter({ hasText: 'Update status refreshed.' })).toHaveCount(0)
    // Retry directly from the restored focused control, without scrolling to feedback or refocusing it.
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await counts(app)).checks).toBe(1)
    expect((await counts(app)).checkCalls).toBe(2)
    await setReadMode(app, 'snapshot')
    await finishCheck(app, latestState)
    await expect(check).toBeEnabled()
    await expect(check).toBeFocused()
    await expect(checkError).toHaveCount(0)
    await expect(readError).toHaveCount(0)
    await expect(panel.locator('.meta-grid')).toContainText('You already have the latest version.')
    // Compact windows also render a summary of the same notification. Count
    // actual notification records so the summary does not appear as a second check.
    await expect(page.locator('.app-notifications > .app-notification .app-notification-message')
      .filter({ hasText: 'Update status refreshed.' })).toHaveCount(1)
    await expect(page.getByTestId('notification-summary')).toContainText('Update status refreshed.')
    await finishRead(app, { ...readyState, status: 'checking', message: 'A stale read must not return.', canInstall: false })
    await expect(panel.locator('.meta-grid')).toContainText('You already have the latest version.')
    await expect(check).toBeEnabled()
    await page.clock.runFor(4000)
    await expect(check).toBeFocused()
    await expect(panel.locator('.meta-grid')).toContainText('You already have the latest version.')
    expect((await counts(app)).installCalls).toBe(0)
    await record(page, app, panel, testInfo, 'retry-success-stale-read-ignored')

    // A later check can settle in a hidden category, but its focus restoration must not move the user back.
    await enter(page, check, buttons)
    await expect.poll(async () => (await counts(app)).checks).toBe(1)
    const general = page.getByRole('tab', { name: 'General', exact: true })
    await general.click()
    await expect(general).toBeFocused()
    await finishCheck(app, latestState)
    await expect(general).toBeFocused()
    await expect(page.getByRole('tabpanel', { name: 'General', exact: true })).toBeVisible()
    await expect(panel).toBeHidden()
    expect((await counts(app)).checkCalls).toBe(3)
    expect((await counts(app)).installCalls).toBe(0)
    await record(page, app, panel, testInfo, 'category-keeps-focus')
    await page.clock.resume()
  })
})
