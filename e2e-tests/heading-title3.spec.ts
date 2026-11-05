// Uses the matching local build and the shared background Electron launcher.
import { expect, test, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { IpcMainInvokeEvent } from 'electron'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { closeElectronApp, hasBuiltElectronApp, launchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'
import type { HeadingTitle3Seed } from './helpers/heading-title3-seed'

const runFile = promisify(execFile), repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const executable = createRequire(import.meta.url)('electron') as string
type Handler = (event: IpcMainInvokeEvent, request: SyncedEditingRequest) => unknown | Promise<unknown>
type Ordinary = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
type Seen = { input: unknown; result?: unknown; error?: string }
type Probe = { original: Handler; ordinary: Ordinary; rows: Seen[]; ordinaryWrites: number }
type ProbeGlobal = typeof globalThis & { __headingTitle3Probe?: Probe }
async function rename(page: Page, title: string) {
  await page.locator('.document-header-title-button').click()
  const dialog = page.locator('.document-rename-dialog')
  await dialog.getByRole('textbox', { name: uiText('Document name', '文档名称'), exact: true }).fill(title)
  await dialog.getByRole('button', { name: uiText('Rename', '重命名'), exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
async function openTarget(page: Page, seed: HeadingTitle3Seed, title: string) {
  const parent = page.getByRole('treeitem', { name: seed.hostTitle, exact: true })
  if (await parent.getAttribute('aria-expanded') === 'false') await parent.locator('.tree-expand-toggle').click()
  await page.getByRole('treeitem', { name: title, exact: true }).locator('.tree-button').click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
test('real UI keeps both heading births and the mixed group across repeated target renames, self maintenance and a complete cold restart @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Build the matching local app first')
  if (process.env.KNOWBOOK_E2E_EXECUTABLE?.trim()) throw Error('Heading lineage seed requires the matching local source build')
  const profile = mkdtempSync(join(realpathSync(tmpdir()), 'knowbook-e2e-heading-title3-'))
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KNOWBOOK_USER_DATA_DIR: profile }
  delete env.ELECTRON_RENDERER_URL
  const seedScript = join(repoRoot, 'e2e-tests/helpers/heading-title3-seed.ts')
  await runFile(executable, ['--import', 'tsx', seedScript, profile, 'create'], { cwd: repoRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  const seed = JSON.parse(readFileSync(join(profile, 'heading-title3-seed.json'), 'utf8')) as HeadingTitle3Seed
  await info.attach('original-heading-births', { body: JSON.stringify(seed), contentType: 'application/json' })
  let context: ElectronAppContext | null = null, failed = true, probeInstalled = false
  const observation = info.outputPath('heading-title3-observation.json')
  const restoreProbe = async () => {
    if (!context || !probeInstalled) return
    await context.app.evaluate(({ ipcMain }) => {
      const globals = globalThis as ProbeGlobal, probe = globals.__headingTitle3Probe
      if (!probe) throw Error('Original probe missing')
      ipcMain.removeHandler('knowbook:invoke-synced-editing-session'); ipcMain.handle('knowbook:invoke-synced-editing-session', probe.original)
      ipcMain.removeHandler('knowbook:update-document'); ipcMain.handle('knowbook:update-document', probe.ordinary)
      delete globals.__headingTitle3Probe
    })
    probeInstalled = false
  }
  try {
    context = await launchElectronApp({}, { userDataRoot: profile, editorMode: 'markdown' })
    await context.app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    await context.app.evaluate(({ ipcMain }, { targetId, observation }) => {
      const globals = globalThis as ProbeGlobal
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler | Ordinary> })._invokeHandlers
      const original = handlers.get('knowbook:invoke-synced-editing-session') as Handler, ordinary = handlers.get('knowbook:update-document') as Ordinary
      if (!original || !ordinary) throw Error('Real handlers required')
      const probe: Probe = { original, ordinary, rows: [], ordinaryWrites: 0 }, fs = process.getBuiltinModule('node:fs')
      const publish = () => { fs.writeFileSync(observation + '.pending', JSON.stringify({ rows: probe.rows, ordinaryWrites: probe.ordinaryWrites }), { flag: 'wx' }); fs.renameSync(observation + '.pending', observation) }
      globals.__headingTitle3Probe = probe; publish()
      ipcMain.removeHandler('knowbook:invoke-synced-editing-session')
      ipcMain.handle('knowbook:invoke-synced-editing-session', async (event, request: SyncedEditingRequest) => {
        const record = request.method === 'applySyncedHostStructure' && request.input.mode === 'host-final'
          && request.input.hostsWorkingBefore[0]?.documentId === targetId ? { input: structuredClone(request.input) } as Seen : null
        if (record) { probe.rows.push(record); publish() }
        try { const result = await original(event, request); if (record) { record.result = structuredClone(result); publish() }; return result }
        catch (error) { if (record) { record.error = String(error); publish() }; throw error }
      })
      ipcMain.removeHandler('knowbook:update-document')
      ipcMain.handle('knowbook:update-document', (event, ...args: unknown[]) => {
        if (args[0] === targetId) { probe.ordinaryWrites++; publish() }; return ordinary(event, ...args)
      })
    }, { targetId: seed.targetId, observation })
    probeInstalled = true
    const page = context.page, first = 'Heading lineage renamed once', second = 'Heading lineage renamed twice'
    await openTarget(page, seed, seed.targetTitle)
    const actual = () => page.evaluate(async seed => ({ target: await window.knowbook.getDocumentDetail(seed.targetId),
      groups: await Promise.all(seed.groups.map(group => window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: seed.hostId, instanceId: group.instanceId, groupId: group.groupId }))) }), seed)
    const before = await actual()
    await rename(page, first)
    const committedRows = () => (JSON.parse(readFileSync(observation, 'utf8')) as { rows: Array<{ result?: { status: string } }> }).rows
    await expect.poll(() => committedRows()[0]?.result?.status).toBe('applied')
    const occupied = await page.evaluate(async ({ hostId, targetTitle }) => {
      const { id } = await window.knowbook.createDocument(hostId), detail = await window.knowbook.getDocumentDetail(id)
      if (!detail) throw Error('Actual old-path occupant absent')
      await window.knowbook.updateDocument(id, { expectedUpdatedAt: detail.updatedAt, title: targetTitle, summary: '', blocks: [{ type: 'heading-1', content: 'Native exact heading', checked: false, depth: 0 }] })
      return id
    }, seed)
    expect(occupied).not.toBe(seed.targetId)
    await rename(page, second)
    await expect.poll(() => committedRows()[1]?.result?.status).toBe('applied')
    const after = await actual(), url = encodeURIComponent(seed.hostTitle) + '/' + encodeURIComponent(second) + '.md'
    expect(after.target?.id).toBe(seed.targetId)
    expect(after.target?.blocks.find(block => block.id === seed.selfId)?.content).toBe('[ordinary self](' + encodeURIComponent(second) + '.md)')
    for (let index = 0; index < after.groups.length; index++) {
      const prior = before.groups[index], current = after.groups[index]
      expect(prior.status).toBe('ready'); expect(current.status).toBe('ready')
      if (prior.status !== 'ready' || current.status !== 'ready') throw Error('Actual instance must stay ready')
      expect(current.snapshot.origin).toEqual(prior.snapshot.origin)
      expect(current.snapshot.creationId).toBe(prior.snapshot.creationId)
      expect(current.snapshot.blocks.map(block => [block.id, block.createdAt])).toEqual(prior.snapshot.blocks.map(block => [block.id, block.createdAt]))
      expect(current.snapshot.bindings.map(binding => binding.target)).toEqual(prior.snapshot.bindings.map(binding => binding.target))
      expect(current.snapshot.bindings.every(binding => binding.raw.startsWith(url))).toBe(true)
    }
    const seen = JSON.parse(readFileSync(observation, 'utf8')) as { rows: Array<Seen & { result?: { status: string; historyToken: string | null } }>; ordinaryWrites: number }
    expect(seen.rows).toHaveLength(2); expect(seen.ordinaryWrites).toBe(0)
    for (const row of seen.rows) { expect(row.error).toBeUndefined(); expect(row.result?.status).toBe('applied'); expect(row.result?.historyToken).toBeNull() }
    await restoreProbe()
    await context.app.context().tracing.stop(); await closeElectronApp(context, { preserveUserData: true }); context = null
    await runFile(executable, ['--import', 'tsx', seedScript, profile, 'inspect', 'heading-title3-inspect-stopped.json'], { cwd: repoRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    const cold = JSON.parse(readFileSync(join(profile, 'heading-title3-inspect-stopped.json'), 'utf8')) as HeadingTitle3Seed['original']
    for (const original of seed.original.operations) expect(cold.operations.find(row => row.client_operation_id === original.client_operation_id)).toEqual(original)
    const titles = cold.operations.filter(row => JSON.parse(row.result_json).kind === 'synced-host-heading-title-metadata3-operation')
    expect(titles).toHaveLength(2)
    expect(cold.blocks.map(row => [row.id, row.document_id, row.parent_block_id, row.type, row.created_at]))
      .toEqual(seed.original.blocks.map(row => [row.id, row.document_id, row.parent_block_id, row.type, row.created_at]))
    for (const identity of seed.original.identities) expect(cold.identities.find(row => row.id === identity.id)).toEqual(identity)
    expect(cold.blocks.find(row => row.id === seed.headingId)).toEqual(seed.original.blocks.find(row => row.id === seed.headingId))
    expect(cold.documents.find(doc => doc.id === seed.targetId)?.created_at).toBe(seed.original.documents.find(doc => doc.id === seed.targetId)?.created_at)
    context = await launchElectronApp({}, { userDataRoot: profile, editorMode: 'markdown' })
    await openTarget(context.page, seed, second)
    expect((await context.page.evaluate(id => window.knowbook.getDocumentDetail(id), seed.targetId))?.blocks).toEqual(after.target?.blocks)
    failed = false
  } finally {
    if (context) { await restoreProbe().catch(() => undefined); if (failed) await context.app.context().tracing.stop({ path: info.outputPath('first-attempt-trace.zip') }).catch(() => undefined); await closeElectronApp(context, { preserveUserData: failed }) }
  }
})
