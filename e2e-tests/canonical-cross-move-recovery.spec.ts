import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { PrepareEditorRecoveryCrossMoveInput } from '../src/shared/editor-recovery-drafts'
import { closeElectronApp, hasBuiltElectronApp, launchElectronApp, uiText } from './helpers/electron'
import { inlineInstance, setInlineReading } from './helpers/canonical-inline'

test.skip(!hasBuiltElectronApp(), 'The current local Electron bundle must be built')

test('a committed V4 move loads the durable shared-body draft and Redo in the new page through the actual recovery panel @electron', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-e2e-cross-move-recovery-')), profile = join(root, 'profile')
  const executable = createRequire(import.meta.url)('electron') as string
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'cross-move-recovery-seed.ts')
  await promisify(execFile)(executable, ['--import', 'tsx', fixture, root], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000
  })
  const seed = JSON.parse(await readFile(join(profile, 'cross-move-recovery-seed.json'), 'utf8')) as {
    instanceId: string; groupId: string; targetId: string; raw: string
  }
  const context = await launchElectronApp({}, { userDataRoot: profile, editorMode: 'markdown' })
  const { app, page } = context
  let passed = false
  try {
    await app.evaluate(({ app, ipcMain }, profile) => {
      if (process.env.KNOWBOOK_E2E_BACKGROUND !== '1' || app.getPath('userData') !== profile) throw new Error('The actual background profile is required')
      const channel = 'knowbook:prepare-editor-recovery-group-cross-move'
      type Handler = (event: IpcMainInvokeEvent, input: PrepareEditorRecoveryCrossMoveInput) => unknown
      const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)
      if (!handler) throw new Error('The real receiving Main handler is required')
      let loseFirst = true
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, input: PrepareEditorRecoveryCrossMoveInput) => {
        const actual = await handler(event, input)
        if (loseFirst) { loseFirst = false; throw new Error('Actual receiving journal committed before the reply was lost') }
        return actual
      })
    }, profile)
    await page.locator('.tree-button', { hasText: 'V3 Target' }).first().click({ noWaitAfter: true })
    await expect(page.locator('.document-header-title')).toHaveText('V3 Target')
    await setInlineReading(page, false)
    const occurrence = inlineInstance(page, seed.instanceId), body = occurrence.locator('.ProseMirror[contenteditable="true"]')
    await expect(body).toBeVisible()
    await expect(body).not.toContainText('unsaved W')
    await page.getByRole('button', { name: /检查保留的编辑草稿|Review retained editor drafts/ }).click()
    const panel = page.getByRole('dialog', { name: uiText('Retained editor drafts', '保留的编辑草稿'), exact: true })
    await panel.getByRole('button', { name: /V3 Host/ }).click()
    await expect(panel).toContainText(/original move is confirmed|原移动已确认/i)
    await panel.getByRole('button', { name: uiText('Restore', '恢复'), exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect(body).toContainText('unsaved W')
    await expect(occurrence.getByRole('status')).toContainText(/review them before saving|请检查后点击/i)
    const savedBody = () => page.evaluate(async ({ targetId, instanceId, groupId }) => {
      const actual = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: targetId, instanceId, groupId })
      return actual.status === 'ready' ? actual.snapshot.blocks[0].content : null
    }, seed)
    expect(await savedBody()).toBe(seed.raw)
    await occurrence.getByRole('button', { name: uiText('Redo', '重做'), exact: true }).click()
    await expect(body).toContainText('unsaved Redo')
    await occurrence.getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
    await expect(body).not.toContainText('unsaved Redo')
    await expect(body).toContainText('unsaved W')
    await occurrence.getByRole('button', { name: uiText('Save / retry', '保存／重试'), exact: true }).click()
    await expect.poll(savedBody).toBe(seed.raw + ' unsaved W')
    passed = true
  } finally {
    await closeElectronApp(context, { preserveUserData: !passed })
  }
})
