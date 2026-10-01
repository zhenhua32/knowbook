import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ElectronApplication } from 'playwright'
import type { SaveWebDavSyncConfig, WebDavSyncStatus } from '../src/shared/webdav-sync'
import { createHash } from 'node:crypto'
import { canonicalJson, type SyncDocument } from '../src/main/sync/model'
import { createWebDavServer } from '../tests/helpers/webdav-server'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type NativeHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown | Promise<unknown>
type PendingAction = { event: IpcMainInvokeEvent; input: unknown; resolve: (status: unknown) => void; reject: (error: Error) => void }
type ActionProbe = { channel: string; original: NativeHandler; pending: PendingAction[]; calls: number }
type ProbeGlobal = typeof globalThis & { __knowbookWebDavFeedbackProbe?: ActionProbe }

async function openSettings(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Sync', '同步'), exact: true }).click()
  const section = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步'), exact: true })
  await expect(section).toBeVisible()
  return section
}

async function installProbe(app: ElectronApplication, channel: string) {
  await app.evaluate(({ ipcMain }, channel) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, NativeHandler> })._invokeHandlers.get(channel)
    if (!original) throw new Error('Missing real WebDAV action handler')
    const probe: ActionProbe = { channel, original, pending: [], calls: 0 }
    ;(globalThis as ProbeGlobal).__knowbookWebDavFeedbackProbe = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input: unknown) => {
      probe.calls++
      return new Promise<unknown>((resolve, reject) => probe.pending.push({ event, input, resolve, reject }))
    })
  }, channel)
}

async function restoreProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookWebDavFeedbackProbe!
    if (probe.pending.length) throw new Error('Cannot restore a pending action handler')
    ipcMain.removeHandler(probe.channel)
    ipcMain.handle(probe.channel, probe.original)
  })
}

async function readProbe(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookWebDavFeedbackProbe!
    return { pending: probe.pending.length, calls: probe.calls }
  })
}

async function finishAction(app: ElectronApplication, failure?: string) {
  await app.evaluate(async (_electron, failure) => {
    const probe = (globalThis as ProbeGlobal).__knowbookWebDavFeedbackProbe!
    const pending = probe.pending.shift()
    if (!pending) throw new Error('No pending WebDAV action')
    if (failure) pending.reject(new Error(`Error: ${failure}`))
    else {
      try { pending.resolve(await probe.original(pending.event, pending.input)) }
      catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))) }
    }
  }, failure ?? null)
}

async function enterAction(page: Page, button: Locator) {
  // Scroll only to the user action before starting it. Never scroll to a status or error to satisfy visibility checks.
  await button.scrollIntoViewIfNeeded()
  await expect(button).toBeInViewport({ ratio: 1 })
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
}

async function expectFeedbackWithButtons(feedback: Locator, buttons: Locator) {
  await expect(feedback).toBeInViewport({ ratio: 1 })
  await expect(buttons).toBeInViewport({ ratio: 1 })
  const feedbackBox = await feedback.boundingBox()
  const buttonsBox = await buttons.boundingBox()
  expect(feedbackBox).not.toBeNull()
  expect(buttonsBox).not.toBeNull()
  expect(feedbackBox!.y + feedbackBox!.height).toBeLessThanOrEqual(buttonsBox!.y + 1)
  expect(buttonsBox!.y - feedbackBox!.y - feedbackBox!.height).toBeLessThan(96)
}

async function recordFeedback(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const geometry = await page.locator('.webdav-settings').evaluate(section => {
    const describe = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { text: element.textContent, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
        fullyInsideViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth }
    }
    return { viewport: { width: innerWidth, height: innerHeight },
      feedback: [...section.querySelectorAll('[role="status"], [role="alert"]')].map(describe),
      buttons: [...section.querySelectorAll('.settings-actions button')].map(describe),
      activeElement: { tag: document.activeElement?.tagName, text: document.activeElement?.tagName === 'BUTTON' ? document.activeElement.textContent : null } }
  })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const body = JSON.stringify({ geometry, windows }, null, 2)
  console.log(`[webdav-feedback:${phase}] ${body}`)
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`WebDAV save feedback stays with the keyboard action and never repeats an old success after failure (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page }) => {
      const isZh = language === 'zh-CN'
      const config: SaveWebDavSyncConfig = { enabled: false, url: 'https://feedback-webdav.example.invalid/dav/', username: 'feedback-user',
        password: 'e2e-feedback-saved-password', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: false }
      await page.evaluate(async ({ config, language }) => {
        await window.knowbook.saveWebDavSyncConfig(config)
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
      }, { config, language })
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 760, height: isZh ? 850 : 640 })
      const previousSuccess = (await page.evaluate(() => window.knowbook.getWebDavSyncStatus())).message
      expect(previousSuccess).not.toBe('')
      const section = await openSettings(page)
      const password = section.getByLabel(uiText('App password', '应用密码'), { exact: true })
      const save = section.getByRole('button', { name: uiText('Save sync settings', '保存同步设置'), exact: true })
      // Keep the locator stable when its accessible name changes to the pending label.
      const saveButton = section.locator('.settings-actions > button.primary-button').first()
      await expect(password).toBeEnabled()
      await section.getByLabel(uiText('Username', '用户名'), { exact: true }).fill('feedback-retry-user')
      await password.fill('e2e-feedback-new-password')
      await installProbe(app, 'knowbook:save-webdav-sync-config')
      await enterAction(page, save)
      await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
      await expect(saveButton).toBeDisabled()
      const saving = section.getByRole('status').filter({ hasText: uiText('Saving sync settings…', '正在保存同步设置…') })
      const feedback = section.locator('.webdav-main-actions > .webdav-action-feedback')
      const buttons = section.locator('.webdav-main-actions > .settings-actions')
      await expect(saving).toHaveCount(1)
      await recordFeedback(page, app, testInfo, 'save-pending')
      await expect(saveButton).toBeInViewport({ ratio: 1 })
      await expect(saving).toBeInViewport({ ratio: 1 })
      await expectFeedbackWithButtons(feedback, buttons)

      await finishAction(app, 'Controlled WebDAV action save failure')
      const error = section.getByRole('alert').filter({ hasText: 'Controlled WebDAV action save failure' })
      await expect(error).toHaveCount(1)
      await expect(saveButton).toBeEnabled()
      await expect(saveButton).toBeFocused()
      await expect(password).toHaveValue('e2e-feedback-new-password')
      await expect(password).toHaveAttribute('type', 'password')
      await recordFeedback(page, app, testInfo, 'save-failure')
      await expect(saveButton).toBeInViewport({ ratio: 1 })
      await expect(error).toBeInViewport({ ratio: 1 })
      await expectFeedbackWithButtons(feedback, buttons)
      await expect(section.getByRole('status').filter({ hasText: previousSuccess })).toHaveCount(0)
      // After the busy action ends, the form is usable again and the dock must not cover keyboard targets.
      const http = section.getByLabel(uiText('Allow HTTP (unencrypted; trusted networks only)', '允许 HTTP（连接不加密，仅用于可信网络）'), { exact: true })
      await page.keyboard.press('Shift+Tab')
      await expect(http).toBeFocused()
      await expect(http).toBeEnabled()
      await expect(http).toBeInViewport({ ratio: 1 })
      expect(await http.evaluate(input => {
        const rect = input.getBoundingClientRect()
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input
      })).toBe(true)
      await page.keyboard.press('Tab')
      await expect(saveButton).toBeFocused()
      // A real successful retry is still delegated to main-process persistence.
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
      expect((await readProbe(app)).calls).toBe(2)
      await finishAction(app)
      await expect(saveButton).toBeEnabled()
      await expect(saveButton).toBeFocused()
      await expect(error).toHaveCount(0)
      await expect(password).toHaveValue('')
      const saved: WebDavSyncStatus = await page.evaluate(() => window.knowbook.getWebDavSyncStatus())
      expect(saved.config.username).toBe('feedback-retry-user')
      expect(saved.hasPassword).toBe(true)
    })
  })
}

async function seedServerSettings(page: Page, url: string, language: 'en-US' | 'zh-CN' = 'en-US') {
  await page.evaluate(async ({ url, language }) => {
    await window.knowbook.saveWebDavSyncConfig({ enabled: false, url, username: 'test', password: 'app-secret',
      directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: true })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
  }, { url, language })
}

function publishRemote(server: Awaited<ReturnType<typeof createWebDavServer>>, id: string, change: (record: SyncDocument) => void) {
  const manifest = JSON.parse(server.files.get('/KnowBook/manifest.json')!.toString())
  const record = JSON.parse(server.files.get(`/KnowBook/objects/${manifest.entries[`doc:${id}`]}.json`)!.toString()) as SyncDocument
  change(record)
  const bytes = Buffer.from(canonicalJson(record))
  const hash = createHash('sha256').update(bytes).digest('hex')
  server.files.set(`/KnowBook/objects/${hash}.json`, bytes)
  manifest.entries[`doc:${id}`] = hash
  server.files.set('/KnowBook/manifest.json', Buffer.from(canonicalJson(manifest)))
}

test('connection, sync and stop feedback stays beside its action through failures and real retries @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  const server = await createWebDavServer()
  let releaseUpload: (() => void) | undefined
  try {
    await withElectronApp(async ({ app, page }) => {
      await seedServerSettings(page, server.url)
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 760, height: 640 })
      const section = await openSettings(page)
      const feedback = section.locator('.webdav-main-actions > .webdav-action-feedback')
      const buttons = section.locator('.webdav-main-actions > .settings-actions')
      for (const action of [
        { channel: 'knowbook:test-webdav-connection', en: 'Test connection', zh: '测试连接', pendingEn: 'Testing connection…', pendingZh: '正在测试连接…', reason: 'Controlled connection failure' },
        { channel: 'knowbook:sync-webdav-now', en: 'Sync now', zh: '立即同步', pendingEn: 'Starting sync…', pendingZh: '正在启动同步…', reason: 'Controlled sync failure' }
      ]) {
        const button = buttons.getByRole('button', { name: uiText(action.en, action.zh), exact: true })
        await installProbe(app, action.channel)
        await enterAction(page, button)
        await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
        await expect(button).toHaveAttribute('aria-busy', 'true')
        await expect(feedback.getByRole('status')).toHaveText(uiText(action.pendingEn, action.pendingZh))
        await expectFeedbackWithButtons(feedback, buttons)
        await finishAction(app, action.reason)
        const error = feedback.getByRole('alert')
        await expect(error).toHaveText(action.reason)
        await expect(button).toBeEnabled()
        await expect(button).toBeFocused()
        await expect(feedback.getByRole('status')).toHaveCount(0)
        await expectFeedbackWithButtons(feedback, buttons)
        await recordFeedback(page, app, testInfo, `${action.en === 'Sync now' ? 'sync' : 'connection'}-failure`)
        await page.keyboard.press('Enter')
        await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
        expect((await readProbe(app)).calls).toBe(2)
        await finishAction(app)
        await expect(button).toBeEnabled()
        await expect(button).toBeFocused()
        await expect(error).toHaveCount(0)
        const status = await page.evaluate(() => window.knowbook.getWebDavSyncStatus())
        expect(status.phase).toBe('idle')
        await restoreProbe(app)
      }
      expect(server.files.has('/KnowBook/manifest.json')).toBe(true)
      // A GET with a usable ETag needs no PROPFIND fallback. Verify the real read/write connection probe instead.
      for (const method of ['PUT', 'GET', 'DELETE']) {
        expect(server.requests.some(request => request.method === method && request.path.includes('/.probe-'))).toBe(true)
      }

      const attachmentBytes = 'feedback-progress-attachment'
      const attachmentHash = createHash('sha256').update(attachmentBytes).digest('hex')
      await page.evaluate(async attachmentBytes => {
        const [attachment] = await window.knowbook.importAttachments([{ name: 'feedback-progress.pdf', bytes: new TextEncoder().encode(attachmentBytes) }])
        const document = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(document.id, { title: 'Progress feedback', summary: '', blocks: [{
          id: crypto.randomUUID(), type: 'paragraph', content: `[Progress attachment](${attachment.url})`, checked: false, depth: 0
        }] })
      }, attachmentBytes)
      let uploading = false
      const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
      server.setHook(async request => {
        if (request.method === 'PUT' && request.url!.endsWith(`/assets/${attachmentHash}`)) { uploading = true; await uploadGate }
      })
      await enterAction(page, buttons.getByRole('button', { name: uiText('Sync now', '立即同步'), exact: true }))
      await expect.poll(() => uploading).toBe(true)
      const progress = feedback.locator('.webdav-sync-progress')
      await expect(progress.getByRole('status')).toHaveText(uiText('Uploading documents and attachments', '正在上传文档与附件'))
      await recordFeedback(page, app, testInfo, 'upload-progress')
      await expectFeedbackWithButtons(feedback, buttons)
      const stop = buttons.getByRole('button', { name: /^(Stop this sync|Stopping…|停止本次同步|正在停止…)$/ })
      await installProbe(app, 'knowbook:cancel-webdav-sync')
      await enterAction(page, stop)
      await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
      await expect(stop).toHaveAttribute('aria-busy', 'true')
      await expect(feedback.getByRole('status')).toHaveText(uiText('Stopping this sync…', '正在停止本次同步…'))
      await expectFeedbackWithButtons(feedback, buttons)
      await finishAction(app, 'Controlled stop failure')
      await expect(stop).toBeEnabled()
      await expect(stop).toBeFocused()
      await expect(feedback.getByRole('alert')).toHaveText('Controlled stop failure')
      // A failed stop did not stop the real upload. Keep live progress alongside the error.
      await expect(progress.getByRole('status')).toHaveText(uiText('Uploading documents and attachments', '正在上传文档与附件'))
      await recordFeedback(page, app, testInfo, 'stop-failure-with-live-progress')
      await expectFeedbackWithButtons(feedback, buttons)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
      expect((await readProbe(app)).calls).toBe(2)
      await finishAction(app)
      await expect(stop).toHaveCount(0)
      await expect(progress).toHaveCount(0)
      await expect(feedback.getByRole('alert')).toHaveCount(0)
      await expect(section.getByLabel(uiText('WebDAV URL', 'WebDAV 服务地址'), { exact: true })).toBeFocused()
      expect((await page.evaluate(() => window.knowbook.getWebDavSyncStatus())).phase).toBe('idle')
      await restoreProbe(app)
      releaseUpload?.()
      server.setHook(undefined)
    })
  } finally { releaseUpload?.(); await server.close() }
})

test('merge feedback belongs to the current conflict and failed custom choices survive a real retry and reload @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  const server = await createWebDavServer()
  try {
    await withElectronApp(async ({ app, page }) => {
      await seedServerSettings(page, server.url, 'zh-CN')
      const ids = await page.evaluate(async () => {
        const ids: string[] = []
        for (const title of ['Base upper conflict', 'Base lower conflict']) {
          const document = await window.knowbook.createDocument(null)
          await window.knowbook.updateDocument(document.id, { title, summary: 'base summary',
            blocks: ['base overlap', 'base remote field', 'base local field'].map(content => ({
              id: crypto.randomUUID(), type: 'paragraph', content, checked: false, depth: 0
            })) })
          ids.push(document.id)
        }
        await window.knowbook.syncWebDavNow()
        return ids
      })
      ids.forEach((id, index) => publishRemote(server, id, record => {
        record.content.title = index === 0 ? 'Remote upper conflict' : 'Remote lower conflict'
        record.content.blocks[0].content = 'Remote overlapping paragraph. '.repeat(12)
        record.content.blocks[1].content = 'Remote independent paragraph'
      }))
      await page.evaluate(async ids => {
        for (let index = 0; index < ids.length; index++) {
          const document = (await window.knowbook.getDocumentDetail(ids[index]))!
          await window.knowbook.updateDocument(document.id, { title: index === 0 ? 'Local upper conflict' : 'Local lower conflict',
            summary: document.summary, blocks: document.blocks.map((block, blockIndex) => blockIndex === 0
              ? { ...block, content: 'Local overlapping paragraph. '.repeat(12) }
              : blockIndex === 2 ? { ...block, content: 'Local independent paragraph' } : block) })
        }
        await window.knowbook.syncWebDavNow()
      }, ids)
      expect((await page.evaluate(() => window.knowbook.getWebDavSyncStatus())).conflicts).toHaveLength(2)
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 760, height: 850 })
      let section = await openSettings(page)
      const upper = section.locator('.webdav-conflict-card').filter({ hasText: 'Local upper conflict' })
      let lower = section.locator('.webdav-conflict-card').filter({ hasText: 'Local lower conflict' })
      await upper.locator(':scope > summary').click()
      await lower.locator(':scope > summary').click()
      await lower.getByRole('button', { name: uiText('Merge changes', '逐项合并'), exact: true }).click()
      const title = lower.getByRole('group', { name: uiText('Title', '标题'), exact: true })
      const block = lower.getByRole('group', { name: uiText('Block 1', '正文块 1'), exact: true })
      await title.getByLabel(uiText('Custom merged text', '自定义合并内容'), { exact: true }).check()
      const titleInput = title.getByLabel(uiText('Title merged content', '标题合并内容'), { exact: true })
      await titleInput.fill('Preserved custom merge title')
      await block.getByLabel(uiText('Custom merged text', '自定义合并内容'), { exact: true }).check()
      // React's initial textarea content is also inside this wrapping label. Match the field within its named group.
      await expect(block.locator('label.editor-label')).toContainText('正文块 1合并内容')
      const blockInput = block.locator('textarea.editor-textarea')
      await expect(blockInput).toHaveAccessibleName(uiText('Block 1 merged content', '正文块 1合并内容'))
      await blockInput.fill('Preserved custom merge paragraph')
      const mergeSave = lower.getByRole('button', { name: uiText('Save merge plan', '保存合并方案'), exact: true })
      const mergeFeedback = lower.locator('.webdav-conflict-merge > .webdav-action-feedback')
      const mergeButtons = lower.locator('.webdav-conflict-merge > .settings-actions')
      const reason = 'Controlled lower merge failure'
      await installProbe(app, 'knowbook:resolve-webdav-sync-conflict')
      await enterAction(page, mergeSave)
      await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
      await expect(mergeSave).toHaveAttribute('aria-busy', 'true')
      await expect(mergeFeedback).toHaveAttribute('role', 'status')
      await expect(mergeFeedback).toHaveText(uiText('Saving resolution…', '正在保存处理方案…'))
      await expect(titleInput).toBeDisabled()
      await expect(blockInput).toBeDisabled()
      await expectFeedbackWithButtons(mergeFeedback, mergeButtons)
      await finishAction(app, reason)
      await expect(mergeSave).toBeEnabled()
      await expect(mergeSave).toBeFocused()
      await expect(mergeFeedback).toHaveAttribute('role', 'alert')
      await expect(mergeFeedback).toHaveText(reason)
      await expect(upper.getByRole('alert')).toHaveCount(0)
      await expect(section.getByRole('alert')).toHaveCount(1)
      await expect(section.locator('.webdav-main-actions').getByRole('alert')).toHaveCount(0)
      await expect(titleInput).toHaveValue('Preserved custom merge title')
      await expect(blockInput).toHaveValue('Preserved custom merge paragraph')
      await recordFeedback(page, app, testInfo, 'lower-merge-failure')
      await expectFeedbackWithButtons(mergeFeedback, mergeButtons)

      // Starting a different card transfers feedback ownership immediately; A's failure must not remain or attach to B.
      const useUpper = upper.getByRole('button', { name: uiText('Use local version', '使用本地版本'), exact: true })
      await enterAction(page, useUpper)
      await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
      await expect(lower.getByRole('alert')).toHaveCount(0)
      await expect(upper.getByRole('alert')).toHaveCount(0)
      await expect(upper.locator('.webdav-conflict-body > .webdav-action-feedback')).toHaveAttribute('role', 'status')
      await finishAction(app)
      await expect(useUpper).toBeEnabled()
      await expect(upper.locator('.webdav-conflict-pending').first()).toBeVisible()
      await expect(lower.getByRole('alert')).toHaveCount(0)

      // Revisit A's preserved draft, fail once, then retry through the original persistence handler using restored keyboard focus.
      await enterAction(page, mergeSave)
      await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
      await finishAction(app, reason)
      await expect(mergeSave).toBeFocused()
      await expect(mergeFeedback).toHaveText(reason)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await readProbe(app)).pending).toBe(1)
      expect((await readProbe(app)).calls).toBe(4)
      await finishAction(app)
      await expect(mergeSave).toBeEnabled()
      await expect(mergeSave).toBeFocused()
      await expect(lower.getByRole('alert')).toHaveCount(0)
      await expect(lower.locator('.webdav-conflict-pending').first()).toBeVisible()
      await expect(titleInput).toHaveValue('Preserved custom merge title')
      await expect(blockInput).toHaveValue('Preserved custom merge paragraph')
      const resolutions = (await page.evaluate(() => window.knowbook.getWebDavSyncStatus())).conflicts
      expect(resolutions.find(conflict => conflict.key === `doc:${ids[0]}`)?.resolution).toBe('local')
      expect(resolutions.find(conflict => conflict.key === `doc:${ids[1]}`)?.resolution).toBe('merge')
      await recordFeedback(page, app, testInfo, 'merge-retry-saved')
      await page.reload()
      section = await openSettings(page)
      lower = section.locator('.webdav-conflict-card').filter({ hasText: 'Local lower conflict' })
      await lower.locator(':scope > summary').click()
      await lower.getByRole('button', { name: uiText('Merge changes', '逐项合并'), exact: true }).click()
      await expect(lower.getByRole('group', { name: uiText('Title', '标题'), exact: true })
        .getByLabel(uiText('Title merged content', '标题合并内容'), { exact: true })).toHaveValue('Preserved custom merge title')
      const restoredBlock = lower.getByRole('group', { name: uiText('Block 1', '正文块 1'), exact: true })
      await expect(restoredBlock.locator('label.editor-label')).toContainText('正文块 1合并内容')
      await expect(restoredBlock.locator('textarea.editor-textarea')).toHaveAccessibleName(uiText('Block 1 merged content', '正文块 1合并内容'))
      await expect(restoredBlock.locator('textarea.editor-textarea')).toHaveValue('Preserved custom merge paragraph')
      expect(await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.title, ids[1])).toBe('Local lower conflict')
    })
  } finally { await server.close() }
})
