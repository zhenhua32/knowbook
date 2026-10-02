import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Notice = { title: string; message: string; level: 'success' | 'info' | 'warning' }
type TabStop = { phase: string; step: number; tag: string | null; text: string | null; label: string | null; reached: boolean }
type ProbeWindow = Window & { __knowbookPauseTabRoute?: TabStop[]; __knowbookPauseExternalFocus?: Element | null }
const needle = 'NotificationPauseNeedle'
const cards = (page: Page) => page.locator('.app-notifications > .app-notification')
const query = (page: Page) => page.getByLabel(uiText('Keywords', '关键词'), { exact: true })
const dismiss = (card: Locator) => card.getByRole('button', { name: uiText('Dismiss notification', '关闭通知'), exact: true })
const bell = (page: Page) => page.locator('.notification-bell')
const center = (page: Page) => page.getByRole('dialog', { name: uiText('Notification center', '通知中心'), exact: true })

async function seed(page: Page, language: 'en-US' | 'zh-CN') {
  const target = await page.evaluate(async ({ language, needle }) => {
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title: 'Notification interaction sample', summary: '', blocks: [
      { id: `${id}-body`, type: 'paragraph', content: `${needle} original content stays unchanged.`, checked: false, depth: 0 }
    ] })
    return (await window.knowbook.getDocumentDetail(id))!
  }, { language, needle })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 1360, height: 880 })
  await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
  await query(page).fill(needle)
  await expect(page.getByTestId('workspace-search-result')).toHaveCount(1)
  await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')
  const now = new Date('2026-10-03T00:00:00Z')
  await page.clock.install({ time: now })
  await page.clock.pauseAt(new Date(now.getTime() + 1_000))
  await page.mouse.move(0, 0)
  return target
}

async function emit(app: ElectronApplication, notice: Notice) {
  await app.evaluate(({ BrowserWindow }, notice) => {
    BrowserWindow.getAllWindows()[0].webContents.send('knowbook:plugin-notification', notice)
  }, notice)
}

async function tabTo(page: Page, target: Locator, app: ElectronApplication, testInfo: TestInfo,
  phase: string, direction: 'Tab' | 'Shift+Tab' = 'Tab') {
  let reached = false
  for (let step = 1; step <= 24; step++) {
    await page.keyboard.press(direction)
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const reached = active === element
      const stop = { phase, step, tag: active?.tagName ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null,
        label: active?.getAttribute('aria-label') ?? null, reached }
      ;((window as ProbeWindow).__knowbookPauseTabRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  await record(page, app, testInfo, phase)
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function hover(page: Page, card: Locator) {
  await expect(card).toBeInViewport({ ratio: 1 })
  const box = (await card.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  expect(await card.evaluate(element => element.matches(':hover'))).toBe(true)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const describe = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { id: element.getAttribute('data-notification-id'), title: element.querySelector('.app-notification-title')?.textContent,
        message: element.querySelector('.app-notification-message')?.textContent, className: element.className,
        hovered: element.matches(':hover'), focusWithin: Boolean(active && element.contains(active)),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, display: getComputedStyle(element).display }
    }
    return { viewport: { width: innerWidth, height: innerHeight }, virtualTime: Date.now(), theme: document.documentElement.dataset.theme,
      active: { tag: active?.tagName, text: active?.tagName === 'BUTTON' ? active.textContent : null,
        label: active?.getAttribute('aria-label'), className: active?.className },
      query: document.querySelector<HTMLInputElement>('.workspace-search-query input')?.value,
      cards: Array.from(document.querySelectorAll('.app-notifications > .app-notification')).map(describe),
      summary: Array.from(document.querySelectorAll('[data-testid="notification-summary"]')).map(describe),
      history: Array.from(document.querySelectorAll('.notification-center .app-notification')).map(describe),
      externalFocusPreserved: active === (window as ProbeWindow).__knowbookPauseExternalFocus,
      tabRoute: (window as ProbeWindow).__knowbookPauseTabRoute ?? [] }
  })
  const body = JSON.stringify({ windows, state }, null, 2)
  writeFileSync(testInfo.outputPath(`${phase}.json`), body, 'utf8')
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

async function rememberExternalFocus(page: Page) {
  expect(await page.evaluate(() => {
    const active = document.activeElement
    ;(window as ProbeWindow).__knowbookPauseExternalFocus = active
    return Boolean(active && active !== document.body && !active.closest('.app-notifications'))
  })).toBe(true)
}

async function expectExternalFocus(page: Page) {
  expect(await page.evaluate(() => document.activeElement === (window as ProbeWindow).__knowbookPauseExternalFocus)).toBe(true)
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`ordinary notification keeps independent keyboard and pointer pauses (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const target = await seed(page, language)
      const first: Notice = { title: language === 'zh-CN' ? '键盘阅读提示' : 'Keyboard reading notice', level: 'info',
        message: language === 'zh-CN' ? '焦点仍在通知内时，鼠标离开不应收起提示。' : 'Moving the pointer away must preserve a keyboard-focused notification.' }
      const second: Notice = { title: language === 'zh-CN' ? '鼠标阅读提示' : 'Pointer reading notice', level: 'warning',
        message: language === 'zh-CN' ? '鼠标仍悬停时，焦点离开不应收起提示。' : 'Moving keyboard focus away must preserve a hovered notification.' }
      await emit(app, first)
      await expect(cards(page)).toHaveCount(1)
      const firstCard = cards(page).first()
      const firstId = (await firstCard.getAttribute('data-notification-id'))!
      await tabTo(page, dismiss(firstCard), app, testInfo, 'native-tab-to-first-dismiss')
      await hover(page, firstCard)
      await page.mouse.move(0, 0)
      expect(await firstCard.evaluate(element => element.matches(':hover'))).toBe(false)
      await expect(dismiss(firstCard)).toBeFocused()
      await page.clock.runFor(7_000)
      // Old paused=false from mouseleave expires this still-focused card. Keep
      // actual count/activeElement/native window evidence before asserting it.
      await record(page, app, testInfo, 'focused-card-after-mouseleave-and-seven-seconds-before-retention-assertion')
      await expect(firstCard).toBeVisible()
      await expect(dismiss(firstCard)).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await rememberExternalFocus(page)
      await page.clock.runFor(5_999)
      await expect(firstCard).toBeVisible()
      await page.clock.runFor(1)
      await record(page, app, testInfo, 'first-card-expires-six-seconds-after-both-interactions-end')
      await expect(cards(page)).toHaveCount(0)
      await expectExternalFocus(page)

      await tabTo(page, query(page), app, testInfo, 'native-shift-tab-back-to-keywords', 'Shift+Tab')
      await emit(app, second)
      await expect(cards(page)).toHaveCount(1)
      const secondCard = cards(page).first()
      const secondId = (await secondCard.getAttribute('data-notification-id'))!
      await tabTo(page, dismiss(secondCard), app, testInfo, 'native-tab-to-second-dismiss')
      await hover(page, secondCard)
      await page.keyboard.press('Shift+Tab')
      await rememberExternalFocus(page)
      expect(await secondCard.evaluate(element => element.matches(':hover'))).toBe(true)
      await page.clock.runFor(7_000)
      // Native Shift+Tab leaves focus outside while the real pointer remains
      // stationary over the card. No synthetic mouse/focus event is used.
      await record(page, app, testInfo, 'hovered-card-after-blur-and-seven-seconds-before-retention-assertion')
      await expect(secondCard).toBeVisible()
      expect(await secondCard.evaluate(element => element.matches(':hover'))).toBe(true)
      await expect(dismiss(secondCard)).not.toBeFocused()
      await expectExternalFocus(page)
      await page.mouse.move(0, 0)
      expect(await secondCard.evaluate(element => element.matches(':hover'))).toBe(false)
      await page.clock.runFor(5_999)
      await expect(secondCard).toBeVisible()
      await expectExternalFocus(page)
      await page.clock.runFor(1)
      await record(page, app, testInfo, 'second-card-expires-six-seconds-after-pointer-leaves-with-external-focus-preserved')
      await expect(cards(page)).toHaveCount(0)
      await expectExternalFocus(page)
      await bell(page).click()
      await expect(center(page)).toBeVisible()
      await expect(center(page).locator('.app-notification')).toHaveCount(2)
      for (const [notice, id] of [[first, firstId], [second, secondId]] as const) {
        const item = center(page).locator(`.app-notification[data-notification-id="${id}"]`)
        await expect(item.locator('.app-notification-title')).toHaveText(notice.title)
        await expect(item.locator('.app-notification-message')).toHaveText(notice.message)
      }
      await record(page, app, testInfo, 'expired-ordinary-notifications-retain-two-complete-history-records')
      await page.keyboard.press('Escape')
      await expect(center(page)).toHaveCount(0)
      await expect(bell(page)).toBeFocused()
      await expect(query(page)).toHaveValue(needle)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), target.id)).toEqual(target)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}

test('ordinary notification resumes expiration after notification-owned media focus transfers @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ page, app }) => {
    await seed(page, 'en-US')
    const notice: Notice = { title: 'Media focus lifecycle', level: 'success',
      message: 'The ordinary notification should resume its timeout after both interaction owners leave.' }
    await emit(app, notice)
    await expect(cards(page)).toHaveCount(1)
    const card = cards(page).first()
    const id = (await card.getAttribute('data-notification-id'))!
    await tabTo(page, dismiss(card), app, testInfo, 'media-wide-native-tab-to-dismiss')
    await page.setViewportSize({ width: 760, height: 640 })
    const summary = page.getByTestId('notification-summary')
    const view = summary.getByRole('button', { name: 'View 1 notification', exact: true })
    await expect(summary).toBeVisible()
    await expect(view).toBeFocused()
    await page.clock.runFor(7_000)
    await record(page, app, testInfo, 'media-compact-view-focus-keeps-ordinary-record-beyond-six-seconds')
    await expect(summary).toBeVisible()
    await expect(view).toBeFocused()
    await page.setViewportSize({ width: 1360, height: 880 })
    await expect(summary).toHaveCount(0)
    await expect(bell(page)).toBeFocused()
    await page.mouse.move(0, 0)
    await expect(card).toBeVisible()
    expect(await card.evaluate(element => element.matches(':hover'))).toBe(false)
    await page.clock.runFor(5_999)
    await expect(card).toBeVisible()
    await expect(bell(page)).toBeFocused()
    await page.clock.runFor(1)
    await record(page, app, testInfo, 'media-wide-expires-after-six-seconds-with-bell-focus-before-assertion')
    await expect(cards(page)).toHaveCount(0)
    await expect(bell(page)).toBeFocused()
    await bell(page).click()
    await expect(center(page)).toBeVisible()
    await expect(center(page).locator('.app-notification')).toHaveCount(1)
    const history = center(page).locator(`.app-notification[data-notification-id="${id}"]`)
    await expect(history.locator('.app-notification-title')).toHaveText(notice.title)
    await expect(history.locator('.app-notification-message')).toHaveText(notice.message)
    await record(page, app, testInfo, 'media-expired-record-retains-complete-notification-history')
    await page.keyboard.press('Escape')
    await expect(center(page)).toHaveCount(0)
    await expect(bell(page)).toBeFocused()
  })
})
