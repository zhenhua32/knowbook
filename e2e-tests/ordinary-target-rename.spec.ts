// Candidate integration target: e2e-tests/ordinary-target-rename.spec.ts.
// Imports intentionally resolve from that final location. Reuse the genuine
// existing seed/helper; no test-only business IPC, exposure or ACK is added.
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { ElectronApplication } from 'playwright'
import type { IpcMainInvokeEvent } from 'electron'
import type { UpdateDocumentInput } from '../src/shared/contracts'
import type { DocumentRenameAdmissionInput, DocumentRenameAdmissionResult } from '../src/shared/document-rename-admission'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import type { SyncedStructureApplied, SyncedStructureInput } from '../src/shared/synced-blocks'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { inlineInstance, setInlineReading } from './helpers/canonical-inline'
import { withSyncedTitleRenameApp } from './helpers/synced-title-rename'
import type { TitleRenameAudit, TitleRenameSeed } from './helpers/synced-title-rename-seed'

type HostFinal = Extract<SyncedStructureInput, { mode: 'host-final' }>
type Handler = (event: IpcMainInvokeEvent, input: SyncedEditingRequest) => unknown | Promise<unknown>
type OrdinaryHandler = (event: IpcMainInvokeEvent, id: string, input: UpdateDocumentInput) => unknown | Promise<unknown>
type AdmissionHandler = (event: IpcMainInvokeEvent, input: DocumentRenameAdmissionInput) => DocumentRenameAdmissionResult | Promise<DocumentRenameAdmissionResult>
type Row = { order: number; sessionId: string; input: HostFinal; result?: SyncedStructureApplied; refusal?: unknown; error?: string; settled: boolean }
type Hint = { order: number; input: DocumentRenameAdmissionInput; result?: DocumentRenameAdmissionResult; error?: string; settled: boolean }
type Observation = { hints: Hint[]; rows: Row[]; ordinaryTargetWrites: unknown[] }
type Probe = Observation & { original: Handler; ordinary: OrdinaryHandler; admission: AdmissionHandler; releaseFirst: () => void }
type ProbeGlobal = typeof globalThis & { __ordinaryTargetRenameProbe?: Probe }
const auditPaths = new WeakMap<ElectronApplication, string>()
const renameDialog = (page: Page) => page.locator('.document-rename-dialog')
const nameField = (page: Page) => renameDialog(page).getByRole('textbox', { name: uiText('Document name', '文档名称'), exact: true })

async function openDocument(page: Page, title: string): Promise<void> {
  await page.getByRole('treeitem', { name: title, exact: true }).locator('.tree-button').click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
async function openTarget(page: Page, seed: TitleRenameSeed): Promise<void> {
  const parent = page.getByRole('treeitem', { name: seed.hostTitle, exact: true })
  await expect(parent).toBeVisible()
  if (await parent.getAttribute('aria-expanded') === 'false') await parent.locator('.tree-expand-toggle').click()
  await openDocument(page, seed.childTitle)
  await setInlineReading(page, true)
}
async function renameTarget(page: Page, title: string): Promise<void> {
  await page.locator('.document-header-title-button').click()
  await expect(renameDialog(page)).toBeVisible()
  await nameField(page).fill(title)
  await renameDialog(page).getByRole('button', { name: uiText('Rename', '重命名'), exact: true }).click()
}

// All three production handlers are delegated unchanged. Only the first real
// successful target title reply is held, after Main commit/event publication.
// Main state is atomically published to a test-owned file, never Inspector-polled.
async function installProbe(app: ElectronApplication, targetId: string, hold: boolean, auditPath: string): Promise<void> {
  await app.evaluate(({ ipcMain }, { targetId, hold, auditPath }) => {
    const globals = globalThis as ProbeGlobal
    if (globals.__ordinaryTargetRenameProbe) throw Error('The actual target probe is already installed')
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler | OrdinaryHandler | AdmissionHandler> })._invokeHandlers
    const original = handlers.get('knowbook:invoke-synced-editing-session') as Handler | undefined
    const ordinary = handlers.get('knowbook:update-document') as OrdinaryHandler | undefined
    const admission = handlers.get('knowbook:get-document-rename-admission') as AdmissionHandler | undefined
    if (!original || !ordinary || !admission) throw Error('All actual target rename handlers must exist')
    let release!: () => void, order = 0
    const released = new Promise<void>(resolve => { release = resolve })
    const probe: Probe = { original, ordinary, admission, rows: [], hints: [], ordinaryTargetWrites: [], releaseFirst: () => release() }
    const fs = process.getBuiltinModule('node:fs')
    const publish = () => {
      fs.writeFileSync(auditPath + '.pending', JSON.stringify({ hints: probe.hints, rows: probe.rows, ordinaryTargetWrites: probe.ordinaryTargetWrites }), { flag: 'wx' })
      fs.renameSync(auditPath + '.pending', auditPath)
    }
    publish()
    globals.__ordinaryTargetRenameProbe = probe
    ipcMain.removeHandler('knowbook:get-document-rename-admission')
    ipcMain.handle('knowbook:get-document-rename-admission', async (event, input: DocumentRenameAdmissionInput) => {
      const hint: Hint | null = input.documentId === targetId ? { order: ++order, input: structuredClone(input), settled: false } : null
      if (hint) { probe.hints.push(hint); publish() }
      try {
        const result = await admission(event, input)
        if (hint) hint.result = structuredClone(result)
        return result
      } catch (error) {
        if (hint) hint.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        if (hint) { hint.settled = true; publish() }
      }
    })
    ipcMain.removeHandler('knowbook:invoke-synced-editing-session')
    ipcMain.handle('knowbook:invoke-synced-editing-session', async (event, request: SyncedEditingRequest) => {
      const input = request.method === 'applySyncedHostStructure' && request.input.mode === 'host-final'
        && request.input.reason === 'selection-edit' && request.input.hostsWorkingBefore[0]?.documentId === targetId ? request.input : null
      const row: Row | null = input ? { order: ++order, sessionId: request.sessionId, input: structuredClone(input), settled: false } : null
      if (row) { probe.rows.push(row); publish() }
      try {
        const result = await original(event, request)
        if (row) {
          if (!result || typeof result !== 'object' || !('status' in result) || result.status !== 'applied'
            || !('hosts' in result) || !Array.isArray(result.hosts) || result.hosts.length !== 1 || result.hosts[0]?.documentId !== targetId) {
            row.refusal = structuredClone(result)
            return result
          }
          row.result = structuredClone(result) as SyncedStructureApplied
          publish()
          if (hold && probe.rows[0] === row) await released
        }
        return result
      } catch (error) {
        if (row) row.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        if (row) { row.settled = true; publish() }
      }
    })
    ipcMain.removeHandler('knowbook:update-document')
    ipcMain.handle('knowbook:update-document', async (event, id: string, input: UpdateDocumentInput) => {
      if (id === targetId) { probe.ordinaryTargetWrites.push(structuredClone(input)); publish() }
      return ordinary(event, id, input)
    })
  }, { targetId, hold, auditPath })
  auditPaths.set(app, auditPath)
}
function observation(app: ElectronApplication): Observation {
  const path = auditPaths.get(app)
  if (!path) throw Error('The real target observation file is missing')
  return JSON.parse(readFileSync(path, 'utf8')) as Observation
}
async function restoreProbe(app: ElectronApplication): Promise<void> {
  try {
    await app.evaluate(({ ipcMain }) => {
      const globals = globalThis as ProbeGlobal, value = globals.__ordinaryTargetRenameProbe
      if (!value) return
      value.releaseFirst()
      ipcMain.removeHandler('knowbook:invoke-synced-editing-session'); ipcMain.handle('knowbook:invoke-synced-editing-session', value.original)
      ipcMain.removeHandler('knowbook:update-document'); ipcMain.handle('knowbook:update-document', value.ordinary)
      ipcMain.removeHandler('knowbook:get-document-rename-admission'); ipcMain.handle('knowbook:get-document-rename-admission', value.admission)
      delete globals.__ordinaryTargetRenameProbe
    })
  } finally { auditPaths.delete(app) }
}

async function actual(page: Page, seed: TitleRenameSeed) {
  return page.evaluate(async ({ hostId, childId, observerId, hostInstanceId, groupId }) => {
    const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: childId })
    if (opened.status !== 'ready') throw Error('The real no-reference target session must be ready')
    // Main owns one session per real frame. Do not release the editor's shared
    // owner merely because this read-only observation has finished.
    // An ordinary no-reference child need not have initialized host history.
    // Observing it must not initialize SQL state or invent an empty history.
    const [host, target, observer, instance] = await Promise.all([
      window.knowbook.getDocumentDetail(hostId), window.knowbook.getDocumentDetail(childId), window.knowbook.getDocumentDetail(observerId),
      window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: hostId, instanceId: hostInstanceId, groupId })
    ])
    if (!host || !target || !observer || instance.status !== 'ready') throw Error('The genuine ordinary target fixture is incomplete')
    return { host, target, observer, instance }
  }, seed)
}
type Actual = Awaited<ReturnType<typeof actual>>
const blockUrl = (path: string, blockId: string) => path.split('/').map(encodeURIComponent).join('/') + '.md#^' + blockId

function expectTargetPreconditions(before: Actual, seed: TitleRenameSeed): void {
  expect(before.target.id).toBe(seed.childId)
  expect(before.target.blocks.some(block => block.type === 'synced-block')).toBe(false)
  expect(before.target.blocks).toHaveLength(1)
  expect(before.target.blocks[0].id).toBe(seed.targetBlockId)
  const block = before.instance.snapshot.bindings.find(item => item.blockId === seed.blockLinkId)!
  expect(block.target).toEqual({ kind: 'block', id: seed.targetBlockId, documentId: seed.childId, state: 'live' })
  expect(block.raw).toBe(blockUrl(before.target.path, seed.targetBlockId))
  expect(before.instance.snapshot.bindings.find(item => item.blockId === seed.documentLinkId)!.target)
    .toEqual({ kind: 'document', id: seed.hostId, state: 'live' })
}
function expectHintAndWorking(observed: Observation, before: Actual, seed: TitleRenameSeed, title: string): Row {
  expect(observed.hints).toHaveLength(1)
  expect(observed.rows).toHaveLength(1)
  expect(observed.ordinaryTargetWrites).toEqual([])
  const hint = observed.hints[0], row = observed.rows[0]
  expect(hint.error).toBeUndefined(); expect(hint.settled).toBe(true)
  expect(hint.input).toEqual({ documentId: seed.childId, expectedUpdatedAt: before.target.updatedAt })
  expect(hint.result).toEqual({ status: 'ready', documentId: seed.childId,
    documentCreatedAt: seed.original.documents.find(item => item.id === seed.childId)!.created_at,
    updatedAt: before.target.updatedAt, requiresFencedTitle2: true, writePermit: false })
  expect(hint.order).toBeLessThan(row.order)
  expect(row.sessionId).not.toBe('')
  expect(row.input.hostsWorkingBefore).toHaveLength(1)
  expect(row.input.finalAfter).toHaveLength(1)
  expect(row.input.groups).toEqual([]); expect(row.input.expectedInstances).toEqual([]); expect(row.input.newRefSources).toEqual([])
  const working = row.input.hostsWorkingBefore[0]
  expect(working.documentId).toBe(seed.childId)
  expect(working.expectedPersistedUpdatedAt).toBe(before.target.updatedAt)
  expect(working.workingBefore.title).toBe(title)
  expect(working.workingBefore.summary).toBe(before.target.summary)
  expect(working.workingBefore.blocks).toEqual(before.target.blocks.map(({ sortOrder: _sortOrder, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })))
  expect(row.input.finalAfter[0]).toEqual({ documentId: seed.childId, ...working.workingBefore })
  expect(row.input.reason).toBe('selection-edit')
  return row
}
function expectColdBirthAndOriginals(audit: TitleRenameAudit, seed: TitleRenameSeed, renamed: string): void {
  expect(audit.identities).toEqual(seed.original.identities)
  expect(audit.originalOperations).toEqual(seed.original.originalOperations)
  expect(audit.hostHistory).toEqual(seed.original.hostHistory)
  expect(audit.hostMappings).toEqual(seed.original.hostMappings)
  for (const before of seed.original.documents) {
    const after = audit.documents.find(item => item.id === before.id)!
    expect(after.created_at).toBe(before.created_at); expect(after.parent_id).toBe(before.parent_id)
    expect(after.summary).toBe(before.summary)
    expect(after.title).toBe(before.id === seed.childId ? renamed : before.title)
    expect(after.path).toBe(before.id === seed.childId ? seed.hostTitle + '/' + renamed : before.path)
  }
  expect(audit.blocks.map(item => [item.id, item.document_id, item.parent_block_id, item.created_at]))
    .toEqual(seed.original.blocks.map(item => [item.id, item.document_id, item.parent_block_id, item.created_at]))
  expect(audit.blocks.find(item => item.id === seed.targetBlockId)).toEqual(seed.original.blocks.find(item => item.id === seed.targetBlockId))
  expect(audit.group.origin).toEqual(seed.original.group.origin)
  expect(audit.group.blocks.map(item => [item.id, item.createdAt])).toEqual(seed.original.group.blocks.map(item => [item.id, item.createdAt]))
  expect(audit.group.instances).toEqual(seed.original.group.instances)
  expect(audit.group.topologyRevision).toBe(seed.original.group.topologyRevision)
  expect(audit.group.history).toEqual(seed.original.group.history)
  expect(audit.group.revision).not.toBe(seed.original.group.revision)
  expect(audit.titleOperations).toHaveLength(1); expect(audit.titleFacts).toHaveLength(1)
  const original = audit.titleOperations[0]
  expect(original.envelope.result.historyToken).toBeNull()
  expect(original.companion.rawLogicalChange).toBe(false)
  expect(original.companion.businessOperationCommitted).toBe(true); expect(original.companion.writePermit).toBe(false)
  const capture = original.captures.find(item => item.groupId === seed.groupId)!
  expect(capture.targets.find(item => item.key.blockId === seed.blockLinkId)).toMatchObject({ status: 'current-block', blockId: seed.targetBlockId,
    createdAt: seed.original.blocks.find(item => item.id === seed.targetBlockId)!.created_at })
}
async function followOriginalBlock(page: Page, seed: TitleRenameSeed, renamed: string): Promise<void> {
  await openDocument(page, seed.observerTitle); await setInlineReading(page, true)
  await inlineInstance(page, seed.observerInstanceId).getByRole('button', { name: 'Original block', exact: true }).click()
  await expect(page.locator('.document-header-title')).toHaveText(renamed)
  await expect(page.locator('[data-block-id="' + seed.targetBlockId + '"]')).toBeVisible()
}

// Original project 60s/retries/workers and the default hidden Electron helper
// remain unchanged. This is an ordinary no-reference target, not Source UI.
test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this ordinary target slice')

test('an ordinary no-reference target header rename uses the real readonly hint and fenced host final with empty caller guards, preserving canonical block targets through held ACK, old-path occupants and a stopped-profile restart @electron', async ({}, info) => {
  await withSyncedTitleRenameApp(info, 'published', async fixture => {
    const { seed } = fixture, renamed = 'Ordinary renamed target 中文🙂'
    let { page, app } = fixture.context()
    await openTarget(page, seed)
    const before = await actual(page, seed)
    expectTargetPreconditions(before, seed)
    expect(before.instance.snapshot.history.undoToken).toBeNull()
    await installProbe(app, seed.childId, true, info.outputPath('ordinary-target-main-observation.json'))
    try {
      await renameTarget(page, renamed)
      await expect.poll(() => observation(app).rows.filter(row => row.result).length).toBe(1)
      const row = expectHintAndWorking(observation(app), before, seed, renamed)
      expect(row.refusal).toBeUndefined(); expect(row.error).toBeUndefined(); expect(row.settled).toBe(false)
      expect(row.result?.status).toBe('applied'); expect(row.result?.historyToken).toBeNull()
      await expect(renameDialog(page)).toBeVisible(); await expect(nameField(page)).toHaveValue(renamed)
      const committed = await actual(page, seed), newPath = seed.hostTitle + '/' + renamed
      expect(committed.target.title).toBe(renamed); expect(committed.target.path).toBe(newPath)
      expect(committed.target.summary).toBe(before.target.summary); expect(committed.target.blocks).toEqual(before.target.blocks)
      expect(committed.host.title).toBe(before.host.title); expect(committed.host.path).toBe(before.host.path)
      const { revision: previousRevision, ...previousInstance } = before.instance.instance
      const { revision: committedRevision, ...committedInstance } = committed.instance.instance
      expect(committedInstance).toEqual(previousInstance)
      expect(committedRevision).not.toBe(previousRevision)
      expect(committedRevision).toBe(committed.instance.snapshot.revision)
      expect(committed.instance.snapshot.origin).toEqual(before.instance.snapshot.origin)
      expect(committed.instance.snapshot.bindings.map(item => item.target)).toEqual(before.instance.snapshot.bindings.map(item => item.target))
      for (const binding of committed.instance.snapshot.bindings) {
        expect(committed.instance.snapshot.blocks.find(item => item.id === binding.blockId)!.content.slice(binding.from, binding.to)).toBe(binding.raw)
      }
      expect(committed.instance.snapshot.bindings.find(item => item.blockId === seed.blockLinkId)!.raw).toBe(blockUrl(newPath, seed.targetBlockId))
      expect(committed.instance.snapshot.blocks.find(item => item.id === seed.documentLinkId))
        .toEqual(before.instance.snapshot.blocks.find(item => item.id === seed.documentLinkId))
      expect(committed.host.blocks.find(item => item.id === seed.hostOrdinaryLinkId)!.content)
        .toBe('[Ordinary child](' + newPath.split('/').map(encodeURIComponent).join('/') + '.md)')
      expect(committed.observer.blocks.find(item => item.id === seed.observerOrdinaryLinkId))
        .toEqual(before.observer.blocks.find(item => item.id === seed.observerOrdinaryLinkId))
      await app.evaluate(() => (globalThis as ProbeGlobal).__ordinaryTargetRenameProbe!.releaseFirst())
      await expect.poll(() => observation(app).rows[0]?.settled).toBe(true)
      await expect(renameDialog(page)).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText(renamed)
      expect(observation(app).ordinaryTargetWrites).toEqual([])
    } finally { await restoreProbe(app) }

    const occupants = await page.evaluate(async ({ hostId, childTitle, missingTitle }) => {
      const values: string[] = []
      for (const [parentId, title] of [[hostId, childTitle], [null, missingTitle]] as const) {
        const value = await window.knowbook.createDocument(parentId)
        await window.knowbook.updateDocument(value.id, { title, summary: 'Later path occupant', blocks: [
          { id: crypto.randomUUID(), type: 'paragraph', content: 'A later occupant cannot borrow the original block target', checked: false, depth: 0, parentBlockId: null }
        ] })
        values.push(value.id)
      }
      return values
    }, seed)
    expect(occupants).not.toContain(seed.childId)
    const withOccupants = await actual(page, seed)
    expect(withOccupants.instance.snapshot.bindings.map(item => item.target)).toEqual(before.instance.snapshot.bindings.map(item => item.target))
    await openDocument(page, seed.observerTitle); await setInlineReading(page, true)
    await inlineInstance(page, seed.observerInstanceId).getByRole('button', { name: 'Unavailable original', exact: true }).click()
    await expect(inlineInstance(page, seed.observerInstanceId).getByRole('alert')).toHaveText(uiText('The original link target is unavailable.', '原链接目标不可用。'))
    await expect(page.locator('.document-header-title')).toHaveText(seed.observerTitle)
    await followOriginalBlock(page, seed, renamed)

    const stopped = await fixture.restart()
    expectColdBirthAndOriginals(stopped, seed, renamed)
    ;({ page, app } = fixture.context())
    await followOriginalBlock(page, seed, renamed)
    const cold = await actual(page, seed)
    expect(cold.target.id).toBe(seed.childId); expect(cold.target.blocks).toEqual(before.target.blocks)
    expect(cold.instance.snapshot).toEqual(withOccupants.instance.snapshot)
  })
})

test('a real canonical dependency with user history refuses an ordinary target rename while retaining complete W, with no ordinary fallback and usable navigation after Cancel @electron', async ({}, info) => {
  await withSyncedTitleRenameApp(info, 'canonical-history', async fixture => {
    const { seed } = fixture, { page, app } = fixture.context(), retained = 'Retained ordinary target history draft 中文🙂'
    await openTarget(page, seed)
    const before = await actual(page, seed)
    expectTargetPreconditions(before, seed)
    expect(before.instance.snapshot.history.undoToken).not.toBeNull()
    expect(before.instance.snapshot.history.undoToken).toBe(seed.original.group.history.undoToken)
    await installProbe(app, seed.childId, false, info.outputPath('ordinary-target-main-observation.json'))
    try {
      await renameTarget(page, retained)
      await expect.poll(() => observation(app).rows.filter(row => row.settled && (row.error || row.refusal)).length).toBe(1)
      const row = expectHintAndWorking(observation(app), before, seed, retained)
      expect(row.error).toBeUndefined(); expect(row.result).toBeUndefined()
      expect(row.refusal).toMatchObject({ status: 'unsupported' })
      expect(JSON.stringify(row.refusal)).toMatch(/requires-lineage.*history/)
      await expect(renameDialog(page)).toBeVisible(); await expect(nameField(page)).toHaveValue(retained)
      await expect(page.locator('.document-header-title')).toHaveText(seed.childTitle)
      expect(await actual(page, seed)).toEqual(before)
      await expect(page.locator('[data-block-id="' + seed.targetBlockId + '"]')).toContainText(before.target.blocks[0].content)
      await renameDialog(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(renameDialog(page)).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText(seed.childTitle)
      expect(await actual(page, seed)).toEqual(before)
      // A definitive refusal must retire its pending nonce; genuine navigation
      // is the assertion, rather than app teardown or a direct navigate call.
      await openDocument(page, seed.observerTitle)
      await expect(page.locator('.document-header-title')).toHaveText(seed.observerTitle)
      expect(observation(app).ordinaryTargetWrites).toEqual([])
    } finally { await restoreProbe(app) }
  })
})
