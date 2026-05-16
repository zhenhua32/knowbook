import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

function getTitleInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-input').first()
}

function getBodyEditor(page: Page): Locator {
  return page.locator('textarea.block-inline-textarea').nth(1)
}

function getPreviewTitle(page: Page): Locator {
  return page.locator('.preview-panel .panel-head h3')
}

async function openSettingsPage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Settings', '配置中心')).first().click()
  await expect(page.locator('.current-page-text')).toHaveText(uiText('Settings', '配置中心'))
}

async function openDashboardPage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Dashboard', '总览')).first().click()
  await expect(page.locator('.current-page-text')).toHaveText(uiText('Dashboard', '总览'))
}

async function openDocumentsPage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Documents', '文档')).first().click()
  await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()
}

async function openAiPage(page: Page): Promise<void> {
  await page.getByTitle(uiText('AI Assistant', 'AI 助手')).first().click()
  await expect(page.locator('.current-page-text')).toHaveText(uiText('AI Assistant', 'AI 助手'))
}

async function createRootDocument(page: Page, title: string, body: string): Promise<void> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
  await getTitleInput(page).fill(title)
  await getBodyEditor(page).fill(body)
  await page.getByRole('button', { name: uiText('Save', '保存') }).click()
  await expect(getPreviewTitle(page)).toHaveText(title)
}

async function saveAiSettings(page: Page, baseUrl: string, model: string, embeddingBaseUrl: string, embeddingModel: string): Promise<void> {
  await openSettingsPage(page)

  await page.getByLabel(uiText('Enable AI features', '启用 AI 功能')).check()
  await page.getByLabel(uiText('Auto-generate summary when summary is empty', '摘要为空时自动生成摘要')).check()
  await page.getByLabel(uiText('Base URL', '基础地址')).fill(baseUrl)
  await page.getByLabel(uiText('Model', '模型')).fill(model)
  await page.getByLabel(uiText('API Key (leave blank to keep current)', 'API Key（留空表示保持当前值）')).fill('test-api-key')
  await page.getByLabel(uiText('Embedding Base URL (leave blank to auto-derive)', '向量地址（留空则自动推导）')).fill(embeddingBaseUrl)
  await page.getByLabel(uiText('Embedding model', '向量模型')).fill(embeddingModel)

  await page.getByRole('button', { name: uiText('Save AI settings', '保存 AI 设置') }).click()
  await expect(page.locator('.flash-message')).toContainText(/AI settings saved\.|AI 设置已保存。/)
}

test.describe('AI Settings @electron', () => {
  test('saves AI settings and keeps non-secret values after page navigation', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const baseUrl = 'https://example.invalid/v1'
    const model = 'gpt-4.1-mini'
    const embeddingBaseUrl = 'https://example.invalid/embeddings'
    const embeddingModel = 'text-embedding-3-small'

    await withElectronApp(async ({ page }) => {
      await saveAiSettings(page, baseUrl, model, embeddingBaseUrl, embeddingModel)

      await openDashboardPage(page)
      await expect(page.locator('.meta-grid')).toContainText(baseUrl)

      await openSettingsPage(page)
      await expect(page.getByLabel(uiText('Enable AI features', '启用 AI 功能'))).toBeChecked()
      await expect(page.getByLabel(uiText('Auto-generate summary when summary is empty', '摘要为空时自动生成摘要'))).toBeChecked()
      await expect(page.getByLabel(uiText('Base URL', '基础地址'))).toHaveValue(baseUrl)
      await expect(page.getByLabel(uiText('Model', '模型'))).toHaveValue(model)
      await expect(page.getByLabel(uiText('Embedding Base URL (leave blank to auto-derive)', '向量地址（留空则自动推导）'))).toHaveValue(embeddingBaseUrl)
      await expect(page.getByLabel(uiText('Embedding model', '向量模型'))).toHaveValue(embeddingModel)
      await expect(page.getByLabel(uiText('API Key (leave blank to keep current)', 'API Key（留空表示保持当前值）'))).toHaveValue('')
    })
  })

  test('keeps the document AI automation button available after AI config is saved', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)

    await withElectronApp(async ({ page }) => {
      await openDocumentsPage(page)
      await createRootDocument(page, `AI Config Doc ${suffix}`, 'Testing AI configuration gating in the document assistant.')

      await openAiPage(page)
      const runAutomationsButton = page.getByRole('button', { name: uiText('Run enabled automations', '运行已启用自动化') })
      await expect(runAutomationsButton).toBeEnabled()

      await saveAiSettings(page, 'https://example.invalid/v1', 'gpt-4.1-mini', 'https://example.invalid/embeddings', 'text-embedding-3-small')

      await openAiPage(page)
      await expect(page.locator('.ai-panel .pill, .panel-head .pill')).toContainText(`AI Config Doc ${suffix}`)
      await expect(runAutomationsButton).toBeEnabled()
    })
  })
})
