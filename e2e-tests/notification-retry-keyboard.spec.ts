import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { BackupResult } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type BackupRequest = { resolve: (result: BackupResult) => void; reject: (error: Error) => void }
type BackupProbe = { calls: number; pending: Map<number, BackupRequest>; failures: string[];
  completed: Array<{ attempt: number; outcome: 'error' | 'success' }> }
type ProbeGlobal = typeof globalThis & { __knowbookNotificationRetry?: BackupProbe }
type TabStop = { phase: string; step: number; tag: string | null; label: string | null; text: string | null; reached: boolean }
type ProbeWindow = Window & { __knowbookNotificationRetryRoute?: TabStop[]; __knowbookNotificationRetryExternal?: Element | null }

const center = (page: Page) => page.getByRole('dialog', { name: uiText('Notification center', '通知中心'), exact: true })
const toasts = (page: Page) => page.locator('.app-notifications')
const retry = (card: Locator) => card.getByRole('button', { name: uiText('Retry', '重试'), exact: true })

async function installBackupProbe(app: ElectronApplication, failures: string[]) {
  await app.evaluate(({ ipcMain }, failures) => {
    const probe: BackupProbe = { calls: 0, pending: new Map(), failures, completed: [] }
    ;(globalThis as ProbeGlobal).__knowbookNotificationRetry = probe
    ipcMain.removeHandler('knowbook:trigger-backup')
    ipcMain.handle('knowbook:trigger-backup', () => new Promise<BackupResult>((resolve, reject) => {
      probe.pending.set(++probe.calls, { resolve, reject })
    }))
  }, failures)
}

async function backupState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookNotificationRetry!
    return { calls: probe.calls, pending: [...probe.pending.keys()], completed: probe.completed }
  })
}

async function finishBackup(app: ElectronApplication, attempt: number) {
  await app.evaluate((_electron, attempt) => {
    const probe = (globalThis as ProbeGlobal).__knowbookNotificationRetry!
    const request = probe.pending.get(attempt)
    if (!request) throw new Error(`Backup attempt ${attempt} must be pending before it can finish`)
    probe.pending.delete(attempt)
    const reason = probe.failures[attempt - 1]
    probe.completed.push({ attempt, outcome: reason ? 'error' : 'success' })
    setImmediate(() => {
      if (reason) request.reject(new Error(`Error: ${reason}`))
      else request.resolve({ exported: 3, root: '/keyboard-backup-fixture', at: new Date().toISOString() })
    })
  }, attempt)
}

async function pendingAttempt(app: ElectronApplication, attempt: number) {
  await expect.poll(async () => {
    const state = await backupState(app)
    return { calls: state.calls, pending: state.pending }
  }).toEqual({ calls: attempt, pending: [attempt] })
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, app: ElectronApplication, info: TestInfo,
  phase: string, direction: 'Tab' | 'Shift+Tab' = 'Tab') {
  let reached = false
  for (let step = 1; step <= 64; step++) {
    await page.keyboard.press(direction)
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const reached = active === element
      const stop: TabStop = { phase, step, reached, tag: active?.tagName ?? null,
        label: active?.getAttribute('aria-label') ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null }
      ;((window as ProbeWindow).__knowbookNotificationRetryRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached) break
  }
  await record(page, app, info, phase)
  expect(reached, `Native ${direction} must reach the control without repairing focus`).toBe(true)
  await expect(target).toBeFocused()
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const describe = (element: Element) => ({ id: element.getAttribute('data-notification-id'),
      title: element.querySelector('.app-notification-title')?.textContent,
      message: element.querySelector('.app-notification-message')?.textContent,
      className: element.className, focused: Boolean(active && element.contains(active)),
      actions: Array.from(element.querySelectorAll<HTMLButtonElement>('.app-notification-actions button'))
        .map(button => ({ text: button.textContent, disabled: button.disabled, focused: button === active })) })
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      active: { tag: active?.tagName, text: active?.textContent?.trim(), label: active?.getAttribute('aria-label'),
        connected: active?.isConnected, notificationId: active?.closest('[data-notification-id]')?.getAttribute('data-notification-id') },
      externalFocusPreserved: active === (window as ProbeWindow).__knowbookNotificationRetryExternal,
      cards: Array.from(document.querySelectorAll('.app-notifications > .app-notification')).map(describe),
      summaries: Array.from(document.querySelectorAll('[data-testid="notification-summary"]')).map(describe),
      history: Array.from(document.querySelectorAll('.notification-center .app-notification')).map(describe),
      route: (window as ProbeWindow).__knowbookNotificationRetryRoute ?? [] }
  })
  const body = JSON.stringify({ windows, backup: await backupState(app), state }, null, 2)
  writeFileSync(info.outputPath(`${phase}.json`), body, 'utf8')
  await info.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
}

for (const scenario of [
  { language: 'en-US', compact: false, viewport: { width: 1360, height: 880 } },
  { language: 'zh-CN', compact: true, viewport: { width: 760, height: 640 } }
] as const) {
  test(`notification retry preserves keyboard ownership across repeated failures (${scenario.language}, ${scenario.compact ? 'center' : 'toast'}) @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const failures = [1, 2, 3].map(attempt => scenario.language === 'zh-CN'
        ? `第 ${attempt} 次备份失败。\n原始文档保持不变，可以再次重试。`
        : `Backup attempt ${attempt} failed.\nThe original documents are preserved; retry is available.`)
      await page.evaluate(async language => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
      }, scenario.language)
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize(scenario.viewport)
      await app.evaluate(({ BrowserWindow }, viewport) => {
        BrowserWindow.getAllWindows()[0].setContentSize(viewport.width, viewport.height)
      }, scenario.viewport)
      await twoFrames(page)
      await installBackupProbe(app, failures)
      await page.getByTitle(uiText('Dashboard', '总览'), { exact: true }).click()
      const runBackup = page.getByRole('button', { name: uiText('Run backup now', '立即执行备份'), exact: true })
      await tabTo(page, runBackup, app, info, 'native-tab-to-initial-backup')
      await page.keyboard.press('Enter')
      await pendingAttempt(app, 1)
      await finishBackup(app, 1)
      const initial = scenario.compact ? page.getByTestId('notification-summary')
        : toasts(page).locator('.app-notification').filter({ hasText: failures[0] })
      await expect(initial.locator('.app-notification-message')).toHaveText(failures[0])
      await expect(initial).toHaveCount(1)
      const recordId = (await initial.getAttribute('data-notification-id'))!
      // A newer independent notice makes the task move to the front of center
      // history when it updates, while the toast keeps its original slot.
      const sentinel = scenario.language === 'zh-CN'
        ? { title: '另一个通知保持不变', message: '重试备份不能覆盖或清除这条通知。', level: 'error' as const }
        : { title: 'Another notification is preserved', message: 'Retrying backup must not replace or clear this notification.', level: 'error' as const }
      await app.evaluate(({ BrowserWindow }, notification) => {
        BrowserWindow.getAllWindows()[0].webContents.send('knowbook:plugin-notification', notification)
      }, sentinel)
      const initialSentinel = toasts(page).locator('.app-notification').filter({ hasText: sentinel.title })
      await expect(initialSentinel).toHaveCount(1)
      const sentinelId = (await initialSentinel.getAttribute('data-notification-id'))!
      if (scenario.compact) {
        const view = page.getByTestId('notification-summary').getByRole('button', { name: '查看 2 条通知', exact: true })
        await tabTo(page, view, app, info, 'native-tab-to-compact-summary')
        await page.keyboard.press('Enter')
        await expect(center(page)).toBeVisible()
        await expect(toasts(page)).toHaveCount(0)
      }
      const list = scenario.compact ? center(page) : toasts(page)
      const card = list.locator(`.app-notification[data-notification-id="${recordId}"]`)
      const sentinelCard = list.locator(`.app-notification[data-notification-id="${sentinelId}"]`)
      await expect(list.locator('.app-notification')).toHaveCount(2)
      await expect(sentinelCard.locator('.app-notification-message')).toHaveText(sentinel.message)
      await tabTo(page, retry(card), app, info, 'native-tab-to-first-retry')
      await page.keyboard.press('Enter')
      await pendingAttempt(app, 2)
      await expect(card.getByRole('progressbar')).toBeVisible()
      await expect(card).toHaveAttribute('data-notification-id', recordId)
      await page.keyboard.press('Enter')
      await twoFrames(page)
      expect((await backupState(app)).calls).toBe(2)
      await record(page, app, info, 'second-attempt-pending-without-duplicate-enter')
      await finishBackup(app, 2)
      await expect(card.locator('.app-notification-message')).toHaveText(failures[1])
      // Observe before any further Tab/Enter. Moving focus here would hide the
      // regression caused by removing the retry action during progress.
      await record(page, app, info, 'second-failure-before-focus-retention-assertion')
      await expect(retry(card)).toBeEnabled()
      await expect(retry(card)).toBeFocused()
      await expect(list.locator('.app-notification')).toHaveCount(2)
      await page.keyboard.press('Enter')
      await pendingAttempt(app, 3)
      await expect(card.getByRole('progressbar')).toBeVisible()
      const external = scenario.compact
        ? center(page).getByRole('button', { name: '关闭通知中心', exact: true })
        : card.getByRole('button', { name: 'Dismiss notification', exact: true })
      await tabTo(page, external, app, info, 'native-tab-away-during-third-attempt', scenario.compact ? 'Shift+Tab' : 'Tab')
      expect(await external.evaluate(element => {
        ;(window as ProbeWindow).__knowbookNotificationRetryExternal = element
        return document.activeElement === element && !element.closest('.app-notification-actions')
      })).toBe(true)
      await finishBackup(app, 3)
      await expect(card.locator('.app-notification-message')).toHaveText(failures[2])
      await twoFrames(page)
      await record(page, app, info, 'third-failure-preserves-user-transferred-focus')
      await expect(external).toBeFocused()
      expect(await page.evaluate(() => document.activeElement === (window as ProbeWindow).__knowbookNotificationRetryExternal)).toBe(true)
      await expect(retry(card)).toBeEnabled()
      await expect(retry(card)).not.toBeFocused()
      expect((await backupState(app)).calls).toBe(3)
      await expect(list.locator('.app-notification')).toHaveCount(2)
      await expect(sentinelCard.locator('.app-notification-message')).toHaveText(sentinel.message)
      await tabTo(page, retry(card), app, info, 'native-tab-back-to-final-retry')
      await page.keyboard.press('Enter')
      await pendingAttempt(app, 4)
      await finishBackup(app, 4)
      await expect(card).toHaveClass(/app-notification-success/)
      await expect(card.locator('.app-notification-message')).toContainText(/Exported 3|已导出 3/)
      await expect(retry(card)).toHaveCount(0)
      await expect(card).toHaveAttribute('data-notification-id', recordId)
      await expect(list.locator('.app-notification')).toHaveCount(2)
      await expect(sentinelCard).toHaveAttribute('data-notification-id', sentinelId)
      await expect(sentinelCard.locator('.app-notification-title')).toHaveText(sentinel.title)
      await expect(sentinelCard.locator('.app-notification-message')).toHaveText(sentinel.message)
      await twoFrames(page)
      await record(page, app, info, 'fourth-attempt-succeeds-with-two-preserved-records-and-usable-focus')
      expect(await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null
        return Boolean(active && active !== document.body && active !== document.documentElement && active.isConnected
          && !active.matches(':disabled') && active.getClientRects().length
          && getComputedStyle(active).visibility !== 'hidden')
      })).toBe(true)
      expect(await backupState(app)).toEqual({ calls: 4, pending: [], completed: [
        { attempt: 1, outcome: 'error' }, { attempt: 2, outcome: 'error' },
        { attempt: 3, outcome: 'error' }, { attempt: 4, outcome: 'success' }
      ] })
      if (scenario.compact) {
        await expect(center(page)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(center(page)).toHaveCount(0)
        await expect(page.locator('.notification-bell')).toBeFocused()
      }
    }, { PLAYWRIGHT_ELECTRON_LOCALE: scenario.language })
  })
}
