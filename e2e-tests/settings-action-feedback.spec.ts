import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import type { AiConfig, UpdateWebClipBridgeSettingsInput } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: IpcMainInvokeEvent, input?: unknown) => unknown | Promise<unknown>
type Pending = { event: IpcMainInvokeEvent; input: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; originalRead?: Handler; pending: Pending[]; calls: number; reads: number; failRead: boolean; bridgeWrites: UpdateWebClipBridgeSettingsInput[] }
type ProbeGlobal = typeof globalThis & { __knowbookActionFeedbackProbe?: Probe }

const savedAi = { enabled: false, autoSummaryOnSave: false, relatedNotesEnabled: true,
  baseUrl: 'https://saved-feedback-ai.example.invalid/v1', model: 'saved-feedback-model' }
const aiDraft = { ...savedAi, relatedNotesEnabled: false, baseUrl: 'https://draft-feedback-ai.example.invalid/v1',
  model: 'draft-feedback-model', apiKey: 'e2e-feedback-new-key' }

async function installProbe(app: ElectronApplication, feature: 'ai' | 'bridge') {
  await app.evaluate(({ ipcMain }, feature) => {
    const channel = feature === 'ai' ? 'knowbook:update-ai-config' : 'knowbook:update-web-clip-bridge-settings'
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get(channel)!
    const originalRead = feature === 'bridge' ? handlers.get('knowbook:get-web-clip-bridge-status') : undefined
    if (!original || feature === 'bridge' && !originalRead) throw new Error('Missing real settings handler')
    const probe: Probe = { original, originalRead, pending: [], calls: 0, reads: 0, failRead: false, bridgeWrites: [] }
    ;(globalThis as ProbeGlobal).__knowbookActionFeedbackProbe = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input: unknown) => {
      probe.calls++
      if (feature === 'bridge') probe.bridgeWrites.push({ ...input as UpdateWebClipBridgeSettingsInput })
      return new Promise<unknown>((resolve, reject) => probe.pending.push({ event, input, resolve, reject }))
    })
    if (originalRead) {
      ipcMain.removeHandler('knowbook:get-web-clip-bridge-status')
      ipcMain.handle('knowbook:get-web-clip-bridge-status', event => {
        probe.reads++
        if (probe.failRead) throw new Error('Error: Controlled bridge status failure')
        return originalRead(event)
      })
    }
  }, feature)
}

async function counts(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookActionFeedbackProbe!
    return { calls: probe.calls, pending: probe.pending.length, reads: probe.reads, bridgeWrites: probe.bridgeWrites }
  })
}

async function finish(app: ElectronApplication, reason?: string) {
  await app.evaluate(async (_electron, reason) => {
    const probe = (globalThis as ProbeGlobal).__knowbookActionFeedbackProbe!
    const pending = probe.pending.shift()
    if (!pending) throw new Error('No pending settings mutation')
    if (reason) pending.reject(new Error(`Error: ${reason}`))
    else {
      try { pending.resolve(await probe.original(pending.event, pending.input)) }
      catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
    }
  }, reason ?? null)
}

async function seed(page: Page, language: 'en-US' | 'zh-CN', feature: 'ai' | 'bridge') {
  await page.evaluate(async ({ language, feature, savedAi }) => {
    if (feature === 'ai') await window.knowbook.updateAiConfig({ ...savedAi, apiKey: 'e2e-feedback-original-key' })
    else await window.knowbook.updateWebClipBridgeSettings({ enabled: false, port: 4321 })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
  }, { language, feature, savedAi })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 760, height: language === 'zh-CN' ? 850 : 640 })
  const time = new Date('2026-10-02T00:00:00Z')
  await page.clock.install({ time })
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
}

async function openPanel(page: Page, feature: 'ai' | 'bridge') {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: feature === 'ai' ? 'AI' : uiText('Web clipping', '网页剪藏'), exact: true }).click()
  const panel = page.locator(feature === 'ai' ? '.settings-ai-panel' : '.settings-bridge-panel')
  await expect(panel).toBeVisible()
  const actions = panel.locator('.settings-editable-form .settings-form-actions')
  const buttons = actions.locator('.settings-actions')
  return { panel, actions, buttons, feedback: actions.locator('.settings-action-feedback'),
    save: buttons.getByRole('button', { name: feature === 'ai'
      ? /^(?:Save AI settings|保存 AI 设置|Saving\.\.\.|保存中\.\.\.)$/i
      : /^(?:Save bridge settings|保存桥接设置|Saving\.\.\.|保存中\.\.\.)$/i }) }
}

async function enter(page: Page, button: Locator) {
  await button.scrollIntoViewIfNeeded()
  await expect(button).toBeInViewport({ ratio: 1 })
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
}

async function expectHit(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 })
  const point = await control.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { reachable: hit === element || Boolean(hit && element.contains(hit)),
      target: { tag: element.tagName, className: element.className, x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hit: hit ? { tag: hit.tagName, className: hit.className, text: hit.tagName === 'INPUT' ? null : hit.textContent } : null }
  })
  expect(point.reachable, JSON.stringify(point)).toBe(true)
}

async function expectFeedback(feedback: Locator, buttons: Locator) {
  await expect(feedback).toBeInViewport({ ratio: 1 })
  await expect(buttons).toBeInViewport({ ratio: 1 })
  const before = await feedback.boundingBox(), after = await buttons.boundingBox()
  expect(before).not.toBeNull(); expect(after).not.toBeNull()
  expect(before!.y + before!.height).toBeLessThanOrEqual(after!.y + 1)
  expect(after!.y - before!.y - before!.height).toBeLessThan(48)
}

async function dismissNotification(page: Page, toast: Locator) {
  const viewport = page.viewportSize()!
  // Compact windows expose a summary and history, while individual dismiss
  // controls are available in the expanded notification list.
  try {
    await page.setViewportSize({ width: Math.max(viewport.width, 1000), height: Math.max(viewport.height, 800) })
    await expect(toast).toBeVisible()
    await toast.getByRole('button', { name: uiText('Dismiss notification', '关闭通知'), exact: true }).click()
  } finally {
    await page.setViewportSize(viewport)
  }
  await expect(toast).toHaveCount(0)
}

async function dismissButKeepHistory(page: Page, reason: string, localError: Locator) {
  const toast = page.locator('.app-notifications .app-notification').filter({ hasText: reason })
  await expect(toast).toHaveCount(1)
  const id = await toast.getAttribute('data-notification-id')
  await expect(page.getByTestId('notification-summary')).toContainText(reason)
  await dismissNotification(page, toast)
  await expect(localError).toContainText(reason)
  await page.getByRole('button', { name: /Notification center|通知中心/ }).click()
  const center = page.getByRole('dialog', { name: uiText('Notification center', '通知中心'), exact: true })
  const record = center.locator('.app-notification').filter({ hasText: reason })
  await expect(record).toHaveAttribute('data-notification-id', id!)
  await center.getByRole('button', { name: uiText('Close notification center', '关闭通知中心'), exact: true }).click()
  await expect(center).toHaveCount(0)
  await expect(localError).toContainText(reason)
}

async function record(page: Page, app: ElectronApplication, panel: Locator, testInfo: TestInfo, phase: string) {
  const geometry = await panel.evaluate(element => {
    const describeRect = (target: Element) => {
      const rect = target.getBoundingClientRect()
      const style = getComputedStyle(target)
      return { tag: target.tagName, className: target.className, top: rect.top, bottom: rect.bottom,
        left: rect.left, right: rect.right, position: style.position, bottomOffset: style.bottom,
        notificationId: target.getAttribute('data-notification-id') }
    }
    const describe = (target: Element) => ({ ...describeRect(target), text: target.textContent })
    const scrollers: Element[] = []
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (/(?:auto|scroll|overlay)/.test(getComputedStyle(ancestor).overflowY)
        && ancestor.scrollHeight > ancestor.clientHeight) scrollers.push(ancestor)
    }
    if (document.scrollingElement && !scrollers.includes(document.scrollingElement)) scrollers.push(document.scrollingElement)
    return { viewport: { width: innerWidth, height: innerHeight },
      editableForms: [...element.querySelectorAll('.settings-editable-form')].map(describeRect),
      formActions: [...element.querySelectorAll('.settings-form-actions')].map(describeRect),
      scrollers: scrollers.map(target => ({ ...describeRect(target), scrollTop: target.scrollTop,
        clientHeight: target.clientHeight, scrollHeight: target.scrollHeight })),
      notifications: [...document.querySelectorAll('.app-notifications, .app-notifications .app-notification')].map(describeRect),
      feedback: [...element.querySelectorAll('.settings-action-feedback')].map(describe),
      buttons: [...element.querySelectorAll('.settings-form-actions button')].map(describe),
      activeTag: document.activeElement?.tagName,
      activeText: document.activeElement?.tagName === 'BUTTON' ? document.activeElement.textContent : null }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const body = JSON.stringify({ geometry, windows, requests: await counts(app) }, null, 2)
  console.log(`[settings-action-feedback:${phase}] ${body}`)
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`), mask: [panel.getByLabel(uiText('Authorization token', '授权令牌'), { exact: true })] })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`AI save errors stay with the editable draft after dismissing notifications and clear only on a real action (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page }) => {
      await seed(page, language, 'ai')
      const { panel, feedback, buttons, save } = await openPanel(page, 'ai')
      const apiKey = panel.getByLabel(uiText('API Key (leave blank to keep current)', 'API Key（留空表示保持当前值）'), { exact: true })
      const model = panel.getByLabel(uiText('Model', '模型'), { exact: true })
      const baseUrl = panel.getByLabel(uiText('Base URL', '基础地址'), { exact: true })
      const clear = panel.getByRole('button', { name: uiText('Clear API key', '清除 API Key'), exact: true })
      await baseUrl.fill(aiDraft.baseUrl)
      await model.fill(aiDraft.model)
      await panel.getByLabel(uiText('Retrieve related notes when asking AI', '询问 AI 时检索相关笔记'), { exact: true }).uncheck()
      await apiKey.fill(aiDraft.apiKey)
      await installProbe(app, 'ai')
      await enter(page, save)
      await expect.poll(async () => (await counts(app)).pending).toBe(1)
      await expect(apiKey).toBeDisabled()
      await expect(model).toBeDisabled()
      await expect(save).toHaveAttribute('aria-busy', 'true')
      await expect(feedback.getByRole('status')).toHaveText(uiText('Saving AI settings…', '正在保存 AI 设置…'))
      await expectFeedback(feedback, buttons)
      const reason = 'Controlled AI settings save failure'
      await finish(app, reason)
      const error = panel.locator('.settings-ai-save-error')
      await expect(error).toHaveText(reason)
      await expect(save).toBeFocused()
      await expect(apiKey).toHaveValue(aiDraft.apiKey)
      await expect(apiKey).toHaveAttribute('type', 'password')
      await expect(model).toHaveValue(aiDraft.model)
      await expect(baseUrl).toHaveValue(aiDraft.baseUrl)
      await expectFeedback(feedback, buttons)
      await expectHit(save)
      await record(page, app, panel, testInfo, 'ai-save-failure')
      await dismissButKeepHistory(page, reason, error)
      await save.focus()
      await page.keyboard.press('Shift+Tab')
      await expect(clear).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(apiKey).toBeFocused()
      await expect(apiKey).toBeEnabled()
      await expectHit(apiKey)
      await page.keyboard.press('Tab')
      await expect(clear).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(save).toBeFocused()
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await counts(app)).pending).toBe(1)
      expect((await counts(app)).calls).toBe(2)
      await finish(app)
      await expect(save).toBeEnabled()
      await expect(error).toHaveCount(0)
      await expect(apiKey).toHaveValue('')
      const { apiKey: _key, ...expectedConfig } = aiDraft
      expect((await page.evaluate(() => window.knowbook.getHomeData())).aiConfig).toEqual({ ...expectedConfig, hasApiKey: true } satisfies AiConfig)
      await record(page, app, panel, testInfo, 'ai-save-retry-success')

      // Opening/cancelling a clear confirmation preserves a prior save error; only the confirmed action clears it.
      await apiKey.fill('e2e-key-draft-preserved-on-clear-failure')
      await model.fill('unsaved-clear-model')
      await enter(page, save)
      await expect.poll(async () => (await counts(app)).pending).toBe(1)
      const secondReason = 'Controlled subsequent AI save failure'
      await finish(app, secondReason)
      await expect(error).toHaveText(secondReason)
      await dismissButKeepHistory(page, secondReason, error)
      await clear.click()
      const dialog = page.getByRole('alertdialog', { name: uiText('Clear API key', '清除 API Key'), exact: true })
      await expect(dialog).toBeVisible()
      await expect(error).toHaveText(secondReason)
      await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(error).toHaveText(secondReason)
      expect((await counts(app)).calls).toBe(3)
      await clear.click()
      await dialog.getByRole('button', { name: uiText('Clear API key', '清除 API Key'), exact: true }).click()
      await expect.poll(async () => (await counts(app)).pending).toBe(1)
      await expect(error).toHaveCount(0)
      await finish(app, 'Controlled confirmed key clear failure')
      await expect(dialog.getByRole('alert')).toHaveText('Controlled confirmed key clear failure')
      await expect(error).toHaveCount(0)
      await expect(apiKey).toHaveValue('e2e-key-draft-preserved-on-clear-failure')
      await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(model).toHaveValue('unsaved-clear-model')
      expect((await page.evaluate(() => window.knowbook.getHomeData())).aiConfig).toEqual({ ...expectedConfig, hasApiKey: true })
      await record(page, app, panel, testInfo, 'ai-clear-failure-keeps-draft')
      await page.clock.resume()
    })
  })
}

test('bridge save and token failures retain their owner across reads and invalid drafts before real keyboard and pointer retries @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await seed(page, 'zh-CN', 'bridge')
    const { panel, feedback, buttons, save } = await openPanel(page, 'bridge')
    const enabled = panel.getByLabel(uiText('Enable local web clip bridge service', '启用本地网页剪藏桥接服务'), { exact: true })
    const port = panel.getByLabel(uiText('Listening port', '监听端口'), { exact: true })
    const token = panel.getByLabel(uiText('Authorization token', '授权令牌'), { exact: true })
    const endpoint = panel.getByLabel(uiText('Extension endpoint', '扩展提交地址'), { exact: true })
    const rotate = buttons.getByRole('button', { name: uiText('Regenerate token', '重新生成令牌'), exact: true })
    await expect(port).toHaveValue('4321')
    await expect(enabled).not.toBeChecked()
    const originalToken = await token.inputValue()
    await installProbe(app, 'bridge')
    await port.fill('5432')
    await enter(page, save)
    await expect.poll(async () => (await counts(app)).pending).toBe(1)
    await expect(port).toBeDisabled()
    await expect(rotate).toBeDisabled()
    await finish(app, 'Controlled bridge save failure')
    const error = panel.locator('.settings-bridge-action-error')
    await expect(error).toHaveAttribute('data-action-kind', 'save')
    await expect(error).toHaveText('保存网页剪藏桥接设置失败。 Controlled bridge save failure')
    await expect(save).toBeFocused()
    await expect(port).toHaveValue('5432')
    await expect(token).toHaveValue(originalToken)
    await expectFeedback(feedback, buttons)
    await expectHit(save)
    await record(page, app, panel, testInfo, 'bridge-save-failure')
    await dismissButKeepHistory(page, 'Controlled bridge save failure', error)
    await page.clock.runFor(4001)
    await expect(error).toHaveAttribute('data-action-kind', 'save')
    await expect(port).toHaveValue('5432')
    await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookActionFeedbackProbe!.failRead = true })
    await page.clock.runFor(4000)
    const readError = panel.locator('.settings-bridge-read-error')
    await expect(readError.getByRole('alert')).toContainText('Controlled bridge status failure')
    await app.evaluate(() => { (globalThis as ProbeGlobal).__knowbookActionFeedbackProbe!.failRead = false })
    await readError.getByRole('button', { name: uiText('Retry loading', '重试读取'), exact: true }).click()
    await expect(readError).toHaveCount(0)
    await expect(error).toHaveAttribute('data-action-kind', 'save')
    await expect(port).toHaveValue('5432')
    await enterFieldAndReturn(page, save, port)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await counts(app)).pending).toBe(1)
    await finish(app)
    await expect(save).toBeEnabled()
    await expect(error).toHaveCount(0)
    const savedToast = page.locator('.app-notifications > .app-notification.app-notification-success').filter({ hasText: '网页剪藏桥接设置已保存。' })
    await expect(savedToast).toHaveCount(1)
    const savedToastId = await savedToast.getAttribute('data-notification-id')
    expect(Boolean(savedToastId)).toBe(true)
    expect(await page.evaluate(() => window.knowbook.getWebClipBridgeStatus())).toMatchObject({ enabled: false, configuredPort: 5432, running: false, port: null, endpoint: null })

    await enabled.check()
    await port.fill('1e4')
    await expect(save).toBeDisabled()
    await enter(page, rotate)
    await expect.poll(async () => (await counts(app)).pending).toBe(1)
    expect((await counts(app)).bridgeWrites.at(-1)).toEqual({ enabled: false, port: 5432, regenerateToken: true })
    await expect(rotate).toHaveAttribute('aria-busy', 'true')
    await finish(app, 'Controlled token rotation failure')
    await expect(error).toHaveAttribute('data-action-kind', 'regenerate')
    await expect(error).toHaveText('更换网页剪藏令牌失败。 Controlled token rotation failure')
    await expect(rotate).toBeFocused()
    await expect(port).toHaveValue('1e4')
    await expect(enabled).toBeChecked()
    await expect(token).toHaveValue(originalToken)
    const rotationErrorToast = page.locator('.app-notifications > .app-notification.app-notification-error').filter({ hasText: 'Controlled token rotation failure' })
    await expect(rotationErrorToast).toHaveCount(1)
    const rotationErrorToastId = await rotationErrorToast.getAttribute('data-notification-id')
    expect(Boolean(rotationErrorToastId)).toBe(true)
    await expect(savedToast).toHaveCount(1)
    await expect(savedToast).toHaveAttribute('data-notification-id', savedToastId!)
    await expectFeedback(feedback, buttons)
    await record(page, app, panel, testInfo, 'bridge-rotate-failure')
    await expect(savedToast).toHaveAttribute('data-notification-id', savedToastId!)
    await expect(rotationErrorToast).toHaveAttribute('data-notification-id', rotationErrorToastId!)
    await expectHit(rotate)
    await dismissButKeepHistory(page, 'Controlled token rotation failure', error)
    const callCount = (await counts(app)).calls
    await save.evaluate(button => (button as HTMLButtonElement).click())
    expect((await counts(app)).calls).toBe(callCount)
    await expect(error).toHaveAttribute('data-action-kind', 'regenerate')
    await page.clock.runFor(4000)
    await expect(error).toHaveAttribute('data-action-kind', 'regenerate')
    await expect(port).toHaveValue('1e4')
    await rotate.scrollIntoViewIfNeeded()
    await rotate.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(port).toBeFocused()
    await expect(port).toBeEnabled()
    await record(page, app, panel, testInfo, 'bridge-port-focused-before-pointer-retry')
    await expectHit(port)
    await expect(error).toHaveAttribute('data-action-kind', 'regenerate')
    // Keep field focus until the genuine pointer action: its mousedown must not lose the click as sticky layout changes.
    await rotate.click()
    await expect.poll(async () => (await counts(app)).pending).toBe(1)
    expect((await counts(app)).calls).toBe(callCount + 1)
    await finish(app)
    await expect(rotate).toBeEnabled()
    await expect(error).toHaveCount(0)
    await expect.poll(() => token.inputValue()).not.toBe(originalToken)
    await expect(port).toHaveValue('1e4')
    await expect(enabled).toBeChecked()
    await expect(save).toBeDisabled()
    expect(await page.evaluate(() => window.knowbook.getWebClipBridgeStatus())).toMatchObject({ enabled: false, configuredPort: 5432, running: false, port: null, endpoint: null })
    await expect(token).toHaveAttribute('readonly', '')
    await expect(endpoint).toHaveAttribute('readonly', '')
    const rotatedToast = page.locator('.app-notifications > .app-notification.app-notification-success').filter({ hasText: '网页剪藏桥接令牌已刷新。' })
    await expect(rotatedToast).toHaveCount(1)
    await dismissNotification(page, rotatedToast)
    await expect(rotatedToast).toHaveCount(0)
    const copyToken = panel.getByRole('button', { name: uiText('Copy token', '复制令牌'), exact: true })
    const tokenField = panel.locator('.settings-bridge-copy-field[data-copy-kind="token"]')
    await tokenField.scrollIntoViewIfNeeded()
    await expect(copyToken).toBeEnabled()
    await expectHit(copyToken)
    await expect(tokenField).toBeInViewport({ ratio: 1 })
    await record(page, app, panel, testInfo, 'bridge-rotate-retry-and-readable-service')
    await page.clock.resume()
  })
})

async function enterFieldAndReturn(page: Page, trigger: Locator, field: Locator) {
  // Choose the action again after deliberately closing the notification/history surface, then use actual Tab navigation.
  await trigger.scrollIntoViewIfNeeded()
  await trigger.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(field).toBeFocused()
  await expect(field).toBeEnabled()
  await expectHit(field)
  await page.keyboard.press('Tab')
  await expect(trigger).toBeFocused()
}
