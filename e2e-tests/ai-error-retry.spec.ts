import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { uiText, withElectronApp } from './helpers/electron'

async function seedRetryDocuments(page: Page) {
  const ids = await page.evaluate(async () => {
    await window.knowbook.updateAiConfig({ enabled: true, apiKey: 'e2e-retry-key', baseUrl: 'https://example.invalid/v1',
      model: 'e2e-retry-model', autoSummaryOnSave: false, relatedNotesEnabled: true })
    const create = async (title: string) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks: [
        { id: `${id}-body`, type: 'paragraph', content: 'Source for error and retry verification', checked: false, depth: 0 }
      ] })
      return id
    }
    return { a: await create('AI retry A'), b: await create('AI retry B') }
  })
  await page.reload()
  await page.locator('.tree-button', { hasText: 'AI retry A' }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText('AI retry A')
  return ids
}

async function installDeferredAnswers(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    type Request = { input: { documentId: string; prompt: string }; resolve: (value: unknown) => void; reject: (error: Error) => void }
    const requests: Request[] = []
    process.env.KNOWBOOK_AI_RETRY_REQUESTS = '[]'
    process.env.KNOWBOOK_AI_COPIED_ANSWER = ''
    let failCopy = true
    ipcMain.removeHandler('knowbook:write-clipboard-text')
    ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => {
      if (failCopy) { failCopy = false; throw new Error('Clipboard busy for isolated verification') }
      process.env.KNOWBOOK_AI_COPIED_ANSWER = text
    })
    ipcMain.removeHandler('knowbook:ask-ai-about-document')
    ipcMain.handle('knowbook:ask-ai-about-document', (_event, input: Request['input']) => new Promise((resolve, reject) => {
      requests.push({ input, resolve, reject })
      process.env.KNOWBOOK_AI_RETRY_REQUESTS = JSON.stringify(requests.map(request => request.input))
    }))
    ipcMain.on('knowbook:test-settle-ai-retry', (_event, input: { index: number; fail: boolean }) => {
      const request = requests[input.index]
      if (!request) throw new Error(`Missing retry request ${input.index}`)
      if (input.fail) request.reject(new Error('The provider is temporarily unavailable. Try again shortly.'))
      else {
        const answer = '## Retry completed\n\n**The original question was retried.**\n\nUse `documentId` for context.\n\n- The new draft is preserved\n- This answer uses the selected document\n\n| Field | Value |\n| --- | --- |\n| Request | Retried |\n\n```ts\nconst retried = true\nconst context = "' + 'long-document-context-'.repeat(20) + '"\n```\n\n<script>window.aiRetryUnsafe = true</script>\n\n<img src="https://example.invalid/image" onerror="window.aiRetryUnsafe=true">\n\n![Remote image](https://example.invalid/image.png)\n\n[Unsafe](javascript:alert(1))'
        process.env.KNOWBOOK_AI_RETRY_ANSWER = answer
        request.resolve({ answer, references: [] })
      }
    })
  })
}

async function settle(app: ElectronApplication, index: number, fail: boolean) {
  await app.evaluate(({ ipcMain }, input) => { ipcMain.emit('knowbook:test-settle-ai-retry', null, input) }, { index, fail })
}

async function expectRequests(app: ElectronApplication, requests: Array<{ documentId: string; prompt: string }>) {
  await expect.poll(() => app.evaluate(() => JSON.parse(process.env.KNOWBOOK_AI_RETRY_REQUESTS!))).toEqual(requests)
}

async function expectErrorCard(panel: Locator, question: string) {
  const error = panel.getByRole('alert', { name: uiText('AI request failed', 'AI 请求失败') })
  await expect(error).toBeVisible()
  await expect(error.locator('.ai-request-error-message')).toHaveText('The provider is temporarily unavailable. Try again shortly.')
  await expect(error.locator('.ai-request-failed-prompt p')).toHaveText(question)
  await expect(panel.locator('.ai-answer')).toHaveCount(0)
  return error
}

for (const surface of ['workspace', 'auxiliary'] as const) {
  test(`${surface} AI retries the failed question while keeping the newer draft and renders safe Markdown @electron`, async ({}, testInfo) => {
    await withElectronApp(async ({ page, app }) => {
      const ids = await seedRetryDocuments(page)
      await installDeferredAnswers(app)
      if (surface === 'workspace') await page.getByTitle(uiText('AI Assistant', 'AI 助手')).first().click()
      else if (!await page.locator('.document-aux-ai-prompt').isVisible()) await page.getByRole('button', { name: uiText('Show auxiliary', '展开辅助区') }).click()
      const panel = surface === 'workspace' ? page.locator('.ai-document-workspace') : page.locator('.document-aux-ai-section')
      const prompt = panel.locator('textarea')
      const originalQuestion = 'Summarize this document.\nInclude the key points and ' + 'UnbrokenKeyword'.repeat(12)
      const newDraft = 'A newer unsent question: explain the terminology instead.'
      const sent: Array<{ documentId: string; prompt: string }> = [{ documentId: ids.a, prompt: originalQuestion }]
      await prompt.fill(originalQuestion)
      await panel.getByRole('button', { name: uiText('Ask AI', '询问 AI'), exact: true }).click()
      await expectRequests(app, sent)
      await prompt.fill(newDraft)
      await settle(app, 0, true)
      const error = await expectErrorCard(panel, originalQuestion)
      await expect(prompt).toHaveValue(newDraft)
      expect(await error.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const retry = error.getByRole('button', { name: uiText('Retry last question', '重试上次问题') })
      expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(36)
      await error.screenshot({ path: testInfo.outputPath(`${surface}-ai-error.png`) })
      await retry.click()
      sent.push({ documentId: ids.a, prompt: originalQuestion })
      await expectRequests(app, sent)
      await expect(prompt).toHaveValue(newDraft)
      await expect(panel.getByRole('button', { name: uiText('Thinking...', '思考中...'), exact: true })).toBeDisabled()
      await settle(app, 1, false)
      await expect(panel.locator('.ai-request-error')).toHaveCount(0)
      const answer = panel.locator('.ai-answer-content')
      await expect(answer.getByRole('heading', { name: 'Retry completed' })).toBeVisible()
      await expect(answer.locator('strong')).toHaveText('The original question was retried.')
      await expect(answer.locator('li')).toHaveCount(2)
      await expect(answer.locator('table td').first()).toHaveText('Request')
      await expect(answer.locator('pre code')).toContainText('const retried = true')
      expect(await answer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await answer.locator('pre').evaluate(element => getComputedStyle(element).overflowX)).toBe('auto')
      expect(await answer.locator('pre').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
      await expect(answer.locator('script, img, iframe, [onerror], [onclick], [href^="javascript:"]')).toHaveCount(0)
      expect(await page.evaluate(() => 'aiRetryUnsafe' in window)).toBe(false)
      await expect(prompt).toHaveValue(newDraft)
      await answer.screenshot({ path: testInfo.outputPath(`${surface}-ai-markdown.png`) })
      const card = panel.locator('.ai-answer')
      await expect(card.locator('.ai-answer-question p')).toHaveText(originalQuestion)
      const copy = card.getByRole('button', { name: uiText('Copy answer', '复制回答'), exact: true })
      await copy.focus()
      await page.keyboard.press('Enter')
      await expect(card.getByRole('status')).toHaveText(uiText('Could not copy. Try again.', '复制失败，请重试'))
      await expect(card).not.toContainText('Clipboard busy for isolated verification')
      await copy.click()
      await expect(card.getByRole('status')).toHaveText(uiText('Copied', '已复制'))
      expect(await app.evaluate(() => process.env.KNOWBOOK_AI_COPIED_ANSWER)).toBe(await app.evaluate(() => process.env.KNOWBOOK_AI_RETRY_ANSWER))
      await expect(prompt).toHaveValue(newDraft)
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => { document.documentElement.setAttribute('data-theme', value) }, theme)
        expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        for (const selector of ['.inline-code', 'table th']) {
          const contrast = await card.locator(selector).first().evaluate(element => {
            const style = getComputedStyle(element)
            const luminance = (color: string) => {
              const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
                const channel = value / 255
                return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
              })
              return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
            }
            const text = luminance(style.color), background = luminance(style.backgroundColor)
            return (Math.max(text, background) + .05) / (Math.min(text, background) + .05)
          })
          expect(contrast).toBeGreaterThanOrEqual(4.5)
        }
        expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(36)
        await card.screenshot({ path: testInfo.outputPath(`${surface}-ai-answer-${theme}.png`), animations: 'disabled' })
      }
      // A new failed request captures the new question, then document selection invalidates its retry target.
      await panel.getByRole('button', { name: uiText('Ask AI', '询问 AI'), exact: true }).click()
      sent.push({ documentId: ids.a, prompt: newDraft })
      await expectRequests(app, sent)
      await settle(app, 2, true)
      const nextError = await expectErrorCard(panel, newDraft)
      await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark') })
      await nextError.screenshot({ path: testInfo.outputPath(`${surface}-ai-error-dark.png`), animations: 'disabled' })
      if (surface === 'workspace') await page.getByLabel(uiText('Document context', '文档上下文'), { exact: true }).selectOption(ids.b)
      else await page.locator('.tree-button', { hasText: 'AI retry B' }).first().click()
      await expect(panel.locator('.ai-request-error')).toHaveCount(0)
      await expect(panel.getByRole('button', { name: uiText('Retry last question', '重试上次问题') })).toHaveCount(0)
      await expect(prompt).toHaveValue(newDraft)
      if (surface === 'workspace') await expect(page.locator('.ai-context-description strong')).toHaveText('AI retry B')
      else await expect(page.locator('.document-header-title')).toHaveText('AI retry B')
    })
  })
}
