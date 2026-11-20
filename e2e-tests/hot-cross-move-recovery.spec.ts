import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type JSHandle } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ApplyEditorRecoveryCrossMoveInput, ApplyEditorRecoveryCrossMoveResult, EditorRecoveryCandidate, EditorRecoveryExpected,
  EditorRecoveryReceipt, WriteEditorRecoveryDraftsInput } from '../src/shared/editor-recovery-drafts'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { closeElectronApp, evaluateInFreshElectronMain, hasBuiltElectronApp, launchElectronApp, relaunchElectronApp, uiText } from './helpers/electron'
import { appendCanonicalText, expectCanonicalRow, inlineInstance, setInlineReading } from './helpers/canonical-inline'

test.skip(!hasBuiltElectronApp(), 'The current local Electron bundle must be built')
type Probe = { moves: ApplyEditorRecoveryCrossMoveResult[]; requests: ApplyEditorRecoveryCrossMoveInput[]; groupWrites: number; methods: string[];
  errors: string[]; stationaryDraftsAtMove: EditorRecoveryExpected[]; hostCapture: Array<{ linked: boolean; updatedAt: unknown; pending: string | undefined }> }
const scenarios = [
  ['hot-before-move', '', false, 0],
  ['hot-empty-before-move', ' after emptying and restarting the source', true, 0],
  ['hot-wiki-before-move', ' with a V6 Wiki dependency', false, 1],
  ['hot-v7-before-move', ' with a V7 Markdown dependency', false, 1],
  ['hot-v9-before-move', ' with V9 source emptying and two external pages', true, 2],
  ['hot-v10-before-move', ' with a V10 HTML dependency', false, 1],
  ['hot-v11-before-move', ' with a V11 clean neighboring reference', false, 1],
  ['hot-nested-before-move', ' for a nested reference moved under a list item', false, 0],
  ['hot-list-parent-before-move', ' for a moved list parent with a shared and an ordinary child', false, 0],
  ['hot-list-parent-outside-before-move', ' for a moved list parent with an outside link', false, 1],
  ['hot-list-parent-target-peer-before-move', ' for a list parent moved into a page already sharing the same body', false, 0],
  ['hot-list-parent-source-peer-before-move', ' for a list parent when another reference remains on the source page', false, 0],
  ['hot-shared-target-before-move', ' into a page already sharing the same body', false, 0],
  ['hot-shared-source-before-move', ' while the source still displays another reference to the same body', false, 0],
  ['hot-batch-before-move', ' in a batch with a staged ordinary source and a live shared draft', false, 1],
  ['hot-batch-saved-reference-before-move', ' in a batch with a saved reference and a live shared draft', false, 1],
  ['hot-batch-stationary-saved-before-move', ' in a batch when an independent draft is saved first', false, 1],
  ['hot-mixed-root-pair-before-move', ' with an ordinary root from the same source', true, 0],
  ['hot-mixed-outside-before-move', ' with mixed roots linked from two outside pages', true, 2],
  ['hot-mixed-target-peer-before-move', ' with mixed roots entering a page already sharing the same body', true, 0],
  ['hot-shared-wiki-before-move', ' with a shared reference in both hosts and a Wiki dependency', false, 1],
  ['hot-shared-markdown-before-move', ' with a shared reference in both hosts and a Markdown dependency', false, 1],
  ['hot-shared-multiple-dependencies-before-move', ' with references in both hosts and multiple dependencies including a clean neighboring group', false, 2],
  ['hot-mixed-forest-before-move', ' with three roots and nested ordinary descendants', true, 0]
] as const
for (const [mode, name, emptiesSource, dependencyCount] of scenarios) test(`Move keeps a live shared draft and Redo until review and explicit Save in the new page${name} @electron`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-e2e-hot-cross-move-')), profile = join(root, 'profile')
  const executable = createRequire(import.meta.url)('electron') as string
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'cross-move-recovery-seed.ts')
  await promisify(execFile)(executable, ['--import', 'tsx', fixture, root, mode],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000 })
  const seed = JSON.parse(await readFile(join(profile, 'cross-move-recovery-seed.json'), 'utf8')) as {
    instanceId: string; groupId: string; sourceId: string; targetId: string; primaryId: string; raw: string
    sharedSourceId?: string; sharedTargetId?: string; ordinaryRootId?: string
    ordinaryBranch?: { root: string; inner: string; leaf: string }
    placement?: { sourceParentId: string; targetParentId: string; targetDepth: number; forest?: { childId: string; outsideId: string } }
    stagedSource?: { documentId: string; title: string; blockId: string; savedGroupId?: string }
    independent?: { groupId: string; instanceId: string; blockId: string; text: string }
    dependencies: Array<{ documentId: string; title: string; before: string; after: string; stationary?: { instanceId: string; groupId: string } }>
  }
  const [dependency] = seed.dependencies
  const stationaryPage = seed.dependencies.find(peer => peer.stationary)
  const placement = seed.placement, forest = placement?.forest, staged = seed.stagedSource, independent = seed.independent
  expect(seed.dependencies).toHaveLength(dependencyCount)
  let context = await launchElectronApp({}, { userDataRoot: profile, editorMode: 'markdown' })
  let { app, page } = context
  let passed = false
  const registerProbe = () =>
    evaluateInFreshElectronMain(app, ({ app, ipcMain }, { profile, independentBlockId }) => {
      if (process.env.KNOWBOOK_E2E_BACKGROUND !== '1' || app.getPath('userData') !== profile) throw new Error('The actual background profile is required')
      const protectedChannel = 'knowbook:apply-editor-recovery-cross-move', sessionChannel = 'knowbook:invoke-synced-editing-session'
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers
      const move = handlers.get(protectedChannel) as (event: IpcMainInvokeEvent, input: ApplyEditorRecoveryCrossMoveInput) => Promise<ApplyEditorRecoveryCrossMoveResult>
      const invoke = handlers.get(sessionChannel) as (event: IpcMainInvokeEvent, input: SyncedEditingRequest) => unknown
      const journal = handlers.get('knowbook:read-editor-recovery-draft') as (event: IpcMainInvokeEvent, input: ApplyEditorRecoveryCrossMoveInput['hostHead']) => EditorRecoveryCandidate
      if (!move || !invoke) throw new Error('The actual protected Main handlers are required')
      const probe: Probe = { moves: [], requests: [], groupWrites: 0, methods: [], errors: [], hostCapture: [], stationaryDraftsAtMove: [] }
      ;(globalThis as typeof globalThis & { hotMoveProbe: Probe }).hotMoveProbe = probe
      let stationaryDraft: EditorRecoveryExpected | undefined
      if (independentBlockId) {
        const writeChannel = 'knowbook:write-editor-recovery-drafts'
        const write = handlers.get(writeChannel) as (event: IpcMainInvokeEvent, input: WriteEditorRecoveryDraftsInput) => EditorRecoveryReceipt
        if (!write) throw new Error('The actual draft writer is required')
        ipcMain.removeHandler(writeChannel)
        ipcMain.handle(writeChannel, (event, input: WriteEditorRecoveryDraftsInput) => {
          const receipt = write(event, input)
          const draft = input.records.find(record => record.working.kind === 'group' && record.working.blocks.some(block => block.id === independentBlockId))
          const head = draft && receipt.records.find(record => record.draftSessionId === draft.draftSessionId && record.generation === draft.generation)
          if (head) stationaryDraft = { recordId: head.recordId, generation: head.generation, hash: head.hash }
          return receipt
        })
      }
      ipcMain.removeHandler(sessionChannel)
      ipcMain.handle(sessionChannel, (event, input: SyncedEditingRequest) => {
        probe.methods.push(input.method)
        if (input.method === 'updateSyncedBlockGroup' || input.method === 'restoreSyncedGroupOperation') probe.groupWrites++
        return invoke(event, input)
      })
      ipcMain.removeHandler(protectedChannel)
      ipcMain.handle(protectedChannel, async (event, input: ApplyEditorRecoveryCrossMoveInput) => {
        probe.requests.push(input)
        if (independentBlockId) {
          if (!stationaryDraft) throw new Error('The independent dirty group was not durably checkpointed before moving')
          probe.stationaryDraftsAtMove.push(stationaryDraft)
        }
        const { record } = journal(event, input.hostHead)
        probe.hostCapture.push({ linked: !!record.crossMoveGroupHead, pending: record.draft.pending[0]?.inputJson,
          updatedAt: record.base.owner.kind === 'host' ? record.base.owner.updatedAt : null })
        let result
        try { result = await move(event, input) }
        catch (error) { probe.errors.push(String(error)); throw error }
        probe.moves.push(result)
        if (probe.moves.length === 1 && result.status === 'moved') throw new Error('Test discarded actual committed move reply')
        return result
      })
    }, { profile, independentBlockId: independent?.blockId })
  try {
    await registerProbe()
    const probe = () => evaluateInFreshElectronMain(app, () => (globalThis as typeof globalThis & { hotMoveProbe: Probe }).hotMoveProbe)
    const open = async (title: string) => {
      await page.locator('.tree-button', { hasText: title }).first().click({ noWaitAfter: true })
      await expect(page.locator('.document-header-title')).toHaveText(title)
      await setInlineReading(page, false)
    }
    const chooseMoveTarget = async (selectedId: string, ordinaryRootId?: string, selectedIds?: readonly string[]) => {
      let menu
      if (ordinaryRootId) {
        const ordinary = page.locator(`.block-editor-row[data-block-id="${ordinaryRootId}"] textarea.block-inline-textarea`)
        await ordinary.focus()
        await expect(ordinary).toBeFocused()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.press('ControlOrMeta+a')
        await expect.poll(() => page.locator('.block-editor-row-selected').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-block-id'))))
          .toEqual(selectedIds)
        menu = page.locator('.block-selection-toolbar')
      } else {
        const row = page.locator('.block-editor-row[data-block-id="' + selectedId + '"]')
        await row.click({ button: 'right', position: { x: 4, y: 7 } })
        menu = page.locator('.block-context-menu[aria-label="Block actions"], .block-context-menu[aria-label="内容块操作"]')
      }
      await menu.getByRole('button', { name: uiText('Move to document…', '移动到文档…'), exact: true }).click()
      const dialog = page.locator('.document-block-move-dialog')
      await dialog.locator('.document-capture-field input').fill('V3 Target')
      await dialog.locator(`input[value="${seed.targetId}"]`).check()
      return dialog
    }
    const savedGroup = (hostDocumentId: string, instanceId = seed.instanceId, groupId = seed.groupId) => page.evaluate(async ({ hostDocumentId, instanceId, groupId }) => {
      const actual = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId, instanceId, groupId })
      return actual.status === 'ready' ? actual.snapshot : null
    }, { hostDocumentId, instanceId, groupId })
    const independentGroup = () => independent && savedGroup(seed.sourceId, independent.instanceId, independent.groupId)
    const rows = (documentId: string) => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks ?? [], documentId)
    const sourceRows = () => rows(seed.sourceId)
    const originalMixedRows = seed.ordinaryRootId ? await sourceRows() : []
    const originalMovedIds = seed.ordinaryRootId ? originalMixedRows.map(block => block.id) : [seed.instanceId]
    const ordinaryBranch = seed.ordinaryBranch
    if (ordinaryBranch) {
      expect(originalMixedRows.filter(block => block.depth === 0).map(block => block.id)).toEqual([seed.ordinaryRootId, seed.instanceId, ordinaryBranch.root])
      expect(originalMixedRows.find(block => block.id === ordinaryBranch.leaf)).toMatchObject({ parentBlockId: ordinaryBranch.inner, depth: 2 })
    }
    const expectedMixedRows = async (documentId: string) => expect((await rows(documentId)).filter(block => originalMovedIds.includes(block.id))
      .map(({ sortOrder: _position, ...block }) => block)).toEqual(originalMixedRows.map(({ sortOrder: _position, ...block }) => block))
    const targetParentId = placement && (forest ? placement.sourceParentId : placement.targetParentId)
    const targetDepth = placement && placement.targetDepth + (forest ? 1 : 0)
    const expectForest = async (direction: 'source' | 'target') => {
      if (!placement || !forest) throw new Error('The list-parent fixture is required')
      const from = direction === 'source', depth = from ? 0 : placement.targetDepth
      const ids = new Set([placement.sourceParentId, seed.instanceId, forest.childId])
      expect((await rows(from ? seed.sourceId : seed.targetId)).filter(block => ids.has(block.id))).toEqual([
        expect.objectContaining({ id: placement.sourceParentId, type: 'bulleted-list', depth,
          parentBlockId: from ? null : placement.targetParentId }),
        expect.objectContaining({ id: seed.instanceId, type: 'synced-block', depth: depth + 1, parentBlockId: placement.sourceParentId }),
        expect.objectContaining({ id: forest.childId, type: 'bulleted-list', content: 'Ordinary moved child', depth: depth + 1,
          parentBlockId: placement.sourceParentId })
      ])
      expect((await rows(from ? seed.targetId : seed.sourceId)).some(block => ids.has(block.id))).toBe(false)
    }
    const dependencyLink = (docId: string) => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks[0].content, docId)
    const stationary = () => stationaryPage?.stationary ? page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input),
      { hostDocumentId: stationaryPage.documentId, ...stationaryPage.stationary }) : undefined
    const ordinaryBefore = staged && await rows(staged.documentId)
    const savedBefore = staged?.savedGroupId && await savedGroup(staged.documentId, staged.blockId, staged.savedGroupId)
    const otherSavedGroup = () => staged?.savedGroupId ? savedGroup(seed.targetId, staged.blockId, staged.savedGroupId) : null
    if (staged) {
      await open(staged.title)
      const dialog = await chooseMoveTarget(staged.blockId)
      await dialog.getByRole('button', { name: uiText('Add to batch', '加入批量'), exact: true }).click()
      await expect(dialog).toHaveCount(0)
      expect(await rows(staged.documentId)).toEqual(ordinaryBefore)
      expect((await probe()).requests).toEqual([])
    }
    await open('V3 Host')
    const occurrence = inlineInstance(page, seed.instanceId), body = occurrence.locator('.ProseMirror[contenteditable="true"]')
    await expect(body).toBeVisible()
    const initial = await savedGroup(seed.sourceId)
    expect(initial?.blocks[0].content).toBe(seed.raw)
    if (placement) expect(initial?.instances.find(item => item.instanceId === seed.instanceId))
      .toMatchObject({ parentBlockId: placement.sourceParentId, depth: 1 })
    if (forest) await expectForest('source')
    const sharedSource = initial?.instances.find(item => item.instanceId === seed.sharedSourceId)
    if (seed.sharedSourceId) expect(sharedSource).toMatchObject({ hostDocumentId: seed.sourceId, instanceId: seed.sharedSourceId })
    const sharedTarget = initial?.instances.find(item => item.instanceId === seed.sharedTargetId)
    if (seed.sharedTargetId) expect(sharedTarget).toMatchObject({ hostDocumentId: seed.targetId, instanceId: seed.sharedTargetId })
    const initialStationary = await stationary()
    if (stationaryPage) expect(initialStationary?.status).toBe('ready')
    const independentBefore = await independentGroup()
    if (mode === 'hot-batch-stationary-saved-before-move' && (!independent || !independentBefore))
      throw new Error('The batch source must contain the independent group')
    if (independent) expect(independentBefore?.blocks[0].content).toBe(independent.text)
    const independentSuffix = ' kept local before restoring the moved draft'
    let independentSaved = independentBefore
    let resume: JSHandle<() => void> | undefined = await page.evaluateHandle(() => {
      const original = window.setTimeout.bind(window)
      const held = new Set<number>()
      window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay !== 800) return original(callback, delay, ...args)
        const id = original(() => {}, 2_147_000_000); held.add(id); return id
      }) as typeof window.setTimeout
      return () => { window.setTimeout = original; for (const id of held) window.clearTimeout(id) }
    })
    try {
      await appendCanonicalText(page, seed.instanceId, seed.primaryId, 'target', ' hot W')
      // Ordinary paste explicitly seals the prior local typing frame.
      await body.evaluate(element => {
        const data = new DataTransfer(); data.setData('text/plain', ' hot Redo')
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      await expect(body).toContainText('hot Redo')
      await occurrence.getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
      await expect(body).toContainText('hot W')
      await expect(body).not.toContainText('hot Redo')
      if (sharedSource) await expect(inlineInstance(page, sharedSource.instanceId)).toContainText('hot W')
      if (independent) await appendCanonicalText(page, independent.instanceId, independent.blockId, independent.text, independentSuffix)
      expect(await savedGroup(seed.sourceId)).toEqual(initial)
      if (independent) expect(await independentGroup()).toEqual(independentBefore)
      const selectedId = forest ? placement!.sourceParentId : seed.instanceId
      const dialog = await chooseMoveTarget(selectedId, seed.ordinaryRootId, originalMovedIds)
      if (placement) {
        const placementControl = dialog.getByRole('combobox', { name: /Placement|放置位置/ })
        try { await expect(placementControl.locator('option', { hasText: 'Receiving list item' })).toBeAttached() }
        catch (error) { throw new Error(await dialog.ariaSnapshot(), { cause: error }) }
        await placementControl.selectOption(placement.targetParentId)
      }
      await dialog.getByRole('button', { name: staged ? uiText('Move batch', '移动批量') : uiText('Move', '移动'), exact: true }).click()
      try { await expect(dialog).toHaveCount(0) }
      catch (error) { throw new Error(JSON.stringify({ dialog: await dialog.textContent(), probe: await probe() }), { cause: error }) }
      const settled = await probe()
      expect(settled.groupWrites).toBe(0)
      expect(settled.requests).toHaveLength(2)
      expect(settled.requests[0]).toEqual(settled.requests[1])
      expect(settled.hostCapture.every(item => item.linked)).toBe(true)
      if (forest) expect(JSON.parse(settled.hostCapture[0].pending!).action.selection.selectedRootIds).toEqual([selectedId])
      if (seed.ordinaryRootId) {
        expect(JSON.parse(settled.hostCapture[0].pending!).action).toMatchObject({ kind: 'move', selection: { selectedRootIds: originalMovedIds } })
        await expectedMixedRows(seed.targetId)
        expect((await rows(seed.targetId)).find(block => block.id === seed.ordinaryRootId)?.content).toBe('Ordinary host body')
      }
      const movedOrdinary = staged && await rows(staged.documentId)
      if (staged) {
        expect(JSON.parse(settled.hostCapture[0].pending!).action).toMatchObject({ kind: 'move-batch', moves: [
          { selection: { documentId: staged.documentId, selectedRootIds: [staged.blockId] } },
          { selection: { documentId: seed.sourceId, selectedRootIds: [seed.instanceId] } }
        ] })
        expect(movedOrdinary).toEqual([expect.objectContaining({ type: 'paragraph', content: '' })])
        const moved = (await rows(seed.targetId)).find(block => block.id === staged.blockId)
        if (staged.savedGroupId) {
          expect(moved).toMatchObject({ type: 'synced-block' })
          expect(savedBefore).toBeTruthy()
          const after = await otherSavedGroup()
          expect(after?.blocks).toEqual(savedBefore && savedBefore.blocks)
          expect(after?.revision).toBe(savedBefore && savedBefore.revision)
          expect(after?.instances).toEqual([expect.objectContaining({ instanceId: staged.blockId, hostDocumentId: seed.targetId })])
          const applied = settled.moves[0]
          expect(applied.status === 'moved' && [...applied.result.affectedInstanceIds].sort()).toEqual([staged.blockId, seed.instanceId].sort())
        } else expect(moved).toMatchObject({ content: 'The staged ordinary block' })
      }
      expect(settled.moves[0].status).toBe('moved')
      expect(settled.moves[0]).toEqual(settled.moves[1])
      if (dependency) {
        const applied = settled.moves[0]
        expect(applied.status === 'moved' && applied.result.hosts.map(host => host.documentId).sort())
          .toEqual([seed.sourceId, seed.targetId, ...seed.dependencies.map(peer => peer.documentId), ...(staged ? [staged.documentId] : [])].sort())
        for (const peer of seed.dependencies) expect(await dependencyLink(peer.documentId)).toBe(peer.after)
        expect(await stationary()).toEqual(initialStationary)
      }
      expect(await savedGroup(seed.sourceId)).toBeNull()
      const targetGroup = await savedGroup(seed.targetId)
      expect(targetGroup?.revision).toBe(initial?.revision)
      if (independent) {
        expect(settled.stationaryDraftsAtMove).toHaveLength(2)
        expect(settled.stationaryDraftsAtMove[0]).toEqual(settled.stationaryDraftsAtMove[1])
        const expected = independent.text + independentSuffix
        const draft = await page.evaluate(head => window.knowbook.readEditorRecoveryDraft(head), settled.stationaryDraftsAtMove[0])
        expect(draft.record.draft.working).toMatchObject({ kind: 'group', blocks: [expect.objectContaining({ id: independent.blockId, content: expected })] })
        expect(await independentGroup()).toEqual(independentBefore)
        const retained = inlineInstance(page, independent.instanceId)
        await expectCanonicalRow(retained, independent.blockId, expected)
        await retained.getByRole('button', { name: uiText('Save / retry', '保存／重试'), exact: true }).click()
        await expect.poll(async () => (await independentGroup())?.blocks[0].content).toBe(expected)
        independentSaved = await independentGroup()
        expect(independentSaved?.instances).toEqual(independentBefore?.instances)
        expect(independentSaved?.revision).not.toBe(independentBefore?.revision)
      }
      if (sharedTarget) expect(targetGroup?.instances.find(item => item.instanceId === sharedTarget.instanceId)).toEqual(sharedTarget)
      if (sharedSource) {
        const survivor = inlineInstance(page, sharedSource.instanceId), survivorBody = survivor.locator('.ProseMirror[contenteditable="true"]')
        await expect(survivorBody).toContainText('target')
        await expect(survivorBody).not.toContainText('hot W')
        expect(targetGroup?.instances.find(item => item.instanceId === sharedSource.instanceId)).toEqual(sharedSource)
        await appendCanonicalText(page, sharedSource.instanceId, seed.primaryId, 'target', ' survivor local W')
        await expect(survivorBody).toContainText('survivor local W')
        await survivor.getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
        await expect(survivorBody).not.toContainText('survivor local W')
        expect((await savedGroup(seed.sourceId, sharedSource.instanceId))?.blocks[0].content).toBe(seed.raw)
        expect((await probe()).groupWrites).toBe(0)
      }
      if (placement) {
        expect(targetGroup?.instances).toHaveLength(1 + Number(Boolean(sharedSource)) + Number(Boolean(sharedTarget)))
        expect(targetGroup?.instances.find(item => item.instanceId === seed.instanceId))
          .toMatchObject({ parentBlockId: targetParentId, depth: targetDepth })
        if (forest) {
          await expectForest('target')
          expect((await sourceRows()).map(block => block.id)).toEqual([forest.outsideId, ...(seed.sharedSourceId ? [seed.sharedSourceId] : [])])
        } else expect(await sourceRows()).toEqual([expect.objectContaining({ id: placement.sourceParentId, type: 'bulleted-list', depth: 0 })])
        expect((await rows(seed.targetId)).find(block => block.id === seed.instanceId)).toMatchObject({ parentBlockId: targetParentId, depth: targetDepth })
      }
      const placeholder = emptiesSource ? (await sourceRows())[0] : undefined
      if (placeholder) {
        expect(await sourceRows()).toEqual([placeholder])
        expect(placeholder).toMatchObject({ type: 'paragraph', content: '', parentBlockId: null, depth: 0 })
        expect(placeholder.id).not.toBe(seed.instanceId)
      } else if (emptiesSource) throw new Error('An emptied source must have its actual placeholder')
      if (placeholder || dependency || placement || sharedTarget) {
        await resume.evaluate(release => release()); await resume.dispose(); resume = undefined
        await closeElectronApp(context, { preserveUserData: true })
        context = await relaunchElectronApp({ userDataRoot: profile, editorMode: 'markdown' })
        ;({ app, page } = context)
        await registerProbe()
        if (placeholder) expect(await sourceRows()).toEqual([placeholder])
        if (staged) expect(await rows(staged.documentId)).toEqual(movedOrdinary)
        if (forest) await expectForest('target')
        for (const peer of seed.dependencies) expect(await dependencyLink(peer.documentId)).toBe(peer.after)
        expect(await stationary()).toEqual(initialStationary)
        if (independent) expect(await independentGroup()).toEqual(independentSaved)
      }
      await open('V3 Target')
      const movedOccurrence = inlineInstance(page, seed.instanceId), movedBody = movedOccurrence.locator('.ProseMirror[contenteditable="true"]')
      await expect(movedBody).toBeVisible()
      if (sharedTarget) {
        const stationaryBody = inlineInstance(page, sharedTarget.instanceId).locator('.ProseMirror[contenteditable="true"]')
        await expect(stationaryBody).toBeVisible()
        await expect(stationaryBody).not.toContainText('hot W')
      }
      await expect(movedBody).not.toContainText('hot W')
      await page.getByRole('button', { name: /检查保留的编辑草稿|Review retained editor drafts/ }).click()
      const panel = page.getByRole('dialog', { name: uiText('Retained editor drafts', '保留的编辑草稿'), exact: true })
      const sourceCards = panel.getByRole('button', { name: /V3 Host/ })
      if (sharedSource || independent) {
        const address = settled.requests[0].hostHead
        const listed = await page.evaluate(() => window.knowbook.listEditorRecoveryDrafts({ limit: 20 }))
        const cards = listed.records.filter(item => item.displayTitle === 'V3 Host')
        const original = cards.findIndex(item => item.recordId === address.recordId && item.generation === address.generation && item.hash === address.hash)
        expect(original).toBeGreaterThanOrEqual(0)
        await expect(sourceCards).toHaveCount(cards.length)
        await sourceCards.nth(original).click()
      } else await sourceCards.click()
      await expect(panel).toContainText(/original move is confirmed|原移动已确认/i)
      if (sharedTarget && forest) {
        const captured = settled.requests[0].hostHead
        const candidate = await page.evaluate(expected => window.knowbook.readEditorRecoveryDraft(expected), captured)
        expect(candidate.canonicalCrossMoveRecovery).toMatchObject({ hostDocumentId: seed.targetId, instanceId: seed.instanceId })
      }
      await panel.getByRole('button', { name: uiText('Restore', '恢复'), exact: true }).click()
      await expect(panel).toHaveCount(0)
      await expect(movedBody).toContainText('hot W')
      if (savedBefore && staged) {
        expect((await otherSavedGroup())?.blocks).toEqual(savedBefore.blocks)
        await expect(inlineInstance(page, staged.blockId)).toContainText('The staged ordinary block')
      }
      if (sharedSource) await expect(movedBody).not.toContainText('survivor local W')
      await movedOccurrence.getByRole('button', { name: uiText('Redo', '重做'), exact: true }).click()
      await expect(movedBody).toContainText('hot Redo')
      expect((await savedGroup(seed.targetId))?.blocks[0].content).toBe(seed.raw)
      expect((await probe()).groupWrites).toBe(0)
      await movedOccurrence.getByRole('button', { name: uiText('Save / retry', '保存／重试'), exact: true }).click()
      await expect.poll(async () => (await savedGroup(seed.targetId))?.blocks[0].content).toMatch(/hot W.*hot Redo/)
      if (placeholder || dependency || placement) {
        await open(stationaryPage?.title ?? dependency?.title ?? 'V3 Host')
        const history = async (action: 'Undo' | 'Redo') => {
          await page.locator('.document-header-more-button').click()
          const command = page.locator('.document-header-action-menu').getByRole('button', { name: uiText(action, action === 'Undo' ? '撤销' : '重做'), exact: true })
          await expect(command).toBeEnabled()
          await command.click()
        }
        await history('Undo')
        if (staged) {
          await expect.poll(() => rows(staged.documentId)).toEqual(ordinaryBefore)
          expect((await rows(seed.targetId)).some(block => block.id === staged.blockId)).toBe(false)
          if (independent) expect(await independentGroup()).toEqual(independentSaved)
        }
        if (placeholder) await expect.poll(async () => (await sourceRows()).map(row => row.id)).toEqual(originalMovedIds)
        if (seed.ordinaryRootId) await expectedMixedRows(seed.sourceId)
        if (placement) await expect.poll(async () => (await savedGroup(seed.sourceId))?.instances.find(item => item.instanceId === seed.instanceId))
          .toMatchObject({ hostDocumentId: seed.sourceId, parentBlockId: placement.sourceParentId, depth: 1 })
        if (sharedTarget && forest) expect((await savedGroup(seed.targetId, sharedTarget.instanceId))?.instances.find(item => item.instanceId === sharedTarget.instanceId)).toEqual(sharedTarget)
        if (forest) await expectForest('source')
        if (dependency) {
          for (const peer of seed.dependencies) await expect.poll(() => dependencyLink(peer.documentId)).toBe(peer.before)
          expect(await savedGroup(seed.sourceId)).not.toBeNull()
          expect(await stationary()).toEqual(initialStationary)
        }
        await history('Redo')
        if (staged) {
          await expect.poll(() => rows(staged.documentId)).toEqual(movedOrdinary)
          expect((await rows(seed.targetId)).some(block => block.id === staged.blockId)).toBe(true)
          if (independent) expect(await independentGroup()).toEqual(independentSaved)
        }
        if (placeholder) await expect.poll(sourceRows).toEqual([placeholder])
        if (seed.ordinaryRootId) await expectedMixedRows(seed.targetId)
        if (placement) await expect.poll(async () => (await savedGroup(seed.targetId))?.instances.find(item => item.instanceId === seed.instanceId))
          .toMatchObject({ hostDocumentId: seed.targetId, parentBlockId: targetParentId, depth: targetDepth })
        if (sharedTarget && forest) expect((await savedGroup(seed.targetId, sharedTarget.instanceId))?.instances.find(item => item.instanceId === sharedTarget.instanceId)).toEqual(sharedTarget)
        if (forest) await expectForest('target')
        if (dependency) {
          for (const peer of seed.dependencies) await expect.poll(() => dependencyLink(peer.documentId)).toBe(peer.after)
          expect(await savedGroup(seed.targetId)).not.toBeNull()
          expect(await stationary()).toEqual(initialStationary)
        }
      }
    } finally {
      if (resume) { await resume.evaluate(release => release()); await resume.dispose() }
    }
    passed = true
  } finally { await closeElectronApp(context, { preserveUserData: !passed }) }
})
