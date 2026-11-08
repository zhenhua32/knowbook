import { expect, test } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { IpcMainInvokeEvent } from 'electron'
import type { EditorRecoveryDraftInput, EditorRecoveryReceipt, WriteEditorRecoveryDraftsInput } from '../src/shared/editor-recovery-drafts'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { appendCanonicalText, expectCanonicalRow, expectHostReferencesUnchanged, inlineInstance,
  openInlineHost, saveCanonical, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'

type DraftWriter = (event: IpcMainInvokeEvent, input: WriteEditorRecoveryDraftsInput) => Promise<EditorRecoveryReceipt>
type SessionInvoker = (event: IpcMainInvokeEvent, input: SyncedEditingRequest) => Promise<unknown>
type CrashProof = { receipt: EditorRecoveryReceipt; draft: EditorRecoveryDraftInput; businessWrites: number }
type Globals = typeof globalThis & { __knowbookCanonicalCrashProof?: Promise<CrashProof> }

/** Crash the actual renderer immediately after the actual side COMMIT. Both
 * handlers forward every call to unchanged Main implementations; no ACK or
 * source owner is fabricated. This deterministic crash keeps the unchanged
 * real 500/800ms journal/autosave intervals and background launch restrictions. */
async function crashAfterActualJournal(app: ElectronApplication, groupId: string, suffix: string) {
  await app.evaluate(({ ipcMain }, { groupId, suffix }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, DraftWriter | SessionInvoker> })._invokeHandlers
    const write = handlers.get('knowbook:write-editor-recovery-drafts') as DraftWriter | undefined
    const invoke = handlers.get('knowbook:invoke-synced-editing-session') as SessionInvoker | undefined
    if (!write || !invoke) throw new Error('Actual Main recovery and fenced writer handlers are required')
    let resolve!: (proof: CrashProof) => void, businessWrites = 0, crashed = false
    ;(globalThis as Globals).__knowbookCanonicalCrashProof = new Promise(done => { resolve = done })
    ipcMain.removeHandler('knowbook:invoke-synced-editing-session')
    ipcMain.handle('knowbook:invoke-synced-editing-session', async (event, input: SyncedEditingRequest) => {
      if (input.method === 'updateSyncedBlockGroup' || input.method === 'restoreSyncedGroupOperation') businessWrites++
      return invoke(event, input)
    })
    ipcMain.removeHandler('knowbook:write-editor-recovery-drafts')
    ipcMain.handle('knowbook:write-editor-recovery-drafts', async (event, input: WriteEditorRecoveryDraftsInput) => {
      const receipt = await write(event, input)
      const draft = input.records.find(record => record.working.kind === 'group' && record.working.blocks.some(block => block.content.endsWith(suffix)))
      if (!crashed && input.purpose === 'background' && draft) {
        const packet = JSON.parse(draft.replayJson ?? 'null')
        if (packet?.snapshot?.groupId === groupId) {
          crashed = true; resolve({ receipt, draft, businessWrites })
          event.sender.forcefullyCrashRenderer()
        }
      }
      return receipt
    })
  }, { groupId, suffix })
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before canonical cold restoration acceptance')

test('real canonical input survives a crash immediately after actual side COMMIT and a new Main owner restores all occurrences with local Undo/Redo but no autosave before explicit Save @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture
    let { page, app } = fixture.context()
    await openInlineHost(page, seed.hosts[0]); await setInlineReading(page, false)
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[0]), seed.primaryId, seed.primaryText)
    const suffix = ' cold retained canonical C', recovered = seed.primaryText + suffix
    await crashAfterActualJournal(app, seed.groupId, suffix)
    await appendCanonicalText(page, seed.instanceIds[0], seed.primaryId, seed.primaryText, suffix)
    const proof = await app.evaluate(async () => await (globalThis as Globals).__knowbookCanonicalCrashProof!)
    expect(proof.receipt.purpose).toBe('background'); expect(proof.businessWrites).toBe(0)
    expect(proof.draft.working.blocks.find(block => block.id === seed.primaryId)?.content).toBe(recovered)
    const replay = JSON.parse(proof.draft.replayJson!)
    expect(replay.version).toBe(2); expect(replay.frames.length).toBeGreaterThan(0); expect(replay.accepted).toBeNull()
    await fixture.restart(); ({ page, app } = fixture.context())
    await openInlineHost(page, seed.hosts[0]); await setInlineReading(page, false)
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[0]), seed.primaryId, seed.primaryText)
    await page.getByRole('button', { name: /检查保留的编辑草稿|Review retained editor drafts/ }).click()
    const panel = page.getByRole('dialog', { name: uiText('Retained editor drafts', '保留的编辑草稿'), exact: true })
    await panel.getByRole('button', { name: new RegExp(seed.query) }).click()
    await expect(panel.getByRole('button', { name: uiText('Restore', '恢复'), exact: true })).toBeEnabled()
    await panel.getByRole('button', { name: uiText('Restore', '恢复'), exact: true }).click()
    await expect(panel).toHaveCount(0)
    for (const id of seed.instanceIds.slice(0, 2)) await expectCanonicalRow(inlineInstance(page, id), seed.primaryId, recovered)
    const first = inlineInstance(page, seed.instanceIds[0])
    await expect(first.getByRole('status')).toContainText(uiText('The restored shared body', '恢复的共享正文'))
    await page.waitForTimeout(1_200)
    const current = await page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input), {
      hostDocumentId: seed.hosts[0].id, instanceId: seed.instanceIds[0], groupId: seed.groupId
    })
    expect(current.status).toBe('ready')
    if (current.status !== 'ready') throw new Error('The actual group must remain present')
    expect(current.snapshot.blocks.find(block => block.id === seed.primaryId)?.content).toBe(seed.primaryText)
    await first.getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
    for (const id of seed.instanceIds.slice(0, 2)) await expectCanonicalRow(inlineInstance(page, id), seed.primaryId, seed.primaryText)
    await first.getByRole('button', { name: uiText('Redo', '重做'), exact: true }).click()
    for (const id of seed.instanceIds.slice(0, 2)) await expectCanonicalRow(inlineInstance(page, id), seed.primaryId, recovered)
    await saveCanonical(page, seed, seed.instanceIds[0], recovered)
    await expectHostReferencesUnchanged(page, seed)
    await expect.poll(async () => (await page.evaluate(() => window.knowbook.listEditorRecoveryDrafts({ limit: 20 }))).records.length).toBe(0)
    await info.attach('actual-canonical-crash-journal', { body: Buffer.from(JSON.stringify(proof, null, 2)), contentType: 'application/json' })
  })
})
