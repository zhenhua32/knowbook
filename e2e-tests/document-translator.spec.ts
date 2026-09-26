import { expect, test, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { closeElectronApp, hasBuiltElectronApp, launchElectronApp, uiText, withElectronApp, type ElectronAppContext } from './helpers/electron'

const pluginId = 'document-translator'

async function openDocuments(page: Page): Promise<void> {
  await page.locator('button.nav-icon-btn').and(page.getByTitle(uiText('Documents', '文档'))).first().click()
}

async function expectActive(page: Page): Promise<void> {
  await expect.poll(async () => {
    const plugin = (await page.evaluate(() => window.knowbook.listSystemPlugins()))
      .find((entry) => entry.pluginId === pluginId)
    return { source: plugin?.source, enabled: plugin?.enabled, status: plugin?.status, runtimeStatus: plugin?.runtimeStatus }
  }).toEqual({ source: 'builtin', enabled: true, status: 'active', runtimeStatus: 'active' })
  await openDocuments(page)
  await expect(page.getByTestId('document-translator')).toHaveCount(0)
  await page.locator('.document-header-more-button').click()
  await expect(page.locator('.document-header-action-menu').getByTestId('document-translator')).toBeVisible()
  await expect(page.locator('.page-documents').getByTestId('document-translator')).toHaveCount(0)
}

test('built-in document translator lives in the More menu and preserves manual opt-out across restarts @electron', async ({}, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  let context: ElectronAppContext | null = null
  let retainedRoot: string | null = null
  try {
    context = await launchElectronApp()
    retainedRoot = context.tempRoot
    await expectActive(context.page)
    expect(await context.page.evaluate(() => window.knowbook.listSystemPluginInstallRequests())).toEqual([])
    const panel = context.page.getByTestId('document-translator')
    await expect(panel.getByRole('button', { name: '翻译成中文', exact: true })).toBeDisabled()
    await expect(panel.getByRole('button', { name: '生成双语对照', exact: true })).toBeDisabled()
    await expect(panel.getByRole('button', { name: '翻译成中文', exact: true })).toHaveAttribute('title', /请先在 KnowBook 设置中启用 AI/)
    await context.page.locator('.document-header-action-menu').screenshot({ path: testInfo.outputPath('translation-more-menu.png') })
    await context.page.locator('.context-menu-overlay').click({ position: { x: 1, y: 1 } })
    await expect(panel).toHaveCount(0)
    await context.page.screenshot({ path: testInfo.outputPath('document-without-translation-banner.png') })
    await context.page.locator('.document-header-more-button').click()
    await expect(panel).toBeVisible()
    const state = await context.page.evaluate(async () => {
      const plugin = (await window.knowbook.listSystemPlugins()).find((entry) => entry.pluginId === 'document-translator')!
      return window.knowbook.invokeSystemPluginMain({
        pluginId: plugin.pluginId, revisionHash: `sha256:${plugin.currentArtifactSha256}`, method: 'get-state'
      })
    })
    expect(state).toMatchObject({ aiReady: false, job: null })

    await context.page.evaluate(() => window.knowbook.setSystemPluginEnabled({ pluginId: 'document-translator', enabled: false }))
    await expect(panel).toHaveCount(0)
    await expect(context.page.locator('style[data-full-trust-plugin="document-translator"]')).toHaveCount(0)
    await closeElectronApp(context, { preserveUserData: true })
    context = null

    context = await launchElectronApp({}, { userDataRoot: retainedRoot })
    await openDocuments(context.page)
    await context.page.locator('.document-header-more-button').click()
    await expect(context.page.getByTestId('document-translator')).toHaveCount(0)
    expect((await context.page.evaluate(() => window.knowbook.listSystemPlugins()))
      .find((entry) => entry.pluginId === pluginId)?.enabled).toBe(false)
    await context.page.evaluate(() => window.knowbook.setSystemPluginEnabled({ pluginId: 'document-translator', enabled: true }))
    await closeElectronApp(context, { preserveUserData: true })
    context = null

    context = await launchElectronApp({}, { userDataRoot: retainedRoot })
    await expectActive(context.page)
    expect(await context.page.evaluate(() => window.knowbook.listSystemPluginInstallRequests())).toEqual([])
  } finally {
    if (context) await closeElectronApp(context)
    if (retainedRoot) {
      const relativeRoot = relative(resolve(tmpdir()), resolve(retainedRoot))
      assertTempProfile(relativeRoot)
      rmSync(retainedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

function assertTempProfile(path: string): void {
  if (!path || isAbsolute(path) || !/^knowbook-e2e-[^/\\]+$/.test(path)) {
    throw new Error('Refusing to remove a profile outside the temporary Electron test directory.')
  }
}

test('translation notifications survive closed menus and page changes, open results, cancel and report failures @electron', async ({}, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  const replies: Array<(fail?: boolean) => void> = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as { messages: Array<{ content: string }> }
      const { translations } = JSON.parse(payload.messages[1].content) as { translations: Array<{ id: string; text: string }> }
      replies.push((fail = false) => {
        if (response.destroyed) return
        response.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(fail ? { error: 'Simulated AI outage' } : {
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            translations: translations.map(({ id, text }) => ({ id, text: text.replace(/\bHome\b/g, '首页') }))
          }) } }]
        }))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  try {
    await withElectronApp(async ({ page, app }) => {
      await expectActive(page)
      await page.locator('.context-menu-overlay').click({ position: { x: 1, y: 1 } })
      await page.evaluate((url) => window.knowbook.updateAiConfig({
        enabled: true, apiKey: 'translation-notification-test', baseUrl: url, model: 'mock-translation',
        autoSummaryOnSave: false, relatedNotesEnabled: false
      }), baseUrl)
      const originalCount = await page.evaluate(async () => (await window.knowbook.getHomeData()).summary.documents)
      await page.locator('.document-header-more-button').click()
      await expect(page.getByTestId('document-translator').getByRole('button', { name: '翻译成中文', exact: true })).toBeEnabled()
      await page.getByTestId('document-translator').getByRole('button', { name: '翻译成中文', exact: true }).click()
      await expect(page.locator('.document-header-action-menu')).toHaveCount(0)
      const notifications = page.locator('.app-notifications')
      await expect(notifications.getByText('正在翻译成中文', { exact: true })).toBeVisible()
      await expect(notifications.locator('progress')).toBeVisible()
      await expect.poll(() => replies.length).toBe(1)
      await page.getByTitle(uiText('Dashboard', '总览')).click()
      await expect(notifications.locator('progress')).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('translation-progress-notification.png') })
      // Reloading the Renderer reconnects to the existing Main job without restarting it.
      await page.reload()
      await expect(notifications.getByRole('button', { name: '取消翻译', exact: true })).toBeVisible()
      expect(replies.length).toBe(1)
      replies[0]()
      await expect(notifications.getByText('翻译完成', { exact: true })).toBeVisible()
      await expect(notifications.locator('progress')).toHaveCount(0)
      await expect(notifications.locator('.app-notification')).toHaveCount(1)
      await page.screenshot({ path: testInfo.outputPath('translation-result-notification.png') })
      await notifications.getByRole('button', { name: '打开译文', exact: true }).click()
      await expect(page.locator('.document-header-title')).toContainText('（中文）')
      await expect.poll(async () => (await page.evaluate(() => window.knowbook.getHomeData())).summary.documents).toBe(originalCount + 1)
      await page.locator('.document-header-more-button').click()
      const menu = page.locator('.document-header-action-menu')
      await expect(menu.locator('progress')).toHaveCount(0)
      await expect(menu).not.toContainText('已生成')
      await expect(menu.getByRole('button', { name: '取消翻译' })).toHaveCount(0)
      await menu.screenshot({ path: testInfo.outputPath('translation-actions-only.png') })
      await page.locator('.context-menu-overlay').click({ position: { x: 1, y: 1 } })
      await notifications.getByRole('button', { name: uiText('Dismiss notification', '关闭通知') }).click()
      await expect(notifications).toHaveCount(0)

      await page.locator('.document-header-more-button').click()
      await expect(page.getByTestId('document-translator').getByRole('button', { name: '生成双语对照', exact: true })).toBeEnabled()
      await expect(notifications).toHaveCount(0)
      await page.getByTestId('document-translator').getByRole('button', { name: '生成双语对照', exact: true }).click()
      await expect.poll(() => replies.length).toBe(2)
      await notifications.getByRole('button', { name: '取消翻译', exact: true }).click()
      await expect(notifications.getByText('翻译已取消', { exact: true })).toBeVisible()
      replies[1]()

      // Directly seeded settings apply when the shell reloads its preferences.
      await page.evaluate(() => window.knowbook.saveSetting('appearance.theme', 'dark'))
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.locator('.document-header-more-button').click()
      await page.getByTestId('document-translator').getByRole('button', { name: '翻译成中文', exact: true }).click()
      await expect.poll(() => replies.length).toBe(3)
      replies[2](true)
      await expect(notifications.getByRole('alert')).toContainText('翻译失败')
      await page.screenshot({ path: testInfo.outputPath('translation-error-notification-dark.png') })
      expect((await page.evaluate(() => window.knowbook.getHomeData())).summary.documents).toBe(originalCount + 1)
      await page.evaluate(() => window.knowbook.setSystemPluginEnabled({ pluginId: 'document-translator', enabled: false }))
      await expect(notifications).toHaveCount(0)

      // The pre-existing v2 notification channel now reaches the same host surface.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('knowbook:plugin-notification', {
        title: 'Plugin notice', message: 'Connected notification channel', level: 'success'
      }))
      await expect(notifications).toContainText('Connected notification channel')
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
