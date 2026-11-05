import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import type { DecideEditorRecoveryDraftInput, EditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'
import type { SyncedHostWorkingBefore } from '../src/shared/synced-blocks'
import { createSyncedHostSourceDraft, applySyncedHostSourceChanges, readSyncedHostSourceRecovery,
  prepareSyncedHostSourceApply, restoreSyncedHostSourceDraft } from '../src/renderer/src/features/synced-blocks/hostSource'
import { openColdHostSourceOwner } from '../src/renderer/src/features/editor-recovery/sourceColdOwner'
import { recoveryData } from '../src/renderer/src/features/editor-recovery/sourceSnapshots'

class Contents extends EventEmitter {
  readonly id = 12; readonly mainFrame = { processId: 102, routingId: 202, detached: false }
  isDestroyed() { return false }; getOSProcessId() { return 302 }; send() {}
}
class Window extends EventEmitter { readonly webContents = new Contents(); isDestroyed() { return false }; close() {} }
function mainRows(main: KnowbookStore) {
  const db = main.getUnsafeDatabaseHandle()
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(value => {
    const name = (value as { name: string }).name
    return [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]
  })
}
function fixture(options: { emptyTags?: boolean; authoredEmptyTags?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kb-cr-source-')), main = new KnowbookStore(join(root, 'main.db')), side = new EditorRecoveryDraftStore(join(root, 'recovery'))
  const window = new Window(), barrier = createEditorCloseBarrier({ beginShutdown() {} }); barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const service = new EditorRecoveryDraftService(side, main, value => barrier.assertEditorMutationAllowed(value))
  const id = main.createDocument(null), initial = main.getDocumentDetail(id)!
  const originals = options.emptyTags ? [...initial.blocks, { ...initial.blocks[0], id: randomUUID() }] : initial.blocks
  main.updateDocument(id, { ...initial, expectedUpdatedAt: initial.updatedAt, blocks: originals.map((block, index) => ({ ...block,
    content: index ? 'Second raw identity' : 'Alpha\r\nBeta', tags: options.emptyTags ? [] : ['hidden'], highlight: 'green' })) })
  const opened = service.open(event, { openRequestId: randomUUID(), kind: 'host', documentId: id, expectedUpdatedAt: main.getDocumentDetail(id)!.updatedAt })
  assert.equal(opened.base.persistedWorking.kind, 'host')
  if (opened.base.persistedWorking.kind !== 'host') throw new Error('Expected host fixture')
  const { kind: _kind, ...workingBefore } = structuredClone(opened.base.persistedWorking)
  if (options.authoredEmptyTags) for (const block of workingBefore.blocks) block.tags = []
  const host = { documentId: id, expectedPersistedUpdatedAt: main.getDocumentDetail(id)!.updatedAt, workingBefore } as SyncedHostWorkingBefore
  const opening = createSyncedHostSourceDraft(host), current = { hostSession: {}, editSequence: 0, host }
  const capture = (source: ReturnType<typeof createSyncedHostSourceDraft>): EditorRecoveryDraftInput => ({ draftSessionId: opened.draftSessionId,
    generation: 1, expectedPreviousGeneration: 0, working: { kind: 'host', ...structuredClone(current.host.workingBefore) }, pending: [], selection: null, composing: false, importing: false,
    sources: [{ sourceId: randomUUID(), kind: 'synced-host', openingSource: opening.source, acceptedSource: opening.source, source: source.source,
      selection: { anchor: source.source.length, head: 1 }, composing: false, applying: false, importing: false,
      replayJson: JSON.stringify(recoveryData({ kind: 'knowbook-source-replay-data', version: 1, opening, accepted: opening, current: source,
        provenance: readSyncedHostSourceRecovery(source) })) }] })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: {
    decideEditorRecoveryDraft: async (input: DecideEditorRecoveryDraftInput) => service.decide(event, input.recoveryOwnerId, input.decision)
  } } })
  return { main, side, service, event, opened, opening, current, capture,
    close() { if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window')
      service.dispose(); side.close(); main.destroy(); rmSync(root, { recursive: true, force: true }) } }
}

test('actual Source producer -> private side COMMIT -> real cold Main decision -> owned draft restores exact raw C/anchors/attrs/accepted floor and a later ordinary Apply remains explicit', async () => {
  const f = fixture()
  try {
    const source = applySyncedHostSourceChanges(f.opening, [{ from: 2, to: 2, insert: ' retained C' }]), draft = f.capture(source)
    const before = mainRows(f.main), changes = (f.main.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const receipt = f.service.write(f.event, { records: [draft] }, { kind: 'background' }), candidate = f.service.read(f.event, {
      recordId: receipt.records[0].recordId, generation: receipt.records[0].generation, hash: receipt.records[0].hash })
    assert.equal(candidate.mode, 'editable-source-draft'); assert.equal(candidate.writePermit, false)
    const owner = await openColdHostSourceOwner(candidate.recoveryOwnerId), restored = restoreSyncedHostSourceDraft(owner, f.current)
    assert.equal(restored.draft.source, source.source); assert.equal(restored.accepted.source, f.opening.source)
    assert.deepEqual(restored.selection, draft.sources[0].selection)
    assert.deepEqual(restored.draft.ordinary.anchors, recoveryData(source.ordinary.anchors))
    assert.deepEqual(restored.draft.ordinary.initialBlocks, recoveryData(source.ordinary.initialBlocks))
    const prepared = prepareSyncedHostSourceApply(restored.draft)
    assert.equal(prepared.finalAfter[0].blocks[0].id, f.opening.opening.workingBefore.blocks[0].id)
    assert.deepEqual(prepared.finalAfter[0].blocks[0].tags, ['hidden']); assert.equal(prepared.finalAfter[0].blocks[0].highlight, 'green')
    assert.deepEqual(mainRows(f.main), before)
    assert.equal((f.main.getUnsafeDatabaseHandle().prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
    assert.throws(() => restoreSyncedHostSourceDraft({ kind: 'actual-cold-host-source-owner' }, f.current), /actual UI visit/)
  } finally { f.close() }
})

test('invalid unfinished raw Source including CRLF/NUL/lone surrogate is restored without parsing or applying it, while forged anchor provenance remains view-only', async () => {
  const f = fixture()
  try {
    const raw = '\r\n\r\n<aside data-knowbook-container="callout-v1">\r\n<div data-knowbook-title="true">Missing closer\u0000\ud800</div>', source = applySyncedHostSourceChanges(f.opening, [{ from: f.opening.source.length, to: f.opening.source.length, insert: raw }])
    const draft = f.capture(source), first = f.service.write(f.event, { records: [draft] }, { kind: 'background' }).records[0]
    const before = mainRows(f.main), candidate = f.service.read(f.event, { recordId: first.recordId, generation: first.generation, hash: first.hash })
    assert.equal(candidate.mode, 'editable-source-draft')
    const restored = restoreSyncedHostSourceDraft(await openColdHostSourceOwner(candidate.recoveryOwnerId), f.current)
    assert.equal(restored.draft.source, source.source); assert.deepEqual(restored.selection, draft.sources[0].selection)
    assert.throws(() => prepareSyncedHostSourceApply(restored.draft))
    assert.deepEqual(mainRows(f.main), before)
    const forged = structuredClone(draft), replay = JSON.parse(forged.sources[0].replayJson!)
    replay.current.ordinary.anchors[0].block.id = 'foreign original identity'
    forged.sources[0].replayJson = JSON.stringify(replay); forged.generation = 2; forged.expectedPreviousGeneration = 1
    const next = f.service.write(f.event, { records: [forged] }, { kind: 'background' }).records[0]
    const rejected = f.service.read(f.event, { recordId: next.recordId, generation: next.generation, hash: next.hash })
    assert.equal(rejected.mode, 'view-only')
    assert.throws(() => f.service.decide(f.event, rejected.recoveryOwnerId, 'restore-draft'), /explicit review/)
    assert.deepEqual(mainRows(f.main), before)
  } finally { f.close() }
})

test('ordinary Source preserves both omitted and explicitly authored empty tags against the same real SQL [] while a fresh public hydration omits them and different nonempty attrs cannot borrow that owner', async () => {
  for (const authoredEmptyTags of [true, false]) {
    const f = fixture({ emptyTags: true, authoredEmptyTags })
    try {
      const owner = f.opened.base.owner
      if (owner.kind !== 'host') throw new Error('Actual host required')
      const db = f.main.getUnsafeDatabaseHandle(), detail = f.main.getDocumentDetail(owner.documentId)!
      assert.equal((db.prepare('SELECT tags_json FROM blocks WHERE id=?').get(detail.blocks[0].id) as { tags_json: string }).tags_json, '[]')
      assert.equal(detail.blocks[0].tags, undefined)
      const source = applySyncedHostSourceChanges(f.opening, [{ from: 2, to: 2, insert: ' retained exact C' }]), draft = f.capture(source)
      assert.deepEqual(source.ordinary.initialBlocks[0].tags, authoredEmptyTags ? [] : undefined)
      const input = structuredClone(draft), item = f.service.write(f.event, { records: [draft] }, { kind: 'background' }).records[0]
      const expected = { recordId: item.recordId, generation: item.generation, hash: item.hash }, before = mainRows(f.main)
      const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
      const candidate = f.service.read(f.event, expected)
      assert.equal(candidate.mode, 'editable-source-draft', 'The actual old Source opening may retain raw tags:[] while SQL/public represent that same physical []')
      const cold = await openColdHostSourceOwner(candidate.recoveryOwnerId)
      const hydrated = { ...f.current, host: { ...f.current.host, workingBefore: { title: detail.title, summary: detail.summary,
        blocks: JSON.parse(JSON.stringify(detail.blocks.map(({ sortOrder: _sortOrder, ...block }) => block))) } } }
      const restored = restoreSyncedHostSourceDraft(cold, hydrated)
      assert.equal(restored.draft.source, source.source)
      assert.deepEqual(restored.draft.ordinary.initialBlocks[0].tags, authoredEmptyTags ? [] : undefined)
      const omittedRootHydration = structuredClone(hydrated)
      for (const block of omittedRootHydration.host.workingBefore.blocks) delete block.parentBlockId
      const omittedRootRestored = restoreSyncedHostSourceDraft(cold, omittedRootHydration)
      assert.equal(omittedRootRestored.draft.ordinary.initialBlocks[0].parentBlockId, null, 'Only the current physical comparison treats an omitted root as SQL NULL; original authored fields remain exact')
      assert.deepEqual(restored.draft.ordinary.anchors, recoveryData(source.ordinary.anchors))
      assert.deepEqual(f.side.read(expected).draft, input, 'No authored field, anchor, Source, or exact draft hash is rewritten for hydration equivalence')
      assert.equal(f.side.head(draft.draftSessionId)!.expected.hash, expected.hash)
      for (const change of [
        (value: typeof hydrated) => { value.host.workingBefore.blocks[0].tags = ['not empty'] },
        (value: typeof hydrated) => { Reflect.set(value.host.workingBefore.blocks[0], 'tags', null) },
        (value: typeof hydrated) => { Reflect.set(value.host.workingBefore.blocks[0], 'highlight', null) },
        (value: typeof hydrated) => { Reflect.set(value.host.workingBefore.blocks[0], 'markdownFormat', { unknown: true }) },
        (value: typeof hydrated) => { value.host.workingBefore.blocks[0].id = randomUUID() },
        (value: typeof hydrated) => { value.host.workingBefore.blocks.reverse() },
        (value: typeof hydrated) => { value.host.workingBefore.blocks[0].highlight = 'yellow' },
        (value: typeof hydrated) => { value.host.workingBefore.blocks[0].content += ' changed actual W' },
        (value: typeof hydrated) => { value.host.expectedPersistedUpdatedAt = '2099-01-01T00:00:00.000Z' }
      ]) {
        const different = structuredClone(hydrated); change(different)
        assert.throws(() => restoreSyncedHostSourceDraft(cold, different), /actual UI visit/)
      }
      const illegal = structuredClone(draft)
      Reflect.set(illegal.working.blocks[0], 'tags', null)
      assert.throws(() => f.service.write(f.event, { records: [illegal] }, { kind: 'background' }), /dense array required/)
      assert.deepEqual(mainRows(f.main), before)
      assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
    } finally { f.close() }
  }
})
