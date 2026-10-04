import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import type { UpdateWebClipBridgeSettingsInput, WebClipBridgeStatus } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type ReadHandler = (event: IpcMainInvokeEvent) => WebClipBridgeStatus | Promise<WebClipBridgeStatus>
type MutationHandler = (event: IpcMainInvokeEvent, input: UpdateWebClipBridgeSettingsInput) => WebClipBridgeStatus | Promise<WebClipBridgeStatus>
type CopyProbe = {
  originalRead: ReadHandler
  originalMutation: MutationHandler
  clipboardTexts: string[]
  pendingCopies: Array<{ resolve: () => void; reject: (error: Error) => void }>
  writes: UpdateWebClipBridgeSettingsInput[]
  pendingMutations: Array<{ event: IpcMainInvokeEvent; input: UpdateWebClipBridgeSettingsInput;
    resolve: (status: WebClipBridgeStatus) => void; reject: (error: Error) => void }>
}
type ProbeGlobal = typeof globalThis & { __knowbookBridgeCopyProbe?: CopyProbe }

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, ReadHandler | MutationHandler> })._invokeHandlers
    const originalRead = handlers.get('knowbook:get-web-clip-bridge-status') as ReadHandler
    const originalMutation = handlers.get('knowbook:update-web-clip-bridge-settings') as MutationHandler
    if (!originalRead || !originalMutation) throw new Error('Missing real bridge settings handlers')
    const probe: CopyProbe = { originalRead, originalMutation, clipboardTexts: [], pendingCopies: [], writes: [], pendingMutations: [] }
    ;(globalThis as ProbeGlobal).__knowbookBridgeCopyProbe = probe
    ipcMain.removeHandler('knowbook:get-web-clip-bridge-status')
    ipcMain.handle('knowbook:get-web-clip-bridge-status', async event => {
      const status = await probe.originalRead(event)
      // Replay a known extension endpoint for copying. The actual stored bridge remains disabled; no server is started.
      return { ...status, endpoint: `http://127.0.0.1:${status.configuredPort}/clip` }
    })
    ipcMain.removeHandler('knowbook:update-web-clip-bridge-settings')
    ipcMain.handle('knowbook:update-web-clip-bridge-settings', (event, input: UpdateWebClipBridgeSettingsInput) => {
      probe.writes.push({ ...input })
      return new Promise<WebClipBridgeStatus>((resolve, reject) => probe.pendingMutations.push({ event, input, resolve, reject }))
    })
    // Never retain or delegate the clipboard handler: these tests must not change the user's clipboard.
    ipcMain.removeHandler('knowbook:write-clipboard-text')
    ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => {
      probe.clipboardTexts.push(text)
      return new Promise<void>((resolve, reject) => probe.pendingCopies.push({ resolve, reject }))
    })
  })
}

async function counts(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookBridgeCopyProbe!
    return { copies: probe.clipboardTexts.length, pendingCopies: probe.pendingCopies.length,
      writes: probe.writes, pendingMutations: probe.pendingMutations.length }
  })
}

async function copiedExactText(app: ElectronApplication, expected: string) {
  return app.evaluate((_electron, expected) =>
    (globalThis as ProbeGlobal).__knowbookBridgeCopyProbe!.clipboardTexts.at(-1) === expected, expected)
}

async function finishCopy(app: ElectronApplication, failure: 'empty' | 'obsolete' | null = null) {
  await app.evaluate((_electron, failure) => {
    const pending = (globalThis as ProbeGlobal).__knowbookBridgeCopyProbe!.pendingCopies.shift()
    if (!pending) throw new Error('No pending clipboard write')
    if (failure === 'empty') pending.reject(new Error(''))
    else if (failure === 'obsolete') pending.reject(new Error('Error: Obsolete clipboard failure'))
    else pending.resolve()
  }, failure)
}

async function finishMutation(app: ElectronApplication) {
  await app.evaluate(async () => {
    const probe = (globalThis as ProbeGlobal).__knowbookBridgeCopyProbe!
    const pending = probe.pendingMutations.shift()
    if (!pending) throw new Error('No pending bridge mutation')
    try { pending.resolve(await probe.originalMutation(pending.event, pending.input)) }
    catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
  })
}

async function seed(page: Page, app: ElectronApplication, language: 'en-US' | 'zh-CN') {
  await page.evaluate(async language => {
    await window.knowbook.updateWebClipBridgeSettings({ enabled: false, port: 4321 })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
  }, language)
  await installProbe(app)
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 760, height: language === 'zh-CN' ? 850 : 640 })
  const time = new Date('2026-10-02T00:00:00Z')
  await page.clock.install({ time })
  // Installation starts a running clock; leave time for the next protocol call before pausing.
  const pauseTime = await page.evaluate(() => Date.now() + 1000)
  await page.clock.pauseAt(pauseTime)
}

function bridgeControls(page: Page) {
  const panel = page.locator('.settings-bridge-panel')
  const copyActions = panel.locator('.settings-bridge-copy-actions')
  return { panel, copyActions, feedback: copyActions.locator('.settings-bridge-copy-feedback'),
    tokenField: copyActions.locator('.settings-bridge-copy-field[data-copy-kind="token"]'),
    endpointField: copyActions.locator('.settings-bridge-copy-field[data-copy-kind="endpoint"]'),
    copyButtons: copyActions.locator('.settings-bridge-copy-button'),
    copyEndpoint: copyActions.getByRole('button', { name: uiText('Copy endpoint', '复制提交地址'), exact: true }),
    copyToken: copyActions.getByRole('button', { name: uiText('Copy token', '复制令牌'), exact: true }),
    save: panel.locator('.settings-form-actions').getByRole('button', { name: /^(?:Save bridge settings|保存桥接设置|Saving\.\.\.|保存中\.\.\.)$/ }),
    rotate: panel.getByRole('button', { name: uiText('Regenerate token', '重新生成令牌'), exact: true }),
    port: panel.getByLabel(uiText('Listening port', '监听端口'), { exact: true }),
    enabled: panel.getByLabel(uiText('Enable local web clip bridge service', '启用本地网页剪藏桥接服务'), { exact: true }),
    token: panel.getByLabel(uiText('Authorization token', '授权令牌'), { exact: true }),
    endpoint: panel.getByLabel(uiText('Extension endpoint', '扩展提交地址'), { exact: true }) }
}
type BridgeControls = ReturnType<typeof bridgeControls>

async function openBridge(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏'), exact: true }).click()
  const controls = bridgeControls(page)
  await expect(controls.panel).toBeVisible()
  await expect(controls.port).toHaveValue('4321')
  await expect(controls.copyEndpoint).toBeEnabled()
  await expect(controls.copyToken).toBeEnabled()
  return controls
}

async function expectHit(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 })
  const point = await control.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { reachable: hit === element || Boolean(hit && element.contains(hit)),
      target: { tag: element.tagName, className: element.className, top: rect.top, bottom: rect.bottom },
      hit: hit ? { tag: hit.tagName, className: hit.className } : null }
  })
  expect(point.reachable, JSON.stringify(point)).toBe(true)
}

async function enter(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded()
  await expectHit(control)
  await control.focus()
  await expect(control).toBeFocused()
  await page.keyboard.press('Enter')
}

async function expectCopying(controls: BridgeControls, kind: 'endpoint' | 'token') {
  const buttons = controls.copyButtons
  await expect(buttons).toHaveCount(2)
  for (const button of await buttons.all()) await expect(button).toBeDisabled()
  await expect(controls.tokenField.locator('.settings-bridge-token-visibility')).toBeEnabled()
  const field = kind === 'endpoint' ? controls.endpointField : controls.tokenField
  const actions = field.locator('.settings-actions')
  const feedback = field.locator('.settings-bridge-copy-feedback')
  const current = field.getByRole('button', { name: uiText('Copying…', '正在复制…'), exact: true })
  await expect(current).toHaveAttribute('aria-busy', 'true')
  await expect(controls.copyActions.locator('.settings-bridge-copy-button[aria-busy="false"]')).toHaveCount(1)
  const status = feedback.getByRole('status')
  await expect(status).toHaveText(kind === 'endpoint'
    ? uiText('Copying the web clip bridge endpoint…', '正在复制网页剪藏提交地址…')
    : uiText('Copying the web clip bridge token…', '正在复制网页剪藏令牌…'))
  expect(await status.evaluate(element => Boolean(element.closest('[aria-busy="true"]')))).toBe(false)
  await expect(field).toBeInViewport({ ratio: 1 })
  await expect(feedback).toBeInViewport({ ratio: 1 })
  await expect(actions).toBeInViewport({ ratio: 1 })
  const before = await actions.boundingBox(), after = await feedback.boundingBox()
  expect(before).not.toBeNull(); expect(after).not.toBeNull()
  expect(before!.y + before!.height).toBeLessThanOrEqual(after!.y + 1)
  expect(after!.y - before!.y - before!.height).toBeLessThan(48)
}

async function expectMutationBlocksCopy(controls: BridgeControls, app: ElectronApplication, expectedCopies: number) {
  const buttons = controls.copyButtons
  await expect(buttons).toHaveCount(2)
  for (const button of await buttons.all()) await expect(button).toBeDisabled()
  await buttons.evaluateAll(elements => elements.forEach(element => (element as HTMLButtonElement).click()))
  expect((await counts(app)).copies).toBe(expectedCopies)
}

async function dismissNotifications(page: Page) {
  const viewport = page.viewportSize()!
  try {
    // Compact summaries retain hidden full cards; dismiss through visible controls.
    await page.setViewportSize({ width: Math.max(viewport.width, 1000), height: Math.max(viewport.height, 800) })
    await expect(page.getByTestId('notification-summary')).toHaveCount(0)
    const dismiss = page.locator('.app-notifications > .app-notification')
      .getByRole('button', { name: uiText('Dismiss notification', '关闭通知'), exact: true })
    while (await dismiss.count()) await dismiss.first().click()
    await expect(page.locator('.app-notifications')).toHaveCount(0)
  } finally {
    await page.setViewportSize(viewport)
  }
}

async function record(page: Page, app: ElectronApplication, controls: BridgeControls, testInfo: TestInfo, phase: string) {
  const geometry = await controls.copyActions.evaluate(element => {
    const describe = (target: Element) => {
      const rect = target.getBoundingClientRect()
      return { text: target.textContent, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
    }
    return { viewport: { width: innerWidth, height: innerHeight },
      feedback: [...element.querySelectorAll('.settings-action-feedback')].map(describe),
      buttons: [...element.querySelectorAll('button')].map(describe),
      activeTag: document.activeElement?.tagName,
      activeText: document.activeElement?.tagName === 'BUTTON' ? document.activeElement.textContent : null }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const body = JSON.stringify({ geometry, windows, requests: await counts(app) }, null, 2)
  console.log(`[bridge-copy:${phase}] ${body}`)
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`), mask: [controls.token] })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`bridge copying is single-flight, retries a failed clipboard write and copies only the newly saved token (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page }) => {
      await seed(page, app, language)
      const controls = await openBridge(page)
      const endpointText = await controls.endpoint.inputValue()
      const originalToken = await controls.token.inputValue()
      await controls.copyEndpoint.scrollIntoViewIfNeeded()
      await expectHit(controls.copyEndpoint)
      await controls.copyEndpoint.click()
      await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
      expect(await copiedExactText(app, endpointText)).toBe(true)
      await expectCopying(controls, 'endpoint')
      await expect(controls.port).toBeEnabled()
      await expect(controls.save).toBeEnabled()
      await expect(controls.rotate).toBeEnabled()
      await record(page, app, controls, testInfo, 'endpoint-copy-pending')

      await finishCopy(app, 'empty')
      await expect(controls.copyEndpoint).toBeEnabled()
      await expect(controls.copyToken).toBeEnabled()
      await expect(controls.copyEndpoint).toBeFocused()
      await expect(controls.feedback.getByRole('status')).toHaveCount(0)
      await expect(page.locator('.app-notifications > .app-notification.app-notification-error .app-notification-message')).toHaveText(uiText('Copy failed.', '复制失败。'))
      await record(page, app, controls, testInfo, 'endpoint-copy-failure')
      await dismissNotifications(page)
      await enter(page, controls.copyEndpoint)
      await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
      expect((await counts(app)).copies).toBe(2)
      expect(await copiedExactText(app, endpointText)).toBe(true)
      await expectCopying(controls, 'endpoint')
      await finishCopy(app)
      await expect(controls.copyEndpoint).toBeEnabled()
      await expect(controls.copyEndpoint).toBeFocused()
      await expect(page.getByTestId('notification-summary').getByText(uiText('Web clip bridge endpoint copied.', '网页剪藏提交地址已复制。'), { exact: true })).toBeVisible()
      await dismissNotifications(page)

      await controls.copyEndpoint.focus()
      await expectHit(controls.copyEndpoint)
      // A cross-kind attempt abandons the original focus intent, but must still share the synchronous copy lock.
      await controls.copyEndpoint.evaluate(button => {
        ;(button as HTMLButtonElement).click()
        ;(button as HTMLButtonElement).click()
        ;(button.closest('.settings-bridge-copy-actions')!
          .querySelector('.settings-bridge-copy-field[data-copy-kind="token"] .settings-bridge-copy-button') as HTMLButtonElement).click()
      })
      await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
      expect((await counts(app)).copies).toBe(3)
      expect(await copiedExactText(app, endpointText)).toBe(true)
      await expectCopying(controls, 'endpoint')
      await finishCopy(app)
      await expect(controls.copyEndpoint).toBeEnabled()
      await expect(controls.copyToken).toBeEnabled()
      await expect(controls.feedback.getByRole('status')).toHaveCount(0)
      await dismissNotifications(page)

      await controls.port.fill('5432')
      await enter(page, controls.save)
      await expect.poll(async () => (await counts(app)).pendingMutations).toBe(1)
      await expectMutationBlocksCopy(controls, app, 3)
      await finishMutation(app)
      await expect(controls.save).toBeEnabled()
      await expect(controls.port).toHaveValue('5432')
      await expect(controls.enabled).not.toBeChecked()
      await dismissNotifications(page)

      await enter(page, controls.rotate)
      await expect.poll(async () => (await counts(app)).pendingMutations).toBe(1)
      await expectMutationBlocksCopy(controls, app, 3)
      await expect(controls.token).toHaveValue(originalToken)
      expect((await counts(app)).writes).toEqual([
        { enabled: false, port: 5432, regenerateToken: false },
        { enabled: false, port: 5432, regenerateToken: true }
      ])
      await finishMutation(app)
      await expect(controls.rotate).toBeEnabled()
      await expect.poll(() => controls.token.inputValue()).not.toBe(originalToken)
      const newToken = await controls.token.inputValue()
      await dismissNotifications(page)
      await enter(page, controls.copyToken)
      await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
      expect((await counts(app)).copies).toBe(4)
      expect(await copiedExactText(app, newToken)).toBe(true)
      await expectCopying(controls, 'token')
      await record(page, app, controls, testInfo, 'rotated-token-copy-pending')
      await finishCopy(app)
      await expect(controls.copyToken).toBeEnabled()
      await expect(controls.copyToken).toBeFocused()
      await expect(page.getByTestId('notification-summary').getByText(uiText('Web clip bridge token copied.', '网页剪藏令牌已复制。'), { exact: true })).toBeVisible()
      await dismissNotifications(page)
      expect(await page.evaluate(async () => {
        const status = await window.knowbook.getWebClipBridgeStatus()
        return { enabled: status.enabled, running: status.running, port: status.port, configuredPort: status.configuredPort }
      })).toEqual({ enabled: false, running: false, port: null, configuredPort: 5432 })
      await record(page, app, controls, testInfo, 'copy-retry-and-rotated-token-success')
      await page.clock.resume()
    })
  })
}

test('copy acknowledgements respect user focus changes and become silent after a real token rotation @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    await seed(page, app, 'en-US')
    const controls = await openBridge(page)
    await enter(page, controls.copyToken)
    await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
    await expectCopying(controls, 'token')
    await controls.port.scrollIntoViewIfNeeded()
    await controls.port.click()
    await expect(controls.port).toBeFocused()
    await expectHit(controls.port)
    await controls.port.fill('1e4')
    await expect(controls.save).toBeDisabled()
    await controls.save.evaluate(button => (button as HTMLButtonElement).click())
    expect((await counts(app)).writes).toEqual([])
    await finishCopy(app)
    await expect(controls.copyToken).toBeEnabled()
    await expect(controls.port).toBeFocused()
    await expect(controls.port).toHaveValue('1e4')
    // Rejected invalid Save is not a new configuration generation, so the valid copy still reports success.
    await expect(page.locator('.app-notifications')).toContainText('Web clip bridge token copied.')
    await dismissNotifications(page)

    await enter(page, controls.copyToken)
    await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
    const aiTab = page.getByRole('tab', { name: 'AI', exact: true })
    await aiTab.click()
    await expect(aiTab).toBeFocused()
    await finishCopy(app)
    await expect(page.locator('.settings-ai-panel')).toBeVisible()
    await expect(aiTab).toBeFocused()
    await dismissNotifications(page)
    await page.getByRole('tab', { name: 'Web clipping', exact: true }).click()
    await expect(controls.panel).toBeVisible()
    await expect(controls.port).toHaveValue('1e4')
    await expect(controls.copyToken).toBeEnabled()

    const originalToken = await controls.token.inputValue()
    await controls.copyToken.scrollIntoViewIfNeeded()
    await expectHit(controls.copyToken)
    await controls.copyToken.click()
    await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
    await expectCopying(controls, 'token')
    expect(await copiedExactText(app, originalToken)).toBe(true)
    await enter(page, controls.rotate)
    await expect.poll(async () => (await counts(app)).pendingMutations).toBe(1)
    await expectMutationBlocksCopy(controls, app, 3)
    await finishMutation(app)
    await expect(controls.rotate).toBeEnabled()
    await expect(controls.rotate).toBeFocused()
    await expect.poll(() => controls.token.inputValue()).not.toBe(originalToken)
    await expect(controls.copyActions.getByRole('button', { name: 'Copying…', exact: true })).toBeDisabled()
    await expect(controls.port).toHaveValue('1e4')
    await expect(controls.enabled).not.toBeChecked()
    expect((await counts(app)).writes).toEqual([{ enabled: false, port: 4321, regenerateToken: true }])
    await dismissNotifications(page)
    await expect(page.locator('.app-notifications .app-notification')).toHaveCount(0)
    await finishCopy(app, 'obsolete')
    await expect(controls.copyToken).toBeEnabled()
    await expect(controls.feedback.getByRole('status')).toHaveCount(0)
    await expect(page.locator('.app-notifications .app-notification')).toHaveCount(0)
    expect((await counts(app)).pendingCopies).toBe(0)
    await controls.copyToken.scrollIntoViewIfNeeded()
    await expectHit(controls.copyToken)
    await record(page, app, controls, testInfo, 'obsolete-copy-failure-releases-without-notification')
    await page.clock.resume()
  })
})
