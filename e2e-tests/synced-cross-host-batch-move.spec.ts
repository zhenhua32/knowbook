import { expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { IpcMainInvokeEvent } from 'electron'
import type { EditorRecoveryOpened, OpenEditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'
import { EDITOR_RECOVERY_CHANNELS } from '../src/shared/editor-recovery-channels'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { inlineInstance, openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import type { CanonicalHostBody } from './helpers/canonical-inline-seed'

type Side = Pick<CanonicalHostBody, 'id' | 'title'>
const moves = (page: Page) => page.locator('.document-block-move-dialog')
const batchButton = (page: Page) => moves(page).getByRole('button', { name: uiText('Move batch', '移动批量'), exact: true })

async function openMove(page: Page, source: CanonicalHostBody, destination: Side) {
  await openInlineHost(page, source)
  await setInlineReading(page, false)
  const row = (id: string) => page.locator('.block-editor-row[data-block-id="' + id + '"]')
  const start = await row(source.blocks[0].id).boundingBox(), end = await row(source.blocks[1].id).boundingBox()
  if (!start || !end) throw new Error('Both selected roots must be visible')
  await page.mouse.move(start.x + 2, start.y + Math.min(10, start.height / 2)); await page.mouse.down()
  await page.mouse.move(end.x + 2, end.y + Math.min(10, end.height / 2), { steps: 4 }); await page.mouse.up()
  await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
  await page.locator('.block-selection-toolbar').getByRole('button', { name: uiText('Move to document…', '移动到文档…'), exact: true }).click()
  await moves(page).locator('.document-capture-field input').fill(destination.title)
  await moves(page).locator('input[value="' + destination.id + '"]').check()
}

async function stageMove(page: Page, source: CanonicalHostBody, destination: Side) {
  await openMove(page, source, destination)
  await moves(page).getByRole('button', { name: uiText('Add to batch', '加入批量'), exact: true }).click()
  await expect(moves(page)).toHaveCount(0)
}

async function destination(page: Page, title = 'Batch destination') {
  const created = await page.evaluate(async title => {
    const { id } = await window.knowbook.createDocument(null)
    const anchor = crypto.randomUUID()
    const { document } = await window.knowbook.updateDocument(id, { title, summary: '', blocks: [{ id: anchor, type: 'paragraph', content: 'Target anchor', checked: false, depth: 0 }] })
    if (!document) throw new Error('The actual destination did not save')
    return { ...document, blocks: document.blocks.map(block => ({ ...block, parentBlockId: block.parentBlockId ?? null })), anchor }
  }, title)
  await page.reload()
  return created
}

async function snapshot(page: Page, ids: string[], groupId: string) {
  return page.evaluate(async ({ ids, groupId }) => {
    const pages = await Promise.all(ids.map(async documentId => {
      const doc = await window.knowbook.getDocumentDetail(documentId)
      const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: documentId })
      if (!doc || opened.status !== 'ready') throw new Error('Actual host state is required')
      const sessionId = opened.session.sessionId
      const history = await window.knowbook.invokeSyncedEditingSession({ sessionId, method: 'getSyncedCrossHostMoveHistory', input: { documentId } })
      return { documentId, blocks: doc.blocks, history, sessionId }
    }))
    const group = (await window.knowbook.invokeSyncedEditingSession({ sessionId: pages[0].sessionId, method: 'getSyncedGroupSnapshots', input: { groupIds: [groupId] } })).items[0]
    if (group?.status !== 'ready') throw new Error('The original group is unavailable')
    return { pages, canonical: group.snapshot.blocks, instances: group.snapshot.instances }
  }, { ids, groupId })
}

async function historyAction(page: Page, action: 'Undo' | 'Redo') {
  await page.locator('.document-header-more-button').click()
  const button = page.locator('.document-header-action-menu').getByRole('button', {
    name: uiText(action, action === 'Undo' ? '撤销' : '重做'), exact: true })
  await expect(button).toBeEnabled()
  await button.click()
}

async function probeBatch(app: ElectronApplication, loseAck: boolean) {
  const calls = await app.evaluateHandle(({ ipcMain }, loseAck) => {
    type Handler = (event: IpcMainInvokeEvent, request: SyncedEditingRequest) => Promise<unknown> | unknown
    const channel = 'knowbook:invoke-synced-editing-session'
    const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)
    if (!handler) throw new Error('The actual Main editing handler is required')
    const calls = { prepares: 0, writes: 0, committed: [] as string[], lookups: 0, inverse: [] as Array<[unknown, unknown]> }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, request: SyncedEditingRequest) => {
      if (request.method === 'prepareSyncedCrossHostMove' && request.input.mode === 'command' && request.input.action.kind === 'move-batch') calls.prepares++
      const command = request.method === 'applySyncedHostStructure' && 'action' in request.input && request.input.action.kind === 'move-batch'
      if (command) calls.writes++
      if (request.method === 'getSyncedOperation' && calls.committed.includes(request.input.clientOperationId)) calls.lookups++
      const result = await handler(event, request)
      if (command && result && typeof result === 'object' && 'status' in result && result.status === 'applied') {
        calls.committed.push(request.input.clientOperationId)
        if (loseAck && calls.committed.length === 1) throw new Error('Test transport discarded the actual committed batch acknowledgement')
      }
      if (request.method === 'restoreSyncedHostOperation' && result && typeof result === 'object' && 'status' in result)
        calls.inverse.push([result.status, 'kind' in result ? result.kind : null])
      return result
    })
    return calls
  }, loseAck)
  return () => calls.jsonValue()
}

// Use the old renderer's real IPC, but dispatch it immediately after Main
// handles navigation start. A same-site reload can reuse the same frame.
async function queueRecoveryOpenAtNavigationStart(app: ElectronApplication, nonce: string) {
  const state = await app.evaluateHandle(({ BrowserWindow, ipcMain }, { channel, nonce }) => {
    type Handler = (event: IpcMainInvokeEvent, input: OpenEditorRecoveryDraftInput) => EditorRecoveryOpened
    const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)
    const contents = BrowserWindow.getAllWindows()[0]?.webContents
    if (!handler || !contents) throw new Error('The actual editor window and recovery handler are required')
    const result = { queued: false, oldDraftSessionId: null as string | null, stillCurrent: false }
    let dispatch: (() => void) | null = null
    const navigation = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean) => {
      if (inPlace || !isMainFrame || !dispatch) return
      contents.removeListener('did-start-navigation', navigation)
      dispatch()
    }
    contents.on('did-start-navigation', navigation)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input: OpenEditorRecoveryDraftInput) => {
      if (input.openRequestId !== nonce) return handler(event, input)
      result.queued = true
      return new Promise<EditorRecoveryOpened>((resolve, reject) => {
        dispatch = () => {
          try {
            result.stillCurrent = event.senderFrame === contents.mainFrame
            const opened = handler(event, input)
            result.oldDraftSessionId = opened.draftSessionId
            resolve(opened)
          } catch (error) { reject(error) }
        }
      })
    })
    return result
  }, { channel: EDITOR_RECOVERY_CHANNELS.open, nonce })
  return () => state.jsonValue()
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

test('moves selected mixed roots from two pages in one operation and undoes and redoes after restart @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const [first, second] = fixture.seed.hosts
    let { page, app } = fixture.context()
    const target = await destination(page), ids = [first.id, second.id, target.id], groupId = fixture.seed.groupId
    const read = () => snapshot(page, ids, groupId)
    const before = await read()
    const probe = await probeBatch(app, true)
    await stageMove(page, first, target)
    expect((await read()).pages.map(side => side.blocks)).toEqual(before.pages.map(side => side.blocks))
    expect(await probe()).toEqual({ prepares: 0, writes: 0, committed: [], lookups: 0, inverse: [] })
    await openMove(page, second, target)
    await expect(moves(page).getByText(/Queued move from|已暂存/)).toBeVisible()
    await batchButton(page).click()
    await expect(moves(page)).toHaveCount(0)
    const moved = await read(), probeResult = await probe()
    expect(probeResult).toEqual({ prepares: 1, writes: 1, committed: [expect.any(String)], lookups: 1, inverse: [] })
    const token = moved.pages[0].history.find(item => item.direction === 'undo')?.historyToken
    expect(token).toBeTruthy()
    expect(moved.pages.map(side => side.history.find(item => item.direction === 'undo')?.historyToken)).toEqual([token, token, token])
    expect(moved.pages[0].blocks.map(block => block.id)).toEqual(first.blocks.slice(2).map(block => block.id))
    expect(moved.pages[1].blocks).toEqual([expect.objectContaining({ type: 'paragraph', content: '' })])
    expect(moved.pages[1].blocks[0].id).not.toBe(second.blocks[0].id)
    expect(moved.pages[2].blocks.map(block => block.id)).toEqual([target.anchor, ...first.blocks.slice(0, 2).map(block => block.id), ...second.blocks.slice(0, 2).map(block => block.id)])
    expect(moved.canonical).toEqual(before.canonical)
    for (const ref of [first.blocks[1], second.blocks[1]]) expect(moved.instances.find(item => item.instanceId === ref.id)?.hostDocumentId).toBe(target.id)

    await fixture.restart(); ({ page } = fixture.context())
    await openInlineHost(page, target); await setInlineReading(page, false)
    await expect(inlineInstance(page, first.blocks[1].id)).toBeVisible()
    const undoProbe = await probeBatch(fixture.context().app, false)
    await historyAction(page, 'Undo')
    await expect.poll(async () => (await undoProbe()).inverse).toEqual([['applied', null]])
    await expect.poll(async () => (await read()).pages.map(side => side.blocks)).toEqual(before.pages.map(side => side.blocks))
    const undone = await read()
    expect(undone.pages.map(side => side.history.find(item => item.direction === 'redo')?.historyToken)).toEqual([token, token, token])
    expect(undone.canonical).toEqual(before.canonical)
    await fixture.restart(); ({ page } = fixture.context())
    await openInlineHost(page, target); await setInlineReading(page, false)
    const redoProbe = await probeBatch(fixture.context().app, false)
    await historyAction(page, 'Redo')
    await expect.poll(async () => (await redoProbe()).inverse).toEqual([['applied', null]])
    await expect.poll(async () => (await read()).pages.map(side => side.blocks)).toEqual(moved.pages.map(side => side.blocks))
    expect((await read()).canonical).toEqual(before.canonical)
  })
})

test('moves one selected pair of mixed roots to each of two destinations in the same batch @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const [first, second] = fixture.seed.hosts, { page, app } = fixture.context()
    const firstTarget = await destination(page, 'Batch destination East')
    const nonce = await page.evaluate(() => crypto.randomUUID())
    const oldOpen = await queueRecoveryOpenAtNavigationStart(app, nonce)
    await page.evaluate(({ documentId, expectedUpdatedAt, openRequestId }) => {
      // The document is about to be replaced, so its reply has no consumer.
      void window.knowbook.openEditorRecoveryDraft({ kind: 'host', documentId, expectedUpdatedAt, openRequestId }).catch(() => undefined)
    }, { documentId: firstTarget.id, expectedUpdatedAt: firstTarget.updatedAt, openRequestId: nonce })
    await expect.poll(async () => (await oldOpen()).queued).toBe(true)
    const secondTarget = await destination(page, 'Batch destination West')
    expect(await oldOpen()).toEqual({ queued: true, oldDraftSessionId: expect.any(String), stillCurrent: true })
    const ids = [first.id, second.id, firstTarget.id, secondTarget.id]
    const before = await snapshot(page, ids, fixture.seed.groupId), probe = await probeBatch(app, false)
    await stageMove(page, first, firstTarget)
    await openMove(page, second, secondTarget)
    await batchButton(page).click()
    await expect(moves(page)).toHaveCount(0)
    expect(await probe()).toEqual({ prepares: 1, writes: 1, committed: [expect.any(String)], lookups: 0, inverse: [] })
    const moved = await snapshot(page, ids, fixture.seed.groupId)
    const token = moved.pages[0].history.find(item => item.direction === 'undo')?.historyToken
    expect(token).toBeTruthy()
    expect(moved.pages.map(side => side.history.find(item => item.direction === 'undo')?.historyToken)).toEqual(ids.map(() => token))
    for (const [index, source] of [first, second].entries()) {
      const target = [firstTarget, secondTarget][index]
      expect(moved.pages[index + 2].blocks.map(block => block.id)).toEqual([target.anchor, ...source.blocks.slice(0, 2).map(block => block.id)])
      expect(moved.instances.find(item => item.instanceId === source.blocks[1].id)?.hostDocumentId).toBe(target.id)
    }
    expect(moved.canonical).toEqual(before.canonical)
  })
})

test('batch rewrites both external inbound pages and one cold Undo from the shared dependency @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const [first, second] = fixture.seed.hosts, groupId = fixture.seed.groupId
    let { page, app } = fixture.context()
    const east = await destination(page, 'Inbound batch East'), west = await destination(page, 'Inbound batch West')
    const links = (one: string, two: string) => [
      `[[${one}#${first.blocks[0].id}|first ordinary block]] then [second ordinary block](<${encodeURIComponent(two)}.md?tab=01#^${second.blocks[0].id}> "old title")`,
      `[second ordinary block again](/${encodeURIComponent(two)}.md#%5E${second.blocks[0].id})`
    ]
    const initialLinks = links(first.title, second.title), finalLinks = links(east.title, west.title)
    const partners = await page.evaluate(async contents => {
      const result = []
      for (const [index, content] of contents.entries()) {
        const { id } = await window.knowbook.createDocument(null), blockId = crypto.randomUUID(), title = `External batch link page ${index}`
        await window.knowbook.updateDocument(id, { title, summary: '', blocks: [{ id: blockId, type: 'paragraph', content, checked: false, depth: 0 }] })
        result.push({ id, title, blockId })
      }
      return result
    }, initialLinks)
    await page.reload()
    const ids = [first.id, second.id, east.id, west.id, ...partners.map(partner => partner.id)]
    const readBlocks = () => page.evaluate(ids => Promise.all(ids.map(async id => (await window.knowbook.getDocumentDetail(id))!.blocks)), ids)
    const expectedLinks = (contents: string[]) => partners.map((partner, index) => [[partner.blockId, contents[index]]])
    const readLinks = async () => (await readBlocks()).slice(4).map(blocks => blocks.map(block => [block.id, block.content]))
    const before = await readBlocks(), probe = await probeBatch(app, false)
    expect(await readLinks()).toEqual(expectedLinks(initialLinks))
    await stageMove(page, first, east)
    await openMove(page, second, west)
    await batchButton(page).click()
    await expect(moves(page)).toHaveCount(0)
    expect(await probe()).toEqual({ prepares: 1, writes: 1, committed: [expect.any(String)], lookups: 0, inverse: [] })
    const moved = await snapshot(page, ids, groupId), token = moved.pages[0].history.find(item => item.direction === 'undo')?.historyToken
    expect(token).toBeTruthy()
    expect(moved.pages.map(side => side.history.find(item => item.direction === 'undo')?.historyToken)).toEqual(ids.map(() => token))
    expect(moved.pages[2].blocks.map(block => block.id)).toEqual([east.anchor, ...first.blocks.slice(0, 2).map(block => block.id)])
    expect(moved.pages[3].blocks.map(block => block.id)).toEqual([west.anchor, ...second.blocks.slice(0, 2).map(block => block.id)])
    expect(await readLinks()).toEqual(expectedLinks(finalLinks))

    await fixture.restart(); ({ page } = fixture.context())
    await page.locator('.tree-button', { hasText: partners[0].title }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(partners[0].title)
    await setInlineReading(page, false)
    await historyAction(page, 'Undo')
    await expect.poll(readBlocks).toEqual(before)
    await historyAction(page, 'Redo')
    await expect.poll(readBlocks).toEqual(moved.pages.map(side => side.blocks))
  })
})

for (const conflict of ['stale destination', 'protected external draft'] as const) {
  test('rejects ' + conflict + ' without committing either staged move @electron', async ({}, info) => {
    await withCanonicalInlineApp(info, async fixture => {
      const [first, second] = fixture.seed.hosts, { page, app } = fixture.context()
      const target = await destination(page), ids = [first.id, second.id, target.id], groupId = fixture.seed.groupId
      const probe = await probeBatch(app, false)
      await stageMove(page, first, target)
      await openMove(page, second, target)
      const protection = await page.evaluate(async ({ conflict, sourceId, targetId }) => {
        const documentId = conflict === 'stale destination' ? targetId : sourceId
        const persisted = await window.knowbook.getDocumentDetail(documentId)
        if (!persisted) throw new Error('An actual host is required to introduce conflict')
        if (conflict === 'stale destination') {
          const result = await window.knowbook.updateDocument(documentId, { expectedUpdatedAt: persisted.updatedAt, title: persisted.title, summary: 'Concurrent committed summary', blocks: persisted.blocks })
          if (!result.document) throw new Error('Failed to commit concurrent target editing')
          return null
        }
        const opened = await window.knowbook.openEditorRecoveryDraft({ kind: 'host', documentId, expectedUpdatedAt: persisted.updatedAt, openRequestId: crypto.randomUUID() })
        const working = structuredClone(opened.base.persistedWorking)
        if (working.kind !== 'host') throw new Error('The actual external host recovery base is required')
        working.blocks[0].content = 'Protected external unsaved edit'
        const saved = await window.knowbook.writeEditorRecoveryDrafts({ purpose: 'background', records: [{ draftSessionId: opened.draftSessionId,
          generation: 1, expectedPreviousGeneration: 0, working, pending: [], sources: [], selection: null, composing: false, importing: false }] })
        return saved
      }, { conflict, sourceId: first.id, targetId: target.id })
      expect(protection !== null).toBe(conflict === 'protected external draft')
      const before = await snapshot(page, ids, groupId)
      await batchButton(page).click()
      await expect(moves(page).getByRole('alert')).toHaveText(/changed|draft|变更|更改|草稿|变化/i)
      expect(await probe()).toEqual({ prepares: conflict === 'protected external draft' ? 1 : 0, writes: 0, committed: [], lookups: 0, inverse: [] })
      const after = await snapshot(page, ids, groupId)
      expect(after.pages.map(side => [side.blocks, side.history])).toEqual(before.pages.map(side => [side.blocks, side.history]))
      expect(after.canonical).toEqual(before.canonical)
      expect(after.instances).toEqual(before.instances)
      if (protection) {
        const [head] = protection.records
        const preserved = await page.evaluate(({ recordId, generation, hash }) =>
          window.knowbook.readEditorRecoveryDraft({ recordId, generation, hash }), head)
        expect(preserved).toMatchObject({ status: 'candidate', writePermit: false, record: { draft: { pending: [],
          working: { kind: 'host', blocks: expect.arrayContaining([expect.objectContaining({ content: 'Protected external unsaved edit' })]) } } } })
      }
    })
  })
}
