import { expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { IpcMainInvokeEvent } from 'electron'
import type { DocumentDetail } from '../src/shared/contracts'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import type { SyncedRestoreHostInput, SyncedStructureApplied, SyncedStructureInput } from '../src/shared/synced-blocks'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { expectSource, sourceValue } from './helpers/markdown-source'

type HostFinal = Extract<SyncedStructureInput, { mode: 'host-final' }>
type SourceRow = { sessionId: string; input: HostFinal; result: SyncedStructureApplied }
type Handler = (event: IpcMainInvokeEvent, input: SyncedEditingRequest) => unknown | Promise<unknown>
type MainProbe = {
  original: Handler; sources: SourceRow[]; inverses: SyncedRestoreHostInput[]
  firstCommitted: Promise<SourceRow>; releaseFirst: () => Promise<SourceRow>
}
type ProbeGlobal = typeof globalThis & { __knowbookSourceCheckpointProbe?: MainProbe }

// Main's accepted forest and the persisted reader normalize empty tags and
// absent optional values differently. Keep every field value in the comparison.
function comparableDetail(detail: DocumentDetail | null) {
  return detail && { ...detail, blocks: detail.blocks.map(block => ({ ...block, tags: block.tags ?? [],
    language: block.language, highlight: block.highlight, listStart: block.listStart, markdownFormat: block.markdownFormat })) }
}

// Only the actual authenticated Main handler's reply is held. Its original
// session/SQL/event publication all execute first; no ACK or writer is mocked.
async function holdFirstSourceReply(app: ElectronApplication, hostId: string): Promise<void> {
  await app.evaluate(({ ipcMain }, hostId) => {
    const channel = 'knowbook:invoke-synced-editing-session'
    const globals = globalThis as ProbeGlobal
    if (globals.__knowbookSourceCheckpointProbe) throw Error('Source reply probe is already installed')
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)
    if (!original) throw Error('The actual opaque session IPC handler is required')
    let committed!: (row: SourceRow) => void, rejectCommit!: (error: unknown) => void
    let release!: () => void, returned!: (row: SourceRow) => void, rejectReturn!: (error: unknown) => void
    const firstCommitted = new Promise<SourceRow>((resolve, reject) => { committed = resolve; rejectCommit = reject })
    const firstReturned = new Promise<SourceRow>((resolve, reject) => { returned = resolve; rejectReturn = reject })
    const released = new Promise<void>(resolve => { release = resolve })
    // Preserve a rejection for the explicit waiter without an unhandled Main
    // promise if the real operation fails before Playwright attaches that wait.
    firstCommitted.catch(() => {}); firstReturned.catch(() => {})
    const probe: MainProbe = { original, sources: [], inverses: [], firstCommitted,
      releaseFirst: async () => { release(); return await firstReturned } }
    globals.__knowbookSourceCheckpointProbe = probe
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, request: SyncedEditingRequest) => {
      const input = request.method === 'applySyncedHostStructure' && request.input.mode === 'host-final'
        && request.input.reason === 'source-apply' && request.input.hostsWorkingBefore[0]?.documentId === hostId ? request.input : null
      const inverse = request.method === 'restoreSyncedHostOperation' && request.input.expectedHosts.some(item => item.documentId === hostId)
        ? request.input : null
      try {
        const result = await original(event, request)
        if (inverse) probe.inverses.push(structuredClone(inverse))
        if (input) {
          if (!result || typeof result !== 'object' || !('status' in result) || result.status !== 'applied'
            || !('hosts' in result) || !Array.isArray(result.hosts) || result.hosts.length !== 1 || result.hosts[0]?.documentId !== hostId) {
            throw Error('The original Main Source handler did not return an actual applied host receipt')
          }
          const row = { sessionId: request.sessionId, input: structuredClone(input), result: structuredClone(result) as SyncedStructureApplied }
          probe.sources.push(row)
          if (probe.sources.length === 1) {
            committed(structuredClone(row))
            await released
            returned(structuredClone(row))
          }
        }
        return result
      } catch (error) {
        if (input && !probe.sources.length) { rejectCommit(error); rejectReturn(error) }
        throw error
      }
    })
  }, hostId)
}

async function restoreSourceHandler(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ ipcMain }) => {
    const globals = globalThis as ProbeGlobal, probe = globals.__knowbookSourceCheckpointProbe
    if (!probe) return
    // Finish an actual held reply before replacing the handler. This is an
    // awaited fixture handshake, not an unobserved fire-and-forget completion.
    if (probe.sources.length) await probe.releaseFirst()
    ipcMain.removeHandler('knowbook:invoke-synced-editing-session')
    ipcMain.handle('knowbook:invoke-synced-editing-session', probe.original)
    delete globals.__knowbookSourceCheckpointProbe
  })
}

async function historyAction(page: Page, direction: 'undo' | 'redo'): Promise<void> {
  await page.locator('.document-header-more-button').click()
  const button = page.locator('.document-header-action-menu').getByRole('button', {
    name: direction === 'undo' ? uiText('Undo', '撤销') : uiText('Redo', '重做'), exact: true })
  await expect(button).toBeEnabled(); await button.click()
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

test('host Source keeps post-submit CM input through the real Main checkpoint and saves it under a fresh nonce with one history boundary per accepted side @electron', async ({}, info) => {
  // The existing 60s/default retries/workers/background independent-profile
  // helper remains unchanged. No native dialog, sleep or test-only IPC is used.
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, { page, app } = fixture.context(), host = seed.hosts[0]
    await openInlineHost(page, host); await setInlineReading(page, false)
    await holdFirstSourceReply(app, host.id)
    try {
      await page.locator('.document-header-more-button').click()
      await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
      const dialog = page.getByRole('dialog', { name: uiText('Edit host body source', '编辑宿主正文源码'), exact: true })
      const source = dialog.getByRole('textbox', { name: uiText('Host body Markdown source', '宿主正文 Markdown 源码'), exact: true })
      // Pending Apply changes its visible name while the original ACK is held.
      const apply = dialog.locator('button.primary-button')
      await expect(source).toBeVisible()
      const initial = await sourceValue(source), textA = 'UI accepted checkpoint A 中文🙂', suffixC = ' plus retained CM C'
      await source.press('Control+End'); await page.keyboard.insertText('\n\n' + textA)
      const rawA = initial + '\n\n' + textA
      await expectSource(source, rawA)
      await apply.click()
      const first = await app.evaluate(async () => {
        const probe = (globalThis as ProbeGlobal).__knowbookSourceCheckpointProbe
        if (!probe) throw Error('Actual Source reply probe missing')
        return await probe.firstCommitted
      })
      expect(first.result.operationId).toBe(first.input.clientOperationId)
      expect(first.result.hosts[0].after.blocks.at(-1)?.content).toBe(textA)
      const actualA = first.result.hosts[0].after, aBlock = actualA.blocks.at(-1)!
      expect(aBlock.id).not.toBe(seed.primaryId)
      expect(actualA.blocks.filter(block => block.type === 'synced-block').map(block => block.id)).toEqual(seed.instanceIds.slice(0, 2))
      // These are real trusted CM keystrokes while the real original Main
      // result is held, rather than replacing the renderer draft from the test.
      await source.press('Control+End'); await page.keyboard.insertText(suffixC)
      await expectSource(source, rawA + suffixC)
      await expect(apply).toBeDisabled()
      const returned = await app.evaluate(async () => {
        const probe = (globalThis as ProbeGlobal).__knowbookSourceCheckpointProbe
        if (!probe) throw Error('Actual Source reply probe missing')
        return await probe.releaseFirst()
      })
      expect(returned).toEqual(first)
      await expect(apply).toBeEnabled()
      await expectSource(source, rawA + suffixC)
      await expect(dialog).toBeVisible()
      const adoptedA = page.locator('.block-editor-row[data-block-id="' + aBlock.id + '"] textarea')
      await expect(adoptedA).toHaveCount(1); await expect(adoptedA).toHaveValue(textA)
      const afterFirst = await page.evaluate(id => window.knowbook.getDocumentDetail(id), host.id)
      expect(comparableDetail(afterFirst)).toEqual(comparableDetail(actualA))
      expect(await app.evaluate(() => (globalThis as ProbeGlobal).__knowbookSourceCheckpointProbe!.sources.length)).toBe(1)
      // Local Source Undo/Redo changes only CM, with accepted A as its floor.
      await dialog.getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
      await expectSource(source, rawA)
      await expect(dialog.getByRole('button', { name: uiText('Undo', '撤销'), exact: true })).toBeDisabled()
      await dialog.getByRole('button', { name: uiText('Redo', '重做'), exact: true }).click()
      await expectSource(source, rawA + suffixC); await expect(adoptedA).toHaveValue(textA)
      expect(comparableDetail(await page.evaluate(id => window.knowbook.getDocumentDetail(id), host.id))).toEqual(comparableDetail(actualA))
      await apply.click(); await expect(dialog).toHaveCount(0)
      await expect(adoptedA).toHaveValue(textA + suffixC)
      const observed = await app.evaluate(() => {
        const probe = (globalThis as ProbeGlobal).__knowbookSourceCheckpointProbe!
        return { sources: probe.sources, inverses: probe.inverses }
      })
      expect(observed.sources).toHaveLength(2)
      const second = observed.sources[1]
      expect(second.sessionId).toBe(first.sessionId)
      expect(second.input.clientOperationId).not.toBe(first.input.clientOperationId)
      expect(second.input.hostsWorkingBefore[0].expectedPersistedUpdatedAt).toBe(actualA.updatedAt)
      expect(second.input.hostsWorkingBefore[0].workingBefore.blocks.at(-1)?.id).toBe(aBlock.id)
      expect(second.input.hostsWorkingBefore[0].workingBefore.blocks.at(-1)?.content).toBe(textA)
      expect(second.input.newRefSources).toEqual([])
      expect(second.result.hosts[0].after.blocks.at(-1)?.id).toBe(aBlock.id)
      expect(second.result.hosts[0].after.blocks.at(-1)?.content).toBe(textA + suffixC)
      expect(comparableDetail(await page.evaluate(id => window.knowbook.getDocumentDetail(id), host.id))).toEqual(comparableDetail(second.result.hosts[0].after))
      expect(observed.inverses).toHaveLength(0)
      // Only two accepted host sides entered the actual editor/Main timeline.
      await historyAction(page, 'undo'); await expect(adoptedA).toHaveValue(textA)
      await historyAction(page, 'undo'); await expect(adoptedA).toHaveCount(0)
      await page.locator('.document-header-more-button').click()
      await expect(page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Undo', '撤销'), exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await historyAction(page, 'redo'); await expect(adoptedA).toHaveValue(textA)
      await historyAction(page, 'redo'); await expect(adoptedA).toHaveValue(textA + suffixC)
      const inverses = await app.evaluate(() => (globalThis as ProbeGlobal).__knowbookSourceCheckpointProbe!.inverses)
      expect(inverses.map(input => [input.direction, input.historyToken])).toEqual([
        ['undo', second.result.historyToken], ['undo', first.result.historyToken], ['redo', first.result.historyToken], ['redo', second.result.historyToken]
      ])
      const final = await page.evaluate(id => window.knowbook.getDocumentDetail(id), host.id)
      expect(final?.blocks.at(-1)?.id).toBe(aBlock.id); expect(final?.blocks.at(-1)?.content).toBe(textA + suffixC)
      expect(final?.blocks.some(block => block.id === seed.primaryId || block.id === seed.secondaryId)).toBe(false)
      expect(final?.blocks.filter(block => block.type === 'synced-block').map(block => block.id)).toEqual(seed.instanceIds.slice(0, 2))
      await info.attach('actual-source-checkpoint-receipts', { body: Buffer.from(JSON.stringify({ first, second, inverses, final }, null, 2)), contentType: 'application/json' })
    } finally { await restoreSourceHandler(app) }
  })
})
