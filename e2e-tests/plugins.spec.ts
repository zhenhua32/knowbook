import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  closeElectronApp, ensureDocumentMetadataEditor, hasBuiltElectronApp, launchElectronApp,
  uiText, withElectronApp, type ElectronAppContext
} from './helpers/electron'

async function openPage(page: Page, en: string, zh: string): Promise<void> {
  const button = page.locator('button.nav-icon-btn').and(page.getByTitle(uiText(en, zh))).first()
  await button.click()
  await expect(button).toHaveClass(/active/)
}

async function selectInstallDirectory(context: ElectronAppContext, sourceDirectory: string): Promise<void> {
  await context.app.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0, checkboxChecked: false }) })
    Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [path] }) })
  }, sourceDirectory)
}

test.describe('Plugin systems @electron', () => {
  test('shows workspace plugins in one column with inline permissions, revision history, and runtime logs', async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
    await withElectronApp(async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1100 })
      await openPage(page, 'Plugins', '插件中心')
      await expect(page.locator('.plugin-inventory-head h4')).toHaveText(uiText('Workspace plugins', '工作区插件'))
      await expect(page.locator('.plugin-inspector')).toHaveCount(0)
      const item = page.locator('.plugin-item').filter({ hasText: 'Activity Pulse v2' }).first()
      const toggle = item.locator('button.plugin-details-toggle')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(item.locator('.plugin-card-meta')).toContainText(/Source: Built in|来源：内置/)
      await page.screenshot({ path: testInfo.outputPath('plugins-list-wide.png'), fullPage: true })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(item.locator('section.plugin-inspector.plugin-inline-details')).toBeVisible()
      const details = page.locator('.plugin-technical-details')
      await expect(details.getByText(uiText('Current permissions', '当前权限'))).toBeVisible()
      await expect(details).toContainText('documents.read@1')
      await expect(details.getByText(uiText('Revision history', '版本历史'))).toBeVisible()
      await expect(details).toContainText('1.0.0')
      await expect(details.getByText(uiText('Recent runtime logs', '最近运行日志'))).toBeVisible()
      const layout = await page.evaluate(() => {
        const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
        const management = bounds('.plugin-management-layout')
        const inventory = bounds('.plugin-inventory-panel')
        const item = bounds('.plugin-item')
        const summary = bounds('.plugin-card-main')
        const details = bounds('.plugin-inline-details')
        return {
          availableWidth: management.width, inventoryWidth: inventory.width,
          itemLeft: item.left, itemRight: item.right, summaryBottom: summary.bottom,
          detailsTop: details.top, detailsLeft: details.left, detailsRight: details.right,
          viewportWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth
        }
      })
      expect(layout.inventoryWidth).toBeGreaterThanOrEqual(layout.availableWidth - 2)
      expect(layout.detailsTop).toBeGreaterThanOrEqual(layout.summaryBottom)
      expect(layout.detailsLeft).toBeGreaterThanOrEqual(layout.itemLeft)
      expect(layout.detailsRight).toBeLessThanOrEqual(layout.itemRight)
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth)
      await page.screenshot({ path: testInfo.outputPath('plugins-inline-details-wide.png'), fullPage: true })
      await toggle.click()
      await expect(page.locator('.plugin-inspector')).toHaveCount(0)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await page.getByRole('searchbox', { name: uiText('Search plugins', '搜索插件') }).fill('unmatched-plugin')
      await expect(page.locator('.plugin-inspector')).toHaveCount(0)
      await page.getByRole('searchbox', { name: uiText('Search plugins', '搜索插件') }).clear()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('.plugin-inspector')).toHaveCount(0)
      await page.setViewportSize({ width: 820, height: 1100 })
      await toggle.click()
      await expect(item.locator('.plugin-inline-details')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('plugins-inline-details-narrow.png'), fullPage: true })
    })
  })

  test('does not execute or expose v1 plugins and rejects their manifests during v3 install', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
    const userDataRoot = mkdtempSync(join(tmpdir(), 'knowbook-no-v1-'))
    const source = join(userDataRoot, 'plugins', 'retired-v1')
    const marker = join(userDataRoot, 'v1-must-not-run.txt')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'retired-v1', name: 'Retired V1 Fixture', version: '1.0.0', entry: 'index.js', enabledByDefault: true }))
    writeFileSync(join(source, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports.activate = function () { throw new Error('v1 must never load'); };`)
    let context: ElectronAppContext | null = null
    try {
      context = await launchElectronApp({}, { userDataRoot })
      await openPage(context.page, 'Plugins', '插件中心')
      await expect(context.page.getByText('Retired V1 Fixture', { exact: true })).toHaveCount(0)
      await expect(context.page.getByText(/Legacy v1|旧版插件目录/)).toHaveCount(0)
      await expect(context.page.getByRole('button', { name: /Reload plugins|重载插件|重新扫描/ })).toHaveCount(0)
      const exposed = await context.page.evaluate(() => {
        const api = window.knowbook as unknown as Record<string, unknown>
        return ['installPluginFromFolder', 'reloadPlugins', 'reloadPlugin', 'setPluginEnabled', 'updatePluginSetting', 'removePlugin'].filter((name) => name in api)
      })
      expect(exposed).toEqual([])
      expect(existsSync(marker)).toBe(false)
      await selectInstallDirectory(context, source)
      const error = await context.page.evaluate(async () => {
        try { await window.knowbook.chooseAndPrepareSystemPluginInstall(); return null }
        catch (cause) { return String(cause) }
      })
      expect(error).toMatch(/schemaVersion|System Plugin|system plugin|version 3|schema version/i)
      expect(existsSync(marker)).toBe(false)
      expect(await context.page.evaluate(() => window.knowbook.listSystemPlugins())).toEqual([])
    } finally {
      if (context) await closeElectronApp(context)
      rmSync(userDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('installs Activity Pulse with exact Full Trust consent, preserves settings, and runs v3 document actions after restart', async () => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
    let context: ElectronAppContext | null = null
    let retainedRoot: string | null = null
    try {
      context = await launchElectronApp()
      retainedRoot = context.tempRoot
      await expect(context.page.getByTestId('activity-pulse-dashboard')).toHaveCount(0)
      expect(await context.page.evaluate(() => window.knowbook.listSystemPlugins())).toEqual([])
      await selectInstallDirectory(context, resolve('plugins/activity-pulse'))
      const prepared = await context.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
      expect(prepared?.pluginId).toBe('activity-pulse')
      expect(prepared?.status).toBe('awaiting-confirmation')
      await openPage(context.page, 'Plugins', '插件中心')
      const request = context.page.locator('.system-plugin-request').filter({ hasText: 'Activity Pulse' }).first()
      await expect(request).toContainText(`SHA-256: ${prepared!.artifactSha256}`)
      const confirm = request.getByRole('button', { name: uiText('Confirm system install', '确认系统安装') })
      await expect(confirm).toBeDisabled()
      await request.locator('input[type="checkbox"]').check()
      await request.locator('.plugin-field input').fill('wrong-id')
      await expect(confirm).toBeDisabled()
      await request.locator('.plugin-field input').fill('activity-pulse')
      await confirm.click()
      await expect(request.locator('.plugin-status')).toHaveText('pending-restart')
      await openPage(context.page, 'Dashboard', '总览')
      await expect(context.page.getByTestId('activity-pulse-dashboard')).toHaveCount(0)
      await closeElectronApp(context, { preserveUserData: true })
      context = null
      context = await launchElectronApp({}, { userDataRoot: retainedRoot })
      await expect.poll(async () => {
        const plugin = (await context!.page.evaluate(() => window.knowbook.listSystemPlugins()))
          .find((candidate) => candidate.pluginId === 'activity-pulse')
        return plugin?.status === 'active' && plugin.runtimeStatus === 'active'
          ? 'active' : JSON.stringify({ status: plugin?.status, runtimeStatus: plugin?.runtimeStatus, error: plugin?.lastError, run: plugin?.lastRun })
      }, { message: 'Activity Pulse Main and Renderer must activate after the confirmed restart' }).toBe('active')
      await openPage(context.page, 'Dashboard', '总览')
      await expect(context.page.getByTestId('activity-pulse-dashboard')).toBeVisible()
      await openPage(context.page, 'Settings', '配置中心')
      const settings = context.page.getByTestId('activity-pulse-settings')
      await settings.getByLabel('摘要前缀').fill('E2E 前缀：')
      await settings.getByRole('button', { name: '保存摘要前缀' }).click()
      await expect(settings.getByRole('status')).toHaveText('摘要前缀已保存。')
      const documentId = await context.page.evaluate(async () => {
        const created = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(created.id, {
          title: 'Activity Pulse v3 验收', summary: '原摘要',
          blocks: [{ type: 'text', content: '  第一段\n 正文  ', checked: false, depth: 0 }]
        })
        return created.id
      })
      await openPage(context.page, 'Dashboard', '总览')
      await expect(context.page.getByTestId('activity-pulse-dashboard')).toContainText('Activity Pulse v3 验收')
      await openPage(context.page, 'Documents', '文档')
      await context.page.locator('.tree-button', { hasText: 'Activity Pulse v3 验收' }).first().click()
      await context.page.getByTestId('activity-pulse-action').getByRole('button', { name: '从首个内容块生成摘要' }).click()
      await expect(context.page.getByTestId('activity-pulse-action').getByRole('status')).toHaveText('已从首个非空内容块更新摘要。')
      await ensureDocumentMetadataEditor(context.page)
      await expect(context.page.locator('.document-summary-card .editor-textarea').first()).toHaveValue('E2E 前缀：第一段 正文')
      expect(await context.page.evaluate(async (id) => (await window.knowbook.getDocumentDetail(id))?.summary, documentId)).toBe('E2E 前缀：第一段 正文')
      await closeElectronApp(context, { preserveUserData: true })
      context = null
      context = await launchElectronApp({}, { userDataRoot: retainedRoot })
      await openPage(context.page, 'Settings', '配置中心')
      await expect(context.page.getByTestId('activity-pulse-settings').getByLabel('摘要前缀')).toHaveValue('E2E 前缀：')
      const activeRevision = await context.page.evaluate(async () => {
        const plugin = (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === 'activity-pulse')
        return `sha256:${plugin!.currentArtifactSha256}`
      })
      await context.page.evaluate(() => window.knowbook.setSystemPluginEnabled({ pluginId: 'activity-pulse', enabled: false }))
      await expect(context.page.getByTestId('activity-pulse-settings')).toHaveCount(0)
      const inactiveCall = await context.page.evaluate(async (revisionHash) => {
        try {
          await window.knowbook.invokeSystemPluginMain({ pluginId: 'activity-pulse', revisionHash, method: 'get-state' })
          return null
        } catch (error) { return String(error) }
      }, activeRevision)
      expect(inactiveCall).toMatch(/active|disposed|registered/i)
      await closeElectronApp(context, { preserveUserData: true })
      context = null
      context = await launchElectronApp({}, { userDataRoot: retainedRoot })
      await openPage(context.page, 'Dashboard', '总览')
      await expect(context.page.getByTestId('activity-pulse-dashboard')).toHaveCount(0)
      await openPage(context.page, 'Settings', '配置中心')
      await expect(context.page.getByTestId('activity-pulse-settings')).toHaveCount(0)
    } finally {
      if (context) await closeElectronApp(context)
      if (retainedRoot) rmSync(retainedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
