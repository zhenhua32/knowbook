import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Notice = { title: string; message: string; level: 'error' | 'success'; persistent?: boolean }
type TabStop = { phase: string; step: number; tag: string | null; label: string | null; text: string | null; reached: boolean }
type ProbeWindow = Window & { __knowbookDismissRoute?: TabStop[] }
const needle = 'NotificationDismissNeedle'
const cards = (page: Page) => page.locator('.app-notifications > .app-notification')
const dismiss = (card: Locator) => card.getByRole('button', { name: uiText('Dismiss notification', '关闭通知'), exact: true })
const bell = (page: Page) => page.locator('.notification-bell')
const query = (page: Page) => page.getByLabel(uiText('Keywords', '关键词'), { exact: true })
const center = (page: Page) => page.getByRole('dialog', { name: uiText('Notification center', '通知中心'), exact: true })

async function emit(app: ElectronApplication, notice: Notice) {
  await app.evaluate(({ BrowserWindow }, notice) => {
    BrowserWindow.getAllWindows()[0].webContents.send('knowbook:plugin-notification', notice)
  }, notice)
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
      focused: Boolean(active && element.contains(active)) })
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      active: { tag: active?.tagName, label: active?.getAttribute('aria-label'),
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null,
        connected: active?.isConnected, notificationId: active?.closest('[data-notification-id]')?.getAttribute('data-notification-id') },
      query: document.querySelector<HTMLInputElement>('.workspace-search-query input')?.value,
      cards: Array.from(document.querySelectorAll('.app-notifications > .app-notification')).map(describe),
      history: Array.from(document.querySelectorAll('.notification-center .app-notification')).map(describe),
      route: (window as ProbeWindow).__knowbookDismissRoute ?? [] }
  })
  const body = JSON.stringify({ windows, state }, null, 2)
  writeFileSync(info.outputPath(`${phase}.json`), body, 'utf8')
  await info.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
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
      ;((window as ProbeWindow).__knowbookDismissRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached) break
  }
  await record(page, app, info, phase)
  expect(reached, 'Native Tab must reach the control without repairing focus').toBe(true)
  await expect(target).toBeFocused()
}

for (const scenario of [
  { language: 'en-US', theme: 'light' },
  { language: 'zh-CN', theme: 'dark' }
] as const) {
  test(`dismissing notifications keeps a native keyboard continuation (${scenario.language}) @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const originalDocument = await page.evaluate(async ({ language, theme, needle }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', theme)
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title: 'Notification dismissal sample', summary: '', blocks: [
          { id: `${id}-body`, type: 'paragraph', content: `${needle} original content stays unchanged.`, checked: false, depth: 0 }
        ] })
        return (await window.knowbook.getDocumentDetail(id))!
      }, { ...scenario, needle })
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      const viewport = { width: 1360, height: 880 }
      await page.setViewportSize(viewport)
      await app.evaluate(({ BrowserWindow }, viewport) => {
        BrowserWindow.getAllWindows()[0].setContentSize(viewport.width, viewport.height)
      }, viewport)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(scenario.theme)
      await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
      await query(page).fill(needle)
      await expect(page.getByTestId('workspace-search-result')).toHaveCount(1)
      await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')
      await page.mouse.move(0, 0)

      const notices: Notice[] = [1, 2, 3].map(index => ({ level: 'error', persistent: true,
        title: scenario.language === 'zh-CN' ? `保留的错误通知 ${index}` : `Retained error notification ${index}`,
        message: scenario.language === 'zh-CN' ? `第 ${index} 条错误的原始详情。\n关闭提示后，详情仍保存在通知中心。`
          : `Original details for error ${index}.\nClosing the toast keeps these details in the notification center.` }))
      for (const [index, notice] of notices.entries()) {
        await emit(app, notice)
        await expect(cards(page)).toHaveCount(index + 1)
      }
      const ids = await cards(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-notification-id')!))
      const first = cards(page).filter({ hasText: notices[0].title })
      const middle = cards(page).filter({ hasText: notices[1].title })
      const last = cards(page).filter({ hasText: notices[2].title })
      await tabTo(page, dismiss(middle), app, info, 'native-tab-to-middle-dismiss')

      await page.keyboard.press('Enter')
      await expect(middle).toHaveCount(0)
      await record(page, app, info, 'middle-dismissed-before-successor-focus-assertion')
      await expect(dismiss(last)).toBeFocused()
      await expect(cards(page)).toHaveCount(2)
      expect(await cards(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-notification-id')))).toEqual([ids[0], ids[2]])

      // Continue with Enter alone. A Tab or manual focus here would hide the regression.
      await page.keyboard.press('Enter')
      await expect(last).toHaveCount(0)
      await record(page, app, info, 'last-dismissed-before-predecessor-focus-assertion')
      await expect(dismiss(first)).toBeFocused()
      await expect(cards(page)).toHaveCount(1)
      await expect(first).toHaveAttribute('data-notification-id', ids[0])

      await page.keyboard.press('Enter')
      await expect(cards(page)).toHaveCount(0)
      await record(page, app, info, 'final-dismissed-before-stable-bell-focus-assertion')
      await expect(bell(page)).toBeFocused()
      await expect(query(page)).toHaveValue(needle)
      await page.keyboard.press('Enter')
      await expect(center(page)).toBeVisible()
      await expect(center(page).locator('.app-notification')).toHaveCount(3)
      for (const [index, notice] of notices.entries()) {
        const item = center(page).locator(`.app-notification[data-notification-id="${ids[index]}"]`)
        await expect(item.locator('.app-notification-title')).toHaveText(notice.title)
        await expect(item.locator('.app-notification-message')).toHaveText(notice.message)
      }
      await record(page, app, info, 'all-three-dismissed-records-preserve-original-history')
      await page.keyboard.press('Escape')
      await expect(center(page)).toHaveCount(0)
      await expect(bell(page)).toBeFocused()

      // Passive expiry must leave keyboard focus in the workspace, unlike an
      // explicitly activated Dismiss control that owned the removed focus.
      await tabTo(page, query(page), app, info, 'native-tab-back-to-existing-query-before-passive-expiry')
      const now = new Date('2026-10-04T00:00:00Z')
      await page.clock.install({ time: now })
      await page.clock.pauseAt(new Date(now.getTime() + 1_000))
      await page.mouse.move(0, 0)
      const ordinary: Notice = { level: 'success',
        title: scenario.language === 'zh-CN' ? '普通通知自动收起' : 'Ordinary notification expires',
        message: scenario.language === 'zh-CN' ? '输入焦点和搜索内容应保持不变。' : 'The query and its keyboard focus remain unchanged.' }
      await emit(app, ordinary)
      await expect(cards(page)).toHaveCount(1)
      await expect(cards(page).locator('.app-notification-title')).toHaveText(ordinary.title)
      const ordinaryId = (await cards(page).getAttribute('data-notification-id'))!
      await expect(query(page)).toBeFocused()
      await page.clock.runFor(5_999)
      await expect(cards(page)).toHaveCount(1)
      await expect(query(page)).toBeFocused()
      await page.clock.runFor(1)
      await record(page, app, info, 'ordinary-expired-before-workspace-focus-assertion')
      await expect(cards(page)).toHaveCount(0)
      await expect(query(page)).toBeFocused()
      await expect(query(page)).toHaveValue(needle)
      await tabTo(page, bell(page), app, info, 'native-tab-to-bell-after-passive-expiry')
      await page.keyboard.press('Enter')
      await expect(center(page)).toBeVisible()
      await expect(center(page).locator('.app-notification')).toHaveCount(4)
      const history = center(page).locator(`.app-notification[data-notification-id="${ordinaryId}"]`)
      await expect(history.locator('.app-notification-title')).toHaveText(ordinary.title)
      await expect(history.locator('.app-notification-message')).toHaveText(ordinary.message)
      await record(page, app, info, 'passively-expired-record-also-retains-its-history')
      await page.keyboard.press('Escape')
      await expect(center(page)).toHaveCount(0)
      await expect(bell(page)).toBeFocused()
      await expect(query(page)).toHaveValue(needle)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), originalDocument.id)).toEqual(originalDocument)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: scenario.language })
  })
}
