import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { ElectronApplication } from 'playwright'
import type { IpcMainInvokeEvent } from 'electron'
import type { UpdateDocumentInput } from '../src/shared/contracts'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import type { SyncedStructureApplied, SyncedStructureInput } from '../src/shared/synced-blocks'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { inlineInstance, setInlineReading } from './helpers/canonical-inline'
import { withSyncedTitleRenameApp } from './helpers/synced-title-rename'
import type { TitleRenameAudit, TitleRenameSeed } from './helpers/synced-title-rename-seed'

type HostFinal = Extract<SyncedStructureInput, { mode: 'host-final' }>
type Handler = (event: IpcMainInvokeEvent, input: SyncedEditingRequest) => unknown | Promise<unknown>
type OrdinaryHandler = (event: IpcMainInvokeEvent, id: string, input: UpdateDocumentInput) => unknown | Promise<unknown>
type Row = { sessionId: string; input: HostFinal; result?: SyncedStructureApplied; refusal?: unknown; error?: string; settled: boolean }
type Probe = { original: Handler; ordinary: OrdinaryHandler; rows: Row[]; ordinaryHostWrites: unknown[];
  firstOutcome: Promise<Row>; releaseFirst: () => Promise<Row> }
type ProbeGlobal = typeof globalThis & { __syncedTitleRenameProbe?: Probe }
const probeAuditPaths = new WeakMap<ElectronApplication, string>()

const renameDialog = (page: Page) => page.locator('.document-rename-dialog')
const nameField = (page: Page) => renameDialog(page).getByRole('textbox', { name: uiText('Document name', '文档名称'), exact: true })

async function openHost(page: Page, title: string): Promise<void> {
  await page.locator('.tree-button').filter({ has: page.locator('.tree-document-title', { hasText: title }) }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
async function renameHost(page: Page, title: string): Promise<void> {
  await page.locator('.document-header-title-button').click()
  await expect(renameDialog(page)).toBeVisible()
  await nameField(page).fill(title)
  await renameDialog(page).getByRole('button', { name: uiText('Rename', '重命名'), exact: true }).click()
}

// Delegates untouched real Main handlers. The sole hold happens AFTER the
// original authenticated title operation and event publication actually finish.
// No business ACK, guard, sourcepoint, exposure, or transaction is fabricated.
async function installProbe(app: ElectronApplication, hostId: string, hold: boolean, auditPath: string): Promise<void> {
  await app.evaluate(({ ipcMain }, { hostId, hold, auditPath }) => {
    const globals = globalThis as ProbeGlobal
    if (globals.__syncedTitleRenameProbe) throw Error('The genuine title probe is already installed')
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler | OrdinaryHandler> })._invokeHandlers
    const original = handlers.get('knowbook:invoke-synced-editing-session') as Handler | undefined
    const ordinary = handlers.get('knowbook:update-document') as OrdinaryHandler | undefined
    if (!original || !ordinary) throw Error('Both actual production handlers must exist')
    let outcome!: (row: Row) => void, release!: () => void
    let returned!: (row: Row) => void
    const firstOutcome = new Promise<Row>(resolve => { outcome = resolve })
    const firstReturned = new Promise<Row>(resolve => { returned = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const probe: Probe = { original, ordinary, rows: [], ordinaryHostWrites: [], firstOutcome,
      releaseFirst: async () => { release(); return await firstReturned } }
    const fs = process.getBuiltinModule('node:fs')
    const publish = () => {
      // Publish actual captured Main state atomically. Reading this test-owned
      // file avoids polling the Main Inspector while the real IPC is pending.
      fs.writeFileSync(auditPath + '.pending', JSON.stringify({ rows: probe.rows, ordinaryHostWrites: probe.ordinaryHostWrites }), { flag: 'wx' })
      fs.renameSync(auditPath + '.pending', auditPath)
    }
    publish()
    globals.__syncedTitleRenameProbe = probe
    ipcMain.removeHandler('knowbook:invoke-synced-editing-session')
    ipcMain.handle('knowbook:invoke-synced-editing-session', async (event, request: SyncedEditingRequest) => {
      const input = request.method === 'applySyncedHostStructure' && request.input.mode === 'host-final'
        && request.input.reason === 'selection-edit' && request.input.hostsWorkingBefore[0]?.documentId === hostId ? request.input : null
      const row: Row | null = input ? { sessionId: request.sessionId, input: structuredClone(input), settled: false } : null
      if (row) { probe.rows.push(row); publish() }
      try {
        const result = await original(event, request)
        if (row) {
          if (!result || typeof result !== 'object' || !('status' in result) || result.status !== 'applied'
            || !('hosts' in result) || !Array.isArray(result.hosts) || result.hosts.length !== 1 || result.hosts[0]?.documentId !== hostId) {
            row.refusal = structuredClone(result)
            // Preserve a genuine typed refusal as the original result. Turning
            // it into an IPC exception here would change the tested UX.
            return result
          }
          row.result = structuredClone(result) as SyncedStructureApplied
          publish()
          if (probe.rows[0] === row) {
            outcome(structuredClone(row))
            if (hold) await released
            row.settled = true; returned(structuredClone(row))
          }
        }
        return result
      } catch (error) {
        if (row) { row.error = error instanceof Error ? error.message : String(error); row.settled = true }
        throw error
      } finally {
        if (row) {
          row.settled = true
          publish()
          if (probe.rows[0] === row) {
            outcome(structuredClone(row)); returned(structuredClone(row))
          }
        }
      }
    })
    ipcMain.removeHandler('knowbook:update-document')
    ipcMain.handle('knowbook:update-document', async (event, id: string, input: UpdateDocumentInput) => {
      if (id === hostId) { probe.ordinaryHostWrites.push(structuredClone(input)); publish() }
      return ordinary(event, id, input)
    })
  }, { hostId, hold, auditPath })
  probeAuditPaths.set(app, auditPath)
}
async function probeRows(app: ElectronApplication) {
  const auditPath = probeAuditPaths.get(app)
  if (!auditPath) throw Error('The actual Main observation file is missing')
  return JSON.parse(readFileSync(auditPath, 'utf8')) as { rows: Row[]; ordinaryHostWrites: unknown[] }
}
async function restoreProbe(app: ElectronApplication): Promise<void> {
  try {
    await app.evaluate(async ({ ipcMain }) => {
      const globals = globalThis as ProbeGlobal, value = globals.__syncedTitleRenameProbe
      if (!value) return
      if (value.rows[0]?.result) await value.releaseFirst()
      ipcMain.removeHandler('knowbook:invoke-synced-editing-session'); ipcMain.handle('knowbook:invoke-synced-editing-session', value.original)
      ipcMain.removeHandler('knowbook:update-document'); ipcMain.handle('knowbook:update-document', value.ordinary)
      delete globals.__syncedTitleRenameProbe
    })
  } finally { probeAuditPaths.delete(app) }
}
async function actual(page: Page, seed: TitleRenameSeed) {
  return page.evaluate(async ({ hostId, childId, observerId, hostInstanceId, groupId }) => {
    const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: hostId })
    if (opened.status !== 'ready') throw Error('The genuine observation session could not open')
    // Main reuses one session per real IPC frame; this observer must not
    // retire the editor runtime's shared owner. Real frame/app teardown owns it.
    const [host, child, observer, instance, history] = await Promise.all([
      window.knowbook.getDocumentDetail(hostId), window.knowbook.getDocumentDetail(childId), window.knowbook.getDocumentDetail(observerId),
      window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: hostId, instanceId: hostInstanceId, groupId }),
      window.knowbook.invokeSyncedEditingSession({ sessionId: opened.session.sessionId, method: 'getSyncedHostHistory', input: { documentId: hostId } })
    ])
    if (!host || !child || !observer || instance.status !== 'ready') throw Error('The genuine persisted title fixture is incomplete')
    return { host, child, observer, instance, history }
  }, seed)
}
function expectBirthAndOrigin(audit: TitleRenameAudit, seed: TitleRenameSeed, renamed: string) {
  expect(audit.identities).toEqual(seed.original.identities)
  expect(audit.originalOperations).toEqual(seed.original.originalOperations)
  expect(audit.hostHistory).toEqual(seed.original.hostHistory)
  expect(audit.hostMappings).toEqual(seed.original.hostMappings)
  for (const before of seed.original.documents) {
    const after = audit.documents.find(item => item.id === before.id)!
    expect(after.created_at).toBe(before.created_at)
    expect(after.parent_id).toBe(before.parent_id)
    expect(after.summary).toBe(before.summary)
    expect(after.path).toBe(before.id === seed.hostId ? renamed : before.id === seed.childId ? renamed + '/' + seed.childTitle : before.path)
  }
  expect(audit.blocks.map(item => [item.id, item.document_id, item.parent_block_id, item.created_at]))
    .toEqual(seed.original.blocks.map(item => [item.id, item.document_id, item.parent_block_id, item.created_at]))
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
  expect(original.companion.businessOperationCommitted).toBe(true)
  expect(original.companion.writePermit).toBe(false)
  const capture = original.captures.find(item => item.groupId === seed.groupId)!
  const document = capture.targets.find(item => item.key.blockId === seed.documentLinkId)
  const block = capture.targets.find(item => item.key.blockId === seed.blockLinkId)
  expect(document).toMatchObject({ status: 'current-document', documentId: seed.hostId,
    documentCreatedAt: seed.original.documents.find(item => item.id === seed.hostId)!.created_at })
  expect(block).toMatchObject({ status: 'current-block', blockId: seed.targetBlockId,
    createdAt: seed.original.blocks.find(item => item.id === seed.targetBlockId)!.created_at })
}

// Original 60s/project retries/workers, hidden Electron and independent profile
// remain unchanged. This is normal rename P!=W=A; it is not a Source title UI.
test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this title slice')

test('normal editor rename preserves the real W=A receipt, canonical targets and birth/Origin through ordinary maintenance, old-path occupants and a complete stopped-profile restart @electron', async ({}, info) => {
  await withSyncedTitleRenameApp(info, 'published', async fixture => {
    const { seed } = fixture, renamed = 'Title renamed host 中文🙂'
    let { page, app } = fixture.context()
    await openHost(page, seed.hostTitle); await setInlineReading(page, true)
    const before = await actual(page, seed)
    await installProbe(app, seed.hostId, true, info.outputPath('title-main-observation.json'))
    try {
      await renameHost(page, renamed)
      const committed = await app.evaluate(() => (globalThis as ProbeGlobal).__syncedTitleRenameProbe!.firstOutcome)
      expect(committed.refusal).toBeUndefined(); expect(committed.error).toBeUndefined()
      expect(committed.result?.status).toBe('applied')
      expect(committed.result?.historyToken).toBeNull()
      expect(committed.input.hostsWorkingBefore[0].workingBefore.title).toBe(renamed)
      expect(committed.input.finalAfter[0].title).toBe(renamed)
      expect(committed.input.reason).toBe('selection-edit')
      expect(committed.input.hostsWorkingBefore[0].expectedPersistedUpdatedAt).toBe(before.host.updatedAt)
      expect(committed.input.finalAfter[0].blocks).toEqual(committed.input.hostsWorkingBefore[0].workingBefore.blocks)
      await expect(renameDialog(page)).toBeVisible(); await expect(nameField(page)).toHaveValue(renamed)
      const persisted = await actual(page, seed)
      expect(persisted.host.title).toBe(renamed); expect(persisted.host.path).toBe(renamed)
      expect(persisted.child.path).toBe(renamed + '/' + seed.childTitle)
      expect(persisted.history).toEqual(before.history)
      expect(persisted.instance.instance.hostCreatedAt).toBe(before.instance.instance.hostCreatedAt)
      expect(persisted.instance.instance.instanceCreatedAt).toBe(before.instance.instance.instanceCreatedAt)
      expect(persisted.instance.instance.bindingVersion).toBe(before.instance.instance.bindingVersion)
      const group = persisted.instance.snapshot
      expect(group.origin).toEqual(before.instance.snapshot.origin)
      expect(group.bindings.map(item => item.target)).toEqual(before.instance.snapshot.bindings.map(item => item.target))
      for (const binding of group.bindings) {
        const block = group.blocks.find(item => item.id === binding.blockId)!
        expect(block.content.slice(binding.from, binding.to)).toBe(binding.raw)
      }
      for (const id of [seed.documentLinkId, seed.blockLinkId]) expect(group.bindings.find(item => item.blockId === id)!.raw).toContain(encodeURIComponent(renamed))
      expect(persisted.host.blocks.find(item => item.id === seed.hostOrdinaryLinkId)!.content).toContain(encodeURIComponent(renamed) + '/' + encodeURIComponent(seed.childTitle) + '.md')
      expect(persisted.observer.blocks.find(item => item.id === seed.observerOrdinaryLinkId)!.content).toContain(encodeURIComponent(renamed) + '.md')
      expect((await probeRows(app)).ordinaryHostWrites).toEqual([])
      expect((await probeRows(app)).rows).toHaveLength(1)
      await app.evaluate(() => (globalThis as ProbeGlobal).__syncedTitleRenameProbe!.releaseFirst())
      await expect(renameDialog(page)).toHaveCount(0); await expect(page.locator('.document-header-title')).toHaveText(renamed)
    } finally { await restoreProbe(app) }

    // New real path occupants must not replace the original typed targets. The
    // unresolved original also remains unresolved even though its URL now exists.
    const occupants = await page.evaluate(async ({ hostTitle, missingTitle }) => {
      const result: string[] = []
      for (const title of [hostTitle, missingTitle]) {
        const value = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(value.id, { title, summary: 'Later path occupant', blocks: [
          { id: crypto.randomUUID(), type: 'paragraph', content: 'Later occupant cannot borrow original targets', checked: false, depth: 0, parentBlockId: null }
        ] })
        result.push(value.id)
      }
      return result
    }, seed)
    expect(occupants).not.toContain(seed.hostId)
    const withOccupants = await actual(page, seed)
    expect(withOccupants.instance.snapshot.bindings.map(item => item.target)).toEqual(before.instance.snapshot.bindings.map(item => item.target))
    await openHost(page, seed.observerTitle); await setInlineReading(page, true)
    await inlineInstance(page, seed.observerInstanceId).getByRole('button', { name: 'Unavailable original', exact: true }).click()
    await expect(inlineInstance(page, seed.observerInstanceId).getByRole('alert')).toHaveText(uiText('The original link target is unavailable.', '原链接目标不可用。'))
    await expect(page.locator('.document-header-title')).toHaveText(seed.observerTitle)
    await inlineInstance(page, seed.observerInstanceId).getByRole('button', { name: 'Original document', exact: true }).click()
    await expect(page.locator('.document-header-title')).toHaveText(renamed)
    await openHost(page, seed.observerTitle); await setInlineReading(page, true)
    await inlineInstance(page, seed.observerInstanceId).getByRole('button', { name: 'Original block', exact: true }).click()
    await expect(page.locator('.document-header-title')).toHaveText(seed.childTitle)
    await expect(page.locator('[data-block-id="' + seed.targetBlockId + '"]')).toBeVisible()

    const stopped = await fixture.restart()
    expectBirthAndOrigin(stopped, seed, renamed)
    ;({ page, app } = fixture.context())
    await openHost(page, seed.observerTitle); await setInlineReading(page, true)
    await inlineInstance(page, seed.observerInstanceId).getByRole('button', { name: 'Original document', exact: true }).click()
    await expect(page.locator('.document-header-title')).toHaveText(renamed)
    const cold = await actual(page, seed)
    expect(cold.instance.snapshot).toEqual(withOccupants.instance.snapshot)
    expect(cold.history).toEqual(before.history)
  })
})

test('canonical user Undo and Redo retain the maintained document destination after a real title save @electron', async ({}, info) => {
  await withSyncedTitleRenameApp(info, 'canonical-history-supported', async fixture => {
    const { seed } = fixture, { page } = fixture.context(), renamed = 'Canonical history renamed host'
    await openHost(page, seed.hostTitle); await setInlineReading(page, true)
    const before = await actual(page, seed)
    expect(before.instance.snapshot.history.undoToken).not.toBeNull()
    await renameHost(page, renamed)
    await expect(renameDialog(page)).toHaveCount(0)
    await expect(page.locator('.document-header-title')).toHaveText(renamed)
    const reference = inlineInstance(page, seed.hostInstanceId)
    const content = async () => (await actual(page, seed)).instance.snapshot.blocks.find(block => block.id === seed.documentLinkId)?.content
    const text = '[Original document](' + encodeURIComponent(renamed) + '.md)'
    await expect.poll(content).toBe(text + ' retained canonical edit')
    await reference.getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
    await expect.poll(content).toBe(text)
    await reference.getByRole('button', { name: uiText('Redo', '重做'), exact: true }).click()
    await expect.poll(content).toBe(text + ' retained canonical edit')
  })
})

test('a genuine asset-bearing canonical-history refusal keeps the rename candidate and original draft while Cancel leaves navigation usable @electron', async ({}, info) => {
  await withSyncedTitleRenameApp(info, 'canonical-history', async fixture => {
    const { seed } = fixture, { page, app } = fixture.context(), retained = 'Retained history title draft 中文🙂'
    await openHost(page, seed.hostTitle); await setInlineReading(page, true)
    const before = await actual(page, seed)
    expect(before.instance.snapshot.history.undoToken).not.toBeNull()
    expect(before.instance.snapshot.history.undoToken).toBe(seed.original.group.history.undoToken)
    await installProbe(app, seed.hostId, false, info.outputPath('title-main-observation.json'))
    try {
      await renameHost(page, retained)
      await expect.poll(async () => (await probeRows(app)).rows.filter(row => row.settled && (row.error || row.refusal)).length).toBe(1)
      const observed = await probeRows(app)
      expect(observed.rows[0].error).toBeUndefined()
      expect(observed.rows[0].refusal).toMatchObject({ status: 'unsupported' })
      expect(JSON.stringify(observed.rows[0].refusal)).toMatch(/requires-lineage.*history/)
      expect(observed.rows[0].result).toBeUndefined()
      expect(observed.ordinaryHostWrites).toEqual([])
      await expect(renameDialog(page)).toBeVisible(); await expect(nameField(page)).toHaveValue(retained)
      await expect(page.locator('.document-header-title')).toHaveText(seed.hostTitle)
      expect(await actual(page, seed)).toEqual(before)
      for (const block of seed.original.group.blocks) {
        await expect.poll(() => inlineInstance(page, seed.hostInstanceId).locator('[data-block-id]').evaluateAll((nodes, id) =>
          nodes.filter(node => (node as HTMLElement).dataset.blockId === id).map(node => node.textContent), block.id)).not.toEqual([])
      }
      await renameDialog(page).getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(renameDialog(page)).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText(seed.hostTitle)
      expect(await actual(page, seed)).toEqual(before)
      // A definitive requires-lineage refusal must not be mistaken for an
      // indefinitely unknown committed nonce after the user cancels its dialog.
      // Retain this real interaction assertion; teardown is not its oracle.
      await openHost(page, seed.observerTitle)
      await expect(page.locator('.document-header-title')).toHaveText(seed.observerTitle)
    } finally { await restoreProbe(app) }
  })
})
