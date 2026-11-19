import { expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { IpcMainInvokeEvent } from 'electron'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { appendCanonicalText, expectCanonicalRow, inlineInstance, openInlineHost, saveCanonical, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import type { CanonicalHostBody } from './helpers/canonical-inline-seed'

async function historyAction(page: Page, action: 'Undo' | 'Redo') {
  await page.locator('.document-header-more-button').click()
  const button = page.locator('.document-header-action-menu').getByRole('button', {
    name: uiText(action, action === 'Undo' ? '撤销' : '重做'), exact: true })
  await expect(button).toBeEnabled()
  await button.click()
}

async function withholdFirstRealAcknowledgement(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: IpcMainInvokeEvent, request: SyncedEditingRequest) => Promise<unknown> | unknown
    const channel = 'knowbook:invoke-synced-editing-session'
    const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)
    if (!handler) throw new Error('The actual Main editing handler is required')
    const pending = new Set(['applySyncedHostStructure', 'restoreSyncedHostOperation'])
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, request: SyncedEditingRequest) => {
      const result = await handler(event, request)
      if (result && typeof result === 'object' && 'status' in result && result.status === 'applied'
        && 'hosts' in result && Array.isArray(result.hosts) && result.hosts.length === 2 && pending.delete(request.method)) {
        throw new Error('Test transport discarded the original committed cross-page reply')
      }
      return result
    })
  })
}

type OrdinaryRouteProbe = { held: boolean; release: () => void; saves: number }
async function observeOrdinaryRoute(app: ElectronApplication, sourceId: string) {
  await app.evaluate(({ ipcMain }, sourceId) => {
    type Handler = (event: IpcMainInvokeEvent, ...input: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const read = 'knowbook:read-controlled-document-block-move-dependencies', write = 'knowbook:update-document'
    const originalRead = handlers.get(read), originalWrite = handlers.get(write)
    if (!originalRead || !originalWrite) throw new Error('The original move decision and save IPC are required')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const probe: OrdinaryRouteProbe = { held: false, release, saves: 0 }
    ;(globalThis as typeof globalThis & { ordinaryRouteProbe: OrdinaryRouteProbe }).ordinaryRouteProbe = probe
    ipcMain.removeHandler(read)
    ipcMain.handle(read, async (event, input: { fromDocumentId: string }) => {
      const result = await originalRead(event, input)
      if (!probe.held && input.fromDocumentId === sourceId && result) { probe.held = true; await gate }
      return result
    })
    ipcMain.removeHandler(write)
    ipcMain.handle(write, (event, id: string, input) => {
      if (id === sourceId) probe.saves++
      return originalWrite(event, id, input)
    })
  }, sourceId)
}

async function openMixedMove(page: Page, source: CanonicalHostBody, destination: CanonicalHostBody) {
  const row = (id: string) => page.locator(`.block-editor-row[data-block-id="${id}"]`)
  const first = row(source.blocks[0].id), last = row(source.blocks[1].id)
  await first.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }))
  await expect(first).toBeInViewport()
  await expect(last).toBeInViewport()
  const start = await first.boundingBox(), end = await last.boundingBox()
  if (!start || !end) throw new Error('Both host rows must be visible')
  await page.mouse.move(start.x + 2, start.y + Math.min(10, start.height / 2)); await page.mouse.down()
  await page.mouse.move(end.x + 2, end.y + Math.min(10, end.height / 2), { steps: 4 }); await page.mouse.up()
  await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
  await page.locator('.block-selection-toolbar').getByRole('button', { name: uiText('Move to document…', '移动到文档…'), exact: true }).click()
  const dialog = page.locator('.document-block-move-dialog')
  await dialog.locator('.document-capture-field input').fill(destination.title)
  await dialog.locator(`input[value="${destination.id}"]`).check()
  return dialog
}

async function pauseAutosave(page: Page) {
  return await page.evaluateHandle(() => {
    const original = window.setTimeout.bind(window), delayed = new Set<number>()
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay !== 800) return original(callback, delay, ...args)
      const timer = original(() => {}, 2_147_000_000)
      delayed.add(timer)
      return timer
    }) as typeof window.setTimeout
    return () => {
      window.setTimeout = original
      for (const timer of delayed) window.clearTimeout(timer)
    }
  })
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

test('moves ordinary and shared roots across pages and restores dependent Markdown and Wiki links after restart @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, [source, destination] = seed.hosts, [ordinary, reference, retained] = source.blocks
    let { page } = fixture.context()
    const third = await page.evaluate(async ({ sourceTitle, id }) => {
      const { id: documentId } = await window.knowbook.createDocument(null)
      const title = 'Independent reference page', blockId = crypto.randomUUID()
      await window.knowbook.updateDocument(documentId, { title, summary: '', blocks: [{ id: blockId, type: 'paragraph',
        content: `Keep [[${sourceTitle}#${id}|link label]] and [linked block](${encodeURIComponent(sourceTitle)}.md?q=01#^${id} "original title") intact`, checked: false, depth: 0 }] })
      return { documentId, title, blockId }
    }, { sourceTitle: source.title, id: reference.id })
    await page.reload()
    const snapshot = () => page.evaluate(async ({ ids, groupId }) => {
      const pages = await Promise.all(ids.map(async documentId => {
        const doc = await window.knowbook.getDocumentDetail(documentId)
        const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: documentId })
        if (!doc || opened.status !== 'ready') throw new Error('The actual page session is unavailable')
        const history = await window.knowbook.invokeSyncedEditingSession({ sessionId: opened.session.sessionId,
          method: 'getSyncedCrossHostMoveHistory', input: { documentId } })
        return { ids: doc.blocks.map(block => block.id), history, text: doc.blocks[0]?.content, sessionId: opened.session.sessionId }
      }))
      const group = (await window.knowbook.invokeSyncedEditingSession({ sessionId: pages[0].sessionId,
        method: 'getSyncedGroupSnapshots', input: { groupIds: [groupId] } })).items[0]
      if (group?.status !== 'ready') throw new Error('The original group is unavailable')
      return { pages, canonical: group.snapshot.blocks, instances: group.snapshot.instances }
    }, { ids: [source.id, destination.id, third.documentId], groupId: seed.groupId })
    const currentContent = () => snapshot().then(state => [state.pages[0].ids, state.pages[1].ids, state.pages[2].text])
    const dependentLink = (title: string) => `Keep [[${title}#${reference.id}|link label]] and [linked block](${encodeURIComponent(title)}.md?q=01#^${reference.id} "original title") intact`
    const initial = [source.blocks.map(block => block.id), destination.blocks.map(block => block.id)]
    const final = [[retained.id], [...initial[1], ordinary.id, reference.id]]
    const beforeSides = [...initial, dependentLink(source.title)], afterSides = [...final, dependentLink(destination.title)]
    await openInlineHost(page, source); await setInlineReading(page, false)
    const before = await snapshot()
    await withholdFirstRealAcknowledgement(fixture.context().app)
    const dialog = await openMixedMove(page, source, destination)
    await dialog.getByRole('button', { name: uiText('Move', '移动'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(currentContent).toEqual(afterSides)
    const moved = await snapshot(), token = moved.pages[0].history.find(item => item.direction === 'undo')?.historyToken
    expect(token).toBeTruthy()
    expect(moved.pages.map(doc => doc.history.find(item => item.direction === 'undo')?.historyToken)).toEqual([token, token, token])
    expect(moved.pages[2].ids).toEqual([third.blockId])
    expect(moved.canonical).toEqual(before.canonical)
    expect(moved.instances.find(item => item.instanceId === reference.id)?.hostDocumentId).toBe(destination.id)
    await historyAction(page, 'Undo')
    await expect.poll(currentContent).toEqual(beforeSides)
    await historyAction(page, 'Redo')
    await expect.poll(currentContent).toEqual(afterSides)

    await fixture.restart(); ({ page } = fixture.context())
    await openInlineHost(page, destination); await setInlineReading(page, false)
    await expect(inlineInstance(page, reference.id)).toBeVisible()
    await historyAction(page, 'Undo')
    await expect.poll(currentContent).toEqual(beforeSides)
    const cold = await snapshot()
    expect(cold.pages.map(doc => doc.history.find(item => item.direction === 'redo')?.historyToken)).toEqual([token, token, token])
    expect(cold.canonical).toEqual(before.canonical)
    await historyAction(page, 'Redo')
    await expect.poll(currentContent).toEqual(afterSides)

    await page.locator('.tree-button', { hasText: third.title }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(third.title)
    await historyAction(page, 'Undo')
    await expect.poll(currentContent).toEqual(beforeSides)
    await historyAction(page, 'Redo')
    await expect.poll(currentContent).toEqual(afterSides)
  })
})

test('declines a mixed cross-page move while two groups have unsaved shared text @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, [source, destination] = seed.hosts, { page } = fixture.context()
    const independent = await page.evaluate(async ({ sourceId, originalGroupId }) => {
      const doc = await window.knowbook.getDocumentDetail(sourceId)
      const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: sourceId })
      if (!doc || opened.status !== 'ready') throw new Error('The original host session is required')
      const { sessionId } = opened.session
      const original = (await window.knowbook.invokeSyncedEditingSession({ sessionId,
        method: 'getSyncedGroupSnapshots', input: { groupIds: [originalGroupId] } })).items[0]
      if (original?.status !== 'ready') throw new Error('The original shared group is required')
      const groupId = crypto.randomUUID(), instanceId = crypto.randomUUID(), blockId = crypto.randomUUID()
      const text = 'Independent shared body on the source page'
      const blocks = doc.blocks.map(({ sortOrder: _order, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null }))
      const result = await window.knowbook.invokeSyncedEditingSession({ sessionId, method: 'applySyncedHostStructure', input: {
        mode: 'command', clientOperationId: crypto.randomUUID(),
        action: { kind: 'create', documentId: sourceId, selectedRootIds: [blockId], groupId, instanceId },
        hostsWorkingBefore: [{ documentId: sourceId, expectedPersistedUpdatedAt: doc.updatedAt,
          workingBefore: { title: doc.title, summary: doc.summary, blocks: [...blocks,
            { id: blockId, type: 'paragraph', content: text, checked: false, depth: 0, parentBlockId: null }] } }],
        groups: [{ groupId: originalGroupId, expectedRevision: original.snapshot.revision, expectedTopologyRevision: original.snapshot.topologyRevision }],
        expectedInstances: original.snapshot.instances.filter(row => row.hostDocumentId === sourceId)
          .map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion }))
      } })
      if (result.status !== 'applied') throw new Error('The fixture must establish a second registered group')
      return { groupId, instanceId, blockId, text }
    }, { sourceId: source.id, originalGroupId: seed.groupId })
    await page.reload()
    const instanceId = seed.instanceIds[0], suffix = ' still private', edited = seed.primaryText + suffix
    const otherSuffix = ' another private draft', otherEdited = independent.text + otherSuffix
    const readActual = () => page.evaluate(async ({ sourceId, destinationId, bindings }) => {
      const pages = await Promise.all([sourceId, destinationId].map(id => window.knowbook.getDocumentDetail(id)))
      const canonical = await Promise.all(bindings.map(async binding => {
        const state = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: sourceId, ...binding })
        if (state.status !== 'ready') throw new Error('An original instance is missing')
        return state.snapshot
      }))
      return { pages, canonical }
    }, { sourceId: source.id, destinationId: destination.id, bindings: [
      { groupId: seed.groupId, instanceId }, { groupId: independent.groupId, instanceId: independent.instanceId }
    ] })
    await openInlineHost(page, source); await setInlineReading(page, false)
    const original = await readActual()
    // Hold the periodic Save so both edits stay live until the move decision.
    const paused = await pauseAutosave(page)
    try {
      await appendCanonicalText(page, instanceId, seed.primaryId, seed.primaryText, suffix)
      await appendCanonicalText(page, independent.instanceId, independent.blockId, independent.text, otherSuffix)
      expect(await readActual()).toEqual(original)
      const dialog = await openMixedMove(page, source, destination)
      await dialog.getByRole('button', { name: uiText('Move', '移动'), exact: true }).click()
      await expect(dialog.getByRole('alert')).toBeVisible()
      await expect(page.getByText(/参与此操作的共享正文还有未保存|A shared body involved in this operation has unsaved/)).toBeVisible()
      expect(await readActual()).toEqual(original)
      await dialog.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
      await expectCanonicalRow(inlineInstance(page, instanceId), seed.primaryId, edited)
      await expectCanonicalRow(inlineInstance(page, independent.instanceId), independent.blockId, otherEdited)
    } finally { await paused.evaluate(resume => resume()); await paused.dispose() }
    await saveCanonical(page, seed, instanceId, edited)
    await saveCanonical(page, { ...seed, groupId: independent.groupId, primaryId: independent.blockId }, independent.instanceId, otherEdited)
  })
})

for (const ordinaryRoute of [false, true]) test(`rewrites a dependent page containing a separate shared reference${ordinaryRoute ? ' from two ordinary pages' : ''} and undoes from it after restart @electron`, async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    let { page } = fixture.context()
    const [source, destination] = !ordinaryRoute ? fixture.seed.hosts : await page.evaluate(async () => {
      const pages = []
      for (const [title, count] of [['Ordinary source host', 3], ['Ordinary destination host', 1]] as const) {
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title, summary: '', blocks: Array.from({ length: count }, (_, index) => ({
          id: crypto.randomUUID(), type: 'paragraph', content: `Ordinary body ${index}`, checked: false, depth: 0 })) })
        const doc = await window.knowbook.getDocumentDetail(id)
        if (!doc) throw new Error('The ordinary page was not committed')
        pages.push(doc)
      }
      return pages
    })
    const [ordinary, movedRef, retained] = source.blocks
    const link = (title: string) => `[stable block](${encodeURIComponent(title)}.md#^${movedRef.id})`
    const partner = await page.evaluate(async ({ content, authoredLink }) => {
      const { id } = await window.knowbook.createDocument(null)
      const title = 'Dependent page with a separate shared body', linkId = crypto.randomUUID(), privateChild = crypto.randomUUID()
      await window.knowbook.updateDocument(id, { title, summary: '', blocks: [
        { id: linkId, type: 'paragraph', content, checked: false, depth: 0 },
        { id: privateChild, type: 'paragraph', content: authoredLink, checked: false, depth: 0 }
      ] })
      const doc = await window.knowbook.getDocumentDetail(id), opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: id })
      if (!doc || opened.status !== 'ready') throw new Error('No real host authorizes this fixture')
      const groupId = crypto.randomUUID(), instanceId = crypto.randomUUID()
      const result = await window.knowbook.invokeSyncedEditingSession({ sessionId: opened.session.sessionId,
        method: 'applySyncedHostStructure', input: { mode: 'command', clientOperationId: crypto.randomUUID(), groups: [], expectedInstances: [],
          hostsWorkingBefore: [{ documentId: id, expectedPersistedUpdatedAt: doc.updatedAt, workingBefore: { title, summary: doc.summary,
            blocks: doc.blocks.map(({ sortOrder: _sort, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })) } }],
          action: { kind: 'create', documentId: id, selectedRootIds: [privateChild], groupId, instanceId } } })
      if (result.status !== 'applied') throw new Error('The fixture must create a genuinely registered reference')
      return { id, title, linkId, groupId, instanceId }
    }, { content: link(source.title), authoredLink: `[Open the stored block link](${encodeURIComponent(source.title)}.md#^${ordinary.id})` })
    await page.reload()
    const contents = () => page.evaluate(async ({ ids, partner, rootId }) => {
      const pages = await Promise.all(ids.map(id => window.knowbook.getDocumentDetail(id)))
      if (pages.some(doc => !doc)) throw new Error('An actual participant was lost')
      const position = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: partner.id,
        groupId: partner.groupId, instanceId: partner.instanceId })
      if (position.status !== 'ready') throw new Error('The dependent reference lost its real binding')
      return { roots: pages.map(doc => doc!.blocks.map(block => block.id)), link: pages[2]!.blocks[0].content, reference: pages[2]!.blocks[1],
        binding: position.instance, canonical: position.snapshot,
        movedText: pages.slice(0, 2).flatMap(doc => doc!.blocks).find(block => block.id === rootId)?.content }
    }, { ids: [source.id, destination.id, partner.id], partner, rootId: ordinary.id })
    const before = await contents(), movedText = ordinaryRoute ? ordinary.content + ' from unsaved W' : ordinary.content
    const undo = { ...before, movedText }, after = { ...undo,
      roots: [[retained.id], [...before.roots[1], ordinary.id, movedRef.id], [partner.linkId, partner.instanceId]], link: link(destination.title) }
    if (ordinaryRoute) {
      const probe = await page.evaluate(async ({ source, destination, partner, blockIds }) => {
        const [from, to, peer] = await Promise.all([source.id, destination.id, partner].map(id => window.knowbook.getDocumentDetail(id)))
        if (!from || !to || !peer) throw new Error('The three pages must already exist')
        const result = await window.knowbook.moveDocumentBlocks({ fromDocumentId: source.id, toDocumentId: destination.id, blockIds,
          expectedFromUpdatedAt: from.updatedAt, expectedToUpdatedAt: to.updatedAt })
        return { result, version: peer.updatedAt }
      }, { source, destination, partner: partner.id, blockIds: [ordinary.id, movedRef.id] })
      expect(probe.result).toEqual({ state: 'controlled-required', dependencies: [{ documentId: partner.id, updatedAt: probe.version }] })
      expect(await contents()).toEqual(before)
    }
    await openInlineHost(page, source); await setInlineReading(page, false)
    const app = fixture.context().app, autosave = ordinaryRoute ? await pauseAutosave(page) : null
    try {
      const textarea = page.locator(`.block-editor-row[data-block-id="${ordinary.id}"] textarea.block-inline-textarea`)
      if (ordinaryRoute) {
        await observeOrdinaryRoute(app, source.id)
        await textarea.fill(movedText)
        expect(await contents()).toEqual(before)
      }
      const dialog = await openMixedMove(page, source, destination)
      const submit = dialog.getByRole('button', { name: uiText('Move', '移动'), exact: true })
      await submit.click()
      if (ordinaryRoute) {
        await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { ordinaryRouteProbe: OrdinaryRouteProbe }).ordinaryRouteProbe.held)).toBe(true)
        const changed = await page.evaluate(async partner => {
          const doc = await window.knowbook.getDocumentDetail(partner.id)
          const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: partner.id })
          const ref = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: partner.id, instanceId: partner.instanceId, groupId: partner.groupId })
          if (!doc || opened.status !== 'ready' || ref.status !== 'ready') throw new Error('The actual dependent session is required')
          const { revision, topologyRevision } = ref.snapshot, { bindingVersion } = ref.instance
          const blocks = doc.blocks.map(({ sortOrder: _order, ...block }) => block)
          return window.knowbook.invokeSyncedEditingSession({ sessionId: opened.session.sessionId, method: 'applySyncedHostStructure', input: {
            mode: 'host-final', reason: 'selection-edit', clientOperationId: crypto.randomUUID(),
            hostsWorkingBefore: [{ documentId: partner.id, expectedPersistedUpdatedAt: doc.updatedAt,
              workingBefore: { title: doc.title, summary: doc.summary, blocks } }],
            finalAfter: [{ documentId: partner.id, title: doc.title, summary: 'Changed during the original decision', blocks }], newRefSources: [],
            groups: [{ groupId: partner.groupId, expectedRevision: revision, expectedTopologyRevision: topologyRevision }],
            expectedInstances: [{ instanceId: partner.instanceId, hostDocumentId: partner.id, bindingVersion }] } })
        }, partner)
        expect(changed.status).toBe('applied')
        await app.evaluate(() => (globalThis as typeof globalThis & { ordinaryRouteProbe: OrdinaryRouteProbe }).ordinaryRouteProbe.release())
        await expect(dialog.getByRole('alert')).toBeVisible()
        await expect(textarea).toHaveValue(movedText)
        expect(await contents()).toEqual(before)
        await submit.click()
      }
      await expect(dialog).toHaveCount(0)
      await expect.poll(contents).toEqual(after)
      if (ordinaryRoute) expect(await app.evaluate(() => (globalThis as typeof globalThis & { ordinaryRouteProbe: OrdinaryRouteProbe }).ordinaryRouteProbe.saves)).toBe(0)
    } finally {
      if (ordinaryRoute) await app.evaluate(() => (globalThis as typeof globalThis & { ordinaryRouteProbe?: OrdinaryRouteProbe }).ordinaryRouteProbe?.release())
      if (autosave) { await autosave.evaluate(resume => resume()); await autosave.dispose() }
    }

    await fixture.restart(); ({ page } = fixture.context())
    const openPartner = async () => {
      await page.locator('.tree-button', { hasText: partner.title }).first().click()
      await expect(page.locator('.document-header-title')).toHaveText(partner.title)
    }
    const followStoredLink = async (target: CanonicalHostBody) => {
      await setInlineReading(page, true)
      await inlineInstance(page, partner.instanceId).getByRole('button', { name: 'Open the stored block link', exact: true }).click()
      await expect(page.locator('.document-header-title')).toHaveText(target.title)
      await expect(page.locator(`[data-block-id="${ordinary.id}"]`).first()).toBeVisible()
    }
    await openPartner()
    await followStoredLink(destination)
    await openPartner()
    await setInlineReading(page, false)
    await expect(inlineInstance(page, partner.instanceId)).toBeVisible()
    await historyAction(page, 'Undo')
    await expect.poll(contents).toEqual(undo)
    await followStoredLink(source)
    await openPartner()
    await setInlineReading(page, false)
    await historyAction(page, 'Redo')
    await expect.poll(contents).toEqual(after)
    await followStoredLink(destination)
  })
})
