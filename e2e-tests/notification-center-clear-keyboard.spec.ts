import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { BackupResult } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Scenario = { language: 'en-US' | 'zh-CN'; theme: 'light' | 'dark'; viewport: { width: number; height: number } }
type Notice = { title: string; message: string; level: 'error'; persistent: true }
type BackupProbe = { calls: number; pending: Map<number, (result: BackupResult) => void>; completed: number[] }
type ProbeGlobal = typeof globalThis & { __knowbookCenterClearBackup?: BackupProbe }
type TabStop = { phase: string; step: number; tag: string | null; label: string | null; text: string | null; reached: boolean }
type ProbeWindow = Window & { __knowbookCenterClearRoute?: TabStop[] }
const needle = 'NotificationCenterClearNeedle'
const historyKey = 'knowbook.notification-history.v1'
const bell = (page: Page) => page.locator('.notification-bell')
const query = (page: Page) => page.getByLabel(uiText('Keywords', '关键词'), { exact: true })
const center = (page: Page) => page.getByRole('dialog', { name: uiText('Notification center', '通知中心'), exact: true })
const clear = (page: Page) => center(page).getByRole('button', { name: uiText('Clear completed', '清除已结束通知'), exact: true })
const close = (page: Page) => center(page).getByRole('button', { name: uiText('Close notification center', '关闭通知中心'), exact: true })

async function backupState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookCenterClearBackup
    return probe ? { calls: probe.calls, pending: [...probe.pending.keys()], completed: probe.completed } : null
  })
}

async function installBackupProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const probe: BackupProbe = { calls: 0, pending: new Map(), completed: [] }
    ;(globalThis as ProbeGlobal).__knowbookCenterClearBackup = probe
    ipcMain.removeHandler('knowbook:trigger-backup')
    ipcMain.handle('knowbook:trigger-backup', () => new Promise<BackupResult>(resolve => {
      probe.pending.set(++probe.calls, resolve)
    }))
  })
}

async function finishBackup(app: ElectronApplication) {
  await app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookCenterClearBackup!
    const resolve = probe.pending.get(1)
    if (!resolve) throw new Error('The original backup must remain pending until the fixture completes it')
    probe.pending.delete(1)
    probe.completed.push(1)
    // Complete the real renderer request after this main-process evaluation
    // returns; no filesystem export or native picker is needed by the fixture.
    setImmediate(() => resolve({ exported: 3, root: '/center-clear-backup-fixture', at: new Date().toISOString() }))
  })
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  const state = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const dialog = document.querySelector('.notification-center')
    const describe = (element: Element) => ({ id: element.getAttribute('data-notification-id'),
      title: element.querySelector('.app-notification-title')?.textContent,
      message: element.querySelector('.app-notification-message')?.textContent, className: element.className })
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      active: { tag: active?.tagName, label: active?.getAttribute('aria-label'),
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null,
        connected: active?.isConnected, disabled: active instanceof HTMLButtonElement ? active.disabled : null,
        insideCenter: Boolean(active && dialog?.contains(active)) },
      query: document.querySelector<HTMLInputElement>('.workspace-search-query input')?.value,
      cards: Array.from(document.querySelectorAll('.app-notifications > .app-notification')).map(describe),
      history: Array.from(document.querySelectorAll('.notification-center .app-notification')).map(describe),
      clearDisabled: document.querySelector<HTMLButtonElement>('.notification-center-toolbar button')?.disabled,
      cachedHistory: window.localStorage.getItem('knowbook.notification-history.v1'),
      route: (window as ProbeWindow).__knowbookCenterClearRoute ?? [] }
  })
  const body = JSON.stringify({ windows, backup: await backupState(app), state }, null, 2)
  writeFileSync(info.outputPath(`${phase}.json`), body, 'utf8')
  await info.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
}

async function tabTo(page: Page, target: Locator, app: ElectronApplication, info: TestInfo, phase: string) {
  let reached = false
  for (let step = 1; step <= 64; step++) {
    await page.keyboard.press('Tab')
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const stop: TabStop = { phase, step, reached: active === element, tag: active?.tagName ?? null,
        label: active?.getAttribute('aria-label') ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null }
      ;((window as ProbeWindow).__knowbookCenterClearRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached) break
  }
  await record(page, app, info, phase)
  expect(reached, 'Native Tab must reach the control without repairing focus').toBe(true)
  await expect(target).toBeFocused()
}

async function prepareWorkspace(page: Page, app: ElectronApplication, scenario: Scenario) {
  const originalDocument = await page.evaluate(async ({ language, theme, needle }) => {
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', theme)
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title: 'Notification center clearing sample', summary: 'Original summary', blocks: [
      { id: `${id}-body`, type: 'paragraph', content: `${needle} original content stays unchanged.`, checked: false, depth: 0 }
    ] })
    return (await window.knowbook.getDocumentDetail(id))!
  }, { ...scenario, needle })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize(scenario.viewport)
  await app.evaluate(({ BrowserWindow }, viewport) => {
    BrowserWindow.getAllWindows()[0].setContentSize(viewport.width, viewport.height)
  }, scenario.viewport)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(scenario.theme)
  return originalDocument
}

async function openSearch(page: Page) {
  await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
  await query(page).fill(needle)
  await expect(page.getByTestId('workspace-search-result')).toHaveCount(1)
  await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')
  await page.mouse.move(0, 0)
}

async function emitErrors(app: ElectronApplication, page: Page, scenario: Scenario) {
  const notices: Notice[] = [1, 2].map(index => ({ level: 'error', persistent: true,
    title: scenario.language === 'zh-CN' ? `可清理的已结束通知 ${index}` : `Completed notification to clear ${index}`,
    message: scenario.language === 'zh-CN' ? `第 ${index} 条已结束通知的原始详情。` : `Original details for completed notification ${index}.` }))
  for (const notice of notices) {
    await app.evaluate(({ BrowserWindow }, notice) => {
      BrowserWindow.getAllWindows()[0].webContents.send('knowbook:plugin-notification', notice)
    }, notice)
  }
  // Full toasts are hidden in a compact viewport; their real mounted owners
  // still carry the complete records. Only visible controls are used below.
  for (const notice of notices) await expect(page.locator('.app-notifications > .app-notification')
    .filter({ hasText: notice.title }).locator('.app-notification-message')).toHaveText(notice.message)
  return notices
}

async function openFromBell(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  await tabTo(page, bell(page), app, info, `${phase}-native-tab-to-bell`)
  await page.keyboard.press('Enter')
  await expect(center(page)).toBeVisible()
  await record(page, app, info, `${phase}-opened-before-close-focus-assertion`)
  await expect(close(page)).toBeFocused()
}

async function expectEmpty(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  await record(page, app, info, phase)
  await expect(center(page)).toBeVisible()
  await expect(center(page).locator('.app-notification')).toHaveCount(0)
  await expect(center(page).locator('.notification-center-empty')).toContainText(/No notifications yet|暂无通知/)
  await expect(clear(page)).toBeDisabled()
  await expect(close(page)).toBeFocused()
  expect(await page.evaluate(key => JSON.parse(window.localStorage.getItem(key) ?? '[]'), historyKey)).toEqual([])
}

async function verifyReloadedEmpty(page: Page, app: ElectronApplication, info: TestInfo) {
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await openSearch(page)
  await openFromBell(page, app, info, 'reloaded-cleared-history')
  await expectEmpty(page, app, info, 'reload-preserves-empty-notification-history')
  await page.keyboard.press('Escape')
  await record(page, app, info, 'reloaded-center-escaped-before-bell-focus-assertion')
  await expect(center(page)).toHaveCount(0)
  await expect(bell(page)).toBeFocused()
  await expect(query(page)).toHaveValue(needle)
}

const scenarios: Scenario[] = [
  { language: 'en-US', theme: 'light', viewport: { width: 1360, height: 880 } },
  { language: 'zh-CN', theme: 'dark', viewport: { width: 760, height: 640 } }
]

for (const scenario of scenarios) {
  test(`clearing completed notifications leaves native keyboard focus on Close (${scenario.language}) @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const originalDocument = await prepareWorkspace(page, app, scenario)
      await openSearch(page)
      const notices = await emitErrors(app, page, scenario)
      await openFromBell(page, app, info, 'completed-records')
      await expect(center(page).locator('.app-notification')).toHaveCount(notices.length)
      await expect(clear(page)).toBeEnabled()
      await tabTo(page, clear(page), app, info, 'native-tab-to-clear-completed')
      await page.keyboard.press('Enter')
      await expectEmpty(page, app, info, 'cleared-before-stable-close-focus-assertion')
      // Enter alone must close the center. Tab here would hide lost focus.
      await page.keyboard.press('Enter')
      await record(page, app, info, 'cleared-center-enter-closed-before-bell-focus-assertion')
      await expect(center(page)).toHaveCount(0)
      await expect(bell(page)).toBeFocused()
      await expect(query(page)).toHaveValue(needle)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), originalDocument.id)).toEqual(originalDocument)
      await verifyReloadedEmpty(page, app, info)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), originalDocument.id)).toEqual(originalDocument)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: scenario.language })
  })

  test(`clearing completed notifications preserves a real pending backup and its keyboard continuation (${scenario.language}) @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const originalDocument = await prepareWorkspace(page, app, scenario)
      await installBackupProbe(app)
      await page.getByTitle(uiText('Dashboard', '总览'), { exact: true }).click()
      const runBackup = page.getByRole('button', { name: uiText('Run backup now', '立即执行备份'), exact: true })
      await tabTo(page, runBackup, app, info, 'native-tab-to-start-real-backup')
      await page.keyboard.press('Enter')
      await expect.poll(() => backupState(app)).toEqual({ calls: 1, pending: [1], completed: [] })
      const runningToast = page.locator('.app-notifications > .app-notification.app-notification-progress')
      await expect(runningToast).toHaveCount(1)
      const backupId = (await runningToast.getAttribute('data-notification-id'))!
      const backupTitle = (await runningToast.locator('.app-notification-title').textContent())!
      await openSearch(page)
      const notices = await emitErrors(app, page, scenario)
      await openFromBell(page, app, info, 'running-backup-and-completed-records')
      await expect(center(page).locator('.app-notification')).toHaveCount(notices.length + 1)
      const task = center(page).locator(`.app-notification[data-notification-id="${backupId}"]`)
      await expect(task.getByRole('progressbar')).toBeVisible()
      await expect(task.locator('.app-notification-title')).toHaveText(backupTitle)
      await expect(clear(page)).toBeEnabled()
      await tabTo(page, clear(page), app, info, 'native-tab-to-clear-around-pending-backup')
      await page.keyboard.press('Enter')
      await record(page, app, info, 'completed-cleared-before-running-task-and-close-focus-assertions')
      await expect(center(page).locator('.app-notification')).toHaveCount(1)
      await expect(task.getByRole('progressbar')).toBeVisible()
      await expect(task.locator('.app-notification-title')).toHaveText(backupTitle)
      await expect(clear(page)).toBeDisabled()
      await expect(close(page)).toBeFocused()
      expect(await backupState(app)).toEqual({ calls: 1, pending: [1], completed: [] })
      await expect(query(page)).toHaveValue(needle)

      await page.keyboard.press('Enter')
      await record(page, app, info, 'running-task-retained-after-center-enter-close')
      await expect(center(page)).toHaveCount(0)
      await expect(bell(page)).toBeFocused()
      await expect(query(page)).toHaveValue(needle)
      expect(await backupState(app)).toEqual({ calls: 1, pending: [1], completed: [] })
      await page.keyboard.press('Enter')
      await expect(center(page)).toBeVisible()
      await record(page, app, info, 'reopened-center-with-original-pending-task')
      await expect(close(page)).toBeFocused()
      await expect(clear(page)).toBeDisabled()
      await expect(task.getByRole('progressbar')).toBeVisible()

      await finishBackup(app)
      await expect(task).toHaveClass(/app-notification-success/)
      await record(page, app, info, 'original-backup-completed-before-clear-enabled-and-unclaimed-focus-assertions')
      await expect(center(page).locator('.app-notification')).toHaveCount(1)
      await expect(task).toHaveAttribute('data-notification-id', backupId)
      await expect(task.locator('.app-notification-message')).toContainText(/Exported 3|已导出 3/)
      await expect(task.getByRole('progressbar')).toHaveCount(0)
      await expect(clear(page)).toBeEnabled()
      await expect(close(page)).toBeFocused()
      expect(await backupState(app)).toEqual({ calls: 1, pending: [], completed: [1] })
      await expect(query(page)).toHaveValue(needle)

      await tabTo(page, clear(page), app, info, 'native-tab-to-clear-original-backup-result')
      await page.keyboard.press('Enter')
      await expectEmpty(page, app, info, 'backup-result-cleared-before-stable-close-focus-assertion')
      await page.keyboard.press('Escape')
      await record(page, app, info, 'backup-result-cleared-center-escaped-before-bell-focus-assertion')
      await expect(center(page)).toHaveCount(0)
      await expect(bell(page)).toBeFocused()
      await expect(query(page)).toHaveValue(needle)
      expect(await backupState(app)).toEqual({ calls: 1, pending: [], completed: [1] })
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), originalDocument.id)).toEqual(originalDocument)
      await verifyReloadedEmpty(page, app, info)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), originalDocument.id)).toEqual(originalDocument)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: scenario.language })
  })
}
