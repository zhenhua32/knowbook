import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type MockAiRequest = {
  method: string
  url: string | undefined
  authorization: string | undefined
  body: string
}

function getTitleInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-input').first()
}

function getBodyEditor(page: Page): Locator {
  return page.locator('textarea.block-inline-textarea').nth(1)
}

function getPreviewTitle(page: Page): Locator {
  return page.locator('.preview-panel .panel-head h3')
}

function getSummaryInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-textarea').first()
}

async function startMockAiServer(summary: string): Promise<{
  baseUrl: string
  requests: MockAiRequest[]
  close: () => Promise<void>
}> {
  const requests: MockAiRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []

    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: request.method ?? 'GET',
        url: request.url,
        authorization: request.headers.authorization,
        body
      })

      if (request.method === 'POST' && request.url === '/chat/completions') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: summary
                }
              }
            ]
          })
        )
        return
      }

      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end('not found')
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
  }
}

async function openSettingsPage(page: Page): Promise<void> {
  const navigationButton = page.locator('button.nav-icon-btn').and(page.getByTitle(uiText('Settings', '配置中心'))).first()
  await navigationButton.click()
  await expect(navigationButton).toHaveClass(/active/)
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

async function openAiPage(page: Page): Promise<void> {
  const navigationButton = page.locator('button.nav-icon-btn').and(page.getByTitle(uiText('AI Assistant', 'AI 助手'))).first()
  await navigationButton.click()
  await expect(navigationButton).toHaveClass(/active/)
}

async function createRootDocument(page: Page, title: string, body: string): Promise<void> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
  await getTitleInput(page).fill(title)
  await getBodyEditor(page).fill(body)
  await page.getByRole('button', { name: uiText('Save', '保存') }).click()
  await expect(getPreviewTitle(page)).toHaveText(title)
}

async function createFreshDocumentEditor(page: Page): Promise<Locator> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await expect(getTitleInput(page)).toHaveValue(/Untitled/i)

  const editor = page.locator('textarea.block-inline-textarea').nth(1)
  await expect(editor).toBeVisible()
  return editor
}

async function createParagraphBlocks(page: Page, values: string[]): Promise<void> {
  const editors = page.locator('textarea.block-inline-textarea')
  await createFreshDocumentEditor(page)

  for (let index = 0; index < values.length; index += 1) {
    const editor = editors.nth(index + 1)
    await expect(editor).toBeVisible()
    await editor.fill(values[index])

    if (index < values.length - 1) {
      await editor.press('Control+Enter')
    }
  }
}

async function selectFirstTwoBodyBlocks(page: Page): Promise<void> {
  const editors = page.locator('textarea.block-inline-textarea')
  const firstBody = editors.nth(1)

  await firstBody.click()
  await firstBody.press('End')
  await firstBody.press('Shift+ArrowDown')

  await expect(page.locator('.block-selection-toolbar')).toBeVisible()
  await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
}

async function getBodyBlockValues(page: Page): Promise<string[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.slice(1).map((textarea) => (textarea as HTMLTextAreaElement).value)
  )
}

async function saveAiSettings(
  page: Page,
  baseUrl: string,
  model: string,
  autoSummaryOnSave = true
): Promise<void> {
  await openSettingsPage(page)

  await page.getByLabel(uiText('Enable AI features', '启用 AI 功能')).check()
  const autoSummaryCheckbox = page.getByLabel(uiText('Auto-generate summary when summary is empty', '摘要为空时自动生成摘要'))
  if (autoSummaryOnSave) {
    await autoSummaryCheckbox.check()
  } else {
    await autoSummaryCheckbox.uncheck()
  }
  await page.getByLabel(uiText('Base URL', '基础地址')).fill(baseUrl)
  await page.getByLabel(uiText('Model', '模型')).fill(model)
  await page.getByLabel(uiText('API Key (leave blank to keep current)', 'API Key（留空表示保持当前值）')).fill('test-api-key')

  await page.getByRole('button', { name: uiText('Save AI settings', '保存 AI 设置') }).click()
  await expect(page.locator('.flash-message')).toContainText(/AI settings saved\.|AI 设置已保存。/)
}

test.describe('AI Settings @electron', () => {
  test('saves AI settings and keeps non-secret values after page navigation', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const baseUrl = 'https://example.invalid/v1'
    const model = 'gpt-4.1-mini'
    await withElectronApp(async ({ page }) => {
      await saveAiSettings(page, baseUrl, model)

      await openDashboardPage(page)
      await expect(page.locator('.meta-grid')).toContainText(baseUrl)

      await openSettingsPage(page)
      await expect(page.getByLabel(uiText('Enable AI features', '启用 AI 功能'))).toBeChecked()
      await expect(page.getByLabel(uiText('Auto-generate summary when summary is empty', '摘要为空时自动生成摘要'))).toBeChecked()
      await expect(page.getByLabel(uiText('Base URL', '基础地址'))).toHaveValue(baseUrl)
      await expect(page.getByLabel(uiText('Model', '模型'))).toHaveValue(model)
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
      await expect(runAutomationsButton).toBeDisabled()

      await saveAiSettings(page, 'https://example.invalid/v1', 'gpt-4.1-mini')

      await openAiPage(page)
      await expect(page.locator('.ai-panel .pill, .panel-head .pill')).toContainText(`AI Config Doc ${suffix}`)
      await expect(runAutomationsButton).toBeEnabled()
    })
  })

  test('runs document summary automation against a configured AI endpoint', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const generatedSummary = '这是由本地模拟 AI 自动生成的摘要。'
    const mockAiServer = await startMockAiServer(generatedSummary)

    try {
      await withElectronApp(async ({ page }) => {
        await saveAiSettings(page, mockAiServer.baseUrl, 'gpt-4.1-mini', false)

        await openDocumentsPage(page)
        await createRootDocument(
          page,
          `AI Automation Doc ${suffix}`,
          'This document contains enough detail to trigger automatic summarization after the AI settings are configured and the automation is run manually.'
        )

        await expect(getSummaryInput(page)).toHaveValue('New knowledge node ready for editing.')

        await saveAiSettings(page, mockAiServer.baseUrl, 'gpt-4.1-mini', true)

        await openDocumentsPage(page)
        await expect(getSummaryInput(page)).toHaveValue('New knowledge node ready for editing.')

        await openAiPage(page)
        const runAutomationsButton = page.getByRole('button', { name: uiText('Run enabled automations', '运行已启用自动化') })
        await expect(runAutomationsButton).toBeEnabled()
        const summaryRequestCountBeforeRun = mockAiServer.requests.filter((request) => request.url === '/chat/completions').length
        await runAutomationsButton.click()

        await expect(page.locator('.flash-message')).toContainText(/AI automation updated the summary\.|AI 自动化已更新摘要。/)
        await expect.poll(() => mockAiServer.requests.filter((request) => request.url === '/chat/completions').length).toBe(summaryRequestCountBeforeRun + 1)

        await openDocumentsPage(page)
        await expect(getSummaryInput(page)).toHaveValue(generatedSummary)
      })

      const summaryRequests = mockAiServer.requests.filter((request) => request.url === '/chat/completions')
      expect(summaryRequests[0]?.authorization).toBe('Bearer test-api-key')
      expect(summaryRequests[0]?.body).toContain(`Document title: AI Automation Doc ${suffix}`)
      expect(summaryRequests[0]?.body).toContain('Document content:')
    } finally {
      await mockAiServer.close()
    }
  })

  test('previews and applies an AI summary over the selected block range', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const generatedSummary = '这是 AI 生成的两段内容总结。'
    const mockAiServer = await startMockAiServer(generatedSummary)

    try {
      await withElectronApp(async ({ page }) => {
        await saveAiSettings(page, mockAiServer.baseUrl, 'gpt-4.1-mini', false)
        await openDocumentsPage(page)
        await createParagraphBlocks(page, ['Alpha facts', 'Beta details', 'Gamma remains'])
        await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha facts', 'Beta details', 'Gamma remains'])

        await selectFirstTwoBodyBlocks(page)
        const toolbar = page.locator('.block-selection-toolbar')
        await toolbar.getByRole('button', { name: uiText('AI edit', 'AI 编辑') }).click()

        await expect(page.getByText(uiText('AI edit selection', 'AI 编辑选区'))).toBeVisible()
        await page.getByRole('button', { name: uiText('Generate preview', '生成预览') }).click()
        await expect(page.locator('.ai-selection-preview')).toContainText(generatedSummary)

        await page.getByRole('button', { name: uiText('Apply to document', '应用到文档') }).click()
        await expect.poll(() => getBodyBlockValues(page)).toEqual([generatedSummary, 'Gamma remains'])
      })

      const summaryRequests = mockAiServer.requests.filter((request) => request.url === '/chat/completions')
      expect(summaryRequests[0]?.body).toContain('Selected block count: 2')
      expect(summaryRequests[0]?.body).toContain('Alpha facts')
      expect(summaryRequests[0]?.body).toContain('Beta details')
    } finally {
      await mockAiServer.close()
    }
  })

  test('applies table conversion as a single multiline block', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const generatedTable = ['| Name | Value |', '| --- | --- |', '| Alpha | 1 |', '| Beta | 2 |'].join('\n')
    const mockAiServer = await startMockAiServer(generatedTable)

    try {
      await withElectronApp(async ({ page }) => {
        await saveAiSettings(page, mockAiServer.baseUrl, 'gpt-4.1-mini', false)
        await openDocumentsPage(page)
        await createParagraphBlocks(page, ['Alpha 1', 'Beta 2', 'Gamma remains'])
        await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha 1', 'Beta 2', 'Gamma remains'])

        await selectFirstTwoBodyBlocks(page)
        const toolbar = page.locator('.block-selection-toolbar')
        await toolbar.getByRole('button', { name: uiText('AI edit', 'AI 编辑') }).click()

        await page.getByRole('button', { name: uiText('Table', '转成表格') }).click()
        await page.getByRole('button', { name: uiText('Generate preview', '生成预览') }).click()
        await expect(page.locator('.ai-selection-preview')).toContainText('| Name | Value |')

        await page.getByRole('button', { name: uiText('Apply to document', '应用到文档') }).click()
        await expect.poll(() => getBodyBlockValues(page)).toEqual([generatedTable, 'Gamma remains'])
      })
    } finally {
      await mockAiServer.close()
    }
  })
})
