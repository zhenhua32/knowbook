import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Notice = { title: string; message: string; level: 'error' }
type TabStop = { phase: string; step: number; tag: string | null; text: string | null; label: string | null; reached: boolean }
type ProbeWindow = Window & { __knowbookCompactTabRoute?: TabStop[] }
type BackupGlobal = typeof globalThis & { __knowbookCompactBackup?: { calls: number; reject?: (error: Error) => void } }
const needle = 'CompactNoticeNeedle'
const summary = (page: Page) => page.getByTestId('notification-summary')
const toasts = (page: Page) => page.locator('.app-notifications')
const view = (page: Page) => summary(page).getByRole('button', { name: uiText('View 3 notifications', '查看 3 条通知'), exact: true })
const center = (page: Page) => page.getByRole('dialog', { name: uiText('Notification center', '通知中心'), exact: true })
const bell = (page: Page) => page.locator('.notification-bell')
const query = (page: Page) => page.getByLabel(uiText('Keywords', '关键词'), { exact: true })
const firstOpen = (page: Page) => page.getByTestId('workspace-search-result').first()
  .getByRole('button', { name: uiText('Open document', '打开文档'), exact: true })

function notices(language: 'en-US' | 'zh-CN'): Notice[] {
  return Array.from({ length: 3 }, (_, index) => ({ level: 'error' as const,
    title: language === 'zh-CN' ? `示例任务 ${index + 1} 失败` : `Example task ${index + 1} failed`,
    message: language === 'zh-CN'
      ? `第 ${index + 1} 项操作暂时无法完成。\n原始文档草稿已保留。\n检查本地设置后可以重试。\n这行完整说明应保留在通知历史中。`
      : `Operation ${index + 1} could not complete.\nThe original document draft is preserved.\nCheck local settings before retrying.\nThis complete final explanation remains in notification history.` }))
}

async function emitNotices(app: ElectronApplication, notifications: Notice[]) {
  await app.evaluate(({ BrowserWindow }, notifications) => {
    for (const notification of notifications) {
      BrowserWindow.getAllWindows()[0].webContents.send('knowbook:plugin-notification', notification)
    }
  }, notifications)
}

async function resize(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  // Let the actual media-query event and React commit finish before collecting
  // geometry. This neither changes app timers nor focuses a native window.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function tabTo(page: Page, target: Locator, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  let reached = false
  for (let step = 1; step <= 24; step++) {
    await page.keyboard.press('Tab')
    const stop = await target.evaluate((element, { step, phase }) => {
      const active = document.activeElement as HTMLElement | null
      const reached = active === element
      const stop = { phase, step, tag: active?.tagName ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null,
        label: active?.getAttribute('aria-label') ?? null, reached }
      ;((window as ProbeWindow).__knowbookCompactTabRoute ??= []).push(stop)
      return stop
    }, { step, phase })
    reached = stop.reached
    // Do not wrap through the unfocusable native host's document boundary.
    if (reached || stop.tag === 'BODY') break
  }
  await record(page, app, testInfo, phase)
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
    }
    const box = (element: Element | null) => {
      if (!element) return null
      const bounds = rect(element)
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      const ancestors: Array<{ className: string; overflowX: string; overflowY: string; rect: ReturnType<typeof rect> }> = []
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX), y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY)
        if (!x && !y) continue
        const parentBox = rect(parent)
        if (x) { clip.left = Math.max(clip.left, parentBox.left + parent.clientLeft)
          clip.right = Math.min(clip.right, parentBox.left + parent.clientLeft + parent.clientWidth) }
        if (y) { clip.top = Math.max(clip.top, parentBox.top + parent.clientTop)
          clip.bottom = Math.min(clip.bottom, parentBox.top + parent.clientTop + parent.clientHeight) }
        ancestors.push({ className: parent.className, overflowX: style.overflowX, overflowY: style.overflowY, rect: parentBox })
      }
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      const style = getComputedStyle(element)
      const visibleWidth = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left))
      const visibleHeight = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      return { rect: bounds, clip, ancestors, display: style.display, visibility: style.visibility,
        visible: bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden',
        visibleRatio: bounds.width && bounds.height ? visibleWidth * visibleHeight / (bounds.width * bounds.height) : 0,
        centerHit: hit === element || Boolean(hit && element.contains(hit)),
        hit: hit && { tag: hit.tagName, className: hit.className,
          notificationId: hit.closest('[data-notification-id]')?.getAttribute('data-notification-id') } }
    }
    const row = document.querySelector('[data-testid="workspace-search-result"]')
    const open = Array.from(row?.querySelectorAll('button') ?? [])
      .find(button => /^(Open document|打开文档)$/.test(button.textContent?.trim() ?? '')) ?? null
    const summary = document.querySelector('[data-testid="notification-summary"]')
    const message = summary?.querySelector('.app-notification-message') ?? null
    const messageStyle = message ? getComputedStyle(message) : null
    const active = document.activeElement
    const toastCards = Array.from(document.querySelectorAll('.app-notifications .app-notification'))
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      active: { tag: active?.tagName, text: active?.tagName === 'BUTTON' ? active.textContent : null,
        label: active?.getAttribute('aria-label') }, openFocused: active === open,
      query: document.querySelector<HTMLInputElement>('.workspace-search-query input')?.value,
      owner: box(row), actions: box(row?.querySelector('.workspace-search-result-actions') ?? null), open: box(open),
      feedback: box(row?.querySelector('.workspace-search-action-feedback') ?? null),
      notifications: box(document.querySelector('.app-notifications')),
      cards: toastCards.map(card => ({ id: card.getAttribute('data-notification-id'),
        title: card.querySelector('.app-notification-title')?.textContent, message: card.querySelector('.app-notification-message')?.textContent,
        ...box(card) })), visibleCardCount: toastCards.filter(card => card.getBoundingClientRect().height > 0).length,
      summary: summary && { id: summary.getAttribute('data-notification-id'), title: summary.querySelector('.app-notification-title')?.textContent,
        message: message?.textContent, messageRect: message ? rect(message) : null,
        lineHeight: messageStyle ? parseFloat(messageStyle.lineHeight) : null, ...box(summary) },
      view: box(summary?.querySelector('button') ?? null),
      center: box(document.querySelector('.notification-center')),
      tabRoute: (window as ProbeWindow).__knowbookCompactTabRoute ?? [] }
  })
  const body = JSON.stringify({ windows, state }, null, 2)
  writeFileSync(testInfo.outputPath(`${phase}.json`), body, 'utf8')
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return state
}

async function expectCompact(page: Page, latest: Notice, id: string, state: Awaited<ReturnType<typeof record>>) {
  await expect(summary(page)).toBeVisible()
  await expect(summary(page)).toHaveAttribute('data-notification-id', id)
  await expect(summary(page).locator('.app-notification-title')).toHaveText(latest.title)
  await expect(summary(page).locator('.app-notification-message')).toHaveText(latest.message)
  await expect(view(page)).toBeVisible()
  await expect(view(page)).toBeInViewport({ ratio: 1 })
  expect(state.visibleCardCount).toBe(0)
  expect(state.summary?.visibleRatio).toBe(1)
  expect(state.view?.centerHit).toBe(true)
  expect(state.summary?.messageRect?.height).toBeLessThanOrEqual((state.summary?.lineHeight ?? 0) + 0.5)
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`compact notifications preserve search controls and full history (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const target = await page.evaluate(async ({ language, needle }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title: 'Compact notification sample', summary: '', blocks:
          Array.from({ length: 3 }, (_, index) => ({ id: `${id}-body-${index}`, type: 'paragraph' as const,
            content: `${needle} paragraph ${index} remains intact.`, checked: false, depth: 0 })) })
        return (await window.knowbook.getDocumentDetail(id))!
      }, { language, needle })
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      const narrow = { width: 760, height: language === 'zh-CN' ? 850 : 640 }
      await resize(page, narrow)
      await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
      await query(page).fill(needle)
      await expect(page.getByTestId('workspace-search-result')).toHaveCount(3)
      await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')
      await expect(query(page)).toBeFocused()
      await tabTo(page, firstOpen(page), app, testInfo, 'native-tab-to-first-secondary-open-before-notifications')
      const errors = notices(language)
      await emitNotices(app, errors)
      await expect(toasts(page).locator('.app-notification')).toHaveCount(3)
      const ids = await toasts(page).locator('.app-notification').evaluateAll(cards => cards.map(card => card.getAttribute('data-notification-id')!))
      // In the old build these three persistent full cards cover Open's center.
      // Save their real pixel/hit geometry before asserting the new summary.
      const narrowState = await record(page, app, testInfo, 'narrow-three-errors-before-compact-and-hit-assertions')
      await expectCompact(page, errors[2]!, ids[2]!, narrowState)
      await expect(firstOpen(page)).toBeFocused()
      await expect(firstOpen(page)).toBeInViewport({ ratio: 1 })
      expect(narrowState.open?.centerHit).toBe(true)
      await resize(page, { width: 1360, height: 640 })
      const shortState = await record(page, app, testInfo, 'wide-short-window-still-uses-one-compact-summary')
      await expectCompact(page, errors[2]!, ids[2]!, shortState)
      await expect(firstOpen(page)).toBeFocused()
      await resize(page, { width: 1360, height: 880 })
      const desktopState = await record(page, app, testInfo, 'desktop-keeps-three-full-notification-cards')
      await expect(summary(page)).toHaveCount(0)
      expect(desktopState.visibleCardCount).toBe(3)
      await expect(firstOpen(page)).toBeFocused()
      for (const [index, notification] of errors.entries()) {
        const card = toasts(page).locator(`.app-notification[data-notification-id="${ids[index]}"]`)
        await expect(card).toBeVisible()
        await expect(card.locator('.app-notification-message')).toHaveText(notification.message)
      }
      // Only a notification-owned focus transfers when its control is hidden
      // by the media switch. Reach Dismiss natively without dismissing a record.
      const dismiss = toasts(page).locator('.app-notification').first().getByRole('button', {
        name: uiText('Dismiss notification', '关闭通知'), exact: true
      })
      await tabTo(page, dismiss, app, testInfo, 'desktop-native-tab-to-dismiss-without-activation')
      await resize(page, narrow)
      await record(page, app, testInfo, 'notification-owned-dismiss-focus-transfers-to-compact-view')
      await expect(view(page)).toBeFocused()
      await resize(page, { width: 1360, height: 880 })
      await record(page, app, testInfo, 'compact-view-focus-transfers-to-stable-bell-on-desktop')
      await expect(summary(page)).toHaveCount(0)
      await expect(bell(page)).toBeFocused()
      await resize(page, narrow)
      await record(page, app, testInfo, 'external-bell-focus-is-preserved-when-summary-returns')
      await expect(summary(page)).toBeVisible()
      await expect(bell(page)).toBeFocused()
      await expect(view(page)).not.toBeFocused()
      // Resume the user's search interaction through a real pointer event;
      // the later summary entry is still reached by native Tab, never focus().
      await query(page).click()
      await expect(query(page)).toBeFocused()
      await tabTo(page, view(page), app, testInfo, 'native-tab-to-view-all-without-focus-or-host-wrap')
      await page.keyboard.press('Enter')
      await expect(center(page)).toBeVisible()
      await expect(center(page).locator('.app-notification')).toHaveCount(3)
      for (const [index, notification] of errors.entries()) {
        const card = center(page).locator(`.app-notification[data-notification-id="${ids[index]}"]`)
        await expect(card.locator('.app-notification-title')).toHaveText(notification.title)
        await expect(card.locator('.app-notification-message')).toHaveText(notification.message)
      }
      await record(page, app, testInfo, 'notification-center-preserves-all-three-full-errors')
      const close = center(page).getByRole('button', { name: uiText('Close notification center', '关闭通知中心'), exact: true })
      await expect(close).toBeFocused()
      await page.keyboard.press(language === 'en-US' ? 'Escape' : 'Enter')
      await expect(center(page)).toHaveCount(0)
      await expect(bell(page)).toBeFocused()
      await expect(bell(page)).toHaveAttribute('aria-expanded', 'false')
      await expect(summary(page)).toHaveCount(0)
      await expect(query(page)).toHaveValue(needle)
      await expect(page.getByTestId('workspace-search-result')).toHaveCount(3)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), target.id)).toEqual(target)
      await record(page, app, testInfo, 'center-close-restores-stable-bell-and-preserves-search')
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}

test('compact summary selects an older backup record updated after two newer errors @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ page, app }) => {
    await page.evaluate(async () => {
      await window.knowbook.saveSetting('ui.language', 'en-US')
      await window.knowbook.saveSetting('appearance.theme', 'light')
    })
    await app.evaluate(({ ipcMain }) => {
      const probe = { calls: 0, reject: undefined as ((error: Error) => void) | undefined }
      ;(globalThis as BackupGlobal).__knowbookCompactBackup = probe
      // Never delegate the backup handler: this task writes no backup files.
      ipcMain.removeHandler('knowbook:trigger-backup')
      ipcMain.handle('knowbook:trigger-backup', () => new Promise((_resolve, reject) => {
        probe.calls++; probe.reject = reject
      }))
    })
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await resize(page, { width: 1360, height: 880 })
    await page.getByTitle(uiText('Dashboard', '总览'), { exact: true }).click()
    await page.getByRole('button', { name: 'Run backup now', exact: true }).click()
    const running = toasts(page).locator('.app-notification-progress')
    await expect(running).toBeVisible()
    await expect.poll(() => app.evaluate(() => (globalThis as BackupGlobal).__knowbookCompactBackup!.calls)).toBe(1)
    const backupId = (await running.getAttribute('data-notification-id'))!
    const backupTitle = (await running.locator('.app-notification-title').textContent())!
    const later = notices('en-US').slice(0, 2)
    await emitNotices(app, later)
    await expect(toasts(page).locator('.app-notification')).toHaveCount(3)
    const originalIds = await toasts(page).locator('.app-notification').evaluateAll(cards => cards.map(card => card.getAttribute('data-notification-id')!))
    expect(originalIds[0]).toBe(backupId)
    await resize(page, { width: 760, height: 640 })
    const reason = 'Cannot write the isolated backup.\nChoose a writable location and retry.'
    await app.evaluate((_electron, reason) => {
      const probe = (globalThis as BackupGlobal).__knowbookCompactBackup!
      if (!probe.reject) throw new Error('No pending backup request')
      setImmediate(() => probe.reject!(new Error(reason)))
    }, reason)
    await expect(toasts(page).locator(`.app-notification[data-notification-id="${backupId}"] .app-notification-message`)).toHaveText(reason)
    const state = await record(page, app, testInfo, 'old-backup-record-updated-to-latest-error-before-summary-assertions')
    await expectCompact(page, { title: `${backupTitle} failed`, message: reason, level: 'error' }, backupId, state)
    expect(await toasts(page).locator('.app-notification').evaluateAll(cards => cards.map(card => card.getAttribute('data-notification-id')))).toEqual(originalIds)
    await view(page).click()
    await expect(center(page)).toBeVisible()
    await expect(center(page).locator('.app-notification')).toHaveCount(3)
    await expect(center(page).locator('.app-notification').first()).toHaveAttribute('data-notification-id', backupId)
    await expect(center(page).locator(`.app-notification[data-notification-id="${backupId}"] .app-notification-message`)).toHaveText(reason)
    for (const notification of later) await expect(center(page)).toContainText(notification.message)
    expect(await app.evaluate(() => (globalThis as BackupGlobal).__knowbookCompactBackup!.calls)).toBe(1)
    await record(page, app, testInfo, 'notification-center-retains-updated-backup-id-and-chronology')
    await page.keyboard.press('Escape')
    await expect(center(page)).toHaveCount(0)
    await expect(bell(page)).toBeFocused()
  })
})
