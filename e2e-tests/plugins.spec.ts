import { expect, test, type Locator, type Page } from '@playwright/test'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

function getLegacyPluginList(page: Page): Locator {
  return page.locator('.plugin-list').filter({ has: page.locator('.plugin-status-legacy') })
}

function getPluginItem(page: Page): Locator {
  return getLegacyPluginList(page).locator('.plugin-item').filter({ hasText: 'Activity Pulse' }).first()
}

function getV2PluginItem(page: Page): Locator {
  return page.locator('.plugin-item').filter({ hasText: 'Activity Pulse v2' }).first()
}

function getLegacyDashboardCard(page: Page): Locator {
  return page.locator('.plugin-dashboard-card').filter({
    has: page.locator('.pill').filter({ hasText: /^activity-pulse$/ })
  })
}

function getLegacyDocumentAction(page: Page): Locator {
  return page.getByRole('button', { name: 'Summary from first block', exact: true })
}

function getTitleInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-input').first()
}

function getSummaryInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-textarea').first()
}

function getBodyEditor(page: Page): Locator {
  return page.locator('textarea.block-inline-textarea').nth(1)
}

function getPreviewTitle(page: Page): Locator {
  return page.locator('.preview-panel .panel-head h3')
}

function getTreeButton(page: Page, title: string): Locator {
  return page.locator('.tree-button', { hasText: title }).first()
}

async function openPluginsPage(page: Page): Promise<void> {
  const navigationButton = page.locator('button.nav-icon-btn').and(page.getByTitle(uiText('Plugins', '插件中心'))).first()
  await navigationButton.click()
  await expect(navigationButton).toHaveClass(/active/)
  await expect(getLegacyPluginList(page)).toBeVisible()
}

async function openDashboardPage(page: Page): Promise<void> {
  const navigationButton = page.locator('button.nav-icon-btn').and(page.getByTitle(uiText('Dashboard', '总览'))).first()
  await navigationButton.click()
  await expect(navigationButton).toHaveClass(/active/)
}

async function openDocumentsPage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Documents', '文档')).first().click()
  await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()
}

async function createRootDocument(page: Page, title: string, body: string): Promise<string> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await ensureDocumentMetadataEditor(page)
  await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
  const initialTitle = await getTitleInput(page).inputValue()
  await getTitleInput(page).fill(title)
  await getBodyEditor(page).fill(body)
  await page.getByRole('button', { name: uiText('Save', '保存') }).click()
  await expect(getPreviewTitle(page)).toHaveText(title)
  return initialTitle
}

async function ensureAuxPanelVisible(page: Page): Promise<void> {
  const actionButton = getLegacyDocumentAction(page)

  if (await actionButton.isVisible().catch(() => false)) {
    return
  }

  const showAuxButton = page.getByRole('button', { name: uiText('Show auxiliary', '展开辅助区') })
  if (await showAuxButton.isVisible().catch(() => false)) {
    await showAuxButton.click()
  }

  await expect(actionButton).toBeVisible()
}

async function enableActivityPulse(page: Page): Promise<void> {
  await openPluginsPage(page)

  const pluginItem = getPluginItem(page)
  const toggle = pluginItem.locator('.plugin-toggle-row input[type="checkbox"]')
  if (await toggle.isChecked()) {
    await expect(pluginItem.locator('.plugin-status-running')).toBeVisible()
    return
  }

  await pluginItem.locator('.plugin-toggle-row').click()
  await expect(toggle).toBeChecked()
  await expect(pluginItem.locator('.plugin-status-running')).toBeVisible()
}

async function disableActivityPulse(page: Page): Promise<void> {
  await openPluginsPage(page)

  const pluginItem = getPluginItem(page)
  const toggle = pluginItem.locator('.plugin-toggle-row input[type="checkbox"]')
  if (!(await toggle.isChecked())) {
    await expect(pluginItem.locator('.plugin-status-disabled')).toBeVisible()
    return
  }

  await pluginItem.locator('.plugin-toggle-row').click()
  await expect(toggle).not.toBeChecked()
  await expect(pluginItem.locator('.plugin-status-disabled')).toBeVisible()
}

test.describe('Plugin System @electron', () => {
  test('inspects v2 permissions, revision history, and runtime logs on demand', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await openPluginsPage(page)
      await getV2PluginItem(page).click()

      const details = page.locator('.plugin-technical-details')
      await expect(details).toBeVisible()
      await expect(details.getByText(uiText('Current permissions', '当前权限'))).toBeVisible()
      await expect(details).toContainText('documents.read@1')
      await expect(details.getByText(uiText('Revision history', '版本历史'))).toBeVisible()
      await expect(details).toContainText('1.0.0')
      await expect(details.getByText(uiText('Recent runtime logs', '最近运行日志'))).toBeVisible()
    })
  })

  test('loads the workspace plugin inventory entry and keeps dashboard state consistent', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await openPluginsPage(page)

      const pluginItem = getPluginItem(page)
      const toggle = pluginItem.locator('.plugin-toggle-row input[type="checkbox"]')
      const isEnabled = await toggle.isChecked()
      await expect(pluginItem).toBeVisible()

      if (isEnabled) {
        await expect(pluginItem.locator('.plugin-status-running')).toBeVisible()
      } else {
        await expect(pluginItem.locator('.plugin-status-disabled')).toBeVisible()
      }

      await openDashboardPage(page)
      const dashboardCard = getLegacyDashboardCard(page)

      if (isEnabled) {
        await expect(dashboardCard.first()).toBeVisible()
      } else {
        await expect(dashboardCard).toHaveCount(0)
      }
    })
  })

  test('enables and disables the workspace plugin', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await enableActivityPulse(page)

      await openDashboardPage(page)
      await expect(getLegacyDashboardCard(page)).toBeVisible()

      await disableActivityPulse(page)

      await openDashboardPage(page)
      await expect(getLegacyDashboardCard(page)).toHaveCount(0)
    })
  })

  test('reloads plugin inventory without losing the workspace plugin', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      await enableActivityPulse(page)

      await page.locator('.plugin-toolbar button').first().click()

      await expect(page.locator('.flash-message')).toContainText(/Plugins reloaded\.|插件已重载。/)
      await expect(getPluginItem(page)).toBeVisible()

      await openDashboardPage(page)
      await expect(getLegacyDashboardCard(page)).toBeVisible()
    })
  })

  test('updates a plugin setting and uses it in the document action', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const title = `Plugin Setting Doc ${suffix}`
    const prefix = `Configured ${suffix}: `

    await withElectronApp(async ({ page }) => {
      await enableActivityPulse(page)
      await openPluginsPage(page)

      const pluginItem = getPluginItem(page)
      const settingRow = pluginItem.locator('.plugin-setting-item').filter({ hasText: 'Summary prefix' }).first()
      await settingRow.getByLabel('Summary prefix').fill(prefix)
      await settingRow.getByRole('button', { name: /Save Summary prefix|保存“Summary prefix”/ }).click()

      await expect(page.locator('.flash-message')).toContainText(/Summary prefix|插件“Activity Pulse”/)

      await openDocumentsPage(page)
      const initialSeedTitle = await createRootDocument(page, title, 'Plugin body content for the configured summary action.')
      await ensureAuxPanelVisible(page)

      await getLegacyDocumentAction(page).click()

      await expect(page.locator('.flash-message')).toContainText('Summary refreshed from the first non-empty block.')
      await expect(getSummaryInput(page)).toHaveValue(`${prefix}${initialSeedTitle}`)
    })
  })

  test('runs the plugin document action and refreshes the saved summary', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const title = `Plugin Doc ${suffix}`

    await withElectronApp(async ({ page }) => {
      await enableActivityPulse(page)
      await openPluginsPage(page)

      const pluginItem = getPluginItem(page)
      const settingRow = pluginItem.locator('.plugin-setting-item').filter({ hasText: 'Summary prefix' }).first()
      await expect(settingRow.getByLabel('Summary prefix')).toHaveValue('')

      await openDocumentsPage(page)
      const initialSeedTitle = await createRootDocument(page, title, 'Plugin body content for the summary action.')
      await ensureAuxPanelVisible(page)

      await getLegacyDocumentAction(page).click()

      await expect(page.locator('.flash-message')).toContainText('Summary refreshed from the first non-empty block.')

      await page.locator('.tree-button:not(.tree-button-active)').first().click()
      await expect(getPreviewTitle(page)).not.toHaveText(title)

      await getTreeButton(page, title).click()
      await expect(getPreviewTitle(page)).toHaveText(title)
      await ensureDocumentMetadataEditor(page)
      await expect(getSummaryInput(page)).toHaveValue(initialSeedTitle)
    })
  })

  test('runs plugins in a dedicated utility process and contains process failure', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ app, page }) => {
      await enableActivityPulse(page)

      await expect.poll(async () => app.evaluate(({ app: electronApp }) => {
        const pluginProcess = electronApp.getAppMetrics().find(
          (metric) => metric.serviceName === 'KnowBook Plugin: activity-pulse'
            || metric.name === 'KnowBook Plugin: activity-pulse'
        )
        return Boolean(pluginProcess)
      })).toBe(true)

      const isolatedProcess = await app.evaluate(({ app: electronApp }) => {
        const browserProcess = electronApp.getAppMetrics().find((metric) => metric.type === 'Browser')
        const pluginProcess = electronApp.getAppMetrics().find(
          (metric) => metric.serviceName === 'KnowBook Plugin: activity-pulse'
            || metric.name === 'KnowBook Plugin: activity-pulse'
        )
        return pluginProcess && browserProcess
          ? { pluginPid: pluginProcess.pid, browserPid: browserProcess.pid }
          : null
      })
      expect(isolatedProcess).not.toBeNull()
      expect(isolatedProcess?.pluginPid).not.toBe(isolatedProcess?.browserPid)

      await app.evaluate(({ app: electronApp }) => {
        const pluginProcess = electronApp.getAppMetrics().find(
          (metric) => metric.serviceName === 'KnowBook Plugin: activity-pulse'
            || metric.name === 'KnowBook Plugin: activity-pulse'
        )
        if (!pluginProcess) {
          throw new Error('Plugin utility process was not found.')
        }
        process.kill(pluginProcess.pid)
      })

      await expect(getPluginItem(page).locator('.plugin-status-error')).toBeVisible()
      await openDashboardPage(page)
      await expect(getLegacyDashboardCard(page)).toHaveCount(0)
      await openDocumentsPage(page)
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()
    })
  })
})
