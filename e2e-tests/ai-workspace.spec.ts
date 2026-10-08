import { expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { uiText, withElectronApp } from './helpers/electron'

async function seedDocuments(page: Page, configureAi = false): Promise<{ a: string; b: string }> {
  const ids = await page.evaluate(async configureAi => {
    const create = async (title: string) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks: [
        { id: `${id}-body`, type: 'paragraph', content: 'Original source', checked: false, depth: 0 }
      ] })
      return id
    }
    if (configureAi) await window.knowbook.updateAiConfig({ enabled: true, apiKey: 'e2e-key',
      baseUrl: 'https://example.invalid/v1', model: 'e2e-model', autoSummaryOnSave: false, relatedNotesEnabled: true })
    return { a: await create('AI workspace A'), b: await create('AI workspace B') }
  }, configureAi)
  await page.reload()
  await page.locator('.tree-button', { hasText: 'AI workspace A' }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText('AI workspace A')
  return ids
}

async function openAi(page: Page) {
  await page.getByTitle(uiText('AI Assistant', 'AI 助手')).first().click()
  await expect(page.getByRole('tab', { name: uiText('Document AI assistant', '文档智能助手') })).toHaveAttribute('aria-selected', 'true')
}

async function expectButtonTargets(page: Page) {
  const undersized = await page.locator('.ai-workspace button, .ai-readiness button').evaluateAll(buttons => buttons
    .filter(button => button.getClientRects().length > 0 && button.getBoundingClientRect().height < 36)
    .map(button => ({ label: button.textContent, height: button.getBoundingClientRect().height })))
  expect(undersized).toEqual([])
}

async function installAnswers(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    process.env.KNOWBOOK_AI_WORKSPACE_REQUESTS = '[]'
    process.env.KNOWBOOK_AI_WORKSPACE_APPROVAL = ''
    const session = { id: 'workspace-app', workspaceId: 'workspace', title: 'Existing extension conversation', activeDocumentId: null,
      modelConfig: {}, status: 'active', activeTurnId: null, lastSeq: 2, createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T01:00:00Z' }
    const assistantMessage = { id: 'message', sessionId: session.id, workspaceId: 'workspace', seq: 1,
      createdAt: '2026-10-01T01:00:00Z', surface: 'conversation', type: 'assistant.message',
      payload: { turnId: 'turn', stepId: 'step', text: '## Extension plan\n\n**Existing conversation**\n\n- Prepare the extension\n- Review permissions' } }
    const approval = { id: 'approval', sessionId: session.id, workspaceId: 'workspace', seq: 2,
      createdAt: '2026-10-01T01:00:00Z', surface: 'conversation', type: 'approval.requested',
      payload: { turnId: 'turn', toolCallId: 'call', approvalId: 'approval', pluginId: 'sample', revisionId: 'revision',
        scope: { kind: 'session', workspaceId: 'workspace', sessionId: session.id }, permissions: [], summary: 'Review the prepared extension', risk: 'low', expiresAt: '2099-01-01T00:00:00Z' } }
    let approved = false
    for (const channel of ['knowbook:ask-ai-about-document', 'knowbook:search-semantic-notes', 'knowbook:list-assistant-sessions',
      'knowbook:get-assistant-session-events', 'knowbook:resolve-assistant-approval']) ipcMain.removeHandler(channel)
    ipcMain.handle('knowbook:ask-ai-about-document', (_event, input: { documentId: string; prompt: string }) => {
      const requests = JSON.parse(process.env.KNOWBOOK_AI_WORKSPACE_REQUESTS!) as unknown[]
      requests.push(input)
      process.env.KNOWBOOK_AI_WORKSPACE_REQUESTS = JSON.stringify(requests)
      return { answer: '## Key points\n\n**Structured answer**\n\n- First point\n- Second point\n\n| Item | Result |\n| --- | --- |\n| A | Ready |\n\n```js\nconst ready = true\n```\n\n<script>window.aiUnsafe = true</script>\n\n<img src="https://example.invalid/pixel" onerror="window.aiUnsafe=true">\n\n![Remote image](https://example.invalid/image.png)\n\n[Unsafe link](javascript:alert(1))\n\n[Source](https://example.com)', references: [] }
    })
    ipcMain.handle('knowbook:search-semantic-notes', () => [])
    ipcMain.handle('knowbook:list-assistant-sessions', () => [session])
    ipcMain.handle('knowbook:get-assistant-session-events', () => approved ? [assistantMessage] : [assistantMessage, approval])
    ipcMain.handle('knowbook:resolve-assistant-approval', (_event, input: { decision: string }) => {
      process.env.KNOWBOOK_AI_WORKSPACE_APPROVAL = input.decision
      approved = true
      return { sessionId: session.id, turnId: 'turn', status: 'completed' }
    })
  })
}

test('missing AI setup opens the AI category and consumes the requested settings category @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page, app }) => {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(680, 520)
      window.setSize(1000, 620)
    })
    await seedDocuments(page)
    await openAi(page)
    expect(await page.evaluate(() => window.innerHeight)).toBeLessThan(650)
    await expect(page.locator('.ai-readiness')).toBeVisible()
    await expect(page.locator('.ai-document-workspace')).toBeVisible()
    await expect(page.locator('.ai-extension-workspace')).not.toBeVisible()
    await expect(page.locator('.ai-related-notes-content')).not.toBeVisible()
    await expect(page.getByRole('button', { name: uiText('Ask AI', '询问 AI'), exact: true })).toBeDisabled()
    await expectButtonTargets(page)
    await expect(page.locator('.ai-document-prompt')).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: uiText('Configure AI', '配置 AI'), exact: true })).toBeInViewport({ ratio: 1 })
    expect(await page.locator('.content.page-ai').evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath('ai-default-unconfigured.png'), fullPage: true })
    await page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手') }).click()
    await expect(page.locator('.assistant-composer textarea')).toBeDisabled()
    await expect(page.locator('.assistant-composer textarea')).toBeInViewport({ ratio: 1 })
    await expect(page.locator('.assistant-composer-hint')).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: uiText('Configure AI', '配置 AI'), exact: true })).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: uiText('Configure AI', '配置 AI'), exact: true }).click()
    await expect(page.getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: uiText('General', '通用'), exact: true }).click()
    await openAi(page)
    await page.getByTitle(uiText('Settings', '配置中心')).first().click()
    await expect(page.getByRole('tab', { name: uiText('General', '通用'), exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute('aria-selected', 'false')
  })
})

test('selecting document context saves the previous source and waits for coherent detail while staying in AI @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    const ids = await seedDocuments(page, true)
    await installAnswers(app)
    await page.clock.install({ time: new Date() })
    await page.clock.pauseAt(new Date())
    await page.locator(`[data-block-id="${ids.a}-body"] textarea`).fill('Unsaved source preserved on context switch')
    await openAi(page)
    const prompt = page.locator('.ai-document-prompt')
    await prompt.fill('Question retained across context selection')
    expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), ids.a))?.blocks[0].content).toBe('Original source')
    await app.evaluate(({ ipcMain }, documentId) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, id: string) => unknown> })._invokeHandlers
      const readDetail = handlers.get('knowbook:get-document-detail')!
      let pending: { event: unknown; resolve: (value: unknown) => void } | undefined
      ipcMain.removeHandler('knowbook:get-document-detail')
      ipcMain.handle('knowbook:get-document-detail', (event, id: string) => id === documentId
        ? new Promise(resolve => { pending = { event, resolve } }) : readDetail(event, id))
      ipcMain.on('knowbook:test-release-context', () => {
        ipcMain.removeHandler('knowbook:get-document-detail')
        ipcMain.handle('knowbook:get-document-detail', readDetail)
        if (pending) pending.resolve(readDetail(pending.event, documentId))
      })
    }, ids.b)
    await page.getByLabel(uiText('Document context', '文档上下文'), { exact: true }).selectOption(ids.b)
    await expect(page.locator('.ai-context-loading')).toBeVisible()
    await expect(prompt).toBeDisabled()
    await expect(page.locator('.ai-context-description')).toHaveCount(0)
    await expect(page.getByRole('button', { name: uiText('Ask AI', '询问 AI'), exact: true })).toBeDisabled()
    await expect(page.locator('.ai-task-switcher')).toBeVisible()
    expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), ids.a))?.blocks[0].content).toBe('Unsaved source preserved on context switch')
    await app.evaluate(({ ipcMain }) => { ipcMain.emit('knowbook:test-release-context') })
    await expect(prompt).toBeEnabled()
    await expect(prompt).toHaveValue('Question retained across context selection')
    await expect(page.locator('.ai-context-description strong')).toHaveText('AI workspace B')
    await expect(page.locator('.ai-task-switcher')).toBeVisible()
    await prompt.press('Control+Enter')
    await expect.poll(() => app.evaluate(() => JSON.parse(process.env.KNOWBOOK_AI_WORKSPACE_REQUESTS!))).toEqual([
      { documentId: ids.b, prompt: 'Question retained across context selection' }
    ])
  })
})

test('AI task switches preserve drafts and approvals and render safe Markdown with IME-aware submission @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page, app }) => {
    const ids = await seedDocuments(page, true)
    await installAnswers(app)
    await openAi(page)
    const prompt = page.locator('.ai-document-prompt')
    await prompt.fill('Explain this document')
    await prompt.dispatchEvent('compositionstart')
    await prompt.press('Control+Enter')
    expect(await app.evaluate(() => JSON.parse(process.env.KNOWBOOK_AI_WORKSPACE_REQUESTS!))).toEqual([])
    await prompt.dispatchEvent('compositionend')
    await prompt.press('Control+Enter')
    await expect.poll(() => app.evaluate(() => JSON.parse(process.env.KNOWBOOK_AI_WORKSPACE_REQUESTS!))).toEqual([
      { documentId: ids.a, prompt: 'Explain this document' }
    ])
    const answer = page.locator('.ai-document-workspace .ai-answer')
    await expect(answer.getByRole('heading', { name: 'Key points' })).toBeVisible()
    await expect(answer.locator('strong')).toHaveText('Structured answer')
    await expect(answer.locator('li')).toHaveCount(2)
    await expect(answer.locator('table td').first()).toHaveText('A')
    await expect(answer.locator('pre code')).toHaveText('const ready = true')
    await expect(answer.locator('script, img, iframe, [onerror], [onclick], [href^="javascript:"]')).toHaveCount(0)
    expect(await page.evaluate(() => 'aiUnsafe' in window)).toBe(false)
    await expectButtonTargets(page)
    await page.screenshot({ path: testInfo.outputPath('ai-document-answer.png'), fullPage: true })
    await page.locator('.ai-related-notes > summary').click()
    await page.getByRole('button', { name: uiText('Find related notes', '查找相关笔记'), exact: true }).click()
    await expect(page.locator('.ai-related-empty')).toContainText(/No related notes found|没有找到相关笔记/)
    const extensionTab = page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手') })
    await extensionTab.click()
    await expect(page.locator('.ai-document-workspace')).not.toBeVisible()
    await expect(page.locator('.assistant-message strong')).toHaveText('Existing conversation')
    await expect(page.locator('.assistant-approval')).toContainText('Review the prepared extension')
    const extensionPrompt = page.locator('.ai-extension-workspace .assistant-composer textarea')
    await extensionPrompt.fill('Unsent extension request')
    await extensionTab.press('Home')
    await expect(prompt).toHaveValue('Explain this document')
    await expect(answer.locator('strong')).toHaveText('Structured answer')
    await page.getByRole('tab', { name: uiText('Document AI assistant', '文档智能助手') }).press('End')
    await expect(extensionPrompt).toHaveValue('Unsent extension request')
    await expect(page.locator('.assistant-approval')).toBeVisible()
    await expectButtonTargets(page)
    await page.screenshot({ path: testInfo.outputPath('ai-extension-task.png'), fullPage: true })
    await page.getByRole('button', { name: uiText('Reject', '拒绝'), exact: true }).click()
    await expect.poll(() => app.evaluate(() => process.env.KNOWBOOK_AI_WORKSPACE_APPROVAL)).toBe('rejected')
    await expect(page.locator('.assistant-approval')).toHaveCount(0)
    await expect(extensionPrompt).toHaveValue('Unsent extension request')
    await page.setViewportSize({ width: 780, height: 900 })
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark') })
    await expectButtonTargets(page)
    await page.screenshot({ path: testInfo.outputPath('ai-extension-dark-narrow.png'), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})

test('restored approvals are visible on the first task switch without resetting history reading after later switches @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page, app }) => {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(680, 520)
      window.setSize(1000, 820)
    })
    await seedDocuments(page, true)
    await installAnswers(app)
    await app.evaluate(({ ipcMain }) => {
      process.env.KNOWBOOK_AI_WORKSPACE_HIDDEN_MESSAGES = '0'
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
      const readEvents = handlers.get('knowbook:get-assistant-session-events')!
      ipcMain.removeHandler('knowbook:get-assistant-session-events')
      ipcMain.handle('knowbook:get-assistant-session-events', async (event, ...args) => {
        const events = await readEvents(event, ...args) as Array<{ id: string; sessionId: string; seq: number; type: string; payload: { text?: string } }>
        const history = events.filter(item => item.type === 'assistant.message')
          .map(item => ({ ...item, payload: { ...item.payload, text: item.payload.text!.repeat(35) } }))
        const additions = Array.from({ length: Number(process.env.KNOWBOOK_AI_WORKSPACE_HIDDEN_MESSAGES) }, (_, index) => ({
          id: `hidden-message-${index}`, sessionId: 'workspace-app', seq: index + 3, surface: 'conversation',
          type: 'assistant.message', createdAt: '2026-10-01T02:00:00Z',
          payload: { turnId: 'turn', stepId: `hidden-step-${index}`, text: `Background progress ${index}` }
        }))
        return [...history, ...additions, ...events.filter(item => item.type !== 'assistant.message')]
      })
      return { configured: true }
    })
    await openAi(page)
    const documentTab = page.getByRole('tab', { name: uiText('Document AI assistant', '文档智能助手') })
    const extensionTab = page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手') })
    const transcript = page.locator('.assistant-transcript')
    const approval = page.locator('.assistant-approval')
    // Wait for restoration while the extension panel is still hidden. Neither
    // a click on the approval nor scrollIntoView may repair the tested layout.
    await expect(page.locator('.assistant-message')).toHaveCount(1)
    await expect(approval).toHaveCount(1)
    await expect(transcript).not.toBeVisible()
    expect(await transcript.evaluate(element => element.scrollHeight)).toBe(0)
    await extensionTab.click()
    await expect(approval).toBeInViewport({ ratio: 1 })
    for (const button of await approval.getByRole('button').all()) await expect(button).toBeInViewport({ ratio: 1 })
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
    expect(await transcript.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1000)
    await page.screenshot({ path: testInfo.outputPath('ai-restored-approval-first-visible.png') })

    const bounds = await transcript.boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.move(bounds!.x + 12, bounds!.y + bounds!.height / 2)
    await page.mouse.wheel(0, -480)
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const readingTop = await transcript.evaluate(element => element.scrollTop)
    await documentTab.click()
    await app.evaluate(({ BrowserWindow }) => {
      process.env.KNOWBOOK_AI_WORKSPACE_HIDDEN_MESSAGES = '1'
      BrowserWindow.getAllWindows()[0].webContents.send('knowbook:assistant-session-changed', { sessionId: 'workspace-app', lastSeq: 3 })
      return { sent: true }
    })
    await expect(page.locator('.assistant-message')).toHaveCount(2)
    await extensionTab.click()
    await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeCloseTo(readingTop, 0)
    expect(await transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100)
    await expect(approval.getByRole('button').first()).not.toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('ai-restored-history-position.png') })

    await transcript.focus()
    await page.keyboard.press('Control+End')
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
    await documentTab.click()
    await app.evaluate(({ BrowserWindow }) => {
      process.env.KNOWBOOK_AI_WORKSPACE_HIDDEN_MESSAGES = '2'
      BrowserWindow.getAllWindows()[0].webContents.send('knowbook:assistant-session-changed', { sessionId: 'workspace-app', lastSeq: 4 })
      return { sent: true }
    })
    await expect(page.locator('.assistant-message')).toHaveCount(3)
    await extensionTab.click()
    await expect(approval.getByRole('button').first()).toBeInViewport({ ratio: 1 })
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
  })
})

test('short AI workspaces keep input and approvals reachable with one content scroller in light and dark palettes @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page, app }) => {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(680, 520)
      window.setSize(1000, 620)
    })
    await seedDocuments(page, true)
    await installAnswers(app)
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
      const readEvents = handlers.get('knowbook:get-assistant-session-events')!
      ipcMain.removeHandler('knowbook:get-assistant-session-events')
      ipcMain.handle('knowbook:get-assistant-session-events', async (event, ...args) => {
        const events = await readEvents(event, ...args) as Array<{ id: string; payload: { text?: string; summary?: string; revisionPreview?: unknown } }>
        return events.map(item => item.payload.text ? { ...item, payload: { ...item.payload, text: item.payload.text.repeat(25) } }
          : { ...item, payload: { ...item.payload, summary: `${item.payload.summary}\n${'Review permissions and the exact artifact. '.repeat(40)}`,
            revisionPreview: { changes: 'Source changes for approval.\n'.repeat(100) } } })
      })
    })
    await openAi(page)
    expect(await page.evaluate(() => window.innerHeight)).toBeLessThan(650)
    for (const themeId of ['moss', 'midnight']) {
      await page.evaluate(async themeId => {
        const plugin = (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === 'theme-switcher')!
        await window.knowbook.invokeSystemPluginMain({ pluginId: plugin.pluginId, revisionHash: `sha256:${plugin.currentArtifactSha256}`,
          method: 'set-theme', input: { themeId } })
      }, themeId)
      await expect(page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', themeId)
      const prompt = page.locator('.ai-document-prompt')
      await prompt.fill('Question in a short window')
      await prompt.press('Control+Enter')
      await expect(page.locator('.ai-answer')).toBeVisible()
      await expect(prompt).toBeInViewport({ ratio: 1 })
      await expect(page.getByRole('button', { name: uiText('Ask AI', '询问 AI'), exact: true })).toBeInViewport({ ratio: 1 })
      await expect(page.locator('.ai-document-reading')).toHaveCSS('overflow-y', 'auto')
      expect(await page.locator('.content.page-ai').evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
      await page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手') }).click()
      const approval = page.locator('.assistant-approval')
      if (await approval.locator('details').getAttribute('open') === null) await approval.locator('summary').click()
      const reject = approval.getByRole('button', { name: uiText('Reject', '拒绝'), exact: true })
      await reject.scrollIntoViewIfNeeded()
      await expect(reject).toBeInViewport()
      await page.locator('.assistant-composer textarea').fill('Extension request with a multiline draft\n'.repeat(8))
      await expect(page.locator('.assistant-composer textarea')).toBeInViewport({ ratio: 1 })
      await expect(page.locator('.assistant-composer button')).toBeInViewport({ ratio: 1 })
      await expect(page.locator('.assistant-composer-hint')).toBeInViewport({ ratio: 1 })
      const layout = await page.locator('.content.page-ai').evaluate(element => {
        const transcript = element.querySelector<HTMLElement>('.assistant-transcript')!
        const composer = element.querySelector<HTMLElement>('.assistant-composer')!
        const workspace = element.querySelector<HTMLElement>('.ai-extension-workspace')!
        const hint = element.querySelector<HTMLElement>('.assistant-composer-hint')!
        return { pageOverflow: element.scrollHeight - element.clientHeight, transcriptOverflow: transcript.scrollHeight - transcript.clientHeight,
          transcriptBottom: transcript.getBoundingClientRect().bottom, composerTop: composer.getBoundingClientRect().top,
          workspaceBottom: workspace.getBoundingClientRect().bottom, hintBottom: hint.getBoundingClientRect().bottom }
      })
      expect(layout.pageOverflow).toBeLessThanOrEqual(1)
      expect(layout.transcriptOverflow).toBeGreaterThan(100)
      expect(layout.transcriptBottom).toBeLessThanOrEqual(layout.composerTop)
      expect(layout.hintBottom).toBeLessThanOrEqual(layout.workspaceBottom - 6)
      await expectButtonTargets(page)
      await page.screenshot({ path: testInfo.outputPath(`ai-short-${themeId}.png`) })
      await page.getByRole('tab', { name: uiText('Document AI assistant', '文档智能助手') }).click()
    }
  })
})
