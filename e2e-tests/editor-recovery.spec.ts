import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { IpcMainInvokeEvent } from 'electron'
import type { EditorRecoveryReceipt, EditorRecoveryRecord, WriteEditorRecoveryDraftsInput } from '../src/shared/editor-recovery-drafts'
import { closeElectronApp, hasBuiltElectronApp, launchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'
import { expectSource, selectSource, sourceValue } from './helpers/markdown-source'

type RecoveryWrite = (event: IpcMainInvokeEvent, input: WriteEditorRecoveryDraftsInput) => Promise<EditorRecoveryReceipt>
type RecoveryRead = (event: IpcMainInvokeEvent, input: { recordId: string; generation: number; hash: string }) => Promise<{ record: EditorRecoveryRecord }>
type CloseProof = { receipt: EditorRecoveryReceipt; records: EditorRecoveryRecord[] }
type Probe = { original: RecoveryWrite; proof: Promise<CloseProof>; release: () => void }
type Globals = typeof globalThis & { __knowbookRecoveryCloseProbe?: Probe }
async function editing(page: Page) {
  const toggle = page.locator('.document-navigation .document-view-toggle')
  await expect(toggle).toBeVisible()
  if (await toggle.getAttribute('aria-pressed') !== 'false') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
}

async function withRecoveryApp(info: TestInfo, run: (fixture: { context: () => ElectronAppContext; restart: () => Promise<void> }) => Promise<void>) {
  let current = await launchElectronApp({}, { editorMode: 'markdown' }), failed = true
  try {
    await run({ context: () => current, restart: async () => {
      const root = current.tempRoot
      await closeElectronApp(current, { preserveUserData: true })
      current = await launchElectronApp({}, { userDataRoot: root, editorMode: 'markdown' })
    } }); failed = false
  } catch (error) {
    await info.attach('retained-recovery-profile', { body: Buffer.from(current.tempRoot), contentType: 'text/plain' }); throw error
  } finally { await closeElectronApp(current, { preserveUserData: failed }) }
}
async function createOrdinary(page: Page, title: string) {
  const detail = await page.evaluate(async title => {
    const created = await window.knowbook.createDocument(null), before = (await window.knowbook.getDocumentDetail(created.id))!
    await window.knowbook.updateDocument(before.id, { expectedUpdatedAt: before.updatedAt, title, summary: 'Persisted summary P',
      blocks: [{ ...before.blocks[0], type: 'paragraph', content: 'Persisted ordinary P', tags: ['hidden source attrs'], highlight: 'green' }] })
    return (await window.knowbook.getDocumentDetail(created.id))!
  }, title)
  // Fixture hydration only; all close/reopen assertions below use actual Main
  // X/quit preparation and the unchanged background/isolated-profile helper.
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  await editing(page)
  return detail
}
async function closeThroughRealWindow(context: ElectronAppContext) {
  const closed = context.page.waitForEvent('close')
  await context.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
}
async function review(page: Page, title: string) {
  await page.getByRole('button', { name: /检查保留的编辑草稿|Review retained editor drafts/ }).click()
  const panel = page.getByRole('dialog', { name: uiText('Retained editor drafts', '保留的编辑草稿'), exact: true })
  await panel.getByRole('button', { name: new RegExp(title) }).click()
  return panel
}
async function holdRealCloseReceipt(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, RecoveryWrite | RecoveryRead> })._invokeHandlers
    const original = map.get('knowbook:write-editor-recovery-drafts') as RecoveryWrite | undefined
    const read = map.get('knowbook:read-editor-recovery-draft') as RecoveryRead | undefined
    if (!original || !read) throw new Error('Actual trusted Main recovery handlers required')
    let done!: (proof: CloseProof) => void, release!: () => void
    const proof = new Promise<CloseProof>(resolve => { done = resolve }), released = new Promise<void>(resolve => { release = resolve })
    ;(globalThis as Globals).__knowbookRecoveryCloseProbe = { original, proof, release }
    ipcMain.removeHandler('knowbook:write-editor-recovery-drafts')
    ipcMain.handle('knowbook:write-editor-recovery-drafts', async (event, input: WriteEditorRecoveryDraftsInput) => {
      const receipt = await original(event, input)
      if (input.purpose === 'close') {
        const records = await Promise.all(receipt.records.map(async item => (await read(event, { recordId: item.recordId, generation: item.generation, hash: item.hash })).record))
        done({ receipt, records }); await released
      }
      return receipt
    })
  })
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before editor recovery acceptance')

test('ordinary retained W restores through the real UI without autosave, explicit Save persists it, and normal close/reopen clears the saved recovery heads @electron', async ({}, info) => {
  await withRecoveryApp(info, async fixture => {
    let { page } = fixture.context()
    const persisted = await createOrdinary(page, 'Recovery ordinary UI'), recoveredTitle = 'Recovered ordinary title C', recoveredBody = 'Recovered ordinary body C'
    // Actual Main/side-store seed for a prior durable local draft. This does
    // not mock a writer or install renderer state; Restore below uses the real
    // panel, hook, canonical drain, Main writer and a fresh app process.
    await page.evaluate(async ({ persisted, recoveredTitle, recoveredBody }) => {
      const opened = await window.knowbook.openEditorRecoveryDraft({ kind: 'host', documentId: persisted.id, expectedUpdatedAt: persisted.updatedAt, openRequestId: crypto.randomUUID() })
      const working = structuredClone(opened.base.persistedWorking)
      if (working.kind !== 'host') throw new Error('Actual host recovery base required')
      working.title = recoveredTitle; working.summary = 'Recovered summary C'; working.blocks[0].content = recoveredBody
      await window.knowbook.writeEditorRecoveryDrafts({ purpose: 'background', records: [{ draftSessionId: opened.draftSessionId,
        generation: 1, expectedPreviousGeneration: 0, working, pending: [], sources: [], selection: null, composing: false, importing: false }] })
    }, { persisted, recoveredTitle, recoveredBody })
    await closeThroughRealWindow(fixture.context()); await fixture.restart(); page = fixture.context().page
    await page.locator('.tree-button', { hasText: persisted.title }).first().click()
    await editing(page)
    const panel = await review(page, recoveredTitle)
    await panel.getByRole('button', { name: uiText('Restore', '恢复'), exact: true }).click()
    const save = page.getByRole('button', { name: uiText('Save restored draft', '保存恢复的草稿'), exact: true })
    await expect(save).toBeVisible(); await expect(page.locator('.block-inline-textarea').first()).toHaveValue(recoveredBody)
    // Exceed the actual 800 ms autosave interval without changing that timer.
    await page.waitForTimeout(1_200)
    expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.id)).toEqual(persisted)
    await expect(save).toBeVisible()
    await save.click()
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.id))?.blocks[0].content).toBe(recoveredBody)
    const saved = await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.id)
    expect(saved?.title).toBe(recoveredTitle); expect(saved?.summary).toBe('Recovered summary C')
    expect(saved?.blocks[0].tags).toEqual(['hidden source attrs']); expect(saved?.blocks[0].highlight).toBe('green')
    await closeThroughRealWindow(fixture.context()); await fixture.restart(); page = fixture.context().page
    await expect.poll(async () => (await page.evaluate(() => window.knowbook.listEditorRecoveryDrafts({ limit: 100 }))).records.length).toBe(0)
    expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.id)).toEqual(saved)
  })
})

test('real unapplied CM input is journaled by an actual close receipt and restored in a fresh app with selection/Undo floor; Cancel and explicit Apply keep separate persistence decisions @electron', async ({}, info) => {
  await withRecoveryApp(info, async fixture => {
    let { page, app } = fixture.context()
    const persisted = await createOrdinary(page, 'Recovery source UI')
    await page.locator('.document-header-more-button').click()
    await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    let dialog = page.getByRole('dialog', { name: uiText('Edit host body source', '编辑宿主正文源码'), exact: true })
    let editor = dialog.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码'), exact: true })
    const opening = await sourceValue(editor), suffix = ' continuous 中文🙂 C'
    await editor.press('Control+End'); await page.keyboard.insertText(suffix)
    const visual = opening + suffix, anchor = visual.length - 2, head = 2
    await expectSource(editor, visual); await selectSource(editor, anchor, head)
    expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.id)).toEqual(persisted)
    await holdRealCloseReceipt(app)
    const closed = page.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    const proof = await app.evaluate(async () => await (globalThis as Globals).__knowbookRecoveryCloseProbe!.proof)
    expect(proof.receipt.purpose).toBe('close'); expect(proof.receipt.closeGeneration).not.toBeNull()
    const sourceRecord = proof.records.find(record => record.base.owner.kind === 'host' && record.base.owner.documentId === persisted.id && record.draft.sources.length)
    expect(sourceRecord).toBeTruthy()
    const raw = sourceRecord!.draft.sources[0]
    expect(raw.source.replace(/\r\n?/g, '\n')).toBe(visual)
    expect(raw.selection).toEqual({ anchor, head })
    await app.evaluate(() => (globalThis as Globals).__knowbookRecoveryCloseProbe!.release())
    await closed; await fixture.restart(); ({ page, app } = fixture.context())
    await page.locator('.tree-button', { hasText: persisted.title }).first().click()
    await editing(page)
    let panel = await review(page, persisted.title)
    await panel.getByRole('button', { name: uiText('Restore', '恢复'), exact: true }).click()
    dialog = page.getByRole('dialog', { name: uiText('Edit host body source', '编辑宿主正文源码'), exact: true })
    editor = dialog.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码'), exact: true })
    await expectSource(editor, visual)
    expect(await editor.evaluate(element => {
      const view = (element as HTMLElement & { cmTile: { root: { view: { state: { selection: { main: { anchor: number; head: number } } } } } } }).cmTile.root.view
      return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }
    })).toEqual({ anchor, head })
    await dialog.getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
    await expectSource(editor, opening); await expect(dialog.getByRole('button', { name: uiText('Undo', '撤销'), exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: uiText('Redo', '重做'), exact: true }).click(); await expectSource(editor, visual)
    await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.id)).toEqual(persisted)
    panel = await review(page, persisted.title)
    await panel.getByRole('button', { name: uiText('Restore', '恢复'), exact: true }).click()
    dialog = page.getByRole('dialog', { name: uiText('Edit host body source', '编辑宿主正文源码'), exact: true })
    await dialog.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.id))?.blocks[0].content).toBe('Persisted ordinary P' + suffix)
    const after = await page.evaluate(id => window.knowbook.getDocumentDetail(id), persisted.id)
    expect(after?.blocks[0].id).toBe(persisted.blocks[0].id); expect(after?.blocks[0].tags).toEqual(persisted.blocks[0].tags)
    await info.attach('actual-recovery-close-receipt', { body: Buffer.from(JSON.stringify({ receipt: proof.receipt, sourceRecord, after }, null, 2)), contentType: 'application/json' })
  })
})
