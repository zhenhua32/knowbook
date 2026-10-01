import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import type { UpdateWebClipBridgeSettingsInput, WebClipBridgeStatus } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type ReadHandler = (event: IpcMainInvokeEvent) => WebClipBridgeStatus | Promise<WebClipBridgeStatus>
type MutationHandler = (event: IpcMainInvokeEvent, input: UpdateWebClipBridgeSettingsInput) => WebClipBridgeStatus | Promise<WebClipBridgeStatus>
type FieldProbe = {
  originalRead: ReadHandler
  originalMutation: MutationHandler
  reads: number
  holdReads: boolean
  pendingReads: Array<{ event: IpcMainInvokeEvent; resolve: (status: WebClipBridgeStatus) => void; reject: (error: Error) => void }>
  copies: string[]
  pendingCopies: Array<{ resolve: () => void; reject: (error: Error) => void }>
  writes: UpdateWebClipBridgeSettingsInput[]
  pendingMutations: Array<{ event: IpcMainInvokeEvent; input: UpdateWebClipBridgeSettingsInput;
    resolve: (status: WebClipBridgeStatus) => void; reject: (error: Error) => void }>
}
type ProbeGlobal = typeof globalThis & { __knowbookBridgeFieldProbe?: FieldProbe }

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, ReadHandler | MutationHandler> })._invokeHandlers
    const originalRead = handlers.get('knowbook:get-web-clip-bridge-status') as ReadHandler
    const originalMutation = handlers.get('knowbook:update-web-clip-bridge-settings') as MutationHandler
    if (!originalRead || !originalMutation) throw new Error('Missing real bridge settings handlers')
    const probe: FieldProbe = { originalRead, originalMutation, reads: 0, holdReads: true, pendingReads: [],
      copies: [], pendingCopies: [], writes: [], pendingMutations: [] }
    ;(globalThis as ProbeGlobal).__knowbookBridgeFieldProbe = probe
    ipcMain.removeHandler('knowbook:get-web-clip-bridge-status')
    ipcMain.handle('knowbook:get-web-clip-bridge-status', async event => {
      probe.reads++
      if (probe.holdReads) return new Promise<WebClipBridgeStatus>((resolve, reject) => probe.pendingReads.push({ event, resolve, reject }))
      const status = await probe.originalRead(event)
      // Only the endpoint is replayed for its field; the real stored service stays disabled and never binds a port.
      return { ...status, endpoint: `http://127.0.0.1:${status.configuredPort}/clip` }
    })
    ipcMain.removeHandler('knowbook:update-web-clip-bridge-settings')
    ipcMain.handle('knowbook:update-web-clip-bridge-settings', (event, input: UpdateWebClipBridgeSettingsInput) => {
      probe.writes.push({ ...input })
      return new Promise<WebClipBridgeStatus>((resolve, reject) => probe.pendingMutations.push({ event, input, resolve, reject }))
    })
    // The native clipboard handler is intentionally not retained or called.
    ipcMain.removeHandler('knowbook:write-clipboard-text')
    ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => {
      probe.copies.push(text)
      return new Promise<void>((resolve, reject) => probe.pendingCopies.push({ resolve, reject }))
    })
  })
}

async function counts(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookBridgeFieldProbe!
    return { reads: probe.reads, pendingReads: probe.pendingReads.length, copies: probe.copies.length,
      pendingCopies: probe.pendingCopies.length, writes: probe.writes, pendingMutations: probe.pendingMutations.length }
  })
}

async function finishReads(app: ElectronApplication) {
  await app.evaluate(async () => {
    const probe = (globalThis as ProbeGlobal).__knowbookBridgeFieldProbe!
    probe.holdReads = false
    for (const pending of probe.pendingReads.splice(0)) {
      try {
        const status = await probe.originalRead(pending.event)
        pending.resolve({ ...status, endpoint: `http://127.0.0.1:${status.configuredPort}/clip` })
      } catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
    }
  })
}

async function finishCopy(app: ElectronApplication, fail = false) {
  await app.evaluate((_electron, fail) => {
    const pending = (globalThis as ProbeGlobal).__knowbookBridgeFieldProbe!.pendingCopies.shift()
    if (!pending) throw new Error('No pending clipboard write')
    // Settle the IPC independently of the inspector evaluation that controls this deferred fixture.
    setImmediate(() => {
      if (fail) pending.reject(new Error(''))
      else pending.resolve()
    })
  }, fail)
}

async function copiedExactText(app: ElectronApplication, text: string) {
  return app.evaluate((_electron, expected) => (globalThis as ProbeGlobal).__knowbookBridgeFieldProbe!.copies.at(-1) === expected, text)
}

async function finishMutation(app: ElectronApplication) {
  await app.evaluate(async () => {
    const probe = (globalThis as ProbeGlobal).__knowbookBridgeFieldProbe!
    const pending = probe.pendingMutations.shift()
    if (!pending) throw new Error('No pending bridge mutation')
    try { pending.resolve(await probe.originalMutation(pending.event, pending.input)) }
    catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
  })
}

async function setup(page: Page, app: ElectronApplication, language: 'en-US' | 'zh-CN') {
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
  await page.clock.pauseAt(new Date(time.getTime() + 1))
  await openBridge(page)
}

async function openBridge(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏'), exact: true }).click()
  await expect(page.locator('.settings-bridge-panel')).toBeVisible()
}

function controls(page: Page) {
  const panel = page.locator('.settings-bridge-panel')
  const tokenField = panel.locator('.settings-bridge-copy-field[data-copy-kind="token"]')
  const endpointField = panel.locator('.settings-bridge-copy-field[data-copy-kind="endpoint"]')
  return { panel, tokenField, endpointField,
    token: tokenField.getByLabel(uiText('Authorization token', '授权令牌'), { exact: true }),
    endpoint: endpointField.getByLabel(uiText('Extension endpoint', '扩展提交地址'), { exact: true }),
    visibility: tokenField.locator('.settings-bridge-token-visibility'),
    copyToken: tokenField.getByRole('button', { name: uiText('Copy token', '复制令牌'), exact: true }),
    copyEndpoint: endpointField.getByRole('button', { name: uiText('Copy endpoint', '复制提交地址'), exact: true }),
    port: panel.getByLabel(uiText('Listening port', '监听端口'), { exact: true }),
    rotate: panel.getByRole('button', { name: uiText('Regenerate token', '重新生成令牌'), exact: true }) }
}
type Controls = ReturnType<typeof controls>

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

async function enter(page: Page, button: Locator) {
  await button.scrollIntoViewIfNeeded()
  await expectHit(button)
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
}

async function expectWholeField(field: Locator) {
  await expect(field).toBeInViewport({ ratio: 1 })
  await expect(field.locator('input')).toBeInViewport({ ratio: 1 })
  await expect(field.locator('.settings-actions')).toBeInViewport({ ratio: 1 })
  await expect(field.locator('.settings-bridge-copy-feedback')).toBeInViewport({ ratio: 1 })
  const actions = await field.locator('.settings-actions').boundingBox()
  const feedback = await field.locator('.settings-bridge-copy-feedback').boundingBox()
  expect(actions).not.toBeNull(); expect(feedback).not.toBeNull()
  expect(actions!.y + actions!.height).toBeLessThanOrEqual(feedback!.y + 1)
  expect(feedback!.y - actions!.y - actions!.height).toBeLessThan(48)
}

async function expectNoTokenMetadata(field: Locator, token: string) {
  expect(await field.evaluate((element, token) => {
    if (element.textContent?.includes(token)) return false
    return [element, ...element.querySelectorAll('*')].every(node => [...node.attributes]
      .filter(attribute => attribute.name === 'title' || attribute.name.startsWith('aria-'))
      .every(attribute => !attribute.value.includes(token)))
  }, token)).toBe(true)
}

async function dismissSuccessNotifications(page: Page) {
  const dismiss = page.locator('.app-notifications .app-notification-success').getByRole('button', {
    name: uiText('Dismiss notification', '关闭通知'), exact: true
  })
  while (await dismiss.count()) await dismiss.first().click()
}

async function record(page: Page, app: ElectronApplication, field: Locator, token: Locator, testInfo: TestInfo, phase: string) {
  const geometry = await field.evaluate(element => {
    const describe = (target: Element) => {
      const rect = target.getBoundingClientRect()
      return { tag: target.tagName, text: target.tagName === 'INPUT' ? null : target.textContent,
        top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
    }
    return { viewport: { width: innerWidth, height: innerHeight }, field: describe(element),
      input: [...element.querySelectorAll('input')].map(describe),
      actions: [...element.querySelectorAll('.settings-actions')].map(describe),
      feedback: [...element.querySelectorAll('.settings-bridge-copy-feedback')].map(describe),
      activeTag: document.activeElement?.tagName,
      activeText: document.activeElement?.tagName === 'BUTTON' ? document.activeElement.textContent : null }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const body = JSON.stringify({ geometry, windows, requests: await counts(app) }, null, 2)
  console.log(`[bridge-fields:${phase}] ${body}`)
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`), mask: [token] })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`bridge fields mask tokens and allow a direct copy retry while the persistent failure notification stays open (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page }) => {
      await setup(page, app, language)
      const current = controls(page)
      await expect.poll(async () => (await counts(app)).pendingReads).toBeGreaterThan(0)
      await expect(current.token).toHaveAttribute('type', 'password')
      await expect.poll(async () => (await current.token.inputValue()) === '').toBe(true)
      await expect(current.visibility).toHaveAccessibleName(uiText('Show token', '显示令牌'))
      await expect(current.visibility).toBeDisabled()
      await expect(current.copyToken).toBeDisabled()
      expect((await counts(app)).copies).toBe(0)
      await finishReads(app)
      await expect(current.port).toHaveValue('4321')
      await expect(current.visibility).toBeEnabled()
      await expect(current.token).toHaveAttribute('type', 'password')
      const originalToken = await current.token.inputValue()
      expect(Boolean(originalToken)).toBe(true)
      const tokenId = await current.token.getAttribute('id')
      expect(Boolean(tokenId)).toBe(true)
      await expect(current.visibility).toHaveAttribute('aria-controls', tokenId!)
      await expect(current.token).toHaveAccessibleName(uiText('Authorization token', '授权令牌'))
      await expectNoTokenMetadata(current.tokenField, originalToken)

      await current.token.focus()
      await page.keyboard.press('Tab')
      await expect(current.visibility).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(current.copyToken).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(current.endpoint).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(current.copyEndpoint).toBeFocused()
      expect((await counts(app)).copies).toBe(0)

      await current.visibility.scrollIntoViewIfNeeded()
      await expectHit(current.visibility)
      await current.visibility.click()
      await expect(current.token).toHaveAttribute('type', 'text')
      await expect(current.visibility).toHaveAccessibleName(uiText('Hide token', '隐藏令牌'))
      await expectNoTokenMetadata(current.tokenField, originalToken)
      const readsBefore = (await counts(app)).reads
      await page.clock.runFor(4001)
      await expect.poll(async () => (await counts(app)).reads).toBeGreaterThan(readsBefore)
      await expect.poll(async () => (await current.token.inputValue()) === originalToken).toBe(true)
      await expect(current.token).toHaveAttribute('type', 'text')
      await expect(current.visibility).toHaveAccessibleName(uiText('Hide token', '隐藏令牌'))
      await record(page, app, current.tokenField, current.token, testInfo, 'same-token-poll-keeps-revealed')

      await page.getByRole('tab', { name: 'AI', exact: true }).click()
      await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏'), exact: true }).click()
      await expect(current.token).toHaveAttribute('type', 'password')
      await current.visibility.click()
      await expect(current.token).toHaveAttribute('type', 'text')
      await page.getByRole('button', { name: uiText('Documents', '文档'), exact: true }).click()
      await expect(page.locator('[data-page-id="documents"]')).toHaveAttribute('aria-current', 'page')
      await openBridge(page)
      await expect(current.token).toHaveAttribute('type', 'password')
      await expect(current.visibility).toHaveAccessibleName(uiText('Show token', '显示令牌'))

      // Hidden tokens still copy their full raw value, using only the stubbed clipboard IPC handler.
      await enter(page, current.copyToken)
      await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
      expect(await copiedExactText(app, originalToken)).toBe(true)
      await expectWholeField(current.tokenField)
      await finishCopy(app)
      await expect(current.copyToken).toBeFocused()
      await dismissSuccessNotifications(page)
      await current.visibility.click()
      await expect(current.token).toHaveAttribute('type', 'text')
      await enter(page, current.rotate)
      await expect.poll(async () => (await counts(app)).pendingMutations).toBe(1)
      expect((await counts(app)).writes).toEqual([{ enabled: false, port: 4321, regenerateToken: true }])
      await finishMutation(app)
      await expect(current.rotate).toBeEnabled()
      await expect.poll(async () => {
        const token = await current.token.inputValue()
        return Boolean(token) && token !== originalToken
      }).toBe(true)
      await expect(current.token).toHaveAttribute('type', 'password')
      await expect(current.visibility).toHaveAccessibleName(uiText('Show token', '显示令牌'))
      const newToken = await current.token.inputValue()
      await expectNoTokenMetadata(current.tokenField, newToken)
      await dismissSuccessNotifications(page)
      await enter(page, current.copyToken)
      await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
      expect(await copiedExactText(app, newToken)).toBe(true)

      let failedKind: 'token' | 'endpoint' = 'token'
      let expectedText = newToken
      if (language === 'zh-CN') {
        await finishCopy(app)
        await expect(current.copyToken).toBeFocused()
        await dismissSuccessNotifications(page)
        const readsBeforeEndpoint = (await counts(app)).reads
        await page.clock.runFor(4000)
        await expect.poll(async () => (await counts(app)).reads).toBeGreaterThan(readsBeforeEndpoint)
        await expect(current.token).toHaveAttribute('type', 'password')
        expectedText = await current.endpoint.inputValue()
        failedKind = 'endpoint'
        await enter(page, current.copyEndpoint)
        await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
        expect(await copiedExactText(app, expectedText)).toBe(true)
      }
      const field = failedKind === 'token' ? current.tokenField : current.endpointField
      const copy = failedKind === 'token' ? current.copyToken : current.copyEndpoint
      await expectWholeField(field)
      try { await finishCopy(app, true) }
      catch (error) {
        const child = app.process()
        const diagnostics: Record<string, unknown> = { exitCode: child.exitCode, signalCode: child.signalCode,
          killed: child.killed, pageClosed: page.isClosed() }
        try {
          diagnostics.windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
            visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
          })))
        } catch (reason) { diagnostics.mainQueryError = String(reason) }
        try {
          diagnostics.renderer = await field.evaluate(element => {
            const rect = element.getBoundingClientRect()
            return { text: element.textContent, top: rect.top, bottom: rect.bottom,
              activeTag: document.activeElement?.tagName,
              notifications: [...document.querySelectorAll('.app-notifications .app-notification-message')].map(item => item.textContent) }
          })
          await page.screenshot({ path: testInfo.outputPath('clipboard-rejection-transport-error.png'), mask: [current.token] })
        } catch (reason) { diagnostics.rendererQueryError = String(reason) }
        const body = JSON.stringify(diagnostics, null, 2)
        console.log(`[bridge-fields:clipboard-rejection-transport-error] ${body}`)
        await testInfo.attach('clipboard-rejection-transport-error', { body, contentType: 'application/json' })
        throw error
      }
      await expect(copy).toBeEnabled()
      await expect(copy).toBeFocused()
      const failure = page.locator('.app-notifications .app-notification-error')
      await expect(failure).toHaveCount(1)
      await expect(failure.locator('.app-notification-message')).toHaveText(uiText('Copy failed.', '复制失败。'))
      const notificationId = await failure.getAttribute('data-notification-id')
      await record(page, app, field, current.token, testInfo, `${failedKind}-failure-toast-kept-open`)
      // Keep the persistent failure toast and the paused clock intact: no dismiss, forced click, or error scrolling.
      await expectWholeField(field)
      await expectHit(copy)
      const copiesBeforeRetry = (await counts(app)).copies
      await copy.click()
      await expect.poll(async () => (await counts(app)).pendingCopies).toBe(1)
      expect((await counts(app)).copies).toBe(copiesBeforeRetry + 1)
      expect(await copiedExactText(app, expectedText)).toBe(true)
      await expect(failure).toHaveAttribute('data-notification-id', notificationId!)
      await expectWholeField(field)
      const status = field.locator('.settings-bridge-copy-feedback').getByRole('status')
      await expect(status).toHaveText(failedKind === 'token'
        ? uiText('Copying the web clip bridge token…', '正在复制网页剪藏令牌…')
        : uiText('Copying the web clip bridge endpoint…', '正在复制网页剪藏提交地址…'))
      expect(await status.evaluate(element => Boolean(element.closest('[aria-busy="true"]')))).toBe(false)
      await finishCopy(app)
      await expect(copy).toBeEnabled()
      await expect(copy).toBeFocused()
      await expect(failure).toHaveAttribute('data-notification-id', notificationId!)
      await expect(current.token).toHaveAttribute('type', 'password')
      await expectNoTokenMetadata(current.tokenField, newToken)
      await record(page, app, field, current.token, testInfo, `${failedKind}-mouse-retry-with-failure-toast-preserved`)
      await page.clock.resume()
    })
  })
}
