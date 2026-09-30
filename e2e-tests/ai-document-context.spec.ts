import { expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { uiText, withElectronApp } from './helpers/electron'

async function createDocuments(page: Page): Promise<{ a: string; b: string }> {
  const ids = await page.evaluate(async () => {
    const create = async (title: string) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, {
        title, summary: '',
        blocks: [{ id: `${id}-body`, type: 'paragraph', content: title, checked: false, depth: 0 }]
      })
      return id
    }
    return { a: await create('AI Context A'), b: await create('AI Context B') }
  })
  await page.reload()
  return ids
}

async function installDeferredAi(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Pending = { documentId: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
    const answers: Pending[] = []
    const searches: Pending[] = []
    ipcMain.removeHandler('knowbook:ask-ai-about-document')
    ipcMain.removeHandler('knowbook:search-semantic-notes')
    ipcMain.handle('knowbook:ask-ai-about-document', (_event, input: { documentId: string }) =>
      new Promise((resolve, reject) => answers.push({ documentId: input.documentId, resolve, reject })))
    ipcMain.handle('knowbook:search-semantic-notes', (_event, input: { excludeDocumentId: string }) =>
      new Promise((resolve, reject) => searches.push({ documentId: input.excludeDocumentId, resolve, reject })))
    ipcMain.on('knowbook:test-ai-request-ids', (_event, reply: (ids: { answers: string[]; searches: string[] }) => void) => {
      reply({ answers: answers.map(item => item.documentId), searches: searches.map(item => item.documentId) })
    })
    ipcMain.on('knowbook:test-settle-ai', (_event, input: { index: number; fail: boolean; marker: string }) => {
      const answer = answers[input.index]
      const search = searches[input.index]
      if (!answer || !search) throw new Error(`Missing deferred AI request ${input.index}`)
      if (input.fail) {
        answer.reject(new Error(`${input.marker} answer error`))
        search.reject(new Error(`${input.marker} search error`))
      } else {
        answer.resolve({ answer: `${input.marker} answer`, references: [] })
        search.resolve([{
          documentId: 'test-related-document', title: `${input.marker} related note`, path: input.marker,
          summary: '', snippet: `${input.marker} snippet`, score: 1
        }])
      }
    })
  })
}

async function openDocumentAssistant(page: Page, title: string): Promise<void> {
  await page.getByTitle(uiText('Documents', '文档')).first().click()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  const prompt = page.locator('.document-aux-sidebar-content textarea.editor-textarea')
  if (!await prompt.isVisible()) await page.getByRole('button', { name: uiText('Show auxiliary', '展开辅助区') }).click()
  await expect(prompt).toBeVisible()
}

function assistantPanel(page: Page) {
  return page.locator('.document-aux-sidebar .ai-panel').filter({ has: page.locator('textarea') })
}

async function startRequests(page: Page, app: ElectronApplication, expectedIds: string[]): Promise<void> {
  const panel = assistantPanel(page)
  await panel.locator('textarea').fill('Which facts matter?')
  const ask = panel.getByRole('button', { name: uiText('Ask AI', '询问 AI') })
  const search = panel.getByRole('button', { name: uiText('Find related notes', '查找相关笔记') })
  await expect(ask).toBeEnabled()
  await expect(search).toBeEnabled()
  await search.click()
  await ask.click()
  await expect.poll(() => app.evaluate(({ ipcMain }) => new Promise((resolve) => {
    ipcMain.emit('knowbook:test-ai-request-ids', null, resolve)
  }))).toEqual({ answers: expectedIds, searches: expectedIds })
  await expectBusyAndEmpty(page)
}

async function expectBusyAndEmpty(page: Page): Promise<void> {
  const panel = assistantPanel(page)
  await expect(panel.getByRole('button', { name: uiText('Thinking...', '思考中...') })).toBeDisabled()
  await expect(panel.getByRole('button', { name: uiText('Searching...', '搜索中...') })).toBeDisabled()
  await expect(panel.locator('.ai-answer, .ai-context-card, .ai-context-error')).toHaveCount(0)
}

async function settleRequests(app: ElectronApplication, index: number, marker: string, fail = false): Promise<void> {
  await app.evaluate(({ ipcMain }, input) => {
    ipcMain.emit('knowbook:test-settle-ai', null, input)
  }, { index, marker, fail })
}

async function expectCurrentResults(page: Page, marker: string): Promise<void> {
  const panel = assistantPanel(page)
  await expect(panel.locator('.ai-answer')).toHaveText(`${marker} answer`)
  await expect(panel.locator('.ai-context-title')).toHaveText(`${marker} related note`)
  await expect(panel.locator('.ai-context-error')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: uiText('Ask AI', '询问 AI') })).toBeEnabled()
  await expect(panel.getByRole('button', { name: uiText('Find related notes', '查找相关笔记') })).toBeEnabled()
}

test('late AI failures cannot enter another document or end its pending requests @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    const ids = await createDocuments(page)
    await installDeferredAi(app)
    await openDocumentAssistant(page, 'AI Context A')
    await startRequests(page, app, [ids.a])
    await openDocumentAssistant(page, 'AI Context B')
    await startRequests(page, app, [ids.a, ids.b])
    await settleRequests(app, 0, 'Obsolete A', true)
    // Allow the rejected IPC promises and their catch/finally callbacks to reach the renderer.
    await page.waitForTimeout(200)
    await expectBusyAndEmpty(page)
    await settleRequests(app, 1, 'Current B')
    await expectCurrentResults(page, 'Current B')
  })
})

test('returning to a document rejects results from its previous AI session @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    const ids = await createDocuments(page)
    await installDeferredAi(app)
    await openDocumentAssistant(page, 'AI Context A')
    await startRequests(page, app, [ids.a])
    await openDocumentAssistant(page, 'AI Context B')
    await startRequests(page, app, [ids.a, ids.b])
    await openDocumentAssistant(page, 'AI Context A')
    await startRequests(page, app, [ids.a, ids.b, ids.a])
    await settleRequests(app, 0, 'Obsolete A')
    await settleRequests(app, 1, 'Obsolete B')
    // Matching the document ID alone must not admit the first A session's response.
    await page.waitForTimeout(200)
    await expectBusyAndEmpty(page)
    await settleRequests(app, 2, 'Current A')
    await expectCurrentResults(page, 'Current A')
  })
})
